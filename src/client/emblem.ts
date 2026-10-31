import type { SafeSnapshot } from '../shared/records.js';
import type { PendingAction } from './controller.js';
import type { DecorEnv } from './decor.js';
import { ENTER_EASING, ValueTween } from './motion.js';

// The Wintr emblem (header). Pure and environment-injected: nothing here touches
// the DOM, fetches anything or decides business state. What the emblem shows is
// derived only from facts the page already owns (the safe snapshot and the local
// action awaiting admission); how it is drawn is a separate motion layer that
// never gates, delays or replaces any of it.

/**
 * Emblem-specific motion constants, separate from the 19 shared transitions.
 * See MOTION_SPEC.json `theme_update.emblem_extension`.
 */
export const EMBLEM = { rings: 5, fillMs: 600, breathMs: 1800 } as const;

// ---------------------------------------------------------------------------
// Snowflake geometry: six clear arms, one branch tier, a central hexagon
// and six terminal nodes. Five independent bands retain factual stage fill.

type Pt = readonly [number, number];
export interface EmblemRingShape {
  /** Open or closed single-subpath lines, drawn from the inside outwards. */
  readonly lines: readonly string[];
  readonly nodes: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
}

const CENTRE = 64;
const round = (x: number) => Math.round(x * 100) / 100;
const arm = (k: number) => -Math.PI / 2 + (k * Math.PI) / 3;
const at = (angle: number, radius: number): Pt => [round(CENTRE + radius * Math.cos(angle)), round(CENTRE + radius * Math.sin(angle))];
const seg = (a: Pt, b: Pt) => `M${a[0]} ${a[1]}L${b[0]} ${b[1]}`;
const ring = (radius: number) => `${Array.from({ length: 6 }, (_, k) => `${k === 0 ? 'M' : 'L'}${at(arm(k), radius).join(' ')}`).join('')}Z`;
const BRANCH = Math.PI / 3;

function branches(radius: number, length: number): { lines: string[]; nodes: EmblemRingShape['nodes'][number][] } {
  const lines: string[] = [];
  const nodes: EmblemRingShape['nodes'][number][] = [];
  for (let k = 0; k < 6; k++) {
    const origin = at(arm(k), radius);
    for (const sign of [-1, 1]) {
      const a = arm(k) + sign * BRANCH;
      const end: Pt = [round(origin[0] + length * Math.cos(a)), round(origin[1] + length * Math.sin(a))];
      lines.push(seg(origin, end));
    }
  }
  return { lines, nodes };
}

function spines(from: number, to: number, nodeR = 0): { lines: string[]; nodes: EmblemRingShape['nodes'][number][] } {
  const lines: string[] = [];
  const nodes: EmblemRingShape['nodes'][number][] = [];
  for (let k = 0; k < 6; k++) {
    lines.push(seg(at(arm(k), from), at(arm(k), to)));
    const [cx, cy] = at(arm(k), to);
    if (nodeR > 0) nodes.push({ cx, cy, r: nodeR });
  }
  return { lines, nodes };
}

function band(from: number, to: number, branch: { radius: number; length: number } | null, extra: readonly string[] = []): EmblemRingShape {
  const s = spines(from, to);
  const b = branch ? branches(branch.radius, branch.length) : { lines: [], nodes: [] };
  return { lines: [...extra, ...s.lines, ...b.lines], nodes: [...s.nodes, ...b.nodes] };
}

/** Band i completes only from i + 1 closed stages; terminal tips need a verified recording. */
export const EMBLEM_GEOMETRY: readonly EmblemRingShape[] = [
  band(9, 18, null, [ring(9)]),
  band(18, 28, null),
  band(28, 40, { radius: 28, length: 10 }),
  band(40, 50, null),
  spines(50, 56, 1.6),
];

// ---------------------------------------------------------------------------
// Factual progress

export interface EmblemFacts {
  /** Actual local microphone capture, independent of provider stages or completed analysis. */
  readonly captureActive?: boolean;
  readonly snapshot: SafeSnapshot | null;
  /**
   * The one paid action this page awaits (before admission), exactly as workingText reads it. The controller creates a fresh
   * object for every started action and keeps that same object for as long as it is awaited, so its identity (never its kind)
   * tells a repeated render of one action from a later action of the same kind.
   */
  readonly action: PendingAction | null;
  /** pending || stopping || a server-active attempt, as the page already decides. */
  readonly working: boolean;
  readonly stopping: boolean;
  /** Clear, a failed Clear (redaction), a recovery barrier or expiry: no private progress may remain. */
  readonly revoked: boolean;
  /** The controller's local wipe counter (Clear, barrier, revocation, replaced session): a run never survives a new value. */
  readonly wipe: number;
}

export interface EmblemOutput {
  /** Completed closed stages, 0..5. Never time-based. */
  readonly steps: number;
  /** Genuine work is in flight and not being stopped. */
  readonly busy: boolean;
  /** The run's own terminal Attempt produced a NEW owned panel with a nonempty verified choices outcome. Only then steps === 5. */
  readonly found: boolean;
  /** Stop is in progress: any partly drawn fill lands now. */
  readonly halted: boolean;
}

interface Run {
  readonly kind: 'reference' | 'discover' | 'refine';
  readonly live: boolean;
  /** The admitted Attempt this run is bound to; an ACK of any other Attempt starts a new run. */
  readonly handle: string | null;
  /** Highest stage count this run itself demonstrated. */
  readonly steps: number;
  /** The panel that existed when the run began: it can never complete the run. */
  readonly priorPanel: string | null;
  /** The finished Attempt that existed when the run began: until this run's own is observed, it can never complete the run. */
  readonly priorAttempt: string | null;
  /** The opaque session context and controller wipe this run began under: a different value is a different run. */
  readonly context: string;
  readonly wipe: number;
  /** The local action object that started it (null for a run first seen as a server-active Attempt). */
  readonly action: PendingAction | null;
  /** Last observed owned records, including terminal replies which this run rejected. */
  readonly observedAttempt: string | null;
  readonly observedPanel: string | null;
}

export interface EmblemState {
  readonly run: Run | null;
}

export const EMBLEM_START: EmblemState = { run: null };
const BLANK: EmblemOutput = { steps: 0, busy: false, found: false, halted: false };

/** Stages the snapshot's own owned records prove: analysis, relationship, artists, Qloo connection. At most 4. */
export function factSteps(s: SafeSnapshot): number {
  if (!s.analysis) return 0;
  if (!s.brief) return 1;
  if (s.connection === null && !(s.identity !== null && !s.identity.awaiting)) return 2;
  return s.connection ? 4 : 3;
}

const foundNow = (s: SafeSnapshot): boolean => s.stage === 'complete' && s.panel?.outcome === 'choices' && s.panel.choices.length > 0;

/**
 * Pure transition. An attempt's own phases count: the saved reference and relationship it starts from are its inputs, but
 * a retained panel, connection or "ready" status of an OLDER attempt never counts for a newer one (a pending local action
 * ignores the older completed attempt, exactly as workingText does). Human-wait states do not keep it busy.
 *
 * A run belongs to one opaque session context, one controller wipe and one local action object; any other value (replaced
 * session, Clear, barrier, a later action of the same kind) starts over. When it ends, only its OWN terminal Attempt (the
 * one it was bound to or, when no active read was observed, a finished Attempt of its kind that did not exist when it began)
 * can lift it past what it demonstrated, and only that Attempt's succeeded outcome with a NEW current panel of verified
 * nonempty choices yields five. Without that evidence the run keeps exactly the stages it proved: an unchanged older
 * snapshot, a changed unrelated panel or an older analysis never completes or extends it. No-match, failure and cancel hold
 * what was proven and never find. A page that saw no run (a restored session) shows the owned records' state at once.
 */
export function emblemStep(state: EmblemState, f: EmblemFacts): { state: EmblemState; out: EmblemOutput } {
  const s = f.snapshot;
  if (f.captureActive && !f.revoked && !f.stopping) return { state: EMBLEM_START, out: { steps: 0, busy: true, found: false, halted: false } };
  if (f.revoked || !s?.session) return { state: EMBLEM_START, out: BLANK };
  const context = s.session.context;
  let run = state.run && state.run.context === context && state.run.wipe === f.wipe ? state.run : null;
  const closed = s.stage === 'failed' || s.stage === 'cancelled' || s.stage === 'expired' || s.stage === 'no_match';

  if (f.working) {
    const active = s.attempt?.active ? s.attempt : null;
    const kind = f.action?.kind ?? active?.kind ?? (run?.live ? run.kind : 'reference');
    const admitted = active && active.kind === kind ? active : null;
    if (!run || !run.live || run.kind !== kind || (f.action !== null && f.action !== run.action) || (admitted && run.handle !== null && run.handle !== admitted.handle)) {
      run = {
        kind, live: true, handle: null, steps: kind === 'reference' ? 0 : Math.min(2, factSteps(s)), priorPanel: s.panel?.handle ?? null,
        priorAttempt: s.attempt && !s.attempt.active ? s.attempt.handle : null, context, wipe: f.wipe, action: f.action,
        observedAttempt: s.attempt?.handle ?? null, observedPanel: s.panel?.handle ?? null,
      };
    }
    const staged = admitted && kind !== 'reference' ? (s.stage === 'finding_tracks' ? 4 : s.stage === 'retrieving_taste' ? 3 : 0) : 0;
    run = { ...run, handle: run.handle ?? admitted?.handle ?? null, steps: Math.max(run.steps, staged),
      observedAttempt: s.attempt?.handle ?? null, observedPanel: s.panel?.handle ?? null };
    return { state: { run }, out: { steps: run.steps, busy: !f.stopping, found: false, halted: f.stopping } };
  }

  // A completed background/very fast action can arrive without a rendered pending frame. Only a genuinely NEW terminal
  // Attempt after this run already ended becomes a new factual baseline. Remember even rejected terminal records, so
  // reading the same mismatched reply twice can never promote it on the second read.
  const terminal = s.attempt;
  if (run && !run.live && f.action === null && terminal && !terminal.active && terminal.handle !== run.observedAttempt) {
    run = { ...run, kind: terminal.kind, handle: terminal.handle, action: null,
      steps: terminal.kind === 'reference' ? 0 : Math.min(2, factSteps(s)),
      priorAttempt: run.observedAttempt, priorPanel: run.observedPanel };
  }

  if (run === null) {
    const restored = foundNow(s);
    return { state: EMBLEM_START, out: { steps: restored ? 5 : Math.min(4, factSteps(s)), busy: false, found: restored, halted: false } };
  }

  const ended: Run = { ...run, live: false, observedAttempt: s.attempt?.handle ?? null, observedPanel: s.panel?.handle ?? null };
  const a = s.attempt;
  const own = !!a && !a.active && a.kind === ended.kind && (ended.handle !== null ? a.handle === ended.handle : a.handle !== ended.priorAttempt);
  const succeeded = own && a.outcome === 'succeeded';
  const found = succeeded && ended.kind !== 'reference' && foundNow(s) && s.panel?.handle !== ended.priorPanel;
  const steps = found ? 5 : succeeded && !closed ? Math.min(4, factSteps(s)) : ended.steps;
  return { state: { run: ended }, out: { steps, busy: false, found, halted: false } };
}

// ---------------------------------------------------------------------------
// Motion: fill and breath. Draws what the facts say; never decides them.

export interface EmblemWriter {
  /** Visible fill of each ring, 0..1 (continuous while a fill runs, integers at rest). */
  fill(rings: readonly number[]): void;
  /** The in-phase breath 0..1, or null to remove it. */
  breath(value: number | null): void;
}

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

/** Breath value at `elapsedMs`: one sinusoidal 1800 ms cycle from 0 up to 1 and back. */
export const breathAt = (elapsedMs: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * (elapsedMs % EMBLEM.breathMs)) / EMBLEM.breathMs);

export class EmblemMotion {
  private readonly tween: ValueTween;
  private busy = false;
  private suspended = false;
  private frame: number | null = null;
  private origin = 0;
  private epoch = 0;

  constructor(
    private readonly env: DecorEnv,
    private readonly out: EmblemWriter,
  ) {
    this.tween = new ValueTween({
      frames: env.frames,
      nominalMs: EMBLEM.fillMs,
      reducedMotion: env.reducedMotion,
      easing: ENTER_EASING,
      apply: (v) => out.fill(Array.from({ length: EMBLEM.rings }, (_, i) => clamp01(v - i))),
    });
  }

  /** Visible fill in ring units, or null before the first write. */
  get value(): number | null {
    return this.tween.value;
  }

  get breathing(): boolean {
    return this.frame !== null;
  }

  /**
   * The factual completed count. A first value, a decrease (new attempt, Clear, expiry, replacement), reduced motion and a
   * hidden page apply at once; an increase fills from the CURRENT visible value over 600 ms scaled by the remaining path.
   */
  setSteps(n: number): void {
    const current = this.tween.value;
    if (current === null || n < current || this.env.hidden?.()) return this.tween.set(n);
    this.tween.to(n, { nominalMs: EMBLEM.fillMs, fullPath: 1, easing: ENTER_EASING });
  }

  /** Stop, a hidden page or a live reduced-motion change: a partly drawn fill lands on its factual end now. */
  finish(): void {
    this.tween.finish();
  }

  setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    if (busy) this.begin();
    else {
      this.cancel();
      this.out.breath(null);
    }
  }

  visibilityChanged(hidden: boolean): void {
    this.suspended = hidden;
    if (hidden) {
      this.tween.finish();
      this.cancel();
      this.out.breath(null);
    } else if (this.busy && this.frame === null) this.begin();
  }

  reducedMotionChanged(): void {
    if (this.env.reducedMotion()) {
      this.tween.finish();
      this.cancel();
      this.out.breath(null);
    } else if (this.busy && this.frame === null && !this.suspended) this.begin();
  }

  dispose(): void {
    this.busy = false;
    this.tween.cancel();
    this.cancel();
  }

  private begin(): void {
    if (this.suspended || this.env.reducedMotion() || this.env.hidden?.()) return;
    this.origin = this.env.frames.now();
    this.tick();
  }

  private cancel(): void {
    this.epoch += 1;
    if (this.frame !== null) this.env.frames.caf(this.frame);
    this.frame = null;
  }

  private tick(): void {
    this.out.breath(breathAt(this.env.frames.now() - this.origin));
    const epoch = this.epoch;
    this.frame = this.env.frames.raf(() => {
      if (epoch !== this.epoch) return;
      this.frame = null;
      // A page hidden (or reduced) without its event yet delivered must not keep a loop alive; the event resumes it.
      if (this.env.hidden?.() || this.env.reducedMotion()) return void this.out.breath(null);
      this.tick();
    });
  }
}
