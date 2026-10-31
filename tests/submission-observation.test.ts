import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SubmissionStage } from '../src/shared/records.js';
import { createApiHandler } from '../src/server/app.js';
import { gatedTransport } from '../src/server/live-runtime.js';
import { loadConfig } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { openExecution, runReferenceStage, submit } from '../src/server/harness.js';
import { runDiscover } from '../src/server/graph.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createSourceResolver } from '../src/server/source-resolver.js';
import { emptyObservedUsage, INTERACTIONS_REFERENCE_OBSERVATION_PROFILE, mergeObservation, observeUsage, parseObservation, type SubmissionObservation } from '../src/server/ledger/observation.js';
import { parseReservation } from '../src/server/ledger/transitions.js';
import { createFirestoreDocStore, type DocData } from '../src/server/persistence/docstore.js';
import { createGeminiCatalogueAdapter } from '../src/server/providers/gemini-catalogue.js';
import { createGeminiReferenceAdapter } from '../src/server/providers/gemini-reference.js';
import { type HttpTransport, type ProviderResponse } from '../src/server/providers/http.js';
import { createCallObserver, type CallObserver } from '../src/server/providers/observation.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { createRecordSealer } from '../src/server/seal.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';
import { MemoryStore, type Store } from '../src/server/store.js';
import { envelope, fakeNetwork, sseBody, VID } from './fixtures/catalogue-fixtures.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { policy } from './fixtures/live-fixtures.js';

// Accounting only, with fake clocks/transports/database. No provider or SDK construction.
const T0 = 1_800_000_000_000;
const INPUT = { reference: { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 } }, listenerCue: null };
const SECRET = new ServerSecret('invented-observation-secret-0001');
function deferred<T>() { let resolve!: (x: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const response = (usageMetadata: unknown, text = 'invalid output'): ProviderResponse => ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata })) });
const marked = (send: HttpTransport): HttpTransport => async (req) => { req.observer?.transportStarted(); return send(req); };
const executions: ReturnType<typeof openExecution>[] = [];
afterEach(() => { for (const e of executions.splice(0)) e.close(); vi.useRealTimers(); });
async function flush(store: Store) {
  for (let i = 0; i < 30; i += 1) { await vi.advanceTimersByTimeAsync(10); if (store.observationHealth().pendingWrites === 0) { await vi.advanceTimersByTimeAsync(10); if (store.observationHealth().pendingWrites === 0) return; } }
  throw new Error('synthetic receipt writes did not settle');
}
async function setup(shared = true) {
  vi.useFakeTimers(); vi.setSystemTime(T0);
  const db = new FakeFirestoreServer();
  const memory = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 3 });
  const make = () => new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'synthetic-observations', policy: policy(T0 + 10_000_000, 'XTS'), clock: Date.now, maxSessions: 10, maxJourneysPerSession: 3 });
  const store = shared ? make() : memory;
  const created = await store.createSession(T0); if (!created || typeof created === 'string') throw new Error('synthetic session failed');
  const owner = { sessionId: created.session.id, epoch: 1 };
  const result = await store.admitReference({ ...owner, now: T0, reference: INPUT.reference, listenerCue: null, actionKeyHash: 'invented-action', inputHash: 'invented-input' });
  if (result.kind !== 'admitted') throw new Error('synthetic admission failed');
  const inflight = new Map<Handle, AbortController>();
  const exec = openExecution(result.attempt, 120_000, inflight); executions.push(exec);
  const run = <T>(stage: SubmissionStage, call: (signal: AbortSignal, observer?: CallObserver) => Promise<T>) => submit(store, exec, owner, result.attempt.id, result.attempt.deadlineAt, stage, Date.now, call);
  const observation = async () => shared ? (await make().reconciliation().unresolved(10))[0]!.observation : memory.submissionObservation(result.attempt.id, 0);
  return { db, store, make, owner, attempt: result.attempt, inflight, exec, run, observation, secret: created.secret };
}

describe('normalised receipt usage and strict bounded schema', () => {
  it.each([null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'])('a malformed supplied counter never becomes zero (%#)', (value) => {
    const u = emptyObservedUsage(); observeUsage(u, { total_input_tokens: value }, 'reference');
    expect(u.inputTokens).toEqual({ value: null, state: 'missing', malformed: true });
  });

  it('distinguishes unknown, known zero, missing and malformed without retaining arbitrary fields', () => {
    const u = emptyObservedUsage(); expect(u.inputTokens).toEqual({ value: null, state: 'unknown', malformed: false });
    observeUsage(u, { total_input_tokens: 0, total_output_tokens: '9', total_tokens: -1, prompt: 'must disappear' }, 'reference');
    expect(u.inputTokens).toEqual({ value: 0, state: 'known', malformed: false });
    expect(u.outputTokens).toEqual({ value: null, state: 'missing', malformed: true });
    expect(u.totalTokens.malformed).toBe(true); expect(u.cachedTokens).toMatchObject({ value: null, state: 'missing', malformed: false });
    expect(JSON.stringify(u)).not.toContain('prompt');
    observeUsage(u, { total_input_tokens: null, total_output_tokens: Number.MAX_SAFE_INTEGER + 1 }, 'reference');
    expect(u.inputTokens).toEqual({ value: 0, state: 'known', malformed: true });
  });

  it('maps GenerateContent usageMetadata for the new profile while the historical Interactions shape stays separate', () => {
    const u = emptyObservedUsage();
    observeUsage(u, { promptTokenCount: 0, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 7, total_input_tokens: 99, private: 'x' }, 'generate_content');
    expect(u.inputTokens).toEqual({ value: 0, state: 'known', malformed: false });
    expect(u.thoughtTokens.value).toBe(2); expect(u.totalTokens.value).toBe(7); expect(JSON.stringify(u)).not.toContain('private');
    const old = emptyObservedUsage(); observeUsage(old, { total_input_tokens: 9, promptTokenCount: 99 }, 'reference');
    expect(old.inputTokens.value).toBe(9);
  });

  it('keeps a saved Interactions-profile unknown-cost observation parseable and never relabels it', async () => {
    const o = createCallObserver('reference_analysis', T0, () => T0, async () => 'stored');
    expect(o.snapshot().profile).toBe('gemini_3_6_flash_medium_generate_content_v1');
    o.observer.adapterEntered(); o.finish();
    const final = o.snapshot(); const saved = { ...final, profile: INTERACTIONS_REFERENCE_OBSERVATION_PROFILE };
    expect(parseObservation(saved)).toMatchObject({ profile: 'gemini_3_6_flash_medium_interactions' });
    expect(parseObservation({ ...saved, stage: 'catalogue_generation', provider: 'gemini' })).toBeNull();
    expect(mergeObservation(parseObservation(saved), final)).toBeNull();
    expect(mergeObservation(parseObservation(saved), saved)).toEqual(saved);
    expect(() => createCallObserver('reference_analysis', T0, () => T0, async () => 'stored', INTERACTIONS_REFERENCE_OBSERVATION_PROFILE)).toThrow();
    await o.flush();
  });

  it('takes cumulative SSE snapshots, never sums, and retains earlier valid values after malformed/lower later counters', () => {
    const u = emptyObservedUsage();
    observeUsage(u, { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 20 }, 'catalogue');
    observeUsage(u, { promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 26 }, 'catalogue');
    observeUsage(u, { promptTokenCount: 'bad', candidatesTokenCount: 2 }, 'catalogue');
    expect(u.inputTokens).toEqual({ value: 12, state: 'known', malformed: true });
    expect(u.outputTokens).toEqual({ value: 9, state: 'known', malformed: true }); expect(u.totalTokens.value).toBe(26);
  });

  it('marks a backward clock sample unavailable instead of inventing a zero transport duration', async () => {
    vi.useFakeTimers();
    let t = T0;
    const o = createCallObserver('reference_analysis', T0, () => t, async () => 'stored');
    o.observer.adapterEntered(); o.observer.transportPending();
    t += 100; o.observer.transportStarted();
    t -= 50; o.observer.transportFinished(200); o.finish();
    expect(o.snapshot()).toMatchObject({ clockInvalid: true, transportStartedAt: T0 + 100, transportEndedAt: null, transportMs: null, adapterEndedAt: null });
    expect(parseObservation(o.snapshot())).not.toBeNull();
    await vi.advanceTimersByTimeAsync(0); await o.flush();
  });

  it('rejects a persisted transport end before its known start, even when a null duration is supplied', async () => {
    const o = createCallObserver('reference_analysis', T0, () => T0 + 100, async () => 'stored');
    o.observer.adapterEntered(); o.finish();
    const crossed = { ...o.snapshot(), invocation: 'one', transportStartedAt: T0 + 80, transportEndedAt: T0 + 20, preparationMs: 80, transportMs: null, transportOutcome: 'response', status: 200 };
    expect(parseObservation(crossed)).toBeNull();
    await o.flush();
  });

  it('coalesces any number of cumulative snapshots into terminal writes, with a hard maximum of three queued writes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(T0);
    const sink = vi.fn(async (_value: SubmissionObservation) => 'stored' as const);
    const o = createCallObserver('catalogue_generation', T0, Date.now, sink);
    o.observer.adapterEntered(); o.observer.transportPending(); o.observer.transportStarted();
    for (let i = 0; i < 1000; i += 1) o.observer.usage({ candidatesTokenCount: i }, 'catalogue');
    o.observer.usageDecoded(); expect(sink).not.toHaveBeenCalled();
    o.interrupt(false); o.finish(new Error('invented cancellation')); await vi.advanceTimersByTimeAsync(0); await o.flush();
    expect(sink).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    o.observer.transportFinished(200); o.observer.usage({ candidatesTokenCount: 1000 }, 'catalogue'); o.observer.usageDecoded();
    await vi.advanceTimersByTimeAsync(0); await o.flush(); expect(sink).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 20; i += 1) { o.observer.usage({ candidatesTokenCount: 1001 + i }, 'catalogue'); o.observer.usageDecoded(); await vi.advanceTimersByTimeAsync(0); }
    await o.flush(); expect(sink).toHaveBeenCalledTimes(3);
    expect(sink.mock.calls[1]![0].usage.outputTokens.value).toBe(1000);
    expect(sink.mock.calls.map(([value]) => value.revision)).toEqual([0, 1, 2]);
  });

  it('rejects extra keys, mismatched profiles, unsafe/crossed times, inconsistent counters and conflicting enrichment', async () => {
    const o = createCallObserver('reference_analysis', T0, () => T0, async () => 'stored');
    const initial = o.snapshot(); o.observer.adapterEntered(); o.finish(); const final = o.snapshot();
    expect(parseObservation(final)).not.toBeNull(); expect(mergeObservation(final, initial)).toEqual(final);
    const bad: unknown[] = [{ ...final, prompt: 'private' }, { ...final, profile: 'arbitrary' }, { ...final, adapterEndedAt: T0 - 1 }, { ...final, invocation: ['zero'] }, { ...final, revision: 9 }, { ...final, preparationMs: -1 }];
    const counter = structuredClone(final); counter.usage.inputTokens = { value: 0, state: 'missing', malformed: false }; bad.push(counter);
    for (const x of bad) expect(parseObservation(x)).toBeNull();
    const conflict = { ...final, adapterStartedAt: T0 + 1 }; expect(mergeObservation(final, conflict)).toBeNull();
    await o.flush();
  });
});

describe.each([false, true])('submission observation persistence (shared=%s)', (shared) => {
  it('invalid reference output preserves decoded zero/usage before validation, independent of monetary settlement', async () => {
    const s = await setup(shared);
    const adapter = createGeminiReferenceAdapter({ apiKey: SECRET, transport: marked(async () => response({ promptTokenCount: 0, candidatesTokenCount: 7, totalTokenCount: 7 })) });
    await expect(s.run('reference_analysis', (signal, observer) => adapter.analyse(INPUT, signal, observer))).rejects.toMatchObject({ kind: 'schema' });
    s.exec.close(); await flush(s.store);
    expect(await s.observation()).toMatchObject({ invocation: 'one', outcome: 'failed', error: 'schema', status: 200, usage: { inputTokens: { value: 0, state: 'known' }, outputTokens: { value: 7, state: 'known' } } });
    expect(s.store.observationHealth()).toMatchObject({ pendingWrites: 0, failedWrites: 0 });
    if (shared) expect(await s.make().reconciliation().totals()).toMatchObject({ counts: { gemini: 1, qloo: 0 }, unitsHeld: 300 });
  });

  it('a custom uninstrumented adapter cannot manufacture a confirmed zero transport count', async () => {
    const s = await setup(shared); await s.run('reference_analysis', async () => 'invented result');
    s.exec.close(); await flush(s.store); expect(await s.observation()).toMatchObject({ invocation: 'unknown', transportStartedAt: null, outcome: 'returned' });
  });
});

describe('bounded native catalogue receipts', () => {
  it('a composed guard does not promote a custom uninstrumented transport into an observed HTTP invocation', async () => {
    const s = await setup(); let calls = 0;
    const adapter = createGeminiReferenceAdapter({ apiKey: SECRET, transport: gatedTransport(async () => {
      calls += 1; return response({ totalTokenCount: 3 });
    }, 'gemini', T0 + 10_000, Date.now) });
    await expect(s.run('reference_analysis', (signal, observer) => adapter.analyse(INPUT, signal, observer))).rejects.toMatchObject({ kind: 'schema' });
    s.exec.close(); await flush(s.store);
    expect(calls).toBe(1);
    expect(await s.observation()).toMatchObject({ invocation: 'unknown', transportStartedAt: null, transportEndedAt: null, transportMs: null, status: 200 });
  });

  it('a transport guard rejection after token delay is a confirmed zero inner invocation', async () => {
    const s = await setup(); const token = deferred<ServerSecret>(); let sends = 0;
    const adapter = createGeminiCatalogueAdapter({ project: 'invented-project', quotaProject: 'invented-quota', accessToken: () => token.promise,
      transport: gatedTransport(async () => { sends += 1; return envelope([], { none: true }); }, 'gemini', T0 + 50, Date.now) });
    const work = s.run('catalogue_generation', (signal, observer) => adapter.generate('invented prompt', { signal, observer, now: Date.now, deadlineAt: T0 + 80_000 })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100); token.resolve(SECRET); await work; s.exec.close(); await flush(s.store);
    expect(sends).toBe(0); expect(await s.observation()).toMatchObject({ invocation: 'zero', preparationMs: 100, transportStartedAt: null, transportOutcome: 'pending' });
  });

  it('a later recording rejection retains usage from the generation without claiming a supported result', async () => {
    const s = await setup(); s.exec.close();
    expect(await s.store.commitAnalysis(s.owner.sessionId, 1, s.attempt.id, { synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null }, T0)).toBe(true);
    const ref = (await s.store.read(s.owner.sessionId, 1, T0))!;
    const saved = await s.store.saveBrief(s.owner, { analysisId: ref.analysis!.id, relationship: 'Invented relationship', relationshipSource: 'analysis_choice', proposedArtists: ['Invented Artist'], exclusions: [] }, { actionKeyHash: 'save-invented', inputHash: 'save-input', expectedBriefId: null }, T0);
    if (saved.kind !== 'saved') throw new Error('synthetic brief failed');
    const discovery = await s.store.admitDiscover({ ...s.owner, now: T0, briefId: saved.brief.id, actionKeyHash: 'discover-invented', inputHash: 'discover-input' });
    if (discovery.kind !== 'admitted') throw new Error('synthetic discovery failed');
    const adapter = createGeminiCatalogueAdapter({ project: 'invented-project', quotaProject: 'invented-quota', accessToken: async () => SECRET, transport: marked(async () => envelope([{ title: 'Invented unmatched recording', artists: ['Synthetic Neighbour A'], anchor: 'Synthetic Neighbour A', videoId: VID(1) }])) });
    const net = fakeNetwork({});
    const work = runDiscover({ store: s.store, now: Date.now, inflight: s.inflight, qloo: createQlooClient({ transport: createSyntheticQlooTransport(), apiKey: SECRET, host: 'hackathon.api.qloo.com' }), qlooSynthetic: true,
      catalogue: createNativeCatalogue({ adapter, verifier: { synthetic: true, lookup: async () => ({ ok: false, gap: 'title_mismatch' }) }, sources: createSourceResolver({ resolve: net.resolve, http: net.http, now: Date.now }, true) }), sealer: createRecordSealer(new ServerSecret('invented-sealing-observation-test-000001')) }, discovery.attempt);
    await vi.advanceTimersByTimeAsync(100); await work; await flush(s.store);
    const view = (await s.store.read(s.owner.sessionId, 1, Date.now()))!;
    expect(view.panel).toMatchObject({ outcome: 'no_match', choices: [], gaps: [{ reason: 'title_mismatch', count: 1 }] });
    const o = (await s.make().reconciliation().unresolved(10)).find((r) => r.stage === 'catalogue_generation')!.observation;
    expect(o).toMatchObject({ outcome: 'returned', invocation: 'one', usage: { totalTokens: { value: 30 }, searchQueries: { value: 1 } } });
    expect(JSON.stringify(o)).not.toContain('unmatched recording');
  });

  it.each(['SAFETY', 'MAX_TOKENS'])('keeps independent cumulative usage when finish reason is %s', async (finish) => {
    const s = await setup();
    const res = { status: 200, contentType: 'text/event-stream', body: sseBody([
      { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 3, totalTokenCount: 3 }, candidates: [{ content: { parts: [{ text: 'incomplete invented output' }] }, finishReason: finish }] },
      { usageMetadata: { promptTokenCount: 'bad', candidatesTokenCount: 7, totalTokenCount: 7, arbitrary_private_key: 99 } },
    ]) };
    const adapter = createGeminiCatalogueAdapter({ project: 'invented-project', quotaProject: 'invented-quota', accessToken: async () => SECRET, transport: marked(async () => res) });
    await expect(s.run('catalogue_generation', (signal, observer) => adapter.generate('invented prompt', { signal, observer, now: Date.now, deadlineAt: T0 + 80_000 }))).rejects.toMatchObject({ kind: finish === 'SAFETY' ? 'refused' : 'incomplete' });
    s.exec.close(); await flush(s.store);
    expect(await s.observation()).toMatchObject({ invocation: 'one', usage: { inputTokens: { value: 0, malformed: true }, outputTokens: { value: 7 }, totalTokens: { value: 7 } } });
    expect(JSON.stringify(await s.observation())).not.toContain('arbitrary_private_key');
  });

  it('separates delayed token preparation from actual post-gate transport/body completion', async () => {
    const s = await setup(); const token = deferred<ServerSecret>(); const body = deferred<ProviderResponse>(); let sends = 0;
    const adapter = createGeminiCatalogueAdapter({ project: 'invented-project', quotaProject: 'invented-quota', accessToken: () => token.promise, transport: marked(async () => { sends += 1; return body.promise; }) });
    const pending = s.run('catalogue_generation', (signal, observer) => adapter.generate('invented prompt', { signal, observer, now: Date.now, deadlineAt: T0 + 80_000 }));
    await vi.advanceTimersByTimeAsync(100); expect(sends).toBe(0);
    token.resolve(SECRET); await vi.advanceTimersByTimeAsync(0); expect(sends).toBe(1);
    await vi.advanceTimersByTimeAsync(250); body.resolve(envelope([], { none: true })); await pending;
    s.exec.close(); await flush(s.store);
    expect(await s.observation()).toMatchObject({ adapterStartedAt: T0, transportStartedAt: T0 + 100, preparationMs: 100, transportEndedAt: T0 + 350, transportMs: 250, invocation: 'one', transportOutcome: 'response' });
  });

  it('token preparation timeout confirms zero; an outstanding transport timeout remains one with unknown body completion', async () => {
    for (const tokenHeld of [true, false]) {
      const s = await setup(); let sends = 0;
      const adapter = createGeminiCatalogueAdapter({ project: 'invented-project', quotaProject: 'invented-quota', accessToken: tokenHeld ? () => new Promise(() => {}) : async () => SECRET, transport: marked(async () => { sends += 1; return new Promise(() => {}); }) });
      const pending = s.run('catalogue_generation', (signal, observer) => adapter.generate('invented prompt', { signal, observer, now: Date.now, deadlineAt: T0 + 30 })).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(30); expect(await pending).toMatchObject({ kind: 'deadline' }); s.exec.close(); await flush(s.store);
      expect(sends).toBe(tokenHeld ? 0 : 1);
      expect(await s.observation()).toMatchObject({ invocation: tokenHeld ? 'zero' : 'one', outcome: 'deadline', transportOutcome: 'pending', transportEndedAt: null, transportMs: null });
    }
  });
});

describe('late accounting, strict migration and controller durability health', () => {
  it('Clear returns promptly; a late bounded response enriches only accounting across Store reconstruction', async () => {
    const s = await setup(); const late = deferred<ProviderResponse>(); let sends = 0;
    const adapter = createGeminiReferenceAdapter({ apiKey: SECRET, transport: marked(async () => { sends += 1; return late.promise; }) });
    const run = runReferenceStage({ store: s.store, adapter, now: Date.now, inflight: s.inflight }, s.attempt, INPUT);
    await vi.advanceTimersByTimeAsync(0);
    await s.store.clearSession(s.owner.sessionId); s.inflight.get(s.attempt.id)!.abort('cleared');
    await run; s.exec.close(); await flush(s.store);
    const totals = await s.make().reconciliation().totals();
    expect(await s.make().read(s.owner.sessionId, 1, Date.now())).toBeNull();
    expect(await s.observation()).toMatchObject({ outcome: 'aborted', invocation: 'one', transportOutcome: 'pending', usage: { totalTokens: { state: 'unknown' } } });
    late.resolve(response({ promptTokenCount: 6, candidatesTokenCount: 0, totalTokenCount: 6 }, 'this output must never resurrect')); await flush(s.store);
    expect(await s.observation()).toMatchObject({ outcome: 'aborted', invocation: 'one', transportOutcome: 'response', usage: { totalTokens: { value: 6, state: 'known' } } });
    expect(sends).toBe(1); expect(s.db.entries('wintr_owned')).toEqual([]); expect(await s.make().reconciliation().totals()).toEqual(totals);
    const dump = JSON.stringify(s.db.entries()); expect(dump).not.toContain('must never resurrect'); expect(dump).not.toContain(SECRET.reveal()); expect(dump).not.toContain(INPUT.reference.canonicalUrl);
  });

  it('legacy records decode as unknown, only exact schema2 accepts observation, and replay changes no accounting', async () => {
    const s = await setup(); await s.store.reserveSubmission(s.owner, s.attempt.id, 'reference_analysis', T0);
    await s.store.beginSubmission(s.owner, s.attempt.id, 0, T0);
    const [, raw] = s.db.entries('wintr_ledger_reservations/')[0]!;
    const legacy: Record<string, unknown> = { ...raw, schema: 1 }; delete legacy.observation;
    expect(parseReservation(legacy as DocData)!.observation).toBeNull();
    for (const bad of [{ ...legacy, observation: null }, { ...raw, extra: 1 }, { ...raw, observation: {} }]) expect(() => parseReservation(bad as DocData)).toThrow();
    const snapshots: SubmissionObservation[] = [];
    const local = createCallObserver('reference_analysis', T0, () => T0, async (o) => { snapshots.push(o); return 'stored'; });
    local.observer.adapterEntered(); local.finish(); await vi.advanceTimersByTimeAsync(0); await local.flush();
    const value = local.snapshot(); const totals = await s.make().reconciliation().totals();
    const crossed = { ...value, invocation: 'one', adapterEndedAt: T0 + 100, transportStartedAt: T0 + 80, transportEndedAt: T0 + 20, preparationMs: 80, transportMs: null, transportOutcome: 'response', status: 200 };
    expect(await s.store.observeSubmission(s.owner.sessionId, s.attempt.id, 0, crossed)).toBe('invalid');
    expect(await s.observation()).toBeNull();
    expect(await s.store.observeSubmission(s.owner.sessionId, s.attempt.id, 0, value)).toBe('stored'); const writes = s.db.log.length;
    expect(await s.make().observeSubmission(s.owner.sessionId, s.attempt.id, 0, value)).toBe('replay');
    expect(await s.store.observeSubmission(s.owner.sessionId, s.attempt.id, 0, snapshots[0])).toBe('replay');
    expect(s.db.log).toHaveLength(writes); expect(await s.make().reconciliation().totals()).toEqual(totals);
    expect(await s.store.observeSubmission(s.owner.sessionId, s.attempt.id, 9, value)).toBe('not_found');
  });

  it('failed and pending writes are visible to the controller, do not retry or turn into settlement', async () => {
    const s = await setup(); await s.store.reserveSubmission(s.owner, s.attempt.id, 'reference_analysis', T0); await s.store.beginSubmission(s.owner, s.attempt.id, 0, T0);
    s.db.faults.push('unavailable');
    const o = createCallObserver('reference_analysis', T0, () => T0, (value) => s.store.observeSubmission(s.owner.sessionId, s.attempt.id, 0, value));
    o.observer.adapterEntered(); o.finish(); await vi.advanceTimersByTimeAsync(0);
    expect(await o.flush()).toEqual(['unavailable']); expect(s.store.observationHealth()).toMatchObject({ pendingWrites: 0, failedWrites: 1, lastFailure: 'unavailable' });
    expect(await s.observation()).toBeNull(); expect(await s.make().reconciliation().totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 300 });
    const gate = deferred<void>(); const before = s.db.callbackRuns;
    s.db.beforeCommit = () => gate.promise;
    const pending = s.store.observeSubmission(s.owner.sessionId, s.attempt.id, 0, o.snapshot());
    await vi.advanceTimersByTimeAsync(0); expect(s.store.observationHealth().pendingWrites).toBe(1);
    gate.resolve(); await pending; s.db.beforeCommit = null;
    expect(s.db.callbackRuns).toBe(before + 1);
  });

  it.each(['inputHash', 'journeyScope'] as const)('rejects a corrupted %s before accounting enrichment after Clear', async (field) => {
    const s = await setup();
    await s.store.reserveSubmission(s.owner, s.attempt.id, 'reference_analysis', T0);
    await s.store.beginSubmission(s.owner, s.attempt.id, 0, T0);
    await s.store.clearSession(s.owner.sessionId);
    const [path, raw] = s.db.entries('wintr_ledger_reservations/')[0]!;
    s.db.seed(path, { ...raw, [field]: field === 'inputHash' ? 'f'.repeat(64) : `j_${'a'.repeat(48)}` });
    const totals = await s.make().reconciliation().totals();
    const before = s.db.log.length;
    const o = createCallObserver('reference_analysis', T0, () => T0, async () => 'stored');
    o.observer.adapterEntered(); o.finish();
    expect(await s.store.observeSubmission(s.owner.sessionId, s.attempt.id, 0, o.snapshot())).toBe('invalid');
    expect(s.db.log).toHaveLength(before);
    expect((s.db.read(path).data as Record<string, unknown>).observation).toBeNull();
    expect(await s.make().reconciliation().totals()).toEqual(totals);
    expect(s.db.entries('wintr_owned')).toEqual([]);
    await vi.advanceTimersByTimeAsync(0); await o.flush();
  });

  it('the canonical API never discloses server-only observation or usage receipts', async () => {
    const s = await setup(); await s.run('reference_analysis', async () => 'synthetic result'); s.exec.close(); await flush(s.store);
    const config = loadConfig([], { WINTR_MODE: 'synthetic' }); const handler = createApiHandler({ config, store: s.store, referenceAdapter: null, now: Date.now });
    const req = new IncomingMessage(new Socket()); req.method = 'GET'; req.url = '/api/state'; req.headers = { host: config.hostHeader, cookie: `wintr_sid=${s.secret}` };
    const res = new ServerResponse(req); let body = ''; res.end = ((chunk: unknown) => { body = String(chunk); return res; }) as typeof res.end;
    await handler(req, res); req.destroy(); expect(res.statusCode).toBe(200);
    for (const field of ['observation', 'adapterStartedAt', 'preparationMs', 'transportMs', 'inputTokens', 'pendingWrites']) expect(body).not.toContain(field);
  });
});
