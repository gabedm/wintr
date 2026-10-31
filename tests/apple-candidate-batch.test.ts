import { describe, expect, it } from 'vitest';
import { createCandidateCatalogue } from '../src/server/candidate-catalogue.js';
import { buildCatalogueHandoff } from '../src/server/catalogue.js';
import { CANDIDATE_SELECTOR_OBSERVATION_PROFILE } from '../src/server/ledger/observation.js';
import { createAppleCandidateBatchBuilder, trustedAppleCandidate, type AppleBatchContext, type AppleBatchInput, type OwnedAppleCandidateBatch } from '../src/server/apple-candidate-batch.js';
import { createAppleCatalogueSearch, type AppleCatalogueSearch } from '../src/server/apple-catalogue-search.js';
import { createAppleMetadataRateGate, type AppleMetadataRateGate, type AppleRateAdmission, type AppleRateContext } from '../src/server/apple-metadata-rate.js';
import { sealIdentity, type IdentityOwner } from '../src/server/identity.js';
import { createAppleMusicVerifier } from '../src/server/verifier.js';
import { createMetadataBudget, METADATA_HEADERS, type MetadataBudget, type PinnedRequest, type PinnedResponse } from '../src/server/net/safe-fetch.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import type { QlooArtistId } from '../src/server/providers/qloo.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createRecordSealer } from '../src/server/seal.js';
import type { Handle } from '../src/shared/records.js';
import { AID } from './fixtures/catalogue-fixtures.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

// Owned Apple candidate batch over the real search seam, the real durable gate on
// the SDK-shaped fake Firestore and the existing identity seal. Every name, ID and
// handle is invented; the fake transport never touches the network or Apple.
// Synthetic fixtures establish neither actual Qloo consumption nor live acceptance.

const H = (s: string) => s.padEnd(24, '0') as Handle;
const NOW = Date.now();
const HOUR = 3_600_000;
const sealer = createRecordSealer(new ServerSecret('synthetic-seal-key-for-tests-only-000001'));
const otherSealer = createRecordSealer(new ServerSecret('synthetic-other-seal-key-tests-000002'));
const uid = (n: number) => `50000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NAMES: [string, string, string, string, string] = ['Neighbour X11', 'Neighbour X12', 'Neighbour X13', 'Neighbour X14', 'Neighbour X15'];
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const ownerFor = (over: Partial<IdentityOwner> = {}): IdentityOwner => ({ sessionId: H('session'), epoch: 1, journeyId: H('journey'), expiresAt: NOW + HOUR, ...over });

/** A valid sealed artist identity. By default it is this fixture pool's artist_insights artist; `prov` builds other (equally validly sealed) provenance. */
const sealed = (n: number, name: string, owner: IdentityOwner, s = sealer, prov: { operation?: 'search' | 'artist_insights'; sourceRecordId?: Handle } = {}) =>
  JSON.parse(
    JSON.stringify(
      sealIdentity({ entityId: uid(n) as QlooArtistId, name, subtypeEvidence: 'subtype', disambiguation: null, external: {}, affinity: null }, { operation: prov.operation ?? 'artist_insights', sourceRecordId: prov.sourceRecordId ?? H('pool') }, owner, s),
    ),
  );

/** Fresh, mutable, JSON-shaped owned records (the shape a store returns). */
function make(o: { owner?: IdentityOwner; anchors?: number; names?: string[] } = {}) {
  const owner = o.owner ?? ownerFor();
  const names = o.names ?? NAMES;
  const owned = { sessionId: owner.sessionId, epoch: owner.epoch, createdAt: NOW, expiresAt: owner.expiresAt };
  const pool = {
    ...owned,
    id: H('pool'),
    journeyId: owner.journeyId,
    sourceBriefId: H('brief'),
    origin: 'initial',
    fingerprint: 'invented',
    synthetic: true,
    seeds: [{ handle: H('seed'), name: 'Seed Artist', entityId: uid(1), role: 'starting' }],
    artists: names.map((name, i) => ({ handle: H(`artist${i}`), identity: sealed(11 + i, name, owner) })),
    tags: [],
    capability: 'artists_only',
    lineage: { artistReturned: names.length, artistRejected: 0, aliasesRemoved: 0, duplicatesRemoved: 0, tagOutcome: 'not_admitted', tagReturned: 0 },
  };
  const plan = {
    ...owned,
    id: H('plan'),
    journeyId: owner.journeyId,
    briefId: H('brief'),
    briefVersion: 1,
    poolId: pool.id,
    relationship: 'invented relationship',
    seedNames: ['Seed Artist'],
    anchors: pool.artists.slice(0, o.anchors ?? 4).map((a) => ({ handle: a.handle, name: a.identity.name })),
    associations: [],
    exclusions: ['Seed Artist'],
    recordingExclusions: { shown: [] as unknown[], known: [] },
    priorities: [],
    refinementMode: null,
    refinement: null,
    attribution: 'seed_mix',
    provenance: { analysisId: H('analysis'), analysisReuse: 'same_source_focus', poolSourceBriefId: H('brief'), poolReuse: 'created' },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { plan: plan as any, pool: pool as any, owner };
}
type Fixture = ReturnType<typeof make>;
const input = (f: Fixture, over: Record<string, unknown> = {}): AppleBatchInput =>
  ({ plan: f.plan, pool: f.pool, owner: { ...f.owner }, executeRef: H('execute'), storefront: 'us', ...over }) as AppleBatchInput;

const row = (id: string, artist: string, storefront = 'us', over: Record<string, unknown> = {}) => ({
  wrapperType: 'track',
  kind: 'song',
  trackId: Number(id),
  trackName: `Invented Song ${id.slice(-4)}`,
  artistName: artist,
  trackViewUrl: `https://music.apple.com/${storefront}/album/invented/9000000001?i=${id}&uo=4`,
  previewUrl: 'https://audio-ssl.itunes.apple.com/invented/preview.m4a',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/invented/100x100bb.jpg',
  isStreamable: true,
  ...over,
});
const baseFor = (term: string) => 100 * (NAMES.indexOf(term) + 1);
const rowsFor = (term: string, n = 6) => Array.from({ length: n }, (_, k) => row(AID(baseFor(term) + k + 1), term));
const jsonResponse = (results: unknown[]): PinnedResponse => ({ status: 200, location: null, body: new TextEncoder().encode(JSON.stringify({ resultCount: results.length, results })) });

function apple(respond: (term: string, req: PinnedRequest) => PinnedResponse = (term) => jsonResponse(rowsFor(term))) {
  const requests: PinnedRequest[] = [];
  const resolved: string[] = [];
  const search = createAppleCatalogueSearch({
    resolve: async (host) => (resolved.push(host), ['17.253.1.1']),
    http: async (req) => (requests.push(req), respond(req.url.searchParams.get('term') ?? '', req)),
    now: Date.now,
  });
  return { search, requests, resolved, terms: () => requests.map((r) => r.url.searchParams.get('term')) };
}

function durableGate(clock: () => number = Date.now) {
  const server = new FakeFirestoreServer();
  const gate = createAppleMetadataRateGate({ docs: createFirestoreDocStore(new FakeFirestore(server)), serviceId: 'svc-wintr-test', expiresAt: NOW * 100, clock });
  return { server, gate, stamps: () => (server.entries('wintr_service_limits/')[0]?.[1].timestamps as number[] | undefined) ?? [] };
}

/** A bounded dispatch ticket as the real gate would grant it (at + 5 s). */
const ticket = (at = Date.now()): AppleRateAdmission => ({ admitted: true, at, dispatchBy: at + 5_000 });

function stubGate(decide: (ctx: AppleRateContext) => Promise<AppleRateAdmission> | AppleRateAdmission = () => ticket(), bindingExpiresAt = NOW * 100) {
  const calls: AppleRateContext[] = [];
  const gate: AppleMetadataRateGate = { bindingExpiresAt, admit: async (ctx) => (calls.push(ctx), decide(ctx)) };
  return { gate, calls };
}

function ctxFor(over: Partial<AppleBatchContext> = {}) {
  let n = 0;
  const minted: Handle[] = [];
  const budget = createMetadataBudget();
  const ctx: AppleBatchContext = {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    budget,
    now: Date.now,
    newHandle: () => (minted.push(H(`cand${String(++n).padStart(4, '0')}`)), minted[minted.length - 1]!),
    ...over,
  };
  return { ctx, minted, budget: ctx.budget };
}

const builderFor = (search: AppleCatalogueSearch, gate: AppleMetadataRateGate, syntheticTransport = true) => createAppleCandidateBatchBuilder({ search, gate, sealer, syntheticTransport });

async function ok(out: Awaited<ReturnType<ReturnType<typeof builderFor>['build']>>): Promise<OwnedAppleCandidateBatch> {
  if (out.status !== 'batch') throw new Error(`expected a batch, got ${out.reason}`);
  return out.batch;
}

const expectedFor = (f: Fixture, over: Record<string, unknown> = {}) => ({ owner: f.owner, executeRef: H('execute'), planId: H('plan'), poolId: H('pool'), ...over }) as Parameters<typeof trustedAppleCandidate>[2];

describe('catalogue metadata with slow durable authorization', () => {
  async function investigate(revoke?: { stage: 'search' | 'lookup'; boundary: 'admission' | 'dns' | 'response' }, latency = 1_800) {
    const f = make({ anchors: 1 });
    let clock = NOW, allowed = true, stage: 'search' | 'lookup' = 'search', admissions = 0, minted = 0;
    const requests: { stage: string; at: number; dispatchBy: number }[] = [];
    const dns: string[] = [], checks: { stage: string; allowed: boolean }[] = [], tickets: number[] = [];
    const rate = durableGate(() => clock);
    const gate: AppleMetadataRateGate = { bindingExpiresAt: f.owner.expiresAt, admit: async ctx => {
      stage = ++admissions === 1 ? 'search' : 'lookup';
      const grant = await rate.gate.admit(ctx);
      if (grant.admitted) tickets.push(grant.dispatchBy);
      if (revoke?.stage === stage && revoke.boundary === 'admission') allowed = false;
      return grant;
    } };
    const network = {
      now: () => clock,
      resolve: async () => {
        dns.push(stage);
        if (revoke?.stage === stage && revoke.boundary === 'dns') allowed = false;
        return ['17.253.1.1'];
      },
      http: async (req: PinnedRequest) => {
        requests.push({ stage, at: clock, dispatchBy: tickets.at(-1)! });
        if (revoke?.stage === stage && revoke.boundary === 'response') allowed = false;
        return jsonResponse([row(AID(101), NAMES[0])]);
      },
    };
    const catalogue = createCandidateCatalogue({
      search: createAppleCatalogueSearch(network), searchSynthetic: true,
      verifier: createAppleMusicVerifier(network, true), sealer, gate, storefront: 'us', expiresAt: f.owner.expiresAt,
      selector: { synthetic: true, observationProfile: CANDIDATE_SELECTOR_OBSERVATION_PROFILE,
        select: async (_handoff, candidates) => ({ choices: [{ candidateRef: candidates[0]!.ref, fitHypothesis: 'Invented relationship to try.' }], usage: null }) },
    });
    const outcome = await catalogue.investigate(buildCatalogueHandoff(f.plan), { plan: f.plan, pool: f.pool }, {
      signal: new AbortController().signal, now: () => clock, deadlineAt: NOW + 80_000, executeRef: H('execute'),
      newHandle: () => H(`slowauth${++minted}`), dispatchGemini: fn => fn(new AbortController().signal),
      authorizeMetadata: async () => { clock += latency; checks.push({ stage, allowed }); return allowed; },
    });
    return { outcome, requests, dns, checks, stamps: rate.stamps() };
  }

  it('completes real search and selected-ID verification with 1.8-second authorization reads', async () => {
    const result = await investigate();
    expect(result.outcome).toMatchObject({ kind: 'panel', panel: { outcome: 'choices', choices: [{ title: row(AID(101), NAMES[0]).trackName }] } });
    expect(result.requests.map(r => r.stage)).toEqual(['search', 'lookup']);
    expect(result.requests.every(r => r.at < r.dispatchBy)).toBe(true);
    expect(result.stamps).toHaveLength(2);
  });

  for (const stage of ['search', 'lookup'] as const) for (const boundary of ['admission', 'dns', 'response'] as const) {
    it(`revocation during ${stage} ${boundary} prevents a verified choice and retains admission`, async () => {
      const result = await investigate({ stage, boundary });
      expect(result.outcome.kind).toBe('failed');
      expect(result.requests.filter(r => r.stage === stage)).toHaveLength(boundary === 'response' ? 1 : 0);
      expect(result.dns.filter(s => s === stage)).toHaveLength(boundary === 'admission' ? 0 : 1);
      expect(result.checks.some(c => !c.allowed)).toBe(true);
      expect(result.stamps).toHaveLength(stage === 'search' ? 1 : 2);
    });
  }

  it('still refuses starts when the two required pre-dispatch reads alone exhaust the ticket', async () => {
    const result = await investigate(undefined, 2_500);
    expect(result.outcome.kind).toBe('failed');
    expect(result.requests).toEqual([]);
    expect(result.stamps).toHaveLength(1);
  });
});

describe('owned Apple candidate batch: valid sealed pool', () => {
  it('preserves the full validation reserve when the clock advances between samples', async () => {
    const f = make({ anchors: 1 });
    const base = Date.now();
    let ticks = 0;
    const now = () => base + ticks++;
    const net = apple();
    let observedDeadline: number | undefined;
    const catalogue = createCandidateCatalogue({
      search: net.search, searchSynthetic: true, sealer, storefront: 'us', expiresAt: f.owner.expiresAt,
      gate: stubGate(() => ticket(now()), f.owner.expiresAt).gate,
      selector: { synthetic: true, observationProfile: CANDIDATE_SELECTOR_OBSERVATION_PROFILE,
        select: async (_handoff, _candidates, options) => {
          observedDeadline = options.deadlineAt;
          return { choices: [], usage: null };
        } },
      verifier: { synthetic: true, lookup: async () => { throw new Error('unexpected lookup'); } },
    });
    const executeDeadline = base + 80_000;
    let minted = 0;
    const result = await catalogue.investigate(buildCatalogueHandoff(f.plan), { plan: f.plan, pool: f.pool }, {
      signal: new AbortController().signal, now, deadlineAt: executeDeadline, executeRef: H('execute'),
      newHandle: () => H(`candidate${++minted}`), authorizeMetadata: async () => true,
      dispatchGemini: fn => fn(new AbortController().signal),
    });
    expect(result.kind).toBe('panel');
    expect(observedDeadline).toBe(executeDeadline - 1000 - 20_000);
  });

  it('searches the first three allowed plan anchors once each, admitting every call durably first', async () => {
    const f = make();
    const net = apple();
    const d = durableGate();
    const { ctx, minted, budget } = ctxFor();
    const batch = await ok(await builderFor(net.search, d.gate).build(input(f), ctx));

    expect([...net.terms()].sort()).toEqual(NAMES.slice(0, 3));
    for (const req of net.requests) {
      expect(req.url.hostname).toBe('itunes.apple.com');
      expect(req.url.pathname).toBe('/search');
      expect(req.url.searchParams.get('limit')).toBe('6');
      expect(req.url.searchParams.get('country')).toBe('us');
      expect(req.url.searchParams.get('attribute')).toBe('artistTerm');
      expect(req.headers).toEqual(METADATA_HEADERS);
      expect(Object.keys(req.headers).join(',')).not.toMatch(/auth|cookie|key|goog/i);
    }
    expect(net.resolved).toEqual(['itunes.apple.com', 'itunes.apple.com', 'itunes.apple.com']);
    expect(d.stamps()).toHaveLength(3);
    expect(budget.used()).toBe(3);

    expect(batch.candidates).toHaveLength(18);
    expect(batch.anchors).toEqual([0, 1, 2].map((i) => ({ anchor: H(`artist${i}`), status: 'candidates', returned: 6 })));
    expect(new Set(batch.candidates.map((c) => c.ref)).size).toBe(18);
    expect(batch.candidates.map((c) => c.ref)).toEqual(minted);
    expect(new Set(batch.candidates.map((c) => c.trackId)).size).toBe(18);
    batch.candidates.forEach((c, i) => {
      const k = Math.floor(i / 6);
      expect(c).toMatchObject({
        anchor: { handle: H(`artist${k}`), name: NAMES[k] },
        artistEntityId: uid(11 + k),
        artistName: NAMES[k],
        sourceKind: 'first_party_catalogue_search_candidate',
        storefront: 'us',
        destination: { kind: 'apple_music', storefront: 'us', url: `https://music.apple.com/us/song/${c.trackId}` },
      });
      expect(Object.isFrozen(c) && Object.isFrozen(c.destination) && Object.isFrozen(c.anchor)).toBe(true);
    });
    expect(batch).toMatchObject({ kind: 'apple_catalogue_search_candidate_batch', planId: H('plan'), poolId: H('pool'), executeRef: H('execute'), storefront: 'us', synthetic: { pool: true, transport: true }, dropped: { duplicate: 0, alreadyShown: 0 } });
    expect(Object.isFrozen(batch) && Object.isFrozen(batch.candidates) && Object.isFrozen(batch.owner)).toBe(true);
    // Candidate metadata only: no choice, evidence, preview, artwork or tracking.
    expect(JSON.stringify(batch)).not.toMatch(/preview|mzstatic|artwork|price|choice|evidence|grounding|uo=/i);
    for (const c of batch.candidates) expect(trustedAppleCandidate(batch, c.ref, expectedFor(f), Date.now())).toBe(c);
  });

  it('labels a non-synthetic pool and transport honestly and searches only one anchor for a one-anchor plan', async () => {
    const f = make({ anchors: 1 });
    f.pool.synthetic = false;
    const net = apple();
    const batch = await ok(await builderFor(net.search, stubGate().gate, false).build(input(f), ctxFor().ctx));
    expect(batch.synthetic).toEqual({ pool: false, transport: false });
    expect(net.terms()).toEqual([NAMES[0]]);
    expect(batch.candidates).toHaveLength(6);
  });

  it('construction does no I/O and refuses invalid dependencies', () => {
    const net = apple();
    const d = durableGate();
    builderFor(net.search, d.gate);
    expect(net.resolved).toEqual([]);
    expect(d.server.callbackRuns).toBe(0);
    expect(() => createAppleCandidateBatchBuilder({ search: net.search, gate: d.gate, sealer, syntheticTransport: 'yes' as never })).toThrow(TypeError);
    expect(() => createAppleCandidateBatchBuilder({ search: {} as never, gate: d.gate, sealer, syntheticTransport: true })).toThrow(TypeError);
  });
});

describe('owned Apple candidate batch: metadata cap and shared admission', () => {
  it('shares the per-execute metadata budget: the third anchor finds the cap before any durable admission', async () => {
    const f = make();
    const net = apple();
    const d = durableGate();
    const c = ctxFor({ budget: createMetadataBudget(2) });
    const batch = await ok(await builderFor(net.search, d.gate).build(input(f), c.ctx));
    expect(batch.anchors.map((a) => (a.status === 'candidates' ? 'candidates' : a.reason))).toEqual(['candidates', 'candidates', 'metadata_cap']);
    expect(batch.candidates).toHaveLength(12);
    expect(net.requests).toHaveLength(2);
    expect(d.stamps()).toHaveLength(2);
  });

  it('an exhausted budget spends no admission and returns an honest empty batch', async () => {
    const f = make();
    const net = apple();
    const d = durableGate();
    const budget: MetadataBudget = createMetadataBudget(0);
    const batch = await ok(await builderFor(net.search, d.gate).build(input(f), ctxFor({ budget }).ctx));
    expect(batch.candidates).toEqual([]);
    expect(batch.anchors.every((a) => a.status === 'unavailable' && a.reason === 'metadata_cap')).toBe(true);
    expect(net.requests).toEqual([]);
    expect(d.stamps()).toEqual([]);
  });

  it('a refused durable admission makes no request and is reported per anchor', async () => {
    const f = make();
    const net = apple();
    const g = stubGate(() => ({ admitted: false, reason: 'rate_limited' }));
    const batch = await ok(await builderFor(net.search, g.gate).build(input(f), ctxFor().ctx));
    expect(batch.anchors.map((a) => (a.status === 'unavailable' ? a.reason : 'x'))).toEqual(Array(3).fill('admission_rate_limited'));
    expect(batch.candidates).toEqual([]);
    expect(net.requests).toEqual([]);
    expect(net.resolved).toEqual([]);
    expect(g.calls).toHaveLength(3);
    expect(g.calls[0]).toMatchObject({ scopeExpiresAt: f.owner.expiresAt });
  });

  it('the shared service window limits the batch: with 17 of 18 spent only one anchor is admitted', async () => {
    const f = make();
    const net = apple();
    const d = durableGate();
    for (let i = 0; i < 17; i += 1) await d.gate.admit({ signal: new AbortController().signal, deadlineAt: NOW + 60_000, scopeExpiresAt: NOW + HOUR });
    const batch = await ok(await builderFor(net.search, d.gate).build(input(f), ctxFor().ctx));
    expect(batch.anchors.filter((a) => a.status === 'candidates')).toHaveLength(1);
    expect(batch.anchors.filter((a) => a.status === 'unavailable' && a.reason === 'admission_rate_limited')).toHaveLength(2);
    expect(net.requests).toHaveLength(1);
    expect(d.stamps()).toHaveLength(18);
    expect(batch.candidates).toHaveLength(6);
  });

  it('throttling is one request per anchor with no retry and no fallback', async () => {
    const f = make();
    const net = apple(() => ({ status: 429, location: null, body: new Uint8Array() }));
    const d = durableGate();
    const batch = await ok(await builderFor(net.search, d.gate).build(input(f), ctxFor().ctx));
    expect(batch.anchors.map((a) => (a.status === 'unavailable' ? a.reason : 'x'))).toEqual(['throttled', 'throttled', 'throttled']);
    expect(batch.candidates).toEqual([]);
    expect(net.requests).toHaveLength(3);
    expect(net.terms().sort()).toEqual(NAMES.slice(0, 3));
    expect(d.stamps()).toHaveLength(3);
    expect(net.requests.every((r) => r.url.pathname === '/search')).toBe(true);
  });
});

describe('owned Apple candidate batch: exclusion and plan-anchor restriction', () => {
  it('skips anchors named by an artist exclusion (matching form) or equal to a pool seed, then takes the next allowed anchors', async () => {
    const f = make();
    f.plan.exclusions = ['Seed Artist', 'neighbour x11'];
    f.pool.seeds[0].entityId = uid(12);
    const net = apple();
    const batch = await ok(await builderFor(net.search, stubGate().gate).build(input(f), ctxFor().ctx));
    expect(net.terms().sort()).toEqual([NAMES[2], NAMES[3]]);
    expect(batch.anchors.map((a) => a.anchor)).toEqual([H('artist2'), H('artist3')]);
  });

  it('never searches a pool artist the plan does not name as an anchor', async () => {
    const f = make({ anchors: 2 });
    const net = apple();
    await ok(await builderFor(net.search, stubGate().gate).build(input(f), ctxFor().ctx));
    expect(net.terms().sort()).toEqual([NAMES[0], NAMES[1]]);
  });

  it('refuses when no anchor is allowed, before any request or admission', async () => {
    const f = make({ anchors: 2 });
    f.plan.exclusions = [NAMES[0], NAMES[1]];
    const net = apple();
    const g = stubGate();
    const c = ctxFor();
    expect(await builderFor(net.search, g.gate).build(input(f), c.ctx)).toEqual({ status: 'unavailable', reason: 'no_allowed_anchor' });
    expect(net.resolved).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(c.budget.used()).toBe(0);
  });

  it('drops exact duplicate track IDs across anchors and recordings the plan already shows', async () => {
    const f = make({ names: [NAMES[0], NAMES[0], NAMES[1]], anchors: 3 });
    f.pool.artists[1].identity = sealed(99, NAMES[0], f.owner);
    f.plan.recordingExclusions.shown = [{ key: 'invented-key', appleTrackId: AID(101), title: 'Shown', credits: [NAMES[0]] }];
    const net = apple();
    const batch = await ok(await builderFor(net.search, stubGate().gate).build(input(f), ctxFor().ctx));
    expect(batch.dropped).toEqual({ duplicate: 5, alreadyShown: 2 });
    expect(batch.candidates).toHaveLength(11);
    expect(batch.candidates.some((c) => c.trackId === AID(101))).toBe(false);
    expect(new Set(batch.candidates.map((c) => c.trackId)).size).toBe(11);
  });
});

describe('owned Apple candidate batch: forged, foreign, mutated and stale input', () => {
  const OTHER = H('other');
  it.each<[string, (f: Fixture) => Record<string, unknown> | void, string]>([
    ['a plan for another pool', (f) => void (f.plan.poolId = OTHER), 'ownership_mismatch'],
    ['a plan of another session', (f) => void (f.plan.sessionId = OTHER), 'ownership_mismatch'],
    ['a pool of another epoch', (f) => void (f.pool.epoch = 2), 'ownership_mismatch'],
    ['a plan of another Journey', (f) => void (f.plan.journeyId = OTHER), 'ownership_mismatch'],
    ['a pool of another Journey', (f) => void (f.pool.journeyId = OTHER), 'ownership_mismatch'],
    ['a plan with another expiry', (f) => void (f.plan.expiresAt += 1), 'ownership_mismatch'],
    ['a pool with another expiry', (f) => void (f.pool.expiresAt += 1), 'ownership_mismatch'],
    ['another expected session', () => ({ owner: ownerFor({ sessionId: OTHER }) }), 'ownership_mismatch'],
    ['another expected epoch', () => ({ owner: ownerFor({ epoch: 2 }) }), 'ownership_mismatch'],
    ['another expected Journey', () => ({ owner: ownerFor({ journeyId: OTHER }) }), 'ownership_mismatch'],
    ['another source brief in the provenance', (f) => void (f.plan.provenance.poolSourceBriefId = OTHER), 'provenance_mismatch'],
    ['a created pool whose source brief is not the plan brief', (f) => void (f.plan.briefId = OTHER), 'provenance_mismatch'],
    ['an unknown pool reuse state', (f) => void (f.plan.provenance.poolReuse = 'invented'), 'provenance_mismatch'],
    ['an anchor outside the pool', (f) => void (f.plan.anchors[0].handle = H('foreign')), 'invalid_anchor'],
    ['an anchor renamed against the pool', (f) => void (f.plan.anchors[0].name = 'Someone Else'), 'invalid_anchor'],
    ['a duplicated anchor', (f) => void (f.plan.anchors[1] = { ...f.plan.anchors[0] }), 'invalid_anchor'],
    ['too many anchors', (f) => void (f.plan.anchors = Array.from({ length: 16 }, () => f.plan.anchors[0])), 'invalid_anchor'],
    ['no anchors', (f) => void (f.plan.anchors = []), 'invalid_anchor'],
    ['an unclean anchor name', (f) => void (f.plan.anchors[0].name = 'Bad\u0007Name'), 'invalid_anchor'],
    [
      'an identity renamed together with its anchor',
      (f) => {
        f.pool.artists[0].identity.name = 'Forged';
        f.plan.anchors[0].name = 'Forged';
      },
      'identity_rejected',
    ],
    ['an identity with another entity', (f) => void (f.pool.artists[0].identity.entityId = uid(77)), 'identity_rejected'],
    ['an identity sealed for another Journey', (f) => void (f.pool.artists[0].identity = sealed(11, NAMES[0], ownerFor({ journeyId: OTHER }))), 'identity_rejected'],
    ['an identity sealed under another key', (f) => void (f.pool.artists[0].identity = sealed(11, NAMES[0], f.owner, otherSealer)), 'identity_rejected'],
    ['an identity without its seal', (f) => void delete f.pool.artists[0].identity.seal, 'identity_rejected'],
    // Valid seals, same owner: authenticity alone is not membership of THIS Qloo pool.
    ['a validly sealed artist of another pool', (f) => void (f.pool.artists[0].identity = sealed(11, NAMES[0], f.owner, sealer, { sourceRecordId: OTHER })), 'identity_rejected'],
    ['a validly sealed Search record identity', (f) => void (f.pool.artists[0].identity = sealed(11, NAMES[0], f.owner, sealer, { operation: 'search' })), 'identity_rejected'],
    ['a validly sealed Search record of another pool', (f) => void (f.pool.artists[0].identity = sealed(11, NAMES[0], f.owner, sealer, { operation: 'search', sourceRecordId: OTHER })), 'identity_rejected'],
    ['a validly sealed other-pool artist as the third selected anchor', (f) => void (f.pool.artists[2].identity = sealed(13, NAMES[2], f.owner, sealer, { sourceRecordId: OTHER })), 'identity_rejected'],
    ['a stale plan (owner expired)', (f) => {
      f.plan.expiresAt = f.pool.expiresAt = NOW - 1;
      return { owner: ownerFor({ expiresAt: NOW - 1 }) };
    }, 'expired'],
    ['an uppercase storefront', () => ({ storefront: 'US' }), 'invalid_input'],
    ['a three-letter storefront', () => ({ storefront: 'usa' }), 'invalid_input'],
    ['a non-string storefront', () => ({ storefront: 5 }), 'invalid_input'],
    ['a malformed execute ref', () => ({ executeRef: 'short' }), 'invalid_input'],
    ['a missing plan', () => ({ plan: null }), 'invalid_input'],
    ['a missing owner', () => ({ owner: undefined }), 'invalid_input'],
    ['a non-boolean pool label', (f) => void (f.pool.synthetic = 'yes'), 'invalid_input'],
    ['a throwing plan accessor', (f) => void Object.defineProperty(f.plan, 'anchors', { get: () => { throw new Error('boom'); } }), 'invalid_input'],
  ])('refuses %s with zero DNS, admission, request, budget or ref use', async (_label, mutate, reason) => {
    const f = make();
    const over = mutate(f) ?? {};
    const net = apple();
    const g = stubGate();
    const c = ctxFor();
    expect(await builderFor(net.search, g.gate).build(input(f, over), c.ctx)).toEqual({ status: 'unavailable', reason });
    expect(net.resolved).toEqual([]);
    expect(net.requests).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(c.budget.used()).toBe(0);
    expect(c.minted).toEqual([]);
  });

  it('refuses an invalid context before anything else', async () => {
    const f = make();
    const g = stubGate();
    const net = apple();
    const b = builderFor(net.search, g.gate);
    for (const over of [{ signal: {} as AbortSignal }, { deadlineAt: Number.NaN }, { now: () => Number.NaN }, { newHandle: undefined as never }, { budget: undefined as never }]) {
      expect(await b.build(input(f), ctxFor(over).ctx)).toEqual({ status: 'unavailable', reason: 'invalid_context' });
    }
    expect(g.calls).toEqual([]);
    expect(net.resolved).toEqual([]);
  });

  it('is fixed at capture: later mutation of the plan, pool, owner, execute ref or storefront changes nothing dispatched', async () => {
    const f = make();
    const net = apple();
    const gate = deferred<AppleRateAdmission>();
    const g = stubGate(() => gate.promise);
    const given = input(f);
    const pending = builderFor(net.search, g.gate).build(given, ctxFor().ctx);
    f.plan.anchors[0].name = 'Mutated Artist';
    f.plan.exclusions.push(NAMES[1]);
    f.plan.id = H('mutatedplan');
    f.pool.artists[0].identity = {};
    f.pool.seeds[0].entityId = uid(12);
    (given as unknown as Record<string, unknown>).storefront = 'gb';
    (given as unknown as Record<string, unknown>).executeRef = H('mutatedexec');
    (given.owner as unknown as Record<string, unknown>).sessionId = H('mutatedsession');
    await tick();
    f.plan.anchors[1].name = 'Mutated Again';
    gate.resolve(ticket());
    const batch = await ok(await pending);
    expect(net.terms().sort()).toEqual(NAMES.slice(0, 3));
    expect(net.requests.every((r) => r.url.searchParams.get('country') === 'us')).toBe(true);
    expect(batch).toMatchObject({ planId: H('plan'), executeRef: H('execute'), storefront: 'us', owner: { sessionId: H('session') } });
    expect(batch.candidates.map((c) => c.anchor.name)).toEqual(NAMES.slice(0, 3).flatMap((n) => Array(6).fill(n)));
    expect(trustedAppleCandidate(batch, batch.candidates[0]!.ref, expectedFor(f), Date.now())).not.toBeNull();
  });
});

describe('owned Apple candidate batch: the search answer is re-checked against this request', () => {
  const A = (i: number) => ({ entityId: uid(11 + i), name: NAMES[i]! });
  const good = (i: number, k: number, over: Record<string, unknown> = {}) => ({
    sourceKind: 'first_party_catalogue_search_candidate',
    title: `Invented Song ${k}`,
    artistName: NAMES[i],
    trackId: AID(100 * (i + 1) + k),
    storefront: 'us',
    destination: { kind: 'apple_music', storefront: 'us', trackId: AID(100 * (i + 1) + k), url: `https://music.apple.com/us/song/${AID(100 * (i + 1) + k)}` },
    ...over,
  });
  const answer = (over: Record<string, unknown> = {}, list: unknown[] = [good(0, 1)]) => ({ status: 'candidates', artist: A(0), storefront: 'us', candidates: list, rejected: [], ...over });

  it.each<[string, unknown, string]>([
    ['another artist identity', answer({ artist: A(1) }), 'search_mismatch'],
    ['another storefront', answer({ storefront: 'gb' }), 'search_mismatch'],
    ['a candidate in another storefront', answer({}, [good(0, 1, { storefront: 'gb' })]), 'search_mismatch'],
    ['a candidate by another artist', answer({}, [good(0, 1, { artistName: NAMES[1] })]), 'search_mismatch'],
    ['a collaboration credit', answer({}, [good(0, 1, { artistName: `${NAMES[0]} & Guest` })]), 'search_mismatch'],
    ['a non-canonical destination URL', answer({}, [good(0, 1, { destination: { kind: 'apple_music', storefront: 'us', trackId: AID(101), url: `https://music.apple.com/us/song/${AID(101)}?uo=4` } })]), 'search_mismatch'],
    ['a destination for another track', answer({}, [good(0, 1, { destination: { kind: 'apple_music', storefront: 'us', trackId: AID(102), url: `https://music.apple.com/us/song/${AID(102)}` } })]), 'search_mismatch'],
    ['a malformed track ID', answer({}, [good(0, 1, { trackId: '0123' })]), 'search_mismatch'],
    ['another source kind', answer({}, [good(0, 1, { sourceKind: 'native_google_grounding' })]), 'search_mismatch'],
    ['duplicate IDs', answer({}, [good(0, 1), good(0, 1)]), 'search_mismatch'],
    ['seven candidates', answer({}, [1, 2, 3, 4, 5, 6, 7].map((k) => good(0, k))), 'search_mismatch'],
    ['no candidates', answer({}, []), 'search_mismatch'],
    ['an unclean title', answer({}, [good(0, 1, { title: 'Bad\u0007Title' })]), 'search_mismatch'],
    ['not a record', 'candidates', 'search_mismatch'],
    ['an undefined answer', undefined, 'search_mismatch'],
    ['an unavailable outcome', { status: 'unavailable', reason: 'throttled' }, 'throttled'],
    ['an unavailable outcome with a bad reason', { status: 'unavailable', reason: { x: 1 } }, 'search_mismatch'],
  ])('keeps nothing from %s', async (_label, out, reason) => {
    const f = make({ anchors: 1 });
    const seam: AppleCatalogueSearch = { search: async () => out as never };
    const batch = await ok(await builderFor(seam, stubGate().gate).build(input(f), ctxFor().ctx));
    expect(batch.candidates).toEqual([]);
    expect(batch.anchors).toEqual([{ anchor: H('artist0'), status: 'unavailable', reason }]);
  });

  it('a throwing search seam is unreachable, not retried', async () => {
    let calls = 0;
    const seam: AppleCatalogueSearch = { search: async () => (calls++, Promise.reject(new Error('boom'))) };
    const batch = await ok(await builderFor(seam, stubGate().gate).build(input(make({ anchors: 1 })), ctxFor().ctx));
    expect(batch.anchors).toEqual([{ anchor: H('artist0'), status: 'unavailable', reason: 'unreachable' }]);
    expect(calls).toBe(1);
  });

  it.each(['response', 'final_authorization'] as const)('retains a timely search completed after the ticket: %s', async phase => {
    const start = Date.now();
    let clock = start, responseReturned = false;
    const search = createAppleCatalogueSearch({
      now: () => clock,
      resolve: async () => { clock = start + 4_000; return ['17.253.1.1']; },
      http: async () => { responseReturned = true; clock = start + (phase === 'response' ? 5_100 : 4_500); return jsonResponse(rowsFor(NAMES[0])); },
    });
    const authorize = async () => { if (responseReturned && phase === 'final_authorization') clock = start + 5_100; return true; };
    const batch = await ok(await builderFor(search, stubGate(() => ticket(start)).gate).build(input(make({ anchors: 1 })), ctxFor({ now: () => clock, authorize }).ctx));
    expect(batch.candidates).toHaveLength(6);
    expect(batch.anchors).toEqual([{ anchor: H('artist0'), status: 'candidates', returned: 6 }]);
    expect(responseReturned).toBe(true);
    expect(clock).toBe(start + 5_100);
  });

  it('gives the seam exactly one metadata unit, the resolved name and ID, and a deadline no later than owner expiry', async () => {
    const f = make({ anchors: 1 });
    const seen: { req: unknown; deadlineAt: number; dispatchBy: number | undefined; takes: boolean[] }[] = [];
    const seam: AppleCatalogueSearch = {
      search: async (req, c) => {
        seen.push({ req, deadlineAt: c.deadlineAt, dispatchBy: c.dispatchBy, takes: [c.budget.take(), c.budget.take()] });
        return answer() as never;
      },
    };
    const at = Date.now();
    await ok(await builderFor(seam, stubGate(() => ticket(at)).gate).build(input(f), ctxFor({ deadlineAt: f.owner.expiresAt + 10_000 }).ctx));
    expect(seen).toEqual([{ req: { artist: { entityId: uid(11), name: NAMES[0] }, storefront: 'us' }, deadlineAt: f.owner.expiresAt, dispatchBy: at + 5_000, takes: [true, false] }]);
  });

  it('bounds response and dispatch independently by gate binding, execute deadline and owner expiry', async () => {
    const f = make({ anchors: 1 });
    const at = Date.now();
    const run = async (gateBinding: number, executeDeadline: number, granted: number, owner = f.owner) => {
      const seen: { deadlineAt: number; dispatchBy: number | undefined }[] = [];
      const seam: AppleCatalogueSearch = { search: async (_r, c) => (seen.push({ deadlineAt: c.deadlineAt, dispatchBy: c.dispatchBy }), { status: 'unavailable', reason: 'no_results' }) };
      const g = stubGate(() => ({ admitted: true, at, dispatchBy: granted }), gateBinding);
      await builderFor(seam, g.gate).build(input(f, { owner }), ctxFor({ deadlineAt: executeDeadline }).ctx);
      return seen;
    };
    const far = at + 100_000;
    expect(await run(far, far, at + 9_000)).toEqual([{ deadlineAt: far, dispatchBy: at + 5_000 }]);
    expect(await run(at + 3_000, far, far)).toEqual([{ deadlineAt: at + 3_000, dispatchBy: at + 3_000 }]);
    expect(await run(far, at + 2_000, far)).toEqual([{ deadlineAt: at + 2_000, dispatchBy: at + 2_000 }]);
    expect(await run(far, far, at + 1_000)).toEqual([{ deadlineAt: far, dispatchBy: at + 1_000 }]);
  });
});

describe('owned Apple candidate batch: trusted provenance is an unforgeable capability', () => {
  it('only the exact built batch, with matching owner, plan, pool and execute, yields a candidate', async () => {
    const f = make();
    const batch = await ok(await builderFor(apple().search, stubGate().gate).build(input(f), ctxFor().ctx));
    const ref = batch.candidates[0]!.ref;
    const want = expectedFor(f);
    expect(trustedAppleCandidate(batch, ref, want, Date.now())).toBe(batch.candidates[0]);

    for (const copy of [{ ...batch }, JSON.parse(JSON.stringify(batch)), structuredClone(batch), Object.assign({}, batch), Object.create(batch), { ...batch, candidates: [...batch.candidates] }]) {
      expect(trustedAppleCandidate(copy, ref, want, Date.now())).toBeNull();
    }
    expect(trustedAppleCandidate(null, ref, want, Date.now())).toBeNull();
    expect(trustedAppleCandidate('batch', ref, want, Date.now())).toBeNull();
    expect(trustedAppleCandidate(batch, H('unknownref'), want, Date.now())).toBeNull();
    expect(trustedAppleCandidate(batch, { toString: () => ref }, want, Date.now())).toBeNull();

    const o = f.owner;
    for (const wrong of [
      expectedFor(f, { owner: { ...o, sessionId: H('other') } }),
      expectedFor(f, { owner: { ...o, epoch: 2 } }),
      expectedFor(f, { owner: { ...o, journeyId: H('other') } }),
      expectedFor(f, { owner: { ...o, expiresAt: o.expiresAt + 1 } }),
      expectedFor(f, { executeRef: H('otherexecute') }),
      expectedFor(f, { planId: H('otherplan') }),
      expectedFor(f, { poolId: H('otherpool') }),
    ]) {
      expect(trustedAppleCandidate(batch, ref, wrong, Date.now())).toBeNull();
    }
    expect(trustedAppleCandidate(batch, ref, want, o.expiresAt)).toBeNull();
    expect(trustedAppleCandidate(batch, ref, want, o.expiresAt + 1)).toBeNull();
    expect(trustedAppleCandidate(batch, ref, want, Number.NaN)).toBeNull();
  });

  it('the capability dies at Stop and at the earliest of execute deadline, gate binding and owner expiry, and before the build clock', async () => {
    const t0 = Date.now();
    const trusted = async (o: { signal?: AbortSignal; deadlineAt?: number; binding?: number; ownerExpiresAt?: number; now?: () => number; grantAt?: number }) => {
      const f = make(o.ownerExpiresAt === undefined ? {} : { owner: ownerFor({ expiresAt: o.ownerExpiresAt }) });
      const batch = await ok(await builderFor(apple().search, stubGate(o.grantAt === undefined ? undefined : () => ticket(o.grantAt), o.binding).gate).build(input(f), ctxFor({ ...(o.signal ? { signal: o.signal } : {}), ...(o.deadlineAt ? { deadlineAt: o.deadlineAt } : {}), ...(o.now ? { now: o.now } : {}) }).ctx));
      const ref = batch.candidates[0]!.ref;
      return (at: number) => trustedAppleCandidate(batch, ref, expectedFor(f), at) !== null;
    };
    const stop = new AbortController();
    const afterStop = await trusted({ signal: stop.signal });
    expect(afterStop(Date.now())).toBe(true);
    stop.abort();
    expect(afterStop(Date.now())).toBe(false);

    const byDeadline = await trusted({ deadlineAt: t0 + 3_000 });
    expect([byDeadline(t0 + 2_999), byDeadline(t0 + 3_000), byDeadline(t0 + 3_001)]).toEqual([true, false, false]);
    const byBinding = await trusted({ binding: t0 + 2_000 });
    expect([byBinding(t0 + 1_999), byBinding(t0 + 2_000)]).toEqual([true, false]);
    const byOwner = await trusted({ ownerExpiresAt: t0 + 1_000 });
    expect([byOwner(t0 + 999), byOwner(t0 + 1_000)]).toEqual([true, false]);

    const T = t0 + 10_000;
    const early = await trusted({ now: () => T, grantAt: T });
    expect([early(T - 1), early(T), early(T + 1)]).toEqual([false, true, true]);
  });

  it('a batch from another execute cannot answer for this one, and refs do not carry across batches', async () => {
    const f = make();
    const b = builderFor(apple().search, stubGate().gate);
    const one = await ok(await b.build(input(f), ctxFor().ctx));
    let n = 0;
    const two = await ok(await b.build(input(f, { executeRef: H('execute2') }), ctxFor({ newHandle: () => H(`second${String(++n).padStart(4, '0')}`) }).ctx));
    expect(trustedAppleCandidate(two, two.candidates[0]!.ref, expectedFor(f), Date.now())).toBeNull();
    expect(trustedAppleCandidate(two, two.candidates[0]!.ref, expectedFor(f, { executeRef: H('execute2') }), Date.now())).toBe(two.candidates[0]);
    expect(trustedAppleCandidate(one, two.candidates[0]!.ref, expectedFor(f), Date.now())).toBeNull();
  });

  it('refuses invalid, repeated or colliding candidate refs instead of minting trust', async () => {
    const cases: [string, () => Handle][] = [
      ['a malformed ref', () => 'short' as Handle],
      ['the plan id', () => H('plan')],
      ['the execute ref', () => H('execute')],
      ['an anchor handle', () => H('artist0')],
      ['a repeated ref', () => H('samecand')],
      ['a throwing minter', () => { throw new Error('boom'); }],
    ];
    for (const [, newHandle] of cases) {
      const f = make({ anchors: 1 });
      expect(await builderFor(apple().search, stubGate().gate).build(input(f), ctxFor({ newHandle }).ctx)).toEqual({ status: 'unavailable', reason: 'invalid_context' });
    }
  });
});

describe('owned Apple candidate batch: no dispatch after delayed admission, Stop or expiry', () => {
  it('Stop during a held admission makes no request even when the admission later succeeds', async () => {
    const f = make();
    const net = apple();
    const gate = deferred<AppleRateAdmission>();
    const g = stubGate(() => gate.promise);
    const stop = new AbortController();
    const pending = builderFor(net.search, g.gate).build(input(f), ctxFor({ signal: stop.signal }).ctx);
    await tick();
    expect(g.calls).toHaveLength(3);
    stop.abort();
    gate.resolve(ticket());
    expect(await pending).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(net.requests).toEqual([]);
    expect(net.resolved).toEqual([]);
  });

  it('owner expiry reached during a held admission makes no request', async () => {
    const clock = { t: NOW };
    const owner = ownerFor({ expiresAt: NOW + 1_000 });
    const f = make({ owner });
    const net = apple();
    const gate = deferred<AppleRateAdmission>();
    const pending = builderFor(net.search, stubGate(() => gate.promise).gate).build(input(f), ctxFor({ now: () => clock.t, deadlineAt: NOW + 60_000 }).ctx);
    await tick();
    clock.t = owner.expiresAt;
    gate.resolve(ticket(NOW));
    expect(await pending).toEqual({ status: 'unavailable', reason: 'expired' });
    expect(net.requests).toEqual([]);
  });

  it('the execute deadline reached during a held admission makes no request', async () => {
    const clock = { t: NOW };
    const f = make();
    const net = apple();
    const gate = deferred<AppleRateAdmission>();
    const pending = builderFor(net.search, stubGate(() => gate.promise).gate).build(input(f), ctxFor({ now: () => clock.t, deadlineAt: NOW + 1_000 }).ctx);
    await tick();
    clock.t = NOW + 1_000;
    gate.resolve(ticket(NOW));
    expect(await pending).toEqual({ status: 'unavailable', reason: 'deadline' });
    expect(net.requests).toEqual([]);
  });

  it.each<[string, () => AppleRateAdmission]>([
    ['an old delayed grant (its 5 s ticket already lapsed)', () => ticket(Date.now() - 10_000)],
    ['a grant whose dispatchBy equals now', () => ({ admitted: true, at: Date.now() - 1, dispatchBy: Date.now() - 1 })],
    ['a ticket without dispatchBy', () => ({ admitted: true, at: Date.now() }) as never],
    ['a ticket with a non-integer dispatchBy', () => ({ admitted: true, at: Date.now(), dispatchBy: Number.NaN })],
  ])('makes no request with %s', async (_label, grant) => {
    const net = apple();
    const g = stubGate(grant);
    const batch = await ok(await builderFor(net.search, g.gate).build(input(make({ anchors: 1 })), ctxFor().ctx));
    expect(batch.anchors).toEqual([{ anchor: H('artist0'), status: 'unavailable', reason: 'dispatch_expired' }]);
    expect(batch.candidates).toEqual([]);
    expect(net.resolved).toEqual([]);
    expect(net.requests).toEqual([]);
  });

  it('a grant stamped in the future (clock below the committed admission) makes no request', async () => {
    const net = apple();
    const batch = await ok(await builderFor(net.search, stubGate(() => ticket(Date.now() + 60_000)).gate).build(input(make({ anchors: 1 })), ctxFor().ctx));
    expect(batch.anchors).toEqual([{ anchor: H('artist0'), status: 'unavailable', reason: 'clock_regressed' }]);
    expect(net.resolved).toEqual([]);
  });

  it('a durable commit held longer than its ticket authorises nothing; the stamp stays spent', async () => {
    const clock = { t: Date.now() };
    const start = clock.t;
    const net = apple();
    const d = durableGate(() => clock.t);
    const hold = deferred<void>();
    d.server.beforeCommit = () => hold.promise;
    const pending = builderFor(net.search, d.gate).build(input(make({ anchors: 1 })), ctxFor({ now: () => clock.t, deadlineAt: start + 60_000 }).ctx);
    await tick();
    clock.t = start + 5_000;
    d.server.beforeCommit = null;
    hold.resolve();
    const batch = await ok(await pending);
    expect(batch.anchors).toEqual([{ anchor: H('artist0'), status: 'unavailable', reason: 'admission_dispatch_expired' }]);
    expect(net.resolved).toEqual([]);
    expect(net.requests).toEqual([]);
    expect(d.stamps()).toEqual([start]);
  });

  it('the gate binding expiring during a held DNS lookup stops the request before any connection', async () => {
    const clock = { t: Date.now() };
    const start = clock.t;
    const dns = deferred<void>();
    const requests: PinnedRequest[] = [];
    const search = createAppleCatalogueSearch({
      resolve: async () => (await dns.promise, ['17.253.1.1']),
      http: async (req) => (requests.push(req), jsonResponse(rowsFor(NAMES[0]))),
      now: () => clock.t,
    });
    const g = stubGate(() => ticket(start), start + 60);
    const pending = builderFor(search, g.gate).build(input(make({ anchors: 1 })), ctxFor({ now: () => clock.t, deadlineAt: start + 60_000 }).ctx);
    await tick(10);
    clock.t = start + 60;
    await tick(100);
    dns.resolve();
    expect(await pending).toEqual({ status: 'unavailable', reason: 'binding_expired' });
    await tick(20);
    expect(requests).toEqual([]);
  });

  it('a Stop already in force makes no admission, request or budget use', async () => {
    const net = apple();
    const g = stubGate();
    const stop = new AbortController();
    stop.abort();
    const c = ctxFor({ signal: stop.signal });
    const out = await builderFor(net.search, g.gate).build(input(make()), c.ctx);
    expect(out).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(g.calls).toEqual([]);
    expect(net.requests).toEqual([]);
    expect(c.budget.used()).toBe(0);
  });

  it('a Stop that lands during the searches discards the whole batch', async () => {
    const stop = new AbortController();
    const net = apple((term) => (stop.abort(), jsonResponse(rowsFor(term))));
    const out = await builderFor(net.search, stubGate().gate).build(input(make()), ctxFor({ signal: stop.signal }).ctx);
    expect(out).toEqual({ status: 'unavailable', reason: 'aborted' });
  });

  it('database contention re-runs in the durable gate never repeat an Apple request', async () => {
    const f = make();
    const net = apple();
    const d = durableGate();
    d.server.beforeCommit = async (attempt) => {
      if (attempt === 1) await tick(2);
    };
    const batch = await ok(await builderFor(net.search, d.gate).build(input(f), ctxFor().ctx));
    expect(d.server.conflicts).toBeGreaterThan(0);
    expect(net.requests).toHaveLength(3);
    expect(d.stamps()).toHaveLength(3);
    expect(batch.candidates).toHaveLength(18);
  });
});
