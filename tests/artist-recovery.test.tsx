// @vitest-environment jsdom
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { transferableAbortController } from 'node:util';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot, Session } from '../src/shared/records.js';
import { App } from '../src/client/App.js';
import { ApiError } from '../src/client/api.js';
import { PreferencePanel } from '../src/client/discovery.js';
import { createApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { sha256 } from '../src/server/ids.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createEphemeralSealer } from '../src/server/seal.js';
import { MemoryStore } from '../src/server/store.js';
import { createSyntheticCatalogue } from '../src/server/synthetic-catalogue.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';

// Real React/controller -> in-process canonical server -> genuine finite graph,
// using only invented records and in-process synthetic provider envelopes. No socket/service/browser.
const port = vi.hoisted(() => ({ state: vi.fn(), createSession: vi.fn(), reference: vi.fn(), preference: vi.fn(), artistChoice: vi.fn(),
  discover: vi.fn(), feedback: vi.fn(), refine: vi.fn(), stop: vi.fn(), clear: vi.fn() }));
vi.mock('../src/client/api.js', async (original) => ({ ...await original<typeof import('../src/client/api.js')>(), api: port }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = (s: string) => s.padEnd(24, '0') as Handle;
const flush = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  const native = transferableAbortController();
  vi.stubGlobal('AbortController', native.constructor); vi.stubGlobal('AbortSignal', native.signal.constructor);
  vi.stubGlobal('Uint8Array', new TextEncoder().encode('').constructor);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function button(text: string) {
  const el = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`Missing expected control: ${text}`);
  return el;
}
async function click(text: string) { await act(async () => { const b = button(text); b.focus(); b.click(); await flush(); }); }
function input(label: string) {
  const el = [...host.querySelectorAll('label')].find((l) => l.textContent?.trim() === label)?.querySelector('input');
  if (!el) throw new Error(`Missing expected input: ${label}`);
  return el;
}
async function type(label: string, value: string) { await act(async () => {
  const el = input(label); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true })); await flush();
}); }
const snapshot = (suffix = ''): SafeSnapshot => ({ mode: 'synthetic', exampleSource: false,
  session: { context: `invented-context${suffix}`, expiresAt: Date.now() + 3_600_000 }, stage: 'awaiting_preference', revision: 2, status: 'reference_ready',
  attempt: null, reference: null, listenerCue: null, analysis: { handle: h(`analysis${suffix}`), synthetic: true, audioAccess: 'synthetic_not_accessed',
    observations: ['Invented observation'], relationships: ['Invented relationship'], proposedArtist: 'Invented Seed' },
  brief: { handle: h(`brief${suffix}`), version: 1, relationship: `Invented intent${suffix}`, source: 'listener_text', artists: ['Invented Seed'] },
  identity: null, connection: null, panel: null, history: [], refinement: null, code: null });

async function server() {
  const config = loadConfig([], { WINTR_MODE: 'synthetic', WINTR_PORT: '8787' });
  const store = new MemoryStore({ maxSessions: 5, maxJourneysPerSession: 3 });
  const now = Date.now(); const created = await store.createSession(now) as { session: Session; secret: string };
  const owner = { sessionId: created.session.id, epoch: 1 };
  const a = await store.admitReference({ ...owner, now, reference: { videoId: 'aaaaaaaaaaa', canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', focus: { start: 0, end: 30 } }, listenerCue: null,
    actionKeyHash: sha256('invented-reference'), inputHash: sha256('invented-reference') });
  if (a.kind !== 'admitted') throw new Error('fixture reference');
  await store.commitAnalysis(owner.sessionId, 1, a.attempt.id, { synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null }, now);
  const b = (await store.read(owner.sessionId, 1, now))!;
  const brief = await store.saveBrief(owner, { analysisId: b.analysis!.id, relationship: 'Keep my invented listener intent', relationshipSource: 'listener_text', proposedArtists: ['Ambiguous invented artist'], exclusions: [] },
    { expectedBriefId: null, actionKeyHash: sha256('invented-brief'), inputHash: sha256('invented-brief') }, now);
  if (brief.kind !== 'saved') throw new Error('fixture brief');
  let qloo = 0, catalogue = 0;
  const synthetic = createSyntheticCatalogue(), transport = createSyntheticQlooTransport();
  const handler = createApiHandler({ config, store, referenceAdapter: null, discovery: {
    qloo: createQlooClient({ host: 'hackathon.api.qloo.com', apiKey: new ServerSecret('synthetic-artist-test'), transport: (req) => { qloo++; return transport(req); } }),
    qlooSynthetic: true, catalogue: createNativeCatalogue({ ...synthetic, adapter: { ...synthetic.adapter, generate: (...args) => { catalogue++; return synthetic.adapter.generate(...args); } } }),
    sealer: createEphemeralSealer(),
  } });
  const call = async (method: string, path: string, data?: unknown): Promise<SafeSnapshot> => {
    const req = new IncomingMessage(new Socket()); const payload = data === undefined ? null : JSON.stringify(data);
    req.method = method; req.url = path; req.headers = { host: config.hostHeader, origin: config.origin, cookie: `wintr_sid=${created.secret}`,
      ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }) };
    if (payload !== null) req.push(Buffer.from(payload)); req.push(null);
    const res = new ServerResponse(req); let body = '';
    res.end = ((chunk: unknown) => { body = String(chunk); return res; }) as typeof res.end;
    await handler(req, res); req.destroy(); const parsed = JSON.parse(body);
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, parsed.error, parsed.message ?? null);
    return parsed as SafeSnapshot;
  };
  port.state.mockImplementation(() => call('GET', '/api/state'));
  port.discover.mockImplementation((data) => call('POST', '/api/discover', data));
  port.artistChoice.mockImplementation((data) => call('POST', '/api/artist-choice', data));
  port.preference.mockImplementation((data) => call('POST', '/api/preference', data));
  port.clear.mockImplementation(() => call('DELETE', '/api/session'));
  return { call, counts: () => ({ qloo, catalogue }), store, owner };
}

describe('P04 free artist correction and acknowledged-save protection', () => {
  it('reselects the original ambiguous brief, restores its choices and continues without repeating Search', async () => {
    const s = await server();
    await act(async () => { root.render(<App />); await flush(); });
    await click('Discover connections');
    const original = await s.call('GET', '/api/state');
    await click('Edit starting artists');
    await type('Start from artist', 'Corrected invented artist');
    await click('Save choice');
    await click('Edit');
    await type('Start from artist', 'Ambiguous invented artist');
    await click('Save choice');
    const restored = await s.call('GET', '/api/state');
    expect(restored.brief!.handle).toBe(original.brief!.handle);
    expect(restored.stage).toBe('awaiting_artist');
    expect(host.querySelector('[aria-label="Which artist did you mean?"]')).not.toBeNull();
    expect(button('Continue discovery').disabled).toBe(true);
    expect(s.counts()).toEqual({ qloo: 1, catalogue: 0 });
    await act(async () => { host.querySelector<HTMLButtonElement>('.identity-row')!.click(); await flush(); });
    expect(button('Continue discovery').disabled).toBe(false);
    await click('Continue discovery');
    expect(s.counts()).toEqual({ qloo: 3, catalogue: 1 });
    expect((await s.call('GET', '/api/state')).stage).toBe('complete');
    expect((await s.store.read(s.owner.sessionId, 1, Date.now()))!.journey!.discoverRuns).toBe(1);
  });

  it('reaches ambiguity, opens focused name correction, preserves intent/draft, saves freely and rejects the stale checkpoint before explicit new Discover', async () => {
    const s = await server();
    await act(async () => { root.render(<App />); await flush(); });
    await click('Discover connections');
    const waiting = await s.call('GET', '/api/state');
    expect(waiting.stage).toBe('awaiting_artist'); expect(s.counts()).toEqual({ qloo: 1, catalogue: 0 });
    const checkpoint = waiting.identity!;
    await click('Edit starting artists');
    expect(input('Start from artist')).toBe(document.activeElement);
    expect(input('Or say it your way').value).toBe('Keep my invented listener intent');
    await type('Start from artist', 'Corrected invented artist');
    await click('Cancel');
    expect(host.querySelector('[aria-label="Which artist did you mean?"]')).toBe(document.activeElement);
    await click('Edit starting artists');
    expect(input('Start from artist').value).toBe('Corrected invented artist');
    const ack = deferred<void>();
    port.preference.mockImplementation(async (data) => { const next = await s.call('POST', '/api/preference', data); await ack.promise; return next; });
    await click('Save choice');
    expect(port.preference).toHaveBeenCalledOnce();
    expect(input('Start from artist').disabled).toBe(true);
    expect(input('Or say it your way').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    expect(button('Saving…')).toBe(document.activeElement);
    expect(s.counts()).toEqual({ qloo: 1, catalogue: 0 });
    await act(async () => { ack.resolve(); await flush(); });
    expect(host.querySelector('[aria-label="Your choice"]')).toBe(document.activeElement);
    expect(host.textContent).toContain('Corrected invented artist');
    expect(host.textContent).toContain('Keep my invented listener intent');
    expect(s.counts()).toEqual({ qloo: 1, catalogue: 0 });
    await expect(s.call('POST', '/api/artist-choice', { checkpoint: checkpoint.handle, slot: 0, choice: checkpoint.slots[0]!.options[0]!.handle, expectedRevision: checkpoint.revision, actionKey: 'invented-stale-choice-0001' })).rejects.toMatchObject({ code: 'stale_version' });
    expect(s.counts()).toEqual({ qloo: 1, catalogue: 0 });
    await click('Discover connections');
    expect(s.counts()).toEqual({ qloo: 4, catalogue: 1 });
    expect((await s.call('GET', '/api/state')).stage).toBe('complete');
    expect(port.discover).toHaveBeenCalledTimes(2);
  });

  it('locks every draft mutation and Cancel while a Save acknowledgement is pending, even without a parent busy prop', async () => {
    const pending = deferred<boolean>(); const save = vi.fn(() => pending.promise);
    await act(async () => { root.render(<PreferencePanel snapshot={snapshot()} disabled={false} onSave={save} onDiscover={() => {}} />); await flush(); });
    await click('Edit'); await type('Start from artist', 'Saved artist A'); await click('Save choice');
    expect(save).toHaveBeenCalledOnce();
    expect(input('Start from artist').disabled).toBe(true);
    expect(input('Another artist you love (optional)').disabled).toBe(true);
    expect(input('Or say it your way').disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button.chip')!.disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    await click('Cancel'); expect(input('Start from artist').value).toBe('Saved artist A');
    expect(button('Saving…')).toBe(document.activeElement);
    await act(async () => { pending.resolve(false); await flush(); });
    expect(input('Start from artist').disabled).toBe(false);
    expect(input('Start from artist').value).toBe('Saved artist A');
    await type('Start from artist', 'New artist B');
    expect(input('Start from artist').value).toBe('New artist B');
  });

  it('a save acknowledgement from a replaced analysis cannot close the newly opened editor or erase its newer draft', async () => {
    const pending = deferred<boolean>();
    const render = (state: SafeSnapshot) => root.render(<PreferencePanel snapshot={state} disabled={false} onSave={() => pending.promise} onDiscover={() => {}} />);
    await act(async () => { render(snapshot()); await flush(); });
    await click('Edit'); await click('Save choice');
    await act(async () => { render(snapshot('-new')); await flush(); });
    await click('Edit'); await type('Start from artist', 'New intended artist');
    await act(async () => { pending.resolve(true); await flush(); });
    expect(input('Start from artist').value).toBe('New intended artist');
    expect(input('Or say it your way').value).toBe('Invented intent-new');
    expect(button('Save choice')).toBeTruthy();
  });
});
