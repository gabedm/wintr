import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../src/server/config.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { composeLiveRuntime, startLiveServer } from '../src/server/live-runtime.js';
import { createHostedBaseConfig, hostedServingOf, parseHostedServing } from '../src/server/serving-profile.js';
import { FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { APPROVED, binding, loaders, transports, type LoaderOptions } from './fixtures/live-fixtures.js';

// Future-profile preparation evidence only: constructed HTTPS Host/Origin over
// loopback HTTP, fake identity/store/transports and invented values. No TLS,
// public listener, real provider, credential, cloud, source or deployment.
const serving = (port = 8080) => ({ profile: 'https_proxy_v1', publicOrigin: 'https://wintr.example.com', listenHost: '127.0.0.1', listenPort: port });
const base = () => loadConfig([], {});
function hosted(raw: unknown = serving()) {
  const made = createHostedBaseConfig(base(), raw);
  if (!made.ok) throw new Error(made.problems.join(','));
  return made.config;
}
async function compose(config: Config, raw: unknown, options: { loader?: LoaderOptions; clock?: () => number } = {}) {
  const db = new FakeFirestoreServer(), l = loaders(db, options.loader), t = transports();
  const runtime = await composeLiveRuntime({ config, bindings: raw, loaders: l.loaders, network: t.network, clock: options.clock });
  return { runtime, calls: l.calls, t };
}
const noLoads = (calls: Awaited<ReturnType<typeof compose>>['calls']) => expect(calls).toEqual({ secret: [], token: 0, firestore: [] });

describe('explicit future HTTPS profile', () => {
  it('constructs a disabled immutable config without changing the ordinary loopback base or recognising a clone', () => {
    const local = base(), raw = serving();
    const made = createHostedBaseConfig(local, raw);
    if (!made.ok) throw new Error(made.problems.join(','));
    expect(made.config).toMatchObject({ mode: 'disabled', origin: raw.publicOrigin, hostHeader: 'wintr.example.com', host: '127.0.0.1', port: 8080, dev: false, secureCookie: true });
    raw.publicOrigin = 'https://changed.example.com';
    expect(made.config.origin).toBe('https://wintr.example.com');
    expect(hostedServingOf(made.config)?.publicOrigin).toBe('https://wintr.example.com');
    expect(hostedServingOf({ ...made.config })).toBeNull();
    expect(Object.isFrozen(made.config) && Object.isFrozen(made.config.freeMutation)).toBe(true);
    expect(local).toMatchObject({ origin: 'http://127.0.0.1:8787', secureCookie: false, mode: 'disabled' });
    expect(() => loadConfig([], { WINTR_MODE: 'live', WINTR_HOST: '0.0.0.0' })).toThrow();
    expect(() => loadConfig([], { WINTR_MODE: 'synthetic', WINTR_HOST: '0.0.0.0' })).toThrow();
  });

  it.each([
    null, [], {}, { ...serving(), extra: true }, { ...serving(), profile: 'live' },
    { ...serving(), publicOrigin: 'http://wintr.example.com' },
    { ...serving(), publicOrigin: 'https://user:private@wintr.example.com' },
    { ...serving(), publicOrigin: 'https://WINTR.example.com' },
    { ...serving(), publicOrigin: 'https://wintr.example.com/' },
    { ...serving(), publicOrigin: 'https://wintr.example.com/path' },
    { ...serving(), publicOrigin: 'https://wintr.example.com?q=private' },
    { ...serving(), publicOrigin: 'https://wintr.example.com#private' },
    { ...serving(), publicOrigin: 'https://wintr.example.com:443' },
    { ...serving(), publicOrigin: 'https://wintr.example.com:0' },
    { ...serving(), publicOrigin: 'https://127.0.0.1' },
    { ...serving(), publicOrigin: 'https://[::1]' },
    { ...serving(), publicOrigin: 'https://localhost' },
    { ...serving(), publicOrigin: 'https://app.local' },
    { ...serving(), publicOrigin: 'https://app.example.com.' },
    { ...serving(), publicOrigin: 'https://*.example.com' },
    { ...serving(), listenHost: 'localhost' },
    { ...serving(), listenHost: '192.168.1.1' },
    { ...serving(), listenPort: 0 }, { ...serving(), listenPort: 65536 },
    { ...serving(), listenPort: 1.5 }, { ...serving(), listenPort: '8080' },
  ])('rejects malformed/noncanonical serving input without reflecting its values', raw => {
    const parsed = parseHostedServing(raw);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toMatch(/private|wintr\.example|192\.168/);
  });

  it('accepts explicit non-default HTTPS ports and backend wildcards as data without starting a public server', () => {
    const raw = { ...serving(), publicOrigin: 'https://wintr.example.com:8443', listenHost: '0.0.0.0' };
    const made = createHostedBaseConfig(base(), raw);
    expect(made).toMatchObject({ ok: true, config: { origin: raw.publicOrigin, hostHeader: 'wintr.example.com:8443', host: '0.0.0.0', secureCookie: true } });
  });

  it('rejects extra base fields, a live/synthetic base, dev middleware and throwing profile getters', () => {
    for (const change of [{ debug: true }, { mode: 'live' }, { mode: 'synthetic' }, { dev: true }]) {
      expect(createHostedBaseConfig({ ...base(), ...change } as Config, serving()).ok).toBe(false);
    }
    const raw = { ...serving(), get publicOrigin(): string { throw new Error('private sentinel'); } };
    expect(parseHostedServing(raw)).toEqual({ ok: false, problem: 'shape' });
  });

  it('rejects changing accessor authority rather than validating one value and granting a capability for another', () => {
    let reads = 0;
    const raw = { ...serving(), get publicOrigin() {
      return ++reads <= 4 ? 'https://wintr.example.com' : 'http://wintr.example.com';
    } };
    expect(createHostedBaseConfig(base(), raw).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it.each(['publicOrigin', 'listenHost', 'listenPort'] as const)('rejects accessor %s in both the config constructor and the explicit binding without invoking it', key => {
    let reads = 0;
    const raw = Object.defineProperty({ ...serving() }, key, { enumerable: true, get: () => { reads++; return serving()[key]; } });
    expect(createHostedBaseConfig(base(), raw).ok).toBe(false);
    expect(validateLiveBindings(binding({ serving: raw }), Date.now()).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it('rejects symbol and nonenumerable extras, including hidden base-config authority', () => {
    expect(parseHostedServing({ ...serving(), [Symbol('extra')]: true }).ok).toBe(false);
    expect(parseHostedServing(Object.defineProperty({ ...serving() }, 'extra', { value: true })).ok).toBe(false);
    expect(createHostedBaseConfig(Object.defineProperty(base(), 'extra', { value: true }), serving()).ok).toBe(false);
  });
});

describe('hosted config and complete runtime binding must agree before loaders', () => {
  it('accepts a matching explicit profile with all the existing source/store/identity/admission bindings', async () => {
    const c = await compose(hosted(), binding({ serving: serving() }));
    expect(c.runtime.ok).toBe(true);
    expect(c.calls.secret).toHaveLength(3);
    expect(c.t.reference).toHaveLength(0);
    expect(c.t.qloo).toHaveLength(0);
    if (c.runtime.ok) expect(c.runtime.config.secureCookie).toBe(true);
  });

  it.each([
    ['missing serving binding', () => hosted(), () => binding(), 'serving:missing'],
    ['loopback config with hosted binding', () => base(), () => binding({ serving: serving() }), 'serving:requires_hosted_config'],
    ['different origin', () => hosted(), () => binding({ serving: { ...serving(), publicOrigin: 'https://other.example.com' } }), 'serving:mismatch'],
    ['different backend port', () => hosted(), () => binding({ serving: serving(8081) }), 'serving:mismatch'],
    ['different backend host', () => hosted(), () => binding({ serving: { ...serving(), listenHost: '::1' } }), 'serving:mismatch'],
    ['unknown serving field', () => hosted(), () => binding({ serving: { ...serving(), trustForwarded: true } }), 'serving:shape'],
    ['undefined serving field', () => hosted(), () => binding({ serving: undefined }), 'binding:shape'],
    ['invalid full binding', () => hosted(), () => binding({ serving: serving(), serviceId: '' }), 'serviceId:empty'],
  ] as const)('refuses %s without loading credentials or store', async (_label, config, raw, problem) => {
    const c = await compose(config(), raw());
    expect(c.runtime).toMatchObject({ ok: false, problems: expect.arrayContaining([problem]) }); noLoads(c.calls);
  });

  it('refuses copied or hand-spoofed hosted configs before loaders, preserving ordinary local validation', async () => {
    for (const config of [{ ...hosted() }, { ...base(), host: '0.0.0.0', secureCookie: true, origin: 'https://wintr.example.com', hostHeader: 'wintr.example.com' }]) {
      const c = await compose(config, binding({ serving: serving() }));
      expect(c.runtime.ok).toBe(false); noLoads(c.calls);
    }
  });

  it('snapshots the matching serving binding before async loaders and refuses expired authority', async () => {
    const originalServing = serving();
    const raw = binding({ serving: originalServing });
    const c = await compose(hosted(), raw, { loader: { onSecret: () => { originalServing.publicOrigin = 'https://changed.example.com'; } } });
    if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
    expect(c.runtime.config.origin).toBe('https://wintr.example.com');
    expect(c.runtime.bindings.serving?.publicOrigin).toBe('https://wintr.example.com');
    const clock = { now: Date.now() };
    const expired = await compose(hosted(), binding({ serving: serving() }), { clock: () => clock.now, loader: { onSecret: () => { clock.now += 3 * 3_600_000; } } });
    expect(expired.runtime.ok).toBe(false);
    expect(expired.calls.secret).toHaveLength(1);
    expect(expired.calls.firestore).toHaveLength(0);
    expect(await startLiveServer({ ...c.runtime })).toEqual({ ok: false, problems: ['runtime:not_composed'] });
  });

  it('keeps an omitted profile backwards compatible but rejects a malformed present profile', () => {
    const ordinary = validateLiveBindings(binding(), Date.now());
    expect(ordinary.ok).toBe(true);
    if (ordinary.ok) expect(ordinary.bindings.serving).toBeUndefined();
    expect(validateLiveBindings(binding({ serving: { ...serving(), publicOrigin: 'http://wintr.example.com' } }), Date.now()).ok).toBe(false);
  });

  it('refuses a formerly valid hosted runtime at its exact expiry before starting a listener', async () => {
    const clock = { now: Date.now() };
    const c = await compose(hosted(), binding({ serving: serving() }), { clock: () => clock.now });
    if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
    clock.now = c.runtime.validUntil;
    expect(await startLiveServer(c.runtime)).toEqual({ ok: false, problems: ['expiresAt:expired'] });
    expect(c.t.reference).toHaveLength(0);
    expect(c.t.qloo).toHaveLength(0);
  });
});

const servers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(close => close())); });
async function freePort() {
  const s = createServer(); await new Promise<void>(done => s.listen(0, '127.0.0.1', done));
  const port = (s.address() as AddressInfo).port; await new Promise<void>(done => s.close(() => done())); return port;
}
async function hostedHttp() {
  const profile = { ...serving(await freePort()), publicOrigin: 'https://wintr.example.com:8443' };
  const c = await compose(hosted(profile), binding({ serving: profile }));
  if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
  const started = await startLiveServer(c.runtime);
  if (!started.ok) throw new Error(started.problems.join(','));
  servers.push(started.close);
  expect((started.server.address() as AddressInfo).address).toBe('127.0.0.1');
  const send = (method: string, path: string, options: { body?: unknown; cookie?: string; origin?: string | null; host?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; body: any; cookie?: string; setCookie: string }>((done, fail) => {
      const headers: Record<string, string> = { host: options.host ?? 'wintr.example.com:8443', ...options.headers };
      if (method !== 'GET' && options.origin !== null) headers.origin = options.origin ?? profile.publicOrigin;
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
      if (options.cookie) headers.cookie = options.cookie;
      const req = request({ host: '127.0.0.1', port: profile.listenPort, method, path, headers }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
        res.on('end', () => { const setCookie = String(res.headers['set-cookie']?.[0] ?? ''); done({ status: res.statusCode!, body: JSON.parse(text), cookie: setCookie.split(';')[0], setCookie }); });
      });
      req.on('error', fail); req.end(payload);
    });
  return { ...c, send, runtime: c.runtime };
}

describe('HTTPS-profile HTTP boundary on a loopback-only synthetic server', () => {
  it('issues a Secure __Host cookie despite false forwarding headers, with exact Origin and host-only scope', async () => {
    const h = await hostedHttp();
    const result = await h.send('POST', '/api/session', { body: {}, headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'other.example.com' } });
    expect(result.status).toBe(201);
    expect(result.setCookie).toMatch(/^__Host-wintr_sid=/);
    expect(result.setCookie).toContain('; HttpOnly; SameSite=Strict; Path=/;');
    expect(result.setCookie).toContain('; Secure');
    expect(result.setCookie).not.toMatch(/Domain=/i);
    expect(h.t.reference).toHaveLength(0);
  });

  it.each([null, 'null', 'http://wintr.example.com:8443', 'https://wintr.example.com', 'https://foreign.example.com'])('rejects hostile/missing mutation Origin %s even with matching forwarded headers', async origin => {
    const h = await hostedHttp();
    const result = await h.send('POST', '/api/session', { body: {}, origin, headers: { forwarded: 'proto=https;host="wintr.example.com:8443"', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'wintr.example.com:8443' } });
    expect(result.status).toBe(403); expect(result.body.error).toBe('bad_origin'); expect(result.setCookie).toBe('');
  });

  it('rejects a backend Host alias without leaking another owner’s content, regardless of forwarded host', async () => {
    const h = await hostedHttp();
    const result = await h.send('GET', '/api/state', { host: '127.0.0.1', headers: { 'x-forwarded-host': 'wintr.example.com:8443' } });
    expect(result.status).toBe(421); expect(result.body.error).toBe('bad_host');
  });

  it('never accepts the ordinary loopback cookie name as a hosted session', async () => {
    const h = await hostedHttp();
    const owner = await h.send('POST', '/api/session', { body: {} });
    const legacyCookie = owner.cookie!.replace(/^__Host-/, '');
    expect((await h.send('GET', '/api/state', { cookie: legacyCookie })).body.session).toBeNull();
    expect((await h.send('GET', '/api/state', { cookie: owner.cookie })).body.session).not.toBeNull();
  });

  it('keeps owned reference handles isolated across sessions under the secure profile', async () => {
    const h = await hostedHttp();
    const a = (await h.send('POST', '/api/session', { body: {} })).cookie!;
    const b = (await h.send('POST', '/api/session', { body: {} })).cookie!;
    const reference = await h.send('POST', '/api/reference', { cookie: a, body: { url: `https://youtu.be/${APPROVED}`, actionKey: 'hosted-owned-reference-0001' } });
    expect(reference.status).toBe(200);
    const foreign = await h.send('POST', '/api/preference', { cookie: b, body: { analysis: reference.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist'], expectedBrief: null, actionKey: 'hosted-foreign-preference-0001' } });
    expect(foreign.status).toBe(409);
    expect(foreign.body.error).toBe('stale_version');
    expect(JSON.stringify(foreign.body)).not.toContain(reference.body.analysis.handle);
    expect(h.t.reference).toHaveLength(1);
    expect((await h.send('DELETE', '/api/session', { cookie: a })).status).toBe(200);
    expect((await h.send('GET', '/api/state', { cookie: a })).body.session).toBeNull();
  });
});
