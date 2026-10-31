import { createHttpFixture } from './fixtures/http-lifecycle.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Handle, InvestigationPlan, SafeSnapshot } from '../src/shared/records.js';
import { createApiHandler, type DiscoveryDeps } from '../src/server/app.js';
import { allowedAnchor, buildCatalogueHandoff, notConfiguredCatalogue, type CatalogueHandoff, type CatalogueSeam } from '../src/server/catalogue.js';
import { loadConfig } from '../src/server/config.js';
import { canonicalFilter, rehydrateIdentity, sealIdentity } from '../src/server/identity.js';
import type { ProviderRequest, ProviderResponse } from '../src/server/providers/http.js';
import { createQlooClient, type QlooArtist, type QlooArtistId } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createSyntheticReferenceAdapter } from '../src/server/reference.js';
import { createRecordSealer } from '../src/server/seal.js';
import { MemoryStore, type DiscoverContext, type Owner } from '../src/server/store.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';
import { SUGGESTIONS_CSP } from '../src/server/catalogue-format.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createSourceResolver } from '../src/server/source-resolver.js';
import { createGeminiCatalogueAdapter } from '../src/server/providers/gemini-catalogue.js';
import { createYouTubeVerifier } from '../src/server/verifier.js';
import { createSyntheticCatalogue } from '../src/server/synthetic-catalogue.js';
import { buildAnswer, catalogueTransport, envelope, fakeNetwork, REDIRECT, sseBody, VID, type MetaEntry } from './fixtures/catalogue-fixtures.js';

// Graph path tests: the genuine Qloo client over fake HTTP envelopes, the real
// HTTP API, MemoryStore and harness. All artists/UUIDs are invented.

const KEY = 'synthetic-qloo-test-key-0001';
const SEAL_KEY = 'synthetic-seal-key-for-tests-only-000001';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const uid = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const SEED = { entity_id: uid(1), name: 'Generic Artist', subtype: 'urn:entity:artist', disambiguation: 'Invented band' };
const SECOND = { entity_id: uid(2), name: 'Other Artist', subtype: 'urn:entity:artist' };
const NAMESAKE_A = { entity_id: uid(3), name: 'Shared Name', subtype: 'urn:entity:artist', disambiguation: 'Invented trio, 1990s' };
const NAMESAKE_B = { entity_id: uid(4), name: 'Shared Name', subtype: 'urn:entity:artist', disambiguation: 'Invented soloist' };
const POOL_X = [11, 12, 13].map((n) => ({ entity_id: uid(n), name: `Neighbour X${n}`, subtype: 'urn:entity:artist', query: { affinity: 0.9 } }));
const POOL_Y = [21, 22].map((n) => ({ entity_id: uid(n), name: `Neighbour Y${n}`, subtype: 'urn:entity:artist' }));
const TAGS = [{ tag_id: 'urn:tag:genre:music:invented_warmth', name: 'Invented warmth', subtype: 'urn:tag:genre:music' }];

const json = (status: number, value: unknown): ProviderResponse => ({
  status,
  contentType: 'application/json',
  body: new TextEncoder().encode(JSON.stringify(value)),
});

type Responder = (req: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>;

interface Fixture {
  search?: Record<string, unknown[]>;
  pool?: unknown[];
  tags?: unknown[] | number;
  artistStatus?: number;
}

function fixture(f: Fixture): Responder {
  return (req) => {
    const p = req.url.searchParams;
    if (req.url.pathname === '/search') {
      const results = f.search?.[(p.get('query') ?? '').toLowerCase()];
      return results ? json(200, { results }) : json(404, {});
    }
    if (p.get('filter.type') === 'urn:tag') {
      return typeof f.tags === 'number' ? json(f.tags, {}) : json(200, { success: true, results: { tags: f.tags ?? TAGS } });
    }
    if (f.artistStatus) return json(f.artistStatus, {});
    return json(200, { success: true, results: { entities: f.pool ?? POOL_X } });
  };
}

const kind = (req: ProviderRequest) =>
  req.url.pathname === '/search' ? 'search' : req.url.searchParams.get('filter.type') === 'urn:tag' ? 'tags' : 'artists';

function recordingCatalogue() {
  const handoffs: CatalogueHandoff[] = [];
  const seam: CatalogueSeam = {
    async investigate(handoff) {
      handoffs.push(structuredClone(handoff));
      return { kind: 'not_configured' };
    },
  };
  return { seam, handoffs };
}

const fixtureHttp = createHttpFixture();
const request = fixtureHttp.request;
const servers: Server[] = [];
afterEach(async () => {
  await fixtureHttp.close(servers.splice(0));
});

interface SetupOptions {
  respond?: Responder;
  catalogue?: CatalogueSeam;
  store?: MemoryStore;
  disabled?: boolean;
  clock?: { t: number };
}

async function setup(opts: SetupOptions = {}) {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: opts.disabled ? 'disabled' : 'synthetic' });
  const store = opts.store ?? new MemoryStore(config);
  const calls: ProviderRequest[] = [];
  const makeDiscovery = (respond: Responder, catalogue: CatalogueSeam): DiscoveryDeps => ({
    qloo: createQlooClient({
      transport: async (req) => {
        calls.push(req);
        return respond(req);
      },
      apiKey: new ServerSecret(KEY),
      host: 'hackathon.api.qloo.com',
    }),
    qlooSynthetic: false,
    catalogue,
    sealer: createRecordSealer(new ServerSecret(SEAL_KEY)),
  });
  const clock = opts.clock;
  const now = clock ? () => clock.t : undefined;
  let handler = createApiHandler({ shutdown: fixtureHttp.shutdown(),
    config,
    store,
    now,
    referenceAdapter: opts.disabled ? null : createSyntheticReferenceAdapter(0),
    discovery: opts.disabled ? null : makeDiscovery(opts.respond ?? fixture({}), opts.catalogue ?? notConfiguredCatalogue),
  });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => void handler(req, res));
  /** Simulates a restart: a fresh handler, Qloo client and sealer instance over the same durable store. */
  const restart = (respond: Responder, catalogue: CatalogueSeam = notConfiguredCatalogue) => {
    handler = createApiHandler({ shutdown: fixtureHttp.shutdown(), config, store, now, referenceAdapter: createSyntheticReferenceAdapter(0), discovery: makeDiscovery(respond, catalogue) });
  };

  const snapshots: string[] = [];
  const send = (method: string, path: string, o: { body?: unknown; cookie?: string; origin?: string | null } = {}) =>
    fixtureHttp.observe(new Promise<{ status: number; headers: Record<string, unknown>; body: any }>((resolve, reject) => {
      const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
      const headers: Record<string, string> = { host: config.hostHeader };
      if (method !== 'GET' && o.origin !== null) headers.origin = o.origin ?? config.origin;
      if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
      }
      if (o.cookie) headers.cookie = o.cookie;
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        res.on('error', reject);
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          snapshots.push(data);
          resolve({ status: res.statusCode!, headers: res.headers, body: data ? JSON.parse(data) : null });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    }));

  const newSession = async () => String((await send('POST', '/api/session', { body: {} })).headers['set-cookie']).split(';')[0]!;
  const state = async (cookie: string) => (await send('GET', '/api/state', { cookie })).body as SafeSnapshot;
  let n = 0;
  const key = () => `graph-action-key-${String(++n).padStart(6, '0')}`;

  /** A deliberate free save: a fresh free action key and the current version as optimistic basis (overridable). */
  const savePref = async (o: { body: Record<string, unknown>; cookie?: string; origin?: string | null }) => {
    const basis = o.cookie ? await state(o.cookie) : null;
    return send('POST', '/api/preference', { ...o, body: { actionKey: key(), expectedBrief: basis?.brief?.handle ?? null, ...o.body } });
  };
  /** A deliberate free artist choice, based on the current checkpoint revision (overridable). */
  const choose = async (o: { body: Record<string, unknown>; cookie?: string }) => {
    const basis = o.cookie ? await state(o.cookie) : null;
    return send('POST', '/api/artist-choice', { ...o, body: { actionKey: key(), expectedRevision: basis?.identity?.revision ?? 0, ...o.body } });
  };

  /** Session -> synthetic reference -> free preference save. */
  const ready = async (artists: string[], cue?: string) => {
    const cookie = await newSession();
    const ref = await send('POST', '/api/reference', {
      body: { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: key(), ...(cue ? { cue } : {}) },
      cookie,
    });
    expect(ref.body.stage).toBe('awaiting_preference');
    const saved = await savePref({
      body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists },
      cookie,
    });
    expect(saved.status).toBe(200);
    return { cookie, snap: saved.body as SafeSnapshot };
  };
  const discover = (cookie: string, brief: Handle, actionKey = key()) => send('POST', '/api/discover', { body: { brief, actionKey }, cookie });

  return { send, newSession, state, store, calls, ready, discover, key, snapshots, restart, config, savePref, choose };
}

const noLeaks = (snapshots: string[]) => {
  for (const s of snapshots) {
    expect(s).not.toMatch(UUID_RE);
    expect(s).not.toMatch(/entityId|entity_id|"seal"|affinity|x-api-key/i);
    expect(s).not.toContain(KEY);
    expect(s).not.toContain(SEAL_KEY);
  }
};

describe('boot and free saves never dispatch', () => {
 it('automatic Live discovery keeps concrete audio observations and skips optional tags',async()=>{
  const {seam,handoffs}=recordingCatalogue();const app=await setup({respond:fixture({search:{'generic artist':[SEED]}}),catalogue:seam});const {cookie,snap}=await app.ready(['Generic Artist']);
  const found=await app.store.findSessionBySecret(cookie.split('=')[1]!,Date.now());if(!found)throw Error('invented owner missing');const owner={sessionId:found.session.id,epoch:found.session.epoch};const bucket=await app.store.read(owner.sessionId,owner.epoch,Date.now());if(!bucket?.analysis)throw Error('invented analysis missing');
  const saved=await app.store.saveBrief(owner,{analysisId:bucket.analysis.id,relationship:snap.brief!.relationship,relationshipSource:'automatic_match',proposedArtists:['Generic Artist'],exclusions:[]},{actionKeyHash:'a'.repeat(64),inputHash:'b'.repeat(64),expectedBriefId:snap.brief!.handle},Date.now());if(saved.kind==='rejected')throw Error(saved.code);
  const commit=app.store.commitPlan.bind(app.store);let checked=false;app.store.commitPlan=async(owner,attempt,pool,plan,now)=>{expect(await commit(owner,attempt,pool,{...plan,referenceObservations:['Invented unrelated audio']},now)).toBe(false);checked=true;return commit(owner,attempt,pool,plan,now);};
  await app.discover(cookie,saved.brief.id);expect(checked).toBe(true);expect(app.calls.map(kind)).toEqual(['search','artists']);expect(handoffs).toHaveLength(1);expect(handoffs[0]!.referenceObservations).toEqual(bucket.analysis.observations);expect(handoffs[0]!.referenceObservations!.length).toBeGreaterThan(0);
 });

  it('makes no Qloo call at boot, on reads, reference or free preference saves', async () => {
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED] } }) });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    await app.state(cookie);
    const again = await app.savePref({
      body: { analysis: snap.analysis!.handle, relationship: { choice: 0 }, artists: ['Generic Artist'] },
      cookie,
    });
    expect(again.body.brief.handle).toBe(snap.brief!.handle);
    expect(app.calls).toHaveLength(0);
    expect(app.store.serviceUsage().qloo).toBe(0);
  });

  it('refuses Discover without dispatch when providers are disabled', async () => {
    const app = await setup({ disabled: true });
    const cookie = await app.newSession();
    const r = await app.send('POST', '/api/discover', { body: { brief: 'a'.repeat(24), actionKey: app.key() }, cookie });
    expect(r.status).toBe(503);
    expect(app.calls).toHaveLength(0);
  });
});

describe('owned immutable briefs', () => {
  it('returns the same version for identical saves, makes new versions for edits and caps distinct versions at 20', async () => {
    const app = await setup();
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const save = (text: string) =>
      app.savePref({
        body: { analysis: snap.analysis!.handle, relationship: { text }, artists: ['Generic Artist'] },
        cookie,
      });
    const v2 = await save('the  warm   bass');
    expect(v2.body.brief).toMatchObject({ version: 2, relationship: 'the warm bass', source: 'listener_text' });
    expect((await save('the warm bass')).body.brief.handle).toBe(v2.body.brief.handle);
    for (let i = 3; i <= 20; i += 1) expect((await save(`edit ${i}`)).body.brief.version).toBe(i);
    const over = await save('one too many');
    expect(over.status).toBe(429);
    // Returning to an earlier identical content reuses its immutable version.
    const back = await app.savePref({
      body: { analysis: snap.analysis!.handle, relationship: { choice: 0 }, artists: ['Generic Artist'] },
      cookie,
    });
    expect(back.body.brief).toMatchObject({ handle: snap.brief!.handle, version: 1 });
  });

  it('validates the owned analysis handle, relationship choice and artist bounds', async () => {
    const app = await setup();
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const other = await app.ready(['Generic Artist']);
    const post = (body: Record<string, unknown>, c = cookie) => app.savePref({ body, cookie: c });
    expect((await post({ analysis: other.snap.analysis!.handle, relationship: { choice: 0 } })).status).toBe(409);
    expect((await post({ analysis: snap.analysis!.handle, relationship: { choice: 9 } })).status).toBe(422);
    expect((await post({ analysis: snap.analysis!.handle, relationship: { choice: 0, text: 'x' } })).status).toBe(400);
    expect((await post({ analysis: snap.analysis!.handle, relationship: { text: 'x'.repeat(1001) } })).status).toBe(422);
    expect((await post({ analysis: snap.analysis!.handle, relationship: { choice: 0 }, artists: ['a', 'b', 'c'] })).status).toBe(422);
    expect((await post({ analysis: snap.analysis!.handle, relationship: { choice: 0 }, artists: ['x'.repeat(129)] })).status).toBe(422);
    expect((await post({ analysis: snap.analysis!.handle, relationship: { choice: 0 } }, '')).status).toBe(401);
    expect((await post({ analysis: snap.analysis!.handle, relationship: { choice: 0 } }, cookie)).status).toBe(200);
    expect((await app.savePref({ body: {}, cookie, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('keeps a clear intake cue as explicit editable intent without a redundant question', async () => {
    const app = await setup();
    const cookie = await app.newSession();
    const ref = await app.send('POST', '/api/reference', {
      body: { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: app.key(), cue: 'the loose drum groove' },
      cookie,
    });
    expect(ref.body.brief).toMatchObject({ version: 1, relationship: 'the loose drum groove', source: 'intake_cue', artists: [] });
    expect(ref.body.stage).toBe('awaiting_preference');
    expect(app.calls).toHaveLength(0);
  });
});

describe('Discover: resolve -> Insights -> pool -> plan -> catalogue seam', () => {
  it('does not invent public identity context from absent IDs or provider-supplied URLs', async () => {
    const app = await setup({ respond: fixture({ search: { 'shared name': [
      { ...NAMESAKE_A, external: { spotify: [{ id: 'https://outside.invalid/artist' }], arbitrary: [{ id: 'invented' }] }, url: 'https://outside.invalid/' }, NAMESAKE_B,
    ] } }) });
    const { cookie, snap } = await app.ready(['Shared Name']);
    const result = await app.discover(cookie, snap.brief!.handle);
    expect(result.body.identity.slots[0].options.every((o: { context?: unknown }) => o.context === undefined)).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain('outside.invalid');
    expect(app.calls.map(kind)).toEqual(['search']);
  });

  it.each([
    ['spotify', '1'.repeat(22), 'https://open.spotify.com/artist/' + '1'.repeat(22)],
    ['musicbrainz', '40000000-0000-4000-8000-000000000001', 'https://musicbrainz.org/artist/40000000-0000-4000-8000-000000000001'],
    ['wikidata', 'Q900000000001', 'https://www.wikidata.org/wiki/Q900000000001'],
  ])('projects available owned %s identity context without a new lookup or trusted browser identifier', async (service, id, url) => {
    const app = await setup({ respond: fixture({ search: { 'shared name': [
      { ...NAMESAKE_A, external: { [service!]: [{ id }] } }, NAMESAKE_B,
    ] } }) });
    const { cookie, snap } = await app.ready(['Shared Name']);
    const result = await app.discover(cookie, snap.brief!.handle);
    expect(result.body.stage).toBe('awaiting_artist');
    expect(result.body.identity.slots[0].options[0]).toMatchObject({ context: { service, url } });
    expect(result.body.identity.slots[0].options[1].context).toBeUndefined();
    expect(app.calls.map(kind)).toEqual(['search']);
    const visible = JSON.stringify(result.body);
    expect(visible).not.toContain(NAMESAKE_A.entity_id);
    expect(visible).not.toContain(NAMESAKE_B.entity_id);
    expect(visible).not.toContain('external');
  });

  it('hands an owned plan built from returned artists to the seam in the same execute', async () => {
    const cat = recordingCatalogue();
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED] } }), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.status).toBe(200);
    expect(app.calls.map(kind).sort()).toEqual(['artists', 'search', 'tags']);
    expect(app.store.serviceUsage().qloo).toBe(3);

    const artistReq = app.calls.find((c) => kind(c) === 'artists')!;
    expect(artistReq.url.searchParams.get('signal.interests.entities')).toBe(SEED.entity_id);
    expect(artistReq.url.searchParams.get('filter.exclude.entities')).toBe(SEED.entity_id);

    expect(cat.handoffs).toHaveLength(1);
    const h = cat.handoffs[0]!;
    expect(h.relationship).toBe(snap.brief!.relationship);
    expect(h.briefVersion).toBe(1);
    expect(h.seedMix).toEqual(['Generic Artist']);
    expect(h.allowedArtists.map((a) => a.name)).toEqual(['Neighbour X11', 'Neighbour X12', 'Neighbour X13']);
    expect(h.associations.map((a) => a.name)).toEqual(['Invented warmth']);
    expect(h.attribution).toBe('seed_mix');
    const session = await app.store.findSessionBySecret(cookie.split('=')[1]!, Date.now());
    const owned = (await app.store.read(session!.session.id, session!.session.epoch, Date.now()))!;
    expect(owned.pool!.tags[0]).toMatchObject({ tagId: TAGS[0]!.tag_id, name: TAGS[0]!.name, subtype: TAGS[0]!.subtype });
    expect(h.exclusions).toContain('Generic Artist');
    expect(Buffer.byteLength(JSON.stringify(h))).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.stringify(h)).not.toMatch(UUID_RE);
    expect(JSON.stringify(h)).not.toMatch(/affinity|0\.9/);

    expect(r.body).toMatchObject({ stage: 'failed', code: 'catalogue_not_configured', status: 'connection_ready' });
    expect(r.body.connection).toMatchObject({ synthetic: false, seeds: ['Generic Artist'], capability: 'artists_and_tags', attribution: 'seed_mix' });
    expect(r.body.connection.why.join(' ')).toMatch(/Qloo returned 3 connected artists for that artist/);
    expect(r.body.connection.why.join(' ')).toMatch(/not the sound of any recording/);
    expect(r.body.connection.why.at(-1)).toBe('No recording has been checked yet.');
    noLeaks(app.snapshots);
  });

  it('the consumed plan changes with the Qloo pool: swap, remove and outside anchors', async () => {
    const x = recordingCatalogue();
    const appX = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, pool: POOL_X }), catalogue: x.seam });
    const a = await appX.ready(['Generic Artist']);
    await appX.discover(a.cookie, a.snap.brief!.handle);

    const y = recordingCatalogue();
    const appY = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, pool: POOL_Y }), catalogue: y.seam });
    const b = await appY.ready(['Generic Artist']);
    await appY.discover(b.cookie, b.snap.brief!.handle);
    expect(x.handoffs[0]!.allowedArtists.map((a) => a.name)).not.toEqual(y.handoffs[0]!.allowedArtists.map((a) => a.name));
    expect(y.handoffs[0]!.allowedArtists.map((a) => a.name)).toEqual(['Neighbour Y21', 'Neighbour Y22']);

    const none = recordingCatalogue();
    const appNone = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, pool: [] }), catalogue: none.seam });
    const c = await appNone.ready(['Generic Artist']);
    const r = await appNone.discover(c.cookie, c.snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'pool_empty', connection: null });
    expect(none.handoffs).toHaveLength(0);

    // A seed returned inside Insights is excluded; only returned neighbours are allowed anchors.
    const seedEcho = recordingCatalogue();
    const appEcho = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, pool: [SEED, ...POOL_Y] }), catalogue: seedEcho.seam });
    const d = await appEcho.ready(['Generic Artist']);
    await appEcho.discover(d.cookie, d.snap.brief!.handle);
    expect(seedEcho.handoffs[0]!.allowedArtists.map((a) => a.name)).toEqual(['Neighbour Y21', 'Neighbour Y22']);
  });

  it('optional tag failure yields artists-only capability without another query', async () => {
    for (const tagStatus of [400, 503]) {
      const cat = recordingCatalogue();
      const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, tags: tagStatus }), catalogue: cat.seam });
      const { cookie, snap } = await app.ready(['Generic Artist']);
      const r = await app.discover(cookie, snap.brief!.handle);
      expect(app.calls).toHaveLength(3);
      expect(r.body.connection).toMatchObject({ capability: 'artists_only', tags: [] });
      expect(r.body.connection.why.join(' ')).toMatch(/Tag associations were not available/);
      expect(cat.handoffs[0]!.associations).toEqual([]);
    }
  });

  it('a failed required artist call is an honest recovery, never model-only picks', async () => {
    const cat = recordingCatalogue();
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, artistStatus: 503 }), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'provider_unavailable', connection: null });
    expect(cat.handoffs).toHaveLength(0);
  });

  const SECRET_BODY = { error: { message: 'SECRET-PROVIDER-TEXT project-0001 quota detail https://provider.invalid/p?key=abc' } };
  const failing = (only: 'search' | 'artists', status: number): Responder => {
    const base = fixture({ search: { 'generic artist': [SEED] } });
    return (req) => (kind(req) === only ? json(status, SECRET_BODY) : base(req));
  };
  const serviceLeaks = (snapshots: string[]) => {
    noLeaks(snapshots);
    for (const s of snapshots) for (const text of ['SECRET-PROVIDER-TEXT', 'project-0001', 'provider.invalid', 'quota detail']) expect(s).not.toContain(text);
  };

  it('names a Qloo 429/503 on the required call as the service limit or outage, with unchanged counts and no retry or fallback', async () => {
    for (const [status, code, only, calls] of [
      [429, 'provider_limited', 'artists', ['artists', 'search', 'tags']],
      [503, 'provider_unavailable', 'artists', ['artists', 'search', 'tags']],
      [429, 'provider_limited', 'search', ['search']],
      [503, 'provider_unavailable', 'search', ['search']],
    ] as const) {
      const cat = recordingCatalogue();
      const app = await setup({ respond: failing(only, status), catalogue: cat.seam });
      const { cookie, snap } = await app.ready(['Generic Artist']);
      const r = await app.discover(cookie, snap.brief!.handle);
      expect(r.body).toMatchObject({ stage: 'failed', code, connection: null, panel: null });
      expect(app.calls.map(kind).sort()).toEqual([...calls]);
      expect(app.store.serviceUsage().qloo).toBe(calls.length);
      expect(cat.handoffs).toHaveLength(0);
      // Restoration reads the same closed code, and reading is never a retry.
      expect(await app.state(cookie)).toMatchObject({ stage: 'failed', code });
      expect(app.calls).toHaveLength(calls.length);
      serviceLeaks(app.snapshots);
    }
  });

  it('keeps the generic recovery for other Qloo failures and the partial-pool behaviour for an optional tag call', async () => {
    for (const status of [400, 401, 500]) {
      const app = await setup({ respond: failing('artists', status) });
      const { cookie, snap } = await app.ready(['Generic Artist']);
      expect((await app.discover(cookie, snap.brief!.handle)).body).toMatchObject({ stage: 'failed', code: 'qloo_failed' });
    }
    for (const tagStatus of [429, 503]) {
      const cat = recordingCatalogue();
      const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, tags: tagStatus }), catalogue: cat.seam });
      const { cookie, snap } = await app.ready(['Generic Artist']);
      const r = await app.discover(cookie, snap.brief!.handle);
      expect(app.calls).toHaveLength(3);
      expect(r.body).toMatchObject({ code: 'catalogue_not_configured', connection: { capability: 'artists_only', tags: [] } });
      expect(cat.handoffs[0]!.associations).toEqual([]);
    }
  });

  it('Stop wins over a late Qloo 429, and the dispatched call stays counted', async () => {
    const { gate, release } = fixtureHttp.gate();
    const base = fixture({ search: { 'generic artist': [SEED] } });
    const app = await setup({
      respond: async (req) => {
        if (kind(req) !== 'artists') return base(req);
        await gate;
        return json(429, SECRET_BODY);
      },
    });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const k = app.key();
    const running = app.send('POST', '/api/discover', { body: { brief: snap.brief!.handle, actionKey: k }, cookie });
    for (let i = 0; i < 100 && !app.calls.some((c) => kind(c) === 'artists'); i += 1) await new Promise((r) => setTimeout(r, 5));
    expect((await app.send('POST', '/api/stop', { body: { actionKey: k }, cookie })).body.stage).toBe('cancelled');
    await running;
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(await app.state(cookie)).toMatchObject({ stage: 'cancelled', code: 'cancelled' });
    expect(app.store.serviceUsage().qloo).toBe(3);
    serviceLeaks(app.snapshots);
  });

  it('an unknown artist gives an honest no-seed outcome without Insights', async () => {
    const app = await setup({ respond: fixture({ search: {} }) });
    const { cookie, snap } = await app.ready(['Nobody Invented']);
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'no_seed' });
    expect(app.calls.map(kind)).toEqual(['search']);
  });

  it('a joint seed mix is attributed to the mix, not to one seed', async () => {
    const cat = recordingCatalogue();
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED], 'other artist': [SECOND] } }), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Generic Artist', 'Other Artist']);
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(app.calls.filter((c) => kind(c) === 'search')).toHaveLength(2);
    const artistReq = app.calls.find((c) => kind(c) === 'artists')!;
    expect(artistReq.url.searchParams.get('signal.interests.entities')).toBe(`${SEED.entity_id},${SECOND.entity_id}`);
    expect(r.body.connection.why.join(' ')).toMatch(/for that seed mix/);
    expect(cat.handoffs[0]!.seedMix).toEqual(['Generic Artist', 'Other Artist']);
  });
});

describe('identity checkpoint, resumption and handles', () => {
  it('ends the execute at awaiting_artist and resumes without repeating the Search', async () => {
    const cat = recordingCatalogue();
    const app = await setup({ respond: fixture({ search: { 'shared name': [NAMESAKE_A, NAMESAKE_B] } }), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Shared Name']);
    const first = await app.discover(cookie, snap.brief!.handle);
    expect(first.body).toMatchObject({ stage: 'awaiting_artist', status: 'artist_choices_ready' });
    expect(first.body.attempt).toMatchObject({ kind: 'discover', active: false, outcome: 'succeeded' });
    const slot = first.body.identity.slots[0];
    expect(slot).toMatchObject({ proposal: 'Shared Name', status: 'ambiguous', chosen: null });
    expect(slot.options.map((o: { disambiguation: string }) => o.disambiguation)).toEqual(['Invented trio, 1990s', 'Invented soloist']);
    expect(app.calls.map(kind)).toEqual(['search']);

    expect((await app.discover(cookie, snap.brief!.handle)).body.error).toBe('not_ready');
    const choose = (choice: string | null, c = cookie, checkpoint = first.body.identity.handle) =>
      app.choose({ body: { checkpoint, slot: 0, choice }, cookie: c });
    expect((await choose('b'.repeat(24))).status).toBe(422);
    expect((await choose(uid(3))).status).toBe(400);
    expect((await choose(null)).body.identity.slots[0].status).toBe('skipped');
    const chosen = await choose(slot.options[1].handle);
    expect(chosen.body.identity.slots[0]).toMatchObject({ status: 'ambiguous', chosen: slot.options[1].handle });
    expect(app.calls).toHaveLength(1);

    const cont = await app.discover(cookie, snap.brief!.handle);
    expect(cont.body).toMatchObject({ stage: 'failed', code: 'catalogue_not_configured' });
    expect(app.calls.map(kind).sort()).toEqual(['artists', 'search', 'tags']);
    expect(app.calls.find((c) => kind(c) === 'artists')!.url.searchParams.get('signal.interests.entities')).toBe(NAMESAKE_B.entity_id);
    expect(cat.handoffs[0]!.seedMix).toEqual(['Shared Name']);
    noLeaks(app.snapshots);
  });

  it('rejects cross-session and stale checkpoint handles', async () => {
    const app = await setup({ respond: fixture({ search: { 'shared name': [NAMESAKE_A, NAMESAKE_B] } }) });
    const a = await app.ready(['Shared Name']);
    const b = await app.ready(['Shared Name']);
    const awaitA = await app.discover(a.cookie, a.snap.brief!.handle);
    await app.discover(b.cookie, b.snap.brief!.handle);
    const optionA = awaitA.body.identity.slots[0].options[0].handle;
    const cross = await app.choose({
      body: { checkpoint: awaitA.body.identity.handle, slot: 0, choice: optionA },
      cookie: b.cookie,
    });
    expect(cross.status).toBe(404);

    // Saving a new brief makes the old checkpoint stale.
    await app.savePref({ body: { analysis: a.snap.analysis!.handle, relationship: { text: 'changed' }, artists: ['Shared Name'] }, cookie: a.cookie });
    const stale = await app.choose({ body: { checkpoint: awaitA.body.identity.handle, slot: 0, choice: optionA }, cookie: a.cookie });
    expect(stale.status).toBe(409);
  });

  it('skipping every artist ends honestly with no Insights call', async () => {
    const app = await setup({ respond: fixture({ search: { 'shared name': [NAMESAKE_A, NAMESAKE_B] } }) });
    const { cookie, snap } = await app.ready(['Shared Name']);
    const first = await app.discover(cookie, snap.brief!.handle);
    await app.choose({ body: { checkpoint: first.body.identity.handle, slot: 0, choice: null }, cookie });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'no_seed' });
    expect(app.calls.map(kind)).toEqual(['search']);
  });

  it('resumes after a restart with a fresh Qloo client from serialised owned records, with zero extra Searches', async () => {
    class SerialisingStore extends MemoryStore {
      override async loadDiscoverContext(owner: Owner, attemptId: Handle, now: number) {
        const ctx = await super.loadDiscoverContext(owner, attemptId, now);
        return ctx === null ? null : (JSON.parse(JSON.stringify(ctx)) as DiscoverContext);
      }
    }
    const app = await setup({
      respond: fixture({ search: { 'shared name': [NAMESAKE_A, NAMESAKE_B] } }),
      store: new SerialisingStore({ maxSessions: 10, maxJourneysPerSession: 3 }),
    });
    const { cookie, snap } = await app.ready(['Shared Name']);
    const first = await app.discover(cookie, snap.brief!.handle);
    await app.choose({
      body: { checkpoint: first.body.identity.handle, slot: 0, choice: first.body.identity.slots[0].options[0].handle },
      cookie,
    });
    const before = app.calls.length;
    app.restart(fixture({ search: {} }));
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'catalogue_not_configured' });
    const after = app.calls.slice(before);
    expect(after.map(kind).sort()).toEqual(['artists', 'tags']);
    expect(after.find((c) => kind(c) === 'artists')!.url.searchParams.get('signal.interests.entities')).toBe(NAMESAKE_A.entity_id);
  });

  it('rejects an intact identity transplanted from another Search during continuation', async () => {
    class TransplantingStore extends MemoryStore {
      override async loadDiscoverContext(owner: Owner, attemptId: Handle, now: number) {
        const ctx = await super.loadDiscoverContext(owner, attemptId, now);
        if (!ctx || ctx.searches.length < 2) return ctx;
        const copy = structuredClone(ctx);
        const shared = copy.searches.find((s) => s.query === 'Shared Name')!;
        const other = copy.searches.find((s) => s.query === 'Other Artist')!;
        Object.assign(shared.candidates[0]!, { identity: other.candidates[0]!.identity });
        return copy;
      }
    }
    const app = await setup({
      respond: fixture({ search: { 'shared name': [NAMESAKE_A, NAMESAKE_B], 'other artist': [SECOND] } }),
      store: new TransplantingStore({ maxSessions: 10, maxJourneysPerSession: 3 }),
    });
    const { cookie, snap } = await app.ready(['Shared Name', 'Other Artist']);
    const first = await app.discover(cookie, snap.brief!.handle);
    await app.choose({ body: { checkpoint: first.body.identity.handle, slot: 0, choice: first.body.identity.slots[0].options[0].handle }, cookie });
    const result = await app.discover(cookie, snap.brief!.handle);
    expect(result.body).toMatchObject({ stage: 'failed', code: 'stale_version' });
    expect(app.calls.map(kind)).toEqual(['search', 'search']);
  });

  it('a tampered stored identity is rejected before any Insights transport call', async () => {
    class TamperingStore extends MemoryStore {
      override async loadDiscoverContext(owner: Owner, attemptId: Handle, now: number) {
        const ctx = await super.loadDiscoverContext(owner, attemptId, now);
        if (!ctx) return null;
        const copy = JSON.parse(JSON.stringify(ctx)) as { searches: { candidates: { identity: { entityId: string } }[] }[] };
        for (const s of copy.searches) for (const c of s.candidates) c.identity.entityId = uid(999);
        return copy as unknown as DiscoverContext;
      }
    }
    const app = await setup({
      respond: fixture({ search: { 'shared name': [NAMESAKE_A, NAMESAKE_B] } }),
      store: new TamperingStore({ maxSessions: 10, maxJourneysPerSession: 3 }),
    });
    const { cookie, snap } = await app.ready(['Shared Name']);
    const first = await app.discover(cookie, snap.brief!.handle);
    await app.choose({
      body: { checkpoint: first.body.identity.handle, slot: 0, choice: first.body.identity.slots[0].options[0].handle },
      cookie,
    });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'stale_version' });
    expect(app.calls.map(kind)).toEqual(['search']);
  });
});

describe('owned identity rehydration boundary', () => {
  const owner = { sessionId: 'session-handle-000000001' as Handle, epoch: 1, journeyId: 'journey-handle-000000001' as Handle, expiresAt: 10_000 };
  const artist = Object.freeze({
    entityId: uid(7) as QlooArtistId,
    name: 'Generic Artist',
    subtypeEvidence: 'subtype' as const,
    disambiguation: null,
    external: {},
    affinity: null,
  }) satisfies QlooArtist;

  it('accepts a JSON-roundtripped record under a fresh sealer instance and drives a fresh client with zero Searches', async () => {
    const stored = JSON.parse(
      JSON.stringify(sealIdentity(artist, { operation: 'search', sourceRecordId: 'search-handle-0000000001' as Handle }, owner, createRecordSealer(new ServerSecret(SEAL_KEY)))),
    );
    const seed = rehydrateIdentity(stored, owner, 5_000, createRecordSealer(new ServerSecret(SEAL_KEY)));
    expect(seed).toEqual({ entityId: uid(7), name: 'Generic Artist', external: {} });
    expect(Object.isFrozen(seed)).toBe(true);

    const calls: ProviderRequest[] = [];
    const client = createQlooClient({
      transport: async (req) => (calls.push(req), json(200, { success: true, results: { entities: POOL_Y } })),
      apiKey: new ServerSecret(KEY),
      host: 'api.qloo.com',
    });
    await client.artistInsights({ seedIds: [seed!.entityId], take: 15 }, new AbortController().signal);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v2/insights']);
  });

  it('rejects forged, foreign, stale, expired, re-keyed and extended records', () => {
    const sealer = createRecordSealer(new ServerSecret(SEAL_KEY));
    const good = JSON.parse(JSON.stringify(sealIdentity(artist, { operation: 'search', sourceRecordId: 'search-handle-0000000001' as Handle }, owner, sealer)));
    expect(rehydrateIdentity(good, owner, 5_000, sealer)).not.toBeNull();
    const cases: [unknown, typeof owner, number][] = [
      [{ ...good, entityId: uid(8) }, owner, 5_000],
      [{ ...good, name: 'Someone Else' }, owner, 5_000],
      [{ ...good, owner: { ...good.owner, sessionId: 'session-handle-000000002' } }, owner, 5_000],
      [good, { ...owner, sessionId: 'session-handle-000000002' as Handle }, 5_000],
      [good, { ...owner, epoch: 2 }, 5_000],
      [good, { ...owner, journeyId: 'journey-handle-000000002' as Handle }, 5_000],
      [good, owner, 10_000],
      [{ ...good, extra: true }, owner, 5_000],
      [{ ...good, entityId: 'not-a-uuid' }, owner, 5_000],
      [{ ...good, seal: 'x'.repeat(43) }, owner, 5_000],
    ];
    for (const [raw, o, now] of cases) expect(rehydrateIdentity(raw, o, now, sealer)).toBeNull();
    expect(rehydrateIdentity(good, owner, 5_000, createRecordSealer(new ServerSecret('another-seal-key-for-tests-0000001')))).toBeNull();
  });
});

describe('admission, counting, idempotency and cancellation', () => {
  it('binds concurrent identical Discover requests to one run and refuses a different concurrent one', async () => {
    const { gate, release } = fixtureHttp.gate();
    const base = fixture({ search: { 'generic artist': [SEED] } });
    const app = await setup({ respond: async (req) => (kind(req) === 'search' ? (await gate, base(req)) : base(req)) });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const k = app.key();
    const one = app.discover(cookie, snap.brief!.handle, k);
    const two = app.discover(cookie, snap.brief!.handle, k);
    await new Promise((r) => setTimeout(r, 30));
    const other = await app.discover(cookie, snap.brief!.handle);
    expect(other.body.error).toBe('operation_active');
    release();
    const [r1, r2] = await Promise.all([one, two]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(app.calls.filter((c) => kind(c) === 'search')).toHaveLength(1);
  });

  it('Stop before the next dispatch prevents Insights; the Search stays counted', async () => {
    const { gate, release } = fixtureHttp.gate();
    const base = fixture({ search: { 'generic artist': [SEED] } });
    const app = await setup({ respond: async (req) => (kind(req) === 'search' ? (await gate, base(req)) : base(req)) });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const k = app.key();
    const running = app.discover(cookie, snap.brief!.handle, k);
    await new Promise((r) => setTimeout(r, 30));
    const stopped = await app.send('POST', '/api/stop', { body: { actionKey: k }, cookie });
    expect(stopped.body.stage).toBe('cancelled');
    expect((await running).body.stage).toBe('cancelled');
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(app.calls.map(kind)).toEqual(['search']);
    expect(app.store.serviceUsage().qloo).toBe(1);
    expect((await app.state(cookie)).connection).toBeNull();
  });

  it('an edit during Insights revokes the run before commit; no plan for the old version', async () => {
    const { gate, release } = fixtureHttp.gate();
    const cat = recordingCatalogue();
    const base = fixture({ search: { 'generic artist': [SEED] } });
    const app = await setup({ respond: async (req) => (kind(req) === 'artists' ? (await gate, base(req)) : base(req)), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const running = app.discover(cookie, snap.brief!.handle);
    await new Promise((r) => setTimeout(r, 30));
    const edit = await app.savePref({
      body: { analysis: snap.analysis!.handle, relationship: { text: 'something else' }, artists: ['Generic Artist'] },
      cookie,
    });
    expect(edit.body.brief.version).toBe(2);
    release();
    const done = await running;
    expect(done.body.connection).toBeNull();
    expect(cat.handoffs).toHaveLength(0);
    expect(done.body.brief.version).toBe(2);
  });

  it('refuses a fresh-key resend after an actual failed HTTP response without changing counts or dispatching', async () => {
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED] }, artistStatus: 400 }) });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const first = await app.discover(cookie, snap.brief!.handle);
    expect(first.body).toMatchObject({ stage: 'failed', code: 'qloo_failed', discovery: 'unavailable' });
    const calls = app.calls.length;
    const counts = app.store.serviceUsage();
    const next = await app.discover(cookie, snap.brief!.handle);
    expect(next.status).toBe(409);
    expect(next.body.error).toBe('discovery_retry_unavailable');
    expect(app.calls).toHaveLength(calls);
    expect(app.store.serviceUsage()).toEqual(counts);
    expect((await app.state(cookie)).attempt).toEqual(first.body.attempt);
  });

  it('reuses completed Searches across versions and enforces one retry plus the shared Qloo cap', async () => {
    const app = await setup({
      // A known empty pool permits one materially changed artist correction; a generic failed submission does not.
      respond: fixture({ pool: [], search: { 'generic artist': [SEED], 'other artist': [SECOND], 'third artist': [{ ...SECOND, entity_id: uid(5), name: 'Third Artist' }], 'fourth artist': [{ ...SECOND, entity_id: uid(6), name: 'Fourth Artist' }] } }),
    });
    const { cookie, snap } = await app.ready(['Generic Artist', 'Other Artist']);
    await app.discover(cookie, snap.brief!.handle);
    expect(app.calls).toHaveLength(4);
    const v2 = await app.savePref({
      body: { analysis: snap.analysis!.handle, relationship: { text: 'new direction' }, artists: ['Third Artist', 'Fourth Artist'] },
      cookie,
    });
    const r = await app.discover(cookie, v2.body.brief.handle);
    // Two new Searches reach the cap of 6; the required artist Insights is refused before transport.
    expect(r.body).toMatchObject({ stage: 'failed', code: 'capacity' });
    expect(app.calls).toHaveLength(6);
    expect(app.store.serviceUsage().qloo).toBe(6);
    const third = await app.discover(cookie, v2.body.brief.handle);
    expect(third.body.error).toBe('discovery_used');

    // Clear does not reset service accounting.
    await app.send('DELETE', '/api/session', { cookie });
    expect(app.store.serviceUsage().qloo).toBe(6);
  });

  it('rejects a stale brief handle and a foreign session brief', async () => {
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED] } }) });
    const a = await app.ready(['Generic Artist']);
    const b = await app.ready(['Generic Artist']);
    expect((await app.discover(a.cookie, b.snap.brief!.handle)).body.error).toBe('stale_version');
    await app.savePref({ body: { analysis: a.snap.analysis!.handle, relationship: { text: 'v2' }, artists: ['Generic Artist'] }, cookie: a.cookie });
    expect((await app.discover(a.cookie, a.snap.brief!.handle)).body.error).toBe('stale_version');
    expect(app.calls).toHaveLength(0);
  });
});

describe('free-action identity and optimistic guards', () => {
  it('an exact replay of an earlier save never reactivates it; a new deliberate action may reselect its version', async () => {
    const app = await setup();
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const v1 = snap.brief!.handle;
    const reqA = { actionKey: app.key(), expectedBrief: v1, analysis: snap.analysis!.handle, relationship: { text: 'keep A' }, artists: ['Generic Artist'] };
    const a = await app.send('POST', '/api/preference', { body: reqA, cookie });
    expect(a.body.brief).toMatchObject({ version: 2, relationship: 'keep A' });
    const b = await app.send('POST', '/api/preference', {
      body: { ...reqA, actionKey: app.key(), expectedBrief: a.body.brief.handle, relationship: { text: 'keep B' } },
      cookie,
    });
    expect(b.body.brief).toMatchObject({ version: 3, relationship: 'keep B' });
    const revision = b.body.revision;

    const replayA = await app.send('POST', '/api/preference', { body: reqA, cookie });
    expect(replayA.status).toBe(409);
    expect(replayA.body.error).toBe('stale_operation');
    const after = await app.state(cookie);
    expect(after.brief).toMatchObject({ version: 3, relationship: 'keep B' });
    expect(after.revision).toBe(revision);

    // Same key, different input.
    const conflict = await app.send('POST', '/api/preference', { body: { ...reqA, relationship: { text: 'other' } }, cookie });
    expect(conflict.body.error).toBe('action_conflict');

    // A genuinely new deliberate action reselects A and reuses its immutable version.
    const reqReselect = { ...reqA, actionKey: app.key(), expectedBrief: b.body.brief.handle };
    const reselect = await app.send('POST', '/api/preference', { body: reqReselect, cookie });
    expect(reselect.body.brief).toMatchObject({ handle: a.body.brief.handle, version: 2 });
    // Its exact replay while its result is still current is a harmless no-op.
    const replayCurrent = await app.send('POST', '/api/preference', { body: reqReselect, cookie });
    expect(replayCurrent.status).toBe(200);
    expect(replayCurrent.body.revision).toBe(reselect.body.revision);
    // A new action based on an out-of-date version is refused.
    const staleBasis = await app.send('POST', '/api/preference', { body: { ...reqA, actionKey: app.key(), expectedBrief: b.body.brief.handle }, cookie });
    expect(staleBasis.body.error).toBe('stale_version');
  });

  it('rejects saves based on an out-of-date version, so concurrent edits cannot silently overwrite each other', async () => {
    const app = await setup();
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const base = { expectedBrief: snap.brief!.handle, analysis: snap.analysis!.handle, artists: ['Generic Artist'] };
    const [x, y] = await Promise.all([
      app.send('POST', '/api/preference', { body: { ...base, actionKey: app.key(), relationship: { text: 'tab one' } }, cookie }),
      app.send('POST', '/api/preference', { body: { ...base, actionKey: app.key(), relationship: { text: 'tab two' } }, cookie }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error).toBe('stale_version');
    expect((await app.state(cookie)).brief!.version).toBe(2);
    // Missing guard or key is a bad request, not an implicit overwrite.
    expect((await app.send('POST', '/api/preference', { body: { ...base, actionKey: app.key(), expectedBrief: undefined, relationship: { text: 'z' } }, cookie })).status).toBe(400);
    expect((await app.send('POST', '/api/preference', { body: { ...base, relationship: { text: 'z' } }, cookie })).status).toBe(400);
  });

  it('keeps free action keys per session and refuses expired sessions', async () => {
    const clock = { t: 1_000_000 };
    const app = await setup({ clock });
    const a = await app.ready(['Generic Artist']);
    const b = await app.ready(['Generic Artist']);
    const key = app.key();
    const body = { actionKey: key, expectedBrief: a.snap.brief!.handle, analysis: a.snap.analysis!.handle, relationship: { text: 'mine' }, artists: [] };
    expect((await app.send('POST', '/api/preference', { body, cookie: a.cookie })).status).toBe(200);
    const foreign = await app.send('POST', '/api/preference', { body, cookie: b.cookie });
    expect(foreign.status).toBe(409);
    expect((await app.state(b.cookie)).brief!.version).toBe(1);
    clock.t += 60 * 60 * 1000;
    expect((await app.send('POST', '/api/preference', { body: { ...body, actionKey: app.key() }, cookie: a.cookie })).status).toBe(401);
  });

  it('artist choose/skip/change: stale replays, stale revisions and unchanged choices never move intent', async () => {
    const app = await setup({ respond: fixture({ search: { 'shared name': [NAMESAKE_A, NAMESAKE_B] } }) });
    const { cookie, snap } = await app.ready(['Shared Name']);
    const first = await app.discover(cookie, snap.brief!.handle);
    const cp = first.body.identity.handle;
    const [optA, optB] = first.body.identity.slots[0].options.map((o: { handle: string }) => o.handle);
    const chooseA = { actionKey: app.key(), checkpoint: cp, slot: 0, choice: optA, expectedRevision: 0 };
    const a = await app.send('POST', '/api/artist-choice', { body: chooseA, cookie });
    expect(a.body.identity).toMatchObject({ revision: 1, slots: [{ chosen: optA }] });
    // Exact replay while current: no-op.
    expect((await app.send('POST', '/api/artist-choice', { body: chooseA, cookie })).body.identity.revision).toBe(1);
    const b = await app.send('POST', '/api/artist-choice', { body: { ...chooseA, actionKey: app.key(), choice: optB, expectedRevision: 1 }, cookie });
    expect(b.body.identity).toMatchObject({ revision: 2, slots: [{ chosen: optB }] });

    const replay = await app.send('POST', '/api/artist-choice', { body: chooseA, cookie });
    expect(replay.body.error).toBe('stale_operation');
    const staleBasis = await app.send('POST', '/api/artist-choice', { body: { ...chooseA, actionKey: app.key(), choice: null, expectedRevision: 1 }, cookie });
    expect(staleBasis.body.error).toBe('stale_version');
    const unchanged = await app.send('POST', '/api/artist-choice', { body: { ...chooseA, actionKey: app.key(), choice: optB, expectedRevision: 2 }, cookie });
    expect(unchanged.body.identity.revision).toBe(2);
    const skip = await app.send('POST', '/api/artist-choice', { body: { ...chooseA, actionKey: app.key(), choice: null, expectedRevision: 2 }, cookie });
    expect(skip.body.identity).toMatchObject({ revision: 3, slots: [{ status: 'skipped', chosen: null }] });
    expect((await app.state(cookie)).identity).toMatchObject({ revision: 3, slots: [{ status: 'skipped' }] });
    expect(app.calls.map(kind)).toEqual(['search']);
  });
});

describe('unchanged saves never cancel paid work', () => {
  it('an identical save or exact replay during held Insights leaves the run to complete', async () => {
    const { gate, release } = fixtureHttp.gate();
    const cat = recordingCatalogue();
    const base = fixture({ search: { 'generic artist': [SEED] } });
    const app = await setup({ respond: async (req) => (kind(req) === 'artists' ? (await gate, base(req)) : base(req)), catalogue: cat.seam });
    const cookie = await app.newSession();
    const ref = await app.send('POST', '/api/reference', { body: { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: app.key() }, cookie });
    const original = { actionKey: app.key(), expectedBrief: null, analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist'] };
    const saved = await app.send('POST', '/api/preference', { body: original, cookie });
    const brief = saved.body.brief.handle;

    const running = app.discover(cookie, brief);
    await new Promise((r) => setTimeout(r, 30));
    expect(app.calls.map(kind)).toContain('artists');

    const identical = await app.send('POST', '/api/preference', { body: { ...original, actionKey: app.key(), expectedBrief: brief }, cookie });
    expect(identical.status).toBe(200);
    expect(identical.body.brief.handle).toBe(brief);
    expect(identical.body.attempt).toMatchObject({ kind: 'discover', active: true });
    const replay = await app.send('POST', '/api/preference', { body: original, cookie });
    expect(replay.status).toBe(200);
    expect(replay.body.attempt.active).toBe(true);

    release();
    const done = await running;
    expect(done.body).toMatchObject({ stage: 'failed', code: 'catalogue_not_configured' });
    expect(done.body.connection.artists).toEqual(['Neighbour X11', 'Neighbour X12', 'Neighbour X13']);
    expect(cat.handoffs).toHaveLength(1);
  });
});

describe('canonical supported-identity filtering', () => {
  const sp = (n: number) => [{ id: String(n).padStart(22, '0') }];
  const SEED_SP = { ...SEED, external: { spotify: sp(1) } };
  const neighbour = (n: number, name: string, external?: unknown) => ({ entity_id: uid(n), name, subtype: 'urn:entity:artist', ...(external ? { external } : {}) });

  it('removes input aliases (direct and transitive), collapses duplicate neighbours and ignores unsupported evidence', async () => {
    const cat = recordingCatalogue();
    const pool = [
      neighbour(30, 'Seed Alias Upload', { spotify: sp(1) }),
      neighbour(31, 'Neighbour One', { spotify: sp(10) }),
      neighbour(32, 'Neighbour One Duplicate', { spotify: sp(10) }),
      neighbour(33, 'Neighbour Two'),
      neighbour(34, 'Neighbour Three', { spotify: sp(11), musicbrainz: [{ id: 'a1b2c3d4-0000-4000-8000-0000000000b1' }] }),
      neighbour(35, 'Neighbour Three Alias', { musicbrainz: [{ id: 'a1b2c3d4-0000-4000-8000-0000000000b1' }] }),
      neighbour(36, 'Bridge Alias', { spotify: sp(1), wikidata: [{ id: 'Q4242' }] }),
      neighbour(37, 'Hidden Seed Alias', { wikidata: [{ id: 'Q4242' }] }),
      neighbour(38, 'Unsupported Evidence', { homepage: [{ id: '0000000000000000000001' }], spotify: [{ id: 'https://example.invalid/0000000000000000000001' }] }),
      neighbour(39, 'Generic Artist'),
    ];
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED_SP] }, pool }), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body.code).toBe('catalogue_not_configured');
    // A namesake spelled like the seed but without shared supported evidence is a different artist.
    expect(cat.handoffs[0]!.allowedArtists.map((a) => a.name)).toEqual([
      'Neighbour One',
      'Neighbour Two',
      'Neighbour Three',
      'Unsupported Evidence',
      'Generic Artist',
    ]);
    noLeaks(app.snapshots);
  });

  it('returns honest empty coverage when every returned artist is an input alias', async () => {
    const cat = recordingCatalogue();
    const pool = [neighbour(40, 'Alias A', { spotify: sp(1) }), neighbour(41, 'Alias B', { spotify: sp(1) })];
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED_SP] }, pool }), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'pool_empty', connection: null });
    expect(cat.handoffs).toHaveLength(0);
  });

  it('deduplicates equivalent seeds before Insights', async () => {
    const cat = recordingCatalogue();
    const alias = { entity_id: uid(50), name: 'Generic Alias', subtype: 'urn:entity:artist', external: { spotify: sp(1) } };
    const app = await setup({ respond: fixture({ search: { 'generic artist': [SEED_SP], 'generic alias': [alias] } }), catalogue: cat.seam });
    const { cookie, snap } = await app.ready(['Generic Artist', 'Generic Alias']);
    await app.discover(cookie, snap.brief!.handle);
    expect(app.calls.find((c) => kind(c) === 'artists')!.url.searchParams.get('signal.interests.entities')).toBe(SEED.entity_id);
    expect(cat.handoffs[0]!.seedMix).toEqual(['Generic Artist']);
  });

  it('removes verified explicit exclusions and keeps evidence across a bounded chain', () => {
    const ev = (n: number, external: Record<string, string[]> = {}) => ({ entityId: uid(n), external });
    const result = canonicalFilter({
      seeds: [ev(1, { spotify: ['0000000000000000000001'] })],
      exclusions: [ev(2, { wikidata: ['Q7'] })],
      candidates: [
        { identity: ev(3, { wikidata: ['Q7'] }) },
        { identity: ev(4, { spotify: ['0000000000000000000009'], wikidata: ['Q8'] }) },
        { identity: ev(5, { wikidata: ['Q8'], musicbrainz: ['a1b2c3d4-0000-4000-8000-0000000000c1'] }) },
        { identity: ev(6, { musicbrainz: ['a1b2c3d4-0000-4000-8000-0000000000c1'] }) },
        { identity: ev(7, { other: ['0000000000000000000001'] }) },
      ],
    });
    expect(result.candidates.map((c) => c.identity.entityId)).toEqual([uid(4), uid(7)]);
    expect(result).toMatchObject({ aliasesRemoved: 1, duplicatesRemoved: 2 });
    expect(() => canonicalFilter({ seeds: [], exclusions: [], candidates: Array.from({ length: 65 }, (_, i) => ({ identity: ev(i) })) })).toThrow(RangeError);
  });
});

describe('free-mutation limiter', () => {
  it('limits saves per session in a bounded window; Stop and Clear stay exempt', async () => {
    const clock = { t: 1_000_000 };
    const store = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 3, freeMutation: { perSession: 3, perService: 50, windowMs: 1000 } });
    const app = await setup({ clock, store });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    const save = (text: string) => app.savePref({ body: { analysis: snap.analysis!.handle, relationship: { text }, artists: [] }, cookie });
    expect((await save('two')).status).toBe(200);
    expect((await save('three')).status).toBe(200);
    const limited = await save('four');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('rate_limited');
    expect((await app.send('POST', '/api/stop', { body: { actionKey: app.key() }, cookie })).status).toBe(200);
    clock.t += 1000;
    expect((await save('four')).status).toBe(200);
    for (let i = 0; i < 3; i += 1) await save(`burst ${i}`);
    expect((await app.send('DELETE', '/api/session', { cookie })).status).toBe(200);
  });

  it('limits free mutations service-wide across sessions, and Clear does not reset the window', async () => {
    const clock = { t: 1_000_000 };
    const store = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 3, freeMutation: { perSession: 10, perService: 4, windowMs: 1000 } });
    const app = await setup({ clock, store });
    const { cookie } = await app.ready(['Generic Artist']); // session create + save = 2
    const second = await app.newSession(); // 3
    expect(second).toMatch(/wintr_sid=/);
    await app.send('DELETE', '/api/session', { cookie });
    expect((await app.send('POST', '/api/session', { body: {} })).status).toBe(201); // 4
    const over = await app.send('POST', '/api/session', { body: {} });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('rate_limited');
    clock.t += 1000;
    expect((await app.send('POST', '/api/session', { body: {} })).status).toBe(201);
    expect(store.serviceUsage().qloo).toBe(0);
  });
});

describe('Discover -> native catalogue -> verified choice panel', () => {
  const TOKEN = 'invented-access-token-0001';
  type CatRespond = Parameters<typeof catalogueTransport>[0];
  const metaFor = (anchor: string, title: string) => ({ title: `${anchor} - ${title} (Official Audio)`, author_name: anchor });
  const X = ['Neighbour X11', 'Neighbour X12', 'Neighbour X13'];
  const three = X.map((anchor, i) => ({ title: `Invented Song ${i + 1}`, artists: [anchor], anchor, videoId: VID(i + 1) }));
  const threeMeta = Object.fromEntries(three.map((c) => [c.videoId, metaFor(c.anchor, c.title)]));

  async function nativeApp(o: { respond: CatRespond; meta: Record<string, MetaEntry>; pool?: unknown[]; dns?: Record<string, string[]>; store?: MemoryStore }) {
    const cat = catalogueTransport(o.respond);
    const net = fakeNetwork(o.meta, o.dns);
    const adapter = createGeminiCatalogueAdapter({
      transport: cat.transport,
      project: 'invented-project',
      quotaProject: 'invented-quota',
      accessToken: async () => new ServerSecret(TOKEN),
    });
    const verifier = createYouTubeVerifier({ resolve: net.resolve, http: net.http, now: Date.now });
    const app = await setup({
      respond: fixture({ search: { 'generic artist': [SEED] }, pool: o.pool ?? POOL_X }),
      catalogue: createNativeCatalogue({ adapter, verifier, sources: createSourceResolver({ resolve: net.resolve, http: net.http, now: Date.now }) }),
      store: o.store,
    });
    const { cookie, snap } = await app.ready(['Generic Artist']);
    return { app, cat, net, cookie, snap };
  }
  const prompt = (req: ProviderRequest) => JSON.parse(req.body!).contents[0].parts[0].text as string;

  it('commits a complete initial panel with Play links, verified credits, tied sources and isolated Suggestions', async () => {
    const { app, cat, net, cookie, snap } = await nativeApp({ respond: () => envelope(three), meta: threeMeta });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'complete', status: 'choices_ready', code: null });
    const panel = r.body.panel;
    expect(panel).toMatchObject({ synthetic: false, outcome: 'choices', gaps: [] });
    expect(panel.choices.map((c: { title: string; anchor: string; playUrl: string; sources: number[]; credits: string[] }) => [c.title, c.anchor, c.playUrl, c.sources, c.credits])).toEqual(
      three.map((c, i) => [c.title, c.anchor, `https://www.youtube.com/watch?v=${c.videoId}`, [i], [c.anchor]]),
    );
    expect(panel.citations.map((c: { title: string }) => c.title)).toEqual(['Invented source 1', 'Invented source 2', 'Invented source 3']);
    expect(panel.answer.text).toBe(buildAnswer(three).text);
    expect(r.body.connection.why.at(-1)).toBe('No recording has been checked yet.');

    // One counted catalogue generation shares the Gemini caps with the reference stage.
    expect(cat.calls).toHaveLength(1);
    expect(app.store.serviceUsage()).toMatchObject({ gemini: 2, qloo: 3 });
    expect(net.metadataRequests).toHaveLength(3);
    const p = prompt(cat.calls[0]!);
    for (const name of X) expect(p).toContain(name);
    expect(p).toContain(snap.brief!.relationship);
    expect(p).toContain('"do_not_choose_recordings_by": [\n    "Generic Artist"');
    // The model sees public names and the listener's words only: no provider IDs or owned handles.
    expect(p).not.toMatch(UUID_RE);
    expect(p).not.toMatch(/"ref"|"plan"|briefVersion|affinity/);

    // Isolated Suggestions: owned, sandboxed, CSP'd document.
    const sugg = await fixtureHttp.observe(new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: Number(app.config.origin.split(':').at(-1)), method: 'GET', path: panel.suggestionsUrl, headers: { host: app.config.hostHeader, cookie } },
        (res) => {
          res.on('error', reject);
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    }));
    expect(sugg.status).toBe(200);
    expect(sugg.headers['content-security-policy']).toBe(SUGGESTIONS_CSP);
    expect(sugg.headers['content-type']).toMatch(/text\/html/);
    expect(sugg.body).toContain('target="_blank" rel="noopener noreferrer"');
    const other = await app.newSession();
    const foreign = await app.send('GET', panel.suggestionsUrl, { cookie: other });
    expect(foreign.status).toBe(404);

    const all = app.snapshots.join('\n');
    for (const secret of [TOKEN, 'invented-project', 'invented-quota', 'recordingKey', 'channelName', 'x-goog', 'hidden reasoning', 'groundingSupports']) expect(all).not.toContain(secret);
    noLeaks(app.snapshots.filter((s) => !s.startsWith('<!doctype')));

    // The committed panel used this reference's discovery; refinement is a later shared allowance.
    expect((await app.discover(cookie, snap.brief!.handle)).body.error).toBe('discovery_used');
  });

  it('rejects a different non-Latin artist instead of treating it as an owned Qloo anchor', async () => {
    const owned = 'Invented 東京';
    const outside = 'Invented 大阪';
    const proposed = { title: 'Invented lantern', artists: [outside], anchor: outside, videoId: VID(1) };
    const { app, cat, net, cookie, snap } = await nativeApp({
      pool: [{ ...POOL_X[0]!, name: owned }],
      respond: () => envelope([proposed]),
      meta: { [VID(1)]: metaFor(outside, proposed.title) },
    });
    const result = await app.discover(cookie, snap.brief!.handle);
    expect(result.body).toMatchObject({ stage: 'no_match', panel: { choices: [], gaps: [{ reason: 'outside_anchor', count: 1 }] } });
    expect(result.body.connection.artists).toEqual([owned]);
    expect(prompt(cat.calls[0]!)).toContain(owned);
    expect(prompt(cat.calls[0]!)).not.toContain(outside);
    expect(net.metadataRequests).toHaveLength(0);
  });

  it('rejects a changed Unicode title and undeclared non-Latin credit in the complete discovery path', async () => {
    const proposed = [
      { ...three[0]!, title: 'Invented lantern 東京' },
      { ...three[1]!, title: 'Invented lantern' },
    ];
    const { app, net, cookie, snap } = await nativeApp({
      respond: () => envelope(proposed),
      meta: {
        [VID(1)]: metaFor(proposed[0]!.anchor, 'Invented lantern 大阪'),
        [VID(2)]: metaFor(`${proposed[1]!.anchor} & 未知`, proposed[1]!.title),
      },
    });
    const result = await app.discover(cookie, snap.brief!.handle);
    expect(result.body).toMatchObject({ stage: 'no_match', panel: { choices: [], gaps: [{ reason: 'title_mismatch', count: 1 }, { reason: 'credits_extra', count: 1 }] } });
    expect(net.metadataRequests).toHaveLength(2);
  });

  it('accepts an exactly supported non-Latin recording from the returned Qloo pool', async () => {
    const artist = '架空の演奏者';
    const proposed = { title: '仮想の灯', artists: [artist], anchor: artist, videoId: VID(1) };
    const { app, cat, net, cookie, snap } = await nativeApp({
      pool: [{ ...POOL_X[0]!, name: artist }],
      respond: () => envelope([proposed]),
      meta: { [VID(1)]: metaFor(artist, proposed.title) },
    });
    const result = await app.discover(cookie, snap.brief!.handle);
    expect(result.body).toMatchObject({ stage: 'complete', panel: { gaps: [] } });
    expect(result.body.panel.choices.map((c: { title: string; credits: string[]; anchor: string }) => [c.title, c.credits, c.anchor]))
      .toEqual([[proposed.title, [artist], artist]]);
    expect(prompt(cat.calls[0]!)).toContain(artist);
    expect(net.metadataRequests).toHaveLength(1);
  });

  it('returns fewer choices when metadata does not confirm a proposal, recording the precise gap', async () => {
    const meta = { ...threeMeta, [VID(2)]: { title: 'Neighbour X12 - Something Else', author_name: 'Neighbour X12' } };
    const { app, cookie, snap } = await nativeApp({ respond: () => envelope(three), meta });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body.stage).toBe('complete');
    expect(r.body.panel.choices.map((c: { title: string }) => c.title)).toEqual(['Invented Song 1', 'Invented Song 3']);
    expect(r.body.panel.gaps).toEqual([{ reason: 'title_mismatch', count: 1 }]);
  });

  it('accepts exact recording evidence without verified uploader affiliation while retaining version checks', async () => {
    const proposed = three[0]!;
    const unverifiedUploader = 'Invented independent uploader';
    const exact = await nativeApp({ respond: () => envelope([proposed]), meta: {
      [proposed.videoId]: { title: `${proposed.anchor} - ${proposed.title}`, author_name: unverifiedUploader },
    } });
    const result = await exact.app.discover(exact.cookie, exact.snap.brief!.handle);
    expect(result.body.panel.choices.map((c: { title: string; credits: string[] }) => [c.title, c.credits])).toEqual([[proposed.title, [proposed.anchor]]]);
    expect(result.body.panel.gaps).toEqual([]);
    const wrongVersion = await nativeApp({ respond: () => envelope([proposed]), meta: {
      [proposed.videoId]: { title: `${proposed.anchor} - ${proposed.title} (Live)`, author_name: unverifiedUploader },
    } });
    const rejected = await wrongVersion.app.discover(wrongVersion.cookie, wrongVersion.snap.brief!.handle);
    expect(rejected.body.panel.choices).toHaveLength(0);
    expect(rejected.body.panel.outcome).toBe('no_match');
  });

  it.each([false, true])('returns at most one recording per distinct Qloo anchor, without filling unused slots (%s)', async (includeSecondAnchor) => {
    const proposed = [
      three[0]!,
      { ...three[0]!, title: 'Another Invented Song', videoId: VID(8) },
      includeSecondAnchor ? three[1]! : { ...three[0]!, title: 'Third Invented Song', videoId: VID(9) },
    ];
    const meta = Object.fromEntries(proposed.map((c) => [c.videoId, metaFor(c.anchor, c.title)]));
    const { app, cat, net, cookie, snap } = await nativeApp({ respond: () => envelope(proposed), meta });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body.stage).toBe('complete');
    expect(r.body.panel.choices.map((c: { title: string }) => c.title)).toEqual(includeSecondAnchor ? ['Invented Song 1', 'Invented Song 2'] : ['Invented Song 1']);
    expect(r.body.panel.gaps).toEqual([]); // Valid surplus recordings are not failed evidence.
    expect(cat.calls).toHaveLength(1);
    expect(net.metadataRequests).toHaveLength(3);
    expect(app.store.serviceUsage()).toMatchObject({ gemini: 2, qloo: 3 });
  });

  it('commits an honest no-match: explicit no choice, or every proposal outside the owned pool', async () => {
    const none = await nativeApp({ respond: () => envelope([], { none: true, queries: [], chunks: [], rendered: null }), meta: {} });
    const a = await none.app.discover(none.cookie, none.snap.brief!.handle);
    expect(a.body).toMatchObject({ stage: 'no_match', status: 'choices_ready', panel: { outcome: 'no_match', choices: [] } });

    const outside = await nativeApp({
      respond: () => envelope([{ title: 'Invented Song', artists: ['Not In Pool'], anchor: 'Not In Pool', videoId: VID(9) }]),
      meta: { [VID(9)]: metaFor('Not In Pool', 'Invented Song') },
    });
    const b = await outside.app.discover(outside.cookie, outside.snap.brief!.handle);
    expect(b.body).toMatchObject({ stage: 'no_match', panel: { outcome: 'no_match', gaps: [{ reason: 'outside_anchor', count: 1 }] } });
    expect(outside.net.metadataRequests).toHaveLength(0);
  });

  it('the consumed allowed space follows the Qloo pool: swap, removal and outside anchors', async () => {
    const y = await nativeApp({
      pool: POOL_Y,
      respond: () =>
        envelope([
          { title: 'Invented Song 1', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(1) },
          { title: 'Invented Song 4', artists: ['Neighbour Y21'], anchor: 'Neighbour Y21', videoId: VID(4) },
        ]),
      meta: { [VID(1)]: metaFor('Neighbour X11', 'Invented Song 1'), [VID(4)]: metaFor('Neighbour Y21', 'Invented Song 4') },
    });
    const r = await y.app.discover(y.cookie, y.snap.brief!.handle);
    const p = prompt(y.cat.calls[0]!);
    expect(p).toContain('Neighbour Y21');
    expect(p).not.toContain('Neighbour X11');
    expect(r.body.panel.choices.map((c: { anchor: string }) => c.anchor)).toEqual(['Neighbour Y21']);
    expect(r.body.panel.gaps).toEqual([{ reason: 'outside_anchor', count: 1 }]);

    const empty = await nativeApp({ pool: [], respond: () => envelope(three), meta: threeMeta });
    const e = await empty.app.discover(empty.cookie, empty.snap.brief!.handle);
    expect(e.body).toMatchObject({ stage: 'failed', code: 'pool_empty', panel: null });
    expect(empty.cat.calls).toHaveLength(0);
  });

  it('accepts a verified collaboration with an outside credit and rejects duplicate uploads of one recording', async () => {
    const collab = { title: 'Invented Duet', artists: ['Neighbour X11', 'Outside Collaborator'], anchor: 'Neighbour X11', videoId: VID(5) };
    const dupA = { title: 'Invented Song 2', artists: ['Neighbour X12'], anchor: 'Neighbour X12', videoId: VID(6) };
    const dupB = { ...dupA, videoId: VID(7) };
    const sameVideo = { ...collab, title: 'Invented Duet', videoId: VID(5), anchor: 'Neighbour X11' };
    const { app, cookie, snap } = await nativeApp({
      respond: () => envelope([collab, dupA, dupB]),
      meta: {
        [VID(5)]: { title: 'Neighbour X11 & Outside Collaborator - Invented Duet', author_name: 'Neighbour X11' },
        [VID(6)]: metaFor('Neighbour X12', 'Invented Song 2'),
        [VID(7)]: { title: 'Neighbour X12 - Invented Song 2 (Official Audio)', author_name: 'Neighbour X12 - Topic' },
      },
    });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body.panel.choices.map((c: { title: string; credits: string[] }) => [c.title, c.credits])).toEqual([
      ['Invented Duet', ['Neighbour X11', 'Outside Collaborator']],
      ['Invented Song 2', ['Neighbour X12']],
    ]);
    expect(r.body.panel.gaps).toEqual([{ reason: 'duplicate_recording', count: 1 }]);
    // The outside collaborator never becomes a graph seed or allowed anchor.
    expect(r.body.connection.seeds).toEqual(['Generic Artist']);
    expect(r.body.connection.artists).not.toContain('Outside Collaborator');

    const twice = await nativeApp({ respond: () => envelope([collab, sameVideo]), meta: { [VID(5)]: { title: 'Neighbour X11 & Outside Collaborator - Invented Duet', author_name: 'Neighbour X11' } } });
    const t = await twice.app.discover(twice.cookie, twice.snap.brief!.handle);
    expect(t.body.panel.choices).toHaveLength(1);
    expect(t.body.panel.gaps).toEqual([{ reason: 'duplicate_recording', count: 1 }]);
    expect(twice.net.metadataRequests).toHaveLength(1);
  });

  it('fails honestly on malformed or incomplete streams and on missing mandatory Suggestions', async () => {
    for (const [respond, code] of [
      [() => ({ status: 200, contentType: null, body: new TextEncoder().encode('data: {"candidates":[{\n\n') }), 'catalogue_failed'],
      [() => envelope(three, { finishReason: 'MAX_TOKENS' }), 'catalogue_failed'],
      [() => envelope(three, { finishReason: 'SAFETY' }), 'catalogue_refused'],
      [() => ({ ...envelope(three), body: sseBody([{ candidates: [{ content: { parts: [{ text: 'Here are three great songs!' }] }, finishReason: 'STOP' }] }]) }), 'catalogue_failed'],
      [() => envelope(three, { rendered: null }), 'grounding_unavailable'],
      // A returned unit that cannot be presented safely within bounds is not silently dropped.
      [() => envelope(three, { rendered: '<script>steal()</script>' }), 'grounding_unavailable'],
      [() => envelope(three, { rendered: '<div>'.repeat(100) + 'too deep' }), 'grounding_unavailable'],
    ] as [CatRespond, string][]) {
      const { app, net, cookie, snap } = await nativeApp({ respond, meta: threeMeta });
      const r = await app.discover(cookie, snap.brief!.handle);
      expect(r.body).toMatchObject({ stage: 'failed', code, panel: null });
      expect(net.metadataRequests).toHaveLength(0);
    }
  });

  it('rejects unsupported or forged citations and unsafe redirects/DNS per proposal', async () => {
    const choices = [
      { ...three[0]!, chunk: null },
      { ...three[1]!, chunk: 1 },
      { ...three[2]!, chunk: 2 },
    ];
    const forged = [
      { web: { uri: REDIRECT(1), title: 'Invented source 1' } },
      { web: { uri: 'https://evil.invalid/grounding-api-redirect/x', title: 'Forged source' } },
      { web: { uri: REDIRECT(3), title: 'Invented source 3' } },
    ];
    const meta = { ...threeMeta, [VID(3)]: { redirect: 'https://evil.invalid/oembed' } };
    const { app, net, cookie, snap } = await nativeApp({ respond: () => envelope(choices, { chunks: forged }), meta });
    const r = await app.discover(cookie, snap.brief!.handle);
    // A forged cited chunk invalidates the entire native unit; it must not be silently dropped per pick.
    expect(r.body).toMatchObject({ stage: 'failed', code: 'grounding_unavailable', panel: null });
    expect(net.requests).toHaveLength(0);
    expect(JSON.stringify(r.body)).not.toContain('evil.invalid');

    // With intact attribution, a bad recording destination still rejects just that proposal.
    const unsafe = await nativeApp({ respond: () => envelope(three), meta });
    const u = await unsafe.app.discover(unsafe.cookie, unsafe.snap.brief!.handle);
    expect(u.body.panel.gaps).toEqual([{ reason: 'unsafe_redirect', count: 1 }]);
    expect(u.body.panel.choices).toHaveLength(2);
    expect(unsafe.net.metadataRequests).toHaveLength(3);

    const inward = await nativeApp({ respond: () => envelope(three), meta: threeMeta, dns: { 'www.youtube.com': ['10.1.2.3'] } });
    const i = await inward.app.discover(inward.cookie, inward.snap.brief!.handle);
    expect(i.body.panel.gaps).toEqual([{ reason: 'unsafe_address', count: 3 }]);
    expect(inward.net.metadataRequests).toHaveLength(0);

    // Reserved/site-local IPv6 answers are refused the same way, before any pinned connection.
    for (const address of ['::2', 'fec0::1']) {
      const v6 = await nativeApp({ respond: () => envelope(three), meta: threeMeta, dns: { 'www.youtube.com': [address] } });
      const r6 = await v6.app.discover(v6.cookie, v6.snap.brief!.handle);
      expect([address, r6.body.panel.gaps]).toEqual([address, [{ reason: 'unsafe_address', count: 3 }]]);
      expect(v6.net.metadataRequests).toHaveLength(0);
    }
  });

  it('grounding of the wrong claim: fit-only, anchor-only or partial support never establishes a recording', async () => {
    // The controller reproduction: the ONLY supported segment is "Why it may fit: ...", metadata is exact.
    const fitOnly = await nativeApp({ respond: () => envelope([{ ...three[0]!, support: 'fit' }]), meta: threeMeta });
    const r = await fitOnly.app.discover(fitOnly.cookie, fitOnly.snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'no_match', panel: { outcome: 'no_match', choices: [], gaps: [{ reason: 'no_identity_support', count: 1 }] } });
    // Rejected before any metadata request; the citation keeps its true meaning and offset in the full answer.
    expect(fitOnly.net.metadataRequests).toHaveLength(0);
    const text = buildAnswer([{ ...three[0]!, support: 'fit' }]).text;
    expect(r.body.panel.answer.text).toBe(text);
    expect(r.body.panel.answer.marks).toEqual([{ end: text.length, citations: [0] }]);

    for (const support of ['anchor', 'title', 'artists'] as const) {
      const one = await nativeApp({ respond: () => envelope([{ ...three[0]!, support }]), meta: threeMeta });
      const o = await one.app.discover(one.cookie, one.snap.brief!.handle);
      expect([support, o.body.panel.gaps]).toEqual([support, [{ reason: 'no_identity_support', count: 1 }]]);
      expect(one.net.metadataRequests).toHaveLength(0);
    }

    // Support that spans two blocks belongs to neither proposal.
    const two = three.slice(0, 2).map((c) => ({ ...c, chunk: null }));
    const spanText = buildAnswer(two).text;
    const spanning = { segment: { startIndex: 0, endIndex: Buffer.byteLength(spanText) }, groundingChunkIndices: [0] };
    const span = await nativeApp({ respond: () => envelope(two, { extraSupports: [spanning] }), meta: threeMeta });
    const s = await span.app.discover(span.cookie, span.snap.brief!.handle);
    expect(s.body.panel.gaps).toEqual([{ reason: 'no_native_support', count: 2 }]);

    // Identity support on one block and fit-only on another: only the identity-supported one is accepted.
    const mixed = await nativeApp({ respond: () => envelope([three[0]!, { ...three[1]!, support: 'fit' }]), meta: threeMeta });
    const m = await mixed.app.discover(mixed.cookie, mixed.snap.brief!.handle);
    expect(m.body.panel.choices.map((c: { title: string; sources: number[] }) => [c.title, c.sources])).toEqual([['Invented Song 1', [0]]]);
    expect(m.body.panel.gaps).toEqual([{ reason: 'no_identity_support', count: 1 }]);
  });

  it('exact recording identity end to end: longer title, undeclared version and incomplete credits are rejected', async () => {
    const sky = { title: 'Sky', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(1) };
    const skyDuo = { title: 'Sky', artists: ['Neighbour X12', 'Outside Collaborator'], anchor: 'Neighbour X12', videoId: VID(2) };
    const skyLive = { title: 'Sky', artists: ['Neighbour X13'], anchor: 'Neighbour X13', videoId: VID(3) };
    const { app, net, cookie, snap } = await nativeApp({
      respond: () => envelope([sky, skyDuo, skyLive]),
      meta: {
        [VID(1)]: { title: 'Neighbour X11 - Sky High (Official Audio)', author_name: 'Neighbour X11' },
        [VID(2)]: { title: 'Neighbour X12 - Sky (Official Audio)', author_name: 'Neighbour X12' },
        [VID(3)]: { title: 'Neighbour X13 - Sky (Live)', author_name: 'Neighbour X13' },
      },
    });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'no_match', panel: { choices: [] } });
    expect(Object.fromEntries(r.body.panel.gaps.map((g: { reason: string; count: number }) => [g.reason, g.count]))).toEqual({
      title_mismatch: 1,
      credits_unconfirmed: 1,
      version_mismatch: 1,
    });
    expect(net.metadataRequests).toHaveLength(3);
  });

  it('counts the catalogue against the shared Gemini cap and refuses it before transport when exhausted', async () => {
    const store = new MemoryStore({ maxSessions: 10, maxJourneysPerSession: 3, serviceCaps: { qloo: 600, gemini: 1 } });
    const { app, cat, cookie, snap } = await nativeApp({ respond: () => envelope(three), meta: threeMeta, store });
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'failed', code: 'capacity', panel: null });
    expect(cat.calls).toHaveLength(0);
    expect(store.serviceUsage().gemini).toBe(1);
  });

  it('Stop, Clear and an edit during a held generation revoke it; the late answer never commits', async () => {
    for (const action of ['stop', 'clear', 'edit'] as const) {
      const { gate, release } = fixtureHttp.gate();
      const { app, cat, net, cookie, snap } = await nativeApp({ respond: async () => (await gate, envelope(three)), meta: threeMeta });
      const k = app.key();
      const running = app.discover(cookie, snap.brief!.handle, k);
      for (let i = 0; i < 50 && cat.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
      expect(cat.calls).toHaveLength(1);
      if (action === 'stop') expect((await app.send('POST', '/api/stop', { body: { actionKey: k }, cookie })).body.stage).toBe('cancelled');
      if (action === 'clear') await app.send('DELETE', '/api/session', { cookie });
      if (action === 'edit') {
        await app.savePref({ body: { analysis: snap.analysis!.handle, relationship: { text: 'changed my mind' }, artists: ['Generic Artist'] }, cookie });
      }
      const done = await running;
      release();
      await new Promise((r) => setTimeout(r, 20));
      expect(done.body.panel ?? null).toBeNull();
      expect(cat.calls[0]!.signal.aborted).toBe(true);
      expect(net.metadataRequests).toHaveLength(0);
      if (action !== 'clear') expect((await app.state(cookie)).panel).toBeNull();
      else expect((await app.state(cookie)).session).toBeNull();
    }
  });
});

describe('labelled synthetic fixture', () => {
  it('runs the genuine catalogue adapter, parser and verifier over the fixture, labelled and without live Play links', async () => {
    const app = await setup({
      respond: createSyntheticQlooTransport(),
      catalogue: createNativeCatalogue(createSyntheticCatalogue()),
    });
    const { cookie, snap } = await app.ready(['Any Name']);
    const r = await app.discover(cookie, snap.brief!.handle);
    expect(r.body).toMatchObject({ stage: 'complete', status: 'choices_ready' });
    expect(r.body.panel.synthetic).toBe(true);
    expect(r.body.panel.choices).toHaveLength(3);
    expect(r.body.panel.choices.every((c: { playUrl: string | null }) => c.playUrl === null)).toBe(true);
    expect(r.body.panel.citations[0].title).toMatch(/fixture/);
    expect(new Set(r.body.panel.choices.map((c: { anchor: string }) => c.anchor)).size).toBe(3);
  });

  it('feeds the genuine client with valid invented identities and is labelled as not Qloo', async () => {
    const client = createQlooClient({ transport: createSyntheticQlooTransport(), apiKey: new ServerSecret(KEY), host: 'hackathon.api.qloo.com' });
    const signal = new AbortController().signal;
    const one = await client.searchArtists('Any Name', 5, signal);
    expect(one.artists).toHaveLength(1);
    expect((await client.searchArtists('Ambiguous Name', 5, signal)).artists).toHaveLength(2);
    expect((await client.searchArtists('Nobody', 5, signal)).noResults).toBe(true);
    const pool = await client.artistInsights({ seedIds: [one.artists[0]!.entityId], take: 15 }, signal);
    expect(pool.artists.length).toBeGreaterThan(0);
    expect(pool.lineage.rejected).toBe(0);
  });

  it('marks pools from the fixture as synthetic in the snapshot and why-chain', async () => {
    const app = await setup();
    const server = createServer();
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: 'synthetic' });
    const handler = createApiHandler({ shutdown: fixtureHttp.shutdown(),
      config,
      store: new MemoryStore(config),
      referenceAdapter: createSyntheticReferenceAdapter(0),
      discovery: {
        qloo: createQlooClient({ transport: createSyntheticQlooTransport(), apiKey: new ServerSecret(KEY), host: 'hackathon.api.qloo.com' }),
        qlooSynthetic: true,
        catalogue: notConfiguredCatalogue,
        sealer: createRecordSealer(new ServerSecret(SEAL_KEY)),
      },
    });
    server.on('request', (req: IncomingMessage, res: ServerResponse) => void handler(req, res));
    const call = (method: string, path: string, body: unknown, cookie?: string) =>
      fixtureHttp.observe(new Promise<{ headers: Record<string, unknown>; body: any }>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: {
              host: config.hostHeader,
              origin: config.origin,
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(payload)),
              ...(cookie ? { cookie } : {}),
            },
          },
          (res) => {
            res.on('error', reject);
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ headers: res.headers, body: JSON.parse(data) }));
          },
        );
        req.on('error', reject);
        req.end(payload);
      }));
    const cookie = String((await call('POST', '/api/session', {})).headers['set-cookie']).split(';')[0]!;
    const ref = await call('POST', '/api/reference', { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: app.key() }, cookie);
    const saved = await call(
      'POST',
      '/api/preference',
      { analysis: ref.body.analysis.handle, relationship: { choice: 1 }, artists: ['Any Name'], actionKey: app.key(), expectedBrief: null },
      cookie,
    );
    const r = await call('POST', '/api/discover', { brief: saved.body.brief.handle, actionKey: app.key() }, cookie);
    expect(r.body.connection.synthetic).toBe(true);
    expect(r.body.connection.why.join(' ')).toMatch(/synthetic local fixture \(not Qloo\)/);
    expect(r.body.code).toBe('catalogue_not_configured');
    expect(JSON.stringify(r.body)).not.toMatch(UUID_RE);
  });
});

describe('catalogue handoff bounds and anchors', () => {
  const plan = (artists: number, nameLen: number): InvestigationPlan => ({
    sessionId: 's'.repeat(24) as Handle,
    epoch: 1,
    createdAt: 0,
    expiresAt: 1,
    id: 'p'.repeat(24) as Handle,
    journeyId: 'j'.repeat(24) as Handle,
    briefId: 'b'.repeat(24) as Handle,
    briefVersion: 20,
    poolId: 'o'.repeat(24) as Handle,
    relationship: 'r'.repeat(1000),
    seedNames: ['a'.repeat(256), 'b'.repeat(256)],
    anchors: Array.from({ length: artists }, (_, i) => ({ handle: `anchor-handle-${String(i).padStart(10, '0')}` as Handle, name: 'n'.repeat(nameLen) })),
    associations: Array.from({ length: 15 }, (_, i) => ({ handle: `tag-handle-${String(i).padStart(13, '0')}` as Handle, name: 't'.repeat(128) })),
    exclusions: Array.from({ length: 16 }, () => 'e'.repeat(128)),
    // The planned refinement shape at its bound: every recording of one earlier panel, maximal titles and credits.
    recordingExclusions: {
      shown: Array.from({ length: 3 }, (_, i) => ({ key: `k${i}`, videoId: VID(i), title: 'x'.repeat(200), credits: Array.from({ length: 8 }, () => 'c'.repeat(128)) })),
      known: ['k0'],
    },
    priorities: ['preserve_listener_relationship'],
    refinementMode: 'follow_connection',
    refinement: null,
    attribution: 'seed_mix',
    provenance: { analysisId: 'a'.repeat(24) as Handle, analysisReuse: 'same_source_focus', poolSourceBriefId: 'b'.repeat(24) as Handle, poolReuse: 'created' },
  });

  it('fits the largest permitted plan (including refinement recording exclusions) inside 16 KiB', () => {
    const h = buildCatalogueHandoff(plan(15, 256));
    expect(Buffer.byteLength(JSON.stringify(h))).toBeLessThanOrEqual(16 * 1024);
    // Recording identities stay separate from the artist-name exclusions and carry no keys or video IDs.
    expect(h.exclusions.every((e) => e === 'e'.repeat(128))).toBe(true);
    expect(JSON.stringify(h.excludedRecordings)).not.toMatch(/"key"|videoId|invVid/);
  });

  it('accepts only anchors owned by the plan pool', () => {
    const p = plan(3, 10);
    expect(allowedAnchor(p, p.anchors[1]!.handle)?.name).toBe('n'.repeat(10));
    expect(allowedAnchor(p, 'outside-anchor-handle-00')).toBeNull();
    expect(allowedAnchor(p, uid(11))).toBeNull();
  });
});
