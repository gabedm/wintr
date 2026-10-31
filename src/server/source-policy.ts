import { createHash } from 'node:crypto';

// Server-owned processing authority, checked before admission and dispatch.
// Existing bindings remain finite. A separately approved optional capability
// permits specified user-directed input kinds, with explicit known denials as
// vetoes. Format validation does not prove rights, availability or audio origin.
// Nothing here fetches media, enrols a source or bypasses a provider refusal.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_APPROVED_SOURCES = 256;

export interface SourcePolicy {
  readonly version: string;
  /** Ms epoch after which no reference is admitted or dispatched. */
  readonly expiresAt: number;
  readonly size: number;
  /** Presentation capability only; the server still checks every receipt/input. */
  readonly recordingSelfService?: boolean;
  /** True only for an approved canonical ID while the policy is current (finite safe non-negative clock). */
  allows(videoId: string, now: number): boolean;
  /** Finite digests or a current server-owned recording capability, with denial vetoes. Registration never grants permission. */
  allowsRecording(sha256: string, now: number): boolean;
  /** Separate explicit class grant. Live cannot pre-screen a complete digest, so any active digest denial disables it. */
  allowsLiveAudio?(now: number): boolean;
}

export type SourcePolicyProblem = 'shape' | 'version' | 'expiry' | 'empty' | 'too_many' | 'video_id' | 'recording_digest' | 'duplicate' | 'processing';

/** Closed own-data configuration; optional recorded digests and separately approved processing capability. Problems never contain values. */
export function parseSourcePolicy(raw: unknown): { ok: true; policy: SourcePolicy } | { ok: false; problem: SourcePolicyProblem } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'shape' };
  if (Object.getPrototypeOf(raw) !== Object.prototype) return { ok: false, problem: 'shape' };
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const keys = Reflect.ownKeys(raw);
  if (keys.some(k => typeof k !== 'string' || !Object.hasOwn(descriptors[k]!, 'value'))) return { ok: false, problem: 'shape' };
  if (!['version', 'expiresAt', 'videoIds'].every(k => Object.hasOwn(descriptors, k)) ||
    keys.some(k => !['version', 'expiresAt', 'videoIds', 'recordedDigests', 'processing'].includes(k as string))) return { ok: false, problem: 'shape' };
  const o = Object.fromEntries((keys as string[]).map(k => [k, descriptors[k]!.value])) as Record<string, unknown>;
  if (typeof o.version !== 'string' || !VERSION.test(o.version)) return { ok: false, problem: 'version' };
  if (typeof o.expiresAt !== 'number' || !Number.isSafeInteger(o.expiresAt) || o.expiresAt <= 0) return { ok: false, problem: 'expiry' };
  if (!Array.isArray(o.videoIds)) return { ok: false, problem: 'shape' };
  const digests = Object.hasOwn(o, 'recordedDigests') ? o.recordedDigests : [];
  if (!Array.isArray(digests)) return { ok: false, problem: 'shape' };
  if (o.videoIds.length + digests.length > MAX_APPROVED_SOURCES) return { ok: false, problem: 'too_many' };
  const dataArray = (a: unknown[]) => Object.getPrototypeOf(a) === Array.prototype && Reflect.ownKeys(a).length === a.length + 1 &&
    Array.from({ length: a.length }, (_, i) => Object.getOwnPropertyDescriptor(a, String(i))).every(d => !!d && Object.hasOwn(d, 'value'));
  if (!dataArray(o.videoIds) || !dataArray(digests)) return { ok: false, problem: 'shape' };
  let processing: { youtube: boolean; recorded: boolean; live: boolean; hasLive: boolean; permissionVersion: string; deniedVideoIds: string[]; deniedRecordedDigests: string[] } | null = null;
  if (Object.hasOwn(o, 'processing')) {
    const p = o.processing;
    if (typeof p !== 'object' || p === null || Object.getPrototypeOf(p) !== Object.prototype) return { ok: false, problem: 'processing' };
    const ds = Object.getOwnPropertyDescriptors(p), ks = Reflect.ownKeys(p);
    const expected = ['deniedRecordedDigests', 'deniedVideoIds', 'kind', 'permissionVersion', 'recorded', 'youtube'];
    if (ks.some(k => typeof k !== 'string' || !Object.hasOwn(ds[k]!, 'value')) ||
      expected.some(k => !Object.hasOwn(ds, k)) || ks.some(k => ![...expected, 'live'].includes(k as string))) return { ok: false, problem: 'processing' };
    const v = Object.fromEntries((ks as string[]).map(k => [k, ds[k]!.value])) as Record<string, unknown>;
    if (v.kind !== 'user_directed_music' || typeof v.permissionVersion !== 'string' || !VERSION.test(v.permissionVersion) ||
      typeof v.youtube !== 'boolean' || typeof v.recorded !== 'boolean' ||
      (Object.hasOwn(v, 'live') && typeof v.live !== 'boolean') || (!v.youtube && !v.recorded && v.live !== true) ||
      !Array.isArray(v.deniedVideoIds) || !Array.isArray(v.deniedRecordedDigests)) return { ok: false, problem: 'processing' };
    if (o.videoIds.length + digests.length + v.deniedVideoIds.length + v.deniedRecordedDigests.length > MAX_APPROVED_SOURCES) return { ok: false, problem: 'too_many' };
    if (!dataArray(v.deniedVideoIds) || !dataArray(v.deniedRecordedDigests)) return { ok: false, problem: 'processing' };
    if (!v.deniedVideoIds.every(id => typeof id === 'string' && VIDEO_ID.test(id)) ||
      !v.deniedRecordedDigests.every(d => typeof d === 'string' && /^[a-f0-9]{64}$/.test(d))) return { ok: false, problem: 'processing' };
    if (new Set(v.deniedVideoIds).size !== v.deniedVideoIds.length || new Set(v.deniedRecordedDigests).size !== v.deniedRecordedDigests.length) return { ok: false, problem: 'duplicate' };
    // Never offer an override: a complete clip/digest does not exist before streaming starts.
    if (v.live === true && v.deniedRecordedDigests.length !== 0) return { ok: false, problem: 'processing' };
    processing = { youtube: v.youtube, recorded: v.recorded, live: v.live === true, hasLive: Object.hasOwn(v, 'live'), permissionVersion: v.permissionVersion,
      deniedVideoIds: [...v.deniedVideoIds] as string[], deniedRecordedDigests: [...v.deniedRecordedDigests] as string[] };
  }
  if (o.videoIds.length + digests.length === 0 && !processing) return { ok: false, problem: 'empty' };
  if (o.videoIds.length + digests.length + (processing?.deniedVideoIds.length ?? 0) + (processing?.deniedRecordedDigests.length ?? 0) > MAX_APPROVED_SOURCES) return { ok: false, problem: 'too_many' };
  if (!o.videoIds.every((id) => typeof id === 'string' && VIDEO_ID.test(id))) return { ok: false, problem: 'video_id' };
  const ids = new Set(o.videoIds as string[]);
  if (ids.size !== o.videoIds.length) return { ok: false, problem: 'duplicate' };
  if (!digests.every(d => typeof d === 'string' && /^[a-f0-9]{64}$/.test(d))) return { ok: false, problem: 'recording_digest' };
  const recordings = new Set(digests as string[]);
  if (recordings.size !== digests.length) return { ok: false, problem: 'duplicate' };
  // A class grant cannot inherit an old finite preparation merely by reusing
  // its label. Bind every permission, known denial, source and deadline into
  // the effective version used by Cloud preparation and final source guards.
  const version = processing ? createHash('sha256').update(JSON.stringify({ label: o.version, expiresAt: o.expiresAt,
    videoIds: [...ids].sort(), recordedDigests: [...recordings].sort(), kind: 'user_directed_music',
    permissionVersion: processing.permissionVersion, youtube: processing.youtube, recorded: processing.recorded,
    ...(processing.hasLive ? { live: processing.live } : {}),
    deniedVideoIds: [...processing.deniedVideoIds].sort(), deniedRecordedDigests: [...processing.deniedRecordedDigests].sort() })).digest('hex') : o.version;
  const expiresAt = o.expiresAt;
  const deniedIds = new Set(processing?.deniedVideoIds ?? []), deniedRecordings = new Set(processing?.deniedRecordedDigests ?? []);
  const youtube = processing?.youtube === true, recorded = processing?.recorded === true;
  return {
    ok: true,
    policy: Object.freeze({
      version,
      expiresAt,
      size: ids.size + recordings.size,
      recordingSelfService: recorded,
      allows: (videoId: string, now: number) => Number.isSafeInteger(now) && now >= 0 && now < expiresAt && typeof videoId === 'string' &&
        VIDEO_ID.test(videoId) && !deniedIds.has(videoId) && (ids.has(videoId) || youtube),
      allowsRecording: (digest: string, now: number) => Number.isSafeInteger(now) && now >= 0 && now < expiresAt && typeof digest === 'string' &&
        /^[a-f0-9]{64}$/.test(digest) && !deniedRecordings.has(digest) && (recordings.has(digest) || recorded),
      allowsLiveAudio: (now: number) => Number.isSafeInteger(now) && now >= 0 && now < expiresAt && processing?.live === true && deniedRecordings.size === 0,
    }),
  };
}
