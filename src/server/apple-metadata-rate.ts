import { createHash } from 'node:crypto';
import type { DocData, DocPath, DocStore } from './persistence/docstore.js';

// Explicit service-level rate admission for Apple's public metadata
// routes (search AND ID lookup). See docs/decisions/APPLE_CATALOGUE_SEARCH_PREPARATION.md.
// - One shared row in the existing wintr_service_limits collection, addressed by
//   an opaque hash of the service namespace. It stores only the schema, an opaque
//   scope tag, the last observed clock and up to 18 integer admission times; never
//   a listener, artist, track or query value.
// - At most 18 admissions are retained per 65 s (the 60 s service window plus the 5 s
//   admission-to-send lag) across instances and restarts, and an admission is a
//   dispatch ticket that expires after 5 s, so at most 18 requests start in any 60 s
//   interval, conservatively below Apple's documented approximately 20 per minute.
// - The transaction callback only reads through tx, samples the injected clock
//   and signal, computes and writes. It performs no I/O of its own, so a database
//   re-run (with a fresh clock sample) can never repeat network activity.
// - Admissions are never refunded: a later failure, Stop, expiry or Clear leaves
//   the spent admission in place. Corrupt, unknown, future or unreadable state
//   refuses and is never reset.
// - No automatic waiting, retry or workaround: a refusal is typed and final.
// - Nothing happens at construction or import.

/**
 * A request must start within `dispatchLagMs` of its committed admission, and an
 * admission is retained for `retainMs` (the 60 s service window plus that lag), so
 * at most 18 requests can start in any 60 s interval even when a grant is delayed.
 */
export const APPLE_METADATA_RATE = Object.freeze({ schema: 1, windowMs: 60_000, dispatchLagMs: 5_000, retainMs: 65_000, maxAdmitted: 18 });
export const APPLE_DISPATCH_LAG_MS = APPLE_METADATA_RATE.dispatchLagMs;

export type AppleRateRefusal =
  | 'invalid_context'
  | 'aborted'
  | 'deadline'
  | 'scope_expired'
  | 'binding_expired'
  | 'clock_invalid'
  | 'clock_regressed'
  | 'dispatch_expired'
  | 'rate_limited'
  | 'state_invalid'
  | 'store_unavailable';

/**
 * Bounded dispatch ticket: the committed admission time and the absolute time at
 * or after which the admitted request must not start (DNS or HTTP):
 * min(at + 5000, binding expiry, scope expiry, execute deadline).
 */
export type AppleRateAdmission = { readonly admitted: true; readonly at: number; readonly dispatchBy: number } | { readonly admitted: false; readonly reason: AppleRateRefusal };

export interface AppleRateContext {
  readonly signal: AbortSignal;
  /** Execute deadline (absolute ms). */
  readonly deadlineAt: number;
  /** Session/Journey scope expiry (absolute ms). */
  readonly scopeExpiresAt: number;
}

export interface AppleMetadataRateGate {
  /** Immutable binding expiry captured at construction (absolute ms). */
  readonly bindingExpiresAt: number;
  /** Durably admits exactly one Apple metadata request, or refuses. The caller dispatches only on `admitted: true` and only after re-authorising. */
  admit(ctx: AppleRateContext): Promise<AppleRateAdmission>;
}

export interface AppleMetadataRateGateOptions {
  readonly docs: DocStore;
  /** Symbolic service namespace (the live binding's service ID shape). */
  readonly serviceId: string;
  /** Fixed binding expiry (absolute ms): no admission at or after it. */
  readonly expiresAt: number;
  readonly clock: () => number;
}

const SERVICE_ID = /^[a-z][a-z0-9-]{2,62}$/;
const hex = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const MAX_TIMER_MS = 2 ** 31 - 1;
const KEYS = 'lastSeen,schema,scope,timestamps';

interface State {
  readonly timestamps: readonly number[];
  readonly lastSeen: number;
}

/** Strict decoding of the stored row; anything else is invalid and never reinterpreted. */
function decode(raw: DocData | null, scope: string): State | 'invalid' {
  if (raw === null) return { timestamps: [], lastSeen: 0 };
  if (Object.keys(raw).sort().join() !== KEYS || raw.schema !== APPLE_METADATA_RATE.schema || raw.scope !== scope) return 'invalid';
  const { timestamps, lastSeen } = raw;
  if (!Array.isArray(timestamps) || timestamps.length > APPLE_METADATA_RATE.maxAdmitted || !isTime(lastSeen)) return 'invalid';
  const stamps: number[] = [];
  for (const t of timestamps) {
    if (!isTime(t) || t > lastSeen || (stamps.length > 0 && t < stamps[stamps.length - 1]!)) return 'invalid';
    stamps.push(t);
  }
  return { timestamps: stamps, lastSeen };
}

export function createAppleMetadataRateGate(opts: AppleMetadataRateGateOptions): AppleMetadataRateGate {
  const { docs, serviceId, expiresAt, clock } = opts;
  if (typeof serviceId !== 'string' || !SERVICE_ID.test(serviceId)) throw new RangeError('invalid service id');
  if (!isTime(expiresAt)) throw new RangeError('invalid expiry');
  if (typeof clock !== 'function' || typeof docs?.transact !== 'function') throw new TypeError('invalid gate dependencies');
  const path: DocPath = { collection: 'wintr_service_limits', id: `apple_md_${hex(`${serviceId}|apple_metadata_rate|doc`, 48)}` };
  const scope = hex(`${serviceId}|apple_metadata_rate|scope`, 32);
  const refuse = (reason: AppleRateRefusal): AppleRateAdmission => ({ admitted: false, reason });
  const read = (): number | null => {
    try {
      const t = clock();
      return isTime(t) ? t : null;
    } catch {
      return null;
    }
  };

  const gate: AppleMetadataRateGate = {
    bindingExpiresAt: expiresAt,
    async admit(raw) {
      // Capture scalars before the first await; later caller mutation changes nothing.
      let signal: AbortSignal;
      let deadlineAt: number;
      let scopeExpiresAt: number;
      try {
        signal = raw.signal;
        deadlineAt = raw.deadlineAt;
        scopeExpiresAt = raw.scopeExpiresAt;
        if (!(signal instanceof AbortSignal) || !isTime(deadlineAt) || !isTime(scopeExpiresAt)) return refuse('invalid_context');
      } catch {
        return refuse('invalid_context');
      }
      const verdict = (t: number | null): AppleRateRefusal | null => {
        if (signal.aborted) return 'aborted';
        if (t === null) return 'clock_invalid';
        if (t >= expiresAt) return 'binding_expired';
        if (t >= deadlineAt) return 'deadline';
        if (t >= scopeExpiresAt) return 'scope_expired';
        return null;
      };
      const start = read();
      const before = verdict(start);
      if (before) return refuse(before);

      let onAbort: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<AppleRateAdmission>((resolve) => {
        onAbort = () => resolve(refuse('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => resolve(refuse(verdict(read()) ?? 'deadline')), Math.min(MAX_TIMER_MS, Math.max(0, Math.min(deadlineAt, scopeExpiresAt, expiresAt) - start!)));
      });
      const work = (async () =>
        docs.transact<AppleRateAdmission>(async (tx) => {
          const [row] = await tx.getAll([path]);
          // Fresh sample after the read, on every database re-run.
          const t = read();
          const stop = verdict(t);
          if (stop) return refuse(stop);
          // The call's own start is a clock floor on every database attempt.
          if (t! < start!) return refuse('clock_regressed');
          const state = decode(row ?? null, scope);
          if (state === 'invalid') return refuse('state_invalid');
          if (state.lastSeen > t!) return refuse('clock_regressed');
          const live = state.timestamps.filter((s) => t! - s < APPLE_METADATA_RATE.retainMs);
          if (live.length >= APPLE_METADATA_RATE.maxAdmitted) return refuse('rate_limited');
          tx.set(path, { schema: APPLE_METADATA_RATE.schema, scope, timestamps: [...live, t!], lastSeen: t! });
          return { admitted: true, at: t!, dispatchBy: Math.min(t! + APPLE_METADATA_RATE.dispatchLagMs, expiresAt, scopeExpiresAt, deadlineAt) };
        }))().catch(() => refuse('store_unavailable'));
      try {
        const outcome = await Promise.race([work, guard]);
        if (!outcome.admitted) return outcome;
        // A commit that finished after Stop/expiry/clock regression/ticket lapse stays
        // spent (never reset or refunded) but authorises nothing.
        const after = read();
        const stop = verdict(after);
        if (stop) return refuse(stop);
        if (after! < Math.max(start!, outcome.at)) return refuse('clock_regressed');
        return after! >= outcome.dispatchBy ? refuse('dispatch_expired') : outcome;
      } finally {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    },
  };
  return Object.freeze(gate);
}
