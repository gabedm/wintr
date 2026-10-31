import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DECOR, Fade, IntroSequence, introDecision, PendingLoop, STATIC_DOTS, visualCapture, type DecorEnv, type HostFacts, type IntroProgress, type VisualCapture } from './decor.js';
import { STANDARD_EASING } from './motion.js';
import { browserFrames, prefersReducedMotion } from './viewport-hooks.js';

// Browser bindings and components for the first conversation motion group
// (M01.intro, M03.send welcome/message, M04.pending, M04.result).
// Every component receives its meaning (wanted, active, revoked, play) from the
// caller's current state and only draws it: nothing here sends, stops, clears,
// expires, validates or delays content, and an exiting picture never holds
// private data or an interactive control.

export const pageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export const ENV: DecorEnv = { frames: browserFrames, reducedMotion: prefersReducedMotion, hidden: pageHidden };

/** Subscribes to page visibility and live reduced-motion changes for the lifetime of the caller. */
export function useEnvEvents(onHidden: (hidden: boolean) => void, onReduced: () => void) {
  const latest = useRef({ onHidden, onReduced });
  latest.current = { onHidden, onReduced };
  useEffect(() => {
    const onVisibility = () => latest.current.onHidden(document.visibilityState === 'hidden');
    const mql = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const onReducedChange = () => latest.current.onReduced();
    document.addEventListener('visibilitychange', onVisibility);
    mql?.addEventListener('change', onReducedChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      mql?.removeEventListener('change', onReducedChange);
    };
  }, []);
}

/** Writes a fade progress: at rest the element carries no inline decoration at all. */
function paint(el: HTMLElement, p: number) {
  if (p >= 1) {
    el.removeAttribute('data-playing');
    el.style.removeProperty('--p');
  } else {
    el.setAttribute('data-playing', '');
    el.style.setProperty('--p', String(p));
  }
}

export interface FadeHookOptions {
  readonly wanted: boolean;
  readonly enterMs: number;
  readonly exitMs: number;
  /** Only read for the very first appearance: false starts at rest. */
  readonly animateIn: boolean;
  /** Authority gone (Clear, expiry, redaction): removed in this very render, with no exit picture. */
  readonly revoked?: boolean;
  readonly onGone?: () => void;
  /** Easing of the enter motion (default: the locked enter token). */
  readonly enterEasing?: (t: number) => number;
  /** Easing of the exit motion (default: the locked exit token). */
  readonly exitEasing?: (t: number) => number;
}

/**
 * Presence with a retargetable enter/exit progress written to `--p` on the
 * element. `present` is what to render: wanted, or still visibly exiting.
 * Whether something is wanted is decided by the caller immediately; this only
 * decides how long its picture lingers.
 */
export function useFade(o: FadeHookOptions) {
  const [present, setPresent] = useState(o.wanted);
  if (o.wanted && !present) setPresent(true);
  const el = useRef<HTMLElement | null>(null);
  const gone = useRef(o.onGone);
  gone.current = o.onGone;
  const ref = useRef<Fade | null>(null);
  if (ref.current === null) {
    ref.current = new Fade({
      ...ENV,
      enterMs: o.enterMs,
      exitMs: o.exitMs,
      enterEasing: o.enterEasing,
      exitEasing: o.exitEasing,
      write: (p) => {
        if (el.current) paint(el.current, p);
      },
      onGone: () => {
        setPresent(false);
        gone.current?.();
      },
    });
  }
  const fade = ref.current;
  const attach = useCallback(
    (node: HTMLElement | null) => {
      el.current = node;
      if (node) paint(node, fade.value ?? 1);
    },
    [fade],
  );

  const started = useRef(false);
  useLayoutEffect(() => {
    if (o.wanted && !o.revoked) {
      if (!started.current || fade.value === null) {
        started.current = true;
        fade.begin(o.animateIn);
      } else fade.show();
    } else if (started.current) {
      if (o.revoked) fade.hardHide();
      else fade.hide();
    }
    // `animateIn`, the timings and the callbacks are read only at the moment of the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.wanted, o.revoked, fade]);

  useEnvEvents(
    (hidden) => hidden && fade.finish(),
    () => ENV.reducedMotion() && fade.finish(),
  );
  useEffect(() => () => fade.dispose(), [fade]);

  return { present: present && !o.revoked, exiting: present && !o.wanted, attach, el, fade };
}

/**
 * A wrapper that appears once when it is mounted: `play` is read at mount only,
 * so a restored, returned or already-seen unit mounts at rest and later changes
 * to its content (feedback, progress) can never replay the entrance. It wraps the
 * complete unit as it is; nothing inside is split, delayed or reordered.
 */
export function Appear({
  play,
  enterMs,
  y,
  className,
  easing,
  children,
}: {
  play: boolean;
  enterMs: number;
  y: number;
  className?: string;
  easing?: (t: number) => number;
  children: ReactNode;
}) {
  const { attach } = useFade({ wanted: true, enterMs, exitMs: 0, animateIn: play, enterEasing: easing });
  return (
    <div ref={attach} className={className ? `appear ${className}` : 'appear'} data-appear data-appear-y={y} style={{ '--fade-y': `${y}px` } as CSSProperties}>
      {children}
    </div>
  );
}

/** The part of a fresh wrapper's translation still in effect (layout reads must not see the decoration). */
export function appearOffset(el: Element): number {
  const wrapper = el.closest<HTMLElement>('[data-appear]');
  if (!wrapper || !wrapper.hasAttribute('data-playing')) return 0;
  const p = Number.parseFloat(wrapper.style.getPropertyValue('--p'));
  const y = Number(wrapper.dataset.appearY);
  return Number.isFinite(p) && Number.isFinite(y) ? (1 - p) * y : 0;
}

// ---------------------------------------------------------------------------
// M01.intro

/**
 * The entry shows the emblem alone. Its 280 ms
 * entrance and five 240 ms / 40 ms staggered bands remain purely decorative;
 * factual analysis fill is a separate layer. Input is never delayed by boot.
 */
export function IntroCard({ attach, ghost = false, onReveal, children }: { attach?: (el: HTMLElement | null) => void; ghost?: boolean; onStart?: () => void; onReveal?: () => void; children?: ReactNode }) {
  return (
    <section ref={attach} className="intro" aria-label={ghost ? undefined : 'Wintr'} onFocusCapture={onReveal}>
      <div className="intro-emblem">{children}</div>
    </section>
  );
}

function paintIntro(el: HTMLElement, p: IntroProgress) {
  const set = (name: string, v: number) => (v >= 1 ? el.style.removeProperty(name) : el.style.setProperty(name, String(v)));
  set('--intro-card', p.card);
  p.motifs.forEach((v, i) => set(`--motif-${i}`, v));
}

export interface IntroOptions {
  /** The first state of this page is known (restored, empty, failed or behind a recovery barrier). */
  readonly resolved: boolean;
  /** The welcome is what the conversation would show (no reference yet). */
  readonly empty: boolean;
  /** The listener typed: decoration ends at once. */
  readonly interrupted: boolean;
  /** Any local wipe (Clear, another tab's Clear): the welcome is never replayed. */
  readonly wipe: number;
}

/**
 * The welcome plays once, only for the first empty view of this page after its
 * state is known. A restored session, an answer, a return, a Clear or a reload
 * with content never replays it; typing, the first send, a wipe, reduced motion
 * and a hidden page finish it at once. It never blocks the composer.
 */
export function useIntro(o: IntroOptions) {
  const el = useRef<HTMLElement | null>(null);
  const seq = useRef<IntroSequence | null>(null);
  if (seq.current === null) {
    seq.current = new IntroSequence(ENV, (p) => {
      if (el.current) paintIntro(el.current, p);
    });
  }
  const intro = seq.current;
  const attach = useCallback((node: HTMLElement | null) => {
    el.current = node;
    if (node && intro.phase === 'done') paintIntro(node, { card: 1, motifs: Array.from({ length: DECOR.intro.motifs }, () => 1) });
  }, [intro]);

  useLayoutEffect(() => {
    const decision = introDecision({ phase: intro.phase, ...o });
    if (decision === 'none') return;
    if (decision === 'finish') return intro.finish();
    if (decision === 'hold') return intro.hold();
    // Layout and fonts first (a real event, never a timer); the composer stays usable throughout.
    let cancelled = false;
    const go = () => {
      if (!cancelled) intro.start();
    };
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts?.ready) void fonts.ready.then(go, go);
    else go();
    return () => {
      cancelled = true;
    };
  }, [intro, o.resolved, o.empty, o.interrupted, o.wipe]);

  useEnvEvents(
    (hidden) => hidden && intro.finish(),
    () => ENV.reducedMotion() && intro.finish(),
  );
  // End queued work on unmount; effect replay leaves the welcome visible at rest.
  useEffect(() => () => intro.finish(), [intro]);
  const reveal = useCallback(() => intro.finish(), [intro]);
  return { attach, element: () => el.current, reveal };
}

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

/** Position of an element inside its offset parent: layout only, unaffected by any transform. */
export const layoutRect = (el: HTMLElement): Rect => ({ top: el.offsetTop, left: el.offsetLeft, width: el.offsetWidth, height: el.offsetHeight });

/**
 * M03.send: the welcome leaves normal layout in the same render the send commits;
 * this noninteractive aria-hidden copy keeps its previous rectangle for the 120 ms
 * opacity exit, then unmounts. Reduced motion never mounts it.
 */
export function WelcomeGhost({ rect, onGone, children }: { rect: Rect; onGone: () => void; children?: ReactNode }) {
  const { attach, fade } = useFade({ wanted: true, enterMs: 0, exitMs: DECOR.welcome.exitMs, animateIn: false, onGone });
  useLayoutEffect(() => {
    fade.hide();
  }, [fade]);
  return (
    <div ref={attach} className="welcome-ghost" aria-hidden="true" inert style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}>
      <IntroCard ghost>{children}</IntroCard>
    </div>
  );
}

/**
 * The element's presentation right now, in the coordinate system of its `.conversation` host (where an absolutely placed
 * outgoing picture lives): rendered rectangle (transforms of any entrance wrapper included) and the combined opacity of
 * every entrance still in progress around it. Null when there is no host to place a picture in.
 */
export function captureVisual(el: HTMLElement): VisualCapture | null {
  const host = el.closest<HTMLElement>('.conversation');
  if (!host) return null;
  const playing: number[] = [];
  for (let n = el.closest<HTMLElement>('[data-appear][data-playing]'); n && host.contains(n) && n !== host; n = n.parentElement?.closest<HTMLElement>('[data-appear][data-playing]') ?? null) {
    playing.push(Number.parseFloat(n.style.getPropertyValue('--p')));
  }
  const facts: HostFacts = { box: host.getBoundingClientRect(), clientTop: host.clientTop, clientLeft: host.clientLeft, scrollTop: host.scrollTop, scrollLeft: host.scrollLeft };
  return visualCapture(el.getBoundingClientRect(), facts, playing);
}

/**
 * M07.selection token_exit: a still, noninteractive, aria-hidden picture of a removed token at its previous rectangle,
 * fading over `ms` and then gone. It carries only the text it is given and takes no part in layout, focus or the pointer.
 */
export function OutgoingPicture({ rect, from = 1, ms, onGone, children }: { rect: Rect; from?: number; ms: number; onGone: () => void; children: ReactNode }) {
  // Never "wanted": this picture only leaves. Its captured starting value is adopted once; an effect replay (StrictMode,
  // Fast Refresh) must neither re-seed it nor run a zero-duration show that would overwrite it, so the replay only
  // retargets the exit from wherever the value is.
  const { attach, fade } = useFade({ wanted: false, enterMs: 0, exitMs: ms, animateIn: false, exitEasing: STANDARD_EASING, onGone });
  useLayoutEffect(() => {
    if (fade.value === null) fade.begin(false, from);
    fade.hide();
    // `from` is the presentation at the gesture, read only for the first appearance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fade]);
  return (
    <div ref={attach} className="welcome-ghost token-ghost" aria-hidden="true" inert style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// M04.pending

interface Layer {
  readonly id: number;
  readonly text: string;
  readonly leaving: boolean;
}

/** One label layer. A new stage fades in over 120 ms while the previous one fades out; both start from their current values. */
function StageLayer({ layer, first, onGone }: { layer: Layer; first: boolean; onGone: (id: number) => void }) {
  const { present, attach } = useFade({
    wanted: !layer.leaving,
    enterMs: DECOR.pending.crossfadeMs,
    exitMs: DECOR.pending.crossfadeMs,
    animateIn: !first,
    onGone: () => onGone(layer.id),
  });
  if (!present) return null;
  return (
    <span ref={attach} className="stage-layer" aria-hidden="true">
      {layer.text}
    </span>
  );
}

/**
 * The truthful status row. `label` is the actual stage the caller derived from the
 * controller and the snapshot; it is shown as given, with no percentage, count or
 * scripted steps. The dots run only while `active` (and the page is visible and
 * motion is allowed); every other state shows static dots. A change of label
 * crossfades in 120 ms and is announced once, politely; dots are never announced.
 * `revoked` removes the row in the same render with no exit picture.
 */
export function PendingStatus({ label, wanted, active, revoked }: { label: string; wanted: boolean; active: boolean; revoked: boolean }) {
  const { present, exiting, attach, el } = useFade({ wanted, enterMs: DECOR.pending.enterMs, exitMs: DECOR.pending.exitMs, animateIn: true, revoked });

  // The exit shows the last true label, whatever the snapshot says by then.
  const last = useRef(label);
  if (wanted) last.current = label;

  // The row (and with it every label layer and the dots) exists only while present, so a later operation starts clean.
  if (!present) return null;
  return <PendingRow text={wanted ? label : last.current} announce={wanted} active={active} exiting={exiting} attach={attach} el={el} />;
}

function PendingRow({
  text,
  announce,
  active,
  exiting,
  attach,
  el,
}: {
  text: string;
  announce: boolean;
  active: boolean;
  exiting: boolean;
  attach: (node: HTMLElement | null) => void;
  el: { current: HTMLElement | null };
}) {
  const [layers, setLayers] = useState<readonly Layer[]>(() => [{ id: 0, text, leaving: false }]);
  const live = layers.find((l) => !l.leaving);
  if (!exiting && live && live.text !== text) {
    setLayers((ls) => [...ls.map((l) => ({ ...l, leaving: true })), { id: Math.max(0, ...ls.map((l) => l.id)) + 1, text, leaving: false }]);
  }
  const dropLayer = useCallback((id: number) => setLayers((ls) => ls.filter((l) => l.id !== id)), []);

  const loop = useRef<PendingLoop | null>(null);
  if (loop.current === null) {
    loop.current = new PendingLoop(ENV, (ops) => {
      const node = el.current;
      if (node) ops.forEach((v, i) => node.style.setProperty(`--dot-${i}`, String(v)));
    });
  }
  const dots = loop.current;
  useEffect(() => {
    if (active) {
      dots.visibilityChanged(document.visibilityState === 'hidden');
      dots.start();
    } else dots.stop();
    return () => dots.stop();
  }, [dots, active]);
  useEnvEvents(
    (hidden) => dots.visibilityChanged(hidden),
    () => dots.reducedMotionChanged(),
  );

  return (
    <div
      ref={attach}
      className="assistant status pending"
      data-exiting={exiting || undefined}
      aria-hidden={exiting || undefined}
      style={{ ...Object.fromEntries(STATIC_DOTS.map((v, i) => [`--dot-${i}`, v])), '--fade-y': '0px' } as CSSProperties}
    >
      <span className="dots" aria-hidden="true">
        <i className="dot" />
        <i className="dot" />
        <i className="dot" />
      </span>
      <span className="stage">
        {layers.map((l) => (
          <StageLayer key={l.id} layer={l} first={l.id === 0} onGone={dropLayer} />
        ))}
      </span>
      <span className="visually-hidden" role="status">
        {announce ? text : ''}
      </span>
    </div>
  );
}
