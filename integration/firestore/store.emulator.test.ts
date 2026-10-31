import { createHash, randomUUID } from 'node:crypto';
import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirestoreStore } from '../../src/server/firestore-store.js';
import { openExecution, submit } from '../../src/server/harness.js';
import { sha256 } from '../../src/server/ids.js';
import { createFirestoreDocStore, type DocPath, type DocStore, type DocTx } from '../../src/server/persistence/docstore.js';
import { createOwnedFirestoreDocStore, isManagedDocStore, type ManagedDocStore } from '../../src/server/persistence/docstore-lifecycle.js';
import { createCallObserver } from '../../src/server/providers/observation.js';
import { createKeylessFirestoreFactory } from '../../src/server/live-runtime.js';
import { RECORDING } from '../../src/shared/recording.js';
import type { RecordedReference } from '../../src/shared/records.js';
import { assertEmulatorEnvironment } from '../../scripts/firestore-emulator-preflight.mjs';
import { createEmulatorClient } from './emulator-client.js';

// Real SDK -> genuine DocStore -> genuine Store, over an already running local
// official emulator. No fake database, provider adapter, SDK mock or skip path.
assertEmulatorEnvironment();
const REF = { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 } };
const ANALYSIS = { synthetic: true, audioAccess: 'synthetic_not_accessed' as const, observations: ['Invented E05 observation'], relationships: ['Invented relationship'], provider: null };
const RECORDING_DIGEST = createHash('sha256').update('invented-recording-metadata-only').digest('hex');

function policy(t: number, gemini = 40) {
  return {
    version: 'e05-invented-policy', currency: 'XTS', expiresAt: t + 10 * 3_600_000,
    service: { capUnits: 1_000_000, concurrency: 8, counts: { qloo: 600, gemini } },
    session: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
    journey: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
    reservations: {
      reference_analysis: { units: 300, bound: 'estimate_with_residual' }, qloo_search: { units: 10, bound: 'enforceable' },
      qloo_artist_insights: { units: 10, bound: 'enforceable' }, qloo_tag_insights: { units: 10, bound: 'enforceable' },
      catalogue_generation: { units: 500, bound: 'estimate_with_residual' },
    },
  };
}

let clock: { t: number };
let caseStart: number;
let namespace: string;
let service: string;
let ownedPaths: Map<string, DocPath>;
let clients: Firestore[];
let closed: Set<Firestore>;
let ownership: Map<Firestore, ManagedDocStore>;

/** Records only the exact documents this case attempts to write; never scans a collection for deletion. */
function tracked(db: Firestore): DocStore {
  const real = createOwnedFirestoreDocStore<DocumentReference>(db);
  ownership.set(db, real);
  const remember = (p: DocPath) => { ownedPaths.set(`${p.collection}/${p.id}`, p); };
  return {
    ...real,
    transact: (fn) => real.transact((tx) => fn({
      ...tx,
      create: (p, d) => { remember(p); tx.create(p, d); },
      set: (p, d) => { remember(p); tx.set(p, d); },
      delete: (p) => { remember(p); tx.delete(p); },
    } as DocTx)),
  };
}

async function instance(gemini = 40, maxSessions = 10) {
  const db = await createEmulatorClient();
  clients.push(db);
  const docs = tracked(db);
  const store = new FirestoreStore({ docs, serviceId: service, policy: policy(caseStart, gemini), clock: () => clock.t, maxSessions, maxJourneysPerSession: 3 });
  return { db, docs, store };
}
async function discard(db: Firestore) {
  const owner = ownership.get(db);
  if (!owner) throw new Error('E05 SDK ownership missing');
  await owner.close(); closed.add(db);
}

async function admitted(store: FirestoreStore, key = 'action') {
  const created = await store.createSession(clock.t);
  if (!created || typeof created === 'string') throw new Error('E05 synthetic session not admitted');
  const owner = { sessionId: created.session.id, epoch: created.session.epoch };
  const input = { ...owner, now: clock.t, reference: REF, listenerCue: null, actionKeyHash: sha256(`${namespace}|${key}`), inputHash: sha256(`${namespace}|input`) };
  const result = await store.admitReference(input);
  if (result.kind !== 'admitted') throw new Error('E05 synthetic Attempt not admitted');
  return { ...created, owner, input, attempt: result.attempt };
}

beforeEach(() => {
  assertEmulatorEnvironment();
  clock = { t: Date.now() };
  caseStart = clock.t;
  namespace = `e05_${randomUUID().replaceAll('-', '')}`;
  service = namespace;
  ownedPaths = new Map(); clients = []; closed = new Set(); ownership = new Map();
});

afterEach(async () => {
  // No global emulator reset, recursive delete, import/export or unknown data deletion.
  // A fresh cleanup client is pinned to the same fictional project and exact loopback host.
  try {
    if (ownedPaths.size > 0) {
      assertEmulatorEnvironment();
      const cleanup = await createEmulatorClient();
      clients.push(cleanup);
      const cleanupDocs = createOwnedFirestoreDocStore<DocumentReference>(cleanup);
      ownership.set(cleanup, cleanupDocs);
      const paths = [...ownedPaths.values()];
      for (let i = 0; i < paths.length; i += 100) {
        await cleanupDocs.transact(async (tx) => { for (const path of paths.slice(i, i + 100)) tx.delete(path); });
      }
    }
  } finally {
    await Promise.all(clients.filter((c) => !closed.has(c)).map(discard));
    vi.restoreAllMocks();
  }
});

describe('E05 official emulator transactions (SDK 9.3.1)', () => {
  it('two independent SDK clients race duplicate admission, final reservation and one-use intent without duplicate sends', async () => {
    const [a, b] = await Promise.all([instance(1), instance(1)]);
    const created = await a.store.createSession(clock.t);
    if (!created || typeof created === 'string') throw new Error('E05 session failed');
    const owner = { sessionId: created.session.id, epoch: 1 };
    const input = { ...owner, now: clock.t, reference: REF, listenerCue: null, actionKeyHash: sha256(namespace), inputHash: sha256('invented-input') };
    const results = await Promise.all([a.store.admitReference(input), b.store.admitReference(input)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['admitted', 'replay']);
    const admitted = results.find((r) => r.kind === 'admitted');
    if (admitted?.kind !== 'admitted') throw new Error('E05 admission race failed');
    expect(await b.store.admitReference({ ...input, inputHash: sha256('conflicting-input') })).toEqual({ kind: 'rejected', code: 'action_conflict' });
    const id = admitted.attempt.id;
    const reserves = await Promise.all([a.store.reserveSubmission(owner, id, 'reference_analysis', clock.t), b.store.reserveSubmission(owner, id, 'reference_analysis', clock.t)]);
    expect(reserves.filter((r) => r.ok)).toHaveLength(1);
    expect(reserves.find((r) => !r.ok)).toEqual({ ok: false, code: 'capacity' });
    const grants = await Promise.all([a.store.beginSubmission(owner, id, 0, clock.t), b.store.beginSubmission(owner, id, 0, clock.t)]);
    const sends: string[] = [];
    for (const grant of grants) if (grant === 'send') sends.push('invented-provider-probe');
    expect(grants.sort()).toEqual(['held', 'send']); expect(sends).toHaveLength(1);
    expect(await b.store.beginSubmission(owner, id, 0, clock.t)).toBe('held');
    expect(await b.store.reconciliation().totals()).toMatchObject({ counts: { gemini: 1, qloo: 0 }, unitsHeld: 300, unresolved: 1 });
  });

  it('two SDK clients racing the last service session slot cannot exceed it', async () => {
    const [a, b] = await Promise.all([instance(40, 1), instance(40, 1)]);
    const sessions = await Promise.all([a.store.createSession(clock.t), b.store.createSession(clock.t)]);
    expect(sessions.filter((s) => s !== null)).toHaveLength(1);
    expect(sessions.filter((s) => s === null)).toHaveLength(1);
  });

  it.each(['stop', 'clear', 'expiry'] as const)('%s before intent fences the send and late commit without resetting counts', async (mode) => {
    const a = await instance(); const b = await instance(); const x = await admitted(a.store);
    await a.store.reserveSubmission(x.owner, x.attempt.id, 'reference_analysis', clock.t);
    const totals = await b.store.reconciliation().totals();
    if (mode === 'stop') await b.store.stopAttempt(x.owner.sessionId, 1, x.attempt.id, clock.t);
    else if (mode === 'clear') await b.store.clearSession(x.owner.sessionId);
    else clock.t = x.session.expiresAt;
    let sends = 0;
    if (await a.store.beginSubmission(x.owner, x.attempt.id, 0, clock.t) === 'send') sends += 1;
    expect(sends).toBe(0);
    expect(await a.store.commitAnalysis(x.owner.sessionId, 1, x.attempt.id, ANALYSIS, clock.t)).toBe(false);
    expect(await b.store.reconciliation().totals()).toEqual(totals);
    if (mode !== 'stop') expect(await b.store.read(x.owner.sessionId, 1, clock.t)).toBeNull();
  });

  it('an intent delivered after authority expires cannot invoke the harness callback, and remains held', async () => {
    const a = await instance(); const x = await admitted(a.store);
    const begin = a.store.beginSubmission.bind(a.store);
    a.store.beginSubmission = async (...args) => { const grant = await begin(...args); clock.t = x.attempt.deadlineAt; return grant; };
    const exec = openExecution(x.attempt, 120_000, new Map());
    let sends = 0;
    try {
      await expect(submit(a.store, exec, x.owner, x.attempt.id, x.attempt.deadlineAt, 'reference_analysis', () => clock.t, async () => { sends += 1; })).rejects.toBeDefined();
      expect(sends).toBe(0);
      expect(await a.store.reconciliation().totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 300, unresolved: 1 });
    } finally { exec.close(); }
  });

  it('discarding and recreating SDK/Store preserves unknown holds, Clear revocation and one-use intent', async () => {
    const a = await instance(); const x = await admitted(a.store);
    await a.store.reserveSubmission(x.owner, x.attempt.id, 'reference_analysis', clock.t);
    expect(await a.store.beginSubmission(x.owner, x.attempt.id, 0, clock.t)).toBe('send');
    await a.store.endSubmission(x.owner.sessionId, x.attempt.id, 0, 'returned');
    const before = await a.store.reconciliation().unresolved(10); const totals = await a.store.reconciliation().totals();
    expect(before).toHaveLength(1); expect(before[0]!.state).toBe('unknown');
    await discard(a.db);
    const b = await instance();
    expect(await b.store.reconciliation().unresolved(10)).toEqual(before);
    expect(await b.store.beginSubmission(x.owner, x.attempt.id, 0, clock.t)).toBe('held');
    await b.store.clearSession(x.owner.sessionId); await discard(b.db);
    const c = await instance();
    expect(await c.store.read(x.owner.sessionId, 1, clock.t)).toBeNull();
    expect(await c.store.read(x.owner.sessionId, 2, clock.t)).toBeNull();
    expect(await c.store.findSessionBySecret(x.secret, clock.t)).toBeNull();
    expect(await c.store.reconciliation().unresolved(10)).toEqual(before);
    expect(await c.store.reconciliation().totals()).toEqual(totals);
  });

  it('a restarted SDK/Store recovers an orphan at its deadline exactly once, preserving intent and money', async () => {
    const a = await instance(); const x = await admitted(a.store);
    await a.store.reserveSubmission(x.owner, x.attempt.id, 'reference_analysis', clock.t);
    await a.store.beginSubmission(x.owner, x.attempt.id, 0, clock.t);
    const totals = await a.store.reconciliation().totals(); const holds = await a.store.reconciliation().unresolved(10);
    await discard(a.db); // No harness timer or live worker survives.
    const b = await instance(); clock.t = x.attempt.deadlineAt - 1;
    expect((await b.store.read(x.owner.sessionId, 1, clock.t))!.attempt!.outcome).toBe('running');
    clock.t += 1;
    const recovered = await b.store.read(x.owner.sessionId, 1, clock.t);
    expect(recovered).toMatchObject({ attempt: { outcome: 'failed', failure: 'deadline', dispatch: 'in_flight' }, journey: { stage: 'failed', revision: 2 } });
    const c = await instance(); expect(await c.store.read(x.owner.sessionId, 1, clock.t)).toEqual(recovered);
    expect(await c.store.reconciliation().totals()).toEqual(totals);
    expect(await c.store.reconciliation().unresolved(10)).toEqual(holds);
    expect(await c.store.commitAnalysis(x.owner.sessionId, 1, x.attempt.id, ANALYSIS, clock.t)).toBe(false);
  });

  it('actual SDK observation enrichment survives Clear and client reconstruction without releasing held exposure', async () => {
    const a = await instance(); const x = await admitted(a.store);
    const reserved = await a.store.reserveSubmission(x.owner, x.attempt.id, 'reference_analysis', clock.t);
    if (!reserved.ok) throw new Error('E05 invented receipt reservation failed');
    expect(await a.store.beginSubmission(x.owner, x.attempt.id, reserved.call, clock.t)).toBe('send');
    const receipt = createCallObserver('reference_analysis', clock.t, () => clock.t,
      (value) => a.store.observeSubmission(x.owner.sessionId, x.attempt.id, reserved.call, value));
    receipt.observer.adapterEntered(); receipt.observer.transportPending(); receipt.observer.transportStarted();
    receipt.interrupt(false); receipt.finish(new Error('invented cancellation'));
    expect(await receipt.flush()).toEqual(['stored']);
    const before = await a.store.reconciliation().totals();
    await a.store.clearSession(x.owner.sessionId);
    clock.t += 10;
    receipt.observer.transportFinished(200);
    receipt.observer.usage({ total_input_tokens: 0, total_output_tokens: 4, total_tokens: 4 }, 'reference');
    receipt.observer.usageDecoded();
    expect(await receipt.flush()).toEqual(['stored', 'stored']);
    await discard(a.db);
    const b = await instance();
    expect(await b.store.read(x.owner.sessionId, 1, clock.t)).toBeNull();
    expect(await b.store.reconciliation().totals()).toEqual(before);
    const reservations = await b.store.reconciliation().unresolved(10);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]!.observation).toMatchObject({ outcome: 'aborted', invocation: 'one', transportOutcome: 'response', usage: { inputTokens: { value: 0, state: 'known' }, outputTokens: { value: 4, state: 'known' } } });
  });

  it('owned timing survives actual SDK reconstruction and Clear without being added to the ledger', async () => {
    const a = await instance(); const x = await admitted(a.store);
    clock.t += 100;
    expect(await a.store.commitAnalysis(x.owner.sessionId, 1, x.attempt.id, ANALYSIS, clock.t)).toBe(true);
    const analysed = (await a.store.read(x.owner.sessionId, 1, clock.t))!;
    expect(analysed.journey!.timing).toMatchObject({ phase: 'awaiting_listener', processingMs: 100, listenerWaitMs: 0, unobservedMs: 0,
      milestones: { reference_result: { at: caseStart + 100, processingMs: 100 } } });
    clock.t += 300;
    const saved = await a.store.saveBrief(x.owner, { analysisId: analysed.analysis!.id, relationship: 'Invented relationship', relationshipSource: 'listener_text', proposedArtists: ['Invented Artist'], exclusions: [] },
      { expectedBriefId: null, actionKeyHash: sha256(namespace + '|brief'), inputHash: sha256('invented-brief') }, clock.t);
    if (saved.kind !== 'saved') throw new Error('E07 invented brief failed');
    await discard(a.db);
    const b = await instance(); clock.t = caseStart + 1000;
    const discovery = await b.store.admitDiscover({ ...x.owner, briefId: saved.brief.id, actionKeyHash: sha256(namespace + '|discovery'), inputHash: sha256('invented-discovery'), now: clock.t });
    if (discovery.kind !== 'admitted') throw new Error('E07 invented discovery failed');
    clock.t += 200;
    expect(await b.store.stopAttempt(x.owner.sessionId, 1, discovery.attempt.id, clock.t)).toBe(true);
    const stopped = (await b.store.read(x.owner.sessionId, 1, clock.t))!;
    expect(stopped.journey!.timing).toMatchObject({ phase: 'closed', cursorAt: caseStart + 1200, processingMs: 300, listenerWaitMs: 900, unobservedMs: 0, quality: 'complete' });
    expect(stopped.attempt!.timing).toEqual({ version: 1, finishedAt: caseStart + 1200, recordedAt: caseStart + 1200, finishBasis: 'transition' });
    const accounting = await b.store.reconciliation().totals();
    const ledger = await b.docs.get({ collection: 'wintr_ledger_service', id: service });
    expect(JSON.stringify(ledger)).not.toContain('timing');
    await discard(b.db);
    const c = await instance();
    expect((await c.store.read(x.owner.sessionId, 1, clock.t))!.journey!.timing).toEqual(stopped.journey!.timing);
    await c.store.clearSession(x.owner.sessionId);
    expect(await c.store.read(x.owner.sessionId, 1, clock.t)).toBeNull();
    expect(await c.store.commitAnalysis(x.owner.sessionId, 1, x.attempt.id, ANALYSIS, clock.t)).toBe(false);
    expect(await c.store.reconciliation().totals()).toEqual(accounting);
  });

  it('delayed actual SDK recovery persists a logical deadline and an unobserved gap exactly once', async () => {
    const a = await instance(); const x = await admitted(a.store);
    await discard(a.db);
    clock.t = x.attempt.deadlineAt + 2500;
    const b = await instance();
    const recovered = (await b.store.read(x.owner.sessionId, 1, clock.t))!;
    expect(recovered.attempt!.timing).toEqual({ version: 1, finishedAt: x.attempt.deadlineAt, recordedAt: clock.t, finishBasis: 'deadline' });
    expect(recovered.journey!.timing).toMatchObject({ phase: 'closed', processingMs: x.attempt.deadlineAt - caseStart, listenerWaitMs: 0, unobservedMs: 2500, quality: 'partial' });
    const snapshot = structuredClone(recovered.journey!.timing);
    await discard(b.db);
    const c = await instance(); clock.t += 1000;
    expect((await c.store.read(x.owner.sessionId, 1, clock.t))!.journey!.timing).toEqual(snapshot);
  });

  it('actual SDK Timestamps roundtrip to Dates, and complete content remains separate and intact across clients', async () => {
    const a = await instance(); const x = await admitted(a.store);
    const finalText = 'Invented E05 ünicode line\n'.repeat(8_000);
    const analysis = { ...ANALYSIS, provider: { model: 'invented-model', finalText, usage: null, uncertainArtistName: null } };
    expect(await a.store.commitAnalysis(x.owner.sessionId, 1, x.attempt.id, analysis, clock.t)).toBe(true);
    const raw = await a.db.doc(`wintr_owned/session_${x.owner.sessionId}`).get();
    expect(raw.get('expireAt').constructor.name).toBe('Timestamp');
    expect(raw.get('expireAt').toMillis()).toBe(x.session.expiresAt);
    const decoded = await a.docs.get({ collection: 'wintr_owned', id: `session_${x.owner.sessionId}` });
    expect(decoded!.expireAt).toBeInstanceOf(Date);
    await discard(a.db);
    const b = await instance(); const view = (await b.store.read(x.owner.sessionId, 1, clock.t))!;
    expect(view.analysis!.provider!.finalText).toBe(finalText);
    expect(await b.docs.get({ collection: 'wintr_owned_content', id: `analysistext_${view.analysis!.id}` })).toMatchObject({ body: { finalText } });
    expect((await b.docs.get({ collection: 'wintr_owned', id: `analysis_${view.analysis!.id}` }))!.body).not.toHaveProperty('provider.finalText');
  });

  it('recording metadata survives SDK reconstruction, consumes once across clients, and Clear retains exposure', async () => {
    const a = await instance();
    const created = await a.store.createSession(clock.t);
    if (!created || typeof created === 'string') throw Error('E05 recording session');
    const owner = { sessionId: created.session.id, epoch: created.session.epoch };
    const intake = { ...owner, now: clock.t, sha256: RECORDING_DIGEST, frames: RECORDING.minFrames,
      actionKeyHash: sha256(`${namespace}|capture`), inputHash: sha256('invented-capture-metadata') };
    const before = await a.store.reconciliation().totals();
    const registered = await a.store.registerCapture(intake);
    if (registered.kind !== 'registered') throw Error(`E05 recording metadata: ${registered.kind === 'rejected' ? registered.code : registered.kind}`);
    const capturePath: DocPath = { collection: 'wintr_owned', id: `capture_${registered.capture.id}` };
    expect(await a.docs.get(capturePath)).toMatchObject({ body: registered.capture, expireAt: new Date(created.session.expiresAt) });
    expect(Object.keys((await a.docs.get(capturePath))!.body as object).sort()).toEqual(Object.keys(registered.capture).sort());
    expect(await a.store.reconciliation().totals()).toEqual(before);
    await discard(a.db);
    const b = await instance(), c = await instance();
    expect(await b.store.registerCapture(intake)).toEqual({ kind: 'replay', capture: registered.capture });
    const reference: RecordedReference = { kind: 'recorded', receipt: registered.capture.id, sha256: intake.sha256, frames: intake.frames };
    const input = { ...owner, now: clock.t, reference, listenerCue: null,
      actionKeyHash: sha256(`${namespace}|recording-admit`), inputHash: sha256('invented-audio-and-cue') };
    const race = await Promise.all([b.store.admitReference(input), c.store.admitReference(input)]);
    expect(race.map(x => x.kind).sort()).toEqual(['admitted', 'replay']);
    const admitted = race.find(x => x.kind === 'admitted');
    if (admitted?.kind !== 'admitted') throw Error('E05 recording admission');
    expect(await c.store.admitReference({ ...input, actionKeyHash: sha256('another-key') })).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect((await c.docs.get(capturePath))!.body).toMatchObject({ consumedAttempt: admitted.attempt.id });
    expect(await b.store.reserveSubmission(owner, admitted.attempt.id, 'reference_analysis', clock.t)).toMatchObject({ ok: true });
    expect(await b.store.beginSubmission(owner, admitted.attempt.id, 0, clock.t)).toBe('send');
    const totals = await c.store.reconciliation().totals();
    expect(totals).toMatchObject({ counts: { gemini: 1, qloo: 0 }, unitsHeld: 300, unresolved: 1 });
    await c.store.clearSession(owner.sessionId);
    expect(await b.store.authorizeReference(owner, admitted.attempt.id, reference, clock.t)).toBe(false);
    expect(await b.store.read(owner.sessionId, owner.epoch, clock.t)).toBeNull();
    expect(await b.docs.get(capturePath)).toBeNull();
    expect(await b.store.reconciliation().totals()).toEqual(totals);
  });

  it.each(['ready', 'session'] as const)('recorded %s expiry is enforced by a reconstructed real SDK Store without renewing access', async mode => {
    const a = await instance(); const created = await a.store.createSession(clock.t);
    if (!created || typeof created === 'string') throw Error('E05 recording session');
    const owner = { sessionId: created.session.id, epoch: created.session.epoch };
    const intake = { ...owner, now: clock.t, sha256: RECORDING_DIGEST, frames: RECORDING.minFrames,
      actionKeyHash: sha256(`${namespace}|capture`), inputHash: sha256('invented-capture') };
    const registered = await a.store.registerCapture(intake);
    if (registered.kind !== 'registered') throw Error('E05 recording metadata');
    expect(registered.capture.usableUntil).toBe(Math.min(created.session.expiresAt, clock.t + 300_000));
    await discard(a.db); clock.t = mode === 'ready' ? registered.capture.usableUntil : created.session.expiresAt;
    const b = await instance();
    const reference: RecordedReference = { kind: 'recorded', receipt: registered.capture.id, sha256: intake.sha256, frames: intake.frames };
    expect(await b.store.admitReference({ ...owner, now: clock.t, reference, listenerCue: null,
      actionKeyHash: sha256(`${namespace}|admit`), inputHash: sha256('invented-reference') })).toEqual({ kind: 'rejected', code: mode === 'ready' ? 'stale_operation' : 'session_expired' });
    expect((await b.store.registerCapture({ ...intake, now: clock.t })).kind).toBe('rejected');
    expect(await b.store.authorizeRead(owner, clock.t)).toBe(mode === 'ready');
    expect(await b.store.reconciliation().totals()).toBeNull();
  });

  it('actual SDK recording receipts cannot cross chat ownership or survive delete-one', async () => {
    const a = await instance(), b = await instance(); const created = await a.store.createSession(clock.t);
    if (!created || typeof created === 'string') throw Error('E05 recording session');
    const owner = { sessionId: created.session.id, epoch: created.session.epoch };
    const intake = { ...owner, now: clock.t, sha256: RECORDING_DIGEST, frames: RECORDING.minFrames,
      actionKeyHash: sha256(`${namespace}|capture`), inputHash: sha256('invented-capture') };
    const first = await a.store.registerCapture(intake);
    if (first.kind !== 'registered') throw Error('E05 recording metadata');
    const chat = await b.store.changeChat(owner, { kind: 'create' }, { actionKeyHash: sha256(`${namespace}|chat`), inputHash: sha256('create-chat') }, clock.t);
    if (chat.kind === 'rejected' || !chat.chat) throw Error('E05 new chat');
    const ref = (receipt: RecordedReference['receipt']): RecordedReference => ({ kind: 'recorded', receipt, sha256: intake.sha256, frames: intake.frames });
    const admit = (receipt: RecordedReference['receipt']) => a.store.forChat(chat.chat!).admitReference({ ...owner, now: clock.t, reference: ref(receipt), listenerCue: null,
      actionKeyHash: sha256(`${namespace}|admit`), inputHash: sha256('invented-reference') });
    expect(await admit(first.capture.id)).toEqual({ kind: 'rejected', code: 'stale_operation' });
    const second = await b.store.forChat(chat.chat).registerCapture({ ...intake, actionKeyHash: sha256(`${namespace}|second-capture`) });
    if (second.kind !== 'registered') throw Error('E05 second recording metadata');
    const deleted = await b.store.changeChat(owner, { kind: 'delete', chat: chat.chat, expectedRevision: 0 }, { actionKeyHash: sha256(`${namespace}|delete`), inputHash: sha256('delete-chat') }, clock.t);
    expect(deleted.kind).not.toBe('rejected'); expect((await admit(second.capture.id)).kind).toBe('rejected');
    expect(await a.docs.get({ collection: 'wintr_owned', id: `capture_${second.capture.id}` })).toBeNull();
    expect(await a.docs.get({ collection: 'wintr_owned', id: `capture_${first.capture.id}` })).not.toBeNull();
    expect(await a.store.reconciliation().totals()).toBeNull();
  });

  it('the explicit keyless OAuth factory can read retained totals through the local SDK without refresh', async () => {
    const a = await instance(); const x = await admitted(a.store);
    expect(await a.store.reserveSubmission(x.owner, x.attempt.id, 'reference_analysis', clock.t)).toMatchObject({ ok: true });
    const expected = await a.store.reconciliation().totals();
    expect(expected).toMatchObject({ counts: { gemini: 1, qloo: 0 }, unitsHeld: 300, unresolved: 1 });
    const { OAuth2Client } = await import('google-auth-library');
    const auth = new OAuth2Client({ eagerRefreshThresholdMillis: 0, forceRefreshOnFailure: false });
    // Invented emulator-only token: never a real account, credential loader or provider.
    auth.setCredentials({ access_token: 'invented-local-emulator-only', expiry_date: clock.t + 600_000 });
    const refresh = vi.spyOn(auth, 'refreshAccessToken');
    const target = assertEmulatorEnvironment();
    const docs = await createKeylessFirestoreFactory(async () => ({ client: auth, expiresAt: clock.t + 600_000 }), () => clock.t)({ projectId: target.projectId, databaseId: target.databaseId });
    if (!isManagedDocStore(docs)) throw Error('E05 keyless ownership missing');
    try {
      const store = new FirestoreStore({ docs, serviceId: service, policy: undefined, clock: () => clock.t, maxSessions: 1, maxJourneysPerSession: 1 });
      expect(await store.reconciliation().totals()).toEqual(expected); expect(refresh).not.toHaveBeenCalled();
    } finally { await docs.close(); }
  });

  it('the real database applies query filters and limits; invalid queries fail before a query is issued', async () => {
    const a = await instance();
    await a.docs.transact(async (tx) => {
      for (let i = 0; i < 5; i++) tx.create({ collection: 'wintr_owned', id: `${namespace}_${i}` }, { e05Case: namespace, state: i < 3 ? 'wanted' : 'other', expireAt: new Date(clock.t + 1000) });
    });
    const rows = await a.docs.query('wintr_owned', [{ field: 'e05Case', op: '==', value: namespace }, { field: 'state', op: 'in', value: ['wanted'] }], 2);
    expect(rows).toHaveLength(2); expect(rows.every((r) => r.data.e05Case === namespace && r.data.state === 'wanted')).toBe(true);
    await expect(a.docs.query('wintr_owned', [{ field: 'e05Case', op: '==', value: namespace }], 501)).rejects.toThrow('invalid query');
    await expect(a.docs.query('wintr_owned', [], 1)).rejects.toThrow('invalid query');
  });

  // The earlier raw use-after-terminate case failed with a hanging SDK Deferred
  // and unhandled pool rejection. It remains negative history in the E05 doc;
  // this case tests the supported owned-close path, not a caught SDK outage.
  it('owned close fails Store entry closed before touching the actual SDK again', async () => {
    const a = await instance(); const x = await admitted(a.store);
    const transactions = vi.spyOn(a.db, 'runTransaction');
    const collection = vi.spyOn(a.db, 'collection');
    const terminate = vi.spyOn(a.db, 'terminate');
    await discard(a.db);
    await ownership.get(a.db)!.close();
    await expect(a.store.read(x.owner.sessionId, 1, clock.t)).rejects.toThrow('store unavailable');
    expect(await a.store.reserveSubmission(x.owner, x.attempt.id, 'reference_analysis', clock.t)).toEqual({ ok: false, code: 'unavailable' });
    expect(await a.store.commitAnalysis(x.owner.sessionId, 1, x.attempt.id, ANALYSIS, clock.t)).toBe(false);
    expect(transactions).not.toHaveBeenCalled(); expect(collection).not.toHaveBeenCalled(); expect(terminate).toHaveBeenCalledTimes(1);
    const b = await instance(); expect((await b.store.read(x.owner.sessionId, 1, clock.t))!.attempt!.calls).toEqual([]);
  });

  it('owned close drains an admitted actual SDK transaction before terminating once', async () => {
    const a = await instance(); const x = await admitted(a.store);
    let entered!: () => void; let release!: () => void;
    const began = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const work = a.docs.transact(async (tx) => {
      await tx.getAll([{ collection: 'wintr_owned', id: `session_${x.owner.sessionId}` }]);
      entered(); await gate;
      return 'drained';
    });
    const completed = work.catch((error: unknown) => error);
    await began;
    const terminate = vi.spyOn(a.db, 'terminate');
    const owner = ownership.get(a.db)!;
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    try {
      await expect(a.docs.get({ collection: 'wintr_owned', id: `session_${x.owner.sessionId}` })).rejects.toThrow('document store closed');
      expect(terminate).not.toHaveBeenCalled();
    } finally { release(); }
    expect(await completed).toMatchObject({ code: 'unavailable' }); await closing;
    expect(terminate).toHaveBeenCalledTimes(1);
    closed.add(a.db);
  });
});
