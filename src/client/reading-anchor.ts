import { ValueTween, type Frames } from './motion.js';

// One reading-anchor policy. A complete result is followed (locked 180 ms) only
// when the reader was within 80 px of the bottom or has just made an explicit
// send/action; otherwise their place is kept and a "New answer" action offers
// the result. Real user input cancels following. Scrolling is never tied to
// generated tokens, no timeout is used, and nothing here gates business state.

export const NEAR_BOTTOM_PX = 80;
export const FOLLOW_MS = 180;

export interface AnchorEnv extends Frames {
  scrollTop(): number;
  setScrollTop(y: number): void;
  /** Largest scrollTop (document height minus the visible height). */
  maxScrollTop(): number;
  reducedMotion(): boolean;
}

export type ResultOutcome = 'follow' | 'pending' | 'none';
/** Re-read resting geometry after wrapping, composer or viewport changes. */
export type ResultTop = number | null | (() => number | null);

export class ReadingAnchor {
  // No mount-time composer write may assume that a restored reader was at the bottom.
  private near = false;
  private forced = false;
  private userActive = false;
  private pendingKey: string | null = null;
  private result: { key: string | null; top: ResultTop } | null = null;
  private target: number | null = null;
  /** Bumped by reset(); a late frame or result from before it can never act. */
  private generation = 0;
  private lastWritten: number | null = null;
  private readonly tween: ValueTween;

  constructor(
    private readonly env: AnchorEnv,
    private readonly onPending: (key: string | null) => void,
  ) {
    this.tween = new ValueTween({
      frames: env,
      nominalMs: FOLLOW_MS,
      reducedMotion: () => env.reducedMotion(),
      apply: (y) => {
        this.lastWritten = y;
        env.setScrollTop(y);
      },
    });
  }

  /** Whether the reader was last known to be within 80 px of the bottom. */
  get nearBottom(): boolean {
    return this.near;
  }

  get following(): boolean {
    return this.tween.running;
  }

  /** Re-measure eligibility. A footer position does not prove an answer was read. */
  measure(): boolean {
    this.near = this.env.maxScrollTop() - this.env.scrollTop() <= NEAR_BOTTOM_PX;
    return this.near;
  }

  /**
   * Native scroll event. A position that does not match this anchor's own last
   * write is manual scrolling (wheel, touch, keys, scrollbar or pointer drag,
   * whatever the input): it cancels a running follow, and scrolling away by
   * hand withdraws an earlier explicit intent to follow. Echoes of this
   * anchor's own writes are never treated as the user.
   */
  onScroll(): void {
    const top = this.env.scrollTop();
    // Removing an offer/composer row can lower the native maximum while an
    // answer is following. The browser clamps before emitting scroll; that is
    // geometry, not a fresh user interruption. Real input already clears result.
    if (this.result && this.lastWritten !== null) {
      const max = this.env.maxScrollTop();
      if (this.lastWritten > max && Math.abs(top - max) <= 2) {
        this.followResult();
        this.measure();
        return;
      }
    }
    const own = this.lastWritten !== null && Math.abs(top - this.lastWritten) <= 2;
    if (!own) {
      this.onUserInput();
    }
    this.measure();
    if (this.userActive && !this.near) this.forced = false;
  }

  /** Wheel, touch, pointer or navigation key: real user scrolling supersedes following at once. */
  onUserInput(): void {
    if (this.tween.running && this.result?.key) this.setPending(this.result.key);
    this.userActive = true;
    this.forced = false;
    this.result = null;
    this.target = null;
    this.lastWritten = null;
    this.tween.cancel();
  }

  /** An explicit current user send/action (analyse, discover, refine). */
  userAction(): void {
    this.tween.cancel();
    this.result = null;
    this.target = null;
    this.lastWritten = null;
    this.setPending(null);
    this.forced = true;
    this.userActive = false;
    this.measure();
  }

  /**
   * A complete new result exists. `resultTop` is where its top sits in scroll
   * coordinates (null when unknown). Returns what was done.
   */
  onResult(key: string, resultTop: ResultTop): ResultOutcome {
    const follow = this.forced || this.near;
    this.forced = false;
    this.tween.cancel();
    this.target = null;
    this.result = follow ? { key, top: resultTop } : null;
    if (!follow || !this.followResult()) {
      this.setPending(key);
      return 'pending';
    }
    this.setPending(null);
    return 'follow';
  }

  /** The reader chose "New answer": go to the start of that result and retire the offer. */
  reveal(resultTop: ResultTop): void {
    this.tween.cancel();
    this.target = null;
    this.result = { key: this.pendingKey, top: resultTop };
    this.userActive = false;
    if (this.followResult()) this.setPending(null);
  }

  /** Native geometry applies immediately, retaining the answer start rather than its footer. */
  viewportMoved(): void {
    if (this.result) { this.followResult(true); return; }
    this.tween.cancel();
    this.pinIfNear();
  }

  /** Layout settling shares the current answer target; otherwise only the old bottom may be pinned. */
  pinIfNear(): void {
    if (this.result) { this.followResult(); return; }
    if (!this.near || this.pendingKey !== null) return;
    this.lastWritten = this.env.maxScrollTop();
    this.env.setScrollTop(this.lastWritten);
  }

  layoutChanged(): void { this.pinIfNear(); }

  /** Live reduced-motion change: finish the current follow immediately. */
  reducedMotionChanged(): void {
    if (this.env.reducedMotion()) this.tween.finish();
  }

  /** Stop, Clear, expiry, replacement or a new session: nothing from before may scroll or reappear. */
  reset(): void {
    this.generation += 1;
    this.tween.cancel();
    this.forced = false;
    this.userActive = false;
    this.result = null;
    this.target = null;
    this.lastWritten = null;
    this.setPending(null);
    this.measure();
  }

  dispose(): void {
    this.generation += 1;
    this.tween.cancel();
    this.result = null;
    this.target = null;
  }

  get epoch(): number {
    return this.generation;
  }

  /** Eligibility, not scroll direction, decides whether a new answer may be followed. */
  private followResult(immediate = false): boolean {
    if (!this.result) return false;
    const resultTop = typeof this.result.top === 'function' ? this.result.top() : this.result.top;
    if (resultTop === null || !Number.isFinite(resultTop)) {
      const key = this.result.key;
      this.result = null;
      this.target = null;
      this.tween.cancel();
      if (key) this.setPending(key);
      return false;
    }
    const max = this.env.maxScrollTop();
    const top = this.env.scrollTop();
    const target = Math.min(max, Math.max(0, resultTop));
    if (target === top) {
      this.tween.cancel();
      this.lastWritten = top;
      this.target = target;
      return true;
    }
    const own = this.lastWritten !== null && Math.abs(top - this.lastWritten) <= 2;
    if (!immediate && this.tween.running && this.target === target && own) return true;
    // A layout/native anchor may have moved the page before its scroll event.
    // Adopt that actual position; a later real user event still cancels everything.
    if (!own) this.tween.cancel();
    this.tween.seed(top);
    this.lastWritten = top;
    this.target = target;
    this.tween.to(target, { immediate });
    return true;
  }

  private setPending(key: string | null): void {
    if (this.pendingKey === key) return;
    this.pendingKey = key;
    this.onPending(key);
  }
}

/**
 * Classifies a snapshot's result key: the first snapshot of a session (page
 * load, restore, session change) is a silent baseline; later keys are new results.
 */
export class ResultTracker {
  private session: string | null = null;
  private key: string | null = null;
  private seeded = false;

  observe(session: string | null, key: string | null): 'baseline' | 'result' | 'none' | 'cleared' {
    if (!this.seeded || session !== this.session) {
      this.seeded = true;
      this.session = session;
      this.key = key;
      return 'baseline';
    }
    if (key === this.key) return 'none';
    this.key = key;
    return key === null ? 'cleared' : 'result';
  }

  reset(): void {
    this.seeded = false;
    this.session = null;
    this.key = null;
  }
}
