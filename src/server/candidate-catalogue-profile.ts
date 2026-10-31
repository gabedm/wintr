import { LIMITS } from '../shared/records.js';
import { APPLE_BATCH_MAX_ANCHORS, APPLE_BATCH_MAX_CANDIDATES } from './apple-candidate-batch.js';
import { APPLE_METADATA_RATE } from './apple-metadata-rate.js';
import { CANDIDATE_SELECTOR_OBSERVATION_PROFILE } from './ledger/observation.js';
import type { LiveBindings } from './live-bindings.js';
import { GEMINI_CATALOGUE_PROFILE } from './providers/gemini-catalogue.js';

/** Code profile, not permission. No default/CLI/client input can select it. */
export const CANDIDATE_CATALOGUE_PROFILE = Object.freeze({
  profile: 'apple_candidates_selector_v1', selectorProfile: CANDIDATE_SELECTOR_OBSERVATION_PROFILE,
  model: GEMINI_CATALOGUE_PROFILE.model, apiVersion: GEMINI_CATALOGUE_PROFILE.apiVersion,
  location: GEMINI_CATALOGUE_PROFILE.location, thinkingLevel: GEMINI_CATALOGUE_PROFILE.thinkingLevel,
  maxOutputTokens: GEMINI_CATALOGUE_PROFILE.maxOutputTokens, timeoutMs: GEMINI_CATALOGUE_PROFILE.maxTimeoutMs,
  maxAnchors: APPLE_BATCH_MAX_ANCHORS, maxCandidates: APPLE_BATCH_MAX_CANDIDATES, maxChoices: LIMITS.trackChoicesPerPanel,
  metadataRequests: LIMITS.metadataRequestsPerExecute, rateAdmissions: APPLE_METADATA_RATE.maxAdmitted,
  rateRetainMs: APPLE_METADATA_RATE.retainMs, rateDispatchLagMs: APPLE_METADATA_RATE.dispatchLagMs,
} as const);

export type CandidateCatalogueBinding = typeof CANDIDATE_CATALOGUE_PROFILE & {
  readonly bindingVersion: string; readonly serviceId: string; readonly serviceIdentity: string;
  readonly sourcePolicyVersion: string; readonly exposurePolicyVersion: string;
  readonly projectId: string; readonly quotaProjectId: string; readonly identityRef: string;
  readonly storefront: string; readonly expiresAt: number;
};
type Parsed = { readonly ok: true; readonly binding: CandidateCatalogueBinding } | { readonly ok: false; readonly problems: readonly string[] };
const KEYS = Object.freeze([...Object.keys(CANDIDATE_CATALOGUE_PROFILE), 'bindingVersion', 'serviceId', 'serviceIdentity',
  'sourcePolicyVersion', 'exposurePolicyVersion', 'projectId', 'quotaProjectId', 'identityRef', 'storefront', 'expiresAt'].sort());
const VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/, SYMBOL = /^[a-z][a-z0-9-]{2,62}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, REF = /^[A-Za-z0-9][A-Za-z0-9/_.-]{2,255}$/;

export function parseCandidateCatalogueBinding(raw: unknown, now: number): Parsed {
  try {
    if (!Number.isSafeInteger(now) || now < 0) return { ok: false, problems: ['candidateCatalogue.clock:invalid'] };
    if (typeof raw !== 'object' || raw === null || Object.getPrototypeOf(raw) !== Object.prototype) throw new TypeError();
    const keys = Reflect.ownKeys(raw);
    if (keys.some(k => typeof k !== 'string') || (keys as string[]).sort().join(',') !== KEYS.join(',')) throw new TypeError();
    const descriptors = Object.getOwnPropertyDescriptors(raw), b: Record<string, unknown> = {};
    for (const key of KEYS) {
      const d = descriptors[key];
      if (!d || !Object.hasOwn(d, 'value')) throw new TypeError();
      b[key] = d.value;
    }
    const problems: string[] = [];
    for (const [key, value] of Object.entries(CANDIDATE_CATALOGUE_PROFILE)) if (b[key] !== value) problems.push(`candidateCatalogue.${key}:mismatch`);
    for (const [key, pattern] of [
      ['bindingVersion', VERSION], ['serviceId', SYMBOL], ['serviceIdentity', SYMBOL], ['sourcePolicyVersion', VERSION],
      ['exposurePolicyVersion', VERSION], ['projectId', PROJECT], ['quotaProjectId', PROJECT], ['identityRef', REF], ['storefront', /^[a-z]{2}$/],
    ] as const) if (typeof b[key] !== 'string' || !pattern.test(b[key])) problems.push(`candidateCatalogue.${key}:invalid`);
    if (!Number.isSafeInteger(b.expiresAt) || (b.expiresAt as number) <= now) problems.push('candidateCatalogue.expiresAt:expired');
    return problems.length ? { ok: false, problems } : { ok: true, binding: Object.freeze(b) as CandidateCatalogueBinding };
  } catch { return { ok: false, problems: ['candidateCatalogue:shape'] }; }
}

export interface CandidateCataloguePreparation { readonly profile: typeof CANDIDATE_CATALOGUE_PROFILE.profile; readonly binding: CandidateCatalogueBinding }
const preparations = new WeakMap<object, { readonly binding: CandidateCatalogueBinding; readonly createdAt: number }>();

export function createCandidateCataloguePreparation(raw: unknown, now = Date.now()):
  { readonly ok: true; readonly preparation: CandidateCataloguePreparation } | { readonly ok: false; readonly problems: readonly string[] } {
  const parsed = parseCandidateCatalogueBinding(raw, now);
  if (!parsed.ok) return parsed;
  const preparation = Object.freeze({ profile: CANDIDATE_CATALOGUE_PROFILE.profile, binding: parsed.binding });
  preparations.set(preparation, Object.freeze({ binding: parsed.binding, createdAt: now }));
  return { ok: true, preparation };
}

export function captureCandidateCataloguePreparation(preparation: unknown, raw: unknown, now: number): Parsed {
  const provenance = typeof preparation === 'object' && preparation !== null ? preparations.get(preparation) : undefined;
  if (!provenance) return { ok: false, problems: ['candidateCatalogue:not_prepared'] };
  if (now < provenance.createdAt) return { ok: false, problems: ['candidateCatalogue.clock:regressed'] };
  const approved = provenance.binding;
  const parsed = parseCandidateCatalogueBinding(raw, now);
  if (!parsed.ok) return parsed;
  if (KEYS.some(k => parsed.binding[k as keyof CandidateCatalogueBinding] !== approved[k as keyof CandidateCatalogueBinding])) return { ok: false, problems: ['candidateCatalogue:binding_mismatch'] };
  return { ok: true, binding: approved };
}

export function candidateCatalogueBindingProblem(candidate: CandidateCatalogueBinding, b: LiveBindings): string | null {
  if (!b.recordingServices.includes('apple_music')) return 'candidateCatalogue:apple_not_enabled';
  if (candidate.bindingVersion !== b.bindingVersion || candidate.serviceId !== b.serviceId || candidate.serviceIdentity !== b.serviceIdentity ||
    candidate.sourcePolicyVersion !== b.sourcePolicy.version || candidate.exposurePolicyVersion !== b.exposurePolicy.version ||
    candidate.projectId !== b.catalogue.projectId || candidate.quotaProjectId !== b.catalogue.quotaProjectId || candidate.identityRef !== b.catalogue.identityRef) return 'candidateCatalogue:runtime_mismatch';
  if (candidate.expiresAt > Math.min(b.expiresAt, b.sourcePolicy.expiresAt, b.exposurePolicy.expiresAt)) return 'candidateCatalogue:outlives_binding';
  return null;
}
