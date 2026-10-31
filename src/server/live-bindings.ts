import { LIMITS, RECORDING_SERVICES, type RecordingService } from '../shared/records.js';
import { resolvePolicy } from './ledger/ledger.js';
import type { ExposurePolicy } from './ledger/policy.js';
import { OWNED_COLLECTIONS } from './persistence/docstore.js';
import { GEMINI_CATALOGUE_PROFILE } from './providers/gemini-catalogue.js';
import { GEMINI_REFERENCE_PROFILE } from './providers/gemini-reference.js';
import { GEMINI_LIVE_PROFILE } from './providers/gemini-live-reference.js';
import { QLOO_HOSTS, type QlooHost } from './providers/qloo.js';
import { parseSourcePolicy, type SourcePolicy } from './source-policy.js';
import { parseHostedServing, type HostedServing } from './serving-profile.js';

// Controller-owned live runtime binding (O01, O03, O04, D07), reconciled with
// the actual adapters, the shared store and the code constants. It carries
// references (secret-manager names, a symbolic identity) and approved
// policies, never secret values. Validation is strict and fails closed: every
// level has exact keys, no empty strings, no test-only profile, nothing
// expired, and every lifetime/count/model/collection value must agree with
// what the code enforces. Problems are safe `path:code` strings: no values,
// secrets or account identifiers are ever echoed.

export interface LiveBindings {
  readonly profile: 'live';
  readonly bindingVersion: string;
  /** Ms epoch; the binding (and anything composed from it) is refused at or after this. */
  readonly expiresAt: number;
  /** Symbolic accounting domain shared by every instance of this service. */
  readonly serviceId: string;
  /** Symbolic runtime identity name the controller grants least privilege to (never a credential). */
  readonly serviceIdentity: string;
  /** Who reconciles unknown-cost work and issues typed settlement receipts. */
  readonly settlementOwner: string;
  readonly exposurePolicy: ExposurePolicy;
  /**
   * Deep-frozen copy of the approved policy, taken synchronously during
   * validation; exposurePolicy is parsed from exactly this snapshot and the
   * store receives exactly this snapshot (never the caller's mutable object).
   */
  readonly exposurePolicySnapshot: unknown;
  readonly sourcePolicy: SourcePolicy;
  readonly limits: {
    readonly sessionLifetimeMs: number;
    readonly executeDeadlineMs: number;
    readonly providerRequestMs: number;
    readonly maxSessions: number;
    readonly maxJourneysPerSession: number;
    readonly freeMutation: { readonly perSession: number; readonly perService: number; readonly windowMs: number };
  };
  readonly firestore: {
    readonly projectId: string;
    /** '(default)' or a named database ID, passed to the SDK explicitly. */
    readonly databaseId: string;
  };
  /** Gemini Developer API reference profile: an API key reference. */
  readonly reference: { readonly credentialRef: string };
  /** Separate explicit authority; a recording permission alone never enables streaming. */
  readonly liveListening?: typeof GEMINI_LIVE_PROFILE & { readonly approvalId: string };
  /** Vertex AI catalogue profile: Cloud project, explicit quota project and a short-lived bearer identity. */
  readonly catalogue: { readonly projectId: string; readonly quotaProjectId: string; readonly identityRef: string };
  readonly qloo: { readonly host: QlooHost; readonly credentialRef: string };
  /** Durable server-only record-sealing key (stable across instances and restarts). */
  readonly sealing: { readonly keyRef: string };
  /**
   * Recording destinations the native catalogue may verify. An absent binding
   * field means YouTube only; an explicit list (known, unique, non-empty) may
   * enable apple_music, whose first-party metadata host is then reachable.
   */
  readonly recordingServices: readonly RecordingService[];
  /** Absent means the existing loopback-only profile. Hosted use needs an explicit matching constructor and this binding. */
  readonly serving?: HostedServing;
}

type Raw = Record<string, unknown>;

const SYMBOL = /^[a-z][a-z0-9-]{2,62}$/;
const VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9/_.-]{2,255}$/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const NAMED_DATABASE = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const SERVICE_ID = /^[a-z][a-z0-9-]{2,62}$/;
const REJECT_PROFILE = /(^|[-_.])(test|synthetic|fixture|example|demo|local)([-_.]|$)/;
/**
 * ISO 4217 reserved codes: XTS (testing) and XXX (no currency). XTS stays the
 * synthetic ledger fixture currency; a live binding refuses both. A declared
 * real currency code is necessary, not proof of approved pricing.
 */
const TEST_CURRENCIES = new Set(['XTS', 'XXX']);

/** Recursively freezes plain objects/arrays (functions and already-frozen values are left as they are). */
function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

const TOP_KEYS = [
  'profile',
  'bindingVersion',
  'expiresAt',
  'serviceId',
  'serviceIdentity',
  'settlementOwner',
  'exposurePolicy',
  'sourcePolicy',
  'limits',
  'firestore',
  'reference',
  'catalogue',
  'qloo',
  'sealing',
];
/** Top-level keys that may be absent (each with a documented fail-closed default). */
const OPTIONAL_TOP_KEYS = ['recordingServices', 'serving', 'liveListening'];

/** Capture JSON-like own data once, without evaluating a getter or inheriting authority. */
function captureBindingData(raw: unknown): unknown {
  const ancestors = new Set<object>();
  let remaining = 4096;
  const visit = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 32) throw new Error('binding shape');
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('binding shape');
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error('binding shape');
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new Error('binding shape');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some(key => !Object.hasOwn(descriptors[key as string]!, 'value'))) throw new Error('binding shape');
    ancestors.add(value);
    try {
      if (array) {
        const length = descriptors.length!.value as number;
        if (length > remaining || keys.length !== length + 1) throw new Error('binding shape');
        const copy: unknown[] = [];
        for (let i = 0; i < length; i += 1) {
          if (!Object.hasOwn(descriptors, String(i))) throw new Error('binding shape');
          copy.push(visit(descriptors[String(i)]!.value, depth + 1));
        }
        return copy;
      }
      return Object.fromEntries((keys as string[]).map(key => [key, visit(descriptors[key]!.value, depth + 1)]));
    } finally {
      ancestors.delete(value);
    }
  };
  return visit(raw, 0);
}

export function validateLiveBindings(raw: unknown, now: number): { ok: true; bindings: LiveBindings } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const bad = (path: string, code: string) => void problems.push(`${path}:${code}`);
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, problems: ['clock:invalid'] };
  try { raw = captureBindingData(raw); } catch { return { ok: false, problems: ['binding:shape'] }; }

  /** Exact keys; returns the object (or {} after recording problems). */
  const obj = (v: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Raw => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      bad(path, v === undefined ? 'missing' : 'invalid');
      return Object.create(null) as Raw;
    }
    const o = v as Raw;
    for (const k of keys) if (!Object.hasOwn(o, k)) bad(`${path}.${k}`.replace(/^\./, ''), 'missing');
    // Unknown names can themselves contain pasted private material. Only code-owned paths leave this parser.
    if (Object.keys(o).some(k => !keys.includes(k) && !optional.includes(k))) bad(path || 'binding', 'extra');
    // Downstream reads of missing required fields must not reach ambient
    // Object.prototype accessors, even after the own-data capture above.
    const own = Object.create(null) as Raw;
    for (const k of [...keys, ...optional]) if (Object.hasOwn(o, k)) own[k] = o[k];
    return own;
  };
  const str = (v: unknown, path: string, re: RegExp): string => {
    if (v === undefined) { bad(path, 'missing'); return ''; }
    if (typeof v !== 'string' || v.trim() === '') bad(path, 'empty');
    else if (!re.test(v)) bad(path, 'invalid');
    return typeof v === 'string' ? v : '';
  };
  const int = (v: unknown, path: string, min: number, max: number): number => {
    if (v === undefined) { bad(path, 'missing'); return 0; }
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) bad(path, 'invalid');
    return typeof v === 'number' ? v : 0;
  };
  const exact = (v: unknown, path: string, expected: number | string) => {
    if (v === undefined) bad(path, 'missing');
    else if (v !== expected) bad(path, 'mismatch');
  };

  const o = obj(raw, '', TOP_KEYS, OPTIONAL_TOP_KEYS);
  // Recording-service capability, read (and copied) synchronously here like every other value.
  const recordingServices = parseRecordingServices(o, bad);
  let serving: HostedServing | undefined;
  if (Object.hasOwn(o, 'serving')) {
    const parsed = parseHostedServing(o.serving);
    if (parsed.ok) serving = parsed.serving;
    else bad('serving', parsed.problem);
  }
  if (o.profile !== undefined && o.profile !== 'live') bad('profile', 'not_live');
  const bindingVersion = str(o.bindingVersion, 'bindingVersion', VERSION);
  const expiresAt = int(o.expiresAt, 'expiresAt', 1, Number.MAX_SAFE_INTEGER);
  if (o.expiresAt !== undefined && expiresAt <= now) bad('expiresAt', 'expired');
  const serviceId = str(o.serviceId, 'serviceId', SERVICE_ID);
  const serviceIdentity = str(o.serviceIdentity, 'serviceIdentity', SYMBOL);
  const settlementOwner = str(o.settlementOwner, 'settlementOwner', SYMBOL);
  for (const [path, value] of [
    ['bindingVersion', bindingVersion],
    ['serviceId', serviceId],
    ['serviceIdentity', serviceIdentity],
  ] as const) {
    if (REJECT_PROFILE.test(value)) bad(path, 'test_only');
  }

  // Approved exposure policy: an immutable snapshot (exact parse) that must be current and not test-only.
  let exposurePolicy: ExposurePolicy | null = null;
  let exposurePolicySnapshot: unknown = null;
  if (o.exposurePolicy === undefined) bad('exposurePolicy', 'missing');
  else {
    let snapshot: unknown = null;
    try {
      snapshot = deepFreeze(structuredClone(o.exposurePolicy));
    } catch {
      snapshot = null;
    }
    const p = snapshot === null ? 'invalid' : resolvePolicy(snapshot);
    if (p === 'missing' || p === 'invalid') bad('exposurePolicy', 'invalid');
    else if (TEST_CURRENCIES.has(p.currency)) bad('exposurePolicy.currency', 'test_currency');
    else if (p.expiresAt <= now) bad('exposurePolicy', 'expired');
    else {
      exposurePolicy = deepFreeze(p);
      exposurePolicySnapshot = snapshot;
    }
  }

  // Executable eligible-source policy must be current.
  let sourcePolicy: SourcePolicy | null = null;
  if (o.sourcePolicy === undefined) bad('sourcePolicy', 'missing');
  else {
    const s = parseSourcePolicy(o.sourcePolicy);
    if (!s.ok) bad('sourcePolicy', s.problem);
    else if (s.policy.expiresAt <= now) bad('sourcePolicy', 'expired');
    else sourcePolicy = s.policy;
  }

  // Lifetimes must equal what the store/harness/adapters enforce; capacities are bounded.
  const l = obj(o.limits, 'limits', ['sessionLifetimeMs', 'executeDeadlineMs', 'providerRequestMs', 'maxSessions', 'maxJourneysPerSession', 'freeMutation']);
  exact(l.sessionLifetimeMs, 'limits.sessionLifetimeMs', LIMITS.sessionLifetimeMs);
  exact(l.executeDeadlineMs, 'limits.executeDeadlineMs', LIMITS.executeDeadlineMs);
  exact(l.providerRequestMs, 'limits.providerRequestMs', LIMITS.providerRequestMs);
  const maxSessions = int(l.maxSessions, 'limits.maxSessions', 1, 5000);
  const maxJourneysPerSession = int(l.maxJourneysPerSession, 'limits.maxJourneysPerSession', 1, 10);
  const fm = obj(l.freeMutation, 'limits.freeMutation', ['perSession', 'perService', 'windowMs']);
  const freeMutation = {
    perSession: int(fm.perSession, 'limits.freeMutation.perSession', 1, 1000),
    perService: int(fm.perService, 'limits.freeMutation.perService', 1, 1_000_000),
    windowMs: int(fm.windowMs, 'limits.freeMutation.windowMs', 1000, LIMITS.sessionLifetimeMs),
  };

  // Firestore: explicit project/database; the controller attests the TTL policies on both
  // owned collections (field expireAt only) and the ledger reconciliation index.
  const f = obj(o.firestore, 'firestore', ['projectId', 'databaseId', 'ownedTtl', 'reconciliationIndex']);
  const fsProject = str(f.projectId, 'firestore.projectId', PROJECT_ID);
  const databaseId = f.databaseId === '(default)' ? '(default)' : str(f.databaseId, 'firestore.databaseId', NAMED_DATABASE);
  const ttl = obj(f.ownedTtl, 'firestore.ownedTtl', ['collections', 'field']);
  if (ttl.collections !== undefined) {
    const c = ttl.collections;
    if (!Array.isArray(c) || !c.every(value => typeof value === 'string') || [...c].sort().join(',') !== [...OWNED_COLLECTIONS].sort().join(',') || c.length !== OWNED_COLLECTIONS.length) bad('firestore.ownedTtl.collections', 'mismatch');
  }
  exact(ttl.field, 'firestore.ownedTtl.field', 'expireAt');
  const idx = obj(f.reconciliationIndex, 'firestore.reconciliationIndex', ['collection', 'fields']);
  exact(idx.collection, 'firestore.reconciliationIndex.collection', 'wintr_ledger_reservations');
  if (idx.fields !== undefined && (!Array.isArray(idx.fields) || idx.fields.length !== 2 || idx.fields[0] !== 'service' || idx.fields[1] !== 'state')) bad('firestore.reconciliationIndex.fields', 'mismatch');

  // Provider profiles: models are fixed in code; credentials are distinct references.
  const r = obj(o.reference, 'reference', ['model', 'credentialRef']);
  exact(r.model, 'reference.model', GEMINI_REFERENCE_PROFILE.model);
  const referenceRef = str(r.credentialRef, 'reference.credentialRef', REF);
  let liveListening: LiveBindings['liveListening'];
  if (Object.hasOwn(o, 'liveListening')) {
    const l = obj(o.liveListening, 'liveListening', [...Object.keys(GEMINI_LIVE_PROFILE), 'approvalId']);
    for (const [key, value] of Object.entries(GEMINI_LIVE_PROFILE)) exact(l[key], `liveListening.${key}`, value);
    const approvalId = str(l.approvalId, 'liveListening.approvalId', /^call_[A-Za-z0-9_-]{8,100}$/);
    if (!sourcePolicy?.allowsLiveAudio?.(now)) bad('liveListening', 'source_refused');
    liveListening = { ...GEMINI_LIVE_PROFILE, approvalId };
  } else if (sourcePolicy?.allowsLiveAudio?.(now)) bad('liveListening', 'missing');
  const c = obj(o.catalogue, 'catalogue', ['model', 'location', 'projectId', 'quotaProjectId', 'identityRef']);
  exact(c.model, 'catalogue.model', GEMINI_CATALOGUE_PROFILE.model);
  exact(c.location, 'catalogue.location', GEMINI_CATALOGUE_PROFILE.location);
  const catProject = str(c.projectId, 'catalogue.projectId', PROJECT_ID);
  const quotaProject = str(c.quotaProjectId, 'catalogue.quotaProjectId', PROJECT_ID);
  const identityRef = str(c.identityRef, 'catalogue.identityRef', REF);
  const q = obj(o.qloo, 'qloo', ['host', 'credentialRef']);
  if (q.host !== undefined && !(QLOO_HOSTS as readonly unknown[]).includes(q.host)) bad('qloo.host', 'invalid');
  const qlooRef = str(q.credentialRef, 'qloo.credentialRef', REF);
  const s = obj(o.sealing, 'sealing', ['keyRef']);
  const sealingRef = str(s.keyRef, 'sealing.keyRef', REF);
  const refs = [referenceRef, identityRef, qlooRef, sealingRef].filter(Boolean);
  if (new Set(refs).size !== refs.length) bad('credentials', 'not_distinct');

  if (problems.length > 0 || !exposurePolicy || !sourcePolicy) return { ok: false, problems: problems.length ? problems : ['binding:invalid'] };
  // Every returned value is a fresh copy, deep-frozen: later changes to the caller's object cannot alter authority.
  return {
    ok: true,
    bindings: deepFreeze({
      profile: 'live',
      bindingVersion,
      expiresAt,
      serviceId,
      serviceIdentity,
      settlementOwner,
      exposurePolicy,
      exposurePolicySnapshot,
      sourcePolicy,
      limits: {
        sessionLifetimeMs: LIMITS.sessionLifetimeMs,
        executeDeadlineMs: LIMITS.executeDeadlineMs,
        providerRequestMs: LIMITS.providerRequestMs,
        maxSessions,
        maxJourneysPerSession,
        freeMutation,
      },
      firestore: { projectId: fsProject, databaseId },
      reference: { credentialRef: referenceRef },
      ...(liveListening ? { liveListening } : {}),
      catalogue: { projectId: catProject, quotaProjectId: quotaProject, identityRef },
      qloo: { host: q.host as QlooHost, credentialRef: qlooRef },
      sealing: { keyRef: sealingRef },
      recordingServices,
      ...(serving ? { serving } : {}),
    } satisfies LiveBindings),
  };
}

/**
 * Absent: YouTube only. Present: a non-empty array of unique known service
 * names (at most one entry per service). Anything else fails closed. The result
 * is a fresh array, frozen with the binding.
 */
function parseRecordingServices(o: Raw, bad: (path: string, code: string) => void): RecordingService[] {
  if (!Object.hasOwn(o, 'recordingServices')) return ['youtube'];
  const v = o.recordingServices;
  if (!Array.isArray(v)) {
    bad('recordingServices', 'invalid');
    return [];
  }
  if (v.length === 0) {
    bad('recordingServices', 'empty');
    return [];
  }
  if (!v.every((s) => typeof s === 'string' && (RECORDING_SERVICES as readonly string[]).includes(s))) {
    bad('recordingServices', 'unknown');
    return [];
  }
  if (new Set(v).size !== v.length || v.length > RECORDING_SERVICES.length) {
    bad('recordingServices', 'duplicate');
    return [];
  }
  return [...(v as RecordingService[])];
}
