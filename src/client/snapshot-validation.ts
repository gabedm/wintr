import type { ErrorCode, SafeSnapshot } from '../shared/records.js';
import { LIMITS } from '../shared/records.js';
import { isSafeArtistContext } from '../shared/artist-context.js';
import { isAppleArtwork } from '../shared/apple-artwork.js';

type Obj = Record<string, unknown>;
type Check = (v: unknown) => boolean;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const shape = (v: unknown, fields: Record<string, Check>, optional: Record<string, Check> = {}): boolean => object(v)
  && Object.keys(v).every(k => Object.hasOwn(fields, k) || Object.hasOwn(optional, k))
  && Object.entries(fields).every(([k, check]) => Object.hasOwn(v, k) && check(v[k]))
  && Object.entries(optional).every(([k, check]) => !Object.hasOwn(v, k) || check(v[k]));
const text = (max: number, min = 0): Check => v => typeof v === 'string' && v.length >= min && v.length <= max;
const number = (max = Number.MAX_SAFE_INTEGER, min = 0): Check => v => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const bool: Check = v => typeof v === 'boolean';
const one = (...values: readonly unknown[]): Check => v => values.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const list = (max: number, check: Check): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const handle: Check = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(v);
const recordingDuration: Check = v => typeof v === 'number' && Number.isFinite(v) && v >= 5000 && v <= 60000;
const strList = (max: number, chars: number) => list(max, text(chars));

const ERROR_CODES = new Set<string>([
  'bad_origin', 'bad_host', 'no_session', 'session_expired', 'not_found', 'body_too_large', 'bad_request', 'unsupported_media_type',
  'invalid_source', 'unsupported_source', 'needs_focus_correction', 'invalid_focus', 'action_conflict', 'stale_operation', 'stale_version',
  'not_ready', 'discovery_used', 'discovery_correction_required', 'discovery_retry_unavailable', 'refinement_used', 'feedback_required', 'operation_active', 'providers_disabled', 'capacity', 'rate_limited',
  'cancelled', 'deadline', 'adapter_failed', 'no_seed', 'qloo_failed', 'pool_empty', 'catalogue_not_configured', 'catalogue_failed',
  'catalogue_refused', 'grounding_unavailable', 'provider_limited', 'provider_unavailable', 'admission_unavailable',
]);
export const isErrorCode = (v: unknown): v is ErrorCode => typeof v === 'string' && ERROR_CODES.has(v);
const gaps = one('catalogue_search_unavailable', 'candidate_set_empty', 'outside_anchor', 'anchor_not_declared', 'excluded_artist',
  'too_many_credits', 'unsupported_destination', 'no_native_support', 'no_identity_support', 'destination_unavailable', 'destination_mismatch',
  'metadata_throttled', 'unsafe_redirect', 'unsafe_address', 'metadata_unreadable', 'metadata_cap', 'deadline', 'title_mismatch', 'version_mismatch',
  'anchor_not_credited', 'credits_unconfirmed', 'credits_extra', 'uncertain_identity', 'duplicate_recording', 'previously_shown');
const brief: Check = v => shape(v, { handle, version: number(LIMITS.briefVersionsPerSession, 1), relationship: text(1000),
  source: one('analysis_choice', 'listener_text', 'intake_cue', 'automatic_match'), artists: strList(LIMITS.maxSeeds, LIMITS.artistNameChars) });
const sourceUrl: Check = v => {
  if (!text(LIMITS.sourceUrlChars, 1)(v)) return false;
  try { const u = new URL(v as string); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash; } catch { return false; }
};
const playUrl = (v: unknown, service: unknown): boolean => v === null || (typeof v === 'string' && (service === 'youtube'
  ? /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(v)
  : /^https:\/\/music\.apple\.com\/[a-z]{2}\/song\/[1-9][0-9]{0,19}$/.test(v)));

function panel(v: unknown, chat?: unknown): boolean {
  if (!object(v) || !Array.isArray(v.citations) || !object(v.answer) || typeof v.answer.text !== 'string') return false;
  const citationCount = v.citations.length;
  const answerLength = v.answer.text.length;
  const refs = list(32, number(citationCount - 1, 0));
  const choice: Check = c => shape(c, { handle, title: text(300, 1), credits: strList(LIMITS.creditedArtists, 300),
    unverifiedCredits: number(LIMITS.creditedArtists), anchor: text(256, 1), service: one('youtube', 'apple_music'),
    playUrl: url => object(c) && playUrl(url, c.service), fitHypothesis: text(1000), sources: refs,
    feedback: f => shape(f, { fit: one(null, 'like', 'not_right'), familiarity: one(null, 'new', 'known'), revision: number() }),
  }, { identityEvidence: one('native_sources', 'first_party_catalogue'), artwork: a => object(c) && c.service === 'apple_music' && typeof c.playUrl === 'string' && isAppleArtwork(a, c.playUrl) });
  if (!shape(v, {
    handle, synthetic: bool, role: one('initial', 'refinement'), mode: one(null, 'follow_connection', 'correct_direction'),
    basis: strList(20, 2000), outcome: one('choices', 'no_match', 'source_unavailable'), choices: list(LIMITS.trackChoicesPerPanel, choice),
    answer: a => shape(a, { text: text(LIMITS.catalogueTextBytes), marks: list(64, m => shape(m, { end: number(answerLength), citations: refs })) }),
    citations: list(32, c => shape(c, { title: text(200), url: sourceUrl, domain: nullable(text(253)) })),
    suggestionsUrl: url => url === null || (typeof url === 'string' && handle(v.handle) && (url === `/api/suggestions/${v.handle}` || (handle(chat) && url === `/api/suggestions/${v.handle}?chat=${chat}`))),
    gaps: list(32, g => shape(g, { reason: gaps, count: number(1000, 1) })),
  }, { foundAt: number(), catalogueMode: one('native_google', 'first_party_candidates'), intent: nullable(brief) })) return false;
  const answer = v.answer as Obj;
  if (v.outcome === 'source_unavailable' && ((v.choices as unknown[]).length !== 0 || answer.text !== '' || (answer.marks as unknown[]).length !== 0
    || citationCount !== 0 || v.suggestionsUrl !== null || (v.gaps as unknown[]).length !== 0)) return false;
  if (v.catalogueMode === 'first_party_candidates' && (citationCount !== 0 || (answer.marks as unknown[]).length !== 0 || v.suggestionsUrl !== null
    || (v.choices as Obj[]).some(c => c.identityEvidence !== 'first_party_catalogue' || c.service !== 'apple_music' || (c.sources as unknown[]).length !== 0))) return false;
  return true;
}

/** Full bounded DTO validation before anything is installed into React/controller state. */
export function isSafeSnapshot(v: unknown): v is SafeSnapshot {
  const currentChat = object(v) && object(v.chats) ? v.chats.current : undefined;
  const chatDirectory: Check = d => {
    if (!shape(d, { current: nullable(handle), revision: number(), items: list(20, c => shape(c, { handle, title: text(80, 1), createdAt: number(), revision: number() })) }) || !object(d) || !Array.isArray(d.items)) return false;
    const ids = d.items.map(c => (c as Obj).handle);
    if (new Set(ids).size !== ids.length || (d.current !== null && !ids.includes(d.current))) return false;
    if (!object(v) || !object(v.session)) return false;
    if (d.current === null && (['attempt','reference','listenerCue','analysis','brief','identity','connection','panel','refinement'].some(key => v[key] !== null) || !Array.isArray(v.history) || v.history.length !== 0 || v.stage !== 'idle' || v.revision !== 0 || v.status !== null)) return false;
    const expiry = (v.session as Obj).expiresAt;
    return typeof expiry === 'number' && d.items.every(c => ((c as Obj).createdAt as number) < expiry);
  };
  return shape(v, {
    mode: one('disabled', 'synthetic', 'live'), session: nullable(s => shape(s, { context: handle, expiresAt: number(Number.MAX_SAFE_INTEGER, 1) }, { checkedAt: number() }) && object(s) &&
      (s.checkedAt === undefined || ((s.expiresAt as number) > (s.checkedAt as number) && (s.expiresAt as number) - (s.checkedAt as number) <= LIMITS.sessionLifetimeMs))),
    stage: one('idle', 'validating', 'analysing_reference', 'awaiting_preference', 'resolving_artists', 'awaiting_artist', 'retrieving_taste',
      'finding_tracks', 'complete', 'no_match', 'failed', 'cancelled', 'expired'), revision: number(),
    status: one(null, 'reference_ready', 'artist_choices_ready', 'connection_ready', 'choices_ready'),
    attempt: nullable(a => shape(a, { handle, kind: one('reference', 'discover', 'refine'), active: bool,
      outcome: one('running', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown') })),
    reference: nullable(r => shape(r, { videoId: id => typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id),
      canonicalUrl: url => object(r) && url === `https://www.youtube.com/watch?v=${r.videoId}`,
      focus: f => shape(f, { start: number(), end: number() }) && object(f) && (f.end as number) > (f.start as number) && (f.end as number) - (f.start as number) <= LIMITS.focusMaxSeconds }) ||
      shape(r, { kind: one('recorded'), receipt: handle, durationMs: recordingDuration }) || shape(r, { kind: one('streamed'), receipt: handle })),
    listenerCue: nullable(text(LIMITS.listenerCueChars)),
    analysis: nullable(a => shape(a, { handle, synthetic: bool, audioAccess: one('synthetic_not_accessed', 'accessed', 'unavailable', 'refused'),
      observations: strList(LIMITS.observations, LIMITS.observationChars), relationships: strList(LIMITS.relationships, LIMITS.relationshipChars), proposedArtist: nullable(text(LIMITS.artistNameChars)) })),
    brief: nullable(brief),
    identity: nullable(i => shape(i, { handle, revision: number(), awaiting: bool, slots: list(LIMITS.maxSeeds, s => shape(s, {
      proposal: text(LIMITS.artistNameChars), status: one('pending', 'resolved', 'ambiguous', 'not_found', 'skipped'), chosen: nullable(handle),
      options: list(LIMITS.identityChoicesShown, o => shape(o, { handle, name: text(256), disambiguation: nullable(text(1000)) }, { context: isSafeArtistContext })),
    })) })),
    connection: nullable(c => shape(c, { synthetic: bool, seeds: strList(LIMITS.maxSeeds, 256), artists: strList(LIMITS.artistCandidates, 256),
      anchors: list(LIMITS.artistCandidates, a => shape(a, { handle, name: text(256) })), tags: strList(LIMITS.tags, 256),
      capability: one('artists_and_tags', 'artists_only'), attribution: one('seed_mix'), why: strList(20, 2000) })),
    panel: nullable(p => panel(p, currentChat)), history: list(LIMITS.discoverRunsPerJourney, p => panel(p, currentChat)), refinement: nullable(r => shape(r, { used: bool })), code: nullable(isErrorCode),
  }, { chats: chatDirectory, exampleSource: bool, recordingSelfService: flag => bool(flag) && (flag === false || (object(v) && v.mode !== 'disabled')),
    liveListening: l => object(v) && v.mode === 'live' && shape(l, { maxSeconds: one(20) }),
    discovery: one('available', 'edit_artists', 'unavailable'), captureReceipt: c => object(v) && object(v.session) &&
    shape(c, { receipt: handle, durationMs: recordingDuration, expiresAt: number(), approved: bool }) && object(c) && (c.expiresAt as number) <= (v.session.expiresAt as number) &&
      (v.session.checkedAt === undefined || (c.expiresAt as number) > (v.session.checkedAt as number)) });
}
