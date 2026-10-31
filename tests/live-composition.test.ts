import dns from 'node:dns';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import type { ApiHandler } from '../src/server/app.js';
import { loadConfig, type Config } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { createHash } from 'node:crypto';
import { encodePcmWav, RECORDING } from '../src/shared/recording.js';
import { sha256 } from '../src/server/ids.js';
import {
  composeLiveRuntime,
  createKeylessFirestoreFactory,
  createOfficialFirestoreFactory,
  gatedTransport,
  liveStoreRefusal,
} from '../src/server/live-runtime.js';
import { createLocalApi } from '../src/server/local-app.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import type { ProviderRequest } from '../src/server/providers/http.js';
import { MemoryStore } from '../src/server/store.js';
import { AID, VID, type AppleEntry } from './fixtures/catalogue-fixtures.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { APPROVED, BEARER, binding, HOUR, json, loaders, NOT_APPROVED, policy, SECRETS, transports, type LoaderOptions } from './fixtures/live-fixtures.js';

// The actual live composition (composeLiveRuntime -> createApiHandler with the
// genuine reference, Qloo, catalogue and verifier adapters, the shared
// FirestoreStore and the durable sealer), exercised over an SDK-shaped fake
// database and synthetic transports/loaders that count every call. Every
// value is invented. Synthetic composition evidence only: no real provider,
// credential, Firestore or source was used, and live mode remains inactive.

const sdk = vi.hoisted(() => ({ loads: 0, constructed: [] as unknown[] }));
vi.mock('@google-cloud/firestore', () => {
  sdk.loads += 1;
  class Firestore {
    constructor(settings: unknown) {
      sdk.constructed.push(settings);
    }
  }
  return { Firestore };
});


// ---------------------------------------------------------------------------
// HTTP over whichever composed handler is current (instances can be swapped).

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  vi.restoreAllMocks();
});

async function http() {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: 'disabled' });
  let current: ApiHandler | null = null;
  server.on('request', (req: IncomingMessage, res: ServerResponse) => void current!(req, res));
  const bodies: string[] = [];
  const send = (method: string, path: string, x: { body?: unknown; cookie?: string } = {}) =>
    new Promise<{ status: number; body: any; cookie?: string }>((resolve, reject) => {
      const payload = x.body === undefined ? undefined : JSON.stringify(x.body);
      const headers: Record<string, string> = { host: config.hostHeader };
      if (method !== 'GET') headers.origin = config.origin;
      if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
      if (x.cookie) headers.cookie = x.cookie;
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          bodies.push(data);
          resolve({ status: res.statusCode!, body: data && String(res.headers['content-type']).startsWith('application/json') ? JSON.parse(data) : data, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  let n = 0;
  const key = () => `live-compose-key-${String(++n).padStart(6, '0')}`;
  return { config, send, key, bodies, use: (h: ApiHandler) => (current = h) };
}

async function compose(config: Config, db: FakeFirestoreServer, t: ReturnType<typeof transports>, o: { bindings?: unknown; loader?: LoaderOptions; clock?: () => number } = {}) {
  const l = loaders(db, o.loader);
  const runtime = await composeLiveRuntime({ config, bindings: o.bindings ?? binding(), loaders: l.loaders, network: t.network, clock: o.clock });
  return { runtime, calls: l.calls };
}

describe('live binding schema, reconciled with the adapters and store', () => {
  it('accepts a complete current binding with the default or a named database', () => {
    expect(validateLiveBindings(binding(), Date.now()).ok).toBe(true);
    const named = binding({ firestore: { ...binding().firestore, databaseId: 'wintr-live-db' } });
    expect(validateLiveBindings(named, Date.now())).toMatchObject({ ok: true, bindings: { firestore: { databaseId: 'wintr-live-db' } } });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['empty string', { serviceId: '' }, 'serviceId:empty'],
    ['missing field', { qloo: undefined }, 'qloo:missing'],
    ['extra field', { debugEndpoint: true }, 'binding:extra'],
    ['test-only profile', { profile: 'test' }, 'profile:not_live'],
    ['test-only service', { serviceId: 'svc-test-live' }, 'serviceId:test_only'],
    ['expired binding', { expiresAt: Date.now() - 1 }, 'expiresAt:expired'],
    ['expired source policy', { sourcePolicy: { version: 'sources-invented-1', expiresAt: Date.now() - 1, videoIds: [APPROVED] } }, 'sourcePolicy:expired'],
    ['expired exposure policy', { exposurePolicy: policy(Date.now() - 1) }, 'exposurePolicy:expired'],
    ['blanket source approval', { sourcePolicy: { version: 'sources-invented-1', expiresAt: Date.now() + HOUR, videoIds: ['*'] } }, 'sourcePolicy:video_id'],
    ['empty source set', { sourcePolicy: { version: 'sources-invented-1', expiresAt: Date.now() + HOUR, videoIds: [] } }, 'sourcePolicy:empty'],
    ['mismatched reference model', { reference: { model: 'another-model', credentialRef: 'secrets/invented-reference-key' } }, 'reference.model:mismatch'],
    ['mismatched session lifetime', { limits: { ...binding().limits, sessionLifetimeMs: 2 * HOUR } }, 'limits.sessionLifetimeMs:mismatch'],
    ['shared credential reference', { qloo: { host: 'hackathon.api.qloo.com', credentialRef: 'secrets/invented-reference-key' } }, 'credentials:not_distinct'],
    ['unapproved Qloo host', { qloo: { host: 'example.invalid', credentialRef: 'secrets/invented-qloo-key' } }, 'qloo.host:invalid'],
    ['missing TTL collection', { firestore: { ...binding().firestore, ownedTtl: { collections: ['wintr_owned'], field: 'expireAt' } } }, 'firestore.ownedTtl.collections:mismatch'],
    ['wrong reconciliation index', { firestore: { ...binding().firestore, reconciliationIndex: { collection: 'wintr_ledger_reservations', fields: ['state'] } } }, 'firestore.reconciliationIndex.fields:mismatch'],
    ['invalid database id', { firestore: { ...binding().firestore, databaseId: 'Not_A_Db' } }, 'firestore.databaseId:invalid'],
  ])('refuses a binding with %s (safe code, no values)', (_name, change, code) => {
    const raw = Object.fromEntries(Object.entries(binding(change)).filter(([, v]) => v !== undefined));
    const v = validateLiveBindings(raw, Date.now());
    expect(v.ok).toBe(false);
    const problems = (v as { problems: string[] }).problems;
    expect(problems).toContain(code);
    expect(JSON.stringify(problems)).not.toMatch(/invented-|secrets\/|example\.invalid|another-model/);
  });
});

describe('composeLiveRuntime: the actual application path over synthetic transports', () => {
  it.each([false, true])('preserves only current server self-service capability through actual composition (%s)', async selfService => {
    const h = await http(), db = new FakeFirestoreServer(), t = transports();
    let now = Date.now();
    const raw = binding(), expiresAt = now + HOUR;
    const sourcePolicy = { ...raw.sourcePolicy, expiresAt, ...(selfService ? { processing: { kind: 'user_directed_music', permissionVersion: 'invented-input-approval',
      youtube: true, recorded: true, deniedVideoIds: [], deniedRecordedDigests: [] } } : {}) };
    const c = await compose(h.config, db, t, { bindings: { ...raw, sourcePolicy }, clock: () => now });
    expect(c.runtime.ok).toBe(true); if (!c.runtime.ok) return;
    h.use(c.runtime.handler);
    expect((await h.send('GET', '/api/state')).body.recordingSelfService).toBe(selfService ? true : undefined);
    now = expiresAt;
    expect((await h.send('GET', '/api/state')).body.recordingSelfService).toBeUndefined();
    expect(t.reference).toHaveLength(0); expect(t.qloo).toHaveLength(0); expect(t.cat.calls).toHaveLength(0);
  });

  it.each(['youtube', 'recorded'] as const)('reference -> Qloo -> recordings -> follow refinement, reconstructing the runtime between requests (stable sealing, %s)', async kind => {
    const h = await http();
    const db = new FakeFirestoreServer();
    const t = transports();
    const audio = encodePcmWav(new Float32Array(RECORDING.minFrames));
    const digest = createHash('sha256').update(audio).digest('hex');
    const raw = binding();
    const bindings = kind === 'recorded' ? { ...raw, sourcePolicy: { ...raw.sourcePolicy, recordedDigests: [digest] } } : raw;
    const instance = async () => {
      const c = await compose(h.config, db, t, { bindings });
      if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
      expect(liveStoreRefusal(c.runtime.store)).toBeNull();
      h.use(c.runtime.handler);
      return c;
    };

    const first = await instance();
    // Credentials and identity are loaded through the controller's loaders only; the SDK factory gets explicit settings.
    expect(first.calls.secret.sort()).toEqual(['secrets/invented-qloo-key', 'secrets/invented-reference-key', 'secrets/invented-sealing-key']);
    expect(first.calls.firestore).toEqual([{ projectId: 'invented-store-project', databaseId: '(default)' }]);
    const cookie = (await h.send('POST', '/api/session', { body: {} })).cookie!;
    expect((await h.send('GET', '/api/state', { cookie })).body.mode).toBe('live');

    // Ineligible source: honest recovery, no admission, no count, no transport call.
    const refused = await h.send('POST', '/api/reference', { body: { url: `https://youtu.be/${NOT_APPROVED}`, actionKey: h.key() }, cookie });
    expect([refused.status, refused.body.error]).toEqual([422, 'unsupported_source']);
    expect(t.reference).toHaveLength(0);
    expect(db.entries('wintr_ledger_reservations')).toEqual([]);

    // Eligible source on a reconstructed instance: one genuine reference request with the reference key only.
    await instance();
    const registration = kind === 'recorded'
      ? await h.send('POST', '/api/capture', { body: { sha256: digest, frames: RECORDING.minFrames, actionKey: h.key() }, cookie }) : null;
    if (registration) { expect(registration.status).toBe(201); expect(t.reference).toHaveLength(0); await instance(); }
    const input = registration
      ? { receipt: registration.body.captureReceipt.receipt, audio: Buffer.from(audio).toString('base64'), actionKey: h.key() }
      : { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() };
    const referencePath = registration ? '/api/recording-reference' : '/api/reference';
    const ref = await h.send('POST', referencePath, { body: input, cookie });
    expect(ref.status).toBe(200);
    expect(ref.body.analysis.synthetic).toBe(false);
    expect(t.reference).toHaveLength(1);
    expect(t.reference[0]!.headers['x-goog-api-key']).toBe(SECRETS['secrets/invented-reference-key']);
    expect(t.reference[0]!.url.pathname).toBe('/v1beta/models/gemini-3.6-flash:generateContent');
    expect(JSON.parse(t.reference[0]!.body!).contents).toEqual(expect.anything());
    if (registration) {
      const media = JSON.parse(t.reference[0]!.body!).contents[0].parts[0];
      expect(media).toEqual({ inlineData: { mimeType: 'audio/wav', data: Buffer.from(audio).toString('base64') } });
      expect(ref.body.reference).toEqual({ kind: 'recorded', receipt: input.receipt, durationMs: 5000 });
      // A lost acknowledgement can be reconciled/replayed on another instance without another audio dispatch.
      await instance();
      expect((await h.send('POST', referencePath, { body: input, cookie })).status).toBe(200);
      expect(t.reference).toHaveLength(1);
      expect(JSON.stringify(db.entries())).not.toContain(Buffer.from(audio).toString('base64'));
    }

    await instance();
    const saved = await h.send('POST', '/api/preference', {
      body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist', 'Other Artist'], actionKey: h.key(), expectedBrief: null },
      cookie,
    });
    await instance();
    const disc = await h.send('POST', '/api/discover', { body: { brief: saved.body.brief.handle, actionKey: h.key() }, cookie });
    expect(disc.status).toBe(200);
    const snap = disc.body as SafeSnapshot;
    expect(snap.panel!.choices.map((c) => c.title)).toEqual(['Invented Song 1', 'Invented Song 2', 'Invented Song 3']);
    expect(t.qloo).toHaveLength(4);
    expect(t.qloo.every((r) => r.headers['x-api-key'] === SECRETS['secrets/invented-qloo-key'] && r.url.host === 'hackathon.api.qloo.com')).toBe(true);
    expect(t.cat.calls).toHaveLength(1);
    const cat = t.cat.calls[0]!;
    expect(cat.headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(cat.headers['x-goog-user-project']).toBe('invented-quota-proj');
    expect(cat.url.pathname).toContain('/projects/invented-catalogue-proj/locations/global/');
    expect(t.net.requests.length).toBeGreaterThanOrEqual(3);

    // Follow refinement on yet another reconstructed instance: sealed identities from earlier instances still verify.
    await instance();
    const song2 = snap.panel!.choices.find((c) => c.title === 'Invented Song 2')!.handle as Handle;
    expect((await h.send('POST', '/api/feedback', { body: { panel: snap.panel!.handle, choice: song2, fit: 'like', familiarity: null, expectedRevision: 0, actionKey: h.key() }, cookie })).status).toBe(200);
    const fourth = await instance();
    const r = await h.send('POST', '/api/refine', { body: { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice: song2, actionKey: h.key() }, cookie });
    expect(r.status).toBe(200);
    expect(r.body.panel.choices.map((c: { title: string }) => c.title)).toEqual(['Fresh Song 1']);
    expect(t.qloo).toHaveLength(5);
    expect(t.cat.calls).toHaveLength(2);
    expect((await h.send('POST', '/api/refine', { body: { mode: 'correct_direction', panel: r.body.panel.handle, brief: r.body.brief.handle, actionKey: h.key() }, cookie })).body.error).toBe('refinement_used');

    // Shared accounting: stage-specific, all held as unknown without a receipt; 5 Qloo / 3 Gemini.
    await new Promise((x) => setTimeout(x, 30));
    const ledger = fourth.runtime.ok ? fourth.runtime.store.reconciliation() : null;
    const unresolved = await ledger!.unresolved(50);
    expect(unresolved).toHaveLength(8);
    expect(unresolved.every((u) => u.state === 'unknown' && u.settlement === null)).toBe(true);
    expect((await ledger!.totals())!.counts).toEqual({ qloo: 5, gemini: 3 });
    if (registration) {
      const beforeClear = await ledger!.totals();
      expect((await h.send('DELETE', '/api/session', { cookie })).status).toBe(200);
      const cleared = (await h.send('GET', '/api/state', { cookie })).body;
      expect(cleared.session).toBeNull(); expect(cleared.reference).toBeNull(); expect(cleared.panel).toBeNull();
      expect(await ledger!.totals()).toEqual(beforeClear);
    }
    for (const body of h.bodies) expect(body).not.toMatch(/invented-reference-api-key|invented-qloo-api-key|invented-sealing-key|invented-bearer|invented-store-project|invented-quota-proj|svc-invented-live|40000000-/);
  });

  it('a different sealing key cannot rehydrate earlier sealed identities (refused before any provider call)', async () => {
    const h = await http();
    const db = new FakeFirestoreServer();
    const t = transports();
    const a = await compose(h.config, db, t);
    h.use((a.runtime as { handler: ApiHandler }).handler);
    const cookie = (await h.send('POST', '/api/session', { body: {} })).cookie!;
    const ref = await h.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie });
    const saved = await h.send('POST', '/api/preference', { body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist'], actionKey: h.key(), expectedBrief: null }, cookie });
    const snap = (await h.send('POST', '/api/discover', { body: { brief: saved.body.brief.handle, actionKey: h.key() }, cookie })).body as SafeSnapshot;
    const song = snap.panel!.choices[0]!.handle;
    await h.send('POST', '/api/feedback', { body: { panel: snap.panel!.handle, choice: song, fit: 'like', familiarity: null, expectedRevision: 0, actionKey: h.key() }, cookie });

    const other = await compose(h.config, db, t, { bindings: binding({ sealing: { keyRef: 'secrets/invented-sealing-key-2' } }) });
    h.use((other.runtime as { handler: ApiHandler }).handler);
    const qloo = t.qloo.length;
    const refused = await h.send('POST', '/api/refine', { body: { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice: song, actionKey: h.key() }, cookie });
    expect(refused.status).toBe(409);
    expect(t.qloo.length).toBe(qloo);
    expect((await h.send('GET', '/api/state', { cookie })).body.refinement).toEqual({ used: false });
  });

  it('refuses incomplete/expired/mismatched bindings and a synthetic base before calling any loader or SDK factory', async () => {
    const db = new FakeFirestoreServer();
    const t = transports();
    const disabled = loadConfig([], { WINTR_MODE: 'disabled' });
    for (const bad of [binding({ expiresAt: Date.now() - 1 }), binding({ catalogue: undefined }), binding({ reference: { model: 'another-model', credentialRef: 'secrets/invented-reference-key' } })]) {
      const c = await compose(disabled, db, t, { bindings: JSON.parse(JSON.stringify(bad)) });
      expect(c.runtime.ok).toBe(false);
      expect(c.calls).toEqual({ secret: [], token: 0, firestore: [] });
    }
    const outlives = binding({ exposurePolicy: policy(Date.now() + 3 * HOUR) });
    expect((await compose(disabled, db, t, { bindings: outlives })).runtime).toEqual({ ok: false, problems: ['exposurePolicy:outlives_binding'] });
    const synthetic = await compose(loadConfig([], { WINTR_MODE: 'synthetic' }), db, t);
    expect(synthetic.runtime).toEqual({ ok: false, problems: ['config:not_disabled_base'] });
    expect(synthetic.calls).toEqual({ secret: [], token: 0, firestore: [] });
    expect(sdk.loads).toBe(0);
  });

  it.each<[string, Parameters<typeof loaders>[1], string]>([
    ['a missing Qloo credential', { failSecret: 'secrets/invented-qloo-key' }, 'credential:qloo_unavailable'],
    ['a missing reference credential', { failSecret: 'secrets/invented-reference-key' }, 'credential:reference_unavailable'],
    ['a missing sealing key', { failSecret: 'secrets/invented-sealing-key' }, 'credential:sealing_unavailable'],
    ['a missing catalogue identity', { failIdentity: true }, 'credential:catalogue_identity_unavailable'],
  ])('fails closed on %s: no store, no transport, safe codes only', async (_name, loader, code) => {
    const db = new FakeFirestoreServer();
    const t = transports();
    const c = await compose(loadConfig([], { WINTR_MODE: 'disabled' }), db, t, { loader });
    expect(c.runtime.ok).toBe(false);
    expect((c.runtime as { readonly problems: readonly string[] }).problems).toContain(code);
    expect(JSON.stringify(c.runtime)).not.toMatch(/invented-|secrets\/|runtime-invented/);
    expect(c.calls.firestore).toEqual([]);
    expect([t.reference.length, t.qloo.length, t.cat.calls.length]).toEqual([0, 0, 0]);
    expect(db.entries('')).toEqual([]);
  });
});

describe('ordinary disabled/synthetic boot and the official SDK factory', () => {
  it('disabled and synthetic CLI composition call no loader, SDK or network; the CLI cannot compose live', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dnsSpy = vi.spyOn(dns.promises, 'lookup');
    const h = await http();
    for (const mode of ['disabled', 'synthetic'] as const) {
      h.use(createLocalApi({ ...h.config, mode, syntheticDelayMs: 0 }));
      const cookie = (await h.send('POST', '/api/session', { body: {} })).cookie!;
      const ref = await h.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie });
      expect(ref.status).toBe(mode === 'disabled' ? 503 : 200);
      if (mode === 'synthetic') expect(ref.body.analysis.synthetic).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dnsSpy).not.toHaveBeenCalled();
    expect(sdk.loads).toBe(0);
    expect(() => createLocalApi({ ...h.config, mode: 'live' })).toThrow(/explicit controller binding/);
  });

  it('the official factory imports the SDK only when invoked, with explicit project, database and credentials', async () => {
    let credentialLoads = 0;
    const factory = createOfficialFirestoreFactory(async () => {
      credentialLoads += 1;
      return { client_email: 'runtime@invented.invalid', private_key: 'invented-private-key-material' };
    });
    expect(sdk.loads).toBe(0);
    expect(credentialLoads).toBe(0);
    await factory({ projectId: 'invented-store-project', databaseId: 'wintr-live-db' });
    expect(credentialLoads).toBe(1);
    expect(sdk.constructed).toEqual([
      { projectId: 'invented-store-project', databaseId: 'wintr-live-db', credentials: { client_email: 'runtime@invented.invalid', private_key: 'invented-private-key-material' } },
    ]);
    const bad = createOfficialFirestoreFactory(async () => ({ client_email: '', private_key: '' }));
    await expect(bad({ projectId: 'invented-store-project', databaseId: '(default)' })).rejects.toThrow('firestore credentials unavailable');
    expect(sdk.constructed).toHaveLength(1);
  });

  it('only a composed FirestoreStore satisfies the live store check, never a kind string', async () => {
    const lookalike = { kind: 'firestore-shared' } as unknown as FirestoreStore;
    expect(liveStoreRefusal(lookalike)).toMatch(/shared transactional Firestore/);
    expect(liveStoreRefusal(new MemoryStore({ maxSessions: 1, maxJourneysPerSession: 1 }))).toMatch(/shared transactional Firestore/);
    const handBuilt = new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(new FakeFirestoreServer())), serviceId: 'svc-invented-live', policy: policy(Date.now() + HOUR), clock: Date.now, maxSessions: 1, maxJourneysPerSession: 1 });
    expect(liveStoreRefusal(handBuilt)).toMatch(/not composed/);
  });
});

/** Fake SDK client that runs `onIntent` when a transaction decides a durable dispatch intent (before it commits). */
class IntentHook extends FakeFirestore {
  constructor(
    server: FakeFirestoreServer,
    private readonly onIntent: () => void,
  ) {
    super(server);
  }
  override runTransaction<T>(fn: Parameters<FakeFirestore['runTransaction']>[0], opts?: { maxAttempts?: number }): Promise<T> {
    return super.runTransaction(async (tx) => {
      const out = await fn(tx);
      const writes = (tx as unknown as { writes: { path: string; data?: { state?: unknown } }[] }).writes;
      if (writes.some((w) => w.path.startsWith('wintr_ledger_reservations/') && w.data?.state === 'intent')) this.onIntent();
      return out as T;
    }, opts);
  }
}

describe('authority at the provider transport boundary (after asynchronous credential preparation)', () => {
  /** Composed API path: reference, free preference, three Qloo calls and a catalogue attempt that returns 503. */
  async function catalogueRun(lapse: boolean) {
    const h = await http();
    const db = new FakeFirestoreServer();
    const t = transports({ catalogue503: true });
    const clock = { t: Date.now() };
    const t0 = clock.t;
    const c = await compose(h.config, db, t, {
      bindings: binding({ exposurePolicy: policy(t0 + 1000) }),
      clock: () => clock.t,
      // The second token load is the catalogue request's own (the first is the composition preflight).
      loader: { onToken: (n) => void (lapse && n === 2 && (clock.t = t0 + 1001)) },
    });
    if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
    h.use(c.runtime.handler);
    const cookie = (await h.send('POST', '/api/session', { body: {} })).cookie!;
    const ref = await h.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie });
    const saved = await h.send('POST', '/api/preference', { body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist'], actionKey: h.key(), expectedBrief: null }, cookie });
    const disc = await h.send('POST', '/api/discover', { body: { brief: saved.body.brief.handle, actionKey: h.key() }, cookie });
    await new Promise((x) => setTimeout(x, 30));
    return { t, c, disc, store: c.runtime.store };
  }

  it('control: a current policy sends the catalogue request once (the fake answers 503)', async () => {
    const { t, c, disc } = await catalogueRun(false);
    expect([t.reference.length, t.qloo.length, t.cat.calls.length]).toEqual([1, 3, 1]);
    expect(c.calls.token).toBe(2);
    expect(disc.body.attempt).toMatchObject({ kind: 'discover', outcome: 'failed' });
  });

  it('policy expiring during the catalogue token fetch never reaches the catalogue transport; the intent stays held', async () => {
    const { t, c, disc, store } = await catalogueRun(true);
    expect([t.reference.length, t.qloo.length, t.cat.calls.length]).toEqual([1, 3, 0]);
    expect(c.calls.token).toBe(2);
    expect(disc.body.attempt).toMatchObject({ kind: 'discover', outcome: 'failed' });
    const held = (await store.reconciliation().unresolved(50)).filter((r) => r.stage === 'catalogue_generation');
    // Durable intent existed, so it is held as unknown with its reservation: never refunded, never retried.
    expect(held).toEqual([expect.objectContaining({ state: 'unknown', units: 500, settlement: null })]);
  });

  it('source-policy expiry after admission keeps the reference request off its transport (control sends once)', async () => {
    for (const lapse of [false, true]) {
      const h = await http();
      const db = new FakeFirestoreServer();
      const t = transports();
      const clock = { t: Date.now() };
      const t0 = clock.t;
      const c = await compose(h.config, db, t, {
        bindings: binding({ sourcePolicy: { version: 'sources-invented-1', expiresAt: t0 + 1000, videoIds: [APPROVED] } }),
        clock: () => clock.t,
        loader: { client: (server) => new IntentHook(server, () => void (lapse && (clock.t = t0 + 1001))) },
      });
      if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
      h.use(c.runtime.handler);
      const cookie = (await h.send('POST', '/api/session', { body: {} })).cookie!;
      const ref = await h.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie });
      await new Promise((x) => setTimeout(x, 30));
      expect(t.reference).toHaveLength(lapse ? 0 : 1);
      expect(ref.body.attempt).toMatchObject({ kind: 'reference', outcome: lapse ? 'failed' : 'succeeded' });
      const [held] = await c.runtime.store.reconciliation().unresolved(10);
      expect(held).toMatchObject({ stage: 'reference_analysis', state: 'unknown' });
    }
  });

  it('the gate is checked synchronously at sending time: valid passes once, expired or unusable clocks never call the transport', async () => {
    let inner = 0;
    const clock = { t: 999 };
    const gate = gatedTransport(async () => (inner++, json(200, {})), 'gemini', 1000, () => clock.t);
    const req = {} as ProviderRequest;
    await gate(req);
    for (const t of [1000, 1001, Number.NaN, -1, 1.5]) {
      clock.t = t;
      await expect(gate(req)).rejects.toMatchObject({ provider: 'gemini', kind: 'config' });
    }
    expect(inner).toBe(1);
  });
});

describe('composition authority snapshot and refresh', () => {
  const disabled = () => loadConfig([], { WINTR_PORT: '8787', WINTR_MODE: 'disabled' });

  it('the store receives exactly the approved immutable policy snapshot, even if the caller mutates it during a load', async () => {
    for (const mutate of [false, true]) {
      const db = new FakeFirestoreServer();
      const clock = { t: Date.now() };
      const t0 = clock.t;
      const approvedExpiry = t0 + 30 * 60_000;
      const raw = binding({ exposurePolicy: policy(approvedExpiry) }) as Record<string, any>;
      const c = await compose(disabled(), db, transports(), {
        bindings: raw,
        clock: () => clock.t,
        loader: { onSecret: (n) => void (mutate && n === 1 && (raw.exposurePolicy.expiresAt = raw.expiresAt + HOUR)) },
      });
      if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
      const { bindings, store } = c.runtime;
      expect(bindings.exposurePolicy.expiresAt).toBe(approvedExpiry);
      expect(Object.isFrozen(bindings) && Object.isFrozen(bindings.exposurePolicy) && Object.isFrozen(bindings.exposurePolicySnapshot)).toBe(true);
      expect(() => ((bindings.exposurePolicy as { expiresAt: number }).expiresAt = 1)).toThrow(TypeError);
      raw.exposurePolicy.expiresAt = 1;
      expect(bindings.exposurePolicy.expiresAt).toBe(approvedExpiry);

      // Effective store policy: a submission is admitted just before the approved expiry and refused at it.
      clock.t = approvedExpiry - 10_000;
      const created = (await store.createSession(clock.t)) as { session: { id: Handle } };
      const owner = { sessionId: created.session.id, epoch: 1 };
      const a = (await store.admitReference({ ...owner, now: clock.t, reference: { videoId: APPROVED, canonicalUrl: `https://www.youtube.com/watch?v=${APPROVED}`, focus: { start: 0, end: 30 } }, listenerCue: null, actionKeyHash: sha256('k'), inputHash: sha256('i') })) as { attempt: { id: Handle } };
      expect(await store.reserveSubmission(owner, a.attempt.id, 'reference_analysis', clock.t)).toMatchObject({ ok: true, validUntil: approvedExpiry });
      clock.t = approvedExpiry;
      expect(await store.reserveSubmission(owner, a.attempt.id, 'reference_analysis', clock.t)).toEqual({ ok: false, code: 'unavailable' });
    }
  });

  it('a binding that expires (or a clock that becomes unusable) during preparation stops composing; nothing later is loaded or built', async () => {
    const t0 = Date.now();
    const short = () => binding({ expiresAt: t0 + 500, exposurePolicy: policy(t0 + 500), sourcePolicy: { version: 'sources-invented-1', expiresAt: t0 + 500, videoIds: [APPROVED] } });
    const run = async (loader: (clock: { t: number }) => LoaderOptions) => {
      const clock = { t: t0 };
      return compose(disabled(), new FakeFirestoreServer(), transports(), { bindings: short(), clock: () => clock.t, loader: loader(clock) });
    };
    const control = await run(() => ({}));
    expect(control.runtime.ok).toBe(true);
    expect([control.calls.secret.length, control.calls.token, control.calls.firestore.length]).toEqual([3, 1, 1]);

    const expired = await run((clock) => ({ onSecret: (n) => void (n === 1 && (clock.t = t0 + 501)) }));
    expect(expired.runtime).toEqual({ ok: false, problems: ['expiresAt:expired'] });
    expect([expired.calls.secret.length, expired.calls.token, expired.calls.firestore.length]).toEqual([1, 0, 0]);

    const badClock = await run((clock) => ({ onSecret: (n) => void (n === 1 && (clock.t = Number.NaN)) }));
    expect(badClock.runtime).toEqual({ ok: false, problems: ['clock:invalid'] });
    expect([badClock.calls.secret.length, badClock.calls.token, badClock.calls.firestore.length]).toEqual([1, 0, 0]);

    const duringStore = await run((clock) => ({ onFirestore: () => void (clock.t = t0 + 501) }));
    expect(duringStore.runtime).toEqual({ ok: false, problems: ['expiresAt:expired'] });
    expect(duringStore.calls.firestore).toHaveLength(1);
  });

  it.each<[string, Partial<Config>, string]>([
    ['a different loopback Origin port', { origin: 'http://127.0.0.1:9999' }, 'config:origin_mismatch'],
    ['a mismatched Host header', { hostHeader: '127.0.0.1:9999' }, 'config:host_mismatch'],
    ['a non-integer port', { port: 8787.5 }, 'config:port_invalid'],
    ['a Secure cookie on plain loopback http', { secureCookie: true }, 'config:cookie_mismatch'],
    ['dev middleware', { dev: true }, 'config:dev_mode'],
    ['a non-loopback host', { host: '0.0.0.0' }, 'config:not_loopback'],
  ])('refuses a base config with %s before any loader', async (_name, change, code) => {
    const c = await compose({ ...disabled(), ...change }, new FakeFirestoreServer(), transports());
    expect(c.runtime).toEqual({ ok: false, problems: [code] });
    expect(c.calls).toEqual({ secret: [], token: 0, firestore: [] });
    expect((await compose(disabled(), new FakeFirestoreServer(), transports())).runtime.ok).toBe(true);
  });

  it.each(['XTS', 'XXX'])('refuses the reserved %s currency in a live binding before any loader (pure ledger tests keep XTS)', async (currency) => {
    const raw = binding({ exposurePolicy: policy(Date.now() + HOUR, currency) });
    expect(validateLiveBindings(raw, Date.now())).toEqual({ ok: false, problems: ['exposurePolicy.currency:test_currency'] });
    const c = await compose(disabled(), new FakeFirestoreServer(), transports(), { bindings: raw });
    expect(c.runtime.ok).toBe(false);
    expect(c.calls).toEqual({ secret: [], token: 0, firestore: [] });
  });
});

describe('keyless Firestore constructor seam (injected short-lived Google auth client)', () => {
  const shortLived = (expiresAt: number) => {
    const client = new OAuth2Client();
    client.setCredentials({ access_token: 'invented-short-lived-access-token', expiry_date: expiresAt });
    return client;
  };

  it('constructs the SDK with exactly the explicit project, database and injected authClient; never uses it to fetch', async () => {
    const t = Date.now();
    const client = shortLived(t + HOUR);
    const headers = vi.spyOn(client, 'getRequestHeaders');
    const before = sdk.constructed.length;
    const factory = createKeylessFirestoreFactory(async () => ({ client, expiresAt: t + HOUR }), () => t);
    expect(sdk.constructed.length).toBe(before);
    await factory({ projectId: 'invented-store-project', databaseId: 'wintr-live-db' });
    const settings = sdk.constructed.at(-1) as Record<string, unknown>;
    expect(sdk.constructed.length).toBe(before + 1);
    expect(Object.keys(settings).sort()).toEqual(['authClient', 'databaseId', 'projectId']);
    expect(settings).toMatchObject({ projectId: 'invented-store-project', databaseId: 'wintr-live-db' });
    expect(settings.authClient).toBe(client);
    expect(headers).not.toHaveBeenCalled();
  });

  it('refuses an expired, malformed or unusable-clock identity without constructing anything', async () => {
    const t = Date.now();
    const before = sdk.constructed.length;
    const settings = { projectId: 'invented-store-project', databaseId: '(default)' };
    await expect(createKeylessFirestoreFactory(async () => ({ client: shortLived(t + HOUR), expiresAt: t }), () => t)(settings)).rejects.toThrow('firestore identity expired');
    await expect(createKeylessFirestoreFactory(async () => ({ client: shortLived(t + HOUR), expiresAt: Number.NaN }), () => t)(settings)).rejects.toThrow('firestore identity expired');
    await expect(createKeylessFirestoreFactory(async () => ({ client: shortLived(t + HOUR), expiresAt: t + HOUR }), () => Number.NaN)(settings)).rejects.toThrow('firestore identity expired');
    await expect(createKeylessFirestoreFactory(async () => ({ client: {} as OAuth2Client, expiresAt: t + HOUR }), () => t)(settings)).rejects.toThrow('firestore identity unavailable');
    expect(sdk.constructed.length).toBe(before);
  });

  it('the official GoogleAuth uses an injected authClient and explicit project with no discovery or network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dnsSpy = vi.spyOn(dns.promises, 'lookup');
    const client = shortLived(Date.now() + HOUR);
    const auth = new GoogleAuth({ projectId: 'invented-store-project', authClient: client });
    expect(await auth.getClient()).toBe(client);
    expect(await auth.getProjectId()).toBe('invented-store-project');
    const h = (await auth.getRequestHeaders()) as unknown as Headers | Record<string, string>;
    expect(h instanceof Headers ? h.get('authorization') : h.Authorization).toBe('Bearer invented-short-lived-access-token');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dnsSpy).not.toHaveBeenCalled();
  });

  it('pins the verified pass-through in the installed SDK: Firestore settings -> google-gax GrpcClient -> GoogleAuth(authClient)', () => {
    const fsMain = createRequire(import.meta.url).resolve('@google-cloud/firestore');
    const fsIndex = readFileSync(fsMain, 'utf8');
    expect(JSON.parse(readFileSync(join(dirname(fsMain), '..', '..', 'package.json'), 'utf8')).version).toBe('9.3.1');
    expect(fsIndex).toMatch(/const settings = \{\s*\.\.\.this\._settings,/);
    expect(fsIndex).toContain('new v1Client(settings, gax)');
    const gaxMain = createRequire(fsMain).resolve('google-gax');
    expect(JSON.parse(readFileSync(join(dirname(gaxMain), '..', '..', 'package.json'), 'utf8')).version).toBe('6.13.0');
    expect(readFileSync(join(dirname(gaxMain), 'grpc.js'), 'utf8')).toContain('this.auth = options.auth || new google_auth_library_1.GoogleAuth(options);');
    const authMain = createRequire(gaxMain).resolve('google-auth-library');
    expect(JSON.parse(readFileSync(join(dirname(authMain), '..', '..', 'package.json'), 'utf8')).version).toBe('11.3.1');
    expect(readFileSync(join(dirname(authMain), 'auth', 'googleauth.js'), 'utf8')).toContain('this.cachedCredential = opts.authClient || null;');
  });
});

describe('recording-service capability in the composed runtime (synthetic transports)', () => {
  const APPLE_CHOICES = [
    { title: 'Invented Song 1', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: '', listen: `https://music.apple.com/us/song/invented-song/${AID(1)}` },
    { title: 'Invented Song 2', artists: ['Neighbour X12'], anchor: 'Neighbour X12', videoId: VID(2) },
  ];
  const APPLE: Record<string, AppleEntry> = { [AID(1)]: { trackName: 'Invented Song 1', artistName: 'Neighbour X11' } };

  async function discover(bindings: unknown) {
    const h = await http();
    const db = new FakeFirestoreServer();
    const t = transports({ initial: APPLE_CHOICES, apple: APPLE });
    const c = await compose(h.config, db, t, { bindings });
    if (!c.runtime.ok) throw new Error(c.runtime.problems.join(','));
    h.use(c.runtime.handler);
    const cookie = (await h.send('POST', '/api/session', { body: {} })).cookie!;
    const ref = await h.send('POST', '/api/reference', { body: { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie });
    const saved = await h.send('POST', '/api/preference', {
      body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist', 'Other Artist'], actionKey: h.key(), expectedBrief: null },
      cookie,
    });
    const disc = await h.send('POST', '/api/discover', { body: { brief: saved.body.brief.handle, actionKey: h.key() }, cookie });
    // A fresh read decodes the persisted Firestore records through the strict schemas.
    const state = (await h.send('GET', '/api/state', { cookie })).body as SafeSnapshot;
    return { disc: disc.body as SafeSnapshot, state, t };
  }

  it('a binding without recordingServices stays YouTube-only and never contacts the Apple lookup host', async () => {
    const { disc, t } = await discover(binding());
    expect(disc.panel!.choices.map((c) => [c.title, c.service])).toEqual([['Invented Song 2', 'youtube']]);
    expect(disc.panel!.gaps).toEqual([{ reason: 'unsupported_destination', count: 1 }]);
    expect(t.net.requests.some((r) => r.url.hostname === 'itunes.apple.com')).toBe(false);
  });

  it('an explicit binding enables verified Apple destinations, persisted and re-read through the strict schemas', async () => {
    const { disc, state, t } = await discover(binding({ recordingServices: ['youtube', 'apple_music'] }));
    expect(disc.panel!.choices.map((c) => [c.title, c.service, c.playUrl])).toEqual([
      ['Invented Song 1', 'apple_music', `https://music.apple.com/us/song/${AID(1)}`],
      ['Invented Song 2', 'youtube', `https://www.youtube.com/watch?v=${VID(2)}`],
    ]);
    expect(state.panel!.choices.map((c) => c.service)).toEqual(['apple_music', 'youtube']);
    const lookups = t.net.requests.filter((r) => r.url.hostname === 'itunes.apple.com');
    expect(lookups.map((r) => r.url.href)).toEqual([`https://itunes.apple.com/lookup?id=${AID(1)}&country=us&entity=song`]);
    expect(lookups[0]!.headers).not.toHaveProperty('authorization');
  });
});
