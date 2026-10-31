import type {
  AttemptFailure,
  ChoicePanel,
  CanonicalReference,
  Familiarity,
  Fit,
  Handle,
  IdentityCheckpoint,
  InvestigationPlan,
  ProviderKind,
  QlooCandidatePool,
  ReferenceAnalysis,
  SearchRecord,
  Session,
  Stage,
  SubmissionStage,
} from '../shared/records.js';
import { isRecordedReference, LIMITS } from '../shared/records.js';
import { newHandle, newSecret, sha256 } from './ids.js';
import { CHAT_CLEANUP_KINDS, CHAT_LIMIT, chatItems, emptyManifest, initialChatState, manifestCount, manifestIds, manifestOf, parseChatState, validChatTitle, type ChatChange, type ChatChangeResult, type ChatManifest, type ChatState } from './chat-state.js';
import { createExposureLedger, ledgerComposer, resolvePolicy, type ExposureLedger } from './ledger/ledger.js';
import { STAGE_PROVIDER, type ExposurePolicy } from './ledger/policy.js';
import { planIntent, planObservation, planReserve, planUnknown, planWithdraw, type Plan } from './ledger/transitions.js';
import { ObservationWrites, type ObservationWrite } from './ledger/observation.js';
import type { DocData, DocPath, DocStore, DocTx } from './persistence/docstore.js';
import { decodeLookup, decodeOwned, decodeSessionRoot, encodeOwned, ownedPath, type OwnedKind, type OwnedOwner } from './persistence/owned.js';
import { validAnalysisText, validPanelContent, validRecord, type RecordKind } from './persistence/record-schema.js';
import { canonicalJson } from './seal.js';
import * as core from './store-core.js';
import type { ActionBinding, Bindings, BucketState, CoreEnv, FreeActionBinding, FreeActionResult, Window } from './store-core.js';
import {
  DEFAULT_FREE_MUTATION_LIMITS,
  StoreUnavailable,
  type AdmitDiscoverInput,
  type AdmitReferenceInput,
  type AdmitRefineInput,
  type AdmitResult,
  type AnalysisCommit,
  type BriefInput,
  type BriefSaveResult,
  type ChoiceResult,
  type FailureOutcome,
  type FeedbackResult,
  type FreeActionGuard,
  type FreeMutationLimits,
  type Owner,
  type RegisterCaptureInput,
  type RegisterCaptureResult,
  type SessionBucket,
  type Store,
  type SubmissionEnd,
  type SubmissionGrant,
  type SubmissionReserve,
} from './store.js';

// Shared transactional Store over the Firestore document adapter (W05/F2).
//
// - Each listener record is its own bounded document under the owned envelope
//   (owner, epoch, authoritative expiry, TTL field). A small session root holds
//   scalars, the current pointers and the bounded id manifest; there is no
//   serialized session snapshot. Complete large provider output (reference
//   final text, panel answer/citations/Suggestions) lives in a content
//   document beside its record and is never truncated.
// - Every method is one shared server transaction: all reads (root, keyed
//   bindings, manifest records, service limits, ledger documents) precede all
//   writes. The domain decision is the same pure store-core transition the
//   synthetic MemoryStore runs; only changed records are written.
// - Provider submissions compose current session/epoch/expiry/Attempt/deadline
//   authority with the exposure ledger's stage-specific reservation, and again
//   with its one-use dispatch intent, inside the SAME transaction each time.
// - The clock is re-read on every transaction attempt; a delayed or retried
//   transaction is judged at its own time, so a stale request timestamp can
//   never authorise work after expiry, a deadline or revocation.
// - Clear revokes the epoch and secret lookup atomically first, then deletes
//   in bounded batches, keeping a minimised cleanup receipt (document ids
//   only) if deletion fails. Service accounting is never touched by Clear.
// - Store failure fails closed: no admission, no dispatch, no commit.
// This is real code exercised only against an SDK-shaped fake; it is not
// hosted Firestore acceptance and constructs no client of its own.

const HANDLE = /^[A-Za-z0-9_-]{16,64}$/;
const PENDING_ID = /^[a-z]{4,16}_[A-Za-z0-9_-]{16,64}$/;
const CONTENT_OF: Partial<Record<RecordKind, OwnedKind>> = { analysis: 'analysistext', panel: 'panelcontent' };
const DELETE_BATCH = 100;

class StoreCorrupt extends Error {}

const safe = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
const plain = <T>(v: T): DocData => JSON.parse(JSON.stringify(v)) as DocData;

function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(v)) throw new StoreCorrupt();
  const got = Object.keys(v).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((k, i) => k !== want[i])) throw new StoreCorrupt();
  return v;
}
const handles = (v: unknown, max: number): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !HANDLE.test(x))) throw new StoreCorrupt();
  return [...(v as string[])];
};
const nullableHandle = (v: unknown): string | null => {
  if (v === null) return null;
  if (typeof v !== 'string' || !HANDLE.test(v)) throw new StoreCorrupt();
  return v;
};
const windowOf = (v: unknown): Window => {
  const o = exact(v, ['start', 'count']);
  if (!safe(o.start) || !safe(o.count)) throw new StoreCorrupt();
  return { start: o.start, count: o.count };
};
const countsOf = (v: unknown): Record<ProviderKind, number> => {
  const o = exact(v, ['qloo', 'gemini']);
  if (!safe(o.qloo) || !safe(o.gemini)) throw new StoreCorrupt();
  return { qloo: o.qloo, gemini: o.gemini };
};

interface RootActive {
  captures?: string[];
  chatState?: ChatState;
  state: 'active';
  secretHash: string;
  createdAt: number;
  journeysCreated: number;
  /** Kept for the shared domain shape only; the exposure ledger's session scope is the count authority here. */
  counts: Record<ProviderKind, number>;
  freeWindow: Window;
  journey: string | null;
  analysis: string | null;
  attempt: string | null;
  briefs: string[];
  searches: string[];
  checkpoints: string[];
  pools: string[];
  plans: string[];
  panels: string[];
  feedback: string[];
  bindings: string[];
  freeBindings: string[];
}
/** Minimised cleanup receipt after revocation: owned document ids still to delete, nothing else. */
interface RootRevoked {
  state: 'revoked';
  pending: string[];
}
type Root = RootActive | RootRevoked;

const ACTIVE_KEYS = [
  'state',
  'secretHash',
  'createdAt',
  'journeysCreated',
  'counts',
  'freeWindow',
  'journey',
  'analysis',
  'attempt',
  'briefs',
  'searches',
  'checkpoints',
  'pools',
  'plans',
  'panels',
  'feedback',
  'bindings',
  'freeBindings',
];

function parseRoot(body: DocData, sessionId: Handle, expiresAt: number): Root {
  if (body.state === 'revoked') {
    const o = exact(body, ['state', 'pending']);
    if (!Array.isArray(o.pending) || o.pending.length > 512 || o.pending.some((x) => typeof x !== 'string' || !PENDING_ID.test(x))) throw new StoreCorrupt();
    return { state: 'revoked', pending: [...(o.pending as string[])] };
  }
  const o = exact(body, [...ACTIVE_KEYS, ...(Object.hasOwn(body, 'chatState') ? ['chatState'] : []), ...(Object.hasOwn(body, 'captures') ? ['captures'] : [])]);
  const R = LIMITS.liveRecordsPerSession;
  if (o.state !== 'active' || typeof o.secretHash !== 'string' || !HANDLE.test(o.secretHash) || !safe(o.createdAt) || !safe(o.journeysCreated)) throw new StoreCorrupt();
  const root: RootActive = {
    state: 'active',
    secretHash: o.secretHash,
    createdAt: o.createdAt,
    journeysCreated: o.journeysCreated,
    counts: countsOf(o.counts),
    freeWindow: windowOf(o.freeWindow),
    journey: nullableHandle(o.journey),
    analysis: nullableHandle(o.analysis),
    attempt: nullableHandle(o.attempt),
    briefs: handles(o.briefs, LIMITS.briefVersionsPerSession),
    searches: handles(o.searches, R),
    checkpoints: handles(o.checkpoints, R),
    pools: handles(o.pools, R),
    plans: handles(o.plans, R),
    panels: handles(o.panels, R),
    feedback: handles(o.feedback, R),
    bindings: handles(o.bindings, R),
    freeBindings: handles(o.freeBindings, LIMITS.freeActionBindingsPerSession + (Object.hasOwn(o, 'chatState') ? CHAT_LIMIT : 0)),
    ...(Object.hasOwn(o, 'captures') ? { captures: handles(o.captures, R) } : {}),
  };
  if (Object.hasOwn(o, 'chatState')) root.chatState = parseChatState(o.chatState, { id: sessionId, epoch: 1, createdAt: root.createdAt, expiresAt, secretHash: root.secretHash, revoked: false }, root);
  return root;
}

/** No mutable server-wide selection. Missing scope means the legacy primary only. */
function selectedManifest(root: RootActive, sessionId: Handle, scope: Handle | null): ChatManifest | null {
  if (scope === null || scope === sessionId) return root.chatState?.primary === null && scope !== null ? null : manifestOf(root);
  return root.chatState?.others.find(c => c.handle === scope)?.manifest ?? null;
}

/**
 * Strict record checks on every read: the complete per-kind schema (required
 * fields, exact types, ranges, enums), ownership, epoch and cross-field
 * invariants. Nothing is coerced or defaulted.
 */
function recordBody(kind: RecordKind, body: DocData, handle: string, owner: OwnedOwner, sessionExpiresAt: number): DocData {
  if (!validRecord(kind, body, handle, { ...owner, sessionExpiresAt })) throw new StoreCorrupt();
  return body;
}

/**
 * Service-wide limits. `live` registers the expiry of every session that may
 * still be live (at most maxSessions entries): admission prunes expired
 * entries and refuses when the remaining count reaches the cap, so the number
 * of simultaneously unexpired sessions can never exceed it. A cleared
 * session's slot is conservatively kept until its own expiry.
 */
interface ServiceLimits {
  live: number[];
  free: Window;
}
const MAX_LIVE_REGISTRY = 5000;
function parseServiceLimits(d: DocData | null): ServiceLimits {
  if (d === null) return { live: [], free: { start: 0, count: 0 } };
  const o = exact(d, ['live', 'free']);
  if (!Array.isArray(o.live) || o.live.length > MAX_LIVE_REGISTRY || !o.live.every(safe)) throw new StoreCorrupt();
  return { live: [...(o.live as number[])], free: windowOf(o.free) };
}

function parseActionBinding(b: DocData): ActionBinding {
  const o = exact(b, ['inputHash', 'attemptId']);
  const inputHash = o.inputHash;
  if (inputHash !== null && (typeof inputHash !== 'string' || inputHash.length === 0 || inputHash.length > 128)) throw new StoreCorrupt();
  // A cancellation binding has neither; an admitted one has both.
  if ((inputHash === null) !== (o.attemptId === null)) throw new StoreCorrupt();
  return { inputHash, attemptId: nullableHandle(o.attemptId) as Handle | null };
}
function parseFreeBinding(b: DocData): FreeActionBinding {
  const o = exact(b, ['inputHash', 'result']);
  if (typeof o.inputHash !== 'string' || o.inputHash.length === 0 || o.inputHash.length > 128 || !isObject(o.result)) throw new StoreCorrupt();
  const r = o.result;
  const ok =
    (r.kind === 'brief' && Object.keys(r).length === 2 && nullableHandle(r.briefId) !== null) ||
    (r.kind === 'capture' && Object.keys(r).length === 2 && nullableHandle(r.captureId) !== null) ||
    (r.kind === 'choice' && Object.keys(r).length === 3 && nullableHandle(r.checkpointId) !== null && safe(r.revision)) ||
    (r.kind === 'chat' && Object.keys(r).length === 3 && nullableHandle(r.chatId) !== null && ['create', 'rename', 'delete'].includes(r.action as string)) ||
    // feedbackId '' records an unchanged no-op save.
    (r.kind === 'feedback' && Object.keys(r).length === 3 && (r.feedbackId === '' || nullableHandle(r.feedbackId) !== null) && safe(r.revision));
  if (!ok) throw new StoreCorrupt();
  return { inputHash: o.inputHash, result: r as unknown as FreeActionResult };
}

/** Bindings view over the keys preloaded in this transaction plus the manifest count. */
class LoadedBindings<V> implements Bindings<V> {
  readonly added = new Map<string, V>();
  constructor(
    private readonly loaded: ReadonlyMap<string, V>,
    private readonly preloaded: ReadonlySet<string>,
    private readonly base: number,
  ) {}
  get(key: string) {
    if (!this.preloaded.has(key)) throw new Error('binding read outside the transaction read set');
    return this.added.get(key) ?? this.loaded.get(key);
  }
  set(key: string, value: V) {
    if (!this.preloaded.has(key)) throw new Error('binding write outside the transaction read set');
    this.added.set(key, value);
  }
  get size() {
    return this.base + [...this.added.keys()].filter((k) => !this.loaded.has(k)).length;
  }
}

interface LoadOpts {
  readonly revocation?: boolean;
  readonly paid?: readonly string[];
  readonly free?: readonly string[];
  readonly service?: boolean;
  readonly content?: boolean;
}

interface Loaded {
  readonly manifest?: ChatManifest;
  readonly sessionId: Handle;
  readonly epoch: number;
  readonly expiresAt: number;
  /** Server time sampled after every read of this load completed; decisions use it. */
  readonly t: number;
  readonly root: Root;
  readonly rootJson: string;
  /** Null when revoked. */
  readonly bucket: BucketState | null;
  /** Only an active (unrevoked, unexpired) session's records are ever rewritten. */
  readonly writable: boolean;
  readonly metaJson: Map<string, string>;
  readonly paid: LoadedBindings<ActionBinding> | null;
  readonly free: LoadedBindings<FreeActionBinding> | null;
  readonly service: ServiceLimits | null;
  readonly serviceJson: string | null;
}

/**
 * Owned links between the loaded records must agree: everything belongs to the
 * current Journey, its pointers resolve to loaded records, and every dependent
 * record names an owned parent. A dangling or foreign link is corruption.
 */
function linked(b: BucketState): boolean {
  const j = b.journey;
  if (j && isRecordedReference(j.reference)) {
    const ref = j.reference;
    const c = b.captures?.find(c => c.id === ref.receipt);
    if (!c || c.sha256 !== ref.sha256 || c.frames !== ref.frames || c.consumedAttempt === null) return false;
  }
  const children = [b.analysis, b.attempt, ...b.briefs, ...b.searches, ...b.checkpoints, ...b.pools, ...b.plans, ...b.panels, ...b.feedback].filter((r) => r !== null);
  if (!j) return children.length === 0;
  const ids = (rs: readonly { id: Handle }[]) => new Set(rs.map((r) => r.id));
  const briefs = ids(b.briefs);
  const pools = ids(b.pools);
  const plans = ids(b.plans);
  const panels = ids(b.panels);
  const t = j.timing;
  const a = b.attempt;
  if (t && a?.timing && (
    (a.outcome === 'running') !== (t.phase === 'processing') ||
    (a.timing.finishBasis === 'clock_regression' && t.quality !== 'partial') ||
    (a.timing.recordedAt !== null && a.timing.recordedAt > t.cursorAt)
  )) return false;
  return (
    children.every((r) => r.journeyId === j.id) &&
    j.analysisId === (b.analysis?.id ?? null) &&
    (j.currentBriefId === null || briefs.has(j.currentBriefId)) &&
    (b.attempt === null || b.attempt.briefId === null || briefs.has(b.attempt.briefId)) &&
    b.briefs.every((x) => x.analysisId === b.analysis?.id) &&
    b.checkpoints.every((c) => briefs.has(c.briefId)) &&
    b.pools.every((p) => briefs.has(p.sourceBriefId)) &&
    b.plans.every((p) => briefs.has(p.briefId) && pools.has(p.poolId)) &&
    b.panels.every((p) => plans.has(p.planId) && briefs.has(p.briefId) && pools.has(p.poolId)) &&
    b.feedback.every((f) => panels.has(f.panelId))
  );
}

/** Splits a record into its bounded authority document and its complete provider content (if any). */
function split(kind: RecordKind, rec: object): { meta: DocData; content: DocData | null } {
  if (kind === 'analysis') {
    const a = rec as ReferenceAnalysis;
    if (!a.provider) return { meta: plain(a), content: null };
    const { finalText, ...provider } = a.provider;
    return { meta: plain({ ...a, provider }), content: plain({ finalText }) };
  }
  if (kind === 'panel') {
    const { answerText, marks, citations, suggestionsHtml, ...meta } = rec as ChoicePanel;
    return { meta: plain(meta), content: plain({ answerText, marks, citations, suggestionsHtml }) };
  }
  return { meta: plain(rec), content: null };
}

/**
 * Rebuilds a record. Authority transactions do not read content documents; the
 * placeholders are never returned to a caller and never written back (content
 * is immutable and only written when its record is created).
 */
function join(kind: RecordKind, meta: DocData, content: DocData | null): unknown {
  if (kind === 'analysis') {
    const a = meta as unknown as ReferenceAnalysis;
    if (!a.provider) return a;
    if (content && !validAnalysisText(content)) throw new StoreCorrupt();
    return { ...a, provider: { ...a.provider, finalText: content ? content.finalText : '' } };
  }
  if (kind === 'panel') {
    if (!content) return { ...meta, answerText: '', marks: [], citations: [], suggestionsHtml: null };
    if (!validPanelContent(content)) throw new StoreCorrupt();
    const panel = { ...meta, ...content } as unknown as ChoicePanel;
    if (!validPanelPresentation(panel)) throw new StoreCorrupt();
    return panel;
  }
  return meta;
}

export interface FirestoreStoreOptions {
  readonly docs: DocStore;
  /** Symbolic service accounting domain (shared by every instance of this service). */
  readonly serviceId: string;
  /** Raw controller exposure policy; validated here. Missing/malformed refuses every submission. */
  readonly policy: unknown;
  /** Injected server clock, re-read on every transaction attempt. */
  readonly clock: () => number;
  readonly maxSessions: number;
  readonly maxJourneysPerSession: number;
  readonly freeMutation?: FreeMutationLimits;
}

const reservationKey = (attemptId: Handle, call: number) => `${attemptId}_c${call}`;

export class FirestoreStore implements Store {
  private readonly chatScope: Handle | null = null;

  forChat(chat: Handle): Store {
    const scoped = Object.create(this) as FirestoreStore;
    Object.defineProperty(scoped, 'chatScope', { value: chat });
    return scoped;
  }
  readonly kind = 'firestore-shared';
  private readonly docs: DocStore;
  private readonly clock: () => number;
  private readonly ledger: ReturnType<typeof ledgerComposer>;
  private readonly observationWrites = new ObservationWrites();
  private readonly localReserved = new Set<string>();
  private readonly localIntents = new Set<string>();
  observationHealth() { return this.observationWrites.health(); }
  private readonly policy: ExposurePolicy | 'missing' | 'invalid';
  private readonly freeLimits: FreeMutationLimits;
  private readonly servicePath: DocPath;

  constructor(private readonly opts: FirestoreStoreOptions) {
    if (!Number.isSafeInteger(opts.maxSessions) || opts.maxSessions < 1 || opts.maxSessions > MAX_LIVE_REGISTRY) throw new RangeError(`maxSessions must be 1..${MAX_LIVE_REGISTRY}`);
    this.docs = opts.docs;
    this.clock = opts.clock;
    this.ledger = ledgerComposer(opts.serviceId);
    this.policy = resolvePolicy(opts.policy);
    this.freeLimits = opts.freeMutation ?? DEFAULT_FREE_MUTATION_LIMITS;
    this.servicePath = { collection: 'wintr_service_limits', id: opts.serviceId };
  }

  /**
   * Controller-only reconciliation seam over the same shared ledger: read
   * unresolved work, settle from a typed validated receipt or mark abandoned
   * work unknown. Never routed to a browser.
   */
  reconciliation(): ExposureLedger {
    return createExposureLedger({ docs: this.docs, policy: this.opts.policy, serviceId: this.opts.serviceId });
  }

  /** Close-only controller capability: never an admission or browser route. */
  async abandonLocalSubmissions(): Promise<void> {
    for (const id of this.localReserved) {
      await this.docs.transact(async tx => {
        const cur = await this.ledger.readCurrent(tx, id, true);
        const plan = cur.reservation?.state === 'reserved'
          ? planWithdraw(cur, { kind: 'intent_never_recorded' }, this.now())
          : cur.reservation?.state === 'intent' && this.localIntents.has(id)
            ? planUnknown(cur, 'cancelled', this.now()) : null;
        if (plan?.ok) this.ledger.apply(tx, id, plan);
      });
    }
    this.localReserved.clear(); this.localIntents.clear();
  }

  /** Startup-only recovery after every possible Attempt deadline has passed.
   * Counts and unknown exposure remain held; no other current worker is ended. */
  async recoverExpiredSubmissions(): Promise<void> {
    const rows = await this.docs.query('wintr_ledger_reservations', [
      { field: 'service', op: '==', value: this.ledger.serviceId },
      { field: 'state', op: 'in', value: ['reserved', 'intent'] },
    ], 500);
    for (const { id } of rows) await this.docs.transact(async tx => {
      const cur = await this.ledger.readCurrent(tx, id, true), r = cur.reservation;
      if (!r || this.now() < r.createdAt + LIMITS.executeDeadlineMs) return;
      const plan = r.state === 'reserved' ? planWithdraw(cur, { kind: 'intent_never_recorded' }, this.now())
        : r.state === 'intent' ? planUnknown(cur, 'abandoned_after_restart', this.now()) : null;
      if (plan?.ok) this.ledger.apply(tx, id, plan);
    });
  }

  // -------------------------------------------------------------------------
  // Paths and transaction plumbing.

  private rootPath = (sessionId: Handle) => ownedPath('session', sessionId);
  private bindingHandle = (sessionId: Handle, kind: 'binding' | 'freebinding', keyHash: string) => sha256(`${sessionId}|${kind}|${keyHash}`);

  /** Current server time; a non-finite or unsafe clock fails closed. */
  private now(): number {
    const c = this.clock();
    if (!Number.isSafeInteger(c) || c < 0) throw new StoreCorrupt();
    return c;
  }

  /**
   * One shared transaction. The callback receives a server-time sampler (never
   * below the request time or an earlier sample of this attempt) instead of a
   * time captured at entry: every decision samples it AFTER the last read it
   * depends on, so slow reads can never let an old time authorise work.
   */
  private tx<T>(now: number, fn: (tx: DocTx, time: (() => number) & { regressed(): boolean }) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(now) || now < 0) return Promise.reject(new StoreCorrupt());
    return this.docs.transact((tx) => {
      let last = now;
      let regressed = false;
      const time = Object.assign(() => {
        const sampled = this.now();
        if (sampled < last) regressed = true;
        return (last = Math.max(last, sampled));
      }, { regressed: () => regressed });
      return fn(tx, time);
    });
  }

  private async load(tx: DocTx, sessionId: Handle, time: () => number, opts: LoadOpts): Promise<Loaded | null> {
    if (!HANDLE.test(sessionId)) return null;
    const paidKeys = [...new Set(opts.paid ?? [])];
    const freeKeys = [...new Set(opts.free ?? [])];
    const first = await tx.getAll([
      this.rootPath(sessionId),
      ...paidKeys.map((k) => ownedPath('binding', this.bindingHandle(sessionId, 'binding', k))),
      ...freeKeys.map((k) => ownedPath('freebinding', this.bindingHandle(sessionId, 'freebinding', k))),
      ...(opts.service ? [this.servicePath] : []),
    ]);
    const env = decodeSessionRoot(first[0] ?? null, sessionId);
    if (!env) return null;
    const root = parseRoot(env.body, sessionId, env.expiresAt);
    const service = opts.service ? parseServiceLimits(first.at(-1) ?? null) : null;
    const base = { sessionId, epoch: env.epoch, expiresAt: env.expiresAt, root, rootJson: canonicalJson(env.body), metaJson: new Map<string, string>(), service, serviceJson: service ? canonicalJson(service) : null };
    if (root.state === 'revoked') return { ...base, t: time(), bucket: null, writable: false, paid: null, free: null };

    const owner = { sessionId, epoch: env.epoch };
    const session: Session = { id: sessionId, secretHash: root.secretHash, createdAt: root.createdAt, expiresAt: env.expiresAt, epoch: env.epoch, revoked: false };
    const manifest = selectedManifest(root, sessionId, this.chatScope);
    if (!manifest) return { ...base, t: time(), bucket: null, writable: false, paid: null, free: null };
    const others = [
      ...(this.chatScope !== null && this.chatScope !== sessionId && root.chatState?.primary !== null ? [manifestOf(root)] : []),
      ...(root.chatState?.others.filter(c => c.handle !== this.chatScope).map(c => c.manifest) ?? []),
    ];
    // Records are only read for a session not already expired; the sampler is monotonic, so a later sample cannot revive it.
    const wanted: [RecordKind, string][] =
      time() >= env.expiresAt
        ? []
        : [
            ...(manifest.journey ? [['journey', manifest.journey] as [RecordKind, string]] : []),
            ...(manifest.analysis ? [['analysis', manifest.analysis] as [RecordKind, string]] : []),
            ...(manifest.attempt ? [['attempt', manifest.attempt] as [RecordKind, string]] : []),
            ...manifest.briefs.map((id): [RecordKind, string] => ['brief', id]),
            ...manifest.searches.map((id): [RecordKind, string] => ['search', id]),
            ...manifest.checkpoints.map((id): [RecordKind, string] => ['checkpoint', id]),
            ...manifest.pools.map((id): [RecordKind, string] => ['pool', id]),
            ...manifest.plans.map((id): [RecordKind, string] => ['plan', id]),
            ...manifest.panels.map((id): [RecordKind, string] => ['panel', id]),
            ...manifest.feedback.map((id): [RecordKind, string] => ['feedback', id]),
            ...(manifest.captures ?? []).map((id): [RecordKind, string] => ['capture', id]),
          ];
    const contentWanted = opts.content ? wanted.filter(([k]) => CONTENT_OF[k]) : [];
    const raws = wanted.length ? await tx.getAll([...wanted.map(([k, id]) => ownedPath(k, id)), ...contentWanted.map(([k, id]) => ownedPath(CONTENT_OF[k]!, id))]) : [];
    const otherRunning = time() >= env.expiresAt ? [] : others.filter(m => m.attempt !== null);
    const otherRaws = otherRunning.length ? await tx.getAll(otherRunning.flatMap(m => [ownedPath('attempt', m.attempt!), ...(m.journey ? [ownedPath('journey', m.journey)] : [])])) : [];
    // All of this load's reads are complete: this is the decision time.
    const t = time();
    if (!opts.revocation && t < root.createdAt) return { ...base, t, bucket: null, writable: false, paid: null, free: null };
    const active = t < env.expiresAt;
    const decodeBinding = <V>(raw: DocData | null | undefined, kind: 'binding' | 'freebinding', key: string, parse: (b: DocData) => V) => {
      const manifest = kind === 'binding' ? root.bindings : root.freeBindings;
      const declared = manifest.includes(this.bindingHandle(sessionId, kind, key));
      const present = raw !== null && raw !== undefined;
      // A lost durable replay record must never turn an already-used key into
      // a fresh action. Orphan records likewise disagree with root authority.
      if (declared !== present) throw new StoreCorrupt();
      if (!present) return undefined;
      const body = decodeOwned(raw, kind, owner, t);
      if (!body) throw new StoreCorrupt();
      return parse(body);
    };
    const paidLoaded = new Map<string, ActionBinding>();
    const freeLoaded = new Map<string, FreeActionBinding>();
    if (active) {
      paidKeys.forEach((k, i) => {
        const v = decodeBinding(first[1 + i], 'binding', k, parseActionBinding);
        if (v) paidLoaded.set(k, v);
      });
      freeKeys.forEach((k, i) => {
        const v = decodeBinding(first[1 + paidKeys.length + i], 'freebinding', k, parseFreeBinding);
        if (v) freeLoaded.set(k, v);
      });
    }
    const paid = new LoadedBindings(paidLoaded, new Set(paidKeys), root.bindings.length);
    const free = new LoadedBindings(freeLoaded, new Set(freeKeys), root.freeBindings.length);
    const bucket: BucketState = {
      chats: { current: this.chatScope === null && root.chatState?.primary === null ? null : this.chatScope ?? sessionId, revision: root.chatState?.revision ?? 0, items: chatItems(root.chatState, session) },
      otherRecordCount: others.reduce((n, m) => n + manifestCount(m), 0) + (root.chatState ? chatItems(root.chatState, session).length + root.chatState.cleanup.filter(id => !id.startsWith('analysistext_') && !id.startsWith('panelcontent_')).length : 0),
      otherBriefCount: others.reduce((n, m) => n + m.briefs.length, 0) + (root.chatState?.cleanup.filter(id => id.startsWith('brief_')).length ?? 0),
      session,
      journey: null,
      analysis: null,
      attempt: null,
      journeysCreated: root.journeysCreated,
      actions: paid,
      briefs: [],
      searches: [],
      checkpoints: [],
      pools: [],
      plans: [],
      panels: [],
      feedback: [],
      ...(manifest.captures ? { captures: [] } : {}),
      counts: { ...root.counts },
      freeActions: free,
      freeWindow: { ...root.freeWindow },
    };
    // An expired session's records are never decoded or rewritten; every core path refuses it first.
    if (!active) return { ...base, t, bucket, writable: false, paid, free };

    let offset = 0;
    bucket.otherActiveUntil = 0;
    for (const m of otherRunning) {
      if (!m.journey) throw new StoreCorrupt();
      const a = decodeOwned(otherRaws[offset++] ?? null, 'attempt', owner, t);
      const j = decodeOwned(otherRaws[offset++] ?? null, 'journey', owner, t);
      if (!a || !j) throw new StoreCorrupt();
      const attempt = recordBody('attempt', a, m.attempt!, owner, env.expiresAt) as unknown as NonNullable<BucketState['attempt']>;
      const journey = recordBody('journey', j, m.journey, owner, env.expiresAt) as unknown as NonNullable<BucketState['journey']>;
      if (attempt.journeyId !== journey.id || journey.analysisId !== m.analysis || (journey.currentBriefId !== null && !m.briefs.includes(journey.currentBriefId)) || (attempt.briefId !== null && !m.briefs.includes(attempt.briefId))) throw new StoreCorrupt();
      if (attempt.outcome === 'running') bucket.otherActiveUntil = Math.max(bucket.otherActiveUntil, attempt.deadlineAt);
    }

    const contents = new Map<string, DocData | null>();
    contentWanted.forEach(([k, id], i) => {
      const raw = raws[wanted.length + i] ?? null;
      const body = raw === null ? null : decodeOwned(raw, CONTENT_OF[k]!, owner, t);
      if (raw !== null && !body) throw new StoreCorrupt();
      contents.set(`${k}_${id}`, body);
    });
    const metaJson = new Map<string, string>();
    wanted.forEach(([kind, id], i) => {
      const body = decodeOwned(raws[i] ?? null, kind, owner, t);
      if (!body) throw new StoreCorrupt();
      const meta = recordBody(kind, body, id, owner, env.expiresAt);
      metaJson.set(`${kind}_${id}`, canonicalJson(meta));
      const content = contents.get(`${kind}_${id}`) ?? null;
      // Content exists exactly when the record carries provider output (every panel; an analysis with a provider result).
      const hasContent = kind === 'panel' || (kind === 'analysis' && meta.provider !== null);
      if (opts.content && hasContent !== (content !== null)) throw new StoreCorrupt();
      const rec = join(kind, meta, content) as never;
      if (kind === 'journey') bucket.journey = rec;
      else if (kind === 'analysis') bucket.analysis = rec;
      else if (kind === 'attempt') bucket.attempt = rec;
      else if (kind === 'brief') bucket.briefs.push(rec);
      else if (kind === 'search') bucket.searches.push(rec);
      else if (kind === 'checkpoint') bucket.checkpoints.push(rec);
      else if (kind === 'pool') bucket.pools.push(rec);
      else if (kind === 'plan') bucket.plans.push(rec);
      else if (kind === 'panel') bucket.panels.push(rec);
      else if (kind === 'capture') (bucket.captures ??= []).push(rec);
      else bucket.feedback.push(rec);
    });
    if (bucket.captures?.some(c => c.chat !== (bucket.chats?.current ?? sessionId))) throw new StoreCorrupt();
    if (!linked(bucket)) throw new StoreCorrupt();
    return { ...base, t, metaJson, bucket, writable: true, paid, free, manifest };
  }

  /** Writes exactly the records, bindings, root and service limits that changed (after all reads). */
  private persist(tx: DocTx, L: Loaded) {
    const b = L.bucket;
    if (!b || !L.writable) return;
    const owner = { sessionId: L.sessionId, epoch: L.epoch };
    const exp = L.expiresAt;
    const seen = new Set<string>();
    const put = (kind: RecordKind, rec: { id: Handle }) => {
      const id = `${kind}_${rec.id}`;
      seen.add(id);
      const { meta, content } = split(kind, rec);
      if (!validRecord(kind, meta, rec.id, { ...owner, sessionExpiresAt: exp })) throw new StoreCorrupt();
      if (L.metaJson.get(id) === canonicalJson(meta)) return;
      tx.set(ownedPath(kind, rec.id), encodeOwned(kind, owner, exp, meta));
      // Complete provider content is immutable: written once, with its record.
      if (content && !L.metaJson.has(id)) tx.set(ownedPath(CONTENT_OF[kind]!, rec.id), encodeOwned(CONTENT_OF[kind]!, owner, exp, content));
    };
    if (b.journey) put('journey', b.journey);
    if (b.analysis) put('analysis', b.analysis);
    if (b.attempt) put('attempt', b.attempt);
    b.briefs.forEach((r) => put('brief', r));
    b.searches.forEach((r) => put('search', r));
    b.checkpoints.forEach((r) => put('checkpoint', r));
    b.pools.forEach((r) => put('pool', r));
    b.plans.forEach((r) => put('plan', r));
    b.panels.forEach((r) => put('panel', r));
    b.feedback.forEach((r) => put('feedback', r));
    b.captures?.forEach((r) => put('capture', r));
    for (const id of L.metaJson.keys()) {
      if (seen.has(id)) continue;
      const cut = id.indexOf('_');
      const kind = id.slice(0, cut) as RecordKind;
      const handle = id.slice(cut + 1);
      tx.delete(ownedPath(kind, handle));
      if (CONTENT_OF[kind]) tx.delete(ownedPath(CONTENT_OF[kind]!, handle));
    }
    const root = L.root as RootActive;
    const bindings = [...root.bindings];
    for (const [key, v] of L.paid?.added ?? []) {
      const h = this.bindingHandle(L.sessionId, 'binding', key);
      if (!bindings.includes(h)) bindings.push(h);
      tx.set(ownedPath('binding', h), encodeOwned('binding', owner, exp, plain({ inputHash: v.inputHash, attemptId: v.attemptId })));
    }
    const freeBindings = [...root.freeBindings];
    for (const [key, v] of L.free?.added ?? []) {
      const h = this.bindingHandle(L.sessionId, 'freebinding', key);
      if (!freeBindings.includes(h)) freeBindings.push(h);
      tx.set(ownedPath('freebinding', h), encodeOwned('freebinding', owner, exp, plain({ inputHash: v.inputHash, result: v.result })));
    }
    const nextManifest: ChatManifest = {
      journey: b.journey?.id ?? null,
      analysis: b.analysis?.id ?? null,
      attempt: b.attempt?.id ?? null,
      briefs: b.briefs.map((r) => r.id),
      searches: b.searches.map((r) => r.id),
      checkpoints: b.checkpoints.map((r) => r.id),
      pools: b.pools.map((r) => r.id),
      plans: b.plans.map((r) => r.id),
      panels: b.panels.map((r) => r.id),
      feedback: b.feedback.map((r) => r.id),
      ...(b.captures ? { captures: b.captures.map(r => r.id) } : {}),
    };
    const next: RootActive = { ...root, journeysCreated: b.journeysCreated, counts: b.counts, freeWindow: b.freeWindow, bindings, freeBindings };
    if (this.chatScope === null || this.chatScope === L.sessionId) Object.assign(next, nextManifest);
    else {
      if (!next.chatState) throw new StoreCorrupt();
      const entry = next.chatState.others.find(c => c.handle === this.chatScope);
      if (!entry) throw new StoreCorrupt();
      entry.manifest = nextManifest;
    }
    const nextBody = plain(next);
    if (canonicalJson(nextBody) !== L.rootJson) tx.set(this.rootPath(L.sessionId), encodeOwned('session', owner, exp, nextBody));
    if (L.service && canonicalJson(L.service) !== L.serviceJson) tx.set(this.servicePath, plain(L.service));
  }

  private env(L: Loaded | null): CoreEnv {
    const { perSession, perService, windowMs } = this.freeLimits;
    return {
      maxJourneysPerSession: this.opts.maxJourneysPerSession,
      takeFree: (b, t) => {
        if (!L?.service) throw new Error('free-write limiter not in the transaction read set');
        const service = core.takeWindow(L.service.free, perService, windowMs, t);
        const session = b ? core.takeWindow(b.freeWindow, perSession, windowMs, t) : true;
        if (!service || !session) return false;
        L.service.free.count += 1;
        if (b) b.freeWindow.count += 1;
        return true;
      },
    };
  }

  /** Loads, runs one pure core transition at the post-read decision time, persists changes. */
  private mutate<T>(sessionId: Handle, now: number, opts: LoadOpts, fn: (b: BucketState | null, t: number, env: CoreEnv) => T): Promise<T> {
    return this.tx(now, async (tx, time) => {
      const L = await this.load(tx, sessionId, time, opts);
      if (L?.bucket) L.bucket.timingClockRegressed = time.regressed();
      const result = fn(L?.bucket ?? null, L ? L.t : time(), this.env(L));
      if (L) this.persist(tx, L);
      return result;
    });
  }

  private async orUnavailable<T>(p: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await p();
    } catch {
      return fallback;
    }
  }

  private async orThrow<T>(p: () => Promise<T>): Promise<T> {
    try {
      return await p();
    } catch {
      throw new StoreUnavailable();
    }
  }

  // -------------------------------------------------------------------------
  // Sessions.

  async createSession(now: number) {
    const secret = newSecret();
    const id = newHandle();
    const secretHash = sha256(secret);
    const result = await this.orThrow(() =>
      this.tx(now, async (tx, time) => {
        const [raw] = await tx.getAll([this.servicePath]);
        const svc = parseServiceLimits(raw ?? null);
        const t = time();
        // Live-session capacity: only registrations not yet expired count; the cap is never exceeded at any instant.
        svc.live = svc.live.filter((expiresAt) => expiresAt > t);
        if (svc.live.length >= this.opts.maxSessions) return null;
        if (!core.takeWindow(svc.free, this.freeLimits.perService, this.freeLimits.windowMs, t)) return 'rate_limited' as const;
        svc.free.count += 1;
        const session: Session = { id, secretHash, createdAt: t, expiresAt: t + LIMITS.sessionLifetimeMs, epoch: 1, revoked: false };
        svc.live.push(session.expiresAt);
        const owner = { sessionId: id, epoch: 1 };
        const root: RootActive = {
          state: 'active',
          secretHash,
          createdAt: t,
          journeysCreated: 0,
          counts: { qloo: 0, gemini: 0 },
          freeWindow: { start: 0, count: 0 },
          journey: null,
          analysis: null,
          attempt: null,
          briefs: [],
          searches: [],
          checkpoints: [],
          pools: [],
          plans: [],
          panels: [],
          feedback: [],
          bindings: [],
          freeBindings: [],
        };
        tx.set(this.servicePath, plain(svc));
        tx.create(this.rootPath(id), encodeOwned('session', owner, session.expiresAt, plain(root)));
        tx.create(ownedPath('secret', secretHash), encodeOwned('secret', owner, session.expiresAt, {}));
        return session;
      }),
    );
    if (result === null || result === 'rate_limited') return result;
    return { session: result, secret };
  }

  async findSessionBySecret(secret: string, now: number, purpose: 'access' | 'revoke' = 'access') {
    const found = await this.orThrow(() =>
      this.tx(now, async (tx, time) => {
        const secretHash = sha256(secret);
        const [raw] = await tx.getAll([ownedPath('secret', secretHash)]);
        const lookup = decodeLookup(raw ?? null, 'secret');
        if (!lookup) return null;
        const sessionId = lookup.sessionId as Handle;
        const [rootRaw] = await tx.getAll([this.rootPath(sessionId)]);
        const env = decodeSessionRoot(rootRaw ?? null, sessionId);
        if (!env) return null;
        const root = parseRoot(env.body, sessionId, env.expiresAt);
        if (root.state !== 'active' || root.secretHash !== secretHash || env.epoch !== lookup.epoch) return null;
        const session: Session = { id: sessionId, secretHash, createdAt: root.createdAt, expiresAt: env.expiresAt, epoch: env.epoch, revoked: false };
        const t = time();
        if (purpose !== 'revoke' && t < root.createdAt) return null;
        return { session, expired: t >= env.expiresAt };
      }),
    );
    if (found?.expired) await this.clearSession(found.session.id);
    return found;
  }

  async read(sessionId: Handle, epoch: number, now: number): Promise<SessionBucket | null> {
    let readAt = now;
    // One extra transaction covers a deadline crossed while the first result
    // was being delivered. Recovery must persist, never be a snapshot-only edit.
    for (let pass = 0; pass < 2; pass += 1) {
      const bucket = await this.orThrow(() =>
        this.mutate(sessionId, readAt, { content: true }, (loaded, t) => {
          const b = core.owned(loaded, sessionId, epoch, t);
          core.recoverAttemptDeadline(b, sessionId, epoch, t);
          return b ? core.clone(core.bucketView(b)) : null;
        }),
      );
      if (!bucket) return null;
      // Final synchronous delivery fence: an unusable clock fails closed;
      // expiry refuses private state even when the result arrives late.
      let current: number;
      try {
        current = Math.max(readAt, this.now());
      } catch {
        throw new StoreUnavailable();
      }
      if (current >= bucket.session.expiresAt) return null;
      if (bucket.attempt?.outcome !== 'running' || current < bucket.attempt.deadlineAt) return bucket;
      readAt = current;
    }
    // Inconsistent current-version authority cannot be repaired by a read.
    throw new StoreUnavailable();
  }

  /** Read only the shared session root; no content, admission, rate counter or authority write. */
  async authorizeRead(owner: Owner, now: number, directoryRevision?: number): Promise<boolean> {
    if (!HANDLE.test(owner.sessionId) || !safe(owner.epoch) || owner.epoch < 1) return false;
    return this.orThrow(async () => {
      const receipt = await this.tx(now, async (tx, time) => {
        const [raw] = await tx.getAll([this.rootPath(owner.sessionId)]);
        if (!raw) return null;
        const env = decodeSessionRoot(raw, owner.sessionId);
        if (!env) throw new StoreCorrupt();
        const root = parseRoot(env.body, owner.sessionId, env.expiresAt);
        const authorizedAt = time();
        if (root.state !== 'active' || env.epoch !== owner.epoch || authorizedAt < root.createdAt || authorizedAt >= env.expiresAt) return null;
        if (!selectedManifest(root, owner.sessionId, this.chatScope) || (directoryRevision !== undefined && directoryRevision !== (root.chatState?.revision ?? 0))) return null;
        return { authorizedAt, expiresAt: env.expiresAt };
      });
      if (!receipt) return false;
      const current = this.now();
      if (current < receipt.authorizedAt) throw new StoreCorrupt();
      return current < receipt.expiresAt;
    });
  }

  /** POST-only quota admission: root authorization and the trusted plan share
   * the same commit. The planner must contain transaction operations only,
   * since SDK conflict retries can invoke it again. authorizeRead stays read-only. */
  async withAuthorizedOperation<T>(owner: Owner, now: number, work: (tx: DocTx) => Promise<T>): Promise<T | null> {
    if (!HANDLE.test(owner.sessionId) || !safe(owner.epoch) || owner.epoch < 1 || typeof work !== 'function') return null;
    return this.orThrow(async () => {
      const receipt = await this.tx(now, async (tx, time) => {
        const [raw] = await tx.getAll([this.rootPath(owner.sessionId)]);
        if (!raw) return null;
        const env = decodeSessionRoot(raw, owner.sessionId);
        if (!env) throw new StoreCorrupt();
        const root = parseRoot(env.body, owner.sessionId, env.expiresAt), authorizedAt = time();
        if (root.state !== 'active' || env.epoch !== owner.epoch || authorizedAt < root.createdAt || authorizedAt >= env.expiresAt || !selectedManifest(root, owner.sessionId, this.chatScope)) return null;
        const value = await work(tx), checkedAt = time();
        if (checkedAt < authorizedAt) throw new StoreCorrupt();
        // Throw after the planner's last awaited read so queued quota writes
        // cannot commit when authority expired during planning. A deadline
        // crossed during commit ACK may still leave a spent, unusable stamp.
        if (checkedAt >= env.expiresAt || time.regressed()) throw new StoreCorrupt();
        return { value, authorizedAt: checkedAt, expiresAt: env.expiresAt };
      });
      if (!receipt) return null;
      const current = this.now(); if (current < receipt.authorizedAt) throw new StoreCorrupt();
      return current < receipt.expiresAt ? receipt.value : null;
    });
  }

  // -------------------------------------------------------------------------
  // Admission (paid action bindings) and revocation.

  async changeChat(owner: Owner, input: ChatChange, guard: FreeActionGuard, now: number): Promise<ChatChangeResult> {
    // Directory mutations always use the legacy root scope, independent of the
    // page being viewed. Every changed manifest still shares this transaction.
    const base = Object.create(this) as FirestoreStore;
    Object.defineProperty(base, 'chatScope', { value: null });
    const result = await this.orUnavailable(() => base.tx(now, async (tx, time): Promise<ChatChangeResult> => {
      const L = await base.load(tx, owner.sessionId, time, { free: [guard.actionKeyHash], service: input.kind !== 'delete' });
      const b = core.owned(L?.bucket ?? null, owner.sessionId, owner.epoch, L?.t ?? time());
      if (!L || !b || L.root.state !== 'active') return { kind: 'rejected', code: 'no_session' };
      const bound = b.freeActions.get(guard.actionKeyHash);
      if (bound) return bound.inputHash === guard.inputHash && bound.result.kind === 'chat'
        ? { kind: 'replay', chat: bound.result.action === 'delete' ? null : bound.result.chatId, revokedAttemptId: null }
        : { kind: 'rejected', code: 'action_conflict' };
      const root = L.root;
      const state = root.chatState ?? initialChatState(b.session);
      const items = chatItems(state, b.session);
      if (b.freeActions.size >= LIMITS.freeActionBindingsPerSession + (input.kind === 'delete' ? CHAT_LIMIT : 0)) return { kind: 'rejected', code: 'capacity' };
      const item = input.kind === 'create' ? null : items.find(c => c.handle === input.chat);
      if (input.kind !== 'create' && !item) return { kind: 'rejected', code: 'not_found' };
      if (input.kind !== 'create' && item!.revision !== input.expectedRevision) return { kind: 'rejected', code: 'stale_version' };
      if (input.kind === 'rename' && !validChatTitle(input.title)) return { kind: 'rejected', code: 'capacity' };
      const records = manifestCount(root) + state.others.reduce((n, c) => n + manifestCount(c.manifest), 0) + state.cleanup.filter(id => !id.startsWith('analysistext_') && !id.startsWith('panelcontent_')).length;
      if (input.kind === 'create' && (items.length >= CHAT_LIMIT || records + items.length + 1 > LIMITS.liveRecordsPerSession)) return { kind: 'rejected', code: 'capacity' };
      if (input.kind === 'rename' && records + items.length > LIMITS.liveRecordsPerSession) return { kind: 'rejected', code: 'capacity' };
      if (input.kind !== 'delete' && !base.env(L).takeFree(b, L.t)) return { kind: 'rejected', code: 'rate_limited' };
      let id: Handle, revoked: Handle | null = null;
      if (input.kind === 'create') {
        id = newHandle();
        state.others.push({ handle: id, title: 'New chat', createdAt: L.t, revision: 0, manifest: emptyManifest() });
      } else {
        id = input.chat;
        if (input.kind === 'rename') {
          const updated = { ...item!, title: input.title, revision: item!.revision + 1 };
          if (id === owner.sessionId) state.primary = updated;
          else Object.assign(state.others.find(c => c.handle === id)!, updated);
        } else {
          const manifest = id === owner.sessionId ? manifestOf(root) : state.others.find(c => c.handle === id)!.manifest;
          revoked = manifest.attempt as Handle | null;
          state.cleanup = [...new Set([...state.cleanup, ...manifestIds(manifest)])];
          if (id === owner.sessionId) {
            state.primary = null;
            b.journey = b.analysis = b.attempt = null;
            b.briefs = []; b.searches = []; b.checkpoints = []; b.pools = []; b.plans = []; b.panels = []; b.feedback = []; b.captures = [];
            // Physical deletion is deliberately after durable revocation. Do
            // not let ordinary replacement cleanup run in this transaction.
            L.metaJson.clear();
          } else state.others = state.others.filter(c => c.handle !== id);
        }
      }
      state.revision += 1;
      root.chatState = state;
      b.freeActions.set(guard.actionKeyHash, { inputHash: guard.inputHash, result: { kind: 'chat', chatId: id, action: input.kind } });
      base.persist(tx, L);
      return { kind: 'ok', chat: input.kind === 'delete' ? null : id, revokedAttemptId: revoked };
    }), { kind: 'rejected', code: 'unavailable' } as ChatChangeResult);
    if (result.kind !== 'rejected' && input.kind === 'delete') await base.cleanupChats(owner.sessionId);
    return result;
  }

  /** Best-effort bounded physical cleanup; membership was revoked already. */
  private async deletionPaths(tx: DocTx, ids: readonly string[], owner: Owner, expiresAt: number, sessionClear: boolean): Promise<DocPath[]> {
    const allowed: readonly string[] = sessionClear ? [...CHAT_CLEANUP_KINDS, 'binding', 'freebinding'] : CHAT_CLEANUP_KINDS;
    const entries = ids.map(id => {
      const cut = id.indexOf('_'), kind = id.slice(0, cut), handle = id.slice(cut + 1);
      if (!allowed.includes(kind)) throw new StoreCorrupt();
      return { kind: kind as OwnedKind, path: ownedPath(kind as OwnedKind, handle) };
    });
    const raws = await tx.getAll(entries.map(e => e.path));
    // Validate the whole batch before any write. A structurally plausible
    // receipt is never ownership authority for another Session's documents.
    entries.forEach((entry, i) => {
      if (raws[i] === null || raws[i] === undefined) return;
      const owned = decodeLookup(raws[i]!, entry.kind);
      if (!owned || owned.sessionId !== owner.sessionId || owned.epoch !== owner.epoch || owned.expiresAt !== expiresAt) throw new StoreCorrupt();
    });
    return entries.map(e => e.path);
  }

  private async cleanupChats(sessionId: Handle): Promise<void> {
    try {
      for (let i = 0; i < 3; i++) {
        const more = await this.docs.transact(async tx => {
          const [raw] = await tx.getAll([this.rootPath(sessionId)]);
          const env = decodeSessionRoot(raw ?? null, sessionId);
          if (!env) return false;
          const root = parseRoot(env.body, sessionId, env.expiresAt);
          if (root.state !== 'active' || !root.chatState?.cleanup.length) return false;
          const batch = root.chatState.cleanup.slice(0, DELETE_BATCH);
          const paths = await this.deletionPaths(tx, batch, { sessionId, epoch: env.epoch }, env.expiresAt, false);
          root.chatState.cleanup = root.chatState.cleanup.slice(DELETE_BATCH);
          for (const path of paths) tx.delete(path);
          tx.set(this.rootPath(sessionId), encodeOwned('session', { sessionId, epoch: env.epoch }, env.expiresAt, plain(root)));
          return root.chatState.cleanup.length > 0;
        });
        if (!more) break;
      }
    } catch { /* Keep the id-only receipt; no access or allowance is restored. */ }
  }

  async admitReference(input: AdmitReferenceInput): Promise<AdmitResult> {
    return this.orUnavailable(
      () => this.mutate(input.sessionId, input.now, { paid: [input.actionKeyHash] }, (b, t, env) => core.admitReference(env, b, { ...input, now: t })),
      { kind: 'rejected', code: 'admission_unavailable' },
    );
  }

  async registerCapture(input: RegisterCaptureInput): Promise<RegisterCaptureResult> {
    return this.orUnavailable(() => this.mutate(input.sessionId, input.now, { free: [input.actionKeyHash], service: true },
      (b, t, env) => core.registerCapture(env, b, { ...input, now: t })), { kind: 'rejected', code: 'unavailable' });
  }

  async authorizeReference(owner: Owner, attemptId: Handle, reference: CanonicalReference, now: number, hint?: { readonly journeyId: Handle }): Promise<boolean> {
    const policy = this.policy;
    if (policy === 'missing' || policy === 'invalid' || (hint && !HANDLE.test(hint.journeyId))) return false;
    return this.orUnavailable(() => this.tx(now, async (tx, time) => {
      const a = await this.loadAuthority(tx, owner.sessionId, attemptId, time, hint?.journeyId);
      const t = time();
      return !!a && t < policy.expiresAt && core.referenceAuthority(a.bucket, owner, attemptId, reference, t);
    }), false);
  }

  async admitDiscover(input: AdmitDiscoverInput): Promise<AdmitResult> {
    return this.orUnavailable(() => this.mutate(input.sessionId, input.now, { paid: [input.actionKeyHash] }, (b, t) => core.admitDiscover(b, { ...input, now: t })), {
      kind: 'rejected',
      code: 'admission_unavailable',
    });
  }

  async admitRefine(input: AdmitRefineInput): Promise<AdmitResult> {
    return this.orUnavailable(() => this.mutate(input.sessionId, input.now, { paid: [input.actionKeyHash] }, (b, t) => core.admitRefine(b, { ...input, now: t })), {
      kind: 'rejected',
      code: 'admission_unavailable',
    });
  }

  async checkAction(owner: Owner, actionKeyHash: string, inputHash: string, now: number): Promise<AdmitResult | null> {
    return this.orUnavailable(
      () =>
        this.tx(now, async (tx, time) => {
          const L = await this.load(tx, owner.sessionId, time, { paid: [actionKeyHash] });
          return core.checkAction(L?.bucket ?? null, owner, actionKeyHash, inputHash, L ? L.t : time());
        }),
      { kind: 'rejected', code: 'admission_unavailable' } as AdmitResult,
    );
  }

  /** Never throttled. */
  async stopAttempt(sessionId: Handle, epoch: number, attemptId: Handle, now: number) {
    return this.orThrow(() => this.mutate(sessionId, now, { revocation: true }, (b, t) => core.stopAttempt(b, sessionId, epoch, attemptId, t)));
  }

  /** Never throttled; records a cancellation binding when the action has not arrived yet. */
  async stopAction(sessionId: Handle, epoch: number, actionKeyHash: string, now: number) {
    return this.orThrow(() => this.mutate(sessionId, now, { paid: [actionKeyHash], revocation: true }, (b, t) => core.stopAction(b, sessionId, epoch, actionKeyHash, t)));
  }

  // -------------------------------------------------------------------------
  // Stage-specific submissions: authority + ledger in the same transaction.

  /**
   * Minimal authority read set for a submission: the session root, the Attempt
   * and its Journey (all reads, before any write). Only these records are ever
   * rewritten from it; the manifest is never touched.
   */
  private async loadAuthority(tx: DocTx, sessionId: Handle, attemptId: Handle, time: () => number, journeyHint?: Handle, extra: readonly DocPath[] = []) {
    if (!HANDLE.test(sessionId) || !HANDLE.test(attemptId) || (journeyHint !== undefined && !HANDLE.test(journeyHint))) return null;
    // Hints select a single fresh transactional read batch. They grant no
    // authority: every hinted link must still agree with the current root.
    const [rootRaw, attemptRaw, ...hinted] = await tx.getAll([this.rootPath(sessionId), ownedPath('attempt', attemptId),
      ...(journeyHint === undefined ? [] : [ownedPath('journey', journeyHint)]), ...extra]);
    const env = decodeSessionRoot(rootRaw ?? null, sessionId);
    if (!env) return null;
    const storedRoot = parseRoot(env.body, sessionId, env.expiresAt);
    if (storedRoot.state !== 'active') return null;
    const manifest = selectedManifest(storedRoot, sessionId, this.chatScope);
    if (!manifest) return null;
    const root: RootActive = { ...storedRoot, ...manifest };
    const owner = { sessionId, epoch: env.epoch };
    if (root.state !== 'active' || root.attempt !== attemptId || !root.journey || time() >= env.expiresAt ||
      (journeyHint !== undefined && root.journey !== journeyHint)) return null;
    const journeyRaw = journeyHint === undefined ? (await tx.getAll([ownedPath('journey', root.journey)]))[0] : hinted[0];
    // Decoded at a time sampled after these reads; callers sample again after any further read before deciding.
    const t = time();
    if (t < root.createdAt || t >= env.expiresAt) return null;
    const attemptBody = decodeOwned(attemptRaw ?? null, 'attempt', owner, t);
    const journeyBody = decodeOwned(journeyRaw ?? null, 'journey', owner, t);
    if (!attemptBody || !journeyBody) throw new StoreCorrupt();
    const attempt = recordBody('attempt', attemptBody, attemptId, owner, env.expiresAt) as unknown as BucketState['attempt'] & object;
    const journey = recordBody('journey', journeyBody, root.journey, owner, env.expiresAt) as unknown as BucketState['journey'] & object;
    // Owned links must agree with the root manifest (no extra reads needed).
    const briefs = new Set(root.briefs);
    if (
      attempt.journeyId !== journey.id ||
      journey.analysisId !== root.analysis ||
      (journey.currentBriefId !== null && !briefs.has(journey.currentBriefId)) ||
      (attempt.briefId !== null && !briefs.has(attempt.briefId))
    ) {
      throw new StoreCorrupt();
    }
    const session: Session = { id: sessionId, secretHash: root.secretHash, createdAt: root.createdAt, expiresAt: env.expiresAt, epoch: env.epoch, revoked: false };
    const bucket = {
      session,
      journey,
      attempt,
      analysis: null,
      journeysCreated: root.journeysCreated,
      actions: new Map(),
      briefs: [],
      searches: [],
      checkpoints: [],
      pools: [],
      plans: [],
      panels: [],
      feedback: [],
      counts: { ...root.counts },
      freeActions: new Map(),
      freeWindow: { ...root.freeWindow },
    } satisfies BucketState;
    const before = { attempt: canonicalJson(attemptBody), journey: canonicalJson(journeyBody) };
    const write = () => {
      const exp = env.expiresAt;
      if (canonicalJson(plain(attempt)) !== before.attempt) tx.set(ownedPath('attempt', attemptId), encodeOwned('attempt', owner, exp, plain(attempt)));
      if (canonicalJson(plain(journey)) !== before.journey) tx.set(ownedPath('journey', root.journey!), encodeOwned('journey', owner, exp, plain(journey)));
    };
    return { bucket, root, write, until: Math.min(attempt.deadlineAt, env.expiresAt), extra: hinted.slice(journeyHint === undefined ? 0 : 1) };
  }

  async authorizeCatalogue(owner: Owner, attemptId: Handle, planId: Handle, poolId: Handle, now: number, hint?: { readonly journeyId: Handle; readonly briefId: Handle }): Promise<boolean> {
    const policy = this.policy;
    if (policy === 'missing' || policy === 'invalid' || !HANDLE.test(planId) || !HANDLE.test(poolId) || (hint && (!HANDLE.test(hint.journeyId) || !HANDLE.test(hint.briefId)))) return false;
    return this.orUnavailable(() => this.tx(now, async (tx, time) => {
      const a = await this.loadAuthority(tx, owner.sessionId, attemptId, time, hint?.journeyId,
        hint ? [ownedPath('plan', planId), ownedPath('pool', poolId), ownedPath('brief', hint.briefId)] : []);
      const briefId = a?.bucket.journey.currentBriefId;
      if (!a || !briefId || !a.root.plans.includes(planId) || !a.root.pools.includes(poolId) || (hint && briefId !== hint.briefId)) return false;
      const [planRaw, poolRaw, briefRaw] = hint ? a.extra : await tx.getAll([ownedPath('plan', planId), ownedPath('pool', poolId), ownedPath('brief', briefId)]);
      const t = time();
      if (t >= policy.expiresAt || !core.running(a.bucket, owner, attemptId, t)) return false;
      const read = (raw: DocData | null | undefined, kind: 'plan' | 'pool' | 'brief', id: Handle) => {
        const body = decodeOwned(raw ?? null, kind, owner, t);
        if (!body) throw new StoreCorrupt();
        return recordBody(kind, body, id, owner, a.bucket.session.expiresAt);
      };
      const bucket: BucketState = { ...a.bucket,
        plans: [read(planRaw, 'plan', planId) as unknown as InvestigationPlan],
        pools: [read(poolRaw, 'pool', poolId) as unknown as QlooCandidatePool],
        briefs: [read(briefRaw, 'brief', briefId) as unknown as BucketState['briefs'][number]],
      };
      return core.catalogueAuthority(bucket, owner, attemptId, planId, poolId, time());
    }), false);
  }

  async reserveSubmission(owner: Owner, attemptId: Handle, stage: SubmissionStage, now: number): Promise<SubmissionReserve> {
    const policy = this.policy;
    if (policy === 'missing' || policy === 'invalid') return { ok: false, code: 'unavailable' };
    const result = await this.orUnavailable<SubmissionReserve>(
      () =>
        this.tx(now, async (tx, time) => {
          const A = await this.loadAuthority(tx, owner.sessionId, attemptId, time);
          if (!A) return { ok: false, code: 'revoked' };
          const call = A.bucket.attempt.calls.length;
          const id = this.ledger.reservationIdFor(reservationKey(attemptId, call));
          const sessionScope = this.ledger.scopeId('session', owner.sessionId);
          const journeyScope = this.ledger.scopeId('journey', A.bucket.journey.id);
          const cur = await this.ledger.readForReserve(tx, id, sessionScope, journeyScope);
          // Every read is complete: authority and the policy are judged now.
          const t = time();
          const b = core.running(A.bucket, owner, attemptId, t);
          if (!b) return { ok: false, code: 'revoked' };
          const attemptRef = this.ledger.attemptRef(attemptId);
          const plan = planReserve(
            { service: this.ledger.serviceId, stage, inputHash: this.ledger.inputHash(stage, sessionScope, journeyScope, attemptRef), sessionScope, journeyScope, attemptRef, now: t },
            cur,
            policy,
          );
          if (!plan.ok) return { ok: false, code: plan.code.startsWith('capacity') || plan.code === 'concurrency' ? 'capacity' : 'unavailable' };
          // A reservation already at this call index means a manifest/ledger mismatch: fail closed.
          if (plan.replay) return { ok: false, code: 'unavailable' };
          this.ledger.apply(tx, id, plan);
          const provider = STAGE_PROVIDER[stage];
          b.attempt!.calls.push({ provider, stage, state: 'reserved' });
          b.journey!.counts[provider] += 1;
          A.write();
          return { ok: true, call, validUntil: Math.min(A.until, policy.expiresAt) };
        }),
      { ok: false, code: 'unavailable' },
    );
    if (result.ok) this.localReserved.add(this.ledger.reservationIdFor(reservationKey(attemptId, result.call)));
    return result;
  }

  async beginSubmission(owner: Owner, attemptId: Handle, call: number, now: number): Promise<SubmissionGrant> {
    const policy = this.policy;
    if (policy === 'missing' || policy === 'invalid') return 'unavailable';
    if (!Number.isSafeInteger(call) || call < 0) return 'revoked';
    const decided = await this.orUnavailable<SubmissionGrant | { grant: 'send'; until: number }>(
      () =>
        this.tx(now, async (tx, time) => {
          const A = await this.loadAuthority(tx, owner.sessionId, attemptId, time);
          const id = this.ledger.reservationIdFor(reservationKey(attemptId, call));
          const { reservation: r } = await this.ledger.readCurrent(tx, id, false);
          // Existing intent (replay, race loser, lost acknowledgement) is an observation only: never a send.
          if (r && r.state !== 'reserved') return r.state === 'withdrawn' ? 'revoked' : 'held';
          // Every read is complete: session expiry, the Attempt deadline and policy expiry are judged now.
          const t = time();
          const b = core.running(A?.bucket ?? null, owner, attemptId, t);
          const entry = b?.attempt!.calls[call];
          if (!A || !b || !r || entry?.state !== 'reserved') return 'revoked';
          const plan: Plan = planIntent(r, t, policy);
          if (!plan.ok) return plan.code === 'intent_exists' ? 'held' : plan.code === 'policy_expired' || plan.code === 'policy_mismatch' ? 'unavailable' : 'revoked';
          this.ledger.apply(tx, id, plan);
          entry.state = 'in_flight';
          if (entry.stage === 'reference_analysis') b.attempt!.dispatch = 'in_flight';
          A.write();
          return { grant: 'send', until: Math.min(A.until, policy.expiresAt) };
        }),
      'unavailable',
    );
    if (typeof decided === 'string') return decided;
    // Delivery boundary: the intent is durable, but if authority lapsed while it
    // was committing the grant is unusable. It is never sent; it stays held
    // (unknown, money and counts reserved) and only its concurrency is released.
    let usable = false;
    try {
      usable = this.now() < decided.until;
    } catch {
      usable = false;
    }
    if (usable) { this.localIntents.add(this.ledger.reservationIdFor(reservationKey(attemptId, call))); return 'send'; }
    await this.holdUnsent(attemptId, call);
    return 'held';
  }

  /** Durable intent that will never be invoked: unknown ('cancelled'), never a refund. */
  private async holdUnsent(attemptId: Handle, call: number) {
    await this.orUnavailable(
      () =>
        this.tx(this.now(), async (tx, time) => {
          const id = this.ledger.reservationIdFor(reservationKey(attemptId, call));
          const cur = await this.ledger.readCurrent(tx, id, true);
          if (cur.reservation?.state !== 'intent') return;
          const plan = planUnknown(cur, 'cancelled', time());
          if (plan.ok) this.ledger.apply(tx, id, plan);
        }),
      undefined,
    );
  }

  /**
   * Best-effort display mirror of a ledger transition onto the owned Attempt.
   * The ledger reservation stays the authority: beginSubmission consults it
   * before the mirror, so a lagging mirror can never permit a send.
   */
  private async mirror(sessionId: Handle, attemptId: Handle, call: number, change: (b: BucketState) => boolean) {
    await this.orUnavailable(
      () =>
        this.tx(this.now(), async (tx, time) => {
          const A = await this.loadAuthority(tx, sessionId, attemptId, time).catch(() => null);
          if (A && A.bucket.attempt.calls[call] && change(A.bucket)) A.write();
        }),
      undefined,
    );
  }

  async withdrawSubmission(sessionId: Handle, attemptId: Handle, call: number): Promise<void> {
    if (!Number.isSafeInteger(call) || call < 0) return;
    const released = await this.orUnavailable(
      () =>
        this.tx(this.now(), async (tx, time) => {
          const id = this.ledger.reservationIdFor(reservationKey(attemptId, call));
          const cur = await this.ledger.readCurrent(tx, id, true);
          // Proof: in this same transaction the reservation is still 'reserved' (no intent was ever recorded).
          if (cur.reservation?.state !== 'reserved') return false;
          const plan = planWithdraw(cur, { kind: 'intent_never_recorded' }, time());
          if (!plan.ok) return false;
          this.ledger.apply(tx, id, plan);
          return true;
        }),
      false,
    );
    if (!released) return;
    await this.mirror(sessionId, attemptId, call, (b) => {
      const entry = b.attempt!.calls[call]!;
      if (entry.state !== 'reserved') return false;
      entry.state = 'withdrawn';
      if (entry.stage === 'reference_analysis') b.attempt!.dispatch = 'withdrawn';
      b.journey!.counts[entry.provider] = Math.max(0, b.journey!.counts[entry.provider] - 1);
      return true;
    });
  }

  async endSubmission(sessionId: Handle, attemptId: Handle, call: number, how: SubmissionEnd): Promise<void> {
    if (!Number.isSafeInteger(call) || call < 0) return;
    // Ledger first, in its own transaction: no known-cost receipt exists here, so the work is held as unknown.
    await this.orUnavailable(
      () =>
        this.tx(this.now(), async (tx, time) => {
          const id = this.ledger.reservationIdFor(reservationKey(attemptId, call));
          const cur = await this.ledger.readCurrent(tx, id, true);
          if (cur.reservation?.state !== 'intent') return;
          const plan = planUnknown(cur, how === 'returned' ? 'transport_returned_without_receipt' : 'cancelled', time());
          if (plan.ok) this.ledger.apply(tx, id, plan);
        }),
      undefined,
    );
    if (how !== 'returned') return;
    await this.mirror(sessionId, attemptId, call, (b) => {
      const entry = b.attempt!.calls[call]!;
      if (entry.state !== 'in_flight') return false;
      entry.state = 'returned';
      if (entry.stage === 'reference_analysis') b.attempt!.dispatch = 'returned';
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Guarded commits (re-authorised at transaction time; late workers dropped).

  observeSubmission(sessionId: Handle, attemptId: Handle, call: number, raw: unknown): Promise<ObservationWrite> {
    return this.observationWrites.run(async () => {
      if (!HANDLE.test(sessionId) || !HANDLE.test(attemptId) || !Number.isSafeInteger(call) || call < 0) return 'invalid';
      return this.tx(this.now(), async (tx) => {
        const id = this.ledger.reservationIdFor(reservationKey(attemptId, call));
        const current = await this.ledger.readCurrent(tx, id, false);
        const r = current.reservation;
        if (!r || r.sessionScope !== this.ledger.scopeId('session', sessionId) || r.attemptRef !== this.ledger.attemptRef(attemptId)) return 'not_found';
        if (r.inputHash !== this.ledger.inputHash(r.stage, r.sessionScope, r.journeyScope, r.attemptRef)) return 'invalid';
        const plan = planObservation(r, raw);
        if (!plan.ok) return 'invalid';
        this.ledger.apply(tx, id, plan);
        return plan.replay ? 'replay' : 'stored';
      });
    });
  }

  async commitAnalysis(sessionId: Handle, epoch: number, attemptId: Handle, result: AnalysisCommit, now: number) {
    return this.orUnavailable(() => this.mutate(sessionId, now, {}, (b, t) => core.commitAnalysis(b, sessionId, epoch, attemptId, result, t)), false);
  }

  async settleAttempt(sessionId: Handle, epoch: number, attemptId: Handle, outcome: FailureOutcome, failure: AttemptFailure | null, now: number) {
    return this.orUnavailable(() => this.mutate(sessionId, now, {}, (b, t) => core.settleAttempt(b, sessionId, epoch, attemptId, outcome, failure, t)), false);
  }

  async loadDiscoverContext(owner: Owner, attemptId: Handle, now: number) {
    return this.orUnavailable(
      () =>
        this.tx(now, async (tx, time) => {
          const L = await this.load(tx, owner.sessionId, time, {});
          return core.loadDiscoverContext(L?.bucket ?? null, owner, attemptId, L ? L.t : time());
        }),
      null,
    );
  }

  async loadRefineContext(owner: Owner, attemptId: Handle, now: number) {
    return this.orUnavailable(
      () =>
        this.tx(now, async (tx, time) => {
          const L = await this.load(tx, owner.sessionId, time, {});
          return core.loadRefineContext(L?.bucket ?? null, owner, attemptId, L ? L.t : time());
        }),
      null,
    );
  }

  async recordSearch(owner: Owner, attemptId: Handle, record: SearchRecord, now: number) {
    return this.orUnavailable(() => this.mutate(owner.sessionId, now, {}, (b, t) => core.recordSearch(b, owner, attemptId, record, t)), false);
  }

  async saveCheckpoint(owner: Owner, attemptId: Handle, checkpoint: IdentityCheckpoint, now: number) {
    return this.orUnavailable(() => this.mutate(owner.sessionId, now, {}, (b, t) => core.saveCheckpoint(b, owner, attemptId, checkpoint, t)), false);
  }

  async setStage(owner: Owner, attemptId: Handle, stage: Stage, now: number) {
    return this.orUnavailable(() => this.mutate(owner.sessionId, now, {}, (b, t) => core.setStage(b, owner, attemptId, stage, t)), false);
  }

  async commitPlan(owner: Owner, attemptId: Handle, pool: QlooCandidatePool | null, plan: InvestigationPlan, now: number) {
    return this.orUnavailable(() => this.mutate(owner.sessionId, now, {}, (b, t) => core.commitPlan(b, owner, attemptId, pool, plan, t)), false);
  }

  async commitPanel(owner: Owner, attemptId: Handle, panel: ChoicePanel, now: number) {
    return this.orUnavailable(() => this.mutate(owner.sessionId, now, {}, (b, t) => core.commitPanel(b, owner, attemptId, panel, t)), false);
  }

  // -------------------------------------------------------------------------
  // Free actions (shared per-session and service-wide free-write windows).

  async saveBrief(owner: Owner, input: BriefInput, guard: FreeActionGuard & { readonly expectedBriefId: Handle | null }, now: number): Promise<BriefSaveResult> {
    return this.orUnavailable(
      () => this.mutate(owner.sessionId, now, { free: [guard.actionKeyHash], service: true }, (b, t, env) => core.saveBrief(env, b, owner, input, guard, t)),
      { kind: 'rejected', code: 'unavailable' } as BriefSaveResult,
    );
  }

  async chooseArtist(owner: Owner, input: { checkpointId: Handle; slot: number; choice: Handle | null }, guard: FreeActionGuard & { readonly expectedRevision: number }, now: number): Promise<ChoiceResult> {
    return this.orUnavailable(
      () => this.mutate(owner.sessionId, now, { free: [guard.actionKeyHash], service: true }, (b, t, env) => core.chooseArtist(env, b, owner, input, guard, t)),
      'unavailable' as ChoiceResult,
    );
  }

  async saveFeedback(
    owner: Owner,
    input: { panelId: Handle; choice: Handle; fit: Fit; familiarity: Familiarity },
    guard: FreeActionGuard & { readonly expectedRevision: number },
    now: number,
  ): Promise<FeedbackResult> {
    return this.orUnavailable(
      () => this.mutate(owner.sessionId, now, { free: [guard.actionKeyHash], service: true }, (b, t, env) => core.saveFeedback(env, b, owner, input, guard, t)),
      'unavailable' as FeedbackResult,
    );
  }

  // -------------------------------------------------------------------------
  // Clear: revoke first, then bounded deletion with a minimised cleanup receipt.

  async clearSession(sessionId: Handle): Promise<Handle | null> {
    if (!HANDLE.test(sessionId)) return null;
    const root = this.rootPath(sessionId);
    // 1. Atomic revocation: epoch + 1, secret lookup removed, root reduced to the id-only receipt.
    const pending = await this.orThrow(() =>
      this.docs.transact(async (tx) => {
        const [raw] = await tx.getAll([root]);
        const env = decodeSessionRoot(raw ?? null, sessionId);
        if (!env) return null;
        const r = parseRoot(env.body, sessionId, env.expiresAt);
        if (r.state === 'revoked') return { epoch: env.epoch, expiresAt: env.expiresAt, ids: r.pending, attempt: null as Handle | null };
        const records: string[] = [
          ...(r.chatState?.others.flatMap(c => manifestIds(c.manifest)) ?? []),
          ...(r.chatState?.cleanup ?? []),
          ...(r.journey ? [`journey_${r.journey}`] : []),
          ...(r.analysis ? [`analysis_${r.analysis}`, `analysistext_${r.analysis}`] : []),
          ...(r.attempt ? [`attempt_${r.attempt}`] : []),
          ...r.briefs.map((h) => `brief_${h}`),
          ...r.searches.map((h) => `search_${h}`),
          ...r.checkpoints.map((h) => `checkpoint_${h}`),
          ...r.pools.map((h) => `pool_${h}`),
          ...r.plans.map((h) => `plan_${h}`),
          ...r.panels.flatMap((h) => [`panel_${h}`, `panelcontent_${h}`]),
          ...r.feedback.map((h) => `feedback_${h}`),
          ...(r.captures ?? []).map(h => `capture_${h}`),
          ...r.bindings.map((h) => `binding_${h}`),
          ...r.freeBindings.map((h) => `freebinding_${h}`),
        ];
        const epoch = env.epoch + 1;
        const [secretRaw] = await tx.getAll([ownedPath('secret', r.secretHash)]);
        const secret = decodeLookup(secretRaw ?? null, 'secret');
        tx.set(root, encodeOwned('session', { sessionId, epoch }, env.expiresAt, { state: 'revoked', pending: records }));
        if (secret?.sessionId === sessionId && secret.epoch === env.epoch && secret.expiresAt === env.expiresAt) tx.delete(ownedPath('secret', r.secretHash));
        return { epoch, expiresAt: env.expiresAt, ids: [...new Set(records)], attempt: (r.attempt ?? r.chatState?.others.find(c => c.manifest.attempt)?.manifest.attempt ?? null) as Handle | null };
      }),
    );
    if (!pending) return null;
    // 2. Bounded deletion. A failure keeps the revoked receipt (TTL or a later Clear finishes it).
    try {
      let remaining = pending.ids;
      for (let done = false; !done; done = remaining.length === 0) {
        const batch = remaining.slice(0, DELETE_BATCH);
        const rest = remaining.slice(DELETE_BATCH);
        await this.docs.transact(async (tx) => {
          await tx.getAll([root]);
          const paths = await this.deletionPaths(tx, batch, { sessionId, epoch: pending.epoch - 1 }, pending.expiresAt, true);
          for (const path of paths) tx.delete(path);
          if (rest.length > 0) tx.set(root, encodeOwned('session', { sessionId, epoch: pending.epoch }, pending.expiresAt, { state: 'revoked', pending: rest }));
          else tx.delete(root);
        });
        remaining = rest;
      }
    } catch {
      // Access is already revoked; only physical cleanup is pending (the revoked receipt keeps the remaining ids).
    }
    return pending.attempt;
  }
}
import { validPanelPresentation } from './persistence/record-schema.js';
