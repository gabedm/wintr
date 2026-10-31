// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/client/App.js';
import type { MusicCapture, MusicCaptureSnapshot } from '../src/client/music-capture.js';
import { encodePcmWav } from '../src/shared/recording.js';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';

// Real App/hook/controller/sheet wiring with an explicitly fake capture engine and API.
// This proves UI/lifecycle behavior, not microphone hardware or rendered animation fidelity.
const fake = vi.hoisted(() => ({ create: vi.fn(), state: vi.fn(), createSession: vi.fn(), registerCapture: vi.fn(), recordingReference: vi.fn(), clear: vi.fn(), stop: vi.fn() }));
vi.mock('../src/client/music-capture.js', () => ({ createMusicCapture: fake.create }));
vi.mock('../src/client/api.js', async original => ({ ...await original<typeof import('../src/client/api.js')>(), api: fake }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const receipt = 'r'.repeat(24) as Handle;
const blank = (): SafeSnapshot => ({ mode: 'synthetic', session: null, stage: 'idle', revision: 0, status: null, attempt: null, reference: null,
  listenerCue: null, analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null });
const owned = (): SafeSnapshot => ({ ...blank(), session: { context: 'invented-ui-session', expiresAt: Date.now() + 3600000 } });
const made: ReturnType<typeof capture>[] = [];
const expireReady: (() => void)[] = [];
let startingPhase: MusicCaptureSnapshot['phase'] = 'recording';
function capture() {
  let snap: MusicCaptureSnapshot = { phase: 'idle', durationMs: 0, error: null };
  const listeners = new Set<() => void>();
  const set = (phase: MusicCaptureSnapshot['phase'], durationMs = 0) => { snap = { phase, durationMs, error: null }; listeners.forEach(fn => fn()); };
  expireReady.push(() => { snap = { phase: 'error', durationMs: 0, error: 'ready_expired' }; listeners.forEach(fn => fn()); });
  const result = {
    getSnapshot: () => snap, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    start: vi.fn(async () => set(startingPhase)), stop: vi.fn(async () => set('ready', 5000)),
    cancel: vi.fn(() => set('idle')), discard: () => set('idle'), dispose: vi.fn(() => set('disposed')),
    takeBytes: vi.fn(() => { if (snap.phase !== 'ready') return null; set('consumed', 5000); return encodePcmWav(new Float32Array(120000)); }),
    readyMetadata: vi.fn(async () => snap.phase === 'ready' ? { sha256: createHash('sha256').update(encodePcmWav(new Float32Array(120000))).digest('hex'), frames: 120000 } : null),
  } satisfies MusicCapture;
  return result;
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  startingPhase = 'recording';
  vi.resetAllMocks(); made.splice(0); expireReady.splice(0); localStorage.clear(); window.history.replaceState(null, '', '/');
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => undefined);
  fake.create.mockImplementation(() => { const c = capture(); made.push(c); return c; });
  fake.state.mockResolvedValue(blank()); fake.createSession.mockResolvedValue(owned());
  fake.registerCapture.mockResolvedValue({ ...owned(), captureReceipt: { receipt, durationMs: 5000, expiresAt: Date.now() + 300000, approved: true } });
  fake.recordingReference.mockResolvedValue({ ...owned(), stage: 'awaiting_preference', revision: 1, reference: { kind: 'recorded', receipt, durationMs: 5000 } });
  fake.clear.mockResolvedValue(blank()); fake.stop.mockResolvedValue(owned());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function flush() { for (let n = 0; n < 15; n++) await Promise.resolve(); }
async function boot(strict = false) { await act(async () => { root.render(strict ? <StrictMode><App /></StrictMode> : <App />); await flush(); }); }
function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  if (!found) throw Error('Missing invented UI control: ' + label); return found;
}
async function click(label: string) { await act(async () => { button(label).click(); await flush(); }); }

function heldSheetFrames() {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  let frameId = 0, time = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  return async (next: number) => act(async () => {
    time = next; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); await flush();
  });
}

it.each(['chooser', 'recording', 'ready'] as const)('ordinary close keeps only the last %s picture through its exit, with capture revoked immediately', async phase => {
  const advance = heldSheetFrames();
  fake.state.mockResolvedValue({ ...owned(), mode: 'live', recordingSelfService: true });
  const requests: FocusOptions[] = [], focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function(this: HTMLElement, options?: FocusOptions) {
    if (this.id === 'mic-trigger') requests.push(options ?? {}); focus.call(this, options);
  });
  await boot(); await click('Add music'); await advance(0); await advance(1000);
  if (phase !== 'chooser') await click('Record music5–60 seconds');
  if (phase === 'ready') await click('Stop recording');
  const layer = host.querySelector<HTMLElement>('.sheet-layer')!, text = layer.textContent;
  expect(layer.querySelector('#sheet-input-title')!.textContent).toBe('Record music');
  requests.splice(0);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(); });
  expect(made[0]!.getSnapshot().phase).toBe('idle');
  expect(host.querySelector('.app')!.hasAttribute('inert')).toBe(false);
  expect(requests[0]?.preventScroll).toBe(true);
  expect(layer.querySelector('[role="dialog"]')!.hasAttribute('inert')).toBe(true);
  expect(layer.textContent).toBe(text);
  // Even a programmatic event on an inert outgoing action has no capability.
  await act(async () => { layer.querySelector<HTMLButtonElement>('.voice-route, .recording-controls button')?.click(); await flush(); });
  expect(made[0]!.getSnapshot().phase).toBe('idle');
  expect(fake.registerCapture).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
  await advance(1259); expect(host.querySelector('.sheet-layer')).not.toBeNull();
  await advance(1260); expect(host.querySelector('.sheet-layer')).toBeNull();
});

it.each(['Clear', 'expired response', 'new session'] as const)('%s removes an already-exiting recording picture without waiting for a frame', async how => {
  const advance = heldSheetFrames();
  fake.state.mockResolvedValue({ ...owned(), mode: 'live', recordingSelfService: true });
  await boot(); await click('Add music'); await advance(0); await advance(1000);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await flush(); });
  expect(host.querySelector('.sheet-layer')).not.toBeNull();
  if (how === 'Clear') { await click('Open chats and privacy'); await click('Clear session'); }
  else {
    fake.state.mockResolvedValue(how === 'expired response' ? { ...blank(), mode: 'live', code: 'session_expired' }
      : { ...owned(), mode: 'live', session: { context: 'invented-replacement-session', expiresAt: Date.now() + 3600000 } });
    await act(async () => { window.dispatchEvent(new Event('pageshow')); await flush(); });
  }
  expect(host.querySelector('#sheet-input-title')).toBeNull();
  expect(fake.recordingReference).not.toHaveBeenCalled(); expect(fake.registerCapture).not.toHaveBeenCalled();
});

it('opening the chooser never starts capture; the explicit music choice does', async () => {
  await boot(); await click('Add music');
  expect(made[0]!.start).not.toHaveBeenCalled(); expect(fake.createSession).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Transcribe voice');
  expect(host.textContent).toContain('Synthetic mode: no provider is called. Results are placeholders.');
  await click('Record music5–60 seconds');
  expect(made[0]!.start).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button('Stop recording'));
  expect(host.querySelector('.emblem')?.getAttribute('data-busy')).toBe('true');
  expect(host.querySelector('.emblem')?.getAttribute('data-steps')).toBe('0');
  expect(fake.registerCapture).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
});

it.each(['permission', 'preparing'] as const)('keeps focus inside the sheet while capture remains in %s', async phase => {
  startingPhase = phase;
  await boot(); await click('Add music');
  await act(async () => button('Record music5–60 seconds').focus());
  expect(document.activeElement).toBe(button('Record music5–60 seconds'));
  await click('Record music5–60 seconds');
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(made[0]!.getSnapshot().phase).toBe(phase);
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(fake.registerCapture).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
});

it('Stop creates local readiness; only Analyse transfers the clip to the real controller', async () => {
  await boot(); await click('Add music'); await click('Record music5–60 seconds');
  await click('Stop recording'); expect(fake.registerCapture).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button('Prepare recording'));
  expect(host.querySelector('.emblem')?.getAttribute('data-busy')).toBeNull();
  await click('Prepare recording'); expect(fake.recordingReference).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Synthetic mode: no recording is analysed and no provider is called.');
  expect(host.textContent).not.toContain('Analyse sends your recording to Google Gemini.');
  expect(made[0]!.takeBytes).not.toHaveBeenCalled(); expect(document.activeElement).toBe(button('Analyse recording'));
  await click('Analyse recording');
  // WebCrypto is native asynchronous work; allow its completion while React owns the update.
  await act(async () => { for (let n = 0; n < 30 && fake.recordingReference.mock.calls.length === 0; n++) await new Promise(r => setTimeout(r, 0)); await flush(); });
  expect(fake.createSession).toHaveBeenCalledTimes(1); expect(fake.registerCapture).toHaveBeenCalledTimes(1); expect(fake.recordingReference).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(host.textContent).toContain('Recorded music');
  expect(host.querySelector<HTMLTextAreaElement>('#source-url')?.value).toBe('');
});

it('keeps a usable focus target while recording metadata preparation is held', async () => {
  let release!: (value: SafeSnapshot) => void;
  const held = new Promise<SafeSnapshot>(resolve => { release = resolve; });
  fake.registerCapture.mockReturnValueOnce(held);
  await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording');
  await act(async () => button('Prepare recording').focus());
  expect(document.activeElement).toBe(button('Prepare recording'));
  try {
    await click('Prepare recording');
    await act(async () => { for (let n = 0; n < 30 && !fake.registerCapture.mock.calls.length; n++) await new Promise(r => setTimeout(r, 0)); await flush(); });
    expect(fake.registerCapture).toHaveBeenCalledTimes(1);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.matches(':disabled')).toBe(false);
    expect(made[0]!.takeBytes).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
  } finally {
    await act(async () => { release({ ...owned(), captureReceipt: { receipt, durationMs: 5000, expiresAt: Date.now() + 300000, approved: true } }); await flush(); });
  }
});

it('retains the same local clip while awaiting approval; Check never transmits audio', async () => {
  fake.registerCapture.mockResolvedValueOnce({ ...owned(), captureReceipt: { receipt, durationMs: 5000, expiresAt: Date.now() + 300000, approved: false } });
  await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording');
  await click('Prepare recording'); expect(made[0]!.takeBytes).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
  expect(made[0]!.getSnapshot().phase).toBe('ready'); await click('Check recording');
  expect(fake.registerCapture.mock.calls[1]![0].actionKey).toBe(fake.registerCapture.mock.calls[0]![0].actionKey);
  expect(made[0]!.takeBytes).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled(); expect(button('Analyse recording')).toBeTruthy();
});

function selfService() {
  fake.state.mockResolvedValue({ ...blank(), recordingSelfService: true });
  fake.createSession.mockResolvedValue({ ...owned(), recordingSelfService: true });
}
async function untilAudio() {
  await act(async () => { for (let n = 0; n < 30 && !fake.recordingReference.mock.calls.length; n++) await new Promise(r => setTimeout(r, 0)); await flush(); });
}

it.each(['live', 'synthetic'] as const)('shows mode-correct transfer disclosure before the first self-service Analyse (%s)', async mode => {
  selfService(); fake.state.mockResolvedValue({ ...blank(), mode, recordingSelfService: true });
  await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording');
  const text = host.querySelector('.recording-controls')!.textContent;
  expect(text).toContain(mode === 'live' ? 'Analyse sends this recording to Google Gemini.' : 'Synthetic mode: no recording is analysed and no provider is called.');
  expect(button('Analyse recording').disabled).toBe(false);
  expect(fake.createSession).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
});

it('one explicit self-service Analyse prepares, adopts entry and transfers once despite a duplicate click', async () => {
  selfService(); await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording');
  expect(fake.createSession).not.toHaveBeenCalled(); expect(fake.registerCapture).not.toHaveBeenCalled();
  expect(button('Analyse recording')).toBeTruthy(); expect(host.textContent).not.toContain('Prepare recording');
  await act(async () => { const analyse = button('Analyse recording'); analyse.click(); analyse.click(); await flush(); });
  await untilAudio();
  expect(fake.createSession).toHaveBeenCalledTimes(1); expect(fake.registerCapture).toHaveBeenCalledTimes(1);
  expect(made[0]!.takeBytes).toHaveBeenCalledTimes(1); expect(fake.recordingReference).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(host.textContent).toContain('Recorded music');
  const transferred = made[0]!.takeBytes.mock.results[0]!.value as Uint8Array;
  expect(transferred.every(b => b === 0)).toBe(true);
});

it('accepted recorded analysis drops the outgoing recorder immediately even when animation frames are held', async () => {
  selfService(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  let time = 0, frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
  const advance = async (next: number) => act(async () => { time = next; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time)); await flush(); });
  let release!: (s: SafeSnapshot) => void;
  fake.recordingReference.mockReturnValueOnce(new Promise<SafeSnapshot>(r => { release = r; }));
  await boot(); await click('Add music'); await advance(0); await advance(1000);
  expect(host.querySelector<HTMLElement>('.sheet-layer')!.style.getPropertyValue('--sheet-p')).toBe('1');
  await click('Record music5–60 seconds'); await click('Stop recording');
  try {
    await click('Analyse recording'); await untilAudio();
    expect(fake.recordingReference).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.sheet-layer')).toBeNull();
    expect(host.textContent).toContain('Recorded music');
  } finally {
    await act(async () => { release({ ...owned(), recordingSelfService: true, stage: 'awaiting_preference', revision: 1, reference: { kind: 'recorded', receipt, durationMs: 5000 } }); await flush(); });
    clock.mockRestore();
  }
});

it.each(['close', 'Clear', 'ready expiry'] as const)('self-service %s wins held metadata without taking audio or reopening the sheet', async how => {
  selfService(); let release!: (s: SafeSnapshot) => void;
  fake.registerCapture.mockReturnValueOnce(new Promise<SafeSnapshot>(r => { release = r; }));
  await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording');
  try {
    await click('Analyse recording');
    expect(fake.registerCapture).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
    if (how === 'close') await click('Close');
    else if (how === 'Clear') await click('Clear session');
    else await act(async () => { expireReady[0]!(); await flush(); });
  } finally {
    await act(async () => { release({ ...owned(), recordingSelfService: true, captureReceipt: { receipt, durationMs: 5000, expiresAt: Date.now() + 300000, approved: true } }); await flush(); });
  }
  expect(made[0]!.takeBytes).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
  if (how === 'ready expiry') { expect(host.querySelector('[role="dialog"]')).not.toBeNull(); expect(button('Record again')).toBe(document.activeElement); }
  else expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('a failed local self-service digest leaves a usable explicit retry without creating Session or sending audio', async () => {
  selfService(); await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording');
  made[0]!.readyMetadata.mockRejectedValueOnce(Error('invented private internal failure'));
  await click('Analyse recording');
  expect(host.textContent).toContain('The recording could not be prepared. Try again.'); expect(host.textContent).not.toContain('invented private internal failure');
  expect(fake.createSession).not.toHaveBeenCalled(); expect(fake.registerCapture).not.toHaveBeenCalled(); expect(made[0]!.takeBytes).not.toHaveBeenCalled();
  expect(button('Analyse recording').disabled).toBe(false);
  await click('Analyse recording'); await untilAudio(); expect(fake.recordingReference).toHaveBeenCalledTimes(1);
});

it('self-service denial never transfers audio or exposes Check/operator steps', async () => {
  selfService(); fake.registerCapture.mockResolvedValueOnce({ ...owned(), recordingSelfService: true, captureReceipt: { receipt, durationMs: 5000, expiresAt: Date.now() + 300000, approved: false } });
  await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording'); await click('Analyse recording');
  expect(host.textContent).toContain('This recording cannot be analysed here. Choose another song.');
  expect(button('Record another song')).toBe(document.activeElement); expect(host.textContent).not.toContain('Check recording');
  expect(made[0]!.takeBytes).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
});

it('closing the sheet discards local capture without analysis', async () => {
  await boot(); await click('Add music'); await click('Record music5–60 seconds');
  await click('Close');
  expect(made[0]!.cancel).toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
});

it('an expired ready-clip update keeps the sheet visible with a focused recovery action and no audio transfer', async () => {
  await boot(); await click('Add music'); await click('Record music5–60 seconds'); await click('Stop recording');
  await act(async () => { expireReady[0]!(); await flush(); });
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(host.textContent).toContain('The unsent recording expired and was discarded.');
  expect(document.activeElement).toBe(button('Record again'));
  expect(host.querySelector('.recording-time')).toBeNull();
  expect(made[0]!.takeBytes).not.toHaveBeenCalled(); expect(fake.recordingReference).not.toHaveBeenCalled();
});

it('Discard restores the music control focus; Clear cancels and closes without audio transport', async () => {
  await boot(); await click('Add music'); await click('Record music5–60 seconds');
  await click('Stop recording'); await click('Discard recording');
  expect(document.activeElement).toBe(button('Record music5–60 seconds'));
  await click('Record music5–60 seconds'); await click('Clear session');
  expect(made[0]!.cancel).toHaveBeenCalled(); expect(fake.clear).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(fake.recordingReference).not.toHaveBeenCalled();
});

it('StrictMode and unmount dispose each effect-owned recorder', async () => {
  await boot(true); expect(made).toHaveLength(2); expect(made[0]!.dispose).toHaveBeenCalledTimes(1); expect(made[1]!.dispose).not.toHaveBeenCalled();
  await click('Add music'); await click('Record music5–60 seconds');
  act(() => root.unmount()); expect(made[1]!.dispose).toHaveBeenCalledTimes(1);
  // afterEach can safely unmount the already-unmounted root.
});
