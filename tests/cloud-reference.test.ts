import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureCloudReferencePreparation, CLOUD_REFERENCE_RETIRES_AT, createCloudReferencePreparation, parseCloudReferenceBinding } from '../src/server/cloud-reference-profile.js';
import { createGeminiCloudReferenceAdapter, parseCloudReferenceUsage, type CloudReferenceToken, type CloudReferenceTokenLoader, type CloudReferenceTokenRequest } from '../src/server/providers/gemini-cloud-reference.js';
import type { ProviderRequest, ProviderResponse } from '../src/server/providers/http.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { json } from './fixtures/live-fixtures.js';
import { cloudBinding, cloudEnvelope, CLOUD_INPUT, CLOUD_OUTPUT, CLOUD_TIME, CLOUD_TOKEN, cloudResponse, cloudToken, deferred, prepared } from './fixtures/cloud-reference-fixtures.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(CLOUD_TIME); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function adapter(options: { load?: CloudReferenceTokenLoader; respond?: (r: ProviderRequest) => ProviderResponse | Promise<ProviderResponse> } = {}) {
  const raw = cloudBinding(), capability = prepared(raw), calls: ProviderRequest[] = [];
  const load = options.load ?? vi.fn(async () => cloudToken(capability.binding));
  const result = createGeminiCloudReferenceAdapter({ preparation: capability, binding: raw, accessToken: load,
    transport: async request => { request.observer?.transportStarted(); calls.push(request); return (options.respond ?? cloudResponse)(request); } });
  const analyse = (ms = 1_000, signal = new AbortController().signal) =>
    result.analyse(CLOUD_INPUT, signal, undefined, { deadlineAt: Date.now() + ms });
  return { adapter: result, analyse, calls, load, capability, raw };
}

describe('immutable Cloud reference preparation', () => {
  it('snapshots a closed binding, never recognises a copy, and performs no loading or dispatch', () => {
    const raw = cloudBinding(), capability = prepared(raw);
    raw.projectId = 'changed-reference-proj';
    expect(capability.binding.projectId).toBe('invented-reference-proj');
    expect(Object.isFrozen(capability) && Object.isFrozen(capability.binding)).toBe(true);
    expect(captureCloudReferencePreparation({ ...capability }, capability.binding, Date.now())).toEqual({ ok: false, problems: ['cloudReference:not_prepared'] });
    expect(captureCloudReferencePreparation(capability, raw, Date.now())).toEqual({ ok: false, problems: ['cloudReference:binding_mismatch'] });
  });

  it.each([
    null, [], {}, { ...cloudBinding(), extra: true }, { ...cloudBinding(), model: 'different-model' },
    { ...cloudBinding(), profile: 'live' }, { ...cloudBinding(), apiVersion: 'v1beta1' }, { ...cloudBinding(), location: 'eu' },
    { ...cloudBinding(), expiresAt: CLOUD_TIME }, { ...cloudBinding(), expiresAt: CLOUD_REFERENCE_RETIRES_AT + 1 },
    { ...cloudBinding(), projectId: 'https://private.invalid' }, { ...cloudBinding(), identityRef: '' },
  ])('refuses an invalid or unbounded profile without echoing values (%#)', raw => {
    const parsed = parseCloudReferenceBinding(raw, Date.now());
    expect(parsed.ok).toBe(false); expect(JSON.stringify(parsed)).not.toMatch(/different-model|private.invalid/);
  });

  it('rejects accessors, hidden/symbol fields, prototypes and invalid clock values', () => {
    let reads = 0;
    const accessor = Object.defineProperty(cloudBinding(), 'projectId', { enumerable: true, get: () => { reads++; return 'invented-reference-proj'; } });
    for (const raw of [accessor, { ...cloudBinding(), [Symbol('extra')]: true }, Object.defineProperty(cloudBinding(), 'hidden', { value: true }), Object.create(cloudBinding())]) {
      expect(createCloudReferencePreparation(raw).ok).toBe(false);
    }
    expect(reads).toBe(0);
    expect(createCloudReferencePreparation(cloudBinding(), NaN).ok).toBe(false);
    expect(createCloudReferencePreparation(cloudBinding(), CLOUD_REFERENCE_RETIRES_AT).ok).toBe(false);
  });
});

describe('native Cloud reference request and bounded output', () => {
  it('refuses shadowed safety fields before using the reference response', async () => {
    const raw = JSON.stringify(cloudEnvelope()).replace('"finishReason":"STOP"', '"finishReason":"SAFETY","finishReason":"STOP"');
    const a = adapter({ respond: () => ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode(raw) }) });
    await expect(a.analyse()).rejects.toMatchObject({ kind: 'malformed', dispatched: true });
    expect(a.calls).toHaveLength(1);
  });

  it('sends one canonical native video part and reuses the typed output contract without tools or clipping', async () => {
    const a = adapter();
    const result = await a.analyse();
    expect(a.calls).toHaveLength(1);
    const request = a.calls[0]!;
    expect(request.url.href).toBe('https://aiplatform.googleapis.com/v1/projects/invented-reference-proj/locations/global/publishers/google/models/gemini-3.6-flash:generateContent');
    expect(request.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${CLOUD_TOKEN}`, 'x-goog-user-project': 'invented-reference-quota' });
    expect(request.maxResponseBytes).toBe(512 * 1024);
    const body = JSON.parse(request.body!);
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig']);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'MEDIUM' } });
    expect(body.contents).toHaveLength(1); expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0]).toEqual({ fileData: { fileUri: CLOUD_INPUT.reference.canonicalUrl, mimeType: 'video/mp4' } });
    expect(body.contents[0].parts[1].text).toContain('does not mean the media was clipped');
    expect(body.contents[0].parts[1].text).toContain('do not quote lyrics');
    expect(result).toMatchObject({ audioAccess: 'accessed', observations: CLOUD_OUTPUT.observations, relationships: CLOUD_OUTPUT.relationships,
      provider: { model: 'gemini-3.6-flash', usage: { totalInputTokens: 0, totalTokens: 20 } } });
    expect(JSON.stringify(result)).not.toMatch(/hidden reasoning|hidden-signature|invented-cloud-reference-token/);
  });

  it.each(['unavailable', 'refused'])('keeps the model typed %s outcome without inventing observations', async access => {
    const a = adapter({ respond: () => json(200, cloudEnvelope({ audio_access: access, observations: [], relationships: [], artist_name: null })) });
    expect(await a.analyse()).toMatchObject({ audioAccess: access, observations: [], relationships: [] });
  });

  it.each([
    ['multiple candidates', { candidates: [...cloudEnvelope().candidates, ...cloudEnvelope().candidates] }, 'schema'],
    ['no candidate', { candidates: [] }, 'schema'], ['wrong envelope', { candidates: undefined, status: 'completed', steps: [] }, 'schema'],
    ['prompt refusal', { promptFeedback: { blockReason: 'SAFETY' } }, 'refused'],
    ['safety refusal', { candidates: [{ ...cloudEnvelope().candidates[0], safetyRatings: [{ blocked: true }] }] }, 'refused'],
    ['refusal finish', { candidates: [{ ...cloudEnvelope().candidates[0], finishReason: 'RECITATION' }] }, 'refused'],
    ['partial finish', { candidates: [{ ...cloudEnvelope().candidates[0], finishReason: 'MAX_TOKENS' }] }, 'incomplete'],
    ['missing finish', { candidates: [{ ...cloudEnvelope().candidates[0], finishReason: undefined }] }, 'incomplete'],
    ['continuation', { candidates: [{ ...cloudEnvelope().candidates[0], continuationToken: 'invented-more' }] }, 'incomplete'],
    ['ambiguous index', { candidates: [{ ...cloudEnvelope().candidates[0], index: 1 }] }, 'schema'],
    ['wrong role', { candidates: [{ content: { role: 'user', parts: [{ text: JSON.stringify(CLOUD_OUTPUT) }] }, finishReason: 'STOP' }] }, 'schema'],
    ['tool output', { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'arbitrary' } }] }, finishReason: 'STOP' }] }, 'schema'],
    ['bad thought flag', { candidates: [{ content: { role: 'model', parts: [{ thought: 'false', text: JSON.stringify(CLOUD_OUTPUT) }] }, finishReason: 'STOP' }] }, 'schema'],
    ['thought only', { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: JSON.stringify(CLOUD_OUTPUT) }] }, finishReason: 'STOP' }] }, 'incomplete'],
    ['empty parts', { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] }, 'schema'],
    ['malformed safety', { candidates: [{ ...cloudEnvelope().candidates[0], safetyRatings: [{ blocked: 'false' }] }] }, 'schema'],
  ])('rejects %s after one submission without fallback', async (_name, extra, kind) => {
    const a = adapter({ respond: () => json(200, cloudEnvelope(CLOUD_OUTPUT, extra)) });
    await expect(a.analyse()).rejects.toMatchObject({ kind, dispatched: true }); expect(a.calls).toHaveLength(1);
  });

  it.each([
    ['non-JSON response', { status: 200, contentType: 'text/html', body: new TextEncoder().encode('{}') }, 'malformed'],
    ['invalid UTF8', { status: 200, contentType: 'application/json', body: new Uint8Array([0xff]) }, 'malformed'],
    ['oversize response', { status: 200, contentType: 'application/json', body: new Uint8Array(512 * 1024 + 1) }, 'oversize'],
    ['invalid typed text', json(200, cloudEnvelope('invented invalid JSON text')), 'schema'],
    ['oversized typed field', json(200, cloudEnvelope({ ...CLOUD_OUTPUT, observations: ['x'.repeat(501)] })), 'schema'],
  ])('rejects %s without exposing response/credential content', async (_name, response, kind) => {
    const a = adapter({ respond: () => response });
    const error = await a.analyse().catch(e => e);
    expect(error).toMatchObject({ kind, dispatched: true });
    expect(String(error)).not.toMatch(/invented-cloud-reference|invented invalid JSON/); expect(a.calls).toHaveLength(1);
  });

  it.each([[400, 'unsupported'], [401, 'auth'], [403, 'auth'], [429, 'quota'], [503, 'http_status']] as const)('preserves HTTP %s with no retry or alternate route', async (status, kind) => {
    const a = adapter({ respond: () => json(status, {}) });
    await expect(a.analyse()).rejects.toMatchObject({ kind, status, dispatched: true }); expect(a.calls).toHaveLength(1);
  });

  it('keeps known zero, treats malformed counters as unknown and drops arbitrary receipt fields', () => {
    const usage = parseCloudReferenceUsage({ promptTokenCount: 0, candidatesTokenCount: '17', totalTokenCount: -1, private: 'discard',
      promptTokensDetails: [{ modality: 'VIDEO', tokenCount: 0 }, { modality: 'AUDIO', tokenCount: '9' }] });
    expect(usage).toMatchObject({ totalInputTokens: 0, totalOutputTokens: null, totalTokens: null, inputTokensByModality: [{ modality: 'VIDEO', tokens: 0 }] });
    expect(JSON.stringify(usage)).not.toContain('discard');
  });
});

describe('explicit reference token and absolute dispatch fence', () => {
  it('requires a genuine matching preparation before accepting an adapter', () => {
    const raw = cloudBinding(), capability = prepared(raw), load = vi.fn();
    for (const bad of [undefined, {}, { ...capability }, new Proxy(capability, {})]) {
      expect(() => createGeminiCloudReferenceAdapter({ preparation: bad, binding: raw, accessToken: load, transport: vi.fn() })).toThrow('gemini:config');
    }
    expect(() => createGeminiCloudReferenceAdapter({ preparation: capability, binding: { ...raw, quotaProjectId: 'different-quota-proj' }, accessToken: load, transport: vi.fn() })).toThrow('gemini:config');
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses bad source/context and expired authority before loading a token', async () => {
    const a = adapter();
    await expect(a.adapter.analyse(CLOUD_INPUT, new AbortController().signal)).rejects.toMatchObject({ kind: 'config', dispatched: false });
    await expect(a.adapter.analyse({ ...CLOUD_INPUT, reference: { ...CLOUD_INPUT.reference, canonicalUrl: 'https://private.invalid/video' } }, new AbortController().signal, undefined, { deadlineAt: Date.now() + 1000 })).rejects.toMatchObject({ kind: 'config', dispatched: false });
    vi.setSystemTime(a.capability.binding.expiresAt);
    await expect(a.analyse()).rejects.toMatchObject({ kind: 'config', dispatched: false });
    expect(a.load).not.toHaveBeenCalled(); expect(a.calls).toHaveLength(0);
  });

  it.each(['identityRef', 'projectId', 'quotaProjectId', 'token'] as const)('rejects a mismatched or spoofed token receipt field %s before HTTP', async field => {
    const receipt: Record<string, unknown> = { ...cloudToken(prepared().binding) };
    receipt[field] = field === 'token' ? Object.create(ServerSecret.prototype) : 'mismatched-invented-value';
    const a = adapter({ load: async () => receipt as unknown as CloudReferenceToken });
    await expect(a.analyse()).rejects.toMatchObject({ kind: 'auth', dispatched: false }); expect(a.calls).toHaveLength(0);
  });

  it('does not invoke token receipt getters or leak a loader error', async () => {
    let reads = 0;
    const receipt = Object.defineProperty(cloudToken(prepared().binding), 'token', { enumerable: true, get: () => { reads++; throw new Error(CLOUD_TOKEN); } });
    const a = adapter({ load: async () => receipt });
    await expect(a.analyse()).rejects.toThrow('gemini:auth'); expect(reads).toBe(0); expect(a.calls).toHaveLength(0);
    const b = adapter({ load: async () => { throw new Error(CLOUD_TOKEN); } });
    expect(String(await b.analyse().catch(e => e))).not.toContain(CLOUD_TOKEN); expect(b.calls).toHaveLength(0);
  });

  it.each(['resolve', 'reject'] as const)('bounds a hung token, passes the signal/end to the loader and absorbs late %s', async late => {
    const gate = deferred<CloudReferenceToken>();
    const load = vi.fn((_request: CloudReferenceTokenRequest) => gate.promise), a = adapter({ load });
    const pending = a.analyse().catch(e => e);
    await vi.advanceTimersByTimeAsync(0);
    const context = load.mock.calls[0]![0];
    expect(context).toMatchObject({ identityRef: a.raw.identityRef, projectId: a.raw.projectId, quotaProjectId: a.raw.quotaProjectId, deadlineAt: CLOUD_TIME + 1000 });
    expect(Object.isFrozen(context)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ kind: 'deadline', dispatched: false }); expect(context.signal.aborted).toBe(true);
    if (late === 'resolve') gate.resolve(cloudToken(a.capability.binding)); else gate.reject(new Error(CLOUD_TOKEN));
    await vi.advanceTimersByTimeAsync(0); expect(a.calls).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['stopped', 'cleared', 'expired'])('%s wins during credential preparation and blocks its late send', async reason => {
    const gate = deferred<CloudReferenceToken>(), control = new AbortController();
    const a = adapter({ load: () => gate.promise });
    const pending = a.analyse(1000, control.signal).catch(e => e);
    await vi.advanceTimersByTimeAsync(10); control.abort(reason);
    expect(await pending).toMatchObject({ kind: 'aborted', dispatched: false });
    gate.resolve(cloudToken(a.capability.binding)); await vi.advanceTimersByTimeAsync(0);
    expect(a.calls).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('checks wall time before timer callbacks and shares the original end across token and HTTP waiting', async () => {
    const gate = deferred<CloudReferenceToken>(), response = deferred<ProviderResponse>();
    const a = adapter({ load: () => gate.promise, respond: () => response.promise });
    const pending = a.analyse().catch(e => e);
    await vi.advanceTimersByTimeAsync(400); gate.resolve(cloudToken(a.capability.binding));
    await vi.advanceTimersByTimeAsync(0); expect(a.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toMatchObject({ kind: 'deadline', dispatched: true }); expect(a.calls[0]!.signal.aborted).toBe(true);
    response.resolve(cloudResponse()); await vi.advanceTimersByTimeAsync(0); expect(a.calls).toHaveLength(1);

    const token = deferred<CloudReferenceToken>(), b = adapter({ load: () => token.promise });
    const late = b.analyse().catch(e => e); await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 1000); token.resolve(cloudToken(b.capability.binding));
    expect(await late).toMatchObject({ kind: 'deadline', dispatched: false }); expect(b.calls).toHaveLength(0);
  });

  it('captures native input before token waiting, caps a longer caller end at90seconds and rejects late parsed output', async () => {
    const gate = deferred<CloudReferenceToken>(), response = deferred<ProviderResponse>(), a = adapter({ load: () => gate.promise, respond: () => response.promise });
    const input = structuredClone(CLOUD_INPUT);
    const pending = a.adapter.analyse(input, new AbortController().signal, undefined, { deadlineAt: Date.now() + 120_000 }).catch(e => e);
    await vi.advanceTimersByTimeAsync(0); input.reference.canonicalUrl = 'https://private.invalid/changed';
    gate.resolve(cloudToken(a.capability.binding)); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(a.calls[0]!.body!).contents[0].parts[0].fileData.fileUri).toBe(CLOUD_INPUT.reference.canonicalUrl);
    await vi.advanceTimersByTimeAsync(90_000); expect(await pending).toMatchObject({ kind: 'deadline', dispatched: true });
    response.resolve(cloudResponse()); await vi.advanceTimersByTimeAsync(0);
    const b = adapter();
    const decode = TextDecoder.prototype.decode;
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (this: TextDecoder, ...args) {
      vi.setSystemTime(Date.now() + 1000); return decode.apply(this, args);
    });
    await expect(b.analyse()).rejects.toMatchObject({ kind: 'deadline', dispatched: true });
  });
});
