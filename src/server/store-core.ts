import type {
  Attempt,
  AttemptFailure,
  BriefVersion,
  ChoiceFeedback,
  ChoicePanel,
  CanonicalReference,
  CapturedInput,
  Familiarity,
  Fit,
  Handle,
  IdentityCheckpoint,
  InvestigationPlan,
  Journey,
  ProviderKind,
  QlooCandidatePool,
  ReferenceAnalysis,
  RefinementBasis,
  SearchRecord,
  SeedSlot,
  Session,
  ChatDirectory,
  Stage,
} from '../shared/records.js';
import { isRecordedReference, LIMITS } from '../shared/records.js';
import { RECORDING } from '../shared/recording.js';
import { canonicalVideoUrl, validateFocus } from '../shared/youtube.js';
import { discoveryAvailability } from './discovery-admission.js';
import { destinationKey, isCanonicalDestination, shownDestinationKey } from './destinations.js';
import { newHandle, sha256 } from './ids.js';
import { recordingExclusionKeys } from './recording-identity.js';
import { canonicalJson } from './seal.js';
import { finishTiming, initialJourneyTiming, timingMilestone, timingPhase, timingRegression } from './journey-timing.js';
import type {
  AdmitDiscoverInput,
  AdmitReferenceInput,
  AdmitRefineInput,
  AdmitRejection,
  AdmitResult,
  AnalysisCommit,
  BriefInput,
  BriefSaveResult,
  ChoiceResult,
  DiscoverContext,
  FailureOutcome,
  FeedbackResult,
  FreeActionGuard,
  FreeRejection,
  Owner,
  RefineContext,
  RegisterCaptureInput,
  RegisterCaptureResult,
  SessionBucket,
} from './store.js';

// Shared, deterministic domain transitions for the ownership/admission Store.
// Each function receives one session's loaded state, performs every ownership,
// epoch, expiry, version, binding, one-active-operation and bound check, and
// mutates that state in place. The process-local MemoryStore runs them on its
// in-memory buckets; the Firestore store runs exactly the same functions on
// state loaded inside one shared transaction and then writes the changed
// individual records. Service-wide concerns (free-write windows, provider
// counts/money) are injected, never kept here.

export interface Bindings<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
}

export interface ActionBinding {
  /** Null for a cancellation recorded before the action arrived. */
  readonly inputHash: string | null;
  readonly attemptId: Handle | null;
}

export type FreeActionResult =
  | { readonly kind: 'capture'; readonly captureId: Handle }
  | { readonly kind: 'chat'; readonly chatId: Handle; readonly action: 'create' | 'rename' | 'delete' }
  | { readonly kind: 'brief'; readonly briefId: Handle }
  | { readonly kind: 'choice'; readonly checkpointId: Handle; readonly revision: number }
  | { readonly kind: 'feedback'; readonly feedbackId: Handle; readonly revision: number };

export interface FreeActionBinding {
  readonly inputHash: string;
  readonly result: FreeActionResult;
}

export interface Window {
  start: number;
  count: number;
}

export interface BucketState {
  /** Legacy buckets omit this metadata-only extension. */
  captures?: CapturedInput[];
  /** Computed transaction-local aggregate bounds/authority; never an authority write on GET. */
  otherActiveUntil?: number;
  otherRecordCount?: number;
  otherBriefCount?: number;
  chats?: ChatDirectory;
  /** Transaction-local signal only; never stored, projected or used to grant authority. */
  timingClockRegressed?: boolean;
  session: Session;
  journey: Journey | null;
  analysis: ReferenceAnalysis | null;
  attempt: Attempt | null;
  journeysCreated: number;
  actions: Bindings<ActionBinding>;
  briefs: BriefVersion[];
  searches: SearchRecord[];
  checkpoints: IdentityCheckpoint[];
  pools: QlooCandidatePool[];
  plans: InvestigationPlan[];
  panels: ChoicePanel[];
  feedback: ChoiceFeedback[];
  /** Session-level submission counts across Journeys; a new Journey cannot reset them. */
  counts: Record<ProviderKind, number>;
  freeActions: Bindings<FreeActionBinding>;
  freeWindow: Window;
}

export interface CoreEnv {
  readonly maxJourneysPerSession: number;
  /** Bounded fixed-window free-mutation limiter (per session and service-wide). Stop/Clear/expiry never call it. */
  takeFree(b: BucketState | null, now: number): boolean;
}

export const clone = <T>(v: T): T => structuredClone(v);

type OwnedFields = { sessionId: Handle; epoch: number; createdAt: number; expiresAt: number };

export const briefHash = (input: BriefInput) =>
  sha256(
    canonicalJson({
      analysisId: input.analysisId,
      relationship: input.relationship,
      source: input.relationshipSource,
      artists: input.proposedArtists,
      exclusions: input.exclusions,
      // Listener-saved briefs hash exactly as before; a refinement brief also binds its immutable basis.
      ...(input.refinement ? { refinement: input.refinement } : {}),
    }),
  );

function revocable(b: BucketState | null, sessionId: Handle, epoch: number, now: number): BucketState | null {
  if (!b || b.session.id !== sessionId || b.session.revoked || b.session.epoch !== epoch || now >= b.session.expiresAt) return null;
  return b;
}
export function owned(b: BucketState | null, sessionId: Handle, epoch: number, now: number): BucketState | null {
  const o = revocable(b, sessionId, epoch, now);
  if (!o || now < o.session.createdAt || (o.journey && now < o.journey.createdAt) || (o.attempt && now < o.attempt.createdAt)) return null;
  return o;
}

/** Owned bucket whose current Attempt is this running one, within its deadline. */
export function running(b: BucketState | null, owner: Owner, attemptId: Handle, now: number): BucketState | null {
  const o = owned(b, owner.sessionId, owner.epoch, now);
  if (!o || !o.journey || o.attempt?.id !== attemptId || o.attempt.outcome !== 'running' || now >= o.attempt.deadlineAt) return null;
  return o;
}

/** Current discovery authority for credential-free metadata, independent of the process-local abort signal. */
export function catalogueAuthority(b: BucketState | null, owner: Owner, attemptId: Handle, planId: Handle, poolId: Handle, now: number): boolean {
  const o = running(b, owner, attemptId, now);
  if (!o || o.attempt!.kind === 'reference') return false;
  const j = o.journey!, plan = o.plans.find(p => p.id === planId), pool = o.pools.find(p => p.id === poolId);
  const brief = o.briefs.find(b => b.id === j.currentBriefId);
  return !!plan && !!pool && !!brief && o.attempt!.briefId === brief.id && plan.briefId === brief.id && plan.briefVersion === brief.version &&
    plan.poolId === pool.id && plan.journeyId === j.id && pool.journeyId === j.id &&
    [plan, pool, brief].every(r => r.sessionId === owner.sessionId && r.epoch === owner.epoch && r.expiresAt === j.expiresAt && now < r.expiresAt);
}

/**
 * One active logical operation. An Attempt past its deadline holds no
 * authority (every dispatch/commit re-checks the deadline), so a worker that
 * crashed or restarted cannot lock the session until expiry.
 */
export const isActive = (b: BucketState, now: number) => b.attempt?.outcome === 'running' && now < b.attempt.deadlineAt;

export function advance(b: BucketState, stage: Stage) {
  if (!b.journey) return;
  b.journey.stage = stage;
  b.journey.revision += 1;
}

export function recordCount(b: BucketState) {
  return (
    (b.otherRecordCount ?? 0) +
    (b.journey ? 1 : 0) +
    (b.analysis ? 1 : 0) +
    (b.attempt ? 1 : 0) +
    b.briefs.length +
    b.searches.length +
    b.checkpoints.length +
    b.pools.length +
    b.plans.length +
    b.panels.length +
    b.feedback.length + (b.captures?.length ?? 0)
  );
}

/** Owned read view (uncloned; callers clone or project). */
export function bucketView(b: BucketState): SessionBucket {
  const briefId = b.journey?.currentBriefId ?? null;
  const panel = b.panels.at(-1) ?? null;
  const plan = b.plans.findLast((p) => p.briefId === briefId) ?? (panel ? (b.plans.find((p) => p.id === panel.planId) ?? null) : null);
  return {
    ...(b.chats ? { chats: b.chats } : {}),
    session: b.session,
    journey: b.journey,
    analysis: b.analysis,
    attempt: b.attempt,
    brief: b.briefs.find((x) => x.id === briefId) ?? null,
    checkpoint: b.checkpoints.find((c) => c.briefId === briefId) ?? null,
    searches: b.searches,
    pool: plan ? (b.pools.find((p) => p.id === plan.poolId) ?? null) : null,
    plan,
    panel,
    briefs: b.briefs,
    pools: b.pools,
    plans: b.plans,
    panels: b.panels,
    feedback: b.feedback,
  };
}

function bindAction(b: BucketState, actionKeyHash: string, inputHash: string): AdmitResult | null {
  const bound = b.actions.get(actionKeyHash);
  if (!bound) return null;
  if (bound.attemptId === null) return { kind: 'rejected', code: 'cancelled' };
  if (bound.inputHash !== inputHash) return { kind: 'rejected', code: 'action_conflict' };
  if (b.attempt?.id === bound.attemptId) return { kind: 'replay', attemptId: bound.attemptId };
  return { kind: 'rejected', code: 'stale_operation' };
}

function newAttempt(b: BucketState, own: OwnedFields, journeyId: Handle, kind: Attempt['kind'], actionKeyHash: string, inputHash: string, briefId: Handle | null, now: number): Attempt {
  return {
    ...own,
    id: newHandle(),
    journeyId,
    kind,
    actionKeyHash,
    inputHash,
    briefId,
    deadlineAt: Math.min(now + LIMITS.executeDeadlineMs, b.session.expiresAt),
    outcome: 'running',
    dispatch: 'not_started',
    calls: [],
    failure: null,
    timing: { version: 1, finishedAt: null, recordedAt: null, finishBasis: null },
  };
}

function insertBrief(b: BucketState, own: OwnedFields, input: BriefInput) {
  const brief: BriefVersion = {
    ...own,
    id: newHandle(),
    journeyId: b.journey!.id,
    version: b.briefs.length + 1,
    analysisId: input.analysisId,
    relationship: input.relationship,
    relationshipSource: input.relationshipSource,
    proposedArtists: [...input.proposedArtists],
    exclusions: [...input.exclusions],
    refinement: input.refinement ? clone(input.refinement) : null,
    contentHash: briefHash(input),
  };
  b.briefs.push(brief);
  b.journey!.currentBriefId = brief.id;
  return brief;
}

/** One terminal transition for product authority and its server timing observation. */
function finishAttempt(b: BucketState, outcome: Attempt['outcome'], failure: AttemptFailure | null, now: number, phase: 'awaiting_listener' | 'closed') {
  const a = b.attempt;
  if (!a || !b.journey || a.outcome !== 'running') return;
  if (b.timingClockRegressed) timingRegression(b.journey);
  finishTiming(b.journey, a, now, phase, now >= a.deadlineAt);
  a.outcome = outcome;
  a.failure = outcome === 'failed' ? failure : null;
}

/** Cancels a running discovery because intent changed; returns the Attempt that lost authority. */
function revokeDiscovery(b: BucketState, now: number): Handle | null {
  if (b.attempt?.outcome === 'running' && b.attempt.kind !== 'reference') {
    finishAttempt(b, 'cancelled', null, now, 'awaiting_listener');
    advance(b, 'cancelled');
    return b.attempt.id;
  }
  return null;
}

export function cancelRunning(b: BucketState, now: number) {
  if (b.attempt?.outcome !== 'running') return;
  finishAttempt(b, 'cancelled', null, now, 'closed');
  advance(b, 'cancelled');
}

// ---------------------------------------------------------------------------
// Admission.

/** Closed own-data boundary, including structurally typed callers with extra raw fields. */
function captureReference(raw: unknown, admission = false): CanonicalReference | null {
  const data = (v: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return null;
    const ds = Object.getOwnPropertyDescriptors(v), got = Reflect.ownKeys(v);
    if (got.length !== keys.length || got.some(k => typeof k !== 'string' || !keys.includes(k) || !Object.hasOwn(ds[k]!, 'value'))) return null;
    return Object.fromEntries(keys.map(k => [k, ds[k]!.value]));
  };
  try {
    // Read kind from its own descriptor only. A getter or prototype never supplies metadata.
    const kind = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'kind') : undefined;
    if (kind) {
      if (Object.hasOwn(kind, 'value') && kind.value === 'streamed') {
        const o = data(raw, admission ? ['kind'] : ['kind', 'receipt']);
        if (!o || (!admission && (typeof o.receipt !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(o.receipt)))) return null;
        return { kind: 'streamed', receipt: admission ? newHandle() : o.receipt as Handle };
      }
      const o = data(raw, ['kind', 'receipt', 'sha256', 'frames']);
      if (!o || o.kind !== 'recorded' || typeof o.receipt !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(o.receipt) ||
        typeof o.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.sha256) || !Number.isSafeInteger(o.frames) ||
        (o.frames as number) < RECORDING.minFrames || (o.frames as number) > RECORDING.maxFrames) return null;
      return { kind: 'recorded', receipt: o.receipt as Handle, sha256: o.sha256, frames: o.frames as number };
    }
    const o = data(raw, ['videoId', 'canonicalUrl', 'focus']);
    if (!o || typeof o.videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(o.videoId) || o.canonicalUrl !== canonicalVideoUrl(o.videoId)) return null;
    const f = data(o.focus, ['start', 'end']);
    if (!f) return null;
    const checked = validateFocus(f);
    return checked.ok ? { videoId: o.videoId, canonicalUrl: o.canonicalUrl as string, focus: checked.focus } : null;
  } catch { return null; }
}

export function referenceAuthority(b: BucketState | null, owner: Owner, attemptId: Handle, reference: CanonicalReference, now: number): boolean {
  if (!Number.isSafeInteger(now) || now < 0) return false;
  const o = running(b, owner, attemptId, now);
  return !!o && o.attempt!.kind === 'reference' && canonicalJson(o.journey!.reference) === canonicalJson(reference);
}

/** Free bounded intake metadata, with one unused receipt per chat. No raw data or source approval. */
export function registerCapture(env: CoreEnv, b: BucketState | null, input: RegisterCaptureInput): RegisterCaptureResult {
  const reject = (code: FreeRejection): RegisterCaptureResult => ({ kind: 'rejected', code });
  const o = owned(b, input.sessionId, input.epoch, input.now);
  if (!o || !Number.isSafeInteger(input.now) || input.now < 0) return reject('no_session');
  const chat = o.chats?.current ?? input.sessionId;
  if (o.chats?.current === null) return reject('stale_operation');
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.frames) || input.frames < RECORDING.minFrames || input.frames > RECORDING.maxFrames) return reject('stale_operation');
  const bound = o.freeActions.get(input.actionKeyHash);
  if (bound) {
    if (bound.inputHash !== input.inputHash || bound.result.kind !== 'capture') return reject('action_conflict');
    const id = bound.result.captureId;
    const capture = o.captures?.find(c => c.id === id);
    return capture && capture.chat === chat && input.now < capture.usableUntil
      ? { kind: 'replay', capture: clone(capture) } : reject('stale_operation');
  }
  if (isActive(o, input.now) || input.now < (o.otherActiveUntil ?? 0)) return reject('operation_active');
  const retained = (o.captures ?? []).filter(c => c.consumedAttempt !== null);
  if (o.freeActions.size >= LIMITS.freeActionBindingsPerSession || recordCount(o) - (o.captures?.length ?? 0) + retained.length + 1 > LIMITS.liveRecordsPerSession) return reject('capacity');
  if (!env.takeFree(o, input.now)) return reject('rate_limited');
  const capture: CapturedInput = { id: newHandle(), sessionId: input.sessionId, epoch: input.epoch, chat,
    createdAt: input.now, expiresAt: o.session.expiresAt, usableUntil: Math.min(o.session.expiresAt, input.now + 5 * 60_000),
    sha256: input.sha256, frames: input.frames, consumedAttempt: null };
  o.captures = [...retained, capture];
  o.freeActions.set(input.actionKeyHash, { inputHash: input.inputHash, result: { kind: 'capture', captureId: capture.id } });
  return { kind: 'registered', capture: clone(capture) };
}

export function admitReference(env: CoreEnv, b: BucketState | null, input: AdmitReferenceInput): AdmitResult {
  if (!b || b.session.revoked || b.session.epoch !== input.epoch) return { kind: 'rejected', code: 'no_session' };
  if (input.now >= b.session.expiresAt) return { kind: 'rejected', code: 'session_expired' };
  if (!owned(b, input.sessionId, input.epoch, input.now)) return { kind: 'rejected', code: 'stale_operation' };
  if (b.chats?.current === null) return { kind: 'rejected', code: 'not_ready' };
  const reference = captureReference(input.reference, true);
  if (!reference) return { kind: 'rejected', code: 'stale_operation' };
  const bound = bindAction(b, input.actionKeyHash, input.inputHash);
  if (bound) return bound;
  const receipt = isRecordedReference(reference) ? reference.receipt : null;
  const capture = receipt ? b.captures?.find(c => c.id === receipt) : null;
  if (isRecordedReference(reference) && (!capture || capture.chat !== (b.chats?.current ?? input.sessionId) ||
    capture.sessionId !== input.sessionId || capture.epoch !== input.epoch || input.now < capture.createdAt || input.now >= capture.usableUntil ||
    capture.consumedAttempt !== null || capture.sha256 !== reference.sha256 || capture.frames !== reference.frames)) return { kind: 'rejected', code: 'stale_operation' };
  if (isActive(b, input.now) || input.now < (b.otherActiveUntil ?? 0)) return { kind: 'rejected', code: 'operation_active' };
  // A reference needs its Journey, Attempt, analysis and (when supplied) its
  // intake brief. Refuse predictable aggregate exhaustion before dispatch.
  if (b.journeysCreated >= env.maxJourneysPerSession || b.actions.size >= LIMITS.liveRecordsPerSession ||
    (b.otherRecordCount ?? 0) + (b.captures?.length ?? 0) + 3 + (input.listenerCue ? 1 : 0) > LIMITS.liveRecordsPerSession ||
    (b.otherBriefCount ?? 0) + (input.listenerCue ? 1 : 0) > LIMITS.briefVersionsPerSession) return { kind: 'rejected', code: 'capacity' };

  const own = { sessionId: input.sessionId, epoch: input.epoch, createdAt: input.now, expiresAt: b.session.expiresAt };
  const journey: Journey = {
    ...own,
    id: newHandle(),
    reference,
    listenerCue: input.listenerCue,
    stage: 'analysing_reference',
    revision: (b.journey?.revision ?? 0) + 1,
    analysisId: null,
    currentBriefId: null,
    counts: { gemini: 0, qloo: 0 },
    discoverRuns: 0,
    clarificationUsed: false,
    refinementUsed: false,
    timing: initialJourneyTiming(input.now),
  };
  const attempt = newAttempt(b, own, journey.id, 'reference', input.actionKeyHash, input.inputHash, null, input.now);
  if (capture) capture.consumedAttempt = attempt.id;
  // A new reference invalidates all dependent evidence from the previous Journey.
  b.journey = journey;
  if (b.timingClockRegressed) timingRegression(journey);
  b.analysis = null;
  b.briefs = [];
  b.searches = [];
  b.checkpoints = [];
  b.pools = [];
  b.plans = [];
  b.panels = [];
  b.feedback = [];
  b.attempt = attempt;
  b.journeysCreated += 1;
  b.actions.set(input.actionKeyHash, { inputHash: input.inputHash, attemptId: attempt.id });
  return { kind: 'admitted', journey: clone(journey), attempt: clone(attempt), continuation: false };
}

export function admitDiscover(b: BucketState | null, input: AdmitDiscoverInput): AdmitResult {
  if (!b || b.session.revoked || b.session.epoch !== input.epoch) return { kind: 'rejected', code: 'no_session' };
  if (input.now >= b.session.expiresAt) return { kind: 'rejected', code: 'session_expired' };
  if (!owned(b, input.sessionId, input.epoch, input.now)) return { kind: 'rejected', code: 'stale_operation' };
  const bound = bindAction(b, input.actionKeyHash, input.inputHash);
  if (bound) return bound;
  const j = b.journey;
  if (!j || !b.analysis || j.currentBriefId !== input.briefId) return { kind: 'rejected', code: 'stale_version' };
  if (isActive(b, input.now) || input.now < (b.otherActiveUntil ?? 0)) return { kind: 'rejected', code: 'operation_active' };
  if (b.actions.size >= LIMITS.liveRecordsPerSession) return { kind: 'rejected', code: 'capacity' };

  // Recover terminal authority/timing even when the new action must be refused;
  // this never clears dispatch intent, counts or unknown holds.
  recoverAttemptDeadline(b, input.sessionId, input.epoch, input.now);
  const cp = b.checkpoints.find((c) => c.briefId === input.briefId);
  // Only the successful human boundary earns an uncounted continuation. A
  // failed continuation before its first send consumes the one retry instead.
  const continuation = !!cp?.awaiting && b.attempt?.kind === 'discover' && b.attempt.outcome === 'succeeded' && b.attempt.briefId === input.briefId;
  if (!continuation && (j.discoverRuns >= LIMITS.discoverRunsPerJourney || b.panels.length > 0)) return { kind: 'rejected', code: 'discovery_used' };
  const availability = discoveryAvailability(bucketView(b));
  if (availability !== 'available') return { kind: 'rejected', code: availability === 'edit_artists' ? 'discovery_correction_required' : 'discovery_retry_unavailable' };
  if (cp?.awaiting) {
    if (cp.slots.some((s) => s.status === 'ambiguous' && s.chosen === null)) return { kind: 'rejected', code: 'not_ready' };
  }
  if (!continuation) j.discoverRuns += 1;
  if (b.timingClockRegressed) timingRegression(j);
  timingPhase(j, input.now, 'processing');
  const own = { sessionId: input.sessionId, epoch: input.epoch, createdAt: input.now, expiresAt: b.session.expiresAt };
  const attempt = newAttempt(b, own, j.id, 'discover', input.actionKeyHash, input.inputHash, input.briefId, input.now);
  b.attempt = attempt;
  b.actions.set(input.actionKeyHash, { inputHash: input.inputHash, attemptId: attempt.id });
  advance(b, 'resolving_artists');
  return { kind: 'admitted', journey: clone(j), attempt: clone(attempt), continuation };
}

export function admitRefine(b: BucketState | null, input: AdmitRefineInput): AdmitResult {
  const reject = (code: AdmitRejection): AdmitResult => ({ kind: 'rejected', code });
  if (!b || b.session.revoked || b.session.epoch !== input.epoch) return reject('no_session');
  if (input.now >= b.session.expiresAt) return reject('session_expired');
  if (!owned(b, input.sessionId, input.epoch, input.now)) return reject('stale_operation');
  const bound = bindAction(b, input.actionKeyHash, input.inputHash);
  if (bound) return bound;
  const j = b.journey;
  if (!j || !b.analysis) return reject('stale_version');
  // One active operation and one shared allowance are decided before version staleness:
  // an admitted refinement has already moved the current brief.
  if (isActive(b, input.now) || input.now < (b.otherActiveUntil ?? 0)) return reject('operation_active');
  if (j.refinementUsed) return reject('refinement_used');
  const panel = b.panels.at(-1);
  if (!panel || panel.id !== input.panelId || panel.journeyId !== j.id) return reject('stale_version');
  if (j.currentBriefId !== input.briefId || panel.briefId !== input.briefId) return reject('stale_version');
  const fromBrief = b.briefs.find((x) => x.id === panel.briefId);
  const plan = b.plans.find((p) => p.id === panel.planId);
  const pool = plan ? b.pools.find((p) => p.id === plan.poolId) : undefined;
  if (!fromBrief || !plan || !pool || plan.provenance.analysisId !== b.analysis.id) return reject('stale_version');
  // The route re-validated the sealed identities of exactly this pool state.
  if (pool.fingerprint !== input.poolFingerprint || input.now >= pool.expiresAt) return reject('stale_version');

  const feedbackFor = (choice: Handle) => b.feedback.find((f) => f.panelId === panel.id && f.choiceHandle === choice);
  let followAnchor: Handle | null = null;
  let proposedArtists = [...fromBrief.proposedArtists];
  let exclusions = [...fromBrief.exclusions];
  let relationship = fromBrief.relationship;
  let relationshipSource = fromBrief.relationshipSource;
  if (input.mode === 'follow_connection') {
    const choice = panel.choices.find((c) => c.handle === input.choice);
    if (!choice) return reject('stale_version');
    // A positive, accepted, owned choice is required; familiarity does not matter.
    if (feedbackFor(choice.handle)?.fit !== 'like') return reject('feedback_required');
    const anchor = pool.artists.find((a) => a.handle === choice.anchor.handle);
    if (!anchor || !plan.anchors.some((a) => a.handle === anchor.handle)) return reject('stale_version');
    followAnchor = anchor.handle;
    const starting = pool.seeds.find((s) => s.role === 'starting');
    proposedArtists = [...(starting ? [starting.name] : []), anchor.identity.name];
  } else {
    if (input.choice !== null) return reject('stale_version');
    const anchors = new Set(plan.anchors.map((a) => a.handle));
    if (input.excludedAnchors.some((h) => !anchors.has(h))) return reject('stale_version');
    if (plan.anchors.every((a) => input.excludedAnchors.includes(a.handle))) return reject('pool_empty');
    const names = plan.anchors.filter((a) => input.excludedAnchors.includes(a.handle)).map((a) => a.name);
    exclusions = [...new Set([...exclusions, ...names])].slice(0, LIMITS.exclusions);
    if (input.relationship) {
      relationship = input.relationship.text;
      relationshipSource = input.relationship.source;
    }
  }
  if (b.actions.size >= LIMITS.liveRecordsPerSession || b.briefs.length + (b.otherBriefCount ?? 0) >= LIMITS.briefVersionsPerSession) return reject('capacity');
  // Room for the refinement brief, its pool (follow), plan and panel.
  if (recordCount(b) + 4 > LIMITS.liveRecordsPerSession) return reject('capacity');

  const own = { sessionId: input.sessionId, epoch: input.epoch, createdAt: input.now, expiresAt: b.session.expiresAt };
  const refinement: RefinementBasis = {
    mode: input.mode,
    fromPanelId: panel.id,
    fromBriefId: fromBrief.id,
    fromPlanId: plan.id,
    followChoice: input.mode === 'follow_connection' ? input.choice : null,
    followAnchor,
    excludedAnchors: input.mode === 'correct_direction' ? [...input.excludedAnchors] : [],
    admittedFeedback: panel.choices.flatMap((c) => {
      const f = feedbackFor(c.handle);
      return f && (f.fit !== null || f.familiarity !== null) ? [{ choice: c.handle, fit: f.fit, familiarity: f.familiarity }] : [];
    }),
  };
  recoverAttemptDeadline(b, input.sessionId, input.epoch, input.now);
  if (b.timingClockRegressed) timingRegression(j);
  timingPhase(j, input.now, 'processing');
  const brief = insertBrief(b, own, { analysisId: b.analysis.id, relationship, relationshipSource, proposedArtists, exclusions, refinement });
  // The single shared allowance is claimed atomically with the admission and never released.
  j.refinementUsed = true;
  const attempt = newAttempt(b, own, j.id, 'refine', input.actionKeyHash, input.inputHash, brief.id, input.now);
  b.attempt = attempt;
  b.actions.set(input.actionKeyHash, { inputHash: input.inputHash, attemptId: attempt.id });
  advance(b, input.mode === 'follow_connection' ? 'retrieving_taste' : 'finding_tracks');
  return { kind: 'admitted', journey: clone(j), attempt: clone(attempt), continuation: false };
}

export function checkAction(b: BucketState | null, owner: Owner, actionKeyHash: string, inputHash: string, now: number): AdmitResult | null {
  const o = owned(b, owner.sessionId, owner.epoch, now);
  if (!o) return { kind: 'rejected', code: 'no_session' };
  return bindAction(o, actionKeyHash, inputHash);
}

// ---------------------------------------------------------------------------
// Revocation (never throttled).

export function stopAttempt(b: BucketState | null, sessionId: Handle, epoch: number, attemptId: Handle, now: number): boolean {
  const o = revocable(b, sessionId, epoch, now);
  if (!o || o.attempt?.id !== attemptId) return false;
  cancelRunning(o, now);
  return true;
}

export function stopAction(b: BucketState | null, sessionId: Handle, epoch: number, actionKeyHash: string, now: number): { attemptId: Handle | null } | null {
  const o = revocable(b, sessionId, epoch, now);
  if (!o) return null;
  const bound = o.actions.get(actionKeyHash);
  if (!bound) {
    if (o.actions.size >= LIMITS.liveRecordsPerSession) return null;
    o.actions.set(actionKeyHash, { inputHash: null, attemptId: null });
    return { attemptId: null };
  }
  // Session-wide replay tombstones survive chat deletion, but they do not
  // grant this chat authority to stop another chat's current worker.
  if (bound.attemptId !== null && o.attempt?.id !== bound.attemptId) return null;
  if (bound.attemptId !== null) cancelRunning(o, now);
  return { attemptId: bound.attemptId };
}

// ---------------------------------------------------------------------------
// Guarded commits.

export function commitAnalysis(b: BucketState | null, sessionId: Handle, epoch: number, attemptId: Handle, result: AnalysisCommit, now: number): boolean {
  const o = owned(b, sessionId, epoch, now);
  if (!o || !o.journey || o.attempt?.id !== attemptId || o.attempt.kind !== 'reference' || o.attempt.outcome !== 'running') return false;
  if (now >= o.attempt.deadlineAt) return false;
  // Free writes in another chat can consume room while a provider is working.
  // Close honestly without inserting corrupt/over-bound state or refunding
  // any dispatched work, counts or unknown monetary holds.
  if (recordCount(o) + 1 + (o.journey.listenerCue ? 1 : 0) > LIMITS.liveRecordsPerSession ||
    o.briefs.length + (o.otherBriefCount ?? 0) + (o.journey.listenerCue ? 1 : 0) > LIMITS.briefVersionsPerSession) {
    finishAttempt(o, 'failed', 'capacity', now, 'closed'); advance(o, 'failed'); return false;
  }
  const own = { sessionId, epoch, createdAt: now, expiresAt: o.session.expiresAt };
  o.analysis = { ...own, id: newHandle(), journeyId: o.journey.id, createdByAttemptId: attemptId, reference: o.journey.reference, ...clone(result) };
  o.journey.analysisId = o.analysis.id;
  finishAttempt(o, 'succeeded', null, now, 'awaiting_listener');
  timingMilestone(o.journey, now, 'reference_result');
  // A clear cue supplied with the reference is kept as explicit editable intent (no redundant question).
  if (o.journey.listenerCue) {
    const artist = o.analysis.provider?.uncertainArtistName;
    insertBrief(o, own, { analysisId: o.analysis.id, relationship: o.journey.listenerCue, relationshipSource: 'intake_cue', proposedArtists: artist ? [artist] : [], exclusions: [] });
  }
  advance(o, 'awaiting_preference');
  return true;
}

export function settleAttempt(b: BucketState | null, sessionId: Handle, epoch: number, attemptId: Handle, outcome: FailureOutcome, failure: AttemptFailure | null, now: number): boolean {
  const o = owned(b, sessionId, epoch, now);
  if (!o || o.attempt?.id !== attemptId || o.attempt.outcome !== 'running') return false;
  finishAttempt(o, outcome, outcome === 'failed' ? (failure ?? 'adapter_failed') : null, now, 'closed');
  advance(o, outcome === 'cancelled' ? 'cancelled' : outcome === 'expired' ? 'expired' : 'failed');
  return true;
}

/**
 * Recover an orphaned worker on an owned read. Deadline expiry ends only the
 * current logical Attempt; it proves nothing about provider acceptance/cost.
 * Calls, reservations, action bindings, results and allowances stay untouched.
 */
export function recoverAttemptDeadline(b: BucketState | null, sessionId: Handle, epoch: number, now: number): boolean {
  if (!Number.isSafeInteger(now) || now < 0) return false;
  const o = owned(b, sessionId, epoch, now);
  const a = o?.attempt;
  const j = o?.journey;
  if (
    !o || !a || !j || a.outcome !== 'running' || !Number.isSafeInteger(a.deadlineAt) || now < a.deadlineAt ||
    a.sessionId !== sessionId || a.epoch !== epoch || j.sessionId !== sessionId || j.epoch !== epoch ||
    a.journeyId !== j.id || a.briefId !== j.currentBriefId
  ) return false;
  return settleAttempt(o, sessionId, epoch, a.id, 'failed', 'deadline', now);
}

export function loadDiscoverContext(b: BucketState | null, owner: Owner, attemptId: Handle, now: number): DiscoverContext | null {
  const o = running(b, owner, attemptId, now);
  const j = o?.journey;
  if (!o || !j || !o.analysis || o.attempt!.briefId !== j.currentBriefId) return null;
  const brief = o.briefs.find((x) => x.id === j.currentBriefId);
  if (!brief) return null;
  return clone({ journey: j, analysis: o.analysis, brief, checkpoint: o.checkpoints.find((c) => c.briefId === brief.id) ?? null, searches: o.searches });
}

export function loadRefineContext(b: BucketState | null, owner: Owner, attemptId: Handle, now: number): RefineContext | null {
  const o = running(b, owner, attemptId, now);
  const j = o?.journey;
  if (!o || !j || !o.analysis || o.attempt!.kind !== 'refine' || o.attempt!.briefId !== j.currentBriefId) return null;
  const brief = o.briefs.find((x) => x.id === j.currentBriefId);
  const basis = brief?.refinement;
  if (!brief || !basis) return null;
  const fromBrief = o.briefs.find((x) => x.id === basis.fromBriefId);
  const fromPanel = o.panels.find((p) => p.id === basis.fromPanelId);
  const fromPlan = o.plans.find((p) => p.id === basis.fromPlanId);
  const fromPool = fromPlan ? o.pools.find((p) => p.id === fromPlan.poolId) : undefined;
  if (!fromBrief || !fromPanel || !fromPlan || !fromPool) return null;
  return clone({
    journey: j,
    analysis: o.analysis,
    brief: brief as BriefVersion & { refinement: RefinementBasis },
    fromBrief,
    fromPanel,
    fromPlan,
    fromPool,
    searches: o.searches,
    panels: o.panels,
  });
}

export function recordSearch(b: BucketState | null, owner: Owner, attemptId: Handle, record: SearchRecord, now: number): boolean {
  const o = running(b, owner, attemptId, now);
  if (!o || record.journeyId !== o.journey!.id) return false;
  if (o.searches.length >= LIMITS.searchesPerJourney || recordCount(o) >= LIMITS.liveRecordsPerSession) return false;
  if (o.searches.some((s) => s.normalizedQuery === record.normalizedQuery)) return true;
  o.searches.push(clone(record));
  if (o.timingClockRegressed) timingRegression(o.journey!);
  timingPhase(o.journey!, now, 'processing');
  return true;
}

export function saveCheckpoint(b: BucketState | null, owner: Owner, attemptId: Handle, checkpoint: IdentityCheckpoint, now: number): boolean {
  const o = running(b, owner, attemptId, now);
  if (!o || checkpoint.briefId !== o.attempt!.briefId || checkpoint.briefId !== o.journey!.currentBriefId) return false;
  const i = o.checkpoints.findIndex((c) => c.briefId === checkpoint.briefId);
  if (i < 0 && recordCount(o) >= LIMITS.liveRecordsPerSession) return false;
  if (i >= 0) o.checkpoints[i] = clone(checkpoint);
  else o.checkpoints.push(clone(checkpoint));
  if (!checkpoint.awaiting) {
    if (o.timingClockRegressed) timingRegression(o.journey!);
    timingPhase(o.journey!, now, 'processing');
  }
  if (checkpoint.awaiting) {
    // The execute ends before the human wait: no lease, loop or stream remains open.
    o.journey!.clarificationUsed = true;
    finishAttempt(o, 'succeeded', null, now, 'awaiting_listener');
    advance(o, 'awaiting_artist');
  }
  return true;
}

export function setStage(b: BucketState | null, owner: Owner, attemptId: Handle, stage: Stage, now: number): boolean {
  const o = running(b, owner, attemptId, now);
  if (!o) return false;
  if (o.timingClockRegressed) timingRegression(o.journey!);
  timingPhase(o.journey!, now, 'processing');
  advance(o, stage);
  return true;
}

export function commitPlan(b: BucketState | null, owner: Owner, attemptId: Handle, pool: QlooCandidatePool | null, plan: InvestigationPlan, now: number): boolean {
  const o = running(b, owner, attemptId, now);
  if (!o) return false;
  const j = o.journey!;
  const briefId = j.currentBriefId;
  const brief = o.briefs.find((x) => x.id === briefId);
  if (!brief || o.attempt!.briefId !== briefId || plan.briefId !== briefId || plan.briefVersion !== brief.version || plan.journeyId !== j.id) return false;
  if (plan.referenceObservations !== undefined && (!o.analysis || plan.provenance.analysisId !== o.analysis.id ||
    JSON.stringify(plan.referenceObservations) !== JSON.stringify(o.analysis.observations))) return false;
  if (pool) {
    if (plan.poolId !== pool.id || pool.journeyId !== j.id || plan.provenance.poolReuse !== 'created' || pool.sourceBriefId !== briefId) return false;
    if (recordCount(o) + 2 > LIMITS.liveRecordsPerSession) return false;
    o.pools.push(clone(pool));
  } else {
    // Reuse: an existing owned pool under its own creation brief; the plan may only narrow its anchors.
    const reused = o.pools.find((p) => p.id === plan.poolId);
    if (!reused || plan.provenance.poolReuse !== 'reused_same_fingerprint' || plan.provenance.poolSourceBriefId !== reused.sourceBriefId) return false;
    if (brief.refinement?.mode !== 'correct_direction') return false;
    if (plan.anchors.some((a) => !reused.artists.some((r) => r.handle === a.handle && r.identity.name === a.name))) return false;
    if (recordCount(o) + 1 > LIMITS.liveRecordsPerSession) return false;
  }
  o.plans.push(clone(plan));
  if (o.timingClockRegressed) timingRegression(j);
  timingPhase(j, now, 'processing');
  timingMilestone(j, now, 'connection');
  advance(o, 'finding_tracks');
  return true;
}

export function commitPanel(b: BucketState | null, owner: Owner, attemptId: Handle, panel: ChoicePanel, now: number): boolean {
  const o = running(b, owner, attemptId, now);
  if (!o) return false;
  const j = o.journey!;
  const plan = o.plans.find((p) => p.id === panel.planId);
  if (
    !plan ||
    !validPanelPresentation(panel) ||
    o.attempt!.briefId !== j.currentBriefId ||
    plan.briefId !== j.currentBriefId ||
    panel.briefId !== plan.briefId ||
    panel.briefVersion !== plan.briefVersion ||
    panel.poolId !== plan.poolId ||
    panel.attemptId !== attemptId ||
    panel.journeyId !== j.id ||
    panel.choices.length > LIMITS.trackChoicesPerPanel ||
    (panel.outcome === 'choices') !== panel.choices.length > 0 ||
    panel.choices.some((c) => !plan.anchors.some((a) => a.handle === c.anchor.handle) || c.credits.length > LIMITS.creditedArtists || !isCanonicalDestination(c.destination))
  ) {
    return false;
  }
  // Store-level defence: no recording already shown (any upload) or admitted as known can be committed again.
  const excluded = recordingExclusionKeys(plan.recordingExclusions);
  const shownDestinations = new Set(plan.recordingExclusions.shown.map(shownDestinationKey));
  if (panel.choices.some((c) => excluded.has(c.recordingKey) || shownDestinations.has(destinationKey(c.destination)))) return false;
  if (recordCount(o) + 1 > LIMITS.liveRecordsPerSession) return false;
  o.panels.push(clone(panel));
  finishAttempt(o, 'succeeded', null, now, 'awaiting_listener');
  timingMilestone(j, now, 'panel_outcome');
  if (panel.choices.length > 0) timingMilestone(j, now, 'recording_choices');
  advance(o, panel.outcome === 'choices' ? 'complete' : 'no_match');
  return true;
}

// ---------------------------------------------------------------------------
// Free (no-dispatch) actions, each bound to its own key and guarded.

export function saveBrief(env: CoreEnv, b: BucketState | null, owner: Owner, input: BriefInput, guard: FreeActionGuard & { readonly expectedBriefId: Handle | null }, now: number): BriefSaveResult {
  const reject = (code: FreeRejection): BriefSaveResult => ({ kind: 'rejected', code });
  const o = owned(b, owner.sessionId, owner.epoch, now);
  if (!o) return reject('no_session');
  if (!env.takeFree(o, now)) return reject('rate_limited');
  const j = o.journey;

  // Exact replay of an earlier free action never changes current intent.
  const bound = o.freeActions.get(guard.actionKeyHash);
  if (bound) {
    if (bound.inputHash !== guard.inputHash) return reject('action_conflict');
    const r = bound.result;
    const brief = r.kind === 'brief' ? o.briefs.find((x) => x.id === r.briefId) : undefined;
    if (!j || !brief || j.currentBriefId !== brief.id) return reject('stale_operation');
    return { kind: 'replay', brief: clone(brief), revokedAttemptId: null };
  }

  if (!j || !o.analysis || o.analysis.id !== input.analysisId) return reject('stale_version');
  // After a committed panel, intent changes belong to the explicit (shared) refinement.
  if (o.panels.length > 0) return reject('panel_committed');
  if (isActive(o, now) && o.attempt!.kind === 'reference') return reject('operation_active');
  // Optimistic guard: the action must be based on the current confirmed version.
  if (guard.expectedBriefId !== j.currentBriefId) return reject('stale_version');
  if (o.freeActions.size >= LIMITS.freeActionBindingsPerSession) return reject('capacity');

  const hash = briefHash(input);
  const existing = o.briefs.find((x) => x.contentHash === hash);
  let kind: 'saved' | 'reselected' | 'unchanged';
  let brief: BriefVersion;
  let revokedAttemptId: Handle | null = null;
  if (existing && existing.id === j.currentBriefId) {
    kind = 'unchanged';
    brief = existing;
  } else if (existing) {
    // A new deliberate action reselects an existing immutable version: intent changes.
    revokedAttemptId = revokeDiscovery(o, now);
    if (o.timingClockRegressed && j.timing?.phase === 'closed') timingRegression(j);
    if (j.timing?.phase === 'closed') timingPhase(j, now, 'awaiting_listener');
    j.currentBriefId = existing.id;
    advance(o, o.checkpoints.some(c => c.briefId === existing.id && c.awaiting) ? 'awaiting_artist' : 'awaiting_preference');
    kind = 'reselected';
    brief = existing;
  } else {
    if (o.briefs.length + (o.otherBriefCount ?? 0) >= LIMITS.briefVersionsPerSession || recordCount(o) >= LIMITS.liveRecordsPerSession) return reject('capacity');
    // An edit during paid work first revokes that attempt's continuation/commit authority.
    revokedAttemptId = revokeDiscovery(o, now);
    if (o.timingClockRegressed && j.timing?.phase === 'closed') timingRegression(j);
    if (j.timing?.phase === 'closed') timingPhase(j, now, 'awaiting_listener');
    brief = insertBrief(o, { ...owner, createdAt: now, expiresAt: o.session.expiresAt }, input);
    advance(o, 'awaiting_preference');
    kind = 'saved';
  }
  o.freeActions.set(guard.actionKeyHash, { inputHash: guard.inputHash, result: { kind: 'brief', briefId: brief.id } });
  return { kind, brief: clone(brief), revokedAttemptId };
}

export function chooseArtist(
  env: CoreEnv,
  b: BucketState | null,
  owner: Owner,
  input: { checkpointId: Handle; slot: number; choice: Handle | null },
  guard: FreeActionGuard & { readonly expectedRevision: number },
  now: number,
): ChoiceResult {
  const o = owned(b, owner.sessionId, owner.epoch, now);
  if (!o || !o.journey) return 'no_session';
  if (!env.takeFree(o, now)) return 'rate_limited';
  const cp = o.checkpoints.find((c) => c.id === input.checkpointId);

  const bound = o.freeActions.get(guard.actionKeyHash);
  if (bound) {
    if (bound.inputHash !== guard.inputHash) return 'action_conflict';
    const r = bound.result;
    const current = r.kind === 'choice' && cp && r.checkpointId === cp.id && cp.revision === r.revision && cp.briefId === o.journey.currentBriefId;
    return current ? 'replay' : 'stale_operation';
  }

  if (!cp) return 'not_found';
  if (cp.briefId !== o.journey.currentBriefId || !cp.awaiting) return 'stale_version';
  if (isActive(o, now)) return 'operation_active';
  if (guard.expectedRevision !== cp.revision) return 'stale_version';
  const slot = cp.slots[input.slot];
  if (!slot || slot.options.length < 1 || (slot.status !== 'ambiguous' && slot.status !== 'skipped')) return 'invalid';
  if (input.choice !== null && !slot.options.includes(input.choice)) return 'invalid';
  if (o.freeActions.size >= LIMITS.freeActionBindingsPerSession) return 'capacity';
  const next: SeedSlot = input.choice === null ? { ...slot, status: 'skipped', chosen: null } : { ...slot, status: 'ambiguous', chosen: input.choice };
  const unchanged = next.status === slot.status && next.chosen === slot.chosen;
  if (!unchanged) {
    cp.slots = cp.slots.map((s, i) => (i === input.slot ? next : s));
    cp.revision += 1;
    if (o.timingClockRegressed && o.journey.timing?.phase === 'closed') timingRegression(o.journey);
    if (o.journey.timing?.phase === 'closed') timingPhase(o.journey, now, 'awaiting_listener');
    advance(o, 'awaiting_artist');
  }
  o.freeActions.set(guard.actionKeyHash, { inputHash: guard.inputHash, result: { kind: 'choice', checkpointId: cp.id, revision: cp.revision } });
  return unchanged ? 'unchanged' : 'ok';
}

export function saveFeedback(
  env: CoreEnv,
  b: BucketState | null,
  owner: Owner,
  input: { panelId: Handle; choice: Handle; fit: Fit; familiarity: Familiarity },
  guard: FreeActionGuard & { readonly expectedRevision: number },
  now: number,
): FeedbackResult {
  const o = owned(b, owner.sessionId, owner.epoch, now);
  if (!o) return 'no_session';
  if (!env.takeFree(o, now)) return 'rate_limited';
  if (!o.journey) return 'not_found';
  const existing = o.feedback.find((f) => f.panelId === input.panelId && f.choiceHandle === input.choice);

  // Exact replay of an earlier free action never overwrites newer feedback.
  const bound = o.freeActions.get(guard.actionKeyHash);
  if (bound) {
    if (bound.inputHash !== guard.inputHash) return 'action_conflict';
    const r = bound.result;
    if (r.kind !== 'feedback') return 'stale_operation';
    const current = r.feedbackId === '' ? !existing || (existing.fit === null && existing.familiarity === null) : existing?.id === r.feedbackId && existing.revision === r.revision;
    return current ? 'replay' : 'stale_operation';
  }

  const panel = o.panels.find((p) => p.id === input.panelId && p.journeyId === o.journey!.id);
  if (!panel || !panel.choices.some((c) => c.handle === input.choice)) return 'not_found';
  if (guard.expectedRevision !== (existing?.revision ?? 0)) return 'stale_version';
  if (o.freeActions.size >= LIMITS.freeActionBindingsPerSession) return 'capacity';
  let record = existing;
  if (!record) {
    if (input.fit === null && input.familiarity === null) {
      o.freeActions.set(guard.actionKeyHash, { inputHash: guard.inputHash, result: { kind: 'feedback', feedbackId: '' as Handle, revision: 0 } });
      return 'unchanged';
    }
    if (recordCount(o) >= LIMITS.liveRecordsPerSession) return 'capacity';
    record = {
      sessionId: owner.sessionId,
      epoch: owner.epoch,
      createdAt: now,
      expiresAt: o.session.expiresAt,
      id: newHandle(),
      journeyId: o.journey.id,
      panelId: panel.id,
      choiceHandle: input.choice,
      fit: null,
      familiarity: null,
      revision: 0,
      updatedAt: now,
    };
    o.feedback.push(record);
  }
  const unchanged = record.fit === input.fit && record.familiarity === input.familiarity;
  if (!unchanged) {
    record.fit = input.fit;
    record.familiarity = input.familiarity;
    record.revision += 1;
    record.updatedAt = now;
    // Feedback is owned state for the snapshot; it never changes stage or revokes work.
    o.journey.revision += 1;
  }
  o.freeActions.set(guard.actionKeyHash, { inputHash: guard.inputHash, result: { kind: 'feedback', feedbackId: record.id, revision: record.revision } });
  return unchanged ? 'unchanged' : 'ok';
}

/** Fixed-window limiter step for one window (shared helper for both stores). */
export function takeWindow(w: Window, limit: number, windowMs: number, now: number): boolean {
  if (now - w.start >= windowMs) {
    w.start = now;
    w.count = 0;
  }
  return w.count < limit;
}
import { validPanelPresentation } from './persistence/record-schema.js';
