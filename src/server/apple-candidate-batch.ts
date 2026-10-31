import type { Handle, InvestigationPlan, QlooCandidatePool } from '../shared/records.js';
import { LIMITS } from '../shared/records.js';
import { APPLE_SEARCH_LIMIT, APPLE_SEARCH_SOURCE_KIND, type AppleCatalogueSearch, type AppleSearchUnavailableReason } from './apple-catalogue-search.js';
import { APPLE_DISPATCH_LAG_MS, type AppleMetadataRateGate, type AppleRateRefusal } from './apple-metadata-rate.js';
import { canonicalAppleSongUrl } from './destinations.js';
import { rehydrateIdentity, type IdentityOwner } from './identity.js';
import type { MetadataBudget, SafeFetchContext } from './net/safe-fetch.js';
import type { QlooArtistId } from './providers/qloo.js';
import { matchForm } from './recording-identity.js';
import type { RecordSealer } from './seal.js';

// Explicitly prepared owned Apple candidate batch; ordinary startup never selects it.
// (docs/decisions/APPLE_CATALOGUE_SEARCH_PREPARATION.md).
// - Consumes only an owned InvestigationPlan and its QlooCandidatePool. The
//   artists searched are the first (at most) three allowed plan anchors, each
//   rehydrated from its sealed identity against the expected owner. No model or
//   client artist string, no extra Qloo request, no substitution, no fallback.
// - Each selected anchor must carry a valid seal AND artist_insights provenance
//   naming THIS pool, checked before any admission or search.
// - Every metadata call is durably admitted first (shared rate gate) and spends
//   one unit of the shared per-execute metadata budget; liveness (Stop, execute
//   deadline, owner and binding expiry, clock floor) is rechecked after the
//   asynchronous admission and before any request. The admission is a bounded
//   dispatch ticket: DNS and HTTP must start before dispatchBy, separately from
//   the bounded response/execute deadline. One search per anchor, no retry.
// - A built batch's trust is short-lived: it ends at the earliest of owner expiry,
//   execute deadline and gate binding expiry, or at the execute's Stop.
// - All provenance (owner, plan, pool, execute, anchors, names, storefront) is
//   captured as scalars before the first await.
// - The batch is candidate metadata only: not a TrackChoice, not musical or audio
//   evidence, not native Google grounding, and not verified by the ID lookup.
//   Trust is a module-private WeakMap capability, so a copy, spread or JSON
//   round-trip carries none. Fixtures establish neither Qloo consumption nor
//   live acceptance; the synthetic flags are explicit.

export const APPLE_BATCH_MAX_ANCHORS = 3;
export const APPLE_BATCH_MAX_CANDIDATES = APPLE_BATCH_MAX_ANCHORS * APPLE_SEARCH_LIMIT;
export const APPLE_BATCH_KIND = 'apple_catalogue_search_candidate_batch';

const HANDLE = /^[A-Za-z0-9_-]{16,64}$/;
const STOREFRONT = /^[a-z]{2}$/;
const MAX_NAME = 256;
const MAX_TEXT = 300;
const MAX_LIST = 512;
const UNCLEAN = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

export interface AppleBatchInput {
  readonly plan: InvestigationPlan;
  readonly pool: QlooCandidatePool;
  /** Expected owner of both records and of every sealed identity. */
  readonly owner: IdentityOwner;
  /** Opaque ref of the current execute/attempt. */
  readonly executeRef: Handle;
  /** Server-owned lowercase two-letter storefront. */
  readonly storefront: string;
}

export interface AppleBatchContext extends SafeFetchContext {
  readonly now: () => number;
  /** Controller-supplied fresh opaque handles for candidate refs. */
  readonly newHandle: () => Handle;
}

export interface OwnedAppleCandidate {
  /** New opaque ref; the only name a future selector may use. */
  readonly ref: Handle;
  readonly anchor: { readonly handle: Handle; readonly name: string };
  readonly artistEntityId: string;
  readonly sourceKind: typeof APPLE_SEARCH_SOURCE_KIND;
  readonly title: string;
  readonly artistName: string;
  readonly trackId: string;
  readonly storefront: string;
  readonly destination: { readonly kind: 'apple_music'; readonly storefront: string; readonly trackId: string; readonly url: string };
}

export type AppleAnchorUnavailableReason = AppleSearchUnavailableReason | `admission_${AppleRateRefusal}` | 'owner_expired' | 'binding_expired' | 'dispatch_expired' | 'clock_regressed' | 'search_mismatch';

export type AppleAnchorResult =
  | { readonly anchor: Handle; readonly status: 'candidates'; readonly returned: number }
  | { readonly anchor: Handle; readonly status: 'unavailable'; readonly reason: AppleAnchorUnavailableReason };

export interface OwnedAppleCandidateBatch {
  readonly kind: typeof APPLE_BATCH_KIND;
  readonly planId: Handle;
  readonly poolId: Handle;
  readonly executeRef: Handle;
  readonly storefront: string;
  readonly owner: { readonly sessionId: Handle; readonly epoch: number; readonly journeyId: Handle; readonly expiresAt: number };
  /** Explicit: true for a synthetic pool and/or a synthetic Apple transport. Neither can show actual Qloo consumption. */
  readonly synthetic: { readonly pool: boolean; readonly transport: boolean };
  readonly anchors: readonly AppleAnchorResult[];
  readonly candidates: readonly OwnedAppleCandidate[];
  readonly dropped: { readonly duplicate: number; readonly alreadyShown: number };
}

export type AppleBatchUnavailableReason =
  | 'invalid_input'
  | 'ownership_mismatch'
  | 'expired'
  | 'provenance_mismatch'
  | 'invalid_anchor'
  | 'identity_rejected'
  | 'no_allowed_anchor'
  | 'invalid_context'
  | 'aborted'
  | 'binding_expired'
  | 'deadline';

export type AppleBatchOutcome = { readonly status: 'batch'; readonly batch: OwnedAppleCandidateBatch } | { readonly status: 'unavailable'; readonly reason: AppleBatchUnavailableReason };

export interface AppleCandidateBatchBuilder {
  build(input: AppleBatchInput, ctx: AppleBatchContext): Promise<AppleBatchOutcome>;
}

export interface AppleCandidateBatchBuilderOptions {
  readonly search: AppleCatalogueSearch;
  readonly gate: AppleMetadataRateGate;
  readonly sealer: RecordSealer;
  /** Explicit label for the Apple transport behind `search`. */
  readonly syntheticTransport: boolean;
}

interface Provenance {
  readonly planId: Handle;
  readonly poolId: Handle;
  readonly executeRef: Handle;
  readonly owner: OwnedAppleCandidateBatch['owner'];
  /** Immutable snapshots taken at build: the capability dies with the execute and its source binding. */
  readonly capturedAt: number;
  readonly validUntil: number;
  readonly signal: AbortSignal;
  readonly candidates: ReadonlyMap<Handle, OwnedAppleCandidate>;
}

const trustedBatches = new WeakMap<object, Provenance>();
const trustedCandidates = new WeakMap<object, object>();

/**
 * The retained candidate for `ref`, only when `batch` is exactly an object this
 * module built and its bound owner, plan, pool and execute equal the expected
 * ones. It is short-lived: null once now reaches the earliest of the owner
 * expiry, execute deadline and gate binding expiry, for a clock before the
 * sample taken at build, or after the execute's Stop. A copy, spread, JSON
 * round-trip, cross-execute or cross-owner batch yields null.
 */
export function trustedAppleCandidate(
  batch: unknown,
  ref: unknown,
  expected: { readonly owner: IdentityOwner; readonly executeRef: Handle; readonly planId: Handle; readonly poolId: Handle },
  now: number,
): OwnedAppleCandidate | null {
  if (typeof batch !== 'object' || batch === null || typeof ref !== 'string') return null;
  const p = trustedBatches.get(batch);
  if (!p || !isTime(now) || now >= p.validUntil || now < p.capturedAt || p.signal.aborted) return null;
  const o = expected.owner;
  if (p.owner.sessionId !== o.sessionId || p.owner.epoch !== o.epoch || p.owner.journeyId !== o.journeyId || p.owner.expiresAt !== o.expiresAt) return null;
  if (p.executeRef !== expected.executeRef || p.planId !== expected.planId || p.poolId !== expected.poolId) return null;
  const c = p.candidates.get(ref as Handle);
  return c && trustedCandidates.get(c) === batch ? c : null;
}

const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHandle = (v: unknown): v is Handle => typeof v === 'string' && HANDLE.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && v === v.trim() && v.length <= max && !UNCLEAN.test(v);
const isName = (v: unknown): v is string => isText(v, MAX_NAME);

interface Anchor {
  readonly handle: Handle;
  readonly name: string;
  readonly entityId: QlooArtistId;
}

interface Captured {
  readonly planId: Handle;
  readonly poolId: Handle;
  readonly executeRef: Handle;
  readonly storefront: string;
  readonly owner: OwnedAppleCandidateBatch['owner'];
  readonly poolSynthetic: boolean;
  readonly anchors: readonly Anchor[];
  readonly reservedHandles: ReadonlySet<string>;
  readonly shownKeys: ReadonlySet<string>;
}

/** Synchronous validation and scalar capture. Any throwing getter or malformed shape refuses. */
function capture(input: AppleBatchInput, now: number, sealer: RecordSealer): Captured | AppleBatchUnavailableReason {
  try {
    if (!isRecord(input) || !isRecord(input.plan) || !isRecord(input.pool) || !isRecord(input.owner)) return 'invalid_input';
    const { plan, pool, owner: o } = input;
    const owner = { sessionId: o.sessionId as Handle, epoch: o.epoch as number, journeyId: o.journeyId as Handle, expiresAt: o.expiresAt as number };
    const { executeRef, storefront } = input;
    if (!isHandle(owner.sessionId) || !isHandle(owner.journeyId) || !Number.isSafeInteger(owner.epoch) || owner.epoch < 1 || !isTime(owner.expiresAt)) return 'invalid_input';
    if (!isHandle(executeRef) || typeof storefront !== 'string' || !STOREFRONT.test(storefront)) return 'invalid_input';
    if (!isHandle(plan.id) || !isHandle(pool.id) || !isHandle(plan.poolId)) return 'invalid_input';
    if (!Array.isArray(plan.anchors) || plan.anchors.length === 0 || plan.anchors.length > LIMITS.artistCandidates) return 'invalid_anchor';
    if (!Array.isArray(pool.artists) || pool.artists.length > LIMITS.artistCandidates || !Array.isArray(pool.seeds) || pool.seeds.length > LIMITS.maxSeeds) return 'invalid_input';
    if (!Array.isArray(plan.exclusions) || plan.exclusions.length > MAX_LIST || !plan.exclusions.every((e) => typeof e === 'string' && e.length <= MAX_NAME)) return 'invalid_input';
    if (!isRecord(plan.recordingExclusions) || !Array.isArray(plan.recordingExclusions.shown) || plan.recordingExclusions.shown.length > MAX_LIST) return 'invalid_input';
    if (!isRecord(plan.provenance) || !isHandle(plan.provenance.poolSourceBriefId) || !isHandle(pool.sourceBriefId) || !isHandle(plan.briefId)) return 'invalid_input';
    if (typeof pool.synthetic !== 'boolean') return 'invalid_input';

    if (plan.sessionId !== owner.sessionId || pool.sessionId !== owner.sessionId || plan.epoch !== owner.epoch || pool.epoch !== owner.epoch) return 'ownership_mismatch';
    if (plan.journeyId !== owner.journeyId || pool.journeyId !== owner.journeyId || plan.poolId !== pool.id) return 'ownership_mismatch';
    if (plan.expiresAt !== owner.expiresAt || pool.expiresAt !== owner.expiresAt) return 'ownership_mismatch';
    if (now >= owner.expiresAt) return 'expired';
    if (plan.provenance.poolSourceBriefId !== pool.sourceBriefId) return 'provenance_mismatch';
    if (plan.provenance.poolReuse === 'created' && plan.briefId !== pool.sourceBriefId) return 'provenance_mismatch';
    if (plan.provenance.poolReuse !== 'created' && plan.provenance.poolReuse !== 'reused_same_fingerprint') return 'provenance_mismatch';

    const poolArtists = new Map<string, unknown>();
    for (const a of pool.artists) {
      if (!isRecord(a) || !isHandle(a.handle) || poolArtists.has(a.handle)) return 'invalid_input';
      poolArtists.set(a.handle, a.identity);
    }
    const seen = new Set<string>();
    const planAnchors: { handle: Handle; name: string }[] = [];
    for (const a of plan.anchors) {
      if (!isRecord(a) || !isHandle(a.handle) || !isName(a.name) || seen.has(a.handle) || !poolArtists.has(a.handle)) return 'invalid_anchor';
      const id = poolArtists.get(a.handle);
      if (!isRecord(id) || id.name !== a.name) return 'invalid_anchor';
      seen.add(a.handle);
      planAnchors.push({ handle: a.handle, name: a.name });
    }

    const excluded = new Set(plan.exclusions.map((e) => matchForm(e as string)).filter((e) => e !== ''));
    const seedIds = new Set(pool.seeds.map((s) => (isRecord(s) && typeof s.entityId === 'string' ? s.entityId.toLowerCase() : '')));
    const anchors: Anchor[] = [];
    for (const a of planAnchors) {
      if (anchors.length >= APPLE_BATCH_MAX_ANCHORS) break;
      const sealedIdentity = poolArtists.get(a.handle);
      const seed = rehydrateIdentity(sealedIdentity, owner, now, sealer);
      if (!seed || seed.name !== a.name) return 'identity_rejected';
      // The seal covers the provenance: the anchor must come from THIS pool's artist insights, not another pool or a Search record.
      const provenance = isRecord(sealedIdentity) ? sealedIdentity.provenance : null;
      if (!isRecord(provenance) || provenance.operation !== 'artist_insights' || provenance.sourceRecordId !== pool.id) return 'identity_rejected';
      if (excluded.has(matchForm(seed.name)) || seedIds.has(seed.entityId.toLowerCase())) continue;
      anchors.push({ handle: a.handle, name: seed.name, entityId: seed.entityId });
    }
    if (anchors.length === 0) return 'no_allowed_anchor';

    const shownKeys = new Set<string>();
    for (const s of plan.recordingExclusions.shown) {
      if (isRecord(s) && typeof s.appleTrackId === 'string') shownKeys.add(s.appleTrackId);
    }
    return Object.freeze({
      planId: plan.id,
      poolId: pool.id,
      executeRef,
      storefront,
      owner: Object.freeze(owner),
      poolSynthetic: pool.synthetic,
      anchors: Object.freeze(anchors.map((a) => Object.freeze(a))),
      reservedHandles: new Set<string>([executeRef, plan.id, pool.id, owner.sessionId, owner.journeyId, ...planAnchors.map((a) => a.handle)]),
      shownKeys,
    });
  } catch {
    return 'invalid_input';
  }
}

const freezeCandidate = (c: OwnedAppleCandidate): OwnedAppleCandidate =>
  Object.freeze({ ...c, anchor: Object.freeze({ ...c.anchor }), destination: Object.freeze({ ...c.destination }) });

type Retained = Omit<OwnedAppleCandidate, 'ref'>;

export function createAppleCandidateBatchBuilder(opts: AppleCandidateBatchBuilderOptions): AppleCandidateBatchBuilder {
  const { search, gate, sealer, syntheticTransport } = opts;
  if (typeof search?.search !== 'function' || typeof gate?.admit !== 'function' || !isTime(gate.bindingExpiresAt) || typeof sealer?.verify !== 'function' || typeof syntheticTransport !== 'boolean') {
    throw new TypeError('invalid batch builder dependencies');
  }
  const bindingExpiresAt = gate.bindingExpiresAt;
  return {
    async build(input, ctx) {
      // Everything below the capture is a function of scalars taken here.
      let now: () => number;
      let signal: AbortSignal;
      let deadlineAt: number;
      let budget: MetadataBudget;
      let newHandle: () => Handle;
      let authorize: (() => Promise<boolean>) | undefined;
      let start: number;
      try {
        ({ now, signal, deadlineAt, budget, newHandle, authorize } = ctx);
        start = now();
        if (typeof now !== 'function' || !(signal instanceof AbortSignal) || !isTime(deadlineAt) || !isTime(start) || typeof newHandle !== 'function' || typeof budget?.take !== 'function' || typeof budget.slot !== 'function') {
          return { status: 'unavailable', reason: 'invalid_context' };
        }
      } catch {
        return { status: 'unavailable', reason: 'invalid_context' };
      }
      const cap = capture(input, start, sealer);
      if (typeof cap === 'string') return { status: 'unavailable', reason: cap };
      const { owner } = cap;
      const effectiveDeadline = Math.min(deadlineAt, owner.expiresAt);

      const validUntil = Math.min(owner.expiresAt, deadlineAt, bindingExpiresAt);

      const sample = (): number | null => {
        try {
          const t = now();
          return isTime(t) ? t : null;
        } catch {
          return null;
        }
      };
      /** Stop, execute deadline, owner or binding expiry, or a clock below the build start, from a fresh sample. */
      const lapsed = (): 'aborted' | 'deadline' | 'owner_expired' | 'binding_expired' | null => {
        if (signal.aborted) return 'aborted';
        const t = sample();
        if (t === null || t < start) return 'deadline';
        if (t >= owner.expiresAt) return 'owner_expired';
        if (t >= bindingExpiresAt) return 'binding_expired';
        return t >= deadlineAt ? 'deadline' : null;
      };

      const runAnchor = (a: Anchor) =>
        budget.slot(async (): Promise<{ result: AppleAnchorResult; found: Retained[] }> => {
          const none = (reason: AppleAnchorUnavailableReason) => ({ result: { anchor: a.handle, status: 'unavailable' as const, reason }, found: [] as Retained[] });
          const stop = lapsed();
          if (stop) return none(stop);
          if (authorize && !(await authorize())) return none('aborted');
          if (lapsed()) return none('aborted');
          if (!budget.take()) return none('metadata_cap');
          const admission = await gate.admit({ signal, deadlineAt: effectiveDeadline, scopeExpiresAt: owner.expiresAt });
          if (!admission.admitted) return none(`admission_${admission.reason}`);
          // The search's safeGet re-authorises after admission immediately before
          // DNS, then again after DNS/before HTTP. Do not spend the same short
          // dispatch ticket on a duplicate durable read here.
          const after = lapsed();
          if (after) return none(after);
          // The ticket bounds when the request may start: DNS/HTTP cannot begin at or after dispatchBy.
          const { at, dispatchBy: granted } = admission;
          if (!isTime(at) || !isTime(granted)) return none('dispatch_expired');
          const dispatchBy = Math.min(granted, at + APPLE_DISPATCH_LAG_MS, bindingExpiresAt, effectiveDeadline);
          const t = sample();
          if (t === null || t < Math.max(start, at)) return none('clock_regressed');
          if (t >= dispatchBy) return none('dispatch_expired');
          let out;
          try {
            let spent = false;
            out = await search.search(
              { artist: { entityId: a.entityId, name: a.name }, storefront: cap.storefront },
              { signal, deadlineAt: Math.min(effectiveDeadline, bindingExpiresAt), dispatchBy, budget: { take: () => !spent && (spent = true), slot: (fn) => fn(), used: () => budget.used() }, ...(authorize ? { authorize } : {}) },
            );
          } catch {
            return none('unreachable');
          }
          if (!isRecord(out)) return none('search_mismatch');
          if (out.status === 'unavailable') return none(typeof out.reason === 'string' ? (out.reason as AppleSearchUnavailableReason) : 'search_mismatch');
          const found = verify(out, a, cap.storefront);
          return found ? { result: { anchor: a.handle, status: 'candidates', returned: found.length }, found } : none('search_mismatch');
        });

      const settled = await Promise.all(cap.anchors.map(runAnchor));
      const end = lapsed();
      if (end) return { status: 'unavailable', reason: end === 'owner_expired' ? 'expired' : end };

      const taken = new Set<string>();
      const candidates: OwnedAppleCandidate[] = [];
      const dropped = { duplicate: 0, alreadyShown: 0 };
      for (const { found } of settled) {
        for (const c of found) {
          if (taken.has(c.trackId)) dropped.duplicate += 1;
          else if (cap.shownKeys.has(c.trackId)) dropped.alreadyShown += 1;
          else {
            taken.add(c.trackId);
            let ref: Handle;
            try {
              ref = newHandle();
            } catch {
              return { status: 'unavailable', reason: 'invalid_context' };
            }
            if (!isHandle(ref) || cap.reservedHandles.has(ref) || candidates.some((x) => x.ref === ref)) return { status: 'unavailable', reason: 'invalid_context' };
            candidates.push(freezeCandidate({ ...c, ref }));
          }
        }
      }
      const batch: OwnedAppleCandidateBatch = Object.freeze({
        kind: APPLE_BATCH_KIND,
        planId: cap.planId,
        poolId: cap.poolId,
        executeRef: cap.executeRef,
        storefront: cap.storefront,
        owner,
        synthetic: Object.freeze({ pool: cap.poolSynthetic, transport: syntheticTransport }),
        anchors: Object.freeze(settled.map((s) => Object.freeze(s.result))),
        candidates: Object.freeze(candidates),
        dropped: Object.freeze(dropped),
      });
      trustedBatches.set(batch, Object.freeze({ planId: cap.planId, poolId: cap.poolId, executeRef: cap.executeRef, owner, capturedAt: start, validUntil, signal, candidates: new Map(candidates.map((c) => [c.ref, c])) }));
      for (const c of candidates) trustedCandidates.set(c, batch);
      return { status: 'batch', batch };
    },
  };
}

/** Re-checks a search answer against this very request and copies out only the retained scalar fields. */
function verify(out: Record<string, unknown>, a: Anchor, storefront: string): Retained[] | null {
  if (out.status !== 'candidates' || !isRecord(out.artist) || out.artist.entityId !== a.entityId || out.storefront !== storefront) return null;
  const list = out.candidates;
  if (!Array.isArray(list) || list.length === 0 || list.length > APPLE_SEARCH_LIMIT) return null;
  const artistKey = matchForm(a.name);
  const kept: Retained[] = [];
  const ids = new Set<string>();
  for (const c of list) {
    if (!isRecord(c) || c.sourceKind !== APPLE_SEARCH_SOURCE_KIND || c.storefront !== storefront || !isRecord(c.destination)) return null;
    const { trackId, title, artistName, destination: d } = c as Record<string, unknown> & { destination: Record<string, unknown> };
    if (typeof trackId !== 'string' || !/^[1-9][0-9]{0,14}$/.test(trackId) || ids.has(trackId)) return null;
    if (!isText(title, MAX_TEXT) || !isText(artistName, MAX_TEXT) || matchForm(artistName) !== artistKey) return null;
    const url = canonicalAppleSongUrl(storefront, trackId);
    if (d.kind !== 'apple_music' || d.storefront !== storefront || d.trackId !== trackId || d.url !== url) return null;
    ids.add(trackId);
    kept.push({
      anchor: { handle: a.handle, name: a.name },
      artistEntityId: a.entityId,
      sourceKind: APPLE_SEARCH_SOURCE_KIND,
      title,
      artistName,
      trackId,
      storefront,
      destination: { kind: 'apple_music', storefront, trackId, url },
    });
  }
  return kept;
}
