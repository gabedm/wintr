import { ENTER_EASING, EXIT_EASING, ValueTween, type Frames } from './motion.js';

// Conversation decoration (motion M01.intro, M01.suggestions, M03.send, M04.pending,
// M04.result). Pure and environment-injected: nothing here touches the DOM or
// business state. Send, Stop, Clear, expiry, content and attribution are decided
// before and never wait for any of this; decoration only draws what is already
// true, finishes at once when interrupted, and never delays a result.

/** Locked numbers from MOTION_SPEC.json (adapted_locked_v1). Times in ms, distances in CSS px. */
export const DECOR = {
  intro: { cardMs: 280, cardY: 8, motifMs: 240, motifStaggerMs: 40, motifs: 5, motifScaleFrom: 0.92, maxTotalMs: 400 },
  suggestions: { enterMs: 180, exitMs: 100, y: 4 },
  welcome: { exitMs: 120 },
  userBubble: { enterMs: 220, y: 8 },
  pending: { enterMs: 120, exitMs: 100, crossfadeMs: 120, dotCycleMs: 900, dotPhaseStepMs: 100, dots: 3, dotMin: 0.35 },
  result: { enterMs: 240, y: 6 },
  /** M03.cancel settled_state / M08.recovery state_crossfade: the incoming in-flow cancellation or recovery state (opacity only). */
  settled: { enterMs: 160 },
  /** M07.selection token_enter (opacity and 3 px rise) and token_exit (opacity only). */
  token: { enterMs: 160, y: 3, exitMs: 120 },
} as const;

export interface DecorEnv {
  readonly frames: Frames;
  /** Read live at every request, so a preference change mid-motion is honoured. */
  readonly reducedMotion: () => boolean;
  /** Whether the page is hidden right now (read at each request); a hidden page never starts motion. Absent: never hidden. */
  readonly hidden?: () => boolean;
}

// ---------------------------------------------------------------------------
// Fade: one progress value 0..1 (opacity and a small translate are derived from it).

export interface FadeOptions extends DecorEnv {
  readonly enterMs: number;
  readonly exitMs: number;
  /** Easing of the enter motion (default: the locked enter token). */
  readonly enterEasing?: (t: number) => number;
  /** Easing of the exit motion (default: the locked exit token). */
  readonly exitEasing?: (t: number) => number;
  /** Writes the current progress (the only side effect). */
  readonly write: (p: number) => void;
  /** Called once the value has reached 0 while no longer wanted. */
  readonly onGone?: () => void;
}

/**
 * Enter/exit progress. A reversal retargets from the current value over the
 * nominal time scaled by the remaining path; zero distance, reduced motion and a
 * hidden page apply at once; every superseded frame is invalidated by the tween.
 */
export class Fade {
  private readonly tween: ValueTween;
  private wanted = false;

  constructor(private readonly o: FadeOptions) {
    this.tween = new ValueTween({
      frames: o.frames,
      nominalMs: o.enterMs,
      reducedMotion: o.reducedMotion,
      apply: (v) => {
        o.write(v);
        if (!this.wanted && v === 0) o.onGone?.();
      },
    });
  }

  /** Current progress, or null before the first write. */
  get value(): number | null {
    return this.tween.value;
  }

  get running(): boolean {
    return this.tween.running;
  }

  /**
   * First appearance: from hidden with the enter motion, or directly at rest. Reduced motion is always at rest.
   * `from` adopts the exact visible value of the picture this one continues (an interrupted entrance), with no motion.
   */
  begin(animate: boolean, from?: number): void {
    this.wanted = true;
    if (this.o.reducedMotion() || this.o.hidden?.()) {
      this.tween.set(1);
      return;
    }
    if (from !== undefined) {
      this.tween.set(Math.min(1, Math.max(0, from)));
      return;
    }
    if (!animate) {
      this.tween.set(1);
      return;
    }
    this.tween.set(0);
    this.tween.to(1, { immediate: this.o.hidden?.(), nominalMs: this.o.enterMs, fullPath: 1, easing: this.o.enterEasing ?? ENTER_EASING });
  }

  show(): void {
    this.wanted = true;
    this.tween.to(1, { immediate: this.o.hidden?.(), nominalMs: this.o.enterMs, fullPath: 1, easing: this.o.enterEasing ?? ENTER_EASING });
  }

  hide(): void {
    this.wanted = false;
    this.tween.to(0, { immediate: this.o.hidden?.(), nominalMs: this.o.exitMs, fullPath: 1, easing: this.o.exitEasing ?? EXIT_EASING });
  }

  /** Authority was revoked (Clear, expiry, redaction): gone at 0 ms, no exit picture. */
  hardHide(): void {
    this.wanted = false;
    this.tween.set(0);
  }

  /** A live reduced-motion change, an interruption or a hidden page: finish the current motion now. */
  finish(): void {
    this.tween.finish();
  }

  dispose(): void {
    this.wanted = true;
    this.tween.cancel();
  }
}

// ---------------------------------------------------------------------------
// Intro: the compact card plus five original motifs, once.

export interface IntroProgress {
  readonly card: number;
  /** One value per motif, 0 hidden .. 1 at rest. */
  readonly motifs: readonly number[];
}

const REST: IntroProgress = { card: 1, motifs: Array.from({ length: DECOR.intro.motifs }, () => 1) };
const HELD: IntroProgress = { card: 0, motifs: Array.from({ length: DECOR.intro.motifs }, () => 0) };

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Progress of the whole sequence at `elapsedMs` (pure; sparse or duplicate frames just evaluate the same function). */
export function introAt(elapsedMs: number): IntroProgress {
  const { cardMs, motifMs, motifStaggerMs, motifs } = DECOR.intro;
  return {
    card: ENTER_EASING(clamp01(elapsedMs / cardMs)),
    motifs: Array.from({ length: motifs }, (_, i) => ENTER_EASING(clamp01((elapsedMs - i * motifStaggerMs) / motifMs))),
  };
}

/**
 * Card at t=0 (280 ms) with motifs starting at 0/40/80/120/160 ms (240 ms each),
 * ending by 400 ms, then still. `finish()` (typing, first send, reduced motion,
 * a hidden page) lands on the final state at once. It never loops and is never
 * started twice.
 */
export class IntroSequence {
  private state: 'idle' | 'held' | 'running' | 'done' = 'idle';
  private frame: number | null = null;
  private startedAt = 0;
  private epoch = 0;

  constructor(
    private readonly env: DecorEnv,
    private readonly write: (p: IntroProgress) => void,
  ) {}

  get phase(): 'idle' | 'held' | 'running' | 'done' {
    return this.state;
  }

  /** Reserve the final layout but draw nothing yet (before the first state is known). */
  hold(): void {
    if (this.state !== 'idle' && this.state !== 'held') return;
    if (this.env.reducedMotion() || this.env.hidden?.()) return this.finish();
    this.state = 'held';
    this.write(HELD);
  }

  start(): void {
    if (this.state === 'done' || this.state === 'running') return;
    if (this.env.reducedMotion() || this.env.hidden?.()) return this.finish();
    this.state = 'running';
    this.startedAt = this.env.frames.now();
    this.write(introAt(0));
    this.schedule();
  }

  finish(): void {
    if (this.state === 'done') return;
    this.stop();
    this.state = 'done';
    this.write(REST);
  }

  /** The element is gone or the page is leaving; nothing is written afterwards. */
  dispose(): void {
    this.stop();
    this.state = 'done';
  }

  private stop(): void {
    this.epoch += 1;
    if (this.frame !== null) this.env.frames.caf(this.frame);
    this.frame = null;
  }

  private schedule(): void {
    const epoch = this.epoch;
    this.frame = this.env.frames.raf(() => {
      if (epoch !== this.epoch) return;
      this.frame = null;
      const elapsed = this.env.frames.now() - this.startedAt;
      if (elapsed >= DECOR.intro.maxTotalMs) return this.finish();
      this.write(introAt(elapsed));
      this.schedule();
    });
  }
}

export interface IntroFacts {
  readonly phase: IntroSequence['phase'];
  /** The first state of this page is known (restored, empty, failed or behind a recovery barrier). */
  readonly resolved: boolean;
  /** The welcome is what the conversation would show (no reference yet). */
  readonly empty: boolean;
  /** The listener typed. */
  readonly interrupted: boolean;
  /** Local wipe epoch: any wipe (Clear, another tab's Clear) consumes the welcome. */
  readonly wipe: number;
}

/**
 * What the welcome does now. It plays once, only for the first empty view after
 * the page's state is known: restored or non-empty content, a wipe, typing and
 * a finished sequence all end with the card simply at rest.
 */
export function introDecision(f: IntroFacts): 'none' | 'finish' | 'hold' | 'start' {
  if (f.phase === 'done') return 'none';
  if (!f.empty || f.wipe > 0 || f.interrupted) return 'finish';
  return f.resolved ? 'start' : 'hold';
}

export interface GhostFacts {
  readonly wasWelcome: boolean;
  readonly welcome: boolean;
  /** This page's own accepted send is what removed it (not a restore, a refresh or a wipe). */
  readonly sentHere: boolean;
  readonly hasRect: boolean;
  readonly reducedMotion: boolean;
}

/** Whether the outgoing welcome copy is shown for its 120 ms exit. */
export const ghostDecision = (f: GhostFacts): boolean => f.wasWelcome && !f.welcome && f.sentHere && f.hasRect && !f.reducedMotion;

export interface TokenExitFacts {
  /** The listener pressed Edit on the saved choice (a real removal, not Clear, expiry, redaction, a new session or unmount). */
  readonly edited: boolean;
  readonly hasRect: boolean;
  /** How visible the token is at this very moment (1 at rest, less mid-entrance, 0 before it showed anything). */
  readonly opacity: number;
  readonly reducedMotion: boolean;
  readonly hidden: boolean;
}

/** Whether the removed Keeping token leaves as an inert 120 ms picture; reduced motion, a hidden page and an invisible token remove it at once. */
export const tokenExitDecision = (f: TokenExitFacts): boolean => f.edited && f.hasRect && f.opacity > 0 && !f.reducedMotion && !f.hidden;

export interface Box {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface HostFacts {
  /** The host's border box in viewport coordinates. */
  readonly box: Box;
  /** Its border widths and scroll offsets: absolute children are placed from its padding box origin, scrolled with it. */
  readonly clientTop: number;
  readonly clientLeft: number;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}

export interface VisualCapture {
  /** Where the element looks to be right now, in the coordinates an absolutely placed sibling inside `host` uses. */
  readonly rect: Box;
  /** How visible it looks right now: the product of every entrance opacity still in progress on it or its wrappers. */
  readonly opacity: number;
}

/**
 * Current presentation of an element for a picture that must continue it exactly. `box` is the element's rendered
 * rectangle (it already includes any transform in effect), so a transformed or nested wrapper cannot misplace the
 * picture the way layout offsets relative to some other offset parent would. `playing` are the progress values of the
 * entrances still running on the element and its ancestors up to the host.
 */
export function visualCapture(box: Box, host: HostFacts, playing: readonly number[]): VisualCapture {
  const opacity = playing.reduce((product, p) => product * (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 1), 1);
  return {
    rect: {
      top: box.top - host.box.top - host.clientTop + host.scrollTop,
      left: box.left - host.box.left - host.clientLeft + host.scrollLeft,
      width: box.width,
      height: box.height,
    },
    opacity,
  };
}

// ---------------------------------------------------------------------------
// Pending dots: three 4 px dots, 900 ms cycle, 100 ms phase step, linear.

/** Opacity of dot `index` `elapsedMs` after the loop began: 0.35 -> 1 -> 0.35 at 0/50/100% of each cycle. */
export function dotOpacity(elapsedMs: number, index: number): number {
  const { dotCycleMs, dotPhaseStepMs, dotMin } = DECOR.pending;
  const local = elapsedMs - index * dotPhaseStepMs;
  if (local < 0) return dotMin;
  const phase = (local % dotCycleMs) / dotCycleMs;
  const triangle = phase <= 0.5 ? phase * 2 : (1 - phase) * 2;
  return dotMin + (1 - dotMin) * triangle;
}

/** What the dots show when nothing animates (reduced motion, a hidden page, a stopped operation). */
export const STATIC_DOTS: readonly number[] = Array.from({ length: DECOR.pending.dots }, () => 1);

/**
 * The only perpetual decoration. It runs only while started, visible and not
 * reduced; `stop()` (operation ended, cancelled, failed, revoked) ends it at once.
 */
export class PendingLoop {
  private running = false;
  private suspended = false;
  private frame: number | null = null;
  private origin = 0;
  private epoch = 0;

  constructor(
    private readonly env: DecorEnv,
    private readonly write: (opacities: readonly number[]) => void,
  ) {}

  get active(): boolean {
    return this.frame !== null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.begin();
  }

  stop(): void {
    this.running = false;
    this.cancel();
    this.write(STATIC_DOTS);
  }

  /** A hidden page suspends the decoration; becoming visible resumes it if the operation is still active. */
  visibilityChanged(hidden: boolean): void {
    this.suspended = hidden;
    if (!this.running) return;
    if (hidden) {
      this.cancel();
      this.write(STATIC_DOTS);
    } else if (this.frame === null) this.begin();
  }

  /** A live reduced-motion change ends the loop and shows the static dots. */
  reducedMotionChanged(): void {
    if (this.running && this.env.reducedMotion()) {
      this.cancel();
      this.write(STATIC_DOTS);
    } else if (this.running && this.frame === null && !this.suspended) this.begin();
  }

  private begin(): void {
    if (this.suspended || this.env.reducedMotion() || this.env.hidden?.()) {
      this.write(STATIC_DOTS);
      return;
    }
    this.origin = this.env.frames.now();
    this.tick();
  }

  private cancel(): void {
    this.epoch += 1;
    if (this.frame !== null) this.env.frames.caf(this.frame);
    this.frame = null;
  }

  private tick(): void {
    const elapsed = this.env.frames.now() - this.origin;
    this.write(Array.from({ length: DECOR.pending.dots }, (_, i) => dotOpacity(elapsed, i)));
    const epoch = this.epoch;
    this.frame = this.env.frames.raf(() => {
      if (epoch !== this.epoch) return;
      this.frame = null;
      this.tick();
    });
  }
}

// ---------------------------------------------------------------------------
// Which result is new: only an answer that arrived while THIS page was working.

/**
 * A complete result entrance plays only for a panel that first appears while
 * this page was awaiting or watching work. A restored, returned, other-tab or
 * already-seen panel is simply complete and never replays; same-panel changes
 * (feedback, progress) are not new; earlier panels never animate. The first
 * observed state is a baseline: everything already owned in it (even when work
 * is under way) is seen, and only a later, unseen result can enter. A local wipe
 * (Clear, redaction, another tab's Clear) forgets everything, baseline included.
 */
export class FreshTracker {
  private readonly seen = new Set<string>();
  private armed = false;
  private baselined = false;

  /** Decided in render for the panel being drawn; has no side effects. Nothing is fresh before a baseline exists. */
  isFresh(handle: string | null, working: boolean): boolean {
    return this.baselined && handle !== null && !this.seen.has(handle) && (this.armed || working);
  }

  /**
   * After each commit: remember what is on screen and whether work is under way. `observed` is false until the
   * page knows its state (nothing can be restored or new before that); the first observed commit is the baseline.
   */
  commit(handles: readonly string[], working: boolean, observed = true): void {
    if (!observed) return;
    if (!this.baselined) {
      this.baselined = true;
      for (const h of handles) this.seen.add(h);
      this.armed = working;
      return;
    }
    if (working) this.armed = true;
    let consumed = false;
    for (const h of handles) {
      if (!this.seen.has(h)) {
        this.seen.add(h);
        consumed = true;
      }
    }
    // Work that ended without producing anything new does not leave the next unrelated panel armed.
    if (consumed || !working) this.armed = false;
  }

  reset(): void {
    this.seen.clear();
    this.armed = false;
    this.baselined = false;
  }
}
