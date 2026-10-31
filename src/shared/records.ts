// Typed records from HARNESS_AND_API H01, shared by the implemented reference,
// discovery, feedback and refinement stages. Runtime validators and owned-record
// projections enforce the boundaries; these declarations alone grant no authority.
import type { AppleArtwork } from './apple-artwork.js';

/** Opaque, unpredictable server-generated handle. Never a provider identifier. */
export type Handle = string & { readonly __handle: unique symbol };

export type RuntimeMode = 'disabled' | 'synthetic' | 'live';

export const LIMITS = {
  mutationBodyBytes: 16 * 1024,
  sourceUrlChars: 2048,
  focusMaxSeconds: 60,
  focusDefaultSeconds: 45,
  listenerCueChars: 1000,
  artistNameChars: 128,
  maxSeeds: 2,
  observations: 5,
  observationChars: 500,
  relationships: 3,
  relationshipChars: 300,
  artistCandidates: 15,
  tags: 15,
  identityChoicesShown: 5,
  trackChoicesPerPanel: 3,
  creditedArtists: 8,
  briefVersionsPerSession: 20,
  liveRecordsPerSession: 64,
  sessionLifetimeMs: 60 * 60 * 1000,
  executeDeadlineMs: 120_000,
  providerRequestMs: 90_000,
  actionKeyChars: 64,
  catalogueHandoffBytes: 16 * 1024,
  searchTake: 5,
  insightsTake: 15,
  searchesPerJourney: 4,
  discoverRunsPerJourney: 2,
  exclusions: 16,
  freeActionBindingsPerSession: 64,
  /** Final 20 execute seconds are reserved for validation and commit. */
  validationReserveMs: 20_000,
  metadataRequestsPerExecute: 12,
  metadataConcurrency: 3,
  metadataRequestMs: 5_000,
  metadataRedirects: 3,
  catalogueTextBytes: 512 * 1024,
} as const;

export type Stage =
  | 'idle'
  | 'validating'
  | 'analysing_reference'
  | 'awaiting_preference'
  | 'resolving_artists'
  | 'awaiting_artist'
  | 'retrieving_taste'
  | 'finding_tracks'
  | 'complete'
  | 'no_match'
  | 'failed'
  | 'cancelled'
  | 'expired';

export type StatusName = 'reference_ready' | 'artist_choices_ready' | 'connection_ready' | 'choices_ready';

export interface Focus {
  readonly start: number;
  readonly end: number;
}

export interface YouTubeReference {
  readonly videoId: string;
  readonly canonicalUrl: string;
  readonly focus: Focus;
}

/** Private metadata only; captured audio never belongs in a durable record. */
export interface RecordedReference {
  readonly kind: 'recorded';
  readonly receipt: Handle;
  readonly sha256: string;
  readonly frames: number;
}
/** A server-minted identity for one live input, never a fabricated completed-file digest. */
export interface StreamedReference {
  readonly kind: 'streamed';
  readonly receipt: Handle;
}
export type CanonicalReference = YouTubeReference | RecordedReference | StreamedReference;
/** The transaction mints the live receipt; callers cannot choose or replay an audio stream. */
export type ReferenceAdmission = YouTubeReference | RecordedReference | { readonly kind: 'streamed' };
/** The digest is private source-policy data, never a public correlation handle. */
export type SafeReference = YouTubeReference | { readonly kind: 'recorded'; readonly receipt: Handle; readonly durationMs: number } | StreamedReference;
export const isRecordedReference = <T extends CanonicalReference | SafeReference>(ref: T): ref is Extract<T, { kind: 'recorded' }> => 'kind' in ref && ref.kind === 'recorded';
export const isStreamedReference = <T extends CanonicalReference | SafeReference>(ref: T): ref is Extract<T, { kind: 'streamed' }> => 'kind' in ref && ref.kind === 'streamed';
export const isAudioReference = <T extends CanonicalReference | SafeReference>(ref: T): ref is Extract<T, { kind: 'recorded' | 'streamed' }> => isRecordedReference(ref) || isStreamedReference(ref);

export interface CapturedInput extends Owned {
  readonly id: Handle;
  readonly chat: Handle;
  readonly sha256: string;
  readonly frames: number;
  /** Fixed at registration; never extended by consumption or replay. */
  readonly usableUntil: number;
  consumedAttempt: Handle | null;
}

interface Owned {
  readonly sessionId: Handle;
  readonly epoch: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface Session {
  readonly id: Handle;
  /** SHA-256 of the cookie secret; the secret itself is never stored. */
  readonly secretHash: string;
  readonly createdAt: number;
  /** Fixed at creation; never extended. */
  readonly expiresAt: number;
  epoch: number;
  revoked: boolean;
}

/** Reviewed first-pair submission bounds, shared by every stage of a Journey (and a session). */
export const DISPATCH_CAPS = { qloo: 6, gemini: 4 } as const;
export type ProviderKind = keyof typeof DISPATCH_CAPS;

/** Server-owned E07 summaries. Never included in SafeSnapshot or Suggestions. */
export interface TimingTotals {
  processingMs: number;
  listenerWaitMs: number;
  unobservedMs: number;
}
export interface TimingMilestone extends TimingTotals {
  at: number;
  quality: 'complete' | 'partial';
}
export interface JourneyTiming extends TimingTotals {
  version: 1;
  phase: 'processing' | 'awaiting_listener' | 'closed';
  cursorAt: number;
  quality: 'complete' | 'partial';
  /** recovering: a backwards sample made the next interval unclassifiable. */
  clock: 'ordered' | 'recovering' | 'regressed';
  milestones: Record<'reference_result' | 'connection' | 'panel_outcome' | 'recording_choices', TimingMilestone | null | 'unknown'>;
}
export interface AttemptTiming {
  version: 1;
  finishedAt: number | null;
  recordedAt: number | null;
  finishBasis: 'transition' | 'deadline' | 'clock_regression' | null;
}

export interface Journey extends Owned {
  /** Omission is legacy unknown, never a measured zero. */
  timing?: JourneyTiming;
  readonly id: Handle;
  readonly reference: CanonicalReference;
  readonly listenerCue: string | null;
  stage: Stage;
  revision: number;
  analysisId: Handle | null;
  /** The listener's current confirmed BriefVersion. Versions themselves are immutable. */
  currentBriefId: Handle | null;
  /** Counted at reservation; never decremented (dispatched/unknown work stays counted). */
  counts: { gemini: number; qloo: number };
  /** Initial discovery plus at most one eligible explicit retry; a human-boundary continuation is not a new run. */
  discoverRuns: number;
  /** One useful identity clarification per Journey. */
  clarificationUsed: boolean;
  refinementUsed: boolean;
}

export type RefinementMode = 'follow_connection' | 'correct_direction';
export type RelationshipSource = 'analysis_choice' | 'listener_text' | 'intake_cue' | 'automatic_match';

/** Recording-level fit and familiarity are independent; neither implies the other or anything about the artist. */
export type Fit = 'like' | 'not_right' | null;
export type Familiarity = 'new' | 'known' | null;

/**
 * Current, editable listener feedback for one exact displayed TrackChoice of one
 * owned panel. Free to save; never dispatches. Admitted refinements copy the
 * values they used into their own immutable provenance, so later edits here
 * never rewrite what an admitted operation consumed.
 */
export interface ChoiceFeedback extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  readonly panelId: Handle;
  readonly choiceHandle: Handle;
  fit: Fit;
  familiarity: Familiarity;
  /** Increments on every applied change; clients send it back as an optimistic guard. */
  revision: number;
  updatedAt: number;
}

/** Immutable basis of a refinement brief, fixed at admission. */
export interface RefinementBasis {
  readonly mode: RefinementMode;
  readonly fromPanelId: Handle;
  readonly fromBriefId: Handle;
  readonly fromPlanId: Handle;
  /** follow_connection: the positively rated owned choice and its owned pool anchor. */
  readonly followChoice: Handle | null;
  readonly followAnchor: Handle | null;
  /** correct_direction: owned anchors of the reused pool the listener explicitly left out. */
  readonly excludedAnchors: readonly Handle[];
  /** Immutable copy of the feedback as it stood when the refinement was admitted. */
  readonly admittedFeedback: readonly { readonly choice: Handle; readonly fit: Fit; readonly familiarity: Familiarity }[];
}

/** Immutable listener brief. A changed save creates a new version; an identical save returns the existing one. */
export interface BriefVersion extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  readonly version: number;
  /** The owned ReferenceAnalysis this brief was saved against (explicit reuse link, not a rewrite). */
  readonly analysisId: Handle;
  readonly relationship: string;
  readonly relationshipSource: RelationshipSource;
  /** Up to two public artist names proposed by the listener or analysis; unresolved until checked. */
  readonly proposedArtists: readonly string[];
  readonly exclusions: readonly string[];
  /** Null for a listener-saved brief; set (immutably) for a brief created by an admitted refinement. */
  readonly refinement: RefinementBasis | null;
  readonly contentHash: string;
}

export type AudioAccess = 'synthetic_not_accessed' | 'accessed' | 'unavailable' | 'refused';

/** Provider usage numbers as returned; never a billing settlement. */
export interface ProviderUsage {
  readonly totalInputTokens: number | null;
  readonly totalOutputTokens: number | null;
  readonly totalThoughtTokens: number | null;
  readonly totalCachedTokens: number | null;
  readonly totalToolUseTokens: number | null;
  readonly totalTokens: number | null;
  readonly inputTokensByModality: readonly { readonly modality: string; readonly tokens: number }[];
}

/** Server-only provider metadata. Never part of a client snapshot. */
export interface PrivateReferenceResult {
  readonly model: string;
  /** Complete final model_output text as returned (no thought content). */
  readonly finalText: string;
  readonly usage: ProviderUsage | null;
  /** Model-proposed artist name; uncertain until resolved against Qloo. */
  readonly uncertainArtistName: string | null;
}

export interface ReferenceAnalysis extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  /** Immutable creation provenance: the Attempt that produced it. */
  readonly createdByAttemptId: Handle;
  readonly reference: CanonicalReference;
  readonly audioAccess: AudioAccess;
  /** True when produced by the synthetic adapter; must be shown as such. */
  readonly synthetic: boolean;
  readonly observations: readonly string[];
  readonly relationships: readonly string[];
  readonly provider: PrivateReferenceResult | null;
}

/**
 * Server-only artist identity from a Qloo response, sealed (HMAC) together with
 * its owner binding and provenance. Stored as plain JSON; it only regains
 * authority through the rehydration boundary, which re-checks owner, expiry,
 * UUID shape and seal. Browser input never carries one.
 */
export interface SealedArtistIdentity {
  readonly entityId: string;
  readonly name: string;
  readonly disambiguation: string | null;
  readonly external: Readonly<Record<string, readonly string[]>>;
  readonly subtypeEvidence: 'subtype' | 'types';
  readonly provenance: { readonly operation: 'search' | 'artist_insights'; readonly sourceRecordId: Handle };
  readonly owner: { readonly sessionId: Handle; readonly epoch: number; readonly journeyId: Handle; readonly expiresAt: number };
  readonly seal: string;
}

export interface ArtistCandidate {
  readonly handle: Handle;
  readonly identity: SealedArtistIdentity;
}

/** One completed Qloo Search, reusable within the Journey for the same normalised query. */
export interface SearchRecord extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly candidates: readonly ArtistCandidate[];
  readonly returned: number;
  readonly rejected: number;
}

export type SeedStatus = 'pending' | 'resolved' | 'ambiguous' | 'not_found' | 'skipped';

export interface SeedSlot {
  readonly proposal: string;
  readonly searchId: Handle | null;
  readonly status: SeedStatus;
  /** Owned candidate handles offered (at most five) or the single resolved one. */
  readonly options: readonly Handle[];
  readonly chosen: Handle | null;
}

/** Owned identity checkpoint for one BriefVersion. Choices are free saves; continuation is explicit. */
export interface IdentityCheckpoint extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  readonly briefId: Handle;
  slots: SeedSlot[];
  awaiting: boolean;
  /** Increments on every applied choice; clients send it back as an optimistic guard. */
  revision: number;
}

export interface PoolArtist {
  readonly handle: Handle;
  readonly identity: SealedArtistIdentity;
}

export interface PoolTag {
  readonly handle: Handle;
  readonly tagId: string;
  readonly name: string;
  /** Exact returned subtype, or null when omitted by the provider; absence is legacy unknown. */
  readonly subtype?: string | null;
}

export type PoolCapability = 'artists_and_tags' | 'artists_only';

/**
 * Role of a seed in the pool request. 'starting' is the listener's first
 * (reference/start) artist slot, 'favourite' the optional second slot,
 * 'followed' an owned anchor followed by an explicit refinement. A missing
 * role is never fabricated.
 */
export type SeedRole = 'starting' | 'favourite' | 'followed';

export interface PoolSeed {
  /** Owned handle of the sealed identity record (Search candidate or earlier pool artist). */
  readonly handle: Handle;
  readonly name: string;
  readonly entityId: string;
  readonly role: SeedRole;
}

export interface QlooCandidatePool extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  /** Creation provenance: the brief whose seeds produced this pool. */
  readonly sourceBriefId: Handle;
  readonly origin: 'initial' | 'follow_connection';
  /** Binding of seeds, Search queries, reference analysis and source brief; reuse requires an exact recomputed match. */
  readonly fingerprint: string;
  readonly synthetic: boolean;
  readonly seeds: readonly PoolSeed[];
  readonly artists: readonly PoolArtist[];
  readonly tags: readonly PoolTag[];
  readonly capability: PoolCapability;
  readonly lineage: {
    readonly artistReturned: number;
    readonly artistRejected: number;
    /** Returned artists equivalent to a seed or verified exclusion (removed). */
    readonly aliasesRemoved: number;
    /** Returned artists equivalent to an earlier kept neighbour (collapsed). */
    readonly duplicatesRemoved: number;
    readonly tagOutcome: 'returned' | 'unsupported' | 'failed' | 'not_admitted';
    readonly tagReturned: number;
  };
}

export interface InvestigationPlan extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  /** The exact consuming brief version. */
  readonly briefId: Handle;
  readonly briefVersion: number;
  readonly poolId: Handle;
  readonly relationship: string;
  readonly referenceObservations?: readonly string[];
  readonly seedNames: readonly string[];
  readonly anchors: readonly { readonly handle: Handle; readonly name: string }[];
  readonly associations: readonly { readonly handle: Handle; readonly name: string }[];
  /** Artist names whose recordings must not be chosen (seeds and explicit artist exclusions). Never recording keys. */
  readonly exclusions: readonly string[];
  /** Exact recordings excluded by identity, kept separate from artist exclusions. */
  readonly recordingExclusions: {
    /** Every recording already displayed in this Journey (shown in this app). */
    readonly shown: readonly ShownRecording[];
    /** Recording keys the listener marked as already known, as admitted (separate from "shown"). */
    readonly known: readonly string[];
  };
  readonly priorities: readonly string[];
  readonly refinementMode: RefinementMode | null;
  /** Factual refinement facts for the why-chain; null for the initial plan. */
  readonly refinement: {
    readonly followed: string | null;
    readonly keptStarting: string | null;
    readonly replaced: readonly string[];
    readonly excludedArtists: readonly string[];
    readonly relationshipChanged: boolean;
    readonly fromPanelId: Handle;
  } | null;
  readonly attribution: 'seed_mix';
  readonly provenance: {
    readonly analysisId: Handle;
    readonly analysisReuse: 'same_source_focus';
    readonly poolSourceBriefId: Handle;
    /** 'created' by this plan's own Attempt, or reused under the same recomputed fingerprint. */
    readonly poolReuse: 'created' | 'reused_same_fingerprint';
  };
}

/**
 * One recording already displayed, identified by its canonical recording key
 * (shared across providers, storefronts and uploads) plus the provider-scoped
 * identifier of the destination that was shown. A YouTube entry keeps its
 * original `videoId` shape; an Apple Music entry carries `appleTrackId` (an Apple
 * ID is never stored in a field that claims to be a video ID).
 */
export type ShownRecording =
  | { readonly key: string; readonly videoId: string; readonly title: string; readonly credits: readonly string[] }
  | { readonly key: string; readonly appleTrackId: string; readonly title: string; readonly credits: readonly string[] };

/** Recording destinations the native catalogue may verify; a controller binding chooses among them. */
export type RecordingService = 'youtube' | 'apple_music';
export const RECORDING_SERVICES: readonly RecordingService[] = ['youtube', 'apple_music'];

/** An exact, canonically rebuilt listening destination for one verified recording. */
export type RecordingDestination =
  | { readonly kind: 'youtube'; readonly videoId: string; readonly url: string }
  /** Apple Music song: two-letter storefront and decimal catalogue track ID; url is rebuilt from both. */
  | { readonly kind: 'apple_music'; readonly storefront: string; readonly trackId: string; readonly url: string };

/** A validated native grounding source (provider-source redirect), tied to the panel that cited it. */
export interface GroundingCitation {
  readonly title: string;
  readonly url: string;
  readonly domain: string | null;
}

/** Character-offset citation marks over the complete answer text (deterministic, meaning-preserving). */
export interface AnswerMark {
  readonly end: number;
  readonly citations: readonly number[];
}

export type CandidateGap =
  | 'catalogue_search_unavailable'
  | 'candidate_set_empty'
  | 'outside_anchor'
  | 'anchor_not_declared'
  | 'excluded_artist'
  | 'too_many_credits'
  | 'unsupported_destination'
  | 'no_native_support'
  /** Native support exists in the block but not for the title and credited artists (e.g. fit-only). */
  | 'no_identity_support'
  | 'destination_unavailable'
  /** The first-party catalogue answered with a different ID, type or storefront than the exact destination. */
  | 'destination_mismatch'
  /** The metadata service throttled or refused the check; an honest unavailable check, never retried. */
  | 'metadata_throttled'
  | 'unsafe_redirect'
  | 'unsafe_address'
  | 'metadata_unreadable'
  | 'metadata_cap'
  | 'deadline'
  | 'title_mismatch'
  /** Metadata carries a version/decoration (live, remix, remaster…) the proposal did not declare, or vice versa. */
  | 'version_mismatch'
  | 'anchor_not_credited'
  /** A declared credit is not present in the metadata. */
  | 'credits_unconfirmed'
  /** The metadata credits someone the proposal did not declare. */
  | 'credits_extra'
  | 'uncertain_identity'
  | 'duplicate_recording'
  /** The same recording (any upload) was already displayed in this Journey. */
  | 'previously_shown';

/** One verified recording in an owned panel. Identity evidence, not proof of musical fit. */
export interface TrackChoice {
  readonly handle: Handle;
  /** Exact proposed title, confirmed in deterministic metadata (never replaced). */
  readonly title: string;
  /** The complete declared credit set, every member confirmed in metadata and nothing extra (at most eight). */
  readonly credits: readonly string[];
  /** Always 0 for committed choices: an incompletely confirmed credit set is rejected, not partially kept. */
  readonly unverifiedCredits: number;
  /** The owned Qloo pool artist credited on this recording. */
  readonly anchor: { readonly handle: Handle; readonly name: string };
  readonly recordingKey: string;
  readonly destination: RecordingDestination;
  readonly artwork?: AppleArtwork;
  /** Tentative interpretation from the catalogue model; not an audio observation. */
  readonly fitHypothesis: string;
  /**
   * Native support for the title and credit claims plus an exact deterministic
   * title/version/credit match. It establishes recording identity, not musical fit.
   * YouTube: identity as uploaded (not official status); `creditSource` says whether
   * credits came from the uploaded title or, only when the title names none, the
   * uploader name (a channel string alone never resolves namesakes or official
   * identity). Apple Music: the first-party catalogue's separate track-name and
   * artist fields for that exact track ID.
   */
  readonly evidence:
    | {
        readonly kind: 'native_identity_support_plus_exact_metadata';
        readonly creditSource: 'title' | 'uploader_name';
        readonly channelName: string;
        readonly topicChannel: boolean;
        /** Declared version decorations matched exactly (empty for the plain recording). */
        readonly versions: readonly string[];
      }
    | {
        readonly kind: 'native_identity_support_plus_first_party_metadata';
        readonly service: 'apple_music';
        readonly creditSource: 'first_party_artist_field';
        /** The first-party artist field as returned (credits are matched against it, never invented). */
        readonly artistName: string;
        readonly versions: readonly string[];
      }
    | {
        /** First-party search candidate, independently checked by its exact catalogue ID. No native grounding. */
        readonly kind: 'first_party_search_plus_exact_metadata';
        readonly service: 'apple_music';
        readonly creditSource: 'first_party_artist_field';
        readonly artistName: string;
        readonly versions: readonly string[];
      };
  /** Indexes into the panel citations whose supported segments cover this proposal's title and credits. */
  readonly sources: readonly number[];
}

/** One committed catalogue result for one InvestigationPlan: answer, citations and Suggestions kept as a unit. */
export interface ChoicePanel extends Owned {
  readonly id: Handle;
  readonly journeyId: Handle;
  readonly briefId: Handle;
  readonly briefVersion: number;
  readonly planId: Handle;
  readonly poolId: Handle;
  readonly attemptId: Handle;
  readonly synthetic: boolean;
  /** Absent on historical native records. Structured selection uses a code-written summary, never a native answer. */
  readonly catalogueMode?: 'native_google' | 'first_party_candidates';
  readonly outcome: 'choices' | 'no_match';
  readonly choices: readonly TrackChoice[];
  /** Complete final answer text exactly as generated (thought parts excluded). */
  readonly answerText: string;
  readonly marks: readonly AnswerMark[];
  readonly citations: readonly GroundingCitation[];
  /** Sanitised provider Search Suggestions unit, rendered only in an isolated sandboxed frame. */
  readonly suggestionsHtml: string | null;
  readonly gaps: readonly { readonly reason: CandidateGap; readonly count: number }[];
  /** Exact recordings shown, kept for a later refinement's exclusions. */
  readonly recordingKeys: readonly string[];
}

export type AttemptKind = 'reference' | 'discover' | 'refine';
export type AttemptOutcome = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown';
/**
 * Dispatch accounting, separate from the product outcome.
 * - 'reserved': counts/exposure reserved under current authority; the adapter
 *   has not been invoked and no dispatch intent exists.
 * - 'in_flight': one-use dispatch intent durably recorded under current
 *   authority; the adapter may have sent work. After a Stop/deadline its
 *   cost/outcome is unknown and stays held; never a refund.
 * - 'withdrawn': released from 'reserved' because intent was never recorded,
 *   so nothing can have been sent.
 * - 'returned': the adapter call returned or failed. Without a validated
 *   known-cost receipt it stays held as unknown; a transport answer is not
 *   billing settlement.
 */
export type DispatchState = 'not_started' | 'reserved' | 'in_flight' | 'withdrawn' | 'returned';

/** Stage-specific provider submissions admitted and accounted individually. */
export type SubmissionStage = 'reference_analysis' | 'qloo_search' | 'qloo_artist_insights' | 'qloo_tag_insights' | 'catalogue_generation';
export type AttemptFailure =
  | 'deadline'
  | 'adapter_failed'
  | 'capacity'
  | 'no_seed'
  | 'qloo_failed'
  | 'pool_empty'
  | 'stale_version'
  | 'catalogue_not_configured'
  | 'catalogue_failed'
  | 'catalogue_refused'
  | 'grounding_unavailable'
  /**
   * A provider answered HTTP 429 to work this app sent: the service limited the request. Says nothing about daily quota,
   * payment, retry time or the quality of the match, and is not our own admission/capacity limit.
   */
  | 'provider_limited'
  /** A provider answered HTTP 503: temporarily unavailable at the service. Not a verdict on the music or the source. */
  | 'provider_unavailable'
  /** Shared admission (store or exposure policy) was unavailable: nothing was sent. */
  | 'admission_unavailable';

export interface DispatchCall {
  readonly provider: ProviderKind;
  readonly stage: SubmissionStage;
  state: DispatchState;
}

export interface Attempt extends Owned {
  /** Omission is legacy unknown, never a measured zero. */
  timing?: AttemptTiming;
  readonly id: Handle;
  readonly journeyId: Handle;
  readonly kind: AttemptKind;
  readonly actionKeyHash: string;
  readonly inputHash: string;
  readonly deadlineAt: number;
  /** The exact brief version a discover/refine Attempt is bound to. */
  readonly briefId: Handle | null;
  outcome: AttemptOutcome;
  /** Reference stage dispatch state. */
  dispatch: DispatchState;
  /** Per-call accounting for multi-call stages (Qloo searches/Insights). */
  calls: DispatchCall[];
  failure: AttemptFailure | null;
}

export type ErrorCode =
  | 'bad_origin'
  | 'bad_host'
  | 'no_session'
  | 'session_expired'
  | 'not_found'
  | 'body_too_large'
  | 'bad_request'
  | 'unsupported_media_type'
  | 'invalid_source'
  /** A valid reference outside the bound eligible-source policy (honest recovery, no workaround). */
  | 'unsupported_source'
  | 'needs_focus_correction'
  | 'invalid_focus'
  | 'action_conflict'
  | 'stale_operation'
  | 'stale_version'
  | 'not_ready'
  | 'discovery_used'
  | 'discovery_correction_required'
  | 'discovery_retry_unavailable'
  | 'refinement_used'
  | 'feedback_required'
  | 'operation_active'
  | 'providers_disabled'
  | 'capacity'
  | 'rate_limited'
  | 'cancelled'
  | AttemptFailure;

export interface SafeArtistContext {
  readonly service: 'spotify' | 'musicbrainz' | 'wikidata';
  readonly url: string;
}

export interface SafeIdentitySlot {
  readonly proposal: string;
  readonly status: SeedStatus;
  readonly options: readonly { readonly handle: Handle; readonly name: string; readonly disambiguation: string | null; readonly context?: SafeArtistContext }[];
  readonly chosen: Handle | null;
}

export type DiscoveryAvailability = 'available' | 'edit_artists' | 'unavailable';

export interface ChatSummary {
  readonly handle: Handle;
  readonly title: string;
  readonly createdAt: number;
  readonly revision: number;
}

export interface ChatDirectory {
  readonly current: Handle | null;
  readonly revision: number;
  readonly items: readonly ChatSummary[];
}

/** Safe client snapshot (H08). No provider IDs, keys, scores, raw prompts or internal state. */
export interface SafeSnapshot {
  /** One free registration response only. Metadata receipt grants no source/provider permission. */
  readonly captureReceipt?: { readonly receipt: Handle; readonly durationMs: number; readonly expiresAt: number; readonly approved: boolean };
  /** Owned chats only within this Session's fixed expiry. No persistent device history. */
  readonly chats?: ChatDirectory;
  /** Derived next-action availability, never an authority grant. Absent legacy failed discovery is not retryable. */
  readonly discovery?: DiscoveryAvailability;
  readonly mode: RuntimeMode;
  /**
   * Derived capability only: the approved public example source may be offered as an editable draft fill because this
   * runtime (mode and, when bound, the eligible-source policy at the current clock) would accept it. Absent means no.
   * It carries no identifiers and never enables dispatch: the server re-checks every reference it receives.
   */
  readonly exampleSource?: boolean;
  /** Server-owned presentation hint; never source/admission authority. Absent in legacy finite bindings. */
  readonly recordingSelfService?: boolean;
  /** Presentation hint only; the server separately validates every Live upgrade and send. */
  readonly liveListening?: { readonly maxSeconds: 20 };
  /**
   * `context` is an opaque identifier derived server-side from the session
   * record and epoch (never the cookie secret). It changes on a new session or
   * epoch, so clients compare revisions only within one context.
   */
  readonly session: { readonly context: string; readonly expiresAt: number; readonly checkedAt?: number } | null;
  readonly stage: Stage;
  readonly revision: number;
  readonly status: StatusName | null;
  readonly attempt: {
    readonly handle: Handle;
    readonly kind: AttemptKind;
    readonly active: boolean;
    readonly outcome: AttemptOutcome;
  } | null;
  readonly reference: SafeReference | null;
  readonly listenerCue: string | null;
  readonly analysis: {
    readonly handle: Handle;
    readonly synthetic: boolean;
    readonly audioAccess: AudioAccess;
    readonly observations: readonly string[];
    readonly relationships: readonly string[];
    /** Model proposal, not verified source identity. Live may propose a stylistically related starting artist. */
    readonly proposedArtist: string | null;
  } | null;
  readonly brief: {
    readonly handle: Handle;
    readonly version: number;
    readonly relationship: string;
    readonly source: RelationshipSource;
    readonly artists: readonly string[];
  } | null;
  readonly identity: {
    readonly handle: Handle;
    readonly revision: number;
    readonly awaiting: boolean;
    readonly slots: readonly SafeIdentitySlot[];
  } | null;
  readonly connection: {
    readonly synthetic: boolean;
    readonly seeds: readonly string[];
    readonly artists: readonly string[];
    /** Owned opaque handles of the connected artists (for an explicit artist exclusion). */
    readonly anchors: readonly { readonly handle: Handle; readonly name: string }[];
    readonly tags: readonly string[];
    readonly capability: PoolCapability;
    readonly attribution: 'seed_mix';
    readonly why: readonly string[];
  } | null;
  /** The latest committed panel of this Journey. */
  readonly panel: SafePanel | null;
  /** Earlier committed panels of this Journey, oldest first (kept available after a refinement). */
  readonly history: readonly SafePanel[];
  /** The one shared refinement allowance; null until a panel exists. */
  readonly refinement: { readonly used: boolean } | null;
  readonly code: ErrorCode | null;
}

/** Client view of an owned choice panel: public names, validated links and owned opaque handles only. */
export interface SafePanel {
  readonly handle: Handle;
  /** Public discovery date for the optional on-device song library; absent on older clients/fixtures. */
  readonly foundAt?: number;
  readonly synthetic: boolean;
  readonly catalogueMode?: 'native_google' | 'first_party_candidates';
  readonly role: 'initial' | 'refinement';
  readonly mode: RefinementMode | null;
  /** Factual lines describing how this panel was produced (built in code from owned records). */
  readonly basis: readonly string[];
  /** This result's immutable listener intent; never substituted with the current brief. Optional for older clients/fixtures. */
  readonly intent?: SafeSnapshot['brief'];
  /**
   * Current presentation verdict, derived on every read (the stored ChoicePanel outcome is unchanged).
   * 'source_unavailable': the panel's mandatory native Search Suggestions unit cannot be presented under the
   * current source policy, so its choices, answer, citations, gaps and frame are withheld (empty here). It is
   * neither a successful result nor a no-match.
   */
  readonly outcome: 'choices' | 'no_match' | 'source_unavailable';
  readonly choices: readonly {
    readonly handle: Handle;
    readonly title: string;
    readonly credits: readonly string[];
    readonly unverifiedCredits: number;
    readonly anchor: string;
    /** Validated canonical listening URL; null for synthetic fixtures (never a live link). */
    readonly playUrl: string | null;
    /** Which service the external listening link opens, so the button names its actual destination. */
    readonly service: RecordingService;
    readonly artwork?: AppleArtwork;
    readonly fitHypothesis: string;
    /** A presentation discriminator only, never provider IDs or candidate handles. */
    readonly identityEvidence?: 'native_sources' | 'first_party_catalogue';
    readonly sources: readonly number[];
    /** The listener's current feedback for this exact choice of this panel. */
    readonly feedback: { readonly fit: Fit; readonly familiarity: Familiarity; readonly revision: number };
  }[];
  readonly answer: { readonly text: string; readonly marks: readonly AnswerMark[] };
  readonly citations: readonly GroundingCitation[];
  /** Same-origin URL of the isolated Suggestions frame, or null when absent. */
  readonly suggestionsUrl: string | null;
  readonly gaps: readonly { readonly reason: CandidateGap; readonly count: number }[];
}
