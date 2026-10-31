import { ENTER_EASING, EXIT_EASING, ValueTween, type Frames } from './motion.js';

// Visual presence of the session drawer (motion M07.drawer). Whether the drawer
// is *wanted* is owned by the caller and applies immediately (focus, inertness,
// Escape, Clear); this class only animates how long its exiting picture stays
// on screen, as two progress values (drawer and scrim, 0 closed .. 1 open).
// A reversal retargets from the current visual progress and lasts the nominal
// time scaled by the remaining path; reduced motion and a hidden document place
// the end state at once; every superseded frame is invalidated by the tween.

export interface PanelTimings {
  readonly enter: number;
  readonly exit: number;
  readonly scrimEnter: number;
  readonly scrimExit: number;
  /** Return to the open state after an undismissed drag (sheet only). */
  readonly dragReturn?: number;
}

/** Locked timings per surface (M07.drawer and M06.sheet). */
export const DRAWER_MS: PanelTimings = { enter: 300, exit: 220, scrimEnter: 220, scrimExit: 180 };
export const SHEET_MS: PanelTimings = { enter: 360, exit: 260, scrimEnter: 220, scrimExit: 180, dragReturn: 220 };

export interface DrawerProgress {
  /** Drawer position: 0 fully off-screen, 1 fully open. */
  readonly panel: number;
  /** Scrim strength: 0 clear, 1 at its full opacity. */
  readonly scrim: number;
}

export interface PresenceDeps {
  readonly frames: Frames;
  /** Locked timings of this surface (default: the drawer's). */
  readonly ms?: PanelTimings;
  /** Read live at every request. */
  readonly reducedMotion: () => boolean;
  /** Writes the visual progress (the only side effect; never touches authority). */
  readonly write: (p: DrawerProgress) => void;
  /** The drawer picture needs to exist (wanted, or still visibly exiting). */
  readonly onMounted: (mounted: boolean) => void;
}

export class DrawerPresence {
  private readonly panel: ValueTween;
  private readonly scrim: ValueTween;
  private p: DrawerProgress = { panel: 0, scrim: 0 };
  private dragOrigin: DrawerProgress = { panel: 1, scrim: 1 };
  private wanted = false;
  private isMounted = false;
  private readonly ms: PanelTimings;

  constructor(private readonly deps: PresenceDeps) {
    this.ms = deps.ms ?? DRAWER_MS;
    const tween = (key: keyof DrawerProgress) =>
      new ValueTween({
        frames: deps.frames,
        nominalMs: this.ms.enter,
        reducedMotion: deps.reducedMotion,
        apply: (v) => {
          this.p = { ...this.p, [key]: v };
          deps.write(this.p);
          this.settle();
        },
      });
    this.panel = tween('panel');
    this.scrim = tween('scrim');
    this.panel.seed(0);
    this.scrim.seed(0);
  }

  /** Current visual progress. */
  get progress(): DrawerProgress {
    return this.p;
  }

  get mounted(): boolean {
    return this.isMounted;
  }

  get animating(): boolean {
    return this.panel.running || this.scrim.running;
  }

  open(): void {
    this.wanted = true;
    this.setMounted(true);
    this.panel.to(1, { nominalMs: this.ms.enter, fullPath: 1, easing: ENTER_EASING });
    this.scrim.to(1, { nominalMs: this.ms.scrimEnter, fullPath: 1, easing: ENTER_EASING });
  }

  close(): void {
    this.wanted = false;
    this.panel.to(0, { nominalMs: this.ms.exit, fullPath: 1, easing: EXIT_EASING });
    this.scrim.to(0, { nominalMs: this.ms.scrimExit, fullPath: 1, easing: EXIT_EASING });
    this.settle();
  }

  /** Whether the surface is currently wanted (the caller's authority, mirrored for gesture guards). */
  get isWanted(): boolean {
    return this.wanted;
  }

  /** A drag took over: stop animating and keep the current visual position. */
  beginDrag(): void {
    this.panel.cancel();
    this.scrim.cancel();
    this.dragOrigin = this.p;
  }

  /** Follow pointer travel towards closed from each captured visual origin, including an interrupted entrance/return. */
  dragTo(fraction: number): void {
    if (!this.wanted) return;
    const travel = Math.min(1, Math.max(0, fraction));
    this.panel.set(Math.max(0, this.dragOrigin.panel - travel));
    this.scrim.set(Math.max(0, this.dragOrigin.scrim - travel));
  }

  /** An undismissed or cancelled drag returns to open from the current position over the locked return time. */
  returnOpen(): void {
    if (!this.wanted) return;
    const nominalMs = this.ms.dragReturn ?? this.ms.enter;
    this.panel.to(1, { nominalMs, easing: ENTER_EASING });
    this.scrim.to(1, { nominalMs, easing: ENTER_EASING });
  }

  /** Authority was revoked: the picture is removed at once (0 ms), with no exit motion. */
  hardClose(): void {
    this.wanted = false;
    this.panel.set(0);
    this.scrim.set(0);
    this.settle();
  }

  /** Live reduced-motion change: finish the spatial motion immediately. */
  reducedMotionChanged(): void {
    if (this.deps.reducedMotion()) this.finish();
  }

  /** A hidden document pauses nonessential motion: land on the end state. */
  visibilityChanged(hidden: boolean): void {
    if (hidden) this.finish();
  }

  dispose(): void {
    this.panel.cancel();
    this.scrim.cancel();
  }

  private finish(): void {
    this.panel.finish();
    this.scrim.finish();
    this.settle();
  }

  private settle(): void {
    if (!this.wanted && this.p.panel === 0 && this.p.scrim === 0 && !this.animating) this.setMounted(false);
  }

  private setMounted(mounted: boolean): void {
    if (this.isMounted === mounted) return;
    this.isMounted = mounted;
    this.deps.onMounted(mounted);
  }
}
