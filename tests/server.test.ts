import { createServer, type Server } from 'node:http';
import { createHttpFixture } from './fixtures/http-lifecycle.js';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';
import { createApiHandler } from '../src/server/app.js';
import { ConfigError, loadConfig } from '../src/server/config.js';
import {
  AdapterOutputError,
  createSyntheticReferenceAdapter,
  validateAdapterResult,
  type ReferenceAdapter,
  type ReferenceAdapterResult,
  type ReferenceInput,
} from '../src/server/reference.js';
import { MemoryStore, type Owner } from '../src/server/store.js';

const URL_A = 'https://youtu.be/dQw4w9WgXcQ?t=12';
const URL_B = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
const RESULT: ReferenceAdapterResult = {
  audioAccess: 'synthetic_not_accessed',
  observations: ['Synthetic placeholder observation'],
  relationships: ['Synthetic A', 'Synthetic B'],
};

interface Call {
  input: ReferenceInput;
  signal: AbortSignal;
  resolve: (r: ReferenceAdapterResult) => void;
}

/** Adapter controlled by the test. With ignoreAbort it models a provider that answers late anyway. */
function controlledAdapter(ignoreAbort = false) {
  const calls: Call[] = [];
  const adapter: ReferenceAdapter = {
    synthetic: true,
    analyse: (input, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ input, signal, resolve });
        const { gate } = fixtureHttp.gate();
        void gate.then(() => resolve(RESULT));
        if (!ignoreAbort) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  };
  return { adapter, calls };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

const fixtureHttp = createHttpFixture();
const request = fixtureHttp.request;
const servers: Server[] = [];
async function closeFixtures() {
  await fixtureHttp.close(servers.splice(0));
}
afterEach(closeFixtures);

async function setup(opts: { adapter?: ReferenceAdapter | null; clock?: { t: number }; store?: (config: ReturnType<typeof loadConfig>) => MemoryStore } = {}) {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: opts.adapter === null ? 'disabled' : 'synthetic' });
  const store = opts.store ? opts.store(config) : new MemoryStore(config);
  const clock = opts.clock;
  const handler = createApiHandler({
    config,
    store,
    referenceAdapter: opts.adapter === undefined ? createSyntheticReferenceAdapter(0) : opts.adapter,
    now: clock ? () => clock.t : undefined,
    shutdown: fixtureHttp.shutdown(),
  });
  server.on('request', handler);

  const send = (
    method: string,
    path: string,
    o: { body?: unknown; raw?: string; cookie?: string; origin?: string | null; headers?: Record<string, string> } = {},
  ) =>
    fixtureHttp.observe(new Promise<Res>((resolve, reject) => {
      const payload = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
      const headers: Record<string, string> = { host: config.hostHeader, ...o.headers };
      if (o.origin !== null && method !== 'GET') headers.origin = o.origin ?? config.origin;
      if (payload !== undefined) {
        headers['content-type'] ??= 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      if (o.cookie) headers.cookie = o.cookie;
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        res.on('error', reject);
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const body = data ? JSON.parse(data) : null;
            if (res.statusCode! < 300 && body && 'mode' in body) expect(isSafeSnapshot(body)).toBe(true);
            resolve({ status: res.statusCode!, headers: res.headers, body });
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    }));

  const newSession = async () => {
    const res = await send('POST', '/api/session', { body: {} });
    expect(res.status).toBe(201);
    const set = String(res.headers['set-cookie']);
    return set.split(';')[0]!;
  };

  const state = async (cookie?: string) => (await send('GET', '/api/state', { cookie })).body as SafeSnapshot;

  return { config, store, send, newSession, state };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

const key = (n: number) => `test-action-key-${String(n).padStart(4, '0')}`;
const withoutDeliveryTime = (value: SafeSnapshot) => {
  if (!value.session) return value;
  const { checkedAt: _, ...session } = value.session;
  return { ...value, session };
};

it('creates, renames, switches and deletes an owned chat without dispatch, cookie replacement or a new expiry', async () => {
  const controlled = controlledAdapter();
  const app = await setup({ adapter: controlled.adapter });
  const cookie = await app.newSession(), original = await app.state(cookie);
  const created = await app.send('POST', '/api/chats', { cookie, body: { kind: 'create', actionKey: key(9000) } });
  expect(created.status).toBe(201); expect(created.headers['set-cookie']).toBeUndefined();
  const chat = created.body.chats.current;
  expect(created.body.session).toMatchObject({ context: original.session!.context, expiresAt: original.session!.expiresAt });
  expect(created.body.session.checkedAt).toBeLessThan(created.body.session.expiresAt);
  expect(created.body.chats.items).toHaveLength(2); expect(controlled.calls).toHaveLength(0);
  const renamed = await app.send('POST', '/api/chats', { cookie, body: { kind: 'rename', chat, title: 'Invented recent chat', expectedRevision: 0, actionKey: key(9001) } });
  expect(renamed.status).toBe(200); expect(renamed.body.chats.items[1].title).toBe('Invented recent chat');
  const switched = await app.send('GET', `/api/state?chat=${chat}`, { cookie });
  expect(switched.body.chats.current).toBe(chat); expect(switched.body.session).toMatchObject({ context: original.session!.context, expiresAt: original.session!.expiresAt });
  const deleted = await app.send('POST', '/api/chats', { cookie, body: { kind: 'delete', chat, expectedRevision: 1, actionKey: key(9002) } });
  expect(deleted.status).toBe(200); expect(deleted.body.chats.items).toHaveLength(1);
  expect((await app.send('GET', `/api/state?chat=${chat}`, { cookie })).body.session).toBeNull();
  expect((await app.state(cookie)).session).toMatchObject({ context: original.session!.context, expiresAt: original.session!.expiresAt }); expect(controlled.calls).toHaveLength(0);
});

it('delete-one cancels its current work and refuses its late result while another chat stays accessible', async () => {
  const controlled = controlledAdapter(true), app = await setup({ adapter: controlled.adapter });
  const cookie = await app.newSession(), original = await app.state(cookie);
  const created = await app.send('POST', '/api/chats', { cookie, body: { kind: 'create', actionKey: key(9010) } });
  const chat = created.body.chats.current;
  const running = app.send('POST', `/api/reference?chat=${chat}`, { cookie, body: { url: URL_A, actionKey: key(9011) } });
  await until(() => controlled.calls.length === 1);
  const deleted = await app.send('POST', '/api/chats', { cookie, body: { kind: 'delete', chat, expectedRevision: 0, actionKey: key(9012) } });
  expect(deleted.status).toBe(200); expect(controlled.calls[0]!.signal.aborted).toBe(true);
  controlled.calls[0]!.resolve(RESULT);
  expect((await running).body.analysis).toBeNull();
  expect((await app.state(cookie)).session).toMatchObject({ context: original.session!.context, expiresAt: original.session!.expiresAt });
  expect((await app.state(cookie)).analysis).toBeNull();
});

it('delete-one invalidates a directory response whose final authorization was delayed in the same instance', async () => {
  let held = false, release!: () => void, paused = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const app = await setup({ store: config => {
    class Delayed extends MemoryStore {
      override async authorizeRead(owner: Owner, now: number, revision?: number) {
        const allowed = await super.authorizeRead(owner, now, revision);
        if (paused) { paused = false; held = true; await gate; }
        return allowed;
      }
    }
    return new Delayed(config);
  } });
  const cookie = await app.newSession();
  const created = await app.send('POST', '/api/chats', { cookie, body: { kind: 'create', actionKey: key(9020) } });
  const chat = created.body.chats.current;
  paused = true;
  const reading = app.send('GET', '/api/state', { cookie });
  try {
    await until(() => held);
    expect((await app.send('POST', '/api/chats', { cookie, body: { kind: 'delete', chat, expectedRevision: 0, actionKey: key(9021) } })).status).toBe(200);
  } finally { release(); }
  const old = await reading;
  expect(old.body.session).toBeNull(); expect(old.body.chats).toBeUndefined();
});

it('refuses malformed/foreign chat selectors and chat writes from a foreign Origin', async () => {
  const app = await setup(), cookie = await app.newSession();
  expect((await app.send('GET', '/api/state?chat=wrong', { cookie })).status).toBe(400);
  expect((await app.send('GET', `/api/state?chat=${'a'.repeat(24)}&chat=${'b'.repeat(24)}`, { cookie })).status).toBe(400);
  expect((await app.send('GET', `/api/state?chat=${'a'.repeat(24)}`, { cookie })).body.session).toBeNull();
  expect((await app.send('POST', '/api/chats', { cookie, origin: 'https://invented.invalid', body: { kind: 'create', actionKey: key(9030) } })).status).toBe(403);
  expect((await app.send('POST', '/api/chats', { cookie, body: { kind: 'create', actionKey: key(9031), extra: true } })).status).toBe(400);
});

it('fixture teardown aborts an abandoned controlled reference and settles its observed request', async () => {
  const controlled = controlledAdapter();
  const app = await setup({ adapter: controlled.adapter });
  const cookie = await app.newSession();
  const pending = app.send('POST', '/api/reference', { cookie, body: { url: URL_A, actionKey: key(9876) } }).catch(() => null);
  await until(() => controlled.calls.length === 1);
  const closing = closeFixtures();
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(controlled.calls[0]!.signal.aborted).toBe(true);
  } finally {
    // Keeps this negative-before regression bounded even under the old broken hook.
    controlled.calls[0]!.resolve(RESULT);
    await pending;
    await closing;
  }
});

describe('configuration fails closed', () => {
  it.each(['environment', 'CLI'] as const)('never includes a rejected %s mode value in startup diagnostics', (source) => {
    // Invented private material and line breaks model a mistaken configuration value.
    const privateValue = 'invented-private-mode-value\r\n[wintr] invented-log-line';
    const invoke = () => loadConfig(source === 'CLI' ? [`--mode=${privateValue}`] : [], source === 'environment' ? { WINTR_MODE: privateValue } : {});
    expect(invoke).toThrow(ConfigError);
    expect(invoke).toThrow('Unknown mode. Use disabled or synthetic.');
    try { invoke(); } catch (err) {
      expect((err as Error).message).not.toContain(privateValue);
      expect((err as Error).message).not.toMatch(/[\r\n]/);
    }
  });

  it('refuses live mode, unknown modes and non-loopback binds', () => {
    expect(() => loadConfig(['--mode=live'], {})).toThrow(ConfigError);
    expect(() => loadConfig([], { WINTR_MODE: 'live' })).toThrow(ConfigError);
    expect(() => loadConfig(['--mode=prod'], {})).toThrow(ConfigError);
    expect(() => loadConfig([], { WINTR_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(loadConfig([], {}).mode).toBe('disabled');
  });
});

describe('origin, host and session ownership', () => {
  it('serves no-store state without CORS and without a session', async () => {
    const { send } = await setup();
    const res = await send('GET', '/api/state', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.body.session).toBeNull();
    expect(res.body.mode).toBe('synthetic');
  });

  it.each([
    ['missing', null],
    ['foreign', 'https://evil.example'],
    ['null', 'null'],
    ['other port', 'http://127.0.0.1:1'],
    ['localhost alias', 'http://localhost'],
  ])('rejects mutations with a %s Origin', async (_label, origin) => {
    const { send } = await setup();
    const res = await send('POST', '/api/session', { body: {}, origin });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('bad_origin');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects cross-site fetch metadata even with the right Origin', async () => {
    const { send } = await setup();
    const res = await send('POST', '/api/session', { body: {}, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(res.status).toBe(403);
  });

  it('rejects an unexpected Host header (DNS rebinding guard)', async () => {
    const { send } = await setup();
    const res = await send('GET', '/api/state', { headers: { host: 'attacker.example:80' } });
    expect(res.status).toBe(421);
  });

  it('issues an HttpOnly SameSite=Strict host cookie and no token in the body', async () => {
    const { send } = await setup();
    const res = await send('POST', '/api/session', { body: {} });
    expect(res.status).toBe(201);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    const secret = cookie.split(';')[0]!.split('=')[1]!;
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(res.body.session.context).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(secret).not.toContain(res.body.session.context);
    const other = await send('POST', '/api/session', { body: {} });
    expect(other.body.session.context).not.toBe(res.body.session.context);
  });

  it('enforces content type, body size and object bodies', async () => {
    const { send, newSession } = await setup();
    const cookie = await newSession();
    expect((await send('POST', '/api/reference', { raw: '{}', cookie, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await send('POST', '/api/reference', { raw: JSON.stringify({ x: 'a'.repeat(17000) }), cookie })).status).toBe(413);
    expect((await send('POST', '/api/reference', { raw: '[1,2]', cookie })).status).toBe(400);
    expect((await send('POST', '/api/reference', { raw: '{bad', cookie })).status).toBe(400);
  });

  it('requires a session for private mutations and ignores forged cookies', async () => {
    const { send } = await setup();
    const body = { url: URL_A, actionKey: key(1) };
    expect((await send('POST', '/api/reference', { body })).status).toBe(401);
    expect((await send('POST', '/api/reference', { body, cookie: `wintr_sid=${'A'.repeat(43)}` })).status).toBe(401);
  });

  it('isolates sessions: another session cannot read or stop an owned attempt', async () => {
    const { adapter, calls } = controlledAdapter();
    const { send, newSession, state } = await setup({ adapter });
    const a = await newSession();
    const b = await newSession();
    const pending = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie: a });
    await until(() => calls.length === 1);

    const aState = await state(a);
    expect(aState.attempt?.active).toBe(true);
    const bState = await state(b);
    expect(bState.reference).toBeNull();
    expect(bState.attempt).toBeNull();

    const foreignStop = await send('POST', '/api/stop', { body: { attempt: aState.attempt!.handle }, cookie: b });
    expect(foreignStop.status).toBe(404);
    expect(foreignStop.body).toEqual({ error: 'not_found', message: null });
    expect(calls[0]!.signal.aborted).toBe(false);

    calls[0]!.resolve(RESULT);
    const done = await pending;
    expect(done.status).toBe(200);
    expect(done.body.stage).toBe('awaiting_preference');
    expect(done.body.status).toBe('reference_ready');
    expect(done.body.analysis.synthetic).toBe(true);
    expect(done.body.reference).toEqual({
      videoId: 'dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      focus: { start: 12, end: 57 },
    });
    expect((await state(b)).analysis).toBeNull();
  });
});

describe('reference admission', () => {
  it('passes only the canonical reference to the adapter and labels synthetic output', async () => {
    const { adapter, calls } = controlledAdapter();
    const { send, newSession } = await setup({ adapter });
    const cookie = await newSession();
    const pending = send('POST', '/api/reference', {
      body: { url: `${URL_A}&si=tracking`, focus: { start: 20, end: 50 }, cue: '  the bassline  ', actionKey: key(1) },
      cookie,
    });
    await until(() => calls.length === 1);
    expect(calls[0]!.input).toEqual({
      reference: { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', focus: { start: 20, end: 50 } },
      listenerCue: 'the bassline',
    });
    calls[0]!.resolve(RESULT);
    expect((await pending).body.listenerCue).toBe('the bassline');
  });

  it('rejects invalid sources, bad focus and unclear timestamps without dispatch', async () => {
    const { adapter, calls } = controlledAdapter();
    const { send, newSession } = await setup({ adapter });
    const cookie = await newSession();
    const r1 = await send('POST', '/api/reference', { body: { url: 'https://evil.example/watch?v=dQw4w9WgXcQ', actionKey: key(1) }, cookie });
    expect(r1.status).toBe(422);
    expect(r1.body.error).toBe('invalid_source');
    expect(r1.body.message).toMatch(/youtube/i);
    const r2 = await send('POST', '/api/reference', { body: { url: URL_A, focus: { start: 0, end: 61 }, actionKey: key(2) }, cookie });
    expect(r2.body.error).toBe('invalid_focus');
    const conflict = 'https://youtu.be/dQw4w9WgXcQ?t=12&start=30';
    const r3 = await send('POST', '/api/reference', { body: { url: conflict, actionKey: key(3) }, cookie });
    expect(r3.body.error).toBe('needs_focus_correction');
    const r4 = await send('POST', '/api/reference', { body: { url: URL_A, cue: 'x'.repeat(1001), actionKey: key(4) }, cookie });
    expect(r4.status).toBe(422);
    const r5 = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: 'short' }, cookie });
    expect(r5.status).toBe(400);
    expect(calls).toHaveLength(0);

    const r6 = send('POST', '/api/reference', { body: { url: conflict, focus: { start: 12, end: 40 }, actionKey: key(6) }, cookie });
    await until(() => calls.length === 1);
    calls[0]!.resolve(RESULT);
    expect((await r6).body.reference.focus).toEqual({ start: 12, end: 40 });
  });

  it('allows one active operation and replays an action key without a second dispatch', async () => {
    const { adapter, calls } = controlledAdapter();
    const { send, newSession } = await setup({ adapter });
    const cookie = await newSession();
    const first = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    await until(() => calls.length === 1);

    const busy = await send('POST', '/api/reference', { body: { url: URL_B, actionKey: key(2) }, cookie });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('operation_active');
    const conflict = await send('POST', '/api/reference', { body: { url: URL_B, actionKey: key(1) }, cookie });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('action_conflict');

    calls[0]!.resolve(RESULT);
    const done = await first;
    const replay = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    expect(replay.status).toBe(200);
    expect(withoutDeliveryTime(replay.body)).toEqual(withoutDeliveryTime(done.body));
    expect(replay.body.session.checkedAt).toBeGreaterThanOrEqual(done.body.session.checkedAt);
    expect(calls).toHaveLength(1);
  });

  it('never answers an old action replay with a newer Journey', async () => {
    const { send, newSession } = await setup();
    const cookie = await newSession();
    const a = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    expect(a.body.reference.videoId).toBe('dQw4w9WgXcQ');
    const b = await send('POST', '/api/reference', { body: { url: URL_B, actionKey: key(2) }, cookie });
    expect(b.body.reference.videoId).toBe('aaaaaaaaaaa');

    const replayA = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    expect(replayA.status).toBe(409);
    expect(replayA.body).toEqual({ error: 'stale_operation', message: null });
    expect(JSON.stringify(replayA.body)).not.toContain('aaaaaaaaaaa');

    const replayB = await send('POST', '/api/reference', { body: { url: URL_B, actionKey: key(2) }, cookie });
    expect(replayB.status).toBe(200);
    expect(withoutDeliveryTime(replayB.body)).toEqual(withoutDeliveryTime(b.body));
    expect(replayB.body.session.checkedAt).toBeGreaterThanOrEqual(b.body.session.checkedAt);
  });

  it('binds concurrent identical requests to one dispatch and one operation', async () => {
    const { adapter, calls } = controlledAdapter();
    const { send, newSession } = await setup({ adapter });
    const cookie = await newSession();
    const body = { url: URL_A, actionKey: key(1) };
    const first = send('POST', '/api/reference', { body, cookie });
    const second = send('POST', '/api/reference', { body, cookie });
    await until(() => calls.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    calls[0]!.resolve(RESULT);
    const [r1, r2] = await Promise.all([first, second]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r1.body.attempt.handle).toBe(r2.body.attempt.handle);
    expect([r1.body.stage, r2.body.stage]).toContain('awaiting_preference');
    expect(calls).toHaveLength(1);
  });

  it('rejects a concurrent conflicting request on the same key without a second dispatch', async () => {
    const { adapter, calls } = controlledAdapter();
    const { send, newSession, state } = await setup({ adapter });
    const cookie = await newSession();
    const first = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    const second = send('POST', '/api/reference', { body: { url: URL_B, actionKey: key(1) }, cookie });
    await until(() => calls.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    calls[0]!.resolve(RESULT);
    const results = await Promise.all([first, second]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('action_conflict');
    expect(calls).toHaveLength(1);
    expect((await state(cookie)).reference).toEqual(calls[0]!.input.reference);
  });

  it('dispatches nothing when providers are disabled', async () => {
    const { send, newSession, state } = await setup({ adapter: null });
    const cookie = await newSession();
    const res = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('providers_disabled');
    const s = await state(cookie);
    expect(s.mode).toBe('disabled');
    expect(s.reference).toBeNull();
  });

  it('rejects oversized adapter output instead of truncating it', () => {
    expect(() => validateAdapterResult({ ...RESULT, observations: Array(6).fill('x') })).toThrow(AdapterOutputError);
    expect(() => validateAdapterResult({ ...RESULT, relationships: ['x'.repeat(301)] })).toThrow(AdapterOutputError);
    expect(() => validateAdapterResult({ ...RESULT, audioAccess: 'maybe' })).toThrow(AdapterOutputError);
    expect(validateAdapterResult(RESULT)).toEqual({ ...RESULT, provider: null });
    expect(() => validateAdapterResult({ ...RESULT, provider: { model: 'm', finalText: 'x'.repeat(512 * 1024 + 1), usage: null } })).toThrow(
      AdapterOutputError,
    );
  });
});

describe('Stop', () => {
  it('revokes the attempt before returning and aborts the adapter', async () => {
    const { adapter, calls } = controlledAdapter();
    const { send, newSession, state } = await setup({ adapter });
    const cookie = await newSession();
    const pending = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    await until(() => calls.length === 1);
    const handle = (await state(cookie)).attempt!.handle;

    const stopped = await send('POST', '/api/stop', { body: { attempt: handle }, cookie });
    expect(stopped.status).toBe(200);
    expect(stopped.body.stage).toBe('cancelled');
    expect(stopped.body.attempt).toEqual({ handle, kind: 'reference', active: false, outcome: 'cancelled' });
    expect(calls[0]!.signal.aborted).toBe(true);
    expect((await pending).body.stage).toBe('cancelled');

    const again = await send('POST', '/api/stop', { body: { attempt: handle }, cookie });
    expect(again.status).toBe(200);
    expect(again.body.stage).toBe('cancelled');
  });

  it('never commits a late provider answer after Stop', async () => {
    const { adapter, calls } = controlledAdapter(true);
    const { send, newSession, state } = await setup({ adapter });
    const cookie = await newSession();
    const pending = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    await until(() => calls.length === 1);
    const handle = (await state(cookie)).attempt!.handle;
    await send('POST', '/api/stop', { body: { attempt: handle }, cookie });

    calls[0]!.resolve(RESULT);
    const late = await pending;
    expect(late.body.stage).toBe('cancelled');
    expect(late.body.analysis).toBeNull();
    const s = await state(cookie);
    expect(s.analysis).toBeNull();
    expect(s.code).toBe('cancelled');
  });

  it('stops by action key on the server, including before the request arrives', async () => {
    const { adapter, calls } = controlledAdapter(true);
    const { send, newSession, state } = await setup({ adapter });
    const cookie = await newSession();

    const early = await send('POST', '/api/stop', { body: { actionKey: key(1) }, cookie });
    expect(early.status).toBe(200);
    const late = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('cancelled');
    expect(calls).toHaveLength(0);
    expect((await state(cookie)).reference).toBeNull();

    const running = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(2) }, cookie });
    await until(() => calls.length === 1);
    const stopped = await send('POST', '/api/stop', { body: { actionKey: key(2) }, cookie });
    expect(stopped.body.stage).toBe('cancelled');
    expect(calls[0]!.signal.aborted).toBe(true);
    expect((await running).body.stage).toBe('cancelled');
  });

  it('requires exactly one stop target', async () => {
    const { send, newSession } = await setup();
    const cookie = await newSession();
    expect((await send('POST', '/api/stop', { body: {}, cookie })).status).toBe(400);
    expect((await send('POST', '/api/stop', { body: { actionKey: key(1), attempt: 'x' }, cookie })).status).toBe(400);
    expect((await send('POST', '/api/stop', { body: { actionKey: 'short' }, cookie })).status).toBe(400);
  });

  it('rejects unknown handles and requires an exact Origin', async () => {
    const { send, newSession } = await setup();
    const cookie = await newSession();
    expect((await send('POST', '/api/stop', { body: { attempt: 'nope' }, cookie })).status).toBe(404);
    expect((await send('POST', '/api/stop', { body: { attempt: 'nope' }, cookie, origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('Clear and expiry', () => {
  it('revokes access immediately, expires the cookie and blocks late repopulation', async () => {
    const { adapter, calls } = controlledAdapter(true);
    const { send, newSession, state } = await setup({ adapter });
    const cookie = await newSession();
    const pending = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    await until(() => calls.length === 1);

    const cleared = await send('DELETE', '/api/session', { cookie });
    expect(cleared.status).toBe(200);
    expect(cleared.body.session).toBeNull();
    expect(String(cleared.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect(calls[0]!.signal.aborted).toBe(true);

    calls[0]!.resolve(RESULT);
    const late = await pending;
    expect(late.body.session).toBeNull();
    expect(late.body.analysis).toBeNull();

    const after = await state(cookie);
    expect(after.session).toBeNull();
    expect(after.reference).toBeNull();
    const reuse = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(2) }, cookie });
    expect(reuse.status).toBe(401);
  });

  it('revokes before any private read, then aborts the Attempt that was current', async () => {
    const events: string[] = [];
    class Recording extends MemoryStore {
      override async read(...a: Parameters<MemoryStore['read']>) {
        events.push('read');
        return super.read(...a);
      }
      override async clearSession(id: Handle) {
        events.push('clear');
        return super.clearSession(id);
      }
    }
    const { adapter, calls } = controlledAdapter(true);
    const { send, newSession, state } = await setup({ adapter, store: (config) => new Recording(config) });
    const cookie = await newSession();
    const pending = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    await until(() => calls.length === 1);
    events.length = 0;
    const cleared = await send('DELETE', '/api/session', { cookie });
    expect(cleared.status).toBe(200);
    // Revocation is the first store operation of Clear (the aborted request may read afterwards, already revoked).
    expect(events[0]).toBe('clear');
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.resolve(RESULT);
    expect((await pending).body.analysis).toBeNull();
    expect((await state(cookie)).session).toBeNull();
  });

  it('a store failure during Clear is not acknowledged: the cookie is kept, the session stays owned, and a later Clear succeeds', async () => {
    let fail = true;
    class Failing extends MemoryStore {
      override async clearSession(id: Handle) {
        if (fail) {
          fail = false;
          throw new Error('store unavailable');
        }
        return super.clearSession(id);
      }
    }
    const { send, newSession, state } = await setup({ store: (config) => new Failing(config) });
    const cookie = await newSession();
    const failed = await send('DELETE', '/api/session', { cookie });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(String(failed.headers['set-cookie'] ?? '')).not.toMatch(/Max-Age=0/);
    expect(failed.body?.session).toBeUndefined();
    expect((await state(cookie)).session).not.toBeNull();
    const retried = await send('DELETE', '/api/session', { cookie });
    expect(retried.status).toBe(200);
    expect(String(retried.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await state(cookie)).session).toBeNull();
  });

  it('requires an exact Origin to Clear and is idempotent without a session', async () => {
    const { send, newSession, state } = await setup();
    const cookie = await newSession();
    expect((await send('DELETE', '/api/session', { cookie, origin: null })).status).toBe(403);
    expect((await state(cookie)).session).not.toBeNull();
    expect((await send('DELETE', '/api/session', {})).status).toBe(200);
  });

  it('expires sessions at a fixed server time and refuses late commits', async () => {
    const clock = { t: 1_000_000 };
    const { adapter, calls } = controlledAdapter(true);
    const { send, newSession, state } = await setup({ adapter, clock });
    const cookie = await newSession();
    const pending = send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(1) }, cookie });
    await until(() => calls.length === 1);

    clock.t += 60 * 60 * 1000;
    calls[0]!.resolve(RESULT);
    expect((await pending).body.analysis).toBeNull();

    const s = await state(cookie);
    expect(s.session).toBeNull();
    expect(s.code).toBe('session_expired');
    const res = await send('POST', '/api/reference', { body: { url: URL_A, actionKey: key(2) }, cookie });
    expect(res.status).toBe(401);
  });
});
