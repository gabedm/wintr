import type { LiveBindings } from './live-bindings.js';

/** Code-only future profile. Constructing it performs no loading, dispatch or activation. */
export const CLOUD_REFERENCE_PROFILE = Object.freeze({
  profile: 'cloud_youtube_reference_v1',
  origin: 'https://aiplatform.googleapis.com',
  apiVersion: 'v1',
  location: 'global',
  model: 'gemini-3.6-flash',
  thinkingLevel: 'MEDIUM',
  maxOutputTokens: 4096,
  timeoutMs: 90_000,
} as const);
/** Conservative boundary on the documented retirement day; never extended by this preparation. */
export const CLOUD_REFERENCE_RETIRES_AT = Date.UTC(2026, 10, 19);

export interface CloudReferenceBinding {
  readonly profile: typeof CLOUD_REFERENCE_PROFILE.profile;
  readonly model: typeof CLOUD_REFERENCE_PROFILE.model;
  readonly apiVersion: typeof CLOUD_REFERENCE_PROFILE.apiVersion;
  readonly location: typeof CLOUD_REFERENCE_PROFILE.location;
  readonly bindingVersion: string;
  readonly serviceId: string;
  readonly serviceIdentity: string;
  readonly sourcePolicyVersion: string;
  readonly exposurePolicyVersion: string;
  readonly expiresAt: number;
  readonly projectId: string;
  readonly quotaProjectId: string;
  readonly identityRef: string;
}

const KEYS = ['apiVersion', 'bindingVersion', 'expiresAt', 'exposurePolicyVersion', 'identityRef', 'location', 'model',
  'profile', 'projectId', 'quotaProjectId', 'serviceId', 'serviceIdentity', 'sourcePolicyVersion'] as const;
const VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SYMBOL = /^[a-z][a-z0-9-]{2,62}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9/_.-]{2,255}$/;
type Parsed = { readonly ok: true; readonly binding: CloudReferenceBinding } | { readonly ok: false; readonly problems: readonly string[] };

/** Own, exact data fields only: getters, symbols, hidden extras and prototypes cannot grant authority. */
function capture(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== 'string') || (keys as string[]).sort().join(',') !== KEYS.join(',')) return null;
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const copy: Record<string, unknown> = {};
  for (const key of KEYS) {
    const d = descriptors[key];
    if (!d || !Object.hasOwn(d, 'value')) return null;
    copy[key] = d.value;
  }
  return copy;
}

export function parseCloudReferenceBinding(raw: unknown, now: number): Parsed {
  try {
    if (!Number.isSafeInteger(now) || now < 0) return { ok: false, problems: ['cloudReference.clock:invalid'] };
    const b = capture(raw);
    if (!b) return { ok: false, problems: ['cloudReference:shape'] };
    const problems: string[] = [];
    for (const key of ['profile', 'model', 'apiVersion', 'location'] as const) {
      if (b[key] !== CLOUD_REFERENCE_PROFILE[key]) problems.push(`cloudReference.${key}:mismatch`);
    }
    for (const [key, re] of [
      ['bindingVersion', VERSION], ['serviceId', SYMBOL], ['serviceIdentity', SYMBOL],
      ['sourcePolicyVersion', VERSION], ['exposurePolicyVersion', VERSION],
      ['projectId', PROJECT], ['quotaProjectId', PROJECT], ['identityRef', REF],
    ] as const) {
      if (typeof b[key] !== 'string' || !re.test(b[key])) problems.push(`cloudReference.${key}:invalid`);
    }
    if (!Number.isSafeInteger(b.expiresAt) || (b.expiresAt as number) <= now) problems.push('cloudReference.expiresAt:expired');
    if (now >= CLOUD_REFERENCE_RETIRES_AT || (b.expiresAt as number) > CLOUD_REFERENCE_RETIRES_AT) problems.push('cloudReference:model_lifetime');
    if (problems.length) return { ok: false, problems };
    return { ok: true, binding: Object.freeze(b) as unknown as CloudReferenceBinding };
  } catch { return { ok: false, problems: ['cloudReference:shape'] }; }
}

export interface CloudReferencePreparation {
  readonly profile: typeof CLOUD_REFERENCE_PROFILE.profile;
  readonly binding: CloudReferenceBinding;
}
const preparations = new WeakMap<object, CloudReferenceBinding>();

/**
 * A genuine immutable constructor capability, analogous to the future serving
 * constructor. A spread, JSON copy, hand-built object or Proxy has no capability.
 * The controller must separately provide an agreeing binding at composition.
 */
export function createCloudReferencePreparation(raw: unknown, now = Date.now()):
  { readonly ok: true; readonly preparation: CloudReferencePreparation } | { readonly ok: false; readonly problems: readonly string[] } {
  const parsed = parseCloudReferenceBinding(raw, now);
  if (!parsed.ok) return parsed;
  const preparation = Object.freeze({ profile: CLOUD_REFERENCE_PROFILE.profile, binding: parsed.binding });
  preparations.set(preparation, parsed.binding);
  return { ok: true, preparation };
}

/** Recheck the exact capability, matching closed binding and time before any loader. */
export function captureCloudReferencePreparation(preparation: unknown, rawBinding: unknown, now: number): Parsed {
  const approved = typeof preparation === 'object' && preparation !== null ? preparations.get(preparation) : undefined;
  if (!approved) return { ok: false, problems: ['cloudReference:not_prepared'] };
  const parsed = parseCloudReferenceBinding(rawBinding, now);
  if (!parsed.ok) return parsed;
  if (KEYS.some(key => parsed.binding[key] !== approved[key])) return { ok: false, problems: ['cloudReference:binding_mismatch'] };
  return { ok: true, binding: approved };
}

/** An explicit reference identity is separate from catalogue permission and every existing secret reference. */
export function cloudReferenceBindingProblem(reference: CloudReferenceBinding, b: LiveBindings): string | null {
  if (reference.bindingVersion !== b.bindingVersion || reference.serviceId !== b.serviceId || reference.serviceIdentity !== b.serviceIdentity ||
    reference.sourcePolicyVersion !== b.sourcePolicy.version || reference.exposurePolicyVersion !== b.exposurePolicy.version) {
    return 'cloudReference:runtime_mismatch';
  }
  if (reference.expiresAt > Math.min(b.expiresAt, b.sourcePolicy.expiresAt, b.exposurePolicy.expiresAt)) return 'cloudReference:outlives_binding';
  if ([b.catalogue.identityRef, b.reference.credentialRef, b.qloo.credentialRef, b.sealing.keyRef].includes(reference.identityRef)) {
    return 'cloudReference:identity_not_distinct';
  }
  return null;
}
