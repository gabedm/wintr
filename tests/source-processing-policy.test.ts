import { describe, expect, it } from 'vitest';
import { MAX_APPROVED_SOURCES, parseSourcePolicy } from '../src/server/source-policy.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { cloudReferenceBindingProblem, type CloudReferenceBinding } from '../src/server/cloud-reference-profile.js';
import { binding } from './fixtures/live-fixtures.js';
import { cloudBinding } from './fixtures/cloud-reference-fixtures.js';

// Server configuration over invented IDs/digests only; never actual permission.
const deniedVideo = 'invDenied01', allowedVideo = 'invAllowed1';
const deniedDigest = 'd'.repeat(64), freshDigest = 'e'.repeat(64);
const capability = () => ({ kind: 'user_directed_music', permissionVersion: 'invented-processing-approval', youtube: true, recorded: true,
  deniedVideoIds: [deniedVideo], deniedRecordedDigests: [deniedDigest] });
const raw = () => ({ version: 'invented-policy-label', expiresAt: 10_000, videoIds: [] as string[], recordedDigests: [] as string[], processing: capability() });
const parse = (value: unknown) => { const p = parseSourcePolicy(value); if (!p.ok) throw Error(p.problem); return p.policy; };

describe('optional server-owned submitted-music processing capability', () => {
  it('preserves finite bindings and refuses an empty policy without the capability', () => {
    const finite = parse({ version: 'invented-policy-label', expiresAt: 10000, videoIds: [allowedVideo], recordedDigests: [freshDigest] });
    expect(finite.version).toBe('invented-policy-label'); expect(finite.recordingSelfService).toBe(false);
    expect(finite.allows(allowedVideo, 1)).toBe(true); expect(finite.allows('invUnseen01', 1)).toBe(false);
    expect(finite.allowsRecording(freshDigest, 1)).toBe(true); expect(finite.allowsRecording('f'.repeat(64), 1)).toBe(false);
    expect(parseSourcePolicy({ version: 'invented-policy-label', expiresAt: 10000, videoIds: [] })).toEqual({ ok: false, problem: 'empty' });
  });

  it('checks exact known denials before finite approvals or the kind grant', () => {
    const value = raw(); value.videoIds.push(deniedVideo); value.recordedDigests.push(deniedDigest);
    const policy = parse(value);
    expect(policy.recordingSelfService).toBe(true); expect(policy.allows(allowedVideo, 1)).toBe(true); expect(policy.allowsRecording(freshDigest, 1)).toBe(true);
    expect(policy.allows(deniedVideo, 1)).toBe(false); expect(policy.allowsRecording(deniedDigest, 1)).toBe(false);
    for (const time of [-1, NaN, Infinity, 1.1, 10000, 10001]) {
      expect(policy.allows(allowedVideo, time)).toBe(false); expect(policy.allowsRecording(freshDigest, time)).toBe(false);
    }
    expect(policy.allows('*', 1)).toBe(false); expect(policy.allowsRecording('*', 1)).toBe(false);
  });

  it('uses immutable snapshots and keeps each input kind separate', () => {
    const value = raw(); value.processing.recorded = false;
    const policy = parse(value); value.processing.youtube = false; value.processing.recorded = true;
    value.processing.deniedVideoIds.length = 0; value.expiresAt = 20000;
    expect(policy.recordingSelfService).toBe(false); expect(policy.allows(allowedVideo, 1)).toBe(true);
    expect(policy.allows(deniedVideo, 1)).toBe(false); expect(policy.allowsRecording(freshDigest, 1)).toBe(false); expect(policy.allows(allowedVideo, 10000)).toBe(false);
  });

  it('binds the complete capability into a new effective version, separate from the old finite preparation label', () => {
    const value = raw(), first = parse(value);
    expect(first.version).toMatch(/^[a-f0-9]{64}$/); expect(first.version).not.toBe(value.version);
    for (const change of [
      { ...value, expiresAt: 10001 }, { ...value, version: 'another-label' },
      { ...value, videoIds: [allowedVideo] }, { ...value, recordedDigests: [freshDigest] },
      { ...value, processing: { ...value.processing, recorded: false } },
      { ...value, processing: { ...value.processing, permissionVersion: 'another-owner-policy' } },
      { ...value, processing: { ...value.processing, deniedVideoIds: [] } },
      { ...value, processing: { ...value.processing, deniedRecordedDigests: [] } },
    ]) expect(parse(change).version).not.toBe(first.version);
    expect(parse({ ...value, processing: { ...value.processing } }).version).toBe(first.version);
  });

  it('refuses missing/extra/malformed capability fields, duplicates and over-bound lists', () => {
    for (const processing of [undefined, null, {}, { ...capability(), kind: '*' }, { ...capability(), extra: true },
      { ...capability(), youtube: 'true' }, { ...capability(), youtube: false, recorded: false },
      { ...capability(), permissionVersion: '' }, { ...capability(), deniedVideoIds: ['*'] },
      { ...capability(), deniedRecordedDigests: ['bad'] }, { ...capability(), deniedVideoIds: [deniedVideo, deniedVideo] },
    ]) expect(parseSourcePolicy({ ...raw(), processing }).ok).toBe(false);
    const value = raw(); value.processing.deniedRecordedDigests = Array.from({ length: MAX_APPROVED_SOURCES + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
    expect(parseSourcePolicy(value)).toEqual({ ok: false, problem: 'too_many' });
  });

  it('refuses an old finite Cloud preparation identity even when the raw version label is reused', () => {
    const finite = binding(), reference = cloudBinding(finite) as CloudReferenceBinding;
    const parsed = validateLiveBindings({ ...finite, sourcePolicy: { ...finite.sourcePolicy, processing: capability() } }, Date.now());
    expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    expect(cloudReferenceBindingProblem(reference, parsed.bindings)).toBe('cloudReference:runtime_mismatch');
    expect(cloudReferenceBindingProblem({ ...reference, sourcePolicyVersion: parsed.bindings.sourcePolicy.version }, parsed.bindings)).toBeNull();
  });

  it('rejects accessor and inherited configuration before evaluating user code', () => {
    let calls = 0;
    for (const field of Object.keys(capability())) {
      const processing = capability(); Object.defineProperty(processing, field, { enumerable: true, get: () => { calls++; throw Error('must not execute'); } });
      expect(parseSourcePolicy({ ...raw(), processing }).ok).toBe(false);
    }
    const value = raw(); Object.defineProperty(value, 'processing', { enumerable: true, get: () => { calls++; return capability(); } });
    expect(parseSourcePolicy(value).ok).toBe(false);
    expect(parseSourcePolicy({ ...raw(), processing: Object.assign(Object.create(capability()), capability()) }).ok).toBe(false);
    expect(calls).toBe(0);
  });
});
