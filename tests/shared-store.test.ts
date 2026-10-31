import { createHttpFixture } from './fixtures/http-lifecycle.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultTreeAdapter as p5tree, parse as parse5, type DefaultTreeAdapterTypes as P5 } from 'parse5';
import { afterEach, describe, expect, it } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { createApiHandler } from '../src/server/app.js';
import { sanitizeStoredSuggestions, sanitizeSuggestions, SUGGESTIONS_CSP, suggestionsDocument } from '../src/server/catalogue-format.js';
import { ConfigError, loadConfig } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { runReferenceStage } from '../src/server/harness.js';
import { sha256 } from '../src/server/ids.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { liveStoreRefusal } from '../src/server/live-runtime.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createSourceResolver } from '../src/server/source-resolver.js';
import { createFirestoreDocStore, firestoreDocSize, MAX_CONTENT_DOC_BYTES, MAX_DOC_BYTES, type DocData } from '../src/server/persistence/docstore.js';
import { decodeOwned, encodeOwned, ownedPath } from '../src/server/persistence/owned.js';
import { createGeminiCatalogueAdapter } from '../src/server/providers/gemini-catalogue.js';
import type { ProviderRequest, ProviderResponse } from '../src/server/providers/http.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createSyntheticReferenceAdapter, type ReferenceAdapter } from '../src/server/reference.js';
import { createRecordSealer } from '../src/server/seal.js';
import { MemoryStore, type Owner } from '../src/server/store.js';
import { createYouTubeVerifier } from '../src/server/verifier.js';
import { catalogueTransport, envelope, fakeNetwork, VID, type FixtureChoice, type MetaEntry } from './fixtures/catalogue-fixtures.js';
import { FakeFirestore, FakeFirestoreServer, FakeTimestamp } from './fixtures/fake-firestore.js';

// F2: the shared transactional Store over the real Firestore document adapter
// and SDK-shaped shared fake. Pipeline tests construct a NEW store, SDK client
// and API handler for every HTTP request over one shared fake database, and
// drive the genuine Qloo client, catalogue adapter, parser and verifier over
// fake envelopes. All names, IDs, prices and sources are invented. Nothing
// here is hosted Firestore, emulator, provider or listener acceptance.

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const SERVICE = 'svc-synthetic-shared';
const KEY = 'synthetic-qloo-test-key-0003';
const TOKEN = 'invented-access-token-0003';
const SEAL_KEY = 'synthetic-seal-key-for-tests-only-000003';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const policy = (expiresAt: number, o: Record<string, unknown> = {}) => ({
  version: 'synthetic-policy-1',
  currency: 'XTS',
  expiresAt,
  service: { capUnits: 1_000_000, concurrency: 8, counts: { qloo: 600, gemini: 400 } },
  session: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
  journey: { capUnits: 100_000, counts: { qloo: 6, gemini: 4 } },
  reservations: {
    reference_analysis: { units: 300, bound: 'estimate_with_residual' },
    qloo_search: { units: 10, bound: 'enforceable' },
    qloo_artist_insights: { units: 11, bound: 'enforceable' },
    qloo_tag_insights: { units: 12, bound: 'enforceable' },
    catalogue_generation: { units: 500, bound: 'estimate_with_residual' },
  },
  ...o,
});

interface StoreOpts {
  clock?: () => number;
  policy?: unknown;
  freeMutation?: { perSession: number; perService: number; windowMs: number };
  maxSessions?: number;
  maxAttempts?: number;
}
/** A separate store + SDK client "instance" (process) over the shared fake database. */
const storeOn = (db: FakeFirestoreServer, o: StoreOpts = {}) =>
  new FirestoreStore({
    docs: createFirestoreDocStore(new FakeFirestore(db), o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}),
    serviceId: SERVICE,
    policy: 'policy' in o ? o.policy : policy(T0 + 10 * HOUR),
    clock: o.clock ?? Date.now,
    maxSessions: o.maxSessions ?? 50,
    maxJourneysPerSession: 3,
    freeMutation: o.freeMutation,
  });

const until = async (f: () => Promise<boolean> | boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

// ---------------------------------------------------------------------------
// Invented Qloo/catalogue fixtures (as in the checkpoint E suite).

const uid = (n: number) => `30000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const artist = (n: number, name: string) => ({ entity_id: uid(n), name, subtype: 'urn:entity:artist' });
const SEED = artist(1, 'Generic Artist');
const SECOND = artist(2, 'Other Artist');
const POOL_X = [artist(11, 'Neighbour X11'), artist(12, 'Neighbour X12'), artist(13, 'Neighbour X13')];
const POOL_F = [artist(11, 'Neighbour X11'), artist(31, 'Neighbour F31'), artist(32, 'Neighbour F32')];
const TAGS = [{ tag_id: 'urn:tag:genre:music:invented_warmth', name: 'Invented warmth', subtype: 'urn:tag:genre:music' }];
const json = (status: number, value: unknown): ProviderResponse => ({ status, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(value)) });
const kind = (req: ProviderRequest) => (req.url.pathname === '/search' ? 'search' : req.url.searchParams.get('filter.type') === 'urn:tag' ? 'tags' : 'artists');
const entities = (req: ProviderRequest) => (req.url.searchParams.get('signal.interests.entities') ?? '').split(',').filter(Boolean);
const qlooRespond = async (req: ProviderRequest): Promise<ProviderResponse> => {
  if (req.url.pathname === '/search') {
    const q = (req.url.searchParams.get('query') ?? '').toLowerCase();
    const results = q === 'generic artist' ? [SEED] : q === 'other artist' ? [SECOND] : null;
    return results ? json(200, { results }) : json(404, {});
  }
  if (req.url.searchParams.get('filter.type') === 'urn:tag') return json(200, { success: true, results: { tags: TAGS } });
  const follow = entities(req).some((e) => [uid(11), uid(12), uid(13)].includes(e));
  return json(200, { success: true, results: { entities: follow ? POOL_F : POOL_X } });
};
const metaFor = (anchor: string, title: string, decoration = ' (Official Audio)') => ({ title: `${anchor} - ${title}${decoration}`, author_name: anchor });
const THREE: FixtureChoice[] = POOL_X.map((a, i) => ({ title: `Invented Song ${i + 1}`, artists: [a.name], anchor: a.name, videoId: VID(i + 1) }));
const META: Record<string, MetaEntry> = {
  ...Object.fromEntries(THREE.map((c) => [c.videoId, metaFor(c.anchor, c.title)])),
  [VID(31)]: metaFor('Neighbour F31', 'Fresh Song 1'),
  [VID(32)]: { title: 'Neighbour F32 & Neighbour X12 - Shared Song', author_name: 'Neighbour F32' },
  [VID(41)]: metaFor('Neighbour X11', 'Invented Song 1', ' (Official Video)'),
  [VID(43)]: metaFor('Neighbour X13', 'Other Song'),
  [VID(44)]: metaFor('Neighbour X11', 'Warm Song'),
};
const FOLLOW = envelope([
  { title: 'Fresh Song 1', artists: ['Neighbour F31'], anchor: 'Neighbour F31', videoId: VID(31) },
  { title: 'Invented Song 1', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(41) },
  { title: 'Shared Song', artists: ['Neighbour F32', 'Neighbour X12'], anchor: 'Neighbour F32', videoId: VID(32) },
]);
const CORRECTION = envelope([
  { title: 'Other Song', artists: ['Neighbour X13'], anchor: 'Neighbour X13', videoId: VID(43) },
  { title: 'Warm Song', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(44) },
]);

const fixtureHttp = createHttpFixture();
const request = fixtureHttp.request;
const servers: Server[] = [];
afterEach(async () => {
  await fixtureHttp.close(servers.splice(0));
});

interface PipelineOptions {
  db?: FakeFirestoreServer;
  catalogue?: (i: number) => ProviderResponse | Promise<ProviderResponse>;
  reference?: ReferenceAdapter;
  store?: StoreOpts;
}

/** HTTP API whose every request is served by a freshly constructed store, SDK client and handler. */
async function pipeline(o: PipelineOptions = {}) {
  const db = o.db ?? new FakeFirestoreServer();
  const pol = policy(Date.now() + 10 * HOUR);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: 'synthetic' });
  const calls: ProviderRequest[] = [];
  const cat = catalogueTransport(() => (o.catalogue ?? ((i: number) => (i === 0 ? envelope(THREE) : FOLLOW)))(cat.calls.length - 1));
  const net = fakeNetwork(META);
  const sealer = createRecordSealer(new ServerSecret(SEAL_KEY));
  let instances = 0;
  const fresh = () => {
    instances += 1;
    return createApiHandler({ shutdown: fixtureHttp.shutdown(),
      config,
      store: storeOn(db, { policy: pol, ...o.store }),
      referenceAdapter: o.reference ?? createSyntheticReferenceAdapter(0),
      discovery: {
        qloo: createQlooClient({
          transport: async (req) => {
            calls.push(req);
            return qlooRespond(req);
          },
          apiKey: new ServerSecret(KEY),
          host: 'hackathon.api.qloo.com',
        }),
        qlooSynthetic: false,
        catalogue: createNativeCatalogue({
          adapter: createGeminiCatalogueAdapter({ transport: cat.transport, project: 'invented-project', quotaProject: 'invented-quota', accessToken: async () => new ServerSecret(TOKEN) }),
          verifier: createYouTubeVerifier({ resolve: net.resolve, http: net.http, now: Date.now }),
          sources: createSourceResolver({ resolve: net.resolve, http: net.http, now: Date.now }),
        }),
        sealer,
      },
    });
  };
  server.on('request', (req: IncomingMessage, res: ServerResponse) => void fresh()(req, res));

  const snapshots: string[] = [];
  const send = (method: string, path: string, x: { body?: unknown; cookie?: string } = {}) =>
    fixtureHttp.observe(new Promise<{ status: number; body: any; setCookie?: string; headers: IncomingMessage['headers'] }>((resolve, reject) => {
      const payload = x.body === undefined ? undefined : JSON.stringify(x.body);
      const headers: Record<string, string> = { host: config.hostHeader };
      if (method !== 'GET') headers.origin = config.origin;
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      if (x.cookie) headers.cookie = x.cookie;
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        res.on('error', reject);
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          snapshots.push(data);
          const isJson = String(res.headers['content-type'] ?? '').startsWith('application/json');
          resolve({ status: res.statusCode!, body: data && isJson ? JSON.parse(data) : data || null, setCookie: res.headers['set-cookie']?.[0], headers: res.headers });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    }));
  let n = 0;
  const key = () => `shared-action-key-${String(++n).padStart(6, '0')}`;
  const newSession = async () => (await send('POST', '/api/session', { body: {} })).setCookie!.split(';')[0]!;
  const state = async (cookie: string) => (await send('GET', '/api/state', { cookie })).body as SafeSnapshot;
  const initial = async () => {
    const cookie = await newSession();
    const ref = await send('POST', '/api/reference', { body: { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: key() }, cookie });
    if (!ref.body?.analysis) throw new Error(`reference failed: ${ref.status} ${JSON.stringify(ref.body).slice(0, 400)}`);
    const saved = await send('POST', '/api/preference', {
      body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist', 'Other Artist'], actionKey: key(), expectedBrief: null },
      cookie,
    });
    const r = await send('POST', '/api/discover', { body: { brief: saved.body.brief.handle, actionKey: key() }, cookie });
    return { cookie, snap: r.body as SafeSnapshot };
  };
  const feedback = (cookie: string, panel: Handle, choice: Handle, fit: string | null, familiarity: string | null, expectedRevision = 0) =>
    send('POST', '/api/feedback', { body: { panel, choice, fit, familiarity, expectedRevision, actionKey: key() }, cookie });
  const refine = (cookie: string, body: Record<string, unknown>) => send('POST', '/api/refine', { body: { actionKey: key(), ...body }, cookie });
  /** Controller-only reconciliation view from yet another instance. */
  const ledger = () => storeOn(db, { policy: pol }).reconciliation();
  /** Waits until every invoked submission has been accounted (no reservation left in 'intent'). */
  const settled = () =>
    until(async () => (await ledger().unresolved(100)).every((r) => r.state !== 'intent')).catch(async (e) => {
      throw new Error(`${e}: ${JSON.stringify((await ledger().unresolved(100)).map((r) => [r.stage, r.state]))} conflicts=${db.conflicts}`);
    });
  return { db, send, state, key, newSession, initial, feedback, refine, calls, cat, net, snapshots, ledger, settled, pol, instances: () => instances };
}

const choiceBy = (snap: SafeSnapshot, title: string) => snap.panel!.choices.find((c) => c.title === title)!;
const byStage = (rs: { stage: string }[]) => rs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.stage]: (m[r.stage] ?? 0) + 1 }), {});
const noLeaks = (snapshots: string[]) => {
  for (const s of snapshots) {
    expect(s).not.toMatch(UUID_RE);
    expect(s).not.toMatch(/entityId|entity_id|"seal"|fingerprint|recordingKey|x-api-key|secretHash|r_[0-9a-f]{48}|wintr_ledger/i);
    for (const secret of [KEY, TOKEN, SEAL_KEY, 'invented-project', 'invented-quota', SERVICE]) expect(s).not.toContain(secret);
  }
};
const roots = (db: FakeFirestoreServer) =>
  db.entries('wintr_owned/session_').map(([, d]) => ({ sessionId: d.sessionId as Handle, epoch: d.epoch as number, body: d.body as Record<string, unknown> }));

// ---------------------------------------------------------------------------

describe('stored envelope and clock validation (codec used as Store authority)', () => {
  const owner = { sessionId: 'session-handle-00000001', epoch: 1 };
  const good = encodeOwned('journey', owner, T0 + HOUR, { id: 'x' });

  it('accepts a well-formed current envelope', () => {
    expect(decodeOwned(good, 'journey', owner, T0)).toEqual({ id: 'x' });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, '9999999999999', null, 2 ** 60])('refuses stored expiresAt %s', (expiresAt) => {
    expect(decodeOwned({ ...good, expiresAt } as unknown as DocData, 'journey', owner, T0)).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])('refuses a non-finite or unsafe current clock %s', (now) => {
    expect(decodeOwned(good, 'journey', owner, now)).toBeNull();
  });

  it('refuses mismatched TTL, epoch, kind, owner, extra or missing fields and a non-object body', () => {
    const bad: DocData[] = [
      { ...good, expireAt: new Date(T0 + HOUR + 1) },
      { ...good, expireAt: new Date(Number.NaN) },
      { ...good, epoch: Number.NaN },
      { ...good, epoch: 0 },
      { ...good, extra: 1 },
      Object.fromEntries(Object.entries(good).filter(([k]) => k !== 'expireAt')),
      { ...good, body: ['x'] },
      { ...good, sessionId: 'short' },
    ];
    for (const d of bad) expect(decodeOwned(d, 'journey', owner, T0)).toBeNull();
    expect(decodeOwned(good, 'brief', owner, T0)).toBeNull();
    expect(decodeOwned(good, 'journey', { ...owner, epoch: 2 }, T0)).toBeNull();
    expect(decodeOwned(good, 'journey', owner, T0 + HOUR)).toBeNull();
  });

  it('a stored NaN expiry or non-finite authority field fails closed in the Store', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const store = storeOn(db, { clock: () => clock.t });
    const created = (await store.createSession(T0)) as { session: { id: Handle; epoch: number }; secret: string };
    const owner: Owner = { sessionId: created.session.id, epoch: 1 };
    const admitted = await store.admitReference({ ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('k1'), inputHash: sha256('i1') });
    expect(admitted.kind).toBe('admitted');
    const attemptId = (admitted as { attempt: { id: Handle } }).attempt.id;

    // Non-finite deadline inside a stored record: every authority path refuses instead of treating `now >= NaN` as false.
    const path = `wintr_owned/attempt_${attemptId}`;
    const stored = db.entries(path)[0]![1];
    db.seed(path, { ...stored, body: { ...(stored.body as object), deadlineAt: Number.NaN } } as DocData);
    expect(await store.reserveSubmission(owner, attemptId, 'reference_analysis', T0)).toEqual({ ok: false, code: 'unavailable' });
    expect(await store.commitAnalysis(owner.sessionId, 1, attemptId, ANALYSIS, T0)).toBe(false);
    await expect(store.read(owner.sessionId, 1, T0)).rejects.toThrow('store unavailable');

    // Non-finite session expiry on the root: the session simply does not exist.
    const rootPath = `wintr_owned/session_${owner.sessionId}`;
    const root = db.entries(rootPath)[0]![1];
    db.seed(rootPath, { ...root, expiresAt: Number.POSITIVE_INFINITY, expireAt: new FakeTimestamp(Number.POSITIVE_INFINITY) } as unknown as DocData);
    expect(await store.findSessionBySecret(created.secret, T0)).toBeNull();
    expect(await store.read(owner.sessionId, 1, T0)).toBeNull();
    expect((await store.admitReference({ ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('k2'), inputHash: sha256('i2') })).kind).toBe('rejected');
  });

  it('persists the closed provider-service failure codes, keeps legacy codes readable and refuses any other stored failure value', async () => {
    const db = new FakeFirestoreServer();
    const store = storeOn(db, { clock: () => T0 });
    const created = (await store.createSession(T0)) as { session: { id: Handle; epoch: number } };
    const owner: Owner = { sessionId: created.session.id, epoch: 1 };
    const admitted = await store.admitReference({ ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('k1'), inputHash: sha256('i1') });
    const attemptId = (admitted as { attempt: { id: Handle } }).attempt.id;
    expect(await store.settleAttempt(owner.sessionId, 1, attemptId, 'failed', 'provider_limited', T0)).toBe(true);
    // Another instance reads exactly the closed code back (restoration).
    expect((await storeOn(db, { clock: () => T0 }).read(owner.sessionId, 1, T0))!.attempt).toMatchObject({ outcome: 'failed', failure: 'provider_limited' });

    const path = `wintr_owned/attempt_${attemptId}`;
    const stored = db.entries(path)[0]![1];
    const withFailure = (failure: unknown) => db.seed(path, { ...stored, body: { ...(stored.body as object), failure } } as DocData);
    for (const ok of ['provider_unavailable', 'adapter_failed', 'qloo_failed', 'catalogue_failed', 'deadline', null]) {
      withFailure(ok);
      expect((await store.read(owner.sessionId, 1, T0))!.attempt!.failure).toBe(ok);
    }
    for (const bad of ['provider_limited_429', 'HTTP 429 Too Many Requests', 'quota_exhausted', 'PROVIDER_LIMITED', 'provider_limited ', '', 429, { message: 'x' }]) {
      withFailure(bad);
      await expect(store.read(owner.sessionId, 1, T0)).rejects.toThrow('store unavailable');
    }
  });
});

const REF = { videoId: 'dQw4w9WgXcQ', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', focus: { start: 0, end: 30 } };
const ANALYSIS = { audioAccess: 'synthetic_not_accessed' as const, synthetic: true, observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null };

describe('shared pipeline over a reconstructed store per request (real adapter fake pipeline)', () => {
  it('retains returned tag subtype across fresh stores, keeps legacy absence unknown and refuses malformed extensions', async () => {
    const app = await pipeline();
    await app.initial();
    const { sessionId, epoch } = roots(app.db)[0]!;
    const read = () => storeOn(app.db, { policy: app.pol }).read(sessionId, epoch, Date.now());
    const state = (await read())!;
    expect(state.pool!.tags[0]).toMatchObject({ tagId: TAGS[0]!.tag_id, name: TAGS[0]!.name, subtype: TAGS[0]!.subtype });
    const poolPath = `wintr_owned/pool_${state.pool!.id}`;
    const saved = app.db.entries(poolPath)[0]![1];
    const body = saved.body as Record<string, unknown>;
    const tags = body.tags as Record<string, unknown>[];
    try {
      app.db.seed(poolPath, { ...saved, body: { ...body, tags: tags.map(({ subtype: _subtype, ...legacy }) => legacy) } } as DocData);
      expect(Object.hasOwn((await read())!.pool!.tags[0]!, 'subtype')).toBe(false);
      for (const subtype of [42, {}, '', 'not-a-tag-identity', 'urn:tag:' + 'x'.repeat(181)]) {
        app.db.seed(poolPath, { ...saved, body: { ...body, tags: tags.map(t => ({ ...t, subtype })) } } as DocData);
        await expect(read()).rejects.toThrow('store unavailable');
      }
      app.db.seed(poolPath, { ...saved, body: { ...body, tags: tags.map(t => ({ ...t, subtype: null })) } } as DocData);
      expect((await read())!.pool!.tags[0]!.subtype).toBeNull();
    } finally { app.db.seed(poolPath, saved); }
  });

  it('initial + follow: stage-specific held submissions, changed Qloo seeds, a different recording and persisted free feedback', async () => {
    const app = await pipeline();
    const { cookie, snap } = await app.initial();
    expect(snap.panel!.choices.map((c) => c.title)).toEqual(['Invented Song 1', 'Invented Song 2', 'Invented Song 3']);
    await app.settled();
    const initial = await app.ledger().unresolved(100);
    expect(byStage(initial)).toEqual({ reference_analysis: 1, qloo_search: 2, qloo_artist_insights: 1, qloo_tag_insights: 1, catalogue_generation: 1 });
    // A provider return without a validated known-cost receipt stays held as unknown; nothing is settled at zero.
    expect(initial.every((r) => r.state === 'unknown' && r.unknownReason === 'transport_returned_without_receipt' && r.settlement === null)).toBe(true);
    expect((await app.ledger().totals())!.counts).toEqual({ qloo: 4, gemini: 2 });
    expect(entities(app.calls.find((c) => kind(c) === 'artists')!).sort()).toEqual([uid(1), uid(2)].sort());

    const song2 = choiceBy(snap, 'Invented Song 2').handle;
    expect((await app.feedback(cookie, snap.panel!.handle, song2, 'like', 'known')).status).toBe(200);
    const qBefore = app.calls.length;
    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice: song2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stage: 'complete', refinement: { used: true }, attempt: { kind: 'refine', outcome: 'succeeded' } });
    const added = app.calls.slice(qBefore);
    expect(added.map(kind)).toEqual(['artists']);
    expect(entities(added[0]!).sort()).toEqual([uid(1), uid(12)].sort());
    const titles = r.body.panel.choices.map((c: { title: string }) => c.title);
    expect(titles).toEqual(['Fresh Song 1', 'Shared Song']);
    expect(titles.some((t: string) => THREE.some((c) => c.title === t))).toBe(false);
    await app.settled();
    expect((await app.ledger().totals())!.counts).toEqual({ qloo: 5, gemini: 3 });
    expect(byStage(await app.ledger().unresolved(100))).toMatchObject({ qloo_artist_insights: 2, catalogue_generation: 2 });

    // Yet another instance sees the same history and the free feedback on the earlier panel.
    const later = await app.state(cookie);
    expect(later.history).toHaveLength(1);
    expect(later.history[0]!.choices.find((c) => c.title === 'Invented Song 2')!.feedback).toEqual({ fit: 'like', familiarity: 'known', revision: 1 });
    // The single shared allowance is spent across instances.
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: r.body.panel.handle, brief: r.body.brief.handle })).body.error).toBe('refinement_used');
    // session, reference, preference, discover, feedback, refine, state, refine: each on a new store + client.
    expect(app.instances()).toBe(8);

    // Individual bounded documents; no session snapshot document; ledger separate and TTL-free.
    const owned = app.db.entries('wintr_owned/');
    const kinds = new Set(owned.map(([p]) => p.split('/')[1]!.split('_')[0]));
    for (const k of ['session', 'secret', 'journey', 'analysis', 'attempt', 'brief', 'search', 'checkpoint', 'pool', 'plan', 'panel', 'feedback', 'binding', 'freebinding']) {
      expect(kinds.has(k)).toBe(true);
    }
    for (const [p, d] of owned) expect(firestoreDocSize({ collection: 'wintr_owned', id: p.split('/')[1]! }, d)).toBeLessThanOrEqual(MAX_DOC_BYTES);
    expect(app.db.entries('wintr_owned_content/panelcontent_')).toHaveLength(2);
    for (const [, d] of app.db.entries('wintr_ledger_')) expect(d.expireAt).toBeUndefined();
    noLeaks(app.snapshots);
  });

  it('correction: reused pool with ZERO new Qloo calls, one generation, independent "not right" feedback', async () => {
    const app = await pipeline({ catalogue: (i) => (i === 0 ? envelope(THREE) : CORRECTION) });
    const { cookie, snap } = await app.initial();
    for (const c of snap.panel!.choices) expect((await app.feedback(cookie, snap.panel!.handle, c.handle, 'not_right', null)).status).toBe(200);
    const x13 = snap.connection!.anchors.find((a) => a.name === 'Neighbour X13')!.handle;
    const qloo = app.calls.length;
    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle, relationship: { text: 'something warmer' }, excludeArtists: [x13] });
    expect(r.body).toMatchObject({ stage: 'complete', panel: { role: 'refinement', mode: 'correct_direction' } });
    expect(app.calls.length).toBe(qloo);
    expect(app.cat.calls).toHaveLength(2);
    expect(r.body.panel.choices.map((c: { title: string }) => c.title)).toEqual(['Warm Song']);
    await app.settled();
    expect((await app.ledger().totals())!.counts).toEqual({ qloo: 4, gemini: 3 });
    noLeaks(app.snapshots);
  });

  it('two instances racing two refinements of one Journey admit exactly one', async () => {
    const app = await pipeline({ catalogue: (i) => (i === 0 ? envelope(THREE) : CORRECTION) });
    const { cookie, snap } = await app.initial();
    const song2 = choiceBy(snap, 'Invented Song 2').handle;
    await app.feedback(cookie, snap.panel!.handle, song2, 'like', null);
    const results = await Promise.all([
      app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice: song2 }),
      app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle }),
    ]);
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    const loser = results.find((x) => x.status !== 200)!;
    expect(['operation_active', 'refinement_used']).toContain(loser.body.error);
    expect(app.cat.calls).toHaveLength(2);
    await app.settled();
    expect((await app.ledger().totals())!.counts.gemini).toBe(3);
  });

  it('keeps a complete 512 KiB reference output and a ~64 KiB Suggestions unit whole across instances', { timeout: 30_000 }, async () => {
    const line = 'Invented "quoted" line, with ünïcode\n';
    let finalText = '';
    while (Buffer.byteLength(finalText + line) <= 512 * 1024) finalText += line;
    finalText += 'x'.repeat(512 * 1024 - Buffer.byteLength(finalText));
    expect(Buffer.byteLength(finalText)).toBe(512 * 1024);
    const reference: ReferenceAdapter = {
      synthetic: false,
      analyse: async () => ({
        audioAccess: 'accessed',
        observations: ['Invented observation'],
        relationships: ['Invented relationship A', 'Invented relationship B'],
        provider: { model: 'invented-model', finalText, usage: null, uncertainArtistName: null },
      }),
    };
    const chip = (n: number) => `<div class="c"><a class="chip" href="https://www.google.com/search?q=invented+query+${n}&amp;x=1">invented query ${n}</a></div>`;
    let unit = '<style>.c{color:#fff}</style>';
    for (let n = 0; Buffer.byteLength(unit + chip(n)) <= 64 * 1024; n++) unit += chip(n);
    expect(Buffer.byteLength(unit)).toBeGreaterThan(63 * 1024);
    const app = await pipeline({ reference, catalogue: () => envelope(THREE, { rendered: unit }) });
    const { cookie, snap } = await app.initial();
    expect(snap.panel!.suggestionsUrl).toBeTruthy();

    const frame = await app.send('GET', snap.panel!.suggestionsUrl!, { cookie });
    expect(frame.status).toBe(200);
    expect(frame.body).toContain(sanitizeSuggestions(unit));
    const { sessionId, epoch } = roots(app.db)[0]!;
    const bucket = (await storeOn(app.db, { policy: app.pol }).read(sessionId, epoch, Date.now()))!;
    expect(bucket.analysis!.provider!.finalText).toBe(finalText);
    expect(bucket.panel!.suggestionsHtml).toBe(sanitizeSuggestions(unit));
    expect(bucket.panel!.answerText.length).toBeGreaterThan(0);

    // The content units exceed the ordinary record bound, so they live in their own bounded documents.
    const sizes = app.db.entries('wintr_owned_content/').map(([p, d]) => firestoreDocSize({ collection: 'wintr_owned_content', id: p.split('/')[1]! }, d));
    expect(sizes.every((s) => s > MAX_DOC_BYTES && s <= MAX_CONTENT_DOC_BYTES)).toBe(true);
    // Output above the document bound is refused, never truncated.
    expect(() => encodeOwned('panelcontent', { sessionId, epoch }, Date.now() + HOUR, { answerText: 'x'.repeat(MAX_CONTENT_DOC_BYTES) })).toThrow('document too large');
  });

  it('Clear revokes access and the old source across instances; service accounting survives', async () => {
    const app = await pipeline();
    const { cookie, snap } = await app.initial();
    await app.settled();
    const before = await app.ledger().totals();
    expect((await app.send('DELETE', '/api/session', { cookie })).status).toBeLessThan(300);
    const after = await app.state(cookie);
    expect(after.panel).toBeNull();
    expect(after.reference).toBeNull();
    expect((await app.send('GET', snap.panel!.suggestionsUrl!, { cookie })).status).toBe(404);
    expect(app.db.entries('wintr_owned')).toEqual([]);
    expect(await app.ledger().totals()).toEqual(before);
    expect((await app.ledger().unresolved(100)).length).toBe(6);
  });
});

describe('stored Search Suggestions units are rebuilt under the current policy at owned delivery', () => {
  /** Replaces the owned panel's stored unit server-side, as a unit written by an earlier server version would be. */
  const storeUnit = (db: FakeFirestoreServer, html: string) => {
    const docs = db.entries('wintr_owned_content/panelcontent_');
    expect(docs).toHaveLength(1);
    const [path, doc] = docs[0]!;
    db.seed(path, { ...doc, body: { ...(doc.body as object), suggestionsHtml: html } } as DocData);
  };
  /** Every element carrying a destination in the browser model of the served document. */
  const links = (served: string) => {
    const out: string[][] = [];
    const walk = (p: P5.ParentNode) => {
      for (const c of p.childNodes) {
        if (!p5tree.isElementNode(c)) continue;
        if (c.attrs.some((a) => a.name === 'href' || a.name === 'target')) out.push([c.tagName, ...['href', 'target', 'rel'].map((n) => c.attrs.find((a) => a.name === n)?.value ?? '')]);
        walk(c);
      }
    };
    walk(parse5(served, { scriptingEnabled: false }));
    return out;
  };
  const SAFE = ['a', 'https://www.google.com/search?q=ok', '_blank', 'noopener noreferrer'];
  const LEGACY =
    '<style>.c{color:#fff}</style><div class="c">' +
    '<a/href="https://example.invalid/"/target="_blank">Synthetic link</a>' +
    '<A HREF=https://example.invalid/m TARGET=_top>Mixed</A>' +
    '<svg><a href="https://example.invalid/s"><rect width="9" height="9"></rect></a></svg>' +
    '<math href="https://example.invalid/x">x</math>' +
    '<a class="chip" href="https://www.google.com/search?q=ok">ok</a></div>';

  it('a legacy slash/mixed/foreign unit is served only in its current-policy form, with no state, provider or budget effect', async () => {
    const app = await pipeline();
    const { cookie, snap } = await app.initial();
    await app.settled();
    const url = snap.panel!.suggestionsUrl!;
    storeUnit(app.db, LEGACY);
    const before = { owned: JSON.stringify(app.db.entries('wintr_owned')), content: JSON.stringify(app.db.entries('wintr_owned_content')), qloo: app.calls.length, gemini: app.cat.calls.length, totals: await app.ledger().totals() };

    for (let i = 0; i < 2; i++) {
      const frame = await app.send('GET', url, { cookie });
      expect(frame.status).toBe(200);
      expect(frame.headers['content-security-policy']).toBe(SUGGESTIONS_CSP);
      expect([frame.headers['x-frame-options'], frame.headers['cross-origin-resource-policy'], frame.headers['content-type']]).toEqual(['SAMEORIGIN', 'same-origin', 'text/html; charset=utf-8']);
      expect(frame.body).toBe(suggestionsDocument(sanitizeStoredSuggestions(LEGACY)!));
      expect(links(frame.body)).toEqual([SAFE]);
      expect(frame.body).not.toContain('example.invalid');
      for (const text of ['Synthetic link', 'Mixed', '.c{color:#fff}', 'class="c"']) expect(frame.body).toContain(text);
    }
    // A rebuildable unit is presentable, so the parent result stays complete.
    expect((await app.state(cookie)).panel).toMatchObject({ outcome: 'choices', choices: snap.panel!.choices, suggestionsUrl: url });
    // Delivery is read-only: the stored unit is not rewritten and nothing is re-run, reserved or reset.
    expect(JSON.stringify(app.db.entries('wintr_owned'))).toBe(before.owned);
    expect(JSON.stringify(app.db.entries('wintr_owned_content'))).toBe(before.content);
    expect([app.calls.length, app.cat.calls.length]).toEqual([before.qloo, before.gemini]);
    expect(await app.ledger().totals()).toEqual(before.totals);

    // Another owner never receives it; after Clear the owner does not either.
    const other = await app.newSession();
    expect(await app.send('GET', url, { cookie: other })).toMatchObject({ status: 404, body: null });
    expect((await app.send('DELETE', '/api/session', { cookie })).status).toBeLessThan(300);
    expect(await app.send('GET', url, { cookie })).toMatchObject({ status: 404, body: null });
  });

  it('a current canonical unit, including an expanded one above the raw provider bound, is delivered unchanged', { timeout: 30_000 }, async () => {
    // Raw provider input within 64 KiB whose canonical output (escaped text, forced target/rel) exceeds it.
    const chip = (n: number) => `<a class="chip" href="https://www.google.com/search?q=invented+${n}">Q&amp;A ${n}</a>`;
    let raw = '<style>.chip{color:#fff}</style><div class="carousel">';
    for (let n = 0; Buffer.byteLength(raw + chip(n) + '</div>') <= 64 * 1024; n++) raw += chip(n);
    raw += '</div>';
    const app = await pipeline({ catalogue: () => envelope(THREE, { rendered: raw }) });
    const { cookie, snap } = await app.initial();
    const canonical = sanitizeSuggestions(raw)!;
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(canonical)).toBeGreaterThan(64 * 1024);
    expect(Buffer.byteLength(canonical)).toBeLessThanOrEqual(256 * 1024);
    // Deliberate bounds: the raw provider entry point would refuse it by size alone; the stored entry point keeps it whole.
    expect(sanitizeSuggestions(canonical)).toBeNull();
    expect(sanitizeStoredSuggestions(canonical)).toBe(canonical);

    // The projection keeps the complete result for this large canonical unit.
    expect(snap.panel).toMatchObject({ outcome: 'choices', suggestionsUrl: expect.stringMatching(/^\/api\/suggestions\//) });
    expect(snap.panel!.choices).toHaveLength(3);
    const frame = await app.send('GET', snap.panel!.suggestionsUrl!, { cookie });
    expect(frame.status).toBe(200);
    expect(frame.body).toBe(suggestionsDocument(canonical));
    expect(links(frame.body)).toHaveLength((canonical.match(/<a /g) ?? []).length);

    // A small valid Google unit stored by an earlier version is also delivered intact (only target/rel forced).
    storeUnit(app.db, '<div class="c"><a class="chip" href="https://www.google.com/search?q=ok">ok</a></div>');
    const small = await app.send('GET', snap.panel!.suggestionsUrl!, { cookie });
    expect(small.status).toBe(200);
    expect(small.body).toBe(suggestionsDocument('<div class="c"><a class="chip" href="https://www.google.com/search?q=ok" target="_blank" rel="noopener noreferrer">ok</a></div>'));
    expect((await app.state(cookie)).panel).toEqual(snap.panel);
  });

  /** The projection of a result whose mandatory unit cannot be presented: safe context only, nothing from the result. */
  const hiddenFrom = (p: SafeSnapshot['panel'] & object) => ({
    handle: p.handle,
    foundAt: p.foundAt, // Public creation time is context; withheld recording/model fields stay empty.
    synthetic: p.synthetic,
    role: p.role,
    mode: p.mode,
    basis: p.basis,
    intent: p.intent, // Listener-authored context survives; the complete generated/native result remains withheld below.
    outcome: 'source_unavailable',
    choices: [],
    answer: { text: '', marks: [] },
    citations: [],
    suggestionsUrl: null,
    gaps: [],
  });
  /** Nothing of the withheld result (titles, listening links, answer, sources, frame URL) appears anywhere in the reply. */
  const noResultLeak = (reply: unknown, p: SafeSnapshot['panel'] & object) => {
    const text = JSON.stringify(reply);
    for (const c of p.choices) for (const s of [c.title, c.playUrl!, c.fitHypothesis]) expect(text).not.toContain(s);
    for (const c of p.citations) expect(text).not.toContain(c.title);
    expect(text).not.toContain(p.answer.text.slice(0, 40));
    expect(text).not.toContain(p.suggestionsUrl!);
  };

  it('an unpresentable stored unit hides its whole result in every projection, the frame is refused (410), and stored truth, counts and the allowance are untouched', async () => {
    const app = await pipeline();
    const { cookie, snap } = await app.initial();
    await app.settled();
    const url = snap.panel!.suggestionsUrl!;
    const before = await app.state(cookie);
    expect(before.panel).toMatchObject({ outcome: 'choices', suggestionsUrl: url });
    expect(before.connection!.artists.length).toBeGreaterThan(0);
    const totals = await app.ledger().totals();
    const unresolved = (await app.ledger().unresolved(100)).length;
    const calls = [app.calls.length, app.cat.calls.length];
    for (const unit of [
      '', // a returned unit that sanitised to nothing under the earlier policy
      '<script>steal()</script>', // sanitises to nothing
      '<div>'.repeat(100) + 'too deep',
      '&'.repeat(200 * 1024), // within the stored-record bound, but its canonical form exceeds the output bound
    ]) {
      storeUnit(app.db, unit);
      const frame = await app.send('GET', url, { cookie });
      expect(frame.status).toBe(410);
      expect(frame.body).toBeNull();
      expect(frame.headers['content-security-policy']).toBe(SUGGESTIONS_CSP);
      expect(frame.headers['x-frame-options']).toBe('SAMEORIGIN');
      // Every read (each on a fresh instance) derives the same verdict: the result is withheld, not a no-match.
      const s = await app.state(cookie);
      expect(s.panel).toEqual(hiddenFrom(before.panel!));
      noResultLeak(s, before.panel!);
      // Stored truth and safe relationship/Qloo context are unchanged: stage, status, attempt, brief, connection, allowance.
      expect(s.session!.checkedAt).toBeGreaterThanOrEqual(before.session!.checkedAt!);
      // Delivery time is freshly projected; the fixed expiry and all stored/owned facts remain identical.
      expect({ ...s, panel: null, session: { ...s.session, checkedAt: undefined } }).toEqual({ ...before, panel: null, session: { ...before.session, checkedAt: undefined } });
    }
    // No provider retry, no automatic spend, no reset of counts or unknown holds.
    expect([app.calls.length, app.cat.calls.length]).toEqual(calls);
    expect(await app.ledger().totals()).toEqual(totals);
    expect((await app.ledger().unresolved(100)).length).toBe(unresolved);

    // A late update (feedback for a choice handle the page held before) cannot revive the withheld result.
    const late = await app.feedback(cookie, before.panel!.handle, before.panel!.choices[0]!.handle, 'like', null);
    noResultLeak(late.body, before.panel!);
    if (late.body?.panel) expect(late.body.panel).toEqual(hiddenFrom(before.panel!));

    // Another owner never sees it; after Clear neither the panel nor the frame is available.
    const other = await app.newSession();
    expect((await app.state(other)).panel).toBeNull();
    expect(await app.send('GET', url, { cookie: other })).toMatchObject({ status: 404, body: null });
    expect((await app.send('DELETE', '/api/session', { cookie })).status).toBeLessThan(300);
    expect((await app.state(cookie)).panel).toBeNull();
    expect(await app.send('GET', url, { cookie })).toMatchObject({ status: 404, body: null });
  });

  it('a hidden result stays hidden while the explicit refined search runs and as an earlier panel afterwards; the one allowance is not bypassed', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await pipeline({ catalogue: (i) => (i === 0 ? envelope(THREE) : gate.then(() => CORRECTION)) });
    const { cookie, snap } = await app.initial();
    await app.settled();
    const oldUrl = snap.panel!.suggestionsUrl!;
    storeUnit(app.db, '<script>steal()</script>');
    const hidden = await app.state(cookie);
    expect(hidden.panel).toEqual(hiddenFrom(snap.panel!));
    expect(hidden.refinement).toEqual({ used: false });
    const gemini = app.cat.calls.length;
    expect(gemini).toBe(1);

    // Explicit recovery: the existing refined search from the hidden panel's own handle (nothing starts by itself).
    const pending = app.refine(cookie, { mode: 'correct_direction', panel: hidden.panel!.handle, brief: hidden.brief!.handle });
    await until(() => app.cat.calls.length === gemini + 1);
    const during = await app.state(cookie);
    expect(during.attempt).toMatchObject({ kind: 'refine', active: true });
    expect(during.panel).toEqual(hidden.panel);
    noResultLeak(during, snap.panel!);

    release();
    const r = await pending;
    expect(r.body).toMatchObject({ stage: 'complete', refinement: { used: true }, panel: { role: 'refinement', outcome: 'choices' } });
    expect(r.body.panel.choices.map((c: { title: string }) => c.title)).toEqual(['Other Song', 'Warm Song']);
    expect(r.body.history).toEqual([hidden.panel]);
    // (The new panel may legitimately share fixture wording such as fit sentences; the earlier result itself stays withheld.)
    noResultLeak(r.body.history, snap.panel!);
    for (const c of snap.panel!.choices) expect(JSON.stringify(r.body)).not.toContain(c.playUrl!);
    const after = await app.state(cookie);
    expect(after.history).toEqual([hidden.panel]);
    expect(after.panel).toEqual(r.body.panel);
    expect((await app.send('GET', after.panel!.suggestionsUrl!, { cookie })).status).toBe(200);
    expect((await app.send('GET', oldUrl, { cookie })).status).toBe(410);
    // The single allowance stays spent.
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: after.panel!.handle, brief: after.brief!.handle })).body.error).toBe('refinement_used');
    expect(app.cat.calls.length).toBe(gemini + 1);
  });
});

describe('composed authority + exposure ledger across instances', () => {
  it('refuses future-created work but retains revocation under clock rollback', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const make = () => storeOn(db, { clock: () => clock.t });
    const created = await make().createSession(clock.t);
    if (!created || typeof created === 'string') throw new Error('expected session');
    const owner = { sessionId: created.session.id, epoch: 1 };
    clock.t += 100;
    const admitted = await make().admitReference({ ...owner, now: clock.t, reference: REF, listenerCue: null, actionKeyHash: sha256('clock-key'), inputHash: sha256('clock-input') });
    if (admitted.kind !== 'admitted') throw new Error('expected attempt');
    clock.t -= 1;
    expect(await make().read(owner.sessionId, 1, clock.t)).toBeNull();
    expect(await make().admitReference({ ...owner, now: clock.t, reference: REF, listenerCue: null, actionKeyHash: sha256('rollback-reference'), inputHash: sha256('rollback-reference-input') })).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect(await make().admitDiscover({ ...owner, now: clock.t, briefId: admitted.attempt.id, actionKeyHash: sha256('rollback-discover'), inputHash: sha256('rollback-discover-input') })).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect(db.entries('wintr_owned/journey_')).toHaveLength(1);
    expect((await make().reserveSubmission(owner, admitted.attempt.id, 'reference_analysis', clock.t)).ok).toBe(false);
    expect(await make().commitAnalysis(owner.sessionId, 1, admitted.attempt.id, ANALYSIS, clock.t)).toBe(false);
    clock.t = T0 - 1;
    expect(await make().findSessionBySecret(created.secret, clock.t, 'revoke')).not.toBeNull();
    expect(await make().stopAttempt(owner.sessionId, 1, admitted.attempt.id, clock.t)).toBe(true);
    clock.t = T0 + 101;
    expect((await make().read(owner.sessionId, 1, clock.t))!.attempt!.outcome).toBe('cancelled');
  });
  it('does not authorize a replacement session before its creation time after clock rollback', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const make = () => storeOn(db, { clock: () => clock.t, maxSessions: 1 });
    const first = await make().createSession(clock.t);
    if (!first || typeof first === 'string') throw new Error('expected session');
    clock.t = first.session.expiresAt;
    const replacement = await make().createSession(clock.t);
    if (!replacement || typeof replacement === 'string') throw new Error('expected replacement');
    clock.t -= 1;
    expect(await make().findSessionBySecret(replacement.secret, clock.t)).toBeNull();
    expect(await make().authorizeRead({ sessionId: replacement.session.id, epoch: 1 }, clock.t)).toBe(false);
    expect(await make().read(replacement.session.id, 1, clock.t)).toBeNull();
  });
  async function attempt(store: FirestoreStore, t: number, k = 'k1') {
    const created = (await store.createSession(t)) as { session: { id: Handle }; secret: string };
    const owner: Owner = { sessionId: created.session.id, epoch: 1 };
    const r = await store.admitReference({ ...owner, now: t, reference: REF, listenerCue: null, actionKeyHash: sha256(`key|${k}`), inputHash: sha256(`input|${k}`) });
    if (r.kind !== 'admitted') throw new Error(`not admitted: ${JSON.stringify(r)}`);
    return { owner, attemptId: r.attempt.id, secret: created.secret, journeyId: r.journey.id };
  }

  it('racing the final session submission slot from two instances admits exactly one (callbacks retried, no duplicate effects)', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const [a, b] = [storeOn(db, { clock: () => clock.t }), storeOn(db, { clock: () => clock.t })];
    const { owner, attemptId } = await attempt(a, T0);
    for (let i = 0; i < 3; i++) expect((await a.reserveSubmission(owner, attemptId, 'catalogue_generation', T0)).ok).toBe(true);
    const conflicts = db.conflicts;
    const raced = await Promise.all([a.reserveSubmission(owner, attemptId, 'catalogue_generation', T0), b.reserveSubmission(owner, attemptId, 'catalogue_generation', T0)]);
    expect(raced.filter((r) => r.ok)).toHaveLength(1);
    expect(raced.find((r) => !r.ok)).toEqual({ ok: false, code: 'capacity' });
    expect(db.conflicts).toBeGreaterThan(conflicts);
    const totals = (await a.reconciliation().totals())!;
    expect(totals.counts.gemini).toBe(4);
    expect(totals.unitsHeld).toBe(4 * 500);
    expect((await a.reconciliation().unresolved(10)).length).toBe(4);
    expect((await b.read(owner.sessionId, 1, T0))!.attempt!.calls.map((c) => c.stage)).toEqual(Array(4).fill('catalogue_generation'));
  });

  it('refuses a paid replay when its manifest-declared binding document is missing', async () => {
    const db = new FakeFirestoreServer();
    const a = storeOn(db, { clock: () => T0 });
    const { owner, attemptId } = await attempt(a, T0);
    await a.commitAnalysis(owner.sessionId, 1, attemptId, ANALYSIS, T0);
    const input = { ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('key|k1'), inputHash: sha256('input|k1') };
    expect((await a.admitReference(input)).kind).toBe('replay');
    const binding = (roots(db)[0]!.body.bindings as string[])[0]!;
    await createFirestoreDocStore(new FakeFirestore(db)).transact(async tx => { tx.delete(ownedPath('binding', binding)); });
    expect(await storeOn(db, { clock: () => T0 }).admitReference(input)).toEqual({ kind: 'rejected', code: 'admission_unavailable' });
    expect(db.entries('wintr_owned/journey_')).toHaveLength(1);
  });

  it('refuses changed free-key reuse when its manifest-declared binding is missing', async () => {
    const db = new FakeFirestoreServer();
    const a = storeOn(db, { clock: () => T0 });
    const { owner, attemptId } = await attempt(a, T0);
    await a.commitAnalysis(owner.sessionId, 1, attemptId, ANALYSIS, T0);
    const bucket = (await a.read(owner.sessionId, 1, T0))!;
    const input = { analysisId: bucket.analysis!.id, relationship: 'Invented first cue', relationshipSource: 'listener_text' as const, proposedArtists: [], exclusions: [] };
    const guard = { actionKeyHash: sha256('free-k'), inputHash: sha256('free-i1'), expectedBriefId: null };
    const first = await a.saveBrief(owner, input, guard, T0);
    if (first.kind !== 'saved') throw new Error('expected saved brief');
    const changed = { ...input, relationship: 'Invented second cue' };
    const changedGuard = { ...guard, inputHash: sha256('free-i2'), expectedBriefId: first.brief.id };
    expect(await a.saveBrief(owner, changed, changedGuard, T0)).toEqual({ kind: 'rejected', code: 'action_conflict' });
    const binding = (roots(db)[0]!.body.freeBindings as string[])[0]!;
    await createFirestoreDocStore(new FakeFirestore(db)).transact(async tx => { tx.delete(ownedPath('freebinding', binding)); });
    expect(await storeOn(db, { clock: () => T0 }).saveBrief(owner, changed, changedGuard, T0)).toEqual({ kind: 'rejected', code: 'unavailable' });
    expect((await a.read(owner.sessionId, 1, T0))!.briefs).toHaveLength(1);
  });

  it('exact action replay across instances allocates once; a conflicting reuse is refused', async () => {
    const db = new FakeFirestoreServer();
    const [a, b] = [storeOn(db, { clock: () => T0 }), storeOn(db, { clock: () => T0 })];
    const created = (await a.createSession(T0)) as { session: { id: Handle } };
    const input = { sessionId: created.session.id, epoch: 1, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('same-key'), inputHash: sha256('same-input') };
    const [r1, r2] = await Promise.all([a.admitReference(input), b.admitReference(input)]);
    expect([r1.kind, r2.kind].sort()).toEqual(['admitted', 'replay']);
    const admitted = [r1, r2].find((r) => r.kind === 'admitted') as { attempt: { id: Handle } };
    expect([r1, r2].find((r) => r.kind === 'replay')).toEqual({ kind: 'replay', attemptId: admitted.attempt.id });
    expect(await b.admitReference({ ...input, inputHash: sha256('other-input') })).toEqual({ kind: 'rejected', code: 'action_conflict' });
    expect(db.entries('wintr_owned/journey_')).toHaveLength(1);
  });

  it('Stop from another instance revokes before intent; a reserved-but-unsent submission is provably withdrawn', async () => {
    const db = new FakeFirestoreServer();
    const [a, b] = [storeOn(db, { clock: () => T0 }), storeOn(db, { clock: () => T0 })];
    const { owner, attemptId } = await attempt(a, T0);
    const reserved = await a.reserveSubmission(owner, attemptId, 'reference_analysis', T0);
    expect(reserved).toMatchObject({ ok: true, call: 0 });
    expect(await b.stopAttempt(owner.sessionId, 1, attemptId, T0)).toBe(true);
    expect(await a.beginSubmission(owner, attemptId, 0, T0)).toBe('revoked');
    await a.withdrawSubmission(owner.sessionId, attemptId, 0);
    const [r] = await a.reconciliation().unresolved(10).then(async (u) => [u, await a.reconciliation().totals()] as const);
    expect(r).toEqual([]);
    expect((await b.read(owner.sessionId, 1, T0))!.attempt).toMatchObject({ outcome: 'cancelled', dispatch: 'withdrawn' });

    // Stop by action key before admission revokes first: the later arrival is refused without dispatch.
    expect(await b.stopAction(owner.sessionId, 1, sha256('key|late'), T0)).toEqual({ attemptId: null });
    expect(await a.admitReference({ ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('key|late'), inputHash: sha256('input|late') })).toEqual({
      kind: 'rejected',
      code: 'cancelled',
    });
  });

  it('intent replay, racing intents and a lost acknowledgement never grant a second send', async () => {
    const db = new FakeFirestoreServer();
    const [a, b] = [storeOn(db, { clock: () => T0 }), storeOn(db, { clock: () => T0 })];
    const { owner, attemptId } = await attempt(a, T0);
    await a.reserveSubmission(owner, attemptId, 'qloo_search', T0);
    const raced = await Promise.all([a.beginSubmission(owner, attemptId, 0, T0), b.beginSubmission(owner, attemptId, 0, T0)]);
    expect(raced.sort()).toEqual(['held', 'send']);
    expect(await a.beginSubmission(owner, attemptId, 0, T0)).toBe('held');

    await a.reserveSubmission(owner, attemptId, 'qloo_search', T0);
    db.faults.push('ack_lost');
    expect(await a.beginSubmission(owner, attemptId, 1, T0)).toBe('unavailable');
    expect(await b.beginSubmission(owner, attemptId, 1, T0)).toBe('held');
    // Possibly sent: withdrawal cannot release it.
    await b.withdrawSubmission(owner.sessionId, attemptId, 1);
    const held = await a.reconciliation().unresolved(10);
    expect(held.map((r) => r.state).sort()).toEqual(['intent', 'intent']);
    expect((await a.read(owner.sessionId, 1, T0))!.attempt!.calls.map((c) => c.state)).toEqual(['in_flight', 'in_flight']);
  });

  it('a crash after intent stays held across reconstruction, Clear, TTL and new sessions; settlement only from a typed receipt', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const pol = policy(T0 + 10 * HOUR, { service: { capUnits: 1_000_000, concurrency: 8, counts: { qloo: 600, gemini: 2 } } });
    const a = storeOn(db, { clock: () => clock.t, policy: pol });
    const { owner, attemptId } = await attempt(a, T0);
    await a.reserveSubmission(owner, attemptId, 'reference_analysis', T0);
    expect(await a.beginSubmission(owner, attemptId, 0, T0)).toBe('send');
    // Process "crashes" here: no end, no settlement.

    const b = storeOn(db, { clock: () => clock.t, policy: pol });
    await b.clearSession(owner.sessionId);
    clock.t = T0 + 2 * HOUR;
    db.sweepTtl(clock.t);
    expect(db.entries('wintr_owned')).toEqual([]);
    const ledger = b.reconciliation();
    const [held] = await ledger.unresolved(10);
    expect(held).toMatchObject({ state: 'intent', stage: 'reference_analysis', units: 300 });
    expect((await ledger.totals())!.unitsHeld).toBe(300);

    // A new session on another instance inherits the service exposure (cap 2 Gemini service-wide).
    const c = storeOn(db, { clock: () => clock.t, policy: pol });
    const next = await attempt(c, clock.t, 'k2');
    expect((await c.reserveSubmission(next.owner, next.attemptId, 'reference_analysis', clock.t)).ok).toBe(true);
    expect(await c.reserveSubmission(next.owner, next.attemptId, 'catalogue_generation', clock.t)).toEqual({ ok: false, code: 'capacity' });

    // Controller reconciliation: abandoned work becomes unknown; only a typed validated receipt settles it.
    expect(await ledger.markUnknown(held!.id, 'abandoned_after_restart', clock.t)).toMatchObject({ ok: true, reservation: { state: 'unknown' } });
    expect(await ledger.settle(held!.id, { kind: 'provider_usage', currency: 'XTS', units: -1, reference: 'synthetic-usage-0001', issuedAt: clock.t }, clock.t)).toMatchObject({ ok: false });
    expect(await ledger.settle(held!.id, { kind: 'provider_usage', currency: 'EUR', units: 10, reference: 'synthetic-usage-0001', issuedAt: clock.t }, clock.t)).toMatchObject({ ok: false });
    expect(await ledger.settle(held!.id, { kind: 'provider_usage', currency: 'XTS', units: 280, reference: 'synthetic-usage-0001', issuedAt: clock.t }, clock.t)).toMatchObject({
      ok: true,
      reservation: { state: 'settled' },
    });
  });

  it('a new Journey, new session or reconstruction cannot reset session or service caps', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const a = storeOn(db, { clock: () => clock.t });
    const first = await attempt(a, T0);
    for (let i = 0; i < 4; i++) expect((await a.reserveSubmission(first.owner, first.attemptId, 'catalogue_generation', T0)).ok).toBe(true);
    expect(await a.settleAttempt(first.owner.sessionId, 1, first.attemptId, 'failed', 'adapter_failed', T0)).toBe(true);
    // Same session, new Journey, new instance: the session Gemini cap (4) still applies.
    const b = storeOn(db, { clock: () => clock.t });
    const again = await b.admitReference({ ...first.owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('key|j2'), inputHash: sha256('input|j2') });
    expect(again.kind).toBe('admitted');
    expect(await b.reserveSubmission(first.owner, (again as { attempt: { id: Handle } }).attempt.id, 'reference_analysis', T0)).toEqual({ ok: false, code: 'capacity' });
    // Qloo is a separate per-provider count.
    expect((await b.reserveSubmission(first.owner, (again as { attempt: { id: Handle } }).attempt.id, 'qloo_search', T0)).ok).toBe(true);
  });

  it('store failure before dispatch fails closed without invoking the adapter; failure after intent keeps the hold', async () => {
    const db = new FakeFirestoreServer();
    const store = storeOn(db, { clock: Date.now, policy: policy(Date.now() + HOUR) });
    const { owner, attemptId } = await attempt(store, Date.now());
    let invoked = 0;
    const adapter: ReferenceAdapter = { synthetic: true, analyse: async () => (invoked++, { audioAccess: 'synthetic_not_accessed', observations: ['x'], relationships: ['y'] }) };
    const read = async () => (await store.read(owner.sessionId, 1, Date.now()))!;
    const admitted = (await read()).attempt!;
    // The next commit (the reservation transaction) fails.
    db.faults.push('unavailable');
    await runReferenceStage({ store, adapter, now: Date.now, inflight: new Map() }, admitted, { reference: REF, listenerCue: null });
    expect(invoked).toBe(0);
    expect((await read()).attempt).toMatchObject({ outcome: 'failed', failure: 'admission_unavailable', dispatch: 'not_started' });
    expect(await store.reconciliation().unresolved(10)).toEqual([]);

    const next = await store.admitReference({ ...owner, now: Date.now(), reference: REF, listenerCue: null, actionKeyHash: sha256('key|n'), inputHash: sha256('input|n') });
    const id = (next as { attempt: { id: Handle } }).attempt.id;
    await store.reserveSubmission(owner, id, 'reference_analysis', Date.now());
    expect(await store.beginSubmission(owner, id, 0, Date.now())).toBe('send');
    db.faults.push('unavailable');
    await store.endSubmission(owner.sessionId, id, 0, 'returned');
    expect((await store.reconciliation().unresolved(10)).map((r) => r.state)).toEqual(['intent']);
    void attemptId;
  });

  it('a missing or malformed exposure policy refuses every submission before any provider call', async () => {
    for (const p of [undefined, { version: 'x' }]) {
      const db = new FakeFirestoreServer();
      const store = storeOn(db, { clock: Date.now, policy: p });
      const { owner, attemptId } = await attempt(store, Date.now());
      let invoked = 0;
      const adapter: ReferenceAdapter = { synthetic: true, analyse: async () => (invoked++, { audioAccess: 'synthetic_not_accessed', observations: ['x'], relationships: ['y'] }) };
      const a = (await store.read(owner.sessionId, 1, Date.now()))!.attempt!;
      await runReferenceStage({ store, adapter, now: Date.now, inflight: new Map() }, a, { reference: REF, listenerCue: null });
      expect(invoked).toBe(0);
      expect((await store.read(owner.sessionId, 1, Date.now()))!.attempt).toMatchObject({ id: attemptId, failure: 'admission_unavailable' });
      expect(db.entries('wintr_ledger_reservations')).toEqual([]);
    }
  });
});

describe('transaction-time fencing', () => {
  it('a transaction delayed and retried past the deadline cannot reserve with its stale request time', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const store = storeOn(db, { clock: () => clock.t });
    const created = (await store.createSession(T0)) as { session: { id: Handle } };
    const owner = { sessionId: created.session.id, epoch: 1 };
    const r = (await store.admitReference({ ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('k'), inputHash: sha256('i') })) as { attempt: { id: Handle; deadlineAt: number } };
    const rootPath = `wintr_owned/session_${owner.sessionId}`;
    db.beforeCommit = (attempt) => {
      if (attempt !== 1) return;
      // Time passes while the first attempt is in flight, and a concurrent write forces a retry.
      clock.t = r.attempt.deadlineAt + 1;
      db.seed(rootPath, db.entries(rootPath)[0]![1]);
    };
    expect(await store.reserveSubmission(owner, r.attempt.id, 'reference_analysis', T0)).toEqual({ ok: false, code: 'revoked' });
    db.beforeCommit = null;
    expect(db.entries('wintr_ledger_reservations')).toEqual([]);
    // Late commits from the stale worker are dropped at transaction time too.
    expect(await store.commitAnalysis(owner.sessionId, 1, r.attempt.id, ANALYSIS, T0)).toBe(false);
    expect(await store.setStage(owner, r.attempt.id, 'resolving_artists', T0)).toBe(false);
  });

  it('a stale request timestamp cannot admit after session expiry or authorise intent after revocation', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const [a, b] = [storeOn(db, { clock: () => clock.t }), storeOn(db, { clock: () => clock.t })];
    const created = (await a.createSession(T0)) as { session: { id: Handle }; secret: string };
    const owner = { sessionId: created.session.id, epoch: 1 };
    const r = (await a.admitReference({ ...owner, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('k'), inputHash: sha256('i') })) as { attempt: { id: Handle } };
    await a.reserveSubmission(owner, r.attempt.id, 'reference_analysis', T0);
    await b.clearSession(owner.sessionId);
    expect(await a.beginSubmission(owner, r.attempt.id, 0, T0)).toBe('revoked');
    await a.withdrawSubmission(owner.sessionId, r.attempt.id, 0);
    expect(await a.reconciliation().unresolved(10)).toEqual([]);

    const s2 = (await a.createSession(T0)) as { session: { id: Handle }; secret: string };
    clock.t = T0 + HOUR;
    expect(await a.admitReference({ sessionId: s2.session.id, epoch: 1, now: T0, reference: REF, listenerCue: null, actionKeyHash: sha256('k'), inputHash: sha256('i') })).toEqual({
      kind: 'rejected',
      code: 'session_expired',
    });
    expect(await a.findSessionBySecret(s2.secret, T0)).toMatchObject({ expired: true });
    expect(db.entries(`wintr_owned/session_${s2.session.id}`)).toEqual([]);
  });
});

describe('free-write limits, Stop/Clear exemption and Clear cleanup receipts', () => {
  it('the service-wide free-write window is shared by every instance; Stop and Clear are never throttled', async () => {
    const db = new FakeFirestoreServer();
    const clock = { t: T0 };
    const fm = { perSession: 30, perService: 3, windowMs: 60_000 };
    const [a, b] = [storeOn(db, { clock: () => clock.t, freeMutation: fm }), storeOn(db, { clock: () => clock.t, freeMutation: fm })];
    const s1 = (await a.createSession(T0)) as { session: { id: Handle } };
    expect(typeof (await b.createSession(T0))).toBe('object');
    expect(typeof (await a.createSession(T0))).toBe('object');
    expect(await b.createSession(T0)).toBe('rate_limited');
    expect(await storeOn(db, { clock: () => clock.t, freeMutation: fm }).createSession(T0)).toBe('rate_limited');
    expect(await b.stopAction(s1.session.id, 1, sha256('stop-key'), T0)).toEqual({ attemptId: null });
    await b.clearSession(s1.session.id);
    expect(db.entries(`wintr_owned/session_${s1.session.id}`)).toEqual([]);
    clock.t = T0 + 60_000;
    expect(typeof (await b.createSession(clock.t))).toBe('object');
  });

  it('Clear revokes epoch and lookup first; a failed deletion keeps an id-only receipt that a later Clear completes', async () => {
    const db = new FakeFirestoreServer();
    const store = storeOn(db, { clock: () => T0 });
    const created = (await store.createSession(T0)) as { session: { id: Handle }; secret: string };
    const owner = { sessionId: created.session.id, epoch: 1 };
    const r = (await store.admitReference({ ...owner, now: T0, reference: REF, listenerCue: 'the bassline', actionKeyHash: sha256('k'), inputHash: sha256('i') })) as { attempt: { id: Handle } };
    const provider = { model: 'invented-model', finalText: 'Invented private final text', usage: null, uncertainArtistName: 'Generic Artist' };
    expect(await store.commitAnalysis(owner.sessionId, 1, r.attempt.id, { ...ANALYSIS, provider }, T0)).toBe(true);
    const ownedBefore = db.entries('wintr_owned').length;
    expect(ownedBefore).toBeGreaterThan(5);

    let commits = 0;
    db.beforeCommit = () => {
      commits += 1;
      if (commits === 2) throw new Error('UNAVAILABLE during deletion');
    };
    await store.clearSession(owner.sessionId);
    db.beforeCommit = null;
    const [root] = roots(db);
    expect(root!.epoch).toBe(2);
    expect(Object.keys(root!.body).sort()).toEqual(['pending', 'state']);
    expect(root!.body.state).toBe('revoked');
    expect(JSON.stringify(root!.body)).not.toMatch(/bassline|Invented private|Generic Artist|secretHash/);
    expect(db.entries('wintr_owned/secret_')).toEqual([]);
    expect(await store.findSessionBySecret(created.secret, T0)).toBeNull();
    expect(await store.read(owner.sessionId, 1, T0)).toBeNull();
    expect(await store.read(owner.sessionId, 2, T0)).toBeNull();

    await storeOn(db, { clock: () => T0 }).clearSession(owner.sessionId);
    expect(db.entries('wintr_owned')).toEqual([]);
  });
});

describe('runtime boundary', () => {
  it('refuses memory/test-backed stores and incomplete bindings; live mode still refuses to start', () => {
    expect(liveStoreRefusal(new MemoryStore({ maxSessions: 1, maxJourneysPerSession: 1 }))).toMatch(/shared transactional Firestore/);
    expect(liveStoreRefusal(storeOn(new FakeFirestoreServer()))).toMatch(/not composed/);
    const v = validateLiveBindings({ firestore: { projectId: 'x' }, exposurePolicy: { version: 'x' } }, T0);
    expect(v.ok).toBe(false);
    expect((v as { problems: string[] }).problems).toEqual(
      expect.arrayContaining(['firestore.databaseId:missing', 'serviceId:missing', 'settlementOwner:missing', 'sourcePolicy:missing', 'qloo:missing', 'reference:missing', 'exposurePolicy:invalid']),
    );
    expect(() => loadConfig(['--mode=live'], {})).toThrow(ConfigError);
    expect(() => loadConfig([], { WINTR_MODE: 'live' })).toThrow(ConfigError);
  });
});
