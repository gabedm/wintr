import { createHttpFixture } from './fixtures/http-lifecycle.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChoicePanel, Handle, InvestigationPlan, QlooCandidatePool, RecordingService, SafeSnapshot, TrackChoice } from '../src/shared/records.js';
import { createApiHandler } from '../src/server/app.js';
import type { CatalogueSeam } from '../src/server/catalogue.js';
import { discoveryOutcome } from '../src/client/discovery.js';
import { resolveWhy, whyIdentity } from '../src/client/overlay.js';
import { loadConfig } from '../src/server/config.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createSourceResolver } from '../src/server/source-resolver.js';
import { createGeminiCatalogueAdapter } from '../src/server/providers/gemini-catalogue.js';
import type { ProviderRequest, ProviderResponse } from '../src/server/providers/http.js';
import { createQlooClient } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createSyntheticReferenceAdapter } from '../src/server/reference.js';
import { createRecordSealer } from '../src/server/seal.js';
import { matchFirstPartyIdentity } from '../src/server/recording-identity.js';
import { MemoryStore, type AdmitRefineInput, type Owner, type RefineContext, type SessionBucket } from '../src/server/store.js';
import { createSyntheticCatalogue } from '../src/server/synthetic-catalogue.js';
import { createSyntheticQlooTransport } from '../src/server/synthetic-qloo.js';
import { createAppleMusicVerifier, createYouTubeVerifier } from '../src/server/verifier.js';
import { AID, catalogueTransport, envelope, fakeNetwork, VID, type AppleEntry, type FixtureChoice, type MetaEntry } from './fixtures/catalogue-fixtures.js';

// Checkpoint E: free independent feedback and ONE shared refinement allowance,
// through the real HTTP API, MemoryStore (synthetic-only), harness, genuine Qloo
// client, genuine SSE catalogue adapter/parser and metadata verifier, all over
// fake envelopes. Every artist, title, video ID and UUID is invented.

const KEY = 'synthetic-qloo-test-key-0002';
const TOKEN = 'invented-access-token-0002';
const SEAL_KEY = 'synthetic-seal-key-for-tests-only-000002';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const uid = (n: number) => `20000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const artist = (n: number, name: string) => ({ entity_id: uid(n), name, subtype: 'urn:entity:artist' });

const SEED = artist(1, 'Generic Artist');
const SECOND = artist(2, 'Other Artist');
const POOL_X = [artist(11, 'Neighbour X11'), artist(12, 'Neighbour X12'), artist(13, 'Neighbour X13')];
/** Returned for any follow request: overlaps on X11, adds F31/F32. */
const POOL_F = [artist(11, 'Neighbour X11'), artist(31, 'Neighbour F31'), artist(32, 'Neighbour F32')];
const TAGS = [{ tag_id: 'urn:tag:genre:music:invented_warmth', name: 'Invented warmth', subtype: 'urn:tag:genre:music' }];

const json = (status: number, value: unknown): ProviderResponse => ({ status, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(value)) });
const kind = (req: ProviderRequest) => (req.url.pathname === '/search' ? 'search' : req.url.searchParams.get('filter.type') === 'urn:tag' ? 'tags' : 'artists');
const entities = (req: ProviderRequest) => (req.url.searchParams.get('signal.interests.entities') ?? '').split(',').filter(Boolean);

function qlooFixture(hold?: { artists?: Promise<void>; afterInitial?: boolean }) {
  let artistCalls = 0;
  return async (req: ProviderRequest): Promise<ProviderResponse> => {
    if (req.url.pathname === '/search') {
      const q = (req.url.searchParams.get('query') ?? '').toLowerCase();
      const results = q === 'generic artist' ? [SEED] : q === 'other artist' ? [SECOND] : null;
      return results ? json(200, { results }) : json(404, {});
    }
    if (req.url.searchParams.get('filter.type') === 'urn:tag') return json(200, { success: true, results: { tags: TAGS } });
    artistCalls += 1;
    if (hold?.artists && (!hold.afterInitial || artistCalls > 1)) await hold.artists;
    // The initial seed mix returns POOL_X; any seed mix containing a followed X-anchor returns POOL_F.
    const follow = entities(req).some((e) => [uid(11), uid(12), uid(13)].includes(e));
    return json(200, { success: true, results: { entities: follow ? POOL_F : POOL_X } });
  };
}

const metaFor = (anchor: string, title: string, decoration = ' (Official Audio)') => ({ title: `${anchor} - ${title}${decoration}`, author_name: anchor });
const THREE: FixtureChoice[] = POOL_X.map((a, i) => ({ title: `Invented Song ${i + 1}`, artists: [a.name], anchor: a.name, videoId: VID(i + 1) }));
const META: Record<string, MetaEntry> = {
  ...Object.fromEntries(THREE.map((c) => [c.videoId, metaFor(c.anchor, c.title)])),
  [VID(5)]: { title: 'Neighbour X11 & Outside Collaborator - Invented Duet', author_name: 'Neighbour X11' },
  [VID(31)]: metaFor('Neighbour F31', 'Fresh Song 1'),
  [VID(32)]: { title: 'Neighbour F32 & Neighbour X12 - Shared Song', author_name: 'Neighbour F32' },
  // Alternate uploads of recordings already shown (a different video ID is not a fresh recording).
  [VID(41)]: metaFor('Neighbour X11', 'Invented Song 1', ' (Official Video)'),
  [VID(42)]: metaFor('Neighbour X12', 'Invented Song 2', ' [Official Music Video]'),
  [VID(43)]: metaFor('Neighbour X13', 'Other Song'),
  [VID(44)]: metaFor('Neighbour X11', 'Warm Song'),
  [VID(45)]: metaFor('Neighbour X11', 'Invented Song 1', ''),
};

/** Synthetic-only store that records committed plans/pools and refine admissions for provenance assertions. */
class CapturingStore extends MemoryStore {
  readonly plans: InvestigationPlan[] = [];
  readonly pools: (QlooCandidatePool | null)[] = [];
  readonly refineInputs: AdmitRefineInput[] = [];
  override async commitPlan(owner: Owner, attemptId: Handle, pool: QlooCandidatePool | null, plan: InvestigationPlan, now: number) {
    const ok = await super.commitPlan(owner, attemptId, pool, plan, now);
    if (ok) {
      this.plans.push(structuredClone(plan));
      this.pools.push(pool ? structuredClone(pool) : null);
    }
    return ok;
  }
  override async admitRefine(input: AdmitRefineInput) {
    this.refineInputs.push(input);
    return super.admitRefine(input);
  }
  async bucket(): Promise<SessionBucket> {
    const owner = this.refineInputs[0]!;
    return (await this.read(owner.sessionId, owner.epoch, Date.now()))!;
  }
}

const fixtureHttp = createHttpFixture();
const request = fixtureHttp.request;
const servers: Server[] = [];
afterEach(async () => {
  await fixtureHttp.close(servers.splice(0));
});

interface Options {
  catalogue?: (i: number, req: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>;
  /** Test-only fault injection after native verification, to isolate later commit guards. */
  catalogueWrap?: (seam: CatalogueSeam) => CatalogueSeam;
  qloo?: (req: ProviderRequest) => Promise<ProviderResponse>;
  store?: MemoryStore;
  dns?: Record<string, string[]>;
  clock?: { t: number };
  synthetic?: boolean;
  /** Recording-service capability passed to the native catalogue (absent = YouTube only). */
  services?: readonly RecordingService[];
  apple?: Record<string, AppleEntry>;
}

async function setup(o: Options = {}) {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const config = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: 'synthetic' });
  const store = o.store ?? new CapturingStore({ maxSessions: 10, maxJourneysPerSession: 3 });
  const calls: ProviderRequest[] = [];
  const qlooRespond = o.qloo ?? qlooFixture();
  const cat = catalogueTransport((req) => (o.catalogue ?? ((i) => (i === 0 ? envelope(THREE) : envelope([], { none: true, queries: [], chunks: [], rendered: null }))))(cat.calls.length - 1, req));
  const net = fakeNetwork(META, o.dns, o.apple);
  const synthetic = o.synthetic ? createSyntheticCatalogue() : null;
  const metadataNet = { resolve: net.resolve, http: net.http, now: Date.now };
  const catalogue = createNativeCatalogue(
    synthetic ?? {
      adapter: createGeminiCatalogueAdapter({ transport: cat.transport, project: 'invented-project', quotaProject: 'invented-quota', accessToken: async () => new ServerSecret(TOKEN) }),
      verifier: createYouTubeVerifier(metadataNet),
      sources: createSourceResolver(metadataNet),
      ...(o.services ? { services: o.services } : {}),
      ...(o.services?.includes('apple_music') ? { appleVerifier: createAppleMusicVerifier(metadataNet) } : {}),
    },
  );
  const handler = createApiHandler({ shutdown: fixtureHttp.shutdown(),
    config,
    store,
    now: o.clock ? () => o.clock!.t : undefined,
    referenceAdapter: createSyntheticReferenceAdapter(0),
    discovery: {
      qloo: createQlooClient({
        transport: o.synthetic
          ? createSyntheticQlooTransport()
          : async (req) => {
              calls.push(req);
              return qlooRespond(req);
            },
        apiKey: new ServerSecret(KEY),
        host: 'hackathon.api.qloo.com',
      }),
      qlooSynthetic: !!o.synthetic,
      catalogue: o.catalogueWrap ? o.catalogueWrap(catalogue) : catalogue,
      sealer: createRecordSealer(new ServerSecret(SEAL_KEY)),
    },
  });
  server.on('request', (req: IncomingMessage, res: ServerResponse) => void handler(req, res));

  const snapshots: string[] = [];
  const send = (method: string, path: string, x: { body?: unknown; cookie?: string } = {}) =>
    fixtureHttp.observe(new Promise<{ status: number; body: any }>((resolve, reject) => {
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
          resolve({ status: res.statusCode!, body: data && isJson ? JSON.parse(data) : data || null });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    }));
  let n = 0;
  const key = () => `refine-action-key-${String(++n).padStart(6, '0')}`;
  const newSession = async () => {
    const r = await fixtureHttp.observe(new Promise<string>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/session', headers: { host: config.hostHeader, origin: config.origin, 'content-type': 'application/json', 'content-length': '2' } },
        (res) => {
          res.on('error', reject);
          res.resume();
          resolve(String(res.headers['set-cookie']).split(';')[0]!);
        },
      );
      req.on('error', reject);
      req.end('{}');
    }));
    return r;
  };
  const state = async (cookie: string) => (await send('GET', '/api/state', { cookie })).body as SafeSnapshot;

  /** Session -> synthetic reference -> free save -> explicit Discover (initial panel). */
  const initial = async (artists: string[] = ['Generic Artist', 'Other Artist']) => {
    const cookie = await newSession();
    const ref = await send('POST', '/api/reference', { body: { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: key() }, cookie });
    const saved = await send('POST', '/api/preference', {
      body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists, actionKey: key(), expectedBrief: null },
      cookie,
    });
    const r = await send('POST', '/api/discover', { body: { brief: saved.body.brief.handle, actionKey: key() }, cookie });
    return { cookie, snap: r.body as SafeSnapshot };
  };
  const feedback = (cookie: string, panel: Handle, choice: Handle, fit: string | null, familiarity: string | null, expectedRevision = 0, actionKey = key()) =>
    send('POST', '/api/feedback', { body: { panel, choice, fit, familiarity, expectedRevision, actionKey }, cookie });
  const refine = (cookie: string, body: Record<string, unknown>, actionKey = key()) => send('POST', '/api/refine', { body: { actionKey, ...body }, cookie });
  const usage = () => (store as MemoryStore).serviceUsage();
  return { send, state, key, newSession, initial, feedback, refine, calls, cat, net, store: store as CapturingStore, snapshots, usage, config };
}

const prompt = (req: ProviderRequest) => JSON.parse(req.body!).contents[0].parts[0].text as string;
const promptData = (req: ProviderRequest) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(prompt(req))![1]!) as Record<string, unknown>;
const choiceBy = (snap: SafeSnapshot, title: string) => snap.panel!.choices.find((c) => c.title === title)!;
const gapsOf = (snap: SafeSnapshot) => Object.fromEntries(snap.panel!.gaps.map((g) => [g.reason, g.count]));
const noLeaks = (snapshots: string[]) => {
  for (const s of snapshots) {
    expect(s).not.toMatch(UUID_RE);
    expect(s).not.toMatch(/entityId|entity_id|"seal"|fingerprint|recordingKey|x-api-key/i);
    for (const secret of [KEY, TOKEN, SEAL_KEY, 'invented-project', 'invented-quota']) expect(s).not.toContain(secret);
  }
};

describe('free, independent feedback', () => {
  it('saves fit and familiarity independently for exact owned choices, with replay/stale guards and no dispatch', async () => {
    const app = await setup();
    const { cookie, snap } = await app.initial();
    const before = { qloo: app.calls.length, cat: app.cat.calls.length, net: app.net.metadataRequests.length, usage: app.usage() };
    const panel = snap.panel!.handle;
    const song2 = choiceBy(snap, 'Invented Song 2').handle;

    const likeKey = app.key();
    const liked = await app.feedback(cookie, panel, song2, 'like', null, 0, likeKey);
    expect(choiceBy(liked.body, 'Invented Song 2').feedback).toEqual({ fit: 'like', familiarity: null, revision: 1 });
    // A known recording can still fit: familiarity is saved independently and leaves fit untouched.
    const known = await app.feedback(cookie, panel, song2, 'like', 'known', 1);
    expect(choiceBy(known.body, 'Invented Song 2').feedback).toEqual({ fit: 'like', familiarity: 'known', revision: 2 });
    // Exact replay of the earlier action cannot overwrite the newer feedback.
    const replay = await app.feedback(cookie, panel, song2, 'like', null, 0, likeKey);
    expect([replay.status, replay.body.error]).toEqual([409, 'stale_operation']);
    // Same key, different input: conflict.
    expect((await app.feedback(cookie, panel, song2, 'not_right', null, 0, likeKey)).body.error).toBe('action_conflict');
    // A new action from an out-of-date basis is refused.
    expect((await app.feedback(cookie, panel, song2, 'not_right', 'known', 1)).body.error).toBe('stale_version');
    // An unchanged save is a no-op: no new revision.
    const same = await app.feedback(cookie, panel, song2, 'like', 'known', 2);
    expect(choiceBy(same.body, 'Invented Song 2').feedback.revision).toBe(2);
    // Clearing both values is a deliberate free save too.
    const cleared = await app.feedback(cookie, panel, song2, null, null, 2);
    expect(choiceBy(cleared.body, 'Invented Song 2').feedback).toEqual({ fit: null, familiarity: null, revision: 3 });
    // Other choices are untouched; "not right" on one recording is not an artist ban anywhere.
    expect(choiceBy(cleared.body, 'Invented Song 1').feedback).toEqual({ fit: null, familiarity: null, revision: 0 });

    // Only owned, displayed choices of owned panels; bounded value sets.
    expect((await app.feedback(cookie, panel, 'x'.repeat(24) as Handle, 'like', null)).status).toBe(404);
    expect((await app.feedback(cookie, 'y'.repeat(24) as Handle, song2, 'like', null)).status).toBe(404);
    expect((await app.feedback(cookie, panel, song2, 'love', null)).status).toBe(400);
    expect((await app.feedback(cookie, panel, song2, 'like', 'familiar')).status).toBe(400);
    const other = await app.newSession();
    expect((await app.feedback(other, panel, song2, 'like', null)).status).toBe(404);

    // No provider, Search, generation or metadata request; no count changed.
    expect([app.calls.length, app.cat.calls.length, app.net.metadataRequests.length]).toEqual([before.qloo, before.cat, before.net]);
    expect(app.usage()).toEqual(before.usage);
    // A plain brief save after a committed panel is refused: intent changes go through the explicit refinement.
    const pref = await app.send('POST', '/api/preference', {
      body: { analysis: snap.analysis!.handle, relationship: { text: 'changed' }, artists: ['Generic Artist'], actionKey: app.key(), expectedBrief: snap.brief!.handle },
      cookie,
    });
    expect([pref.status, pref.body.error]).toEqual([409, 'discovery_used']);
    expect((await app.state(cookie)).refinement).toEqual({ used: false });
    noLeaks(app.snapshots);
  });

  it('is bounded by the configured free-mutation limiter', async () => {
    const app = await setup({ store: new CapturingStore({ maxSessions: 10, maxJourneysPerSession: 3, freeMutation: { perSession: 4, perService: 100, windowMs: 60_000 } }) });
    const { cookie, snap } = await app.initial();
    const c = snap.panel!.choices[0]!.handle;
    // The preference save already used 1 of 4 per-session free mutations.
    expect((await app.feedback(cookie, snap.panel!.handle, c, 'like', null, 0)).status).toBe(200);
    expect((await app.feedback(cookie, snap.panel!.handle, c, 'like', 'new', 1)).status).toBe(200);
    expect((await app.feedback(cookie, snap.panel!.handle, c, 'not_right', 'new', 2)).status).toBe(200);
    expect((await app.feedback(cookie, snap.panel!.handle, c, 'like', 'new', 3)).body.error).toBe('rate_limited');
  });
});

describe('follow_connection refinement', () => {
  it('shares a pending normalized Search and keeps its persisted handles usable for correction', async () => {
    const fallback = qlooFixture();
    const app = await setup({ qloo: async (req) => {
      if (req.url.pathname !== '/search') return fallback(req);
      const query = req.url.searchParams.get('query');
      // Before the fix the unaccented duplicate finishes first and steals persistence.
      if (query === 'Café') await new Promise((resolve) => setTimeout(resolve, 20));
      return json(200, { results: [artist(1, 'Café')] });
    } });
    const { cookie, snap } = await app.initial(['Café', 'Cafe']);
    expect(snap.stage).toBe('complete');
    expect(app.calls.filter((call) => kind(call) === 'search')).toHaveLength(1);
    const refined = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(refined.status).toBe(200);
    expect(refined.body.error).toBeUndefined();
    expect(refined.body.refinement.used).toBe(true);
    const bucket = await app.store.bucket();
    expect(bucket.searches).toHaveLength(1);
    const handles = new Set(bucket.searches.flatMap((search) => search.candidates.map((candidate) => candidate.handle)));
    expect(app.store.pools[0]!.seeds.every((seed) => handles.has(seed.handle))).toBe(true);
  });
  it('initial + follow: one new artist Insights call, a changed pool/plan, one generation and a different supported recording', async () => {
    const followEnvelope = envelope([
      { title: 'Fresh Song 1', artists: ['Neighbour F31'], anchor: 'Neighbour F31', videoId: VID(31) },
      // Another upload of a recording already shown: excluded by canonical identity after verification.
      { title: 'Invented Song 1', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(41) },
      // The liked (followed) artist stays eligible as a credited collaborator.
      { title: 'Shared Song', artists: ['Neighbour F32', 'Neighbour X12'], anchor: 'Neighbour F32', videoId: VID(32) },
    ]);
    const app = await setup({ catalogue: (i) => (i === 0 ? envelope(THREE) : followEnvelope) });
    const { cookie, snap } = await app.initial();
    expect(snap.panel!.choices.map((c) => c.title)).toEqual(['Invented Song 1', 'Invented Song 2', 'Invented Song 3']);
    expect(app.usage()).toEqual({ qloo: 4, gemini: 2 });
    const initialInsights = app.calls.find((c) => kind(c) === 'artists')!;
    expect(entities(initialInsights).sort()).toEqual([uid(1), uid(2)].sort());

    // Positive familiar feedback is enough to follow; a known track can still fit.
    const song2 = choiceBy(snap, 'Invented Song 2').handle;
    await app.feedback(cookie, snap.panel!.handle, song2, 'like', 'known');
    expect(app.usage()).toEqual({ qloo: 4, gemini: 2 });

    const qBefore = app.calls.length;
    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice: song2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stage: 'complete', status: 'choices_ready', refinement: { used: true }, attempt: { kind: 'refine', outcome: 'succeeded' } });

    // Exactly one new Qloo call: artist Insights for [kept starting seed, followed anchor]; no Search, no tag call.
    const added = app.calls.slice(qBefore);
    expect(added.map(kind)).toEqual(['artists']);
    expect(entities(added[0]!).sort()).toEqual([uid(1), uid(12)].sort());
    expect(entities(added[0]!)).not.toContain(uid(2));
    expect(app.usage()).toEqual({ qloo: 5, gemini: 3 });
    expect(app.cat.calls).toHaveLength(2);

    // The consumed plan changed with the new Qloo pool; shown recordings are excluded separately from artist names.
    const data = promptData(app.cat.calls[1]!);
    expect(data.allowed_artists).toEqual(['Neighbour X11', 'Neighbour F31', 'Neighbour F32']);
    expect(data.starting_artists).toEqual(['Generic Artist', 'Neighbour X12']);
    expect(data.do_not_choose_recordings_by).toEqual(['Generic Artist']);
    expect(data.already_shown_recordings).toEqual(THREE.map((c) => ({ title: c.title, artists: c.artists })));
    expect(data.listener_wants_to_keep).toBe(snap.brief!.relationship);

    // A different supported recording; the alternate upload of a shown recording was rejected.
    expect(r.body.panel.choices.map((c: { title: string; anchor: string }) => [c.title, c.anchor])).toEqual([
      ['Fresh Song 1', 'Neighbour F31'],
      ['Shared Song', 'Neighbour F32'],
    ]);
    expect(gapsOf(r.body)).toEqual({ previously_shown: 1 });
    expect(r.body.panel).toMatchObject({ role: 'refinement', mode: 'follow_connection' });
    expect(r.body.panel.basis).toEqual([
      'Followed Neighbour X12 from a recording you liked.',
      'Kept your starting artist Generic Artist.',
      'Other Artist (your optional artist) was replaced by Neighbour X12 for this search.',
      'A new artist lookup asked Qloo for artists connected to Generic Artist and Neighbour X12 together.',
      '3 recordings already shown were left out.',
    ]);
    // The original panel and its feedback remain available and unambiguous.
    expect(r.body.history).toHaveLength(1);
    expect(r.body.history[0].handle).toBe(snap.panel!.handle);
    expect(r.body.history[0].choices.map((c: { title: string }) => c.title)).toEqual(['Invented Song 1', 'Invented Song 2', 'Invented Song 3']);
    expect(r.body.history[0].choices[1].feedback).toMatchObject({ fit: 'like', familiarity: 'known' });
    expect(r.body.panel.choices.every((c: { feedback: { revision: number } }) => c.feedback.revision === 0)).toBe(true);
    // Each panel keeps its own isolated Suggestions unit.
    expect(r.body.history[0].suggestionsUrl).not.toBe(r.body.panel.suggestionsUrl);
    expect((await app.send('GET', r.body.history[0].suggestionsUrl, { cookie })).status).toBe(200);

    // Provenance: new pool/plan bound to the refinement brief, with roles, exclusions and admitted feedback.
    const [initialPlan, followPlan] = app.store.plans;
    const followPool = app.store.pools[1]!;
    expect(followPool.origin).toBe('follow_connection');
    expect(followPool.seeds.map((s) => [s.name, s.role, s.entityId])).toEqual([
      ['Generic Artist', 'starting', uid(1)],
      ['Neighbour X12', 'followed', uid(12)],
    ]);
    expect(followPool.lineage.tagOutcome).toBe('not_admitted');
    expect(followPlan!.poolId).not.toBe(initialPlan!.poolId);
    expect(followPlan!.briefId).not.toBe(initialPlan!.briefId);
    expect(followPlan!.provenance).toMatchObject({ poolReuse: 'created', poolSourceBriefId: followPlan!.briefId, analysisId: initialPlan!.provenance.analysisId });
    expect(followPlan!.refinement).toMatchObject({ followed: 'Neighbour X12', keptStarting: 'Generic Artist', replaced: ['Other Artist'] });
    expect(followPlan!.recordingExclusions.shown.map((s) => ('videoId' in s ? s.videoId : null))).toEqual([VID(1), VID(2), VID(3)]);
    expect(followPlan!.recordingExclusions.known).toHaveLength(1);
    const bucket = await app.store.bucket();
    const refineBrief = bucket.briefs.find((b) => b.id === followPlan!.briefId)!;
    expect(refineBrief.refinement).toMatchObject({ mode: 'follow_connection', fromPanelId: snap.panel!.handle, followChoice: song2 });
    expect(refineBrief.relationship).toBe(snap.brief!.relationship);

    // Later free edits never rewrite the immutable admitted provenance.
    await app.feedback(cookie, snap.panel!.handle, song2, null, null, 1);
    const after = await app.store.bucket();
    expect(after.briefs.find((b) => b.id === refineBrief.id)!.refinement!.admittedFeedback).toEqual([{ choice: song2, fit: 'like', familiarity: 'known' }]);
    expect(after.feedback.find((f) => f.choiceHandle === song2)).toMatchObject({ fit: null, familiarity: null });

    // One shared allowance: neither mode can run again.
    const again = await app.refine(cookie, { mode: 'correct_direction', panel: r.body.panel.handle, brief: r.body.brief.handle });
    expect([again.status, again.body.error]).toEqual([409, 'refinement_used']);
    expect(app.usage()).toEqual({ qloo: 5, gemini: 3 });
    noLeaks(app.snapshots);
  });

  it('uses only the owned anchor of a collaboration (never the outside collaborator) and discloses a missing starting role', async () => {
    const app = await setup({
      catalogue: (i) =>
        i === 0
          ? envelope([{ title: 'Invented Duet', artists: ['Neighbour X11', 'Outside Collaborator'], anchor: 'Neighbour X11', videoId: VID(5) }])
          : envelope([{ title: 'Fresh Song 1', artists: ['Neighbour F31'], anchor: 'Neighbour F31', videoId: VID(31) }]),
    });
    // "Missing Artist" is not found: the only verified seed is the optional favourite (no starting role is fabricated).
    const { cookie, snap } = await app.initial(['Missing Artist', 'Other Artist']);
    expect(snap.connection!.seeds).toEqual(['Other Artist']);
    const duet = snap.panel!.choices[0]!;
    expect(duet.credits).toEqual(['Neighbour X11', 'Outside Collaborator']);
    await app.feedback(cookie, snap.panel!.handle, duet.handle, 'like', 'new');
    const searches = app.calls.filter((c) => kind(c) === 'search').length;

    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice: duet.handle });
    expect(r.body.stage).toBe('complete');
    const follow = app.calls.filter((c) => kind(c) === 'artists').at(-1)!;
    // Seeds: the owned anchor only; the replaced favourite and the collaborator are not sent.
    expect(entities(follow)).toEqual([uid(11)]);
    expect(app.calls.filter((c) => kind(c) === 'search')).toHaveLength(searches);
    expect(JSON.stringify(app.calls.map((c) => c.url.href))).not.toMatch(/Outside/);
    expect(r.body.connection.seeds).toEqual(['Neighbour X11']);
    expect(r.body.panel.basis.slice(0, 3)).toEqual([
      'Followed Neighbour X11 from a recording you liked.',
      'No verified starting artist was available to keep, so the new search starts from Neighbour X11 alone.',
      'Other Artist (your optional artist) was replaced by Neighbour X11 for this search.',
    ]);
    expect(app.store.pools[1]!.seeds.map((s) => s.role)).toEqual(['followed']);
  });

  it('requires a positive vote on an owned displayed choice; invalid actions spend nothing', async () => {
    const app = await setup();
    const { cookie, snap } = await app.initial();
    const panel = snap.panel!.handle;
    const brief = snap.brief!.handle;
    const song1 = snap.panel!.choices[0]!.handle;
    const usage = app.usage();
    const calls = app.calls.length;

    expect((await app.refine(cookie, { mode: 'follow_connection', panel, brief, choice: song1 })).body.error).toBe('feedback_required');
    await app.feedback(cookie, panel, song1, 'not_right', 'known');
    expect((await app.refine(cookie, { mode: 'follow_connection', panel, brief, choice: song1 })).body.error).toBe('feedback_required');
    // Foreign/forged handles, wrong panel/brief, provider UUIDs and malformed bodies are refused before admission.
    expect((await app.refine(cookie, { mode: 'follow_connection', panel, brief, choice: 'z'.repeat(24) })).body.error).toBe('stale_version');
    expect((await app.refine(cookie, { mode: 'follow_connection', panel, brief, choice: uid(12) })).status).toBe(400);
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: 'q'.repeat(24), brief })).body.error).toBe('stale_version');
    expect((await app.refine(cookie, { mode: 'correct_direction', panel, brief: 'q'.repeat(24) })).body.error).toBe('stale_version');
    expect((await app.refine(cookie, { mode: 'correct_direction', panel, brief, excludeArtists: [uid(11)] })).status).toBe(400);
    expect((await app.refine(cookie, { mode: 'correct_direction', panel, brief, choice: song1 })).status).toBe(400);
    expect((await app.refine(cookie, { mode: 'rewrite_everything', panel, brief })).status).toBe(400);
    const all = snap.connection!.anchors.map((a) => a.handle);
    expect((await app.refine(cookie, { mode: 'correct_direction', panel, brief, excludeArtists: all })).body.error).toBe('pool_empty');
    // Another session cannot use these handles.
    const other = await app.newSession();
    expect((await app.refine(other, { mode: 'correct_direction', panel, brief })).body.error).toBe('stale_version');

    expect((await app.state(cookie)).refinement).toEqual({ used: false });
    expect(app.usage()).toEqual(usage);
    expect(app.calls.length).toBe(calls);
    expect(app.cat.calls).toHaveLength(1);
  });
});

describe('correct_direction refinement', () => {
  it('none fit: corrected direction over the reused pool with ZERO Qloo calls, explicit artist exclusion and identity exclusions', async () => {
    const correction = envelope([
      // Another upload of a shown recording (same canonical identity): excluded after verification.
      { title: 'Invented Song 2', artists: ['Neighbour X12'], anchor: 'Neighbour X12', videoId: VID(42) },
      // An explicitly excluded owned anchor is outside the derived allowed list.
      { title: 'Other Song', artists: ['Neighbour X13'], anchor: 'Neighbour X13', videoId: VID(43) },
      // A "not right" recording never bans its artist: a different X11 recording is fine.
      { title: 'Warm Song', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(44) },
    ]);
    const app = await setup({ catalogue: (i) => (i === 0 ? envelope(THREE) : correction) });
    const { cookie, snap } = await app.initial();
    for (const c of snap.panel!.choices) await app.feedback(cookie, snap.panel!.handle, c.handle, 'not_right', null);
    const x13 = snap.connection!.anchors.find((a) => a.name === 'Neighbour X13')!.handle;
    const qloo = app.calls.length;

    const r = await app.refine(cookie, {
      mode: 'correct_direction',
      panel: snap.panel!.handle,
      brief: snap.brief!.handle,
      relationship: { text: 'something warmer' },
      excludeArtists: [x13],
    });
    expect(r.body).toMatchObject({ stage: 'complete', refinement: { used: true }, panel: { role: 'refinement', mode: 'correct_direction' } });
    expect(r.body.history[0].intent).toEqual(snap.brief);
    expect(r.body.panel.intent).toEqual(r.body.brief);
    expect(r.body.history[0].intent.relationship).not.toBe('something warmer');
    expect(app.calls.length).toBe(qloo);
    expect(app.usage()).toEqual({ qloo: 4, gemini: 3 });

    const data = promptData(app.cat.calls[1]!);
    expect(data.allowed_artists).toEqual(['Neighbour X11', 'Neighbour X12']);
    expect(data.listener_wants_to_keep).toBe('something warmer');
    expect(data.do_not_choose_recordings_by).toEqual(['Generic Artist', 'Other Artist', 'Neighbour X13']);
    expect((data.already_shown_recordings as unknown[]).length).toBe(3);
    expect(r.body.panel.choices.map((c: { title: string }) => c.title)).toEqual(['Warm Song']);
    expect(gapsOf(r.body)).toEqual({ previously_shown: 1, outside_anchor: 1 });
    expect(r.body.panel.basis).toEqual([
      'The artist connections from the earlier search were reused; no new artist lookup was made.',
      'Now keeping: “something warmer”.',
      'Left out at your request: Neighbour X13.',
      '3 recordings already shown were left out.',
    ]);
    expect(r.body.connection.why).toContain('These artist connections were reused from the earlier search; no new artist lookup was made.');

    // Provenance: same pool (creation brief kept), new consuming brief/plan, historical pool not mutated.
    const [initialPlan, correctionPlan] = app.store.plans;
    expect(app.store.pools[1]).toBeNull();
    expect(correctionPlan!.poolId).toBe(initialPlan!.poolId);
    expect(correctionPlan!.provenance).toEqual({ ...initialPlan!.provenance, poolReuse: 'reused_same_fingerprint' });
    expect(correctionPlan!.briefId).not.toBe(initialPlan!.briefId);
    expect(correctionPlan!.anchors.map((a) => a.name)).toEqual(['Neighbour X11', 'Neighbour X12']);
    const bucket = await app.store.bucket();
    expect(bucket.pools).toHaveLength(1);
    expect(bucket.pools[0]!.artists.map((a) => a.identity.name)).toEqual(['Neighbour X11', 'Neighbour X12', 'Neighbour X13']);
    expect(bucket.pools[0]!.sourceBriefId).toBe(initialPlan!.briefId);
    const brief = bucket.briefs.find((b) => b.id === correctionPlan!.briefId)!;
    expect(brief).toMatchObject({ relationship: 'something warmer', relationshipSource: 'listener_text', proposedArtists: ['Generic Artist', 'Other Artist'], exclusions: ['Neighbour X13'] });
    expect(brief.refinement).toMatchObject({ mode: 'correct_direction', excludedAnchors: [x13], followChoice: null });
    expect(brief.refinement!.admittedFeedback.map((f) => f.fit)).toEqual(['not_right', 'not_right', 'not_right']);
    expect(r.body.history[0].choices.every((c: { feedback: { fit: string } }) => c.feedback.fit === 'not_right')).toBe(true);
    noLeaks(app.snapshots);
  });

  it('find fresh recordings after all are familiar; same-video and different-credit-subset proposals are not fresh; honest no-match', async () => {
    const fresh = envelope([
      // The exact shown video: rejected before any metadata request.
      { title: 'Invented Song 1', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(1) },
      // Same recording with a different model-declared credit subset: rejected (incomplete credits), never a new key.
      { title: 'Invented Song 1', artists: ['Neighbour X11', 'Outside Collaborator'], anchor: 'Neighbour X11', videoId: VID(45) },
      // Same recording, another upload: excluded by identity.
      { title: 'Invented Song 2', artists: ['Neighbour X12'], anchor: 'Neighbour X12', videoId: VID(42) },
    ]);
    const app = await setup({ catalogue: (i) => (i === 0 ? envelope(THREE) : fresh) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    for (const c of snap.panel!.choices) await app.feedback(cookie, snap.panel!.handle, c.handle, null, 'known');
    const metaBefore = app.net.metadataRequests.length;
    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(r.body).toMatchObject({ stage: 'no_match', status: 'choices_ready', panel: { outcome: 'no_match', choices: [] }, refinement: { used: true } });
    expect(gapsOf(r.body)).toEqual({ previously_shown: 2, credits_unconfirmed: 1 });
    expect(app.net.metadataRequests.length - metaBefore).toBe(2);
    expect(r.body.panel.basis[1]).toBe(`Still keeping: “${snap.brief!.relationship}”.`);
    expect(app.store.plans[1]!.recordingExclusions.known).toHaveLength(3);
    // The truthful no-match keeps the original panel; it is recovery, not refinement success.
    expect(r.body.history[0].choices).toHaveLength(3);
  });

  it('rejects an intact Search identity transplanted into a pool before follow dispatch', async () => {
    class TransplantedContext extends CapturingStore {
      override async loadRefineContext(owner: Owner, attemptId: Handle, now: number) {
        const ctx = await super.loadRefineContext(owner, attemptId, now);
        if (!ctx) return null;
        const copy = structuredClone(ctx);
        Object.assign(copy.fromPool.artists[0]!, { identity: copy.searches[0]!.candidates[0]!.identity });
        return copy;
      }
    }
    const app = await setup({ store: new TransplantedContext({ maxSessions: 10, maxJourneysPerSession: 3 }) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const choice = snap.panel!.choices[0]!.handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', null);
    const before = app.usage();
    const result = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice });
    expect(result.body).toMatchObject({ stage: 'failed', code: 'stale_version', refinement: { used: true } });
    expect(app.usage()).toEqual(before);
    expect(app.cat.calls).toHaveLength(1);
  });

  it('rejects reuse of an invalidated pool before admission (nothing spent), and again at the harness boundary', async () => {
    class TamperedRead extends CapturingStore {
      override async read(sessionId: Handle, epoch: number, now: number) {
        const b = await super.read(sessionId, epoch, now);
        if (!b || b.pools.length === 0) return b;
        const copy = structuredClone(b) as unknown as { pools: { seeds: { entityId: string }[] }[] };
        copy.pools[0]!.seeds[0]!.entityId = uid(999);
        return copy as unknown as SessionBucket;
      }
    }
    const a = await setup({ store: new TamperedRead({ maxSessions: 10, maxJourneysPerSession: 3 }) });
    const one = await a.initial(['Generic Artist']);
    const usage = a.usage();
    const res = await a.refine(one.cookie, { mode: 'correct_direction', panel: one.snap.panel!.handle, brief: one.snap.brief!.handle });
    expect([res.status, res.body.error]).toEqual([409, 'stale_version']);
    expect(a.usage()).toEqual(usage);
    expect(a.cat.calls).toHaveLength(1);
    expect(a.store.refineInputs).toHaveLength(0);

    class TamperedContext extends CapturingStore {
      override async loadRefineContext(owner: Owner, attemptId: Handle, now: number) {
        const ctx = await super.loadRefineContext(owner, attemptId, now);
        if (!ctx) return null;
        const copy = structuredClone(ctx) as RefineContext & { fromPool: { artists: { identity: { name: string } }[] } };
        copy.fromPool.artists[0]!.identity.name = 'Substituted Artist';
        return copy;
      }
    }
    const b = await setup({ store: new TamperedContext({ maxSessions: 10, maxJourneysPerSession: 3 }) });
    const two = await b.initial(['Generic Artist']);
    const before = b.usage();
    const r = await b.refine(two.cookie, { mode: 'correct_direction', panel: two.snap.panel!.handle, brief: two.snap.brief!.handle });
    expect(r.body).toMatchObject({ stage: 'failed', code: 'stale_version', refinement: { used: true } });
    // No dispatch happened, but the admitted allowance is conservatively spent and not reset.
    expect(b.usage()).toEqual(before);
    expect(b.cat.calls).toHaveLength(1);
    expect(r.body.panel.handle).toBe(two.snap.panel!.handle);
  });
});

describe('shared admission, replay, revocation and counting', () => {
  it('concurrent modes cannot both claim the allowance; exact replay returns the owned result; conflicts are refused', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await setup({
      qloo: qlooFixture({ artists: gate, afterInitial: true }),
      catalogue: (i) => (i === 0 ? envelope(THREE) : envelope([{ title: 'Fresh Song 1', artists: ['Neighbour F31'], anchor: 'Neighbour F31', videoId: VID(31) }])),
    });
    const { cookie, snap } = await app.initial();
    const song2 = choiceBy(snap, 'Invented Song 2').handle;
    await app.feedback(cookie, snap.panel!.handle, song2, 'like', null);
    const body = { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice: song2 };
    const followKey = app.key();
    const follow = app.refine(cookie, body, followKey);
    for (let i = 0; i < 50 && app.calls.filter((c) => kind(c) === 'artists').length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));

    // While the follow runs: a correction is refused (one active operation) and a feedback save does not cancel it.
    const concurrent = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(concurrent.body.error).toBe('operation_active');
    expect((await app.feedback(cookie, snap.panel!.handle, song2, 'like', 'new', 1)).status).toBe(200);
    // Exact replay while running is the same operation, not a second dispatch.
    const replayRunning = app.refine(cookie, body, followKey);
    release();
    const done = await follow;
    expect(done.body).toMatchObject({ stage: 'complete', refinement: { used: true } });
    expect((await replayRunning).status).toBe(200);
    expect(app.calls.filter((c) => kind(c) === 'artists')).toHaveLength(2);

    // Exact replay after completion returns the owned snapshot without new work; a changed body conflicts.
    const replay = await app.refine(cookie, body, followKey);
    expect([replay.status, replay.body.panel.handle]).toEqual([200, done.body.panel.handle]);
    expect((await app.refine(cookie, { ...body, choice: snap.panel!.choices[0]!.handle }, followKey)).body.error).toBe('action_conflict');
    // A key used for a different operation kind conflicts too (shared action namespace).
    expect((await app.send('POST', '/api/discover', { body: { brief: snap.brief!.handle, actionKey: followKey }, cookie })).body.error).toBe('action_conflict');
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: done.body.panel.handle, brief: done.body.brief.handle })).body.error).toBe('refinement_used');
    expect(app.usage()).toEqual({ qloo: 5, gemini: 3 });
    expect(app.cat.calls).toHaveLength(2);
    expect(app.store.refineInputs.filter((x) => x.mode === 'follow_connection')).toHaveLength(1);
  });

  it('Stop during a held generation revokes it; the unknown call stays counted, the allowance stays used and nothing late commits', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await setup({
      catalogue: async (i) => {
        if (i === 0) return envelope(THREE);
        await gate;
        return envelope([{ title: 'Warm Song', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(44) }]);
      },
    });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const k = app.key();
    const running = app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle }, k);
    for (let i = 0; i < 50 && app.cat.calls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(app.cat.calls).toHaveLength(2);
    const stopped = await app.send('POST', '/api/stop', { body: { actionKey: k }, cookie });
    expect(stopped.body.stage).toBe('cancelled');
    const done = await running;
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(done.body.panel.handle).toBe(snap.panel!.handle);
    expect(app.cat.calls[1]!.signal.aborted).toBe(true);
    const s = await app.state(cookie);
    expect(s).toMatchObject({ stage: 'cancelled', refinement: { used: true }, history: [] });
    expect(s.panel!.handle).toBe(snap.panel!.handle);
    // Dispatched (unknown) generation stays counted; Stop resets nothing.
    expect(app.usage()).toEqual({ qloo: 3, gemini: 3 });
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: s.brief!.handle })).body.error).toBe('refinement_used');
    expect(app.net.metadataRequests.length).toBe(3);
  });

  it('Clear during a held follow Insights call revokes access; the dispatched call stays counted in the service', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await setup({ qloo: qlooFixture({ artists: gate, afterInitial: true }) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const choice = snap.panel!.choices[0]!.handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', null);
    const running = app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice });
    for (let i = 0; i < 50 && app.calls.filter((c) => kind(c) === 'artists').length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    await app.send('DELETE', '/api/session', { cookie });
    release();
    await running;
    await new Promise((r) => setTimeout(r, 20));
    expect(app.calls.at(-1)!.signal.aborted).toBe(true);
    expect(app.usage()).toEqual({ qloo: 4, gemini: 2 });
    expect(app.cat.calls).toHaveLength(1);
    expect((await app.state(cookie)).session).toBeNull();
    // A new session cannot touch the old Journey's handles.
    const fresh = await app.newSession();
    expect((await app.feedback(fresh, snap.panel!.handle, choice, 'like', null)).status).toBe(404);
    expect((await app.refine(fresh, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice })).body.error).toBe('stale_version');
  });

  it('a refinement past its execute deadline fails honestly without a generation; counted work stays counted', async () => {
    class ShortDeadline extends CapturingStore {
      override async admitRefine(input: AdmitRefineInput) {
        const r = await super.admitRefine(input);
        if (r.kind !== 'admitted') return r;
        // Test-only: shrink this refine Attempt's deadline so the catalogue cannot fit its reserve.
        const internal = (this as unknown as { buckets: Map<Handle, { attempt: { deadlineAt: number } }> }).buckets.get(input.sessionId)!;
        internal.attempt.deadlineAt = input.now + 2_000;
        return { ...r, attempt: { ...r.attempt, deadlineAt: input.now + 2_000 } };
      }
    }
    const app = await setup({ store: new ShortDeadline({ maxSessions: 10, maxJourneysPerSession: 3 }) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const choice = snap.panel!.choices[0]!.handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', null);
    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice });
    expect(r.body).toMatchObject({ stage: 'failed', code: 'deadline', refinement: { used: true } });
    // The Insights call ran (counted); the generation could not fit min(90 s, remaining - 20 s) and was never sent.
    expect(app.usage()).toEqual({ qloo: 4, gemini: 2 });
    expect(app.cat.calls).toHaveLength(1);
    expect(r.body.panel.handle).toBe(snap.panel!.handle);
  });

  it('an expired session refuses refinement and feedback (expiry revokes on first touch)', async () => {
    const clock = { t: Date.now() };
    const app = await setup({ clock });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const usage = app.usage();
    clock.t += 60 * 60 * 1000 + 1;
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle })).body.error).toBe('session_expired');
    expect((await app.feedback(cookie, snap.panel!.handle, snap.panel!.choices[0]!.handle, 'like', null)).body.error).toBe('no_session');
    expect(app.usage()).toEqual(usage);
  });
});

describe('the connection always explains the recording that is shown', () => {
  /** Test-only: a refine Attempt whose deadline cannot fit the catalogue, so the new investigation commits and then fails. */
  class ShortDeadline extends CapturingStore {
    override async admitRefine(input: AdmitRefineInput) {
      const r = await super.admitRefine(input);
      if (r.kind !== 'admitted') return r;
      const internal = (this as unknown as { buckets: Map<Handle, { attempt: { deadlineAt: number } }> }).buckets.get(input.sessionId)!;
      internal.attempt.deadlineAt = input.now + 2_000;
      return { ...r, attempt: { ...r.attempt, deadlineAt: input.now + 2_000 } };
    }
  }
  type Internal = { pools: { id: Handle }[]; plans: { id: Handle; poolId: Handle }[]; panels: { planId: Handle }[] };
  const internalBucket = (app: Awaited<ReturnType<typeof setup>>) => (app.store as unknown as { buckets: Map<Handle, Internal> }).buckets.get(app.store.refineInputs[0]!.sessionId)!;
  const connectionOf = (s: SafeSnapshot) => JSON.stringify(s.connection);
  const names = (s: SafeSnapshot) => s.connection!.anchors.map((a) => a.name);

  /** Initial success, a liked choice, then a Follow whose new Qloo pool commits and whose catalogue then fails. */
  async function failedFollow() {
    const app = await setup({ store: new ShortDeadline({ maxSessions: 10, maxJourneysPerSession: 3 }) });
    const { cookie, snap } = await app.initial();
    const choice = choiceBy(snap, 'Invented Song 2').handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', 'known');
    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice });
    return { app, cookie, snap, choice, r };
  }

  it('an initial success is explained by its own plan and pool', async () => {
    const app = await setup();
    const { snap } = await app.initial();
    const [plan] = app.store.plans;
    expect(snap.connection).toMatchObject({ synthetic: false, seeds: ['Generic Artist', 'Other Artist'], capability: 'artists_and_tags' });
    expect(snap.connection!.anchors).toEqual(plan!.anchors.map((a) => ({ handle: a.handle, name: a.name })));
    expect(names(snap)).toEqual(['Neighbour X11', 'Neighbour X12', 'Neighbour X13']);
    expect(snap.panel!.outcome).toBe('choices');
  });

  it('a failed new-pool Follow keeps the retained recording explained by its OLD connection, in the response and the state', async () => {
    const { app, cookie, snap, choice, r } = await failedFollow();
    // The new investigation really committed a different plan and pool, so this is the divergence being tested.
    expect(app.store.plans).toHaveLength(2);
    expect(app.store.plans[1]!.poolId).not.toBe(app.store.plans[0]!.poolId);
    expect(app.store.plans[1]!.anchors.map((a) => a.name)).toContain('Neighbour F31');

    expect(r.body).toMatchObject({ stage: 'failed', code: 'deadline', refinement: { used: true } });
    for (const s of [r.body as SafeSnapshot, await app.state(cookie)]) {
      expect(connectionOf(s)).toBe(connectionOf(snap));
      expect(names(s)).toEqual(['Neighbour X11', 'Neighbour X12', 'Neighbour X13']);
      expect(JSON.stringify(s.connection)).not.toMatch(/F31|F32|Neighbour X12 together/);
      expect(s.panel!.handle).toBe(snap.panel!.handle);
      expect(s.panel!.role).toBe('initial');
      expect(s.history).toEqual([]);
      expect(s.brief!.handle).not.toBe(snap.brief!.handle);
      // The Why story is one story: its connection and evidence both describe the retained panel. (A replaced brief
      // still changes the sheet's opaque identity, so a sheet opened before the Follow closes rather than updating in place.)
      expect(whyIdentity(s)).not.toBe(whyIdentity(snap));
      expect(resolveWhy(whyIdentity(snap), { snapshot: s, clearing: false, redacted: false })).toBeNull();
      expect(resolveWhy(whyIdentity(s), { snapshot: s, clearing: false, redacted: false })?.recordings).toEqual({ outcome: 'choices', count: 3, refined: false, synthetic: false });
    }
    // The old source unit and feedback are intact, and feedback stays free and independent.
    const state = await app.state(cookie);
    expect(state.panel!.choices.find((c) => c.handle === choice)!.feedback).toMatchObject({ fit: 'like', familiarity: 'known' });
    const saved = await app.feedback(cookie, snap.panel!.handle, choice, 'not_right', null, 1);
    expect(saved.status).toBe(200);
    expect(connectionOf(saved.body)).toBe(connectionOf(snap));
    expect((await app.state(cookie)).panel!.choices.find((c) => c.handle === choice)!.feedback).toMatchObject({ fit: 'not_right', familiarity: null });
    noLeaks(app.snapshots);
  });

  it('a Stopped new-pool Follow keeps the OLD connection and never shows the cancelled investigation', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await setup({
      catalogue: async (i) => {
        if (i === 0) return envelope(THREE);
        await gate;
        return envelope([{ title: 'Fresh Song 1', artists: ['Neighbour F31'], anchor: 'Neighbour F31', videoId: VID(31) }]);
      },
    });
    const { cookie, snap } = await app.initial();
    const choice = snap.panel!.choices[0]!.handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', null);
    const k = app.key();
    const running = app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice }, k);
    for (let i = 0; i < 50 && app.cat.calls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    // While it runs, the retained recording is still explained by its own connection.
    const during = await app.state(cookie);
    expect(app.store.plans).toHaveLength(2);
    expect(during.attempt).toMatchObject({ kind: 'refine', active: true });
    expect(connectionOf(during)).toBe(connectionOf(snap));
    await app.send('POST', '/api/stop', { body: { actionKey: k }, cookie });
    await running;
    release();
    await new Promise((r) => setTimeout(r, 30));
    const after = await app.state(cookie);
    expect(after).toMatchObject({ stage: 'cancelled', code: 'cancelled' });
    expect(connectionOf(after)).toBe(connectionOf(snap));
    expect(after.panel!.handle).toBe(snap.panel!.handle);
  });

  it('a failed corrected direction (reused pool, new plan) keeps the old connection too, including the anchor it tried to exclude', async () => {
    const app = await setup({ store: new ShortDeadline({ maxSessions: 10, maxJourneysPerSession: 3 }) });
    const { cookie, snap } = await app.initial();
    const x13 = snap.connection!.anchors.find((a) => a.name === 'Neighbour X13')!.handle;
    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle, relationship: { text: 'something warmer' }, excludeArtists: [x13] });
    expect(r.body).toMatchObject({ stage: 'failed', code: 'deadline' });
    expect(app.store.plans).toHaveLength(2);
    expect(app.store.plans[1]!.anchors.map((a) => a.name)).toEqual(['Neighbour X11', 'Neighbour X12']);
    expect(connectionOf(r.body)).toBe(connectionOf(snap));
    expect(names(r.body)).toEqual(['Neighbour X11', 'Neighbour X12', 'Neighbour X13']);
    // The desired brief is the new one, while the shown recording keeps its own explanation.
    expect(r.body.brief).toMatchObject({ relationship: 'something warmer', version: snap.brief!.version + 1 });
    expect(r.body.panel.handle).toBe(snap.panel!.handle);
  });

  it('a successful refined panel is explained by its NEW plan and pool; the old panel in history keeps its own basis', async () => {
    const app = await setup({ catalogue: (i) => (i === 0 ? envelope(THREE) : envelope([{ title: 'Fresh Song 1', artists: ['Neighbour F31'], anchor: 'Neighbour F31', videoId: VID(31) }])) });
    const { cookie, snap } = await app.initial();
    const choice = snap.panel!.choices[1]!.handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', null);
    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice });
    expect(r.body).toMatchObject({ stage: 'complete', panel: { role: 'refinement', outcome: 'choices' } });
    const refined = app.store.plans[1]!;
    expect(r.body.connection.anchors).toEqual(refined.anchors.map((a: { handle: Handle; name: string }) => ({ handle: a.handle, name: a.name })));
    expect(r.body.connection.seeds).toEqual(['Generic Artist', 'Neighbour X12']);
    expect(names(r.body)).toContain('Neighbour F31');
    expect(connectionOf(r.body)).not.toBe(connectionOf(snap));
    expect(whyIdentity(r.body)).not.toBe(whyIdentity(snap));
    expect(r.body.history[0].handle).toBe(snap.panel!.handle);
  });

  it('a refined no-match panel is explained by its NEW plan and pool, and says so', async () => {
    const app = await setup();
    const { cookie, snap } = await app.initial();
    const choice = snap.panel!.choices[0]!.handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', null);
    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice });
    expect(r.body).toMatchObject({ stage: 'no_match', status: 'choices_ready', panel: { role: 'refinement', outcome: 'no_match', choices: [] } });
    expect(r.body.connection.anchors).toEqual(app.store.plans[1]!.anchors.map((a: { handle: Handle; name: string }) => ({ handle: a.handle, name: a.name })));
    expect(names(r.body)).toContain('Neighbour F31');
    expect(resolveWhy(whyIdentity(r.body), { snapshot: r.body, clearing: false, redacted: false })?.recordings).toEqual({ outcome: 'no_match', count: 0, refined: true, synthetic: false });
  });

  it('a successful corrected direction with a changed brief uses its own plan over the reused pool', async () => {
    const app = await setup({ catalogue: (i) => (i === 0 ? envelope(THREE) : envelope([{ title: 'Warm Song', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(44) }])) });
    const { cookie, snap } = await app.initial();
    const x13 = snap.connection!.anchors.find((a) => a.name === 'Neighbour X13')!.handle;
    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle, relationship: { text: 'something warmer' }, excludeArtists: [x13] });
    expect(r.body.stage).toBe('complete');
    const [initialPlan, correctionPlan] = app.store.plans;
    expect(correctionPlan!.poolId).toBe(initialPlan!.poolId);
    expect(correctionPlan!.briefId).not.toBe(initialPlan!.briefId);
    expect(names(r.body)).toEqual(['Neighbour X11', 'Neighbour X12']);
    expect(r.body.connection.why).toContain('These artist connections were reused from the earlier search; no new artist lookup was made.');
    expect(r.body.panel).toMatchObject({ role: 'refinement', mode: 'correct_direction' });
    expect(connectionOf(r.body)).not.toBe(connectionOf(snap));
  });

  describe('missing or inconsistent associated parents fail closed, never to a newer unrelated pool', () => {
    it('a missing pool of the shown panel gives no connection even though a newer pool exists', async () => {
      const { app, cookie, snap } = await failedFollow();
      const bucket = internalBucket(app);
      const planOfPanel = bucket.plans.find((p) => p.id === bucket.panels.at(-1)!.planId)!;
      expect(bucket.pools.length).toBe(2);
      bucket.pools = bucket.pools.filter((p) => p.id !== planOfPanel.poolId);
      expect(bucket.pools).toHaveLength(1);
      const s = await app.state(cookie);
      expect(s.connection).toBeNull();
      expect(s.panel!.handle).toBe(snap.panel!.handle);
      expect(s.panel!.basis).toEqual([]);
      expect(whyIdentity(s)).toBeNull();
      expect(resolveWhy('anything', { snapshot: s, clearing: false, redacted: false })).toBeNull();
    });

    it('a missing plan, or a panel pointing at an unknown plan, gives no connection', async () => {
      const a = await failedFollow();
      const bucketA = internalBucket(a.app);
      bucketA.plans = bucketA.plans.filter((p) => p.id !== bucketA.panels.at(-1)!.planId);
      expect((await a.app.state(a.cookie)).connection).toBeNull();

      const b = await failedFollow();
      internalBucket(b.app).panels.at(-1)!.planId = 'z'.repeat(24) as Handle;
      const s = await b.app.state(b.cookie);
      expect(s.connection).toBeNull();
      expect(s.panel!.handle).toBe(b.snap.panel!.handle);
    });

    it('a plan whose pool is unknown gives no connection', async () => {
      const { app, cookie } = await failedFollow();
      const bucket = internalBucket(app);
      bucket.plans.find((p) => p.id === bucket.panels.at(-1)!.planId)!.poolId = 'y'.repeat(24) as Handle;
      expect((await app.state(cookie)).connection).toBeNull();
    });
  });

  it('with no panel yet the current accepted plan and pool still give the progress connection', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await setup({
      catalogue: async () => {
        await gate;
        return envelope(THREE);
      },
    });
    const cookie = await app.newSession();
    const ref = await app.send('POST', '/api/reference', { body: { url: 'https://youtu.be/dQw4w9WgXcQ', actionKey: app.key() }, cookie });
    const saved = await app.send('POST', '/api/preference', { body: { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist'], actionKey: app.key(), expectedBrief: null }, cookie });
    const running = app.send('POST', '/api/discover', { body: { brief: saved.body.brief.handle, actionKey: app.key() }, cookie });
    for (let i = 0; i < 50 && app.cat.calls.length < 1; i += 1) await new Promise((r) => setTimeout(r, 5));
    const during = await app.state(cookie);
    expect(during.panel).toBeNull();
    expect(during.attempt).toMatchObject({ kind: 'discover', active: true });
    expect(during.connection).toMatchObject({ seeds: ['Generic Artist'] });
    expect(names(during)).toEqual(['Neighbour X11', 'Neighbour X12', 'Neighbour X13']);
    release();
    const done = (await running).body as SafeSnapshot;
    expect(connectionOf(done)).toBe(connectionOf(during));
  });

  it('Clear and expiry still remove the connection with everything else', async () => {
    const { app, cookie } = await failedFollow();
    await app.send('DELETE', '/api/session', { cookie });
    const s = await app.state(cookie);
    expect(s).toMatchObject({ session: null, connection: null, panel: null });

    const clock = { t: Date.now() };
    const timed = await setup({ clock });
    const { cookie: c2 } = await timed.initial();
    clock.t += 60 * 60 * 1000 + 1;
    const expired = await timed.state(c2);
    expect(expired).toMatchObject({ session: null, connection: null, panel: null });
  });
});

describe('labelled synthetic mode', () => {
  it('a synthetic correction produces different invented tracks, labelled, with no Play destinations', async () => {
    const app = await setup({ synthetic: true });
    const { cookie, snap } = await app.initial(['Any Name']);
    expect(snap.panel!.synthetic).toBe(true);
    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(r.body.panel).toMatchObject({ synthetic: true, role: 'refinement' });
    expect(r.body.panel.choices.length).toBeGreaterThan(0);
    const first = new Set(snap.panel!.choices.map((c) => c.title));
    expect(r.body.panel.choices.every((c: { title: string; playUrl: string | null }) => !first.has(c.title) && c.playUrl === null)).toBe(true);
    expect(r.body.connection.why.join(' ')).toMatch(/synthetic local fixture \(not Qloo\)/);
  });
});

describe('Apple Music destinations through the owned pipeline (explicit capability)', () => {
  const APPLE_URL = (n: number, sf = 'us') => `https://music.apple.com/${sf}/song/invented-song/${AID(n)}`;
  const ALBUM_URL = (n: number, sf = 'us') => `https://music.apple.com/${sf}/album/invented-album/${AID(90)}?i=${AID(n)}`;
  const apple = (title: string, anchor: string, listen: string, extra: Partial<FixtureChoice> = {}): FixtureChoice => ({ title, artists: [anchor], anchor, videoId: '', listen, ...extra });
  const APPLE_THREE: FixtureChoice[] = [
    apple('Invented Song 1', 'Neighbour X11', APPLE_URL(1)),
    apple('Invented Song 2', 'Neighbour X12', ALBUM_URL(2)),
    apple('Invented Song 3', 'Neighbour X13', APPLE_URL(3)),
  ];
  const APPLE_META: Record<string, AppleEntry> = {
    [AID(1)]: { trackName: 'Invented Song 1', artistName: 'Neighbour X11' },
    [AID(2)]: { trackName: 'Invented Song 2', artistName: 'Neighbour X12' },
    [AID(3)]: { trackName: 'Invented Song 3', artistName: 'Neighbour X13' },
    [AID(10)]: { trackName: 'Warm Song', artistName: 'Neighbour X11' },
    [AID(11)]: { trackName: 'Invented Song 1 (Live)', artistName: 'Neighbour X11' },
  };
  const lookups = (app: Awaited<ReturnType<typeof setup>>) => app.net.metadataRequests.filter((r) => r.url.hostname === 'itunes.apple.com');
  const oembeds = (app: Awaited<ReturnType<typeof setup>>) => app.net.metadataRequests.filter((r) => r.url.pathname === '/oembed');

  it.each(['native', 'harness', 'store'] as const)('retains a legacy Unicode recording exclusion at the %s boundary', async (guard) => {
    const before = 'Invented lantern 東京';
    const different = 'Invented lantern 大阪';
    const anchor = 'Neighbour X11';
    const legacyKey = 'invented lantern|neighbour x11|';
    const current = matchFirstPartyIdentity({ title: before, artists: [anchor] }, anchor, { trackName: before, artistName: anchor });
    if (!current.ok) throw new Error('Invented exact evidence did not match');
    const repeat = (c: TrackChoice): TrackChoice => ({ ...c, title: before, recordingKey: current.recordingKey });
    // Model a panel persisted by the earlier writer, whose matcher erased the
    // title suffix. Keep its raw title/credits, immutable key and feedback.
    class LegacyKeyStore extends CapturingStore {
      override async commitPanel(owner: Owner, attemptId: Handle, panel: ChoicePanel, now: number) {
        const choices = guard === 'store' ? panel.choices.map(repeat) : panel.choices;
        const stored = this.plans.length === 1
          ? { ...panel, choices: panel.choices.map(c => ({ ...c, recordingKey: legacyKey })), recordingKeys: [legacyKey] }
          : { ...panel, choices, recordingKeys: choices.map(c => c.recordingKey) };
        return super.commitPanel(owner, attemptId, stored, now);
      }
    }
    const store = new LegacyKeyStore({ maxSessions: 10, maxJourneysPerSession: 3 });
    const app = await setup({
      store,
      services: ['youtube', 'apple_music'],
      apple: {
        [AID(1)]: { trackName: before, artistName: anchor },
        [AID(2)]: { trackName: before, artistName: anchor },
        [AID(3)]: { trackName: different, artistName: anchor },
      },
      catalogue: i => envelope(i === 0
        ? [apple(before, anchor, APPLE_URL(1))]
        : [apple(before, anchor, APPLE_URL(2)), apple(different, anchor, APPLE_URL(3))]),
      catalogueWrap: seam => ({
        async investigate(handoff, inputs, context) {
          const result = await seam.investigate(handoff, inputs, context);
          if (guard !== 'harness' || inputs.plan.recordingExclusions.shown.length === 0 || result.kind !== 'panel') return result;
          const choices = result.panel.choices.map(repeat);
          return { ...result, panel: { ...result.panel, choices, recordingKeys: choices.map(c => c.recordingKey) } };
        },
      }),
    });
    const { cookie, snap } = await app.initial();
    expect(snap.panel!.choices.map(c => c.title)).toEqual([before]);
    await app.feedback(cookie, snap.panel!.handle, snap.panel!.choices[0]!.handle, null, 'known');
    const initialLookups = app.calls.length;
    const refined = (await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle })).body as SafeSnapshot;
    if (guard === 'native') {
      expect(refined.panel!.choices.map(c => c.title)).toEqual([different]);
      expect(gapsOf(refined)).toEqual({ previously_shown: 1 });
      expect(refined.history[0]!.choices[0]!.feedback.familiarity).toBe('known');
    } else {
      // Force the repeat past each earlier layer; the next boundary must reject
      // it without committing a panel or restoring the admitted allowance.
      expect(refined).toMatchObject({ stage: 'failed', code: guard === 'harness' ? 'catalogue_failed' : 'stale_version', refinement: { used: true } });
      expect(refined.panel!.handle).toBe(snap.panel!.handle);
      expect(refined.panel!.choices[0]!.feedback.familiarity).toBe('known');
      expect(refined.history).toHaveLength(0);
    }
    expect(store.plans[1]!.recordingExclusions).toMatchObject({
      shown: [{ key: legacyKey, title: before, credits: [anchor] }], known: [legacyKey],
    });
    expect(app.calls).toHaveLength(initialLookups); // Correction reuses the actual owned pool; no new Qloo request.
  });

  it('verifies Apple song destinations by first-party ID lookup, then keeps one recording excluded across providers and storefronts in a refinement', async () => {
    const REFINED: FixtureChoice[] = [
      // Another provider's upload of a recording already shown: verified, then excluded by its recording identity.
      { title: 'Invented Song 1', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(41) },
      // The same Apple track in another storefront: excluded by its provider-scoped ID before any lookup.
      apple('Invented Song 1', 'Neighbour X11', APPLE_URL(1, 'gb')),
      apple('Warm Song', 'Neighbour X11', APPLE_URL(10)),
    ];
    const app = await setup({
      services: ['youtube', 'apple_music'],
      apple: APPLE_META,
      catalogue: (i) => envelope(i === 0 ? APPLE_THREE : REFINED),
    });
    const { cookie, snap } = await app.initial();
    expect(snap.panel!.synthetic).toBe(false);
    expect(snap.panel!.choices.map((c) => [c.title, c.service, c.playUrl])).toEqual([
      ['Invented Song 1', 'apple_music', `https://music.apple.com/us/song/${AID(1)}`],
      ['Invented Song 2', 'apple_music', `https://music.apple.com/us/song/${AID(2)}`],
      ['Invented Song 3', 'apple_music', `https://music.apple.com/us/song/${AID(3)}`],
    ]);
    expect(lookups(app).map((r) => r.url.href)).toEqual([1, 2, 3].map((n) => `https://itunes.apple.com/lookup?id=${AID(n)}&country=us&entity=song`));
    expect(oembeds(app)).toHaveLength(0);
    // The complete native answer, citations and Suggestions stay with the panel.
    expect(snap.panel!.answer.text).toContain(APPLE_URL(1));
    expect(snap.panel!.citations.length).toBeGreaterThan(0);
    expect(snap.panel!.suggestionsUrl).not.toBeNull();

    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(r.status).toBe(200);
    const refined = r.body as SafeSnapshot;
    expect(refined.panel!.choices.map((c) => [c.title, c.service, c.playUrl])).toEqual([['Warm Song', 'apple_music', `https://music.apple.com/us/song/${AID(10)}`]]);
    expect(gapsOf(refined)).toEqual({ previously_shown: 2 });
    // The other-storefront duplicate was never looked up; the YouTube upload was checked and then excluded by identity.
    expect(lookups(app).filter((q) => q.url.searchParams.get('id') === AID(1))).toHaveLength(1);
    expect(oembeds(app)).toHaveLength(1);
    // The earlier panel and its feedback stay available.
    expect(refined.history.map((p) => p.choices.length)).toEqual([3]);
    // Shown exclusions carry provider-scoped IDs in their own fields: never an Apple ID in a video-ID field.
    const plan = app.store.plans[1]!;
    expect(plan.recordingExclusions.shown).toEqual(
      [1, 2, 3].map((n) => ({ key: expect.any(String), appleTrackId: AID(n), title: `Invented Song ${n}`, credits: [`Neighbour X${10 + n}`] })),
    );
    noLeaks(app.snapshots);
  });

  it('keeps one recording once in a mixed panel and refuses a live version for the proposed studio recording', async () => {
    const MIXED: FixtureChoice[] = [
      { title: 'Invented Song 1', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(1) },
      apple('Invented Song 1', 'Neighbour X11', APPLE_URL(1)),
      apple('Invented Song 1', 'Neighbour X11', APPLE_URL(11)),
    ];
    const app = await setup({ services: ['youtube', 'apple_music'], apple: APPLE_META, catalogue: () => envelope(MIXED) });
    const { snap } = await app.initial();
    expect(snap.panel!.choices.map((c) => [c.title, c.service])).toEqual([['Invented Song 1', 'youtube']]);
    expect(gapsOf(snap)).toEqual({ duplicate_recording: 1, version_mismatch: 1 });
  });

  it('records throttling and a different catalogue track as explicit gaps, with no retry and no substitute', async () => {
    const app = await setup({
      services: ['apple_music'],
      apple: { [AID(1)]: { status: 429 }, [AID(2)]: { trackName: 'Invented Song 2', artistName: 'Neighbour X12', trackId: Number(AID(7)) }, [AID(3)]: APPLE_META[AID(3)]! },
      catalogue: () => envelope(APPLE_THREE),
    });
    const { snap } = await app.initial();
    expect(snap.panel!.choices.map((c) => c.title)).toEqual(['Invented Song 3']);
    expect(gapsOf(snap)).toEqual({ metadata_throttled: 1, destination_mismatch: 1 });
    expect(lookups(app)).toHaveLength(3);
  });

  it('without the capability, Apple links are unsupported and Apple is never contacted', async () => {
    const app = await setup({ apple: APPLE_META, catalogue: () => envelope(APPLE_THREE) });
    const { snap } = await app.initial();
    expect(snap.panel!.outcome).toBe('no_match');
    expect(gapsOf(snap)).toEqual({ unsupported_destination: 3 });
    expect(app.net.metadataRequests).toHaveLength(0);
    // An Apple-only capability likewise refuses YouTube links without contacting YouTube.
    const appleOnly = await setup({ services: ['apple_music'], apple: APPLE_META, catalogue: () => envelope(THREE) });
    const r = await appleOnly.initial();
    expect(gapsOf(r.snap)).toEqual({ unsupported_destination: 3 });
    expect(appleOnly.net.metadataRequests).toHaveLength(0);
  });
});

describe('a provider 429/503 on the catalogue or a later Qloo call is named as the service, never as a bad result', () => {
  const SECRET_BODY = { error: { message: 'SECRET-PROVIDER-TEXT project-0001 quota detail https://provider.invalid/p?key=abc' } };
  const refused = (status: number) => json(status, SECRET_BODY);
  const leaks = (snapshots: string[]) => {
    noLeaks(snapshots);
    for (const s of snapshots) for (const text of ['SECRET-PROVIDER-TEXT', 'project-0001', 'provider.invalid', 'quota detail']) expect(s).not.toContain(text);
  };
  type Held = { attempt: { outcome: string; failure: string | null; calls: { stage: string; state: string }[] } | null };
  const attemptOf = (app: Awaited<ReturnType<typeof setup>>) => [...(app.store as unknown as { buckets: Map<Handle, Held> }).buckets.values()][0]!.attempt!;
  const PROSE_DENIED = /quota|daily|payment|billing|pay |upgrade|minutes|seconds|tomorrow|later today|bad match|not a match|no match|rights|copyright|licen[cs]e/i;

  it.each([
    [429, 'provider_limited'],
    [503, 'provider_unavailable'],
  ] as const)('initial Discover: catalogue HTTP %i is %s, keeps the connection, counts, held dispatch and zero retries', async (status, code) => {
    const app = await setup({ catalogue: () => refused(status) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    expect(snap).toMatchObject({ stage: 'failed', code, panel: null, status: 'connection_ready' });
    expect(snap.connection).not.toBeNull();
    expect(app.cat.calls).toHaveLength(1);
    expect(app.net.metadataRequests).toHaveLength(0);
    expect(app.usage()).toEqual({ qloo: 3, gemini: 2 });
    const attempt = attemptOf(app);
    expect(attempt).toMatchObject({ outcome: 'failed', failure: code });
    expect(attempt.calls.every((c) => c.state === 'returned')).toBe(true);
    expect(attempt.calls.map((c) => c.stage)).toContain('catalogue_generation');

    // Restoration shows the same closed code; reading is never a retry.
    expect(await app.state(cookie)).toMatchObject({ stage: 'failed', code });
    await new Promise((r) => setTimeout(r, 20));
    expect(app.cat.calls).toHaveLength(1);
    expect(app.usage()).toEqual({ qloo: 3, gemini: 2 });

    // The sentence is about the service at that moment only: no cause beyond the status, no time, money, match or rights claim.
    const text = discoveryOutcome(snap)!;
    expect(text).toMatch(code === 'provider_limited' ? /limited this request/ : /is unavailable/);
    expect(text).toContain('No new picks were added.');
    expect(text).not.toMatch(PROSE_DENIED);
    leaks(app.snapshots);
  });

  it.each([500, 502, 401, 400])('catalogue HTTP %i keeps the existing generic recovery', async (status) => {
    const app = await setup({ catalogue: () => refused(status) });
    const { snap } = await app.initial(['Generic Artist']);
    expect(snap).toMatchObject({ stage: 'failed', code: 'catalogue_failed' });
    expect(discoveryOutcome(snap)).not.toMatch(/limited|temporarily/);
  });

  it('a refined search the catalogue limits keeps the earlier choices, still counts as used and cannot be retried', async () => {
    const app = await setup({ catalogue: (i) => (i === 0 ? envelope(THREE) : refused(429)) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const qloo = app.calls.length;
    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(r.body).toMatchObject({ stage: 'failed', code: 'provider_limited', refinement: { used: true } });
    expect(r.body.panel.handle).toBe(snap.panel!.handle);
    expect(app.cat.calls).toHaveLength(2);
    expect(app.calls.length).toBe(qloo);
    expect(app.usage()).toEqual({ qloo: 3, gemini: 3 });
    const text = discoveryOutcome(r.body)!;
    expect(text).toContain('limited this request');
    expect(text).toContain('Refinement used.');
    expect(text).toContain('Your previous picks are still here.');
    expect(text).not.toMatch(PROSE_DENIED);
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: r.body.brief.handle })).body.error).toBe('refinement_used');
    expect(app.cat.calls).toHaveLength(2);
    leaks(app.snapshots);
  });

  it('a Follow whose new artist Insights call is answered 503 is the service outage, with the old panel kept and the call counted', async () => {
    const base = qlooFixture();
    let artists = 0;
    const app = await setup({ qloo: async (req) => (kind(req) === 'artists' && (artists += 1) === 2 ? refused(503) : base(req)) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const choice = snap.panel!.choices[0]!.handle;
    await app.feedback(cookie, snap.panel!.handle, choice, 'like', null);
    const r = await app.refine(cookie, { mode: 'follow_connection', panel: snap.panel!.handle, brief: snap.brief!.handle, choice });
    expect(r.body).toMatchObject({ stage: 'failed', code: 'provider_unavailable', refinement: { used: true } });
    expect(r.body.panel.handle).toBe(snap.panel!.handle);
    expect(app.cat.calls).toHaveLength(1);
    expect(app.usage()).toEqual({ qloo: 4, gemini: 2 });
    expect(discoveryOutcome(r.body)).toContain('is unavailable');
    leaks(app.snapshots);
  });

  it('Stop wins over a late catalogue 429: cancelled, never a service cause; the dispatched generation stays counted', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await setup({
      catalogue: async (i) => {
        if (i === 0) return envelope(THREE);
        await gate;
        return refused(429);
      },
    });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const k = app.key();
    const running = app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle }, k);
    for (let i = 0; i < 50 && app.cat.calls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect((await app.send('POST', '/api/stop', { body: { actionKey: k }, cookie })).body.stage).toBe('cancelled');
    await running;
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(await app.state(cookie)).toMatchObject({ stage: 'cancelled', code: 'cancelled' });
    expect(app.usage()).toEqual({ qloo: 3, gemini: 3 });
  });

  it('Clear wins over a late catalogue 503: nothing is stored or readable afterwards', async () => {
    const { gate, release } = fixtureHttp.gate();
    const app = await setup({
      catalogue: async (i) => {
        if (i === 0) return envelope(THREE);
        await gate;
        return refused(503);
      },
    });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const running = app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    for (let i = 0; i < 50 && app.cat.calls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    await app.send('DELETE', '/api/session', { cookie });
    release();
    await running;
    await new Promise((r) => setTimeout(r, 30));
    expect((await app.state(cookie)).session).toBeNull();
    expect(await app.state(cookie)).toMatchObject({ code: null, panel: null, connection: null });
  });

  it('a 429 that arrives after the Attempt deadline is a deadline, not a service cause', async () => {
    const clock = { t: Date.now() };
    const app = await setup({
      clock,
      catalogue: (i) => {
        if (i === 0) return envelope(THREE);
        clock.t += 30 * 60 * 1000;
        return refused(429);
      },
    });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(r.body).toMatchObject({ stage: 'failed', code: 'deadline', refinement: { used: true } });
    expect(app.cat.calls).toHaveLength(2);
  });

  it.each([
    [429, 'provider_limited'],
    [503, 'provider_unavailable'],
  ] as const)('a refinement answered %i over a HIDDEN earlier panel stays hidden, says so, and does not reclassify, unhide or reset anything', async (status, code) => {
    const app = await setup({ catalogue: (i) => (i === 0 ? envelope(THREE) : refused(status)) });
    const { cookie, snap } = await app.initial(['Generic Artist']);
    // As a stored unit that can no longer be presented safely would be (the stored record is not what is judged on read).
    for (const bucket of (app.store as unknown as { buckets: Map<Handle, { panels: { suggestionsHtml: string }[] }> }).buckets.values()) {
      for (const stored of bucket.panels) stored.suggestionsHtml = '<script>unsafe()</script>';
    }
    const hiddenBefore = await app.state(cookie);
    expect(hiddenBefore.panel).toMatchObject({ outcome: 'source_unavailable', choices: [], suggestionsUrl: null });

    const r = await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: snap.brief!.handle });
    expect(r.body).toMatchObject({ stage: 'failed', code, refinement: { used: true }, panel: { outcome: 'source_unavailable', choices: [], suggestionsUrl: null } });
    const text = discoveryOutcome(r.body)!;
    expect(text).toContain('Refinement used.');
    expect(text.endsWith('Previous results stay hidden while sources are unavailable.')).toBe(true);
    expect(text).not.toMatch(/choices|kept above/i);
    // Nothing is unhidden or leaked, no second refinement is given, and no extra request or count appears.
    expect(JSON.stringify(r.body.panel)).not.toMatch(/Invented Song|youtube\.com|playUrl":"https|Source/);
    expect(app.cat.calls).toHaveLength(2);
    expect(app.usage()).toEqual({ qloo: 3, gemini: 3 });
    expect((await app.refine(cookie, { mode: 'correct_direction', panel: snap.panel!.handle, brief: r.body.brief.handle })).body.error).toBe('refinement_used');
    expect(app.cat.calls).toHaveLength(2);
    expect(await app.state(cookie)).toMatchObject({ code, panel: { outcome: 'source_unavailable' } });
  });});

describe('owned result intent projection', () => {
  it.each(['missing', 'version', 'journeyId', 'sessionId', 'epoch', 'expiresAt'] as const)('never substitutes the current choice when original intent has a %s mismatch', async field => {
    class ChangedRead extends CapturingStore {
      changed = false;
      override async read(sessionId: Handle, epoch: number, now: number) {
        const b = await super.read(sessionId, epoch, now);
        if (!this.changed || !b?.panel || !b.brief) return b;
        return { ...b, brief: { ...b.brief, relationship: 'Newer current cue' }, briefs: b.briefs.flatMap(brief => {
          if (brief.id !== b.panel!.briefId) return [brief];
          if (field === 'missing') return [];
          if (field === 'version' || field === 'epoch' || field === 'expiresAt') return [{ ...brief, [field]: brief[field] + 1 }];
          return [{ ...brief, [field]: 'different-owned-handle-000' as Handle }];
        }) };
      }
    }
    const store = new ChangedRead({ maxSessions: 10, maxJourneysPerSession: 3 }), app = await setup({ store });
    const { cookie } = await app.initial();
    const usage = app.usage(), calls = app.calls.length;
    store.changed = true;
    const state = await app.state(cookie);
    expect(state.brief!.relationship).toBe('Newer current cue');
    expect(state.panel!.intent).toBeNull();
    expect(app.usage()).toEqual(usage); expect(app.calls).toHaveLength(calls); expect(app.cat.calls).toHaveLength(1);
  });

  it('retains only the original safe intent when native presentation is withheld', async () => {
    class WithheldRead extends CapturingStore {
      changed = false;
      override async read(sessionId: Handle, epoch: number, now: number) {
        const b = await super.read(sessionId, epoch, now);
        return this.changed && b?.panel ? { ...b, panel: { ...b.panel, suggestionsHtml: '<div>'.repeat(100) } } : b;
      }
    }
    const store = new WithheldRead({ maxSessions: 10, maxJourneysPerSession: 3 }), app = await setup({ store });
    const { cookie, snap } = await app.initial(); store.changed = true;
    const state = await app.state(cookie);
    expect(state.panel).toMatchObject({ outcome: 'source_unavailable', intent: snap.brief, choices: [], citations: [], answer: { text: '', marks: [] }, suggestionsUrl: null });
    expect(state.panel!.intent).toEqual(snap.brief);
    expect(app.cat.calls).toHaveLength(1);
  });
});
