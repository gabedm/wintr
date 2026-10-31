import type { SafePanel, SafeSnapshot } from '../shared/records.js';

// One modal overlay at a time (the session menu drawer or the contextual Why
// sheet), and the privacy rule for the Why sheet: it stores only its kind and an
// opaque identity of the accepted state it was opened for, and every render
// resolves its content from the CURRENT accepted snapshot. A revoked, replaced
// or expired state therefore yields nothing, with no copied payload to leak,
// animate out or resurrect.

export type Overlay = { readonly kind: 'menu' } | { readonly kind: 'why'; readonly identity: string }
  | { readonly kind: 'input'; readonly context: string | null; readonly wipe: number };

export interface AuthorityContext {
  readonly snapshot: SafeSnapshot | null;
  readonly clearing: boolean;
  readonly redacted: boolean;
  /** Present for the input chooser; existing Why-only callers do not need a local wipe. */
  readonly wipe?: number;
  readonly recovery?: boolean;
}

/**
 * Opaque identity of the connection a Why sheet was opened for: the session
 * context, the brief it serves and the opaque handles of the connected artists.
 * It carries no names or provider data. A new session, a changed brief or a
 * different connection (new pool) yields a different identity.
 */
export function whyIdentity(snapshot: SafeSnapshot | null): string | null {
  if (!snapshot?.session || !snapshot.brief || !snapshot.connection) return null;
  return `${snapshot.session.context}|${snapshot.brief.handle}|${snapshot.connection.anchors.map((a) => a.handle).join(',')}`;
}

/** What the Why sheet may show right now: only the current accepted connection of exactly that identity. */
export interface WhyView {
  readonly connection: NonNullable<SafeSnapshot['connection']>;
  /** Current recording outcome for honest evidence wording; null while no recording check has produced a panel. */
  readonly recordings: { readonly outcome: SafePanel['outcome']; readonly count: number; readonly refined: boolean; readonly synthetic: boolean } | null;
}

export function resolveWhy(identity: string | null, ctx: AuthorityContext): WhyView | null {
  const { snapshot } = ctx;
  if (identity === null || ctx.clearing || ctx.redacted || !snapshot?.connection) return null;
  if (whyIdentity(snapshot) !== identity) return null;
  const panel = snapshot.panel;
  return {
    connection: snapshot.connection,
    recordings: panel ? { outcome: panel.outcome, count: panel.choices.length, refined: panel.role === 'refinement', synthetic: panel.synthetic } : null,
  };
}

export interface OverlayWants {
  readonly menu: boolean;
  readonly why: boolean;
  /** The voice-input chooser: it holds no private content, but Clear and redaction still remove it at once. */
  readonly input: boolean;
}

/**
 * Which overlays are wanted right now. The state holds a single overlay, so
 * the menu and Why can never both be wanted (two traps and two scroll locks
 * never overlap); the Why sheet is wanted only while its content still
 * resolves.
 */
export function overlayWants(overlay: Overlay | null, ctx: AuthorityContext): OverlayWants {
  return {
    menu: overlay?.kind === 'menu',
    why: overlay?.kind === 'why' && resolveWhy(overlay.identity, ctx) !== null,
    input: overlay?.kind === 'input' && !ctx.clearing && !ctx.redacted && !ctx.recovery
      && overlay.wipe === (ctx.wipe ?? 0)
      && overlay.context === (ctx.snapshot?.session?.context ?? null),
  };
}

/**
 * The host keeps only the opaque identity it was last opened for, so an exiting
 * picture can still resolve the CURRENT state of that exact connection. It
 * never keeps content.
 */
export const holdIdentity = (held: string | null, open: boolean, identity: string | null): string | null => (open && identity !== null ? identity : held);

/** Opening an overlay replaces any other one; there is no stack. */
export const openOverlay = (_current: Overlay | null, next: Overlay): Overlay => next;

/**
 * The server's connection lines end with a fixed status line ("No recording has
 * been checked yet."). That line describes the moment the connection was built,
 * not the current outcome, so the sheet drops it and states the current recording
 * outcome itself.
 */
export const STALE_STATUS_LINE = 'No recording has been checked yet.';
export const whyLines = (lines: readonly string[]): string[] => lines.filter((l) => l !== STALE_STATUS_LINE);

/** Truthful, current statement of what the recording evidence is and is not. */
export function recordingEvidence(r: WhyView['recordings']): string {
  if (r === null) return 'No recording has been checked yet.';
  if (r.outcome === 'source_unavailable') return 'A recording search ran, but its result is hidden because its required Google Search information can no longer be shown safely.';
  if (r.synthetic) {
    if (r.outcome === 'no_match' || r.count === 0) return 'The local synthetic fixture produced no placeholder recordings. No real search or check was made.';
    const what = r.count === 1 ? 'One placeholder recording was' : `${r.count} placeholder recordings were`;
    return `${what} generated by the local synthetic fixture${r.refined ? ' for the refined search' : ''}. Nothing was found in a real search, confirmed against a real source or listened to, and none of it is a real recording.`;
  }
  if (r.outcome === 'no_match' || r.count === 0) return 'No recording could be confirmed within these artist connections. This is not a sign that none exist.';
  const what = r.count === 1 ? 'One recording was' : `${r.count} recordings were`;
  return `${what} confirmed from its title, credited artists and a listening link${r.refined ? ' in the refined search' : ''}. Wintr has not listened to ${r.count === 1 ? 'it' : 'them'}, so how a recording sounds is only a possibility.`;
}

/** Stable id of the in-conversation trigger the Why sheet returns focus to. */
export const WHY_TRIGGER_ID = 'why-trigger';

/** Stable id of the one microphone control the voice-input chooser returns focus to. */
export const MIC_TRIGGER_ID = 'mic-trigger';
