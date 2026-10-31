import type { ErrorCode, Familiarity, Fit, Focus, Handle, SafeSnapshot } from '../shared/records.js';
import { isErrorCode, isSafeSnapshot } from './snapshot-validation.js';
import { LIMITS } from '../shared/records.js';
import type { LiveMusicCapture } from './live-music-capture.js';
import { streamLiveReference } from './live-transport.js';

// Receive-side timing is not DTO content or server authority. Replayed old
// projections must not gain a fresh lifetime merely from a later body read.
const snapshotDeadlines = new WeakMap<SafeSnapshot, number>();
export function snapshotRemainingMs(snapshot: SafeSnapshot): number | null {
  const deadline = snapshotDeadlines.get(snapshot);
  return deadline === undefined ? null : Math.max(0, deadline - performance.now());
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'internal' | 'network' | 'aborted' | 'timeout' | 'unconfirmed',
    readonly detail: string | null,
  ) {
    super(code);
  }
}

/**
 * Deadline for free control and read requests (session setup, state reads,
 * saves, Stop, Clear), covering BOTH the response and reading its body. Paid
 * executes keep the server's own execute deadline and are not bounded here.
 */
export const CONTROL_TIMEOUT_MS = 15_000;

export interface TransportDeps {
  readonly fetch: typeof fetch;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (t: unknown) => void;
  readonly controlTimeoutMs: number;
}

const BROWSER: TransportDeps = {
  fetch: (...a) => globalThis.fetch(...a),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
  controlTimeoutMs: CONTROL_TIMEOUT_MS,
};

/**
 * One request. With `bounded`, a single deadline covers the fetch and the body
 * read: on expiry the transport is aborted and the wait ends with a retryable
 * 'timeout' error even if the underlying promise never settles. Never retries.
 */
async function call(deps: TransportDeps, method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, signal: AbortSignal | undefined, bounded: boolean): Promise<SafeSnapshot> {
  const startedAt = performance.now();
  const transport = new AbortController();
  const onAbort = () => transport.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) transport.abort();
  let timer: unknown = null;
  const deadline = bounded
    ? new Promise<never>((_, reject) => {
        timer = deps.setTimeout(() => {
          // Claim the deadline first: real fetch/body aborts can reject synchronously and otherwise look like a network error.
          reject(new ApiError(0, 'timeout', null));
          transport.abort();
        }, deps.controlTimeoutMs);
      })
    : null;
  const within = <T>(p: Promise<T>): Promise<T> => (deadline ? Promise.race([p, deadline]) : p);
  try {
    let res: Response;
    try {
      res = await within(
        deps.fetch(path, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: transport.signal,
        }),
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, signal?.aborted ? 'aborted' : 'network', null);
    }
    let data: unknown = null;
    try {
      const raw = await within(res.text());
      if (raw.length > 12 * 1024 * 1024) throw new ApiError(res.status, method === 'DELETE' ? 'unconfirmed' : 'network', null);
      data = JSON.parse(raw);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (signal?.aborted) throw new ApiError(0, 'aborted', null);
      // An unreadable or unparsable body is never a confirmation.
      if (res.ok) throw new ApiError(res.status, 'network', null);
    }
    if (!res.ok) {
      const err = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
      throw new ApiError(res.status, isErrorCode(err.error) ? err.error : 'internal',
        typeof err.message === 'string' && err.message.length <= 2000 ? err.message : null);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ApiError(res.status, 'network', null);
    if (!isSafeSnapshot(data)) throw new ApiError(res.status, method === 'DELETE' ? 'unconfirmed' : 'network', null);
    if (data.session?.checkedAt !== undefined) {
      const receivedAt = performance.now();
      const elapsed = receivedAt - startedAt;
      const remaining = Math.max(0, Math.min(LIMITS.sessionLifetimeMs, data.session.expiresAt - data.session.checkedAt) - elapsed);
      snapshotDeadlines.set(data, Number.isFinite(elapsed) && elapsed >= 0 ? receivedAt + remaining : receivedAt);
    }
    return data;
  } finally {
    if (timer !== null) deps.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface ReferenceRequest {
  readonly url: string;
  readonly focus: Focus;
  readonly cue: string | null;
  readonly actionKey: string;
}

export type StopTarget = { readonly actionKey: string } | { readonly attempt: Handle };
export type ChatRequest = ({ readonly kind: 'create' } | { readonly kind: 'rename'; readonly chat: Handle; readonly title: string; readonly expectedRevision: number } | { readonly kind: 'delete'; readonly chat: Handle; readonly expectedRevision: number }) & { readonly actionKey: string };

/** What the listener chose; the controller adds the free action key and optimistic guard. */
export interface PreferenceInput {
  /** One deliberate Live-only discovery uses the first model relationship, not a listener vote. */
  readonly automatic?: true;
  readonly analysis: Handle;
  readonly relationship: { readonly choice: number } | { readonly text: string };
  readonly artists: readonly string[];
}

export interface PreferenceRequest extends PreferenceInput {
  readonly actionKey: string;
  /** The confirmed version this edit is based on (null before the first save). */
  readonly expectedBrief: Handle | null;
}

export interface ArtistChoiceInput {
  readonly checkpoint: Handle;
  readonly slot: number;
  /** Null skips this artist. */
  readonly choice: Handle | null;
}

export interface ArtistChoiceRequest extends ArtistChoiceInput {
  readonly actionKey: string;
  /** The checkpoint revision this choice is based on. */
  readonly expectedRevision: number;
}

/** Independent fit and familiarity for one exact displayed choice of one owned panel. */
export interface FeedbackInput {
  readonly panel: Handle;
  readonly choice: Handle;
  readonly fit: Fit;
  readonly familiarity: Familiarity;
}

export interface FeedbackRequest extends FeedbackInput {
  readonly actionKey: string;
  /** The feedback revision this change is based on. */
  readonly expectedRevision: number;
}

/** The one explicit refinement: follow a liked connection, or correct the direction over the reused connections. */
export type RefineInput =
  | { readonly mode: 'follow_connection'; readonly panel: Handle; readonly brief: Handle; readonly choice: Handle }
  | {
      readonly mode: 'correct_direction';
      readonly panel: Handle;
      readonly brief: Handle;
      readonly relationship?: { readonly text: string };
      readonly excludeArtists?: readonly Handle[];
    };

export interface ApiPort {
  liveReference?(input: { readonly actionKey: string; readonly cue: string | null }, capture: LiveMusicCapture, signal: AbortSignal): Promise<SafeSnapshot>;
  registerCapture?(input: { readonly actionKey: string; readonly sha256: string; readonly frames: number }, signal: AbortSignal): Promise<SafeSnapshot>;
  recordingReference?(input: { readonly actionKey: string; readonly receipt: Handle; readonly audio: string; readonly cue: string | null }, signal: AbortSignal): Promise<SafeSnapshot>;
  selectChat?(chat: Handle | null): void;
  readChat?(chat: Handle | null): Promise<SafeSnapshot>;
  changeChat?(input: ChatRequest): Promise<SafeSnapshot>;
  state(): Promise<SafeSnapshot>;
  createSession(): Promise<SafeSnapshot>;
  reference(input: ReferenceRequest, signal: AbortSignal): Promise<SafeSnapshot>;
  preference(input: PreferenceRequest): Promise<SafeSnapshot>;
  artistChoice(input: ArtistChoiceRequest): Promise<SafeSnapshot>;
  feedback(input: FeedbackRequest): Promise<SafeSnapshot>;
  discover(input: { readonly brief: Handle; readonly actionKey: string }, signal: AbortSignal): Promise<SafeSnapshot>;
  refine(input: RefineInput & { readonly actionKey: string }, signal: AbortSignal): Promise<SafeSnapshot>;
  stop(target: StopTarget): Promise<SafeSnapshot>;
  clear(): Promise<SafeSnapshot>;
}

const MODES = new Set(['disabled', 'synthetic', 'live']);

/**
 * The only reply that confirms a Clear: the server's exact revoked-session
 * snapshot (no session and nothing private). A partial, array, error-shaped or
 * session-bearing body is never a confirmation.
 */
export function isRevokedSessionAck(v: unknown): v is SafeSnapshot {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.mode === 'string' &&
    MODES.has(s.mode) &&
    s.session === null &&
    s.stage === 'idle' &&
    s.revision === 0 &&
    s.status === null &&
    s.attempt === null &&
    s.reference === null &&
    s.listenerCue === null &&
    s.analysis === null &&
    s.brief === null &&
    s.identity === null &&
    s.connection === null &&
    s.panel === null &&
    Array.isArray(s.history) &&
    s.history.length === 0 &&
    s.refinement === null &&
    !('error' in s)
  );
}

/** The page's API. Free control/read calls are bounded (fetch and body); paid executes are not. */
export function createApi(deps: TransportDeps = BROWSER): ApiPort {
  let selected: Handle | null = null;
  const pathFor = (path: string, chat: Handle | null) => chat ? `${path}?chat=${encodeURIComponent(chat)}` : path;
  // Capture selection synchronously when each request starts. A later click
  // cannot retarget a request, its Stop, or the response already on the wire.
  const free = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, chat = selected) => call(deps, method, pathFor(path, chat), body, undefined, true);
  const paid = (path: string, body: unknown, signal: AbortSignal) => call(deps, 'POST', pathFor(path, selected), body, signal, false);
  return {
    selectChat: chat => { selected = chat; },
    readChat: chat => free('GET', '/api/state', undefined, chat),
    changeChat: input => free('POST', '/api/chats', input, null),
    state: () => free('GET', '/api/state'),
    createSession: () => free('POST', '/api/session', {}, null),
    reference: (input, signal) => paid('/api/reference', input, signal),
    registerCapture: (input, signal) => call(deps, 'POST', pathFor('/api/capture', selected), input, signal, true),
    recordingReference: (input, signal) => paid('/api/recording-reference', input, signal),
    liveReference: async (input, capture, signal) => {
      const chat = selected;
      await streamLiveReference(pathFor('/api/live-reference', chat), input, capture, signal);
      return call(deps, 'GET', pathFor('/api/state', chat), undefined, signal, true);
    },
    preference: (input) => free('POST', '/api/preference', input),
    artistChoice: (input) => free('POST', '/api/artist-choice', input),
    feedback: (input) => free('POST', '/api/feedback', input),
    discover: (input, signal) => paid('/api/discover', input, signal),
    refine: (input, signal) => paid('/api/refine', input, signal),
    stop: (target) => free('POST', '/api/stop', target),
    clear: async () => {
      const reply = await free('DELETE', '/api/session', undefined, null);
      if (!isRevokedSessionAck(reply)) throw new ApiError(200, 'unconfirmed', null);
      return reply;
    },
  };
}

export const api: ApiPort = createApi();

const MESSAGES: Partial<Record<ApiError['code'], string>> = {
  network: 'Can’t connect to Wintr. Open Wintr again.',
  timeout: 'Wintr did not get an answer in time, so nothing was confirmed. Try again.',
  unconfirmed: "The server's reply did not confirm it, so nothing is assumed. Try again.",
  providers_disabled: 'Analysis is unavailable right now.',
  session_expired: 'Your session ended. Start a new chat.',
  no_session: 'Start a new chat to continue.',
  operation_active: 'Something is already running. Stop it first or wait for it to finish.',
  action_conflict: 'That request changed while it was being sent. Try again.',
  stale_operation: 'That request belongs to an earlier reference, so nothing was repeated.',
  cancelled: 'Stopped before anything was sent. Nothing was added.',
  stale_version: 'That choice is out of date. Review the latest version and try again.',
  not_ready: 'Choose or skip each artist before continuing.',
  discovery_used: 'This reference has used its discovery allowance.',
  discovery_correction_required: 'Change the starting artists before discovering again.',
  discovery_retry_unavailable: 'This discovery cannot be sent again. You can still edit your choice or clear this session.',
  refinement_used: 'This reference has already used its one refined search.',
  feedback_required: 'Like a song to follow its artist.',
  pool_empty: 'That would leave no connected artists, so nothing was started.',
  rate_limited: 'Too many changes in a short time. Wait a moment and try again.',
  capacity: 'This connection has reached its limit.',
  bad_origin: 'This request did not come from the Wintr page, so it was refused.',
  bad_host: 'Open Wintr from its desktop icon.',
  body_too_large: 'That request was too large.',
};

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? MESSAGES[err.code] ?? 'Something went wrong. Nothing further was started.';
  return 'Something went wrong. Nothing further was started.';
}
