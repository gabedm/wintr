import { createHash } from 'node:crypto';
import type { DocData, DocPath, DocStore, DocTx } from '../persistence/docstore.js';
import { canonicalJson } from '../seal.js';
import { parseExposurePolicy, PolicyError, STAGES, type ExposurePolicy, type StageKey } from './policy.js';
import {
  LedgerCorrupt,
  LedgerOverflow,
  parseReservation,
  parseScope,
  parseService,
  parseSettlementReceipt,
  planIntent,
  planReserve,
  planSettle,
  planUnknown,
  planWithdraw,
  UNKNOWN_REASONS,
  UNRESOLVED_STATES,
  type Current,
  type Plan,
  type Refusal,
  type ReservationDoc,
  type ServiceDoc,
  type UnknownReason,
} from './transitions.js';

// Durable service-level exposure/count ledger (W05 foundation, F1).
//
// Every decision is one shared transaction over individual bounded documents:
//   wintr_ledger_service/{serviceId}       service totals (counts, held units, in-flight, unresolved)
//   wintr_ledger_scopes/{s_…|j_…}          per-session / per-Journey counts and held units
//   wintr_ledger_reservations/{r_…}        one record per dispatch reservation
// These collections are separate from listener-owned content, carry no TTL
// field and are never touched by Clear or expiry, so a new session, Clear,
// clock expiry, restart or TTL cannot reset unresolved exposure. Records hold
// only opaque hashes, stage/provider, integer units, states, timestamps and
// receipt references: no source, prompt, result, URL, key or listener content.
//
// Dispatch protocol for F2 (one provider submission):
//   1. reserve(key, stage, owner…)   -> must be ok, else do not send
//   2. markIntent(id)                -> send ONLY on { ok: true, grant: 'send' }. Every other
//                                       result (including intent_exists after a race, a repeat
//                                       or a lost acknowledgement, and store_unavailable) means
//                                       do not send; if intent may exist, hold it as unknown.
//   3. invoke the adapter once (outside any transaction)
//   4a. settle(id, receipt)          -> only with a typed controller/provider receipt
//   4b. markUnknown(id, reason)      -> timeout/failure/cancel/unusable output: held, not refunded
//   (or) withdraw(id, {kind:'intent_never_recorded'}) if step 2 never committed
// Exact replay of reserve/markUnknown/settle/withdraw is idempotent; a different
// input under the same reservation key is refused. New reservations and new
// intent require the current, unexpired policy (same version and currency);
// read, withdrawal of never-sent work, unknown marking and known settlement
// remain available without one, so unknown work can always be reconciled.
// Every record is bound to one serviceId: another service can neither read nor
// change it.
//
// Not supplied here (F2 seam): this ledger does not know session epoch, the
// current brief/Attempt or the execute deadline. F2 must compose those Store
// checks with the reserve and intent writes in the SAME Firestore transaction
// (all reads first, then the Store and ledger writes), so a revoked or stale
// Attempt can never obtain a send grant. A standalone ledger grant is financial
// admission only, not ownership or live acceptance.

export type LedgerCode = Refusal | 'policy_missing' | 'policy_invalid' | 'invalid_input' | 'overflow' | 'store_corrupt' | 'store_unavailable';

/**
 * Result of the dispatch-intent boundary. Only `grant: 'send'` permits exactly
 * one adapter invocation; `intent_exists` reports possibly-sent work.
 */
export type IntentResult =
  | { readonly ok: true; readonly grant: 'send'; readonly reservation: ReservationView }
  | { readonly ok: false; readonly code: 'intent_exists'; readonly reservation: ReservationView }
  | { readonly ok: false; readonly code: Exclude<LedgerCode, 'intent_exists'> };

export interface ReservationView {
  readonly id: string;
  readonly state: ReservationDoc['state'];
  readonly provider: ReservationDoc['provider'];
  readonly stage: StageKey;
  readonly units: number;
  readonly bound: ReservationDoc['bound'];
  readonly currency: string;
  readonly policyVersion: string;
  readonly createdAt: number;
  readonly intentAt: number | null;
  readonly resolvedAt: number | null;
  readonly unknownReason: UnknownReason | null;
  readonly settlement: ReservationDoc['settlement'];
  readonly observation: ReservationDoc['observation'];
}

export type LedgerResult = { readonly ok: true; readonly reservation: ReservationView; readonly replay: boolean } | { readonly ok: false; readonly code: LedgerCode };

export interface ReserveRequest {
  /** Caller-derived opaque key for exactly one submission (e.g. hash of attempt + call index). */
  readonly reservationKey: string;
  readonly stage: StageKey;
  readonly sessionId: string;
  readonly journeyId: string;
  readonly attemptId: string;
  readonly now: number;
}

export interface ServiceTotals {
  readonly currency: string;
  readonly counts: ServiceDoc['counts'];
  readonly unitsHeld: number;
  readonly active: number;
  readonly unresolved: number;
}

export interface ExposureLedger {
  reserve(req: ReserveRequest): Promise<LedgerResult>;
  markIntent(reservationId: string, now: number): Promise<IntentResult>;
  markUnknown(reservationId: string, reason: UnknownReason, now: number): Promise<LedgerResult>;
  settle(reservationId: string, receipt: unknown, now: number): Promise<LedgerResult>;
  withdraw(reservationId: string, proof: unknown, now: number): Promise<LedgerResult>;
  read(reservationId: string): Promise<ReservationView | null>;
  /** Unresolved reservations (reserved/intent/unknown) for reconciliation; no listener content. */
  unresolved(limit: number): Promise<ReservationView[]>;
  totals(): Promise<ServiceTotals | null>;
}

const SERVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPAQUE = /^[A-Za-z0-9_-]{16,128}$/;
const RESERVATION_ID = /^r_[a-f0-9]{48}$/;

const toDoc = (x: object) => x as unknown as DocData;
const view = (id: string, r: ReservationDoc): ReservationView => ({
  id,
  state: r.state,
  provider: r.provider,
  stage: r.stage,
  units: r.units,
  bound: r.bound,
  currency: r.currency,
  policyVersion: r.policyVersion,
  createdAt: r.createdAt,
  intentAt: r.intentAt,
  resolvedAt: r.resolvedAt,
  unknownReason: r.unknownReason,
  settlement: r.settlement,
  observation: r.observation,
});

export interface LedgerOptions {
  readonly docs: DocStore;
  /** Raw controller policy, validated here; missing or malformed fails admission closed. */
  readonly policy: unknown;
  /** Symbolic service identifier (one accounting domain). */
  readonly serviceId: string;
}

/** Parsed policy or the reason admission must fail closed. */
export function resolvePolicy(raw: unknown): ExposurePolicy | 'missing' | 'invalid' {
  if (raw === undefined || raw === null) return 'missing';
  try {
    return parseExposurePolicy(raw);
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    return 'invalid';
  }
}

/**
 * Ledger building blocks for composing ledger reads/plans/writes into a larger
 * shared transaction (the transactional Store). Pure path/hash derivations,
 * strict decoders and plan application; no I/O of its own.
 */
export function ledgerComposer(serviceId: string) {
  if (!SERVICE_ID.test(serviceId)) throw new RangeError('invalid service id');
  /** Lowercase hex SHA-256 prefix: opaque, non-reversible ledger identifiers. */
  const h = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
  const servicePath: DocPath = { collection: 'wintr_ledger_service', id: serviceId };
  const scopeId = (kind: 'session' | 'journey', id: string) => `${kind === 'session' ? 's' : 'j'}_${h(`${serviceId}|${kind}|${id}`, 48)}`;
  const scopePath = (id: string): DocPath => ({ collection: 'wintr_ledger_scopes', id });
  const reservationPath = (id: string): DocPath => ({ collection: 'wintr_ledger_reservations', id });
  const reservationIdFor = (key: string) => `r_${h(`${serviceId}|reservation|${key}`, 48)}`;
  const attemptRef = (attemptId: string) => h(`${serviceId}|attempt|${attemptId}`, 32);
  const inputHash = (stage: StageKey, sessionScope: string, journeyScope: string, ref: string) =>
    h(canonicalJson({ stage, session: sessionScope, journey: journeyScope, attempt: ref }), 64);
  /** A reservation bound to another service is treated exactly like an absent one. */
  const own = (r: ReservationDoc | null) => (r && r.service === serviceId ? r : null);
  /** Applies a plan's writes inside the caller's transaction (no other side effect). */
  const apply = (tx: DocTx, id: string, plan: Plan) => {
    if (!plan.ok) return;
    const w = plan.writes;
    if (w.reservation?.create) tx.create(reservationPath(id), toDoc(w.reservation.doc));
    else if (w.reservation) tx.set(reservationPath(id), toDoc(w.reservation.doc));
    if (w.service) tx.set(servicePath, toDoc(w.service));
    if (w.session && plan.reservation) tx.set(scopePath(plan.reservation.sessionScope), toDoc(w.session));
    if (w.journey && plan.reservation) tx.set(scopePath(plan.reservation.journeyScope), toDoc(w.journey));
  };
  /** Reads (in one getAll round, before any write) everything planReserve needs. */
  const readForReserve = async (tx: DocTx, id: string, sessionScope: string, journeyScope: string): Promise<Current> => {
    const [r, s, sess, jour] = await tx.getAll([reservationPath(id), servicePath, scopePath(sessionScope), scopePath(journeyScope)]);
    return {
      reservation: parseReservation(r ?? null),
      service: parseService(s ?? null),
      session: parseScope(sess ?? null, 'session'),
      journey: parseScope(jour ?? null, 'journey'),
    };
  };
  /** Reads this service's reservation and (if wanted) its aggregate documents, all before any write. */
  const readCurrent = async (tx: DocTx, id: string, withAggregates: boolean): Promise<Current> => {
    const [raw] = await tx.getAll([reservationPath(id)]);
    // Service ownership is checked on every path, with or without aggregates.
    const reservation = own(parseReservation(raw ?? null));
    if (!reservation || !withAggregates) return { reservation, service: null, session: null, journey: null };
    const [s, sess, jour] = await tx.getAll([servicePath, scopePath(reservation.sessionScope), scopePath(reservation.journeyScope)]);
    return { reservation, service: parseService(s ?? null), session: parseScope(sess ?? null, 'session'), journey: parseScope(jour ?? null, 'journey') };
  };
  return { serviceId, servicePath, scopeId, scopePath, reservationPath, reservationIdFor, attemptRef, inputHash, own, apply, readForReserve, readCurrent };
}

export type LedgerComposer = ReturnType<typeof ledgerComposer>;

export function createExposureLedger(opts: LedgerOptions): ExposureLedger {
  const { docs, serviceId } = opts;
  const policy = resolvePolicy(opts.policy);
  const { servicePath, scopeId, reservationPath, reservationIdFor, own, apply, readForReserve, readCurrent, attemptRef: refFor, inputHash: hashFor } = ledgerComposer(serviceId);

  /** Store/integrity failures fail closed (never a grant, never a fallback). */
  const failure = (err: unknown): { ok: false; code: 'store_corrupt' | 'overflow' | 'store_unavailable' } => ({
    ok: false,
    code: err instanceof LedgerCorrupt ? 'store_corrupt' : err instanceof LedgerOverflow ? 'overflow' : 'store_unavailable',
  });

  /** Runs one shared transaction. */
  const run = async (fn: (tx: DocTx) => Promise<{ id: string; plan: Plan }>): Promise<LedgerResult> => {
    try {
      const { id, plan } = await docs.transact(fn);
      return plan.ok ? { ok: true, reservation: view(id, plan.reservation), replay: plan.replay } : { ok: false, code: plan.code };
    } catch (err) {
      return failure(err);
    }
  };

  const transition = (id: string, withAggregates: boolean, plan: (cur: Current) => Plan) => {
    if (!RESERVATION_ID.test(id)) return Promise.resolve<LedgerResult>({ ok: false, code: 'invalid_input' });
    return run(async (tx) => {
      const cur = await readCurrent(tx, id, withAggregates);
      const p = plan(cur);
      apply(tx, id, p);
      return { id, plan: p };
    });
  };

  const validNow = (now: unknown): now is number => typeof now === 'number' && Number.isSafeInteger(now) && now >= 0;

  return {
    async reserve(req) {
      if (policy === 'missing') return { ok: false, code: 'policy_missing' };
      if (policy === 'invalid') return { ok: false, code: 'policy_invalid' };
      const p = policy;
      if (
        !OPAQUE.test(req.reservationKey) ||
        !OPAQUE.test(req.sessionId) ||
        !OPAQUE.test(req.journeyId) ||
        !OPAQUE.test(req.attemptId) ||
        !STAGES.includes(req.stage) ||
        !validNow(req.now)
      ) {
        return { ok: false, code: 'invalid_input' };
      }
      const id = reservationIdFor(req.reservationKey);
      const sessionScope = scopeId('session', req.sessionId);
      const journeyScope = scopeId('journey', req.journeyId);
      const attemptRef = refFor(req.attemptId);
      const inputHash = hashFor(req.stage, sessionScope, journeyScope, attemptRef);
      return run(async (tx) => {
        const cur = await readForReserve(tx, id, sessionScope, journeyScope);
        const plan = planReserve({ service: serviceId, stage: req.stage, inputHash, sessionScope, journeyScope, attemptRef, now: req.now }, cur, p);
        apply(tx, id, plan);
        return { id, plan };
      });
    },

    async markIntent(id, now) {
      if (!validNow(now) || !RESERVATION_ID.test(id)) return { ok: false, code: 'invalid_input' };
      // New durable intent is new financial dispatch admission: a valid policy is required here too.
      if (policy === 'missing') return { ok: false, code: 'policy_missing' };
      if (policy === 'invalid') return { ok: false, code: 'policy_invalid' };
      const p = policy;
      try {
        const { plan, observed } = await docs.transact(async (tx) => {
          const cur = await readCurrent(tx, id, false);
          const plan = planIntent(cur.reservation, now, p);
          apply(tx, id, plan);
          return { plan, observed: cur.reservation };
        });
        // Only the transaction that performed reserved -> intent grants a send.
        if (plan.ok) return { ok: true, grant: 'send', reservation: view(id, plan.reservation) };
        if (plan.code === 'intent_exists' && observed) return { ok: false, code: 'intent_exists', reservation: view(id, observed) };
        return { ok: false, code: plan.code as Exclude<LedgerCode, 'intent_exists'> };
      } catch (err) {
        return failure(err);
      }
    },

    markUnknown(id, reason, now) {
      if (!validNow(now) || !UNKNOWN_REASONS.includes(reason)) return Promise.resolve({ ok: false, code: 'invalid_input' });
      return transition(id, true, (cur) => planUnknown(cur, reason, now));
    },

    settle(id, rawReceipt, now) {
      const receipt = parseSettlementReceipt(rawReceipt);
      if (!receipt) return Promise.resolve({ ok: false, code: 'invalid_receipt' });
      if (!validNow(now)) return Promise.resolve({ ok: false, code: 'invalid_input' });
      return transition(id, true, (cur) => planSettle(cur, receipt, now));
    },

    withdraw(id, proof, now) {
      if (!validNow(now)) return Promise.resolve({ ok: false, code: 'invalid_input' });
      return transition(id, true, (cur) => planWithdraw(cur, proof, now));
    },

    async read(id) {
      if (!RESERVATION_ID.test(id)) return null;
      const r = own(parseReservation(await docs.get(reservationPath(id))));
      return r ? view(id, r) : null;
    },

    async unresolved(limit) {
      // The service restriction is a database filter applied before the limit (equality on
      // `service`, `in` on `state`); the in-process ownership check below is defence in depth.
      // Live Firestore may need a composite index on (service, state): live-unverified.
      const rows = await docs.query(
        'wintr_ledger_reservations',
        [
          { field: 'service', op: '==', value: serviceId },
          { field: 'state', op: 'in', value: UNRESOLVED_STATES },
        ],
        limit,
      );
      return rows.flatMap(({ id, data }) => {
        const r = own(parseReservation(data));
        return r ? [view(id, r)] : [];
      });
    },

    async totals() {
      const s = parseService(await docs.get(servicePath));
      return s ? { currency: s.currency, counts: s.counts, unitsHeld: s.unitsHeld, active: s.active, unresolved: s.unresolved } : null;
    },
  };
}
