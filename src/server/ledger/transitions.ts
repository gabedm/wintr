import type { ProviderKind } from '../../shared/records.js';
import type { DocData } from '../persistence/docstore.js';
import { STAGE_PROVIDER, STAGES, type ExposurePolicy, type ReservationBound, type StageKey } from './policy.js';
import { mergeObservation, parseObservation, type SubmissionObservation } from './observation.js';
import { canonicalJson } from '../seal.js';

// Pure, deterministic ledger transitions. Given the documents read inside one
// transaction they return either a refusal or the complete set of documents to
// write. No I/O, no clock, no randomness: safe to re-run on transaction retry.
//
// Reservation states:
//   reserved  -> counted and held; the adapter has NOT been invoked.
//   intent    -> durable dispatch intent recorded; the network may be touched.
//                A crash here leaves the reservation held (money, counts and
//                the concurrency slot) until an explicit reconciliation.
//   unknown   -> the local request ended without a typed receipt (timeout,
//                failure, cancellation, unusable output, abandoned after
//                restart). Money and counts stay held; only the in-flight
//                concurrency slot is released.
//   settled   -> a typed, validated receipt fixed the actual units.
//   withdrawn -> released, only from `reserved` with proof that intent was
//                never recorded (so no invocation can have happened).

export type ReservationState = 'reserved' | 'intent' | 'unknown' | 'settled' | 'withdrawn';
export const UNRESOLVED_STATES: readonly ReservationState[] = ['reserved', 'intent', 'unknown'];
export const UNKNOWN_REASONS = ['transport_returned_without_receipt', 'timeout', 'cancelled', 'failed', 'output_unusable', 'abandoned_after_restart'] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export interface Counts {
  readonly qloo: number;
  readonly gemini: number;
}

export interface ServiceDoc {
  readonly schema: 1;
  readonly kind: 'service';
  readonly currency: string;
  /** Admitted submissions; only a proven withdrawal decrements. */
  readonly counts: Counts;
  /** reserved + intent + unknown reservation units, plus settled actual units. */
  readonly unitsHeld: number;
  /** reserved + intent (in flight). */
  readonly active: number;
  /** reserved + intent + unknown. */
  readonly unresolved: number;
  readonly updatedAt: number;
}

export interface ScopeDoc {
  readonly schema: 1;
  readonly kind: 'scope';
  readonly scope: 'session' | 'journey';
  readonly counts: Counts;
  readonly unitsHeld: number;
  readonly updatedAt: number;
}

export interface Settlement {
  readonly kind: 'provider_usage' | 'controller_reconciliation';
  readonly units: number;
  readonly reference: string;
  readonly issuedAt: number;
  /** Actual units above the reservation (recorded, never hidden). */
  readonly overrunUnits: number;
}

export interface ReservationDoc {
  readonly schema: 2;
  readonly kind: 'reservation';
  readonly service: string;
  readonly state: ReservationState;
  readonly provider: ProviderKind;
  readonly stage: StageKey;
  readonly units: number;
  readonly bound: ReservationBound;
  readonly currency: string;
  readonly policyVersion: string;
  readonly inputHash: string;
  readonly sessionScope: string;
  readonly journeyScope: string;
  readonly attemptRef: string;
  readonly createdAt: number;
  readonly intentAt: number | null;
  readonly resolvedAt: number | null;
  readonly unknownReason: UnknownReason | null;
  readonly settlement: Settlement | null;
  readonly withdrawal: { readonly proof: 'intent_never_recorded' } | null;
  readonly observation: SubmissionObservation | null;
}

/** A typed receipt from the controller or a provider usage record; the only way to fix actual units. */
export interface SettlementReceipt {
  readonly kind: 'provider_usage' | 'controller_reconciliation';
  readonly currency: string;
  readonly units: number;
  readonly reference: string;
  readonly issuedAt: number;
}

export class LedgerCorrupt extends Error {}
export class LedgerOverflow extends Error {}

export type Refusal =
  | 'policy_expired'
  | 'policy_mismatch'
  /** Intent already recorded (by this or another instance): an observation, never a send grant. */
  | 'intent_exists'
  | 'conflict'
  | 'not_found'
  | 'invalid_state'
  | 'concurrency'
  | 'capacity_service_count'
  | 'capacity_service_units'
  | 'capacity_session_count'
  | 'capacity_session_units'
  | 'capacity_journey_count'
  | 'capacity_journey_units'
  | 'invalid_receipt';

export interface Writes {
  readonly reservation?: { readonly doc: ReservationDoc; readonly create: boolean };
  readonly service?: ServiceDoc;
  readonly session?: ScopeDoc;
  readonly journey?: ScopeDoc;
}

export type Plan = { readonly ok: true; readonly reservation: ReservationDoc; readonly replay: boolean; readonly writes: Writes } | { readonly ok: false; readonly code: Refusal };

// ---------------------------------------------------------------------------
// Overflow-checked arithmetic.

/** a + b as a non-negative safe integer, or LedgerOverflow (fail closed). */
export function add(a: number, b: number): number {
  const r = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(r) || r < 0) throw new LedgerOverflow('ledger arithmetic out of range');
  return r;
}

const bump = (c: Counts, p: ProviderKind, by: number): Counts => ({ ...c, [p]: add(c[p], by) });

// ---------------------------------------------------------------------------
// Strict parsing of stored documents (malformed => LedgerCorrupt, fail closed).

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new LedgerCorrupt('stored integer invalid');
  return v;
};
const str = (v: unknown, re: RegExp): string => {
  if (typeof v !== 'string' || !re.test(v)) throw new LedgerCorrupt('stored string invalid');
  return v;
};
const keys = (v: unknown, want: readonly string[]): Record<string, unknown> => {
  if (!isRecord(v) || Object.keys(v).length !== want.length || want.some((k) => !(k in v))) throw new LedgerCorrupt('stored document shape invalid');
  return v;
};
const parseCounts = (v: unknown): Counts => {
  const o = keys(v, ['qloo', 'gemini']);
  return { qloo: int(o.qloo), gemini: int(o.gemini) };
};
const HASH = /^[a-f0-9]{16,64}$/;
const SCOPE_ID = /^[sj]_[a-f0-9]{48}$/;
const REF = /^[A-Za-z0-9_.:-]{1,128}$/;

export function parseService(d: DocData | null): ServiceDoc | null {
  if (d === null) return null;
  const o = keys(d, ['schema', 'kind', 'currency', 'counts', 'unitsHeld', 'active', 'unresolved', 'updatedAt']);
  if (o.schema !== 1 || o.kind !== 'service') throw new LedgerCorrupt('service document invalid');
  return {
    schema: 1,
    kind: 'service',
    currency: str(o.currency, /^[A-Z]{3}$/),
    counts: parseCounts(o.counts),
    unitsHeld: int(o.unitsHeld),
    active: int(o.active),
    unresolved: int(o.unresolved),
    updatedAt: int(o.updatedAt),
  };
}

export function parseScope(d: DocData | null, scope: 'session' | 'journey'): ScopeDoc | null {
  if (d === null) return null;
  const o = keys(d, ['schema', 'kind', 'scope', 'counts', 'unitsHeld', 'updatedAt']);
  if (o.schema !== 1 || o.kind !== 'scope' || o.scope !== scope) throw new LedgerCorrupt('scope document invalid');
  return { schema: 1, kind: 'scope', scope, counts: parseCounts(o.counts), unitsHeld: int(o.unitsHeld), updatedAt: int(o.updatedAt) };
}

const nullableInt = (v: unknown) => (v === null ? null : int(v));

export function parseReservation(d: DocData | null): ReservationDoc | null {
  if (d === null) return null;
  const legacy = d.schema === 1;
  const o = keys(d, [
    'schema', 'kind', 'service', 'state', 'provider', 'stage', 'units', 'bound', 'currency', 'policyVersion', 'inputHash',
    'sessionScope', 'journeyScope', 'attemptRef', 'createdAt', 'intentAt', 'resolvedAt', 'unknownReason', 'settlement', 'withdrawal',
    ...(legacy ? [] : ['observation']),
  ]);
  if ((o.schema !== 1 && o.schema !== 2) || o.kind !== 'reservation') throw new LedgerCorrupt('reservation document invalid');
  const state = o.state as ReservationState;
  if (!['reserved', 'intent', 'unknown', 'settled', 'withdrawn'].includes(state)) throw new LedgerCorrupt('reservation state invalid');
  const stage = o.stage as StageKey;
  if (!STAGES.includes(stage) || o.provider !== STAGE_PROVIDER[stage]) throw new LedgerCorrupt('reservation stage invalid');
  if (o.bound !== 'enforceable' && o.bound !== 'estimate_with_residual') throw new LedgerCorrupt('reservation bound invalid');
  if (o.unknownReason !== null && !UNKNOWN_REASONS.includes(o.unknownReason as UnknownReason)) throw new LedgerCorrupt('reservation reason invalid');
  let settlement: Settlement | null = null;
  if (o.settlement !== null) {
    const s = keys(o.settlement, ['kind', 'units', 'reference', 'issuedAt', 'overrunUnits']);
    if (s.kind !== 'provider_usage' && s.kind !== 'controller_reconciliation') throw new LedgerCorrupt('settlement invalid');
    settlement = { kind: s.kind, units: int(s.units), reference: str(s.reference, REF), issuedAt: int(s.issuedAt), overrunUnits: int(s.overrunUnits) };
  }
  let withdrawal: ReservationDoc['withdrawal'] = null;
  if (o.withdrawal !== null) {
    const w = keys(o.withdrawal, ['proof']);
    if (w.proof !== 'intent_never_recorded') throw new LedgerCorrupt('withdrawal invalid');
    withdrawal = { proof: 'intent_never_recorded' };
  }
  // State/field consistency: a record cannot claim a resolution it does not carry.
  const consistent =
    (state === 'settled') === (settlement !== null) &&
    (state === 'withdrawn') === (withdrawal !== null) &&
    (state === 'unknown' ? o.unknownReason !== null : true) &&
    (state === 'reserved' || state === 'withdrawn' ? o.intentAt === null : o.intentAt !== null);
  if (!consistent) throw new LedgerCorrupt('reservation fields inconsistent with state');
  const observation = legacy || o.observation === null ? null : parseObservation(o.observation);
  if ((!legacy && o.observation !== null && !observation) || (observation && (observation.stage !== stage || observation.provider !== o.provider || (state === 'reserved' || state === 'withdrawn') || observation.adapterStartedAt < int(o.intentAt)))) throw new LedgerCorrupt('reservation observation invalid');
  return {
    schema: 2,
    kind: 'reservation',
    service: str(o.service, /^[A-Za-z0-9_-]{1,64}$/),
    state,
    provider: STAGE_PROVIDER[stage],
    stage,
    units: int(o.units),
    bound: o.bound,
    currency: str(o.currency, /^[A-Z]{3}$/),
    policyVersion: str(o.policyVersion, /^[A-Za-z0-9_.-]{1,64}$/),
    inputHash: str(o.inputHash, HASH),
    sessionScope: str(o.sessionScope, SCOPE_ID),
    journeyScope: str(o.journeyScope, SCOPE_ID),
    attemptRef: str(o.attemptRef, HASH),
    createdAt: int(o.createdAt),
    intentAt: nullableInt(o.intentAt),
    resolvedAt: nullableInt(o.resolvedAt),
    unknownReason: (o.unknownReason as UnknownReason | null) ?? null,
    settlement,
    withdrawal,
    observation,
  };
}

/** Strict receipt validation: exact fields, integer non-negative units, bounded opaque reference. */
export function parseSettlementReceipt(raw: unknown): SettlementReceipt | null {
  if (!isRecord(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const want = ['kind', 'currency', 'units', 'reference', 'issuedAt'];
  if (Object.keys(raw).length !== want.length || want.some((k) => !(k in raw))) return null;
  const { kind, currency, units, reference, issuedAt } = raw;
  if (kind !== 'provider_usage' && kind !== 'controller_reconciliation') return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  if (typeof units !== 'number' || !Number.isSafeInteger(units) || units < 0) return null;
  if (typeof reference !== 'string' || !REF.test(reference)) return null;
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
  return { kind, currency, units, reference, issuedAt };
}

/** Observation enrichment writes only this existing reservation, never exposure aggregates or settlement. */
export function planObservation(r: ReservationDoc | null, raw: unknown): Plan {
  if (!r) return { ok: false, code: 'not_found' };
  if (r.state === 'reserved' || r.state === 'withdrawn' || r.intentAt === null) return { ok: false, code: 'invalid_state' };
  const observation = mergeObservation(r.observation, raw);
  if (!observation || observation.stage !== r.stage || observation.provider !== r.provider || observation.adapterStartedAt < r.intentAt) return { ok: false, code: 'invalid_receipt' };
  const replay = canonicalJson(observation) === canonicalJson(r.observation);
  const reservation = { ...r, observation };
  return { ok: true, reservation, replay, writes: replay ? {} : { reservation: { doc: reservation, create: false } } };
}

// ---------------------------------------------------------------------------
// Planners.

const emptyService = (currency: string, now: number): ServiceDoc => ({
  schema: 1,
  kind: 'service',
  currency,
  counts: { qloo: 0, gemini: 0 },
  unitsHeld: 0,
  active: 0,
  unresolved: 0,
  updatedAt: now,
});
const emptyScope = (scope: 'session' | 'journey', now: number): ScopeDoc => ({ schema: 1, kind: 'scope', scope, counts: { qloo: 0, gemini: 0 }, unitsHeld: 0, updatedAt: now });

export interface ReserveInput {
  readonly service: string;
  readonly stage: StageKey;
  readonly inputHash: string;
  readonly sessionScope: string;
  readonly journeyScope: string;
  readonly attemptRef: string;
  readonly now: number;
}

export interface Current {
  readonly reservation: ReservationDoc | null;
  readonly service: ServiceDoc | null;
  readonly session: ScopeDoc | null;
  readonly journey: ScopeDoc | null;
}

export function planReserve(input: ReserveInput, cur: Current, policy: ExposurePolicy): Plan {
  // Exact replay never allocates twice; a different input under the same key is refused.
  if (cur.reservation) {
    return cur.reservation.inputHash === input.inputHash ? { ok: true, reservation: cur.reservation, replay: true, writes: {} } : { ok: false, code: 'conflict' };
  }
  if (input.now >= policy.expiresAt) return { ok: false, code: 'policy_expired' };
  if (cur.service && cur.service.currency !== policy.currency) return { ok: false, code: 'policy_mismatch' };
  const provider = STAGE_PROVIDER[input.stage];
  const { units, bound } = policy.reservations[input.stage];
  const service = cur.service ?? emptyService(policy.currency, input.now);
  const session = cur.session ?? emptyScope('session', input.now);
  const journey = cur.journey ?? emptyScope('journey', input.now);

  if (add(service.active, 1) > policy.service.concurrency) return { ok: false, code: 'concurrency' };
  if (add(service.counts[provider], 1) > policy.service.counts[provider]) return { ok: false, code: 'capacity_service_count' };
  if (add(service.unitsHeld, units) > policy.service.capUnits) return { ok: false, code: 'capacity_service_units' };
  if (add(session.counts[provider], 1) > policy.session.counts[provider]) return { ok: false, code: 'capacity_session_count' };
  if (add(session.unitsHeld, units) > policy.session.capUnits) return { ok: false, code: 'capacity_session_units' };
  if (add(journey.counts[provider], 1) > policy.journey.counts[provider]) return { ok: false, code: 'capacity_journey_count' };
  if (add(journey.unitsHeld, units) > policy.journey.capUnits) return { ok: false, code: 'capacity_journey_units' };

  const reservation: ReservationDoc = {
    schema: 2,
    kind: 'reservation',
    service: input.service,
    state: 'reserved',
    provider,
    stage: input.stage,
    units,
    bound,
    currency: policy.currency,
    policyVersion: policy.version,
    inputHash: input.inputHash,
    sessionScope: input.sessionScope,
    journeyScope: input.journeyScope,
    attemptRef: input.attemptRef,
    createdAt: input.now,
    intentAt: null,
    resolvedAt: null,
    unknownReason: null,
    settlement: null,
    withdrawal: null,
    observation: null,
  };
  return {
    ok: true,
    reservation,
    replay: false,
    writes: {
      reservation: { doc: reservation, create: true },
      service: {
        ...service,
        counts: bump(service.counts, provider, 1),
        unitsHeld: add(service.unitsHeld, units),
        active: add(service.active, 1),
        unresolved: add(service.unresolved, 1),
        updatedAt: input.now,
      },
      session: { ...session, counts: bump(session.counts, provider, 1), unitsHeld: add(session.unitsHeld, units), updatedAt: input.now },
      journey: { ...journey, counts: bump(journey.counts, provider, 1), unitsHeld: add(journey.unitsHeld, units), updatedAt: input.now },
    },
  };
}

/**
 * Durable dispatch intent: must commit before the adapter is invoked. Only the
 * call whose transaction performs reserved -> intent is a send grant. An
 * existing intent (repeat, race loser, retry after a lost acknowledgement) is
 * an observation of possibly-sent work, never permission to send again.
 * New intent is new financial dispatch admission, so it requires the current,
 * unexpired policy that admitted the reservation (same version and currency).
 */
export function planIntent(r: ReservationDoc | null, now: number, policy: ExposurePolicy): Plan {
  if (!r) return { ok: false, code: 'not_found' };
  if (r.state === 'intent') return { ok: false, code: 'intent_exists' };
  if (r.state !== 'reserved') return { ok: false, code: 'invalid_state' };
  if (now >= policy.expiresAt) return { ok: false, code: 'policy_expired' };
  if (r.policyVersion !== policy.version || r.currency !== policy.currency) return { ok: false, code: 'policy_mismatch' };
  const doc: ReservationDoc = { ...r, state: 'intent', intentAt: now };
  return { ok: true, reservation: doc, replay: false, writes: { reservation: { doc, create: false } } };
}

/** Requires the aggregate documents referenced by the reservation to exist (else the store is corrupt). */
function aggregates(cur: Current) {
  if (!cur.service || !cur.session || !cur.journey) throw new LedgerCorrupt('aggregate documents missing for an existing reservation');
  return { service: cur.service, session: cur.session, journey: cur.journey };
}

/** Releases a reservation that provably never reached the network. */
export function planWithdraw(cur: Current, proof: unknown, now: number): Plan {
  const r = cur.reservation;
  if (!r) return { ok: false, code: 'not_found' };
  if (r.state === 'withdrawn') return { ok: true, reservation: r, replay: true, writes: {} };
  const proven = typeof proof === 'object' && proof !== null && Object.keys(proof).length === 1 && (proof as { kind?: unknown }).kind === 'intent_never_recorded';
  // Intent recorded => an invocation may have happened => never a withdrawal.
  if (r.state !== 'reserved' || !proven || r.intentAt !== null) return { ok: false, code: 'invalid_state' };
  const { service, session, journey } = aggregates(cur);
  const doc: ReservationDoc = { ...r, state: 'withdrawn', resolvedAt: now, withdrawal: { proof: 'intent_never_recorded' } };
  return {
    ok: true,
    reservation: doc,
    replay: false,
    writes: {
      reservation: { doc, create: false },
      service: {
        ...service,
        counts: bump(service.counts, r.provider, -1),
        unitsHeld: add(service.unitsHeld, -r.units),
        active: add(service.active, -1),
        unresolved: add(service.unresolved, -1),
        updatedAt: now,
      },
      session: { ...session, counts: bump(session.counts, r.provider, -1), unitsHeld: add(session.unitsHeld, -r.units), updatedAt: now },
      journey: { ...journey, counts: bump(journey.counts, r.provider, -1), unitsHeld: add(journey.unitsHeld, -r.units), updatedAt: now },
    },
  };
}

/**
 * The local request ended without a receipt. Never a refund: money and counts
 * stay held; only the in-flight concurrency slot is released.
 */
export function planUnknown(cur: Current, reason: UnknownReason, now: number): Plan {
  const r = cur.reservation;
  if (!r) return { ok: false, code: 'not_found' };
  if (r.state === 'unknown' || r.state === 'settled') return { ok: true, reservation: r, replay: true, writes: {} };
  if (r.state !== 'intent') return { ok: false, code: 'invalid_state' };
  const { service } = aggregates(cur);
  const doc: ReservationDoc = { ...r, state: 'unknown', unknownReason: reason };
  return {
    ok: true,
    reservation: doc,
    replay: false,
    writes: { reservation: { doc, create: false }, service: { ...service, active: add(service.active, -1), updatedAt: now } },
  };
}

/** Fixes actual units from a typed validated receipt; the held amount moves from reserved to actual. */
export function planSettle(cur: Current, receipt: SettlementReceipt, now: number): Plan {
  const r = cur.reservation;
  if (!r) return { ok: false, code: 'not_found' };
  if (receipt.currency !== r.currency) return { ok: false, code: 'invalid_receipt' };
  if (r.state === 'settled') {
    const s = r.settlement!;
    const same = s.kind === receipt.kind && s.units === receipt.units && s.reference === receipt.reference && s.issuedAt === receipt.issuedAt;
    return same ? { ok: true, reservation: r, replay: true, writes: {} } : { ok: false, code: 'conflict' };
  }
  // A receipt for work whose intent was never recorded (or that was withdrawn) is not accepted.
  if (r.state !== 'intent' && r.state !== 'unknown') return { ok: false, code: 'invalid_state' };
  const { service, session, journey } = aggregates(cur);
  const delta = receipt.units - r.units;
  const doc: ReservationDoc = {
    ...r,
    state: 'settled',
    resolvedAt: now,
    settlement: { kind: receipt.kind, units: receipt.units, reference: receipt.reference, issuedAt: receipt.issuedAt, overrunUnits: Math.max(0, delta) },
  };
  return {
    ok: true,
    reservation: doc,
    replay: false,
    writes: {
      reservation: { doc, create: false },
      service: {
        ...service,
        unitsHeld: add(service.unitsHeld, delta),
        active: r.state === 'intent' ? add(service.active, -1) : service.active,
        unresolved: add(service.unresolved, -1),
        updatedAt: now,
      },
      session: { ...session, unitsHeld: add(session.unitsHeld, delta), updatedAt: now },
      journey: { ...journey, unitsHeld: add(journey.unitsHeld, delta), updatedAt: now },
    },
  };
}
