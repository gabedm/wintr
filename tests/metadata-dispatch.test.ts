import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetadataBudget, safeGet, type PinnedResponse, type SafeFetchContext, type SafeFetchDeps } from '../src/server/net/safe-fetch.js';

// Invented metadata and public addresses only. No network or provider calls.
const response: PinnedResponse = { status: 200, location: null, body: new Uint8Array([1]) };
const url = new URL('https://catalogue.example/search');
const policy = { maxBytes: 10, allow: (u: URL) => u.hostname === url.hostname };
const context = (over: Partial<SafeFetchContext> & { dispatchBy?: number } = {}) => ({
  signal: new AbortController().signal, deadlineAt: 60_000, dispatchBy: 5_000, budget: createMetadataBudget(), ...over,
});
afterEach(() => vi.useRealTimers());

describe('metadata dispatch ticket and response deadline', () => {
  it('accepts a timely connection whose short response completes after the dispatch ticket', async () => {
    let now = 0;
    const deps: SafeFetchDeps = {
      now: () => now,
      resolve: async () => { now = 4_900; return ['17.253.1.1']; },
      http: async () => { now = 5_100; return response; },
    };
    await expect(safeGet(deps, policy, url, context())).resolves.toMatchObject({ status: 200 });
  });

  it('allows final durable authorization to complete after a timely response and ticket', async () => {
    let now = 0, checks = 0;
    const deps: SafeFetchDeps = { now: () => now, resolve: async () => ['17.253.1.1'], http: async () => { now = 4_500; return response; } };
    const authorize = async () => { if (++checks === 3) now = 5_100; return true; };
    await expect(safeGet(deps, policy, url, context({ authorize }))).resolves.toMatchObject({ status: 200 });
    expect(checks).toBe(3);
  });

  it.each(['before_dns', 'after_dns', 'after_authorize'] as const)('never starts a late connection: %s', async phase => {
    let now = phase === 'before_dns' ? 5_000 : 0, checks = 0;
    const dns = vi.fn(async () => { if (phase === 'after_dns') now = 5_000; return ['17.253.1.1']; });
    const http = vi.fn(async () => response);
    const authorize = async () => { if (phase === 'after_authorize' && ++checks === 2) now = 5_000; return true; };
    await expect(safeGet({ now: () => now, resolve: dns, http }, policy, url, context({ authorize }))).rejects.toMatchObject({ gap: 'deadline' });
    expect(http).not.toHaveBeenCalled();
    expect(dns).toHaveBeenCalledTimes(phase === 'before_dns' ? 0 : 1);
  });

  it('does not start a redirect hop after the ticket', async () => {
    let now = 0;
    const dns = vi.fn(async () => ['17.253.1.1']);
    const http = vi.fn(async () => { now = 5_100; return { ...response, status: 302, location: '/next' }; });
    await expect(safeGet({ now: () => now, resolve: dns, http }, policy, url, context())).rejects.toMatchObject({ gap: 'deadline' });
    expect(dns).toHaveBeenCalledTimes(1); expect(http).toHaveBeenCalledTimes(1);
  });

  it('still discards a response at the overall execute or owner deadline', async () => {
    let now = 0;
    const deps: SafeFetchDeps = { now: () => now, resolve: async () => ['17.253.1.1'], http: async () => { now = 4_000; return response; } };
    await expect(safeGet(deps, policy, url, context({ deadlineAt: 4_000 }))).rejects.toMatchObject({ gap: 'deadline' });
  });

  it('keeps a timely HTTP response alive when the actual dispatch timer fires', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const http = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 200)); return response; });
    const deps: SafeFetchDeps = { now: Date.now, resolve: async () => { await new Promise(resolve => setTimeout(resolve, 4_900)); return ['17.253.1.1']; }, http };
    const pending = safeGet(deps, policy, url, context());
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('ends held DNS at ticket expiry and absorbs its late answer without connecting', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let release!: (addresses: string[]) => void;
    const dns = new Promise<string[]>(resolve => { release = resolve; });
    const http = vi.fn(async () => response);
    const pending = safeGet({ now: Date.now, resolve: () => dns, http }, policy, url, context()).catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ gap: 'deadline' });
    release(['17.253.1.1']); await vi.advanceTimersByTimeAsync(0);
    expect(http).not.toHaveBeenCalled();
  });

  it('still ends an unresponsive HTTP request after five seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const pending = safeGet({ now: Date.now, resolve: async () => ['17.253.1.1'], http: () => new Promise(() => {}) }, policy, url, context()).catch(error => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ gap: 'deadline' });
  });

  it.each([Number.NaN, Infinity, -1, 1.5])('refuses malformed dispatch bounds before any I/O: %s', async dispatchBy => {
    const dns = vi.fn(async () => ['17.253.1.1']);
    await expect(safeGet({ now: () => 0, resolve: dns, http: async () => response }, policy, url, context({ dispatchBy }))).rejects.toMatchObject({ gap: 'deadline' });
    expect(dns).not.toHaveBeenCalled();
  });

  it('disposes the operation timer and abort listener when dispatch-clock sampling throws', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    let samples = 0;
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
    const dns = vi.fn(async () => ['17.253.1.1']);
    await expect(safeGet({ now: () => { if (++samples === 2) throw new Error('invented clock regression'); return 0; }, resolve: dns, http: async () => response }, policy, url, context({ signal: controller.signal }))).rejects.toThrow('invented clock regression');
    expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledTimes(1);
    expect(dns).not.toHaveBeenCalled();
  });
});
