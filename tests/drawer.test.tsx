// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DrawerLayer, MenuSheet } from '../src/client/App.js';
import { pickFocusTarget } from '../src/client/focus.js';
import { DrawerPresence, DRAWER_MS, type DrawerProgress } from '../src/client/presence.js';
import { createScrollLock } from '../src/client/scroll-lock.js';
import { FakeFrames } from './fixtures/fake-frames.js';
import { expandedMenu } from './fixtures/expanded-menu.js';

// The session drawer's visual presence, focus-return decision, scroll lock and
// exiting markup, exercised with injected frames and server rendering. These are
// logic tests: real focus, inertness, scrolling and frame pacing in a browser or
// on a phone are separate acceptance.

function drawer(reduced = false) {
  const frames = new FakeFrames();
  const flags = { reduced };
  const writes: DrawerProgress[] = [];
  const mounts: boolean[] = [];
  const d = new DrawerPresence({
    frames,
    reducedMotion: () => flags.reduced,
    write: (p) => writes.push(p),
    onMounted: (m) => mounts.push(m),
  });
  return { frames, flags, writes, mounts, d };
}

describe('drawer presence: enter, exit, interruption', () => {
  it('appears at once, then enters over its own durations, the scrim finishing first', () => {
    const { frames, mounts, d } = drawer();
    d.open();
    // Mounted before any frame: the picture exists immediately (authority never waits for motion).
    expect(mounts).toEqual([true]);
    expect(d.progress).toEqual({ panel: 0, scrim: 0 });
    frames.step(DRAWER_MS.scrimEnter);
    expect(d.progress.scrim).toBe(1);
    expect(d.progress.panel).toBeGreaterThan(0);
    expect(d.progress.panel).toBeLessThan(1);
    frames.step(DRAWER_MS.enter - DRAWER_MS.scrimEnter);
    expect(d.progress).toEqual({ panel: 1, scrim: 1 });
    expect(d.animating).toBe(false);
  });

  it('exits over its own durations and removes the picture only once both have finished', () => {
    const { frames, mounts, d } = drawer();
    d.open();
    frames.run(400);
    d.close();
    frames.step(DRAWER_MS.scrimExit);
    expect(d.progress.scrim).toBe(0);
    expect(d.progress.panel).toBeGreaterThan(0);
    expect(mounts).toEqual([true]);
    frames.step(DRAWER_MS.exit - DRAWER_MS.scrimExit);
    expect(d.progress).toEqual({ panel: 0, scrim: 0 });
    expect(mounts).toEqual([true, false]);
    expect(d.mounted).toBe(false);
  });

  it('reversing mid-exit retargets from the current progress over the scaled remaining path, without a jump', () => {
    const { frames, writes, d } = drawer();
    d.open();
    frames.run(400);
    d.close();
    frames.step(DRAWER_MS.exit / 2);
    const mid = d.progress.panel;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    const before = writes.length;
    d.open();
    // Retargeting writes nothing by itself: no snap back to either end.
    expect(d.progress.panel).toBe(mid);
    expect(writes.length).toBe(before);
    // Scaled path: the nominal enter time times the distance still to go.
    const remaining = DRAWER_MS.enter * (1 - mid);
    frames.step(remaining - 1);
    expect(d.progress.panel).toBeLessThan(1);
    frames.step(1);
    expect(d.progress.panel).toBe(1);
    // The panel never moved backwards after the reversal.
    const after = writes.slice(before).map((w) => w.panel);
    expect(after.every((v, i) => i === 0 || v >= after[i - 1]!)).toBe(true);
    expect(d.mounted).toBe(true);
  });

  it('reversing mid-enter closes over the scaled remaining path and a superseded frame can never write', () => {
    const { frames, writes, mounts, d } = drawer();
    d.open();
    frames.step(120);
    const mid = d.progress.panel;
    d.close();
    const before = writes.length;
    frames.step(DRAWER_MS.exit * mid - 1);
    expect(d.progress.panel).toBeGreaterThan(0);
    frames.step(1);
    expect(d.progress.panel).toBe(0);
    frames.run(1000);
    expect(d.progress).toEqual({ panel: 0, scrim: 0 });
    expect(mounts.at(-1)).toBe(false);
    // Rapid open/close/open ends open with no leftover motion from the earlier requests.
    d.open();
    d.close();
    d.open();
    frames.run(1000);
    expect(d.progress).toEqual({ panel: 1, scrim: 1 });
    expect(d.animating).toBe(false);
    expect(writes.length).toBeGreaterThan(before);
  });

  it('dispose stops all motion and nothing writes afterwards', () => {
    const { frames, writes, d } = drawer();
    d.open();
    frames.step(100);
    d.dispose();
    const n = writes.length;
    frames.run(1000);
    expect(writes).toHaveLength(n);
  });
});

describe('drawer presence: reduced motion and hidden documents', () => {
  it('places the drawer at once, in both directions, with no frame scheduled', () => {
    const { frames, mounts, d } = drawer(true);
    d.open();
    expect(d.progress).toEqual({ panel: 1, scrim: 1 });
    expect(frames.queue.size).toBe(0);
    d.close();
    expect(d.progress).toEqual({ panel: 0, scrim: 0 });
    expect(mounts).toEqual([true, false]);
    expect(frames.queue.size).toBe(0);
  });

  it('a live reduced-motion change mid-transition finishes the spatial motion immediately, entering or leaving', () => {
    const entering = drawer();
    entering.d.open();
    entering.frames.step(100);
    entering.flags.reduced = true;
    entering.d.reducedMotionChanged();
    expect(entering.d.progress).toEqual({ panel: 1, scrim: 1 });
    expect(entering.frames.queue.size).toBe(0);

    const leaving = drawer();
    leaving.d.open();
    leaving.frames.run(400);
    leaving.d.close();
    leaving.frames.step(60);
    leaving.flags.reduced = true;
    leaving.d.reducedMotionChanged();
    expect(leaving.d.progress).toEqual({ panel: 0, scrim: 0 });
    expect(leaving.mounts.at(-1)).toBe(false);
    expect(leaving.frames.queue.size).toBe(0);

    // Turning the preference off again affects only the next transition.
    leaving.flags.reduced = false;
    leaving.d.reducedMotionChanged();
    leaving.d.open();
    expect(leaving.d.animating).toBe(true);
  });

  it('a hidden document lands on the end state; a visible one changes nothing', () => {
    const { frames, d } = drawer();
    d.open();
    frames.step(100);
    d.visibilityChanged(false);
    expect(d.animating).toBe(true);
    d.visibilityChanged(true);
    expect(d.progress).toEqual({ panel: 1, scrim: 1 });
    expect(frames.queue.size).toBe(0);
  });
});

describe('closing is decided at once: focus, scroll lock and the exiting picture', () => {
  it('returns focus to the opener when it can take focus, else the fixed trigger, else nowhere', () => {
    type El = { name: string; alive: boolean };
    const opener: El = { name: 'opener', alive: true };
    const trigger: El = { name: 'trigger', alive: true };
    const ok = (e: El) => e.alive;
    expect(pickFocusTarget(opener, trigger, ok)).toBe(opener);
    opener.alive = false;
    expect(pickFocusTarget(opener, trigger, ok)).toBe(trigger);
    expect(pickFocusTarget<El>(null, trigger, ok)).toBe(trigger);
    trigger.alive = false;
    expect(pickFocusTarget(opener, trigger, ok)).toBeNull();
    expect(pickFocusTarget<El>(null, null, ok)).toBeNull();
  });

  it('locks background scrolling and restores exactly what was there, once, however many releases', () => {
    const root = { style: { overflow: 'scroll' } };
    const lock = createScrollLock(root);
    const release = lock();
    expect(root.style.overflow).toBe('hidden');
    release();
    release();
    expect(root.style.overflow).toBe('scroll');

    const empty = { style: { overflow: '' } };
    const again = createScrollLock(empty);
    const a = again();
    const b = again();
    a();
    expect(empty.style.overflow).toBe('hidden');
    b();
    expect(empty.style.overflow).toBe('');
    // A fresh lock captures the then-current value, not a stale one.
    empty.style.overflow = 'auto';
    again()();
    expect(empty.style.overflow).toBe('auto');
  });

  it('an exiting drawer is inert, hidden from assistive technology and ignores the pointer; an open one is not', () => {
    const props = { mode: 'synthetic' as const, onClose: () => {}, onClear: () => {} };
    const open = renderToStaticMarkup(<DrawerLayer exiting={false} {...props} />);
    expect(open).not.toMatch(/data-exiting|inert|aria-hidden="true">\s*<div/);
    expect(open).toMatch(/role="dialog"/);
    expect(open).toMatch(/aria-modal="true"/);
    // The scrim is decoration, never announced.
    expect(open).toMatch(/class="drawer-scrim"[^>]*aria-hidden="true"/);

    const leaving = renderToStaticMarkup(<DrawerLayer exiting {...props} />);
    expect(leaving).toMatch(/class="drawer-layer" data-exiting="true"/);
    expect(leaving).toMatch(/<div[^>]*role="dialog"[^>]*inert=""/);
    expect(leaving).toMatch(/<div[^>]*role="dialog"[^>]*aria-hidden="true"/);
  });

  it('keeps privacy and licences reachable while Clear and Close remain outside the disclosure', async () => {
    for (const exiting of [false, true]) {
      const html = renderToStaticMarkup(<MenuSheet mode="live" exiting={exiting} onClose={() => {}} onClear={() => {}} />);
      expect(html).toContain('Privacy &amp; sources');
      expect(html).not.toMatch(/short-lived session cookie/);
      expect(html).toMatch(/Clear session/);
      expect(html).toMatch(/aria-label="Close"/);
      expect(html).toMatch(/tabindex="-1"/);
    }
    const open = await expandedMenu({ mode: 'live', onClose() {}, onClear() {} });
    expect(open).toMatch(/short-lived session cookie/);
    expect(open).toContain('No Wintr account or permanent chat history.');
    expect(open).toContain('New chats share that expiry.');
    expect(open).toContain('Clear removes access immediately; server deletion follows.');
    expect(open).toContain('/licenses/Inter-OFL.txt');
    expect(open).not.toContain('/licenses/SpaceGrotesk-OFL.txt');
  });

  it('closing and Clear are plain callbacks: the scrim, Close and Clear invoke them synchronously', () => {
    const onClose = vi.fn();
    const onClear = vi.fn();
    const tree = DrawerLayer({ exiting: false, mode: null, onClose, onClear });
    const children = (tree as { props: { children: { props: { onClick?: () => void; onClose?: () => void; onClear?: () => void } }[] } }).props.children;
    children[0]!.props.onClick?.();
    expect(onClose).toHaveBeenCalledTimes(1);
    const sheet = children[1]!.props;
    sheet.onClear?.();
    sheet.onClose?.();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
