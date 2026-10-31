// @vitest-environment jsdom
import { MenuSheet } from '../src/client/App.js';
import { SheetLayer, WhyFooter } from '../src/client/WhySheet.js';
import { act, StrictMode, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusable, useModalAuthority, useSheetDrag } from '../src/client/overlay-hooks.js';
import { DrawerPresence, SHEET_MS } from '../src/client/presence.js';
import { useComposerHeight, useShellMotion, type ShellMotion } from '../src/client/viewport-hooks.js';
import { FakeFrames } from './fixtures/fake-frames.js';
import { useIntro } from '../src/client/conversation-motion.js';
import { useControlPress } from '../src/client/control-hooks.js';

// Real hook event bindings over deterministic frames and jsdom. Native focus
// scrolling, pointer capture and device/browser motion remain separate checks.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function frameClock() {
  const frames = new FakeFrames();
  vi.spyOn(performance, 'now').mockImplementation(() => frames.now());
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.raf(() => cb(frames.now())));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.caf(id));
  return frames;
}

it.each(['hidden', 'display'])('modal close skips an opener hidden by %s and restores the stable fallback', mode => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function Fixture({ open }: { open: boolean }) {
    useModalAuthority(open, () => {}, 'audit-focus-fallback');
    return <><div data-opener><button>Original opener</button></div><button id="audit-focus-fallback">Menu</button></>;
  }
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(<Fixture open={false} />));
  const opener = host.querySelector('button')!;
  opener.focus();
  act(() => root.render(<Fixture open />));
  const wrapper = host.querySelector<HTMLElement>('[data-opener]')!;
  if (mode === 'hidden') wrapper.hidden = true;
  else wrapper.style.display = 'none';
  expect(focusable(opener)).toBe(false);
  expect(focusable(host.querySelector('#audit-focus-fallback')!)).toBe(true);
  act(() => root.render(<Fixture open={false} />));
  expect(document.activeElement).toBe(host.querySelector('#audit-focus-fallback'));
});

it('a visibility-hidden opener is ineligible for focus restoration', () => {
  const button = document.createElement('button'); document.body.append(button);
  cleanups.push(() => button.remove());
  button.style.visibility = 'hidden';
  expect(focusable(button)).toBe(false);
  button.style.visibility = 'visible';
  expect(focusable(button)).toBe(true);
});

it('starting IME composition finishes an in-flight composer resize before the next input', () => {
  const frames = frameClock();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  let natural = 24;
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => natural);
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function Fixture({ value }: { value: string }) {
    const ref = useRef<HTMLTextAreaElement>(null);
    const motion = useShellMotion();
    const composer = useComposerHeight(ref, value, motion);
    return <textarea ref={ref} value={value} readOnly onCompositionStart={composer.onCompositionStart} onCompositionEnd={composer.onCompositionEnd} />;
  }
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(<Fixture value="a" />));
  natural = 120;
  act(() => root.render(<Fixture value="a longer draft" />));
  act(() => frames.step(40));
  const editor = host.querySelector('textarea')!;
  expect(Number.parseFloat(editor.style.height)).toBeLessThan(120);
  act(() => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  expect(editor.style.height).toBe('120px');
  act(() => frames.run(200));
  expect(editor.style.height).toBe('120px');
});

describe('home, menu and listening press bindings', () => {
  it.each(['menu', 'start', 'listen'] as const)('%s uses the locked press and cancels without activating', kind => {
    const frames = frameClock();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const activate = vi.fn();
    function Fixture() {
      useControlPress();
      return <><button className="session-trigger" onClick={activate}>Menu</button><button className="intro-start" onClick={activate}>Add a song</button>
        <a className="primary play" href="#invented-destination" onClick={activate}>Synthetic listening link</a></>;
    }
    act(() => root.render(<Fixture />));
    cleanups.push(() => { act(() => root.unmount()); host.remove(); });
    const target = host.querySelector<HTMLElement>(kind === 'menu' ? '.session-trigger' : kind === 'start' ? '.intro-start' : '.play')!;
    const down = new Event('pointerdown', { bubbles: true });
    Object.defineProperties(down, { isPrimary: { value: true }, pointerType: { value: 'mouse' }, button: { value: 0 } });
    act(() => { target.dispatchEvent(down); frames.step(80); });
    expect(target.hasAttribute('data-pressing')).toBe(true);
    expect(Number(target.style.getPropertyValue('--press'))).toBeCloseTo(.97);
    act(() => { target.dispatchEvent(new Event('pointercancel', { bubbles: true })); frames.step(120); });
    expect(target.hasAttribute('data-pressing')).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
});

function shellFixture() {
  const frames = frameClock();
  const html = document.documentElement;
  const previous = ['clientHeight', 'clientWidth', 'scrollHeight'].map(name => [name, Object.getOwnPropertyDescriptor(html, name)] as const);
  Object.defineProperties(html, {
    clientHeight: { configurable: true, value: 852 }, clientWidth: { configurable: true, value: 394 }, scrollHeight: { configurable: true, value: 3252 },
  });
  const beforeScroll = html.scrollTop;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let shell!: ShellMotion;
  function Fixture() {
    shell = useShellMotion();
    return <><button>Visible control</button><input /><textarea /><div contentEditable suppressContentEditableWarning>Editable text</div></>;
  }
  act(() => root.render(<Fixture />));
  // jsdom does not implement this browser property; preserve its real meaning.
  Object.defineProperty(host.querySelector('[contenteditable]')!, 'isContentEditable', { value: true });
  cleanups.push(() => {
    act(() => root.unmount()); host.remove(); html.scrollTop = beforeScroll;
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(html, name, descriptor); else Reflect.deleteProperty(html, name);
    }
  });
  const scrolled = vi.spyOn(shell.anchor, 'onScroll');
  const follow = (target: HTMLElement) => act(() => {
    target.focus(); html.scrollTop = 1900;
    shell.anchor.userAction(); shell.anchor.onResult('new-result', 700); frames.step(16);
    expect(shell.anchor.following).toBe(true);
  });
  return { frames, html, host, shell, scrolled, follow };
}

describe('actual reading-follow keyboard binding', () => {
  it.each(['button', 'input', 'textarea', '[contenteditable]'].flatMap(selector => [false, true].map(shiftKey => ({ selector, shiftKey }))))(
    'Tab interrupts from $selector with Shift=$shiftKey even when focus causes no native scroll', ({ selector, shiftKey }) => {
      const t = shellFixture(); const target = t.host.querySelector<HTMLElement>(selector)!;
      t.follow(target);
      const top = t.html.scrollTop;
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      act(() => target.dispatchEvent(event));
      expect(t.scrolled).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(target);
      expect(t.shell.anchor.following).toBe(false);
      act(() => t.frames.run(240));
      expect(t.html.scrollTop).toBe(top);
    },
  );

  it.each(['Home', 'End', 'ArrowUp', 'ArrowDown'])('%s remains ordinary editing and does not interrupt a follow inside an editable', key => {
    const t = shellFixture();
    for (const selector of ['input', 'textarea', '[contenteditable]']) {
      const target = t.host.querySelector<HTMLElement>(selector)!;
      t.follow(target);
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => target.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
      expect(t.shell.anchor.following).toBe(true);
      expect(document.activeElement).toBe(target);
    }
    expect(t.scrolled).not.toHaveBeenCalled();
  });

  it('ordinary page navigation still interrupts from a non-editable control', () => {
    const t = shellFixture(); const target = t.host.querySelector('button')!;
    t.follow(target);
    const top = t.html.scrollTop;
    const event = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
    act(() => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(t.shell.anchor.following).toBe(false);
    act(() => t.frames.run(240));
    expect(t.html.scrollTop).toBe(top);
    expect(t.scrolled).not.toHaveBeenCalled();
  });
});

describe('actual interrupted sheet cancel bindings', () => {
  it.each(['pointercancel', 'lostpointercapture'])('%s returns from both interrupted visual origins without dismissing', type => {
    const frames = frameClock();
    const presence = new DrawerPresence({ frames, ms: SHEET_MS, reducedMotion: () => false, write: () => {}, onMounted: () => {} });
    presence.open(); frames.step(100);
    const origin = presence.progress;
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const panel = { current: document.createElement('div') };
    vi.spyOn(panel.current, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 300, bottom: 400, width: 300, height: 400, x: 0, y: 0, toJSON() {} });
    const dismissed = vi.fn();
    function Fixture() { return <div {...useSheetDrag(presence, panel, dismissed, true)} data-handle />; }
    act(() => root.render(<Fixture />));
    cleanups.push(() => { act(() => root.unmount()); presence.dispose(); host.remove(); });
    const handle = host.querySelector<HTMLElement>('[data-handle]')!;
    handle.setPointerCapture = vi.fn();
    const pointer = (name: string, y: number, time: number) => {
      const event = new Event(name, { bubbles: true });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'touch' }, clientY: { value: y }, timeStamp: { value: time } });
      act(() => handle.dispatchEvent(event));
    };
    pointer('pointerdown', 0, 100);
    expect(presence.progress).toEqual(origin);
    pointer('pointermove', 40, 400);
    expect((1 - presence.progress.panel) * 408).toBeCloseTo((1 - origin.panel) * 408 + 40, 9);
    expect(presence.progress.scrim).toBeCloseTo(origin.scrim - 40 / 408, 9);
    const dragged = presence.progress;
    pointer(type, 40, 500);
    expect(presence.progress).toEqual(dragged);
    pointer('pointerup', 390, 510);
    expect(dismissed).not.toHaveBeenCalled();
    act(() => frames.step(219));
    expect(presence.progress.panel).toBeLessThan(1);
    act(() => frames.step(1));
    expect(presence.progress).toEqual({ panel: 1, scrim: 1 });
  });
});

it('unmounting the intro cancels its queued animation immediately', async () => {
  const frames = frameClock();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    try { act(() => root.unmount()); } finally { host.remove(); }
  };
  cleanups.push(unmount);
  function Fixture() {
    const intro = useIntro({ resolved: true, empty: true, interrupted: false, wipe: 0 });
    return <section ref={intro.attach}>Welcome</section>;
  }
  await act(async () => { root.render(<Fixture />); });
  expect(frames.queue.size).toBeGreaterThan(0);
  unmount();
  expect(frames.queue.size).toBe(0);
});
it('intro effect replay leaves the welcome visible at rest without orphan frames', async () => {
  const frames = frameClock();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  function Fixture() {
    const intro = useIntro({ resolved: true, empty: true, interrupted: false, wipe: 0 });
    return <section ref={intro.attach}>Welcome</section>;
  }
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  await act(async () => { root.render(<StrictMode><Fixture /></StrictMode>); });
  expect(host.querySelector('section')!.style.getPropertyValue('--intro-card')).toBe('');
  expect(frames.queue.size).toBe(0);
});
it('menu Stop hands focus to the dialog before its control disappears', () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const draw = (working: boolean) => <MenuSheet mode="synthetic" working={working} onClose={() => {}} onClear={() => {}} onStop={() => root.render(draw(false))} />;
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(draw(true)));
  const stop = [...host.querySelectorAll('button')].find(b => b.textContent === 'Stop')!;
  stop.focus(); act(() => stop.click());
  expect(document.activeElement).toBe(host.querySelector('[role="dialog"]'));
});

it('Why Stop preserves focus inside its dialog when the working footer disappears', () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const draw = (working: boolean) => <SheetLayer exiting={false} title="Why this connection" onClose={() => {}}
    footer={<WhyFooter working={working} stopping={false} onClear={() => {}} onStop={() => root.render(draw(false))} />}>
    <p>Invented connection</p>
  </SheetLayer>;
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  act(() => root.render(draw(true)));
  const stop = [...host.querySelectorAll('button')].find(b => b.textContent === 'Stop')!;
  stop.focus(); act(() => stop.click());
  expect(document.activeElement).toBe(host.querySelector('[role="dialog"]'));
});
