import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse, type ClientRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, Socket } from 'node:net';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Handle, InvestigationPlan, QlooCandidatePool, Session } from '../src/shared/records.js';
import type { ApiHandler } from '../src/server/app.js';
import { buildCatalogueHandoff } from '../src/server/catalogue.js';
import { buildCitationUnit, sanitizeSuggestions } from '../src/server/catalogue-format.js';
import { canonicalListeningDestination } from '../src/server/destinations.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createMetadataBudget, createNodePinnedHttpClient, METADATA_HEADERS, type PinnedHttpClient, type PinnedRequest, type PinnedResponse } from '../src/server/net/safe-fetch.js';
import { assembleStream, createGeminiCatalogueAdapter, parseSseEvents } from '../src/server/providers/gemini-catalogue.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createSourceResolver } from '../src/server/source-resolver.js';
import { createYouTubeVerifier } from '../src/server/verifier.js';
import { loadConfig } from '../src/server/config.js';
import { composeLiveRuntime } from '../src/server/live-runtime.js';
import { sha256 } from '../src/server/ids.js';
import { FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { binding, loaders, transports } from './fixtures/live-fixtures.js';
import { buildAnswer, envelope, fakeNetwork, REDIRECT, RENDERED, sseBody, VID } from './fixtures/catalogue-fixtures.js';

// Mock the public Node HTTPS entry point only: no real socket, DNS, source or provider.
vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const EMPTY = new Uint8Array();
const ok = (status = 200): PinnedResponse => ({ status, location: null, body: EMPTY });
const redirect = (location: string): PinnedResponse => ({ status: 302, location, body: EMPTY });
const ctx = (signal = new AbortController().signal, cap = 12) => ({ signal, deadlineAt: Date.now() + 20_000, budget: createMetadataBudget(cap) });
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
function network(respond: PinnedHttpClient, dns: Record<string, readonly string[]> = {}) {
  const requests: PinnedRequest[] = [];
  const hosts: string[] = [];
  const resolve = async (host: string) => {
    hosts.push(host);
    const literal = host.replace(/^\[|\]$/g, '');
    return dns[host] ?? (isIP(literal) ? [literal] : ['142.250.1.1']);
  };
  const http: PinnedHttpClient = async (req) => { requests.push(req); return respond(req); };
  return { requests, hosts, deps: { resolve, http, now: Date.now } };
}

describe('native source HEAD resolver over the pinned guard', () => {
  it('requires a real redirect and a successful terminal response, pins every hop and sends only fixed credential-free headers with zero body allowance', async () => {
    const net = network(async (req) => req.url.hostname === 'vertexaisearch.cloud.google.com' ? redirect('https://publisher.invalid/article') : ok());
    expect(await createSourceResolver(net.deps).check(REDIRECT(1), ctx())).toEqual({ ok: true });
    expect(net.hosts).toEqual(['vertexaisearch.cloud.google.com', 'publisher.invalid']);
    expect(net.requests.map((r) => [r.method, r.maxBytes, r.address])).toEqual([['HEAD', 0, '142.250.1.1'], ['HEAD', 0, '142.250.1.1']]);
    for (const r of net.requests) expect(r.headers).toEqual(METADATA_HEADERS);
    expect(canonicalListeningDestination(REDIRECT(1))).toBeNull();
    const noRedirect = network(async () => ok());
    expect(await createSourceResolver(noRedirect.deps).check(REDIRECT(1), ctx())).toEqual({ ok: false, reason: 'status' });
  });

  it.each([405, 403, 404, 429, 500])('terminal HEAD status %s fails without GET fallback or retry', async (status) => {
    const net = network(async (r) => r.url.hostname === 'vertexaisearch.cloud.google.com' ? redirect('https://publisher.invalid/article') : ok(status));
    expect(await createSourceResolver(net.deps).check(REDIRECT(1), ctx())).toEqual({ ok: false, reason: 'status' });
    expect(net.requests).toHaveLength(2);
    expect(net.requests.every((r) => r.method === 'HEAD')).toBe(true);
  });

  it.each(['/landing', '/errors/unavailable'])('a redirect to a same-origin intermediary %s is not an external source', async (path) => {
    let calls = 0;
    const net = network(async () => ++calls === 1 ? redirect('https://vertexaisearch.cloud.google.com' + path) : ok());
    expect(await createSourceResolver(net.deps).check(REDIRECT(1), ctx())).toEqual({ ok: false, reason: 'status' });
    expect(net.requests).toHaveLength(2);
  });

  it.each(['http://vertexaisearch.cloud.google.com/grounding-api-redirect/x', 'https://vertexaisearch.cloud.google.com.evil.invalid/grounding-api-redirect/x', 'https://www.youtube.com/watch?v=invVid00001', 'https://user:pass@vertexaisearch.cloud.google.com/grounding-api-redirect/x'])('rejects a non-source initial route before DNS: %s', async (source) => {
    const net = network(async () => ok());
    expect(await createSourceResolver(net.deps).check(source, ctx())).toEqual({ ok: false, reason: 'unsafe_redirect' });
    expect(net.hosts).toHaveLength(0); expect(net.requests).toHaveLength(0);
  });

  it.each([
    ['http://publisher.invalid/x', 'unsafe_redirect'], ['https://publisher.invalid:8443/x', 'unsafe_redirect'],
    ['https://user:pass@publisher.invalid/x', 'unsafe_redirect'], ['file:///etc/passwd', 'unsafe_redirect'],
    ['https://127.0.0.1/x', 'unsafe_address'], ['https://2130706433/x', 'unsafe_address'],
    ['https://169.254.169.254/x', 'unsafe_address'], ['https://[::ffff:127.0.0.1]/x', 'unsafe_address'],
    ['https://localhost/x', 'unsafe_address'], ['https://mixed.invalid/x', 'unsafe_address'],
  ])('rejects every unsafe redirected target before access: %s', async (location, reason) => {
    const net = network(async () => redirect(location), { localhost: ['127.0.0.1'], 'mixed.invalid': ['142.250.1.1', '10.0.0.1'] });
    expect(await createSourceResolver(net.deps).check(REDIRECT(1), ctx())).toEqual({ ok: false, reason });
    expect(net.requests).toHaveLength(1);
  });

  it('checks later hops and rebinding rather than trusting the first safe redirect', async () => {
    const net = network(async (r) => r.url.hostname === 'vertexaisearch.cloud.google.com' ? redirect('https://publisher.invalid/start') : redirect('/next'));
    let n = 0;
    const resolver = createSourceResolver({ ...net.deps, resolve: async (host) => host === 'publisher.invalid' && ++n > 1 ? ['10.0.0.1'] : ['142.250.1.1'] });
    expect(await resolver.check(REDIRECT(1), ctx())).toEqual({ ok: false, reason: 'unsafe_address' });
    expect(net.requests).toHaveLength(2);
  });

  it('bounds redirects, aggregate hop requests, and rejects even one returned body byte', async () => {
    const loop = network(async () => redirect('https://publisher.invalid/loop'));
    expect(await createSourceResolver(loop.deps).check(REDIRECT(1), ctx())).toEqual({ ok: false, reason: 'too_many_redirects' });
    expect(loop.requests).toHaveLength(4);
    const capped = network(async () => redirect('https://publisher.invalid/next'));
    expect(await createSourceResolver(capped.deps).check(REDIRECT(1), ctx(undefined, 2))).toEqual({ ok: false, reason: 'metadata_cap' });
    expect(capped.requests).toHaveLength(2);
    const body = network(async () => ({ ...ok(), body: new Uint8Array([1]) }));
    expect(await createSourceResolver(body.deps).check(REDIRECT(1), ctx())).toEqual({ ok: false, reason: 'oversize' });
  });

  it('Stop during held DNS returns immediately and a late DNS answer cannot connect', async () => {
    const dns = deferred<readonly string[]>(); const http = vi.fn(async () => ok());
    const control = new AbortController();
    const p = createSourceResolver({ resolve: () => dns.promise, http, now: Date.now }).check(REDIRECT(1), ctx(control.signal));
    control.abort('stopped');
    expect(await p).toEqual({ ok: false, reason: 'aborted' });
    dns.resolve(['142.250.1.1']); await Promise.resolve();
    expect(http).not.toHaveBeenCalled();
  });

  it('an invalid clock after awaited DNS cannot authorise a source connection', async () => {
    let now = Date.now(); const http = vi.fn(async () => ok());
    const source = createSourceResolver({ resolve: async () => { now = Number.NaN; return ['142.250.1.1']; }, http, now: () => now });
    expect(await source.check(REDIRECT(1), ctx())).toEqual({ ok: false, reason: 'deadline' });
    expect(http).not.toHaveBeenCalled();
  });

  it('bounds never-resolving DNS and HTTP to five seconds and the earlier validation deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    for (const atDns of [true, false]) {
      const resolver = createSourceResolver({ resolve: atDns ? () => new Promise(() => undefined) : async () => ['142.250.1.1'], http: () => new Promise(() => undefined), now: Date.now });
      const p = resolver.check(REDIRECT(1), ctx());
      await vi.advanceTimersByTimeAsync(5000);
      expect(await p).toEqual({ ok: false, reason: 'deadline' });
    }
    const http = vi.fn(async () => ok());
    const p = createSourceResolver({ resolve: () => new Promise(() => undefined), http, now: Date.now }).check(REDIRECT(1), { ...ctx(), deadlineAt: Date.now() + 50 });
    await vi.advanceTimersByTimeAsync(50); expect(await p).toEqual({ ok: false, reason: 'deadline' });
    expect(http).not.toHaveBeenCalled();
  });

  it('a backward clock between source admission and timer creation cannot extend held DNS past five seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    let samples = 0;
    const http = vi.fn(async () => ok());
    const resolver = createSourceResolver({ resolve: () => new Promise(() => undefined), http, now: () => ++samples === 1 ? 10_000 : 0 });
    let outcome: unknown = null;
    void resolver.check(REDIRECT(1), ctx()).then((result) => { outcome = result; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(outcome).toEqual({ ok: false, reason: 'deadline' });
    expect(http).not.toHaveBeenCalled();
  });

  it('the production pinned Node client sends HEAD, pins DNS with the original SNI/Host, and does not send cookie/auth headers', async () => {
    let sent: RequestOptions | undefined;
    vi.mocked(httpsRequest).mockImplementation(((options: RequestOptions, listener: (res: IncomingMessage) => void) => {
      sent = options;
      const request = new EventEmitter() as ClientRequest;
      request.end = (() => {
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = 200; response.headers = {};
        listener(response); response.emit('end'); return request;
      }) as ClientRequest['end'];
      return request;
    }) as typeof httpsRequest);
    const response = await createNodePinnedHttpClient()({ method: 'HEAD', url: new URL('https://publisher.invalid/article'), address: '142.250.1.1', headers: METADATA_HEADERS, signal: new AbortController().signal, maxBytes: 0 });
    expect(response).toEqual(ok());
    expect(sent).toMatchObject({ method: 'HEAD', host: 'publisher.invalid', servername: 'publisher.invalid', port: 443, path: '/article', agent: false });
    expect(sent!.headers).toEqual({ ...METADATA_HEADERS, host: 'publisher.invalid' });
    const found = vi.fn();
    const lookup = sent!.lookup as (host: string, options: { all: boolean }, cb: (...args: unknown[]) => void) => void;
    lookup('publisher.invalid', { all: true }, found);
    expect(found).toHaveBeenCalledWith(null, [{ address: '142.250.1.1', family: 4 }]);
  });
});

const h = (s: string) => s.repeat(24) as Handle;
const own = { sessionId: h('s'), epoch: 1, createdAt: 0, expiresAt: 200_000 };
const plan: InvestigationPlan = { ...own, id: h('p'), journeyId: h('j'), briefId: h('b'), briefVersion: 1, poolId: h('o'),
  relationship: 'Invented relationship', seedNames: ['Invented Seed'], anchors: [{ handle: h('x'), name: 'Invented Neighbour' }], associations: [], exclusions: [],
  recordingExclusions: { shown: [], known: [] }, priorities: [], refinementMode: null, refinement: null, attribution: 'seed_mix',
  provenance: { analysisId: h('a'), analysisReuse: 'same_source_focus', poolSourceBriefId: h('b'), poolReuse: 'created' } };
const pool: QlooCandidatePool = { ...own, id: plan.poolId, journeyId: plan.journeyId, sourceBriefId: plan.briefId, origin: 'initial', fingerprint: 'invented-fingerprint', synthetic: true,
  seeds: [], artists: [], tags: [], capability: 'artists_only', lineage: { artistReturned: 0, artistRejected: 0, aliasesRemoved: 0, duplicatesRemoved: 0, tagOutcome: 'not_admitted', tagReturned: 0 } };
const CHOICE = { title: 'Invented Recording', artists: ['Invented Neighbour'], anchor: 'Invented Neighbour', videoId: VID(1) };
function native(o: { response?: ReturnType<typeof envelope>; http?: PinnedHttpClient; resolve?: (host: string) => Promise<readonly string[]>; control?: AbortController; authorize?: () => Promise<boolean> } = {}) {
  const response = o.response ?? envelope([CHOICE]);
  const net = fakeNetwork({ [VID(1)]: { title: `${CHOICE.anchor} - ${CHOICE.title}`, author_name: CHOICE.anchor } });
  const deps = { resolve: o.resolve ?? net.resolve, http: o.http ?? net.http, now: Date.now };
  const transport = vi.fn(async () => response);
  const lookup = vi.fn(createYouTubeVerifier(deps, true).lookup);
  const catalogue = createNativeCatalogue({ sources: createSourceResolver(deps, true), verifier: { synthetic: true, lookup },
    adapter: createGeminiCatalogueAdapter({ transport, project: 'invented-project', quotaProject: 'invented-project', accessToken: async () => new ServerSecret('invented-token') }) });
  const control = o.control ?? new AbortController();
  const pending = catalogue.investigate(buildCatalogueHandoff(plan), { plan, pool }, { signal: control.signal, now: Date.now, deadlineAt: Date.now() + 120_000,
    newHandle: () => h('n'), dispatchGemini: (fn) => fn(control.signal), authorizeMetadata: o.authorize });
  return { pending, lookup, net, transport, control };
}

describe('actual native catalogue source-resolution wiring', () => {
  it('does not request source or recording metadata after shared authority is revoked', async () => {
    const authorize = vi.fn(async () => false);
    const s = native({ authorize });
    expect((await s.pending).kind).toBe('failed');
    expect(authorize).toHaveBeenCalled();
    expect(s.net.requests).toHaveLength(0);
    expect(s.lookup).not.toHaveBeenCalled();
  });

  it.each(['source', 'recording'] as const)('rechecks shared revocation after %s DNS before connection', async stage => {
    let revoked = false;
    const authorize = vi.fn(async () => !revoked);
    const s = native({ authorize, resolve: async host => {
      if (stage === 'source' || host === 'www.youtube.com') revoked = true;
      return ['142.250.1.1'];
    } });
    const result = await s.pending;
    expect(authorize).toHaveBeenCalled();
    expect(s.net.requests.some(r => r.url.hostname === 'www.youtube.com')).toBe(false);
    if (stage === 'source') expect(s.net.requests).toHaveLength(0);
    expect(result.kind === 'panel' ? result.panel.choices.length : 0).toBe(0);
  });
  it.each([
    ['out-of-range segment', { extraSupports: [{ segment: { startIndex: 0, endIndex: 999999 }, groundingChunkIndices: [0] }] }],
    ['unsafe cited chunk', {
      chunks: [{ web: { uri: REDIRECT(1), title: 'Valid source' } }, { web: { uri: 'https://unsafe.invalid/x', title: 'Lost cited source' } }],
      extraSupports: [{ segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [1] }],
    }],
    ['wrong text part', { extraSupports: [{ segment: { partIndex: 1, startIndex: 0, endIndex: 5, text: 'Other' }, groundingChunkIndices: [0] }] }],
    ['contradictory segment text', { extraSupports: [{ segment: { startIndex: 0, endIndex: 5, text: 'Other' }, groundingChunkIndices: [0] }] }],
  ] as const)('rejects the whole attribution unit with an %s, even when valid identity support remains', async (_label, options) => {
    const s = native({ response: envelope([CHOICE], options) });
    expect(await s.pending).toEqual({ kind: 'failed', failure: 'grounding_unavailable' });
    expect(s.transport).toHaveBeenCalledOnce();
    expect(s.net.requests).toHaveLength(0);
    expect(s.lookup).not.toHaveBeenCalled();
  });

  it.each(['startIndex', 'endIndex'] as const)('rejects a citation with %s inside a UTF-8 character without relocating it', async field => {
    const choice = { ...CHOICE, title: 'Invénted Recording' };
    const { text } = buildAnswer([choice]);
    const inside = Buffer.byteLength(text.slice(0, text.indexOf('é'))) + 1;
    const s = native({ response: envelope([choice], { extraSupports: [{
      segment: { startIndex: 0, endIndex: Buffer.byteLength(text), [field]: inside }, groundingChunkIndices: [0],
    }] }) });
    expect(await s.pending).toEqual({ kind: 'failed', failure: 'grounding_unavailable' });
    expect(s.net.requests).toHaveLength(0);
  });

  it('refuses streamed metadata that loses an earlier citation instead of treating a partial last object as the whole unit', async () => {
    const { text, grounding } = buildAnswer([CHOICE]);
    const response = { status: 200, contentType: 'text/event-stream', body: sseBody([
      { candidates: [{ content: { parts: [{ text }] }, groundingMetadata: grounding }] },
      { candidates: [{ finishReason: 'STOP', groundingMetadata: { searchEntryPoint: grounding.searchEntryPoint } }] },
    ]) };
    const s = native({ response });
    expect(await s.pending).toEqual({ kind: 'failed', failure: 'grounding_unavailable' });
    expect(s.net.requests).toHaveLength(0);
  });

  it('preserves the complete text, marks, original attribution URLs and Suggestions; unused chunks do not trigger network', async () => {
    const response = envelope([CHOICE], { chunks: [{ web: { uri: REDIRECT(1), title: 'Invented source', domain: 'publisher.invalid' } }, { web: { uri: REDIRECT(2), title: 'Unused source' } }] });
    const s = native({ response }); const result = await s.pending;
    if (result.kind !== 'panel') throw new Error('fixture panel failed');
    const decoded = assembleStream(parseSseEvents(response.body as Uint8Array));
    const unit = buildCitationUnit(decoded.text, decoded.grounding);
    expect(result.panel).toMatchObject({ outcome: 'choices', answerText: decoded.text, citations: unit.citations, marks: unit.marks, suggestionsHtml: sanitizeSuggestions(RENDERED) });
    expect(result.panel.citations[0]!.url).toBe(REDIRECT(1));
    expect(s.net.requests.map((r) => r.method ?? 'GET')).toEqual(['HEAD', 'HEAD', 'GET']);
    expect(s.net.requests.some((r) => r.url.href === REDIRECT(2))).toBe(false);
    expect(s.lookup).toHaveBeenCalledOnce(); expect(s.transport).toHaveBeenCalledOnce();
  });

  it('deduplicates the same cited initial URL without dropping either citation/support segment', async () => {
    const response = envelope([CHOICE], { chunks: [1, 2].map((n) => ({ web: { uri: REDIRECT(1), title: `Invented title ${n}` } })), extraSupports: [{ segment: { startIndex: 0, endIndex: 20 }, groundingChunkIndices: [1] }] });
    const s = native({ response }); const result = await s.pending;
    expect(result.kind).toBe('panel');
    if (result.kind === 'panel') expect(result.panel.citations).toHaveLength(2);
    expect(s.net.requests.filter((r) => r.method === 'HEAD')).toHaveLength(2);
  });

  it('an unsafe cited source fails the whole unit before recording metadata instead of removing a citation', async () => {
    const http = vi.fn(async () => redirect('http://127.0.0.1/private'));
    const s = native({ http });
    expect(await s.pending).toEqual({ kind: 'failed', failure: 'grounding_unavailable' });
    expect(http).toHaveBeenCalledOnce(); expect(s.lookup).not.toHaveBeenCalled(); expect(s.transport).toHaveBeenCalledOnce();
  });

  it('refuses an over-cap cited unit before source DNS/HTTP, with no truncated citation unit', async () => {
    const response = envelope([CHOICE], { chunks: Array.from({ length: 13 }, (_, n) => ({ web: { uri: REDIRECT(n + 1), title: `Invented source ${n + 1}` } })),
      extraSupports: [{ segment: { startIndex: 0, endIndex: 20 }, groundingChunkIndices: Array.from({ length: 13 }, (_, n) => n) }] });
    const http = vi.fn(async () => ok()); const resolve = vi.fn(async () => ['142.250.1.1']);
    const s = native({ response, http, resolve });
    expect(await s.pending).toEqual({ kind: 'failed', failure: 'grounding_unavailable' });
    expect(resolve).not.toHaveBeenCalled(); expect(http).not.toHaveBeenCalled(); expect(s.lookup).not.toHaveBeenCalled();
  });

  it('all source hops and recording metadata share cap 12/concurrency 3', async () => {
    let active = 0; let max = 0;
    const requests: PinnedRequest[] = [];
    const response = envelope([CHOICE], { chunks: Array.from({ length: 7 }, (_, n) => ({ web: { uri: REDIRECT(n + 1), title: `Invented source ${n + 1}` } })),
      extraSupports: [{ segment: { startIndex: 0, endIndex: 20 }, groundingChunkIndices: Array.from({ length: 7 }, (_, n) => n) }] });
    const s = native({ response, http: async (req) => {
      requests.push(req); max = Math.max(max, ++active); await Promise.resolve(); active--;
      return req.url.hostname === 'vertexaisearch.cloud.google.com' ? redirect('https://publisher.invalid/article') : ok();
    } });
    expect(await s.pending).toEqual({ kind: 'failed', failure: 'grounding_unavailable' });
    expect(requests).toHaveLength(12); expect(max).toBeLessThanOrEqual(3); expect(s.lookup).not.toHaveBeenCalled();
  });

  it('source checks cannot reset the aggregate cap before recording verification', async () => {
    const response = envelope([CHOICE], { chunks: Array.from({ length: 6 }, (_, n) => ({ web: { uri: REDIRECT(n + 1), title: `Invented source ${n + 1}` } })),
      extraSupports: [{ segment: { startIndex: 0, endIndex: 20 }, groundingChunkIndices: Array.from({ length: 6 }, (_, n) => n) }] });
    const s = native({ response });
    const result = await s.pending;
    expect(result.kind).toBe('panel');
    if (result.kind === 'panel') expect(result.panel).toMatchObject({ outcome: 'no_match', choices: [], gaps: [{ reason: 'metadata_cap', count: 1 }] });
    expect(s.net.requests).toHaveLength(12); expect(s.net.metadataRequests).toHaveLength(0);
    expect(s.lookup).toHaveBeenCalledOnce();
  });

  it('Stop during source DNS cannot reach metadata or authorise a late panel', async () => {
    const dns = deferred<readonly string[]>(); const http = vi.fn(async () => ok());
    const entered = deferred<void>();
    const s = native({ http, resolve: () => { entered.resolve(); return dns.promise; } });
    const settled = s.pending.catch((error: unknown) => error);
    await entered.promise; s.control.abort('stopped');
    expect(await settled).toBe('stopped');
    dns.resolve(['142.250.1.1']); await Promise.resolve();
    expect(http).not.toHaveBeenCalled(); expect(s.lookup).not.toHaveBeenCalled(); expect(s.transport).toHaveBeenCalledOnce();
  });
});

async function call(handler: ApiHandler, config: ReturnType<typeof loadConfig>, secret: string, brief: Handle) {
  const req = new IncomingMessage(new Socket());
  const payload = JSON.stringify({ brief, actionKey: 'source-wiring-invented-0001' });
  req.method = 'POST'; req.url = '/api/discover'; req.headers = { host: config.hostHeader, origin: config.origin, cookie: `wintr_sid=${secret}`,
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) };
  req.push(Buffer.from(payload)); req.push(null);
  const res = new ServerResponse(req); let body = '';
  res.end = ((chunk: unknown) => { body = String(chunk); return res; }) as typeof res.end;
  await handler(req, res); req.destroy();
  return { status: res.statusCode, body };
}

describe('composed runtime uses the real resolver gate (synthetic loaders/network, no server)', () => {
  async function composed(hold = false) {
    const config = loadConfig([], { WINTR_MODE: 'disabled', WINTR_PORT: '8787' });
    const db = new FakeFirestoreServer(); const l = loaders(db); const t = transports();
    const entered = deferred<void>(); const dns = deferred<readonly string[]>();
    const runtime = await composeLiveRuntime({ config, bindings: binding(), loaders: l.loaders, network: { ...t.network,
      resolve: hold ? (host) => { if (host === 'vertexaisearch.cloud.google.com') { entered.resolve(); return dns.promise; } return t.network.resolve(host); } : t.network.resolve,
    } });
    if (!runtime.ok) throw new Error('invented runtime composition');
    const now = Date.now(); const made = await runtime.store.createSession(now) as { session: Session; secret: string };
    const owner = { sessionId: made.session.id, epoch: 1 };
    const admitted = await runtime.store.admitReference({ ...owner, now, reference: { videoId: 'invRefAAA01', canonicalUrl: 'https://www.youtube.com/watch?v=invRefAAA01', focus: { start: 0, end: 30 } },
      listenerCue: null, actionKeyHash: sha256('source-ref'), inputHash: sha256('source-ref') });
    if (admitted.kind !== 'admitted') throw new Error('invented admission');
    await runtime.store.commitAnalysis(owner.sessionId, 1, admitted.attempt.id, { synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null }, now);
    const ref = (await runtime.store.read(owner.sessionId, 1, now))!;
    const brief = await runtime.store.saveBrief(owner, { analysisId: ref.analysis!.id, relationship: 'Invented relationship', relationshipSource: 'listener_text', proposedArtists: ['Generic Artist'], exclusions: [] },
      { expectedBriefId: null, actionKeyHash: sha256('source-brief'), inputHash: sha256('source-brief') }, now);
    if (brief.kind !== 'saved') throw new Error('invented brief');
    return { runtime, t, db, entered, dns, work: () => call(runtime.handler, runtime.config, made.secret, brief.brief.id) };
  }

  it('successful composition resolves original native citations before recording metadata without forwarding loaded credentials', async () => {
    const s = await composed();
    try {
      const answer = await s.work(); expect(answer.status).toBe(200);
      expect(JSON.parse(answer.body).stage).toBe('complete');
      const heads = s.t.net.requests.filter((r) => r.method === 'HEAD');
      expect(heads).toHaveLength(6); expect(s.t.net.metadataRequests).toHaveLength(3);
      for (const r of heads) expect(r.headers).toEqual(METADATA_HEADERS);
      expect(s.t.cat.calls).toHaveLength(1);
    } finally { await s.runtime.close(); }
  });

  it('runtime close during source DNS revokes the pending resolver synchronously, prevents later access/panel, and preserves unknown holds', async () => {
    const s = await composed(true);
    onTestFinished(async () => { const closed = s.runtime.close(); s.dns.resolve([]); await closed; });
    const work = s.work();
    await s.entered.promise;
    const ledger = s.db.entries('wintr_ledger_reservations/');
    const closed = s.runtime.close();
    const answer = await work; await closed;
    expect(answer.status).toBe(503);
    s.dns.resolve(['142.250.1.1']); await Promise.resolve();
    expect(s.t.net.requests).toHaveLength(0);
    expect(s.db.entries('wintr_owned/panel_')).toHaveLength(0);
    expect(s.db.entries('wintr_ledger_reservations/')).toEqual(ledger);
    expect(s.t.cat.calls).toHaveLength(1);
  });
});
