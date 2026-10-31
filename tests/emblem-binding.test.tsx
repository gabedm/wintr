// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { App } from '../src/client/App.js';
import { type ApiPort } from '../src/client/api.js';
import { SessionController } from '../src/client/controller.js';
import { Emblem, useEmblem } from '../src/client/emblem-view.js';

// The emblem's run identity through the REAL App and SessionController over an explicitly fake API: the opaque session
// context, the controller's wipe counter and the local action object. Synthetic DOM/lifecycle evidence only: not rendered
// layout, a browser, a device or owner acceptance.
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
const analysis = { handle: h('analysis'), synthetic: true, audioAccess: 'synthetic_not_accessed' as const, observations: ['An invented observation.'], relationships: ['A low line'], proposedArtist: 'Invented Seed' };
const brief = { handle: h('brief'), version: 1, relationship: 'A low line', source: 'intake_cue' as const, artists: ['Invented Seed'] };
const ref = { videoId: 'aaaaaaaaaaa', canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', focus: { start: 12, end: 57 } };
const panel = {
  handle: h('panel'), synthetic: true, role: 'initial' as const, mode: null, basis: [], outcome: 'choices' as const,
  choices: [{ handle: h('choice'), title: 'Invented Recording', credits: ['Invented Neighbour'], anchor: 'Invented Neighbour', unverifiedCredits: 0, service: 'youtube' as const, playUrl: null,
    fitHypothesis: 'An invented hypothesis.', sources: [], feedback: { fit: null, familiarity: null, revision: 0 } }],
  answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [],
};
const sessionA = { context: 'invented-session-a', expiresAt: Date.now() + 3_600_000 };
const sessionB = { context: 'invented-session-b', expiresAt: Date.now() + 3_600_000 };
const finished = (): SafeSnapshot => blank({
  session: sessionA, stage: 'complete', revision: 3, reference: ref, analysis, brief, panel, refinement: { used: false },
  attempt: { handle: h('discover-attempt'), kind: 'discover', active: false, outcome: 'succeeded' },
});
const refining = (revision: number): SafeSnapshot => ({
  ...finished(), revision, stage: 'finding_tracks', attempt: { handle: h('refine-attempt'), kind: 'refine', active: true, outcome: 'running' },
});
const sessionBReady = (): SafeSnapshot => blank({ session: sessionB, stage: 'awaiting_preference', status: 'reference_ready', revision: 1, reference: ref, analysis, brief });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no network in this test'); }));
  port.clear.mockResolvedValue(blank());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
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
const emblem = () => host.querySelector<SVGSVGElement>('.emblem')!;
const shown = () => ({ steps: emblem().dataset.steps, busy: emblem().dataset.busy === 'true', found: emblem().dataset.found === 'true' });
/** One bounded read-only progress/watch interval of the real controller. */
const tick = async () => act(async () => { await vi.advanceTimersByTimeAsync(1000); await flush(); });

it('reveals the Live mark progressively from captured duration and resets in the same commit', () => {
  const draw = (ms: number) => act(() => root.render(<Emblem out={{ steps: 0, busy: true, found: false, halted: false }} listeningMs={ms}/>));
  const radius = () => Number(host.querySelector('.flake-capture-radius')!.getAttribute('r'));
  draw(0); expect(radius()).toBe(0); expect(emblem().hasAttribute('data-capture-progressing')).toBe(false);
  draw(1000); expect(radius()).toBeCloseTo(11.2); expect(emblem().dataset.captureReady).toBe('false'); expect(emblem().dataset.captureProgressing).toBe('true');
  draw(2500); expect(radius()).toBe(28);
  draw(4999); expect(radius()).toBeLessThan(56); expect(radius()).toBeGreaterThan(55); expect(emblem().dataset.captureReady).toBe('false');
  draw(5000); expect(radius()).toBe(56); expect(emblem().dataset.captureReady).toBe('true'); expect(emblem().hasAttribute('data-capture-progressing')).toBe(false);
  draw(15000); expect(radius()).toBe(56);
  draw(0); expect(radius()).toBe(0); expect(emblem().dataset.captureReady).toBe('false'); expect(emblem().hasAttribute('data-capture-progressing')).toBe(false);
  expect(host.querySelector('.flake-ready')!.getAttribute('clip-path')).toBe(`url(#${host.querySelector('.flake-capture-radius')!.parentElement!.id})`);
});
it('closes invalid Live duration to an empty mark and keeps ordinary factual bands separate', () => {
  for (const ms of [-1, NaN, Infinity, -Infinity]) { act(() => root.render(<Emblem out={{ steps: 0, busy: false, found: false, halted: false }} listeningMs={ms}/>)); expect(host.querySelector('.flake-capture-radius')!.getAttribute('r')).toBe('0'); expect(emblem().dataset.captureReady).toBe('false'); }
  act(() => root.render(<Emblem out={{ steps: 3, busy: false, found: false, halted: false }}/>)); expect(host.querySelector('.flake-capture-radius')).toBeNull(); expect(host.querySelectorAll('.ring')).toHaveLength(5); expect(emblem().hasAttribute('data-capture-ready')).toBe(false);
});

describe('the controller\'s local action is one stable object per started action', () => {
  const idle = (): ApiPort => port as unknown as ApiPort;

  it('keeps the same object across every later view change of that action, and gives a later same-kind action a different one', async () => {
    const c = new SessionController(idle());
    port.state.mockResolvedValue(blank({ session: sessionA, stage: 'awaiting_preference', revision: 1, analysis, brief }));
    await c.refresh();
    const first = deferred<SafeSnapshot>(); port.discover.mockReturnValueOnce(first.promise);
    const seen = new Set<unknown>();
    c.subscribe(() => c.getView().action && seen.add(c.getView().action));
    const run = c.discover(brief.handle);
    const a = c.getView().action;
    expect(a).toEqual({ kind: 'discover' });
    port.state.mockResolvedValue(blank({ session: sessionA, stage: 'resolving_artists', revision: 2, analysis, brief, attempt: { handle: h('d1'), kind: 'discover', active: true, outcome: 'running' } }));
    await c.refresh();
    expect(c.getView().action).toBe(a);
    first.resolve(blank({ session: sessionA, stage: 'awaiting_artist', revision: 3, analysis, brief, attempt: { handle: h('d1'), kind: 'discover', active: false, outcome: 'succeeded' } }));
    await run;
    expect(c.getView().action).toBeNull();
    expect([...seen]).toEqual([a]);

    const second = deferred<SafeSnapshot>(); port.discover.mockReturnValueOnce(second.promise);
    const again = c.discover(brief.handle);
    const b = c.getView().action;
    expect(b).toEqual({ kind: 'discover' });
    expect(b).not.toBe(a);
    second.resolve(blank({ session: sessionA, stage: 'awaiting_artist', revision: 4, analysis, brief, attempt: { handle: h('d2'), kind: 'discover', active: false, outcome: 'succeeded' } }));
    await again;
    c.dispose();
  });

  it('Stop, Clear and a replaced session end the action object; a late completion never installs one again', async () => {
    const c = new SessionController(idle());
    port.state.mockResolvedValue(blank({ session: sessionA, stage: 'awaiting_preference', revision: 1, analysis, brief }));
    await c.refresh();
    const late = deferred<SafeSnapshot>(); port.discover.mockReturnValueOnce(late.promise);
    const run = c.discover(brief.handle);
    expect(c.getView().action).not.toBeNull();
    const wipe = c.getView().wipe;
    void c.clear();
    expect(c.getView().action).toBeNull();
    expect(c.getView().wipe).toBe(wipe + 1);
    late.resolve(blank({ session: sessionA, stage: 'complete', revision: 9, analysis, brief, panel }));
    await run;
    await flush();
    expect(c.getView().action).toBeNull();
    expect(c.getView().snapshot?.panel ?? null).toBeNull();
    c.dispose();
  });
});

describe('the emblem through the real App: session, wipe and local action binding', () => {
  it('resumes only the visible Home emblem after a page-visibility cycle while in Library', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    function HomeMark({ visible }: { visible: boolean }) {
      const mark = useEmblem({ snapshot: refining(4), action: null, working: true, stopping: false, revoked: false, wipe: 0 }, visible);
      return visible ? <Emblem {...mark} /> : null;
    }
    act(() => root.render(<HomeMark visible />));
    expect(emblem().style.getPropertyValue('--emblem-breath')).not.toBe('');
    act(() => root.render(<HomeMark visible={false} />));
    expect(emblem()).toBeNull();
    visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
    visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(emblem()).toBeNull();
    act(() => root.render(<HomeMark visible />));
    expect(emblem().style.getPropertyValue('--emblem-breath')).not.toBe('');
  });
  it('keeps a background music result from moving Library and removes hidden pending motion', async () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    await boot(refining(4));
    await click('Library');
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('Library');
    expect(host.querySelector('.pending')).toBeNull();
    expect(host.textContent).toContain('Wintr is working on your music.');
    scroll.mockClear();
    port.state.mockResolvedValue({ ...finished(), revision: 5,
      panel: { ...panel, handle: h('fresh-panel') },
      attempt: { handle: h('refine-attempt'), kind: 'refine', active: false, outcome: 'succeeded' },
    });
    await tick();
    expect(scroll).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-current="page"]')?.textContent).toBe('Library');
    await click('Home');
    expect(shown()).toEqual({ steps: '5', busy: false, found: true });
  });
  it.each(['expired', 'replaced'] as const)('hard-closes the input chooser when a read-only refresh reports the session %s', async (ending) => {
    await boot(refining(4));
    await click('Add music');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(host.querySelector('.app')!.hasAttribute('inert')).toBe(true);
    port.state.mockResolvedValue(ending === 'expired' ? blank({ code: 'session_expired' }) : sessionBReady());
    await tick();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('.sheet-layer')).toBeNull();
    expect(host.querySelector('.app')!.hasAttribute('inert')).toBe(false);
    expect(host.textContent).not.toContain('Invented Recording');
    // The available pre-session/new-session chooser still opens through a new deliberate click.
    await click('Add music');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('a directly replaced session never inherits another session\'s discovery progress, even into its own unadmitted Discover', async () => {
    const work = deferred<SafeSnapshot>(); port.refine.mockReturnValue(work.promise);
    await boot(finished());
    expect(shown()).toEqual({ steps: '5', busy: false, found: true });
    await click('Find fresh recordings');
    expect(shown()).toEqual({ steps: '2', busy: true, found: false });
    port.state.mockResolvedValue(refining(4));
    await tick();
    expect(shown()).toEqual({ steps: '4', busy: true, found: false });
    // The next read-only poll reports a different session: A's progress ends with it (the controller drops A's request reply).
    port.discover.mockReturnValue(deferred<SafeSnapshot>().promise);
    port.state.mockResolvedValue(sessionBReady());
    await tick();
    expect(shown()).toEqual({ steps: '2', busy: false, found: false });
    await act(async () => { work.resolve({ ...finished(), revision: 20 }); await flush(); });
    expect(shown()).toEqual({ steps: '2', busy: false, found: false });
    expect(host.textContent).not.toContain('Invented Recording');
    await click('Discover connections');
    expect(port.discover).toHaveBeenCalledTimes(1);
    expect(shown()).toEqual({ steps: '2', busy: true, found: false });
  });

  it('Stop keeps only what the run proved, a late completion of the stopped request is ignored, and Clear then wipes it', async () => {
    const work = deferred<SafeSnapshot>(); port.refine.mockReturnValue(work.promise);
    port.stop.mockResolvedValue({ ...refining(5), stage: 'cancelled', code: 'cancelled', attempt: { handle: h('refine-attempt'), kind: 'refine', active: false, outcome: 'cancelled' } });
    await boot(finished());
    await click('Find fresh recordings');
    port.state.mockResolvedValue(refining(4));
    await tick();
    expect(shown()).toEqual({ steps: '4', busy: true, found: false });
    await click('Stop');
    expect(shown()).toEqual({ steps: '4', busy: false, found: false });
    await act(async () => { work.resolve({ ...finished(), revision: 10, panel: { ...panel, handle: h('late-panel') }, attempt: { handle: h('refine-attempt'), kind: 'refine', active: false, outcome: 'succeeded' } }); await flush(); });
    expect(shown()).toEqual({ steps: '4', busy: false, found: false });
    await act(async () => { host.querySelector<HTMLButtonElement>('#menu-trigger')!.click(); await flush(); });
    await click('Clear session');
    expect(shown()).toEqual({ steps: '0', busy: false, found: false });
    expect(host.textContent).not.toContain('Invented Recording');
  });

  it('Clear while a request is pending wipes progress at once; its late reply, even for the same session, cannot bring it back', async () => {
    const work = deferred<SafeSnapshot>(); port.refine.mockReturnValue(work.promise);
    await boot(finished());
    await click('Find fresh recordings');
    port.state.mockResolvedValue(refining(4));
    await tick();
    expect(shown().steps).toBe('4');
    await act(async () => { host.querySelector<HTMLButtonElement>('#menu-trigger')!.click(); await flush(); });
    await click('Clear session');
    expect(shown()).toEqual({ steps: '0', busy: false, found: false });
    await act(async () => { work.resolve({ ...finished(), revision: 11, panel: { ...panel, handle: h('late-panel') } }); await flush(); });
    await tick();
    expect(shown()).toEqual({ steps: '0', busy: false, found: false });
    expect(host.textContent).not.toContain('Invented Recording');
  });
});
