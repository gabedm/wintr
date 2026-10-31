import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { tabWrapTarget } from './focus.js';
import { holdIdentity, recordingEvidence, WHY_TRIGGER_ID, whyLines, type WhyView } from './overlay.js';
import { useModalAuthority, useSheetDrag, useSheetPresence } from './overlay-hooks.js';

// The contextual Why sheet (motion M06.sheet): a bottom-origin dialog that shows
// why a connection was made, from the CURRENT accepted snapshot only. It keeps
// no copy of the connection: the host resolves it on every render, so a cleared,
// expired, replaced or redacted state removes it at once, exiting picture included.
// Native answer, citations and Search Suggestions are not part of this sheet.
//
// Essential controls never scroll away: Close lives in the persistent header and
// Stop/Clear (while work is pending) in a persistent footer; only the middle scrolls.

export interface WhyActions {
  readonly working: boolean;
  readonly stopping: boolean;
  readonly notice?: string | null;
  readonly onClose: () => void;
  readonly onStop: () => void;
  readonly onClear: () => void;
}

/** Scrollable content for one resolved view; every line is an owned fact or a plain statement of what it is not. */
export function WhyContent({ view }: { view: WhyView }) {
  const { connection, recordings } = view;
  const source = connection.synthetic ? 'The synthetic local fixture (not Qloo)' : 'Qloo';
  return (
    <>
      {connection.synthetic && <p className="synthetic-label">Synthetic connection from a local fixture, not from Qloo</p>}
      <ul className="why-lines" aria-label="How this connection was made">
        {whyLines(connection.why).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <section className="why-section" aria-labelledby="why-artists">
        <h3 id="why-artists" className="why-heading">
          Connected artists
        </h3>
        <ul>
          {connection.artists.map((name, i) => (
            <li key={i}>{name}</li>
          ))}
        </ul>
        {connection.capability === 'artists_only' && <p className="support">Tag associations were not available, so only artist connections are used.</p>}
      </section>
      <section className="why-section" aria-labelledby="why-evidence">
        <h3 id="why-evidence" className="why-heading">
          Sources
        </h3>
        <p>Artist connections come from {source}.</p>
        <p>{recordingEvidence(recordings)}</p>
        {recordings !== null && !recordings.synthetic && recordings.outcome === 'choices' && recordings.count > 0 && (
          <p className="support">Fit notes are predictions based on your chosen direction.</p>
        )}
      </section>
    </>
  );
}

/** Persistent footer: Stop and Clear stay visibly reachable while work is pending; nothing otherwise. */
export function WhyFooter({ working, stopping, onStop, onClear }: Pick<WhyActions, 'working' | 'stopping' | 'onStop' | 'onClear'>) {
  if (!working) return null;
  return (
    <div className="sheet-foot action-row">
      <button type="button" className="secondary" onClick={(event) => {
        event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
        onStop();
      }} disabled={stopping}>
        Stop
      </button>
      <button type="button" className="secondary" onClick={onClear}>
        Clear session
      </button>
    </div>
  );
}

export interface SheetLayerProps {
  attach?: (el: HTMLElement | null) => void;
  exiting: boolean;
  title: string;
  /** Dialog title id and scrolling-region name; the defaults are the Why sheet's. */
  titleId?: string;
  bodyLabel?: string;
  onClose: () => void;
  /** Handle-only drag handlers (never on content). */
  handle?: Record<string, unknown>;
  panelRef?: RefObject<HTMLDivElement | null>;
  titleRef?: RefObject<HTMLHeadingElement | null>;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  /** Persistent region below the scrolling content. */
  footer?: ReactNode;
  /** Current controller notice must remain within the active modal's accessible tree. */
  notice?: string | null;
  children: ReactNode;
}

/**
 * The sheet picture: scrim plus bottom-origin panel with a persistent header
 * (handle, title, Close), an independently scrolling body and an optional
 * persistent footer. While `exiting` it ignores the pointer and the panel is
 * inert and hidden from assistive technology.
 */
export function SheetLayer(p: SheetLayerProps) {
  const titleId = p.titleId ?? 'sheet-why-title';
  return (
    <div className="sheet-layer" ref={p.attach} data-exiting={p.exiting || undefined}>
      <div className="sheet-scrim" onClick={p.onClose} aria-hidden="true" />
      <div
        ref={p.panelRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        inert={p.exiting}
        aria-hidden={p.exiting || undefined}
        onKeyDown={p.onKeyDown}
      >
        <div className="sheet-handle" aria-hidden="true" {...p.handle}>
          <span className="sheet-grip" />
        </div>
        <div className="sheet-head">
          <h2 id={titleId} ref={p.titleRef} tabIndex={-1} className="sheet-title">
            {p.title}
          </h2>
          <button type="button" className="secondary sheet-close" onClick={p.onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body" tabIndex={0} role="region" aria-label={p.bodyLabel ?? 'Connection details'}>
          {p.notice && <p className="support" role="alert">{p.notice}</p>}
          {p.children}
        </div>
        {p.footer}
      </div>
    </div>
  );
}

/**
 * Host: `open` is the immediate authority (the overlay is wanted and its
 * content still resolves); `identity` is the opaque identity it was opened for.
 * Content comes from `resolve` on every render. If it stops resolving (Clear,
 * expiry, a replaced session, brief or connection, redaction) the picture is
 * removed in that same render and its motion is dropped, never animated out.
 */
export function WhySheet(p: { open: boolean; identity: string | null; resolve: (identity: string) => WhyView | null } & WhyActions) {
  const held = useRef<string | null>(null);
  held.current = holdIdentity(held.current, p.open, p.identity);
  const view = held.current === null ? null : p.resolve(held.current);

  const { mounted, exiting, attach, presence } = useSheetPresence(p.open && view !== null);
  useModalAuthority(p.open && view !== null, p.onClose, WHY_TRIGGER_ID);
  const panel = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const handle = useSheetDrag(presence, panel, p.onClose, mounted);

  const revoked = view === null;
  useLayoutEffect(() => {
    if (revoked) {
      presence.hardClose();
      held.current = null;
    }
  }, [revoked, presence]);
  useEffect(() => {
    if (!mounted && !p.open) held.current = null;
  }, [mounted, p.open]);

  // Meaningful initial focus: the title, announced with the dialog, without scrolling anything.
  useEffect(() => {
    if (mounted && !exiting) title.current?.focus({ preventScroll: true });
  }, [mounted, exiting]);

  // The title and the dialog itself are focusable but not tabbable, so Tab from them is wrapped explicitly.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')];
    const next = tabWrapTarget<Element | null>(items, document.activeElement, panel.current, e.shiftKey);
    if (next instanceof HTMLElement) {
      e.preventDefault();
      next.focus();
    }
  };

  if (!mounted || view === null) return null;
  return (
    <SheetLayer
      attach={attach}
      exiting={exiting}
      title="Why this connection"
      notice={p.notice}
      onClose={p.onClose}
      handle={handle}
      panelRef={panel}
      titleRef={title}
      onKeyDown={onKeyDown}
      footer={<WhyFooter working={p.working} stopping={p.stopping} onStop={p.onStop} onClear={p.onClear} />}
    >
      <WhyContent view={view} />
    </SheetLayer>
  );
}
