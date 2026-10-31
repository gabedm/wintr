// @vitest-environment jsdom
import { StrictMode, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Appear, IntroCard, OutgoingPicture, useIntro } from '../src/client/conversation-motion.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// Real React effect lifecycle (mount, StrictMode setup/cleanup/replay, unmount) for the outgoing picture and the
// ordinary Appear wrapper, in jsdom with a controlled frame clock and synthetic data only. jsdom has no layout, so
// this proves the lifecycle and the written progress values; it is not browser, device or visual evidence.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let frames: FakeFrames;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  frames = new FakeFrames();
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.raf(cb));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.caf(id));
  vi.spyOn(performance, 'now').mockImplementation(() => frames.t);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

const mount = (node: ReactNode) => act(() => root.render(node));
const RECT = { top: 340, left: 0, width: 360, height: 120 };
const ghost = () => host.querySelector<HTMLElement>('.token-ghost');
const progress = (el: HTMLElement | null) => (el && el.hasAttribute('data-playing') ? Number(el.style.getPropertyValue('--p')) : 1);
const picture = (onGone: () => void, from = 0.4) => (
  <OutgoingPicture rect={RECT} from={from} ms={120} onGone={onGone}>
    <p>Keeping: “a synthetic relationship”</p>
  </OutgoingPicture>
);

function IntroFocusProbe({ resolved }: { resolved: boolean }) {
  const intro = useIntro({ resolved, empty: true, interrupted: false, wipe: 0 });
  return <><IntroCard attach={intro.attach}><span aria-hidden="true">Emblem</span></IntroCard><input aria-label="Song link" onFocus={intro.reveal} /></>;
}

describe('welcome keyboard entry before asynchronous readiness', () => {
  it.each([false, true])('focus reveals the card immediately with initial state resolved=%s, and pending fonts cannot hide it again', async (resolved) => {
    let ready!: () => void;
    const fonts = new Promise<void>((resolve) => { ready = resolve; });
    const previous = Object.getOwnPropertyDescriptor(document, 'fonts');
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: fonts } });
    try {
      mount(<IntroFocusProbe resolved={resolved} />);
      const card = host.querySelector<HTMLElement>('.intro')!;
      if (!resolved) expect(card.style.getPropertyValue('--intro-card')).toBe('0');
      const start = host.querySelector<HTMLInputElement>('input')!;
      act(() => start.focus());
      expect(document.activeElement).toBe(start);
      expect(card.style.getPropertyValue('--intro-card')).toBe('');
      expect(frames.queue.size).toBe(0);
      mount(<IntroFocusProbe resolved />);
      await act(async () => { ready(); await fonts; });
      frames.step(500);
      expect(card.style.getPropertyValue('--intro-card')).toBe('');
      expect(document.activeElement).toBe(start);
      expect(frames.queue.size).toBe(0);
    } finally {
      if (previous) Object.defineProperty(document, 'fonts', previous);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });
});

describe.each([
  ['an ordinary mount', (n: ReactNode) => n],
  ['StrictMode effect setup, cleanup and replay', (n: ReactNode) => <StrictMode>{n}</StrictMode>],
])('outgoing picture continuing a mid-entrance token: %s', (_name, wrap) => {
  it('keeps the captured visible opacity (never re-seeded to 1) and leaves in the scaled remaining time', () => {
    const onGone = vi.fn();
    mount(wrap(picture(onGone)));
    const el = ghost()!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('inert')).toBe(true);
    // Exactly the captured presentation, with exactly one frame scheduled (a replay must not stack a second run).
    expect(progress(el)).toBe(0.4);
    expect(frames.queue.size).toBe(1);
    expect(onGone).not.toHaveBeenCalled();

    frames.step(16);
    const early = progress(el);
    expect(early).toBeLessThan(0.4);
    expect(early).toBeGreaterThan(0);
    // 120 ms x 0.4 remaining: still visible just before, gone by the end, nothing left running.
    frames.step(48 - 16 - 1);
    expect(onGone).not.toHaveBeenCalled();
    expect(progress(el)).toBeGreaterThan(0);
    act(() => frames.step(1));
    expect(progress(el)).toBe(0);
    expect(onGone).toHaveBeenCalled();
    expect(frames.queue.size).toBe(0);
  });

  it('a token at rest still leaves over the full 120 ms from opacity 1', () => {
    const onGone = vi.fn();
    mount(wrap(picture(onGone, 1)));
    const el = ghost()!;
    expect(progress(el)).toBe(1);
    frames.step(60);
    expect(progress(el)).toBeLessThan(1);
    expect(progress(el)).toBeGreaterThan(0);
    expect(onGone).not.toHaveBeenCalled();
    act(() => frames.step(60));
    expect(onGone).toHaveBeenCalled();
    expect(frames.queue.size).toBe(0);
  });

  it('unmounting mid-exit (Clear, expiry, ownership change) removes the picture and every pending frame with no late callback', () => {
    const onGone = vi.fn();
    mount(wrap(picture(onGone)));
    frames.step(16);
    mount(wrap(<p>cleared</p>));
    expect(ghost()).toBeNull();
    expect(frames.queue.size).toBe(0);
    frames.step(500);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('a hidden page finishes the exit at once', () => {
    const onGone = vi.fn();
    mount(wrap(picture(onGone)));
    frames.step(16);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(progress(ghost())).toBe(0);
    expect(onGone).toHaveBeenCalled();
    expect(frames.queue.size).toBe(0);
  });

  it('reduced motion removes it at once, without a frame', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    const onGone = vi.fn();
    mount(wrap(picture(onGone)));
    expect(onGone).toHaveBeenCalled();
    expect(frames.queue.size).toBe(0);
  });
});

describe('the ordinary entrance wrapper is not changed by the replay-safe exit path', () => {
  const entering = (play: boolean) => (
    <Appear play={play} enterMs={160} y={3}>
      <p>synthetic result</p>
    </Appear>
  );

  it.each([
    ['an ordinary mount', (n: ReactNode) => n],
    ['StrictMode', (n: ReactNode) => <StrictMode>{n}</StrictMode>],
  ])('%s: a fresh unit starts hidden, enters over 160 ms and ends at rest with nothing running', (_n, wrap) => {
    mount(wrap(entering(true)));
    const el = host.querySelector<HTMLElement>('[data-appear]')!;
    expect(el.hasAttribute('data-playing')).toBe(true);
    expect(progress(el)).toBe(0);
    frames.step(16);
    expect(progress(el)).toBeGreaterThan(0);
    expect(progress(el)).toBeLessThan(1);
    act(() => frames.step(160));
    expect(el.hasAttribute('data-playing')).toBe(false);
    expect(frames.queue.size).toBe(0);
  });

  it('a restored unit mounts at rest and never replays', () => {
    mount(<StrictMode>{entering(false)}</StrictMode>);
    const el = host.querySelector<HTMLElement>('[data-appear]')!;
    expect(el.hasAttribute('data-playing')).toBe(false);
    expect(frames.queue.size).toBe(0);
  });
});
