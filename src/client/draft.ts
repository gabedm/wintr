import { formatClock } from '../shared/youtube.js';

// The composer's in-memory state: the unsaved draft, the compact source
// disclosure, and the one bounded retry copy of the last ACCEPTED send.
//
// Contract (M03.send composer reset, PRODUCT_FLOW typing/retry):
// - Typing is a local draft only. An accepted Analyse moves exactly that draft
//   out of the composer into the retry copy (the height then settles over the
//   existing measured 160 ms path); a refused or no-op Analyse changes nothing.
// - Nothing else ever clears or rewrites the draft: a result, a failure, a stop
//   or a finishing decoration may only PUT BACK the retry copy, and only if the
//   composer is still completely empty and the same wipe epoch, session and
//   owner still apply. A new draft always survives.
// - Everything here belongs to one wipe epoch: any local wipe (Clear here, a
//   Clear intent from another tab, an earlier load) makes the draft, the retry
//   copy and the disclosure state vanish in the same render.
// - Memory only: nothing is written to any storage. These functions are pure;
//   no decision here sends, retries or waits.

export interface Draft {
  url: string;
  start: string;
  end: string;
  cue: string;
  focusEdited: boolean;
}

export const EMPTY_DRAFT: Draft = { url: '', start: '', end: '', cue: '', focusEdited: false };

export const isEmptyDraft = (d: Draft): boolean => d.url === '' && d.start === '' && d.end === '' && d.cue === '';

/** The owned or accepted reference identity a retry copy is compared with. */
export interface SourceRef {
  readonly canonicalUrl: string;
  readonly focus: { readonly start: number; readonly end: number };
}

/**
 * The note exactly as the request normalises it (the page and the server both trim; blank means none), so a typed
 * note and an owned note compare by what was actually submitted, never by raw typing.
 */
export const normalizeNote = (raw: string | null | undefined): string | null => {
  const t = (raw ?? '').trim();
  return t === '' ? null : t;
};

/** The server-owned reference with its note (listenerCue), the full intent a send is compared with. */
export interface OwnedRef extends SourceRef {
  readonly cue: string | null;
}

/** Source, focus AND normalised note: a note-only correction is a different intent. */
const sameIntent = (owned: OwnedRef, sent: { ref: SourceRef; note: string | null }) =>
  owned.canonicalUrl === sent.ref.canonicalUrl &&
  owned.focus.start === sent.ref.focus.start &&
  owned.focus.end === sent.ref.focus.end &&
  normalizeNote(owned.cue) === sent.note;

/** What the page tells the listener about where their link is after a send that did not stay. */
export type SendNote = 'restored' | 'kept_new' | null;

export interface AcceptedSend {
  /** The exact draft that was sent (the only copy; at most one is ever held). */
  readonly draft: Draft;
  readonly ref: SourceRef;
  /** The normalised note actually submitted with it (null when blank), taken from the draft itself. */
  readonly note: string | null;
  /** The session context at send time; null when the send had to create the session. */
  readonly context: string | null;
}

export interface ComposerState {
  readonly wipe: number;
  readonly draft: Draft;
  /** The compact source/focus/note disclosure is open (controlled, so a send can collapse it). */
  readonly sourceOpen: boolean;
  readonly accepted: AcceptedSend | null;
  readonly note: SendNote;
}

export const initialComposer = (wipe: number): ComposerState => ({ wipe, draft: EMPTY_DRAFT, sourceOpen: false, accepted: null, note: null });

/** The state as it applies now: anything from an earlier wipe epoch is gone. */
export const currentComposer = (s: ComposerState, wipe: number): ComposerState => (s.wipe === wipe ? s : initialComposer(wipe));

export const visibleDraft = (s: ComposerState, wipe: number): Draft => currentComposer(s, wipe).draft;

/** An edit made now (a value, or a function of what is currently visible). */
export function editDraft(s: ComposerState, wipe: number, next: Draft | ((d: Draft) => Draft)): ComposerState {
  const c = currentComposer(s, wipe);
  return { ...c, draft: typeof next === 'function' ? next(c.draft) : next, note: null };
}

export function setSourceOpen(s: ComposerState, wipe: number, open: boolean): ComposerState {
  const c = currentComposer(s, wipe);
  return c.sourceOpen === open ? c : { ...c, sourceOpen: open };
}

/**
 * The Analyse was ACCEPTED: the draft leaves the composer (reset) and a single
 * retry copy is kept, tied to this wipe epoch and session. The disclosure collapses.
 */
export function acceptSend(s: ComposerState, wipe: number, sent: { ref: SourceRef; context: string | null }): ComposerState {
  const c = currentComposer(s, wipe);
  return { wipe, draft: EMPTY_DRAFT, sourceOpen: false, accepted: { draft: c.draft, ref: sent.ref, note: normalizeNote(c.draft.cue), context: sent.context }, note: null };
}

export interface SettleFacts {
  /** An operation is pending, stopping or active on the server: nothing is decided yet. */
  readonly working: boolean;
  /** Clear running, content redacted, recovery barrier or an unconfirmed Clear anywhere. */
  readonly blocked: boolean;
  /** The session ended (expiry/revocation). */
  readonly expired: boolean;
  /** The current owned session context, if any. */
  readonly context: string | null;
  /** The reference (with its note) the server owns now, if any. */
  readonly owned: OwnedRef | null;
}

export type SettleResult = 'waiting' | 'none' | 'owned' | 'restored' | 'kept_new' | 'dropped';

/**
 * Once work has ended, decide what the retry copy becomes:
 * - the server owns this very intent (same source, focus AND normalised note): it is kept there
 *   (Edit source); the copy is dropped;
 * - nothing, a different source, or the same source with a different note is owned (a note-only correction
 *   that was not admitted) and the composer is empty: the exact typed copy goes back, once;
 * - the listener has started something new: the copy is dropped and never overwrites it;
 * - a wipe, barrier, expiry or a different session: the copy is dropped, never revived.
 */
export function settleSend(s: ComposerState, wipe: number, f: SettleFacts): { state: ComposerState; result: SettleResult } {
  const c = currentComposer(s, wipe);
  const a = c.accepted;
  if (!a) return { state: c, result: 'none' };
  if (f.working) return { state: c, result: 'waiting' };
  const drop = (result: SettleResult, note: SendNote = null) => ({ state: { ...c, accepted: null, note: note ?? c.note }, result });
  if (f.blocked || f.expired) return drop('dropped');
  if (a.context !== null && f.context !== a.context) return drop('dropped');
  if (f.owned && sameIntent(f.owned, a)) return drop('owned');
  if (!isEmptyDraft(c.draft)) return drop('kept_new', 'kept_new');
  return { state: { ...c, draft: a.draft, accepted: null, note: 'restored' }, result: 'restored' };
}

/** The owned source, as the explicit Edit source action reads it. */
export type OwnedSource = OwnedRef;

/**
 * Edit source: loads the owned source, focus and note into the composer for deliberate
 * correction. Only into an EMPTY composer (a new draft is never overwritten); it
 * dispatches nothing, and only an explicit Analyse sends it.
 */
export function loadSource(s: ComposerState, wipe: number, owned: OwnedSource): { state: ComposerState; loaded: boolean } {
  const c = currentComposer(s, wipe);
  if (!isEmptyDraft(c.draft)) return { state: c, loaded: false };
  const draft: Draft = { url: owned.canonicalUrl, start: formatClock(owned.focus.start), end: formatClock(owned.focus.end), cue: owned.cue ?? '', focusEdited: true };
  return { state: { wipe, draft, sourceOpen: true, accepted: null, note: null }, loaded: true };
}

/**
 * Honest wording about where the link is after a stop or a failure. It never says a
 * link is in the composer unless it was just put back there, and never promises an
 * edit that is not available.
 */
export function sourceNote(note: SendNote, ownedSource: boolean, composerEmpty: boolean): string {
  if (note === 'restored') return 'Your link, focus and note are back in the composer.';
  if (note === 'kept_new') return 'Your earlier link was not put back because you have started a new draft.';
  if (ownedSource && composerEmpty) return 'Use Edit source to bring your link, focus and note back into the composer.';
  if (ownedSource) return 'Your earlier source stays above; Edit source is available when the composer is empty.';
  return '';
}
