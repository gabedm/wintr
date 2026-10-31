import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiHandler } from '../src/server/app.js';
import { loadConfig, type Config } from '../src/server/config.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { composeLiveRuntime, composePreparedCloudReferenceRuntime, startLiveServer, type LiveRuntime, type PreparedCloudReferenceRuntimeOptions } from '../src/server/live-runtime.js';
import { CLOUD_REFERENCE_OBSERVATION_PROFILE, mergeObservation, parseObservation } from '../src/server/ledger/observation.js';
import type { CloudReferenceToken, CloudReferenceTokenRequest } from '../src/server/providers/gemini-cloud-reference.js';
import type { ProviderRequest, ProviderResponse } from '../src/server/providers/http.js';
import { APPROVED, binding, json, loaders, NOT_APPROVED, SECRETS, transports } from './fixtures/live-fixtures.js';
import { cloudBinding, cloudEnvelope, CLOUD_OUTPUT, CLOUD_TIME, CLOUD_TOKEN, cloudResponse, cloudToken, deferred, prepared } from './fixtures/cloud-reference-fixtures.js';
import { FakeFirestoreServer } from './fixtures/fake-firestore.js';

// In-process API, SDK-shaped fake store, invented bindings and fake transports only.
const runtimes: Array<Extract<LiveRuntime, { ok: true }>> = [];
const clearReadReleases = new Set<() => void>();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(CLOUD_TIME);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('real HTTP forbidden in this synthetic check'); });
});
afterEach(async () => {
  const closing = Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  for (const release of clearReadReleases) release();
  clearReadReleases.clear();
  try {
    await settle(closing);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); vi.useRealTimers();
  }
});
/** Drive only bounded fake-clock contention/receipt timers; a pending provider is never awaited through this helper. */
async function settle<T>(pending: Promise<T>): Promise<T> {
  let done = false;
  void pending.then(() => { done = true; }, () => { done = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; !done && i < 100; i++) await vi.advanceTimersByTimeAsync(10);
  if (!done) throw new Error('invented ready operation did not settle');
  return pending;
}
function fixture() {
  const raw = binding(), reference = cloudBinding(raw), capability = prepared(reference);
  const db = new FakeFirestoreServer(), l = loaders(db), t = transports(), calls: ProviderRequest[] = [];
  const token = vi.fn(async (_request: CloudReferenceTokenRequest) => cloudToken(capability.binding));
  const options: PreparedCloudReferenceRuntimeOptions = { config: loadConfig([], {}), bindings: raw, loaders: l.loaders,
    referencePreparation: capability, referenceBinding: reference, referenceAccessToken: token,
    network: { ...t.network, reference: async request => { request.observer?.transportStarted(); calls.push(request); return cloudResponse(); } } };
  const compose = async (change: Partial<PreparedCloudReferenceRuntimeOptions> = {}) => {
    const runtime = await composePreparedCloudReferenceRuntime({ ...options, ...change });
    if (runtime.ok) runtimes.push(runtime);
    return runtime;
  };
  return { raw, reference, capability, db, l, t, calls, token, options, compose };
}
async function requireRuntime(f: ReturnType<typeof fixture>, change: Partial<PreparedCloudReferenceRuntimeOptions> = {}) {
  const runtime = await f.compose(change);
  if (!runtime.ok) throw new Error(runtime.problems.join(','));
  return runtime;
}
function api(handler: ApiHandler, config: Config) {
  let count = 0;
  const bodies: string[] = [];
  const key = () => `cloud-reference-action-${++count}`;
  const send = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const req = new IncomingMessage(new Socket()); req.method = method; req.url = path;
    req.headers = { host: config.hostHeader, ...(method === 'GET' ? {} : { origin: config.origin }), ...(cookie ? { cookie } : {}) };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) {
      req.headers['content-type'] = 'application/json'; req.headers['content-length'] = String(Buffer.byteLength(payload));
    }
    req[Symbol.asyncIterator] = async function* () { if (payload !== undefined) yield Buffer.from(payload); } as typeof req[typeof Symbol.asyncIterator];
    const res = new ServerResponse(req); let text = '';
    res.end = ((chunk: unknown) => { text = String(chunk); return res; }) as typeof res.end;
    await handler(req, res); req.destroy(); bodies.push(text);
    const setCookie = res.getHeader('set-cookie');
    return { status: res.statusCode, body: JSON.parse(text) as any,
      cookie: (Array.isArray(setCookie) ? setCookie[0] : typeof setCookie === 'string' ? setCookie : undefined)?.split(';')[0] };
  };
  return { send, ready: (...args: Parameters<typeof send>) => settle(send(...args)), key, bodies };
}
async function flush(runtime: Extract<LiveRuntime, { ok: true }>) {
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(10);
    if (runtime.store.observationHealth().pendingWrites === 0) {
      await vi.advanceTimersByTimeAsync(10);
      if (runtime.store.observationHealth().pendingWrites === 0) return;
    }
  }
  throw new Error('invented observation writes did not settle');
}

describe('explicit inactive Cloud reference composition', () => {
  it('uses only the own reference identity, keeps strict default bindings and returns no capability/credential to the client', async () => {
    const f = fixture(), runtime = await requireRuntime(f);
    expect(f.options.config.mode).toBe('disabled'); expect(f.calls).toHaveLength(0); expect(f.token).not.toHaveBeenCalled();
    expect(f.l.calls.secret).toEqual(['secrets/invented-qloo-key', 'secrets/invented-sealing-key']);
    expect(f.l.calls.token).toBe(1); // The unchanged catalogue preflight is a separate loader, never reference authority.
    expect(runtime.cloudReference).toEqual(f.capability.binding); expect(Object.isFrozen(runtime.cloudReference)).toBe(true);
    const h = api(runtime.handler, runtime.config), cookie = (await h.ready('POST', '/api/session', {})).cookie;
    const actionKey = h.key(), request = { url: `https://youtu.be/${APPROVED}`, actionKey };
    const result = await h.ready('POST', '/api/reference', request, cookie);
    expect(result.status).toBe(200); expect(result.body.analysis).toMatchObject({ audioAccess: 'accessed', observations: CLOUD_OUTPUT.observations });
    expect(f.calls).toHaveLength(1); expect(f.t.reference).toHaveLength(0); expect(f.token).toHaveBeenCalledTimes(1);
    expect(f.token.mock.calls[0]![0]).toMatchObject({ identityRef: 'identities/invented-cloud-reference', projectId: 'invented-reference-proj', quotaProjectId: 'invented-reference-quota', deadlineAt: CLOUD_TIME + 90_000 });
    expect(f.calls[0]!.headers.authorization).toBe(`Bearer ${CLOUD_TOKEN}`); expect(f.calls[0]!.headers['x-goog-api-key']).toBeUndefined();
    expect(f.calls[0]!.headers['x-goog-user-project']).toBe('invented-reference-quota');
    await h.ready('POST', '/api/reference', request, cookie); expect(f.calls).toHaveLength(1); expect(f.token).toHaveBeenCalledTimes(1);
    await flush(runtime);
    const held = (await runtime.store.reconciliation().unresolved(10))[0]!;
    expect(held).toMatchObject({ stage: 'reference_analysis', state: 'unknown', observation: { profile: CLOUD_REFERENCE_OBSERVATION_PROFILE,
      invocation: 'one', outcome: 'returned', usage: { inputTokens: { value: 0, state: 'known' }, totalTokens: { value: 20, state: 'known' } } } });
    expect(await runtime.store.reconciliation().totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 300 });
    for (const body of h.bodies) expect(body).not.toMatch(/cloud_youtube_reference|cloud_youtube_v1|invented-reference-proj|invented-reference-quota|invented-cloud-reference|usageMetadata|hidden reasoning/);
    expect(await startLiveServer({ ...runtime })).toEqual({ ok: false, problems: ['runtime:not_composed'] });
  });

  it('leaves ordinary composition on the Developer generateContent route despite unrelated environment/option data', async () => {
    const f = fixture();
    const config = loadConfig([], { WINTR_REFERENCE_PROFILE: 'cloud_youtube_reference_v1' }); expect(config.mode).toBe('disabled');
    const runtime = await composeLiveRuntime({ ...f.options, config, network: f.t.network });
    if (!runtime.ok) throw new Error(runtime.problems.join(',')); runtimes.push(runtime);
    expect(runtime.cloudReference).toBeUndefined(); expect(f.token).not.toHaveBeenCalled();
    expect(f.l.calls.secret).toContain('secrets/invented-reference-key');
    const h = api(runtime.handler, runtime.config), cookie = (await h.ready('POST', '/api/session', {})).cookie;
    await h.ready('POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie);
    expect(f.t.reference).toHaveLength(1); expect(f.t.reference[0]!.url.href).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(f.t.reference[0]!.headers['x-goog-api-key']).toBe(SECRETS['secrets/invented-reference-key']);
    const body = JSON.parse(f.t.reference[0]!.body!); expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'store']);
    expect(body.store).toBe(false);
    await flush(runtime);
    expect((await runtime.store.reconciliation().unresolved(10))[0]!.observation).toMatchObject({ profile: 'gemini_3_6_flash_medium_generate_content_v1',
      usage: { totalTokens: { value: 10, state: 'known' } } });
    expect(f.token).not.toHaveBeenCalled();
    expect(validateLiveBindings(binding({ reference: f.reference }), Date.now()).ok).toBe(false);
    expect(validateLiveBindings(binding({ cloudReference: f.reference }), Date.now()).ok).toBe(false);
  });

  it.each([
    ['missing capability', (f: ReturnType<typeof fixture>) => ({ referencePreparation: undefined })],
    ['copied capability', (f: ReturnType<typeof fixture>) => ({ referencePreparation: { ...f.capability } })],
    ['JSON capability', (f: ReturnType<typeof fixture>) => ({ referencePreparation: JSON.parse(JSON.stringify(f.capability)) })],
    ['spoofed capability', (f: ReturnType<typeof fixture>) => ({ referencePreparation: { profile: 'cloud_youtube_reference_v1', binding: f.reference } })],
    ['missing reference binding', () => ({ referenceBinding: undefined })],
    ['copied catalogue binding', (f: ReturnType<typeof fixture>) => ({ referenceBinding: f.raw.catalogue })],
    ['changed project', (f: ReturnType<typeof fixture>) => ({ referenceBinding: { ...f.reference, projectId: 'changed-reference-proj' } })],
    ['changed quota', (f: ReturnType<typeof fixture>) => ({ referenceBinding: { ...f.reference, quotaProjectId: 'changed-reference-quota' } })],
    ['changed identity', (f: ReturnType<typeof fixture>) => ({ referenceBinding: { ...f.reference, identityRef: 'identities/changed-reference' } })],
    ['changed parent binding', (f: ReturnType<typeof fixture>) => ({ bindings: { ...f.raw, bindingVersion: 'binding-invented-2' } })],
    ['changed source scope', (f: ReturnType<typeof fixture>) => ({ bindings: { ...f.raw, sourcePolicy: { ...f.raw.sourcePolicy, version: 'sources-invented-2' } } })],
    ['missing loader', () => ({ referenceAccessToken: undefined as any })],
  ] as const)('rejects %s before any loader, store construction or provider transport', async (_name, change) => {
    const f = fixture(), runtime = await f.compose(change(f));
    expect(runtime.ok).toBe(false); expect(f.l.calls).toEqual({ secret: [], token: 0, firestore: [] });
    expect(f.token).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0); expect(f.t.reference).toHaveLength(0);
  });

  it('rejects a copied catalogue identity even with a genuine newly constructed capability', async () => {
    const f = fixture();
    for (const identityRef of [f.raw.catalogue.identityRef, f.raw.reference.credentialRef, f.raw.qloo.credentialRef, f.raw.sealing.keyRef]) {
      const reference = { ...f.reference, identityRef };
      expect(await f.compose({ referencePreparation: prepared(reference), referenceBinding: reference })).toEqual({ ok: false, problems: ['cloudReference:identity_not_distinct'] });
    }
    expect(f.l.calls).toEqual({ secret: [], token: 0, firestore: [] }); expect(f.token).not.toHaveBeenCalled();
  });

  it('rejects expired or outliving scope before loaders and rechecks expiry during composition', async () => {
    const f = fixture(); vi.setSystemTime(f.reference.expiresAt);
    expect((await f.compose()).ok).toBe(false); expect(f.l.calls.secret).toHaveLength(0);
    vi.setSystemTime(CLOUD_TIME);
    const long = { ...f.reference, expiresAt: f.reference.expiresAt + 1 };
    expect(await f.compose({ referencePreparation: prepared(long), referenceBinding: long })).toEqual({ ok: false, problems: ['cloudReference:outlives_binding'] });
    const expiring = loaders(f.db, { onSecret: () => vi.setSystemTime(f.reference.expiresAt) });
    expect((await f.compose({ loaders: expiring.loaders })).ok).toBe(false);
    expect(expiring.calls.secret).toHaveLength(1); expect(expiring.calls.firestore).toHaveLength(0); expect(f.token).not.toHaveBeenCalled();
  });
});

describe('Cloud preparation inside the unchanged admission/cancellation/accounting path', () => {
  it('refuses an unapproved source before admission/token loading and never retries or falls back after429', async () => {
    const f = fixture(), runtime = await requireRuntime(f, { network: { ...f.options.network, reference: async request => {
      request.observer?.transportStarted(); f.calls.push(request); return json(429, { usageMetadata: { totalTokenCount: 0 } });
    } } });
    const h = api(runtime.handler, runtime.config), cookie = (await h.ready('POST', '/api/session', {})).cookie;
    expect((await h.ready('POST', '/api/reference', { url: `https://youtu.be/${NOT_APPROVED}`, actionKey: h.key() }, cookie)).status).toBe(422);
    expect(f.token).not.toHaveBeenCalled(); expect(await runtime.store.reconciliation().totals()).toBeNull();
    const action = { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() };
    const failed = await h.ready('POST', '/api/reference', action, cookie);
    expect(failed.body.code).toBe('provider_limited'); expect(failed.body.analysis).toBeNull();
    await h.ready('POST', '/api/reference', action, cookie); expect(f.calls).toHaveLength(1); expect(f.t.reference).toHaveLength(0);
    await flush(runtime);
    expect((await runtime.store.reconciliation().unresolved(10))[0]!.observation).toMatchObject({ profile: CLOUD_REFERENCE_OBSERVATION_PROFILE,
      invocation: 'one', status: 429, outcome: 'failed', error: 'quota', usage: { totalTokens: { value: 0, state: 'known' } } });
    expect(await runtime.store.reconciliation().totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 300 });
  });

  it('keeps decoded usage on malformed output and keeps the observation profile stage-specific', async () => {
    const f = fixture(), runtime = await requireRuntime(f, { network: { ...f.options.network, reference: async request => {
      request.observer?.transportStarted(); f.calls.push(request); return json(200, cloudEnvelope('invented malformed output'));
    } } });
    const h = api(runtime.handler, runtime.config), cookie = (await h.ready('POST', '/api/session', {})).cookie;
    const failed = await h.ready('POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie);
    expect(failed.body.analysis).toBeNull(); await flush(runtime);
    const o = (await runtime.store.reconciliation().unresolved(10))[0]!.observation!;
    expect(o).toMatchObject({ outcome: 'failed', error: 'schema', usage: { inputTokens: { value: 0, state: 'known' }, totalTokens: { value: 20, state: 'known' } } });
    expect(parseObservation(o)).not.toBeNull();
    expect(parseObservation({ ...o, stage: 'catalogue_generation' })).toBeNull();
    expect(mergeObservation(o, { ...o, profile: 'gemini_3_6_flash_medium_interactions' })).toBeNull();
  });

  it.each(['stop', 'clear', 'close'] as const)('%s returns promptly during a hung token; late resolution cannot send or release held intent', async operation => {
    const f = fixture(), token = deferred<CloudReferenceToken>();
    const load = vi.fn((_request: CloudReferenceTokenRequest) => token.promise);
    const runtime = await requireRuntime(f, { referenceAccessToken: load });
    const h = api(runtime.handler, runtime.config), cookie = (await h.ready('POST', '/api/session', {})).cookie, actionKey = h.key();
    const pending = h.send('POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey }, cookie);
    await vi.advanceTimersByTimeAsync(10); expect(load).toHaveBeenCalledTimes(1);
    if (operation === 'stop') expect((await h.ready('POST', '/api/stop', { actionKey }, cookie)).status).toBe(200);
    else if (operation === 'clear') expect((await h.ready('DELETE', '/api/session', undefined, cookie)).status).toBe(200);
    else await runtime.close();
    await settle(pending);
    expect(load.mock.calls[0]![0].signal.aborted).toBe(true);
    token.resolve(cloudToken(f.capability.binding)); await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(0); await flush(runtime);
    // A closed runtime refuses store entry; the retained fake shared ledger is read through a fresh composition.
    const reader = operation === 'close' ? await requireRuntime(f) : runtime;
    expect(await reader.store.reconciliation().totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 300 });
    const held = (await reader.store.reconciliation().unresolved(10))[0]!;
    expect(held).toMatchObject({ state: 'unknown' });
    if (operation !== 'close') expect(held.observation).toMatchObject({ profile: CLOUD_REFERENCE_OBSERVATION_PROFILE, invocation: 'zero', outcome: 'aborted' });
  });

  it('does not restart the90second allocation after delayed admission and respects the shorter capability expiry', async () => {
    const f = fixture(), token = deferred<CloudReferenceToken>(), admission = deferred<void>();
    const load = vi.fn((_request: CloudReferenceTokenRequest) => token.promise), runtime = await requireRuntime(f, { referenceAccessToken: load });
    const reserve = runtime.store.reserveSubmission.bind(runtime.store);
    vi.spyOn(runtime.store, 'reserveSubmission').mockImplementation(async (...args) => { await admission.promise; return reserve(...args); });
    const h = api(runtime.handler, runtime.config), cookie = (await h.ready('POST', '/api/session', {})).cookie;
    const pending = h.send('POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie);
    await vi.advanceTimersByTimeAsync(40_000); admission.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls[0]![0].deadlineAt).toBe(CLOUD_TIME + 90_000);
    await vi.advanceTimersByTimeAsync(50_000); expect((await settle(pending)).body.code).toBe('deadline');
    token.resolve(cloudToken(f.capability.binding)); await vi.advanceTimersByTimeAsync(0); expect(f.calls).toHaveLength(0);
    await flush(runtime); expect(await runtime.store.reconciliation().totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 300 });

    const expiring = fixture(), raw = { ...expiring.reference, expiresAt: Date.now() + 500 }, late = deferred<CloudReferenceToken>();
    const short = await requireRuntime(expiring, { referenceBinding: raw, referencePreparation: prepared(raw), referenceAccessToken: () => late.promise });
    const sh = api(short.handler, short.config), sc = (await sh.ready('POST', '/api/session', {})).cookie;
    const stopped = sh.send('POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey: sh.key() }, sc);
    await vi.advanceTimersByTimeAsync(500); expect((await settle(stopped)).body.analysis).toBeNull();
    late.resolve(cloudToken(raw as typeof expiring.capability.binding)); await vi.advanceTimersByTimeAsync(0); expect(expiring.calls).toHaveLength(0);
    expect(await startLiveServer(short)).toEqual({ ok: false, problems: ['cloudReference.expiresAt:expired'] });
  });

  it.each([false, true])('Clear revokes a sent request immediately; its late usage enriches only the held receipt without resurrecting content (delayed final read: %s)', async delayedRead => {
    const f = fixture(), response = deferred<ProviderResponse>();
    const runtime = await requireRuntime(f, { network: { ...f.options.network, reference: async request => {
      request.observer?.transportStarted(); f.calls.push(request); return response.promise;
    } } });
    const h = api(runtime.handler, runtime.config), cookie = (await h.ready('POST', '/api/session', {})).cookie;
    const pending = h.send('POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey: h.key() }, cookie);
    await vi.advanceTimersByTimeAsync(10); expect(f.calls).toHaveLength(1);
    const clearAcknowledged = deferred<void>();
    clearReadReleases.add(() => { clearAcknowledged.resolve(); response.resolve(cloudResponse()); });
    if (delayedRead) {
      const read = runtime.store.read.bind(runtime.store);
      // Model a final owned read queued after the Clear ACK, as a shared-store retry can be.
      vi.spyOn(runtime.store, 'read').mockImplementation(async (...args) => {
        await clearAcknowledged.promise;
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        return read(...args);
      });
    }
    expect((await h.ready('DELETE', '/api/session', undefined, cookie)).status).toBe(200);
    clearAcknowledged.resolve();
    // Cancellation does not stop fake-clock persistence callbacks. Drive the bounded final read, not the held provider.
    expect((await settle(pending)).body).toMatchObject({ session: null, analysis: null });
    expect(f.calls[0]!.signal.aborted).toBe(true); await flush(runtime);
    const before = (await runtime.store.reconciliation().unresolved(10))[0]!;
    expect(before.observation).toMatchObject({ outcome: 'aborted', invocation: 'one', usage: { totalTokens: { state: 'unknown' } } });
    response.resolve(cloudResponse()); await flush(runtime);
    const after = (await runtime.store.reconciliation().unresolved(10))[0]!;
    expect(after.observation).toMatchObject({ profile: CLOUD_REFERENCE_OBSERVATION_PROFILE, outcome: 'aborted', invocation: 'one', transportOutcome: 'response', usage: { totalTokens: { value: 20, state: 'known' } } });
    expect(await runtime.store.reconciliation().totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 300 });
    const retained = JSON.stringify(f.db.entries());
    expect(retained).not.toMatch(/invented dry bass|invented bass and drum|hidden reasoning|hidden-signature|invented-cloud-reference-token|youtube.com/);
  });
});
