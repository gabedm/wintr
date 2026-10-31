import { describe, expect, it } from 'vitest';
import { APPLE_METADATA_RATE, createAppleMetadataRateGate, type AppleRateContext } from '../src/server/apple-metadata-rate.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

// Durable Apple metadata rate admission over the repository's SDK-shaped fake
// Firestore. Invented namespaces and times only; no real client, network or Apple call.

const T0 = 1_000_000;
const FAR = T0 * 100;
const SERVICE = 'svc-wintr-test';
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

function setup() {
  const server = new FakeFirestoreServer();
  const clock = { t: T0 };
  const gateOn = (srv = server, opts: { serviceId?: string; expiresAt?: number; attempts?: number } = {}) =>
    createAppleMetadataRateGate({
      docs: createFirestoreDocStore(new FakeFirestore(srv), { maxAttempts: opts.attempts ?? 10 }),
      serviceId: opts.serviceId ?? SERVICE,
      expiresAt: opts.expiresAt ?? FAR,
      clock: () => clock.t,
    });
  const ctx = (over: Partial<AppleRateContext> = {}): AppleRateContext => ({
    signal: new AbortController().signal,
    deadlineAt: clock.t + 120_000,
    scopeExpiresAt: clock.t + 3_600_000,
    ...over,
  });
  const rows = () => server.entries('wintr_service_limits/');
  const stamps = () => (rows()[0]?.[1].timestamps as number[] | undefined) ?? [];
  return { server, clock, gateOn, ctx, rows, stamps };
}

describe('Apple metadata rate gate: construction and storage', () => {
  it('construction reads and writes nothing and validates the namespace and expiry', () => {
    const s = setup();
    s.gateOn();
    expect(s.server.callbackRuns).toBe(0);
    expect(s.rows()).toEqual([]);
    for (const serviceId of ['', 'A', 'has space', 'x'.repeat(64), '1abc', 'ab', 'UPPER-case']) expect(() => s.gateOn(s.server, { serviceId })).toThrow(RangeError);
    for (const expiresAt of [Number.NaN, -1, 1.5, Infinity, 2 ** 60]) expect(() => s.gateOn(s.server, { expiresAt })).toThrow(RangeError);
  });

  it('stores one bounded opaque row in the existing collection: integers and schema only', async () => {
    const s = setup();
    expect(await s.gateOn().admit(s.ctx())).toEqual({ admitted: true, at: T0, dispatchBy: T0 + 5_000 });
    expect(s.rows()).toHaveLength(1);
    const [path, data] = s.rows()[0]!;
    expect(path).toMatch(/^wintr_service_limits\/apple_md_[0-9a-f]{48}$/);
    expect(path).not.toContain(SERVICE);
    expect(Object.keys(data).sort()).toEqual(['lastSeen', 'schema', 'scope', 'timestamps']);
    expect(data).toMatchObject({ schema: 1, timestamps: [T0], lastSeen: T0 });
    expect(JSON.stringify(data)).not.toContain(SERVICE);
    // A different namespace has its own row and its own budget.
    await s.gateOn(s.server, { serviceId: 'svc-other-test' }).admit(s.ctx());
    expect(s.rows()).toHaveLength(2);
  });

  it('never reads or writes the FirestoreStore service row stored under the plain service id', async () => {
    const s = setup();
    s.server.seed(`wintr_service_limits/${SERVICE}`, { junk: 'unrelated' });
    expect((await s.gateOn().admit(s.ctx())).admitted).toBe(true);
    expect(s.server.read(`wintr_service_limits/${SERVICE}`).data).toEqual({ junk: 'unrelated' });
  });
});

describe('Apple metadata rate gate: shared 18 per 65 retained seconds (18 starts per 60 s)', () => {
  it('admits exactly 18 of 19 calls in contending waves across two instances', async () => {
    const s = setup();
    const a = s.gateOn();
    const b = s.gateOn();
    const results = [];
    // Waves keep database re-runs within the attempt bound while every wave still contends on the one row.
    for (const wave of [4, 4, 4, 4, 3]) {
      results.push(...(await Promise.all(Array.from({ length: wave }, (_, i) => (i % 2 === 0 ? a : b).admit(s.ctx())))));
    }
    expect(results).toHaveLength(19);
    expect(results.filter((r) => r.admitted)).toHaveLength(APPLE_METADATA_RATE.maxAdmitted);
    expect(results.filter((r) => !r.admitted)).toEqual([{ admitted: false, reason: 'rate_limited' }]);
    expect(s.stamps()).toHaveLength(18);
  });

  it('never over-admits when contention exhausts the database attempts', async () => {
    const s = setup();
    const gates = [s.gateOn(s.server, { attempts: 1 }), s.gateOn(s.server, { attempts: 1 })];
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => gates[i % 2]!.admit(s.ctx())));
    const refused = results.filter((r) => !r.admitted).map((r) => (r as { reason: string }).reason);
    expect(refused.length).toBeGreaterThan(0);
    expect(new Set(refused)).toEqual(new Set(['store_unavailable']));
    expect(results.filter((r) => r.admitted)).toHaveLength(s.stamps().length);
    expect(s.stamps().length).toBeLessThanOrEqual(18);
  });

  it('survives restart: a new client and gate see the earlier admissions', async () => {
    const s = setup();
    for (let i = 0; i < 18; i += 1) expect((await s.gateOn().admit(s.ctx())).admitted).toBe(true);
    const restarted = s.gateOn();
    expect(await restarted.admit(s.ctx())).toEqual({ admitted: false, reason: 'rate_limited' });
    expect(s.stamps()).toHaveLength(18);
  });

  it('retains the 18 admissions for 65 seconds (60 s window plus 5 s dispatch lag) and ages them out exactly there', async () => {
    expect(APPLE_METADATA_RATE).toMatchObject({ windowMs: 60_000, dispatchLagMs: 5_000, retainMs: 65_000, maxAdmitted: 18 });
    const s = setup();
    const g = s.gateOn();
    for (let i = 0; i < 10; i += 1) await g.admit(s.ctx());
    s.clock.t = T0 + 30_000;
    for (let i = 0; i < 8; i += 1) await g.admit(s.ctx());
    for (const t of [T0 + 59_999, T0 + 60_000, T0 + 64_999]) {
      s.clock.t = t;
      expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'rate_limited' });
    }
    s.clock.t = T0 + 65_000;
    // The first ten have just left the retained window; the eight from 30 s remain.
    for (let i = 0; i < 10; i += 1) expect((await g.admit(s.ctx())).admitted).toBe(true);
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'rate_limited' });
    expect(s.stamps()).toEqual([...Array(8).fill(T0 + 30_000), ...Array(10).fill(T0 + 65_000)]);
  });

  it('a delayed old grant is dead before its stamp ages out, so it cannot start beside a new window', async () => {
    const s = setup();
    const g = s.gateOn();
    const old = await g.admit(s.ctx());
    if (!old.admitted) throw new Error('expected a grant');
    for (let i = 0; i < 17; i += 1) await g.admit(s.ctx());
    // Its ticket lapses at +5 s; a fresh 18 only become admissible once the stamp is 65 s old.
    expect(old.dispatchBy).toBe(T0 + 5_000);
    expect(old.dispatchBy + APPLE_METADATA_RATE.windowMs).toBe(T0 + 65_000);
    s.clock.t = T0 + 60_000;
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'rate_limited' });
    s.clock.t = T0 + 65_000;
    const fresh = await g.admit(s.ctx());
    expect(fresh).toEqual({ admitted: true, at: T0 + 65_000, dispatchBy: T0 + 70_000 });
    expect(old.dispatchBy).toBeLessThanOrEqual(fresh.admitted ? fresh.at - APPLE_METADATA_RATE.windowMs : 0);
  });

  it('refuses a clock that moved backwards without changing the row', async () => {
    const s = setup();
    const g = s.gateOn();
    await g.admit(s.ctx());
    const before = s.rows();
    s.clock.t = T0 - 1;
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'clock_regressed' });
    expect(s.rows()).toEqual(before);
  });

  it.each([Number.NaN, -5, 1.5, Infinity])('refuses an invalid clock value %s before any database work', async (bad) => {
    const s = setup();
    const live = s.ctx();
    s.clock.t = bad;
    expect(await s.gateOn().admit(live)).toEqual({ admitted: false, reason: 'clock_invalid' });
    expect(s.server.callbackRuns).toBe(0);
  });

  it('a clock that turns invalid between the read and the decision refuses without writing', async () => {
    const s = setup();
    const g = s.gateOn();
    s.server.beforeCommit = () => undefined;
    const original = s.clock.t;
    let calls = 0;
    const flaky = createAppleMetadataRateGate({
      docs: createFirestoreDocStore(new FakeFirestore(s.server)),
      serviceId: SERVICE,
      expiresAt: FAR,
      clock: () => (++calls >= 2 ? Number.NaN : original),
    });
    expect(await flaky.admit(s.ctx())).toEqual({ admitted: false, reason: 'clock_invalid' });
    expect(s.rows()).toEqual([]);
    expect((await g.admit(s.ctx())).admitted).toBe(true);
  });
});

describe('Apple metadata rate gate: stored state is strict', () => {
  const GOOD = { schema: 1, timestamps: [T0 - 10], lastSeen: T0 - 10 };
  const seeded = async (mutate: (good: Record<string, unknown>) => Record<string, unknown>) => {
    const s = setup();
    const g = s.gateOn();
    await g.admit(s.ctx());
    const [path, data] = s.rows()[0]!;
    s.server.seed(path, mutate({ ...data, ...GOOD }));
    const commits = s.server.log.length;
    return { s, g, path, commits, before: s.rows() };
  };

  it.each<[string, (g: Record<string, unknown>) => Record<string, unknown>]>([
    ['an unknown extra field', (g) => ({ ...g, artist: 'x' })],
    ['a missing field', ({ lastSeen: _l, ...g }) => g],
    ['another schema', (g) => ({ ...g, schema: 2 })],
    ['another scope', (g) => ({ ...g, scope: 'f'.repeat(32) })],
    ['a non-array timestamp list', (g) => ({ ...g, timestamps: 'nope' })],
    ['19 timestamps', (g) => ({ ...g, timestamps: Array(19).fill(T0 - 10), lastSeen: T0 - 10 })],
    ['a negative timestamp', (g) => ({ ...g, timestamps: [-1], lastSeen: T0 - 10 })],
    ['a fractional timestamp', (g) => ({ ...g, timestamps: [T0 - 10.5], lastSeen: T0 - 10 })],
    ['a string timestamp', (g) => ({ ...g, timestamps: [String(T0 - 10)] })],
    ['an unordered list', (g) => ({ ...g, timestamps: [T0 - 5, T0 - 10], lastSeen: T0 - 5 })],
    ['a timestamp beyond lastSeen', (g) => ({ ...g, timestamps: [T0 - 5], lastSeen: T0 - 10 })],
    ['a non-integer lastSeen', (g) => ({ ...g, lastSeen: 'later' })],
  ])('refuses %s without changing it', async (_label, mutate) => {
    const { s, g, commits, before } = await seeded(mutate);
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'state_invalid' });
    expect(s.rows()).toEqual(before);
    expect(s.server.log.length).toBe(commits);
  });

  it('refuses future state (a later timestamp or last-seen time) and never resets it', async () => {
    const { s, g, path, commits } = await seeded((x) => ({ ...x, timestamps: [T0 + 50_000], lastSeen: T0 + 50_000 }));
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'clock_regressed' });
    s.server.seed(path, { ...GOOD, scope: s.rows()[0]![1].scope as string, timestamps: [], lastSeen: T0 + 1 });
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'clock_regressed' });
    expect(s.server.log.length).toBe(commits);
  });

  it('treats an empty valid list (old window) as free capacity', async () => {
    const { s, g } = await seeded((x) => ({ ...x, timestamps: [], lastSeen: 0 }));
    expect((await g.admit(s.ctx())).admitted).toBe(true);
  });

  it('refuses when the store fails and keeps whatever was committed', async () => {
    const s = setup();
    const g = s.gateOn();
    s.server.faults.push('unavailable');
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'store_unavailable' });
    expect(s.rows()).toEqual([]);
    // A commit whose acknowledgement is lost is refused to the caller but stays spent.
    s.server.faults.push('ack_lost');
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'store_unavailable' });
    expect(s.stamps()).toEqual([T0]);
    expect((await g.admit(s.ctx())).admitted).toBe(true);
    expect(s.stamps()).toHaveLength(2);
  });
});

describe('Apple metadata rate gate: Stop, expiry and delay', () => {
  it.each([
    ['an invalid signal', { signal: {} as AbortSignal }],
    ['a NaN deadline', { deadlineAt: Number.NaN }],
    ['a fractional scope expiry', { scopeExpiresAt: 1.5 }],
  ])('refuses %s as an invalid context before any database work', async (_l, over) => {
    const s = setup();
    expect(await s.gateOn().admit(s.ctx(over))).toEqual({ admitted: false, reason: 'invalid_context' });
    expect(s.server.callbackRuns).toBe(0);
  });

  it('refuses a Stop, an elapsed deadline, an elapsed scope and an elapsed binding before any database work', async () => {
    const s = setup();
    const stopped = new AbortController();
    stopped.abort();
    const g = s.gateOn(s.server, { expiresAt: T0 + 500 });
    expect(await g.admit(s.ctx({ signal: stopped.signal }))).toEqual({ admitted: false, reason: 'aborted' });
    expect(await g.admit(s.ctx({ deadlineAt: T0 }))).toEqual({ admitted: false, reason: 'deadline' });
    expect(await g.admit(s.ctx({ scopeExpiresAt: T0 }))).toEqual({ admitted: false, reason: 'scope_expired' });
    s.clock.t = T0 + 500;
    expect(await g.admit(s.ctx())).toEqual({ admitted: false, reason: 'binding_expired' });
    expect(s.server.callbackRuns).toBe(0);
  });

  it('a Stop while the transaction is held returns promptly; the late commit stays spent and authorises nothing', async () => {
    const s = setup();
    const hold = deferred();
    s.server.beforeCommit = () => hold.promise;
    const stop = new AbortController();
    const pending = s.gateOn().admit(s.ctx({ signal: stop.signal }));
    await tick();
    stop.abort();
    expect(await pending).toEqual({ admitted: false, reason: 'aborted' });
    expect(s.stamps()).toEqual([]);
    s.server.beforeCommit = null;
    hold.resolve();
    await tick();
    expect(s.stamps()).toEqual([T0]);
  });

  it('an expiry reached while the transaction is held refuses even though the commit lands', async () => {
    const s = setup();
    const hold = deferred();
    s.server.beforeCommit = () => hold.promise;
    const pending = s.gateOn().admit(s.ctx({ deadlineAt: T0 + 1_000 }));
    await tick();
    s.clock.t = T0 + 1_000;
    s.server.beforeCommit = null;
    hold.resolve();
    expect(await pending).toEqual({ admitted: false, reason: 'deadline' });
    expect(s.stamps()).toEqual([T0]);
  });

  it('a held transaction is bounded by the deadline timer without a Stop, and its late commit is absorbed', async () => {
    const s = setup();
    const hold = deferred();
    s.server.beforeCommit = () => hold.promise;
    const pending = s.gateOn().admit(s.ctx({ deadlineAt: T0 + 40 }));
    await tick(5);
    s.clock.t = T0 + 40;
    expect(await pending).toEqual({ admitted: false, reason: 'deadline' });
    s.server.beforeCommit = null;
    hold.resolve();
    await tick();
    expect(s.stamps()).toEqual([T0]);
  });

  it('database re-runs sample a fresh clock and never repeat the caller dispatch', async () => {
    const s = setup();
    const a = s.gateOn();
    const b = s.gateOn();
    s.server.beforeCommit = async (attempt) => {
      if (attempt !== 1) return;
      s.server.beforeCommit = null;
      s.clock.t = T0 + 5;
      await b.admit(s.ctx());
      s.clock.t = T0 + 10;
    };
    let dispatches = 0;
    const r = await a.admit(s.ctx());
    if (r.admitted) dispatches += 1;
    expect(r).toEqual({ admitted: true, at: T0 + 10, dispatchBy: T0 + 5_010 });
    expect(dispatches).toBe(1);
    expect(s.server.callbackRuns).toBe(3);
    expect(s.stamps()).toEqual([T0 + 5, T0 + 10]);
  });

  it('a re-run that finds the deadline passed refuses and spends nothing', async () => {
    const s = setup();
    const a = s.gateOn();
    const b = s.gateOn();
    s.server.beforeCommit = async (attempt) => {
      if (attempt !== 1) return;
      s.server.beforeCommit = null;
      await b.admit(s.ctx());
      s.clock.t = T0 + 2_000;
    };
    expect(await a.admit(s.ctx({ deadlineAt: T0 + 1_000 }))).toEqual({ admitted: false, reason: 'deadline' });
    expect(s.stamps()).toEqual([T0]);
  });
});

describe('Apple metadata rate gate: bounded dispatch ticket and clock floors', () => {
  /** A gate whose first clock samples are scripted (start, then each database attempt); afterwards it reads `now.t`. */
  const scripted = (s: ReturnType<typeof setup>, script: number[], now: { t: number }) =>
    createAppleMetadataRateGate({
      docs: createFirestoreDocStore(new FakeFirestore(s.server)),
      serviceId: SERVICE,
      expiresAt: FAR,
      clock: () => (script.length > 0 ? script.shift()! : now.t),
    });

  it('exposes an immutable binding expiry and grants dispatchBy = min(at + 5 s, binding, scope, execute deadline)', async () => {
    const s = setup();
    const g = s.gateOn(s.server, { expiresAt: T0 + 9_000 });
    expect(g.bindingExpiresAt).toBe(T0 + 9_000);
    expect(Object.isFrozen(g)).toBe(true);
    expect(() => ((g as { bindingExpiresAt: number }).bindingExpiresAt = FAR)).toThrow();
    expect(g.bindingExpiresAt).toBe(T0 + 9_000);
    const dispatchBy = async (gate: typeof g, over: Partial<AppleRateContext>) => {
      const r = await gate.admit(s.ctx(over));
      return r.admitted ? r.dispatchBy : r;
    };
    expect(await dispatchBy(g, {})).toBe(T0 + 5_000);
    expect(await dispatchBy(g, { deadlineAt: T0 + 2_000 })).toBe(T0 + 2_000);
    expect(await dispatchBy(g, { scopeExpiresAt: T0 + 1_500 })).toBe(T0 + 1_500);
    expect(await dispatchBy(s.gateOn(s.server, { expiresAt: T0 + 1_000 }), { deadlineAt: T0 + 2_000, scopeExpiresAt: T0 + 3_000 })).toBe(T0 + 1_000);
  });

  it('a commit that returns after its ticket lapsed authorises nothing but stays spent', async () => {
    for (const [late, expected] of [
      [T0 + 4_999, { admitted: true, at: T0, dispatchBy: T0 + 5_000 }],
      [T0 + 5_000, { admitted: false, reason: 'dispatch_expired' }],
      [T0 + 30_000, { admitted: false, reason: 'dispatch_expired' }],
    ] as const) {
      const s = setup();
      const hold = deferred();
      s.server.beforeCommit = () => hold.promise;
      const pending = s.gateOn().admit(s.ctx());
      await tick();
      s.clock.t = late;
      s.server.beforeCommit = null;
      hold.resolve();
      expect(await pending).toEqual(expected);
      expect(s.stamps()).toEqual([T0]);
    }
  });

  it('refuses a postcommit sample below the committed admission time without refunding the stamp', async () => {
    const s = setup();
    const now = { t: T0 + 100 };
    const hold = deferred();
    s.server.beforeCommit = () => hold.promise;
    // start = T0, the database attempt samples T0 + 100 and commits that stamp.
    const pending = scripted(s, [T0, T0 + 100], now).admit(s.ctx());
    await tick();
    now.t = T0;
    s.server.beforeCommit = null;
    hold.resolve();
    expect(await pending).toEqual({ admitted: false, reason: 'clock_regressed' });
    expect(s.stamps()).toEqual([T0 + 100]);
    // The spent stamp still counts, and the earlier clock cannot reset it.
    expect(await s.gateOn().admit(s.ctx())).toEqual({ admitted: false, reason: 'clock_regressed' });
    expect(s.stamps()).toEqual([T0 + 100]);
  });

  it('refuses a postcommit sample below the call start floor', async () => {
    const s = setup();
    const now = { t: T0 + 100 };
    const hold = deferred();
    s.server.beforeCommit = () => hold.promise;
    const pending = scripted(s, [T0 + 100, T0 + 100], now).admit(s.ctx());
    await tick();
    now.t = T0 + 99;
    s.server.beforeCommit = null;
    hold.resolve();
    expect(await pending).toEqual({ admitted: false, reason: 'clock_regressed' });
    expect(s.stamps()).toEqual([T0 + 100]);
  });

  it('enforces the start floor on every database attempt, writing nothing below it', async () => {
    const s = setup();
    s.server.beforeCommit = null;
    // First attempt: a sample below the start floor refuses without a write.
    expect(await scripted(s, [T0 + 100, T0 + 99], { t: T0 + 99 }).admit(s.ctx())).toEqual({ admitted: false, reason: 'clock_regressed' });
    expect(s.rows()).toEqual([]);
    // A contention re-run: the row now holds an older stamp (T0), so only the start floor can refuse the re-run sample.
    const other = s.gateOn();
    s.server.beforeCommit = async (attempt) => {
      if (attempt !== 1) return;
      s.server.beforeCommit = null;
      await other.admit(s.ctx());
    };
    expect(await scripted(s, [T0 + 100, T0 + 105, T0 + 50], { t: T0 + 50 }).admit(s.ctx())).toEqual({ admitted: false, reason: 'clock_regressed' });
    expect(s.stamps()).toEqual([T0]);
  });
});
