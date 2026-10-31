import { describe, expect, it } from 'vitest';
import type { AttemptFailure, SubmissionStage } from '../src/shared/records.js';
import { discoveryAvailability } from '../src/server/discovery-admission.js';
import { notConfiguredCatalogue } from '../src/server/catalogue.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { runDiscover } from '../src/server/graph.js';
import { sha256 } from '../src/server/ids.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createEphemeralSealer } from '../src/server/seal.js';
import { MemoryStore, type AdmitResult, type Store } from '../src/server/store.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

// Actual shared domain transitions over invented state. No socket, provider or real SDK invocation.
const T = 1_800_000_000_000;
const HOUR = 3_600_000;
const reference = { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 } };
const analysis = { synthetic: true, audioAccess: 'synthetic_not_accessed' as const, observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null };
const admitted = (r: AdmitResult) => { expect(r.kind).toBe('admitted'); if (r.kind !== 'admitted') throw new Error('admission expected'); return r; };

async function fixture(kind: 'memory' | 'shared') {
  const clock = { t: T };
  const db = new FakeFirestoreServer();
  const memory = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 1 });
  const make = (): Store => kind === 'memory' ? memory : new FirestoreStore({
    docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'invented-retry-audit', clock: () => clock.t,
    maxSessions: 10, maxJourneysPerSession: 1,
    policy: { version: 'invented-retry-policy', currency: 'XTS', expiresAt: T + 2 * HOUR,
      service: { capUnits: 10000, concurrency: 8, counts: { qloo: 60, gemini: 40 } },
      session: { capUnits: 1000, counts: { qloo: 6, gemini: 4 } }, journey: { capUnits: 1000, counts: { qloo: 6, gemini: 4 } },
      reservations: Object.fromEntries(['reference_analysis', 'qloo_search', 'qloo_artist_insights', 'qloo_tag_insights', 'catalogue_generation'].map(s => [s, { units: 1, bound: 'enforceable' }])) },
  });
  const created = await make().createSession(clock.t);
  if (!created || created === 'rate_limited') throw new Error('session expected');
  const owner = { sessionId: created.session.id, epoch: created.session.epoch };
  let n = 0;
  const action = () => ({ actionKeyHash: sha256(`invented-key-${++n}`), inputHash: sha256(`invented-input-${n}`) });
  const r = admitted(await make().admitReference({ ...owner, now: clock.t, reference, listenerCue: null, ...action() }));
  expect(await make().commitAnalysis(owner.sessionId, owner.epoch, r.attempt.id, analysis, clock.t)).toBe(true);
  const save = async (artists = ['Invented Artist'], relationship = 'Invented relationship') => {
    const state = (await make().read(owner.sessionId, owner.epoch, clock.t))!;
    const result = await make().saveBrief(owner, { analysisId: state.analysis!.id, relationship, relationshipSource: 'listener_text', proposedArtists: artists, exclusions: [] },
      { ...action(), expectedBriefId: state.brief?.id ?? null }, clock.t);
    if (result.kind === 'rejected') throw new Error(result.code);
    return result.brief.id;
  };
  let briefId = await save();
  const firstInput = { ...owner, now: clock.t, briefId, ...action() };
  const first = admitted(await make().admitDiscover(firstInput));
  const call = async (stage: SubmissionStage = 'qloo_search', returned = true) => {
    const reserved = await make().reserveSubmission(owner, first.attempt.id, stage, clock.t);
    if (!reserved.ok) throw new Error(reserved.code);
    expect(await make().beginSubmission(owner, first.attempt.id, reserved.call, clock.t)).toBe('send');
    if (returned) await make().endSubmission(owner.sessionId, first.attempt.id, reserved.call, 'returned');
  };
  const fail = (failure: AttemptFailure) => make().settleAttempt(owner.sessionId, owner.epoch, first.attempt.id, 'failed', failure, clock.t);
  const read = () => make().read(owner.sessionId, owner.epoch, clock.t);
  const discover = () => make().admitDiscover({ ...owner, now: clock.t, briefId, ...action() });
  const edit = async (artists?: string[], relationship?: string) => { briefId = await save(artists, relationship); };
  const checkpoint = async (choose = true) => {
    await runDiscover({ store: make(), qlooSynthetic: true, now: () => clock.t, inflight: new Map(), catalogue: notConfiguredCatalogue,
      sealer: createEphemeralSealer(), qloo: createQlooClient({ host: 'hackathon.api.qloo.com', apiKey: new ServerSecret('invented-retry-test-key'),
        transport: async () => ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ results: [1, 2].map(i => ({
          entity_id: `10000000-0000-4000-8000-00000000000${i}`, name: 'Invented Artist', subtype: 'urn:entity:artist', disambiguation: `Invented identity ${i}`,
        })) })) }) }),
    }, first.attempt);
    const state = (await read())!;
    expect(state.attempt!.outcome).toBe('succeeded');
    const cp = state.checkpoint!;
    expect(cp.awaiting).toBe(true);
    if (choose) expect(await make().chooseArtist(owner, { checkpointId: cp.id, slot: 0, choice: cp.slots[0]!.options[0]! },
      { ...action(), expectedRevision: cp.revision }, clock.t)).toBe('ok');
  };
  return { clock, make, owner, first, firstInput, call, fail, read, discover, edit, checkpoint };
}

describe.each(['memory', 'shared'] as const)('%s durable Discover retry eligibility', kind => {
  it('restores an unselected owned identity checkpoint when the original immutable brief is reselected', async () => {
    const f = await fixture(kind);
    await f.checkpoint(false);
    const original = (await f.read())!;
    await f.edit(['Different Invented Artist']);
    await f.edit(['Invented Artist']);
    const restored = (await f.read())!;
    expect(restored.brief!.id).toBe(original.brief!.id);
    expect(restored.journey!.stage).toBe('awaiting_artist');
    expect(restored.checkpoint).toEqual(original.checkpoint);
    expect(discoveryAvailability(restored)).toBe('available');
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'not_ready' });
    expect(restored.journey!.discoverRuns).toBe(1);
    expect(restored.journey!.counts.qloo).toBe(1);
  });

  it.each([false, true])('permits one explicit changed-artist correction after a successful human boundary (chosen=%s)', async chosen => {
    const f = await fixture(kind);
    await f.checkpoint(chosen);
    await f.edit(['Different Invented Artist']);
    expect(discoveryAvailability((await f.read())!)).toBe('available');
    const corrected = admitted(await f.discover());
    expect(corrected.continuation).toBe(false);
    expect(corrected.journey.discoverRuns).toBe(2);
    expect(corrected.journey.counts.qloo).toBe(1);
    await f.edit(['Invented Artist']);
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'discovery_used' });
  });

  it.each(['qloo_failed', 'catalogue_failed', 'catalogue_refused', 'provider_limited', 'provider_unavailable', 'deadline'] as const)('refuses unchanged or prose-only resend after dispatched %s and retains accounting/replay', async failure => {
    const f = await fixture(kind);
    await f.call(failure.startsWith('catalogue') ? 'catalogue_generation' : 'qloo_search');
    await f.fail(failure);
    const before = (await f.read())!;
    expect(discoveryAvailability(before)).toBe('unavailable');
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'discovery_retry_unavailable' });
    expect(await f.make().admitDiscover(f.firstInput)).toEqual({ kind: 'replay', attemptId: f.first.attempt.id });
    await f.edit(undefined, 'Changed relationship');
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'discovery_retry_unavailable' });
    const after = (await f.read())!;
    expect(after.attempt).toEqual(before.attempt);
    expect(after.journey!.counts).toEqual(before.journey!.counts);
    expect(after.journey!.discoverRuns).toBe(1);
  });

  it('never repeats an in-flight unknown after deadline recovery, even with different artists', async () => {
    const f = await fixture(kind);
    await f.call('qloo_search', false);
    f.clock.t = f.first.attempt.deadlineAt;
    await f.read(); // The actual owned read performs deadline recovery in both stores.
    await f.edit(['Different Invented Artist']);
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'discovery_retry_unavailable' });
    const state = (await f.read())!;
    expect(state.attempt!.calls[0]!.state).toBe('in_flight');
    expect(state.journey!.counts.qloo).toBe(1);
    expect(state.journey!.discoverRuns).toBe(1);
  });

  it.each(['no_seed', 'pool_empty'] as const)('permits one materially changed artist correction after known %s, never case/prose-only changes', async failure => {
    const f = await fixture(kind);
    await f.call();
    await f.fail(failure);
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'discovery_correction_required' });
    await f.edit(['INVENTED  ARTIST'], 'Changed relationship');
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'discovery_correction_required' });
    await f.edit(['Different Invented Artist']);
    const results = await Promise.all([f.discover(), f.discover()]);
    expect(results.map(r => r.kind).sort()).toEqual(['admitted', 'rejected']);
    const state = (await f.read())!;
    expect(state.journey!.discoverRuns).toBe(2);
    expect(state.journey!.counts.qloo).toBe(1);
    expect(state.briefs.length).toBe(3);
  });

  it('allows a bounded explicit pre-send retry without resetting a withdrawn reservation', async () => {
    const f = await fixture(kind);
    const reserve = await f.make().reserveSubmission(f.owner, f.first.attempt.id, 'qloo_search', f.clock.t);
    if (!reserve.ok) throw new Error(reserve.code);
    await f.make().withdrawSubmission(f.owner.sessionId, f.first.attempt.id, reserve.call);
    await f.fail('admission_unavailable');
    expect(discoveryAvailability((await f.read())!)).toBe('available');
    expect((await f.discover()).kind).toBe('admitted');
    expect((await f.read())!.journey!.discoverRuns).toBe(2);
    expect((await f.read())!.journey!.counts.qloo).toBe(0);
  });

  it('counts a pre-send retry of a human continuation once instead of granting unlimited checkpoint resumptions', async () => {
    const f = await fixture(kind);
    await f.checkpoint();
    const continued = admitted(await f.discover());
    expect(continued.continuation).toBe(true);
    expect(continued.journey.discoverRuns).toBe(1);
    await f.make().settleAttempt(f.owner.sessionId, f.owner.epoch, continued.attempt.id, 'failed', 'capacity', f.clock.t);
    const corrected = admitted(await f.discover());
    expect(corrected.continuation).toBe(false);
    expect(corrected.journey.discoverRuns).toBe(2);
    await f.make().settleAttempt(f.owner.sessionId, f.owner.epoch, corrected.attempt.id, 'failed', 'capacity', f.clock.t);
    expect(await f.discover()).toEqual({ kind: 'rejected', code: 'discovery_used' });
    expect((await f.read())!.journey!.counts.qloo).toBe(1);
  });
});
