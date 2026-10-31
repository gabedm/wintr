import { createCloudReferencePreparation } from '../../src/server/cloud-reference-profile.js';
import type { CloudReferenceBinding } from '../../src/server/cloud-reference-profile.js';
import type { CloudReferenceToken } from '../../src/server/providers/gemini-cloud-reference.js';
import { ServerSecret } from '../../src/server/providers/secret.js';
import { APPROVED, binding, json } from './live-fixtures.js';

// Invented preparation, source, identity and responses only. No account, token or media is real.
export const CLOUD_TIME = Date.UTC(2026, 9, 27, 1);
export const CLOUD_TOKEN = 'invented-cloud-reference-token-00001';
export const CLOUD_INPUT = { reference: { videoId: APPROVED, canonicalUrl: `https://www.youtube.com/watch?v=${APPROVED}`,
  focus: { start: 12, end: 42 } }, listenerCue: 'An invented groove cue' };
export const CLOUD_OUTPUT = { audio_access: 'accessed', observations: ['An invented dry bass line.'],
  relationships: ['An invented bass and drum relationship'], artist_name: 'Generic Artist' };
export const cloudBinding = (b = binding(), override: Record<string, unknown> = {}) => ({
  profile: 'cloud_youtube_reference_v1', model: 'gemini-3.6-flash', apiVersion: 'v1', location: 'global',
  bindingVersion: b.bindingVersion, serviceId: b.serviceId, serviceIdentity: b.serviceIdentity,
  sourcePolicyVersion: b.sourcePolicy.version, exposurePolicyVersion: b.exposurePolicy.version, expiresAt: b.expiresAt,
  projectId: 'invented-reference-proj', quotaProjectId: 'invented-reference-quota', identityRef: 'identities/invented-cloud-reference',
  ...override,
});
export function prepared(raw: unknown = cloudBinding()) {
  const result = createCloudReferencePreparation(raw);
  if (!result.ok) throw new Error(result.problems.join(','));
  return result.preparation;
}
export const cloudToken = (b: Pick<CloudReferenceBinding, 'identityRef' | 'projectId' | 'quotaProjectId'>): CloudReferenceToken =>
  ({ identityRef: b.identityRef, projectId: b.projectId, quotaProjectId: b.quotaProjectId, token: new ServerSecret(CLOUD_TOKEN) });
export const cloudEnvelope = (output: unknown = CLOUD_OUTPUT, extra: Record<string, unknown> = {}) => ({
  candidates: [{ index: 0, content: { role: 'model', parts: [
    { text: 'invented hidden reasoning', thought: true, thoughtSignature: 'invented-hidden-signature' },
    { text: typeof output === 'string' ? output : JSON.stringify(output) },
  ] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 17, thoughtsTokenCount: 3, totalTokenCount: 20,
    promptTokensDetails: [{ modality: 'VIDEO', tokenCount: 0 }] },
  ...extra,
});
export const cloudResponse = () => json(200, cloudEnvelope());
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
