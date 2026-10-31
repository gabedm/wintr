import type { Frames } from './motion.js';

export interface DockMeasurement {
  layoutHeight: number;
  visual: { offsetTop: number; height: number } | null;
  dock: { top: number; height: number };
  controlHeight: number;
}
export interface DockClearancePlan {
  top: number;
  bottom: number;
  flow: boolean;
}
const GAP = 8;
const finite = (n: number) => Number.isFinite(n);

/** Root scroll clearance, not another keyboard/layout offset. No guessed keyboard size. */
export function dockClearance(m: DockMeasurement): DockClearancePlan | null {
  if (!finite(m.layoutHeight) || m.layoutHeight <= 0 || !finite(m.dock.top) || !finite(m.dock.height) || m.dock.height <= 0 || !finite(m.controlHeight)) return null;
  if (m.visual && (!finite(m.visual.offsetTop) || !finite(m.visual.height) || m.visual.height <= 0)) return null;
  const top = Math.max(0, m.visual?.offsetTop ?? 0);
  const visibleBottom = Math.min(m.layoutHeight, top + (m.visual?.height ?? m.layoutHeight));
  if (visibleBottom <= top) return null;
  // Capacity depends on intrinsic heights, never the dock's sticky/flow top:
  // changing position cannot feed back into the decision and oscillate it.
  const flow = m.dock.height + Math.max(44, m.controlHeight) + 2 * GAP > visibleBottom - top;
  const lowerBound = flow ? visibleBottom : Math.min(visibleBottom, Math.max(top, m.dock.top));
  return { top: Math.ceil(top + GAP), bottom: Math.ceil(m.layoutHeight - lowerBound + GAP), flow };
}

/** Coalesced measurement only. Never focuses or scrolls, including after restore/user scrolling. */
export class DockClearance {
  private frame: number | null = null;
  private stopped = false;
  private last: DockClearancePlan | null = null;
  constructor(private readonly deps: {
    frames: Pick<Frames, 'raf' | 'caf'>;
    read(): DockMeasurement | null;
    apply(plan: DockClearancePlan): void;
  }) {}
  measure() {
    if (this.stopped) return;
    const m = this.deps.read();
    const next = m && dockClearance(m);
    if (!next || (this.last && next.top === this.last.top && next.bottom === this.last.bottom && next.flow === this.last.flow)) return;
    const positionChanged = this.last === null || this.last.flow !== next.flow;
    this.last = next;
    this.deps.apply(next);
    // The positional mode may change top without resizing the box; sample its
    // new position once next frame, rather than relying on a ResizeObserver.
    if (positionChanged) this.changed();
  }
  changed() {
    if (this.stopped || this.frame !== null) return;
    this.frame = this.deps.frames.raf(() => { this.frame = null; this.measure(); });
  }
  dispose() {
    this.stopped = true;
    if (this.frame !== null) this.deps.frames.caf(this.frame);
    this.frame = null;
  }
}
