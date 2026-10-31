import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, Session } from '../src/shared/records.js';
import { createApiHandler } from '../src/server/app.js';
import type { CatalogueSeam } from '../src/server/catalogue.js';
import { loadConfig } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { runDiscover, runRefine } from '../src/server/graph.js';
import { sha256 } from '../src/server/ids.js';
import { initialJourneyTiming, timingMilestone, timingPhase } from '../src/server/journey-timing.js';
import { createFirestoreDocStore, type DocStore, type DocTx } from '../src/server/persistence/docstore.js';
import { validRecord } from '../src/server/persistence/record-schema.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createEphemeralSealer } from '../src/server/seal.js';
import { MemoryStore, type Store } from '../src/server/store.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

// Invented data, in-process provider envelopes and SDK-shaped fake only. No sockets/services.
const T0 = 1_800_000_000_000;
const REF = { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 } };
const ANALYSIS = { synthetic: true, audioAccess: 'synthetic_not_accessed' as const, observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null };
const policy = {
  version: 'synthetic-timing', currency: 'XTS', expiresAt: T0 + 36_000_000,
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
afterEach(() => vi.restoreAllMocks());

function setup(shared: boolean) {
  const clock = { t: T0 };
  const db = new FakeFirestoreServer();
  const real = createFirestoreDocStore(new FakeFirestore(db));
  const probe = { afterRead: null as (() => void) | null };
  const docs: DocStore = { ...real, transact: (fn) => real.transact((tx) => fn({
    ...tx, getAll: async (paths) => { const out = await tx.getAll(paths); probe.afterRead?.(); return out; },
  } as DocTx)) };
  const memory = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 4 });
  const make = (): Store => shared ? new FirestoreStore({ docs, serviceId: 'synthetic-timing', policy, clock: () => clock.t, maxSessions: 10, maxJourneysPerSession: 4 }) : memory;
  return { clock, db, make, probe, store: make() };
}
type Setup = ReturnType<typeof setup>;
async function reference(s: Setup) {
  const created = await s.store.createSession(T0) as { session: Session; secret: string };
  const owner = { sessionId: created.session.id, epoch: 1 };
  const input = { ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('ref'), inputHash: sha256('ref-input') };
  const admitted = await s.store.admitReference(input);
  if (admitted.kind !== 'admitted') throw new Error('fixture admission');
  return { ...created, owner, input, attempt: admitted.attempt };
}
async function ready(s: Setup, artist = 'Invented Artist') {
  const a = await reference(s);
  s.clock.t = T0 + 100;
  expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, s.clock.t)).toBe(true);
  const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
  s.clock.t = T0 + 400;
  const saved = await s.make().saveBrief(a.owner, { analysisId: b.analysis!.id, relationship: 'Invented relationship', relationshipSource: 'listener_text', proposedArtists: [artist], exclusions: [] },
    { expectedBriefId: null, actionKeyHash: sha256('brief'), inputHash: sha256('brief-input') }, s.clock.t);
  if (saved.kind !== 'saved') throw new Error('fixture brief');
  return { ...a, brief: saved.brief };
}
async function discover(s: Setup, a: Awaited<ReturnType<typeof ready>>, key = 'discover') {
  const r = await s.make().admitDiscover({ ...a.owner, now: s.clock.t, briefId: a.brief.id, actionKeyHash: sha256(key), inputHash: sha256(key) });
  if (r.kind !== 'admitted') throw new Error('fixture discover');
  return r.attempt;
}
const totals = (processingMs: number, listenerWaitMs: number, unobservedMs = 0) => ({ processingMs, listenerWaitMs, unobservedMs });

/** Genuine graph and Qloo decoder; overlapping Insights finish at 200/400 ms, not their sum. */
function graph(s: Setup, outcome: 'choices' | 'no_match' = 'choices') {
  const fixture = createSyntheticQlooTransport();
  const calls: string[] = [];
  let insightsStart = 0;
  let arrivals = 0;
  let release!: () => void;
  const pair = new Promise<void>((r) => { release = r; });
  let panels = 0;
  const catalogue: CatalogueSeam = { async investigate(_handoff, { plan }, ctx) {
    s.clock.t += 300; // catalogue preparation, validation and result assembly are logical processing too.
    panels++;
    const anchor = plan.anchors[0]!;
    const key = sha256(`invented-recording-${panels}`);
    return { kind: 'panel', panel: {
      synthetic: true, outcome,
      choices: outcome === 'no_match' ? [] : [{ handle: ctx.newHandle(), title: `Invented Track ${panels}`, credits: [anchor.name], unverifiedCredits: 0, anchor,
        recordingKey: key, destination: { kind: 'youtube', videoId: `0000000000${panels}`, url: `https://www.youtube.com/watch?v=0000000000${panels}` },
        fitHypothesis: 'Invented hypothesis', evidence: { kind: 'native_identity_support_plus_exact_metadata', creditSource: 'title', channelName: 'Invented channel', topicChannel: false, versions: [] }, sources: [] }],
      answerText: 'Invented result', marks: [], citations: [], suggestionsHtml: '<div>Invented Suggestions</div>', gaps: [], recordingKeys: outcome === 'choices' ? [key] : [],
    } };
  } };
  return {
    store: s.make(), qloo: createQlooClient({ host: 'hackathon.api.qloo.com', apiKey: new ServerSecret('synthetic-timing-not-a-key'), transport: async (req) => {
      const kind = req.url.pathname === '/search' ? 'search' : req.url.searchParams.get('filter.type') === 'urn:tag' ? 'tags' : 'artists';
      calls.push(kind);
      if (kind === 'search') s.clock.t += 100;
      else {
        if (++arrivals === 1) insightsStart = s.clock.t;
        if (arrivals === 2) release();
        await pair;
        s.clock.t = Math.max(s.clock.t, insightsStart + (kind === 'tags' ? 400 : 200));
      }
      return fixture(req);
    } }), qlooSynthetic: true, catalogue, sealer: createEphemeralSealer(), now: () => s.clock.t, inflight: new Map<Handle, AbortController>(), calls,
  };
}

async function get(s: Setup, secret: string, path = '/api/state') {
  const config = loadConfig([], { WINTR_MODE: 'synthetic', WINTR_PORT: '8787' });
  const handler = createApiHandler({ config, store: s.make(), now: () => s.clock.t, referenceAdapter: null });
  const req = new IncomingMessage(new Socket());
  req.method = 'GET'; req.url = path; req.headers = { host: config.hostHeader, cookie: `wintr_sid=${secret}` };
  const res = new ServerResponse(req);
  let body = '';
  res.end = ((chunk: unknown) => { body = String(chunk); return res; }) as typeof res.end;
  await handler(req, res); req.destroy();
  return { status: res.statusCode, body };
}

describe.each([false, true])('E07 logical intervals (shared=%s)', (shared) => {
  it('reconciles first milestones, parallel processing once, listener pause, reload and refinement without overwriting initial milestones', async () => {
    const s = setup(shared); vi.spyOn(Date, 'now').mockImplementation(() => s.clock.t);
    const a = await ready(s);
    const waiting = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.timing!;
    expect(waiting).toMatchObject({ phase: 'awaiting_listener', cursorAt: T0 + 100, quality: 'complete', ...totals(100, 0) });
    s.clock.t = T0 + 1000;
    const attempt = await discover(s, a);
    const deps = graph(s);
    await runDiscover(deps, attempt);
    const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(deps.calls).toEqual(['search', 'artists', 'tags']);
    expect(b.journey!.timing).toMatchObject({ cursorAt: T0 + 1800, phase: 'awaiting_listener', quality: 'complete', ...totals(900, 900), milestones: {
      reference_result: { at: T0 + 100, ...totals(100, 0) }, connection: { at: T0 + 1500, ...totals(600, 900) },
      panel_outcome: { at: T0 + 1800, ...totals(900, 900) }, recording_choices: { at: T0 + 1800, ...totals(900, 900) },
    } });
    expect(b.attempt!.timing).toEqual({ version: 1, finishedAt: T0 + 1800, recordedAt: T0 + 1800, finishBasis: 'transition' });
    const first = structuredClone(b.journey!.timing!.milestones);
    s.clock.t = T0 + 3000;
    const r = await s.make().admitRefine({ ...a.owner, now: s.clock.t, actionKeyHash: sha256('refine'), inputHash: sha256('refine'), mode: 'correct_direction', panelId: b.panel!.id,
      briefId: b.brief!.id, choice: null, relationship: null, excludedAnchors: [], poolFingerprint: b.pool!.fingerprint });
    if (r.kind !== 'admitted') throw new Error('fixture refine');
    await runRefine(deps, r.attempt);
    const refined = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(refined.attempt!.outcome).toBe('succeeded');
    expect(refined.journey!.timing).toMatchObject({ ...totals(1200, 2100), milestones: first });
    expect(deps.calls).toHaveLength(3); // correction reused the pool
    const api = await get(s, a.secret);
    expect(api.status).toBe(200);
    expect(api.body).not.toMatch(/timing|processingMs|listenerWaitMs|unobservedMs|finishedAt|recordedAt|milestones/);
    const suggestions = await get(s, a.secret, `/api/suggestions/${refined.panel!.id}`);
    expect(suggestions.status).toBe(200);
    expect(suggestions.body).not.toMatch(/timing|processingMs|listenerWaitMs|unobservedMs|milestones/);
  });

  it('clarification ends one execute; free choice and exact replay preserve the same listener window until Continue', async () => {
    const s = setup(shared); vi.spyOn(Date, 'now').mockImplementation(() => s.clock.t);
    const a = await ready(s, 'Ambiguous invented artist');
    s.clock.t = T0 + 1000;
    const attempt = await discover(s, a);
    const deps = graph(s);
    await runDiscover(deps, attempt);
    const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(b.journey!.timing).toMatchObject({ phase: 'awaiting_listener', cursorAt: T0 + 1100, ...totals(200, 900) });
    expect(b.attempt!.timing!.finishedAt).toBe(T0 + 1100);
    s.clock.t = T0 + 2100;
    const guard = { expectedRevision: b.checkpoint!.revision, actionKeyHash: sha256('choice'), inputHash: sha256('choice') };
    const choice = { checkpointId: b.checkpoint!.id, slot: 0, choice: b.checkpoint!.slots[0]!.options[0]! };
    expect(await s.make().chooseArtist(a.owner, choice, guard, s.clock.t)).toBe('ok');
    s.clock.t = T0 + 2500;
    await s.make().chooseArtist(a.owner, choice, guard, s.clock.t);
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.timing).toEqual(b.journey!.timing);
    s.clock.t = T0 + 3100;
    const continuation = await discover(s, a, 'continue');
    const resumed = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(resumed.journey!.timing).toMatchObject({ phase: 'processing', ...totals(200, 2900) });
    expect(continuation.timing).toEqual({ version: 1, finishedAt: null, recordedAt: null, finishBasis: null });
  });

  it('no_match records a panel outcome without inventing recording choices', async () => {
    const s = setup(shared); vi.spyOn(Date, 'now').mockImplementation(() => s.clock.t);
    const a = await ready(s); s.clock.t = T0 + 1000;
    await runDiscover(graph(s, 'no_match'), await discover(s, a));
    const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(b.journey!.stage).toBe('no_match');
    expect(b.journey!.timing!.milestones.panel_outcome).toMatchObject({ at: T0 + 1800 });
    expect(b.journey!.timing!.milestones.recording_choices).toBeNull();
  });

  it('a changed free choice after stopping Continue reopens a valid listener window without rewriting the terminal Attempt', async () => {
    const s = setup(shared); vi.spyOn(Date, 'now').mockImplementation(() => s.clock.t);
    const a = await ready(s, 'Ambiguous invented artist');
    s.clock.t = T0 + 1000;
    await runDiscover(graph(s), await discover(s, a));
    const waiting = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    s.clock.t = T0 + 2100;
    expect(await s.make().chooseArtist(a.owner, { checkpointId: waiting.checkpoint!.id, slot: 0, choice: waiting.checkpoint!.slots[0]!.options[0]! },
      { expectedRevision: waiting.checkpoint!.revision, actionKeyHash: sha256('initial-choice'), inputHash: sha256('initial-choice') }, s.clock.t)).toBe('ok');
    s.clock.t = T0 + 3100;
    const continuation = await discover(s, a, 'continue-then-stop');
    s.clock.t = T0 + 3300;
    expect(await s.make().stopAttempt(a.owner.sessionId, 1, continuation.id, s.clock.t)).toBe(true);
    const stopped = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    const terminal = structuredClone(stopped.attempt!.timing);
    s.clock.t = T0 + 4100;
    const guard = { expectedRevision: stopped.checkpoint!.revision, actionKeyHash: sha256('changed-choice'), inputHash: sha256('changed-choice') };
    const change = { checkpointId: stopped.checkpoint!.id, slot: 0, choice: null };
    expect(await s.make().chooseArtist(a.owner, change, guard, s.clock.t)).toBe('ok');
    const edited = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(edited.journey!.stage).toBe('awaiting_artist');
    expect(edited.journey!.timing).toMatchObject({ phase: 'awaiting_listener', cursorAt: T0 + 4100, quality: 'partial', ...totals(400, 2900, 800) });
    expect(edited.attempt!.timing).toEqual(terminal);
    s.clock.t += 200;
    expect(await s.make().chooseArtist(a.owner, change, guard, s.clock.t)).toBe('replay');
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.timing).toEqual(edited.journey!.timing);
  });

  it.each(['failed', 'expired', 'stop', 'intent_change'] as const)('%s finishes once and late callbacks cannot rewrite timing or content', async (terminal) => {
    const s = setup(shared); const a = await ready(s); s.clock.t = T0 + 1000;
    const attempt = await discover(s, a); s.clock.t = T0 + 1600;
    if (terminal === 'stop') await s.make().stopAttempt(a.owner.sessionId, 1, attempt.id, s.clock.t);
    else if (terminal === 'intent_change') await s.make().saveBrief(a.owner, { analysisId: a.brief.analysisId, relationship: 'Changed invented relationship', relationshipSource: 'listener_text', proposedArtists: [], exclusions: [] },
      { expectedBriefId: a.brief.id, actionKeyHash: sha256('edit'), inputHash: sha256('edit') }, s.clock.t);
    else await s.make().settleAttempt(a.owner.sessionId, 1, attempt.id, terminal, terminal === 'failed' ? 'qloo_failed' : null, s.clock.t);
    const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(b.attempt!.timing).toEqual({ version: 1, finishedAt: s.clock.t, recordedAt: s.clock.t, finishBasis: 'transition' });
    expect(b.journey!.timing).toMatchObject({ ...totals(700, 900), phase: terminal === 'intent_change' ? 'awaiting_listener' : 'closed' });
    s.clock.t += 500;
    expect(await s.make().settleAttempt(a.owner.sessionId, 1, attempt.id, 'failed', 'deadline', s.clock.t)).toBe(false);
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, attempt.id, ANALYSIS, s.clock.t)).toBe(false);
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.timing).toEqual(b.journey!.timing);
  });

  it.each([false, true])('late orphan recovery/direct refused resend (readFirst=%s) accounts for the gap once without changing holds', async (readFirst) => {
    const s = setup(shared); const a = await ready(s); s.clock.t = T0 + 1000;
    const attempt = await discover(s, a);
    await s.make().reserveSubmission(a.owner, attempt.id, 'qloo_search', s.clock.t);
    await s.make().beginSubmission(a.owner, attempt.id, 0, s.clock.t);
    const ledger = s.db.entries('wintr_ledger');
    s.clock.t = attempt.deadlineAt + 5000;
    if (readFirst) {
      const recovered = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
      expect(recovered.attempt!.timing).toEqual({ version: 1, finishedAt: attempt.deadlineAt, recordedAt: s.clock.t, finishBasis: 'deadline' });
      expect(recovered.journey!.timing).toMatchObject({ phase: 'closed', quality: 'partial', ...totals(120100, 900, 5000) });
      expect(await s.make().read(a.owner.sessionId, 1, s.clock.t)).toEqual(recovered);
    }
    const next = await s.make().admitDiscover({ ...a.owner, now: s.clock.t, briefId: a.brief.id,
      actionKeyHash: sha256('second-discover'), inputHash: sha256('second-discover') });
    expect(next).toEqual({ kind: 'rejected', code: 'discovery_retry_unavailable' });
    const after = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(after.journey!.timing).toMatchObject({ phase: 'closed', quality: 'partial', ...totals(120100, 900, 5000) });
    expect(after.attempt!.timing).toEqual({ version: 1, finishedAt: attempt.deadlineAt, recordedAt: s.clock.t, finishBasis: 'deadline' });
    expect(after.journey!.discoverRuns).toBe(1);
    expect(after.journey!.counts).toEqual({ gemini: 0, qloo: 1 });
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
    expect(await s.make().beginSubmission(a.owner, attempt.id, 0, s.clock.t)).toBe('held');
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, attempt.id, ANALYSIS, s.clock.t)).toBe(false);
    expect(after.attempt!.id).toBe(attempt.id);
  });

  it.each(['clear', 'expiry', 'replacement'] as const)('%s cannot resurrect an owned summary through late work; ledger stays separate', async (action) => {
    const s = setup(shared); const a = await reference(s);
    await s.make().reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0);
    await s.make().beginSubmission(a.owner, a.attempt.id, 0, T0);
    const ledger = s.db.entries('wintr_ledger');
    if (action === 'clear') await s.make().clearSession(a.owner.sessionId);
    else if (action === 'expiry') s.clock.t = a.session.expiresAt;
    else {
      s.clock.t = a.attempt.deadlineAt + 1;
      const r = await s.make().admitReference({ ...a.input, now: s.clock.t, actionKeyHash: sha256('new-source'), inputHash: sha256('new-source') });
      expect(r.kind).toBe('admitted');
    }
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, s.clock.t)).toBe(false);
    const b = await s.make().read(a.owner.sessionId, 1, s.clock.t);
    if (action !== 'replacement') expect(b).toBeNull();
    else expect(b!.journey!.timing).toEqual(initialJourneyTiming(s.clock.t));
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
    if (action === 'clear') expect(JSON.stringify(s.db.entries('wintr_owned/'))).not.toMatch(/processingMs|listenerWaitMs|milestones/);
  });
});

describe('E07 strict legacy, corruption and clock quality', () => {
  it('rejects known success at or after the deadline even when clock regression hides its finish', async () => {
    const s = setup(false); const a = await ready(s);
    const attempt = (await s.store.read(a.owner.sessionId, 1, s.clock.t))!.attempt!;
    const ctx = { sessionId: a.owner.sessionId, epoch: 1, sessionExpiresAt: a.session.expiresAt };
    for (const recordedAt of [attempt.deadlineAt, attempt.deadlineAt + 1]) {
      const timing = { version: 1, finishedAt: null, recordedAt, finishBasis: 'clock_regression' };
      expect(validRecord('attempt', { ...attempt, timing }, attempt.id, ctx)).toBe(false);
    }
    expect(validRecord('attempt', { ...attempt, timing: { version: 1, finishedAt: null, recordedAt: attempt.deadlineAt - 1, finishBasis: 'clock_regression' } }, attempt.id, ctx)).toBe(true);
  });

  it('accepts exact legacy and exact new schemas; rejects malformed fields, overflow, order, phase and terminal inconsistencies', async () => {
    const s = setup(false); const a = await ready(s);
    const b = (await s.store.read(a.owner.sessionId, 1, s.clock.t))!;
    const ctx = { sessionId: a.owner.sessionId, epoch: 1, sessionExpiresAt: a.session.expiresAt };
    for (const kind of ['journey', 'attempt'] as const) {
      const record = b[kind]!;
      expect(validRecord(kind, record, record.id, ctx)).toBe(true);
      const legacy = structuredClone(record); delete legacy.timing;
      expect(validRecord(kind, legacy, record.id, ctx)).toBe(true);
      for (const bad of [null, undefined, {}, { ...record.timing, extra: 0 }, { ...record.timing, version: 2 }]) {
        expect(validRecord(kind, { ...record, timing: bad }, record.id, ctx)).toBe(false);
      }
    }
    const j = b.journey!;
    for (const change of [
      { processingMs: -1 }, { listenerWaitMs: 0.5 }, { processingMs: Number.MAX_SAFE_INTEGER }, { cursorAt: Infinity },
      { cursorAt: j.createdAt - 1 }, { phase: 'processing' }, { quality: 'complete', clock: 'regressed' }, { clock: ['ordered'] },
      { milestones: { ...j.timing!.milestones, connection: { at: T0 + 99, quality: 'complete', ...totals(99, 0) } } },
    ]) expect(validRecord('journey', { ...j, timing: { ...j.timing, ...change } }, j.id, ctx)).toBe(false);
    const attempt = b.attempt!;
    for (const timing of [
      { ...attempt.timing, finishBasis: null }, { ...attempt.timing, recordedAt: T0 + 99 },
      { ...attempt.timing, finishBasis: 'deadline' }, { ...attempt.timing, finishedAt: -1 },
    ]) expect(validRecord('attempt', { ...attempt, timing }, attempt.id, ctx)).toBe(false);
    expect(validRecord('attempt', { ...attempt, outcome: 'running' }, attempt.id, ctx)).toBe(false);
  });

  it('legacy history becomes explicitly partial on a later real admission without fabricating milestones', async () => {
    const s = setup(true); vi.spyOn(Date, 'now').mockImplementation(() => s.clock.t);
    const a = await ready(s);
    for (const [path, data] of s.db.entries('wintr_owned/')) {
      if (!(path.includes('/journey_') || path.includes('/attempt_'))) continue;
      const body = { ...(data.body as Record<string, unknown>) }; delete body.timing;
      s.db.seed(path, { ...data, body });
    }
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.timing).toBeUndefined();
    s.clock.t = T0 + 1000;
    const attempt = await discover(s, a);
    const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(b.journey!.timing).toMatchObject({ quality: 'partial', ...totals(0, 0, 1000), milestones: {
      reference_result: 'unknown', connection: 'unknown', panel_outcome: 'unknown', recording_choices: 'unknown',
    } });
    await runDiscover(graph(s), attempt);
    const complete = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(complete.journey!.timing).toMatchObject({ ...totals(800, 0, 1000), milestones: b.journey!.timing!.milestones });
  });

  it('a measured zero remains complete; legacy omission and a backwards terminal sample stay explicitly different', async () => {
    const s = setup(false); const a = await reference(s);
    await s.store.commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0);
    const zero = (await s.store.read(a.owner.sessionId, 1, T0))!;
    expect(zero.journey!.timing).toMatchObject({ quality: 'complete', ...totals(0, 0, 0) });
    expect(zero.attempt!.timing).toEqual({ version: 1, finishedAt: T0, recordedAt: T0, finishBasis: 'transition' });
    const other = setup(false); const next = await reference(other);
    await other.store.stopAttempt(next.owner.sessionId, 1, next.attempt.id, T0 - 1);
    const backwards = (await other.store.read(next.owner.sessionId, 1, T0))!;
    expect(backwards.journey!.timing).toMatchObject({ quality: 'partial', clock: 'recovering', ...totals(0, 0, 0) });
    expect(backwards.attempt!.timing).toEqual({ version: 1, finishedAt: null, recordedAt: null, finishBasis: 'clock_regression' });
  });

  it('corrupt persisted timing fails closed at Store and GET without disclosing or changing private state/accounting', async () => {
    const s = setup(true); const a = await reference(s);
    await s.make().reserveSubmission(a.owner, a.attempt.id, 'reference_analysis', T0);
    const ledger = s.db.entries('wintr_ledger');
    const [path, data] = s.db.entries('wintr_owned/journey_')[0]!;
    const body = data.body as Record<string, unknown>;
    s.db.seed(path, { ...data, body: { ...body, timing: { ...(body.timing as object), processingMs: Number.MAX_SAFE_INTEGER } } });
    const before = s.db.entries();
    await expect(s.make().read(a.owner.sessionId, 1, T0)).rejects.toThrow('store unavailable');
    const api = await get(s, a.secret);
    expect(api.status).toBe(503);
    expect(api.body).not.toMatch(/timing|processingMs|milestones|00000000001/);
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0)).toBe(false);
    expect(s.db.entries()).toEqual(before);
    expect(s.db.entries('wintr_ledger')).toEqual(ledger);
  });

  it('a backwards clock leaves the cursor authoritative and the next uncertain interval unobserved, distinct from measured zero', async () => {
    const s = setup(false); const a = await ready(s);
    const j = (await s.store.read(a.owner.sessionId, 1, s.clock.t))!.journey!;
    timingPhase(j, T0 + 50, 'processing');
    expect(j.timing).toMatchObject({ cursorAt: T0 + 100, clock: 'recovering', quality: 'partial', ...totals(100, 0) });
    timingMilestone(j, T0 + 70, 'connection');
    expect(j.timing!.milestones.connection).toBe('unknown');
    timingPhase(j, T0 + 300, 'awaiting_listener');
    expect(j.timing).toMatchObject({ clock: 'regressed', quality: 'partial', ...totals(100, 0, 200) });
    timingPhase(j, T0 + 400, 'processing');
    expect(j.timing).toMatchObject(totals(100, 100, 200));
  });

  it('transaction retry uses its post-await sampler; losing callback timing does not leak or double count', async () => {
    const s = setup(true); const a = await reference(s);
    let retries = 0;
    s.db.beforeCommit = () => {
      if (retries++ !== 0) return;
      const [path, data] = s.db.entries('wintr_owned/journey_')[0]!;
      s.db.seed(path, data); // conflict and rerun the callback against unchanged authoritative content
      s.clock.t = T0 + 400;
    };
    s.clock.t = T0 + 100;
    s.probe.afterRead = () => { s.clock.t = Math.max(s.clock.t, T0 + 200); };
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0 + 100)).toBe(true);
    s.db.beforeCommit = null; s.probe.afterRead = null;
    const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(s.db.conflicts).toBe(1);
    expect(b.journey!.timing).toMatchObject({ ...totals(400, 0), milestones: { reference_result: { at: T0 + 400 } } });
    expect(b.attempt!.timing).toMatchObject({ finishedAt: T0 + 400, recordedAt: T0 + 400 });
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, s.clock.t + 20)).toBe(false);
    expect((await s.make().read(a.owner.sessionId, 1, s.clock.t))!.journey!.timing).toEqual(b.journey!.timing);
  });

  it('a failed terminal transaction reports refusal and cannot leave a successful timing summary behind', async () => {
    const s = setup(true); const a = await reference(s);
    const before = s.db.entries();
    s.clock.t = T0 + 100;
    s.db.faults.push('unavailable');
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, s.clock.t)).toBe(false);
    expect(s.db.entries()).toEqual(before);
    const b = (await s.make().read(a.owner.sessionId, 1, s.clock.t))!;
    expect(b.analysis).toBeNull();
    expect(b.attempt!.timing).toEqual({ version: 1, finishedAt: null, recordedAt: null, finishBasis: null });
    expect(b.journey!.timing!.milestones.reference_result).toBeNull();
    expect(b.journey!.timing).toMatchObject({ phase: 'processing', cursorAt: T0, ...totals(0, 0) });
  });

  it('a within-transaction backwards sample is disclosed without lowering live authority time', async () => {
    const s = setup(true); const a = await reference(s);
    s.clock.t = T0 + 100;
    s.probe.afterRead = () => { s.clock.t = T0 + 50; };
    expect(await s.make().commitAnalysis(a.owner.sessionId, 1, a.attempt.id, ANALYSIS, T0 + 100)).toBe(true);
    s.probe.afterRead = null;
    const b = (await s.make().read(a.owner.sessionId, 1, T0 + 100))!;
    expect(b.journey!.timing).toMatchObject({ quality: 'partial', ...totals(0, 0, 100) });
    expect(b.attempt!.timing).toEqual({ version: 1, finishedAt: null, recordedAt: T0 + 100, finishBasis: 'clock_regression' });
  });
});
