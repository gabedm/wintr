import { STAGE_PROVIDER, type StageKey } from './policy.js';
import { canonicalJson } from '../seal.js';
import { LIVE_PROTOCOL_FAILURES } from '../../shared/live-listening.js';

export const OBSERVATION_PROFILES = {
  reference_analysis: 'gemini_3_6_flash_medium_generate_content_v1', catalogue_generation: 'gemini_3_6_flash_low_native_search',
  qloo_search: 'qloo_artist_search', qloo_artist_insights: 'qloo_v2_artist_insights', qloo_tag_insights: 'qloo_v2_tag_insights',
} as const;
export const CLOUD_REFERENCE_OBSERVATION_PROFILE = 'gemini_3_6_flash_medium_cloud_youtube_v1';
export const CLOUD_AUDIO_OBSERVATION_PROFILE = 'gemini_3_6_flash_medium_cloud_audio_v1';
/** One bounded Live connection, not one count per PCM frame or an ordinary generateContent reply. */
export const LIVE_AUDIO_OBSERVATION_PROFILE = 'gemini_3_8_live_music_report_v1';
export const CANDIDATE_SELECTOR_OBSERVATION_PROFILE = 'gemini_3_6_flash_low_candidate_selection_v1';
/** Historical only: saved observations keep this identity; no current adapter dispatches Interactions or may declare it. */
export const INTERACTIONS_REFERENCE_OBSERVATION_PROFILE = 'gemini_3_6_flash_medium_interactions';
export type ReferenceObservationProfile = typeof OBSERVATION_PROFILES.reference_analysis | typeof CLOUD_REFERENCE_OBSERVATION_PROFILE | typeof CLOUD_AUDIO_OBSERVATION_PROFILE | typeof LIVE_AUDIO_OBSERVATION_PROFILE;
export type ObservationProfile = typeof OBSERVATION_PROFILES[StageKey] | typeof CLOUD_REFERENCE_OBSERVATION_PROFILE | typeof CLOUD_AUDIO_OBSERVATION_PROFILE | typeof LIVE_AUDIO_OBSERVATION_PROFILE | typeof INTERACTIONS_REFERENCE_OBSERVATION_PROFILE | typeof CANDIDATE_SELECTOR_OBSERVATION_PROFILE;
/** Profiles a new call may declare: the stage default, plus the optional Cloud profile for reference analysis. */
export const liveObservationProfile = (stage: StageKey, profile: unknown): profile is Exclude<ObservationProfile, typeof INTERACTIONS_REFERENCE_OBSERVATION_PROFILE> =>
  profile === OBSERVATION_PROFILES[stage] || (stage === 'reference_analysis' && (profile === CLOUD_REFERENCE_OBSERVATION_PROFILE || profile === CLOUD_AUDIO_OBSERVATION_PROFILE || profile === LIVE_AUDIO_OBSERVATION_PROFILE))
    || (stage === 'catalogue_generation' && profile === CANDIDATE_SELECTOR_OBSERVATION_PROFILE);
/** Persisted observations additionally parse under the historical Interactions identity, never relabelled. */
export const validObservationProfile = (stage: StageKey, profile: unknown): profile is ObservationProfile =>
  liveObservationProfile(stage, profile) || (stage === 'reference_analysis' && profile === INTERACTIONS_REFERENCE_OBSERVATION_PROFILE);
export const USAGE_COUNTERS = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedTokens', 'toolUseTokens', 'totalTokens', 'searchQueries'] as const;
export type UsageKey = typeof USAGE_COUNTERS[number];
/** 'reference' is the historical Interactions usage shape; 'generate_content' is the Developer API usageMetadata shape. */
export type UsageFormat = 'reference' | 'generate_content' | 'live_audio' | 'catalogue' | 'cloud_reference' | 'qloo';
export interface ObservedCounter { value: number | null; state: 'unknown' | 'missing' | 'known'; malformed: boolean }
export type ObservedUsage = Record<UsageKey, ObservedCounter>;
export const OBSERVATION_ERRORS = ['config', 'aborted', 'deadline', 'transport', 'redirect', 'oversize', 'auth', 'quota', 'unsupported', 'http_status', 'malformed', 'schema', 'incomplete', 'refused', 'unclassified', ...LIVE_PROTOCOL_FAILURES] as const;
export interface SubmissionObservation {
  version: 1; revision: number; provider: 'gemini' | 'qloo'; stage: StageKey; profile: ObservationProfile;
  adapterStartedAt: number; adapterEndedAt: number | null; preparationMs: number | null;
  invocation: 'pending' | 'unknown' | 'zero' | 'one'; transportStartedAt: number | null; transportEndedAt: number | null; transportMs: number | null;
  transportOutcome: 'pending' | 'response' | 'error'; status: number | null;
  outcome: 'pending' | 'returned' | 'failed' | 'aborted' | 'deadline'; error: typeof OBSERVATION_ERRORS[number] | null;
  clockInvalid: boolean; usage: ObservedUsage;
}
export const emptyObservedUsage = (): ObservedUsage => Object.fromEntries(USAGE_COUNTERS.map((k) => [k, { value: null, state: 'unknown', malformed: false }])) as ObservedUsage;
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => record(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const elapsed = (start: number | null, end: number | null) => start !== null && end !== null && integer(end - start) ? end - start : null;

/** Strict accounting schema. No content, identifiers, arbitrary metric names or billing units. */
export function parseObservation(v: unknown): SubmissionObservation | null {
  if (!exact(v, ['version', 'revision', 'provider', 'stage', 'profile', 'adapterStartedAt', 'adapterEndedAt', 'preparationMs', 'invocation', 'transportStartedAt', 'transportEndedAt', 'transportMs', 'transportOutcome', 'status', 'outcome', 'error', 'clockInvalid', 'usage'])) return null;
  if (v.version !== 1 || !integer(v.revision) || v.revision > 2 || typeof v.stage !== 'string' || !Object.hasOwn(OBSERVATION_PROFILES, v.stage)) return null;
  const stage = v.stage as StageKey;
  if (v.provider !== STAGE_PROVIDER[stage] || !validObservationProfile(stage, v.profile) || !integer(v.adapterStartedAt) || typeof v.clockInvalid !== 'boolean') return null;
  for (const k of ['adapterEndedAt', 'preparationMs', 'transportStartedAt', 'transportEndedAt', 'transportMs']) if (v[k] !== null && !integer(v[k])) return null;
  if (typeof v.invocation !== 'string' || !['pending', 'unknown', 'zero', 'one'].includes(v.invocation) || typeof v.transportOutcome !== 'string' || !['pending', 'response', 'error'].includes(v.transportOutcome) || typeof v.outcome !== 'string' || !['pending', 'returned', 'failed', 'aborted', 'deadline'].includes(v.outcome)) return null;
  if (v.error !== null && !(OBSERVATION_ERRORS as readonly unknown[]).includes(v.error)) return null;
  if ((LIVE_PROTOCOL_FAILURES as readonly unknown[]).includes(v.error) && v.profile !== LIVE_AUDIO_OBSERVATION_PROFILE) return null;
  if (v.status !== null && (!integer(v.status) || v.status < 100 || v.status > 599)) return null;
  if (!exact(v.usage, USAGE_COUNTERS)) return null;
  for (const key of USAGE_COUNTERS) {
    const c = v.usage[key];
    if (!exact(c, ['value', 'state', 'malformed']) || typeof c.malformed !== 'boolean' || typeof c.state !== 'string' || !['unknown', 'missing', 'known'].includes(c.state)) return null;
    if (c.state === 'known' ? !integer(c.value) : c.value !== null) return null;
    if (c.state === 'unknown' && c.malformed) return null;
  }
  const o = v as unknown as SubmissionObservation;
  for (const t of [o.adapterEndedAt, o.transportStartedAt, o.transportEndedAt]) if (t !== null && t < o.adapterStartedAt) return null;
  if (o.transportStartedAt !== null && o.transportEndedAt !== null && o.transportEndedAt < o.transportStartedAt) return null;
  if (o.transportStartedAt !== null && o.invocation !== 'one') return null;
  if (o.invocation === 'one' && o.transportStartedAt === null && !o.clockInvalid) return null;
  if ((o.outcome === 'returned' || o.outcome === 'failed') && o.adapterEndedAt === null && !o.clockInvalid) return null;
  if (o.outcome === 'pending' && o.adapterEndedAt !== null) return null;
  if (o.invocation === 'zero' && (o.adapterEndedAt === null || o.transportOutcome !== 'pending' || o.transportStartedAt !== null || o.transportEndedAt !== null || o.status !== null)) return null;
  if (o.transportEndedAt !== null && (o.invocation !== 'one' || o.transportOutcome === 'pending')) return null;
  if (o.transportOutcome === 'response' && o.status === null) return null;
  if (o.transportOutcome !== 'response' && o.status !== null) return null;
  if (o.preparationMs !== elapsed(o.adapterStartedAt, o.transportStartedAt ?? (o.invocation === 'zero' ? o.adapterEndedAt : null)) || o.transportMs !== elapsed(o.transportStartedAt, o.transportEndedAt)) return null;
  if ((o.outcome === 'pending' || o.outcome === 'returned') && o.error !== null) return null;
  if (['failed', 'aborted', 'deadline'].includes(o.outcome) && o.error === null) return null;
  return structuredClone(o);
}

/** Preserve cumulative snapshots (never sum). Missing/malformed later values cannot erase valid counters. */
export function observeUsage(usage: ObservedUsage, raw: unknown, format: UsageFormat): void {
  const fields: Partial<Record<UsageKey, string>> = format === 'reference'
    ? { inputTokens: 'total_input_tokens', outputTokens: 'total_output_tokens', thoughtTokens: 'total_thought_tokens', cachedTokens: 'total_cached_tokens', toolUseTokens: 'total_tool_use_tokens', totalTokens: 'total_tokens' }
    : format === 'live_audio' ? { inputTokens: 'promptTokenCount', outputTokens: 'responseTokenCount', thoughtTokens: 'thoughtsTokenCount', cachedTokens: 'cachedContentTokenCount', toolUseTokens: 'toolUsePromptTokenCount', totalTokens: 'totalTokenCount' }
    : format === 'catalogue' || format === 'cloud_reference' || format === 'generate_content' ? { inputTokens: 'promptTokenCount', outputTokens: 'candidatesTokenCount', thoughtTokens: 'thoughtsTokenCount', cachedTokens: 'cachedContentTokenCount', toolUseTokens: 'toolUsePromptTokenCount', totalTokens: 'totalTokenCount' } : {};
  for (const key of USAGE_COUNTERS) {
    if (key === 'searchQueries') continue;
    const c = usage[key]; const field = fields[key];
    const present = record(raw) && field !== undefined && Object.hasOwn(raw, field);
    const value = present ? raw[field!] : undefined;
    if (integer(value)) {
      if (c.value !== null && value < c.value) c.malformed = true;
      else { c.value = value; c.state = 'known'; }
    } else {
      if (c.state === 'unknown') c.state = 'missing';
      if (present || (raw !== undefined && !record(raw))) c.malformed = true;
    }
  }
}

/** A bounded monotonic join tolerates out-of-order acknowledgements/replays, never conflicting identities/times. */
export function mergeObservation(old: SubmissionObservation | null, incoming: unknown): SubmissionObservation | null {
  const next = parseObservation(incoming); if (!next) return null;
  if (!old) return next;
  const result = structuredClone(old);
  for (const key of ['provider', 'stage', 'profile', 'adapterStartedAt'] as const) if (old[key] !== next[key]) return null;
  for (const key of ['adapterEndedAt', 'transportStartedAt', 'transportEndedAt', 'status'] as const) {
    if (old[key] !== null && next[key] !== null && old[key] !== next[key]) return null;
    result[key] = old[key] ?? next[key];
  }
  const invocationRank = { pending: 0, unknown: 1, zero: 2, one: 3 };
  if ((old.invocation === 'zero' && next.invocation === 'one') || (old.invocation === 'one' && next.invocation === 'zero')) return null;
  result.invocation = invocationRank[next.invocation] > invocationRank[old.invocation] ? next.invocation : old.invocation;
  for (const key of ['outcome', 'transportOutcome'] as const) {
    if (old[key] !== 'pending' && next[key] !== 'pending' && old[key] !== next[key]) return null;
    Object.assign(result, { [key]: old[key] === 'pending' ? next[key] : old[key] });
  }
  if (old.error !== null && next.error !== null && old.error !== next.error) return null;
  result.error = old.error ?? next.error; result.clockInvalid ||= next.clockInvalid;
  for (const key of USAGE_COUNTERS) {
    const a = old.usage[key]; const b = next.usage[key];
    result.usage[key] = { state: a.state === 'known' || b.state === 'known' ? 'known' : a.state === 'missing' || b.state === 'missing' ? 'missing' : 'unknown', value: a.value === null ? b.value : b.value === null ? a.value : Math.max(a.value, b.value), malformed: a.malformed || b.malformed };
  }
  result.revision = Math.max(old.revision, next.revision);
  result.preparationMs = elapsed(result.adapterStartedAt, result.transportStartedAt ?? (result.invocation === 'zero' ? result.adapterEndedAt : null));
  result.transportMs = elapsed(result.transportStartedAt, result.transportEndedAt);
  const parsed = parseObservation(result);
  if (parsed && next.revision <= old.revision && canonicalJson(parsed) !== canonicalJson(old)) return null;
  return parsed;
}

export type ObservationWrite = 'stored' | 'replay' | 'invalid' | 'not_found' | 'unavailable';
/** Controller-only process health; pending/unacknowledged writes are never labelled durable. No automatic retry. */
export class ObservationWrites {
  private pending = 0; private failed = 0; private last: ObservationWrite | null = null;
  health() { return { pendingWrites: this.pending, failedWrites: this.failed, lastFailure: this.last }; }
  async run(write: () => Promise<ObservationWrite>): Promise<ObservationWrite> {
    this.pending += 1;
    let result: ObservationWrite;
    try { result = await write(); } catch { result = 'unavailable'; }
    this.pending -= 1;
    if (result !== 'stored' && result !== 'replay') { this.failed = Math.min(Number.MAX_SAFE_INTEGER, this.failed + 1); this.last = result; }
    return result;
  }
}
