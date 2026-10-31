import { describe, expect, it, vi } from 'vitest';
import type { Handle } from '../src/shared/records.js';
import type { CatalogueHandoff } from '../src/server/catalogue.js';
import { CANDIDATE_SELECTOR_OBSERVATION_PROFILE, liveObservationProfile, OBSERVATION_PROFILES, validObservationProfile } from '../src/server/ledger/observation.js';
import { buildCandidateSelectionRequest, createGeminiCandidateSelector, parseCandidateSelection, type SelectorCandidate } from '../src/server/providers/gemini-candidate-selector.js';
import { buildCatalogueRequestBody, createGeminiCatalogueAdapter } from '../src/server/providers/gemini-catalogue.js';
import { ProviderError, type ProviderResponse } from '../src/server/providers/http.js';
import { createCallObserver } from '../src/server/providers/observation.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { catalogueTransport, sseBody } from './fixtures/catalogue-fixtures.js';

// Protocol tests over invented metadata and a fake HTTP transport. No providers,
// media, account credentials or live catalogue/candidate provenance are tested.
const ref = (s: string) => s.padEnd(24, '0');
const A = ref('candidate-a'), B = ref('candidate-b');
const handoff: CatalogueHandoff = { plan: ref('plan') as Handle, briefVersion: 1, relationship: 'A low line under a light lead', seedMix: ['Invented Seed'],
  attribution: 'seed_mix', allowedArtists: [{ ref: ref('anchor') as Handle, name: 'Invented Neighbour' }], associations: [], exclusions: [], excludedRecordings: [], priorities: [] };
const candidates: readonly SelectorCandidate[] = [{ ref: A, title: 'Invented Song', artist: 'Invented Neighbour', anchor: 'Invented Neighbour' }];
const choice = (candidateRef = A) => ({ candidateRef, fitHypothesis: 'It may carry the contrast you chose.' });
const payload = (choices: unknown[] = [choice()]) => JSON.stringify({ choices });
const event = (text: string, extra: Record<string, unknown> = {}) => ({ candidates: [{ index: 0, content: { parts: [{ text }] }, finishReason: 'STOP', ...extra }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 21 } });
const response = (events: unknown[], status = 200): ProviderResponse => ({ status, contentType: 'text/event-stream', body: sseBody(events) });
const options = (signal = new AbortController().signal, now = Date.now) => ({ signal, now, deadlineAt: now() + 10_000 });
const secret = () => new ServerSecret('invented-selector-token');
function setup(result = response([event(payload())]), accessToken = async () => secret()) {
  const t = catalogueTransport(() => result);
  return { ...t, adapter: createGeminiCandidateSelector({ ...t, accessToken, project: 'invented-project', quotaProject: 'invented-quota' }) };
}

describe('closed candidate selection output', () => {
  it('permits explicit abstention and only exact supplied distinct references', () => {
    expect(parseCandidateSelection(payload([]), new Set([A]))).toEqual([]);
    const result = parseCandidateSelection(payload([choice()]), new Set([A]));
    expect(result).toEqual([choice()]);
    expect(Object.isFrozen(result) && Object.isFrozen(result[0])).toBe(true);
  });

  it.each([
    '{"choices":[],"extra":true}', '{"choices":null}', '{"choices":[],"choices":[]}',
    '{"choices":[],"choi\\u0063es":[]}', '```json\n{"choices":[]}\n```', 'null',
    payload([choice(B)]), payload([choice(), choice()]), payload([choice(), choice(B), choice(ref('c')), choice(ref('d'))]),
    payload([{ ...choice(), title: 'Invented by model' }]), payload([{ candidateRef: A }]),
    payload([{ ...choice(), fitHypothesis: 'https://example.invalid/song' }]),
    payload([{ ...choice(), fitHypothesis: 'untrusted\ncontrol' }]), payload([{ ...choice(), fitHypothesis: 'x'.repeat(301) }]),
    '{"choices":[{"candidateRef":"' + A + '","candidateRef":"' + A + '","fitHypothesis":"Maybe."}]}',
  ])('refuses malformed, extra, repeated, unsafe or out-of-set data (%#)', (text) => {
    expect(() => parseCandidateSelection(text, new Set([A, ref('c'), ref('d')]))).toThrow(ProviderError);
  });

  it('does not confuse JSON-looking words inside a hypothesis with structural duplicate keys', () => {
    const value = { candidateRef: A, fitHypothesis: 'The phrase "choices": is just text.' };
    expect(parseCandidateSelection(payload([value]), new Set([A]))).toEqual([value]);
  });
});

describe('separate fixed Cloud selector profile', () => {
  it.each([false, true])('retains earlier valid usage and never observes ambiguous stream usage (native=%s)', async native => {
    const body = new TextEncoder().encode(
      'data: {"usageMetadata":{"promptTokenCount":40,"candidatesTokenCount":5,"totalTokenCount":45}}\n\n' +
      'data: {"usageMetadata":{"promptTokenCount":900,"promptTokenCount":901,"totalTokenCount":999}}\n\n');
    const t = catalogueTransport(() => ({ status: 200, contentType: 'text/event-stream', body }));
    const observed = createCallObserver('catalogue_generation', Date.now(), Date.now, async () => 'stored',
      native ? OBSERVATION_PROFILES.catalogue_generation : CANDIDATE_SELECTOR_OBSERVATION_PROFILE);
    const usage = vi.fn(observed.observer.usage);
    const observer = { ...observed.observer, usage };
    const config = { transport: t.transport, project: 'invented-project', quotaProject: 'invented-quota', accessToken: async () => secret() };
    const result = native ? createGeminiCatalogueAdapter(config).generate('invented prompt', { ...options(), observer })
      : createGeminiCandidateSelector(config).select(handoff, candidates, { ...options(), observer });
    await expect(result).rejects.toMatchObject({ kind: 'malformed', dispatched: true });
    expect(t.calls).toHaveLength(1);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(observed.snapshot().usage.inputTokens).toMatchObject({ state: 'known', value: 40 });
    expect(observed.snapshot().usage.totalTokens).toMatchObject({ state: 'known', value: 45 });
  });

  it.each([
    '"finishReason":"SAFETY","finishReason":"STOP"',
    '"finishReason":"STOP","safetyRatings":[{"blocked":true,"blocked":false}]',
    '"finishReason":"STOP","safetyRatings":[{"blocked":true,"blo\\u0063ked":false}]',
  ])('rejects ambiguous outer stream safety fields in both catalogue adapters (%#)', async fields => {
    for (const native of [false, true]) {
      const text = native ? 'NO SUPPORTED CHOICE' : payload();
      const body = new TextEncoder().encode(`data: {"candidates":[{"content":{"parts":[{"text":${JSON.stringify(text)}}]},${fields}}]}\n\n`);
      const t = catalogueTransport(() => ({ status: 200, contentType: 'text/event-stream', body }));
      const config = { transport: t.transport, project: 'invented-project', quotaProject: 'invented-quota', accessToken: async () => secret() };
      const result = native ? createGeminiCatalogueAdapter(config).generate('invented prompt', options())
        : createGeminiCandidateSelector(config).select(handoff, candidates, options());
      await expect(result).rejects.toMatchObject({ kind: 'malformed', dispatched: true });
      expect(t.calls).toHaveLength(1);
    }
  });

  it('omits tools while retaining native Search request behaviour unchanged', () => {
    const body = JSON.parse(buildCandidateSelectionRequest('invented prompt'));
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig).toEqual({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' }, responseMimeType: 'application/json' });
    expect(JSON.parse(buildCatalogueRequestBody('invented prompt')).tools).toEqual([{ googleSearch: {} }]);
    expect(liveObservationProfile('catalogue_generation', CANDIDATE_SELECTOR_OBSERVATION_PROFILE)).toBe(true);
    expect(validObservationProfile('catalogue_generation', OBSERVATION_PROFILES.catalogue_generation)).toBe(true);
    expect(liveObservationProfile('reference_analysis', CANDIDATE_SELECTOR_OBSERVATION_PROFILE)).toBe(false);
  });

  it('sends once on the pinned Cloud route with header-only credentials and returns only refs/hypotheses/usage', async () => {
    const t = setup();
    expect(await t.adapter.select(handoff, candidates, options())).toEqual({ choices: [choice()], usage: { promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 21 } });
    expect(t.calls).toHaveLength(1);
    const request = t.calls[0]!;
    expect(request.url.origin).toBe('https://aiplatform.googleapis.com');
    expect(request.url.pathname).toContain('/projects/invented-project/locations/global/publishers/google/models/gemini-3.6-flash:streamGenerateContent');
    expect(request.url.search).toBe('?alt=sse');
    expect(request.headers.authorization).toBe('Bearer invented-selector-token');
    expect(request.headers['x-goog-user-project']).toBe('invented-quota');
    expect(request.body).not.toContain('invented-selector-token');
    expect(JSON.parse(request.body!).tools).toBeUndefined();
    expect(t.adapter.observationProfile).toBe(CANDIDATE_SELECTOR_OBSERVATION_PROFILE);
  });

  it.each(['groundingMetadata', 'citationMetadata', 'urlContextMetadata'])('refuses unexpected %s rather than silently stripping attribution', async (key) => {
    const t = setup(response([event(payload(), { [key]: {} })]));
    await expect(t.adapter.select(handoff, candidates, options())).rejects.toMatchObject({ kind: 'schema', dispatched: true });
    expect(t.calls).toHaveLength(1);
  });

  it('keeps decoded usage after a refused generation and never lets a later STOP undo the refusal', async () => {
    const events = [event('', { finishReason: 'SAFETY' }), event(payload())];
    const t = setup(response(events));
    const observed = createCallObserver('catalogue_generation', Date.now(), Date.now, async () => 'stored', CANDIDATE_SELECTOR_OBSERVATION_PROFILE);
    const error = await t.adapter.select(handoff, candidates, { ...options(), observer: observed.observer }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'refused', dispatched: true });
    observed.finish(error); await observed.flush();
    expect(observed.snapshot().usage.inputTokens).toMatchObject({ state: 'known', value: 12 });
    expect(observed.snapshot().invocation).toBe('one');
  });

  it.each([
    { safetyRatings: [{ blocked: true }] },
    { safetyRatings: [{ blocked: 'false' }] },
    { safetyRatings: {} },
    { content: { parts: [{ text: payload(), functionCall: { name: 'unrequested' } }] } },
    { content: { parts: [{ text: payload(), thought: 'true' }] } },
  ])('refuses blocked or malformed tool-free response fields after usage capture (%#)', async (extra) => {
    const t = setup(response([event(payload(), extra)]));
    const observed = createCallObserver('catalogue_generation', Date.now(), Date.now, async () => 'stored', CANDIDATE_SELECTOR_OBSERVATION_PROFILE);
    const error = await t.adapter.select(handoff, candidates, { ...options(), observer: observed.observer }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    observed.finish(error); await observed.flush();
    expect(observed.snapshot().usage.inputTokens).toMatchObject({ state: 'known', value: 12 });
    expect(t.calls).toHaveLength(1);
  });

  it('refuses prompt safety blocking even when candidate text ends with STOP', async () => {
    const t = setup(response([{ ...event(payload()), promptFeedback: { safetyRatings: [{ blocked: true }] } }]));
    await expect(t.adapter.select(handoff, candidates, options())).rejects.toMatchObject({ kind: 'refused', dispatched: true });
  });

  it.each([401, 429, 503])('returns one bounded HTTP failure without a retry (%i)', async (status) => {
    const t = setup(response([], status));
    await expect(t.adapter.select(handoff, candidates, options())).rejects.toMatchObject({ status, dispatched: true });
    expect(t.calls).toHaveLength(1);
  });

  it('refuses invalid input before loading a token, and refuses invalid routing at construction', async () => {
    const token = vi.fn(async () => secret());
    const t = setup(undefined, token);
    await expect(t.adapter.select(handoff, [], options())).rejects.toMatchObject({ kind: 'config', dispatched: false });
    expect(token).not.toHaveBeenCalled(); expect(t.calls).toHaveLength(0);
    expect(() => createGeminiCandidateSelector({ transport: t.transport, accessToken: token, project: '../other', quotaProject: 'invented-quota' })).toThrow(TypeError);
  });

  it('captures candidate membership and routing before an asynchronous token wait', async () => {
    let release!: (s: ServerSecret) => void;
    const token = new Promise<ServerSecret>((yes) => { release = yes; });
    const t = catalogueTransport(() => response([event(payload())]));
    const config = { transport: t.transport, accessToken: () => token, project: 'invented-project', quotaProject: 'invented-quota' };
    const adapter = createGeminiCandidateSelector(config);
    const input = [{ ...candidates[0]! }];
    const pending = adapter.select(handoff, input, options());
    input[0]!.ref = B; config.project = 'changed-project'; config.quotaProject = 'changed-quota';
    release(secret());
    expect((await pending).choices[0]!.candidateRef).toBe(A);
    expect(t.calls[0]!.url.pathname).toContain('/projects/invented-project/');
    expect(t.calls[0]!.headers['x-goog-user-project']).toBe('invented-quota');
    expect(t.calls[0]!.body).toContain(A); expect(t.calls[0]!.body).not.toContain(B);
  });

  it.each(['stop', 'deadline', 'clock-regression'] as const)('cannot send after %s during a held token', async (ending) => {
    let time = 1000;
    let release!: (s: ServerSecret) => void;
    const token = new Promise<ServerSecret>((yes) => { release = yes; });
    const t = setup(undefined, () => token);
    const stopped = new AbortController();
    const pending = t.adapter.select(handoff, candidates, options(stopped.signal, () => time)).catch((e: unknown) => e);
    await Promise.resolve(); await Promise.resolve();
    if (ending === 'stop') stopped.abort();
    else time = ending === 'deadline' ? 11_000 : 999;
    release(secret());
    const error = await pending;
    expect(error).toBeInstanceOf(ProviderError);
    expect(t.calls).toHaveLength(0);
  });

  it('does not let a replaced options clock/signal/deadline escape the captured boundary', async () => {
    let time = 1000;
    let release!: (s: ServerSecret) => void;
    const token = new Promise<ServerSecret>((yes) => { release = yes; });
    const t = setup(undefined, () => token);
    const o = options(new AbortController().signal, () => time);
    const pending = t.adapter.select(handoff, candidates, o).catch((e: unknown) => e);
    await Promise.resolve(); await Promise.resolve();
    time = 11_000; o.now = () => 1000; o.deadlineAt = 999_999; o.signal = new AbortController().signal;
    release(secret());
    expect(await pending).toMatchObject({ kind: 'deadline', dispatched: false });
    expect(t.calls).toHaveLength(0);
  });

  it('keeps the original observer when options mutate during token waiting', async () => {
    let release!: (s: ServerSecret) => void;
    const token = new Promise<ServerSecret>((yes) => { release = yes; });
    const t = setup(undefined, () => token);
    const original = createCallObserver('catalogue_generation', Date.now(), Date.now, async () => 'stored', CANDIDATE_SELECTOR_OBSERVATION_PROFILE);
    const replacement = createCallObserver('catalogue_generation', Date.now(), Date.now, async () => 'stored', CANDIDATE_SELECTOR_OBSERVATION_PROFILE);
    const o = { ...options(), observer: original.observer };
    const pending = t.adapter.select(handoff, candidates, o);
    await Promise.resolve(); await Promise.resolve();
    o.observer = replacement.observer; release(secret());
    await pending;
    original.finish(); replacement.finish(); await original.flush(); await replacement.flush();
    expect(original.snapshot().invocation).toBe('one');
    expect(original.snapshot().usage.inputTokens).toMatchObject({ state: 'known', value: 12 });
    expect(replacement.snapshot().usage.inputTokens.state).toBe('unknown');
  });
});
