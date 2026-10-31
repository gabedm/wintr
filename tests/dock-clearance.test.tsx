// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockClearance, dockClearance, type DockMeasurement } from '../src/client/dock-clearance.js';
import { useDockClearance, ViewportHub } from '../src/client/viewport-hooks.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// Controlled boxes reproduce reported bounds and verify the policy/lifecycle.
// They do not demonstrate Chrome focus scrolling, rendered hit tests or zoom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const short = (): DockMeasurement => ({ layoutHeight: 320, visual: null, dock: { top: 69.4, height: 250.6 }, controlHeight: 45.6 });

describe('root clearance uses actual visible bounds and intrinsic capacity', () => {
  it('the reproduced six-line dock leaves a full End field in the preferred view, instead of using all 320px', () => {
    const p = dockClearance(short())!;
    expect(p).toEqual({ top: 8, bottom: 259, flow: false });
    expect(320 - p.top - p.bottom).toBeGreaterThanOrEqual(45.6);
    expect(320 - p.bottom).toBeLessThan(69.4);
  });
  it('includes an overlay keyboard once from layout bottom, including visual panning', () => {
    expect(dockClearance({ layoutHeight: 852, visual: { offsetTop: 20, height: 400 }, dock: { top: 320, height: 100 }, controlHeight: 44 }))
      .toEqual({ top: 28, bottom: 540, flow: false });
    expect(dockClearance({ layoutHeight: 400, visual: { offsetTop: 0, height: 400 }, dock: { top: 300, height: 100 }, controlHeight: 44 }))
      .toEqual({ top: 8, bottom: 108, flow: false });
  });
  it('a New answer/long-editor/disclosure dock that leaves too little space returns to document flow without clipping a control', () => {
    const m = { ...short(), dock: { top: 17.4, height: 302.6 } };
    expect(dockClearance(m)).toEqual({ top: 8, bottom: 8, flow: true });
    expect(dockClearance({ ...m, dock: { ...m.dock, top: 600 } })).toEqual(dockClearance(m));
  });
  it('large text uses the measured control height and normal portrait/desktop retains sticky mode', () => {
    expect(dockClearance({ ...short(), controlHeight: 100 })!.flow).toBe(true);
    expect(dockClearance({ layoutHeight: 852, visual: null, dock: { top: 766, height: 86 }, controlHeight: 45.6 }))
      .toEqual({ top: 8, bottom: 94, flow: false });
    expect(dockClearance({ layoutHeight: 720, visual: null, dock: { top: 634, height: 86 }, controlHeight: 45.6 })!.flow).toBe(false);
  });
  it.each([0, NaN, Infinity])('does not turn unmeasured/invalid layout %s into a guessed viewport', (layoutHeight) => {
    expect(dockClearance({ ...short(), layoutHeight })).toBeNull();
  });
});

describe('coalesced measurement never scrolls or writes after disposal', () => {
  it('coalesces resize/viewport events, avoids write loops and remeasures a positional-mode change once', () => {
    const frames = new FakeFrames(); const plans: object[] = [];
    let m = { ...short(), dock: { top: 17.4, height: 302.6 } };
    const c = new DockClearance({ frames, read: () => m, apply: (p) => {
      plans.push(p); m = { ...m, dock: { ...m.dock, top: p.flow ? 600 : 200 } };
    } });
    c.measure();
    for (let i = 0; i < 20; i++) c.changed();
    expect(frames.queue.size).toBe(1); frames.step(16);
    expect(plans).toHaveLength(1); expect(frames.queue.size).toBe(0);
    m = { ...m, dock: { top: 600, height: 120 } }; c.changed(); frames.step(16);
    expect(frames.queue.size).toBe(1); frames.step(16);
    expect(plans.at(-1)).toEqual({ top: 8, bottom: 128, flow: false });
    expect(frames.queue.size).toBe(0);
    const count = plans.length; c.changed(); c.dispose(); c.measure(); c.changed(); frames.step(100);
    expect(plans).toHaveLength(count);
  });
  it('a missing/disconnected current measurement cannot apply a late owner snapshot', () => {
    const frames = new FakeFrames(), apply = vi.fn(); let m: DockMeasurement | null = short();
    const c = new DockClearance({ frames, read: () => m, apply }); c.changed(); m = null; frames.step(16);
    expect(apply).not.toHaveBeenCalled(); c.dispose();
  });
});

describe('actual hook binding, cleanup and native-focus-only behavior', () => {
  it('preserves current focus/manual scroll, updates measured padding, and restores prior inline styles/flag despite queued and late callbacks', () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const html = document.documentElement;
    const savedHeight = Object.getOwnPropertyDescriptor(html, 'clientHeight');
    const oldTop = html.style.getPropertyValue('scroll-padding-top'), oldBottom = html.style.getPropertyValue('scroll-padding-bottom');
    const oldTopPriority = html.style.getPropertyPriority('scroll-padding-top'), oldBottomPriority = html.style.getPropertyPriority('scroll-padding-bottom');
    Object.defineProperty(html, 'clientHeight', { configurable: true, value: 320 });
    html.style.setProperty('scroll-padding-top', '12px', 'important'); html.style.setProperty('scroll-padding-bottom', '13px');
    const frames = new FakeFrames();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.raf(() => cb(frames.now())));
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.caf(id));
    const observers: { callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn(); observe() {} unobserve() {}
      constructor(callback: ResizeObserverCallback) { observers.push({ callback, disconnect: this.disconnect }); }
    });
    let dockHeight = 250.6;
    let invalidateViewport: (() => void) | undefined;
    const unsubscribeViewport = vi.fn();
    vi.spyOn(ViewportHub.prototype, 'subscribe').mockImplementation(listener => {
      invalidateViewport = listener;
      return unsubscribeViewport;
    });
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      const top = this.hasAttribute('data-test-dock') ? 69.4 : 183.6;
      const height = this.hasAttribute('data-test-dock') ? dockHeight : 45.6;
      return { top, bottom: top + height, left: 0, right: 200, height, width: 200, x: 0, y: top, toJSON() {} };
    });
    let footer!: HTMLDivElement;
    function Fixture() {
      const context = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null);
      const viewport = useRef(new ViewportHub()).current;
      useDockClearance(context, dock, viewport);
      return <><div ref={context}><input aria-label="End" /></div><div ref={el => { dock.current = el; if (el) footer = el; }} data-test-dock data-flow="prior" /></>;
    }
    const initialScroll = html.scrollTop;
    try {
      act(() => root.render(<Fixture />));
      const field = host.querySelector('input')!;
      field.focus(); html.scrollTop = 330.4;
      act(() => { window.dispatchEvent(new Event('scroll')); frames.step(16); });
      expect(document.activeElement).toBe(field); expect(html.scrollTop).toBe(330.4);
      expect(html.style.getPropertyValue('scroll-padding-bottom')).toBe('259px');
      expect(footer.hasAttribute('data-flow')).toBe(false);
      bounds.mockClear();
      // A user drag or an interrupted/programmatic follow can deliver many
      // document scroll events. None may repeatedly sample layout geometry.
      act(() => {
        for (let i = 0; i < 100; i++) {
          window.dispatchEvent(new Event('scroll'));
          frames.step(16);
        }
      });
      expect(bounds).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(field); expect(html.scrollTop).toBe(330.4);
      dockHeight = 302.6;
      act(() => { observers[0]!.callback([], {} as ResizeObserver); frames.step(16); frames.step(16); });
      expect(bounds).toHaveBeenCalled();
      expect(footer.hasAttribute('data-flow')).toBe(true);
      expect(html.style.getPropertyValue('scroll-padding-bottom')).toBe('8px');
      dockHeight = 250.6;
      bounds.mockClear();
      act(() => { invalidateViewport!(); frames.step(16); frames.step(16); });
      expect(bounds).toHaveBeenCalled();
      expect(footer.hasAttribute('data-flow')).toBe(false);
      expect(html.style.getPropertyValue('scroll-padding-bottom')).toBe('259px');
      act(() => { invalidateViewport!(); root.unmount(); });
      expect(frames.queue.size).toBe(0);
      for (const o of observers) o.callback([], {} as ResizeObserver);
      frames.step(100);
      expect(html.style.getPropertyValue('scroll-padding-top')).toBe('12px');
      expect(html.style.getPropertyPriority('scroll-padding-top')).toBe('important');
      expect(html.style.getPropertyValue('scroll-padding-bottom')).toBe('13px');
      expect(footer.getAttribute('data-flow')).toBe('prior');
      expect(observers.every(o => o.disconnect.mock.calls.length === 1)).toBe(true);
      expect(unsubscribeViewport).toHaveBeenCalledOnce();
    } finally {
      bounds.mockRestore(); host.remove(); html.scrollTop = initialScroll;
      if (savedHeight) Object.defineProperty(html, 'clientHeight', savedHeight); else Reflect.deleteProperty(html, 'clientHeight');
      for (const [name, value, priority] of [['scroll-padding-top', oldTop, oldTopPriority], ['scroll-padding-bottom', oldBottom, oldBottomPriority]]) {
        if (value) html.style.setProperty(name!, value, priority); else html.style.removeProperty(name!);
      }
    }
  });
});

describe('retained focus after a real viewport change', () => {
  it.each(['none', 'wheel', 'scroll', 'pointerdown', 'touchstart', 'PageDown', 'replace', 'inert', 'visible', 'late_scroll', 'detached'] as const)(
    'reveals an occluded retained control once, unless %s supersedes its focus', cause => {
      const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
      const html = document.documentElement, priorHeight = Object.getOwnPropertyDescriptor(html, 'clientHeight'), priorScroll = html.scrollTop;
      Object.defineProperty(html, 'clientHeight', { configurable: true, value: 390 });
      const frames = new FakeFrames();
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.raf(() => cb(frames.now())));
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.caf(id));
      let change!: () => void;
      vi.spyOn(ViewportHub.prototype, 'subscribe').mockImplementation(listener => { change = listener; return () => {}; });
      let controlTop = 100;
      const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
        const top = this.hasAttribute('data-test-dock') ? 239 : controlTop, height = this.hasAttribute('data-test-dock') ? 151 : 44;
        return { top, bottom: top + height, left: 0, right: 200, height, width: 200, x: 0, y: top, toJSON() {} };
      });
      function Fixture() {
        const context = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null);
        const viewport = useRef(new ViewportHub()).current;
        useDockClearance(context, dock, viewport);
        return <div className="app"><button>Earlier feedback</button><button>Other control</button><div ref={context} /><div ref={dock} data-test-dock /></div>;
      }
      try {
        act(() => root.render(<Fixture />));
        const target = host.querySelector('button')!, other = host.querySelectorAll('button')[1]!;
        const reveal = vi.fn(); target.scrollIntoView = reveal;
        act(() => { target.focus(); frames.step(16); frames.step(16); });
        bounds.mockClear();
        act(() => { for (let n = 0; n < 100; n++) window.dispatchEvent(new Event('scroll')); });
        expect(bounds).not.toHaveBeenCalled();
        // A fresh focus event re-arms after the deliberate read-scroll above.
        act(() => { other.focus(); target.focus(); frames.step(16); frames.step(16); });
        controlTop = cause === 'visible' || cause === 'late_scroll' ? 100 : 345;
        act(() => {
          if (cause === 'scroll') window.dispatchEvent(new Event('scroll'));
          change(); change(); change();
          if (cause === 'replace') other.focus();
          else if (cause === 'inert') host.querySelector('.app')!.setAttribute('inert', '');
          else if (cause === 'detached') target.remove();
          else if (cause === 'PageDown') target.dispatchEvent(new KeyboardEvent('keydown', { key: cause, bubbles: true }));
          else if (['wheel', 'pointerdown', 'touchstart'].includes(cause)) window.dispatchEvent(new Event(cause));
          frames.step(16); frames.step(16);
          if (cause === 'late_scroll') {
            // No reveal occurred. A manual read-scroll before the next frame must not inherit a grace exemption.
            html.scrollTop += 50; window.dispatchEvent(new Event('scroll'));
            controlTop = 345; change(); frames.step(16); frames.step(16);
          }
          frames.step(16);
        });
        if (cause === 'none') {
          expect(reveal).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
          expect(document.activeElement).toBe(target);
        } else expect(reveal).not.toHaveBeenCalled();
        act(() => { change(); root.unmount(); frames.step(100); });
        expect(frames.queue.size).toBe(0);
      } finally {
        act(() => root.unmount()); host.remove(); html.scrollTop = priorScroll;
        if (priorHeight) Object.defineProperty(html, 'clientHeight', priorHeight); else Reflect.deleteProperty(html, 'clientHeight');
      }
    },
  );
});
