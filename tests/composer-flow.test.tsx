import { renderToStaticMarkup } from 'react-dom/server';
import { isRecordedReference } from '../src/shared/records.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { parseTimestamp, parseYouTubeReference, validateFocus } from '../src/shared/youtube.js';
import { ApiError, type ApiPort, type ReferenceRequest } from '../src/client/api.js';
import { EditSourceAction, SourceDetails } from '../src/client/App.js';
import { CLEAR_INTENT_PREFIX, createIntentCell, memoryClearIntents } from '../src/client/clear-intent.js';
import { COMPOSER_HEIGHT_MS, ComposerHeight } from '../src/client/composer-height.js';
import { SessionController, type AnalyseInput } from '../src/client/controller.js';
import {
  acceptSend,
  currentComposer,
  editDraft,
  EMPTY_DRAFT,
  initialComposer,
  isEmptyDraft,
  loadSource,
  setSourceOpen,
  settleSend,
  sourceNote,
  type ComposerState,
  type Draft,
  type OwnedRef,
  type SettleFacts,
  type SourceRef,
} from '../src/client/draft.js';
import { FakeFrames } from './fixtures/fake-frames.js';

const fixtureControllers = new Set<SessionController>();
const heldRequests = new Set<() => void>();
function trackedController(...args: ConstructorParameters<typeof SessionController>) {
  const controller = new SessionController(...args);
  fixtureControllers.add(controller);
  return controller;
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

// Accepted-send composer reset, compact source editing and the safe, memory-only retry
// copy (M03.send / M03.growth). Pure-core tests plus deferred-operation flows through the
// real controller. They are logic tests, not browser, phone or zoom evidence.

const A: SourceRef = { canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', focus: { start: 12, end: 57 } };
const B: SourceRef = { canonicalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', focus: { start: 0, end: 45 } };
const typedA: Draft = { url: 'https://youtu.be/dQw4w9WgXcQ?t=12', start: '00:12', end: '00:57', cue: 'the groove', focusEdited: false };
/** What the server owns, as the page reads it from the snapshot: the source, its focus and its note (listenerCue). */
const ownedA: OwnedRef = { ...A, cue: 'the groove' };
const ownedB: OwnedRef = { ...B, cue: null };
const facts = (o: Partial<SettleFacts> = {}): SettleFacts => ({ working: false, blocked: false, expired: false, context: 'ctx-1', owned: null, ...o });
const sentA = (s: ComposerState, wipe = 0, context: string | null = 'ctx-1') => acceptSend(editDraft(s, wipe, typedA), wipe, { ref: A, context });

describe('an accepted send resets only the accepted composer draft', () => {
  it('moves exactly the sent draft into one retry copy, empties the composer and collapses the source disclosure', () => {
    let s = editDraft(initialComposer(0), 0, typedA);
    s = setSourceOpen(s, 0, true);
    const sent = acceptSend(s, 0, { ref: A, context: 'ctx-1' });
    expect(sent.draft).toBe(EMPTY_DRAFT);
    expect(isEmptyDraft(sent.draft)).toBe(true);
    expect(sent.sourceOpen).toBe(false);
    expect(sent.accepted).toEqual({ draft: typedA, ref: A, note: 'the groove', context: 'ctx-1' });
    expect(sent.note).toBeNull();
  });

  it('a new draft typed afterwards survives a late completion, failure, stop or result untouched', () => {
    const s = editDraft(sentA(initialComposer(0)), 0, (d) => ({ ...d, url: 'https://youtu.be/AAAAAAAAAAA' }));
    for (const f of [facts({ owned: ownedA }), facts({ owned: null }), facts({ owned: ownedB }), facts({ context: null })]) {
      const settled = settleSend(s, 0, f);
      expect(settled.state.draft).toEqual({ ...EMPTY_DRAFT, url: 'https://youtu.be/AAAAAAAAAAA' });
      expect(settled.state.accepted).toBeNull();
    }
    expect(settleSend(s, 0, facts({ owned: null })).result).toBe('kept_new');
    expect(settleSend(s, 0, facts({ owned: null })).state.note).toBe('kept_new');
  });

  it('even a single typed character keeps the composer from being overwritten', () => {
    const s = editDraft(sentA(initialComposer(0)), 0, (d) => ({ ...d, cue: 'x' }));
    expect(settleSend(s, 0, facts()).state.draft.cue).toBe('x');
  });

  it('a second accept replaces the single copy; at most one is ever held', () => {
    const once = sentA(initialComposer(0));
    const twice = acceptSend(editDraft(once, 0, { ...typedA, url: B.canonicalUrl }), 0, { ref: B, context: 'ctx-1' });
    expect(twice.accepted?.ref).toBe(B);
    expect(twice.accepted?.draft.url).toBe(B.canonicalUrl);
  });
});

describe('what happens to the retry copy once work has ended', () => {
  const sent = () => sentA(initialComposer(0));

  it('waits while work is under way, and is inert when there is no copy', () => {
    const held = sent();
    expect(settleSend(held, 0, facts({ working: true })).result).toBe('waiting');
    expect(settleSend(held, 0, facts({ working: true })).state).toBe(held);
    expect(settleSend(initialComposer(0), 0, facts()).result).toBe('none');
  });

  it('the server owning this very source keeps it there (Edit source) and drops the copy; the composer stays empty', () => {
    const r = settleSend(sent(), 0, facts({ owned: ownedA }));
    expect(r.result).toBe('owned');
    expect(r.state.accepted).toBeNull();
    expect(isEmptyDraft(r.state.draft)).toBe(true);
  });

  it('nothing owned, or a different source owned, puts the exact copy back into an empty composer once', () => {
    for (const owned of [null, ownedB]) {
      const r = settleSend(sent(), 0, facts({ owned }));
      expect(r.result).toBe('restored');
      expect(r.state.draft).toBe(typedA);
      expect(r.state.accepted).toBeNull();
      expect(r.state.note).toBe('restored');
      // Settling again can never restore a second time.
      expect(settleSend(r.state, 0, facts({ owned })).result).toBe('none');
    }
  });

  describe('the note is part of the intent: same source and focus, different note', () => {
    const draftWith = (cue: string): Draft => ({ ...typedA, cue });
    const sentWith = (cue: string) => acceptSend(editDraft(initialComposer(0), 0, draftWith(cue)), 0, { ref: A, context: 'ctx-1' });

    it('a note-only correction that was not admitted restores the EXACT typed draft once; the old owned note is not mistaken for it', () => {
      const typed = draftWith('  keep the guitar contrast  ');
      const s = acceptSend(editDraft(initialComposer(0), 0, typed), 0, { ref: A, context: 'ctx-1' });
      const r = settleSend(s, 0, facts({ owned: { ...A, cue: 'keep the groove' } }));
      expect(r.result).toBe('restored');
      expect(r.state.draft).toBe(typed);
      expect(r.state.draft.cue).toBe('  keep the guitar contrast  ');
      expect(settleSend(r.state, 0, facts({ owned: { ...A, cue: 'keep the groove' } })).result).toBe('none');
    });

    it('the same normalised note owned means the duplicate is dropped; raw spacing does not matter, as the request trims', () => {
      const r = settleSend(sentWith('  the groove \n'), 0, facts({ owned: { ...A, cue: 'the groove' } }));
      expect(r.result).toBe('owned');
      expect(isEmptyDraft(r.state.draft)).toBe(true);
      expect(r.state.accepted).toBeNull();
    });

    it('blank and whitespace-only notes are the same as no note, in both directions', () => {
      for (const typed of ['', '   ', '\n\t ']) {
        for (const cue of [null, '', '  ']) expect(settleSend(sentWith(typed), 0, facts({ owned: { ...A, cue } })).result).toBe('owned');
        expect(settleSend(sentWith(typed), 0, facts({ owned: { ...A, cue: 'an older note' } })).result).toBe('restored');
      }
      // Adding a note where none is owned is also a different intent.
      expect(settleSend(sentWith('a new note'), 0, facts({ owned: { ...A, cue: null } })).result).toBe('restored');
      expect(settleSend(sentWith('a new note'), 0, facts({ owned: { ...A, cue: '  ' } })).result).toBe('restored');
    });

    it('a different note is compared as typed text, not as a prefix or case variant', () => {
      for (const owned of ['The groove', 'the groove.', 'the']) expect(settleSend(sentWith('the groove'), 0, facts({ owned: { ...A, cue: owned } })).result).toBe('restored');
    });

    it('a new draft typed meanwhile still wins over a note-only restore, and the wipe/context/expiry barriers still apply', () => {
      const typedNew = editDraft(sentWith('keep the guitar contrast'), 0, (d) => ({ ...d, url: B.canonicalUrl }));
      const kept = settleSend(typedNew, 0, facts({ owned: { ...A, cue: 'keep the groove' } }));
      expect(kept.result).toBe('kept_new');
      expect(kept.state.draft.url).toBe(B.canonicalUrl);
      expect(kept.state.draft.cue).toBe('');
      for (const f of [facts({ blocked: true }), facts({ expired: true }), facts({ context: 'ctx-other' })]) {
        const r = settleSend(sentWith('keep the guitar contrast'), 0, { ...f, owned: { ...A, cue: 'keep the groove' } });
        expect(r.result).toBe('dropped');
        expect(isEmptyDraft(r.state.draft)).toBe(true);
      }
      expect(settleSend(sentWith('keep the guitar contrast'), 1, facts({ owned: { ...A, cue: 'keep the groove' } })).result).toBe('none');
    });
  });

  it('a session creation that failed (no session, no owned source) is recoverable; the new session context is fine for a first send', () => {
    const first = sentA(initialComposer(0), 0, null);
    expect(settleSend(first, 0, facts({ context: null, owned: null })).result).toBe('restored');
    expect(settleSend(first, 0, facts({ context: 'ctx-new', owned: null })).result).toBe('restored');
  });

  it('a barrier, expiry, another session or a wipe never revives the copy', () => {
    expect(settleSend(sent(), 0, facts({ blocked: true })).result).toBe('dropped');
    expect(settleSend(sent(), 0, facts({ expired: true })).result).toBe('dropped');
    expect(settleSend(sent(), 0, facts({ context: 'ctx-other' })).result).toBe('dropped');
    expect(settleSend(sent(), 0, facts({ context: null })).result).toBe('dropped');
    const dropped = settleSend(sent(), 0, facts({ blocked: true })).state;
    expect(isEmptyDraft(dropped.draft)).toBe(true);
    expect(dropped.accepted).toBeNull();
    // A wipe epoch change: everything (draft, copy, disclosure) is gone in the same render.
    const wiped = settleSend(setSourceOpen(sent(), 0, true), 1, facts());
    expect(wiped.result).toBe('none');
    expect(wiped.state).toEqual(initialComposer(1));
    expect(currentComposer(sent(), 1).accepted).toBeNull();
  });

  it('wording never claims a link is in the composer unless it was just put back there', () => {
    expect(sourceNote('restored', false, false)).toMatch(/back in the composer/);
    expect(sourceNote('kept_new', true, false)).toMatch(/not put back because you have started a new draft/);
    const owned = sourceNote(null, true, true);
    expect(owned).toMatch(/Edit source/);
    expect(owned).not.toMatch(/is still in the composer|are back in the composer/);
    expect(sourceNote(null, true, false)).toMatch(/Edit source is available when the composer is empty/);
    expect(sourceNote(null, false, true)).toBe('');
  });
});

describe('Edit source: the owned source back into the composer, sent only by Analyse', () => {
  const owned = { ...A, cue: 'the groove' };

  it('loads source, focus and note into an empty composer with the disclosure open, and keeps the allowed forms', () => {
    const r = loadSource(initialComposer(0), 0, owned);
    expect(r.loaded).toBe(true);
    expect(r.state.draft).toEqual({ url: A.canonicalUrl, start: '00:12', end: '00:57', cue: 'the groove', focusEdited: true });
    expect(r.state.sourceOpen).toBe(true);
    expect(r.state.accepted).toBeNull();
    // The loaded draft is exactly what Analyse would accept: a valid link and an unchanged focus.
    const parsed = parseYouTubeReference(r.state.draft.url);
    expect(parsed.ok).toBe(true);
    const focus = validateFocus({ start: parseTimestamp(r.state.draft.start)!, end: parseTimestamp(r.state.draft.end)! });
    expect(focus.ok && focus.focus).toEqual(A.focus);
    expect(loadSource(initialComposer(0), 0, { ...A, cue: null }).state.draft.cue).toBe('');
  });

  it('never overwrites a new draft', () => {
    const typed = editDraft(initialComposer(0), 0, { ...EMPTY_DRAFT, url: 'https://youtu.be/AAAAAAAAAAA' });
    const r = loadSource(typed, 0, owned);
    expect(r.loaded).toBe(false);
    expect(r.state).toBe(typed);
  });

  it('is gone with a wipe: nothing loads from an earlier epoch', () => {
    expect(currentComposer(loadSource(initialComposer(0), 0, owned).state, 1)).toEqual(initialComposer(1));
  });
});

describe('suggestion note focus and disclosure progression', () => {
  it('a tap fills only the note, opens the disclosure, and an accepted send then collapses it (the large form is gone from the result)', () => {
    let s = editDraft(initialComposer(0), 0, typedA);
    s = { ...s, draft: { ...s.draft, cue: '' } };
    s = setSourceOpen(editDraft(s, 0, (d) => ({ ...d, cue: 'The vocal' })), 0, true);
    expect(s.draft).toEqual({ ...typedA, cue: 'The vocal' });
    expect(s.sourceOpen).toBe(true);
    const sent = acceptSend(s, 0, { ref: A, context: 'ctx-1' });
    expect(sent.sourceOpen).toBe(false);
    expect(isEmptyDraft(sent.draft)).toBe(true);
    // Reopening the disclosure is an explicit act, and a user toggle is recorded without touching the draft.
    const reopened = setSourceOpen(sent, 0, true);
    expect(reopened.draft).toBe(EMPTY_DRAFT);
    expect(setSourceOpen(reopened, 0, true)).toBe(reopened);
  });

  it('the disclosure is controlled: open state renders open, attention forces it open, and it is otherwise collapsed', () => {
    const render = (o: { attention: boolean; open: boolean }) =>
      renderToStaticMarkup(
        <SourceDetails compact summary="Focus 00:12–00:57" attention={o.attention} open={o.open} onToggle={() => {}}>
          <input id="source-cue" />
        </SourceDetails>,
      );
    expect(render({ attention: false, open: true })).toMatch(/<details[^>]*\sopen=""/);
    expect(render({ attention: true, open: false })).toMatch(/<details[^>]*\sopen=""/);
    expect(render({ attention: false, open: false })).not.toMatch(/<details[^>]*\sopen/);
  });

  it('Edit source is a named toolbar action and sends nothing by itself', () => {
    const html = renderToStaticMarkup(<EditSourceAction onEdit={() => {}} />);
    expect(html).toContain('class="icon-button new-reference"');
    expect(html).toContain('aria-label="Edit source link, focus and note"');
    expect(html).not.toMatch(/type="submit"|<form|href=/);
  });
});

// ---------------------------------------------------------------------------
// Deferred operations through the real controller

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
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const snap = (o: Partial<SafeSnapshot> = {}): SafeSnapshot => ({
  mode: 'synthetic',
  session: { context: 'ctx-1', expiresAt: 9_999_999 },
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
const REF = { videoId: 'dQw4w9WgXcQ', canonicalUrl: A.canonicalUrl, focus: A.focus };
const OWNED = (o: Partial<SafeSnapshot> = {}) =>
  snap({ revision: 3, stage: 'awaiting_preference', status: 'reference_ready', reference: REF, listenerCue: 'the groove', attempt: { handle: 'attempt-handle-0001' as Handle, kind: 'reference', active: false, outcome: 'succeeded' }, ...o });

/** One page: the real controller over deferred operations, with the composer state driven exactly as the page drives it. */
function page(cell = createIntentCell()) {
  const log: string[] = [];
  const q = {
    state: [] as Deferred<SafeSnapshot>[],
    create: [] as Deferred<SafeSnapshot>[],
    reference: [] as { input: ReferenceRequest; signal: AbortSignal; d: Deferred<SafeSnapshot> }[],
    stop: [] as Deferred<SafeSnapshot>[],
    clear: [] as Deferred<SafeSnapshot>[],
  };
  const unused = () => Promise.reject(new Error('not used here'));
  const api: ApiPort = {
    state: () => (log.push('state'), q.state[q.state.push(deferred()) - 1]!.promise),
    createSession: () => (log.push('createSession'), q.create[q.create.push(deferred()) - 1]!.promise),
    reference: (input, signal) => {
      log.push('reference');
      const d = deferred<SafeSnapshot>();
      q.reference.push({ input, signal, d });
      return d.promise;
    },
    preference: unused,
    artistChoice: unused,
    feedback: unused,
    discover: unused,
    refine: unused,
    stop: () => (log.push('stop'), q.stop[q.stop.push(deferred()) - 1]!.promise),
    clear: () => (log.push('clear'), q.clear[q.clear.push(deferred()) - 1]!.promise),
  };
  let n = 0;
  const c = trackedController(api, { newKey: () => `client-action-key-${String(++n).padStart(4, '0')}`, returnMinIntervalMs: 0, intents: memoryClearIntents(cell), newIntentId: () => String(++n).padStart(16, '0') });
  c.activate();
  let comp = initialComposer(c.getView().wipe);
  const wipe = () => c.getView().wipe;
  const draft = () => currentComposer(comp, wipe()).draft;
  const type = (d: Draft | ((d: Draft) => Draft)) => (comp = editDraft(comp, wipe(), d));
  const inputOf = (d: Draft): AnalyseInput => {
    const parsed = parseYouTubeReference(d.url);
    if (!parsed.ok) throw new Error('fixture draft must be valid');
    const focus = { start: parseTimestamp(d.start)!, end: parseTimestamp(d.end)! };
    const cue = d.cue.trim() === '' ? null : d.cue.trim();
    return { url: d.url.trim(), focus, cue, display: { videoId: parsed.videoId, canonicalUrl: parsed.canonicalUrl, focus, cue } };
  };
  /** The page's Analyse handler: only an accepted send takes the draft out of the composer. */
  const analyse = () => {
    const input = inputOf(draft());
    const sent = c.submitReference(input);
    if (sent.accepted) comp = acceptSend(comp, wipe(), { ref: { canonicalUrl: input.display.canonicalUrl, focus: input.focus }, context: c.getView().snapshot?.session?.context ?? null });
    return sent;
  };
  /** The page's settle effect, run after each change. */
  const settle = () => {
    const v = c.getView();
    const s = v.snapshot;
    const working = v.pending || v.stopping || s?.attempt?.active === true;
    const blocked = v.clearing || v.redacted || v.recovery !== null || c.barrierActive();
    const owned = s?.reference && !('kind' in s.reference) ? { canonicalUrl: s.reference.canonicalUrl, focus: s.reference.focus, cue: s.listenerCue } : null;
    const r = settleSend(comp, wipe(), { working, blocked, expired: s?.code === 'session_expired', context: s?.session?.context ?? null, owned });
    comp = r.state;
    return r.result;
  };
  const edit = () => {
    const s = c.getView().snapshot;
    if (!s?.reference || 'kind' in s.reference) return false;
    const r = loadSource(comp, wipe(), { canonicalUrl: s.reference.canonicalUrl, focus: s.reference.focus, cue: s.listenerCue });
    comp = r.state;
    return r.loaded;
  };
  return { c, log, q, cell, get comp() { return comp; }, draft, type, analyse, settle, edit };
}

describe('accepted versus refused sends (deferred operations)', () => {
  it('a refused Analyse (one is already running) is a no-op: nothing leaves the composer and exactly one request exists', async () => {
    const p = page();
    p.type(typedA);
    const first = p.analyse();
    expect(first.accepted).toBe(true);
    expect(p.draft()).toBe(EMPTY_DRAFT);
    // While it runs the listener has a new draft; a second Analyse is refused and changes nothing.
    p.type({ ...typedA, url: B.canonicalUrl });
    const second = p.analyse();
    expect(second.accepted).toBe(false);
    expect(p.draft().url).toBe(B.canonicalUrl);
    expect(p.comp.accepted?.ref).toEqual(A);
    await flush();
    expect(p.log).toEqual(['createSession']);
    p.q.create[0]!.resolve(snap());
    await flush();
    expect(p.log).toEqual(['createSession', 'reference']);
  });

  it('behind a Clear barrier an Analyse is refused and the draft stays where it is', async () => {
    const cell = createIntentCell({ [`${CLEAR_INTENT_PREFIX}00000000000000aa`]: 'v1' });
    const p = page(cell);
    p.type(typedA);
    // The page itself erased this draft at the barrier's wipe; typing after it is new content in the new epoch.
    p.type(typedA);
    const sent = p.analyse();
    expect(sent.accepted).toBe(false);
    expect(p.draft()).toEqual(typedA);
    expect(p.log).toEqual([]);
  });
});

describe('failure, Stop and recovery without any automatic call', () => {
  it('an early session-creation failure puts the original intent back, and nothing is sent again', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    expect(p.settle()).toBe('waiting');
    p.q.create[0]!.reject(new ApiError(0, 'network', null));
    await flush();
    expect(p.settle()).toBe('restored');
    expect(p.draft()).toBe(typedA);
    expect(p.comp.note).toBe('restored');
    await flush();
    expect(p.log).toEqual(['createSession']);
  });

  it('Stop before anything was sent restores at once, and the late session landing sends no paid request', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    void p.c.stop();
    expect(p.c.getView().pending).toBe(false);
    expect(p.settle()).toBe('restored');
    expect(p.draft()).toBe(typedA);
    p.q.create[0]!.resolve(snap());
    await flush();
    expect(p.log).toEqual(['createSession']);
    expect(p.settle()).toBe('none');
    expect(p.draft()).toBe(typedA);
  });

  it('a later failure cannot overwrite what was typed in between', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    void p.c.stop();
    // The listener starts something new before the old send's outcome is settled.
    p.type({ ...EMPTY_DRAFT, url: B.canonicalUrl });
    expect(p.settle()).toBe('kept_new');
    expect(p.draft().url).toBe(B.canonicalUrl);
    expect(p.comp.accepted).toBeNull();
    p.q.create[0]!.reject(new ApiError(0, 'network', null));
    await flush();
    expect(p.settle()).toBe('none');
    expect(p.draft().url).toBe(B.canonicalUrl);
  });

  it('a send the server owns (even if it failed later) stays as an owned source: composer empty, Edit source loads it, and only Analyse sends', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    p.q.create[0]!.resolve(snap());
    await flush();
    p.q.reference[0]!.d.resolve(OWNED({ stage: 'failed', code: 'deadline', attempt: { handle: 'attempt-handle-0001' as Handle, kind: 'reference', active: false, outcome: 'failed' } }));
    await flush();
    expect(p.settle()).toBe('owned');
    expect(isEmptyDraft(p.draft())).toBe(true);
    expect(p.edit()).toBe(true);
    expect(p.draft()).toEqual({ url: A.canonicalUrl, start: '00:12', end: '00:57', cue: 'the groove', focusEdited: true });
    await flush();
    expect(p.log).toEqual(['createSession', 'reference']);
    // Only the explicit Analyse sends, once, with the owned focus and note.
    const sent = p.analyse();
    expect(sent.accepted).toBe(true);
    expect(p.log).toEqual(['createSession', 'reference', 'reference']);
    expect(p.q.reference[1]!.input).toMatchObject({ focus: A.focus, cue: 'the groove' });
  });

  it('an edited source that is rejected before admission comes back as the EDITED draft, not the old owned one', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    p.q.create[0]!.resolve(snap());
    await flush();
    p.q.reference[0]!.d.resolve(OWNED());
    await flush();
    expect(p.settle()).toBe('owned');
    p.edit();
    p.type((d) => ({ ...d, url: B.canonicalUrl, start: '00:00', end: '00:45', cue: 'the vocal' }));
    p.analyse();
    p.q.reference[1]!.d.reject(new ApiError(429, 'rate_limited', null));
    await flush();
    expect(p.settle()).toBe('restored');
    expect(p.draft()).toEqual({ url: B.canonicalUrl, start: '00:00', end: '00:45', cue: 'the vocal', focusEdited: true });
    expect(p.log.filter((l) => l === 'reference')).toHaveLength(2);
  });

  describe('a note-only correction of the same source and focus (real controller, deferred rejection)', () => {
    /** An owned source with its note, then Edit source and a change to the note alone. */
    async function ownedThenNoteEdit(newNote: string) {
      const p = page();
      p.type(typedA);
      p.analyse();
      p.q.create[0]!.resolve(snap());
      await flush();
      p.q.reference[0]!.d.resolve(OWNED());
      await flush();
      expect(p.settle()).toBe('owned');
      expect(p.edit()).toBe(true);
      p.type((d) => ({ ...d, cue: newNote }));
      return p;
    }

    it('rejected before admission: the old owned note is NOT taken for the new intent; the edited note comes back exactly, once', async () => {
      const p = await ownedThenNoteEdit('keep the guitar contrast');
      const edited = p.draft();
      expect(p.analyse().accepted).toBe(true);
      expect(isEmptyDraft(p.draft())).toBe(true);
      // The existing snapshot still owns the OLD note while the new request is refused before admission.
      p.q.reference[1]!.d.reject(new ApiError(409, 'capacity', null));
      await flush();
      expect(p.c.getView().snapshot?.listenerCue).toBe('the groove');
      expect(p.settle()).toBe('restored');
      expect(p.draft()).toBe(edited);
      expect(p.draft().cue).toBe('keep the guitar contrast');
      expect(p.draft()).toMatchObject({ url: A.canonicalUrl, start: '00:12', end: '00:57' });
      // Once only, and nothing was ever re-sent by the page.
      expect(p.settle()).toBe('none');
      expect(p.log.filter((l) => l === 'reference')).toHaveLength(2);
    });

    it('the explicit Edit source after that loads the OLD owned note only into an empty composer, never over the restored correction', async () => {
      const p = await ownedThenNoteEdit('keep the guitar contrast');
      p.analyse();
      p.q.reference[1]!.d.reject(new ApiError(429, 'rate_limited', null));
      await flush();
      p.settle();
      expect(p.edit()).toBe(false);
      expect(p.draft().cue).toBe('keep the guitar contrast');
    });

    it('a new draft typed after the refusal survives; the correction is not put back over it', async () => {
      const p = await ownedThenNoteEdit('keep the guitar contrast');
      p.analyse();
      p.q.reference[1]!.d.reject(new ApiError(409, 'capacity', null));
      await flush();
      p.type({ ...EMPTY_DRAFT, url: B.canonicalUrl });
      expect(p.settle()).toBe('kept_new');
      expect(p.draft()).toEqual({ ...EMPTY_DRAFT, url: B.canonicalUrl });
    });

    it('when the server does admit the note change, it owns the new note and the duplicate copy is dropped', async () => {
      const p = await ownedThenNoteEdit('  keep the guitar contrast ');
      p.analyse();
      p.q.reference[1]!.d.resolve(OWNED({ listenerCue: 'keep the guitar contrast', revision: 4 }));
      await flush();
      expect(p.settle()).toBe('owned');
      expect(isEmptyDraft(p.draft())).toBe(true);
      expect(p.edit()).toBe(true);
      expect(p.draft().cue).toBe('keep the guitar contrast');
    });

    it('a blank correction of the note is also a different intent from an owned note', async () => {
      const p = await ownedThenNoteEdit('   ');
      p.analyse();
      p.q.reference[1]!.d.reject(new ApiError(409, 'capacity', null));
      await flush();
      expect(p.settle()).toBe('restored');
      expect(p.draft().cue).toBe('   ');
    });
  });

  it('a successful send keeps nothing in the composer and holds no copy afterwards', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    p.q.create[0]!.resolve(snap());
    await flush();
    p.q.reference[0]!.d.resolve(OWNED());
    await flush();
    expect(p.settle()).toBe('owned');
    expect(p.comp.accepted).toBeNull();
    expect(isEmptyDraft(p.draft())).toBe(true);
  });
});

describe('Clear, another tab, reload and expiry never resurrect the copy', () => {
  it('Clear during a send wipes the composer, the copy and the disclosure at once; a later failure restores nothing', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    const clearing = p.c.clear();
    expect(p.draft()).toBe(EMPTY_DRAFT);
    expect(p.comp.accepted).not.toBeNull();
    expect(p.settle()).toBe('none');
    expect(p.comp.accepted).toBeNull();
    // Clear waits for the session creation on the wire (or its deadline) before revoking; the late failure restores nothing.
    p.q.create[0]!.reject(new ApiError(0, 'network', null));
    await flush();
    p.q.clear[0]!.resolve({ ...snap({ session: null }), mode: 'synthetic' });
    await clearing;
    await flush();
    expect(p.settle()).toBe('none');
    expect(isEmptyDraft(p.draft())).toBe(true);
    expect(p.log.filter((l) => l === 'reference')).toHaveLength(0);
  });

  it('another tab\'s Clear (marker, even before its event) drops the copy and blocks any restore', async () => {
    const cell = createIntentCell();
    cell.deliver = 'manual';
    const p = page(cell);
    p.type(typedA);
    p.analyse();
    void p.c.stop();
    // Another renderer has just written a pending Clear; no event has been delivered yet.
    cell.entries.set(`${CLEAR_INTENT_PREFIX}00000000000000bb`, 'v1');
    // Reading storage enters the barrier (a wipe epoch), which already removed the copy: nothing to restore.
    expect(p.settle()).toBe('none');
    expect(isEmptyDraft(p.draft())).toBe(true);
    expect(p.c.getView().recovery).toBe('clear_pending');
    expect(currentComposer(p.comp, p.c.getView().wipe).accepted).toBeNull();
  });

  it('a reload (a new page over the same storage) has no copy at all: nothing is persisted', async () => {
    const cell = createIntentCell();
    const first = page(cell);
    first.type(typedA);
    first.analyse();
    expect([...cell.entries.keys()]).toEqual([]);
    const reload = page(cell);
    expect(reload.comp.accepted).toBeNull();
    expect(isEmptyDraft(reload.draft())).toBe(true);
    expect(reload.log).toEqual([]);
  });

  it('expiry or a different session during the send drops the copy', async () => {
    const p = page();
    p.type(typedA);
    p.analyse();
    p.q.create[0]!.resolve(snap());
    await flush();
    p.q.reference[0]!.d.reject(new ApiError(401, 'session_expired', null));
    await flush();
    // The authoritative error wipes the accepted copy before any reconciliation read returns.
    expect(p.c.getView().redacted).toBe(true);
    expect(p.settle()).toBe('none');
    expect(p.comp.accepted).toBeNull();
    expect(isEmptyDraft(p.draft())).toBe(true);
    // The controller reads the owned state after an expiry; the expired snapshot has no session.
    p.q.state[0]!.resolve(snap({ session: null, code: 'session_expired' }));
    await flush();
    expect(p.settle()).toBe('none');
    expect(isEmptyDraft(p.draft())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Composer height on reset (M03.growth, 160 ms, measured, interruptible)

describe('the accepted reset settles over the existing measured height path', () => {
  function height() {
    const frames = new FakeFrames();
    const applied: number[] = [];
    const s = { reduced: false, moving: false };
    const h = new ComposerHeight({ frames, apply: (px) => applied.push(px), reducedMotion: () => s.reduced, viewportMoving: () => s.moving });
    return { frames, applied, s, h };
  }

  it('shrinks from six lines to one over 160 ms, and typing during it retargets from the current height', () => {
    const t = height();
    t.h.request(144, { composing: false });
    expect(t.h.visual).toBe(144);
    t.h.request(24, { composing: false });
    t.frames.step(COMPOSER_HEIGHT_MS - 1);
    expect(t.h.visual).toBeGreaterThan(24);
    t.frames.step(1);
    expect(t.h.visual).toBe(24);

    t.h.request(144, { composing: false });
    t.h.request(24, { composing: false });
    t.frames.step(50);
    const mid = t.h.visual!;
    // The listener types a new draft while it is shrinking: the path continues from where it is, not from the old minimum or maximum.
    t.h.request(72, { composing: false });
    expect(t.h.visual).toBe(mid);
    t.frames.step(COMPOSER_HEIGHT_MS);
    expect(t.h.visual).toBe(72);
  });

  it('reduced motion and IME composition apply the reset height at once; rapid requests finish on the last one', () => {
    const reduced = height();
    reduced.s.reduced = true;
    reduced.h.request(144, { composing: false });
    reduced.h.request(24, { composing: false });
    expect(reduced.h.visual).toBe(24);
    expect(reduced.frames.queue.size).toBe(0);

    const rapid = height();
    rapid.h.request(144, { composing: false });
    for (const px of [24, 96, 24, 120, 24]) {
      rapid.h.request(px, { composing: false });
      rapid.frames.step(10);
    }
    rapid.frames.step(COMPOSER_HEIGHT_MS * 2);
    expect(rapid.h.visual).toBe(24);
    expect(rapid.h.animating).toBe(false);
  });
});
