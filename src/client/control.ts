import { STANDARD_EASING, ValueTween } from './motion.js';
import type { DecorEnv } from './decor.js';

// Control and selection motion (M03.control, M07.selection). Pure and
// environment-injected: nothing here touches the DOM, and no animation or its
// completion ever activates a control, sends a request or changes state. A
// control's semantics (activation, focus, aria-pressed, names) are decided by
// the page immediately; this only draws a press and a state change.

/** Locked numbers from MOTION_SPEC.json (adapted_locked_v1), `standard` easing throughout. */
export const CONTROL = {
  pressMs: 80,
  releaseMs: 120,
  pressScale: 0.97,
  iconCrossfadeMs: 100,
  toggleMs: 160,
} as const;

const PRESS_PATH = 1 - CONTROL.pressScale;

/**
 * One control's press: scale 1 -> 0.97 over 80 ms, back over 120 ms. A reversal
 * retargets from the current scale over the nominal time scaled by the remaining
 * path. Under reduced motion nothing scales at all, and a live reduced-motion
 * change or a hidden page restores scale 1 at once.
 */
export class PressScale {
  private readonly tween: ValueTween;
  private holding = false;

  constructor(
    private readonly env: DecorEnv,
    write: (scale: number) => void,
    /** Called when the control is back at rest and released. */
    private readonly onRest: () => void = () => undefined,
  ) {
    this.tween = new ValueTween({
      frames: env.frames,
      nominalMs: CONTROL.pressMs,
      reducedMotion: env.reducedMotion,
      easing: STANDARD_EASING,
      apply: (v) => {
        write(v);
        if (v === 1 && !this.holding) this.onRest();
      },
    });
    this.tween.seed(1);
  }

  get scale(): number {
    return this.tween.value ?? 1;
  }

  press(): void {
    this.holding = true;
    if (this.env.reducedMotion()) return;
    this.tween.to(CONTROL.pressScale, { nominalMs: CONTROL.pressMs, fullPath: PRESS_PATH, easing: STANDARD_EASING });
  }

  /** Pointer up, leave or cancel: back to scale 1 from wherever it is. */
  release(): void {
    this.holding = false;
    if (this.scale === 1 && !this.tween.running) return this.onRest();
    this.tween.to(1, { nominalMs: CONTROL.releaseMs, fullPath: PRESS_PATH, easing: STANDARD_EASING });
  }

  /** Reduced-motion change, hidden page or revoked control: restore at once. */
  restore(): void {
    this.holding = false;
    this.tween.set(1);
  }
}

/**
 * Presses of many controls (one per pressed element), so one delegated pointer
 * binding can serve every existing control. Entries exist only while pressed or
 * returning; a control at rest holds nothing.
 */
export class PressManager<T extends object> {
  private readonly active = new Map<T, PressScale>();

  constructor(
    private readonly env: DecorEnv,
    private readonly write: (target: T, scale: number) => void,
  ) {}

  get size(): number {
    return this.active.size;
  }

  down(target: T): void {
    let p = this.active.get(target);
    if (!p) {
      p = new PressScale(
        this.env,
        (v) => this.write(target, v),
        () => this.active.delete(target),
      );
      this.active.set(target, p);
    }
    p.press();
  }

  /** Release one control, or every pressed control (pointer up/cancel anywhere). */
  up(target?: T): void {
    if (target) this.active.get(target)?.release();
    else for (const p of [...this.active.values()]) p.release();
  }

  restoreAll(): void {
    for (const p of [...this.active.values()]) p.restore();
    this.active.clear();
  }
}

/** The disabled/aria-disabled test the delegated press uses: an unavailable control never presses. */
export const isPressable = (el: { disabled?: boolean; getAttribute: (n: string) => string | null }): boolean =>
  !el.disabled && el.getAttribute('aria-disabled') !== 'true';

/**
 * A 0..1 state value (selected mark, Send/Stop icon) that crossfades over a fixed
 * time and retargets from its current value. Reduced motion changes it at once.
 */
export class Toggle {
  private readonly tween: ValueTween;

  constructor(
    private readonly env: DecorEnv,
    private readonly ms: number,
    private readonly write: (t: number) => void,
  ) {
    this.tween = new ValueTween({ frames: env.frames, nominalMs: ms, reducedMotion: env.reducedMotion, easing: STANDARD_EASING, apply: write });
  }

  get value(): number | null {
    return this.tween.value;
  }

  get running(): boolean {
    return this.tween.running;
  }

  /** The state at first appearance: no motion. */
  seed(on: boolean): void {
    this.tween.set(on ? 1 : 0);
  }

  /**
   * A node showing this value appeared. Nothing shown yet, or the page is already hidden (no motion may start and none
   * is running): the real state is drawn at once. Otherwise the value in progress continues. Returns the value to show.
   */
  attach(on: boolean): number {
    if (this.tween.value === null || this.env.hidden?.()) this.seed(on);
    return this.tween.value ?? (on ? 1 : 0);
  }

  /**
   * The semantic state changed (already true on screen for assistive technology): draw the change from the current value.
   * While the page is hidden nothing is drawn over time: the actual state lands at once and no frame is requested.
   */
  set(on: boolean): void {
    const target = on ? 1 : 0;
    const current = this.tween.value;
    if (current === null || this.env.hidden?.()) return this.seed(on);
    // Re-assert the current value first so the picture never flashes the final state before the first frame.
    this.write(current);
    this.tween.to(target, { nominalMs: this.ms, fullPath: 1, easing: STANDARD_EASING });
  }

  finish(): void {
    this.tween.finish();
  }

  dispose(): void {
    this.tween.cancel();
  }
}

/** What the single Send/Stop action does when activated, from the real state: never from motion. */
export function actionDecision(s: { working: boolean; stopping: boolean; canAnalyse: boolean }): 'stop' | 'send' | 'none' {
  if (s.working) return s.stopping ? 'none' : 'stop';
  return s.canAnalyse ? 'send' : 'none';
}
