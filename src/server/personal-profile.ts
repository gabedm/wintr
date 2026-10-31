import { createHash } from 'node:crypto';
import { LIMITS } from '../shared/records.js';
import { parseSourcePolicy } from './source-policy.js';
import { validateLiveBindings } from './live-bindings.js';
import type { ServiceTotals } from './ledger/ledger.js';
import { GEMINI_LIVE_PROFILE } from './providers/gemini-live-reference.js';

// A separately approved ongoing personal connection, never a renewed test hour.
// The finite sentinel represents explicit until-revoked authority. The local
// approval file is checked at every outbound boundary and watched for shutdown.
// Session/Attempt/provider deadlines retain their ordinary short lifetimes.
export const PERSONAL_EXPIRY = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export class PersonalSetupError extends Error {
  constructor(readonly code: 'setup_required' | 'setup_changed' | 'sign_in_required' | 'accounting_unavailable' | 'accounting_changed' | 'already_starting' | 'startup_failed') {
    super(code); this.name = 'PersonalSetupError';
  }
}
export function ownData(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype) throw new PersonalSetupError('setup_required');
  const keys = Reflect.ownKeys(raw), ds = Object.getOwnPropertyDescriptors(raw);
  if (keys.some(k => typeof k !== 'string' || ![...required, ...optional].includes(k) || !Object.hasOwn(ds[k]!, 'value')) || required.some(k => !Object.hasOwn(ds, k))) throw new PersonalSetupError('setup_required');
  return Object.fromEntries((keys as string[]).map(k => [k, ds[k]!.value]));
}
const integer = (n: unknown, min = 0) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const text = (v: unknown, re: RegExp): string => {
  if (typeof v !== 'string' || !re.test(v)) throw new PersonalSetupError('setup_required'); return v;
};
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SYMBOL = /^[a-z][a-z0-9-]{2,62}$/;
export interface PersonalProfile {
  readonly schema: 1; readonly profileId: string; readonly approved: true; readonly approvalId: string;
  readonly approvedAt: number; readonly authority: 'until_revoked'; readonly enabled: true;
  readonly projectId: string; readonly quotaProjectId: string; readonly geminiProjectId: string;
  readonly databaseId: string; readonly runtimeServiceAccount: string;
  readonly serviceId: string; readonly serviceIdentity: string; readonly settlementOwner: string; readonly port: number;
  readonly baseline: Readonly<ServiceTotals>;
  readonly allowance: { readonly gbpMinor: number; readonly qloo: number; readonly gemini: number };
  readonly deniedVideoIds: readonly string[];
  readonly deniedRecordedDigests: readonly string[];
  readonly recordedMusicApprovalId: string | null;
}
export function parsePersonalProfile(raw: unknown, now: number): PersonalProfile {
  const p = ownData(raw, ['schema', 'profileId', 'approved', 'approvalId', 'approvedAt', 'authority', 'enabled', 'projectId', 'quotaProjectId', 'geminiProjectId', 'databaseId', 'runtimeServiceAccount', 'serviceId', 'serviceIdentity', 'settlementOwner', 'port', 'baseline', 'allowance', 'deniedVideoIds', 'deniedRecordedDigests', 'recordedMusicApprovalId']);
  if (p.schema !== 1 || p.approved !== true || p.enabled !== true || p.authority !== 'until_revoked' || !integer(now) || !integer(p.approvedAt, 1) || (p.approvedAt as number) > now) throw new PersonalSetupError('setup_required');
  const profileId = text(p.profileId, /^[a-f0-9]{32}$/), approvalId = text(p.approvalId, /^call_[A-Za-z0-9_-]{8,100}$/);
  const projectId = text(p.projectId, PROJECT), quotaProjectId = text(p.quotaProjectId, PROJECT), geminiProjectId = text(p.geminiProjectId, PROJECT);
  if (quotaProjectId !== projectId || !integer(p.port, 1024) || (p.port as number) > 65535) throw new PersonalSetupError('setup_required');
  const runtimeServiceAccount = text(p.runtimeServiceAccount, /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/);
  if (!runtimeServiceAccount.endsWith(`@${projectId}.iam.gserviceaccount.com`)) throw new PersonalSetupError('setup_required');
  const a = ownData(p.allowance, ['gbpMinor', 'qloo', 'gemini']);
  if (!integer(a.gbpMinor, 482) || !integer(a.qloo, 6) || !integer(a.gemini, 4) || (a.gbpMinor as number) > 1_000_000 || (a.qloo as number) > 1_000_000 || (a.gemini as number) > 1_000_000) throw new PersonalSetupError('setup_required');
  const baseline = captureTotals(p.baseline);
  if (baseline.active !== 0 || !Number.isSafeInteger(baseline.unitsHeld + (a.gbpMinor as number)) ||
      baseline.counts.qloo + (a.qloo as number) > 1_000_000 || baseline.counts.gemini + (a.gemini as number) > 1_000_000) throw new PersonalSetupError('setup_required');
  const recordedMusicApprovalId = p.recordedMusicApprovalId === null ? null : text(p.recordedMusicApprovalId, /^call_[A-Za-z0-9_-]{8,100}$/);
  const source = parseSourcePolicy({ version: `personal-${profileId}`, expiresAt: PERSONAL_EXPIRY, videoIds: [], processing: { kind: 'user_directed_music', permissionVersion: `personal-${profileId}`, youtube: true, recorded: recordedMusicApprovalId !== null, deniedVideoIds: p.deniedVideoIds, deniedRecordedDigests: p.deniedRecordedDigests } });
  if (!source.ok) throw new PersonalSetupError('setup_required');
  return Object.freeze({ schema: 1, profileId, approved: true, approvalId, approvedAt: p.approvedAt as number, authority: 'until_revoked', enabled: true,
    projectId, quotaProjectId, geminiProjectId, runtimeServiceAccount, databaseId: text(p.databaseId, /^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/),
    serviceId: text(p.serviceId, SYMBOL), serviceIdentity: text(p.serviceIdentity, SYMBOL), settlementOwner: text(p.settlementOwner, SYMBOL), port: p.port as number,
    baseline: Object.freeze(baseline), allowance: Object.freeze({ gbpMinor: a.gbpMinor as number, qloo: a.qloo as number, gemini: a.gemini as number }),
    deniedVideoIds: Object.freeze([...(p.deniedVideoIds as string[])]), deniedRecordedDigests: Object.freeze([...(p.deniedRecordedDigests as string[])]), recordedMusicApprovalId });
}
export const personalFingerprint = (p: PersonalProfile) => createHash('sha256').update(JSON.stringify(p)).digest('hex');
export function captureTotals(raw: unknown): ServiceTotals {
  const t = ownData(raw, ['currency', 'counts', 'unitsHeld', 'active', 'unresolved']), c = ownData(t.counts, ['qloo', 'gemini']);
  if (t.currency !== 'GBP' || ![c.qloo, c.gemini, t.unitsHeld, t.active, t.unresolved].every(n => integer(n)) || (t.active as number) > 2) throw new PersonalSetupError('accounting_changed');
  return { currency: 'GBP', counts: Object.freeze({ qloo: c.qloo as number, gemini: c.gemini as number }), unitsHeld: t.unitsHeld as number, active: t.active as number, unresolved: t.unresolved as number };
}
export function checkPersonalTotals(p: PersonalProfile, raw: unknown, previous: ServiceTotals = p.baseline): ServiceTotals {
  const t = captureTotals(raw), b = p.baseline;
  if (t.counts.qloo < previous.counts.qloo || t.counts.gemini < previous.counts.gemini || t.unitsHeld < previous.unitsHeld || t.unresolved < previous.unresolved ||
      t.counts.qloo > b.counts.qloo + p.allowance.qloo || t.counts.gemini > b.counts.gemini + p.allowance.gemini || t.unitsHeld > b.unitsHeld + p.allowance.gbpMinor) throw new PersonalSetupError('accounting_changed');
  return t;
}
export function personalBindings(p: PersonalProfile, now: number, liveApprovalId?: string) {
  // Sessions may use several chats within the same already-approved cumulative
  // allowance. Version the changed bounds; no service total or hold is reset.
  const version = `personal-${p.profileId}-${liveApprovalId ? 'listen' : 'chats'}-v1`, b = p.baseline, a = p.allowance;
  const bindings = { profile: 'live', bindingVersion: version, expiresAt: PERSONAL_EXPIRY, serviceId: p.serviceId, serviceIdentity: p.serviceIdentity, settlementOwner: p.settlementOwner,
    exposurePolicy: { version, currency: 'GBP', expiresAt: PERSONAL_EXPIRY, sessionMode: 'shared_chats',
      service: { capUnits: b.unitsHeld + a.gbpMinor, counts: { qloo: b.counts.qloo + a.qloo, gemini: b.counts.gemini + a.gemini }, concurrency: 2 },
      session: { capUnits: a.gbpMinor, counts: { qloo: a.qloo, gemini: a.gemini } }, journey: { capUnits: 500, counts: { qloo: 6, gemini: 4 } },
      reservations: { reference_analysis: { units: 119, bound: 'estimate_with_residual' }, catalogue_generation: { units: 119, bound: 'estimate_with_residual' },
        qloo_search: { units: 1, bound: 'estimate_with_residual' }, qloo_artist_insights: { units: 1, bound: 'estimate_with_residual' }, qloo_tag_insights: { units: 1, bound: 'estimate_with_residual' } } },
    sourcePolicy: { version, expiresAt: PERSONAL_EXPIRY, videoIds: [], processing: { kind: 'user_directed_music', permissionVersion: version, youtube: true, recorded: p.recordedMusicApprovalId !== null, ...(liveApprovalId ? { live: true } : {}), deniedVideoIds: p.deniedVideoIds, deniedRecordedDigests: p.deniedRecordedDigests } },
    ...(liveApprovalId ? { liveListening: { ...GEMINI_LIVE_PROFILE, approvalId: liveApprovalId } } : {}),
    limits: { sessionLifetimeMs: LIMITS.sessionLifetimeMs, executeDeadlineMs: LIMITS.executeDeadlineMs, providerRequestMs: LIMITS.providerRequestMs, maxSessions: 100, maxJourneysPerSession: 10, freeMutation: { perSession: 60, perService: 600, windowMs: 60_000 } },
    firestore: { projectId: p.projectId, databaseId: p.databaseId, ownedTtl: { collections: ['wintr_owned', 'wintr_owned_content'], field: 'expireAt' }, reconciliationIndex: { collection: 'wintr_ledger_reservations', fields: ['service', 'state'] } },
    reference: { model: 'gemini-3.6-flash', credentialRef: 'personal/reference' },
    catalogue: { model: 'gemini-3.6-flash', location: 'global', projectId: p.projectId, quotaProjectId: p.quotaProjectId, identityRef: 'personal/google' },
    qloo: { host: 'hackathon.api.qloo.com', credentialRef: 'personal/qloo' }, sealing: { keyRef: 'personal/sealing' }, recordingServices: ['apple_music'] };
  const parsed = validateLiveBindings(bindings, now); if (!parsed.ok) throw new PersonalSetupError('setup_required'); return bindings;
}
