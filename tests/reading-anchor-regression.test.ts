import { describe, expect, it } from 'vitest';
import { ReadingAnchor, FOLLOW_MS, type AnchorEnv } from '../src/client/reading-anchor.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// The rendered failure left all recording headings above the reader. These
// geometry fakes exercise the policy, not browser layout or device acceptance.
function setup(nativeClamp: number | null = null) {
  const frames = new FakeFrames();
  const state = { top: 980, max: 1000, reduced: false };
  const writes: number[] = [];
  const pending: (string | null)[] = [];
  const env: AnchorEnv = {
    now: () => frames.now(), raf: cb => frames.raf(cb), caf: id => frames.caf(id),
    scrollTop: () => state.top, maxScrollTop: () => state.max,
    setScrollTop: y => { state.top = nativeClamp !== null ? Math.min(Math.max(0, state.max - nativeClamp), y) : y; writes.push(y); }, reducedMotion: () => state.reduced,
  };
  const anchor = new ReadingAnchor(env, key => pending.push(key));
  anchor.measure();
  return { anchor, state, writes, pending, frames };
}

describe('new answer start takes precedence over a footer', () => {
  it('retires an explicit offer when removing its row natively clamps a short document', () => {
    const s = setup(); s.state.top = 0; s.anchor.measure();
    expect(s.anchor.onResult('reference', 400)).toBe('pending');
    s.state.max = 85; s.state.top = 84.8;
    s.anchor.reveal(400); expect(s.pending.at(-1)).toBeNull();
    // The44pxoffer plus its8pxgap leaves the DOM before the next scroll event.
    // Native scroll maximum is fractional although scrollHeight is rounded.
    s.state.max = 33; s.state.top = 32.8; s.anchor.onScroll();
    s.frames.run(400);
    expect(s.pending.at(-1)).toBeNull(); expect(s.state.top).toBe(33);
  });

  it('retains an answer target when a layout shrink clamps an automatic follow', () => {
    const s = setup(); expect(s.anchor.onResult('choices', 1000)).toBe('follow');
    s.state.max = 800; s.state.top = 800; s.anchor.onScroll(); s.frames.run(400);
    expect(s.pending.at(-1)).not.toBe('choices'); expect(s.state.top).toBe(800);
  });

  it('still cancels on actual input before a document clamp', () => {
    const s = setup(); s.state.top = 0; s.anchor.measure();s.anchor.onResult('reference', 400);
    s.state.max = 85; s.state.top = 84.8;s.anchor.reveal(400);
    s.anchor.onUserInput();const writes=s.writes.length;
    s.state.max=33;s.state.top=32.8;s.anchor.onScroll();s.frames.run(400);
    expect(s.pending.at(-1)).toBe('reference');expect(s.writes).toHaveLength(writes);expect(s.state.top).toBe(32.8);
  });

  it('does not call a scroll away from the new maximum a native clamp', () => {
    const s=setup();s.anchor.onResult('choices',1000);
    s.state.max=800;s.state.top=500;s.anchor.onScroll();const writes=s.writes.length;s.frames.run(400);
    expect(s.pending.at(-1)).toBe('choices');expect(s.writes).toHaveLength(writes);expect(s.state.top).toBe(500);
  });

  it('also accepts the native scroll echo when layout retargeted first', () => {
    const s=setup();s.state.top=0;s.anchor.measure();s.anchor.onResult('reference',400);
    s.state.max=85;s.state.top=84.8;s.anchor.reveal(400);
    s.state.max=33;s.state.top=32.8;s.anchor.layoutChanged();s.anchor.onScroll();s.frames.run(400);
    expect(s.pending.at(-1)).toBeNull();expect(s.state.top).toBe(33);
  });

  it('keeps repeated shrinking native maxima including zero from reoffering the same answer', () => {
    const s=setup();s.anchor.onResult('choices',1000);
    for(const max of [800,400,0]){s.state.max=max;s.state.top=max;s.anchor.onScroll();s.frames.run(400);}
    expect(s.pending.at(-1)).not.toBe('choices');expect(s.state.top).toBe(0);
  });

  it('adopts a maximum that changed just before a tween write was natively clamped', () => {
    const s=setup(0.2);s.anchor.onResult('choices',1000);s.state.max=500;
    s.frames.step(48);expect(s.state.top).toBe(499.8);s.anchor.onScroll();s.frames.run(400);
    expect(s.pending.at(-1)).not.toBe('choices');expect(s.state.top).toBe(499.8);
  });

  it('corrects an eligible result above the current position over the locked follow', () => {
    const s = setup();
    s.anchor.userAction(); s.state.max = 2400; s.state.top = 1762;
    expect(s.anchor.onResult('choices', 700)).toBe('follow');
    s.frames.step(FOLLOW_MS / 2);
    expect(s.state.top).toBeLessThan(1762); expect(s.state.top).toBeGreaterThan(700);
    s.frames.step(FOLLOW_MS / 2);
    expect(s.state.top).toBe(700);
  });

  it('does not replace an eligible answer target with a composer/viewport footer pin', () => {
    const s = setup(); s.anchor.onResult('choices', 1000); s.frames.step(48);
    s.state.max = 2600; s.anchor.pinIfNear(); s.anchor.viewportMoved();
    s.frames.run(400);
    expect(s.state.top).toBe(1000);
    expect(s.writes).not.toContain(2600);
  });

  it('offers a missing result instead of guessing that its start is the footer', () => {
    const s = setup();
    expect(s.anchor.onResult('hidden-result', null)).toBe('pending');
    s.anchor.pinIfNear(); s.frames.run(400);
    expect(s.writes).toEqual([]); expect(s.pending.at(-1)).toBe('hidden-result');
    s.anchor.reveal(null); s.frames.run(400);
    expect(s.writes).toEqual([]); expect(s.pending.at(-1)).toBe('hidden-result');
  });

  it('re-measures a protected result after wrapping without replaying unchanged geometry', () => {
    const s = setup(); let start = 1000;
    s.anchor.onResult('choices', () => start); s.frames.step(48);
    const at = s.state.top;
    start = 1200; s.state.max = 3000; s.anchor.layoutChanged();
    expect(s.state.top).toBe(at);
    s.frames.run(400); expect(s.state.top).toBe(1200);
    const count = s.writes.length;
    s.anchor.layoutChanged(); s.anchor.pinIfNear();
    expect(s.writes).toHaveLength(count);
    start = 1350; s.anchor.viewportMoved();
    expect(s.state.top).toBe(1350); expect(s.frames.queue.size).toBe(0);
  });

  it.each(['input', 'scrollbar'] as const)('a real %s interruption cancels result and later layout writes, with an explicit offer', (kind) => {
    const s = setup(); s.anchor.onResult('choices', 1000); s.frames.step(48);
    if (kind === 'input') s.anchor.onUserInput();
    s.state.top = 200; s.anchor.onScroll();
    const count = s.writes.length;
    s.state.max = 3000; s.anchor.layoutChanged(); s.anchor.viewportMoved(); s.frames.run(400);
    expect(s.state.top).toBe(200); expect(s.writes).toHaveLength(count);
    expect(s.pending.at(-1)).toBe('choices');
    s.anchor.reveal(1000); s.frames.run(400);
    expect(s.state.top).toBe(1000); expect(s.pending.at(-1)).toBeNull();
  });

  it('a reader who left the bottom during work receives an offer without a layout pin', () => {
    const s = setup(); s.anchor.userAction(); s.anchor.onUserInput();
    s.state.top = 100; s.anchor.onScroll(); s.state.max = 2400;
    expect(s.anchor.onResult('new', 1200)).toBe('pending');
    s.anchor.layoutChanged(); s.anchor.viewportMoved(); s.frames.run(400);
    expect(s.writes).toEqual([]); expect(s.state.top).toBe(100);
  });

  it('accepts the native scroll echo already queued when the new result was measured', () => {
    const s = setup(); s.state.max = 2400; s.state.top = 1762;
    s.anchor.userAction(); s.anchor.onResult('choices', 700); s.anchor.onScroll();
    s.frames.run(400); expect(s.state.top).toBe(700); expect(s.pending.at(-1)).not.toBe('choices');
  });

  it('reset revokes a retained resolver before any late frame or layout callback', () => {
    const s = setup(); const read = () => { throw new Error('revoked result must not be measured'); };
    let live = true;
    s.anchor.onResult('old', () => live ? 1000 : read()); s.frames.step(48);
    s.anchor.reset(); live = false;
    const count = s.writes.length;
    s.frames.run(400);
    expect(s.writes).toHaveLength(count);
    // The listener is away; a late layout event cannot consult the old resolver.
    s.state.top = 100; s.anchor.onScroll(); s.anchor.layoutChanged();
    expect(s.writes).toHaveLength(count);
  });

  it('reduced motion still corrects upward instantly, without a frame', () => {
    const s = setup(); s.state.reduced = true;
    s.anchor.onResult('no-match', 400);
    expect(s.state.top).toBe(400); expect(s.frames.queue.size).toBe(0);
  });
});
