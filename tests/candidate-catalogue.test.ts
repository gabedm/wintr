import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { CANDIDATE_CATALOGUE_PROFILE, createCandidateCataloguePreparation, parseCandidateCatalogueBinding } from '../src/server/candidate-catalogue-profile.js';
import { composeLiveRuntime, composePreparedCandidateCatalogueRuntime, type LiveRuntime } from '../src/server/live-runtime.js';
import { CANDIDATE_SELECTOR_OBSERVATION_PROFILE } from '../src/server/ledger/observation.js';
import type { ProviderRequest } from '../src/server/providers/http.js';
import type { SelectorCandidate } from '../src/server/providers/gemini-candidate-selector.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import type { PinnedRequest } from '../src/server/net/safe-fetch.js';
import type { DocData, DocStore } from '../src/server/persistence/docstore.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import type { Handle } from '../src/shared/records.js';
import { sseBody, AID } from './fixtures/catalogue-fixtures.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { manageDocStore } from '../src/server/persistence/docstore-lifecycle.js';
import { APPROVED, binding, loaders, transports } from './fixtures/live-fixtures.js';
import { deferred } from './fixtures/cloud-reference-fixtures.js';
import { cloudBinding, cloudToken } from './fixtures/cloud-reference-fixtures.js';
import { createCloudReferencePreparation } from '../src/server/cloud-reference-profile.js';
import { validRecord } from '../src/server/persistence/record-schema.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';

// Full real composition/API/harness/store/adapters over invented fake providers,
// an SDK-shaped fake store and local HTTP. No provider, credential, audio or live acceptance.
const config = () => loadConfig([], { WINTR_MODE: 'disabled' });
const rawFor = (b = binding({ recordingServices: ['youtube', 'apple_music'] }), extra: Record<string, unknown> = {}) => ({
  ...CANDIDATE_CATALOGUE_PROFILE, bindingVersion: b.bindingVersion, serviceId: b.serviceId, serviceIdentity: b.serviceIdentity,
  sourcePolicyVersion: b.sourcePolicy.version, exposurePolicyVersion: b.exposurePolicy.version,
  projectId: b.catalogue.projectId, quotaProjectId: b.catalogue.quotaProjectId, identityRef: b.catalogue.identityRef,
  storefront: 'us', expiresAt: b.expiresAt, ...extra,
});
const prepared = (raw = rawFor()) => {
  const r = createCandidateCataloguePreparation(raw);
  if (!r.ok) throw new Error(r.problems.join(','));
  return r.preparation;
};
const servers: Server[] = [], runtimes: Extract<LiveRuntime, { ok: true }>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(r => r.close()));
  await Promise.all(servers.splice(0).map(s => new Promise<void>((resolve) => s.close(() => resolve()))));
});
const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

interface Setup {
  searchStatus?: number;
  searchEmpty?: boolean;
  lookupStatus?: number;
  lookupEmpty?: boolean;
  lookupChange?: Record<string, unknown>;
  select?: (candidates: SelectorCandidate[], call: number) => unknown;
  secondToken?: () => Promise<ServerSecret>;
  metadataHook?: (req: PinnedRequest) => Promise<void>;
  catalogueStatus?: number;
  resolveHook?: () => Promise<void>;
}
async function setup(o: Setup = {}) {
  const server = createServer(); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const cfg = loadConfig([], { WINTR_MODE: 'disabled', WINTR_PORT: String(port) });
  const db = new FakeFirestoreServer(), l = loaders(db), t = transports();
  const raw = binding({ recordingServices: ['youtube', 'apple_music'] }), candidate = rawFor(raw);
  const catalogue: ProviderRequest[] = [], metadata: PinnedRequest[] = [], selectionData: any[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const network = { ...t.network,
    resolve: async () => { await o.resolveHook?.(); return ['17.253.1.1']; },
    pinned: async (req: PinnedRequest) => {
      metadata.push(req); await o.metadataHook?.(req);
      if (req.url.hostname !== 'itunes.apple.com') throw new Error('Unexpected non-catalogue metadata');
      let results: Record<string, unknown>[] = [], status = 200;
      if (req.url.pathname === '/search') {
        status = o.searchStatus ?? 200;
        if (status === 200 && !o.searchEmpty) {
          const artistName = req.url.searchParams.get('term')!;
          const anchorNumber = Number(artistName.match(/\d+$/)?.[0] ?? 0);
          results = [1, 2, 3].map(n => {
            const id = AID(anchorNumber * 100 + n);
            const r = { wrapperType: 'track', kind: 'song', trackId: Number(id), trackName: `Invented ${anchorNumber} Song ${n}`, artistName,
              trackViewUrl: `https://music.apple.com/us/album/invented/${AID(50000)}?i=${id}`, isStreamable: true };
            rows.set(id, r); return r;
          });
        }
      } else if (req.url.pathname === '/lookup') {
        status = o.lookupStatus ?? 200;
        const r = rows.get(req.url.searchParams.get('id')!);
        results = r && !o.lookupEmpty ? [{ ...r, ...o.lookupChange }] : [];
      } else throw new Error('Unexpected catalogue route');
      return { status, location: null, body: new TextEncoder().encode(JSON.stringify({ resultCount: results.length, results })) };
    },
    catalogue: async (req: ProviderRequest) => {
      req.observer?.transportStarted(); catalogue.push(req);
      const body = JSON.parse(req.body!), prompt = body.contents[0].parts[0].text as string;
      expect(body.tools).toBeUndefined();
      const data = JSON.parse(prompt.split('DATA:\n')[1]!); selectionData.push(data);
      const candidates = data.candidates as SelectorCandidate[];
      const selected = candidates.filter((c, i) => candidates.findIndex(x => x.anchor === c.anchor) === i).slice(0, 3);
      const value = o.select ? o.select(candidates, catalogue.length) : { choices: selected.map(c => ({ candidateRef: c.ref, fitHypothesis: 'This may retain the chosen contrast.' })) };
      return { status: o.catalogueStatus ?? 200, contentType: 'text/event-stream', body: sseBody([{ candidates: [{ index: 0, content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 21 } }]) };
    },
  };
  const token = l.loaders.googleAccessToken;
  const runtime = await composePreparedCandidateCatalogueRuntime({ config: cfg, bindings: raw,
    cataloguePreparation: prepared(candidate), catalogueBinding: candidate,
    loaders: { ...l.loaders, googleAccessToken: async ref => { const value = await token(ref); return l.calls.token === 2 && o.secondToken ? o.secondToken() : value; } }, network });
  if (!runtime.ok) throw new Error(runtime.problems.join(','));
  runtimes.push(runtime);
  server.on('request', (req, res) => void runtime.handler(req, res));
  let n = 0;
  const key = () => `candidate-action-key-${String(++n).padStart(6, '0')}`;
  const send = (method: string, path: string, body?: unknown, cookie?: string) => new Promise<{ status: number; body: any; cookie?: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body), headers: Record<string, string> = { host: cfg.hostHeader };
    if (method !== 'GET') headers.origin = cfg.origin;
    if (payload !== undefined) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) });
    if (cookie) headers.cookie = cookie;
    const req = request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let value = ''; res.setEncoding('utf8'); res.on('data', c => value += c);
      res.on('end', () => {
        try {
          const body = value ? JSON.parse(value) : null;
          if (res.statusCode! < 300 && body && 'mode' in body) expect(isSafeSnapshot(body)).toBe(true);
          resolve({ status: res.statusCode!, body, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(payload);
  });
  const ready = async () => {
    const cookie = (await send('POST', '/api/session', {})).cookie!;
    const ref = await send('POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey: key() }, cookie);
    expect(ref.body.analysis).not.toBeNull();
    const saved = await send('POST', '/api/preference', { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist'], actionKey: key(), expectedBrief: null }, cookie);
    return { cookie, brief: saved.body.brief.handle };
  };
  const discover = (r: Awaited<ReturnType<typeof ready>>, actionKey = key()) => send('POST', '/api/discover', { brief: r.brief, actionKey }, r.cookie);
  const stamps = () => (db.entries('wintr_service_limits/').find(([p]) => p.includes('apple_md_'))?.[1].timestamps ?? []) as number[];
  return { db, runtime, catalogue, metadata, selectionData, t, l, ready, discover, send, key, stamps };
}

describe('explicit first-party candidate capability', () => {
  it('overlaps selected-ID checks without adding requests or changing selector order', async () => {
    const held = deferred<void>(); let lookups = 0;
    const h = await setup({ metadataHook: async req => { if (req.url.pathname === '/lookup') { lookups++; await held.promise; } } });
    const r = await h.ready(), running = h.discover(r);
    try { for (let i = 0; i < 100 && lookups < 3; i++) await wait(10); expect(lookups).toBe(3); }
    finally { held.resolve(); }
    const response = await running;
    expect(response.body.panel.choices).toHaveLength(3); expect(h.metadata).toHaveLength(6);
    expect(h.selectionData[0].handoff.referenceObservations).toEqual(expect.any(Array));
    expect(h.selectionData[0].handoff.referenceObservations.length).toBeGreaterThan(0);
    const candidates = h.selectionData[0].candidates as SelectorCandidate[];
    expect(response.body.panel.choices.map((c: { title: string }) => c.title)).toEqual(candidates.filter((c,i) => candidates.findIndex(x => x.anchor === c.anchor) === i).slice(0,3).map(c => c.title));
  });
  it('batches catalogue authority in one fresh read and refuses wrong hinted links', async () => {
    const entered = deferred<void>(), held = deferred<void>();
    const h = await setup({ metadataHook: async req => { if (req.url.pathname === '/search') { entered.resolve(); await held.promise; } } });
    const r = await h.ready(), running = h.discover(r); await entered.promise;
    try {
      const found = await h.runtime.store.findSessionBySecret(r.cookie.split('=')[1]!, Date.now());
      if (!found) throw new Error('Missing invented session');
      const owner = { sessionId: found.session.id, epoch: found.session.epoch };
      const b = await h.runtime.store.read(owner.sessionId, owner.epoch, Date.now());
      if (!b?.attempt || !b.journey) throw new Error('Missing invented investigation');
      const plan = b.plans.at(-1)!;
      const context = { ...owner, sessionExpiresAt: plan.expiresAt };
      expect(validRecord('plan',plan,plan.id,context)).toBe(true);
      const {referenceObservations: omitted,...legacy}=plan;expect(omitted?.length).toBeGreaterThan(0);expect(validRecord('plan',legacy,plan.id,context)).toBe(true);
      for(const referenceObservations of [['x'.repeat(501)],Array(6).fill('invented'),null,[42]])expect(validRecord('plan',{...plan,referenceObservations},plan.id,context)).toBe(false);
      expect(validRecord('plan',{...plan,unownedExtra:true},plan.id,context)).toBe(false);
      const real = createFirestoreDocStore(new FakeFirestore(h.db)); let batches = 0;
      const docs: DocStore = { ...real, transact: fn => real.transact(tx => fn({ ...tx, getAll: async paths => { batches++; return tx.getAll(paths); } })) };
      const raw = binding({ recordingServices: ['youtube','apple_music'] });
      const store = new FirestoreStore({ docs, serviceId: raw.serviceId, policy: raw.exposurePolicy, clock: Date.now, maxSessions: 50, maxJourneysPerSession: 3 });
      const hint = { journeyId: b.journey.id, briefId: plan.briefId };
      expect(await store.authorizeCatalogue(owner,b.attempt.id,plan.id,plan.poolId,Date.now(),hint)).toBe(true); expect(batches).toBe(1);
      batches = 0; expect(await store.authorizeCatalogue(owner,b.attempt.id,plan.id,plan.poolId,Date.now())).toBe(true); expect(batches).toBe(3);
      expect(await store.authorizeCatalogue(owner,b.attempt.id,plan.id,plan.poolId,Date.now(),{...hint,journeyId:'Z'.repeat(24) as Handle})).toBe(false);
      expect(await store.authorizeCatalogue(owner,b.attempt.id,plan.id,plan.poolId,Date.now(),{...hint,briefId:'Y'.repeat(24) as Handle})).toBe(false);
    } finally { held.resolve(); await running; }
  });
  it('is inactive on ordinary composition and agrees only with its exact prepared binding', async () => {
    const b = binding(), db = new FakeFirestoreServer(), l = loaders(db), t = transports();
    const ordinary = await composeLiveRuntime({ config: config(), bindings: b, loaders: l.loaders, network: t.network });
    expect(ordinary.ok && ordinary.candidateCatalogue).toBeUndefined();
    if (ordinary.ok) runtimes.push(ordinary);
    expect([t.qloo.length, t.cat.calls.length, t.net.requests.length]).toEqual([0, 0, 0]);
  });

  it.each(['model', 'selectorProfile', 'maxAnchors', 'maxCandidates', 'maxChoices', 'metadataRequests', 'rateAdmissions', 'rateRetainMs', 'timeoutMs'])('refuses changed fixed %s before any loader', async field => {
    const b = binding({ recordingServices: ['apple_music'] }), raw = rawFor(b), changed = { ...raw, [field]: 'changed' };
    expect(parseCandidateCatalogueBinding(changed, Date.now()).ok).toBe(false);
    const l = loaders(new FakeFirestoreServer());
    const result = await composePreparedCandidateCatalogueRuntime({ config: config(), bindings: b, cataloguePreparation: prepared(raw), catalogueBinding: changed, loaders: l.loaders });
    expect(result.ok).toBe(false); expect(l.calls).toEqual({ secret: [], token: 0, firestore: [] });
  });

  it.each(['copy', 'json', 'proxy', 'wrong-service', 'wrong-project', 'no-apple', 'expired', 'outlives', 'getter', 'extra'] as const)('refuses %s authority before loaders', async kind => {
    let b = binding({ recordingServices: ['apple_music'] }) as ReturnType<typeof binding> & { recordingServices: string[] };
    let raw: any = rawFor(b), cap: unknown = prepared(raw);
    if (kind === 'copy') cap = { ...(cap as object) };
    if (kind === 'json') cap = JSON.parse(JSON.stringify(cap));
    if (kind === 'proxy') cap = new Proxy(cap as object, {});
    if (kind === 'wrong-service') raw = { ...raw, serviceId: 'other-service' };
    if (kind === 'wrong-project') raw = { ...raw, projectId: 'other-project' };
    if (kind === 'no-apple') b = { ...b, recordingServices: ['youtube'] };
    if (kind === 'expired') raw = { ...raw, expiresAt: Date.now() - 1 };
    if (kind === 'outlives') { raw = { ...raw, expiresAt: b.expiresAt + 1000 }; cap = prepared(raw); }
    if (kind === 'getter') { raw = { ...raw }; Object.defineProperty(raw, 'storefront', { get: () => { throw new Error('unreadable'); }, enumerable: true }); }
    if (kind === 'extra') raw = { ...raw, unsafe: true };
    const l = loaders(new FakeFirestoreServer());
    const result = await composePreparedCandidateCatalogueRuntime({ config: config(), bindings: b, cataloguePreparation: cap, catalogueBinding: raw, loaders: l.loaders });
    expect(result.ok).toBe(false); expect(l.calls).toEqual({ secret: [], token: 0, firestore: [] });
  });

  it('captures nested Cloud-reference capability and loader before asynchronous preparation', async () => {
    const b = binding({ recordingServices: ['apple_music'] }), raw = rawFor(b), referenceBinding = cloudBinding(b);
    const ref = createCloudReferencePreparation(referenceBinding);
    if (!ref.ok) throw new Error('Invalid invented reference preparation');
    const nested = { preparation: ref.preparation as unknown, binding: referenceBinding as unknown, accessToken: async () => cloudToken(referenceBinding) };
    const l = loaders(new FakeFirestoreServer()), original = l.loaders.secret, entered = deferred<void>(), held = deferred<void>();
    const pending = composePreparedCandidateCatalogueRuntime({ config: config(), bindings: b, cataloguePreparation: prepared(raw), catalogueBinding: raw,
      cloudReference: nested, loaders: { ...l.loaders, secret: async name => { const value = await original(name); entered.resolve(); await held.promise; return value; } }, network: transports().network });
    await entered.promise;
    nested.preparation = null; nested.binding = null;
    nested.accessToken = async () => { throw new Error('Replaced loader must never be used'); };
    held.resolve();
    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) runtimes.push(result);
  });

  it('drains and closes an acquired managed store once if later runtime construction fails', async () => {
    const b = binding({ recordingServices: ['apple_music'] }), raw = rawFor(b), db = new FakeFirestoreServer(), l = loaders(db);
    let closed = 0;
    const docs = manageDocStore(createFirestoreDocStore(new FakeFirestore(db)), async () => { closed++; });
    const network = transports().network;
    Object.defineProperty(network, 'catalogue', { get: () => { throw new Error('Invented construction failure'); } });
    const result = await composePreparedCandidateCatalogueRuntime({ config: config(), bindings: b,
      cataloguePreparation: prepared(raw), catalogueBinding: raw, loaders: { ...l.loaders, firestore: async () => docs }, network });
    expect(result).toEqual({ ok: false, problems: ['runtime:construction_failed'] });
    expect(closed).toBe(1);
  });

  it('refuses clock regression immediately after capability validation before any loader', async () => {
    const b = binding({ recordingServices: ['apple_music'] }), raw = rawFor(b), time = Date.now();
    const p = createCandidateCataloguePreparation(raw, time);
    if (!p.ok) throw new Error('Invalid invented candidate preparation');
    const l = loaders(new FakeFirestoreServer()); let samples = 0;
    const result = await composePreparedCandidateCatalogueRuntime({ config: config(), bindings: b,
      cataloguePreparation: p.preparation, catalogueBinding: raw, loaders: l.loaders,
      network: transports().network, clock: () => ++samples <= 2 ? time : time - 1 });
    if (result.ok) runtimes.push(result);
    expect(result).toEqual({ ok: false, problems: ['clock:regressed'] });
    expect(l.calls).toEqual({ secret: [], token: 0, firestore: [] });
  });
});

describe('owned Qloo pool through strict selection, exact lookup and committed API projection', () => {
  it('consumes actual sealed pool artists, counts one selector call, shares search/lookup admission and persists honest evidence', async () => {
    const h = await setup(), r = await h.ready(), key = h.key(), first = await h.discover(r, key);
    expect(first.status).toBe(200); expect(first.body.panel).toMatchObject({ outcome: 'choices', catalogueMode: 'first_party_candidates', suggestionsUrl: null, citations: [] });
    expect(first.body.panel.choices).toHaveLength(3);
    expect(first.body.panel.choices.every((c: any) => c.service === 'apple_music' && c.identityEvidence === 'first_party_catalogue' && c.sources.length === 0)).toBe(true);
    expect(h.metadata.map(m => m.url.pathname).sort()).toEqual(['/lookup', '/lookup', '/lookup', '/search', '/search', '/search']);
    expect(h.metadata.every(m => m.url.hostname === 'itunes.apple.com' && !('authorization' in m.headers) && !('x-api-key' in m.headers))).toBe(true);
    expect(h.stamps()).toHaveLength(6);
    expect(h.t.qloo).toHaveLength(3); expect(h.catalogue).toHaveLength(1);
    expect(h.selectionData[0].candidates).toHaveLength(9);
    expect(h.selectionData[0].candidates.every((c: any) => ['Neighbour X11', 'Neighbour X12', 'Neighbour X13'].includes(c.anchor) && !c.trackId && !c.url)).toBe(true);
    const state = await h.send('GET', '/api/state', undefined, r.cookie);
    expect(state.body.panel).toEqual(first.body.panel);
    const wire = JSON.stringify(state.body);
    expect(wire).not.toMatch(/candidateRef|artistEntityId|invented-bearer|credentialRef|first_party_search_plus_exact_metadata/);
    await wait(30);
    const held = await h.runtime.store.reconciliation().unresolved(30), selection = held.find(x => x.stage === 'catalogue_generation');
    expect(selection).toMatchObject({ state: 'unknown', observation: { profile: CANDIDATE_SELECTOR_OBSERVATION_PROFILE, invocation: 'one' } });
    const replay = await h.discover(r, key);
    expect(replay.body.panel).toEqual(first.body.panel); expect(h.catalogue).toHaveLength(1); expect(h.stamps()).toHaveLength(6);
  });

  it.each(['correct_direction', 'follow_connection'] as const)('keeps independent feedback and one shared %s refinement allowance', async mode => {
    const h = await setup(), r = await h.ready(), first = (await h.discover(r)).body, chosen = first.panel.choices[0].handle;
    await h.send('POST', '/api/feedback', { panel: first.panel.handle, choice: chosen, fit: 'like', familiarity: null, expectedRevision: 0, actionKey: h.key() }, r.cookie);
    const second = await h.send('POST', '/api/refine', { mode, panel: first.panel.handle, brief: first.brief.handle, ...(mode === 'follow_connection' ? { choice: chosen } : {}), actionKey: h.key() }, r.cookie);
    expect(second.status).toBe(200); expect(second.body.panel.outcome).toBe('choices');
    expect(second.body.panel.choices.every((c: any) => !first.panel.choices.some((old: any) => old.title === c.title))).toBe(true);
    expect(h.t.qloo).toHaveLength(mode === 'follow_connection' ? 4 : 3);
    expect(h.catalogue).toHaveLength(2); expect(h.stamps()).toHaveLength(mode === 'follow_connection' ? 10 : 12);
    expect(second.body.history[0].choices[0].feedback).toMatchObject({ fit: 'like', familiarity: null });
    expect((await h.send('POST', '/api/refine', { mode: 'correct_direction', panel: second.body.panel.handle, brief: second.body.brief.handle, actionKey: h.key() }, r.cookie)).body.error).toBe('refinement_used');
  });

  it('carries exact-lookup display artwork through persistence and projection without new dispatch or model input', async () => {
    const artworkUrl100 = 'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg';
    const h = await setup({ lookupChange: { artworkUrl100 } }), r = await h.ready(), first = await h.discover(r);
    expect(first.body.panel.choices).toHaveLength(3);
    for (const choice of first.body.panel.choices) {
      expect(choice.artwork.url).toBe(artworkUrl100);
      expect(new URL(choice.artwork.storeUrl).searchParams.get('i')).toBe(choice.playUrl.split('/').at(-1));
    }
    const state = await h.send('GET', '/api/state', undefined, r.cookie);
    expect(state.body.panel).toEqual(first.body.panel);
    expect(h.metadata).toHaveLength(6); expect(h.catalogue).toHaveLength(1); expect(h.stamps()).toHaveLength(6);
    expect(JSON.stringify(h.selectionData)).not.toMatch(/mzstatic|artwork|storeUrl/);
  });

  it.each([429, 503])('does not call Gemini or lookup when candidate search is unavailable (%i)', async searchStatus => {
    const h = await setup({ searchStatus }), result = (await h.discover(await h.ready())).body;
    expect(result.attempt).toMatchObject({ outcome: 'failed' }); expect(result.code).toBe('catalogue_failed');
    expect(result.panel).toBeNull();
    expect(h.catalogue).toHaveLength(0); expect(h.stamps()).toHaveLength(3);
  });

  it('keeps a genuine completed empty search distinct from catalogue unavailability', async () => {
    const h = await setup({ searchEmpty: true }), result = (await h.discover(await h.ready())).body;
    expect(result.panel).toMatchObject({ outcome: 'no_match', choices: [], gaps: [{ reason: 'candidate_set_empty', count: 3 }] });
    expect(h.catalogue).toHaveLength(0); expect(h.metadata).toHaveLength(3);
  });

  it.each([429, 503])('fails honestly when every selected recording lookup is unavailable (%i)', async lookupStatus => {
    const h = await setup({ lookupStatus }), result = (await h.discover(await h.ready())).body;
    expect(result.attempt).toMatchObject({ outcome: 'failed' }); expect(result.code).toBe('catalogue_failed');
    expect(result.panel).toBeNull();
    expect(h.catalogue).toHaveLength(1); expect(h.stamps()).toHaveLength(6);
  });

  it.each([{ lookupEmpty: true }, { lookupStatus: 404 }, { lookupChange: { isStreamable: false } }])('retains completed unavailable-recording coverage as no_match: %j', async options => {
    const h = await setup(options), result = (await h.discover(await h.ready())).body;
    expect(result.attempt).toMatchObject({ outcome: 'succeeded' });
    expect(result.panel).toMatchObject({ outcome: 'no_match', choices: [], gaps: [{ reason: 'destination_unavailable', count: 3 }] });
    expect(h.catalogue).toHaveLength(1); expect(h.stamps()).toHaveLength(6);
    expect(JSON.stringify(result)).not.toContain('operational');
  });

  it('does not turn failure classification into an unchanged resend or reset the spent admissions', async () => {
    const options = { searchStatus: 503 };
    const h = await setup(options), r = await h.ready(), failed = await h.discover(r);
    expect(failed.body.code).toBe('catalogue_failed');
    expect(h.catalogue).toHaveLength(0); expect(h.t.qloo).toHaveLength(3);
    options.searchStatus = 200;
    const recovered = await h.discover(r);
    expect(recovered.body.error).toBe('discovery_retry_unavailable');
    expect(h.catalogue).toHaveLength(0); expect(h.t.qloo).toHaveLength(3);
    expect(h.stamps()).toHaveLength(3);
  });

  it('allows explicit selector abstention without unnecessary exact lookups', async () => {
    const h = await setup({ select: () => ({ choices: [] }) }), result = (await h.discover(await h.ready())).body;
    expect(result.panel).toMatchObject({ outcome: 'no_match', choices: [], catalogueMode: 'first_party_candidates' });
    expect(h.catalogue).toHaveLength(1); expect(h.metadata.every(m => m.url.pathname === '/search')).toBe(true);
  });

  it.each(['unknown', 'duplicate', 'extra'] as const)('never looks up a %s selector choice', async kind => {
    const h = await setup({ select: cs => {
      const c = { candidateRef: cs[0]!.ref, fitHypothesis: 'Maybe.' };
      return { choices: kind === 'unknown' ? [{ ...c, candidateRef: 'forged-candidate-000000000' }] : kind === 'duplicate' ? [c, c] : [{ ...c, title: 'Forged title' }] };
    } }), result = (await h.discover(await h.ready())).body;
    expect(result.attempt).toMatchObject({ outcome: 'failed' }); expect(result.code).toBe('catalogue_failed');
    expect(result.panel).toBeNull(); expect(h.catalogue).toHaveLength(1); expect(h.stamps()).toHaveLength(3);
  });

  it.each([
    [{ trackName: 'Different title' }, 'title_mismatch'],
    [{ trackName: 'Invented 11 Song 1 (Live)' }, 'version_mismatch'],
    [{ artistName: 'Neighbour X11 & Undeclared Artist' }, 'credits_extra'],
    [{ trackId: 99999 }, 'destination_mismatch'],
  ] as const)('refuses selected-ID identity mismatch (%#)', async (lookupChange, gap) => {
    const h = await setup({ lookupChange, select: cs => ({ choices: [{ candidateRef: cs[0]!.ref, fitHypothesis: 'Maybe.' }] }) }), result = (await h.discover(await h.ready())).body;
    expect(result.panel).toMatchObject({ outcome: 'no_match', choices: [] });
    expect(result.panel.gaps).toContainEqual({ reason: gap, count: 1 }); expect(h.stamps()).toHaveLength(4);
  });

  it('does not silently retry a selector 429 and retains its counted unknown exposure', async () => {
    const h = await setup({ catalogueStatus: 429 }), result = (await h.discover(await h.ready())).body;
    expect(result.attempt).toMatchObject({ outcome: 'failed' }); expect(result.code).toBe('provider_limited');
    expect(result.panel).toBeNull(); expect(h.catalogue).toHaveLength(1); expect(h.stamps()).toHaveLength(3);
    await wait(20);
    expect((await h.runtime.store.reconciliation().unresolved(30)).find(x => x.stage === 'catalogue_generation')).toMatchObject({ state: 'unknown', units: 500 });
  });

  it.each(['stop', 'clear'] as const)('revokes %s during a held selector token without a late send or refund', async action => {
    const entered = deferred<void>(), held = deferred<ServerSecret>();
    const h = await setup({ secondToken: () => { entered.resolve(); return held.promise; } }), r = await h.ready();
    const actionKey = h.key(), discovering = h.discover(r, actionKey); await entered.promise;
    expect((action === 'stop'
      ? await h.send('POST', '/api/stop', { actionKey }, r.cookie)
      : await h.send('DELETE', '/api/session', undefined, r.cookie)).status).toBe(200);
    held.resolve(new ServerSecret('invented-late-token'));
    await discovering; await wait(30);
    expect(h.catalogue).toHaveLength(0); expect(h.metadata).toHaveLength(3); expect(h.stamps()).toHaveLength(3);
    expect((await h.runtime.store.reconciliation().unresolved(30)).find(x => x.stage === 'catalogue_generation')).toMatchObject({ state: 'unknown', units: 500 });
    const state = await h.send('GET', '/api/state', undefined, r.cookie);
    expect(state.body.panel).toBeNull();
  });

  it.each(['stop', 'clear'] as const)('honours a different instance’s %s committed during metadata DNS', async action => {
    const entered = deferred<void>(), dns = deferred<void>();
    const h = await setup({ resolveHook: async () => { entered.resolve(); await dns.promise; } }), r = await h.ready();
    const running = h.discover(r); await entered.promise;
    const found = await h.runtime.store.findSessionBySecret(r.cookie.split('=')[1]!, Date.now());
    if (!found) throw new Error('Missing invented session');
    const state = await h.send('GET', '/api/state', undefined, r.cookie);
    // Direct durable revocation models another worker: this process's local abort signal is deliberately untouched.
    if (action === 'stop') await h.runtime.store.stopAttempt(found.session.id, found.session.epoch, state.body.attempt.handle, Date.now());
    else await h.runtime.store.clearSession(found.session.id);
    dns.resolve(); await running;
    expect(h.metadata).toHaveLength(0); expect(h.catalogue).toHaveLength(0);
    expect(h.stamps()).toHaveLength(3); // Already-admitted tickets are never refunded.
  });

  it('refuses a persisted first-party panel relabelled as native and native source injection', async () => {
    const h = await setup(), r = await h.ready(); await h.discover(r);
    const [path, doc] = h.db.entries('wintr_owned/').find(([, d]) => d.kind === 'panel')!;
    h.db.seed(path, { ...doc, body: { ...(doc.body as object), catalogueMode: 'native_google' } } as DocData);
    expect((await h.send('GET', '/api/state', undefined, r.cookie)).status).toBe(503);
    h.db.seed(path, doc);
    const [contentPath, contentDoc] = h.db.entries('wintr_owned_content/panelcontent_')[0]!;
    h.db.seed(contentPath, { ...contentDoc, body: { ...(contentDoc.body as object), suggestionsHtml: '<div>Invented sources</div>' } } as DocData);
    expect((await h.send('GET', '/api/state', undefined, r.cookie)).status).toBe(503);
  });
});
