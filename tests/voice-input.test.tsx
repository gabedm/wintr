// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { App } from '../src/client/App.js';
import { ApiError } from '../src/client/api.js';

// Real App/controller/React wiring over an explicitly fake API: the one microphone control and its two-route
// chooser (honestly unavailable in this UI checkpoint), the accessible Send/Stop target, and the header
// emblem's facts. DOM and lifecycle evidence only: not rendered layout, device audio or owner acceptance.
const port = vi.hoisted(() => ({ state: vi.fn(), createSession: vi.fn(), reference: vi.fn(),
  preference: vi.fn(), artistChoice: vi.fn(), discover: vi.fn(), feedback: vi.fn(),
  refine: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
vi.mock('../src/client/api.js', async (original) => ({ ...await original<typeof import('../src/client/api.js')>(), api: port }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = (value: string) => value.padEnd(24, '0') as Handle;
const blank = (extra: Partial<SafeSnapshot> = {}): SafeSnapshot => ({
  mode: 'synthetic', exampleSource: false, session: null, stage: 'idle', revision: 0,
  status: null, attempt: null, reference: null, listenerCue: null, analysis: null,
  brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null, ...extra,
});
const ready = (): SafeSnapshot => blank({
  session: { context: 'invented-dom-session', expiresAt: Date.now() + 3_600_000 },
  stage: 'complete', revision: 3,
  reference: { videoId: 'aaaaaaaaaaa', canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', focus: { start: 12, end: 57 } },
  analysis: { handle: h('analysis'), synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['An invented observation.'], relationships: ['A low line'], proposedArtist: 'Invented Seed' },
  brief: { handle: h('brief'), version: 1, relationship: 'A low line', source: 'intake_cue', artists: ['Invented Seed'] },
  panel: { handle: h('panel'), synthetic: true, role: 'initial', mode: null, basis: [], outcome: 'choices',
    choices: [{ handle: h('choice'), title: 'Invented Recording', credits: ['Invented Neighbour'], anchor: 'Invented Neighbour', unverifiedCredits: 0, service: 'youtube', playUrl: null,
      fitHypothesis: 'An invented hypothesis.', sources: [], feedback: { fit: null, familiarity: null, revision: 0 } }],
    answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] },
  refinement: { used: false },
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let root: Root, host: HTMLDivElement;
const media = { getUserMedia: vi.fn(), enumerateDevices: vi.fn() };
const speech = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in this test'); }));
  vi.stubGlobal('SpeechRecognition', speech);
  vi.stubGlobal('webkitSpeechRecognition', speech);
  vi.stubGlobal('MediaRecorder', vi.fn());
  Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true });
  port.clear.mockResolvedValue(blank());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function boot(state: SafeSnapshot) {
  port.state.mockResolvedValue(state);
  await act(async () => { root.render(<App />); await flush(); });
}
function button(text: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
  if (!found) throw new Error('Missing expected synthetic-test control: ' + text);
  return found;
}
const click = async (text: string) => act(async () => { button(text).click(); await flush(); });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const emblem = () => host.querySelector<SVGSVGElement>('.emblem')!;
function typeLink(value: string) {
  const field = host.querySelector<HTMLTextAreaElement>('#source-url')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
const paidCalls = () => port.reference.mock.calls.length + port.discover.mock.calls.length + port.refine.mock.calls.length;
const MIC = 'Add music';

describe('one microphone control and its two-route chooser', () => {
  it('has one microphone in the composer and opens a titled dialog with two distinct, labelled routes', async () => {
    await boot(blank());
    expect(host.querySelector('.suggestions')).toBeNull();
    expect(host.querySelector('button.suggestion')).toBeNull();
    expect(host.querySelectorAll('.mic')).toHaveLength(1);
    const mic = button(MIC);
    expect(mic.closest('.composer')).not.toBeNull();
    expect(mic.getAttribute('aria-haspopup')).toBe('dialog');
    expect(dialog()).toBeNull();
    await click(MIC);
    const sheet = dialog()!;
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.querySelector('#sheet-input-title')!.textContent).toBe('Voice input');
    expect(sheet.getAttribute('aria-labelledby')).toBe('sheet-input-title');
    const routes = [...sheet.querySelectorAll<HTMLButtonElement>('.voice-route')];
    expect(routes.map((r) => r.querySelector('.voice-label')!.textContent)).toEqual(['Record music', 'Transcribe voice']);
    // Two different icons: a note (circles on stems) versus three plain vertical strokes.
    expect(routes[0]!.querySelectorAll('circle')).toHaveLength(2);
    const waves = routes[1]!.querySelectorAll('path');
    expect(waves).toHaveLength(1);
    expect(waves[0]!.getAttribute('d')!.match(/M/g)).toHaveLength(3);
    expect(routes[1]!.querySelectorAll('circle')).toHaveLength(0);
    // The page behind the modal is inert, and nothing is claimed to work.
    expect(host.querySelector('.app')!.hasAttribute('inert')).toBe(true);
    for (const r of routes) {
      expect(r.getAttribute('aria-disabled')).toBe('true');
      expect(r.textContent).toMatch(/Unavailable/);
    }
  });

  it('choosing a route explains honestly and requests no permission, stream, upload, recognition or provider', async () => {
    await boot(blank());
    await click(MIC);
    const route = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.voice-route')].find((r) => r.textContent!.includes(label))!;
    await act(async () => { route('Record music').click(); await flush(); });
    expect(document.querySelector('.voice-explanation')!.textContent).toMatch(/Recording music is not available in this version\. No microphone permission was requested and nothing was recorded/);
    await act(async () => { route('Transcribe voice').click(); await flush(); });
    expect(document.querySelector('.voice-explanation')!.textContent).toMatch(/Voice transcription is not available in this version\. No microphone permission was requested and nothing was recorded/);
    expect(document.querySelector('.voice-explanation')!.getAttribute('role')).toBe('status');
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.enumerateDevices).not.toHaveBeenCalled();
    expect(speech).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(paidCalls() + port.createSession.mock.calls.length + port.preference.mock.calls.length + port.feedback.mock.calls.length).toBe(0);
    expect(port.state).toHaveBeenCalledTimes(1);
  });

  it.each(['Stop', 'Clear session'] as const)('keeps %s directly reachable inside the chooser during active work', async (action) => {
    const attempt = { handle: h('active-discovery'), kind: 'discover' as const, active: true, outcome: 'running' as const };
    port.stop.mockResolvedValue({ ...ready(), revision: 4, stage: 'cancelled', code: 'cancelled', attempt: { ...attempt, active: false, outcome: 'cancelled' } });
    await boot({ ...ready(), stage: 'finding_tracks', attempt });
    await click(MIC);
    const sheet = dialog()!;
    const controls = [...sheet.querySelectorAll<HTMLButtonElement>('.sheet-foot button')];
    expect(controls.map((b) => b.textContent?.trim())).toEqual(['Stop', 'Clear session']);
    expect(controls.every((b) => b.closest('[inert]') === null)).toBe(true);
    await act(async () => { controls.find((b) => b.textContent?.trim() === action)!.click(); await flush(); });
    expect(action === 'Stop' ? port.stop : port.clear).toHaveBeenCalledTimes(1);
    expect(paidCalls()).toBe(0);
    if (action === 'Clear session') {
      expect(dialog()).toBeNull();
      expect(host.querySelector('.app')!.hasAttribute('inert')).toBe(false);
      expect(host.textContent).not.toContain('Invented Recording');
    }
  });

  it('Escape and Close dismiss at once and return focus to the microphone; the scrim does too', async () => {
    await boot(blank());
    // jsdom does not enforce `inert` on focus, and React's own selection restore then re-focuses the (inert) exiting
    // title; a browser ignores that. So the modal authority's request is observed directly.
    const requests: { id: string; inert: boolean; preventScroll: boolean | undefined }[] = [];
    const real = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      requests.push({ id: this.id, inert: this.closest('[inert]') !== null, preventScroll: options?.preventScroll });
      return real.call(this, options);
    });
    for (const how of ['escape', 'close', 'scrim'] as const) {
      // A real tap or key press focuses the control first; a programmatic click would not.
      button(MIC).focus();
      await click(MIC);
      expect(dialog()).not.toBeNull();
      expect(requests.some((r) => r.id === 'sheet-input-title')).toBe(true);
      requests.length = 0;
      if (how === 'escape') await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(); });
      else if (how === 'close') await act(async () => { dialog()!.querySelector<HTMLButtonElement>('.sheet-close')!.click(); await flush(); });
      else await act(async () => { document.querySelector<HTMLElement>('.sheet-scrim')!.click(); await flush(); });
      expect(dialog()).toBeNull();
      expect(host.querySelector('.app')!.hasAttribute('inert')).toBe(false);
      expect(requests[0], how).toEqual({ id: 'mic-trigger', inert: false, preventScroll: true });
    }
  });

  it('Tab stays inside the open dialog (wraps from the last control to the first and back)', async () => {
    await boot(blank());
    await click(MIC);
    const sheet = dialog()!;
    const items = [...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]')];
    expect(items.length).toBeGreaterThanOrEqual(4);
    items[items.length - 1]!.focus();
    await act(async () => { sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); await flush(); });
    expect(document.activeElement).toBe(items[0]);
    await act(async () => { sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); await flush(); });
    expect(document.activeElement).toBe(items[items.length - 1]);
  });
});

describe('Send and Stop remain one accessible target', () => {
  it('is aria-disabled with no link, becomes an enabled Send for a valid link, and the same element becomes Stop while work runs', async () => {
    const work = deferred<SafeSnapshot>(); port.reference.mockReturnValue(work.promise);
    await boot(ready());
    const send = button('Analyse reference');
    expect(send.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { send.click(); await flush(); });
    expect(paidCalls()).toBe(0);
    await act(async () => { typeLink('https://youtu.be/bbbbbbbbbbb'); await flush(); });
    expect(send.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { send.click(); await flush(); });
    expect(port.reference).toHaveBeenCalledTimes(1);
    const stop = button('Stop');
    expect(stop).toBe(send);
    expect(stop.hasAttribute('data-working')).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('#source-url')!.disabled).toBe(true);
    expect(stop.querySelector('.icon-stop rect')).not.toBeNull();
    expect(stop.querySelector('.icon-send path')).not.toBeNull();
    await act(async () => { work.resolve(blank()); await flush(); });
  });
});

describe('the plain Send arrow stays white on the black composer while unavailable', () => {
  // jsdom evaluates the real stylesheet's selectors and cascade but not var(); the root custom properties are substituted
  // textually first. This is cascade evidence only: real rendered pixels, zoom and devices remain a separate gate.
  function sheet() {
    const css = readFileSync('src/client/styles.css', 'utf8');
    const vars = new Map([...css.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()] as const));
    const resolved = css.replace(/var\((--[\w-]+)\)/g, (whole, name: string) => vars.get(name) ?? whole);
    const style = document.createElement('style');
    style.textContent = resolved;
    document.head.append(style);
    return style;
  }
  const computed = (el: Element) => { const c = getComputedStyle(el); return { background: c.backgroundColor, color: c.color, cursor: c.cursor }; };
  const WHITE_ARROW = { background: 'rgba(0, 0, 0, 0)', color: 'rgb(255, 255, 255)' };

  it('keeps a plain white arrow over the black composer in empty, disabled, enabled and working states', async () => {
    const style = sheet();
    try {
      await boot(blank());
      const send = button('Analyse reference');
      expect(send.getAttribute('aria-disabled')).toBe('true');
      expect(computed(send.closest('.composer')!)).toMatchObject({ background: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)' });
      expect(computed(send)).toMatchObject({ ...WHITE_ARROW, cursor: 'not-allowed' });
      send.setAttribute('aria-disabled', 'false');
      send.removeAttribute('aria-disabled');
      expect(computed(send)).toMatchObject(WHITE_ARROW);
      expect(computed(send).cursor).not.toBe('not-allowed');
      send.disabled = true;
      expect(computed(send)).toMatchObject({ ...WHITE_ARROW, cursor: 'not-allowed' });
      send.disabled = false;
      send.setAttribute('data-working', '');
      expect(computed(send)).toMatchObject(WHITE_ARROW);
    } finally {
      style.remove();
    }
  });

  it('keeps the unavailable arrow white and unboxed, with aria-disabled and a not-allowed cursor', () => {
    const css = readFileSync('src/client/styles.css', 'utf8');
    expect(css).not.toMatch(/disabled-fill/);
    const unavailable = css.match(/\.send:disabled,\s*\.send\[aria-disabled='true'\]\s*\{([^}]*)\}/);
    expect(unavailable).not.toBeNull();
    expect(unavailable![1]).toMatch(/background:\s*transparent/);
    expect(unavailable![1]).toMatch(/color:\s*var\(--on-ink\)/);
    expect(unavailable![1]).toMatch(/cursor:\s*not-allowed/);
    expect(unavailable![1]).not.toMatch(/opacity|filter/);
  });
});

describe('the emblem draws only existing facts', () => {
  it('shows a complete current verified panel as full, resets for a refinement, halts on Stop and is wiped by Clear', async () => {
    const work = deferred<SafeSnapshot>(); port.refine.mockReturnValue(work.promise);
    port.stop.mockResolvedValue({ ...ready(), revision: 9, stage: 'cancelled', code: 'cancelled', attempt: { handle: h('refine-attempt'), kind: 'refine', active: false, outcome: 'cancelled' } });
    await boot(ready());
    expect(emblem().dataset.steps).toBe('5');
    expect(emblem().dataset.found).toBe('true');
    expect(emblem().getAttribute('aria-label')).toBe('Wintr');
    await click('Find fresh recordings');
    expect(emblem().dataset.steps).toBe('2');
    expect(emblem().dataset.found).toBeUndefined();
    expect(emblem().dataset.busy).toBe('true');
    expect(host.querySelectorAll('.ring[data-frontier]')).toHaveLength(1);
    await click('Stop');
    expect(emblem().dataset.busy).toBeUndefined();
    expect(emblem().dataset.found).toBeUndefined();
    expect(Number(emblem().dataset.steps)).toBeLessThan(5);
    await act(async () => { work.resolve({ ...ready(), revision: 10 }); await flush(); });
    expect(Number(emblem().dataset.steps)).toBeLessThan(5);
    await act(async () => { host.querySelector<HTMLButtonElement>('#menu-trigger')!.click(); await flush(); });
    await click('Clear session');
    expect(emblem().dataset.steps).toBe('0');
    expect(emblem().dataset.found).toBeUndefined();
    expect(host.textContent).not.toContain('Invented Recording');
  });

  it('a known-expired session wipes progress at once and a late old reply cannot restore it', async () => {
    const save = deferred<SafeSnapshot>(); port.feedback.mockReturnValue(save.promise);
    await boot(ready());
    expect(emblem().dataset.steps).toBe('5');
    await click('Like it');
    await act(async () => { save.reject(new ApiError(410, 'session_expired', null)); await flush(); });
    expect(emblem().dataset.steps).toBe('0');
    expect(emblem().dataset.found).toBeUndefined();
  });

  it('a new reference never shows the earlier journey as progress while it runs', async () => {
    const work = deferred<SafeSnapshot>(); port.reference.mockReturnValue(work.promise);
    await boot(ready());
    await act(async () => { typeLink('https://youtu.be/bbbbbbbbbbb'); await flush(); });
    await click('Analyse reference');
    expect(emblem().dataset.steps).toBe('0');
    expect(emblem().dataset.busy).toBe('true');
    await act(async () => { work.resolve(blank()); await flush(); });
  });
});
