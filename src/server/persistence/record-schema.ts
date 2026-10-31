import type { AttemptFailure, CandidateGap, ChoicePanel, DispatchState, Stage, SubmissionStage } from '../../shared/records.js';
import { DISPATCH_CAPS, LIMITS } from '../../shared/records.js';
import { RECORDING } from '../../shared/recording.js';
import { isCanonicalDestination } from '../destinations.js';
import { STAGE_PROVIDER } from '../ledger/policy.js';
import { validAttemptTiming, validJourneyTiming } from '../journey-timing.js';
import { isAppleArtwork } from '../../shared/apple-artwork.js';

// Strict read-side schemas for every stored listener record kind. A stored
// body regains authority only if every required field is present with the
// exact type, range and enum value, the object has no unexpected keys, and its
// owned links and cross-field invariants hold. Nothing is coerced or defaulted
// (a missing or non-numeric deadline is a corrupt record, never "no deadline"
// or a fresh one). Firestore can store any supported type in any field, so
// write-side validation alone is not enough.

type V = (v: unknown) => boolean;

const HANDLE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && Object.getPrototypeOf(v) === Object.prototype;
/** Finite safe integer >= 0 (times, versions, revisions, counts). */
export const int: V = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const intIn = (min: number, max: number): V => (v) => int(v) && (v as number) >= min && (v as number) <= max;
const num: V = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const bool: V = (v) => typeof v === 'boolean';
const str = (max: number): V => (v) => typeof v === 'string' && v.length <= max;
const text = (max: number): V => (v) => typeof v === 'string' && v.length > 0 && v.length <= max;
const handle: V = (v) => typeof v === 'string' && HANDLE_RE.test(v);
const nullable = (c: V): V => (v) => v === null || c(v);
const oneOf = (values: readonly unknown[]): V => (v) => values.includes(v);
const arr = (c: V, max: number): V => (v) => Array.isArray(v) && v.length <= max && v.every(c);
/** Exactly these keys, each passing its check. */
const obj = (shape: Record<string, V>): V => {
  const keys = Object.keys(shape).sort();
  return (v) => {
    if (!isObj(v)) return false;
    const got = Object.keys(v).sort();
    return got.length === keys.length && got.every((k, i) => k === keys[i]) && keys.every((k) => shape[k]!(v[k]));
  };
};
/** Optional additions preserve old stored plans while retaining closed fields. */
const optionalFields = (optional: Record<string, V>, required: Record<string, V>): V => (value) => {
  if (!isObj(value)) return false;
  const core = { ...value };
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(core, key)) { if (!check(core[key])) return false; delete core[key]; }
  return obj(required)(core);
};
const record = (c: V, max: number): V => (v) => isObj(v) && Object.keys(v).length <= max && Object.values(v).every(c);

// Runtime enum lists, checked against the shared union types in both directions.
const STAGES = [
  'idle',
  'validating',
  'analysing_reference',
  'awaiting_preference',
  'resolving_artists',
  'awaiting_artist',
  'retrieving_taste',
  'finding_tracks',
  'complete',
  'no_match',
  'failed',
  'cancelled',
  'expired',
] as const satisfies readonly Stage[];
const FAILURES = [
  'deadline',
  'adapter_failed',
  'capacity',
  'no_seed',
  'qloo_failed',
  'pool_empty',
  'stale_version',
  'catalogue_not_configured',
  'catalogue_failed',
  'catalogue_refused',
  'grounding_unavailable',
  'provider_limited',
  'provider_unavailable',
  'admission_unavailable',
] as const satisfies readonly AttemptFailure[];
const GAPS = [
  'catalogue_search_unavailable',
  'candidate_set_empty',
  'outside_anchor',
  'anchor_not_declared',
  'excluded_artist',
  'too_many_credits',
  'unsupported_destination',
  'no_native_support',
  'no_identity_support',
  'destination_unavailable',
  'destination_mismatch',
  'metadata_throttled',
  'unsafe_redirect',
  'unsafe_address',
  'metadata_unreadable',
  'metadata_cap',
  'deadline',
  'title_mismatch',
  'version_mismatch',
  'anchor_not_credited',
  'credits_unconfirmed',
  'credits_extra',
  'uncertain_identity',
  'duplicate_recording',
  'previously_shown',
] as const satisfies readonly CandidateGap[];
const DISPATCH = ['not_started', 'reserved', 'in_flight', 'withdrawn', 'returned'] as const satisfies readonly DispatchState[];
const SUBMISSION_STAGES = Object.keys(STAGE_PROVIDER) as SubmissionStage[];
type Exhaustive<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : never;
const exhaustive: [Exhaustive<Stage, (typeof STAGES)[number]>, Exhaustive<AttemptFailure, (typeof FAILURES)[number]>, Exhaustive<CandidateGap, (typeof GAPS)[number]>, Exhaustive<DispatchState, (typeof DISPATCH)[number]>] = [
  true,
  true,
  true,
  true,
];
void exhaustive;

const NAME = text(LIMITS.artistNameChars * 2);
const SHORT = str(4096);
const HASH = text(256);
const MAX_CALLS = DISPATCH_CAPS.qloo + DISPATCH_CAPS.gemini;

const owned = { sessionId: handle, epoch: intIn(1, Number.MAX_SAFE_INTEGER), createdAt: int, expiresAt: int };
const digest: V = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const frames = intIn(RECORDING.minFrames, RECORDING.maxFrames);
const youtube = obj({ videoId: (v) => typeof v === 'string' && VIDEO_ID.test(v), canonicalUrl: text(LIMITS.sourceUrlChars), focus: obj({ start: num, end: num }) });
const recorded = obj({ kind: oneOf(['recorded']), receipt: handle, sha256: digest, frames });
const streamed = obj({ kind: oneOf(['streamed']), receipt: handle });
const reference: V = v => youtube(v) || recorded(v) || streamed(v);
const fit = oneOf(['like', 'not_right', null]);
const familiarity = oneOf(['new', 'known', null]);
const named = obj({ handle, name: NAME });
const sealedIdentity = obj({
  entityId: text(128),
  name: NAME,
  disambiguation: nullable(str(1024)),
  external: record(arr(str(512), 16), 32),
  subtypeEvidence: oneOf(['subtype', 'types']),
  provenance: obj({ operation: oneOf(['search', 'artist_insights']), sourceRecordId: handle }),
  owner: obj({ sessionId: handle, epoch: intIn(1, Number.MAX_SAFE_INTEGER), journeyId: handle, expiresAt: int }),
  seal: HASH,
});
const candidate = obj({ handle, identity: sealedIdentity });
const usage = obj({
  totalInputTokens: nullable(int),
  totalOutputTokens: nullable(int),
  totalThoughtTokens: nullable(int),
  totalCachedTokens: nullable(int),
  totalToolUseTokens: nullable(int),
  totalTokens: nullable(int),
  inputTokensByModality: arr(obj({ modality: str(64), tokens: int }), 16),
});
const refinementBasis = obj({
  mode: oneOf(['follow_connection', 'correct_direction']),
  fromPanelId: handle,
  fromBriefId: handle,
  fromPlanId: handle,
  followChoice: nullable(handle),
  followAnchor: nullable(handle),
  excludedAnchors: arr(handle, LIMITS.artistCandidates),
  admittedFeedback: arr(obj({ choice: handle, fit, familiarity }), LIMITS.trackChoicesPerPanel),
});
const anyOf = (...cs: V[]): V => (v) => cs.some((c) => c(v));
const APPLE_TRACK_ID = /^[1-9][0-9]{0,14}$/;
/** Legacy/YouTube shape (unchanged, so existing owned records still decode) or the Apple Music shape. */
const shownRecording = anyOf(
  obj({ key: HASH, videoId: (v) => typeof v === 'string' && VIDEO_ID.test(v), title: text(1024), credits: arr(NAME, LIMITS.creditedArtists) }),
  obj({ key: HASH, appleTrackId: (v) => typeof v === 'string' && APPLE_TRACK_ID.test(v), title: text(1024), credits: arr(NAME, LIMITS.creditedArtists) }),
);
const youtubeEvidence = obj({
  kind: oneOf(['native_identity_support_plus_exact_metadata']),
  creditSource: oneOf(['title', 'uploader_name']),
  channelName: str(1024),
  topicChannel: bool,
  versions: arr(str(256), 16),
});
const appleEvidence = obj({
  kind: oneOf(['native_identity_support_plus_first_party_metadata', 'first_party_search_plus_exact_metadata']),
  service: oneOf(['apple_music']),
  creditSource: oneOf(['first_party_artist_field']),
  artistName: text(1024),
  versions: arr(str(256), 16),
});
const trackChoiceFields: Record<string, V> = {
  handle,
  title: text(1024),
  credits: arr(NAME, LIMITS.creditedArtists),
  unverifiedCredits: (v) => v === 0,
  anchor: named,
  recordingKey: HASH,
  // Exact canonical destination only: known kind, valid identifiers, URL rebuilt from exactly them.
  destination: isCanonicalDestination,
  fitHypothesis: SHORT,
  evidence: anyOf(youtubeEvidence, appleEvidence),
  sources: arr(int, 256),
};
const trackChoiceShape = anyOf(obj(trackChoiceFields), obj({ ...trackChoiceFields, artwork: v => v !== undefined }));
/** Evidence must be of the destination's own kind (no Apple evidence vouching for a YouTube link, or the reverse). */
const trackChoice: V = (v) => {
  if (!trackChoiceShape(v)) return false;
  const c = v as { destination: { kind: string; url: string }; evidence: { kind: string }; sources: number[]; artwork?: unknown };
  if (Object.hasOwn(c, 'artwork') && (c.destination.kind !== 'apple_music' || !isAppleArtwork(c.artwork, c.destination.url))) return false;
  return c.destination.kind === 'youtube'
    ? c.evidence.kind === 'native_identity_support_plus_exact_metadata'
    : c.evidence.kind === 'native_identity_support_plus_first_party_metadata'
      || (c.evidence.kind === 'first_party_search_plus_exact_metadata' && c.sources.length === 0);
};

/** Timing is an exact optional extension: every other legacy key remains mandatory. */
const timed = (shape: Record<string, V>): V => anyOf(obj(shape), obj({ ...shape, timing: (v) => v !== undefined }));
const catalogueMode = (shape: Record<string, V>): V => anyOf(obj(shape), obj({ ...shape, catalogueMode: oneOf(['native_google', 'first_party_candidates']) }));
const tagFields = { handle, tagId: text(256), name: text(256) };
const poolTag = anyOf(obj(tagFields), obj({ ...tagFields, subtype: nullable(v => typeof v === 'string' && /^urn:tag:[a-z0-9_:.-]{1,180}$/i.test(v)) }));
const SHAPES = {
  capture: obj({ ...owned, id: handle, chat: handle, sha256: digest, frames, usableUntil: int, consumedAttempt: nullable(handle) }),
  journey: timed({
    ...owned,
    id: handle,
    reference,
    listenerCue: nullable(str(LIMITS.listenerCueChars * 2)),
    stage: oneOf(STAGES),
    revision: int,
    analysisId: nullable(handle),
    currentBriefId: nullable(handle),
    counts: obj({ gemini: intIn(0, DISPATCH_CAPS.gemini), qloo: intIn(0, DISPATCH_CAPS.qloo) }),
    discoverRuns: intIn(0, LIMITS.discoverRunsPerJourney),
    clarificationUsed: bool,
    refinementUsed: bool,
  }),
  analysis: obj({
    ...owned,
    id: handle,
    journeyId: handle,
    createdByAttemptId: handle,
    reference,
    audioAccess: oneOf(['synthetic_not_accessed', 'accessed', 'unavailable', 'refused']),
    synthetic: bool,
    observations: arr(text(LIMITS.observationChars * 2), LIMITS.observations),
    relationships: arr(text(LIMITS.relationshipChars * 2), LIMITS.relationships),
    // The complete final text lives in its own content document.
    provider: nullable(obj({ model: text(256), usage: nullable(usage), uncertainArtistName: nullable(NAME) })),
  }),
  attempt: timed({
    ...owned,
    id: handle,
    journeyId: handle,
    kind: oneOf(['reference', 'discover', 'refine']),
    actionKeyHash: HASH,
    inputHash: HASH,
    deadlineAt: int,
    briefId: nullable(handle),
    outcome: oneOf(['running', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown']),
    dispatch: oneOf(DISPATCH),
    calls: arr(obj({ provider: oneOf(['qloo', 'gemini']), stage: oneOf(SUBMISSION_STAGES), state: oneOf(DISPATCH) }), MAX_CALLS),
    failure: nullable(oneOf(FAILURES)),
  }),
  brief: obj({
    ...owned,
    id: handle,
    journeyId: handle,
    version: intIn(1, LIMITS.briefVersionsPerSession),
    analysisId: handle,
    relationship: SHORT,
    relationshipSource: oneOf(['analysis_choice', 'listener_text', 'intake_cue', 'automatic_match']),
    proposedArtists: arr(NAME, LIMITS.maxSeeds),
    exclusions: arr(NAME, LIMITS.exclusions),
    refinement: nullable(refinementBasis),
    contentHash: HASH,
  }),
  search: obj({
    ...owned,
    id: handle,
    journeyId: handle,
    query: text(LIMITS.artistNameChars * 2),
    normalizedQuery: text(LIMITS.artistNameChars * 2),
    candidates: arr(candidate, LIMITS.artistCandidates),
    returned: int,
    rejected: int,
  }),
  checkpoint: obj({
    ...owned,
    id: handle,
    journeyId: handle,
    briefId: handle,
    slots: arr(
      obj({
        proposal: NAME,
        searchId: nullable(handle),
        status: oneOf(['pending', 'resolved', 'ambiguous', 'not_found', 'skipped']),
        options: arr(handle, LIMITS.identityChoicesShown),
        chosen: nullable(handle),
      }),
      LIMITS.maxSeeds,
    ),
    awaiting: bool,
    revision: int,
  }),
  pool: obj({
    ...owned,
    id: handle,
    journeyId: handle,
    sourceBriefId: handle,
    origin: oneOf(['initial', 'follow_connection']),
    fingerprint: HASH,
    synthetic: bool,
    seeds: arr(obj({ handle, name: NAME, entityId: text(128), role: oneOf(['starting', 'favourite', 'followed']) }), LIMITS.maxSeeds),
    artists: arr(candidate, LIMITS.artistCandidates),
    tags: arr(poolTag, LIMITS.tags),
    capability: oneOf(['artists_and_tags', 'artists_only']),
    lineage: obj({
      artistReturned: int,
      artistRejected: int,
      aliasesRemoved: int,
      duplicatesRemoved: int,
      tagOutcome: oneOf(['returned', 'unsupported', 'failed', 'not_admitted']),
      tagReturned: int,
    }),
  }),
  plan: optionalFields({ referenceObservations: arr(text(500), 5) }, {
    ...owned,
    id: handle,
    journeyId: handle,
    briefId: handle,
    briefVersion: intIn(1, LIMITS.briefVersionsPerSession),
    poolId: handle,
    relationship: SHORT,
    seedNames: arr(NAME, LIMITS.maxSeeds),
    anchors: arr(named, LIMITS.artistCandidates),
    associations: arr(named, LIMITS.tags),
    exclusions: arr(NAME, LIMITS.exclusions + LIMITS.maxSeeds + LIMITS.artistCandidates),
    recordingExclusions: obj({ shown: arr(shownRecording, LIMITS.liveRecordsPerSession), known: arr(HASH, LIMITS.liveRecordsPerSession) }),
    priorities: arr(SHORT, 16),
    refinementMode: nullable(oneOf(['follow_connection', 'correct_direction'])),
    refinement: nullable(
      obj({
        followed: nullable(NAME),
        keptStarting: nullable(NAME),
        replaced: arr(NAME, LIMITS.maxSeeds),
        excludedArtists: arr(NAME, LIMITS.artistCandidates),
        relationshipChanged: bool,
        fromPanelId: handle,
      }),
    ),
    attribution: oneOf(['seed_mix']),
    provenance: obj({ analysisId: handle, analysisReuse: oneOf(['same_source_focus']), poolSourceBriefId: handle, poolReuse: oneOf(['created', 'reused_same_fingerprint']) }),
  }),
  // Panel authority record; the answer, marks, citations and Suggestions live in its content document.
  panel: catalogueMode({
    ...owned,
    id: handle,
    journeyId: handle,
    briefId: handle,
    briefVersion: intIn(1, LIMITS.briefVersionsPerSession),
    planId: handle,
    poolId: handle,
    attemptId: handle,
    synthetic: bool,
    outcome: oneOf(['choices', 'no_match']),
    choices: arr(trackChoice, LIMITS.trackChoicesPerPanel),
    gaps: arr(obj({ reason: oneOf(GAPS), count: int }), GAPS.length),
    recordingKeys: arr(HASH, LIMITS.trackChoicesPerPanel),
  }),
  feedback: obj({
    ...owned,
    id: handle,
    journeyId: handle,
    panelId: handle,
    choiceHandle: handle,
    fit,
    familiarity,
    revision: int,
    updatedAt: int,
  }),
} satisfies Record<string, V>;

export type RecordKind = keyof typeof SHAPES;

export interface RecordContext {
  readonly sessionId: string;
  readonly epoch: number;
  readonly sessionExpiresAt: number;
}

/** Cross-field invariants per kind (beyond the shape). */
function consistent(kind: RecordKind, r: Record<string, any>, ctx: RecordContext): boolean {
  if (r.sessionId !== ctx.sessionId || r.epoch !== ctx.epoch || r.createdAt > r.expiresAt || r.expiresAt > ctx.sessionExpiresAt) return false;
  switch (kind) {
    case 'attempt':
      return (
        (!Object.hasOwn(r, 'timing') || validAttemptTiming(r.timing, r.createdAt, r.expiresAt, r.deadlineAt, r.outcome)) &&
        r.deadlineAt >= r.createdAt &&
        r.deadlineAt <= ctx.sessionExpiresAt &&
        r.deadlineAt - r.createdAt <= LIMITS.executeDeadlineMs &&
        (r.kind === 'reference') === (r.briefId === null) &&
        (r.failure === null || r.outcome === 'failed') &&
        r.calls.every((c: { provider: string; stage: SubmissionStage }) => STAGE_PROVIDER[c.stage] === c.provider) &&
        r.calls.filter((c: { provider: string }) => c.provider === 'qloo').length <= DISPATCH_CAPS.qloo &&
        r.calls.filter((c: { provider: string }) => c.provider === 'gemini').length <= DISPATCH_CAPS.gemini
      );
    case 'journey':
      return (r.reference.kind === 'recorded' || r.reference.kind === 'streamed' || r.reference.focus.end > r.reference.focus.start) &&
        (!Object.hasOwn(r, 'timing') || validJourneyTiming(r.timing, r.createdAt, r.expiresAt, r.stage));
    case 'capture':
      return r.usableUntil > r.createdAt && r.usableUntil <= r.expiresAt && r.usableUntil - r.createdAt <= 5 * 60_000;
    case 'checkpoint':
      return r.slots.every((s: { chosen: string | null; options: string[] }) => s.chosen === null || s.options.includes(s.chosen));
    case 'panel':
      return (
        (r.outcome === 'choices') === r.choices.length > 0 &&
        r.recordingKeys.length === r.choices.length &&
        r.choices.every((c: { recordingKey: string; evidence: { kind: string } }, i: number) =>
          r.recordingKeys[i] === c.recordingKey &&
          (r.catalogueMode === 'first_party_candidates') === (c.evidence.kind === 'first_party_search_plus_exact_metadata'))
      );
    case 'feedback':
      return r.updatedAt >= r.createdAt;
    case 'brief':
      return r.refinement === null || r.version > 1;
    default:
      return true;
  }
}

/** True only for a complete, well-typed, consistent stored record of this kind and owner. */
export function validRecord(kind: RecordKind, body: unknown, handle: string, ctx: RecordContext): boolean {
  if (!SHAPES[kind](body)) return false;
  const r = body as Record<string, unknown>;
  return r.id === handle && consistent(kind, r, ctx);
}

/** Content documents (complete provider output), validated as strictly as records. */
export const validAnalysisText = obj({ finalText: (v) => typeof v === 'string' && Buffer.byteLength(v) <= LIMITS.catalogueTextBytes });
export const validPanelContent = obj({
  answerText: (v) => typeof v === 'string' && Buffer.byteLength(v) <= LIMITS.catalogueTextBytes,
  marks: arr(obj({ end: int, citations: arr(int, 256) }), 4096),
  citations: arr(obj({ title: str(1024), url: text(LIMITS.sourceUrlChars), domain: nullable(str(255)) }), 256),
  suggestionsHtml: nullable((v) => typeof v === 'string' && Buffer.byteLength(v) <= 256 * 1024),
});

/** The new summary mode never borrows native citations/Suggestions or historical evidence. */
export function validPanelPresentation(panel: Pick<ChoicePanel, 'catalogueMode' | 'choices' | 'marks' | 'citations' | 'suggestionsHtml'>): boolean {
  if (panel.catalogueMode !== undefined && panel.catalogueMode !== 'native_google' && panel.catalogueMode !== 'first_party_candidates') return false;
  const candidates = panel.catalogueMode === 'first_party_candidates';
  if (!panel.choices.every(c => candidates === (c.evidence.kind === 'first_party_search_plus_exact_metadata'))) return false;
  return !candidates || (panel.marks.length === 0 && panel.citations.length === 0 && panel.suggestionsHtml === null &&
    panel.choices.every(c => c.destination.kind === 'apple_music' && c.sources.length === 0));
}
