import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { LIMITS } from '../../shared/records.js';

// Deterministic metadata fetching with injected DNS, connection and clock seams.
// - Only server-owned host/route allowlists; HTTPS on the standard port; no
//   credentials in URLs; no cookies, auth or provider keys are ever sent.
// - Every hop (including each redirect, at most three) is resolved, every
//   resolved address must be public, and the connection is pinned to the
//   validated address (no second lookup, so DNS rebinding cannot swap it).
// - Bounded body, per-request time (<= 5 s or remaining execute time), at most
//   three concurrent checks and the frozen aggregate cap per execute.
// - One cancellation/deadline guard covers the whole operation and is installed
//   before the first await. DNS and HTTP are both raced against it, and every
//   hop re-authorises (signal + remaining time) before connecting, so a held or
//   uncooperative lookup/connection can neither outlive Stop/deadline nor start
//   a connection afterwards. Late completions are absorbed, never unhandled.
// - Metadata only: no media is downloaded or analysed.

export type FetchGap = 'unsafe_redirect' | 'unsafe_address' | 'too_many_redirects' | 'unreachable' | 'oversize' | 'deadline' | 'aborted' | 'metadata_cap';

export class SafeFetchError extends Error {
  constructor(readonly gap: FetchGap) {
    super(gap);
  }
}

export type DnsResolver = (hostname: string) => Promise<readonly string[]>;

export interface PinnedRequest {
  /** Source resolution is HEAD-only; metadata keeps the default GET. */
  readonly method?: 'HEAD';
  readonly url: URL;
  /** The validated public address the connection must use. */
  readonly address: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

export interface PinnedResponse {
  readonly status: number;
  readonly location: string | null;
  readonly body: Uint8Array;
}

export type PinnedHttpClient = (req: PinnedRequest) => Promise<PinnedResponse>;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}

const isPublicIPv4 = (address: string) => isIP(address) === 4 && !blocked.check(address, 'ipv4');

/**
 * Expands any valid textual IPv6 form (compressed, uncompressed, embedded
 * dotted IPv4 tail) to its 16 bytes. Zone identifiers are refused.
 */
export function ipv6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes('%')) return null;
  let s = address.toLowerCase();
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    s = `${s.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if ((halves.length === 1 && head.length !== 8) || fill < 0 || (halves.length === 2 && fill < 1)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

/**
 * True only for a syntactically valid, publicly routable unicast address.
 * IPv6 is an allowlist: only global unicast 2000::/3 can qualify, minus its
 * special-purpose blocks. Everything else is refused, including :: and ::1,
 * reserved ::/8 forms such as ::2, IPv4-compatible ::a.b.c.d, NAT64
 * 64:ff9b::/96, discard 100::/64, ULA fc00::/7, link-local fe80::/10,
 * deprecated site-local fec0::/10 and multicast ff00::/8. IPv4-mapped
 * ::ffff:0:0/96 (in any spelling) is classified exactly as its embedded IPv4.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family !== 6) return false;
  const b = ipv6Bytes(address);
  if (!b) return false;
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return isPublicIPv4(b.slice(12).join('.'));
  if ((b[0]! & 0xe0) !== 0x20) return false;
  const [b0, b1, b2, b3] = b as [number, number, number, number];
  if (b0 === 0x20 && b1 === 0x01 && b2 < 0x02) return false; // 2001::/23 IETF protocol assignments (Teredo, ORCHID…)
  if (b0 === 0x20 && b1 === 0x01 && b2 === 0x0d && b3 === 0xb8) return false; // 2001:db8::/32 documentation
  if (b0 === 0x20 && b1 === 0x02) return false; // 2002::/16 6to4 (embeds arbitrary IPv4)
  if (b0 === 0x3f && b1 === 0xfe) return false; // 3ffe::/16 former 6bone
  if (b0 === 0x3f && b1 === 0xff && (b2 & 0xf0) === 0) return false; // 3fff::/20 documentation
  return true;
}

export interface MetadataBudget {
  /** Takes one request from the aggregate cap; false when exhausted. */
  take(): boolean;
  /** Runs fn with at most `concurrency` holders at once. */
  slot<T>(fn: () => Promise<T>): Promise<T>;
  readonly used: () => number;
}

export function createMetadataBudget(cap: number = LIMITS.metadataRequestsPerExecute, concurrency: number = LIMITS.metadataConcurrency): MetadataBudget {
  let used = 0;
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    take() {
      if (used >= cap) return false;
      used += 1;
      return true;
    },
    async slot(fn) {
      if (active >= concurrency) await new Promise<void>((r) => queue.push(r));
      else active += 1;
      try {
        return await fn();
      } finally {
        const next = queue.shift();
        // Transfer the occupied slot directly; new callers must not steal it
        // before the queued continuation resumes in a later microtask.
        if (next) next();
        else active -= 1;
      }
    },
    used: () => used,
  };
}

export interface SafeFetchPolicy {
  readonly method?: 'HEAD';
  /** Server-owned allowlist for the first hop and every redirect hop. */
  readonly allow: (url: URL) => boolean;
  readonly maxBytes: number;
}

export interface SafeFetchDeps {
  readonly resolve: DnsResolver;
  readonly http: PinnedHttpClient;
  readonly now: () => number;
}

export interface SafeFetchContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  /** Optional durable ticket: every DNS/HTTP start must precede it; an already-started response keeps its own deadline. */
  readonly dispatchBy?: number;
  readonly budget: MetadataBudget;
  /** Optional fresh durable execute authority for the explicitly composed candidate path. */
  readonly authorize?: () => Promise<boolean>;
}

/** Fixed, credential-free headers. `identity` keeps the bounded body the decoded body (no compression to expand). */
export const METADATA_HEADERS = { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'wintr-metadata/0.1' } as const;
const HEADERS = METADATA_HEADERS;

function checkUrl(url: URL, policy: SafeFetchPolicy): boolean {
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '' && policy.allow(url);
}

/** Invokes fn now; a synchronous throw becomes a rejection. */
const invoke = <T>(fn: () => Promise<T>) => new Promise<T>((resolve) => resolve(fn()));

/** Whole-operation cancellation/deadline guard (see header). */
function operationGuard(ctx: SafeFetchContext, now: () => number) {
  const sample = () => {
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) throw new SafeFetchError('deadline');
    return t;
  };
  const startedAt = sample();
  if (!Number.isSafeInteger(ctx.deadlineAt) || ctx.deadlineAt < 0) throw new SafeFetchError('deadline');
  const op = new AbortController();
  const onOuter = () => op.abort();
  ctx.signal.addEventListener('abort', onOuter, { once: true });
  if (ctx.signal.aborted) op.abort();
  const timer = setTimeout(() => op.abort(), Math.max(0, ctx.deadlineAt - startedAt));
  const failure = () => new SafeFetchError(ctx.signal.aborted ? 'aborted' : 'deadline');
  return {
    signal: op.signal,
    /** Re-authorises: throws on Stop or an elapsed deadline, else returns the remaining time. */
    check(): number {
      if (ctx.signal.aborted) throw new SafeFetchError('aborted');
      const remaining = ctx.deadlineAt - sample();
      if (remaining <= 0 || op.signal.aborted) throw new SafeFetchError('deadline');
      return remaining;
    },
    /** Settles with p, or rejects as soon as the operation (or the optional hop signal) is aborted. */
    race<T>(p: Promise<T>, hop?: AbortSignal): Promise<T> {
      p.catch(() => undefined);
      return new Promise<T>((resolve, reject) => {
        if (op.signal.aborted) return reject(failure());
        if (hop?.aborted) return reject(new SafeFetchError('deadline'));
        const onOp = () => reject(failure());
        const onHop = () => reject(new SafeFetchError('deadline'));
        const done = () => {
          op.signal.removeEventListener('abort', onOp);
          hop?.removeEventListener('abort', onHop);
        };
        op.signal.addEventListener('abort', onOp, { once: true });
        hop?.addEventListener('abort', onHop, { once: true });
        p.then(
          (v) => {
            done();
            resolve(v);
          },
          (e: unknown) => {
            done();
            reject(e);
          },
        );
      });
    },
    dispose() {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onOuter);
    },
  };
}

/** GET with manual, validated redirects. Returns the final non-redirect response. */
export async function safeGet(deps: SafeFetchDeps, policy: SafeFetchPolicy, start: URL, ctx: SafeFetchContext): Promise<PinnedResponse & { readonly finalUrl: string; readonly redirects: number }> {
  if (!checkUrl(start, policy)) throw new SafeFetchError('unsafe_redirect');
  const dispatchBy = ctx.dispatchBy;
  if (dispatchBy !== undefined && (!Number.isSafeInteger(dispatchBy) || dispatchBy < 0)) throw new SafeFetchError('deadline');
  const guard = operationGuard(ctx, deps.now);
  const dispatch = new AbortController();
  let dispatchTimer: ReturnType<typeof setTimeout> | undefined;
  const checkDispatch = () => {
    guard.check();
    if (dispatchBy !== undefined) {
      const t = deps.now();
      if (!Number.isSafeInteger(t) || t < 0 || t >= dispatchBy || dispatch.signal.aborted) throw new SafeFetchError('deadline');
    }
  };
  const authorize = ctx.authorize;
  const checkAuthority = async (beforeDispatch: boolean) => {
    guard.check();
    let allowed = false;
    try { allowed = await guard.race(invoke(authorize!), beforeDispatch ? dispatch.signal : undefined); }
    catch (error) { throw error instanceof SafeFetchError ? error : new SafeFetchError('aborted'); }
    guard.check();
    if (!allowed) throw new SafeFetchError('aborted');
  };
  try {
    if (dispatchBy !== undefined) {
      const t = deps.now();
      if (!Number.isSafeInteger(t) || t < 0) throw new SafeFetchError('deadline');
      dispatchTimer = setTimeout(() => dispatch.abort(), Math.min(2 ** 31 - 1, Math.max(0, dispatchBy - t)));
    }
    let url = start;
    for (let hop = 0; ; hop += 1) {
      checkDispatch();
      if (!ctx.budget.take()) throw new SafeFetchError('metadata_cap');
      if (authorize) await checkAuthority(true);
      checkDispatch();
      const host = url.hostname;
      let addresses: readonly string[];
      try {
        addresses = await guard.race(invoke(() => deps.resolve(host)), dispatch.signal);
      } catch (err) {
        if (err instanceof SafeFetchError) throw err;
        throw new SafeFetchError('unreachable');
      }
      // Re-authorise after the lookup: Stop or the deadline during DNS ends here, before any connection.
      if (authorize) await checkAuthority(true);
      const remaining = guard.check();
      // Every resolved address must be public: a mixed answer is treated as hostile.
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new SafeFetchError('unsafe_address');
      const hopControl = new AbortController();
      const stopHop = () => hopControl.abort();
      guard.signal.addEventListener('abort', stopHop, { once: true });
      const timer = setTimeout(stopHop, Math.min(LIMITS.metadataRequestMs, remaining));
      let res: PinnedResponse;
      try {
        const target = url;
        checkDispatch();
        res = await guard.race(
          invoke(() => deps.http({ url: target, address: addresses[0]!, headers: HEADERS, signal: hopControl.signal, maxBytes: policy.maxBytes, ...(policy.method ? { method: policy.method } : {}) })),
          hopControl.signal,
        );
      } catch (err) {
        if (ctx.signal.aborted) throw new SafeFetchError('aborted');
        if (err instanceof SafeFetchError) throw err;
        throw new SafeFetchError(hopControl.signal.aborted ? 'deadline' : 'unreachable');
      } finally {
        clearTimeout(timer);
        guard.signal.removeEventListener('abort', stopHop);
      }
      guard.check();
      if (authorize) await checkAuthority(false);
      if (res.body.byteLength > policy.maxBytes) throw new SafeFetchError('oversize');
      if (res.status < 300 || res.status > 399) return { ...res, finalUrl: url.href, redirects: hop };
      if (hop >= LIMITS.metadataRedirects) throw new SafeFetchError('too_many_redirects');
      let next: URL;
      try {
        next = new URL(res.location ?? '', url);
      } catch {
        throw new SafeFetchError('unsafe_redirect');
      }
      if (!res.location || !checkUrl(next, policy)) throw new SafeFetchError('unsafe_redirect');
      url = next;
    }
  } finally {
    clearTimeout(dispatchTimer);
    guard.dispose();
  }
}

/**
 * Real pinned HTTPS client (live-unverified). The connection's DNS lookup is
 * replaced by the already-validated address; SNI/Host stay the URL hostname.
 * No cookies or credentials; redirects are returned, never followed.
 */
export function createNodePinnedHttpClient(): PinnedHttpClient {
  return (req) =>
    new Promise<PinnedResponse>((resolve, reject) => {
      const family = isIP(req.address);
      const r = httpsRequest(
        {
          host: req.url.hostname,
          servername: req.url.hostname,
          port: 443,
          method: req.method ?? 'GET',
          path: `${req.url.pathname}${req.url.search}`,
          headers: { ...req.headers, host: req.url.hostname },
          signal: req.signal,
          lookup: (_host, opts, cb) => {
            if ((opts as { all?: boolean }).all) cb(null, [{ address: req.address, family }] as never);
            else cb(null, req.address, family);
          },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > req.maxBytes) {
              res.destroy();
              reject(new SafeFetchError('oversize'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              location: typeof res.headers.location === 'string' ? res.headers.location : null,
              body: new Uint8Array(Buffer.concat(chunks)),
            }),
          );
          res.on('error', reject);
        },
      );
      r.on('error', reject);
      r.end();
    });
}
