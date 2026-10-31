import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import {
  ApiError,
  type ApiPort,
  type ArtistChoiceRequest,
  type FeedbackRequest,
  type PreferenceInput,
  type PreferenceRequest,
  type ReferenceRequest,
  type RefineInput,
  type StopTarget,
} from '../src/client/api.js';
import { CLEAR_INTENT_PREFIX, createIntentCell, isIntentId, memoryClearIntents } from '../src/client/clear-intent.js';
import { SessionController, type AnalyseInput } from '../src/client/controller.js';
import { workingText } from '../src/client/discovery.js';

const fixtureControllers = new Set<SessionController>();
const heldRequests = new Set<() => void>();
function trackedController(...args: ConstructorParameters<typeof SessionController>) {
  const controller = new SessionController(...args);
  fixtureControllers.add(controller);
  return controller;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const cleanup = () => {
    heldRequests.delete(cleanup);
    void promise.catch(() => {});
    reject(new Error('invented fixture teardown'));
  };
  heldRequests.add(cleanup);
  return { promise,
    resolve: value => { heldRequests.delete(cleanup); resolve(value); },
    reject: error => { heldRequests.delete(cleanup); reject(error); },
  };
}

const REF = { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', focus: { start: 12, end: 57 } };
const INPUT: AnalyseInput = { url: 'https://youtu.be/dQw4w9WgXcQ?t=12', focus: REF.focus, cue: null, display: { ...REF, cue: null } };
const HANDLE = 'attempt-handle-0001' as Handle;

const snap = (o: Partial<SafeSnapshot> = {}): SafeSnapshot => ({
  mode: 'synthetic',
  session: { context: 'ctx-session-a', expiresAt: 9_999_999 },
  stage: 'idle',
  revision: 0,
  status: null,
  attempt: null,
  reference: null,
  listenerCue: null,
  analysis: null,
  brief: null,
  identity: null,
  connection: null,
  panel: null,
  history: [],
  refinement: null,
  code: null,
  ...o,
});
const NO_SESSION = snap({ session: null });
const ACTIVE = (revision: number) =>
  snap({ stage: 'analysing_reference', revision, reference: REF, attempt: { handle: HANDLE, kind: 'reference', active: true, outcome: 'running' } });
const ANALYSIS_HANDLE = 'analysis-handle-00000001' as Handle;
const BRIEF_HANDLE = 'brief-handle-0000000001x' as Handle;
const READY = (revision: number) =>
  snap({
    stage: 'awaiting_preference',
    status: 'reference_ready',
    revision,
    reference: REF,
    attempt: { handle: HANDLE, kind: 'reference', active: false, outcome: 'succeeded' },
    analysis: {
      handle: ANALYSIS_HANDLE,
      synthetic: true,
      audioAccess: 'synthetic_not_accessed',
      observations: ['Synthetic'],
      relationships: ['A'],
      proposedArtist: null,
    },
  });
const CANCELLED = (revision: number) =>
  snap({
    stage: 'cancelled',
    revision,
    reference: REF,
    attempt: { handle: HANDLE, kind: 'reference', active: false, outcome: 'cancelled' },
    code: 'cancelled',
  });

function fakeApi() {
  const log: string[] = [];
  const q = {
    state: [] as Deferred<SafeSnapshot>[],
    createSession: [] as Deferred<SafeSnapshot>[],
    reference: [] as { input: ReferenceRequest; signal: AbortSignal; d: Deferred<SafeSnapshot> }[],
    preference: [] as { input: PreferenceRequest; d: Deferred<SafeSnapshot> }[],
    artistChoice: [] as { input: ArtistChoiceRequest; d: Deferred<SafeSnapshot> }[],
    discover: [] as { input: { brief: Handle; actionKey: string }; signal: AbortSignal; d: Deferred<SafeSnapshot> }[],
    feedback: [] as { input: FeedbackRequest; d: Deferred<SafeSnapshot> }[],
    refine: [] as { input: RefineInput & { actionKey: string }; signal: AbortSignal; d: Deferred<SafeSnapshot> }[],
    stop: [] as { target: StopTarget; d: Deferred<SafeSnapshot> }[],
    clear: [] as Deferred<SafeSnapshot>[],
  };
  const api: ApiPort = {
    state: () => (log.push('state'), q.state[q.state.push(deferred()) - 1]!.promise),
    createSession: () => (log.push('createSession'), q.createSession[q.createSession.push(deferred()) - 1]!.promise),
    reference: (input, signal) => {
      log.push('reference');
      const d = deferred<SafeSnapshot>();
      q.reference.push({ input, signal, d });
      return d.promise;
    },
    preference: (input) => {
      log.push('preference');
      const d = deferred<SafeSnapshot>();
      q.preference.push({ input, d });
      return d.promise;
    },
    artistChoice: (input) => {
      log.push('artistChoice');
      const d = deferred<SafeSnapshot>();
      q.artistChoice.push({ input, d });
      return d.promise;
    },
    discover: (input, signal) => {
      log.push('discover');
      const d = deferred<SafeSnapshot>();
      q.discover.push({ input, signal, d });
      return d.promise;
    },
    feedback: (input) => {
      log.push('feedback');
      const d = deferred<SafeSnapshot>();
      q.feedback.push({ input, d });
      return d.promise;
    },
    refine: (input, signal) => {
      log.push('refine');
      const d = deferred<SafeSnapshot>();
      q.refine.push({ input, signal, d });
      return d.promise;
    },
    stop: (target) => {
      log.push('stop');
      const d = deferred<SafeSnapshot>();
      q.stop.push({ target, d });
      return d.promise;
    },
    clear: () => (log.push('clear'), q.clear[q.clear.push(deferred()) - 1]!.promise),
  };
  return { api, log, q };
}

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function keys() {
  let n = 0;
  return () => `client-action-key-${String(++n).padStart(4, '0')}`;
}

async function withSession(c: SessionController, q: ReturnType<typeof fakeApi>['q'], s: SafeSnapshot = snap()) {
  const r = c.refresh();
  q.state.at(-1)!.resolve(s);
  await r;
}

afterEach(async () => {
  try {
    for (const controller of fixtureControllers) controller.dispose();
    fixtureControllers.clear();
    // Rejecting a held creation can resume a Clear waiting behind it.
    for (let pass = 0; pass < 4; pass++) {
      for (const cleanup of [...heldRequests]) cleanup();
      await flush();
      if (heldRequests.size === 0) break;
    }
    expect(heldRequests.size).toBe(0);
    if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

describe('client revocation races', () => {
  it('Clear during a slow session creation prevents the reference submission and revokes after creation lands', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    const analysing = c.analyse(INPUT);
    await flush();
    expect(log).toEqual(['createSession']);

    const clearing = c.clear();
    expect(c.getView()).toMatchObject({ pending: false, submitted: null });
    await flush();
    expect(log).toEqual(['createSession']);

    q.createSession[0]!.resolve(snap());
    await flush();
    expect(log).toEqual(['createSession', 'clear']);
    q.clear[0]!.resolve(NO_SESSION);
    expect(await clearing).toBe(true);
    await analysing;
    expect(log).not.toContain('reference');
    expect(c.getView().snapshot?.session).toBeNull();
  });

  it('Stop during a slow session creation sends nothing further', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    const analysing = c.analyse(INPUT);
    await flush();
    await c.stop();
    expect(c.getView().pending).toBe(false);
    q.createSession[0]!.resolve(snap());
    await analysing;
    expect(log).toEqual(['createSession']);
    expect(c.getView().snapshot).toBeNull();
  });

  it('Stop after submission aborts transport, stops by action key on the server and ignores the late response', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    await withSession(c, q);
    const analysing = c.analyse(INPUT);
    await flush();
    const sent = q.reference[0]!;
    expect(sent.input.actionKey).toBe('client-action-key-0001');

    const stopping = c.stop();
    expect(sent.signal.aborted).toBe(true);
    expect(q.stop[0]!.target).toEqual({ actionKey: 'client-action-key-0001' });
    q.stop[0]!.d.resolve(CANCELLED(2));
    await stopping;

    sent.d.resolve(READY(3));
    await analysing;
    await flush();
    expect(c.getView().snapshot?.stage).toBe('cancelled');
    expect(c.getView().snapshot?.analysis).toBeNull();
    expect(log.filter((l) => l === 'reference')).toHaveLength(1);
  });

  it('Clear after submission never renders the late reference response', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    await withSession(c, q);
    const analysing = c.analyse(INPUT);
    await flush();
    const clearing = c.clear();
    expect(q.reference[0]!.signal.aborted).toBe(true);
    expect(c.getView().snapshot?.reference).toBeNull();
    await flush();
    q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    q.reference[0]!.d.resolve(READY(5));
    await analysing;
    await flush();
    expect(c.getView().snapshot).toMatchObject({ session: null, reference: null, analysis: null });
  });

  it("an older operation's finally cannot release a newer operation's guard", async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    const first = c.analyse(INPUT);
    await flush();
    await c.stop();
    const second = c.analyse(INPUT);
    await flush();
    expect(log).toEqual(['createSession']);

    q.createSession[0]!.resolve(snap());
    await first;
    await flush();
    expect(c.getView().pending).toBe(true);
    void c.analyse(INPUT);
    await flush();
    expect(q.reference).toHaveLength(1);
    expect(q.reference[0]!.input.actionKey).toBe('client-action-key-0002');

    q.reference[0]!.d.resolve(READY(1));
    await second;
    expect(c.getView()).toMatchObject({ pending: false });
    expect(c.getView().snapshot?.stage).toBe('awaiting_preference');
  });
});

describe('Clear barrier and redaction', () => {
  it('a held Clear blocks return reads, refreshes and new submissions, then a new action proceeds untouched', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys(), returnMinIntervalMs: 0 });
    await withSession(c, q, READY(2));
    const clearing = c.clear();
    expect(c.getView()).toMatchObject({ clearing: true });
    expect(c.getView().snapshot?.analysis).toBeNull();

    c.onReturn(true);
    await c.refresh();
    await c.analyse(INPUT);
    await c.stop();
    await flush();
    expect(log).toEqual(['state', 'clear']);
    expect(c.getView().snapshot?.analysis).toBeNull();

    q.clear[0]!.resolve(NO_SESSION);
    expect(await clearing).toBe(true);
    expect(c.getView().clearing).toBe(false);

    const analysing = c.analyse(INPUT);
    await flush();
    expect(log).toEqual(['state', 'clear', 'createSession']);
    q.createSession[0]!.resolve(snap({ session: { context: 'ctx-session-b', expiresAt: 1 } }));
    await flush();
    q.reference[0]!.d.resolve({ ...READY(1), session: { context: 'ctx-session-b', expiresAt: 1 } });
    await analysing;
    expect(c.getView().snapshot).toMatchObject({ stage: 'awaiting_preference', session: { context: 'ctx-session-b' } });
    expect(c.getView()).toMatchObject({ notice: null, clearing: false, pending: false });
  });

  it('a read issued before Clear that lands during Clear is never applied', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, READY(2));
    const reading = c.refresh();
    const clearing = c.clear();
    q.state[1]!.resolve(READY(3));
    await reading;
    expect(c.getView().snapshot?.analysis).toBeNull();
    q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    expect(c.getView().snapshot).toMatchObject({ session: null, analysis: null });
  });

  it('Clear held behind a slow session creation blocks new submissions until revocation finishes', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    void c.analyse(INPUT);
    await flush();
    const clearing = c.clear();
    await c.analyse(INPUT);
    q.createSession[0]!.resolve(snap());
    await flush();
    await c.analyse(INPUT);
    expect(log).toEqual(['createSession', 'clear']);
    q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    expect(log).not.toContain('reference');
  });

  it('a failed Clear stays behind the recovery barrier: no return read, no submission, until an explicit Retry Clear is confirmed', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys(), returnMinIntervalMs: 0 });
    await withSession(c, q, READY(2));
    const clearing = c.clear();
    q.clear[0]!.reject(new Error('offline'));
    expect(await clearing).toBe(false);
    expect(c.getView()).toMatchObject({ redacted: true, clearing: false, recovery: 'clear_pending' });
    expect(c.getView().notice).toMatch(/Clear did not complete/);

    c.onReturn(true);
    await c.refresh();
    await c.analyse(INPUT);
    await flush();
    expect(log).toEqual(['state', 'clear']);
    expect(c.getView().snapshot).toMatchObject({ analysis: null, reference: null });

    const retry = c.clear();
    q.clear[1]!.resolve(NO_SESSION);
    expect(await retry).toBe(true);
    expect(c.getView()).toMatchObject({ redacted: false, recovery: null, snapshot: { session: null } });
  });

  it('if the browser refuses to store the marker, Clear still proceeds, says so, and keeps this tab redacted until no or a different session is seen', async () => {
    const cell = createIntentCell();
    cell.failWrite = true;
    const { api, q } = fakeApi();
    const c = trackedController(api, { intents: memoryClearIntents(cell) });
    await withSession(c, q, READY(2));
    const clearing = c.clear();
    q.clear[0]!.reject(new Error('offline'));
    await clearing;
    expect(c.getView().notice).toMatch(/did not let Wintr remember the unfinished Clear/);
    expect(c.getView().recovery).toBeNull();
    await withSession(c, q, READY(9));
    expect(c.getView().snapshot?.analysis).toBeNull();
    await withSession(c, q, NO_SESSION);
    expect(c.getView().redacted).toBe(false);
  });

  it.each(['persisted_return', 'delayed_removed_events'] as const)('retains failed-Clear redaction across %s when marker writes fail', async trigger => {
    const cell = createIntentCell();
    cell.deliver = 'manual';
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { intents: memoryClearIntents(cell), returnMinIntervalMs: 0 });
    c.activate();
    await withSession(c, q, { ...READY(2), listenerCue: 'Invented private cue' });
    if (trigger === 'delayed_removed_events') {
      const other = memoryClearIntents(cell);
      other.add('1234567890abcdef');
      other.remove('1234567890abcdef');
    }
    cell.failWrite = true;
    const clearing = c.clear();
    q.clear[0]!.reject(new Error('invented offline failure'));
    expect(await clearing).toBe(false);
    expect(c.getView().redacted).toBe(true);
    if (trigger === 'persisted_return') c.onReturn(true);
    else cell.flush();
    await flush();
    for (let i = 1; i < q.state.length; i++) {
      q.state[i]!.resolve({ ...READY(9), listenerCue: 'Invented private cue' });
      await flush();
    }
    expect(c.getView()).toMatchObject({ redacted: true, snapshot: { reference: null, listenerCue: null, analysis: null } });
    await c.analyse(INPUT);
    await c.discover(BRIEF_HANDLE);
    expect(log.filter(name => !['state', 'clear'].includes(name))).toEqual([]);
    await withSession(c, q, NO_SESSION);
    expect(c.getView().redacted).toBe(false);
    c.dispose();
  });
});

describe('session context ordering', () => {
  it.each(['no_session', 'session_expired'] as const)('a persisted return cannot restore a context already revoked by %s', async code => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, READY(2));
    const failed = c.refresh();
    q.state[1]!.reject(new ApiError(401, code, null));
    await failed;
    c.onReturn(true);
    q.state[2]!.resolve(READY(9));
    await flush();
    expect(c.getView()).toMatchObject({ redacted: true, snapshot: { reference: null, analysis: null } });
    await withSession(c, q, NO_SESSION);
    expect(c.getView().redacted).toBe(false);
    c.dispose();
  });
  it.each(['read', 'stop'] as const)('a known-revoked %s response hides content immediately without waiting for another read', async kind => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, ACTIVE(4));
    const before = c.getView().wipe;
    const request = kind === 'read' ? c.refresh() : c.stop();
    if (kind === 'read') q.state[1]!.reject(new ApiError(401, 'no_session', null));
    else q.stop[0]!.d.reject(new ApiError(401, 'no_session', null));
    await request;
    expect(c.getView()).toMatchObject({ pending: false, stopping: false, redacted: true, wipe: before + 1,
      snapshot: { session: null, reference: null, analysis: null } });
    for (const read of q.state.slice(2)) read.resolve(NO_SESSION);
    await flush();
    c.dispose();
  });

  it.each(['reference', 'discover', 'refine'] as const)('a known-expired %s response wipes local state before reconciliation, and late reads cannot restore it', async kind => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, READY(4));
    const before = c.getView().wipe;
    const work = kind === 'reference' ? c.analyse(INPUT) : kind === 'discover' ? c.discover(BRIEF_HANDLE)
      : c.refine({ mode: 'correct_direction', panel: HANDLE, brief: BRIEF_HANDLE });
    q[kind][0]!.d.reject(new ApiError(410, 'session_expired', null));
    await work;
    expect(c.getView()).toMatchObject({ pending: false, action: null, submitted: null, redacted: true, wipe: before + 1,
      snapshot: { session: null, reference: null, analysis: null } });
    q.state[1]!.resolve(READY(99));
    await flush();
    expect(c.getView().snapshot?.analysis).toBeNull();
    expect(q[kind]).toHaveLength(1);
    c.dispose();
  });

  it('an ended-session GET revokes pending work and wipes drafts before a late successful execute', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, READY(4));
    const before = c.getView().wipe;
    const work = c.discover(BRIEF_HANDLE);
    await withSession(c, q, snap({ session: null, code: 'session_expired' }));
    expect(c.getView()).toMatchObject({ pending: false, submitted: null, wipe: before + 1, snapshot: { session: null } });
    expect(q.discover[0]!.signal.aborted).toBe(true);
    q.discover[0]!.d.resolve(READY(99));
    await work;
    expect(c.getView().snapshot?.analysis).toBeNull();
    c.dispose();
  });

  it('a new session at revision 0 replaces an old session at a higher revision', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, READY(2));
    await withSession(c, q, snap({ session: { context: 'ctx-session-b', expiresAt: 1 }, revision: 0 }));
    expect(c.getView().snapshot).toMatchObject({ session: { context: 'ctx-session-b' }, revision: 0, analysis: null, reference: null });
  });

  it('within one context a lower revision is ignored', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, READY(4));
    await withSession(c, q, ACTIVE(3));
    expect(c.getView().snapshot?.revision).toBe(4);
  });

  it('a response from another context issued before the displayed one cannot reappear', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    void c.analyse(INPUT);
    await flush();
    const reading = c.refresh();
    q.state[0]!.resolve(snap({ session: { context: 'ctx-session-b', expiresAt: 1 } }));
    await reading;
    q.createSession[0]!.resolve({ ...READY(7), session: { context: 'ctx-session-a', expiresAt: 1 } });
    await flush();
    expect(c.getView().snapshot).toMatchObject({ session: { context: 'ctx-session-b' }, analysis: null });
  });
});

describe('free saves and explicit discovery', () => {
  const SAVED = (revision: number) =>
    snap({
      ...READY(revision),
      brief: { handle: BRIEF_HANDLE, version: 1, relationship: 'A', source: 'analysis_choice', artists: ['Generic Artist'] },
    });
  const PREF: PreferenceInput = { analysis: ANALYSIS_HANDLE, relationship: { choice: 0 }, artists: ['Generic Artist'] };

  it('a free save only calls the preference endpoint, with its own key and the version it was based on', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    await withSession(c, q, READY(2));
    const saving = c.savePreference(PREF);
    expect(q.preference[0]!.input).toEqual({ ...PREF, actionKey: 'client-action-key-0001', expectedBrief: null });
    // A second click while the first save is pending is ignored rather than racing its own basis.
    expect(await c.savePreference(PREF)).toBe(false);
    q.preference[0]!.d.resolve(SAVED(3));
    expect(await saving).toBe(true);
    expect(log).toEqual(['state', 'preference']);
    expect(c.getView().snapshot?.brief?.version).toBe(1);

    const next = c.savePreference({ ...PREF, relationship: { text: 'different' } });
    expect(q.preference[1]!.input).toMatchObject({ actionKey: 'client-action-key-0002', expectedBrief: BRIEF_HANDLE });
    q.preference[1]!.d.resolve(SAVED(4));
    await next;
  });

  it('an artist choice carries its own key and the checkpoint revision; a stale basis re-reads state', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    const identity = { handle: BRIEF_HANDLE, revision: 3, awaiting: true, slots: [] };
    await withSession(c, q, snap({ ...SAVED(4), stage: 'awaiting_artist', identity }));
    const choosing = c.chooseArtist({ checkpoint: BRIEF_HANDLE, slot: 0, choice: null });
    expect(q.artistChoice[0]!.input).toEqual({ checkpoint: BRIEF_HANDLE, slot: 0, choice: null, actionKey: 'client-action-key-0001', expectedRevision: 3 });
    q.artistChoice[0]!.d.reject(new ApiError(409, 'stale_version', null));
    expect(await choosing).toBe(false);
    expect(log.at(-1)).toBe('state');
  });

  it('free saves and artist choices are blocked during Clear, without a session and while work runs', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    expect(await c.savePreference(PREF)).toBe(false);
    await withSession(c, q, READY(2));
    const clearing = c.clear();
    expect(await c.savePreference(PREF)).toBe(false);
    expect(await c.chooseArtist({ checkpoint: BRIEF_HANDLE, slot: 0, choice: null })).toBe(false);
    q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    await withSession(c, q, { ...ACTIVE(5) });
    expect(await c.savePreference(PREF)).toBe(false);
    expect(log.filter((l) => l === 'preference' || l === 'artistChoice')).toEqual([]);
  });

  it('Discover sends the confirmed brief handle with a fresh action key and can be stopped by that key', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    await withSession(c, q, SAVED(3));
    const running = c.discover(BRIEF_HANDLE);
    await flush();
    expect(q.discover[0]!.input).toEqual({ brief: BRIEF_HANDLE, actionKey: 'client-action-key-0001' });
    const stopping = c.stop();
    expect(q.discover[0]!.signal.aborted).toBe(true);
    expect(q.stop[0]!.target).toEqual({ actionKey: 'client-action-key-0001' });
    q.stop[0]!.d.resolve({ ...SAVED(5), stage: 'cancelled', attempt: { handle: HANDLE, kind: 'discover', active: false, outcome: 'cancelled' } });
    await stopping;
    q.discover[0]!.d.resolve({ ...SAVED(6), stage: 'failed', code: 'catalogue_not_configured' });
    await running;
    await flush();
    expect(c.getView().snapshot?.stage).toBe('cancelled');
  });

  it('feedback is a free save with its own key and the revision it was based on; refine is one counted, stoppable operation', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    const PANEL = 'panel-handle-00000000001' as Handle;
    const CHOICE = 'choice-handle-0000000001' as Handle;
    const withPanel = (revision: number, fbRevision: number) =>
      snap({
        ...SAVED(revision),
        stage: 'complete',
        panel: {
          handle: PANEL,
          synthetic: true,
          role: 'initial',
          mode: null,
          basis: [],
          outcome: 'choices',
          choices: [
            {
              handle: CHOICE,
              title: 'Invented Song',
              credits: ['Neighbour X11'],
              unverifiedCredits: 0,
              anchor: 'Neighbour X11',
              playUrl: null,
              service: 'youtube',
              fitHypothesis: 'x',
              sources: [],
              feedback: { fit: fbRevision > 0 ? 'like' : null, familiarity: null, revision: fbRevision },
            },
          ],
          answer: { text: '', marks: [] },
          citations: [],
          suggestionsUrl: null,
          gaps: [],
        },
        refinement: { used: false },
      });
    await withSession(c, q, withPanel(3, 2));
    const saving = c.saveFeedback({ panel: PANEL, choice: CHOICE, fit: 'like', familiarity: 'known' });
    expect(q.feedback[0]!.input).toEqual({ panel: PANEL, choice: CHOICE, fit: 'like', familiarity: 'known', actionKey: 'client-action-key-0001', expectedRevision: 2 });
    expect(await c.saveFeedback({ panel: PANEL, choice: CHOICE, fit: null, familiarity: null })).toBe(false);
    q.feedback[0]!.d.resolve(withPanel(4, 3));
    expect(await saving).toBe(true);
    expect(log).toEqual(['state', 'feedback']);

    const running = c.refine({ mode: 'correct_direction', panel: PANEL, brief: BRIEF_HANDLE });
    await flush();
    expect(q.refine[0]!.input).toEqual({ mode: 'correct_direction', panel: PANEL, brief: BRIEF_HANDLE, actionKey: 'client-action-key-0002' });
    // Feedback is blocked while the counted operation is in flight.
    expect(await c.saveFeedback({ panel: PANEL, choice: CHOICE, fit: null, familiarity: null })).toBe(false);
    const stopping = c.stop();
    expect(q.refine[0]!.signal.aborted).toBe(true);
    expect(q.stop[0]!.target).toEqual({ actionKey: 'client-action-key-0002' });
    q.stop[0]!.d.resolve({ ...withPanel(5, 3), stage: 'cancelled', attempt: { handle: HANDLE, kind: 'refine', active: false, outcome: 'cancelled' }, refinement: { used: true } });
    await stopping;
    q.refine[0]!.d.resolve(withPanel(4, 3));
    await running;
    expect(c.getView().snapshot).toMatchObject({ stage: 'cancelled', refinement: { used: true } });
    expect(log.filter((l) => l === 'refine')).toHaveLength(1);
  });

  it('a late discovery response after Clear is never rendered', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    await withSession(c, q, SAVED(3));
    const running = c.discover(BRIEF_HANDLE);
    await flush();
    const clearing = c.clear();
    q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    q.discover[0]!.d.resolve({
      ...SAVED(9),
      connection: { synthetic: true, seeds: ['x'], artists: ['y'], anchors: [], tags: [], capability: 'artists_only', attribution: 'seed_mix', why: [] },
    });
    await running;
    expect(c.getView().snapshot).toMatchObject({ session: null, connection: null, brief: null });
  });
});

describe('acknowledged free feedback and revocation', () => {
  const PANEL = 'pending-panel-0000000001' as Handle;
  const CHOICE = 'pending-choice-000000001' as Handle;
  const result = (revision: number, fit: 'like' | null = null, familiarity: 'new' | null = null): SafeSnapshot => ({
    ...READY(revision), stage: 'complete',
    brief: { handle: BRIEF_HANDLE, version: 1, relationship: 'A', source: 'analysis_choice', artists: ['Invented Artist'] },
    panel: { handle: PANEL, synthetic: true, role: 'initial', mode: null, basis: [], outcome: 'choices',
      choices: [{ handle: CHOICE, title: 'Invented Recording', credits: ['Invented Neighbour'], unverifiedCredits: 0,
        anchor: 'Invented Neighbour', service: 'youtube', playUrl: null, fitHypothesis: 'An untested synthetic hypothesis.',
        sources: [], feedback: { fit, familiarity, revision: revision - 3 } }],
      answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] },
    refinement: { used: false },
  });
  const input = { panel: PANEL, choice: CHOICE, fit: 'like' as const, familiarity: null };

  it('shows an outstanding save, visibly refuses a rapid second axis and holds paid work until acknowledgement', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { newKey: keys() });
    await withSession(c, q, result(3));
    const first = c.saveFeedback(input);
    expect(c.getView().saving).toEqual({ kind: 'feedback', target: CHOICE });
    expect(c.getView().snapshot?.panel?.choices[0]?.feedback.fit).toBeNull();
    expect(await c.saveFeedback({ ...input, fit: null, familiarity: 'new' })).toBe(false);
    expect(c.getView().notice).toMatch(/still being saved.*not sent/i);
    await c.discover(BRIEF_HANDLE);
    expect(c.submitReference(INPUT).accepted).toBe(false);
    await c.refine({ mode: 'correct_direction', panel: PANEL, brief: BRIEF_HANDLE });
    expect(log).toEqual(['state', 'feedback']);
    q.feedback[0]!.d.resolve(result(4, 'like'));
    expect(await first).toBe(true);
    expect(c.getView().saving).toBeNull();
    const second = c.saveFeedback({ ...input, familiarity: 'new' });
    expect(q.feedback[1]!.input).toMatchObject({ fit: 'like', familiarity: 'new', expectedRevision: 1 });
    q.feedback[1]!.d.resolve(result(5, 'like', 'new'));
    expect(await second).toBe(true);
    expect(c.getView().snapshot?.panel?.choices[0]?.feedback).toMatchObject({ fit: 'like', familiarity: 'new' });
  });

  it('expiry removes the pending save immediately and a late acknowledgement cannot restore the old recording', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, result(3));
    const first = c.saveFeedback(input);
    await withSession(c, q, NO_SESSION);
    expect(c.getView()).toMatchObject({ saving: null, snapshot: { session: null, panel: null } });
    q.feedback[0]!.d.resolve(result(4, 'like'));
    expect(await first).toBe(false);
    expect(c.getView().snapshot?.panel).toBeNull();
  });

  it.each(['session_expired', 'no_session'] as const)('a %s free-save response revokes local content before a reconciliation read can finish', async code => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, result(3));
    const initialWipe = c.getView().wipe;
    const first = c.saveFeedback(input);
    q.feedback[0]!.d.reject(new ApiError(410, code, null));
    expect(await first).toBe(false);
    expect(c.getView()).toMatchObject({ saving: null, redacted: true, wipe: initialWipe + 1,
      snapshot: { session: null, reference: null, brief: null, panel: null } });
    expect(log).toEqual(['state', 'feedback', 'state']);
    // A read that started before revocation must not reintroduce the same old context, even with a larger revision.
    q.state[1]!.resolve(result(99, 'like'));
    await flush();
    expect(c.getView().snapshot?.panel).toBeNull();
    expect(c.getView().snapshot?.brief).toBeNull();
    expect(c.getView().redacted).toBe(true);
    await withSession(c, q, NO_SESSION);
    expect(c.getView()).toMatchObject({ redacted: false, saving: null, snapshot: { session: null } });
    expect(q.feedback).toHaveLength(1);
  });

  it('a cleared old save cannot end a different session’s outstanding save when its late acknowledgement arrives', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, result(3));
    const first = c.saveFeedback(input);
    const clearing = c.clear();
    expect(c.getView().saving).toBeNull();
    q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    const other = { ...result(3), session: { context: 'another-invented-session', expiresAt: 99_999_999 } };
    await withSession(c, q, other);
    const second = c.saveFeedback({ ...input, familiarity: 'new' });
    q.feedback[0]!.d.resolve(result(4, 'like'));
    expect(await first).toBe(false);
    expect(c.getView().saving).toEqual({ kind: 'feedback', target: CHOICE });
    expect(c.getView().snapshot?.session?.context).toBe(other.session.context);
    q.feedback[1]!.d.resolve({ ...result(4, 'like', 'new'), session: other.session });
    expect(await second).toBe(true);
    expect(c.getView().saving).toBeNull();
  });

  it('a stale feedback basis ends saving with a visible failure and reads the owned state without retrying the write', async () => {
    const { api, log, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, result(3));
    const first = c.saveFeedback(input);
    q.feedback[0]!.d.reject(new ApiError(409, 'stale_version', null));
    expect(await first).toBe(false);
    expect(c.getView().saving).toBeNull();
    expect(c.getView().notice).toBeTruthy();
    expect(log).toEqual(['state', 'feedback', 'state']);
    q.state[1]!.resolve(result(5, null, 'new'));
    await flush();
    expect(c.getView().snapshot?.panel?.choices[0]?.feedback).toMatchObject({ fit: null, familiarity: 'new' });
    expect(q.feedback).toHaveLength(1);
  });

  it('another tab’s Clear intent removes the pending cue and content before a free response returns', async () => {
    const cell = createIntentCell();
    const intents = memoryClearIntents(cell);
    const { api, q } = fakeApi();
    const c = trackedController(api, { intents });
    c.activate();
    await withSession(c, q, result(3));
    const first = c.saveFeedback(input);
    memoryClearIntents(cell).add('independent-clear-intent-0001');
    expect(c.getView()).toMatchObject({ saving: null, redacted: true });
    expect(c.getView().snapshot?.panel).toBeNull();
    q.feedback[0]!.d.resolve(result(4, 'like'));
    expect(await first).toBe(false);
    expect(c.getView().snapshot?.panel).toBeNull();
    c.dispose();
  });
});

describe('refresh and return recovery', () => {
  it('observes completion of an active attempt with bounded GET reads, then stops', async () => {
    vi.useFakeTimers();
    const { api, log, q } = fakeApi();
    const c = trackedController(api, { watchIntervalMs: 1000 });
    await withSession(c, q, ACTIVE(1));
    expect(c.getView().snapshot?.attempt?.active).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(q.state).toHaveLength(2);
    q.state[1]!.resolve(ACTIVE(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(q.state).toHaveLength(3);
    q.state[2]!.resolve(READY(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getView().snapshot?.stage).toBe('awaiting_preference');

    await vi.advanceTimersByTimeAsync(30_000);
    expect(q.state).toHaveLength(3);
    expect(log.every((l) => l === 'state')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps background reads while the server stays active', async () => {
    vi.useFakeTimers();
    const { api, q } = fakeApi();
    const c = trackedController(api, { watchIntervalMs: 1000, maxWatchReads: 3 });
    await withSession(c, q, ACTIVE(1));
    for (let i = 1; i <= 3; i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      q.state[i]!.resolve(ACTIVE(1));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(q.state).toHaveLength(4);
    expect(c.getView().notice).toMatch(/still working/i);
  });

  it('return handling is one rate-limited read and never dispatches', async () => {
    const { api, log, q } = fakeApi();
    const clock = { t: 0 };
    const c = trackedController(api, { returnMinIntervalMs: 2000, clock: () => clock.t });
    c.onReturn(false);
    expect(log).toEqual([]);

    await withSession(c, q);
    clock.t = 10_000;
    c.onReturn(false);
    c.onReturn(true);
    expect(log).toEqual(['state', 'state']);
    q.state[1]!.resolve(snap());
    await flush();
    clock.t = 12_000;
    c.onReturn(true);
    expect(log).toEqual(['state', 'state', 'state']);
  });

  it('a revoked server session clears rendered data instead of resurrecting it', async () => {
    const { api, q } = fakeApi();
    const c = trackedController(api);
    await withSession(c, q, READY(4));
    expect(c.getView().snapshot?.analysis).not.toBeNull();
    await withSession(c, q, snap({ session: null, code: 'session_expired' }));
    expect(c.getView().snapshot).toMatchObject({ session: null, reference: null, analysis: null, code: 'session_expired' });
  });
});

describe('honest progress while the page awaits its own execute', () => {
  const SAVED = (revision: number) =>
    snap({
      ...READY(revision),
      brief: { handle: BRIEF_HANDLE, version: 1, relationship: 'A', source: 'analysis_choice', artists: ['Generic Artist'] },
    });
  const PANEL = 'panel-handle-00000000001' as Handle;
  const admitted = (revision: number, kind: 'discover' | 'refine', stage: SafeSnapshot['stage'], extra: Partial<SafeSnapshot> = {}) =>
    snap({
      ...SAVED(revision),
      stage,
      attempt: { handle: 'attempt-handle-0002' as Handle, kind, active: true, outcome: 'running' },
      ...extra,
    });
  const CONNECTION: SafeSnapshot['connection'] = {
    synthetic: true,
    seeds: ['Generic Artist'],
    artists: ['Neighbour X11'],
    anchors: [],
    tags: [],
    capability: 'artists_only',
    attribution: 'seed_mix',
    why: [],
  };
  const done = (revision: number) =>
    snap({
      ...SAVED(revision),
      stage: 'complete',
      attempt: { handle: 'attempt-handle-0002' as Handle, kind: 'discover', active: false, outcome: 'succeeded' },
      connection: CONNECTION,
      refinement: { used: false },
      panel: { handle: PANEL, synthetic: true, role: 'initial', mode: null, basis: [], outcome: 'choices', choices: [], answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] },
    });
  const text = (c: SessionController) => workingText(c.getView().snapshot, c.getView().action);
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  async function discovering(opts: { maxWatchReads?: number } = {}) {
    vi.useFakeTimers();
    const fake = fakeApi();
    const c = trackedController(fake.api, { newKey: keys(), watchIntervalMs: 1000, ...opts });
    await withSession(c, fake.q, SAVED(3));
    const running = c.discover(BRIEF_HANDLE);
    await tick(0);
    return { ...fake, c, running };
  }

  it('shows the pre-admission fallback, not the earlier reference attempt, then each actual admitted stage from read-only GETs', async () => {
    const { c, q, log, running } = await discovering();
    expect(c.getView().action).toEqual({ kind: 'discover' });
    // The page still holds the old, finished reference attempt; it must not describe this action.
    expect(c.getView().snapshot?.attempt).toMatchObject({ kind: 'reference', active: false });
    expect(text(c)).toBe('Starting the search…');
    expect(q.state).toHaveLength(1);

    await tick(1000);
    expect(q.state).toHaveLength(2);
    q.state[1]!.resolve(admitted(4, 'discover', 'resolving_artists'));
    await tick(0);
    expect(text(c)).toBe('Finding artist connections…');

    await tick(1000);
    q.state[2]!.resolve(admitted(5, 'discover', 'retrieving_taste', { connection: CONNECTION }));
    await tick(0);
    expect(text(c)).toBe('Exploring artist connections…');
    expect(c.getView().snapshot?.connection?.artists).toEqual(['Neighbour X11']);

    await tick(1000);
    q.state[3]!.resolve(admitted(6, 'discover', 'finding_tracks', { connection: CONNECTION }));
    await tick(0);
    expect(text(c)).toBe('Finding and verifying songs…');

    q.discover[0]!.d.resolve(done(7));
    await running;
    expect(c.getView()).toMatchObject({ pending: false, action: null });
    expect(c.getView().snapshot?.stage).toBe('complete');

    // Completion cancels the watch: no timer, no further read, and the execute went out exactly once.
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(q.state).toHaveLength(4);
    expect(log.filter((l) => l === 'discover')).toHaveLength(1);
  });

  it('a direction correction is honest before admission and about its reused connections after', async () => {
    vi.useFakeTimers();
    const { api, q } = fakeApi();
    const c = trackedController(api, { newKey: keys(), watchIntervalMs: 1000 });
    const withPanel = { ...done(5), refinement: { used: false } };
    await withSession(c, q, withPanel);
    const running = c.refine({ mode: 'correct_direction', panel: PANEL, brief: BRIEF_HANDLE });
    await tick(0);
    expect(c.getView().action).toEqual({ kind: 'refine', refineMode: 'correct_direction' });
    expect(text(c)).toBe('Starting your refinement…');
    expect(text(c)).not.toMatch(/Finding the artists|reference/i);
    await tick(1000);
    q.state[1]!.resolve({ ...admitted(6, 'refine', 'finding_tracks', { connection: CONNECTION }), refinement: { used: true } });
    await tick(0);
    expect(text(c)).toBe('Finding more songs…');
    q.refine[0]!.d.resolve({ ...withPanel, revision: 7 });
    await running;
  });

  it('a following refinement starts at the connection step the server reports, never the reference text', async () => {
    vi.useFakeTimers();
    const { api, q } = fakeApi();
    const c = trackedController(api, { newKey: keys(), watchIntervalMs: 1000 });
    await withSession(c, q, done(5));
    const running = c.refine({ mode: 'follow_connection', panel: PANEL, brief: BRIEF_HANDLE, choice: 'choice-handle-0000000001' as Handle });
    await tick(0);
    expect(text(c)).toBe('Starting your refinement…');
    await tick(1000);
    q.state[1]!.resolve(admitted(6, 'refine', 'retrieving_taste', { connection: CONNECTION }));
    await tick(0);
    expect(text(c)).toBe('Exploring artist connections…');
    q.refine[0]!.d.resolve(done(7));
    await running;
  });

  it('only an active attempt of the same kind counts as admitted; recovery with no local action follows the server', () => {
    const old = snap({ ...SAVED(4), stage: 'finding_tracks', attempt: { handle: HANDLE, kind: 'reference', active: false, outcome: 'succeeded' } });
    expect(workingText(old, { kind: 'discover' })).toBe('Starting the search…');
    const other = admitted(4, 'refine', 'finding_tracks');
    expect(workingText(other, { kind: 'discover' })).toBe('Starting the search…');
    expect(workingText(admitted(4, 'discover', 'finding_tracks'), null)).toBe('Finding and verifying songs…');
    expect(workingText(ACTIVE(1), null)).toBe('Preparing the reference. Synthetic mode: no provider is contacted.');
    expect(workingText(null, { kind: 'reference' })).toBe('Preparing your song…');
  });

  it('Stop cancels the watch, drops a read still in flight, and never sends another paid request', async () => {
    const { c, q, log, running } = await discovering();
    await tick(1000);
    const inFlight = q.state[1]!;
    const stopping = c.stop();
    expect(q.discover[0]!.signal.aborted).toBe(true);
    // No progress timer is left: only the deadlines of the read in flight and of the Stop request.
    expect(vi.getTimerCount()).toBe(2);
    q.stop[0]!.d.resolve({ ...SAVED(5), stage: 'cancelled', attempt: { handle: HANDLE, kind: 'discover', active: false, outcome: 'cancelled' }, code: 'cancelled' });
    await stopping;
    // A late read that still shows the run as active, or with a result, must not render or announce anything.
    inFlight.resolve({ ...admitted(6, 'discover', 'finding_tracks', { connection: CONNECTION }), panel: done(6).panel });
    await tick(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(c.getView().snapshot).toMatchObject({ stage: 'cancelled', panel: null, connection: null });
    q.discover[0]!.d.resolve(done(8));
    await running;
    expect(c.getView().snapshot?.stage).toBe('cancelled');
    await tick(30_000);
    expect(q.state).toHaveLength(2);
    expect(log.filter((l) => l === 'discover')).toHaveLength(1);
    expect(log.filter((l) => l === 'stop')).toHaveLength(1);
  });

  it('Clear cancels the watch and rejects reads and responses that land afterwards', async () => {
    const { c, q, log, running } = await discovering();
    await tick(1000);
    const inFlight = q.state[1]!;
    const clearing = c.clear();
    // No progress timer is left: only the deadlines of the read in flight and of the Clear request.
    expect(vi.getTimerCount()).toBe(2);
    q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    inFlight.resolve(admitted(6, 'discover', 'retrieving_taste', { connection: CONNECTION }));
    q.discover[0]!.d.resolve(done(9));
    await running;
    await tick(0);
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(c.getView().snapshot).toMatchObject({ session: null, connection: null, panel: null });
    expect(c.getView()).toMatchObject({ pending: false, action: null });
    expect(q.state).toHaveLength(2);
    expect(log.filter((l) => l === 'discover')).toHaveLength(1);
  });

  it('a read that lands after the execute returned is dropped and cannot overwrite the result', async () => {
    const { c, q, running } = await discovering();
    await tick(1000);
    const late = q.state[1]!;
    q.discover[0]!.d.resolve(done(8));
    await running;
    late.resolve(admitted(6, 'discover', 'finding_tracks'));
    await tick(0);
    expect(c.getView().snapshot).toMatchObject({ stage: 'complete', revision: 8 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a failed progress read is silent, never retries the execute, and the watch carries on', async () => {
    const { c, q, log, running } = await discovering();
    await tick(1000);
    q.state[1]!.reject(new ApiError(503, 'admission_unavailable', null));
    await tick(0);
    expect(c.getView().notice).toBeNull();
    expect(c.getView().pending).toBe(true);
    await tick(1000);
    expect(q.state).toHaveLength(3);
    q.state[2]!.resolve(admitted(5, 'discover', 'finding_tracks'));
    await tick(0);
    expect(text(c)).toBe('Finding and verifying songs…');
    q.discover[0]!.d.resolve(done(8));
    await running;
    expect(c.getView().notice).toBeNull();
    expect(log.filter((l) => l === 'discover')).toHaveLength(1);
  });

  it('honours the read ceiling, and dispose cancels the timer', async () => {
    const capped = await discovering({ maxWatchReads: 2 });
    for (let i = 1; i <= 2; i += 1) {
      await tick(1000);
      capped.q.state[i]!.resolve(admitted(3 + i, 'discover', 'resolving_artists'));
      await tick(0);
    }
    await tick(10_000);
    expect(capped.q.state).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    capped.q.discover[0]!.d.resolve(done(9));
    await capped.running;

    const disposed = await discovering();
    disposed.c.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await tick(10_000);
    expect(disposed.q.state).toHaveLength(1);
    disposed.q.discover[0]!.d.resolve(done(9));
    await disposed.running;
  });

  it('no reads are scheduled before the execute is on the wire (session creation) or after a reference starts failing', async () => {
    vi.useFakeTimers();
    const { api, q, log } = fakeApi();
    const c = trackedController(api, { newKey: keys(), watchIntervalMs: 1000 });
    const running = c.analyse(INPUT);
    await tick(0);
    expect(c.getView().action).toEqual({ kind: 'reference' });
    expect(text(c)).toBe('Preparing your song…');
    await tick(5000);
    expect(log).toEqual(['createSession']);
    q.createSession[0]!.resolve(snap({ revision: 0 }));
    await tick(0);
    expect(log).toEqual(['createSession', 'reference']);
    q.reference[0]!.d.reject(new ApiError(503, 'providers_disabled', null));
    await running;
    expect(c.getView().action).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Clear recovery across hangs, reloads and renderers (shared marker storage)', () => {
  it('reconciles a completed cross-tab Clear after an in-flight progress read drains', async () => {
    vi.useFakeTimers();
    const cell = createIntentCell();
    const net = fakeApi();
    const c = trackedController(net.api, { intents: memoryClearIntents(cell), watchIntervalMs: 1000 });
    c.activate();
    await withSession(c, net.q, READY(4));
    const running = c.discover(BRIEF_HANDLE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.q.state).toHaveLength(2);
    const other = memoryClearIntents(cell);
    other.add('1234567890abcdef');
    other.remove('1234567890abcdef');
    expect(c.getView().snapshot?.analysis).toBeNull();
    net.q.state[1]!.resolve(READY(6));
    await vi.advanceTimersByTimeAsync(0);
    expect(net.q.state).toHaveLength(3);
    net.q.state[2]!.resolve(NO_SESSION);
    net.q.discover[0]!.d.resolve(READY(7));
    await running;
    await vi.advanceTimersByTimeAsync(0);
    expect(c.getView().snapshot?.session).toBeNull();
    expect(net.q.discover).toHaveLength(1);
    c.dispose();
  });
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  // Unique per Clear operation across renderers, like the random nonce in the browser.
  let idSeq = 0;
  const nextId = () => (++idSeq).toString(16).padStart(16, '0');
  /** One renderer (a tab, or one page load) with its own controller and network, sharing the origin's storage. */
  function tab(cell: ReturnType<typeof createIntentCell>, opts: { controlTimeoutMs?: number } = {}) {
    const net = fakeApi();
    const c = trackedController(net.api, { newKey: keys(), returnMinIntervalMs: 0, intents: memoryClearIntents(cell), newIntentId: nextId, ...opts });
    c.activate();
    return { c, ...net };
  }
  const markers = (cell: ReturnType<typeof createIntentCell>) => [...cell.entries.keys()].filter((k) => k.startsWith(CLEAR_INTENT_PREFIX));
  const SESSION_READY = READY(4);
  const SAVED_BRIEF = READY(5);

  it('a Clear whose request never answers ends at the control deadline: hidden, retryable, marker kept, nothing retried', async () => {
    vi.useFakeTimers();
    const cell = createIntentCell();
    const a = tab(cell, { controlTimeoutMs: 1000 });
    await withSession(a.c, a.q, SESSION_READY);
    const clearing = a.c.clear();
    expect(a.c.getView().snapshot).toMatchObject({ analysis: null, reference: null });
    expect(markers(cell)).toHaveLength(1);
    expect(isIntentId(markers(cell)[0]!.slice(CLEAR_INTENT_PREFIX.length))).toBe(true);
    expect([...cell.entries.values()]).toEqual(['v1']);
    await tick(999);
    expect(a.c.getView().clearing).toBe(true);
    await tick(1);
    expect(await clearing).toBe(false);
    expect(a.c.getView()).toMatchObject({ clearing: false, redacted: true, recovery: 'clear_pending' });
    expect(a.c.getView().notice).toMatch(/did not get an answer in time/);
    expect(markers(cell)).toHaveLength(1);
    await tick(60_000);
    expect(a.log).toEqual(['state', 'clear']);
    // A late reply to the abandoned request is not an acknowledgement this page acts on.
    a.q.clear[0]!.resolve(NO_SESSION);
    await tick(0);
    expect(a.c.getView().recovery).toBe('clear_pending');
    expect(markers(cell)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a malformed success reply is not a confirmation: marker kept, no success claim', async () => {
    for (const reply of [{}, [], { ...NO_SESSION, session: { context: 'ctx-session-a', expiresAt: 1 } }, { ...NO_SESSION, analysis: READY(1).analysis }, { error: 'no_session' }]) {
      const cell = createIntentCell();
      const a = tab(cell);
      await withSession(a.c, a.q, SESSION_READY);
      const clearing = a.c.clear();
      a.q.clear[0]!.resolve(reply as unknown as SafeSnapshot);
      expect(await clearing).toBe(false);
      expect(markers(cell)).toHaveLength(1);
      expect(a.c.getView()).toMatchObject({ recovery: 'clear_pending', redacted: true });
      expect(a.c.getView().notice).toMatch(/did not confirm/);
      expect(a.c.getView().notice).not.toMatch(/Session cleared/);
    }
    // An error reply never confirms either, whatever code it carries.
    const cell = createIntentCell();
    const a = tab(cell);
    const clearing = a.c.clear();
    a.q.clear[0]!.reject(new ApiError(401, 'no_session', null));
    expect(await clearing).toBe(false);
    expect(markers(cell)).toHaveLength(1);
  });

  it('after an unconfirmed Clear a hard reload makes no private read and shows nothing until Retry Clear is confirmed', async () => {
    const cell = createIntentCell();
    const first = tab(cell);
    await withSession(first.c, first.q, SESSION_READY);
    const clearing = first.c.clear();
    first.q.clear[0]!.reject(new ApiError(0, 'network', null));
    await clearing;
    first.c.dispose();

    const reload = tab(cell);
    await reload.c.refresh();
    reload.c.onReturn(true);
    reload.c.onReturn(false);
    await reload.c.analyse(INPUT);
    expect(await reload.c.saveFeedback({ panel: 'p' as Handle, choice: 'c' as Handle, fit: 'like', familiarity: null })).toBe(false);
    await flush();
    expect(reload.log).toEqual([]);
    expect(reload.c.getView()).toMatchObject({ snapshot: null, recovery: 'clear_pending', redacted: true, pending: false });
    expect(reload.c.getView().wipe).toBeGreaterThan(0);
    expect(reload.c.getView().notice).toMatch(/not confirmed by the server/);

    const retry = reload.c.clear();
    expect(reload.log).toEqual(['clear']);
    reload.q.clear[0]!.resolve(NO_SESSION);
    expect(await retry).toBe(true);
    expect(markers(cell)).toEqual([]);
    expect(reload.c.getView()).toMatchObject({ recovery: null, redacted: false, snapshot: { session: null } });
    expect(reload.c.getView().notice).toBe('Session cleared.');
    void reload.c.refresh();
    expect(reload.log).toEqual(['clear', 'state']);
  });

  describe('storage is the authority, not event delivery (events delayed or never delivered)', () => {
    it('wipes a completed Clear even when both storage events arrive after marker removal', async () => {
      const cell = createIntentCell(); cell.deliver = 'manual';
      const a = tab(cell), b = tab(cell);
      await withSession(b.c, b.q, SESSION_READY);
      const clearing = a.c.clear();
      a.q.clear[0]!.resolve(NO_SESSION); expect(await clearing).toBe(true);
      expect(markers(cell)).toEqual([]);
      cell.flush();
      expect(b.c.getView().snapshot?.analysis ?? null).toBeNull();
      expect(b.c.getView().wipe).toBeGreaterThan(0);
      // Every read that predates the final invalidation must stay unable to restore content.
      for (const read of b.q.state.slice(1)) read.resolve(NO_SESSION);
      await flush();
      for (const read of b.q.state.slice(1)) read.resolve(NO_SESSION);
      await flush();
      expect(b.c.getView().snapshot?.session ?? null).toBeNull();
    });

    it('redacts a restored page before a fresh read even if Clear markers have already gone', async () => {
      const cell = createIntentCell(); const b = tab(cell);
      await withSession(b.c, b.q, SESSION_READY);
      b.c.onReturn(true);
      expect(b.c.getView().snapshot?.analysis ?? null).toBeNull();
      expect(b.c.getView().wipe).toBeGreaterThan(0);
      b.q.state[1]!.resolve(NO_SESSION); await flush();
      expect(b.c.getView().snapshot?.session ?? null).toBeNull();
    });
    it('a marker written during session creation stops the paid request before it is sent, and nothing renders', async () => {
      const cell = createIntentCell();
      cell.deliver = 'manual';
      const a = tab(cell);
      const b = tab(cell);
      const analysing = b.c.analyse(INPUT);
      await flush();
      expect(b.log).toEqual(['createSession']);
      void a.c.clear();
      b.q.createSession[0]!.resolve(READY(1));
      await analysing;
      await flush();
      expect(b.log).toEqual(['createSession']);
      expect(b.c.getView()).toMatchObject({ recovery: 'clear_pending', pending: false, snapshot: null });
      cell.flush();
      expect(b.log).toEqual(['createSession']);
    });

    it('a marker written while a free save is in flight wins: its private reply is never applied', async () => {
      const cell = createIntentCell();
      cell.deliver = 'manual';
      const a = tab(cell);
      const b = tab(cell);
      await withSession(b.c, b.q, SAVED_BRIEF);
      const saving = b.c.savePreference({ analysis: ANALYSIS_HANDLE, relationship: { text: 'a private note' }, artists: [] });
      await flush();
      void a.c.clear();
      b.q.preference[0]!.d.resolve({ ...SAVED_BRIEF, revision: 6, listenerCue: 'a new private cue' });
      expect(await saving).toBe(false);
      expect(b.c.getView().snapshot?.listenerCue ?? null).toBeNull();
      expect(b.c.getView().snapshot?.analysis ?? null).toBeNull();
      expect(b.c.getView().recovery).toBe('clear_pending');
    });

    it('a marker written while a paid execute or a read is in flight wins over their replies', async () => {
      const cell = createIntentCell();
      cell.deliver = 'manual';
      const a = tab(cell);
      const b = tab(cell);
      await withSession(b.c, b.q, SESSION_READY);
      const running = b.c.discover(BRIEF_HANDLE);
      await flush();
      void a.c.clear();
      b.q.discover[0]!.d.resolve(READY(9));
      await running;
      expect(b.c.getView()).toMatchObject({ recovery: 'clear_pending', snapshot: { analysis: null } });
      expect(b.log.filter((l) => l === 'discover')).toHaveLength(1);

      const c = tab(cell);
      expect(c.c.getView().recovery).toBe('clear_pending');
    });

    it('with no marker, the same flows proceed exactly once and render normally', async () => {
      const cell = createIntentCell();
      cell.deliver = 'manual';
      const b = tab(cell);
      const analysing = b.c.analyse(INPUT);
      await flush();
      b.q.createSession[0]!.resolve(snap());
      await flush();
      b.q.reference[0]!.d.resolve(READY(1));
      await analysing;
      expect(b.log).toEqual(['createSession', 'reference']);
      expect(b.c.getView()).toMatchObject({ recovery: null, snapshot: { stage: 'awaiting_preference' } });
    });
  });

  it('a Clear in another renderer hides this one at once, aborts its pending execute, then reads once after the ACK', async () => {
    const cell = createIntentCell();
    const a = tab(cell);
    const b = tab(cell);
    await withSession(a.c, a.q, SESSION_READY);
    await withSession(b.c, b.q, SESSION_READY);
    const running = b.c.discover(BRIEF_HANDLE);
    await flush();
    const wipeBefore = b.c.getView().wipe;
    const clearing = a.c.clear();
    expect(b.c.getView()).toMatchObject({ recovery: 'clear_pending', redacted: true, pending: false, snapshot: { analysis: null } });
    expect(b.c.getView().wipe).toBe(wipeBefore + 1);
    expect(b.q.discover[0]!.signal.aborted).toBe(true);
    b.q.discover[0]!.d.resolve(READY(9));
    await running;
    b.c.onReturn(true);
    await b.c.refresh();
    expect(b.log).toEqual(['state', 'discover']);
    a.q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    expect(markers(cell)).toEqual([]);
    expect(b.c.getView()).toMatchObject({ recovery: null, redacted: false, notice: 'Session cleared from another Wintr tab.' });
    expect(b.log).toEqual(['state', 'discover', 'state']);
    b.q.state.at(-1)!.resolve(NO_SESSION);
    await flush();
    expect(b.c.getView().snapshot).toMatchObject({ session: null, analysis: null });
  });

  it('a newer marker written between an acknowledgement and its removal survives; the barrier holds until that Clear is confirmed', async () => {
    const cell = createIntentCell();
    const a = tab(cell);
    const b = tab(cell);
    await withSession(a.c, a.q, SESSION_READY);
    const first = a.c.clear();
    let second: Promise<boolean> | null = null;
    // Interleave: B starts its own Clear exactly between A's acknowledgement and A's first removal.
    cell.beforeOp = (op) => {
      if (op === 'remove') second = b.c.clear();
    };
    a.q.clear[0]!.resolve(NO_SESSION);
    expect(await first).toBe(true);
    expect(second).not.toBeNull();
    expect(markers(cell)).toHaveLength(1);
    expect(a.c.getView()).toMatchObject({ recovery: 'clear_pending', redacted: true });
    expect(a.c.getView().notice).toMatch(/another Clear is still waiting/);
    await a.c.refresh();
    expect(a.log).toEqual(['state', 'clear']);
    b.q.clear[0]!.resolve(NO_SESSION);
    expect(await second!).toBe(true);
    expect(markers(cell)).toEqual([]);
    expect(a.c.getView().recovery).toBeNull();
    expect(b.c.getView().recovery).toBeNull();
  });

  it('independent pending intents: an older ACK leaves the newer one; a newer ACK also covers the older one', async () => {
    const cell = createIntentCell();
    const a = tab(cell);
    const b = tab(cell);
    const older = a.c.clear();
    const newer = b.c.clear();
    expect(markers(cell)).toHaveLength(2);
    a.q.clear[0]!.resolve(NO_SESSION);
    await older;
    expect(markers(cell)).toHaveLength(1);
    expect(a.c.getView().recovery).toBe('clear_pending');
    b.q.clear[0]!.resolve(NO_SESSION);
    await newer;
    expect(markers(cell)).toEqual([]);

    const cell2 = createIntentCell();
    const c = tab(cell2);
    const d = tab(cell2);
    const olderFails = c.c.clear();
    const newerOk = d.c.clear();
    d.q.clear[0]!.resolve(NO_SESSION);
    expect(await newerOk).toBe(true);
    expect(markers(cell2)).toEqual([]);
    c.q.clear[0]!.reject(new ApiError(0, 'network', null));
    expect(await olderFails).toBe(false);
    expect(markers(cell2)).toEqual([]);
  });

  it('a page restored from the back/forward cache, or booting cold, honours a marker it was never notified about', async () => {
    const cell = createIntentCell();
    const b = tab(cell);
    await withSession(b.c, b.q, SESSION_READY);
    cell.entries.set(`${CLEAR_INTENT_PREFIX}00000000000000aa`, 'v1');
    b.c.onReturn(true);
    expect(b.c.getView()).toMatchObject({ recovery: 'clear_pending', snapshot: { analysis: null } });
    expect(b.log).toEqual(['state']);
    const cold = tab(cell);
    await cold.c.refresh();
    expect(cold.log).toEqual([]);
    expect(cold.c.getView().recovery).toBe('clear_pending');
  });

  it('with no intent, return from listening elsewhere reads normally and keeps the draft epoch', async () => {
    const cell = createIntentCell();
    const b = tab(cell);
    await withSession(b.c, b.q, SESSION_READY);
    b.c.onReturn(false);
    expect(b.log).toEqual(['state', 'state']);
    b.q.state[1]!.resolve(READY(5));
    await flush();
    expect(b.c.getView()).toMatchObject({ recovery: null, redacted: false, wipe: 0, snapshot: { revision: 5 } });
    expect(b.c.getView().snapshot?.analysis).not.toBeNull();
  });

  it('a corrupt marker (any key under the prefix, any value) is pending; a confirmed Retry Clear removes it as an earlier marker', async () => {
    const cell = createIntentCell({ [`${CLEAR_INTENT_PREFIX}not-hex`]: 'garbage', [`${CLEAR_INTENT_PREFIX}0000000000000bad`]: '' });
    const b = tab(cell);
    await b.c.refresh();
    expect(b.log).toEqual([]);
    expect(b.c.getView().recovery).toBe('clear_pending');
    const retry = b.c.clear();
    expect(markers(cell)).toHaveLength(3);
    b.q.clear[0]!.resolve(NO_SESSION);
    await retry;
    expect(markers(cell)).toEqual([]);
    expect(b.c.getView().recovery).toBeNull();
  });

  it('unreadable storage fails closed with an explicit choice: show the session, or Retry Clear', async () => {
    const cell = createIntentCell();
    cell.failRead = true;
    const b = tab(cell);
    await b.c.refresh();
    expect(b.log).toEqual([]);
    expect(b.c.getView()).toMatchObject({ recovery: 'storage_unavailable', redacted: true });
    expect(b.c.getView().notice).toMatch(/blocking site storage/);
    b.c.continueWithoutIntentCheck();
    expect(b.log).toEqual(['state']);
    b.q.state[0]!.resolve(SESSION_READY);
    await flush();
    expect(b.c.getView()).toMatchObject({ recovery: null, redacted: false });
    expect(b.c.getView().snapshot?.analysis).not.toBeNull();

    const other = createIntentCell();
    other.failRead = true;
    other.failWrite = true;
    const t = tab(other);
    expect(t.c.getView().recovery).toBe('storage_unavailable');
    const retry = t.c.clear();
    t.q.clear[0]!.resolve(NO_SESSION);
    expect(await retry).toBe(true);
    expect(t.c.getView()).toMatchObject({ recovery: null, redacted: false });
  });

  it('Clear racing a hung session creation waits only up to the deadline, never sends the paid request, and drops the late session', async () => {
    vi.useFakeTimers();
    const cell = createIntentCell();
    const b = tab(cell, { controlTimeoutMs: 1000 });
    const analysing = b.c.analyse(INPUT);
    await tick(0);
    expect(b.log).toEqual(['createSession']);
    const clearing = b.c.clear();
    await tick(999);
    expect(b.log).toEqual(['createSession']);
    await tick(1);
    expect(b.log).toEqual(['createSession', 'clear']);
    b.q.createSession[0]!.resolve(snap({ session: { context: 'ctx-late', expiresAt: 1 } }));
    b.q.clear[0]!.resolve(NO_SESSION);
    expect(await clearing).toBe(true);
    await analysing;
    await tick(0);
    expect(b.log).toEqual(['createSession', 'clear']);
    expect(b.c.getView().snapshot).toMatchObject({ session: null });
    expect(markers(cell)).toEqual([]);
  });

  it('a paid result landing after Clear is never applied and nothing paid is re-sent', async () => {
    const cell = createIntentCell();
    const b = tab(cell);
    await withSession(b.c, b.q, SESSION_READY);
    const running = b.c.discover(BRIEF_HANDLE);
    await flush();
    const clearing = b.c.clear();
    b.q.discover[0]!.d.resolve(READY(12));
    await running;
    expect(b.c.getView().snapshot?.analysis ?? null).toBeNull();
    b.q.clear[0]!.resolve(NO_SESSION);
    await clearing;
    expect(b.log.filter((l) => l === 'discover')).toHaveLength(1);
    expect(b.log).not.toContain('stop');
    expect(b.c.getView().snapshot).toMatchObject({ session: null });
  });

  it('hung reads and a hung Stop end at the deadline with a notice; nothing is retried', async () => {
    vi.useFakeTimers();
    const cell = createIntentCell();
    const b = tab(cell, { controlTimeoutMs: 1000 });
    const reading = b.c.refresh();
    await tick(1000);
    await reading;
    expect(b.c.getView().notice).toMatch(/did not get an answer in time/);
    expect(b.log).toEqual(['state']);

    const c = tab(cell, { controlTimeoutMs: 1000 });
    const r = c.c.refresh();
    c.q.state[0]!.resolve(ACTIVE(1));
    await r;
    const stopping = c.c.stop();
    await tick(1000);
    await stopping;
    expect(c.c.getView()).toMatchObject({ stopping: false });
    expect(c.c.getView().notice).toMatch(/did not get an answer in time/);
    expect(c.log.filter((l) => l === 'stop')).toHaveLength(1);
    c.c.dispose();
  });
});
