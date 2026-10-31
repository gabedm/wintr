import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposerHeight, ComposerLayout, editorTarget, type EditorLike } from '../src/client/composer-height.js';
import { STANDARD_EASING, ValueTween, type Frames } from '../src/client/motion.js';
import { FOLLOW_MS, ReadingAnchor, ResultTracker, type AnchorEnv } from '../src/client/reading-anchor.js';
import { keyboardInset, trackViewport, type ViewportLike, type WindowLike } from '../src/client/viewport.js';
import { ViewportHub } from '../src/client/viewport-hooks.js';

// Behaviour of the measured-layout cores over injected frames, viewports and
// scrollers. These are logic tests with fakes: they say nothing about real
// iOS/Android keyboards, frame pacing or touch scrolling.

class FakeFrames implements Frames {
  t = 0;
  private next = 0;
  readonly queue = new Map<number, () => void>();
  now() {
    return this.t;
  }
  raf(cb: () => void) {
    this.queue.set(++this.next, cb);
    return this.next;
  }
  caf(id: number) {
    this.queue.delete(id);
  }
  /** Advance the clock and run the frames that were scheduled before this step. */
  step(ms: number) {
    this.t += ms;
    const run = [...this.queue.values()];
    this.queue.clear();
    run.forEach((cb) => cb());
  }
  /** Run frames in 16 ms steps for `ms` total. */
  run(ms: number) {
    for (let spent = 0; spent < ms; spent += 16) this.step(Math.min(16, ms - spent));
  }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('standard easing and the retargetable tween', () => {
  it('follows the locked standard curve: endpoints fixed, monotonic, decelerating', () => {
    expect(STANDARD_EASING(0)).toBe(0);
    expect(STANDARD_EASING(1)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 20; i++) {
      const v = STANDARD_EASING(i / 20);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
    expect(STANDARD_EASING(0.5)).toBeGreaterThan(0.5);
  });

  function tween(reduced = false) {
    const frames = new FakeFrames();
    const writes: number[] = [];
    const flags = { reduced };
    const t = new ValueTween({ frames, nominalMs: 160, apply: (v) => writes.push(v), reducedMotion: () => flags.reduced });
    return { frames, writes, flags, t };
  }

  it('runs an uninterrupted path for exactly the nominal duration', () => {
    const { frames, writes, t } = tween();
    t.set(0);
    t.to(100);
    frames.step(16);
    expect(t.value).toBeGreaterThan(0);
    expect(t.value).toBeLessThan(100);
    frames.step(128);
    expect(t.value).toBeLessThan(100);
    frames.step(16);
    expect(t.value).toBe(100);
    expect(t.running).toBe(false);
    expect(writes.at(-1)).toBe(100);
  });

  it('retargets from the current visual value, never from the original start, over a scaled duration', () => {
    const { frames, t } = tween();
    t.set(0);
    t.to(100);
    frames.step(80);
    const mid = t.value!;
    expect(mid).toBeGreaterThan(40);
    t.to(40);
    expect(t.value).toBe(mid);
    frames.step(16);
    expect(t.value!).toBeLessThan(mid);
    expect(t.value!).toBeGreaterThan(40);
    // Remaining distance / full path (100) of the nominal 160 ms: finished once that much time has passed.
    const total = 160 * ((mid - 40) / 100);
    frames.step(total);
    expect(t.value).toBe(40);
    expect(t.running).toBe(false);
  });

  it('applies zero-distance, reduced-motion and immediate requests at once without scheduling frames', () => {
    const { frames, writes, flags, t } = tween();
    t.set(10);
    t.to(10);
    expect(frames.queue.size).toBe(0);
    flags.reduced = true;
    t.to(90);
    expect(t.value).toBe(90);
    expect(frames.queue.size).toBe(0);
    flags.reduced = false;
    t.to(50, { immediate: true });
    expect(t.value).toBe(50);
    expect(writes).toEqual([10, 10, 90, 50]);
  });

  it('finish() lands on the end point; cancel() and set() leave no stale frame that can write later', () => {
    const { frames, writes, t } = tween();
    t.set(0);
    t.to(100);
    frames.step(40);
    t.finish();
    expect(t.value).toBe(100);
    t.to(0);
    frames.step(40);
    t.cancel();
    const frozen = writes.length;
    const at = t.value;
    frames.run(400);
    expect(writes).toHaveLength(frozen);
    expect(t.value).toBe(at);
    t.to(100);
    t.set(7);
    frames.run(400);
    expect(t.value).toBe(7);
  });

  it('ignores an already queued callback after cancellation or retargeting', () => {
    const { frames, writes, t } = tween();
    t.set(0);
    t.to(100);
    const cancelled = [...frames.queue.values()][0]!;
    t.cancel();
    const before = writes.length;
    cancelled(); // Simulate a callback already handed off before caf took effect.
    expect(writes).toHaveLength(before);
    expect(frames.queue.size).toBe(0);

    t.to(100);
    const superseded = [...frames.queue.values()][0]!;
    frames.step(40);
    t.to(25);
    const atRetarget = t.value;
    const pending = frames.queue.size;
    superseded();
    expect(t.value).toBe(atRetarget);
    expect(frames.queue.size).toBe(pending);
    frames.run(160);
    expect(t.value).toBe(25);
  });
});

describe('composer height: cap, retargeting, IME, viewport and reduced motion', () => {
  it('caps the editable box at six 24 px lines and never above 144 px', () => {
    expect(editorTarget(24)).toBe(24);
    expect(editorTarget(120)).toBe(120);
    expect(editorTarget(144)).toBe(144);
    expect(editorTarget(600)).toBe(144);
    expect(editorTarget(0)).toBe(24);
    expect(editorTarget(Number.NaN)).toBe(24);
    // A smaller computed cap (for example six larger lines) is honoured; a larger one never lifts the 144 limit.
    expect(editorTarget(600, 96)).toBe(96);
    expect(editorTarget(600, 400)).toBe(144);
    expect(editorTarget(600, Number.NaN)).toBe(144);
  });

  function composer() {
    const frames = new FakeFrames();
    const applied: number[] = [];
    const s = { reduced: false, moving: false };
    const h = new ComposerHeight({ frames, apply: (px) => applied.push(px), reducedMotion: () => s.reduced, viewportMoving: () => s.moving });
    return { frames, applied, s, h };
  }

  it('sets the first measurement directly, then animates growth over 160 ms and retargets from the visual height', () => {
    const { frames, applied, h } = composer();
    h.request(24, { composing: false });
    expect(applied).toEqual([24]);
    h.request(72, { composing: false });
    expect(h.animating).toBe(true);
    frames.step(80);
    const mid = h.visual!;
    expect(mid).toBeGreaterThan(24);
    expect(mid).toBeLessThan(72);
    h.request(144 + 200, { composing: false });
    expect(h.visual).toBe(mid);
    frames.step(160);
    expect(h.visual).toBe(144);
    expect(Math.max(...applied)).toBe(144);
  });

  it('applies directly during a native viewport move and during IME composition', () => {
    const { frames, s, h } = composer();
    h.request(24, { composing: false });
    s.moving = true;
    h.request(96, { composing: false });
    expect(h.visual).toBe(96);
    expect(h.animating).toBe(false);
    expect(frames.queue.size).toBe(0);
    s.moving = false;
    h.request(120, { composing: true });
    expect(h.visual).toBe(120);
    expect(frames.queue.size).toBe(0);
    h.request(48, { composing: false });
    expect(h.animating).toBe(true);
  });

  it('a viewport move finishes a running tween at its end point', () => {
    const { frames, h } = composer();
    h.request(24, { composing: false });
    h.request(120, { composing: false });
    frames.step(48);
    expect(h.visual).toBeLessThan(120);
    h.viewportMoved();
    expect(h.visual).toBe(120);
    expect(h.animating).toBe(false);
  });

  it('a live reduced-motion change finishes the current motion; turning it off animates the next change', () => {
    const { frames, s, h } = composer();
    h.request(24, { composing: false });
    h.request(120, { composing: false });
    frames.step(48);
    s.reduced = true;
    h.reducedMotionChanged();
    expect(h.visual).toBe(120);
    expect(frames.queue.size).toBe(0);
    h.request(24, { composing: false });
    expect(h.visual).toBe(24);
    s.reduced = false;
    h.reducedMotionChanged();
    h.request(96, { composing: false });
    expect(h.animating).toBe(true);
  });

  it('dispose stops the motion without writing again', () => {
    const { frames, applied, h } = composer();
    h.request(24, { composing: false });
    h.request(120, { composing: false });
    frames.step(48);
    h.dispose();
    const n = applied.length;
    frames.run(400);
    expect(applied).toHaveLength(n);
  });
});

class FakeVisualViewport implements ViewportLike {
  height: number;
  offsetTop = 0;
  scale = 1;
  readonly listeners = { resize: new Set<() => void>(), scroll: new Set<() => void>() };
  constructor(height: number) {
    this.height = height;
  }
  addEventListener(type: 'resize' | 'scroll', l: () => void) {
    this.listeners[type].add(l);
  }
  removeEventListener(type: 'resize' | 'scroll', l: () => void) {
    this.listeners[type].delete(l);
  }
  fire(type: 'resize' | 'scroll') {
    [...this.listeners[type]].forEach((l) => l());
  }
  get count() {
    return this.listeners.resize.size + this.listeners.scroll.size;
  }
}

class FakeWindow implements WindowLike {
  readonly listeners = { resize: new Set<() => void>(), orientationchange: new Set<() => void>() };
  addEventListener(type: 'resize' | 'orientationchange', l: () => void) {
    this.listeners[type].add(l);
  }
  removeEventListener(type: 'resize' | 'orientationchange', l: () => void) {
    this.listeners[type].delete(l);
  }
  fire(type: 'resize' | 'orientationchange') {
    [...this.listeners[type]].forEach((l) => l());
  }
  get count() {
    return this.listeners.resize.size + this.listeners.orientationchange.size;
  }
}

describe('native visual viewport: one layout offset', () => {
  it('measures the layout viewport hidden below the visual viewport, and nothing for zoom or resized layouts', () => {
    expect(keyboardInset(800, { height: 500, offsetTop: 0, scale: 1 })).toBe(300);
    expect(keyboardInset(800, { height: 500, offsetTop: 100, scale: 1 })).toBe(200);
    expect(keyboardInset(800, { height: 800, offsetTop: 0, scale: 1 })).toBe(0);
    // The layout viewport itself shrank (resize-content browsers): the visual viewport matches it, so nothing is offset twice.
    expect(keyboardInset(500, { height: 500, offsetTop: 0, scale: 1 })).toBe(0);
    // Pinch zoom makes the visual viewport smaller without any keyboard.
    expect(keyboardInset(800, { height: 400, offsetTop: 0, scale: 2 })).toBe(0);
    expect(keyboardInset(800, { height: 900, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(800, { height: Number.NaN, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(800, null)).toBe(0);
  });

  function setup(layout = 800) {
    const frames = new FakeFrames();
    const vv = new FakeVisualViewport(layout);
    const win = new FakeWindow();
    const applied: [number, boolean][] = [];
    const env = { layout };
    const tracker = trackViewport({
      visualViewport: vv,
      window: win,
      layoutHeight: () => env.layout,
      apply: (inset, open) => applied.push([inset, open]),
      frames,
    });
    return { frames, vv, win, applied, env, tracker };
  }

  it('applies exactly one offset per real change, from native events, and is moving only until the next frame', () => {
    const { frames, vv, applied, tracker } = setup();
    const moved = vi.fn();
    tracker.subscribe(moved);
    expect(applied).toEqual([[0, false]]);
    expect(tracker.moving()).toBe(false);

    vv.height = 500;
    vv.fire('resize');
    expect(applied).toEqual([[0, false], [300, true]]);
    expect(tracker.inset).toBe(300);
    expect(tracker.moving()).toBe(true);
    expect(moved).toHaveBeenCalledTimes(1);
    frames.step(16);
    expect(tracker.moving()).toBe(false);

    // An unchanged measurement neither re-applies nor notifies.
    vv.fire('resize');
    vv.fire('scroll');
    expect(applied).toHaveLength(2);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(tracker.moving()).toBe(false);

    // A pan of the visual viewport (iOS) changes the same single offset.
    vv.offsetTop = 120;
    vv.fire('scroll');
    expect(applied.at(-1)).toEqual([180, true]);
  });

  it('treats a small overlap (browser chrome) as an offset but not as an open keyboard, and ignores pinch zoom', () => {
    const { vv, applied } = setup();
    vv.height = 740;
    vv.fire('resize');
    expect(applied.at(-1)).toEqual([60, false]);
    vv.height = 400;
    vv.scale = 2;
    vv.fire('resize');
    expect(applied.at(-1)).toEqual([0, false]);
  });

  it('remeasures once on orientation or layout resize, and notifies even when the offset is unchanged', () => {
    const { win, env, applied, tracker } = setup();
    const moved = vi.fn();
    tracker.subscribe(moved);
    env.layout = 400;
    win.fire('orientationchange');
    expect(moved).toHaveBeenCalledTimes(1);
    win.fire('resize');
    expect(moved).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([[0, false]]);
  });

  it('uses no timers, and stop() removes every listener and the pending frame', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const interval = vi.spyOn(globalThis, 'setInterval');
    const { frames, vv, win, applied, tracker } = setup();
    expect(vv.count).toBe(2);
    expect(win.count).toBe(2);
    vv.height = 500;
    vv.fire('resize');
    expect(frames.queue.size).toBe(1);
    tracker.stop();
    expect(vv.count).toBe(0);
    expect(win.count).toBe(0);
    expect(frames.queue.size).toBe(0);
    vv.height = 300;
    vv.fire('resize');
    expect(applied).toHaveLength(2);
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    tracker.stop();
  });

  it('stays usable without a visualViewport: only layout resizes are heard and no offset is applied', () => {
    const win = new FakeWindow();
    const applied: [number, boolean][] = [];
    const tracker = trackViewport({ visualViewport: null, window: win, layoutHeight: () => 700, apply: (i, o) => applied.push([i, o]), frames: new FakeFrames() });
    win.fire('resize');
    expect(applied).toEqual([[0, false]]);
    tracker.stop();
    expect(win.count).toBe(0);
  });

  it('the browser binding writes the one CSS offset and removes it and every listener on cleanup', () => {
    const vv = new FakeVisualViewport(800);
    const win = Object.assign(new FakeWindow(), { visualViewport: vv });
    const props = new Map<string, string>();
    const attrs = new Set<string>();
    const root = {
      clientHeight: 800,
      style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
      toggleAttribute: (k: string, on: boolean) => (on ? attrs.add(k) : attrs.delete(k)),
      removeAttribute: (k: string) => attrs.delete(k),
    };
    const frames = new FakeFrames();
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', { documentElement: root });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.raf(cb));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.caf(id));
    const hub = new ViewportHub();
    const moved = vi.fn();
    hub.subscribe(moved);
    const stop = hub.start();
    expect(props.get('--kb-inset')).toBe('0px');
    vv.height = 480;
    vv.fire('resize');
    expect(props.get('--kb-inset')).toBe('320px');
    expect(attrs.has('data-keyboard')).toBe(true);
    expect(hub.moving()).toBe(true);
    expect(moved).toHaveBeenCalledTimes(1);
    stop();
    expect(props.has('--kb-inset')).toBe(false);
    expect(attrs.size).toBe(0);
    expect(vv.count + win.count).toBe(0);
    expect(hub.moving()).toBe(false);
  });
});

describe('reading anchor: follow near the bottom, preserve place otherwise', () => {
  function anchor(o: { top: number; max: number; reduced?: boolean }) {
    const frames = new FakeFrames();
    const s = { top: o.top, max: o.max, reduced: o.reduced ?? false };
    const writes: number[] = [];
    const env: AnchorEnv = {
      now: () => frames.now(),
      raf: (cb) => frames.raf(cb),
      caf: (id) => frames.caf(id),
      scrollTop: () => s.top,
      setScrollTop: (y) => {
        s.top = y;
        writes.push(y);
      },
      maxScrollTop: () => s.max,
      reducedMotion: () => s.reduced,
    };
    const pending: (string | null)[] = [];
    const a = new ReadingAnchor(env, (k) => pending.push(k));
    a.measure();
    return { a, s, writes, frames, pending };
  }

  it('follows a result when the reader is within 80 px of the bottom, over 180 ms, to the start of the result', () => {
    const { a, s, writes, frames } = anchor({ top: 920, max: 1000 });
    expect(a.onResult('r1', 960)).toBe('follow');
    frames.step(FOLLOW_MS / 2);
    expect(s.top).toBeGreaterThan(920);
    expect(s.top).toBeLessThan(960);
    frames.step(FOLLOW_MS / 2);
    expect(s.top).toBe(960);
    expect(writes.at(-1)).toBe(960);
    expect(a.following).toBe(false);
  });

  it('reaches an eligible start in either direction, capped at the available document', () => {
    const near = anchor({ top: 950, max: 1000 });
    expect(near.a.onResult('r', 900)).toBe('follow');
    near.frames.run(400);
    expect(near.s.top).toBe(900);
    const tall = anchor({ top: 950, max: 1000 });
    tall.a.onResult('r', 5000);
    tall.frames.run(400);
    expect(tall.s.top).toBe(1000);
  });

  it('one pixel beyond the 80 px threshold preserves the reader, offers New answer and writes no scroll', () => {
    const { a, s, writes, frames, pending } = anchor({ top: 919, max: 1000 });
    expect(a.onResult('r1', 960)).toBe('pending');
    frames.run(400);
    expect(writes).toEqual([]);
    expect(s.top).toBe(919);
    expect(pending).toEqual(['r1']);
  });

  it('New answer reaches its start; reaching an unread footer alone does not retire the offer', () => {
    const first = anchor({ top: 300, max: 1000 });
    first.a.onResult('r1', 700);
    first.a.reveal(700);
    expect(first.pending).toEqual(['r1', null]);
    first.frames.run(400);
    expect(first.s.top).toBe(700);

    const second = anchor({ top: 300, max: 1000 });
    second.a.onResult('r2', 700);
    second.s.top = 930;
    second.a.onScroll();
    expect(second.pending).toEqual(['r2']);
  });

  it('an explicit current user action follows even from away, once; scrolling away by hand withdraws it', () => {
    const acted = anchor({ top: 100, max: 1000 });
    acted.a.userAction();
    expect(acted.a.onResult('r1', 400)).toBe('follow');
    expect(acted.a.onResult('r2', 600)).toBe('pending');

    const withdrawn = anchor({ top: 990, max: 1000 });
    withdrawn.a.userAction();
    withdrawn.a.onUserInput();
    withdrawn.s.top = 300;
    withdrawn.a.onScroll();
    expect(withdrawn.a.onResult('r1', 500)).toBe('pending');
  });

  it('real user scrolling cancels an in-progress follow immediately', () => {
    const { a, s, writes, frames } = anchor({ top: 950, max: 1000 });
    a.onResult('r1', 1000);
    frames.step(48);
    const before = writes.length;
    expect(before).toBeGreaterThan(0);
    a.onUserInput();
    const at = s.top;
    frames.run(400);
    expect(writes).toHaveLength(before);
    expect(s.top).toBe(at);
    expect(a.following).toBe(false);
  });

  it('a scroll position that the follow did not write also cancels it', () => {
    const { a, s, writes, frames } = anchor({ top: 950, max: 1000 });
    a.onResult('r1', 1000);
    frames.step(48);
    const before = writes.length;
    s.top = 400;
    a.onScroll();
    frames.run(400);
    expect(writes).toHaveLength(before);
  });

  it('Stop, Clear, expiry or replacement (reset) leaves no late frame, offer or intent that could act', () => {
    const run = anchor({ top: 950, max: 1000 });
    run.a.onResult('r1', 1000);
    run.frames.step(48);
    const before = run.writes.length;
    run.a.reset();
    run.frames.run(400);
    expect(run.writes).toHaveLength(before);

    const offered = anchor({ top: 100, max: 1000 });
    offered.a.onResult('r1', 500);
    offered.a.reset();
    expect(offered.pending.at(-1)).toBeNull();

    const intent = anchor({ top: 100, max: 1000 });
    intent.a.userAction();
    intent.a.reset();
    expect(intent.a.onResult('r2', 500)).toBe('pending');
  });

  it('reduced motion scrolls at once with no frames; a live change finishes the current follow', () => {
    const reduced = anchor({ top: 950, max: 1000, reduced: true });
    reduced.a.onResult('r1', 1000);
    expect(reduced.s.top).toBe(1000);
    expect(reduced.frames.queue.size).toBe(0);

    const live = anchor({ top: 950, max: 1000 });
    live.a.onResult('r1', 1000);
    live.frames.step(48);
    live.s.reduced = true;
    live.a.reducedMotionChanged();
    expect(live.s.top).toBe(1000);
    expect(live.frames.queue.size).toBe(0);
  });

  it('layout keeps an eligible answer start, pins an ordinary bottom, and leaves an earlier reader in place', () => {
    const pinned = anchor({ top: 950, max: 1000 });
    pinned.a.onResult('r1', 1000);
    pinned.frames.step(48);
    pinned.s.max = 1300;
    pinned.a.viewportMoved();
    expect(pinned.frames.queue.size).toBe(0);
    expect(pinned.s.top).toBe(1000);

    const bottom = anchor({ top: 950, max: 1000 });
    bottom.s.max = 1300;
    bottom.a.viewportMoved();
    expect(bottom.s.top).toBe(1300);

    const away = anchor({ top: 200, max: 1000 });
    away.s.max = 1300;
    away.a.viewportMoved();
    away.a.pinIfNear();
    expect(away.writes).toEqual([]);
    expect(away.s.top).toBe(200);
  });
});

describe('result tracking: only genuinely new results in the current session count', () => {
  it('treats the first snapshot, a restore and a new session as silent baselines', () => {
    const t = new ResultTracker();
    expect(t.observe('s1', 'a')).toBe('baseline');
    expect(t.observe('s1', 'a')).toBe('none');
    expect(t.observe('s1', 'b')).toBe('result');
    expect(t.observe('s1', null)).toBe('cleared');
    expect(t.observe('s1', 'c')).toBe('result');
    expect(t.observe('s2', 'c')).toBe('baseline');
    expect(t.observe('s2', 'd')).toBe('result');
    t.reset();
    expect(t.observe('s2', 'e')).toBe('baseline');
  });
});

describe('reading anchor corrections: explicit reveal and manual scrolling', () => {
  function anchor(o: { top: number; max: number }) {
    const frames = new FakeFrames();
    const s = { top: o.top, max: o.max };
    const writes: number[] = [];
    const env: AnchorEnv = {
      now: () => frames.now(),
      raf: (cb) => frames.raf(cb),
      caf: (id) => frames.caf(id),
      scrollTop: () => s.top,
      setScrollTop: (y) => {
        s.top = y;
        writes.push(y);
      },
      maxScrollTop: () => s.max,
      reducedMotion: () => false,
    };
    const pending: (string | null)[] = [];
    const a = new ReadingAnchor(env, (k) => pending.push(k));
    a.measure();
    return { a, s, writes, frames, pending };
  }

  it('explicit reveal and an eligible automatic follow both reach a start above the current position', () => {
    const { a, s, writes, frames, pending } = anchor({ top: 900, max: 1500 });
    // The reader is well below the result's start (away from the bottom): the result is only offered.
    expect(a.onResult('r1', 300)).toBe('pending');
    expect(pending).toEqual(['r1']);
    expect(writes).toEqual([]);
    a.reveal(300);
    expect(pending).toEqual(['r1', null]);
    frames.step(FOLLOW_MS / 2);
    expect(s.top).toBeLessThan(900);
    expect(s.top).toBeGreaterThan(300);
    frames.step(FOLLOW_MS / 2);
    expect(s.top).toBe(300);
    expect(a.following).toBe(false);

    // Eligibility is measured before append, not inferred from scroll direction.
    const auto = anchor({ top: 1480, max: 1500 });
    expect(auto.a.onResult('r2', 300)).toBe('follow');
    auto.frames.run(400);
    expect(auto.s.top).toBe(300);
  });

  it('a reveal at the exact position, or to a missing result start, is safe', () => {
    const here = anchor({ top: 300, max: 1500 });
    here.a.onResult('r', 300);
    here.a.reveal(300);
    expect(here.writes).toEqual([]);
    const unknown = anchor({ top: 200, max: 1500 });
    unknown.a.reveal(null);
    unknown.frames.run(400);
    expect(unknown.s.top).toBe(200);
    expect(unknown.writes).toEqual([]);
  });

  it('a manual scroll away (scrollbar drag, no wheel/key/touch event) withdraws pending explicit intent', () => {
    const control = anchor({ top: 100, max: 1000 });
    control.a.userAction();
    expect(control.a.onResult('r1', 400)).toBe('follow');

    const dragged = anchor({ top: 990, max: 1000 });
    dragged.a.userAction();
    dragged.s.top = 300;
    dragged.a.onScroll();
    expect(dragged.a.onResult('r1', 500)).toBe('pending');
    dragged.frames.run(400);
    expect(dragged.writes).toEqual([]);
    expect(dragged.s.top).toBe(300);

    // A manual scroll that stays at the bottom does not withdraw the intent.
    const stays = anchor({ top: 100, max: 1000 });
    stays.a.userAction();
    stays.s.top = 960;
    stays.a.onScroll();
    expect(stays.a.onResult('r1', 970)).toBe('follow');
  });

  it('echoes of the anchor\'s own scroll writes never count as the user', () => {
    const { a, s, writes, frames } = anchor({ top: 100, max: 1000 });
    a.userAction();
    expect(a.onResult('r1', 600)).toBe('follow');
    for (let i = 0; i < 20 && a.following; i++) {
      frames.step(16);
      a.onScroll();
    }
    expect(a.following).toBe(false);
    expect(s.top).toBe(600);
    expect(writes.at(-1)).toBe(600);
    // A pin from a layout change is also its own write.
    const pinned = anchor({ top: 990, max: 1000 });
    pinned.s.max = 1100;
    pinned.a.pinIfNear();
    pinned.a.userAction();
    pinned.a.onScroll();
    expect(pinned.a.onResult('r', 1100)).toBe('follow');
  });

  it('a manual scroll mid-follow cancels it, and Stop/Clear reset still leaves nothing that can act', () => {
    const { a, s, writes, frames } = anchor({ top: 100, max: 1000 });
    a.userAction();
    a.onResult('r1', 800);
    frames.step(48);
    const before = writes.length;
    s.top = 20;
    a.onScroll();
    frames.run(400);
    expect(writes).toHaveLength(before);
    expect(s.top).toBe(20);
    a.reset();
    expect(a.onResult('r2', 500)).toBe('pending');
  });
});

describe('composer layout: re-measure the same draft when the layout changes', () => {
  /** A box whose natural height depends on its width, like wrapped text (24 px lines). */
  function box(initialWidth: number, chars: number) {
    const s = { width: initialWidth, reads: 0, charPx: 8 };
    const editor: EditorLike & { style: { height: string }; scrollTop: number } = {
      style: { height: '24px' },
      scrollTop: 0,
      get scrollHeight() {
        s.reads += 1;
        return Math.max(1, Math.ceil((chars * s.charPx) / s.width)) * 24;
      },
    };
    const frames = new FakeFrames();
    const flags = { moving: false, composing: false, reduced: false };
    const height = new ComposerHeight({
      frames,
      apply: (px) => {
        editor.style.height = `${px}px`;
      },
      reducedMotion: () => flags.reduced,
      viewportMoving: () => flags.moving,
    });
    const layout = new ComposerLayout(editor, () => 144, height, () => flags.composing);
    // The observer's first report only records the starting width.
    expect(layout.widthChanged(initialWidth)).toBe(false);
    return { s, editor, frames, flags, height, layout };
  }

  it('measuring keeps the visual height and the internal scroll position, never leaving the box at auto', () => {
    const { s, editor, layout, height, frames } = box(300, 20);
    layout.measure();
    expect(editor.style.height).toBe('24px');
    s.width = 100;
    editor.scrollTop = 37;
    layout.measure();
    // The new target is animated from the current visual height; the measurement itself left both untouched.
    expect(editor.style.height).toBe('24px');
    expect(editor.scrollTop).toBe(37);
    expect(height.animating).toBe(true);
    frames.run(200);
    expect(editor.style.height).toBe('48px');
  });

  it('a width change rewraps the same draft and retargets the height; height-only changes are ignored', () => {
    const { s, frames, layout, height } = box(400, 100);
    layout.measure();
    expect(height.visual).toBe(48);
    expect(layout.widthChanged(400)).toBe(false);
    const reads = s.reads;
    expect(layout.widthChanged(400.2)).toBe(false);
    expect(s.reads).toBe(reads);
    s.width = 200;
    expect(layout.widthChanged(200)).toBe(true);
    expect(height.animating).toBe(true);
    frames.run(200);
    expect(height.visual).toBe(96);
    s.width = 100;
    expect(layout.widthChanged(100)).toBe(true);
    frames.run(200);
    expect(height.visual).toBe(144);
  });

  it('our own height writes cannot trigger another measurement', () => {
    const { s, frames, layout, height } = box(200, 100);
    layout.widthChanged(200);
    layout.measure();
    frames.run(200);
    const reads = s.reads;
    // The observer reports the same width after every height write.
    for (let i = 0; i < 10; i++) expect(layout.widthChanged(200)).toBe(false);
    expect(s.reads).toBe(reads);
    expect(height.animating).toBe(false);
  });

  it('a native keyboard/viewport move finishes the old motion and applies the new height directly, not over 160 ms', () => {
    const { s, frames, flags, layout, height } = box(400, 100);
    layout.measure();
    s.width = 200;
    layout.widthChanged(200);
    frames.step(32);
    expect(height.animating).toBe(true);
    flags.moving = true;
    s.width = 100;
    layout.viewportMoved();
    expect(height.visual).toBe(144);
    expect(height.animating).toBe(false);
    expect(frames.queue.size).toBe(0);
  });

  it('honours reduced motion and IME composition when the same draft rewraps', () => {
    const reduced = box(400, 100);
    reduced.layout.measure();
    reduced.flags.reduced = true;
    reduced.s.width = 200;
    reduced.layout.widthChanged(200);
    expect(reduced.height.visual).toBe(96);
    expect(reduced.frames.queue.size).toBe(0);
    const composing = box(400, 100);
    composing.layout.measure();
    composing.flags.composing = true;
    composing.s.width = 200;
    composing.layout.widthChanged(200);
    expect(composing.height.visual).toBe(96);
    expect(composing.frames.queue.size).toBe(0);
  });
});

describe('layout width counts as a native viewport change', () => {
  it('notifies listeners on a width-only change even though the keyboard offset is unchanged', () => {
    const win = new FakeWindow();
    const env = { w: 400 };
    const applied: [number, boolean][] = [];
    const tracker = trackViewport({
      visualViewport: null,
      window: win,
      layoutHeight: () => 800,
      layoutWidth: () => env.w,
      apply: (i, o) => applied.push([i, o]),
      frames: new FakeFrames(),
    });
    const moved = vi.fn();
    tracker.subscribe(moved);
    env.w = 300;
    win.fire('resize');
    expect(moved).toHaveBeenCalledTimes(1);
    expect(tracker.moving()).toBe(true);
    expect(applied).toEqual([[0, false]]);
    win.fire('resize');
    expect(moved).toHaveBeenCalledTimes(1);
    tracker.stop();
  });
});
