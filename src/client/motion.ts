// Shared motion primitives for the measured-layout exceptions (composer height,
// reading-anchor follow). Pure and environment-injected: nothing here touches the
// DOM, and no callback ever controls business state (send, Stop, Clear, expiry).

/** Frame/clock source; the browser binding is in viewport-hooks.ts, tests inject a fake. */
export interface Frames {
  now(): number;
  raf(cb: () => void): number;
  caf(id: number): void;
}

/** Locked `standard` easing token: cubic-bezier(0.2, 0, 0, 1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(t) - x;
      if (Math.abs(err) < 1e-6) return sy(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 40 && hi - lo > 1e-7; i++) {
      if (sx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sy(t);
  };
}

export const STANDARD_EASING = cubicBezier(0.2, 0, 0, 1);
/** Locked `enter` and `exit` easing tokens. */
export const ENTER_EASING = cubicBezier(0.22, 1, 0.36, 1);
export const EXIT_EASING = cubicBezier(0.4, 0, 1, 1);

export interface TweenOptions {
  readonly frames: Frames;
  /** Nominal duration of an uninterrupted full path. */
  readonly nominalMs: number;
  /** Writes the current visual value (a layout write; the only side effect). */
  readonly apply: (value: number) => void;
  /** Evaluated at every request so a live preference change is honoured. */
  readonly reducedMotion: () => boolean;
  readonly easing?: (t: number) => number;
}

/**
 * Retargetable numeric tween. A new target always starts from the current
 * visual value (never snaps back to the original start). An interrupted path
 * lasts nominal x remaining / full path distance, capped at nominal; a
 * zero-distance end point, reduced motion and `immediate` apply at once.
 */
export class ValueTween {
  private current: number | null = null;
  private target: number | null = null;
  private from = 0;
  private startedAt = 0;
  private duration = 0;
  private fullPath = 0;
  private nominal = 0;
  private ease: (t: number) => number = STANDARD_EASING;
  private frame: number | null = null;
  /** Bumped by every cancel/finish/set so a delayed frame can never apply a stale value. */
  private epoch = 0;

  constructor(private readonly o: TweenOptions) {}

  /** Current visual value, or null before the first write. */
  get value(): number | null {
    return this.current;
  }

  get running(): boolean {
    return this.frame !== null;
  }

  /** Adopt the real current value (for example the actual scroll position) without writing; ignored mid-motion. */
  seed(value: number): void {
    if (!this.running) this.current = value;
  }

  /** Apply immediately and stop any motion. */
  set(value: number): void {
    this.stop();
    this.write(value);
    this.target = value;
  }

  /**
   * Animate (or, when allowed, jump) to `target` from the current visual value.
   * `nominalMs`, `fullPath` and `easing` override the instance defaults for this
   * segment: a surface with different enter and exit timings supplies them per
   * call, and `fullPath` is then the whole uninterrupted path (1 for progress).
   */
  to(target: number, opts: { immediate?: boolean; nominalMs?: number; fullPath?: number; easing?: (t: number) => number } = {}): void {
    if (this.current === null || opts.immediate || this.o.reducedMotion() || this.current === target) {
      this.set(target);
      return;
    }
    const remaining = Math.abs(target - this.current);
    const wasRunning = this.running;
    this.stop();
    // A fresh path measures itself; an interrupted one scales against the previous full path.
    if (opts.fullPath !== undefined) this.fullPath = opts.fullPath;
    else if (!wasRunning || this.fullPath === 0) this.fullPath = remaining;
    this.nominal = opts.nominalMs ?? this.o.nominalMs;
    this.ease = opts.easing ?? this.o.easing ?? STANDARD_EASING;
    this.duration = this.nominal * Math.min(1, remaining / this.fullPath);
    if (this.duration <= 0) {
      this.set(target);
      return;
    }
    this.from = this.current;
    this.target = target;
    this.startedAt = this.o.frames.now();
    this.schedule();
  }

  /** Finish current motion at its end point at once (reduced-motion change, viewport move). */
  finish(): void {
    if (!this.running || this.target === null) return;
    const end = this.target;
    this.stop();
    this.write(end);
  }

  /** Stop where the visual value is now. */
  cancel(): void {
    this.stop();
    this.target = this.current;
  }

  private stop(): void {
    this.epoch += 1;
    if (this.frame !== null) this.o.frames.caf(this.frame);
    this.frame = null;
  }

  private write(v: number): void {
    this.current = v;
    this.o.apply(v);
  }

  private schedule(): void {
    const epoch = this.epoch;
    this.frame = this.o.frames.raf(() => {
      if (epoch !== this.epoch) return;
      this.frame = null;
      const t = (this.o.frames.now() - this.startedAt) / this.duration;
      if (t >= 1) {
        this.write(this.target!);
        return;
      }
      this.write(this.from + (this.target! - this.from) * this.ease(Math.max(0, t)));
      this.schedule();
    });
  }
}
