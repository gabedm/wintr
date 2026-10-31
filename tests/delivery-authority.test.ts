import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createApiHandler, type ApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createSyntheticReferenceAdapter } from '../src/server/reference.js';
import { createEphemeralSealer } from '../src/server/seal.js';
import { MemoryStore, StoreUnavailable, type Store } from '../src/server/store.js';
import { createSyntheticCatalogue } from '../src/server/synthetic-catalogue.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { HOUR, policy } from './fixtures/live-fixtures.js';

// All requests are direct handler calls over synthetic fixtures and an
// in-process database: no HTTP listener, DNS, SDK, credential or provider.
const config = loadConfig([], { WINTR_MODE: 'synthetic' });
const T0 = Date.now();
const PRIVATE_CUE = 'INVENTED PRIVATE DELIVERY CUE';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

async function send(handler: ApiHandler, method: string, path: string, cookie?: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = method;
  req.url = path;
  req.headers = { host: config.hostHeader, origin: config.origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) };
  const headers = new Map<string, unknown>();
  let raw = '';
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader: (key: string, value: unknown) => { headers.set(key.toLowerCase(), value); },
    end: (text = '') => { raw = text; response.headersSent = true; },
  };
  await handler(req, response as unknown as ServerResponse);
  return { status: response.statusCode, raw, headers, json: String(headers.get('content-type')).startsWith('application/json') ? JSON.parse(raw) : null };
}

function api(store: Store, clock: () => number = () => T0, shutdown?: AbortSignal) {
  return createApiHandler({
    config, store, now: clock, shutdown, referenceAdapter: createSyntheticReferenceAdapter(0),
    discovery: {
      qloo: createQlooClient({ transport: createSyntheticQlooTransport(), apiKey: new ServerSecret('invented-fixture-only'), host: 'hackathon.api.qloo.com' }),
      qlooSynthetic: true, catalogue: createNativeCatalogue(createSyntheticCatalogue()), sealer: createEphemeralSealer(),
    },
  });
}

function pauseMethod(store: Store, method: 'read' | 'authorizeRead') {
  let armed = false;
  const ready = deferred(), release = deferred();
  const proxy = new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === method) return async (...args: unknown[]) => {
        const result = await (value as (...args: unknown[]) => Promise<unknown>).apply(target, args);
        if (armed) { armed = false; ready.resolve(); await release.promise; }
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { store: proxy, arm: () => { armed = true; }, ready: ready.promise, release: release.resolve };
}

async function seeded(handler: ApiHandler) {
  const session = await send(handler, 'POST', '/api/session', undefined, {});
  expect(session.status).toBe(201);
  const cookie = String(session.headers.get('set-cookie')).split(';')[0]!;
  const reference = await send(handler, 'POST', '/api/reference', cookie, { url: 'https://youtu.be/aaaaaaaaaaa', actionKey: 'invented-reference-0001' });
  expect(reference.status).toBe(200);
  const saved = await send(handler, 'POST', '/api/preference', cookie, {
    analysis: reference.json.analysis.handle, expectedBrief: null, actionKey: 'invented-preference-0001',
    relationship: { text: PRIVATE_CUE }, artists: ['Invented Seed Artist'],
  });
  expect(saved.status).toBe(200);
  const found = await send(handler, 'POST', '/api/discover', cookie, { brief: saved.json.brief.handle, actionKey: 'invented-discover-0001' });
  expect(found.status).toBe(200);
  expect(found.json.panel.suggestionsUrl).toMatch(/^\/api\/suggestions\//);
  return { cookie, suggestions: found.json.panel.suggestionsUrl as string };
}

describe('owned private delivery authorization', () => {
  it.each(['state', 'Suggestions'] as const)('withholds a held %s snapshot after Clear on another shared instance', async kind => {
    const db = new FakeFirestoreServer();
    const make = () => new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'svc-delivery-invented',
      policy: policy(T0 + 2 * HOUR), clock: () => T0, maxSessions: 5, maxJourneysPerSession: 3 });
    const paused = pauseMethod(make(), 'read');
    const first = api(paused.store), second = api(make());
    const fixture = await seeded(first);
    paused.arm();
    const pending = send(first, 'GET', kind === 'state' ? '/api/state' : fixture.suggestions, fixture.cookie);
    await paused.ready;
    const cleared = await send(second, 'DELETE', '/api/session', fixture.cookie);
    expect([cleared.status, cleared.json.session]).toEqual([200, null]);
    paused.release();
    const late = await pending;
    expect(late.raw).not.toMatch(/INVENTED PRIVATE|Synthetic Track|Synthetic Search Suggestions/);
    if (kind === 'state') expect(late.json.session).toBeNull();
    else expect([late.status, late.raw]).toEqual([404, '']);
  });

  it.each(['state', 'Suggestions'] as const)('invalidates a held %s snapshot locally before acknowledging Clear', async kind => {
    const paused = pauseMethod(new MemoryStore(config), 'read');
    const handler = api(paused.store);
    const fixture = await seeded(handler);
    paused.arm();
    const pending = send(handler, 'GET', kind === 'state' ? '/api/state' : fixture.suggestions, fixture.cookie);
    await paused.ready;
    expect((await send(handler, 'DELETE', '/api/session', fixture.cookie)).status).toBe(200);
    paused.release();
    const late = await pending;
    expect(late.raw).not.toMatch(/INVENTED PRIVATE|Synthetic Track|Synthetic Search Suggestions/);
    if (kind === 'state') expect(late.json.session).toBeNull();
    else expect([late.status, late.raw]).toEqual([404, '']);
  });

  it.each(['state', 'Suggestions'] as const)('invalidates an already authorized %s response delayed across local Clear', async kind => {
    const paused = pauseMethod(new MemoryStore(config), 'authorizeRead');
    const handler = api(paused.store);
    const fixture = await seeded(handler);
    paused.arm();
    const pending = send(handler, 'GET', kind === 'state' ? '/api/state' : fixture.suggestions, fixture.cookie);
    await paused.ready; // The underlying minimal read authorized before Clear, but its receipt is delayed.
    expect((await send(handler, 'DELETE', '/api/session', fixture.cookie)).status).toBe(200);
    paused.release();
    const late = await pending;
    expect(late.raw).not.toMatch(/INVENTED PRIVATE|Synthetic Track|Synthetic Search Suggestions/);
    if (kind === 'state') expect(late.json.session).toBeNull();
    else expect([late.status, late.raw]).toEqual([404, '']);
  });

  it('invalidates older local reads as soon as Clear begins, before the store reply', async () => {
    const clearReady = deferred(), clearRelease = deferred();
    class SlowClear extends MemoryStore {
      armed = false;
      override async clearSession(...args: Parameters<MemoryStore['clearSession']>) {
        if (this.armed) { this.armed = false; clearReady.resolve(); await clearRelease.promise; }
        return super.clearSession(...args);
      }
    }
    const store = new SlowClear(config), paused = pauseMethod(store, 'read');
    const handler = api(paused.store), fixture = await seeded(handler);
    paused.arm();
    const pendingRead = send(handler, 'GET', '/api/state', fixture.cookie);
    await paused.ready;
    store.armed = true;
    const pendingClear = send(handler, 'DELETE', '/api/session', fixture.cookie);
    await clearReady.promise;
    paused.release();
    expect((await pendingRead).json.session).toBeNull();
    clearRelease.resolve();
    expect((await pendingClear).status).toBe(200);
  });

  it('also invalidates a read begun while Clear is waiting for the store', async () => {
    const clearReady = deferred(), clearRelease = deferred();
    class SlowClear extends MemoryStore {
      armed = false;
      override async clearSession(...args: Parameters<MemoryStore['clearSession']>) {
        if (this.armed) { this.armed = false; clearReady.resolve(); await clearRelease.promise; }
        return super.clearSession(...args);
      }
    }
    const store = new SlowClear(config), paused = pauseMethod(store, 'authorizeRead');
    const handler = api(paused.store), fixture = await seeded(handler);
    store.armed = true;
    const pendingClear = send(handler, 'DELETE', '/api/session', fixture.cookie);
    await clearReady.promise;
    paused.arm();
    const pendingRead = send(handler, 'GET', '/api/state', fixture.cookie);
    await paused.ready;
    clearRelease.resolve();
    expect((await pendingClear).status).toBe(200);
    paused.release();
    expect((await pendingRead).json.session).toBeNull();
  });

  it.each(['state', 'Suggestions'] as const)('fails %s closed when the final authority read is unavailable', async kind => {
    class Unavailable extends MemoryStore {
      fail = false;
      override async authorizeRead(...args: Parameters<MemoryStore['authorizeRead']>) {
        if (this.fail) throw new StoreUnavailable();
        return super.authorizeRead(...args);
      }
    }
    const store = new Unavailable(config), handler = api(store), fixture = await seeded(handler);
    store.fail = true;
    const reply = await send(handler, 'GET', kind === 'state' ? '/api/state' : fixture.suggestions, fixture.cookie);
    expect(reply.status).toBe(503);
    expect(reply.raw).not.toMatch(/INVENTED PRIVATE|Synthetic Track|Synthetic Search Suggestions/);
  });

  it.each([
    ['state', 'expiry'], ['Suggestions', 'expiry'], ['state', 'shutdown'], ['Suggestions', 'shutdown'],
  ] as const)('retains the final %s %s fence after a delayed successful authority read', async (kind, end) => {
    let now = T0;
    const shutdown = new AbortController();
    const paused = pauseMethod(new MemoryStore(config), 'authorizeRead');
    const handler = api(paused.store, () => now, shutdown.signal), fixture = await seeded(handler);
    paused.arm();
    const pending = send(handler, 'GET', kind === 'state' ? '/api/state' : fixture.suggestions, fixture.cookie);
    await paused.ready;
    if (end === 'expiry') now = T0 + HOUR;
    else shutdown.abort();
    paused.release();
    const late = await pending;
    expect(late.status).toBe(end === 'shutdown' ? 503 : kind === 'state' ? 401 : 404);
    expect(late.raw).not.toMatch(/INVENTED PRIVATE|Synthetic Track|Synthetic Search Suggestions/);
  });

  it('a failed Clear invalidates old local reads but permits explicit read/retry recovery', async () => {
    class FailedClear extends MemoryStore {
      fail = true;
      override async clearSession(...args: Parameters<MemoryStore['clearSession']>) {
        if (this.fail) { this.fail = false; throw new StoreUnavailable(); }
        return super.clearSession(...args);
      }
    }
    const paused = pauseMethod(new FailedClear(config), 'authorizeRead');
    const handler = api(paused.store), fixture = await seeded(handler);
    paused.arm();
    const pending = send(handler, 'GET', '/api/state', fixture.cookie);
    await paused.ready;
    const failed = await send(handler, 'DELETE', '/api/session', fixture.cookie);
    expect(failed.status).toBe(503);
    expect(failed.headers.has('set-cookie')).toBe(false);
    paused.release();
    expect((await pending).json.session).toBeNull();
    // No durable revocation was acknowledged; a fresh explicit read is still authorized.
    expect((await send(handler, 'GET', '/api/state', fixture.cookie)).json.session).not.toBeNull();
    expect((await send(handler, 'DELETE', '/api/session', fixture.cookie)).status).toBe(200);
    expect((await send(handler, 'GET', '/api/state', fixture.cookie)).json.session).toBeNull();
  });

  it('the minimal shared check is read-only and rejects a wrong epoch, Clear, expiry and corrupt authority', async () => {
    let now = T0;
    const db = new FakeFirestoreServer();
    const store = new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'svc-delivery-invented',
      policy: policy(T0 + 2 * HOUR), clock: () => now, maxSessions: 5, maxJourneysPerSession: 3 });
    const created = await store.createSession(now);
    if (!created || typeof created === 'string') throw new Error('invented session setup');
    const owner = { sessionId: created.session.id, epoch: created.session.epoch };
    const writes = db.log.length;
    expect(await store.authorizeRead(owner, now)).toBe(true);
    expect(await store.authorizeRead({ ...owner, epoch: owner.epoch + 1 }, now)).toBe(false);
    expect(db.log.length).toBe(writes);
    now = created.session.expiresAt;
    expect(await store.authorizeRead(owner, now)).toBe(false);
    now = T0;
    await store.clearSession(owner.sessionId);
    expect(await store.authorizeRead(owner, now)).toBe(false);
    db.seed(`wintr_owned/session_${owner.sessionId}`, { invented: 'malformed' });
    await expect(store.authorizeRead(owner, now)).rejects.toBeInstanceOf(StoreUnavailable);
  });
});
