import dns from 'node:dns';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { connect, createServer as netServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';
import { loadConfig, type Config } from '../src/server/config.js';
import { createWintrServer, listen } from '../src/server/http-server.js';
import { composeLiveRuntime, startLiveServer } from '../src/server/live-runtime.js';
import { createLocalApi } from '../src/server/local-app.js';
import { FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { APPROVED, binding, loaders, NOT_APPROVED, transports, type LoaderOptions } from './fixtures/live-fixtures.js';

// The canonical HTTP server over an actual client build (Vite, the project's
// own config, emitted into a temporary directory): shipped font notices, both
// ordinary modes and the controller-only live start seam. Synthetic evidence
// only: invented binding values, fake transports, the SDK-shaped fake database
// and a loopback server. No credential, provider, Firestore or browser was used.

const sdk = vi.hoisted(() => ({ loads: 0 }));
vi.mock('@google-cloud/firestore', () => {
  sdk.loads += 1;
  return { Firestore: class {} };
});

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const OUT_PREFIX = 'wintr-client-';
const TEMP_ROOT = realpathSync.native(tmpdir());
let out: string;
/** Set only once the build directory is proven to be a fresh mkdtemp child of the OS temp root. */
let owned = false;

/** A directory this suite may empty or delete: directly inside the OS temp root, named wintr-client-<random>. */
function isOwnedTempDir(dir: string): boolean {
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch {
    return false;
  }
  const name = basename(real);
  return dirname(real) === TEMP_ROOT && name.startsWith(OUT_PREFIX) && name.length > OUT_PREFIX.length && resolve(dir) === resolve(TEMP_ROOT, name);
}

beforeAll(async () => {
  out = mkdtempSync(join(TEMP_ROOT, OUT_PREFIX));
  if (!isOwnedTempDir(out)) throw new Error('temporary build directory is not an owned child of the OS temp root');
  owned = true;
  await build({ configFile: resolve('vite.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
}, 120_000);
afterAll(() => {
  if (owned && isOwnedTempDir(out)) rmSync(out, { recursive: true, force: true });
});

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

const closer = (server: Server) => ({
  close: () =>
    new Promise<void>((r) => {
      if (!server.listening) return r();
      server.close(() => r());
      server.closeAllConnections();
    }),
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  raw: Buffer;
  json: any;
  cookie?: string;
}

function client(config: Config) {
  let n = 0;
  const send = (method: string, path: string, x: { body?: unknown; cookie?: string; host?: string; origin?: string } = {}) =>
    new Promise<Reply>((ok, fail) => {
      const payload = x.body === undefined ? undefined : JSON.stringify(x.body);
      const headers: Record<string, string> = { host: x.host ?? config.hostHeader };
      if (method !== 'GET' && method !== 'HEAD') headers.origin = x.origin ?? config.origin;
      if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
      if (x.cookie) headers.cookie = x.cookie;
      const req = request({ host: config.host, port: config.port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          const json = String(res.headers['content-type']).startsWith('application/json') && text ? JSON.parse(text) : null;
          ok({ status: res.statusCode!, headers: res.headers, text, raw, json, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
        });
      });
      req.on('error', fail);
      req.end(payload);
    });
  return { send, key: () => `shell-test-key-${String(++n).padStart(6, '0')}` };
}

/**
 * Network and SDK access observed during a block (none is expected outside fake
 * transports). Node's own server.listen passes the loopback literal through
 * dns.lookup, which resolves it locally; any other name counts.
 */
function watchExternal() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
  const lookup = vi.spyOn(dns, 'lookup');
  const plookup = vi.spyOn(dns.promises, 'lookup');
  const sdkBefore = sdk.loads;
  const names = () => [...lookup.mock.calls, ...plookup.mock.calls].map((a) => a[0]).filter((h) => h !== '127.0.0.1' && h !== '::1');
  return () => ({ fetch: fetchSpy.mock.calls.length, dns: names(), sdk: sdk.loads - sdkBefore });
}

const assetNames = () => readdirSync(join(out, 'assets'));

/** Shared checks that a server is the canonical shell over the built client. */
async function expectCanonicalShell(c: ReturnType<typeof client>, config: Config) {
  const index = await c.send('GET', '/');
  expect(index.status).toBe(200);
  expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(index.headers['content-security-policy']).toMatch(/default-src 'self'.*font-src 'self'.*frame-ancestors 'none'/);
  expect(index.headers['cache-control']).toBe('no-store');
  expect(index.raw.equals(readFileSync(join(out, 'index.html')))).toBe(true);
  const js = assetNames().find((f) => f.endsWith('.js'))!;
  const asset = await c.send('GET', `/assets/${js}`);
  expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
  expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(asset.raw.equals(readFileSync(join(out, 'assets', js)))).toBe(true);
  const font = assetNames().find((f) => f.endsWith('.woff2'))!;
  expect((await c.send('GET', `/assets/${font}`)).headers['content-type']).toBe('font/woff2');
  const notice = await c.send('GET', '/licenses/Inter-OFL.txt');
  expect(notice.status).toBe(200);
  expect(notice.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(notice.raw.equals(readFileSync('node_modules/@fontsource/inter/LICENSE'))).toBe(true);
  // SPA fallback, traversal, Host and method guards.
  expect((await c.send('GET', '/some/client/path')).raw.equals(index.raw)).toBe(true);
  expect((await c.send('GET', '/licenses/%2e%2e/%2e%2e/package.json')).status).toBe(404);
  expect((await c.send('GET', '/assets/missing.js')).status).toBe(404);
  const misdirected = await c.send('GET', '/', { host: `localhost:${config.port}` });
  expect(misdirected.status).toBe(421);
  expect((await c.send('POST', '/', { body: {} })).status).toBe(405);
  expect((await c.send('GET', '/api/state', { host: `localhost:${config.port}` })).status).toBe(421);
}

describe('shipped font notices (actual client build)', () => {
  const manifest = JSON.parse(readFileSync('src/client/public/licenses/fonts.json', 'utf8')) as {
    fonts: { family: string; package: string; version: string; license: string; integrity: string; notice: { path: string; source: string; sha256: string }; files: { path: string; sha256: string }[] }[];
  };

  it('pins the installed, lockfile-resolved packages, their verbatim notices and every font file by hash', () => {
    const lock = readFileSync('pnpm-lock.yaml', 'utf8');
    expect(manifest.fonts.map((f) => `${f.package}@${f.version}`)).toEqual(['@fontsource/inter@5.3.0']);
    for (const f of manifest.fonts) {
      const pkg = JSON.parse(readFileSync(`node_modules/${f.package}/package.json`, 'utf8'));
      expect([pkg.version, pkg.license]).toEqual([f.version, 'OFL-1.1']);
      expect(lock).toContain(`'${f.package}@${f.version}':\n    resolution: {integrity: ${f.integrity}}`);
      const packaged = readFileSync(f.notice.source);
      expect(sha256(packaged)).toBe(f.notice.sha256);
      expect(readFileSync(`src/client/public/licenses/${f.notice.path}`).equals(packaged)).toBe(true);
      for (const file of f.files) {
        expect(file.path.startsWith(`node_modules/${f.package}/files/`)).toBe(true);
        expect(sha256(readFileSync(file.path))).toBe(file.sha256);
      }
    }
    // Relative paths only: no machine path or account identifier in the shipped manifest.
    const text = readFileSync('src/client/public/licenses/fonts.json', 'utf8');
    expect(text).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it('emits exactly the pinned font files and the verbatim notices into the distributed client', () => {
    const emitted = assetNames().filter((f) => /\.woff2?$/.test(f));
    const pinned = manifest.fonts.flatMap((f) => f.files);
    expect(emitted).toHaveLength(pinned.length);
    const unmatched = new Set(pinned.map((p) => p.path));
    for (const name of emitted) {
      const hash = sha256(readFileSync(join(out, 'assets', name)));
      const entry = pinned.find((p) => p.sha256 === hash && name.startsWith(basename(p.path).replace(/\.woff2?$/, '') + '-') && name.endsWith(p.path.slice(p.path.lastIndexOf('.'))));
      expect(entry, name).toBeDefined();
      unmatched.delete(entry!.path);
    }
    expect([...unmatched]).toEqual([]);
    for (const f of manifest.fonts) expect(readFileSync(join(out, 'licenses', f.notice.path)).equals(readFileSync(f.notice.source))).toBe(true);
    expect(readFileSync(join(out, 'licenses', 'fonts.json')).equals(readFileSync('src/client/public/licenses/fonts.json'))).toBe(true);
    // The packaged copyright lines survive (not stripped as if they were owner data).
    expect(readFileSync(join(out, 'licenses', 'Inter-OFL.txt'), 'utf8')).toMatch(/^Copyright 2016 The Inter Project Authors \(https:\/\/github\.com\/rsms\/inter\)/);
    expect(readFileSync(join(out, 'licenses', 'SpaceGrotesk-OFL.txt'), 'utf8')).toMatch(/^Copyright 2020 The Space Grotesk Project Authors \(https:\/\/github\.com\/floriankarsten\/space-grotesk\)/);
    expect(readFileSync(join(out, 'licenses', 'SpaceGrotesk-OFL.txt'), 'utf8')).toMatch(/This Font Software is licensed under the SIL Open Font License, Version 1\.1/);
    // The retired serif's notice is no longer shipped.
    expect(existsSync(join(out, 'licenses', 'SourceSerif4-OFL.txt'))).toBe(false);
  });

  it('self-hosts fonts (no remote URL or import) and links the notices from the shipped client', () => {
    const css = assetNames().filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!.replace(/["']/g, ''));
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u.startsWith('/assets/') || u.startsWith('data:')).toBe(true);
    expect(css).not.toMatch(/@import|https?:\/\//);
    const js = assetNames().filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
    expect(js).toContain('/licenses/Inter-OFL.txt');
    expect(js).not.toContain('/licenses/SpaceGrotesk-OFL.txt');
    expect(js).not.toContain('SourceSerif4');
    // The owner chose real Inter weights, including Bold and ExtraBold.
    for (const w of [400, 500, 600, 700, 800]) expect(css).toMatch(new RegExp(`font-family:\\s*["']?Inter["']?[^}]*font-weight:\\s*${w}`));
    expect(css).not.toMatch(/font-family:\s*["']?Space Grotesk/);
    expect(css).not.toMatch(/Source Serif/);
  });
});

describe('ordinary boot through the canonical server', () => {
  it.each(['disabled', 'synthetic'] as const)('%s serves the real client and API with no credential, SDK or provider access', async (mode) => {
    const external = watchExternal();
    const config = { ...loadConfig([`--mode=${mode}`], { WINTR_PORT: String(await freePort()) }), syntheticDelayMs: 0 };
    const server = createWintrServer(config, createLocalApi(config), { clientRoot: out });
    servers.push(closer(server));
    await listen(server, config);
    const c = client(config);
    await expectCanonicalShell(c, config);
    expect((await c.send('GET', '/api/state')).json.mode).toBe(mode);
    const cookie = (await c.send('POST', '/api/session', { body: {} })).cookie!;
    const ref = await c.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: c.key() }, cookie });
    if (mode === 'disabled') {
      // Whatever the browser sends, disabled refuses before any provider.
      expect([ref.status, ref.json.error]).toEqual([503, 'providers_disabled']);
      const spoof = await c.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: c.key(), mode: 'live' }, cookie });
      expect(spoof.status).toBeGreaterThanOrEqual(400);
    } else {
      expect(ref.status).toBe(200);
      expect(ref.json.analysis.synthetic).toBe(true);
    }
    expect(external()).toEqual({ fetch: 0, dns: [], sdk: 0 });
  });

  it('keeps the ordinary entry unable to start live, on the one shared server implementation', () => {
    expect(() => loadConfig(['--mode=live'], {})).toThrow(/Live mode is unavailable/);
    expect(() => loadConfig([], { WINTR_MODE: 'live' })).toThrow(/Live mode is unavailable/);
    const entry = readFileSync('src/server/index.ts', 'utf8');
    expect(entry).not.toMatch(/from '\.\/live-runtime|import\('(?!vite')|composeLiveRuntime|startLiveServer/);
    expect([...entry.matchAll(/from '(\.[^']+)'/g)].map((m) => m[1])).toEqual(['./config.js', './http-server.js', './local-app.js']);
    expect(entry).toMatch(/createWintrServer\(config, api/);
    // Canonical request routing/static serving remain singular; the access bootstrap has its own restrictive CSP.
    const src = readdirSync('src/server').filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join('src/server', f), 'utf8')] as const);
    expect(src.filter(([, s]) => /\.on\('request'/.test(s)).map(([f]) => f)).toEqual(['http-server.ts']);
    expect(src.filter(([, s]) => /frame-ancestors 'none'/.test(s)).map(([f]) => f)).toEqual(['http-server.ts', 'judge-access.ts']);
    expect(src.filter(([, s]) => /\.listen\(/.test(s)).map(([f]) => f)).toEqual(['http-server.ts']);
  });
});

describe('controller-only live start seam (synthetic composition)', () => {
  async function composed(o: { loader?: LoaderOptions; clock?: () => number; config?: Config } = {}) {
    const config = o.config ?? loadConfig([], { WINTR_PORT: String(await freePort()) });
    const db = new FakeFirestoreServer();
    const t = transports();
    const l = loaders(db, o.loader);
    const runtime = await composeLiveRuntime({ config, bindings: binding(), loaders: l.loaders, network: t.network, clock: o.clock });
    return { config, runtime, t, calls: l.calls };
  }

  it('serves the real client and the same-origin live API with the existing guards', async () => {
    const external = watchExternal();
    const { config, runtime, t } = await composed();
    expect(runtime.ok).toBe(true);
    const started = await startLiveServer(runtime, { clientRoot: out });
    if (!started.ok) throw new Error(started.problems.join());
    servers.push(started);
    expect(started.origin).toBe(config.origin);
    const c = client(config);
    await expectCanonicalShell(c, config);
    expect((await c.send('GET', '/api/state')).json.mode).toBe('live');
    const cookie = (await c.send('POST', '/api/session', { body: {} })).cookie!;
    expect((await c.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: c.key() }, cookie, origin: 'http://127.0.0.1:1' })).status).toBe(403);
    const refused = await c.send('POST', '/api/reference', { body: { url: `https://youtu.be/${NOT_APPROVED}`, actionKey: c.key() }, cookie });
    expect([refused.status, refused.json.error]).toEqual([422, 'unsupported_source']);
    expect(t.reference).toHaveLength(0);
    const ref = await c.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: c.key() }, cookie });
    expect(ref.status).toBe(200);
    expect(ref.json.analysis.synthetic).toBe(false);
    expect(t.reference).toHaveLength(1);
    // Only the fake transports carried provider traffic; no real network, DNS or SDK.
    expect(external()).toEqual({ fetch: 0, dns: [], sdk: 0 });
  });

  it('serves its own frozen config snapshot even if the caller mutates the base config during a loader', async () => {
    const config = { ...loadConfig([], { WINTR_PORT: String(await freePort()) }) };
    const original = { ...config };
    const other = await freePort();
    const { runtime } = await composed({
      config,
      loader: {
        onSecret: (n) => {
          if (n !== 1) return;
          const m = config as { -readonly [K in keyof Config]: Config[K] };
          m.port = other;
          m.hostHeader = `127.0.0.1:${other}`;
          m.origin = `http://127.0.0.1:${other}`;
        },
      },
    });
    if (!runtime.ok) throw new Error(runtime.problems.join());
    expect([runtime.config.port, runtime.config.origin, runtime.config.mode]).toEqual([original.port, original.origin, 'live']);
    expect(Object.isFrozen(runtime.config) && Object.isFrozen(runtime.config.freeMutation)).toBe(true);
    const started = await startLiveServer(runtime, { clientRoot: out });
    if (!started.ok) throw new Error(started.problems.join());
    servers.push(started);
    expect((started.server.address() as AddressInfo).port).toBe(original.port);
    expect((await client(original).send('GET', '/api/state')).json.mode).toBe('live');
    expect((await client(original).send('POST', '/api/session', { body: {}, origin: `http://127.0.0.1:${other}` })).status).toBe(403);
  });

  it('refuses spoofed, copied, failed and unbound runtimes before listening', async () => {
    const { runtime, config } = await composed();
    if (!runtime.ok) throw new Error(runtime.problems.join());
    const failed = await composeLiveRuntime({ config, bindings: { ...binding(), serviceId: '' }, loaders: loaders(new FakeFirestoreServer()).loaders });
    expect(failed.ok).toBe(false);
    for (const candidate of [{ ...runtime }, failed, null, undefined, 'live', { ok: true, handler: runtime.handler, store: runtime.store, config, validUntil: Infinity }]) {
      expect(await startLiveServer(candidate, { clientRoot: out })).toEqual({ ok: false, problems: ['runtime:not_composed'] });
    }
    expect(await portOpen(config.port)).toBe(false);
  });

  it.each(['sequential', 'concurrent'] as const)('refuses a %s duplicate start without revoking the serving runtime', async (mode) => {
    const { runtime, config } = await composed();
    if (!runtime.ok) throw new Error(runtime.problems.join());
    const first = startLiveServer(runtime, { clientRoot: out });
    const second = mode === 'concurrent' ? startLiveServer(runtime, { clientRoot: out }) : undefined;
    const started = await first;
    if (!started.ok) throw new Error(started.problems.join());
    servers.push(started);
    const duplicate = await (second ?? startLiveServer(runtime, { clientRoot: out }));
    // The healthy handler and Store must stay usable even when another caller
    // tries to start the same exact capability again.
    expect((await client(config).send('GET', '/api/state')).status).toBe(200);
    expect((await client(config).send('POST', '/api/session', { body: {} })).status).toBe(201);
    expect(duplicate).toEqual({ ok: false, problems: ['runtime:already_started'] });
  });

  it('permanently revokes an expired runtime before listening', async () => {
    const clock = { t: Date.now() };
    const { runtime, config } = await composed({ clock: () => clock.t });
    if (!runtime.ok) throw new Error(runtime.problems.join());
    clock.t = runtime.validUntil;
    expect(await startLiveServer(runtime, { clientRoot: out })).toEqual({ ok: false, problems: ['expiresAt:expired'] });
    expect(await portOpen(config.port)).toBe(false);
    clock.t = runtime.validUntil - 25;
    expect(await startLiveServer(runtime, { clientRoot: out })).toEqual({ ok: false, problems: ['runtime:closed'] });
  });

  it('refuses an invalid clock before listening without reviving that runtime', async () => {
    const clock = { t: Date.now() };
    const { runtime, config } = await composed({ clock: () => clock.t });
    if (!runtime.ok) throw new Error(runtime.problems.join());
    clock.t = Number.NaN;
    expect(await startLiveServer(runtime, { clientRoot: out })).toEqual({ ok: false, problems: ['clock:invalid'] });
    expect(await portOpen(config.port)).toBe(false);
    clock.t = runtime.validUntil - 25;
    expect(await startLiveServer(runtime, { clientRoot: out })).toEqual({ ok: false, problems: ['runtime:closed'] });
  });

  it('closes a running current runtime when its validity ends', async () => {
    const clock = { t: Date.now() };
    const { runtime, config } = await composed({ clock: () => clock.t });
    if (!runtime.ok) throw new Error(runtime.problems.join());
    clock.t = runtime.validUntil - 25;
    const started = await startLiveServer(runtime, { clientRoot: out });
    if (!started.ok) throw new Error(started.problems.join());
    servers.push(started);
    expect(await portOpen(config.port)).toBe(true);
    const closed = new Promise<void>((r) => started.server.once('close', () => r()));
    clock.t = runtime.validUntil;
    await closed;
    expect(await portOpen(config.port)).toBe(false);
  });
});

function portOpen(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), r(true)));
    s.once('error', () => r(false));
  });
}
