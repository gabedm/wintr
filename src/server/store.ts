import type {
  Attempt,
  AttemptFailure,
  BriefVersion,
  ChoiceFeedback,
  ChoicePanel,
  CanonicalReference,
  ReferenceAdmission,
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
  RefinementMode,
  RelationshipSource,
  SearchRecord,
  Session,
  ChatDirectory,
  Stage,
  SubmissionStage,
} from '../shared/records.js';
import type { DocTx } from './persistence/docstore.js';
import { DISPATCH_CAPS, LIMITS } from '../shared/records.js';
import { newHandle, newSecret, sha256 } from './ids.js';
import { STAGE_PROVIDER } from './ledger/policy.js';
import { mergeObservation, ObservationWrites, type ObservationWrite, type SubmissionObservation } from './ledger/observation.js';
import { canonicalJson } from './seal.js';
import * as core from './store-core.js';
import type { ActionBinding, BucketState, CoreEnv, FreeActionBinding, Window } from './store-core.js';
import { CHAT_LIMIT, chatItems, initialChatState, validChatTitle, type ChatChange, type ChatChangeResult, type ChatState } from './chat-state.js';

// Ownership/admission domain store. Every method performs its ownership,
// epoch, expiry, version, action-binding, one-active-operation and counting
// checks as one atomic step on individual records (no giant session document).
// The domain transitions live in store-core.ts and are shared by the
// synthetic-only MemoryStore (below) and the Firestore transactional store
// (firestore-store.ts), which runs them inside shared server transactions.

export interface Owner {
  readonly sessionId: Handle;
  readonly epoch: number;
}

export interface SessionBucket {
  readonly chats?: ChatDirectory;
  readonly session: Session;
  readonly journey: Journey | null;
  readonly analysis: ReferenceAnalysis | null;
  readonly attempt: Attempt | null;
  readonly brief: BriefVersion | null;
  readonly checkpoint: IdentityCheckpoint | null;
  readonly searches: readonly SearchRecord[];
  /** The plan/pool shown as the current connection (current brief's plan, else the latest panel's). */
  readonly pool: QlooCandidatePool | null;
  readonly plan: InvestigationPlan | null;
  /** The latest committed panel of the Journey. */
  readonly panel: ChoicePanel | null;
  /** Bounded owned history of the Journey (at most 20 briefs and a handful of pools/plans/panels). */
  readonly briefs: readonly BriefVersion[];
  readonly pools: readonly QlooCandidatePool[];
  readonly plans: readonly InvestigationPlan[];
  readonly panels: readonly ChoicePanel[];
  readonly feedback: readonly ChoiceFeedback[];
}

export type AdmitRejection =
  | 'no_session'
  | 'session_expired'
  | 'operation_active'
  | 'capacity'
  | 'action_conflict'
  | 'stale_operation'
  | 'stale_version'
  | 'not_ready'
  | 'discovery_used'
  | 'discovery_correction_required'
  | 'discovery_retry_unavailable'
  | 'refinement_used'
  | 'feedback_required'
  | 'pool_empty'
  | 'cancelled'
  /** The shared store could not decide (unavailable/corrupt): nothing was admitted. */
  | 'admission_unavailable';

export type AdmitResult =
  | { readonly kind: 'admitted'; readonly journey: Journey; readonly attempt: Attempt; readonly continuation: boolean }
  /** Exact replay of the action that owns the current Attempt. */
  | { readonly kind: 'replay'; readonly attemptId: Handle }
  | { readonly kind: 'rejected'; readonly code: AdmitRejection };

export interface AdmitReferenceInput {
  readonly sessionId: Handle;
  readonly epoch: number;
  readonly now: number;
  readonly reference: ReferenceAdmission;
  readonly listenerCue: string | null;
  readonly actionKeyHash: string;
  readonly inputHash: string;
}

export interface RegisterCaptureInput extends Owner, FreeActionGuard {
  readonly now: number;
  readonly sha256: string;
  readonly frames: number;
}
export type RegisterCaptureResult = { readonly kind: 'registered' | 'replay'; readonly capture: CapturedInput }
  | { readonly kind: 'rejected'; readonly code: FreeRejection };

export interface AdmitDiscoverInput extends Owner {
  readonly now: number;
  readonly briefId: Handle;
  readonly actionKeyHash: string;
  readonly inputHash: string;
}

export interface BriefInput {
  readonly analysisId: Handle;
  readonly relationship: string;
  readonly relationshipSource: RelationshipSource;
  readonly proposedArtists: readonly string[];
  readonly exclusions: readonly string[];
  readonly refinement?: RefinementBasis | null;
}

/**
 * One explicit refinement. The route has already re-validated the sealed
 * identities of the pool being consumed and recomputed its fingerprint; the
 * store binds the admission to that exact fingerprint, the current owner/epoch,
 * brief, latest panel, action key and the single shared Journey allowance.
 */
export interface AdmitRefineInput extends Owner {
  readonly now: number;
  readonly actionKeyHash: string;
  readonly inputHash: string;
  readonly mode: RefinementMode;
  readonly panelId: Handle;
  readonly briefId: Handle;
  /** follow_connection: the positively rated owned choice whose anchor is followed. */
  readonly choice: Handle | null;
  /** correct_direction: a corrected relationship, or null to keep the current one. */
  readonly relationship: { readonly text: string; readonly source: RelationshipSource } | null;
  /** correct_direction: owned anchors of the reused pool explicitly left out. */
  readonly excludedAnchors: readonly Handle[];
  readonly poolFingerprint: string;
}

export interface RefineContext {
  readonly journey: Journey;
  readonly analysis: ReferenceAnalysis;
  /** The refinement brief this Attempt is bound to (immutable basis inside). */
  readonly brief: BriefVersion & { readonly refinement: RefinementBasis };
  readonly fromBrief: BriefVersion;
  readonly fromPanel: ChoicePanel;
  readonly fromPlan: InvestigationPlan;
  readonly fromPool: QlooCandidatePool;
  readonly searches: readonly SearchRecord[];
  /** Every panel already committed in this Journey (for shown-recording exclusions). */
  readonly panels: readonly ChoicePanel[];
}

export type FeedbackResult = 'ok' | 'unchanged' | 'replay' | 'not_found' | FreeRejection;

/** Server-owned binding for one deliberate free action (save/choice), separate from paid actions. */
export interface FreeActionGuard {
  readonly actionKeyHash: string;
  readonly inputHash: string;
}

export type FreeRejection =
  | 'no_session'
  | 'rate_limited'
  | 'action_conflict'
  | 'stale_operation'
  | 'stale_version'
  | 'operation_active'
  | 'capacity'
  /** A panel exists: intent changes go through the explicit refinement, not a plain brief save. */
  | 'panel_committed'
  /** The shared store could not decide: nothing was written. */
  | 'unavailable';

export type BriefSaveResult =
  | {
      /**
       * saved: new immutable version; reselected: a new deliberate action made an
       * existing version current; unchanged: already current (true no-op);
       * replay: exact repeat of an action whose result is still current (no-op).
       */
      readonly kind: 'saved' | 'reselected' | 'unchanged' | 'replay';
      readonly brief: BriefVersion;
      /** The running Attempt that lost authority because intent actually changed. */
      readonly revokedAttemptId: Handle | null;
    }
  | { readonly kind: 'rejected'; readonly code: FreeRejection };

export type ChoiceResult = 'ok' | 'unchanged' | 'replay' | 'not_found' | 'invalid' | FreeRejection;

export interface FreeMutationLimits {
  readonly perSession: number;
  readonly perService: number;
  readonly windowMs: number;
}

export const DEFAULT_FREE_MUTATION_LIMITS: FreeMutationLimits = { perSession: 30, perService: 300, windowMs: 60_000 };

export interface DiscoverContext {
  readonly journey: Journey;
  readonly analysis: ReferenceAnalysis;
  readonly brief: BriefVersion;
  readonly checkpoint: IdentityCheckpoint | null;
  readonly searches: readonly SearchRecord[];
}

/**
 * Reservation of one stage-specific submission under current Attempt authority.
 * `validUntil` is the earliest of the Attempt deadline, the session expiry and
 * (in the shared store) the exposure policy expiry: no send may start at or
 * after it, whatever a later grant says.
 */
export type SubmissionReserve =
  | { readonly ok: true; readonly call: number; readonly validUntil: number }
  | { readonly ok: false; readonly code: 'revoked' | 'capacity' | 'unavailable' };

/**
 * One-use dispatch intent. Only 'send' permits exactly one adapter invocation.
 * 'held' means intent already exists (replay, race loser or lost
 * acknowledgement): never send, the work stays held as unknown.
 */
export type SubmissionGrant = 'send' | 'revoked' | 'held' | 'unavailable';

/** How an invoked submission ended locally. Neither is a known-cost receipt. */
export type SubmissionEnd = 'returned' | 'cancelled';

export type FailureOutcome = 'failed' | 'cancelled' | 'expired';

/** The shared store could not decide a read/revocation; callers must not report success. */
export class StoreUnavailable extends Error {
  constructor() {
    super('store unavailable');
  }
}

export type AnalysisCommit = Pick<ReferenceAnalysis, 'audioAccess' | 'synthetic' | 'observations' | 'relationships' | 'provider'>;

export interface Store {
  /** Immutable request scope; selecting a chat does not mutate server-wide selection. */
  forChat(chat: Handle): Store;
  changeChat(owner: Owner, input: ChatChange, guard: FreeActionGuard, now: number): Promise<ChatChangeResult>;
  /** Null at session capacity; 'rate_limited' when the service free-mutation window is exhausted. */
  createSession(now: number): Promise<{ session: Session; secret: string } | null | 'rate_limited'>;
  findSessionBySecret(secret: string, now: number, purpose?: 'access' | 'revoke'): Promise<{ session: Session; expired: boolean } | null>;
  read(sessionId: Handle, epoch: number, now: number): Promise<SessionBucket | null>;
  /** Minimal read-only owner/epoch/expiry authorization after a possibly delayed content read. */
  authorizeRead(owner: Owner, now: number, directoryRevision?: number): Promise<boolean>;
  /** Trusted POST-operation admission only. Session authority and the caller's
   * bounded quota plan share one transaction; never used by a GET/projection. */
  withAuthorizedOperation?<T>(owner: Owner, now: number, work: (tx: DocTx) => Promise<T>): Promise<T | null>;
  /** Read-only fresh shared authority. Server-owned hints batch reads only;
   * current durable links, ownership and expiry must still agree in full. */
  authorizeCatalogue(owner: Owner, attemptId: Handle, planId: Handle, poolId: Handle, now: number, hint?: { readonly journeyId: Handle; readonly briefId: Handle }): Promise<boolean>;
  /** Fresh shared read after asynchronous provider preparation, immediately before transport. */
  authorizeReference(owner: Owner, attemptId: Handle, reference: CanonicalReference, now: number, hint?: { readonly journeyId: Handle }): Promise<boolean>;
  /** Metadata only; never approves a source or accepts audio bytes. */
  registerCapture(input: RegisterCaptureInput): Promise<RegisterCaptureResult>;
  /** Atomically binds the action key and admits, replays or rejects. */
  admitReference(input: AdmitReferenceInput): Promise<AdmitResult>;
  /** Initial discovery, its eligible retry, or the human-boundary continuation of the current brief. */
  admitDiscover(input: AdmitDiscoverInput): Promise<AdmitResult>;
  /** Revokes the owned current Attempt before returning. False if not owned/current. */
  stopAttempt(sessionId: Handle, epoch: number, attemptId: Handle, now: number): Promise<boolean>;
  /**
   * Revokes by action key. If the action has not been admitted yet, records a
   * cancellation so a later arrival with that key is refused without dispatch.
   */
  stopAction(sessionId: Handle, epoch: number, actionKeyHash: string, now: number): Promise<{ attemptId: Handle | null } | null>;
  /**
   * Reserves counts (and, in the shared store, monetary exposure) for one
   * stage-specific submission, atomically with the current session/epoch/
   * expiry/Attempt/deadline authority.
   */
  reserveSubmission(owner: Owner, attemptId: Handle, stage: SubmissionStage, now: number): Promise<SubmissionReserve>;
  /** Records the one-use dispatch intent atomically with the same authority checks, before the network call. */
  beginSubmission(owner: Owner, attemptId: Handle, call: number, now: number): Promise<SubmissionGrant>;
  /** Releases a reservation whose intent was never recorded (revocation won before dispatch). */
  withdrawSubmission(sessionId: Handle, attemptId: Handle, call: number): Promise<void>;
  /** Accounting only: the invoked adapter ended. Without a known-cost receipt it stays held/unknown; never commits content. */
  endSubmission(sessionId: Handle, attemptId: Handle, call: number, how: SubmissionEnd): Promise<void>;
  /** Accounting only, matched to existing intent; survives revocation. Never settlement. */
  observeSubmission(sessionId: Handle, attemptId: Handle, call: number, observation: unknown): Promise<ObservationWrite>;
  observationHealth(): ReturnType<ObservationWrites['health']>;
  /** Commits only if session epoch, expiry, deadline and the running Attempt are all still current. */
  commitAnalysis(sessionId: Handle, epoch: number, attemptId: Handle, result: AnalysisCommit, now: number): Promise<boolean>;
  settleAttempt(sessionId: Handle, epoch: number, attemptId: Handle, outcome: FailureOutcome, failure: AttemptFailure | null, now: number): Promise<boolean>;
  /**
   * Free immutable brief save, bound to a free action key and guarded by the
   * expected current brief. Only an actual change of intent revokes running work.
   */
  saveBrief(owner: Owner, input: BriefInput, guard: FreeActionGuard & { readonly expectedBriefId: Handle | null }, now: number): Promise<BriefSaveResult>;
  /** Free identity choice/skip/change, bound to a free action key and guarded by the checkpoint revision. */
  chooseArtist(
    owner: Owner,
    input: { checkpointId: Handle; slot: number; choice: Handle | null },
    guard: FreeActionGuard & { readonly expectedRevision: number },
    now: number,
  ): Promise<ChoiceResult>;
  /**
   * Free, independent fit/familiarity save for one exact displayed choice of an
   * owned committed panel, bound to a free action key and guarded by the
   * feedback revision. Never dispatches and never revokes running work.
   */
  saveFeedback(
    owner: Owner,
    input: { panelId: Handle; choice: Handle; fit: Fit; familiarity: Familiarity },
    guard: FreeActionGuard & { readonly expectedRevision: number },
    now: number,
  ): Promise<FeedbackResult>;
  /**
   * Admits one refinement against the single shared Journey allowance: creates
   * the immutable refinement brief (with admitted feedback provenance), makes it
   * current and binds a new refine Attempt to it, atomically. A rejected action
   * spends nothing.
   */
  admitRefine(input: AdmitRefineInput): Promise<AdmitResult>;
  /** Read-only: how an already-bound paid action key would be answered (replay/conflict/stale/cancelled), or null if unbound. */
  checkAction(owner: Owner, actionKeyHash: string, inputHash: string, now: number): Promise<AdmitResult | null>;
  loadRefineContext(owner: Owner, attemptId: Handle, now: number): Promise<RefineContext | null>;
  loadDiscoverContext(owner: Owner, attemptId: Handle, now: number): Promise<DiscoverContext | null>;
  recordSearch(owner: Owner, attemptId: Handle, record: SearchRecord, now: number): Promise<boolean>;
  /** Persists slot state. With awaiting=true the execute ends at awaiting_artist (no lease kept). */
  saveCheckpoint(owner: Owner, attemptId: Handle, checkpoint: IdentityCheckpoint, now: number): Promise<boolean>;
  setStage(owner: Owner, attemptId: Handle, stage: Stage, now: number): Promise<boolean>;
  /**
   * Commits a plan for the Attempt's exact current brief. With a new pool, the
   * pool is stored (created provenance). With pool=null the plan must reuse an
   * existing owned pool by id under its own source brief (reused provenance)
   * and may only narrow its anchors.
   */
  commitPlan(owner: Owner, attemptId: Handle, pool: QlooCandidatePool | null, plan: InvestigationPlan, now: number): Promise<boolean>;
  /**
   * Commits the verified panel for the Attempt's own committed plan: re-checks
   * owner, epoch, expiry, deadline, running Attempt, exact current brief version,
   * the plan/pool binding and that every choice anchor is an owned pool anchor.
   * Ends the execute at complete/no_match.
   */
  commitPanel(owner: Owner, attemptId: Handle, panel: ChoicePanel, now: number): Promise<boolean>;
  /**
   * Revokes the session epoch first, then deletes owned records. Service accounting is unaffected.
   * Resolves the Attempt that was current at revocation (so the caller can abort its local work), or null.
   */
  clearSession(sessionId: Handle): Promise<Handle | null>;
}

export interface MemoryStoreLimits {
  readonly maxSessions: number;
  readonly maxJourneysPerSession: number;
  /** Synthetic service-level caps; a new session never resets these. */
  readonly serviceCaps?: Readonly<Record<ProviderKind, number>>;
  /** Free-mutation limiter (saves, choices, session creation). Stop/Clear/expiry are always exempt. */
  readonly freeMutation?: FreeMutationLimits;
}

interface MemoryBucket extends BucketState {
  actions: Map<string, ActionBinding>;
  freeActions: Map<string, FreeActionBinding>;
}

export const briefHash = core.briefHash;
const clone = core.clone;

/**
 * Process-local store for disabled/synthetic local operation and tests only.
 * It is not shared admission and must never back live provider dispatch.
 */
export class MemoryStore implements Store {
  private readonly chatScope: Handle | null = null;
  private readonly chatStates = new Map<Handle, ChatState>();
  private readonly chatBuckets = new Map<Handle, Map<Handle, MemoryBucket>>();
  readonly kind = 'memory-synthetic-only';
  private readonly bySecretHash = new Map<string, Handle>();
  private readonly buckets = new Map<Handle, MemoryBucket>();
  private readonly service: Record<ProviderKind, number> = { qloo: 0, gemini: 0 };
  private readonly serviceCaps: Readonly<Record<ProviderKind, number>>;
  private readonly freeLimits: FreeMutationLimits;
  /** Service-wide free-mutation window; never reset by Clear or a new session. */
  private readonly serviceFreeWindow: Window = { start: Number.NEGATIVE_INFINITY, count: 0 };
  private readonly env: CoreEnv;
  private readonly observationWrites = new ObservationWrites();
  private readonly accounting = new Map<string, { sessionId: Handle; stage: SubmissionStage; observation: SubmissionObservation | null }>();
  observationHealth() { return this.observationWrites.health(); }
  submissionObservation(attemptId: Handle, call: number) { return clone(this.accounting.get(`${attemptId}_${call}`)?.observation ?? null); }

  constructor(private readonly limits: MemoryStoreLimits) {
    this.serviceCaps = limits.serviceCaps ?? { qloo: 600, gemini: 400 };
    this.freeLimits = limits.freeMutation ?? DEFAULT_FREE_MUTATION_LIMITS;
    this.env = { maxJourneysPerSession: limits.maxJourneysPerSession, takeFree: (b, now) => this.takeFree(b, now) };
  }

  /** Synthetic service-level usage, for tests. Decremented only by a proven withdrawal. */
  serviceUsage(): Readonly<Record<ProviderKind, number>> {
    return { ...this.service };
  }

  forChat(chat: Handle): Store {
    const scoped = Object.create(this) as MemoryStore;
    Object.defineProperty(scoped, 'chatScope', { value: chat });
    return scoped;
  }

  private slot(sessionId: Handle): MemoryBucket | null {
    const root = this.buckets.get(sessionId);
    if (!root) return null;
    const state = this.chatStates.get(sessionId);
    const selected = this.chatScope ?? sessionId;
    const primary = selected === sessionId;
    if (state && ((primary && !state.primary && this.chatScope !== null) || (!primary && !state.others.some(c => c.handle === selected)))) return null;
    const b = primary ? root : this.chatBuckets.get(sessionId)?.get(selected);
    if (!b) return null;
    const all = [root, ...this.chatBuckets.get(sessionId)?.values() ?? []];
    const ownCount = (v: MemoryBucket) => core.recordCount({ ...v, otherRecordCount: 0 });
    b.otherRecordCount = all.filter(v => v !== b).reduce((n, v) => n + ownCount(v), 0) + (state ? chatItems(state, root.session).length : 0);
    b.otherBriefCount = all.filter(v => v !== b).reduce((n, v) => n + v.briefs.length, 0);
    b.otherActiveUntil = Math.max(0, ...all.filter(v => v !== b && v.attempt?.outcome === 'running').map(v => v.attempt!.deadlineAt));
    b.chats = { current: primary && state?.primary === null ? null : selected, revision: state?.revision ?? 0, items: chatItems(state, root.session) };
    return b;
  }

  async changeChat(owner: Owner, input: ChatChange, guard: FreeActionGuard, now: number): Promise<ChatChangeResult> {
    const root = this.buckets.get(owner.sessionId);
    if (!core.owned(root ?? null, owner.sessionId, owner.epoch, now)) return { kind: 'rejected', code: 'no_session' };
    const b = root!;
    const bound = b.freeActions.get(guard.actionKeyHash);
    if (bound) return bound.inputHash === guard.inputHash && bound.result.kind === 'chat'
      ? { kind: 'replay', chat: bound.result.action === 'delete' ? null : bound.result.chatId, revokedAttemptId: null }
      : { kind: 'rejected', code: 'action_conflict' };
    const state = this.chatStates.get(owner.sessionId) ?? initialChatState(b.session);
    // At most20 existing chats can still need deletion after ordinary free
    // bindings are full. Their revocation tombstones have reserved headroom.
    if (b.freeActions.size >= LIMITS.freeActionBindingsPerSession + (input.kind === 'delete' ? CHAT_LIMIT : 0)) return { kind: 'rejected', code: 'capacity' };
    const items = chatItems(state, b.session);
    const item = input.kind === 'create' ? null : items.find(c => c.handle === input.chat);
    if (input.kind !== 'create' && !item) return { kind: 'rejected', code: 'not_found' };
    if (input.kind !== 'create' && item!.revision !== input.expectedRevision) return { kind: 'rejected', code: 'stale_version' };
    if (input.kind === 'rename' && !validChatTitle(input.title)) return { kind: 'rejected', code: 'capacity' };
    const all = [b, ...this.chatBuckets.get(owner.sessionId)?.values() ?? []];
    if (input.kind === 'create' && (items.length >= CHAT_LIMIT || all.reduce((n, v) => n + core.recordCount({ ...v, otherRecordCount: 0 }), 0) + items.length + 1 > LIMITS.liveRecordsPerSession)) return { kind: 'rejected', code: 'capacity' };
    if (input.kind === 'rename' && all.reduce((n, v) => n + core.recordCount({ ...v, otherRecordCount: 0 }), 0) + items.length > LIMITS.liveRecordsPerSession) return { kind: 'rejected', code: 'capacity' };
    // Revocation is never rate limited. Create and rename use the shared free window.
    if (input.kind !== 'delete' && !this.takeFree(b, now)) return { kind: 'rejected', code: 'rate_limited' };
    let id: Handle, revoked: Handle | null = null;
    if (input.kind === 'create') {
      id = newHandle();
      state.others.push({ handle: id, title: 'New chat', createdAt: now, revision: 0, manifest: { journey: null, analysis: null, attempt: null, briefs: [], searches: [], checkpoints: [], pools: [], plans: [], panels: [], feedback: [] } });
      const bucket: MemoryBucket = { session: b.session, journey: null, analysis: null, attempt: null, journeysCreated: b.journeysCreated, counts: b.counts, actions: b.actions, freeActions: b.freeActions, freeWindow: b.freeWindow, briefs: [], searches: [], checkpoints: [], pools: [], plans: [], panels: [], feedback: [] };
      // Shared scalar, just like the shared counters/maps: a new chat cannot replenish it.
      Object.defineProperty(bucket, 'journeysCreated', { enumerable: true, get: () => b.journeysCreated, set: (value: number) => { b.journeysCreated = value; } });
      let buckets = this.chatBuckets.get(owner.sessionId);
      if (!buckets) { buckets = new Map(); this.chatBuckets.set(owner.sessionId, buckets); }
      buckets.set(id, bucket);
    } else {
      id = input.chat;
      if (input.kind === 'rename') {
        const updated = { ...item!, title: input.title, revision: item!.revision + 1 };
        if (id === owner.sessionId) state.primary = updated;
        else Object.assign(state.others.find(c => c.handle === id)!, updated);
      } else {
        const target = id === owner.sessionId ? b : this.chatBuckets.get(owner.sessionId)?.get(id);
        revoked = target?.attempt?.id ?? null;
        if (target) core.cancelRunning(target, now);
        if (id === owner.sessionId) {
          state.primary = null;
          b.journey = b.analysis = b.attempt = null;
          b.briefs = []; b.searches = []; b.checkpoints = []; b.pools = []; b.plans = []; b.panels = []; b.feedback = []; b.captures = [];
        } else {
          state.others = state.others.filter(c => c.handle !== id);
          this.chatBuckets.get(owner.sessionId)?.delete(id);
        }
      }
    }
    state.revision += 1;
    this.chatStates.set(owner.sessionId, state);
    b.freeActions.set(guard.actionKeyHash, { inputHash: guard.inputHash, result: { kind: 'chat', chatId: id, action: input.kind } });
    return { kind: 'ok', chat: input.kind === 'delete' ? null : id, revokedAttemptId: revoked };
  }

  async createSession(now: number) {
    this.sweep(now);
    if (this.buckets.size >= this.limits.maxSessions) return null;
    if (!this.takeFree(null, now)) return 'rate_limited' as const;
    const secret = newSecret();
    const session: Session = { id: newHandle(), secretHash: sha256(secret), createdAt: now, expiresAt: now + LIMITS.sessionLifetimeMs, epoch: 1, revoked: false };
    this.bySecretHash.set(session.secretHash, session.id);
    this.buckets.set(session.id, {
      session,
      journey: null,
      analysis: null,
      attempt: null,
      journeysCreated: 0,
      actions: new Map(),
      briefs: [],
      searches: [],
      checkpoints: [],
      pools: [],
      plans: [],
      panels: [],
      feedback: [],
      counts: { qloo: 0, gemini: 0 },
      freeActions: new Map(),
      freeWindow: { start: Number.NEGATIVE_INFINITY, count: 0 },
    });
    return { session: { ...session }, secret };
  }

  async findSessionBySecret(secret: string, now: number, purpose: 'access' | 'revoke' = 'access') {
    const id = this.bySecretHash.get(sha256(secret));
    const bucket = id === undefined ? undefined : this.buckets.get(id);
    if (!bucket || bucket.session.revoked) return null;
    if (purpose !== 'revoke' && now < bucket.session.createdAt) return null;
    if (now >= bucket.session.expiresAt) {
      await this.clearSession(bucket.session.id);
      return { session: { ...bucket.session }, expired: true };
    }
    return { session: { ...bucket.session }, expired: false };
  }

  async read(sessionId: Handle, epoch: number, now: number): Promise<SessionBucket | null> {
    const b = core.owned(this.slot(sessionId), sessionId, epoch, now);
    core.recoverAttemptDeadline(b, sessionId, epoch, now);
    return b ? clone(core.bucketView(b)) : null;
  }

  async authorizeRead(owner: Owner, now: number, directoryRevision?: number): Promise<boolean> {
    const b = this.slot(owner.sessionId);
    return Number.isSafeInteger(now) && now >= 0 && !!core.owned(b, owner.sessionId, owner.epoch, now) &&
      (directoryRevision === undefined || directoryRevision === b?.chats?.revision);
  }

  async authorizeCatalogue(owner: Owner, attemptId: Handle, planId: Handle, poolId: Handle, now: number, hint?: { readonly journeyId: Handle; readonly briefId: Handle }): Promise<boolean> {
    const bucket = this.slot(owner.sessionId);
    if (hint && (hint.journeyId !== bucket?.journey?.id || hint.briefId !== bucket.journey.currentBriefId)) return false;
    return core.catalogueAuthority(bucket, owner, attemptId, planId, poolId, now);
  }

  async admitReference(input: AdmitReferenceInput) {
    return core.admitReference(this.env, this.slot(input.sessionId), input);
  }

  async registerCapture(input: RegisterCaptureInput): Promise<RegisterCaptureResult> {
    return core.registerCapture(this.env, this.slot(input.sessionId), input);
  }

  async authorizeReference(owner: Owner, attemptId: Handle, reference: CanonicalReference, now: number, hint?: { readonly journeyId: Handle }): Promise<boolean> {
    const bucket = this.slot(owner.sessionId);
    if (hint && hint.journeyId !== bucket?.journey?.id) return false;
    return core.referenceAuthority(bucket, owner, attemptId, reference, now);
  }

  async admitDiscover(input: AdmitDiscoverInput) {
    return core.admitDiscover(this.slot(input.sessionId), input);
  }

  async admitRefine(input: AdmitRefineInput) {
    return core.admitRefine(this.slot(input.sessionId), input);
  }

  async checkAction(owner: Owner, actionKeyHash: string, inputHash: string, now: number) {
    return core.checkAction(this.slot(owner.sessionId), owner, actionKeyHash, inputHash, now);
  }

  async stopAttempt(sessionId: Handle, epoch: number, attemptId: Handle, now: number) {
    return core.stopAttempt(this.slot(sessionId), sessionId, epoch, attemptId, now);
  }

  async stopAction(sessionId: Handle, epoch: number, actionKeyHash: string, now: number) {
    return core.stopAction(this.slot(sessionId), sessionId, epoch, actionKeyHash, now);
  }

  async reserveSubmission(owner: Owner, attemptId: Handle, stage: SubmissionStage, now: number): Promise<SubmissionReserve> {
    const b = core.running(this.slot(owner.sessionId), owner, attemptId, now);
    if (!b) return { ok: false, code: 'revoked' };
    const provider = STAGE_PROVIDER[stage];
    if (!this.count(b, b.journey!, provider, 1)) return { ok: false, code: 'capacity' };
    b.attempt!.calls.push({ provider, stage, state: 'reserved' });
    return { ok: true, call: b.attempt!.calls.length - 1, validUntil: Math.min(b.attempt!.deadlineAt, b.session.expiresAt) };
  }

  async beginSubmission(owner: Owner, attemptId: Handle, call: number, now: number): Promise<SubmissionGrant> {
    const current = this.slot(owner.sessionId)?.attempt;
    const entry = current?.id === attemptId ? current.calls[call] : undefined;
    // An existing intent is an observation only, even after revocation.
    if (entry && (entry.state === 'in_flight' || entry.state === 'returned')) return 'held';
    const b = core.running(this.slot(owner.sessionId), owner, attemptId, now);
    if (!b || !entry || entry.state !== 'reserved') return 'revoked';
    entry.state = 'in_flight';
    this.accounting.set(`${attemptId}_${call}`, { sessionId: owner.sessionId, stage: entry.stage, observation: null });
    if (entry.stage === 'reference_analysis') b.attempt!.dispatch = 'in_flight';
    return 'send';
  }

  async withdrawSubmission(sessionId: Handle, attemptId: Handle, call: number) {
    const b = this.slot(sessionId);
    const entry = b?.attempt?.id === attemptId ? b.attempt.calls[call] : undefined;
    if (!b || !entry || entry.state !== 'reserved') return;
    // Intent was never recorded, so nothing can have been sent: the reservation is released.
    entry.state = 'withdrawn';
    if (entry.stage === 'reference_analysis') b.attempt!.dispatch = 'withdrawn';
    if (b.journey) this.count(b, b.journey, entry.provider, -1);
  }

  async endSubmission(sessionId: Handle, attemptId: Handle, call: number, how: SubmissionEnd) {
    const attempt = this.slot(sessionId)?.attempt;
    const entry = attempt?.id === attemptId ? attempt.calls[call] : undefined;
    // Durable intent revoked before invocation stays held as 'in_flight' (unknown), never released.
    if (entry?.state !== 'in_flight' || how === 'cancelled') return;
    entry.state = 'returned';
    if (entry.stage === 'reference_analysis') attempt!.dispatch = 'returned';
  }

  async commitAnalysis(sessionId: Handle, epoch: number, attemptId: Handle, result: AnalysisCommit, now: number) {
    return core.commitAnalysis(this.slot(sessionId), sessionId, epoch, attemptId, result, now);
  }

  observeSubmission(sessionId: Handle, attemptId: Handle, call: number, raw: unknown): Promise<ObservationWrite> {
    return this.observationWrites.run(async () => {
      if (!Number.isSafeInteger(call) || call < 0) return 'invalid';
      const entry = this.accounting.get(`${attemptId}_${call}`);
      if (!entry || entry.sessionId !== sessionId) return 'not_found';
      const observation = mergeObservation(entry.observation, raw);
      if (!observation || observation.stage !== entry.stage) return 'invalid';
      if (canonicalJson(observation) === canonicalJson(entry.observation)) return 'replay';
      entry.observation = observation;
      return 'stored';
    });
  }

  async settleAttempt(sessionId: Handle, epoch: number, attemptId: Handle, outcome: FailureOutcome, failure: AttemptFailure | null, now: number) {
    return core.settleAttempt(this.slot(sessionId), sessionId, epoch, attemptId, outcome, failure, now);
  }

  async saveBrief(owner: Owner, input: BriefInput, guard: FreeActionGuard & { readonly expectedBriefId: Handle | null }, now: number) {
    return core.saveBrief(this.env, this.slot(owner.sessionId), owner, input, guard, now);
  }

  async chooseArtist(owner: Owner, input: { checkpointId: Handle; slot: number; choice: Handle | null }, guard: FreeActionGuard & { readonly expectedRevision: number }, now: number) {
    return core.chooseArtist(this.env, this.slot(owner.sessionId), owner, input, guard, now);
  }

  async saveFeedback(
    owner: Owner,
    input: { panelId: Handle; choice: Handle; fit: Fit; familiarity: Familiarity },
    guard: FreeActionGuard & { readonly expectedRevision: number },
    now: number,
  ) {
    return core.saveFeedback(this.env, this.slot(owner.sessionId), owner, input, guard, now);
  }

  async loadRefineContext(owner: Owner, attemptId: Handle, now: number) {
    return core.loadRefineContext(this.slot(owner.sessionId), owner, attemptId, now);
  }

  async loadDiscoverContext(owner: Owner, attemptId: Handle, now: number) {
    return core.loadDiscoverContext(this.slot(owner.sessionId), owner, attemptId, now);
  }

  async recordSearch(owner: Owner, attemptId: Handle, record: SearchRecord, now: number) {
    return core.recordSearch(this.slot(owner.sessionId), owner, attemptId, record, now);
  }

  async saveCheckpoint(owner: Owner, attemptId: Handle, checkpoint: IdentityCheckpoint, now: number) {
    return core.saveCheckpoint(this.slot(owner.sessionId), owner, attemptId, checkpoint, now);
  }

  async setStage(owner: Owner, attemptId: Handle, stage: Stage, now: number) {
    return core.setStage(this.slot(owner.sessionId), owner, attemptId, stage, now);
  }

  async commitPlan(owner: Owner, attemptId: Handle, pool: QlooCandidatePool | null, plan: InvestigationPlan, now: number) {
    return core.commitPlan(this.slot(owner.sessionId), owner, attemptId, pool, plan, now);
  }

  async commitPanel(owner: Owner, attemptId: Handle, panel: ChoicePanel, now: number) {
    return core.commitPanel(this.slot(owner.sessionId), owner, attemptId, panel, now);
  }

  async clearSession(sessionId: Handle): Promise<Handle | null> {
    const b = this.buckets.get(sessionId);
    if (!b) return null;
    b.session.revoked = true;
    b.session.epoch += 1;
    if (b.attempt?.outcome === 'running') b.attempt.outcome = 'cancelled';
    this.bySecretHash.delete(b.session.secretHash);
    this.buckets.delete(sessionId);
    this.chatStates.delete(sessionId);
    this.chatBuckets.delete(sessionId);
    return b.attempt?.id ?? null;
  }

  /**
   * Counts (by=1) or releases (by=-1, proven withdrawal only) one submission
   * against Journey, session and service caps atomically.
   */
  private count(b: BucketState, j: Journey, provider: ProviderKind, by: 1 | -1) {
    if (by === 1) {
      if (j.counts[provider] >= DISPATCH_CAPS[provider] || b.counts[provider] >= DISPATCH_CAPS[provider]) return false;
      if (this.service[provider] >= this.serviceCaps[provider]) return false;
    }
    j.counts[provider] = Math.max(0, j.counts[provider] + by);
    b.counts[provider] = Math.max(0, b.counts[provider] + by);
    this.service[provider] = Math.max(0, this.service[provider] + by);
    return true;
  }

  /**
   * Bounded fixed-window free-mutation limiter (per session and service-wide).
   * Stop, Clear and expiry never call this, so they are always exempt.
   */
  private takeFree(b: BucketState | null, now: number): boolean {
    const { perSession, perService, windowMs } = this.freeLimits;
    const service = core.takeWindow(this.serviceFreeWindow, perService, windowMs, now);
    const session = b ? core.takeWindow(b.freeWindow, perSession, windowMs, now) : true;
    if (!service || !session) return false;
    this.serviceFreeWindow.count += 1;
    if (b) b.freeWindow.count += 1;
    return true;
  }

  /** Physical removal of expired sessions happens lazily on later activity. */
  private sweep(now: number) {
    for (const b of [...this.buckets.values()]) if (now >= b.session.expiresAt) void this.clearSession(b.session.id);
  }
}
