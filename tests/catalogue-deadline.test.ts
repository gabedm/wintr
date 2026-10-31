import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Handle, InvestigationPlan, QlooCandidatePool } from '../src/shared/records.js';
import { buildCatalogueHandoff, type CatalogueContext } from '../src/server/catalogue.js';
import { createNativeCatalogue } from '../src/server/native-catalogue.js';
import { createSourceResolver } from '../src/server/source-resolver.js';
import { createGeminiCatalogueAdapter, type CatalogueAdapter, type CatalogueGeneration } from '../src/server/providers/gemini-catalogue.js';
import { ProviderError, type ProviderResponse } from '../src/server/providers/http.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { catalogueTransport, envelope, fakeNetwork } from './fixtures/catalogue-fixtures.js';

// All time, tokens, responses and transports here are synthetic. No network.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const secret = () => new ServerSecret('invented-catalogue-deadline-token');
const options = (ms: number, signal = new AbortController().signal) => ({ deadlineAt: Date.now() + ms, now: Date.now, signal });
const noMatch = () => envelope([], { none: true });
const adapterFor = (accessToken: () => Promise<ServerSecret>, respond: () => ProviderResponse | Promise<ProviderResponse> = noMatch) => {
  const t = catalogueTransport(respond);
  return { ...t, adapter: createGeminiCatalogueAdapter({ transport: t.transport, accessToken, project: 'invented-project', quotaProject: 'invented-quota' }) };
};

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('absolute catalogue deadline through credential preparation', () => {
  it('checks elapsed server time after token preparation even before a timer callback runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const token = deferred<ServerSecret>();
    const t = adapterFor(() => token.promise);
    const pending = t.adapter.generate('invented prompt', options(1_000)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(2_000);
    token.resolve(secret());
    expect(await pending).toMatchObject({ kind: 'deadline', dispatched: false });
    expect(t.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('bounds a never-resolving token and absorbs its late %s without sending', async (late) => {
    vi.useFakeTimers();
    const token = deferred<ServerSecret>();
    const t = adapterFor(() => token.promise);
    const pending = t.adapter.generate('invented prompt', options(1_000)).catch((e: unknown) => e);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: 'deadline', dispatched: false });
    expect(t.calls).toHaveLength(0);
    if (late === 'resolve') token.resolve(secret());
    else token.reject(new Error('invented late credential failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives transport only the remaining time after a delayed token, then ignores its late answer', async () => {
    vi.useFakeTimers();
    const token = deferred<ServerSecret>();
    const response = deferred<ProviderResponse>();
    const t = adapterFor(() => token.promise, () => response.promise);
    const pending = t.adapter.generate('invented prompt', options(1_000)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(400);
    token.resolve(secret());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(599);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ kind: 'deadline', dispatched: true });
    expect(t.calls[0]!.signal.aborted).toBe(true);
    response.resolve(noMatch());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['stopped', 'cleared', 'expired'])('%s cancels pending token preparation promptly and prevents a late send', async (reason) => {
    vi.useFakeTimers();
    const token = deferred<ServerSecret>();
    const t = adapterFor(() => token.promise);
    const control = new AbortController();
    const pending = t.adapter.generate('invented prompt', options(1_000, control.signal)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    control.abort(reason);
    expect(await pending).toMatchObject({ kind: 'aborted', dispatched: false });
    token.resolve(secret());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets outer cancellation win when the token completes at the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const token = deferred<ServerSecret>();
    const t = adapterFor(() => token.promise);
    const control = new AbortController();
    const pending = t.adapter.generate('invented prompt', options(1_000, control.signal)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(2_000);
    token.resolve(secret());
    control.abort('stopped');
    expect(await pending).toMatchObject({ kind: 'aborted', dispatched: false });
    expect(t.calls).toHaveLength(0);
  });

  it('rejects an answer that reaches the absolute end before parsing, even before the timer runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    const t = adapterFor(async () => secret(), () => {
      vi.setSystemTime(2_000);
      return noMatch();
    });
    await expect(t.adapter.generate('invented prompt', options(1_000))).rejects.toMatchObject({ kind: 'deadline', dispatched: true });
    expect(decode).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(1);
  });

  it('does not publish a parsed generation if synchronous parsing crosses the absolute end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const decode = TextDecoder.prototype.decode;
    vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (this: TextDecoder, ...args) {
      vi.setSystemTime(2_000);
      return decode.apply(this, args);
    });
    const t = adapterFor(async () => secret());
    await expect(t.adapter.generate('invented prompt', options(1_000))).rejects.toMatchObject({ kind: 'deadline', dispatched: true });
    expect(t.calls).toHaveLength(1);
  });

  it('fails closed on invalid clock/deadline authority before loading a token or sending', async () => {
    const load = vi.fn(async () => secret());
    const t = adapterFor(load);
    for (const authority of [{ deadlineAt: NaN, now: Date.now }, { deadlineAt: Date.now() + 1000, now: () => NaN }]) {
      await expect(t.adapter.generate('invented prompt', { ...authority, signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'config', dispatched: false });
    }
    expect(load).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(0);
  });
});

describe('absolute catalogue deadline fixed before dispatch admission', () => {
  const handle = (s: string) => s.repeat(24) as Handle;
  const owned = { sessionId: handle('s'), epoch: 1, createdAt: 0, expiresAt: 200_000 };
  const plan: InvestigationPlan = {
    ...owned, id: handle('p'), journeyId: handle('j'), briefId: handle('b'), briefVersion: 1, poolId: handle('o'),
    relationship: 'Invented relationship', seedNames: ['Invented Seed'], anchors: [], associations: [], exclusions: [],
    recordingExclusions: { shown: [], known: [] }, priorities: [], refinementMode: null, refinement: null, attribution: 'seed_mix',
    provenance: { analysisId: handle('a'), analysisReuse: 'same_source_focus', poolSourceBriefId: handle('b'), poolReuse: 'created' },
  };
  const pool: QlooCandidatePool = {
    ...owned, id: plan.poolId, journeyId: plan.journeyId, sourceBriefId: plan.briefId, origin: 'initial', fingerprint: 'invented-fingerprint',
    synthetic: true, seeds: [], artists: [], tags: [], capability: 'artists_only',
    lineage: { artistReturned: 0, artistRejected: 0, aliasesRemoved: 0, duplicatesRemoved: 0, tagOutcome: 'not_admitted', tagReturned: 0 },
  };
  function investigate(adapter: CatalogueAdapter, admission: Promise<void>, control = new AbortController(), executeMs = 100_000) {
    const lookup = vi.fn();
    const net = fakeNetwork({});
    const native = createNativeCatalogue({ adapter, verifier: { synthetic: true, lookup }, sources: createSourceResolver({ resolve: net.resolve, http: net.http, now: Date.now }, true) });
    const ctx: CatalogueContext = {
      signal: control.signal, now: Date.now, deadlineAt: Date.now() + executeMs, newHandle: () => handle('h'),
      dispatchGemini: async (call) => { await admission; return call(control.signal); },
    };
    return { pending: native.investigate(buildCatalogueHandoff(plan), { plan, pool }, ctx), lookup };
  }

  it('exhausted admission fails at the generation end; a late grant cannot load a token or send', async () => {
    vi.useFakeTimers();
    const grant = deferred<void>();
    const load = vi.fn(async () => secret());
    const t = adapterFor(load);
    const run = investigate(t.adapter, grant.promise);
    let settled = false;
    void run.pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(79_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run.pending).toEqual({ kind: 'failed', failure: 'deadline' });
    grant.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(0);
    expect(run.lookup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks time at admission return when the generation timer has not yet fired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const grant = deferred<void>();
    const load = vi.fn(async () => secret());
    const t = adapterFor(load);
    const run = investigate(t.adapter, grant.promise);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(81_000);
    grant.resolve();
    expect(await run.pending).toEqual({ kind: 'failed', failure: 'deadline' });
    expect(load).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(0);
  });

  it('admission and token delays share the original allocation and leave all 20 seconds of reserve', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const grant = deferred<void>();
    const token = deferred<ServerSecret>();
    const response = deferred<ProviderResponse>();
    const t = adapterFor(() => token.promise, () => response.promise);
    const generate = vi.spyOn(t.adapter, 'generate');
    const run = investigate(t.adapter, grant.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    grant.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(generate.mock.calls[0]![1].deadlineAt).toBe(81_000);
    expect(generate.mock.calls[0]![1].now).toBe(Date.now);
    await vi.advanceTimersByTimeAsync(20_000);
    token.resolve(secret());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(1);
    let settled = false;
    void run.pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run.pending).toEqual({ kind: 'failed', failure: 'deadline' });
    expect(Date.now()).toBe(81_000); // Execute still has its untouched 20-second reserve.
    expect(t.calls[0]!.signal.aborted).toBe(true);
    response.resolve(noMatch());
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(1);
    expect(run.lookup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also preserves the 90-second cap when the execute has more time', async () => {
    vi.useFakeTimers();
    const grant = deferred<void>();
    const t = adapterFor(async () => secret(), () => new Promise(() => {}));
    const run = investigate(t.adapter, grant.promise, new AbortController(), 120_000);
    await vi.advanceTimersByTimeAsync(40_000);
    grant.resolve();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await run.pending).toEqual({ kind: 'failed', failure: 'deadline' });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.signal.aborted).toBe(true);
  });

  it('accepts a current delayed generation and ignores a generation that returns after its end', async () => {
    vi.useFakeTimers();
    const t = adapterFor(async () => secret());
    const grant = deferred<void>();
    const run = investigate(t.adapter, grant.promise);
    await vi.advanceTimersByTimeAsync(30_000);
    grant.resolve();
    expect(await run.pending).toMatchObject({ kind: 'panel', panel: { outcome: 'no_match' } });
    expect(t.calls).toHaveLength(1);

    // A seam that ignores its signal cannot return late text for the native parser/metadata path.
    const generation = deferred<CatalogueGeneration>();
    const late = investigate({ synthetic: true, generate: () => generation.promise }, Promise.resolve());
    await vi.advanceTimersByTimeAsync(80_000);
    expect(await late.pending).toEqual({ kind: 'failed', failure: 'deadline' });
    const text = vi.fn(() => { throw new Error('late text must not be parsed'); });
    generation.resolve({ get text() { return text(); }, grounding: { queries: [], chunks: [], supports: [], renderedContent: null, invalidChunks: 0, invalidSupports: 0 }, usage: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(text).not.toHaveBeenCalled();
    expect(late.lookup).not.toHaveBeenCalled();
  });

  it.each(['stopped', 'cleared', 'expired'])('%s wins during pending admission; its later grant cannot send', async (reason) => {
    vi.useFakeTimers();
    const grant = deferred<void>();
    const control = new AbortController();
    const t = adapterFor(async () => secret());
    const run = investigate(t.adapter, grant.promise, control);
    const pending = run.pending.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    control.abort(reason);
    expect(await pending).toBeInstanceOf(ProviderError);
    expect(await pending).toMatchObject({ kind: 'aborted' });
    grant.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toHaveLength(0);
    expect(run.lookup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
