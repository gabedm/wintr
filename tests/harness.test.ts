import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attempt, Handle, Session } from '../src/shared/records.js';
import { LIMITS } from '../src/shared/records.js';
import { runReferenceStage, type HarnessDeps } from '../src/server/harness.js';
import { createGeminiReferenceAdapter } from '../src/server/providers/gemini-reference.js';
import { ProviderError, type HttpTransport, type ProviderResponse } from '../src/server/providers/http.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import type { ReferenceAdapter, ReferenceAdapterResult, ReferenceInput } from '../src/server/reference.js';
import { MemoryStore } from '../src/server/store.js';

const REF = { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', focus: { start: 0, end: 45 } };
const INPUT: ReferenceInput = { reference: REF, listenerCue: null };
const RESULT: ReferenceAdapterResult = { audioAccess: 'synthetic_not_accessed', observations: ['Synthetic'], relationships: ['A'] };

/** Deferred adapter that ignores its abort signal, like a provider that keeps going. */
function stubbornAdapter() {
  const calls: { resolve: (r: ReferenceAdapterResult) => void; reject: (e: unknown) => void; signal: AbortSignal }[] = [];
  const adapter: ReferenceAdapter = {
    synthetic: true,
    analyse: (_input, signal) => new Promise((resolve, reject) => calls.push({ resolve, reject, signal })),
  };
  return { adapter, calls };
}

let clock: { t: number };
let store: MemoryStore;
let session: Session;

beforeEach(async () => {
  vi.useFakeTimers();
  clock = { t: 1_000_000 };
  store = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 5 });
  session = ((await store.createSession(clock.t)) as { session: Session }).session;
});

afterEach(() => {
  vi.useRealTimers();
});

const deps = (adapter: ReferenceAdapter): HarnessDeps => ({ store, adapter, now: () => clock.t, inflight: new Map<Handle, AbortController>() });

async function admit(n = 1): Promise<Attempt> {
  const r = await store.admitReference({
    sessionId: session.id,
    epoch: session.epoch,
    now: clock.t,
    reference: REF,
    listenerCue: null,
    actionKeyHash: `action-${n}`,
    inputHash: `input-${n}`,
  });
  if (r.kind !== 'admitted') throw new Error(r.kind);
  return r.attempt;
}

const read = async () => (await store.read(session.id, session.epoch, clock.t))!;

function track(p: Promise<void>) {
  const state = { done: false };
  void p.then(() => (state.done = true));
  return state;
}

describe('runReferenceStage bounded execution', () => {
  it('settles at the deadline even when the adapter ignores abort, and holds unknown dispatch', async () => {
    clock.t = session.expiresAt - 20;
    const attempt = await admit();
    expect(attempt.deadlineAt - clock.t).toBe(20);
    const { adapter, calls } = stubbornAdapter();
    const d = deps(adapter);
    const run = track(runReferenceStage(d, attempt, INPUT));

    await vi.advanceTimersByTimeAsync(19);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.done).toBe(true);
    expect(calls[0]!.signal.aborted).toBe(true);

    const after = await read();
    expect(after.journey!.stage).toBe('failed');
    expect(after.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline', dispatch: 'in_flight' });
    // Immediate terminal response precedes the coalesced accounting-only write.
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(d.inflight.size).toBe(0);

    calls[0]!.resolve(RESULT);
    await vi.advanceTimersByTimeAsync(0);
    const late = await read();
    expect(late.analysis).toBeNull();
    expect(late.attempt).toMatchObject({ outcome: 'failed', dispatch: 'returned' });
  });

  it('uses the 90-second provider cap when the execute window is longer', async () => {
    const attempt = await admit();
    const { adapter } = stubbornAdapter();
    const run = track(runReferenceStage(deps(adapter), attempt, INPUT));
    await vi.advanceTimersByTimeAsync(LIMITS.providerRequestMs - 1);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.done).toBe(true);
    expect((await read()).attempt!.failure).toBe('deadline');
  });

  it('settles promptly on Stop without waiting for the adapter', async () => {
    const attempt = await admit();
    const { adapter, calls } = stubbornAdapter();
    const d = deps(adapter);
    const run = track(runReferenceStage(d, attempt, INPUT));
    await vi.advanceTimersByTimeAsync(0);

    expect(await store.stopAttempt(session.id, session.epoch, attempt.id, clock.t)).toBe(true);
    d.inflight.get(attempt.id)!.abort('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);
    expect((await read()).attempt).toMatchObject({ outcome: 'cancelled', dispatch: 'in_flight' });
    expect(vi.getTimerCount()).toBe(0);

    calls[0]!.resolve(RESULT);
    await vi.advanceTimersByTimeAsync(0);
    expect((await read()).analysis).toBeNull();
  });

  it('settles promptly on Clear and a late answer cannot repopulate', async () => {
    const attempt = await admit();
    const { adapter, calls } = stubbornAdapter();
    const d = deps(adapter);
    const run = track(runReferenceStage(d, attempt, INPUT));
    await vi.advanceTimersByTimeAsync(0);

    await store.clearSession(session.id);
    d.inflight.get(attempt.id)!.abort('cleared');
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);

    calls[0]!.resolve(RESULT);
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.read(session.id, session.epoch, clock.t)).toBeNull();
    expect(await store.read(session.id, session.epoch + 1, clock.t)).toBeNull();
  });

  it('does not leak an unhandled rejection when the adapter fails after losing the race', async () => {
    const attempt = await admit();
    const { adapter, calls } = stubbornAdapter();
    const d = deps(adapter);
    const run = track(runReferenceStage(d, attempt, INPUT));
    await vi.advanceTimersByTimeAsync(0);
    d.inflight.get(attempt.id)!.abort('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);
    calls[0]!.reject(new Error('late provider failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect((await read()).attempt!.dispatch).toBe('returned');
  });

  it('Stop while the reservation transaction is pending prevents the adapter call and releases the unsent reservation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedStore extends MemoryStore {
      override async reserveSubmission(...args: Parameters<MemoryStore['reserveSubmission']>) {
        const reserved = await super.reserveSubmission(...args);
        await gate;
        return reserved;
      }
    }
    store = new GatedStore({ maxSessions: 10, maxJourneysPerSession: 5 });
    session = ((await store.createSession(clock.t)) as { session: Session }).session;
    const attempt = await admit();
    const { adapter, calls } = stubbornAdapter();
    const d = deps(adapter);
    const run = track(runReferenceStage(d, attempt, INPUT));
    await vi.advanceTimersByTimeAsync(0);

    // Counts are reserved, no intent exists and the method is paused; cancellation is already registered.
    expect((await read()).attempt).toMatchObject({ dispatch: 'not_started', calls: [{ stage: 'reference_analysis', state: 'reserved' }] });
    expect(d.inflight.has(attempt.id)).toBe(true);
    await store.stopAttempt(session.id, session.epoch, attempt.id, clock.t);
    d.inflight.get(attempt.id)!.abort('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    const after = await read();
    expect(after.attempt).toMatchObject({ outcome: 'cancelled', dispatch: 'withdrawn', calls: [{ state: 'withdrawn' }] });
    // A proven-unsent reservation is released.
    expect(after.journey!.counts.gemini).toBe(0);
    expect(d.inflight.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Stop while the intent transaction is pending never invokes the adapter and keeps the durable intent held', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class GatedStore extends MemoryStore {
      override async beginSubmission(...args: Parameters<MemoryStore['beginSubmission']>) {
        const grant = await super.beginSubmission(...args);
        await gate;
        return grant;
      }
    }
    store = new GatedStore({ maxSessions: 10, maxJourneysPerSession: 5 });
    session = ((await store.createSession(clock.t)) as { session: Session }).session;
    const attempt = await admit();
    const { adapter, calls } = stubbornAdapter();
    const d = deps(adapter);
    const run = track(runReferenceStage(d, attempt, INPUT));
    await vi.advanceTimersByTimeAsync(0);
    expect((await read()).attempt!.dispatch).toBe('in_flight');
    await store.stopAttempt(session.id, session.epoch, attempt.id, clock.t);
    d.inflight.get(attempt.id)!.abort('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(run.done).toBe(true);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    const after = await read();
    // Intent was durable, so it cannot be proven unsent: held and counted, not withdrawn.
    expect(after.attempt).toMatchObject({ outcome: 'cancelled', dispatch: 'in_flight' });
    expect(after.journey!.counts.gemini).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failing accounting store neither crashes, logs nor releases the unknown hold', async () => {
    const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')];
    class FailingAccounting extends MemoryStore {
      override endSubmission(): Promise<void> {
        return Promise.reject(new Error('store unavailable: private-detail'));
      }
    }
    class ThrowingAccounting extends MemoryStore {
      override endSubmission(): Promise<void> {
        throw new Error('synchronous store failure');
      }
    }
    for (const Kind of [FailingAccounting, ThrowingAccounting]) {
      store = new Kind({ maxSessions: 10, maxJourneysPerSession: 5 });
      session = ((await store.createSession(clock.t)) as { session: Session }).session;
      const attempt = await admit();
      await runReferenceStage(deps({ synthetic: true, analyse: async () => RESULT }), attempt, INPUT);
      await vi.advanceTimersByTimeAsync(0);
      const after = await read();
      expect(after.journey!.stage).toBe('awaiting_preference');
      expect(after.attempt!.dispatch).toBe('in_flight');
    }
    for (const spy of logs) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('does not dispatch when the attempt was revoked or its window is exhausted', async () => {
    const { adapter, calls } = stubbornAdapter();
    const revoked = await admit(1);
    await store.stopAttempt(session.id, session.epoch, revoked.id, clock.t);
    const d = deps(adapter);
    await runReferenceStage(d, revoked, INPUT);
    expect(calls).toHaveLength(0);
    expect((await read()).attempt!.dispatch).toBe('not_started');
    expect(d.inflight.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    const exhausted = await admit(2);
    clock.t = exhausted.deadlineAt;
    await runReferenceStage(deps(adapter), exhausted, INPUT);
    expect(calls).toHaveLength(0);
    expect((await read()).attempt).toMatchObject({ outcome: 'failed', failure: 'deadline', dispatch: 'not_started' });
  });

  it('commits a timely result and records failures from a throwing adapter', async () => {
    const ok = await admit(1);
    const good: ReferenceAdapter = { synthetic: true, analyse: async () => RESULT };
    await runReferenceStage(deps(good), ok, INPUT);
    const done = await read();
    expect(done.journey!.stage).toBe('awaiting_preference');
    expect(done.analysis!.synthetic).toBe(true);
    expect(done.attempt!.dispatch).toBe('returned');

    const bad = await admit(2);
    const thrower: ReferenceAdapter = {
      synthetic: true,
      analyse: () => {
        throw new Error('sync failure');
      },
    };
    await runReferenceStage(deps(thrower), bad, INPUT);
    expect((await read()).attempt).toMatchObject({ outcome: 'failed', failure: 'adapter_failed' });
    await vi.advanceTimersByTimeAsync(1); // Coalesced receipts, never provider retries.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a provider answering 429/503 is named as the service, never as a bad result', () => {
  const SECRET_BODY = 'SECRET-PROVIDER-TEXT project-0001 quota detail https://provider.invalid/path?key=abc';
  const respond = (status: number): ProviderResponse => ({ status, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ error: { message: SECRET_BODY } })) });
  const real = (status: number) => {
    const calls: unknown[] = [];
    const transport: HttpTransport = async (req) => {
      calls.push(req);
      return respond(status);
    };
    return { adapter: createGeminiReferenceAdapter({ transport, apiKey: new ServerSecret('synthetic-test-key-0001') }), calls };
  };

  it.each([
    [429, 'provider_limited'],
    [503, 'provider_unavailable'],
    [500, 'adapter_failed'],
    [502, 'adapter_failed'],
    [504, 'adapter_failed'],
    [400, 'adapter_failed'],
    [401, 'adapter_failed'],
    [403, 'adapter_failed'],
  ])('reference HTTP %i settles as %s: one send, held unknown dispatch, no provider text anywhere', async (status, failure) => {
    const attempt = await admit();
    const { adapter, calls } = real(status);
    await runReferenceStage(deps(adapter), attempt, INPUT);
    const bucket = await read();
    expect(bucket.journey!.stage).toBe('failed');
    expect(bucket.attempt).toMatchObject({ outcome: 'failed', failure, dispatch: 'returned', calls: [{ stage: 'reference_analysis', state: 'returned' }] });
    expect(bucket.analysis).toBeNull();
    // Zero implicit retry, and the counted submission is neither refunded nor released.
    expect(calls).toHaveLength(1);
    expect(store.serviceUsage().gemini).toBe(1);
    expect(bucket.journey!.counts.gemini).toBe(1);
    // Only the closed code is stored: nothing of the response, its message, URL, key or project.
    const stored = JSON.stringify(bucket);
    for (const text of ['SECRET-PROVIDER-TEXT', 'project-0001', 'provider.invalid', 'quota detail', 'synthetic-test-key-0001']) expect(stored).not.toContain(text);
    await vi.advanceTimersByTimeAsync(LIMITS.providerRequestMs);
    expect(calls).toHaveLength(1);
  });

  it('a limit before the work was dispatched is not claimed as the provider limiting it', async () => {
    const attempt = await admit();
    const adapter: ReferenceAdapter = {
      synthetic: false,
      analyse: () => Promise.reject(new ProviderError('gemini', 'quota', false, 429)),
    };
    await runReferenceStage(deps(adapter), attempt, INPUT);
    expect((await read()).attempt).toMatchObject({ outcome: 'failed', failure: 'adapter_failed' });
  });

  it('our own admission or capacity is not a provider limit', async () => {
    const attempt = await admit();
    const refusing: HarnessDeps = { ...deps(stubbornAdapter().adapter), store: Object.assign(Object.create(store), { reserveSubmission: async () => ({ ok: false, code: 'capacity' }) }) };
    await runReferenceStage(refusing, attempt, INPUT);
    expect((await read()).attempt).toMatchObject({ outcome: 'failed', failure: 'capacity' });
  });

  it('Stop wins over a late 429; Clear leaves nothing behind; the deadline (signal or clock) wins over a late 503', async () => {
    const limited = () => new ProviderError('gemini', 'quota', true, 429);
    const unavailable = () => new ProviderError('gemini', 'http_status', true, 503);

    const stopped = await admit(1);
    const a = stubbornAdapter();
    const da = deps(a.adapter);
    const runA = track(runReferenceStage(da, stopped, INPUT));
    await vi.advanceTimersByTimeAsync(0);
    await store.stopAttempt(session.id, session.epoch, stopped.id, clock.t);
    da.inflight.get(stopped.id)!.abort('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(runA.done).toBe(true);
    a.calls[0]!.reject(limited());
    await vi.advanceTimersByTimeAsync(0);
    expect((await read()).attempt).toMatchObject({ outcome: 'cancelled', failure: null });

    const cleared = await admit(2);
    const b = stubbornAdapter();
    const db = deps(b.adapter);
    const runB = track(runReferenceStage(db, cleared, INPUT));
    await vi.advanceTimersByTimeAsync(0);
    await store.clearSession(session.id);
    db.inflight.get(cleared.id)!.abort('cleared');
    await vi.advanceTimersByTimeAsync(0);
    expect(runB.done).toBe(true);
    b.calls[0]!.reject(unavailable());
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.read(session.id, session.epoch, clock.t)).toBeNull();
  });

  it('the deadline wins over a late 503 whether the timer or only the clock has passed', async () => {
    const unavailable = () => new ProviderError('gemini', 'http_status', true, 503);
    clock.t = session.expiresAt - 20;
    const timed = await admit(1);
    const a = stubbornAdapter();
    const runA = track(runReferenceStage(deps(a.adapter), timed, INPUT));
    await vi.advanceTimersByTimeAsync(20);
    expect(runA.done).toBe(true);
    a.calls[0]!.reject(unavailable());
    await vi.advanceTimersByTimeAsync(0);
    expect((await read()).attempt).toMatchObject({ outcome: 'failed', failure: 'deadline' });

    // Clock past the Attempt deadline while its timer has not fired (a stalled timer): the late 503 is still a deadline.
    store = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 5 });
    clock.t = 1_000_000;
    session = ((await store.createSession(clock.t)) as { session: Session }).session;
    const late = await admit(1);
    const b = stubbornAdapter();
    const runB = track(runReferenceStage(deps(b.adapter), late, INPUT));
    await vi.advanceTimersByTimeAsync(0);
    clock.t = late.deadlineAt;
    b.calls[0]!.reject(unavailable());
    await vi.advanceTimersByTimeAsync(0);
    expect(runB.done).toBe(true);
    expect((await read()).attempt).toMatchObject({ outcome: 'failed', failure: 'deadline' });
  });
});
