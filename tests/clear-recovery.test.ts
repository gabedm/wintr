import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type TransportDeps } from '../src/client/api.js';
import { RecoveryActions } from '../src/client/App.js';
import { browserClearIntents, CLEAR_INTENT_PREFIX, createIntentCell, isIntentId, MAX_INTENTS, memoryClearIntents, newIntentId, readIntents } from '../src/client/clear-intent.js';

// Transport deadlines and the Clear-intent marker port. Fake fetch, timers and
// storage only; real browser reload, cross-tab and BFCache behaviour are
// separate (controller-run) checks.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface Call {
  readonly path: string;
  readonly init: RequestInit;
}

function transport(respond: (call: Call) => Promise<Response>, controlTimeoutMs = 1000) {
  const calls: Call[] = [];
  const deps: TransportDeps = {
    fetch: ((path: string, init: RequestInit) => {
      const call = { path, init };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    controlTimeoutMs,
  };
  return { api: createApi(deps), calls };
}

const never = <T>() => new Promise<T>(() => {});
/** A response whose headers arrived but whose body never finishes. */
const hungBody = (status = 200) => ({ ok: status < 400, status, text: () => never<string>() }) as unknown as Response;
const body = (status: number, text: string) => ({ ok: status < 400, status, text: async () => text }) as unknown as Response;
/** The server's exact revoked-session reply (snapshot(null)). */
const REVOKED = { mode: 'synthetic', session: null, stage: 'idle', revision: 0, status: null, attempt: null, reference: null, listenerCue: null, analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null };
const SNAP = JSON.stringify(REVOKED);

describe('bounded free control and read requests', () => {
  it.each(['fetch', 'body'] as const)('a deadline remains a timeout when the real-style %s rejects immediately on abort', async (phase) => {
    vi.useFakeTimers();
    const { api, calls } = transport(({ init }) => {
      const aborted = new Promise<never>((_, reject) =>
        init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }),
      );
      return phase === 'fetch' ? aborted : Promise.resolve({ ok: true, status: 200, text: () => aborted } as unknown as Response);
    });
    const clearing = api.clear().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await clearing).toMatchObject({ code: 'timeout' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a Clear whose request never answers ends at the deadline with a retryable timeout and aborts the transport', async () => {
    vi.useFakeTimers();
    const { api, calls } = transport(() => never());
    const clearing = api.clear().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls[0]!.init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await clearing;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('timeout');
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a hung body counts against the same deadline: headers alone are never a confirmation', async () => {
    vi.useFakeTimers();
    const { api, calls } = transport(async () => hungBody(200));
    const clearing = api.clear().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    expect(((await clearing) as ApiError).code).toBe('timeout');
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    for (const call of [() => api.state(), () => api.createSession(), () => api.stop({ attempt: 'a' as never })]) {
      const p = call().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(((await p) as ApiError).code).toBe('timeout');
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an unparsable or non-object 200 body is a failure, not an acknowledgement; error bodies keep their code', async () => {
    const bad = transport(async () => body(200, '<html>'));
    expect(((await bad.api.clear().catch((e: unknown) => e)) as ApiError).code).toBe('network');
    const empty = transport(async () => body(200, 'null'));
    expect(((await empty.api.clear().catch((e: unknown) => e)) as ApiError).code).toBe('network');
    const refused = transport(async () => body(403, JSON.stringify({ error: 'bad_origin', message: null })));
    expect(((await refused.api.clear().catch((e: unknown) => e)) as ApiError)).toMatchObject({ status: 403, code: 'bad_origin' });
    const ok = transport(async () => body(200, SNAP));
    expect(await ok.api.clear()).toMatchObject({ session: null });
    expect(ok.calls[0]).toMatchObject({ path: '/api/session', init: { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' } });
  });

  it('paid executes keep the server execute deadline: no client deadline, but the caller can still abort', async () => {
    vi.useFakeTimers();
    const { api, calls } = transport(() => never());
    const stop = new AbortController();
    const settled = vi.fn();
    const running = api.discover({ brief: 'b' as never, actionKey: 'k' }, stop.signal).then(settled, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(settled).not.toHaveBeenCalled();
    expect(calls[0]!.init.signal!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    stop.abort();
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    void running;
  });
});

describe('only the exact revoked-session reply confirms a Clear (through the real transport)', () => {
  it.each([
    ['an empty object', '{}'],
    ['an array', '[]'],
    ['a snapshot that still names a session', JSON.stringify({ ...REVOKED, session: { context: 'ctx', expiresAt: 1 } })],
    ['a snapshot with private content', JSON.stringify({ ...REVOKED, listenerCue: 'private' })],
    ['a partial snapshot', JSON.stringify({ mode: 'synthetic', session: null })],
    ['an unknown mode', JSON.stringify({ ...REVOKED, mode: 'other' })],
    ['an error-shaped success body', JSON.stringify({ ...REVOKED, error: 'no_session' })],
  ])('%s is unconfirmed', async (_label, text) => {
    const { api } = transport(async () => body(200, text));
    const err = (await api.clear().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(['unconfirmed', 'network']).toContain(err.code);
  });

  it('an error reply never confirms, whatever it claims', async () => {
    const { api } = transport(async () => body(401, JSON.stringify({ error: 'no_session', ...REVOKED })));
    expect((await api.clear().catch((e: unknown) => e)) as ApiError).toMatchObject({ status: 401, code: 'no_session' });
  });

  it('the genuine idempotent reply confirms', async () => {
    const { api } = transport(async () => body(200, SNAP));
    expect(await api.clear()).toEqual(REVOKED);
  });
});

describe('the Clear-intent markers', () => {
  it('each operation has its own key holding only a fixed version; the id is a random nonce', () => {
    expect(newIntentId((n) => new Uint8Array(n).fill(171))).toBe('abababababababab');
    expect(isIntentId(newIntentId())).toBe(true);
    expect(newIntentId()).not.toBe(newIntentId());
    for (const bad of ['', 'ABABABABABABABAB', 'abababababababab;ctx=x', 'abab']) expect(isIntentId(bad)).toBe(false);
    const cell = createIntentCell();
    memoryClearIntents(cell).add('abababababababab');
    expect([...cell.entries]).toEqual([[`${CLEAR_INTENT_PREFIX}abababababababab`, 'v1']]);
  });

  it('reading fails closed: any key under the prefix is pending, unreadable storage is unavailable', () => {
    const cell = createIntentCell();
    const port = memoryClearIntents(cell);
    expect(readIntents(port)).toEqual({ state: 'none', ids: [] });
    cell.entries.set('unrelated-key', 'x');
    expect(readIntents(port).state).toBe('none');
    cell.entries.set(`${CLEAR_INTENT_PREFIX}garbage`, 'anything');
    expect(readIntents(port)).toEqual({ state: 'pending', ids: ['garbage'] });
    cell.failRead = true;
    expect(readIntents(port)).toEqual({ state: 'unavailable', ids: [] });
  });

  it('removing one operation never touches another, even when written between a read and a remove', () => {
    const cell = createIntentCell();
    const a = memoryClearIntents(cell);
    const b = memoryClearIntents(cell);
    a.add('000000000000000a');
    cell.beforeOp = (op) => {
      if (op === 'remove') b.add('000000000000000b');
    };
    a.remove('000000000000000a');
    expect(readIntents(a).ids).toEqual(['000000000000000b']);
    a.remove('000000000000000a');
    expect(readIntents(a).ids).toEqual(['000000000000000b']);
  });

  it('delivery is asynchronous: with manual delivery a write is visible before its notification', () => {
    const cell = createIntentCell();
    cell.deliver = 'manual';
    const a = memoryClearIntents(cell);
    const b = memoryClearIntents(cell);
    const seen = vi.fn();
    b.subscribe(seen);
    a.add('000000000000000a');
    expect(readIntents(b).state).toBe('pending');
    expect(seen).not.toHaveBeenCalled();
    cell.flush();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('the browser binding uses one same-origin key per operation, lists them boundedly and reacts only to its prefix (or a storage wipe)', () => {
    const store = new Map<string, string>();
    const listeners: ((e: { key: string | null }) => void)[] = [];
    vi.stubGlobal('localStorage', {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('addEventListener', (type: string, l: (e: { key: string | null }) => void) => type === 'storage' && listeners.push(l));
    vi.stubGlobal('removeEventListener', () => {});
    const port = browserClearIntents();
    store.set('unrelated', 'x');
    port.add('0000000000000002');
    port.add('0000000000000003');
    expect(port.list().sort()).toEqual(['0000000000000002', '0000000000000003']);
    port.remove('0000000000000002');
    expect([...store.keys()].sort()).toEqual(['unrelated', `${CLEAR_INTENT_PREFIX}0000000000000003`]);
    expect(store.get(`${CLEAR_INTENT_PREFIX}0000000000000003`)).toBe('v1');
    for (let i = 0; i < 100; i += 1) store.set(`${CLEAR_INTENT_PREFIX}flood${i}`, 'x');
    expect(port.list().length).toBe(MAX_INTENTS + 1);
    const seen = vi.fn();
    port.subscribe(seen);
    for (const l of listeners) l({ key: 'something-else' });
    expect(seen).not.toHaveBeenCalled();
    for (const l of listeners) l({ key: `${CLEAR_INTENT_PREFIX}x` });
    for (const l of listeners) l({ key: null });
    expect(seen).toHaveBeenCalledTimes(2);
    vi.stubGlobal('localStorage', undefined);
    expect(readIntents(browserClearIntents()).state).toBe('unavailable');
  });
});

describe('explicit recovery actions', () => {
  const render = (recovery: 'clear_pending' | 'storage_unavailable' | null, failedClear = false) =>
    renderToStaticMarkup(createElement(RecoveryActions, { recovery, failedClear, onRetryClear: () => {}, onContinue: () => {} }));

  it('offers Retry Clear for a pending Clear, and also "Show this session" only when storage cannot be checked', () => {
    expect(render(null)).toBe('');
    expect(render('clear_pending')).toMatch(/>Retry Clear</);
    expect(render('clear_pending')).not.toMatch(/Show this session/);
    expect(render('storage_unavailable')).toMatch(/>Retry Clear<[\s\S]*>Show this session</);
    expect(render(null, true)).toMatch(/>Retry Clear</);
  });
});
