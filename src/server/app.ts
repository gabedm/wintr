import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type {
  BriefVersion,
  ChoicePanel,
  ErrorCode,
  Familiarity,
  Fit,
  Handle,
  RefinementMode,
  RelationshipSource,
  SafeIdentitySlot,
  SafePanel,
  SafeSnapshot,
  Session,
  CapturedInput,
} from '../shared/records.js';
import { EXAMPLE_SOURCE } from '../shared/example-source.js';
import { isRecordedReference, isStreamedReference, LIMITS } from '../shared/records.js';
import { inspectPcmWav, RECORDING } from '../shared/recording.js';
import { refuseDuplicateKeys } from './providers/json-keys.js';
import { defaultFocus, parseYouTubeReference, validateFocus } from '../shared/youtube.js';
import { connectionWhy, refinementBasisLines, type CatalogueSeam } from './catalogue.js';
import { storedSuggestionsVerdict, SUGGESTIONS_CSP, suggestionsDocument } from './catalogue-format.js';
import type { Config } from './config.js';
import { ownedIdentities, runDiscover, runRefine, validateOwnedPool } from './graph.js';
import { runReferenceStage } from './harness.js';
import { publicArtistContext, rehydrateIdentity } from './identity.js';
import { sha256 } from './ids.js';
import type { QlooClient } from './providers/qloo.js';
import type { ReferenceAdapter } from './reference.js';
import { canonicalJson, type RecordSealer } from './seal.js';
import type { SourcePolicy } from './source-policy.js';
import { StoreUnavailable, type AdmitRejection, type FreeRejection, type SessionBucket, type Store } from './store.js';
import { discoveryAvailability } from './discovery-admission.js';
import type { ChatChange } from './chat-state.js';
import { createLiveUpgrade, type UpgradeHandler } from './live-upgrade.js';
import { createLiveAudioInput } from './live-audio.js';
import type { ConcertSearch } from './concerts.js';
import type { TicketmasterAuthorization } from './ticketmaster-rate.js';
import { isConcertQuery, isConcertReply } from '../shared/concerts.js';

export interface DiscoveryDeps {
  readonly qloo: QlooClient;
  /** True when Qloo answers come from the labelled local fixture. */
  readonly qlooSynthetic: boolean;
  readonly catalogue: CatalogueSeam;
  readonly sealer: RecordSealer;
}

export interface AppDeps {
  readonly config: Config;
  readonly store: Store;
  /** Null when providers are disabled; no dispatch path exists then. */
  readonly referenceAdapter: ReferenceAdapter | null;
  /** Null when providers are disabled; Discover is then refused without dispatch. */
  readonly discovery?: DiscoveryDeps | null;
  /**
   * Bound eligible-source policy. Required by the live composition; checked
   * before reference admission. Absent only in disabled/synthetic local modes,
   * whose adapter accesses no media.
   */
  readonly sourcePolicy?: SourcePolicy | null;
  readonly now?: () => number;
  /** Server-owned runtime shutdown; never supplied by a request or client clock. */
  readonly shutdown?: AbortSignal;
  readonly liveListeningAuthority?: () => void;
  /** Separately prepared Ticketmaster connection; never inferred from a Gemini/Qloo approval. */
  readonly concerts?: ConcertSearch;
}

export type ApiHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & { readonly upgrade?: UpgradeHandler; readonly closeLive?: () => void };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

const ACTION_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

const ADMIT_STATUS: Record<AdmitRejection, number> = {
  no_session: 401,
  session_expired: 401,
  operation_active: 409,
  action_conflict: 409,
  stale_operation: 409,
  stale_version: 409,
  not_ready: 409,
  discovery_used: 409,
  discovery_correction_required: 409,
  discovery_retry_unavailable: 409,
  refinement_used: 409,
  feedback_required: 409,
  pool_empty: 422,
  cancelled: 409,
  capacity: 429,
  admission_unavailable: 503,
};

const FREE_STATUS: Record<FreeRejection | 'not_found' | 'invalid', [number, ErrorCode, string?]> = {
  no_session: [401, 'no_session'],
  rate_limited: [429, 'rate_limited'],
  action_conflict: [409, 'action_conflict'],
  stale_operation: [409, 'stale_operation'],
  stale_version: [409, 'stale_version'],
  operation_active: [409, 'operation_active'],
  capacity: [429, 'capacity'],
  panel_committed: [409, 'discovery_used', 'These choices used this reference’s discovery. Use “Try this direction” to change what to keep.'],
  not_found: [404, 'not_found'],
  invalid: [422, 'bad_request'],
  unavailable: [503, 'admission_unavailable'],
};

const FITS: readonly Fit[] = ['like', 'not_right', null];
const FAMILIARITIES: readonly Familiarity[] = ['new', 'known', null];
const MODES: readonly RefinementMode[] = ['follow_connection', 'correct_direction'];

/** Opaque per-session/epoch context for client revision ordering. Derived from the record, never the cookie secret. */
const sessionContext = (session: Session) => sha256(`context|${session.id}|${session.epoch}`).slice(0, 22);

/**
 * Action keys live in one owned namespace so Stop can revoke any paid action by
 * key; the operation kind is part of the bound input hash, so reusing a key for a
 * different kind is a conflict.
 */
const actionHash = (session: Session, key: string) => sha256(`${session.id}|action|${key}`);
/** Free (no-dispatch) actions have their own bounded owned namespace. */
const freeActionHash = (session: Session, key: string) => sha256(`${session.id}|free|${key}`);

const HANDLE = /^[A-Za-z0-9_-]{24}$/;
const isHandle = (v: unknown): v is Handle => typeof v === 'string' && HANDLE.test(v);

/** Bounded, trimmed, control-free text; null when absent/empty. Throws on wrong type or over-length. */
function boundedText(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'bad_request');
  const t = v.replace(/\s+/g, ' ').trim();
  if (t === '') return null;
  if (t.length > max || /[\u0000-\u001F\u007F]/.test(t)) throw new HttpError(422, 'bad_request', 'That text is too long.');
  return t;
}

export function createApiHandler(deps: AppDeps): ApiHandler {
  const { config, store, referenceAdapter } = deps;
  const now = deps.now ?? Date.now;
  const liveAllowed = () => {
    try {
      if (config.mode !== 'live' || !referenceAdapter?.liveListening || !deps.liveListeningAuthority || deps.shutdown?.aborted || !deps.sourcePolicy?.allowsLiveAudio?.(now())) return false;
      deps.liveListeningAuthority(); return true;
    } catch { return false; }
  };
  const inflight = new Map<Handle, AbortController>();
  const sessionWork = new Map<Handle, Set<Handle>>();
  const trackWork = async (session: Session, attempt: Handle, run: () => Promise<unknown>) => {
    let work = sessionWork.get(session.id);
    if (!work) { work = new Set(); sessionWork.set(session.id, work); }
    work.add(attempt);
    try { await run(); } finally { work.delete(attempt); if (!work.size) sessionWork.delete(session.id); }
  };
  deps.shutdown?.addEventListener('abort', () => {
    for (const controller of inflight.values()) controller.abort('runtime_closed');
  }, { once: true });
  const cookieName = config.secureCookie ? '__Host-wintr_sid' : 'wintr_sid';

  const discovery = deps.discovery ?? null;
  const briefView = (brief: BriefVersion): NonNullable<SafeSnapshot['brief']> => ({
    handle: brief.id, version: brief.version, relationship: brief.relationship, source: brief.relationshipSource, artists: brief.proposedArtists,
  });

  /**
   * The exact plan and pool a panel was made from (its immutable planId, then that plan's poolId).
   * Both or neither: a missing or inconsistent parent explains nothing and never falls back to another investigation.
   */
  const panelParents = (bucket: SessionBucket, panel: ChoicePanel) => {
    const plan = bucket.plans.find((p) => p.id === panel.planId) ?? null;
    const pool = plan ? (bucket.pools.find((p) => p.id === plan.poolId) ?? null) : null;
    return { plan, pool };
  };

  /**
   * Safe projection of one owned panel, its factual basis and the listener's current feedback for each exact choice.
   * The stored Suggestions unit is judged under the current source policy on every projection: when a stored
   * mandatory unit cannot be presented, the result is projected as 'source_unavailable' and its answer, choices,
   * listening links, citations, gaps and frame are withheld (the stored record itself is unchanged).
   */
  const projectPanel = (bucket: SessionBucket, panel: ChoicePanel): SafePanel => {
    const { plan, pool } = panelParents(bucket, panel);
    const original = bucket.briefs.find(b => b.id === panel.briefId && b.version === panel.briefVersion &&
      b.journeyId === panel.journeyId && b.sessionId === panel.sessionId && b.epoch === panel.epoch && b.expiresAt === panel.expiresAt);
    const context = {
      handle: panel.id,
      foundAt: panel.createdAt,
      synthetic: panel.synthetic,
      ...(panel.catalogueMode === 'first_party_candidates' ? { catalogueMode: 'first_party_candidates' as const } : {}),
      role: plan?.refinementMode ? ('refinement' as const) : ('initial' as const),
      mode: plan?.refinementMode ?? null,
      basis: plan && pool ? refinementBasisLines(plan, pool) : [],
      intent: original ? briefView(original) : null,
    };
    const unit = storedSuggestionsVerdict(panel.suggestionsHtml);
    if (unit.kind === 'unavailable') {
      return { ...context, outcome: 'source_unavailable', choices: [], answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [] };
    }
    return {
      ...context,
      outcome: panel.outcome,
      choices: panel.choices.map((c) => {
        const f = bucket.feedback.find((x) => x.panelId === panel.id && x.choiceHandle === c.handle);
        return {
          handle: c.handle,
          title: c.title,
          credits: c.credits,
          unverifiedCredits: c.unverifiedCredits,
          anchor: c.anchor.name,
          // Synthetic fixture IDs are invented: never expose them as live listening links.
          playUrl: panel.synthetic ? null : c.destination.url,
          service: c.destination.kind,
          ...(!panel.synthetic && c.artwork ? { artwork: c.artwork } : {}),
          fitHypothesis: c.fitHypothesis,
          ...(c.evidence.kind === 'first_party_search_plus_exact_metadata' ? { identityEvidence: 'first_party_catalogue' as const } : {}),
          sources: c.sources,
          feedback: { fit: f?.fit ?? null, familiarity: f?.familiarity ?? null, revision: f?.revision ?? 0 },
        };
      }),
      answer: { text: panel.answerText, marks: panel.marks },
      citations: panel.citations,
      suggestionsUrl: unit.kind === 'presentable' ? `/api/suggestions/${panel.id}${bucket.chats?.current && bucket.chats.current !== bucket.session.id ? `?chat=${bucket.chats.current}` : ''}` : null,
      gaps: panel.gaps,
    };
  };

  /**
   * Whether the approved public example may be offered as a draft fill, judged now: never when disabled; in live only
   * when a bound policy currently allows it; with any policy bound, only while it does. Offering it never admits it.
   */
  const exampleOffered = (): boolean => {
    if (config.mode === 'disabled') return false;
    if (!deps.sourcePolicy) return config.mode !== 'live';
    return deps.sourcePolicy.allows(EXAMPLE_SOURCE.videoId, now());
  };

  /** Safe projection: owned opaque handles and public names only. No provider IDs, scores, seals or raw results. */
  const snapshot = (bucket: SessionBucket | null, code: ErrorCode | null = null): SafeSnapshot => {
    const journey = bucket?.journey ?? null;
    const attempt = bucket?.attempt ?? null;
    const analysis = bucket?.analysis ?? null;
    const brief = bucket?.brief ?? null;
    const failedCode: ErrorCode | null =
      attempt?.outcome === 'failed' ? (attempt.failure ?? 'adapter_failed') : attempt?.outcome === 'cancelled' ? 'cancelled' : null;
    const identityOwner = bucket && journey ? { sessionId: bucket.session.id, epoch: bucket.session.epoch, journeyId: journey.id, expiresAt: journey.expiresAt } : null;
    const candidateView = new Map(
      (bucket?.searches ?? []).flatMap((s) =>
        s.candidates.map((c) => {
          const verified = discovery && identityOwner && s.journeyId === journey!.id && c.identity.provenance.operation === 'search' && c.identity.provenance.sourceRecordId === s.id
            ? rehydrateIdentity(c.identity, identityOwner, now(), discovery.sealer) : null;
          const context = verified ? publicArtistContext(verified) : undefined;
          return [c.handle, { handle: c.handle, name: c.identity.name, disambiguation: c.identity.disambiguation, ...(context ? { context } : {}) }] as const;
        }),
      ),
    );
    const cp = bucket?.checkpoint ?? null;
    const plan = bucket?.plan ?? null;
    const pool = bucket?.pool ?? null;
    const panel = bucket?.panel ?? null;
    // The connection explains what is shown: a visible panel is explained by its own plan and pool, never by a newer
    // (pending, failed or cancelled) investigation; without a panel the current accepted plan and pool give the progress view.
    const shown = bucket && panel ? panelParents(bucket, panel) : { plan, pool };
    const stage = journey?.stage ?? 'idle';
    const inputPolicyTime = now();
    return {
      ...(bucket?.chats ? { chats: bucket.chats } : {}),
      mode: config.mode,
      discovery: bucket ? discoveryAvailability(bucket) : 'unavailable',
      exampleSource: exampleOffered(),
      ...(config.mode !== 'disabled' && referenceAdapter !== null && deps.sourcePolicy?.recordingSelfService === true &&
        Number.isSafeInteger(inputPolicyTime) && inputPolicyTime >= 0 && inputPolicyTime < deps.sourcePolicy.expiresAt
        ? { recordingSelfService: true } : {}),
      ...(liveAllowed()
        ? { liveListening: { maxSeconds: 20 as const } } : {}),
      session: bucket ? { context: sessionContext(bucket.session), expiresAt: bucket.session.expiresAt, checkedAt: now() } : null,
      stage,
      revision: journey?.revision ?? 0,
      status:
        panel && (stage === 'complete' || stage === 'no_match')
          ? 'choices_ready'
          : stage === 'awaiting_artist'
          ? 'artist_choices_ready'
          : plan && (stage === 'finding_tracks' || stage === 'failed')
            ? 'connection_ready'
            : analysis && stage === 'awaiting_preference'
              ? 'reference_ready'
              : null,
      attempt: attempt ? { handle: attempt.id, kind: attempt.kind, active: attempt.outcome === 'running', outcome: attempt.outcome } : null,
      reference: journey ? (isRecordedReference(journey.reference) ? { kind: 'recorded', receipt: journey.reference.receipt, durationMs: journey.reference.frames * 1000 / RECORDING.sampleRate } : journey.reference) : null,
      listenerCue: journey?.listenerCue ?? null,
      analysis: analysis
        ? {
            handle: analysis.id,
            synthetic: analysis.synthetic,
            audioAccess: analysis.audioAccess,
            observations: analysis.observations,
            relationships: analysis.relationships,
            proposedArtist: analysis.provider?.uncertainArtistName ?? null,
          }
        : null,
      brief: brief ? briefView(brief) : null,
      identity: cp
        ? {
            handle: cp.id,
            revision: cp.revision,
            awaiting: cp.awaiting,
            slots: cp.slots.map(
              (s): SafeIdentitySlot => ({
                proposal: s.proposal,
                status: s.status,
                options: s.options.flatMap((h) => {
                  const v = candidateView.get(h);
                  return v ? [v] : [];
                }),
                chosen: s.chosen,
              }),
            ),
          }
        : null,
      connection:
        shown.plan && shown.pool
          ? {
              synthetic: shown.pool.synthetic,
              seeds: shown.plan.seedNames,
              artists: shown.plan.anchors.map((a) => a.name),
              anchors: shown.plan.anchors.map((a) => ({ handle: a.handle, name: a.name })),
              tags: shown.plan.associations.map((t) => t.name),
              capability: shown.pool.capability,
              attribution: shown.plan.attribution,
              why: connectionWhy(shown.plan, shown.pool),
            }
          : null,
      panel: bucket && panel ? projectPanel(bucket, panel) : null,
      history: bucket ? bucket.panels.slice(0, -1).map((p) => projectPanel(bucket, p)) : [],
      refinement: journey && panel ? { used: journey.refinementUsed } : null,
      code: code ?? failedCode,
    };
  };

  const readCookie = (req: IncomingMessage): string | null => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === cookieName) {
        const value = rest.join('=');
        return SECRET.test(value) ? value : null;
      }
    }
    return null;
  };

  const setCookie = (res: ServerResponse, value: string, maxAgeSeconds: number) => {
    const attrs = [`${cookieName}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAgeSeconds}`];
    if (config.secureCookie) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  };

  /** Resolves the owned, unexpired session; expired sessions are revoked and reported. */
  const currentSession = async (req: IncomingMessage, purpose: 'access' | 'revoke' = 'access'): Promise<{ session: Session | null; expired: boolean }> => {
    const secret = readCookie(req);
    if (!secret) return { session: null, expired: false };
    const found = await store.findSessionBySecret(secret, now(), purpose);
    if (!found) return { session: null, expired: false };
    return found.expired ? { session: null, expired: true } : { session: found.session, expired: false };
  };

  const requireSession = async (req: IncomingMessage, purpose: 'access' | 'revoke' = 'access'): Promise<Session> => {
    const { session, expired } = await currentSession(req, purpose);
    if (expired) throw new HttpError(401, 'session_expired');
    if (!session) throw new HttpError(401, 'no_session');
    return session;
  };

  const readJson = async (req: IncomingMessage, maxBytes: number = LIMITS.mutationBodyBytes): Promise<Record<string, unknown>> => {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type');
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > maxBytes) throw new HttpError(413, 'body_too_large');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) throw new HttpError(413, 'body_too_large');
      chunks.push(chunk);
    }
    let parsed: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      if (maxBytes !== LIMITS.mutationBodyBytes) refuseDuplicateKeys(text, () => new HttpError(400, 'bad_request'));
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_request');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'bad_request');
    return parsed as Record<string, unknown>;
  };

  // Expiring local generations also invalidate an already-authorized response
  // whose last store await is delayed across this handler's Clear. Shared
  // revocation is decided separately by authorizeRead, never by this map.
  const deliveryGenerations = new Map<Handle, { token: object; expiresAt: number }>();
  const concertWork = new Map<Handle, Set<AbortController>>();
  const deliveryToken = (session: Session): object => {
    const t = now();
    if (Number.isSafeInteger(t) && t >= 0) {
      for (const [id, entry] of deliveryGenerations) if (t >= entry.expiresAt) deliveryGenerations.delete(id);
    }
    let entry = deliveryGenerations.get(session.id);
    if (!entry) {
      entry = { token: {}, expiresAt: session.expiresAt };
      deliveryGenerations.set(session.id, entry);
    }
    return entry.token;
  };
  const invalidateDeliveries = (session: Session) => {
    deliveryGenerations.set(session.id, { token: {}, expiresAt: session.expiresAt });
    for (const work of concertWork.get(session.id) ?? []) work.abort();
  };
  const locallyCurrent = (session: Session, token: object) => deliveryGenerations.get(session.id)?.token === token;
  const privateSnapshots = new WeakMap<object, { bucket: SessionBucket; token: object; code: ErrorCode | null; scope: Store }>();
  const captureReplies = new WeakMap<object, CapturedInput>();
  let recordingReaders = 0;
  const ownedSnapshot = async (session: Session, scope: Store, code: ErrorCode | null = null) => {
    const token = deliveryToken(session);
    const bucket = await scope.read(session.id, session.epoch, now());
    // Projection happens synchronously only after the final minimal authority
    // read. This placeholder is internal to the route/response boundary.
    const snap = snapshot(null, code);
    if (bucket) privateSnapshots.set(snap, { bucket, token, code, scope });
    return snap;
  };

  /**
   * Final synchronous time fence immediately before private content is written
   * (nothing is awaited after it). A practical delivery check, not atomic with
   * any database commit; an unusable clock refuses private content.
   */
  const deliverable = (until: number | undefined): 'ok' | 'expired' | 'unavailable' => {
    if (deps.shutdown?.aborted) return 'unavailable';
    if (until === undefined) return 'ok';
    const t = now();
    if (!Number.isSafeInteger(t) || t < 0) return 'unavailable';
    return t < until ? 'ok' : 'expired';
  };

  /**
   * Owned, read-only Search Suggestions unit. Served as its own document with a
   * CSP sandbox (opaque origin, no scripts/forms/same-origin access), no
   * resources beyond the allowlisted image origin, and framable only by Wintr.
   * The stored unit is rebuilt under the current sanitiser policy on every
   * delivery (synchronously, before the final expiry fence); one that cannot be
   * presented safely (the same verdict the projection uses) is refused with 410
   * and an empty body, never truncated.
   */
  const serveSuggestions = async (req: IncomingMessage, res: ServerResponse, panelId: Handle, store: Store) => {
    const { session } = await currentSession(req);
    const token = session ? deliveryToken(session) : null;
    const bucket = session ? await store.read(session.id, session.epoch, now()) : null;
    const authorized = !!bucket && locallyCurrent(bucket.session, token!) && deliverable(bucket.session.expiresAt) === 'ok' &&
      await store.authorizeRead({ sessionId: bucket.session.id, epoch: bucket.session.epoch }, now(), bucket.chats?.revision);
    // No further await: rebuild the unit, then recheck local revocation, time
    // and shutdown immediately before emission. A previously authorized remote
    // response already in flight cannot be recalled by a later Clear elsewhere.
    // Each owned panel (current or earlier) keeps its own Suggestions unit; never another session's.
    const unit = storedSuggestionsVerdict(authorized && locallyCurrent(bucket!.session, token!)
      ? bucket!.panels.find((p) => p.id === panelId)?.suggestionsHtml ?? null : null);
    const document = unit.kind === 'presentable' ? suggestionsDocument(unit.html) : '';
    res.setHeader('Content-Security-Policy', SUGGESTIONS_CSP);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const verdict = deliverable(bucket?.session.expiresAt);
    res.statusCode = verdict === 'unavailable' ? 503 : verdict === 'expired' || unit.kind === 'absent' ? 404 : unit.kind === 'unavailable' ? 410 : 200;
    res.end(verdict === 'ok' && unit.kind === 'presentable' && locallyCurrent(bucket!.session, token!) ? document : '');
  };

  const requestChat = (req: IncomingMessage): Handle | null => {
    const values = new URL(req.url ?? '/', config.origin).searchParams.getAll('chat');
    if (values.length > 1 || (values.length === 1 && !isHandle(values[0]))) throw new HttpError(400, 'bad_request');
    return (values[0] as Handle | undefined) ?? null;
  };
  const scopedInput = (req: IncomingMessage, values: readonly unknown[]) => { const chat = requestChat(req); return chat ? [...values, { chat }] : values; };

  const routes: Record<string, (req: IncomingMessage, res: ServerResponse, store: Store) => Promise<[number, SafeSnapshot]>> = {
    'POST /api/chats': async (req) => {
      const body = await readJson(req);
      const session = await requireSession(req);
      if (typeof body.actionKey !== 'string' || !ACTION_KEY.test(body.actionKey)) throw new HttpError(400, 'bad_request');
      let input: ChatChange;
      if (body.kind === 'create' && Object.keys(body).length === 2) input = { kind: 'create' };
      else if ((body.kind === 'rename' || body.kind === 'delete') && isHandle(body.chat) && Number.isSafeInteger(body.expectedRevision) && (body.expectedRevision as number) >= 0 && Object.keys(body).length === (body.kind === 'rename' ? 5 : 4)) {
        const basis = { chat: body.chat, expectedRevision: body.expectedRevision as number };
        if (body.kind === 'rename') {
          const title = boundedText(body.title, 80);
          if (!title) throw new HttpError(400, 'bad_request');
          input = { kind: 'rename', ...basis, title };
        } else input = { kind: 'delete', ...basis };
      } else throw new HttpError(400, 'bad_request');
      // Delete invalidates this instance's held directory/content responses both
      // before and after the shared await. Other instances use the final read.
      if (input.kind === 'delete') invalidateDeliveries(session);
      let result;
      try {
        result = await deps.store.changeChat({ sessionId: session.id, epoch: session.epoch }, input,
          { actionKeyHash: freeActionHash(session, body.actionKey), inputHash: sha256(canonicalJson(['chat', input])) }, now());
      } finally { if (input.kind === 'delete') invalidateDeliveries(session); }
      if (result.kind === 'rejected') { const [status, code] = FREE_STATUS[result.code]; throw new HttpError(status, code); }
      if (result.revokedAttemptId) inflight.get(result.revokedAttemptId)?.abort('chat_deleted');
      const target = result.chat ? deps.store.forChat(result.chat) : deps.store;
      return [input.kind === 'create' && result.kind === 'ok' ? 201 : 200, await ownedSnapshot(session, target)];
    },
    'GET /api/state': async (req, _res, store) => {
      const { session, expired } = await currentSession(req);
      if (!session) return [200, snapshot(null, expired ? 'session_expired' : null)];
      return [200, await ownedSnapshot(session, store)];
    },

    'POST /api/session': async (req, res, store) => {
      await readJson(req);
      const existing = await currentSession(req);
      if (existing.session) return [200, await ownedSnapshot(existing.session, store)];
      const created = await store.createSession(now());
      if (created === 'rate_limited') throw new HttpError(429, 'rate_limited');
      if (!created) throw new HttpError(503, 'capacity');
      setCookie(res, created.secret, Math.floor(LIMITS.sessionLifetimeMs / 1000));
      return [201, await ownedSnapshot(created.session, store)];
    },

    'POST /api/capture': async (req, _res, store) => {
      const session = await requireSession(req);
      const body = await readJson(req);
      if (Object.keys(body).sort().join(',') !== 'actionKey,frames,sha256' || typeof body.actionKey !== 'string' || !ACTION_KEY.test(body.actionKey) ||
        typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.sha256) || !Number.isSafeInteger(body.frames) ||
        (body.frames as number) < RECORDING.minFrames || (body.frames as number) > RECORDING.maxFrames) throw new HttpError(400, 'bad_request');
      const registered = await store.registerCapture({ sessionId: session.id, epoch: session.epoch, now: now(), sha256: body.sha256, frames: body.frames as number,
        actionKeyHash: freeActionHash(session, body.actionKey), inputHash: sha256(canonicalJson(scopedInput(req, ['capture', body.sha256, body.frames]))) });
      if (registered.kind === 'rejected') throw new HttpError(...FREE_STATUS[registered.code]);
      const output = await ownedSnapshot(session, store);
      captureReplies.set(output, registered.capture);
      return [registered.kind === 'registered' ? 201 : 200, output];
    },

    'POST /api/recording-reference': async (req, _res, store) => {
      // Authenticate before allocating the separately bounded audio body. General mutations stay at16KiB.
      const session = await requireSession(req);
      if (recordingReaders >= 2) throw new HttpError(429, 'capacity');
      if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'unsupported_media_type');
      let body;
      recordingReaders++;
      const readTimer = setTimeout(() => req.destroy(), 10_000);
      try { body = await readJson(req, RECORDING.maxJsonBytes); }
      finally { clearTimeout(readTimer); recordingReaders--; }
      if (Object.keys(body).some(k => !['actionKey', 'receipt', 'audio', 'cue'].includes(k)) || !isHandle(body.receipt) ||
        typeof body.actionKey !== 'string' || !ACTION_KEY.test(body.actionKey) || typeof body.audio !== 'string' ||
        body.audio.length === 0 || body.audio.length > Math.ceil(RECORDING.maxWavBytes / 3) * 4 ||
        body.audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.audio)) throw new HttpError(400, 'bad_request');
      const audio = Buffer.from(body.audio, 'base64');
      try {
        if (audio.toString('base64') !== body.audio) throw new HttpError(400, 'bad_request');
        let info;
        try { info = inspectPcmWav(audio); } catch { throw new HttpError(422, 'invalid_source', 'Record between 5 and 60 seconds of music.'); }
        const digest = createHash('sha256').update(audio).digest('hex');
        const cue = boundedText(body.cue, LIMITS.listenerCueChars);
        if (!referenceAdapter) throw new HttpError(503, 'providers_disabled');
        if (deps.sourcePolicy && !deps.sourcePolicy.allowsRecording(digest, now())) throw new HttpError(422, 'unsupported_source', 'This recording cannot be analysed here. Choose another song.');
        const reference = { kind: 'recorded' as const, receipt: body.receipt, sha256: digest, frames: info.frames };
        const admitted = await store.admitReference({ sessionId: session.id, epoch: session.epoch, now: now(), reference, listenerCue: cue,
          actionKeyHash: actionHash(session, body.actionKey), inputHash: sha256(canonicalJson(scopedInput(req, ['recording-reference', body.receipt, digest, info.frames, cue]))) });
        if (admitted.kind === 'rejected') throw new HttpError(ADMIT_STATUS[admitted.code], admitted.code);
        if (admitted.kind === 'replay') return [200, await ownedSnapshot(session, store)];
        await trackWork(session, admitted.attempt.id, () => runReferenceStage({ store, adapter: referenceAdapter, now, inflight }, admitted.attempt, { reference, listenerCue: cue, audio }));
        return [200, await ownedSnapshot(session, store)];
      } finally { audio.fill(0); }
    },

    'POST /api/reference': async (req, _res, store) => {
      const body = await readJson(req);
      const session = await requireSession(req);
      if (typeof body.actionKey !== 'string' || !ACTION_KEY.test(body.actionKey)) throw new HttpError(400, 'bad_request');

      const source = parseYouTubeReference(body.url);
      if (!source.ok) throw new HttpError(422, 'invalid_source', source.message);
      let focus;
      if (body.focus !== undefined) {
        const checked = validateFocus(body.focus);
        if (!checked.ok) throw new HttpError(422, 'invalid_focus', checked.message);
        focus = checked.focus;
      } else if (source.timestamp.kind === 'invalid') {
        throw new HttpError(422, 'needs_focus_correction', 'The time in the link is unclear. Set the start and end.');
      } else {
        focus = defaultFocus(source.timestamp.kind === 'valid' ? source.timestamp.start : 0);
      }
      if (body.cue !== undefined && body.cue !== null && typeof body.cue !== 'string') throw new HttpError(400, 'bad_request');
      const cue = typeof body.cue === 'string' && body.cue.trim() !== '' ? body.cue.trim() : null;
      if (cue !== null && cue.length > LIMITS.listenerCueChars) throw new HttpError(422, 'bad_request', 'That note is too long.');

      const reference = { videoId: source.videoId, canonicalUrl: source.canonicalUrl, focus };
      const inputHash = sha256(JSON.stringify(scopedInput(req, ['reference', reference.videoId, focus.start, focus.end, cue])));
      if (!referenceAdapter) throw new HttpError(503, 'providers_disabled');
      // Eligible-source policy: refused before any admission, count or dispatch; no workaround is offered.
      if (deps.sourcePolicy && !deps.sourcePolicy.allows(reference.videoId, now())) {
        throw new HttpError(422, 'unsupported_source', 'This song cannot be analysed here. Choose another song.');
      }

      const admitted = await store.admitReference({
        sessionId: session.id,
        epoch: session.epoch,
        now: now(),
        reference,
        listenerCue: cue,
        actionKeyHash: actionHash(session, body.actionKey),
        inputHash,
      });
      if (admitted.kind === 'rejected') throw new HttpError(ADMIT_STATUS[admitted.code], admitted.code);
      // An exact replay returns the snapshot of the operation it owns, which is the current one.
      if (admitted.kind === 'replay') return [200, await ownedSnapshot(session, store)];

      await trackWork(session, admitted.attempt.id, () => runReferenceStage({ store, adapter: referenceAdapter, now, inflight }, admitted.attempt, { reference, listenerCue: cue }));
      return [200, await ownedSnapshot(session, store)];
    },

    'POST /api/preference': async (req, _res, store) => {
      const body = await readJson(req);
      const session = await requireSession(req);
      if (!isHandle(body.analysis) || typeof body.actionKey !== 'string' || !ACTION_KEY.test(body.actionKey)) {
        throw new HttpError(400, 'bad_request');
      }
      if (body.expectedBrief !== null && !isHandle(body.expectedBrief)) throw new HttpError(400, 'bad_request');
      const expectedBrief = body.expectedBrief as Handle | null;
      const bucket = await store.read(session.id, session.epoch, now());
      const analysis = bucket?.analysis;
      if (!analysis || analysis.id !== body.analysis) throw new HttpError(409, 'stale_version');

      let relationship: string | null;
      let source: RelationshipSource;
      const rel = body.relationship;
      if (typeof rel !== 'object' || rel === null || Array.isArray(rel)) throw new HttpError(400, 'bad_request');
      const r = rel as Record<string, unknown>;
      if (body.automatic !== undefined && body.automatic !== true) throw new HttpError(400, 'bad_request');
      if (body.automatic === true && (!isStreamedReference(analysis.reference) || r.choice !== 0 || r.text !== undefined)) throw new HttpError(400, 'bad_request');
      if (r.choice !== undefined && r.text === undefined) {
        if (!Number.isSafeInteger(r.choice) || (r.choice as number) < 0) throw new HttpError(400, 'bad_request');
        relationship = analysis.relationships[r.choice as number] ?? null;
        if (!relationship) throw new HttpError(422, 'bad_request');
        source = body.automatic === true ? 'automatic_match' : 'analysis_choice';
      } else if (r.text !== undefined && r.choice === undefined) {
        relationship = boundedText(r.text, LIMITS.listenerCueChars);
        if (!relationship) throw new HttpError(422, 'bad_request', 'Say what you want to keep.');
        source = bucket?.journey?.listenerCue === relationship ? 'intake_cue' : 'listener_text';
      } else {
        throw new HttpError(400, 'bad_request');
      }

      if (body.artists !== undefined && (!Array.isArray(body.artists) || body.artists.length > LIMITS.maxSeeds)) {
        throw new HttpError(422, 'bad_request', 'Name at most two artists.');
      }
      const artists: string[] = [];
      for (const a of (body.artists as unknown[] | undefined) ?? []) {
        const name = boundedText(a, LIMITS.artistNameChars);
        if (name && !artists.some((x) => x.toLowerCase() === name.toLowerCase())) artists.push(name);
      }

      const input = { analysisId: analysis.id, relationship, relationshipSource: source, proposedArtists: artists, exclusions: [] };
      const saved = await store.saveBrief(
        { sessionId: session.id, epoch: session.epoch },
        input,
        {
          actionKeyHash: freeActionHash(session, body.actionKey),
          inputHash: sha256(canonicalJson(scopedInput(req, ['preference', input, expectedBrief]))),
          expectedBriefId: expectedBrief,
        },
        now(),
      );
      if (saved.kind === 'rejected') throw new HttpError(...FREE_STATUS[saved.code]);
      // Only the Attempt the atomic store reports as revoked (because intent changed) is aborted.
      if (saved.revokedAttemptId) inflight.get(saved.revokedAttemptId)?.abort('stopped');
      return [200, await ownedSnapshot(session, store)];
    },

    'POST /api/artist-choice': async (req, _res, store) => {
      const body = await readJson(req);
      const session = await requireSession(req);
      if (
        !isHandle(body.checkpoint) ||
        !Number.isSafeInteger(body.slot) ||
        !Number.isSafeInteger(body.expectedRevision) ||
        (body.choice !== null && !isHandle(body.choice)) ||
        typeof body.actionKey !== 'string' ||
        !ACTION_KEY.test(body.actionKey)
      ) {
        throw new HttpError(400, 'bad_request');
      }
      const input = { checkpointId: body.checkpoint, slot: body.slot as number, choice: body.choice as Handle | null };
      const expectedRevision = body.expectedRevision as number;
      const result = await store.chooseArtist(
        { sessionId: session.id, epoch: session.epoch },
        input,
        {
          actionKeyHash: freeActionHash(session, body.actionKey),
          inputHash: sha256(canonicalJson(scopedInput(req, ['artist-choice', input, expectedRevision]))),
          expectedRevision,
        },
        now(),
      );
      if (result !== 'ok' && result !== 'unchanged' && result !== 'replay') throw new HttpError(...FREE_STATUS[result]);
      return [200, await ownedSnapshot(session, store)];
    },

    /** Free, independent fit/familiarity save for one exact owned displayed choice. Never dispatches. */
    'POST /api/feedback': async (req, _res, store) => {
      const body = await readJson(req);
      const session = await requireSession(req);
      if (
        !isHandle(body.panel) ||
        !isHandle(body.choice) ||
        !FITS.includes(body.fit as Fit) ||
        !FAMILIARITIES.includes(body.familiarity as Familiarity) ||
        !Number.isSafeInteger(body.expectedRevision) ||
        (body.expectedRevision as number) < 0 ||
        typeof body.actionKey !== 'string' ||
        !ACTION_KEY.test(body.actionKey)
      ) {
        throw new HttpError(400, 'bad_request');
      }
      const input = { panelId: body.panel, choice: body.choice, fit: body.fit as Fit, familiarity: body.familiarity as Familiarity };
      const expectedRevision = body.expectedRevision as number;
      const result = await store.saveFeedback(
        { sessionId: session.id, epoch: session.epoch },
        input,
        {
          actionKeyHash: freeActionHash(session, body.actionKey),
          inputHash: sha256(canonicalJson(scopedInput(req, ['feedback', input, expectedRevision]))),
          expectedRevision,
        },
        now(),
      );
      if (result !== 'ok' && result !== 'unchanged' && result !== 'replay') throw new HttpError(...FREE_STATUS[result]);
      return [200, await ownedSnapshot(session, store)];
    },

    /**
     * One explicit refinement against the single shared Journey allowance.
     * follow_connection: a positively rated owned choice whose owned anchor is followed.
     * correct_direction: corrected relationship and/or explicit owned-artist exclusions over the reused pool.
     * The consumed pool's sealed identities and fingerprint are re-validated before admission, so an
     * invalid request spends nothing.
     */
    'POST /api/refine': async (req, _res, store) => {
      const body = await readJson(req);
      const session = await requireSession(req);
      const mode = body.mode as RefinementMode;
      if (typeof body.actionKey !== 'string' || !ACTION_KEY.test(body.actionKey) || !MODES.includes(mode) || !isHandle(body.panel) || !isHandle(body.brief)) {
        throw new HttpError(400, 'bad_request');
      }
      const follow = mode === 'follow_connection';
      if (follow ? !isHandle(body.choice) || body.relationship !== undefined || body.excludeArtists !== undefined : body.choice !== undefined) {
        throw new HttpError(400, 'bad_request');
      }
      const exclude = body.excludeArtists ?? [];
      if (!Array.isArray(exclude) || exclude.length > LIMITS.artistCandidates || !exclude.every(isHandle) || new Set(exclude).size !== exclude.length) {
        throw new HttpError(400, 'bad_request');
      }
      if (!discovery) throw new HttpError(503, 'providers_disabled');
      const actionKeyHash = actionHash(session, body.actionKey);
      const excludedAnchors = [...(exclude as Handle[])].sort();
      // An already-bound key is answered first: exact replay returns its owned snapshot, a changed input conflicts.
      const prior = await store.checkAction(
        { sessionId: session.id, epoch: session.epoch },
        actionKeyHash,
        sha256(canonicalJson(scopedInput(req, ['refine-key', mode, body.panel, body.brief, follow ? body.choice : null, body.relationship ?? null, excludedAnchors]))),
        now(),
      );
      if (prior?.kind === 'rejected') throw new HttpError(ADMIT_STATUS[prior.code], prior.code);
      if (prior?.kind === 'replay') return [200, await ownedSnapshot(session, store)];
      const bucket = await store.read(session.id, session.epoch, now());
      const journey = bucket?.journey;
      const panel = bucket?.panel;
      const analysis = bucket?.analysis;
      // Early, read-only answers for the common refusals; the store re-decides all of them atomically.
      if (bucket?.attempt?.outcome === 'running') throw new HttpError(409, 'operation_active');
      if (journey?.refinementUsed) throw new HttpError(409, 'refinement_used');
      if (!bucket || !journey || !panel || !analysis || panel.id !== body.panel) throw new HttpError(409, 'stale_version');
      const plan = bucket.plans.find((p) => p.id === panel.planId);
      const pool = plan ? bucket.pools.find((p) => p.id === plan.poolId) : undefined;
      const sourceBrief = pool ? bucket.briefs.find((b) => b.id === pool.sourceBriefId) : undefined;
      if (!plan || !pool || !sourceBrief) throw new HttpError(409, 'stale_version');
      const identityOwner = { sessionId: session.id, epoch: session.epoch, journeyId: journey.id, expiresAt: journey.expiresAt };
      const valid = validateOwnedPool({
        pool,
        sourceBrief,
        analysisId: analysis.id,
        reference: analysis.reference,
        identities: ownedIdentities(bucket.searches, bucket.pools),
        owner: identityOwner,
        now: now(),
        sealer: discovery.sealer,
      });
      if (!valid) throw new HttpError(409, 'stale_version', 'The earlier artist connections are no longer valid, so nothing was started.');

      let relationship: { text: string; source: RelationshipSource } | null = null;
      if (follow) {
        const choice = panel.choices.find((c) => c.handle === body.choice);
        const anchor = choice ? pool.artists.find((a) => a.handle === choice.anchor.handle) : undefined;
        // Only the owned anchor of an owned displayed choice can become a seed (never a collaborator or browser UUID).
        if (!choice || !anchor || !rehydrateIdentity(anchor.identity, identityOwner, now(), discovery.sealer)) throw new HttpError(409, 'stale_version');
      } else {
        if (body.relationship !== undefined && body.relationship !== null) {
          const r = body.relationship as Record<string, unknown>;
          if (typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'bad_request');
          if (r.choice !== undefined && r.text === undefined) {
            const text = Number.isSafeInteger(r.choice) && (r.choice as number) >= 0 ? analysis.relationships[r.choice as number] : undefined;
            if (!text) throw new HttpError(422, 'bad_request');
            relationship = { text, source: 'analysis_choice' };
          } else if (r.text !== undefined && r.choice === undefined) {
            const text = boundedText(r.text, LIMITS.listenerCueChars);
            if (!text) throw new HttpError(422, 'bad_request', 'Say what you want to keep.');
            relationship = { text, source: journey.listenerCue === text ? 'intake_cue' : 'listener_text' };
          } else {
            throw new HttpError(400, 'bad_request');
          }
        }
        if (exclude.some((h) => !plan.anchors.some((a) => a.handle === h))) throw new HttpError(409, 'stale_version');
        if (plan.anchors.every((a) => exclude.includes(a.handle))) {
          throw new HttpError(422, 'pool_empty', 'That would leave no connected artists, so nothing was started.');
        }
      }

      const admitted = await store.admitRefine({
        sessionId: session.id,
        epoch: session.epoch,
        now: now(),
        actionKeyHash,
        inputHash: sha256(canonicalJson(scopedInput(req, ['refine-key', mode, body.panel, body.brief, follow ? body.choice : null, body.relationship ?? null, excludedAnchors]))),
        mode,
        panelId: body.panel,
        briefId: body.brief,
        choice: follow ? (body.choice as Handle) : null,
        relationship,
        excludedAnchors,
        poolFingerprint: pool.fingerprint,
      });
      if (admitted.kind === 'rejected') throw new HttpError(ADMIT_STATUS[admitted.code], admitted.code);
      if (admitted.kind === 'replay') return [200, await ownedSnapshot(session, store)];
      await trackWork(session, admitted.attempt.id, () => runRefine({ store, ...discovery, now, inflight }, admitted.attempt));
      return [200, await ownedSnapshot(session, store)];
    },

    'POST /api/discover': async (req, _res, store) => {
      const body = await readJson(req);
      const session = await requireSession(req);
      if (typeof body.actionKey !== 'string' || !ACTION_KEY.test(body.actionKey) || !isHandle(body.brief)) {
        throw new HttpError(400, 'bad_request');
      }
      if (!discovery) throw new HttpError(503, 'providers_disabled');
      const admitted = await store.admitDiscover({
        sessionId: session.id,
        epoch: session.epoch,
        now: now(),
        briefId: body.brief,
        actionKeyHash: actionHash(session, body.actionKey),
        inputHash: sha256(JSON.stringify(scopedInput(req, ['discover', body.brief]))),
      });
      if (admitted.kind === 'rejected') throw new HttpError(ADMIT_STATUS[admitted.code], admitted.code);
      if (admitted.kind === 'replay') return [200, await ownedSnapshot(session, store)];
      await trackWork(session, admitted.attempt.id, () => runDiscover({ store, ...discovery, now, inflight }, admitted.attempt));
      return [200, await ownedSnapshot(session, store)];
    },

    'POST /api/stop': async (req, _res, store) => {
      const body = await readJson(req);
      const session = await requireSession(req, 'revoke');
      let attemptId: Handle | null;
      if (typeof body.actionKey === 'string' && body.attempt === undefined) {
        if (!ACTION_KEY.test(body.actionKey)) throw new HttpError(400, 'bad_request');
        const stopped = await store.stopAction(session.id, session.epoch, actionHash(session, body.actionKey), now());
        if (!stopped) throw new HttpError(404, 'not_found');
        attemptId = stopped.attemptId;
      } else if (typeof body.attempt === 'string' && body.actionKey === undefined && body.attempt.length <= 64) {
        attemptId = body.attempt as Handle;
        if (!(await store.stopAttempt(session.id, session.epoch, attemptId, now()))) throw new HttpError(404, 'not_found');
      } else {
        throw new HttpError(400, 'bad_request');
      }
      if (attemptId) inflight.get(attemptId)?.abort('stopped');
      return [200, await ownedSnapshot(session, store)];
    },

    'DELETE /api/session': async (req, res, store) => {
      const { session } = await currentSession(req, 'revoke');
      if (session) {
        // Revoke first, with no private read before it; then abort the local work of the Attempt that was current.
        // A store failure throws: no acknowledgement is sent and the cookie is kept, so the client keeps its Clear intent.
        invalidateDeliveries(session);
        try {
          for (const id of sessionWork.get(session.id) ?? []) inflight.get(id)?.abort('cleared');
          const attemptId = await store.clearSession(session.id);
          if (attemptId) inflight.get(attemptId)?.abort('cleared');
        } finally {
          // Also invalidate reads begun while the revocation was awaiting its
          // store result, including a failed Clear which must remain retryable.
          invalidateDeliveries(session);
        }
      }
      setCookie(res, '', 0);
      return [200, snapshot(null)];
    },
  };

  const live = createLiveUpgrade(async req => {
    if (!liveAllowed() || !referenceAdapter) throw new HttpError(503, 'providers_disabled');
    if (req.method !== 'GET' || req.headers.host !== config.hostHeader || req.headers.origin !== config.origin ||
      (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new HttpError(403, 'bad_origin');
    const url = new URL(req.url ?? '', config.origin);
    if (url.pathname !== '/api/live-reference' || [...url.searchParams.keys()].some(k => k !== 'chat')) throw new HttpError(400, 'bad_request');
    const chat = requestChat(req), scope = chat ? store.forChat(chat) : store;
    const session = await requireSession(req), owner = { sessionId: session.id, epoch: session.epoch };
    if (!await scope.authorizeRead(owner, now())) throw new HttpError(401, 'no_session');
    return async (msg, channel) => {
      if (typeof msg.actionKey !== 'string' || !ACTION_KEY.test(msg.actionKey)) throw new HttpError(400, 'bad_request');
      const cue = boundedText(msg.cue, LIMITS.listenerCueChars), key = actionHash(session, msg.actionKey);
      let attempt: Handle | undefined;
      const cancel = () => {
        if (attempt) inflight.get(attempt)?.abort('stream_closed');
        void scope.stopAction(session.id, session.epoch, key, now()).catch(() => {});
      };
      channel.signal.addEventListener('abort', cancel, { once: true });
      try {
        if (channel.signal.aborted || !liveAllowed()) throw new HttpError(409, 'cancelled');
        const admitted = await scope.admitReference({ ...owner, now: now(), reference: { kind: 'streamed' }, listenerCue: cue,
          actionKeyHash: key, inputHash: sha256(canonicalJson(scopedInput(req, ['live-reference', deps.sourcePolicy!.version, cue]))) });
        if (admitted.kind === 'rejected') throw new HttpError(ADMIT_STATUS[admitted.code], admitted.code);
        if (admitted.kind === 'replay') return; // An exact replay never attaches a new stream or reconnects.
        attempt = admitted.attempt.id;
        if (channel.signal.aborted || deps.shutdown?.aborted) { await scope.stopAction(session.id, session.epoch, key, now()); throw new HttpError(409, 'cancelled'); }
        const reference = admitted.journey.reference;
        if (!('kind' in reference) || reference.kind !== 'streamed') throw new HttpError(500, 'admission_unavailable');
        const stream = createLiveAudioInput(reference.receipt, channel.signal, () => channel.ready(), now); channel.attach(stream);
        try { await trackWork(session, attempt, () => runReferenceStage({ store: scope, adapter: referenceAdapter, now, inflight }, admitted.attempt, { reference, listenerCue: cue, stream })); }
        finally { stream.cancel(); }
      } finally { channel.signal.removeEventListener('abort', cancel); }
    };
  }, error => error instanceof HttpError ? error.code : 'admission_unavailable');
  deps.shutdown?.addEventListener('abort', live.close, { once: true });
  if (deps.shutdown?.aborted) live.close();
  const handler: ApiHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status: number, body: unknown) => {
      if (deps.shutdown?.aborted) {
        status = 503;
        body = { error: 'admission_unavailable', message: null };
      }
      if (!res.headersSent) res.statusCode = status;
      res.end(JSON.stringify(body));
    };
    try {
      if (deps.shutdown?.aborted) throw new StoreUnavailable();
      if (req.headers.host !== config.hostHeader) throw new HttpError(421, 'bad_host');
      const path = (req.url ?? '').split('?')[0] ?? '';
      const chat = requestChat(req);
      const scope = chat ? store.forChat(chat) : store;
      const suggestions = /^\/api\/suggestions\/([A-Za-z0-9_-]{24})$/.exec(path);
      if (suggestions && req.method === 'GET') {
        await serveSuggestions(req, res, suggestions[1] as Handle, scope);
        return;
      }
      if (path === '/api/concerts/capability' && req.method === 'GET') {
        send(200, { available: config.mode === 'live' && deps.concerts?.available() === true }); return;
      }
      if (path === '/api/concerts' && req.method === 'POST') {
        if (req.headers.origin !== config.origin || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) throw new HttpError(403, 'bad_origin');
        const query = await readJson(req);
        if (!isConcertQuery(query)) throw new HttpError(400, 'bad_request');
        if (config.mode !== 'live' || !deps.concerts?.available()) throw new HttpError(503, 'providers_disabled');
        const session = await requireSession(req), token = deliveryToken(session), owner = { sessionId: session.id, epoch: session.epoch };
        const abort = new AbortController();
        const work = concertWork.get(session.id) ?? new Set<AbortController>();
        if (work.size) throw new HttpError(409, 'operation_active');
        work.add(abort); concertWork.set(session.id, work);
        const cancel = () => abort.abort();
        req.once('aborted', cancel); res.once('close', cancel); deps.shutdown?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, Math.max(0, Math.min(30000, session.expiresAt - now())));
        const isCurrent = () => !abort.signal.aborted && locallyCurrent(session, token) && deliverable(session.expiresAt) === 'ok' && !deps.shutdown?.aborted;
        const authorize = async () => isCurrent() && await store.authorizeRead(owner, now()) && isCurrent();
        const admitOwned = store.withAuthorizedOperation?.bind(store);
        const authorizeAdmission: TicketmasterAuthorization | undefined = admitOwned ? async plan => {
          if (!isCurrent()) return null;
          const result = await admitOwned(owner, now(), async tx => {
            if (!isCurrent()) throw new StoreUnavailable();
            const value = await plan(tx);
            if (!isCurrent()) throw new StoreUnavailable();
            return value;
          });
          return isCurrent() ? result : null;
        } : undefined;
        try {
          if (!await authorize()) throw new HttpError(401, 'no_session');
          const result = await deps.concerts.search(query, { signal: abort.signal, authorize, isCurrent, ...(authorizeAdmission ? { authorizeAdmission } : {}) });
          if (!isConcertReply(result)) throw new HttpError(503, 'provider_unavailable');
          // Last shared read immediately precedes synchronous emission, as for private snapshots.
          if (!await authorize() || !isCurrent()) throw new HttpError(401, 'no_session');
          send(200, result);
        } catch (error) {
          if (error instanceof HttpError || error instanceof StoreUnavailable) throw error;
          throw new HttpError(error instanceof Error && error.message === 'limited' ? 429 : 503, error instanceof Error && error.message === 'limited' ? 'rate_limited' : 'provider_unavailable');
        } finally {
          // Retire the writable admission capability with this HTTP request,
          // including detached continuations after an otherwise successful reply.
          abort.abort();
          clearTimeout(timer); req.off('aborted', cancel); res.off('close', cancel); deps.shutdown?.removeEventListener('abort', cancel);
          work.delete(abort); if (!work.size) concertWork.delete(session.id);
        }
        return;
      }
      const route = routes[`${req.method} ${path}`];
      if (!route) throw new HttpError(404, 'not_found');
      if (req.method !== 'GET') {
        if (req.headers.origin !== config.origin) throw new HttpError(403, 'bad_origin');
        const site = req.headers['sec-fetch-site'];
        if (site !== undefined && site !== 'same-origin') throw new HttpError(403, 'bad_origin');
      }
      const [status, body] = await route(req, res, scope);
      const ticket = privateSnapshots.get(body);
      const session = ticket?.bucket.session;
      const authorized = !!ticket && locallyCurrent(session!, ticket.token) && deliverable(session!.expiresAt) === 'ok' &&
        await ticket!.scope.authorizeRead({ sessionId: session!.id, epoch: session!.epoch }, now(), ticket!.bucket.chats?.revision);
      // The minimal durable authorization is the last asynchronous step. Local
      // Clear, expiry and shutdown are checked again after synchronous projection.
      const output = ticket ? snapshot(authorized && locallyCurrent(session!, ticket.token) ? ticket.bucket : null, ticket.code) : body;
      const capture = captureReplies.get(body);
      const reply = capture && ticket && authorized && locallyCurrent(session!, ticket.token) && now() < capture.usableUntil && output.session
        ? { ...output, captureReceipt: { receipt: capture.id, durationMs: capture.frames * 1000 / RECORDING.sampleRate, expiresAt: capture.usableUntil,
          approved: referenceAdapter !== null && (!deps.sourcePolicy || deps.sourcePolicy.allowsRecording(capture.sha256, now())) } } : output;
      const verdict = deliverable(session?.expiresAt);
      if (verdict === 'expired') send(401, { error: 'session_expired', message: null });
      else if (verdict === 'unavailable') send(503, { error: 'admission_unavailable', message: null });
      else send(status, ticket && !locallyCurrent(session!, ticket.token) ? snapshot(null) : reply);
    } catch (err) {
      if (err instanceof HttpError) {
        send(err.status, { error: err.code, message: err.detail ?? null });
      } else if (err instanceof StoreUnavailable) {
        send(503, { error: 'admission_unavailable', message: null });
      } else {
        send(500, { error: 'internal', message: null });
      }
    }
  };
  return Object.assign(handler, { upgrade: live.upgrade, closeLive: live.close });
}
