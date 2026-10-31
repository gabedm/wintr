import type { Frames } from './motion.js';

// One viewport strategy for every browser: the layout viewport is left alone and
// the part of it hidden under the on-screen keyboard (measured from the native
// visualViewport) becomes a single CSS offset, `--kb-inset`. The composer sticks
// that far above the layout bottom and the document gains the same bottom
// padding, so content stays reachable. Browsers that resize the layout viewport
// instead report no overlap, so nothing is applied twice. No keyboard height is
// guessed and no timer or CSS animation is involved.

export interface ViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
}

export interface WindowLike {
  addEventListener(type: 'resize' | 'orientationchange', listener: () => void): void;
  removeEventListener(type: 'resize' | 'orientationchange', listener: () => void): void;
}

/** Below this overlap the viewport change is browser chrome (URL bar), not a keyboard. */
export const KEYBOARD_OPEN_MIN_PX = 100;
/** A pinch-zoomed visual viewport is smaller than the layout one without any keyboard. */
const ZOOM_EPSILON = 0.01;

/** Layout-viewport pixels hidden below the visual viewport; 0 when zoomed, unknown or negative. */
export function keyboardInset(layoutHeight: number, vv: Pick<ViewportLike, 'height' | 'offsetTop' | 'scale'> | null): number {
  if (!vv || !Number.isFinite(layoutHeight) || !Number.isFinite(vv.height) || !Number.isFinite(vv.offsetTop)) return 0;
  if (Math.abs(vv.scale - 1) > ZOOM_EPSILON) return 0;
  return Math.max(0, Math.round(layoutHeight - (vv.offsetTop + vv.height)));
}

export interface ViewportEnv {
  readonly visualViewport: ViewportLike | null;
  readonly window: WindowLike;
  /** Layout viewport height (documentElement.clientHeight). */
  layoutHeight(): number;
  /** Layout viewport width; a width change rewraps text and counts as a native viewport change. */
  layoutWidth?(): number;
  /** Writes the single layout offset. */
  apply(inset: number, keyboardOpen: boolean): void;
  readonly frames: Pick<Frames, 'raf' | 'caf'>;
}

export interface ViewportTracker {
  /** True from a native viewport change until the next frame; app height tweens are suppressed meanwhile. */
  moving(): boolean;
  readonly inset: number;
  /** Called synchronously after a real change has been applied. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  stop(): void;
}

export function trackViewport(env: ViewportEnv): ViewportTracker {
  const vv = env.visualViewport;
  const listeners = new Set<() => void>();
  let inset = -1;
  let key = '';
  let isMoving = false;
  let frame: number | null = null;
  let stopped = false;

  const measure = () => {
    if (stopped) return;
    const next = keyboardInset(env.layoutHeight(), vv);
    // Offset, size and orientation changes all supersede the previous measurement immediately.
    const nextKey = `${next}|${vv?.height ?? ''}|${vv?.offsetTop ?? ''}|${env.layoutHeight()}|${env.layoutWidth?.() ?? ''}`;
    if (next === inset && nextKey === key) return;
    const insetChanged = next !== inset;
    key = nextKey;
    inset = next;
    if (insetChanged) env.apply(next, next >= KEYBOARD_OPEN_MIN_PX);
    isMoving = true;
    if (frame === null) {
      frame = env.frames.raf(() => {
        frame = null;
        isMoving = false;
      });
    }
    for (const l of [...listeners]) l();
  };

  vv?.addEventListener('resize', measure);
  vv?.addEventListener('scroll', measure);
  env.window.addEventListener('resize', measure);
  env.window.addEventListener('orientationchange', measure);
  measure();
  // The initial measurement is not a keyboard move.
  isMoving = false;

  return {
    moving: () => isMoving,
    get inset() {
      return Math.max(0, inset);
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      env.window.removeEventListener('resize', measure);
      env.window.removeEventListener('orientationchange', measure);
      if (frame !== null) env.frames.caf(frame);
      frame = null;
      isMoving = false;
      listeners.clear();
    },
  };
}
