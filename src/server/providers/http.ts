import { refuseDuplicateKeys } from './json-keys.js';
import type { LiveProtocolFailure } from '../../shared/live-listening.js';
// Provider HTTP seam. Adapters build requests only from fixed allowlisted
// HTTPS origins/paths in code and submit through an injected transport exactly
// once (zero retries). Redirects are never followed (credentials cannot be
// forwarded), bodies are bounded after decompression, time is bounded and the
// caller's abort propagates. Errors carry a kind and status only: no body,
// header, query, prompt or credential content.

export type ProviderName = 'gemini' | 'qloo';
import type { CallObserver } from './observation.js';

export interface ProviderRequest {
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal: AbortSignal;
  /** Maximum decompressed response body bytes the transport may buffer. */
  readonly maxResponseBytes: number;
  /** Server-only call-local observer; the actual transport marks entry after its guards. */
  readonly observer?: CallObserver;
}

export interface ProviderResponse {
  readonly status: number;
  readonly contentType: string | null;
  /** Decompressed body. */
  readonly body: Uint8Array;
}

export type HttpTransport = (request: ProviderRequest) => Promise<ProviderResponse>;

export type ProviderFailure =
  | LiveProtocolFailure
  | 'config'
  | 'aborted'
  | 'deadline'
  | 'transport'
  | 'redirect'
  | 'oversize'
  | 'auth'
  | 'quota'
  | 'unsupported'
  | 'http_status'
  | 'malformed'
  | 'schema'
  | 'incomplete'
  | 'refused';

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly kind: ProviderFailure,
    /** True once the transport was invoked: the provider may have accepted (and charged for) the work. */
    readonly dispatched: boolean,
    readonly status: number | null = null,
  ) {
    super(`${provider}:${kind}${status === null ? '' : `:${status}`}`);
    this.name = 'ProviderError';
  }
}

/** Thrown by a transport when the decompressed body exceeds the bound. */
export class ResponseTooLarge extends Error {}

export interface Endpoint {
  readonly origin: string;
  readonly path: string;
}

/**
 * Value-free, closed classification of a provider's own refusal to serve work this app dispatched: HTTP 429 means the
 * service limited the request, HTTP 503 that it was temporarily unavailable. Nothing else is inferred (no quota
 * exhaustion, payment need or retry time), and every other failure keeps its existing handling (null).
 */
export function providerServiceCause(err: unknown): 'provider_limited' | 'provider_unavailable' | null {
  if (!(err instanceof ProviderError) || !err.dispatched) return null;
  if (err.status === 429) return 'provider_limited';
  if (err.status === 503) return 'provider_unavailable';
  return null;
}

export function classifyStatus(status: number): ProviderFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  if (status === 400 || status === 404 || status === 422) return 'unsupported';
  return 'http_status';
}

export interface SendOnceOptions {
  readonly provider: ProviderName;
  readonly transport: HttpTransport;
  readonly endpoint: Endpoint;
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal: AbortSignal;
  readonly observer?: CallObserver;
  /** Bounded accounting decode only, including a late response that lost the abort race. */
  readonly onResponse?: (response: ProviderResponse) => void;
}

/** Exactly one transport invocation, raced against the caller's abort and a deadline. */
export async function sendOnce(o: SendOnceOptions): Promise<ProviderResponse> {
  const fail = (kind: ProviderFailure, dispatched: boolean, status: number | null = null) =>
    new ProviderError(o.provider, kind, dispatched, status);
  const u = o.url;
  if (
    u.protocol !== 'https:' ||
    u.origin !== o.endpoint.origin ||
    u.pathname !== o.endpoint.path ||
    u.username !== '' ||
    u.password !== '' ||
    u.port !== '' ||
    u.hash !== ''
  ) {
    throw fail('config', false);
  }
  if (o.signal.aborted) throw fail('aborted', false);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('deadline'), o.timeoutMs);
  const onOuterAbort = () => controller.abort('aborted');
  o.signal.addEventListener('abort', onOuterAbort, { once: true });
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});

  try {
    let pending: Promise<ProviderResponse>;
    o.observer?.transportPending();
    try {
      pending = Promise.resolve(
        o.transport({
          method: o.method,
          url: u,
          headers: o.headers,
          body: o.body,
          signal: controller.signal,
          maxResponseBytes: o.maxResponseBytes,
          observer: o.observer,
        }),
      );
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending = pending.then((res) => {
      const valid = Number.isSafeInteger(res.status) && res.status >= 100 && res.status <= 599 && res.body instanceof Uint8Array && res.body.byteLength <= o.maxResponseBytes;
      o.observer?.transportFinished(valid ? res.status : null);
      if (valid) o.onResponse?.(res);
      return res;
    }, (error: unknown) => { o.observer?.transportFinished(null); throw error; });
    pending.catch(() => {});
    let res: ProviderResponse;
    try {
      res = await Promise.race([pending, aborted]);
    } catch (err) {
      if (controller.signal.aborted) throw fail(controller.signal.reason === 'deadline' ? 'deadline' : 'aborted', true);
      throw fail(err instanceof ResponseTooLarge ? 'oversize' : 'transport', true);
    }
    if (!Number.isInteger(res.status) || !(res.body instanceof Uint8Array)) throw fail('transport', true);
    if (res.body.byteLength > o.maxResponseBytes) throw fail('oversize', true);
    if (res.status >= 300 && res.status < 400) throw fail('redirect', true, res.status);
    return res;
  } finally {
    clearTimeout(timer);
    o.signal.removeEventListener('abort', onOuterAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

/** Strict UTF-8 JSON decode of a bounded body; ambiguous duplicate fields are refused. */
export function decodeJson(provider: ProviderName, body: Uint8Array): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const value: unknown = JSON.parse(text);
    refuseDuplicateKeys(text, () => new ProviderError(provider, 'malformed', true));
    return value;
  } catch {
    throw new ProviderError(provider, 'malformed', true);
  }
}

/**
 * Real fetch-based transport (live-unverified against providers). Only the
 * listed origins are reachable, redirects are returned rather than followed,
 * and the decompressed stream is cut off at the bound.
 */
export function createFetchTransport(allowedOrigins: readonly string[]): HttpTransport {
  const allowed = new Set(allowedOrigins);
  return async (req) => {
    if (!allowed.has(req.url.origin)) throw new Error('origin not allowed');
    req.observer?.transportStarted();
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
      redirect: 'manual',
      credentials: 'omit',
    });
    const contentType = res.headers.get('content-type');
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, contentType, body: new Uint8Array() };
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (res.headers.get('content-encoding') === null && declared > req.maxResponseBytes) {
      await res.body?.cancel().catch(() => {});
      throw new ResponseTooLarge();
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > req.maxResponseBytes) {
          await reader.cancel().catch(() => {});
          throw new ResponseTooLarge();
        }
        chunks.push(value);
      }
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.byteLength;
    }
    return { status: res.status, contentType, body };
  };
}
