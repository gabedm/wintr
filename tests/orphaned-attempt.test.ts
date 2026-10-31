import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot, Session } from '../src/shared/records.js';
import { createApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { runDiscover } from '../src/server/graph.js';
import { sha256 } from '../src/server/ids.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createFirestoreDocStore, type DocStore, type DocTx } from '../src/server/persistence/docstore.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createRecordSealer } from '../src/server/seal.js';
import { MemoryStore, type Store } from '../src/server/store.js';
import { recoverAttemptDeadline, type BucketState } from '../src/server/store-core.js';
import { createSyntheticCatalogue } from '../src/server/synthetic-catalogue.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

// No worker is opened for the orphaned Attempt, and no network is used. A new
// FirestoreStore over the shared SDK-shaped fake represents a restarted process.
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const REF = { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 } };
const ANALYSIS = { synthetic: true, audioAccess: 'synthetic_not_accessed' as const, observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null };
afterEach(() => vi.restoreAllMocks());
const policy = {
  version: 'synthetic-orphan-policy', currency: 'XTS', expiresAt: T0 + 10 * HOUR,
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
};

function setup(shared: boolean) {
  const clock = { t: T0 };
  const db = new FakeFirestoreServer();
  const real = createFirestoreDocStore(new FakeFirestore(db));
  const probe = { afterRead: null as null | (() => void), afterResult: null as null | (() => void) };
  const docs: DocStore = {
    ...real,
    transact: async (fn) => {
      const result = await real.transact((tx) => fn({
        ...tx, getAll: async (paths) => { const out = await tx.getAll(paths); probe.afterRead?.(); return out; },
      } as DocTx));
      probe.afterResult?.();
      return result;
    },
  };
  const memory = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 3 });
  const make = (): Store => shared
    ? new FirestoreStore({ docs, serviceId: 'synthetic-orphan-service', policy, clock: () => clock.t, maxSessions: 10, maxJourneysPerSession: 3 })
    : memory;
  return { clock, db, probe, make, store: make() };
}

async function admitted(s: ReturnType<typeof setup>) {
  const created = await s.store.createSession(s.clock.t) as { session: Session; secret: string };
  const owner = { sessionId: created.session.id, epoch: created.session.epoch };
  const input = { ...owner, now: s.clock.t, reference: REF, listenerCue: null, actionKeyHash: sha256('invented-action'), inputHash: sha256('invented-input') };
  const result = await s.store.admitReference(input);
  if (result.kind !== 'admitted') throw new Error('synthetic admission failed');
  return { ...created, owner, input, attempt: result.attempt };
}

/** Exercise the canonical GET handler in-process; no socket is connected or listened on. */
async function state(s: ReturnType<typeof setup>, secret: string) {
  const config = loadConfig([], { WINTR_MODE: 'synthetic', WINTR_PORT: '8787' });
  const handler = createApiHandler({ config, store: s.make(), now: () => s.clock.t, referenceAdapter: null });
  const req = new IncomingMessage(new Socket());
  req.method = 'GET'; req.url = '/api/state'; req.headers = { host: config.hostHeader, cookie: `wintr_sid=${secret}` };
  const res = new ServerResponse(req);
  let body = '';
  res.end = ((chunk: unknown) => { body = String(chunk); return res; }) as typeof res.end;
  await handler(req, res);
  req.destroy();
  return { status: res.statusCode, body: JSON.parse(body) as SafeSnapshot };
}

describe.each([false, true])('orphan recovery (shared=%s)', (shared) => {
  it('the first GET after the orphan deadline performs durable recovery and stops projecting active work', async () => {
    const s = setup(shared);
    const a = await admitted(s);
    await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0);
    await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0);
    s.clock.t = a.attempt.deadlineAt - 1;
    expect((await state(s, a.secret)).body.attempt).toMatchObject({ active: true, outcome: 'running' });
    const ledger = s.db.entries('wintr_ledger');
    s.clock.t += 1;
    expect(await state(s, a.secret)).toMatchObject({ status: 200, body: { stage: 'failed', code: 'deadline', revision: 2, attempt: { active: false, outcome: 'failed' } } });
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline' });
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
  });

  it.each(['reserved', 'returned'] as const)('deadline recovery preserves a %s submission and its accounting exactly', async (submission) => {
    const s = setup(shared);
    const a = await admitted(s);
    await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0);
    if (submission === 'returned') {
      await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0);
      await s.store.endSubmission(a.owner.sessionId, a.attempt.id, 0, 'returned');
    }
    const before = (await s.store.read(a.owner.sessionId, 1, T0))!;
    const ledger = s.db.entries('wintr_ledger');
    if (shared) expect(s.db.entries('wintr_ledger_reservations/')[0]![1].state).toBe(submission === 'returned' ? 'unknown' : 'reserved');
    s.clock.t = a.attempt.deadlineAt;
    const after = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(after.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline', dispatch: before.attempt!.dispatch, calls: before.attempt!.calls });
    expect(after.journey!.counts).toEqual(before.journey!.counts);
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
  });

  it('a read after a worker disappears persists failed/deadline once, without replaying or releasing intent', async () => {
    const s = setup(shared);
    const a = await admitted(s);
    expect(await s.store.reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0)).toMatchObject({ ok: true, call: 0 });
    expect(await s.store.beginSubmission(a.owner, a.attempt.id, 0, T0)).toBe('send');
    const before = (await s.store.read(a.owner.sessionId, 1, T0))!;
    const ledger = s.db.entries('wintr_ledger');
    if (shared) {
      expect(ledger.some(([path, doc]) => path.startsWith('wintr_ledger_reservations/') && doc.state === 'intent')).toBe(true);
      expect(s.db.entries('wintr_ledger_service')[0]![1]).toMatchObject({ unitsHeld: 300, counts: { gemini: 1, qloo: 0 } });
    }
    s.clock.t = a.attempt.deadlineAt - 1;
    expect(await s.make().read(a.owner.sessionId, 1, s.clock.t)).toEqual(before);
    s.clock.t += 1;
    const recovered = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(recovered.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline', dispatch: 'in_flight', calls: before.attempt!.calls });
    expect(recovered.journey).toMatchObject({ stage: 'failed', revision: before.journey!.revision + 1, counts: before.journey!.counts });
    expect(await s.make().read(a.owner.sessionId, 1, s.clock.t + 1)).toEqual(recovered);
    const get = await state(s, a.secret);
    expect(get).toMatchObject({ status: 200, body: { stage: 'failed', code: 'deadline', attempt: { active: false, outcome: 'failed' } } });
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
    expect(await s.make().admitReference({ ...a.input, now: s.clock.t })).toEqual({ kind: 'replay', attemptId: a.attempt.id });
    expect(await s.make().beginSubmission(a.owner, a.attempt.id, 0, s.clock.t)).toBe('held');
    expect(await s.make().reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', s.clock.t)).toEqual({ ok: false, code: 'revoked' });
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, s.clock.t)).toBe(false);
    expect(await s.make().read(a.owner.sessionId, 1, s.clock.t)).toEqual(recovered);
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
  });

  it.each(['succeeded', 'failed', 'cancelled', 'expired'] as const)('does not rewrite a terminal %s Attempt or increment its revision', async (outcome) => {
    const s = setup(shared);
    const a = await admitted(s);
    if (outcome === 'succeeded') expect(await s.store.commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0)).toBe(true);
    else expect(await s.store.settleAttempt(a.owner.sessionId, 1, a.attempt.id, outcome, outcome === 'failed' ? 'adapter_failed' : null, T0)).toBe(true);
    const before = await s.store.read(a.owner.sessionId, 1, T0);
    s.clock.t = a.attempt.deadlineAt + 1;
    const log = s.db.log.length;
    expect(await s.make().read(a.owner.sessionId, 1, s.clock.t)).toEqual(before);
    expect(s.db.log).toHaveLength(log);
  });

  it('does not mutate an expired session, stale epoch or foreign owner; Clear cannot be undone', async () => {
    const s = setup(shared);
    const a = await admitted(s);
    s.clock.t = a.attempt.deadlineAt;
    const stored = s.db.entries();
    expect(await s.make().read(a.owner.sessionId, 2, s.clock.t)).toBeNull();
    expect(await s.make().read('x'.repeat(24) as Handle, 1, s.clock.t)).toBeNull();
    expect(s.db.entries()).toEqual(stored);
    s.clock.t = a.session.expiresAt;
    expect(await s.make().read(a.owner.sessionId, 1, s.clock.t)).toBeNull();
    expect(s.db.entries()).toEqual(stored);

    const other = setup(shared);
    const b = await admitted(other);
    await other.store.clearSession(b.owner.sessionId);
    other.clock.t = b.attempt.deadlineAt;
    const cleared = other.db.entries();
    expect(await other.make().read(b.owner.sessionId, 1, other.clock.t)).toBeNull();
    expect(await other.make().read(b.owner.sessionId, 2, other.clock.t)).toBeNull();
    expect(other.db.entries()).toEqual(cleared);
  });

  it('cannot settle a replacement Attempt using the orphaned worker deadline', async () => {
    const s = setup(shared);
    const a = await admitted(s);
    s.clock.t = a.attempt.deadlineAt;
    const next = await s.store.admitReference({ ...a.input, now: s.clock.t, actionKeyHash: sha256('replacement-action'), inputHash: sha256('replacement-input') });
    if (next.kind !== 'admitted') throw new Error('replacement not admitted');
    const before = (await s.store.read(a.owner.sessionId, 1, s.clock.t))!;
    expect(before.attempt).toMatchObject({ id: next.attempt.id, outcome: 'running' });
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, s.clock.t)).toBe(false);
    expect(await s.make().read(a.owner.sessionId, 1, s.clock.t + 1)).toEqual(before);
  });

  it('preserves a prior panel, spent refinement allowance, counts and unknown holds when refinement is orphaned', async () => {
    const s = setup(shared);
    vi.spyOn(Date, 'now').mockImplementation(() => s.clock.t);
    const a = await admitted(s);
    await s.store.commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0);
    const ref = (await s.store.read(a.owner.sessionId, 1, T0))!;
    const saved = await s.store.saveBrief(a.owner, {
      analysisId: ref.analysis!.id, relationship: 'Invented relationship', relationshipSource: 'analysis_choice', proposedArtists: ['Invented Artist'], exclusions: [],
    }, { actionKeyHash: sha256('save'), inputHash: sha256('save-input'), expectedBriefId: null }, T0);
    if (saved.kind !== 'saved') throw new Error('synthetic brief not saved');
    const discovery = await s.store.admitDiscover({ ...a.owner, now: T0, briefId: saved.brief.id, actionKeyHash: sha256('discover'), inputHash: sha256('discover-input') });
    if (discovery.kind !== 'admitted') throw new Error('synthetic discovery not admitted');
    await runDiscover({
      store: s.store, qloo: createQlooClient({ transport: createSyntheticQlooTransport(), apiKey: new ServerSecret('synthetic-orphan-qloo-key'), host: 'hackathon.api.qloo.com' }),
      qlooSynthetic: true, catalogue: createNativeCatalogue(createSyntheticCatalogue()),
      sealer: createRecordSealer(new ServerSecret('synthetic-orphan-sealing-key-000000001')), now: () => s.clock.t, inflight: new Map(),
    }, discovery.attempt);
    const initial = (await s.store.read(a.owner.sessionId, 1, T0))!;
    expect(initial.panel?.choices).toHaveLength(3);
    const input = {
      ...a.owner, now: T0, actionKeyHash: sha256('refine'), inputHash: sha256('refine-input'), mode: 'correct_direction' as const,
      panelId: initial.panel!.id, briefId: initial.brief!.id, choice: null, relationship: null, excludedAnchors: [], poolFingerprint: initial.pool!.fingerprint,
    };
    const refinement = await s.store.admitRefine(input);
    if (refinement.kind !== 'admitted') throw new Error('synthetic refinement not admitted');
    const id = refinement.attempt.id;
    expect(await s.store.reserveSubmission(a.owner, id, 'catalogue_generation', T0)).toMatchObject({ ok: true, call: 0 });
    expect(await s.store.beginSubmission(a.owner, id, 0, T0)).toBe('send');
    const before = (await s.store.read(a.owner.sessionId, 1, T0))!;
    const ledger = s.db.entries('wintr_ledger');
    if (shared) {
      const states = s.db.entries('wintr_ledger_reservations/').map(([, doc]) => doc.state);
      expect(states).toContain('intent');
      expect(states).toContain('unknown');
    }
    s.clock.t = refinement.attempt.deadlineAt;
    const recovered = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(recovered.attempt).toMatchObject({ id, outcome: 'failed', failure: 'deadline', calls: before.attempt!.calls });
    expect(recovered.journey).toMatchObject({ refinementUsed: true, revision: before.journey!.revision + 1, counts: before.journey!.counts, discoverRuns: before.journey!.discoverRuns });
    expect(recovered.panels).toEqual(initial.panels);
    expect(recovered.brief).toEqual(before.brief);
    expect((await state(s, a.secret)).body).toMatchObject({ attempt: { active: false }, code: 'deadline', refinement: { used: true }, panel: { handle: initial.panel!.id } });
    expect(await s.make().admitRefine({ ...input, now: s.clock.t })).toEqual({ kind: 'replay', attemptId: id });
    expect(await s.make().admitRefine({ ...input, now: s.clock.t, actionKeyHash: sha256('extra-refine') })).toEqual({ kind: 'rejected', code: 'refinement_used' });
    expect(await s.make().commitPanel(a.owner, id, initial.panel!, s.clock.t)).toBe(false);
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
    expect(await s.make().read(a.owner.sessionId, 1, s.clock.t)).toEqual(recovered);
  });
});

describe('shared recovery authority at delayed transaction boundaries', () => {
  it('uses time after the last awaited read, not the request start time', async () => {
    const s = setup(true);
    const a = await admitted(s);
    s.probe.afterRead = () => { s.clock.t = a.attempt.deadlineAt; };
    expect((await s.make().read(a.owner.sessionId, 1, T0))!.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline' });
    expect((await s.make().read(a.owner.sessionId, 1, T0))!.journey!.revision).toBe(2);
  });

  it('recovers durably if time passes while the transaction result is delivered', async () => {
    const s = setup(true);
    const a = await admitted(s);
    s.probe.afterResult = () => { s.clock.t = a.attempt.deadlineAt; };
    const log = s.db.log.length;
    expect((await s.make().read(a.owner.sessionId, 1, T0))!.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline' });
    const writes = s.db.log.slice(log).map((w) => w.path);
    expect(writes.sort()).toEqual([`wintr_owned/attempt_${a.attempt.id}`, ...s.db.entries('wintr_owned/journey_').map(([path]) => path)].sort());
    s.probe.afterResult = null;
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.revision).toBe(2);
  });

  it('re-samples time on a database retry; a stale first callback cannot keep the orphan running', async () => {
    const s = setup(true);
    const a = await admitted(s);
    const [path, root] = s.db.entries('wintr_owned/session_')[0]!;
    s.db.beforeCommit = () => {
      s.db.beforeCommit = null;
      s.clock.t = a.attempt.deadlineAt;
      s.db.seed(path, root); // Force the old read set to conflict; no semantic data change.
    };
    expect((await s.make().read(a.owner.sessionId, 1, T0))!.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline' });
    expect(s.db.conflicts).toBe(1);
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.revision).toBe(2);
  });

  it('two restarted instances recover once under contention', async () => {
    const s = setup(true);
    const a = await admitted(s);
    s.clock.t = a.attempt.deadlineAt;
    const results = await Promise.all([s.make().read(a.owner.sessionId, 1, T0), s.make().read(a.owner.sessionId, 1, T0)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.journey).toMatchObject({ stage: 'failed', revision: 2 });
    expect(s.db.conflicts).toBeGreaterThan(0);
  });

  it('a failed recovery write returns unavailable without claiming a terminal state; a later read can recover', async () => {
    const s = setup(true);
    const a = await admitted(s);
    s.clock.t = a.attempt.deadlineAt;
    const before = s.db.entries();
    s.db.faults.push('unavailable');
    await expect(s.make().read(a.owner.sessionId, 1, T0)).rejects.toThrow('store unavailable');
    expect(s.db.entries()).toEqual(before);
    s.probe.afterResult = () => { s.probe.afterResult = null; s.db.faults.push('unavailable'); };
    expect(await state(s, a.secret)).toMatchObject({ status: 503, body: { error: 'admission_unavailable' } });
    expect(s.db.entries()).toEqual(before);
    expect((await s.make().read(a.owner.sessionId, 1, T0))!.attempt).toMatchObject({ outcome: 'failed', failure: 'deadline' });
  });

  it('session expiry or an unusable clock during the read prevents recovery writes', async () => {
    for (const invalid of [false, true]) {
      const s = setup(true);
      const a = await admitted(s);
      const before = s.db.entries();
      s.probe.afterRead = () => { s.clock.t = invalid ? NaN : a.session.expiresAt; };
      if (invalid) await expect(s.make().read(a.owner.sessionId, 1, T0)).rejects.toThrow('store unavailable');
      else expect(await s.make().read(a.owner.sessionId, 1, T0)).toBeNull();
      expect(s.db.entries()).toEqual(before);
    }
  });
});

it('the shared transition refuses stale version/child ownership and unknown terminal state without any mutation', async () => {
  const s = setup(false);
  const a = await admitted(s);
  const view = (await s.store.read(a.owner.sessionId, 1, T0))!;
  const seed: BucketState = {
    ...view, briefs: [...view.briefs], searches: [...view.searches], checkpoints: [], pools: [...view.pools], plans: [...view.plans], panels: [...view.panels], feedback: [...view.feedback],
    journeysCreated: 1, actions: new Map(), counts: { qloo: 0, gemini: 0 }, freeActions: new Map(), freeWindow: { start: T0, count: 0 },
  };
  for (const corrupt of [
    (b: BucketState) => { b.journey!.currentBriefId = 'b'.repeat(24) as Handle; },
    (b: BucketState) => { b.attempt = { ...b.attempt!, epoch: 2 }; },
    (b: BucketState) => { b.attempt = { ...b.attempt!, journeyId: 'j'.repeat(24) as Handle }; },
    (b: BucketState) => { b.attempt!.outcome = 'unknown'; },
  ]) {
    const b = structuredClone(seed);
    corrupt(b);
    const before = structuredClone(b);
    expect(recoverAttemptDeadline(b, a.owner.sessionId, 1, a.attempt.deadlineAt)).toBe(false);
    expect(b).toEqual(before);
  }
});
