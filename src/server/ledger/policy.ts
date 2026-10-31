import type { ProviderKind, SubmissionStage } from '../../shared/records.js';
import { DISPATCH_CAPS } from '../../shared/records.js';

// Exposure/count admission policy (O03, D03). It is always injected by the
// controller binding and strictly validated; this module contains no prices.
// Money is integer minor units of one declared currency. A reservation is
// either an enforceable bound or an estimate with explicitly approved residual
// provider-cost uncertainty; the ledger records which. Each Journey and legacy
// session retains the first-pair count ceiling. An explicit controller-owned
// shared-chat session may use its approved service allowance across Journeys;
// it cannot raise that service ceiling or any individual Journey's bounds.

export const STAGES = ['reference_analysis', 'qloo_search', 'qloo_artist_insights', 'qloo_tag_insights', 'catalogue_generation'] as const satisfies readonly SubmissionStage[];
export type StageKey = SubmissionStage;

export const STAGE_PROVIDER: Readonly<Record<StageKey, ProviderKind>> = {
  reference_analysis: 'gemini',
  qloo_search: 'qloo',
  qloo_artist_insights: 'qloo',
  qloo_tag_insights: 'qloo',
  catalogue_generation: 'gemini',
};

export type ReservationBound = 'enforceable' | 'estimate_with_residual';

export interface ScopeLimits {
  /** Integer minor units that may be held (reserved + unknown + settled) in this scope. */
  readonly capUnits: number;
  readonly counts: Readonly<Record<ProviderKind, number>>;
}

export interface ExposurePolicy {
  readonly sessionMode?: 'shared_chats';
  /** Opaque controller policy identifier, recorded on every reservation. */
  readonly version: string;
  /** ISO-4217-style code; tests use the reserved testing code XTS. */
  readonly currency: string;
  /** Policy is refused at and after this instant (fail closed). */
  readonly expiresAt: number;
  readonly service: ScopeLimits & { readonly concurrency: number };
  readonly session: ScopeLimits;
  readonly journey: ScopeLimits;
  /** Conservative per-submission reservation for each stage, in minor units. */
  readonly reservations: Readonly<Record<StageKey, { readonly units: number; readonly bound: ReservationBound }>>;
}

export class PolicyError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function exactKeys(v: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (!isRecord(v)) throw new PolicyError(`${where}: expected an object`);
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) throw new PolicyError(`${where}: unexpected or missing fields`);
  return v;
}

/** Positive (or non-negative) safe integer; rejects strings, fractions, NaN, Infinity and overflow. */
export function safeUnits(v: unknown, where: string, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw new PolicyError(`${where}: expected an integer in [${min}, ${max}]`);
  return v;
}

function counts(v: unknown, where: string, ceiling?: Readonly<Record<ProviderKind, number>>): Record<ProviderKind, number> {
  const o = exactKeys(v, ['qloo', 'gemini'], where);
  return {
    qloo: safeUnits(o.qloo, `${where}.qloo`, { min: 0, max: ceiling?.qloo ?? 1_000_000 }),
    gemini: safeUnits(o.gemini, `${where}.gemini`, { min: 0, max: ceiling?.gemini ?? 1_000_000 }),
  };
}

function limits(v: unknown, where: string, ceiling?: Readonly<Record<ProviderKind, number>>): ScopeLimits {
  const o = exactKeys(v, ['capUnits', 'counts'], where);
  return { capUnits: safeUnits(o.capUnits, `${where}.capUnits`), counts: counts(o.counts, `${where}.counts`, ceiling) };
}

/** Strict parse; any missing, extra or malformed field throws (callers fail closed). */
export function parseExposurePolicy(raw: unknown): ExposurePolicy {
  const mode = isRecord(raw) ? Object.getOwnPropertyDescriptor(raw, 'sessionMode') : undefined;
  if (mode && (!Object.hasOwn(mode, 'value') || mode.value !== 'shared_chats')) throw new PolicyError('policy.sessionMode: invalid');
  const o = exactKeys(raw, ['version', 'currency', 'expiresAt', 'service', 'session', 'journey', 'reservations', ...(mode ? ['sessionMode'] : [])], 'policy');
  if (typeof o.version !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(o.version)) throw new PolicyError('policy.version: invalid');
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) throw new PolicyError('policy.currency: invalid');
  const expiresAt = safeUnits(o.expiresAt, 'policy.expiresAt');
  const s = exactKeys(o.service, ['capUnits', 'counts', 'concurrency'], 'policy.service');
  const service = { ...limits({ capUnits: s.capUnits, counts: s.counts }, 'policy.service'), concurrency: safeUnits(s.concurrency, 'policy.service.concurrency', { max: 10_000 }) };
  const session = limits(o.session, 'policy.session', mode ? service.counts : DISPATCH_CAPS);
  if (mode && session.capUnits > service.capUnits) throw new PolicyError('policy.session.capUnits: above service');
  const journey = limits(o.journey, 'policy.journey', DISPATCH_CAPS);
  const r = exactKeys(o.reservations, STAGES, 'policy.reservations');
  const reservations = Object.fromEntries(
    STAGES.map((stage) => {
      const e = exactKeys(r[stage], ['units', 'bound'], `policy.reservations.${stage}`);
      if (e.bound !== 'enforceable' && e.bound !== 'estimate_with_residual') throw new PolicyError(`policy.reservations.${stage}.bound: invalid`);
      // A reservation larger than the narrowest cap could never be admitted: a malformed policy, not a silent refusal.
      const units = safeUnits(e.units, `policy.reservations.${stage}.units`, { max: Math.min(service.capUnits, session.capUnits, journey.capUnits) });
      return [stage, { units, bound: e.bound }];
    }),
  ) as ExposurePolicy['reservations'];
  return Object.freeze({ version: o.version, currency: o.currency, expiresAt, service, session, journey, reservations, ...(mode ? { sessionMode: 'shared_chats' as const } : {}) });
}
