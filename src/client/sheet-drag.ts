// Handle-only, one-pointer downward drag of a bottom sheet (motion M06.sheet).
// Pure: pointer samples in, a clamped offset and a release decision out. It
// holds no DOM, timer or business state; the caller wires real pointer events
// from the sheet's handle alone (never content, fields or links).

/** Dismiss when dragged beyond this fraction of the CURRENT panel height... */
export const DISMISS_FRACTION = 0.25;
/** ...or released faster than this (CSS px per ms, downward) after at least MIN_TRAVEL_PX. */
export const DISMISS_VELOCITY = 0.8;
export const MIN_TRAVEL_PX = 24;
/** Release velocity is sampled from the final 80 ms of pointer samples. */
export const VELOCITY_WINDOW_MS = 80;

export interface DragSample {
  readonly t: number;
  readonly y: number;
}

/**
 * Downward velocity (px/ms) over the final window before release. The window
 * starts exactly `windowMs` before the last sample: where no sample falls on
 * that boundary, the position there is interpolated between the sample just
 * before it and the first one inside, so sparse samples on a steady trajectory
 * give that trajectory's velocity. A drag shorter than the window uses all its
 * samples; a window with no elapsed time (duplicate or single timestamp) is 0.
 */
export function releaseVelocity(samples: readonly DragSample[], windowMs: number = VELOCITY_WINDOW_MS): number {
  const last = samples[samples.length - 1];
  const firstSample = samples[0];
  if (!last || !firstSample) return 0;
  const span = last.t - firstSample.t;
  if (!(span > 0)) return 0;
  const width = Math.min(windowMs, span);
  const cutoff = last.t - width;
  const i = samples.findIndex((s) => s.t >= cutoff);
  const inside = samples[i];
  if (!inside) return 0;
  const before = samples[i - 1];
  let y0 = inside.y;
  if (before && inside.t > cutoff && inside.t > before.t) y0 = before.y + ((inside.y - before.y) * (cutoff - before.t)) / (inside.t - before.t);
  return (last.y - y0) / width;
}

export interface ReleaseInput {
  /** Clamped downward travel at release (0..panelHeight). */
  readonly offset: number;
  readonly panelHeight: number;
  readonly samples: readonly DragSample[];
}

/** Dismiss on distance beyond 25% of the panel, or fast downward release after at least 24 px of travel. */
export function shouldDismiss({ offset, panelHeight, samples }: ReleaseInput): boolean {
  if (!(panelHeight > 0)) return false;
  if (offset > DISMISS_FRACTION * panelHeight) return true;
  return offset >= MIN_TRAVEL_PX && releaseVelocity(samples) > DISMISS_VELOCITY;
}

export interface DragEnd {
  readonly dismiss: boolean;
  readonly offset: number;
}

export class SheetDrag {
  private pointer: number | null = null;
  private startY = 0;
  private height = 0;
  private samples: DragSample[] = [];
  private offset = 0;

  /** True while exactly one pointer owns the drag. */
  get active(): boolean {
    return this.pointer !== null;
  }

  /** Begins a drag for `pointerId`; a second pointer (or a repeat) is refused. */
  start(pointerId: number, y: number, t: number, panelHeight: number): boolean {
    if (this.pointer !== null || !Number.isFinite(y) || !Number.isFinite(t) || !(panelHeight > 0)) return false;
    this.pointer = pointerId;
    this.startY = y;
    this.height = panelHeight;
    this.samples = [{ t, y }];
    this.offset = 0;
    return true;
  }

  /** Clamped downward offset (0..panel height) for this pointer's move, or null if it is not the owner. */
  move(pointerId: number, y: number, t: number): number | null {
    if (pointerId !== this.pointer || !Number.isFinite(y) || !Number.isFinite(t)) return null;
    this.samples.push({ t, y });
    // Only the final window ever matters; keep a bounded tail (one sample before the cutoff anchors it).
    const cutoff = t - VELOCITY_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1]!.t < cutoff) this.samples.shift();
    this.offset = Math.min(this.height, Math.max(0, y - this.startY));
    return this.offset;
  }

  /** Release: decide dismiss or return. Null if this pointer is not the owner. */
  end(pointerId: number, y: number, t: number): DragEnd | null {
    if (pointerId !== this.pointer) return null;
    if (Number.isFinite(y) && Number.isFinite(t)) this.move(pointerId, y, t);
    const result = { dismiss: shouldDismiss({ offset: this.offset, panelHeight: this.height, samples: this.samples }), offset: this.offset };
    this.reset();
    return result;
  }

  /** Cancellation (or loss of capture) returns to open: never a dismissal. */
  cancel(pointerId?: number): boolean {
    if (this.pointer === null || (pointerId !== undefined && pointerId !== this.pointer)) return false;
    this.reset();
    return true;
  }

  private reset() {
    this.pointer = null;
    this.samples = [];
    this.offset = 0;
  }
}

/** The parts of the sheet presence a gesture drives. */
export interface GesturePresence {
  readonly isWanted: boolean;
  beginDrag(): void;
  dragTo(fraction: number): void;
  returnOpen(): void;
}

export interface PointerLike {
  readonly pointerId: number;
  readonly clientY: number;
  /** High-resolution event time in ms. */
  readonly timeStamp: number;
  readonly isPrimary?: boolean;
  readonly pointerType?: string;
  readonly button?: number;
}

/**
 * Wires pointer events (delivered by the handle element only) to a presence:
 * the sheet follows one primary pointer, and on release either asks the caller
 * to dismiss (synchronously, before any exit motion) or returns to open.
 * Cancellation and lost capture always return to open. Nothing here touches
 * business state.
 */
export class SheetGesture {
  private readonly drag = new SheetDrag();
  private travel = 1;
  private startHeight = 0;
  private pointer: number | null = null;

  constructor(
    private readonly presence: GesturePresence,
    /** Current panel height in CSS px, read when a drag starts. */
    private readonly panelHeight: () => number,
    /** Gap below the panel; the full bottom-origin path is panel height plus this. */
    private readonly bottomGap: number,
    private readonly onDismiss: () => void,
  ) {}

  /** Returns true when the drag began (the caller then captures the pointer). */
  down(e: PointerLike): boolean {
    if (e.isPrimary === false || (e.pointerType === 'mouse' && (e.button ?? 0) !== 0) || !this.presence.isWanted) return false;
    const height = this.panelHeight();
    if (!this.drag.start(e.pointerId, e.clientY, e.timeStamp, height)) return false;
    this.travel = height + this.bottomGap;
    this.startHeight = height;
    this.pointer = e.pointerId;
    this.presence.beginDrag();
    return true;
  }

  move(e: PointerLike): void {
    const offset = this.drag.move(e.pointerId, e.clientY, e.timeStamp);
    if (offset !== null) this.presence.dragTo(offset / this.travel);
  }

  up(e: PointerLike): void {
    const end = this.drag.end(e.pointerId, e.clientY, e.timeStamp);
    if (!end) return;
    this.pointer = null;
    this.presence.dragTo(end.offset / this.travel);
    if (end.dismiss) this.onDismiss();
    else this.presence.returnOpen();
  }

  /** pointercancel or lost capture. */
  cancel(pointerId: number): void {
    if (this.drag.cancel(pointerId)) {
      this.pointer = null;
      this.presence.returnOpen();
    }
  }

  /**
   * The viewport or the panel's geometry changed under an active drag (rotation,
   * resize, keyboard): its start height and travel are no longer the current
   * ones, so the drag is abandoned and the sheet returns to open from where it
   * is. Returns the abandoned pointer (to release its capture), or null if no
   * drag was active.
   */
  invalidate(): number | null {
    const id = this.pointer;
    if (id === null || !this.drag.cancel(id)) return null;
    this.pointer = null;
    this.presence.returnOpen();
    return id;
  }

  /** Panel height observed now; a different height than the drag started with invalidates it. */
  heightChanged(height: number): number | null {
    return this.pointer !== null && Math.abs(height - this.startHeight) > 0.5 ? this.invalidate() : null;
  }
}
