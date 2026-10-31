// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/client/App.js';
import type { SafeSnapshot } from '../src/shared/records.js';
import type { LiveCaptureSnapshot, LiveMusicCapture } from '../src/client/live-music-capture.js';

const fake = vi.hoisted(() => ({ create: vi.fn(), state: vi.fn(), createSession: vi.fn(), liveReference: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
vi.mock('../src/client/live-music-capture.js', async original => ({ ...await original<typeof import('../src/client/live-music-capture.js')>(), createLiveMusicCapture: fake.create }));
vi.mock('../src/client/api.js', async original => ({ ...await original<typeof import('../src/client/api.js')>(), api: fake }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const blank = (): SafeSnapshot => ({ mode: 'live', liveListening: { maxSeconds: 20 }, session: null, stage: 'idle', revision: 0, status: null, attempt: null, reference: null, listenerCue: null,
  analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null });
const owned = (): SafeSnapshot => ({ ...blank(), session: { context: 'invented-live-ui', expiresAt: Date.now() + 3600000 } });
const failedLive = (): SafeSnapshot => ({ ...owned(), revision: 1, stage: 'failed', code: 'adapter_failed',
  attempt: { handle: 'F'.repeat(24) as any, kind: 'reference', active: false, outcome: 'failed' }, reference: { kind: 'streamed', receipt: 'R'.repeat(24) as any } });
let host: HTMLDivElement, root: Root, current: ReturnType<typeof capture>;
let resolve!: (s: SafeSnapshot) => void;
function capture() {
  let snap: LiveCaptureSnapshot = { phase: 'idle', durationMs: 0, error: null }; const watchers = new Set<() => void>();
  const set = (phase: LiveCaptureSnapshot['phase'], durationMs = 0) => { snap = { phase, durationMs, error: null }; watchers.forEach(fn => fn()); };
  const result = { getSnapshot: () => snap, subscribe: (fn: () => void) => { watchers.add(fn); return () => { watchers.delete(fn); }; },
    prepare: vi.fn(async () => set('connecting')), begin: vi.fn(() => set('listening')), finish: vi.fn(() => set('analysing', snap.durationMs)), cancel: vi.fn(), completion: new Promise<void>(() => {}) } satisfies LiveMusicCapture;
  return { ...result, set };
}
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.getAttribute('aria-label') === name || b.textContent?.replace(/\s+/g, ' ').trim() === name)!;
const click = async (name: string) => { const b = button(name); expect(b).toBeTruthy(); await act(async () => { b.click(); }); await flush(); };
beforeEach(() => {
  localStorage.clear(); fake.create.mockReset(); fake.state.mockResolvedValue(owned()); fake.createSession.mockResolvedValue(owned()); fake.stop.mockResolvedValue(owned()); fake.clear.mockResolvedValue(blank());
  fake.create.mockImplementation(() => (current = capture()));
  fake.liveReference.mockImplementation(() => new Promise<SafeSnapshot>(yes => { resolve = yes; }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); await flush(); });
async function boot() { act(() => root.render(<App />)); await flush(); }
it('opening the chooser never captures; only Listen live creates one owned stream', async () => {
  await boot(); await click('Add music'); expect(fake.create).not.toHaveBeenCalled(); expect(fake.liveReference).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Streams music to Google Gemini'); await click('Listen liveStreams music to Google Gemini · up to 20s');
  expect(fake.create).toHaveBeenCalledOnce(); expect(fake.liveReference).toHaveBeenCalledOnce(); expect(host.querySelector('[role="dialog"]:not([aria-hidden="true"])')).toBeNull();
  act(() => current.set('listening', 4500)); expect(button('Finish listening').disabled).toBe(true);
  act(() => current.set('listening', 5000)); expect(button('Finish listening').disabled).toBe(false);
  await click('Finish listening'); expect(current.finish).toHaveBeenCalledOnce();
  resolve(owned()); await flush(); expect(host.querySelector('section[aria-label="Listen live"]')).toBeNull();
});
it('starts one stream from Home and fills the replacement mark only after five factual seconds', async () => {
  await boot();
  expect(host.textContent).toContain('Press to find your jam'); expect(fake.create).not.toHaveBeenCalled();
  await click('Listen live'); expect(fake.create).toHaveBeenCalledOnce(); expect(fake.liveReference).toHaveBeenCalledOnce();
  act(() => current.set('listening', 4999)); expect(host.querySelector('[data-capture-ready="true"]')).toBeNull(); expect(button('Finish listening').disabled).toBe(true);
  act(() => current.set('listening', 5000)); expect(host.querySelector('[data-capture-ready="true"]')).not.toBeNull(); expect(button('Finish listening').disabled).toBe(false); expect(current.finish).not.toHaveBeenCalled();
  act(() => current.set('listening', 10000)); expect(fake.liveReference).toHaveBeenCalledOnce(); expect(current.finish).not.toHaveBeenCalled();
});
it('leaving Home revokes live capture immediately while keeping all three navigation choices', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  await boot(); await click('Listen live'); act(() => current.set('listening', 5000)); await click('Library');
  expect(current.cancel).toHaveBeenCalled(); expect(fake.liveReference.mock.calls[0]![2].aborted).toBe(true);
  expect([...host.querySelectorAll('nav[aria-label="Main navigation"] button')].map(b => b.textContent)).toEqual(['Home', 'Library', 'Concerts']);
  resolve({ ...owned(), stage: 'awaiting_preference', analysis: { handle: 'A'.repeat(24) as any, synthetic: false, audioAccess: 'accessed', observations: ['Invented late observation'], relationships: ['Invented rhythm'], proposedArtist: null } }); await flush(); expect(host.textContent).not.toContain('Invented late observation');
});
it.each(['Stop', 'Clear session'])('%s releases capture and discards a late private reply', async action => {
  await boot(); await click('Add music'); await click('Listen liveStreams music to Google Gemini · up to 20s');
  act(() => current.set('listening', 5000));
  if (action === 'Clear session') { await click('Open chats and privacy'); await click('Clear session'); } else await click('Stop');
  expect(current.cancel).toHaveBeenCalled(); expect(fake.liveReference.mock.calls[0]![2].aborted).toBe(true);
  resolve({ ...owned(), reference: { kind: 'streamed', receipt: 'S'.repeat(24) as any }, stage: 'awaiting_preference', analysis: { handle: 'A'.repeat(24) as any, synthetic: false, audioAccess: 'accessed', observations: ['invented stale observation'], relationships: ['invented rhythm'], proposedArtist: null } });
  await flush(); expect(host.textContent).not.toContain('invented stale observation');
});
it('offers an explicit Listen again after a failed Live response, including after reload, without a link instruction or automatic capture', async () => {
  fake.state.mockResolvedValue(failedLive());
  await boot();
  expect(host.textContent).toContain('We couldn’t finish analysing that music.');
  expect(host.textContent).not.toContain('Paste a link to try again.');
  expect(fake.create).not.toHaveBeenCalled(); expect(fake.liveReference).not.toHaveBeenCalled();
  await click('Listen again');
  expect(fake.create).toHaveBeenCalledOnce(); expect(fake.liveReference).toHaveBeenCalledOnce();
});
it('keeps an explicit stopped Live request distinct from a failed analysis and does not restart it', async () => {
  const stopped = failedLive();
  fake.state.mockResolvedValue({ ...stopped, stage: 'cancelled', code: null, attempt: { ...stopped.attempt!, outcome: 'cancelled' } });
  await boot();
  expect(host.textContent).toContain('Listening stopped.');
  expect(host.textContent).not.toContain('Paste a link to try again.');
  expect(button('Listen again')).toBeTruthy();
  expect(fake.create).not.toHaveBeenCalled(); expect(fake.liveReference).not.toHaveBeenCalled();
});
it('removes the recovery action with revoked Live capability and never turns it into recording capture', async () => {
  fake.state.mockResolvedValue({ ...failedLive(), liveListening: undefined });
  await boot();
  expect(button('Listen again')).toBeUndefined();
  expect(host.textContent).not.toContain('Paste a link to try again.');
  expect(fake.create).not.toHaveBeenCalled(); expect(fake.liveReference).not.toHaveBeenCalled();
});
it('uses recording recovery for a failed saved excerpt, with no Live restart or link instruction', async () => {
  fake.state.mockResolvedValue({ ...failedLive(), reference: { kind: 'recorded', receipt: 'R'.repeat(24) as any, durationMs: 7000 } });
  await boot();
  expect(host.textContent).toContain('Record another excerpt to try again.');
  expect(host.textContent).not.toContain('Paste a link to try again.');
  expect(button('Listen again')).toBeUndefined();
  expect(fake.create).not.toHaveBeenCalled(); expect(fake.liveReference).not.toHaveBeenCalled();
});
