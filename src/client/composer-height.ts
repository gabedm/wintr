import { ValueTween, type Frames } from './motion.js';

/** Absolute maximum of the editable box; at 24 px lines this is six rendered lines. */
export const EDITOR_CAP_PX = 144;
export const EDITOR_LINE_PX = 24;
export const COMPOSER_HEIGHT_MS = 160;

/** Natural content height clamped to the single-line minimum and the absolute cap. */
export function editorTarget(scrollHeight: number, capPx: number = EDITOR_CAP_PX, minPx: number = EDITOR_LINE_PX): number {
  const cap = Math.min(EDITOR_CAP_PX, Number.isFinite(capPx) && capPx > 0 ? capPx : EDITOR_CAP_PX);
  if (!Number.isFinite(scrollHeight)) return minPx;
  return Math.round(Math.min(cap, Math.max(minPx, scrollHeight)));
}

/** The parts of the editable box the measurement touches (a textarea in the browser). */
export interface EditorLike {
  readonly style: { height: string };
  scrollTop: number;
  readonly scrollHeight: number;
}

/**
 * Measures the natural height of the editable box and feeds ComposerHeight.
 * Used for draft changes and for layout changes that rewrap the same draft
 * (width, orientation, zoom, font loading). Measuring restores the visual height
 * and the internal scroll position, and never touches the value, caret or
 * selection. Width is the only layout input watched from the element itself, so
 * this class's own height writes can never trigger another measurement.
 */
export class ComposerLayout {
  private width: number | null = null;

  constructor(
    private readonly editor: EditorLike,
    private readonly capPx: () => number,
    private readonly height: ComposerHeight,
    private readonly composing: () => boolean,
  ) {}

  measure(): void {
    const e = this.editor;
    const top = e.scrollTop;
    const visual = e.style.height;
    e.style.height = 'auto';
    const natural = e.scrollHeight;
    e.style.height = visual;
    e.scrollTop = top;
    const cap = this.capPx();
    this.height.request(Number.isFinite(cap) ? Math.min(natural, cap) : natural, { composing: this.composing() });
  }

  /** A native viewport/keyboard move: finish the old motion, then re-measure; applied directly while the viewport is moving. */
  viewportMoved(): void {
    this.height.viewportMoved();
    this.measure();
  }

  /** Observed inline size of the editor. Height-only changes (our own writes) are ignored. Returns whether it re-measured. */
  widthChanged(width: number): boolean {
    const previous = this.width;
    if (previous !== null && Math.abs(width - previous) < 0.5) return false;
    this.width = width;
    if (previous === null) return false;
    this.measure();
    return true;
  }
}

export interface ComposerHeightDeps {
  readonly frames: Frames;
  /** Writes the editable box height. */
  readonly apply: (px: number) => void;
  readonly reducedMotion: () => boolean;
  /** True while a native viewport/keyboard move is in progress. */
  readonly viewportMoving: () => boolean;
}

/**
 * Retargets the editable box height from its current visual height over the
 * locked 160 ms `standard` motion. It is applied directly (no tween) during a
 * native viewport move, during IME composition and under reduced motion, and a
 * viewport move or a live reduced-motion change finishes any running tween.
 * Nothing here gates sending, Stop or Clear.
 */
export class ComposerHeight {
  private readonly tween: ValueTween;

  constructor(private readonly deps: ComposerHeightDeps) {
    this.tween = new ValueTween({ frames: deps.frames, nominalMs: COMPOSER_HEIGHT_MS, apply: deps.apply, reducedMotion: deps.reducedMotion });
  }

  /** Current visual height, or null before the first measurement. */
  get visual(): number | null {
    return this.tween.value;
  }

  get animating(): boolean {
    return this.tween.running;
  }

  request(naturalPx: number, state: { composing: boolean }): void {
    const target = editorTarget(naturalPx);
    this.tween.to(target, { immediate: state.composing || this.deps.viewportMoving() });
  }

  viewportMoved(): void {
    this.tween.finish();
  }

  reducedMotionChanged(): void {
    if (this.deps.reducedMotion()) this.tween.finish();
  }

  dispose(): void {
    this.tween.cancel();
  }
}
