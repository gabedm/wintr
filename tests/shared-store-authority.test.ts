import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Handle } from '../src/shared/records.js';
import { createApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { runReferenceStage } from '../src/server/harness.js';
import { sha256 } from '../src/server/ids.js';
import { assertDocData, createFirestoreDocStore, firestoreDocSize, MAX_DOC_BYTES, type DocData, type DocStore, type DocTx } from '../src/server/persistence/docstore.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createSyntheticReferenceAdapter, type ReferenceAdapter } from '../src/server/reference.js';
import { createEphemeralSealer } from '../src/server/seal.js';
import type { Owner } from '../src/server/store.js';
import { createSyntheticCatalogue } from '../src/server/synthetic-catalogue.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

// Regressions for the controller-reproduced F2 faults, over the real Firestore
// store and document adapter on the SDK-shaped shared fake. Invented data only;
// not hosted Firestore, emulator, provider or listener acceptance.

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const SERVICE = 'svc-synthetic-authority';
const REF = { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', focus: { start: 0, end: 30 } };
const ANALYSIS = { audioAccess: 'synthetic_not_accessed' as const, synthetic: true, observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null };

const policy = (expiresAt = T0 + 10 * HOUR) => ({
  version: 'synthetic-policy-1',
  currency: 'XTS',
  expiresAt,
  service: { capUnits: 1_000_000, concurrency: 8, counts: { qloo: 600, gemini: 400 } },
  session: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
  journey: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
  reservations: {
    reference_analysis: { units: 300, bound: 'estimate_with_residual' },
    qloo_search: { units: 10, bound: 'enforceable' },
    qloo_artist_insights: { units: 10, bound: 'enforceable' },
    qloo_tag_insights: { units: 10, bound: 'enforceable' },
    catalogue_generation: { units: 500, bound: 'estimate_with_residual' },
  },
});

/** Document store whose transaction reads call `after(n)` once the n-th read has returned (no retry is forced). */
function instrumented(db: FakeFirestoreServer) {
  const real = createFirestoreDocStore(new FakeFirestore(db));
  const probe = { reads: 0, after: null as null | ((n: number) => void) };
  const docs: DocStore = {
    ...real,
    transact: (fn) =>
      real.transact((tx) =>
        fn({
          ...tx,
          getAll: async (paths) => {
            const out = await tx.getAll(paths);
            probe.reads += 1;
            probe.after?.(probe.reads);
            return out;
          },
        } as DocTx),
      ),
  };
  return { docs, probe };
}

function setup(o: { policy?: unknown; maxSessions?: number; db?: FakeFirestoreServer } = {}) {
  const db = o.db ?? new FakeFirestoreServer();
  const clock = { t: T0 };
  const { docs, probe } = instrumented(db);
  const make = () =>
    new FirestoreStore({ docs, serviceId: SERVICE, policy: 'policy' in o ? o.policy : policy(), clock: () => clock.t, maxSessions: o.maxSessions ?? 50, maxJourneysPerSession: 3 });
  return { db, clock, probe, store: make(), make };
}

async function admitted(s: ReturnType<typeof setup>) {
  const created = (await s.store.createSession(s.clock.t)) as { session: { id: Handle; expiresAt: number }; secret: string };
  const owner: Owner = { sessionId: created.session.id, epoch: 1 };
  const r = await s.store.admitReference({ ...owner, now: s.clock.t, reference: REF, listenerCue: null, actionKeyHash: sha256('key'), inputHash: sha256('input') });
  if (r.kind !== 'admitted') throw new Error('not admitted');
  return { owner, attempt: r.attempt, expiresAt: created.session.expiresAt, secret: created.secret };
}

/** Number of transaction reads an operation performs (measured on an identical positive-control setup). */
async function readsOf(s: ReturnType<typeof setup>, op: () => Promise<unknown>) {
  const before = s.probe.reads;
  const result = await op();
  return { reads: s.probe.reads - before, result };
}

/** Arms the probe so the clock jumps to `to` right after the n-th read of the next operation. */
const jumpAfterRead = (s: ReturnType<typeof setup>, n: number, to: number) => {
  const start = s.probe.reads;
  s.probe.after = (count) => {
    if (count - start === n) s.clock.t = to;
  };
};

describe('server time is judged after slow reads, at the decision and delivery boundary', () => {
  it('batches hinted reference authority once, still rejects wrong links, delayed expiry and another instance’s Clear', async () => {
    const s = setup(), a = await admitted(s), hint = { journeyId: a.attempt.journeyId };
    const ordinary = await readsOf(s, () => s.store.authorizeReference(a.owner, a.attempt.id, REF, T0));
    const batched = await readsOf(s, () => s.store.authorizeReference(a.owner, a.attempt.id, REF, T0, hint));
    expect(ordinary).toEqual({ reads: 2, result: true }); expect(batched).toEqual({ reads: 1, result: true });
    expect(await s.store.authorizeReference(a.owner, a.attempt.id, REF, T0, { journeyId: 'Z'.repeat(24) as Handle })).toBe(false);
    jumpAfterRead(s, 1, a.attempt.deadlineAt);
    expect(await s.store.authorizeReference(a.owner, a.attempt.id, REF, T0, hint)).toBe(false);
    const fresh = setup(), b = await admitted(fresh); let cleared = false;
    fresh.db.beforeCommit = async () => { if (!cleared) { cleared = true; await fresh.make().clearSession(b.owner.sessionId); } };
    expect(await fresh.store.authorizeReference(b.owner, b.attempt.id, REF, T0, { journeyId: b.attempt.journeyId })).toBe(false);
  });
  it('beginSubmission: send in the control; never send when the deadline passes during its reads', async () => {
    const control = setup();
    const c = await admitted(control);
    await control.store.reserveSubmission(c.owner, c.attempt.id, 'reference_analysis', T0);
    const { reads, result } = await readsOf(control, () => control.store.beginSubmission(c.owner, c.attempt.id, 0, T0));
    expect(result).toBe('send');
    expect(reads).toBeGreaterThanOrEqual(3);

    for (const after of [1, reads]) {
      const s = setup();
      const a = await admitted(s);
      await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0);
      const conflicts = s.db.conflicts;
      jumpAfterRead(s, after, a.attempt.deadlineAt + 1);
      expect(await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0)).toBe('revoked');
      expect(s.db.conflicts).toBe(conflicts);
      // No intent was recorded: the reservation stays provably unsent.
      expect((await s.store.reconciliation().unresolved(10)).map((r) => r.state)).toEqual(['reserved']);
    }
  });

  it('beginSubmission: policy expiry during the reads refuses new intent', async () => {
    const control = setup({ policy: policy(T0 + 60_000) });
    const c = await admitted(control);
    await control.store.reserveSubmission(c.owner, c.attempt.id, 'reference_analysis', T0);
    const { reads, result } = await readsOf(control, () => control.store.beginSubmission(c.owner, c.attempt.id, 0, T0));
    expect(result).toBe('send');

    const s = setup({ policy: policy(T0 + 60_000) });
    const a = await admitted(s);
    await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0);
    // Still before the Attempt deadline: only the policy has lapsed.
    jumpAfterRead(s, reads, T0 + 60_000);
    expect(await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0)).toBe('unavailable');
    expect((await s.store.reconciliation().unresolved(10)).map((r) => r.state)).toEqual(['reserved']);
  });

  it('beginSubmission: authority lapsing while the intent commits makes the grant unusable and held, never sent', async () => {
    const s = setup();
    const a = await admitted(s);
    await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0);
    // After the decision, before the commit lands: no conflict, no retry.
    s.db.beforeCommit = () => {
      s.clock.t = a.attempt.deadlineAt;
    };
    const conflicts = s.db.conflicts;
    expect(await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0)).toBe('held');
    s.db.beforeCommit = null;
    expect(s.db.conflicts).toBe(conflicts);
    const [held] = await s.store.reconciliation().unresolved(10);
    expect(held).toMatchObject({ state: 'unknown', unknownReason: 'cancelled', units: 300 });
  });

  it('reserveSubmission: the deadline passing during its reads reserves nothing', async () => {
    const control = setup();
    const c = await admitted(control);
    const { reads, result } = await readsOf(control, () => control.store.reserveSubmission(c.owner, c.attempt.id, 'reference_analysis', T0));
    expect(result).toEqual({ ok: true, call: 0, validUntil: c.attempt.deadlineAt });
    const s = setup();
    const a = await admitted(s);
    jumpAfterRead(s, reads, a.attempt.deadlineAt);
    expect(await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0)).toEqual({ ok: false, code: 'revoked' });
    expect(s.db.entries('wintr_ledger_reservations')).toEqual([]);
  });

  it('commitAnalysis: true in the control; false (and nothing stored) when the deadline passes during its reads', async () => {
    const control = setup();
    const c = await admitted(control);
    const { reads, result } = await readsOf(control, () => control.store.commitAnalysis(c.owner.sessionId, 1, c.attempt.id, ANALYSIS, T0));
    expect(result).toBe(true);

    const s = setup();
    const a = await admitted(s);
    const conflicts = s.db.conflicts;
    jumpAfterRead(s, reads, a.attempt.deadlineAt + 1);
    expect(await s.store.commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0)).toBe(false);
    expect(s.db.conflicts).toBe(conflicts);
    s.probe.after = null;
    expect((await s.store.read(a.owner.sessionId, 1, s.clock.t))!.analysis).toBeNull();
    expect(s.db.entries('wintr_owned/analysis_')).toEqual([]);
  });

  it('read: owned state in the control; nothing once the session expires during the reads', async () => {
    const control = setup();
    const c = await admitted(control);
    const { reads, result } = await readsOf(control, () => control.store.read(c.owner.sessionId, 1, T0));
    expect((result as { journey: unknown }).journey).toBeTruthy();

    const s = setup();
    const a = await admitted(s);
    jumpAfterRead(s, reads, a.expiresAt);
    expect(await s.store.read(a.owner.sessionId, 1, T0)).toBeNull();
  });

  it('the harness rechecks the deadline at the send boundary: a lapsed grant is never invoked and stays held', async () => {
    const s = setup();
    const a = await admitted(s);
    class SlowDelivery extends FirestoreStore {
      override async beginSubmission(...args: Parameters<FirestoreStore['beginSubmission']>) {
        const grant = await super.beginSubmission(...args);
        // The 'send' answer reaches the worker only after the deadline.
        s.clock.t = a.attempt.deadlineAt;
        return grant;
      }
    }
    const store = new SlowDelivery({ docs: createFirestoreDocStore(new FakeFirestore(s.db)), serviceId: SERVICE, policy: policy(), clock: () => s.clock.t, maxSessions: 50, maxJourneysPerSession: 3 });
    let invoked = 0;
    const adapter: ReferenceAdapter = { synthetic: true, analyse: async () => (invoked++, { audioAccess: 'synthetic_not_accessed', observations: ['x'], relationships: ['y'] }) };
    await runReferenceStage({ store, adapter, now: () => s.clock.t, inflight: new Map() }, a.attempt, { reference: REF, listenerCue: null });
    expect(invoked).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    const [held] = await store.reconciliation().unresolved(10);
    expect(held).toMatchObject({ state: 'unknown', unknownReason: 'cancelled' });
  });
});

describe('strict stored authority fields per record kind', () => {
  async function corrupted(edit: (body: Record<string, unknown>) => void, kind: 'attempt' | 'journey' = 'attempt') {
    const s = setup();
    const a = await admitted(s);
    expect(await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0)).toEqual({ ok: true, call: 0, validUntil: a.attempt.deadlineAt });
    const id = kind === 'attempt' ? a.attempt.id : a.attempt.journeyId;
    const path = `wintr_owned/${kind}_${id}`;
    const stored = s.db.entries(path)[0]![1];
    const body = structuredClone(stored.body) as Record<string, unknown>;
    edit(body);
    s.db.seed(path, { ...stored, body } as DocData);
    return { s, a };
  }

  it('a valid admitted record is the positive control', async () => {
    const { s, a } = await corrupted(() => {});
    expect((await s.store.read(a.owner.sessionId, 1, T0))!.attempt!.deadlineAt).toBe(a.attempt.deadlineAt);
    expect(await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0)).toBe('send');
  });

  const attemptCases: [string, (b: Record<string, unknown>) => void][] = [
    ['string deadline', (b) => (b.deadlineAt = 'not-a-deadline')],
    ['missing deadline', (b) => delete b.deadlineAt],
    ['null deadline', (b) => (b.deadlineAt = null)],
    ['fractional deadline', (b) => (b.deadlineAt = 1.5)],
    ['deadline after session expiry', (b) => (b.deadlineAt = (b.expiresAt as number) + 1)],
    ['deadline beyond the execute limit', (b) => (b.deadlineAt = (b.createdAt as number) + 120_001)],
    ['unknown outcome', (b) => (b.outcome = 'running ')],
    ['provider/stage mismatch', (b) => (b.calls = [{ provider: 'qloo', stage: 'reference_analysis', state: 'reserved' }])],
    ['string epoch', (b) => (b.epoch = '1')],
    ['foreign journey link', (b) => (b.journeyId = 'foreign-journey-handle-0001')],
    ['extra field', (b) => (b.bonus = 1)],
    ['failure without a failed outcome', (b) => (b.failure = 'deadline')],
  ];

  it.each(attemptCases)('attempt with %s: no private snapshot, no reservation, no intent, no commit', async (_name, edit) => {
    const { s, a } = await corrupted(edit);
    await expect(s.store.read(a.owner.sessionId, 1, T0)).rejects.toThrow('store unavailable');
    expect(await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0)).toBe('unavailable');
    expect(await s.store.reserveSubmission(a.owner, a.attempt.id, 'catalogue_generation', T0)).toEqual({ ok: false, code: 'unavailable' });
    expect(await s.store.commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0)).toBe(false);
    expect(await s.store.loadDiscoverContext(a.owner, a.attempt.id, T0)).toBeNull();
    // The earlier valid reservation was never turned into dispatch intent; nothing new was reserved.
    expect((await s.store.reconciliation().unresolved(10)).map((r) => r.state)).toEqual(['reserved']);
  });

  it.each<[string, (b: Record<string, unknown>) => void]>([
    ['unknown stage', (b) => (b.stage = 'warp')],
    ['string revision', (b) => (b.revision = '3')],
    ['count above the Gemini ceiling', (b) => (b.counts = { gemini: 5, qloo: 0 })],
    ['dangling analysis link', (b) => (b.analysisId = 'missing-analysis-handle-01')],
  ])('journey with %s fails closed: no private snapshot and no intent', async (_name, edit) => {
    const { s, a } = await corrupted(edit, 'journey');
    await expect(s.store.read(a.owner.sessionId, 1, T0)).rejects.toThrow('store unavailable');
    expect(await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0)).toBe('unavailable');
    expect((await s.store.reconciliation().unresolved(10)).map((r) => r.state)).toEqual(['reserved']);
  });

  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((x) => new Promise((r) => x.close(r))));
  });

  it('over HTTP a corrupt stored deadline yields 503 with no private content', async () => {
    const db = new FakeFirestoreServer();
    const server = createServer();
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: 'synthetic' });
    const store = new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: SERVICE, policy: policy(Date.now() + HOUR), clock: Date.now, maxSessions: 5, maxJourneysPerSession: 3 });
    const handler = createApiHandler({ config, store, referenceAdapter: null, discovery: null });
    server.on('request', (req: IncomingMessage, res: ServerResponse) => void handler(req, res));
    const send = (method: string, path: string, cookie?: string) =>
      new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
        const headers: Record<string, string> = { host: config.hostHeader, ...(method !== 'GET' ? { origin: config.origin, 'content-type': 'application/json', 'content-length': '2' } : {}), ...(cookie ? { cookie } : {}) };
        const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode!, body: data, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
        });
        req.on('error', reject);
        req.end(method !== 'GET' ? '{}' : undefined);
      });
    const cookie = (await send('POST', '/api/session')).cookie!;
    const root = db.entries('wintr_owned/session_')[0]![1];
    const sessionId = root.sessionId as Handle;
    const r = await store.admitReference({ sessionId, epoch: 1, now: Date.now(), reference: REF, listenerCue: 'invented private cue', actionKeyHash: sha256('k'), inputHash: sha256('i') });
    expect(r.kind).toBe('admitted');
    expect((await send('GET', '/api/state', cookie)).status).toBe(200);
    const path = `wintr_owned/attempt_${(r as { attempt: { id: Handle } }).attempt.id}`;
    const stored = db.entries(path)[0]![1];
    db.seed(path, { ...stored, body: { ...(stored.body as object), deadlineAt: 'not-a-deadline' } } as DocData);
    const res = await send('GET', '/api/state', cookie);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'admission_unavailable', message: null });
    expect(res.body).not.toMatch(/invented private cue|dQw4w9WgXcQ|deadline/);
  });
});

describe('live-session capacity is an actual invariant across instances', () => {
  /** Sessions alive at instant t: created at or before t, not yet expired, not revoked. */
  const liveAt = (db: FakeFirestoreServer, t: number) =>
    db.entries('wintr_owned/session_').filter(([, d]) => {
      const body = d.body as { state: string; createdAt: number };
      return body.state === 'active' && body.createdAt <= t && (d.expiresAt as number) > t;
    }).length;

  it('maxSessions 2 is never exceeded across the lifetime-window boundary (each call on a new instance)', async () => {
    const s = setup({ maxSessions: 2 });
    const create = async (t: number) => {
      s.clock.t = t;
      return s.make().createSession(t);
    };
    expect(await create(T0)).toMatchObject({ session: { expiresAt: T0 + HOUR } });
    expect(await create(T0 + HOUR - 1)).toMatchObject({ session: { expiresAt: T0 + 2 * HOUR - 1 } });
    expect(liveAt(s.db, T0 + HOUR - 1)).toBe(2);
    // Just after the first lifetime window: the first session expired, so exactly one slot is free.
    expect(typeof (await create(T0 + HOUR + 1))).toBe('object');
    expect(await create(T0 + HOUR + 2)).toBeNull();
    expect(liveAt(s.db, T0 + HOUR + 2)).toBe(2);

    // A cleared session's slot is conservatively kept until its own expiry (no overshoot, documented).
    const third = s.db.entries('wintr_owned/session_').map(([, d]) => d).find((d) => d.expiresAt === T0 + 2 * HOUR + 1)!;
    await s.make().clearSession(third.sessionId as Handle);
    expect(await create(T0 + HOUR + 3)).toBeNull();
    // Once the second session expires, one slot is free again.
    expect(typeof (await create(T0 + 2 * HOUR - 1))).toBe('object');
    expect(await create(T0 + 2 * HOUR)).toBeNull();
    for (const t of [T0, T0 + HOUR - 1, T0 + HOUR + 1, T0 + HOUR + 2, T0 + 2 * HOUR]) expect(liveAt(s.db, t)).toBeLessThanOrEqual(2);
  });

  it('two instances racing for the last live slot admit exactly one', async () => {
    const s = setup({ maxSessions: 1 });
    const results = await Promise.all([s.make().createSession(T0), s.make().createSession(T0)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(liveAt(s.db, T0)).toBe(1);
  });
});

describe('final synchronous delivery fences after the transaction result', () => {
  /** The genuine DocStore; each transaction result is delivered only after `onResult` runs (callback, retries and records untouched). */
  function delayedDelivery(db: FakeFirestoreServer) {
    const real = createFirestoreDocStore(new FakeFirestore(db));
    const gate = { onResult: null as null | (() => void), delivered: 0 };
    const docs: DocStore = {
      ...real,
      transact: async (fn) => {
        const out = await real.transact(fn);
        gate.delivered += 1;
        gate.onResult?.();
        return out;
      },
    };
    return { docs, gate };
  }

  it('read: owned at expiresAt-1; nothing once expiry passes after the read transaction resolved; an unusable clock refuses', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const { docs, gate } = delayedDelivery(db);
    const store = new FirestoreStore({ docs, serviceId: SERVICE, policy: policy(), clock: () => clock.t, maxSessions: 5, maxJourneysPerSession: 3 });
    const a = await admitted({ db, clock, probe: { reads: 0, after: null }, store, make: () => store });
    clock.t = a.expiresAt - 1;
    expect((await store.read(a.owner.sessionId, 1, clock.t))!.journey).toBeTruthy();

    const conflicts = db.conflicts;
    const delivered = gate.delivered;
    clock.t = a.expiresAt - 1;
    gate.onResult = () => {
      clock.t = a.expiresAt + 1;
    };
    expect(await store.read(a.owner.sessionId, 1, a.expiresAt - 1)).toBeNull();
    expect(gate.delivered).toBe(delivered + 1);
    expect(db.conflicts).toBe(conflicts);

    clock.t = a.expiresAt - 1;
    gate.onResult = () => {
      clock.t = Number.NaN;
    };
    await expect(store.read(a.owner.sessionId, 1, a.expiresAt - 1)).rejects.toThrow('store unavailable');
  });

  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((x) => new Promise((r) => x.close(r))));
  });

  it('HTTP: the private snapshot and the Suggestions unit are re-checked against current expiry immediately before they are written', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: Date.now() };
    const late = { to: null as number | null };
    /** The read itself is current; its result reaches the HTTP layer only after `late.to` (delivery delay). */
    class LateDelivery extends FirestoreStore {
      override async read(...args: Parameters<FirestoreStore['read']>) {
        const bucket = await super.read(...args);
        if (late.to !== null) clock.t = late.to;
        return bucket;
      }
    }
    const store = new LateDelivery({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: SERVICE, policy: policy(clock.t + 10 * HOUR), clock: () => clock.t, maxSessions: 5, maxJourneysPerSession: 3 });
    const server = createServer();
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: 'synthetic' });
    const handler = createApiHandler({
      config,
      store,
      now: () => clock.t,
      referenceAdapter: createSyntheticReferenceAdapter(0),
      discovery: {
        qloo: createQlooClient({ transport: createSyntheticQlooTransport(), apiKey: new ServerSecret('synthetic-local-fixture-not-a-credential'), host: 'hackathon.api.qloo.com' }),
        qlooSynthetic: true,
        catalogue: createNativeCatalogue(createSyntheticCatalogue()),
        sealer: createEphemeralSealer(),
      },
    });
    server.on('request', (req: IncomingMessage, res: ServerResponse) => void handler(req, res));
    const send = (method: string, path: string, x: { body?: unknown; cookie?: string } = {}) =>
      new Promise<{ status: number; text: string; cookie?: string }>((resolve, reject) => {
        const payload = x.body === undefined ? undefined : JSON.stringify(x.body);
        const headers: Record<string, string> = { host: config.hostHeader };
        if (method !== 'GET') headers.origin = config.origin;
        if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
        if (x.cookie) headers.cookie = x.cookie;
        const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode!, text: data, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
        });
        req.on('error', reject);
        req.end(payload);
      });

    const cookie = (await send('POST', '/api/session', { body: {} })).cookie!;
    const ref = JSON.parse((await send('POST', '/api/reference', { body: { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: 'fence-action-key-000001' }, cookie })).text);
    const pref = JSON.parse(
      (await send('POST', '/api/preference', { body: { analysis: ref.analysis.handle, relationship: { choice: 0 }, artists: ['Synthetic Seed'], actionKey: 'fence-action-key-000002', expectedBrief: null }, cookie })).text,
    );
    const disc = JSON.parse((await send('POST', '/api/discover', { body: { brief: pref.brief.handle, actionKey: 'fence-action-key-000003' }, cookie })).text);
    const frameUrl = disc.panel.suggestionsUrl as string;
    expect(frameUrl).toBeTruthy();
    const expiresAt = (db.entries('wintr_owned/session_')[0]![1].expiresAt as number);

    // Positive controls at expiresAt - 1: private snapshot and Suggestions are delivered.
    clock.t = expiresAt - 1;
    const state = await send('GET', '/api/state', { cookie });
    expect(state.status).toBe(200);
    expect(state.text).toContain('dQw4w9WgXcQ');
    const frame = await send('GET', frameUrl, { cookie });
    expect(frame.status).toBe(200);
    expect(frame.text).toContain('Synthetic Search Suggestions');

    // The current read returns, then expiry passes before the response is written: no private content.
    clock.t = expiresAt - 1;
    late.to = expiresAt + 1;
    const lateState = await send('GET', '/api/state', { cookie });
    expect(lateState.status).toBe(401);
    expect(JSON.parse(lateState.text)).toEqual({ error: 'session_expired', message: null });
    clock.t = expiresAt - 1;
    const lateFrame = await send('GET', frameUrl, { cookie });
    expect(lateFrame.status).toBe(404);
    expect(lateFrame.text).toBe('');

    // An unusable clock at delivery also refuses private content.
    clock.t = expiresAt - 1;
    late.to = Number.NaN;
    const badClock = await send('GET', '/api/state', { cookie });
    expect(badClock.status).toBe(503);
    expect(badClock.text).not.toContain('dQw4w9WgXcQ');
    clock.t = expiresAt - 1;
    const badFrame = await send('GET', frameUrl, { cookie });
    expect(badFrame.status).toBe(503);
    expect(badFrame.text).toBe('');

    // A unit stored under an earlier sanitiser is rebuilt before the same final fence, which still decides delivery.
    const storeUnit = (html: string) => {
      const [path, doc] = db.entries('wintr_owned_content/panelcontent_')[0]!;
      db.seed(path, { ...doc, body: { ...(doc.body as object), suggestionsHtml: html } } as DocData);
    };
    storeUnit('<a/href="https://example.invalid/"/target="_blank">Synthetic link</a>');
    late.to = null;
    clock.t = expiresAt - 1;
    const rebuilt = await send('GET', frameUrl, { cookie });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.text).toContain('<body><a>Synthetic link</a></body>');
    expect(rebuilt.text).not.toContain('example.invalid');
    late.to = expiresAt + 1;
    expect(await send('GET', frameUrl, { cookie })).toMatchObject({ status: 404, text: '' });
    // An unpresentable unit is 410 only while deliverable; after expiry or with an unusable clock nothing distinguishes it.
    storeUnit('<script>steal()</script>');
    late.to = null;
    clock.t = expiresAt - 1;
    expect(await send('GET', frameUrl, { cookie })).toMatchObject({ status: 410, text: '' });
    // The parent projection withholds that result too, and the same fence still decides delivery of the snapshot.
    clock.t = expiresAt - 1;
    const hiddenState = await send('GET', '/api/state', { cookie });
    expect(hiddenState.status).toBe(200);
    expect(JSON.parse(hiddenState.text).panel).toMatchObject({ outcome: 'source_unavailable', choices: [], citations: [], suggestionsUrl: null, answer: { text: '' } });
    late.to = expiresAt + 1;
    clock.t = expiresAt - 1;
    expect(await send('GET', '/api/state', { cookie })).toMatchObject({ status: 401 });
    late.to = expiresAt + 1;
    clock.t = expiresAt - 1;
    expect(await send('GET', frameUrl, { cookie })).toMatchObject({ status: 404, text: '' });
    late.to = Number.NaN;
    clock.t = expiresAt - 1;
    expect(await send('GET', frameUrl, { cookie })).toMatchObject({ status: 503, text: '' });
  });

  it('the reservation carries the earliest validity (policy expiry) to the harness send check', async () => {
    const run = async (lapse: boolean) => {
      const s = setup({ policy: policy(T0 + 500) });
      const a = await admitted(s);
      class GrantDelivery extends FirestoreStore {
        override async beginSubmission(...args: Parameters<FirestoreStore['beginSubmission']>) {
          // The genuine grant, delivered to the harness just after the policy lapsed (the Attempt still has ~120 s).
          const grant = await super.beginSubmission(...args);
          if (lapse) s.clock.t = T0 + 501;
          return grant;
        }
      }
      const store = new GrantDelivery({ docs: createFirestoreDocStore(new FakeFirestore(s.db)), serviceId: SERVICE, policy: policy(T0 + 500), clock: () => s.clock.t, maxSessions: 5, maxJourneysPerSession: 3 });
      expect(a.attempt.deadlineAt).toBe(T0 + 120_000);
      let invoked = 0;
      const adapter: ReferenceAdapter = { synthetic: true, analyse: async () => (invoked++, { audioAccess: 'synthetic_not_accessed', observations: ['x'], relationships: ['y'] }) };
      await runReferenceStage({ store, adapter, now: () => s.clock.t, inflight: new Map() }, a.attempt, { reference: REF, listenerCue: null });
      await new Promise((r) => setTimeout(r, 20));
      return { invoked, s, a, store };
    };
    const control = await run(false);
    expect(control.invoked).toBe(1);
    expect((await control.store.reconciliation().unresolved(10))[0]).toMatchObject({ state: 'unknown', unknownReason: 'transport_returned_without_receipt' });

    const lapsed = await run(true);
    expect(lapsed.invoked).toBe(0);
    // The durable intent is held as unknown (never refunded), and the Attempt did not succeed.
    expect((await lapsed.store.reconciliation().unresolved(10))[0]).toMatchObject({ state: 'unknown', unknownReason: 'cancelled', units: 300 });
    expect((await lapsed.store.read(lapsed.a.owner.sessionId, 1, lapsed.s.clock.t))!.attempt).toMatchObject({ outcome: 'failed', failure: 'admission_unavailable' });
  });

  it('the synthetic MemoryStore reservation carries the same bound (Attempt deadline and session expiry)', async () => {
    const { MemoryStore } = await import('../src/server/store.js');
    const memory = new MemoryStore({ maxSessions: 2, maxJourneysPerSession: 2 });
    const created = (await memory.createSession(T0)) as { session: { id: Handle; expiresAt: number } };
    const owner = { sessionId: created.session.id, epoch: 1 };
    const r = await memory.admitReference({ ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('k'), inputHash: sha256('i') });
    const attempt = (r as { attempt: { id: Handle; deadlineAt: number } }).attempt;
    expect(await memory.reserveSubmission(owner, attempt.id, 'reference_analysis', T0)).toEqual({ ok: true, call: 0, validUntil: Math.min(attempt.deadlineAt, created.session.expiresAt) });
  });
});

describe('Firestore storage-size estimate (official formula, nested maps included)', () => {
  const p = { collection: 'c', id: 'd' };

  it('matches the documented sizes for flat, nested-map and array values', () => {
    expect(firestoreDocSize(p, { score: 1 })).toBe(66);
    expect(firestoreDocSize(p, { inner: { score: 1 } })).toBe(104);
    // Arrays add no overhead; a map inside an array does.
    expect(firestoreDocSize(p, { a: [1, { b: true }] })).toBe(20 + 2 + 8 + (2 + 1 + 32) + 32);
    expect(firestoreDocSize({ collection: 'users', id: 'jeff' }, {})).toBe(6 + 5 + 16 + 32);
  });

  it('bounds records by the corrected size: exactly at the bound passes, one byte over fails, nested maps count', () => {
    const path = { collection: 'wintr_owned' as const, id: 'journey_bound-test-handle-0001' };
    const maps = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, {}]));
    const build = (pad: number) => ({ maps, pad: 'x'.repeat(pad) });
    // Independent hand computation of the official formula for build(pad).
    const name = ('wintr_owned'.length + 1) + (path.id.length + 1) + 16;
    const nested = 32 + Array.from({ length: 200 }, (_, i) => `k${i}`.length + 1 + 32).reduce((a, b) => a + b, 0);
    const expected = (pad: number) => name + 32 + ('maps'.length + 1) + nested + ('pad'.length + 1) + (pad + 1);
    expect(firestoreDocSize(path, build(0))).toBe(expected(0));
    const atBound = MAX_DOC_BYTES - expected(0);
    expect(expected(atBound)).toBe(MAX_DOC_BYTES);
    expect(() => assertDocData(build(atBound), path)).not.toThrow();
    // One byte over the bound by the official formula is refused, although ignoring the
    // 201 nested maps' 32-byte overheads would have counted it 6,432 bytes smaller.
    expect(() => assertDocData(build(atBound + 1), path)).toThrow('document too large');
  });
});
