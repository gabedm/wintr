import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ComposerHeight, ComposerLayout } from './composer-height.js';
import { DockClearance } from './dock-clearance.js';
import type { Frames } from './motion.js';
import { DrawerPresence, type DrawerProgress } from './presence.js';
import { ReadingAnchor, type AnchorEnv } from './reading-anchor.js';
import { trackViewport, type ViewportEnv } from './viewport.js';
import { retainViewportFocus } from './viewport-focus.js';
import type { DockClearancePlan } from './dock-clearance.js';

// Browser bindings for the testable cores (motion.ts, viewport.ts,
// composer-height.ts, reading-anchor.ts). Only native events and animation
// frames are used: no timers, no guessed keyboard durations.

export const browserFrames: Frames = {
  now: () => performance.now(),
  raf: (cb) => requestAnimationFrame(() => cb()),
  caf: (id) => cancelAnimationFrame(id),
};

const REDUCED = '(prefers-reduced-motion: reduce)';
/** Read live, so a preference change mid-animation is honoured on the next request. */
export const prefersReducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia(REDUCED).matches;

function onReducedMotionChange(listener: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const mql = matchMedia(REDUCED);
  mql.addEventListener('change', listener);
  return () => mql.removeEventListener('change', listener);
}

/** Single bridge between the native viewport tracker and React consumers. */
export class ViewportHub {
  private readonly listeners = new Set<() => void>();
  private active: ReturnType<typeof trackViewport> | null = null;

  moving(): boolean {
    return this.active?.moving() ?? false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts native tracking; returns the cleanup that removes every listener. */
  start(): () => void {
    const root = document.documentElement;
    const env: ViewportEnv = {
      visualViewport: window.visualViewport,
      window,
      layoutHeight: () => root.clientHeight,
      layoutWidth: () => root.clientWidth,
      apply: (inset, open) => {
        root.style.setProperty('--kb-inset', `${inset}px`);
        root.toggleAttribute('data-keyboard', open);
      },
      frames: browserFrames,
    };
    const tracker = trackViewport(env);
    this.active = tracker;
    const off = tracker.subscribe(() => this.listeners.forEach((l) => l()));
    return () => {
      off();
      tracker.stop();
      if (this.active === tracker) this.active = null;
      root.style.removeProperty('--kb-inset');
      root.removeAttribute('data-keyboard');
    };
  }
}

function anchorEnv(): AnchorEnv {
  const scroller = () => document.scrollingElement ?? document.documentElement;
  return {
    ...browserFrames,
    scrollTop: () => scroller().scrollTop,
    setScrollTop: (y) => {
      scroller().scrollTop = y;
    },
    maxScrollTop: () => Math.max(0, scroller().scrollHeight - scroller().clientHeight),
    reducedMotion: prefersReducedMotion,
  };
}

const NAV_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown']);
const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'INPUT');

export interface ShellMotion {
  readonly anchor: ReadingAnchor;
  readonly viewport: ViewportHub;
  /** Key of a complete result the reader has not been taken to, or null. */
  readonly pending: string | null;
}

/** Viewport offset, reading anchor and their native listeners for the one scrolling layout. */
export function useShellMotion(): ShellMotion {
  const [pending, setPending] = useState<string | null>(null);
  const [viewport] = useState(() => new ViewportHub());
  const [anchor] = useState(() => new ReadingAnchor(anchorEnv(), setPending));

  useEffect(() => viewport.start(), [viewport]);

  useEffect(() => {
    const scroll = () => anchor.onScroll();
    const input = () => anchor.onUserInput();
    const key = (e: KeyboardEvent) => {
      // Tab changes focus even when the browser needs no scroll. It supersedes
      // following from every target; text-navigation keys keep their editing behavior.
      if (e.key === 'Tab' || (NAV_KEYS.has(e.key) && !isEditable(e.target))) anchor.onUserInput();
    };
    const move = viewport.subscribe(() => anchor.viewportMoved());
    const reduced = onReducedMotionChange(() => anchor.reducedMotionChanged());
    window.addEventListener('scroll', scroll, { passive: true });
    window.addEventListener('wheel', input, { passive: true });
    window.addEventListener('touchstart', input, { passive: true });
    window.addEventListener('pointerdown', input, { passive: true });
    window.addEventListener('keydown', key);
    anchor.measure();
    return () => {
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('wheel', input);
      window.removeEventListener('touchstart', input);
      window.removeEventListener('pointerdown', input);
      window.removeEventListener('keydown', key);
      move();
      reduced();
      anchor.dispose();
    };
  }, [anchor, viewport]);

  return { anchor, viewport, pending };
}

/** Native focus uses the real unobscured root scrollport, without changing the reading host. */
export function useDockClearance(context: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>, viewport: ViewportHub, anchor?: ReadingAnchor) {
  useLayoutEffect(() => {
    const content = context.current;
    const footer = dock.current;
    if (!content || !footer) return;
    const root = document.documentElement;
    const properties = ['scroll-padding-top', 'scroll-padding-bottom'] as const;
    const previous = properties.map((name) => ({ name, value: root.style.getPropertyValue(name), priority: root.style.getPropertyPriority(name) }));
    const flag = footer.getAttribute('data-flow');
    let visible: DockClearancePlan | null = null;
    const clearance = new DockClearance({
      frames: browserFrames,
      read: () => {
        if (!content.isConnected || !footer.isConnected) return null;
        const visual = window.visualViewport;
        const dockRect = footer.getBoundingClientRect();
        let controlHeight = 44;
        for (const el of content.querySelectorAll<HTMLElement>('input, button, textarea, select, summary, a[href]')) {
          controlHeight = Math.max(controlHeight, el.getBoundingClientRect().height);
        }
        return { layoutHeight: root.clientHeight, visual: visual ? { offsetTop: visual.offsetTop, height: visual.height } : null,
          dock: { top: dockRect.top, height: dockRect.height }, controlHeight };
      },
      apply: (plan) => {
        visible = plan;
        root.style.setProperty('scroll-padding-top', `${plan.top}px`);
        root.style.setProperty('scroll-padding-bottom', `${plan.bottom}px`);
        footer.toggleAttribute('data-flow', plan.flow);
      },
    });
    const changed = () => clearance.changed();
    const shell = footer.closest<HTMLElement>('.app');
    const focus = shell ? retainViewportFocus({ shell, dock: footer, frames: browserFrames,
      beforeReveal: () => anchor?.onUserInput(),
      scrollTop: () => (document.scrollingElement ?? root).scrollTop,
      bounds: () => visible && ({ top: visible.top, bottom: root.clientHeight - visible.bottom }) }) : null;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(changed) : null;
    observer?.observe(content); observer?.observe(footer);
    const off = viewport.subscribe(() => { changed(); focus?.changed(); });
    // Document scrolling does not change intrinsic clearance. Keep layout
    // measurement out of scroll loops; real visual-viewport movement is
    // delivered by the shared viewport tracker above.
    document.fonts?.addEventListener?.('loadingdone', changed);
    clearance.measure();
    return () => {
      focus?.dispose(); clearance.dispose(); observer?.disconnect(); off();
      document.fonts?.removeEventListener?.('loadingdone', changed);
      for (const p of previous) {
        if (p.value) root.style.setProperty(p.name, p.value, p.priority);
        else root.style.removeProperty(p.name);
      }
      if (flag === null) footer.removeAttribute('data-flow');
      else footer.setAttribute('data-flow', flag);
    };
  }, [context, dock, viewport, anchor]);
}

/**
 * Intrinsic multiline growth of the editable box: measures the natural height
 * (keeping caret/selection/internal scroll) and retargets from the current
 * visual height. Composition, viewport moves and reduced motion apply directly.
 */
export function useComposerHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string, motion: ShellMotion) {
  const composing = useRef(false);
  const heightRef = useRef<ComposerHeight | null>(null);

  if (heightRef.current === null) {
    heightRef.current = new ComposerHeight({
      frames: browserFrames,
      apply: (px) => {
        const el = ref.current;
        if (!el) return;
        el.style.height = `${px}px`;
        // The composer grows upward; a reader at the bottom stays at the bottom.
        motion.anchor.pinIfNear();
      },
      reducedMotion: prefersReducedMotion,
      viewportMoving: () => motion.viewport.moving(),
    });
  }
  const height = heightRef.current;
  const layout = useRef<ComposerLayout | null>(null);

  // Native layout changes re-measure the same draft: keyboard/viewport moves (applied directly),
  // width changes of the box itself, and web fonts finishing (metrics change the wrapping).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const l = new ComposerLayout(el, () => Number.parseFloat(getComputedStyle(el).maxHeight), height, () => composing.current);
    layout.current = l;
    l.measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => entries.forEach((e) => l.widthChanged(e.contentRect.width))) : null;
    observer?.observe(el);
    const fonts = document.fonts;
    const onFonts = () => l.measure();
    fonts?.addEventListener?.('loadingdone', onFonts);
    const off = [motion.viewport.subscribe(() => l.viewportMoved()), onReducedMotionChange(() => height.reducedMotionChanged())];
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener?.('loadingdone', onFonts);
      off.forEach((f) => f());
      height.dispose();
      layout.current = null;
    };
  }, [height, motion.viewport, ref]);

  useLayoutEffect(() => layout.current?.measure(), [value]);

  return {
    /** True while an IME composition is active; nothing may blur or submit then. */
    composing: () => composing.current,
    onCompositionStart: () => {
      composing.current = true;
      // Composition may begin between input events while a resize is still
      // running. Settle it now rather than waiting for the first IME update.
      layout.current?.measure();
    },
    onCompositionEnd: () => {
      composing.current = false;
      layout.current?.measure();
    },
  };
}

function paintDrawer(el: HTMLElement, p: DrawerProgress) {
  el.style.setProperty('--drawer-p', String(p.panel));
  el.style.setProperty('--scrim-p', String(p.scrim));
}

/**
 * Presence for the session drawer: `open` is the immediate authority; the hook
 * animates only how long the exiting picture stays (see presence.ts). It writes
 * two CSS variables on the drawer layer and re-renders only when the picture
 * must appear or can be removed. The presence object survives the picture being
 * unmounted, so a reopen retargets from the current visual progress.
 */
export function useDrawerPresence(open: boolean) {
  const [mounted, setMounted] = useState(false);
  const layer = useRef<HTMLElement | null>(null);
  const ref = useRef<DrawerPresence | null>(null);
  if (ref.current === null) {
    ref.current = new DrawerPresence({
      frames: browserFrames,
      reducedMotion: prefersReducedMotion,
      write: (p) => {
        if (layer.current) paintDrawer(layer.current, p);
      },
      onMounted: setMounted,
    });
  }
  const presence = ref.current;

  const attach = useCallback(
    (el: HTMLElement | null) => {
      layer.current = el;
      if (el) paintDrawer(el, presence.progress);
    },
    [presence],
  );

  useLayoutEffect(() => {
    if (open) presence.open();
    else presence.close();
  }, [open, presence]);

  useEffect(() => {
    const onVisibility = () => presence.visibilityChanged(document.visibilityState === 'hidden');
    const off = onReducedMotionChange(() => presence.reducedMotionChanged());
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      off();
      presence.dispose();
    };
  }, [presence]);

  return { mounted, exiting: mounted && !open, attach };
}
