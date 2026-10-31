import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { ConnectionPanel, connectionPreview } from '../src/client/discovery.js';
import { tabWrapTarget } from '../src/client/focus.js';
import { holdIdentity, openOverlay, overlayWants, recordingEvidence, resolveWhy, whyIdentity, whyLines, type AuthorityContext, type Overlay, type WhyView } from '../src/client/overlay.js';
import { DrawerPresence, DRAWER_MS, SHEET_MS, type DrawerProgress } from '../src/client/presence.js';
import { DISMISS_VELOCITY, releaseVelocity, SheetDrag, SheetGesture, shouldDismiss, type PointerLike } from '../src/client/sheet-drag.js';
import { SheetLayer, WhyContent, WhyFooter } from '../src/client/WhySheet.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// The contextual Why sheet: its reusable presence and gesture cores, the privacy
// rule that its content always resolves from the CURRENT accepted state, and its
// markup contract. Logic tests over fakes and server rendering: real focus,
// inertness, pointer capture, scrolling, rotation and frame pacing on a browser
// or a phone are separate acceptance.

const H = (s: string) => s.padEnd(24, '0') as Handle;

// ---------------------------------------------------------------------------
// Presence (M06.sheet timings)

function sheet(reduced = false) {
  const frames = new FakeFrames();
  const flags = { reduced };
  const writes: DrawerProgress[] = [];
  const mounts: boolean[] = [];
  const p = new DrawerPresence({ frames, ms: SHEET_MS, reducedMotion: () => flags.reduced, write: (w) => writes.push(w), onMounted: (m) => mounts.push(m) });
  return { frames, flags, writes, mounts, p };
}

describe('sheet presence: locked durations and current-value reversal', () => {
  it('enters over 360 ms (scrim 220 ms) and exits over 260 ms (scrim 180 ms), mounted at once', () => {
    const { frames, mounts, p } = sheet();
    p.open();
    expect(mounts).toEqual([true]);
    frames.step(SHEET_MS.scrimEnter);
    expect(p.progress.scrim).toBe(1);
    expect(p.progress.panel).toBeLessThan(1);
    frames.step(SHEET_MS.enter - SHEET_MS.scrimEnter - 1);
    expect(p.progress.panel).toBeLessThan(1);
    frames.step(1);
    expect(p.progress).toEqual({ panel: 1, scrim: 1 });

    p.close();
    frames.step(SHEET_MS.scrimExit);
    expect(p.progress.scrim).toBe(0);
    expect(p.progress.panel).toBeGreaterThan(0);
    expect(mounts).toEqual([true]);
    frames.step(SHEET_MS.exit - SHEET_MS.scrimExit);
    expect(p.progress).toEqual({ panel: 0, scrim: 0 });
    expect(mounts).toEqual([true, false]);
  });

  it('the sheet and the drawer keep their own locked timings', () => {
    expect([SHEET_MS.enter, SHEET_MS.exit, SHEET_MS.scrimEnter, SHEET_MS.scrimExit, SHEET_MS.dragReturn]).toEqual([360, 260, 220, 180, 220]);
    expect([DRAWER_MS.enter, DRAWER_MS.exit, DRAWER_MS.scrimEnter, DRAWER_MS.scrimExit]).toEqual([300, 220, 220, 180]);
  });

  it('reverses from the current position over the scaled remaining path, in both directions, without a jump', () => {
    const entering = sheet();
    entering.p.open();
    entering.frames.step(120);
    const mid = entering.p.progress.panel;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    const before = entering.writes.length;
    entering.p.close();
    expect(entering.p.progress.panel).toBe(mid);
    expect(entering.writes.length).toBe(before);
    entering.frames.step(SHEET_MS.exit * mid - 1);
    expect(entering.p.progress.panel).toBeGreaterThan(0);
    entering.frames.step(1);
    expect(entering.p.progress.panel).toBe(0);

    const leaving = sheet();
    leaving.p.open();
    leaving.frames.run(500);
    leaving.p.close();
    leaving.frames.step(SHEET_MS.exit / 2);
    const back = leaving.p.progress.panel;
    leaving.p.open();
    expect(leaving.p.progress.panel).toBe(back);
    leaving.frames.step(SHEET_MS.enter * (1 - back) - 1);
    expect(leaving.p.progress.panel).toBeLessThan(1);
    leaving.frames.step(1);
    expect(leaving.p.progress.panel).toBe(1);
    expect(leaving.p.mounted).toBe(true);
  });

  it('reduced motion places it at once; a live change mid-flight finishes the spatial motion; a hidden document lands on the end state', () => {
    const r = sheet(true);
    r.p.open();
    expect(r.p.progress).toEqual({ panel: 1, scrim: 1 });
    expect(r.frames.queue.size).toBe(0);
    r.p.close();
    expect(r.mounts).toEqual([true, false]);

    const mid = sheet();
    mid.p.open();
    mid.frames.step(100);
    mid.flags.reduced = true;
    mid.p.reducedMotionChanged();
    expect(mid.p.progress).toEqual({ panel: 1, scrim: 1 });
    expect(mid.frames.queue.size).toBe(0);

    const hidden = sheet();
    hidden.p.open();
    hidden.frames.run(500);
    hidden.p.close();
    hidden.frames.step(60);
    hidden.p.visibilityChanged(false);
    expect(hidden.p.animating).toBe(true);
    hidden.p.visibilityChanged(true);
    expect(hidden.p.progress).toEqual({ panel: 0, scrim: 0 });
    expect(hidden.mounts.at(-1)).toBe(false);
    expect(hidden.frames.queue.size).toBe(0);
  });
});

describe('sheet presence: drag, return and revoked authority', () => {
  function open() {
    const t = sheet();
    t.p.open();
    t.frames.run(600);
    return t;
  }

  it('a drag takes over from the current position (no jump), follows the pointer, clamps, and moves the scrim with it', () => {
    const t = sheet();
    t.p.open();
    t.frames.step(100);
    const at = t.p.progress;
    t.p.beginDrag();
    expect(t.p.progress).toEqual(at);
    expect(t.p.animating).toBe(false);
    t.frames.run(500);
    expect(t.p.progress).toEqual(at);

    const o = open();
    o.p.beginDrag();
    o.p.dragTo(0.3);
    expect(o.p.progress).toEqual({ panel: 0.7, scrim: 0.7 });
    o.p.dragTo(-2);
    expect(o.p.progress).toEqual({ panel: 1, scrim: 1 });
    o.p.dragTo(7);
    expect(o.p.progress).toEqual({ panel: 0, scrim: 0 });
  });

  it('an undismissed or cancelled drag returns to open in exactly 220 ms from any distance', () => {
    for (const fraction of [0.1, 0.3, 0.9]) {
      const t = open();
      t.p.beginDrag();
      t.p.dragTo(fraction);
      t.p.returnOpen();
      expect(t.p.progress.panel).toBeCloseTo(1 - fraction, 10);
      t.frames.step(SHEET_MS.dragReturn! - 1);
      expect(t.p.progress.panel).toBeLessThan(1);
      t.frames.step(1);
      expect(t.p.progress).toEqual({ panel: 1, scrim: 1 });
    }
    const r = sheet(true);
    r.p.open();
    r.p.beginDrag();
    r.p.dragTo(0.4);
    r.p.returnOpen();
    expect(r.p.progress).toEqual({ panel: 1, scrim: 1 });
    expect(r.frames.queue.size).toBe(0);
  });

  it('a dismissing release exits from the dragged position over the scaled remaining path', () => {
    const t = open();
    t.p.beginDrag();
    t.p.dragTo(0.6);
    t.p.close();
    expect(t.p.progress.panel).toBeCloseTo(0.4, 10);
    t.frames.step(SHEET_MS.exit * 0.4 - 1);
    expect(t.p.progress.panel).toBeGreaterThan(0);
    t.frames.step(1);
    expect(t.p.progress.panel).toBe(0);
    expect(t.mounts.at(-1)).toBe(false);
  });

  it('once no longer wanted (Escape, Close, Clear) a late drag or return changes nothing', () => {
    const t = open();
    t.p.beginDrag();
    t.p.dragTo(0.2);
    t.p.close();
    const at = t.p.progress;
    t.p.dragTo(0.9);
    t.p.returnOpen();
    expect(t.p.progress).toEqual(at);
    expect(t.p.isWanted).toBe(false);
  });

  it('revoked authority removes the picture at 0 ms with no exit motion, and no stale frame can write afterwards', () => {
    const t = sheet();
    t.p.open();
    t.frames.step(120);
    const writes = t.writes.length;
    t.p.hardClose();
    expect(t.p.progress).toEqual({ panel: 0, scrim: 0 });
    expect(t.p.mounted).toBe(false);
    expect(t.mounts.at(-1)).toBe(false);
    expect(t.frames.queue.size).toBe(0);
    const after = t.writes.length;
    expect(after).toBeGreaterThan(writes);
    t.frames.run(1000);
    expect(t.writes).toHaveLength(after);
    // Exiting from a normal close is also removed at once when revoked mid-exit.
    const exiting = open();
    exiting.p.close();
    exiting.frames.step(40);
    expect(exiting.p.mounted).toBe(true);
    exiting.p.hardClose();
    expect(exiting.p.mounted).toBe(false);
    expect(exiting.frames.queue.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Drag decisions

describe('release velocity and dismissal thresholds', () => {
  const s = (...pairs: [number, number][]) => pairs.map(([t, y]) => ({ t, y }));

  it('samples only the final 80 ms, or every sample when the drag is shorter', () => {
    // Slow for 500 ms then fast: only the last 80 ms count.
    expect(releaseVelocity(s([0, 0], [250, 10], [500, 20], [540, 60], [580, 100]))).toBeCloseTo((100 - 20) / 80, 5);
    expect(releaseVelocity(s([0, 0], [250, 10], [505, 20], [520, 20], [580, 100]))).toBeCloseTo((100 - (10 + (10 * 250) / 255)) / 80, 5);
    // Fast early, then stopped for more than 80 ms: released at rest.
    expect(releaseVelocity(s([0, 0], [20, 100], [40, 200], [200, 200], [300, 200]))).toBe(0);
    // A drag shorter than the window uses all its samples.
    expect(releaseVelocity(s([0, 0], [30, 30], [60, 60]))).toBeCloseTo(1, 5);
    expect(releaseVelocity(s([10, 5]))).toBe(0);
    expect(releaseVelocity([])).toBe(0);
    // Upward motion is negative.
    expect(releaseVelocity(s([0, 100], [50, 40]))).toBeLessThan(0);
  });

  it('uses the boundary position for sparse samples: a steady 0.9 px/ms trajectory is 0.9 however few samples there are', () => {
    // Only two samples, 100 ms apart: the old behaviour saw just the release inside the window and read 0.
    expect(releaseVelocity(s([0, 0], [100, 90]))).toBeCloseTo(0.9, 10);
    expect(releaseVelocity(s([0, 0], [50, 45], [200, 180]))).toBeCloseTo(0.9, 10);
    expect(releaseVelocity(s([0, 0], [400, 360]))).toBeCloseTo(0.9, 10);
    // The same sparse trajectory dismisses after at least 24 px, and not below it.
    expect(shouldDismiss({ offset: 90, panelHeight: 1000, samples: s([0, 0], [100, 90]) })).toBe(true);
    expect(shouldDismiss({ offset: 20, panelHeight: 1000, samples: s([0, 0], [20, 18]) })).toBe(false);
    // A sparse release below the threshold still returns: 0.7 px/ms.
    expect(shouldDismiss({ offset: 70, panelHeight: 1000, samples: s([0, 0], [100, 70]) })).toBe(false);
  });

  it('older fast movement followed by a stationary final window is released at rest, even with sparse samples', () => {
    expect(releaseVelocity(s([0, 0], [50, 200], [400, 200]))).toBe(0);
    expect(releaseVelocity(s([0, 0], [10, 300], [500, 300], [560, 300]))).toBe(0);
    expect(shouldDismiss({ offset: 200, panelHeight: 1000, samples: s([0, 0], [50, 200], [400, 200]) })).toBe(false);
    // Partly inside: the boundary lies halfway through a slow-then-still segment.
    expect(releaseVelocity(s([0, 0], [100, 80], [180, 80]))).toBeCloseTo(0, 10);
  });

  it('duplicate timestamps never divide by zero or invent speed', () => {
    expect(releaseVelocity(s([100, 0], [100, 50]))).toBe(0);
    // The boundary (t=20) lies between the first sample and the duplicated pair: interpolated from the sample before it.
    expect(releaseVelocity(s([0, 0], [100, 40], [100, 90]))).toBeCloseTo((90 - 8) / 80, 10);
    // A duplicated first timestamp does not disturb the interpolation after it.
    expect(releaseVelocity(s([0, 0], [0, 40], [100, 90]))).toBeCloseTo((90 - 50) / 80, 10);
    expect(Number.isFinite(releaseVelocity(s([0, 0], [50, 10], [50, 30], [50, 60], [130, 120])))).toBe(true);
  });

  it('dismisses beyond 25% of the current panel height, not at it', () => {
    const rest = s([0, 0], [300, 100], [600, 100]);
    expect(shouldDismiss({ offset: 100, panelHeight: 400, samples: rest })).toBe(false);
    expect(shouldDismiss({ offset: 100.5, panelHeight: 400, samples: rest })).toBe(true);
    expect(shouldDismiss({ offset: 120, panelHeight: 400, samples: rest })).toBe(true);
    expect(shouldDismiss({ offset: 100.5, panelHeight: 0, samples: rest })).toBe(false);
  });

  it('dismisses on a fast downward release only after at least 24 px of travel, and only above 0.8 px/ms', () => {
    const fast = (travel: number, ms: number) => s([0, 0], [ms, travel]);
    expect(shouldDismiss({ offset: 30, panelHeight: 1000, samples: fast(30, 30) })).toBe(true);
    // Exactly 0.8 px/ms is not above the threshold.
    expect(shouldDismiss({ offset: 40, panelHeight: 1000, samples: fast(40, 50) })).toBe(false);
    expect(shouldDismiss({ offset: 41, panelHeight: 1000, samples: fast(41, 50) })).toBe(true);
    // Fast but short of 24 px: never.
    expect(shouldDismiss({ offset: 23, panelHeight: 1000, samples: fast(23, 10) })).toBe(false);
    expect(shouldDismiss({ offset: 24, panelHeight: 1000, samples: fast(24, 10) })).toBe(true);
    // Slow and short of a quarter: returns.
    expect(shouldDismiss({ offset: 60, panelHeight: 1000, samples: fast(60, 600) })).toBe(false);
    expect(DISMISS_VELOCITY).toBe(0.8);
  });

  it('SheetDrag: one pointer only, clamped 0..height, velocity from the final window, cancel never dismisses', () => {
    const d = new SheetDrag();
    expect(d.start(1, 100, 0, 400)).toBe(true);
    expect(d.start(2, 100, 0, 400)).toBe(false);
    expect(d.move(2, 300, 10)).toBeNull();
    expect(d.move(1, 50, 20)).toBe(0);
    expect(d.move(1, 700, 30)).toBe(400);
    expect(d.move(1, 160, 40)).toBe(60);
    expect(d.end(2, 160, 50)).toBeNull();
    expect(d.end(1, 160, 300)).toEqual({ dismiss: false, offset: 60 });
    expect(d.active).toBe(false);

    // Slow for a long time, then a fast final 80 ms past 24 px: dismisses on velocity alone.
    expect(d.start(3, 0, 0, 1000)).toBe(true);
    for (let t = 100; t <= 900; t += 100) d.move(3, t / 100, t);
    d.move(3, 10, 920);
    expect(d.end(3, 100, 980)).toEqual({ dismiss: true, offset: 100 });

    expect(d.start(4, 0, 0, 400)).toBe(true);
    d.move(4, 390, 10);
    expect(d.cancel(9)).toBe(false);
    expect(d.cancel(4)).toBe(true);
    expect(d.end(4, 390, 20)).toBeNull();
    expect(d.active).toBe(false);
    expect(d.start(5, Number.NaN, 0, 400)).toBe(false);
    expect(d.start(6, 0, 0, 0)).toBe(false);
  });
});

describe('sheet gesture over a real presence', () => {
  function gesture(height = 400) {
    const t = sheet();
    t.p.open();
    t.frames.run(600);
    const dismissed = vi.fn(() => t.p.close());
    const g = new SheetGesture(t.p, () => height, 8, dismissed);
    const ev = (over: Partial<PointerLike> & { clientY: number; timeStamp: number }): PointerLike => ({ pointerId: 1, isPrimary: true, pointerType: 'touch', button: 0, ...over });
    return { ...t, g, dismissed, ev, height };
  }

  it('follows one pointer with the scrim, then a drag past a quarter dismisses (authority first) and exits from there', () => {
    const t = gesture();
    expect(t.g.down(t.ev({ clientY: 10, timeStamp: 0 }))).toBe(true);
    t.g.move(t.ev({ clientY: 60, timeStamp: 200 }));
    expect(t.p.progress.panel).toBeCloseTo(1 - 50 / 408, 10);
    expect(t.p.progress.scrim).toBeCloseTo(1 - 50 / 408, 10);
    t.g.move(t.ev({ clientY: 160, timeStamp: 600 }));
    t.g.up(t.ev({ clientY: 160, timeStamp: 900 }));
    expect(t.dismissed).toHaveBeenCalledTimes(1);
    expect(t.p.isWanted).toBe(false);
    const at = t.p.progress.panel;
    expect(at).toBeCloseTo(1 - 150 / 408, 10);
    t.frames.step(SHEET_MS.exit * at - 1);
    expect(t.p.progress.panel).toBeGreaterThan(0);
    t.frames.step(1);
    expect(t.p.progress.panel).toBe(0);
  });

  it('a short, slow drag returns to open over 220 ms and never dismisses', () => {
    const t = gesture();
    t.g.down(t.ev({ clientY: 0, timeStamp: 0 }));
    t.g.move(t.ev({ clientY: 60, timeStamp: 500 }));
    t.g.up(t.ev({ clientY: 60, timeStamp: 1000 }));
    expect(t.dismissed).not.toHaveBeenCalled();
    expect(t.p.isWanted).toBe(true);
    t.frames.step(SHEET_MS.dragReturn!);
    expect(t.p.progress).toEqual({ panel: 1, scrim: 1 });
  });

  it('a fast flick dismisses; a pointer cancellation or lost capture returns to open', () => {
    const flick = gesture();
    flick.g.down(flick.ev({ clientY: 0, timeStamp: 0 }));
    flick.g.move(flick.ev({ clientY: 50, timeStamp: 40 }));
    flick.g.up(flick.ev({ clientY: 90, timeStamp: 80 }));
    expect(flick.dismissed).toHaveBeenCalledTimes(1);

    const cancelled = gesture();
    cancelled.g.down(cancelled.ev({ clientY: 0, timeStamp: 0 }));
    cancelled.g.move(cancelled.ev({ clientY: 350, timeStamp: 100 }));
    cancelled.g.cancel(1);
    expect(cancelled.dismissed).not.toHaveBeenCalled();
    cancelled.frames.step(SHEET_MS.dragReturn!);
    expect(cancelled.p.progress).toEqual({ panel: 1, scrim: 1 });
    // A release after cancellation is not a second decision.
    cancelled.g.up(cancelled.ev({ clientY: 350, timeStamp: 200 }));
    expect(cancelled.dismissed).not.toHaveBeenCalled();
  });

  it('a second pointer, a secondary mouse button and a non-primary pointer never start or steer a drag', () => {
    const t = gesture();
    expect(t.g.down(t.ev({ clientY: 0, timeStamp: 0, pointerType: 'mouse', button: 2 }))).toBe(false);
    expect(t.g.down(t.ev({ clientY: 0, timeStamp: 0, isPrimary: false }))).toBe(false);
    expect(t.g.down(t.ev({ clientY: 0, timeStamp: 0 }))).toBe(true);
    expect(t.g.down(t.ev({ pointerId: 2, clientY: 0, timeStamp: 0 }))).toBe(false);
    t.g.move(t.ev({ pointerId: 2, clientY: 399, timeStamp: 10 }));
    expect(t.p.progress.panel).toBe(1);
    t.g.up(t.ev({ pointerId: 2, clientY: 399, timeStamp: 20 }));
    expect(t.dismissed).not.toHaveBeenCalled();
  });

  it('nothing starts once the sheet is no longer wanted, and reduced motion snaps either endpoint with no spring', () => {
    const closed = gesture();
    closed.p.close();
    expect(closed.g.down(closed.ev({ clientY: 0, timeStamp: 0 }))).toBe(false);

    const reduced = gesture();
    reduced.flags.reduced = true;
    reduced.g.down(reduced.ev({ clientY: 0, timeStamp: 0 }));
    reduced.g.move(reduced.ev({ clientY: 40, timeStamp: 500 }));
    reduced.g.up(reduced.ev({ clientY: 40, timeStamp: 1000 }));
    expect(reduced.p.progress).toEqual({ panel: 1, scrim: 1 });
    expect(reduced.frames.queue.size).toBe(0);
    reduced.g.down(reduced.ev({ clientY: 0, timeStamp: 2000 }));
    reduced.g.move(reduced.ev({ clientY: 300, timeStamp: 2100 }));
    reduced.g.up(reduced.ev({ clientY: 300, timeStamp: 2200 }));
    expect(reduced.p.progress).toEqual({ panel: 0, scrim: 0 });
    expect(reduced.frames.queue.size).toBe(0);
  });
});

describe('sheet gesture interrupted entrance', () => {
  function entering() {
    const t = sheet();
    t.p.open();
    t.frames.step(100);
    const origin = t.p.progress;
    const staleEntrance = [...t.frames.queue.values()];
    const dismissed = vi.fn(() => t.p.close());
    const g = new SheetGesture(t.p, () => 400, 8, dismissed);
    const ev = (clientY: number, timeStamp: number): PointerLike => ({ pointerId: 1, clientY, timeStamp, pointerType: 'touch', isPrimary: true });
    return { ...t, origin, staleEntrance, dismissed, g, ev };
  }

  function displaced(t: ReturnType<typeof entering>, px: number, origin = t.origin) {
    expect((1 - t.p.progress.panel) * 408).toBeCloseTo((1 - origin.panel) * 408 + px, 9);
    expect(t.p.progress.scrim).toBeCloseTo(Math.max(0, origin.scrim - px / 408), 9);
  }

  it('keeps the separate panel/scrim origins on first and continued movement, including a return towards the drag start', () => {
    const t = entering();
    expect(t.origin.panel).not.toBe(t.origin.scrim);
    expect(t.g.down(t.ev(0, 100))).toBe(true);
    expect(t.p.progress).toEqual(t.origin);
    t.g.move(t.ev(1, 110)); displaced(t, 1);
    t.g.move(t.ev(60, 300)); displaced(t, 60);
    t.g.move(t.ev(15, 400)); displaced(t, 15);
    t.g.move(t.ev(-10, 500)); displaced(t, 0);
  });

  it('counts only pointer travel for dismissal and returns from the dragged values over the locked 220 ms', () => {
    const t = entering();
    t.g.down(t.ev(0, 100));
    t.g.move(t.ev(40, 400)); displaced(t, 40);
    // Entrance offset plus 40 px exceeds a quarter of the sheet, but this slow
    // 40 px user drag is below the dismissal threshold and must return.
    expect((1 - t.p.progress.panel) * 408).toBeGreaterThan(100);
    const released = t.p.progress;
    t.g.up(t.ev(40, 700));
    expect(t.dismissed).not.toHaveBeenCalled();
    expect(t.p.progress).toEqual(released);
    t.frames.step(219);
    expect(t.p.progress.panel).toBeGreaterThan(released.panel);
    expect(t.p.progress.panel).toBeLessThan(1);
    expect(t.p.progress.scrim).toBeGreaterThan(released.scrim);
    expect(t.p.progress.scrim).toBeLessThan(1);
    t.frames.step(1);
    expect(t.p.progress).toEqual({ panel: 1, scrim: 1 });
  });

  it('old entrance frames cannot move the dragged sheet or overwrite its return', () => {
    const t = entering();
    t.g.down(t.ev(0, 100));
    t.g.move(t.ev(30, 300)); displaced(t, 30);
    const dragged = t.p.progress;
    const writes = t.writes.length;
    t.staleEntrance.forEach(frame => frame());
    expect(t.p.progress).toEqual(dragged);
    expect(t.writes).toHaveLength(writes);
    t.g.up(t.ev(30, 600));
    t.frames.step(80);
    const returning = t.p.progress;
    t.staleEntrance.forEach(frame => frame());
    expect(t.p.progress).toEqual(returning);
    t.frames.step(140);
    expect(t.p.progress).toEqual({ panel: 1, scrim: 1 });
  });

  it('a new drag can interrupt snap-back using both current return values', () => {
    const t = entering();
    t.g.down(t.ev(0, 100));
    t.g.move(t.ev(40, 400)); displaced(t, 40);
    t.g.up(t.ev(40, 700)); t.frames.step(80);
    const returning = t.p.progress;
    const staleReturn = [...t.frames.queue.values()];
    t.g.down(t.ev(0, 800));
    expect(t.p.progress).toEqual(returning);
    t.g.move(t.ev(1, 810)); displaced(t, 1, returning);
    const dragged = t.p.progress;
    staleReturn.forEach(frame => frame());
    expect(t.p.progress).toEqual(dragged);
    t.g.cancel(1);
    expect(t.p.progress).toEqual(dragged);
    t.frames.step(220);
    expect(t.p.progress).toEqual({ panel: 1, scrim: 1 });
  });

  it('reduced motion snaps a release to open and invalidates an interrupted return frame', () => {
    const release = entering();
    release.g.down(release.ev(0, 100));
    release.g.move(release.ev(40, 400)); displaced(release, 40);
    release.flags.reduced = true;
    release.g.up(release.ev(40, 700));
    expect(release.p.progress).toEqual({ panel: 1, scrim: 1 });
    expect(release.frames.queue.size).toBe(0);
    expect(release.dismissed).not.toHaveBeenCalled();

    const returning = entering();
    returning.g.down(returning.ev(0, 100));
    returning.g.move(returning.ev(40, 400)); displaced(returning, 40);
    returning.g.up(returning.ev(40, 700)); returning.frames.step(80);
    const staleReturn = [...returning.frames.queue.values()];
    returning.flags.reduced = true; returning.p.reducedMotionChanged();
    expect(returning.p.progress).toEqual({ panel: 1, scrim: 1 });
    staleReturn.forEach(frame => frame());
    expect(returning.p.progress).toEqual({ panel: 1, scrim: 1 });
    expect(returning.frames.queue.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Privacy: content resolves from the current accepted snapshot only

const connection = (over: Partial<NonNullable<SafeSnapshot['connection']>> = {}): NonNullable<SafeSnapshot['connection']> => ({
  synthetic: true,
  seeds: ['Generic Artist'],
  artists: ['Neighbour X11', 'Neighbour X12'],
  anchors: [
    { handle: H('anchor11'), name: 'Neighbour X11' },
    { handle: H('anchor12'), name: 'Neighbour X12' },
  ],
  tags: [],
  capability: 'artists_only',
  attribution: 'seed_mix',
  why: ['You chose to keep: “the groove”.', 'Starting artist: Generic Artist.', 'No recording has been checked yet.'],
  ...over,
});

const snap = (over: Partial<SafeSnapshot> = {}): SafeSnapshot => ({
  mode: 'synthetic',
  session: { context: 'ctx-a', expiresAt: 9_999_999 },
  stage: 'finding_tracks',
  revision: 3,
  status: null,
  attempt: null,
  reference: null,
  listenerCue: null,
  analysis: null,
  brief: { handle: H('brief1'), version: 1, relationship: 'the groove', source: 'analysis_choice', artists: ['Generic Artist'] },
  identity: null,
  connection: connection(),
  panel: null,
  history: [],
  refinement: null,
  code: null,
  ...over,
});

const ctx = (snapshot: SafeSnapshot | null, over: Partial<AuthorityContext> = {}): AuthorityContext => ({ snapshot, clearing: false, redacted: false, ...over });

describe('Why sheet content resolves from the current accepted state', () => {
  it('stores only an opaque identity: no names, reasons or provider data', () => {
    const id = whyIdentity(snap())!;
    expect(id).toContain('ctx-a');
    for (const leaked of ['Neighbour', 'Generic', 'groove', 'Qloo', 'reason']) expect(id).not.toContain(leaked);
    const overlay: Overlay = { kind: 'why', identity: id };
    expect(Object.keys(overlay).sort()).toEqual(['identity', 'kind']);
  });

  it('shows the current connection, and updates in place for the same connection (a result arriving changes the evidence, not the sheet)', () => {
    const id = whyIdentity(snap())!;
    const before = resolveWhy(id, ctx(snap()));
    expect(before?.connection.artists).toEqual(['Neighbour X11', 'Neighbour X12']);
    expect(before?.recordings).toBeNull();
    const panel = { handle: H('panel1'), synthetic: true, role: 'initial', mode: null, basis: [], outcome: 'no_match', choices: [], answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] } as unknown as SafeSnapshot['panel'];
    const after = resolveWhy(id, ctx(snap({ revision: 4, panel })));
    expect(after?.recordings).toEqual({ outcome: 'no_match', count: 0, refined: false, synthetic: true });
  });

  it.each([
    ['Clear in progress', (s: SafeSnapshot) => ctx(s, { clearing: true })],
    ['a failed Clear (redacted)', (s: SafeSnapshot) => ctx(s, { redacted: true })],
    ['no snapshot', () => ctx(null)],
    ['an expired or revoked session', (s: SafeSnapshot) => ctx({ ...s, session: null, connection: null, brief: null })],
    ['a replaced session', (s: SafeSnapshot) => ctx({ ...s, session: { context: 'ctx-b', expiresAt: 9_999_999 } })],
    ['a replaced brief', (s: SafeSnapshot) => ctx({ ...s, brief: { ...s.brief!, handle: H('brief2'), version: 2 } })],
    ['a replaced connection (new pool)', (s: SafeSnapshot) => ctx({ ...s, connection: connection({ anchors: [{ handle: H('anchor99'), name: 'Neighbour X99' }] }) })],
    ['a removed connection', (s: SafeSnapshot) => ctx({ ...s, connection: null })],
  ])('resolves nothing after %s', (_label, make) => {
    const s = snap();
    const id = whyIdentity(s)!;
    expect(resolveWhy(id, ctx(s))).not.toBeNull();
    expect(resolveWhy(id, make(s))).toBeNull();
    expect(resolveWhy(null, ctx(s))).toBeNull();
    expect(overlayWants({ kind: 'why', identity: id }, make(s)).why).toBe(false);
  });

  it('the host keeps only the identity, so an exiting picture resolves current state, never a stale copy', () => {
    expect(holdIdentity(null, true, 'a')).toBe('a');
    expect(holdIdentity('a', false, null)).toBe('a');
    expect(holdIdentity('a', true, 'b')).toBe('b');
    expect(holdIdentity('a', true, null)).toBe('a');
    const s = snap();
    const id = whyIdentity(s)!;
    // Closed by the listener: the held identity still resolves current data for the exit...
    expect(resolveWhy(holdIdentity(id, false, null), ctx(s))).not.toBeNull();
    // ...but after Clear, expiry or replacement it resolves nothing at all.
    expect(resolveWhy(holdIdentity(id, false, null), ctx(s, { clearing: true }))).toBeNull();
    expect(resolveWhy(holdIdentity(id, false, null), ctx({ ...s, session: { context: 'ctx-z', expiresAt: 1 } }))).toBeNull();
  });
});

describe('one overlay at a time', () => {
  it('the menu and Why are never wanted together, opening replaces, and Why is wanted only while it resolves', () => {
    const s = snap();
    const id = whyIdentity(s)!;
    const input: Overlay = { kind: 'input', context: s.session?.context ?? null, wipe: 0 };
    const overlays: (Overlay | null)[] = [null, { kind: 'menu' }, { kind: 'why', identity: id }, { kind: 'why', identity: 'stale' }, input];
    for (const o of overlays) for (const c of [ctx(s), ctx(s, { clearing: true }), ctx(null)]) expect(Object.values(overlayWants(o, c)).filter(Boolean).length).toBeLessThanOrEqual(1);
    expect(overlayWants({ kind: 'menu' }, ctx(s))).toEqual({ menu: true, why: false, input: false });
    expect(overlayWants({ kind: 'why', identity: id }, ctx(s))).toEqual({ menu: false, why: true, input: false });
    expect(overlayWants({ kind: 'why', identity: 'stale' }, ctx(s))).toEqual({ menu: false, why: false, input: false });
    // The voice-input chooser holds no private content but still yields to Clear and redaction at once.
    expect(overlayWants(input, ctx(s))).toEqual({ menu: false, why: false, input: true });
    expect(overlayWants(input, ctx(s, { clearing: true })).input).toBe(false);
    expect(overlayWants(input, ctx(s, { redacted: true })).input).toBe(false);
    expect(overlayWants(input, ctx(s, { wipe: 1 })).input).toBe(false);
    expect(overlayWants(input, ctx(s, { recovery: true })).input).toBe(false);
    expect(overlayWants(input, ctx(null)).input).toBe(false);
    expect(overlayWants({ kind: 'input', context: null, wipe: 0 }, ctx(null)).input).toBe(true);
    expect(openOverlay({ kind: 'menu' }, { kind: 'why', identity: id })).toEqual({ kind: 'why', identity: id });
    expect(openOverlay({ kind: 'why', identity: id }, { kind: 'menu' })).toEqual({ kind: 'menu' });
  });
});

describe('truthful evidence wording', () => {
  const rec = (over: Partial<NonNullable<WhyView['recordings']>> = {}): NonNullable<WhyView['recordings']> => ({ outcome: 'choices', count: 1, refined: false, synthetic: false, ...over });

  it('drops the build-time status line and states the current recording outcome for a real panel', () => {
    expect(whyLines(connection().why)).toEqual(['You chose to keep: “the groove”.', 'Starting artist: Generic Artist.']);
    expect(recordingEvidence(null)).toBe('No recording has been checked yet.');
    expect(recordingEvidence(rec({ outcome: 'no_match', count: 0 }))).toMatch(/No recording could be confirmed/);
    expect(recordingEvidence(rec({ outcome: 'no_match', count: 0 }))).not.toMatch(/has been checked yet/);
    const one = recordingEvidence(rec());
    expect(one).toMatch(/^One recording was confirmed/);
    expect(one).toMatch(/has not listened to it/);
    const two = recordingEvidence(rec({ count: 2, refined: true }));
    expect(two).toMatch(/^2 recordings were confirmed.*refined search/);
    expect(two).toMatch(/has not listened to them/);
  });

  it('a synthetic panel is described as placeholders: nothing found, confirmed or listened to', () => {
    for (const count of [1, 3]) {
      const text = recordingEvidence(rec({ synthetic: true, count }));
      expect(text).toMatch(/placeholder recordings? (was|were) generated by the local synthetic fixture/);
      expect(text).toMatch(/Nothing was found in a real search, confirmed against a real source or listened to/);
      expect(text).not.toMatch(/were confirmed|was confirmed from|credited artists and a listening link|search results/);
    }
    const none = recordingEvidence(rec({ synthetic: true, outcome: 'no_match', count: 0 }));
    expect(none).toMatch(/synthetic fixture produced no placeholder recordings/);
    expect(none).not.toMatch(/No recording could be confirmed/);
    expect(recordingEvidence(rec({ synthetic: true, count: 2, refined: true }))).toMatch(/for the refined search/);
  });
});

// ---------------------------------------------------------------------------
// Markup contract

describe('sheet markup', () => {
  const noop = () => {};
  const view = (recordings: WhyView['recordings'] = null, over: Partial<NonNullable<SafeSnapshot['connection']>> = {}): WhyView => ({ connection: connection(over), recordings });
  const rec = (over: Partial<NonNullable<WhyView['recordings']>> = {}): NonNullable<WhyView['recordings']> => ({ outcome: 'choices', count: 2, refined: false, synthetic: false, ...over });
  const content = (v: WhyView) => renderToStaticMarkup(<WhyContent view={v} />);

  it('shows the owned connection and says plainly what it does not show, from current data only', () => {
    const html = content(view());
    expect(html).toContain('Synthetic connection from a local fixture, not from Qloo');
    expect(html).toContain('You chose to keep: “the groove”.');
    expect(html).toContain('Neighbour X11');
    expect(html).toContain('Neighbour X12');
    expect(html).toMatch(/Tag associations were not available/);
    expect(html).toContain('Artist connections come from The synthetic local fixture (not Qloo).');
    expect(html).toContain('No recording has been checked yet.');
    expect(html).not.toMatch(/score|confidence|%|constellation|recommend/i);
    // The build-time line is not repeated beside a current result or no-match.
    const noMatch = content(view(rec({ outcome: 'no_match', count: 0 }), { synthetic: false }));
    expect(noMatch).toContain('No recording could be confirmed within these artist connections');
    expect(noMatch).not.toContain('No recording has been checked yet.');
    const results = content(view(rec(), { synthetic: false }));
    expect(results).toMatch(/2 recordings were confirmed/);
    expect(results).toMatch(/Fit notes are predictions/);
    expect(results).not.toContain('has been checked yet');
    const real = content(view(null, { synthetic: false }));
    expect(real).toContain('Artist connections come from Qloo.');
    expect(real).not.toContain('Synthetic connection');
  });

  it('a synthetic run never claims source, search or recording confirmation anywhere in the sheet', () => {
    const html = content(view(rec({ synthetic: true, count: 3 })));
    expect(html).toContain('Synthetic connection from a local fixture, not from Qloo');
    expect(html).toMatch(/3 placeholder recordings were generated by the local synthetic fixture/);
    expect(html).toContain('Artist connections come from The synthetic local fixture (not Qloo).');
    expect(html).not.toMatch(/were confirmed|search results that Wintr checked|credited artists and a listening link|only a hypothesis/);
    const none = content(view(rec({ synthetic: true, outcome: 'no_match', count: 0 })));
    expect(none).toMatch(/produced no placeholder recordings/);
    expect(none).not.toMatch(/No recording could be confirmed|has been checked yet/);
  });

  it('mixed status follows each part: a synthetic connection with a real panel and the reverse', () => {
    const syntheticConnectionRealPanel = content(view(rec({ synthetic: false }), { synthetic: true }));
    expect(syntheticConnectionRealPanel).toContain('Synthetic connection from a local fixture, not from Qloo');
    expect(syntheticConnectionRealPanel).toMatch(/2 recordings were confirmed/);
    const realConnectionSyntheticPanel = content(view(rec({ synthetic: true }), { synthetic: false }));
    expect(realConnectionSyntheticPanel).not.toContain('Synthetic connection');
    expect(realConnectionSyntheticPanel).toContain('Artist connections come from Qloo.');
    expect(realConnectionSyntheticPanel).toMatch(/2 placeholder recordings were generated/);
    expect(realConnectionSyntheticPanel).not.toMatch(/were confirmed|search results that Wintr checked/);
  });

  it('the evidence comes from the current panel of the current snapshot (synthetic status included) and follows it', () => {
    const s = snap();
    const id = whyIdentity(s)!;
    const panelOf = (synthetic: boolean, outcome: 'choices' | 'no_match', n: number) =>
      ({ handle: H('panel1'), synthetic, role: 'initial', mode: null, basis: [], outcome, choices: Array.from({ length: n }, () => ({})), answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] }) as unknown as SafeSnapshot['panel'];
    expect(resolveWhy(id, ctx(snap({ panel: panelOf(true, 'choices', 3) })))?.recordings).toEqual({ outcome: 'choices', count: 3, refined: false, synthetic: true });
    expect(resolveWhy(id, ctx(snap({ panel: panelOf(false, 'choices', 1) })))?.recordings).toEqual({ outcome: 'choices', count: 1, refined: false, synthetic: false });
    expect(resolveWhy(id, ctx(snap({ panel: panelOf(false, 'no_match', 0) })))?.recordings).toEqual({ outcome: 'no_match', count: 0, refined: false, synthetic: false });
    expect(resolveWhy(id, ctx(snap()))?.recordings).toBeNull();
  });

  it('Stop and Clear are in a persistent footer while work is pending; the footer is absent otherwise', () => {
    const footer = (working: boolean, stopping = false) => renderToStaticMarkup(<WhyFooter working={working} stopping={stopping} onStop={noop} onClear={noop} />);
    expect(footer(false)).toBe('');
    const busy = footer(true);
    expect(busy).toMatch(/class="sheet-foot action-row"/);
    expect(busy).toMatch(/<button[^>]*>Stop<\/button>/);
    expect(busy).toContain('Clear session');
    expect(footer(true, true)).toMatch(/<button[^>]*disabled[^>]*>Stop<\/button>/);
  });

  it('keeps Close in a persistent header and Stop/Clear in a persistent footer, both outside the scrolling body', () => {
    const html = renderToStaticMarkup(
      <SheetLayer exiting={false} title="Why this connection" onClose={noop} footer={<WhyFooter working stopping={false} onStop={noop} onClear={noop} />}>
        <WhyContent view={view(null, { artists: Array.from({ length: 15 }, (_, i) => `Neighbour X${i + 1}`) })} />
      </SheetLayer>,
    );
    const head = html.slice(html.indexOf('class="sheet-head"'), html.indexOf('class="sheet-body"'));
    const body = html.slice(html.indexOf('class="sheet-body"'), html.indexOf('class="sheet-foot'));
    const foot = html.slice(html.indexOf('class="sheet-foot'));
    expect(head).toContain('>Close<');
    expect(head).toContain('Why this connection');
    expect(body).not.toMatch(/>Close<|>Stop<|Clear session/);
    expect(body).toContain('Neighbour X15');
    expect(foot).toMatch(/>Stop<[\s\S]*Clear session/);
    // The scrolling region is an explicit keyboard stop, so Tab order never depends on browser-added scroller stops.
    expect(html).toMatch(/class="sheet-body" tabindex="0" role="region" aria-label="Connection details"/);
    // Order: header, then body, then footer.
    expect(html.indexOf('>Close<')).toBeLessThan(html.indexOf('Neighbour X1<'));
    expect(html.indexOf('Neighbour X15')).toBeLessThan(html.indexOf('>Stop<'));
  });

  it('is a labelled modal dialog with a drag handle that alone carries the drag handlers', () => {
    const html = renderToStaticMarkup(
      <SheetLayer exiting={false} title="Why this connection" onClose={noop} handle={{ 'data-drag': 'handle-only' }}>
        <a href="/licenses/x.txt">link</a>
        <input aria-label="field" />
      </SheetLayer>,
    );
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="sheet-why-title"/);
    expect(html).toMatch(/<h2 id="sheet-why-title" tabindex="-1"[^>]*>Why this connection<\/h2>/);
    expect(html.match(/data-drag/g)).toHaveLength(1);
    expect(html).toMatch(/<div class="sheet-handle" aria-hidden="true" data-drag="handle-only">/);
    // The header, content, links and fields are outside the handle and carry no drag attribute.
    expect(html.slice(html.indexOf('sheet-head'))).not.toContain('data-drag');
    expect(html).not.toMatch(/data-exiting|inert/);
    expect(html).toMatch(/class="sheet-scrim"[^>]*aria-hidden="true"/);
  });

  it('an exiting sheet is inert, hidden from assistive technology and ignores the pointer', () => {
    const html = renderToStaticMarkup(
      <SheetLayer exiting title="Why this connection" onClose={noop}>
        <p>x</p>
      </SheetLayer>,
    );
    expect(html).toMatch(/class="sheet-layer" data-exiting="true"/);
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*inert=""/);
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*aria-hidden="true"/);
  });
});

describe('compact connection entry', () => {
  const many = connection({ synthetic: false, artists: Array.from({ length: 15 }, (_, i) => `Neighbour X${i + 1}`) });

  it('previews the real count and at most two returned names, with the complete list left to the sheet', () => {
    expect(connectionPreview(many)).toBe('15 connected artists for Generic Artist, including Neighbour X1, Neighbour X2 and 13 more.');
    expect(connectionPreview(connection({ artists: ['Neighbour X11', 'Neighbour X12'] }))).toBe('2 connected artists for Generic Artist, including Neighbour X11 and Neighbour X12.');
    expect(connectionPreview(connection({ artists: ['Neighbour X11'] }))).toBe('1 connected artist for Generic Artist, including Neighbour X11.');
    expect(connectionPreview(connection({ artists: [] }))).toBe('0 connected artists for Generic Artist.');
  });

  it('is one section with a directly reachable Why action: no list, no disclosure, no reasons, labels preserved', () => {
    const html = renderToStaticMarkup(<ConnectionPanel connection={many} onWhy={() => {}} />);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Why this connection<\/button>/);
    expect(html).not.toMatch(/<details|<summary|Neighbour X3\b|Neighbour X15/);
    expect(html).not.toContain('You chose to keep');
    expect(html).not.toContain('Synthetic connection');
    expect(renderToStaticMarkup(<ConnectionPanel connection={connection()} onWhy={() => {}} />)).toContain('Synthetic connection from a local fixture, not from Qloo');
    expect(renderToStaticMarkup(<ConnectionPanel connection={many} />)).not.toContain('Why this connection');
  });
});

describe('focus: tab wrap inside the sheet', () => {
  // The title and the dialog are focusable but not tabbable: they are never in the control list.
  const [close, body, stop, clear] = ['close', 'body', 'stop', 'clear'];
  const controls = [close, body, stop, clear];

  it('Shift+Tab from the initially focused title (or the dialog) goes to the last control, not out of the dialog', () => {
    expect(tabWrapTarget(controls, 'title', 'dialog', true)).toBe(clear);
    expect(tabWrapTarget(controls, 'dialog', 'dialog', true)).toBe(clear);
    expect(tabWrapTarget(controls, null, 'dialog', true)).toBe(clear);
  });

  it('Tab from the title or dialog goes to the first control; boundaries wrap; interior moves stay with the browser', () => {
    expect(tabWrapTarget(controls, 'title', 'dialog', false)).toBe(close);
    expect(tabWrapTarget(controls, 'dialog', 'dialog', false)).toBe(close);
    expect(tabWrapTarget(controls, clear, 'dialog', false)).toBe(close);
    expect(tabWrapTarget(controls, close, 'dialog', true)).toBe(clear);
    for (const mid of [body, stop]) {
      expect(tabWrapTarget(controls, mid, 'dialog', false)).toBeNull();
      expect(tabWrapTarget(controls, mid, 'dialog', true)).toBeNull();
    }
    expect(tabWrapTarget(controls, close, 'dialog', false)).toBeNull();
    expect(tabWrapTarget(controls, clear, 'dialog', true)).toBeNull();
  });

  it('a single control wraps onto itself and an empty list leaves the browser order', () => {
    expect(tabWrapTarget([close], close, 'dialog', false)).toBe(close);
    expect(tabWrapTarget([close], close, 'dialog', true)).toBe(close);
    expect(tabWrapTarget([close], 'title', 'dialog', true)).toBe(close);
    expect(tabWrapTarget([], null, 'dialog', false)).toBeNull();
  });
});

describe('gesture geometry change', () => {
  function started(height = 400) {
    const t = sheet();
    t.p.open();
    t.frames.run(600);
    const dismissed = vi.fn(() => t.p.close());
    const g = new SheetGesture(t.p, () => height, 8, dismissed);
    const ev = (clientY: number, timeStamp: number, pointerId = 1): PointerLike => ({ pointerId, clientY, timeStamp, isPrimary: true, pointerType: 'touch', button: 0 });
    g.down(ev(0, 0));
    g.move(ev(300, 200));
    return { ...t, g, dismissed, ev };
  }

  it('a viewport change abandons the drag: it returns to open from the current position over 220 ms, names the pointer to release, and its release decides nothing', () => {
    const t = started();
    const at = t.p.progress.panel;
    expect(at).toBeLessThan(1);
    expect(t.g.invalidate()).toBe(1);
    expect(t.p.progress.panel).toBe(at);
    t.frames.step(SHEET_MS.dragReturn! - 1);
    expect(t.p.progress.panel).toBeLessThan(1);
    t.frames.step(1);
    expect(t.p.progress).toEqual({ panel: 1, scrim: 1 });
    t.g.up(t.ev(399, 400));
    expect(t.dismissed).not.toHaveBeenCalled();
    expect(t.p.isWanted).toBe(true);
    // A late capture-loss event after the abandonment is not a second return.
    t.g.cancel(1);
    expect(t.frames.queue.size).toBe(0);
  });

  it('a changed panel height abandons the drag; an unchanged one (within half a pixel) does not; no drag means nothing to release', () => {
    const t = started(400);
    expect(t.g.heightChanged(400.4)).toBeNull();
    t.g.move(t.ev(310, 220));
    expect(t.p.progress.panel).toBeLessThan(1);
    expect(t.g.heightChanged(250)).toBe(1);
    expect(t.g.heightChanged(250)).toBeNull();
    expect(t.g.invalidate()).toBeNull();
    // The sheet can be dragged again afterwards, measuring the new height.
    t.frames.run(300);
    expect(t.g.down(t.ev(0, 1000))).toBe(true);
  });

  it('after a viewport change the same pointer cannot dismiss; a new drag measures the current height', () => {
    const heights = [400, 200];
    const t = sheet();
    t.p.open();
    t.frames.run(600);
    const dismissed = vi.fn(() => t.p.close());
    const g = new SheetGesture(t.p, () => heights.shift() ?? 200, 8, dismissed);
    const ev = (clientY: number, timeStamp: number): PointerLike => ({ pointerId: 1, clientY, timeStamp, isPrimary: true, pointerType: 'touch' });
    g.down(ev(0, 0));
    g.move(ev(90, 400));
    g.invalidate();
    t.frames.run(300);
    g.move(ev(500, 800));
    g.up(ev(500, 1200));
    expect(dismissed).not.toHaveBeenCalled();
    // 60 px of travel is a quarter of nothing for a 400 px panel but more than a quarter of the new 200 px one.
    g.down(ev(0, 2000));
    g.move(ev(60, 2400));
    g.up(ev(60, 2800));
    expect(dismissed).toHaveBeenCalledTimes(1);
  });
});
