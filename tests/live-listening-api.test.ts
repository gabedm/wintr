import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiHandler, type ApiHandler } from '../src/server/app.js';
import { createWintrServer } from '../src/server/http-server.js';
import { loadConfig } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { parseSourcePolicy } from '../src/server/source-policy.js';
import type { ReferenceAdapter } from '../src/server/reference.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';
import { newHandle } from '../src/server/ids.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { composeLiveRuntime } from '../src/server/live-runtime.js';
import { GEMINI_LIVE_PROFILE } from '../src/server/providers/gemini-live-reference.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { binding, loaders, policy } from './fixtures/live-fixtures.js';

// Real local WebSockets against the actual API/harness, invented stores and music only.
const owned: { server: Server; handler: ApiHandler; shutdown: AbortController }[] = [], clients: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const f of owned.splice(0)) { f.shutdown.abort(); f.handler.closeLive?.(); await new Promise<void>(r => { f.server.close(() => r()); f.server.closeAllConnections(); }); }
});
async function fixture(enabled = true) {
  let now = Date.now(), chunks = 0; const db = new FakeFirestoreServer(), shutdown = new AbortController();
  const store = new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'invented-live-api', policy: policy(now + 3600000), clock: () => now, maxSessions: 20, maxJourneysPerSession: 3 });
  const created = await store.createSession(now); if (!created || created === 'rate_limited') throw Error('fixture');
  const server = createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r())); const port = (server.address() as AddressInfo).port;
  const config = { ...loadConfig([], { WINTR_PORT: String(port) }), mode: 'live' as const };
  const source = parseSourcePolicy({ version: 'invented-stream-source', expiresAt: now + 3600000, videoIds: [],
    processing: { kind: 'user_directed_music', permissionVersion: 'invented-grant', youtube: true, recorded: true, live: enabled, deniedVideoIds: [], deniedRecordedDigests: [] } });
  if (!source.ok) throw Error('fixture');
  const analyse = vi.fn<ReferenceAdapter['analyse']>(async (input, signal) => {
    if (!input.stream) throw Error('fixture stream'); input.stream.ready();
    for await (const bytes of input.stream) { if (signal.aborted) throw Error('cancelled'); chunks += bytes.length; }
    return { audioAccess: 'accessed', observations: ['An invented beat.'], relationships: ['Keep the rhythm'], provider: null };
  });
  const handler = createApiHandler({ config, store, referenceAdapter: { synthetic: false, liveListening: { maxSeconds: 20 }, analyse }, sourcePolicy: source.policy, shutdown: shutdown.signal, now: () => now, liveListeningAuthority() {} });
  createWintrServer(config, handler, { server }); owned.push({ server, handler, shutdown });
  const origin = config.origin, cookie = `wintr_sid=${created.secret}`, owner = { sessionId: created.session.id, epoch: created.session.epoch };
  const connect = async (changes: { origin?: string; cookie?: string; host?: string; query?: string } = {}) => {
    const ws = new WebSocket(origin.replace('http', 'ws') + '/api/live-reference' + (changes.query ?? ''), { headers: { Origin: changes.origin ?? origin, Cookie: changes.cookie ?? cookie, ...(changes.host ? { Host: changes.host } : {}) } });
    clients.push(ws); const messages: any[] = []; ws.on('message', data => messages.push(JSON.parse(data.toString()))); ws.on('error', () => {});
    await new Promise<void>((yes, no) => { ws.once('open', yes); ws.once('error', no); ws.once('unexpected-response', (_r, res) => { res.resume(); ws.terminate(); no(Error(`refused:${res.statusCode}`)); }); });
    return { ws, messages, start: (key = 'invented-live-key-0001') => ws.send(JSON.stringify({ type: 'start', actionKey: key, cue: null })) };
  };
  const read = async () => { const r = await fetch(origin + '/api/state', { headers: { Cookie: cookie } }); return r.json(); };
  return { connect, store, owner, read, shutdown, handler, analyse, chunks: () => chunks, advance: (n: number) => { now += n; } };
}
describe('upgrade authentication and one owned stream', () => {
  it.each([{ origin: 'https://invented.invalid' }, { host: 'localhost:1' }, { cookie: '' }, { query: '?chat=bad' }, { query: '?extra=true' }, { query: `?chat=${newHandle()}` }])('refuses unowned/bad upgrade before admission: %j', async change => {
    const f = await fixture(); await expect(f.connect(change)).rejects.toThrow(); expect(f.analyse).not.toHaveBeenCalled();
    expect((await f.store.reconciliation().totals())?.counts.gemini ?? 0).toBe(0);
  });
  it('requires the separate streaming capability even when recording is enabled', async () => {
    const f = await fixture(false); await expect(f.connect()).rejects.toThrow(); expect((await f.read() as any).liveListening).toBeUndefined();
  });
  it('streams while connected, finishes once, then obtains results only through authenticated GET', async () => {
    const f = await fixture(), c = await f.connect(); c.start(); await vi.waitFor(() => expect(c.messages).toEqual([{ type: 'ready', maxSeconds: 20 }]));
    for (let left = 120000; left > 0;) { const n = Math.min(left, 4096); f.advance(Math.ceil(n / 24)); c.ws.send(Buffer.alloc(n * 2)); left -= n; await vi.waitFor(() => expect(f.chunks()).toBe(240000 - left * 2)); }
    c.ws.send(JSON.stringify({ type: 'finish' })); await vi.waitFor(() => expect(c.messages.at(-1)).toEqual({ type: 'complete' }));
    expect(c.messages).toHaveLength(2); expect(JSON.stringify(c.messages)).not.toMatch(/observations|receipt|artist|audio/);
    const snapshot = await f.read(); expect(isSafeSnapshot(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({ reference: { kind: 'streamed' }, analysis: { observations: ['An invented beat.'] } });
    expect((await f.store.reconciliation().totals())?.counts.gemini).toBe(1);
  });
  it('exact action replay never attaches another stream or counts a second submission', async () => {
    const f = await fixture(), a = await f.connect(); a.start(); await vi.waitFor(() => expect(a.messages[0]?.type).toBe('ready'));
    const b = await f.connect(); b.start(); await vi.waitFor(() => expect(b.messages).toEqual([{ type: 'complete' }]));
    expect(f.analyse).toHaveBeenCalledTimes(1); expect((await f.store.reconciliation().totals())?.counts.gemini).toBe(1);
  });
  it.each(['disconnect', 'cancel', 'duplicate', 'shutdown', 'clear'] as const)('%s revokes input without making it a successful Finish', async action => {
    const f = await fixture(), c = await f.connect(); c.start(); await vi.waitFor(() => expect(c.messages[0]?.type).toBe('ready'));
    if (action === 'disconnect') c.ws.close(); else if (action === 'cancel') c.ws.send(JSON.stringify({ type: 'cancel' }));
    else if (action === 'duplicate') c.start(); else if (action === 'shutdown') f.shutdown.abort();
    else await f.store.clearSession(f.owner.sessionId);
    if (action === 'clear') { c.ws.send(JSON.stringify({ type: 'cancel' })); }
    await vi.waitFor(async () => expect((await f.store.reconciliation().totals())?.active).toBe(0));
    const final = await f.read() as any;
    if (action === 'shutdown') expect(final).toEqual({ error: 'admission_unavailable', message: null });
    else expect(final.analysis).toBeNull();
    expect(f.analyse).toHaveBeenCalledOnce();
    expect((await f.store.reconciliation().totals())?.unresolved).toBe(1);
  });
  it('a Clear after upgrade but before start prevents admission', async () => {
    const f = await fixture(), c = await f.connect(); await f.store.clearSession(f.owner.sessionId); c.start();
    await vi.waitFor(() => expect(c.messages.at(-1)?.type).toBe('error')); expect(f.analyse).not.toHaveBeenCalled();
    expect((await f.store.reconciliation().totals())?.counts.gemini ?? 0).toBe(0);
  });
});

describe('explicit Live composition binding', () => {
  const liveBinding = () => binding({ liveListening: { ...GEMINI_LIVE_PROFILE, approvalId: 'call_invented_live_approval' },
    sourcePolicy: { version: 'invented-live-source', expiresAt: Date.now() + 3600000, videoIds: [], processing: { kind: 'user_directed_music', permissionVersion: 'invented-grant', youtube: true, recorded: true, live: true, deniedVideoIds: [], deniedRecordedDigests: [] } } });
  it('validates the fixed model, duration, output bound and retention without inheriting authority', () => {
    const b = liveBinding(); expect(validateLiveBindings(b, Date.now()).ok).toBe(true);
    for (const changed of [{ model: 'other' }, { maxSeconds: 60 }, { maxOutputTokens: 8192 }, { retention: 'no_retention' }, { approvalId: '' }]) expect(validateLiveBindings({ ...b, liveListening: { ...(b as any).liveListening, ...changed } }, Date.now()).ok).toBe(false);
    const absent = { ...b } as any; delete absent.liveListening; expect(validateLiveBindings(absent, Date.now()).ok).toBe(false);
  });
  it('requires a current controller guard before loading credentials or a shared store', async () => {
    const db = new FakeFirestoreServer(), l = loaders(db);
    const result = await composeLiveRuntime({ config: loadConfig([], {}), bindings: liveBinding(), loaders: l.loaders });
    expect(result).toMatchObject({ ok: false, problems: ['liveListening:authority_required'] }); expect(l.calls.secret).toHaveLength(0); expect(l.calls.firestore).toHaveLength(0);
  });
});
