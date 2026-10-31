import type { PrivateReferenceResult } from '../../shared/records.js';
import { isRecordedReference } from '../../shared/records.js';
import { captureCloudReferencePreparation, CLOUD_REFERENCE_PROFILE, type CloudReferenceBinding } from '../cloud-reference-profile.js';
import { MAX_FINAL_TEXT_BYTES, type ReferenceAdapter, type ReferenceExecutionContext, type ReferenceInput } from '../reference.js';
import { CLOUD_AUDIO_OBSERVATION_PROFILE, CLOUD_REFERENCE_OBSERVATION_PROFILE } from '../ledger/observation.js';
import { withinCatalogueDeadline as withinReferenceDeadline } from './catalogue-deadline.js';
import { assertReferenceInput, buildReferencePrompt, parseReferenceOutput, referenceMediaPart } from './gemini-reference.js';
import { extractGenerateContentText, isRecord as record, JSON_CONTENT, parseGenerateContentUsage } from './generate-content.js';
import { classifyStatus, decodeJson, ProviderError, sendOnce, type Endpoint, type HttpTransport } from './http.js';
import { ServerSecret } from './secret.js';
import type { CallObserver } from './observation.js';

// INACTIVE future-profile preparation, not an Interactions fallback or a 429 fix.
// Native YouTube fileData only: no media fetch, upload, clipping, tools or agentic
// processing. Cloud retention/Pre-GA/source/access/lifetime acceptance is unearned.

export interface CloudReferenceTokenRequest {
  readonly identityRef: string;
  readonly projectId: string;
  readonly quotaProjectId: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}
export interface CloudReferenceToken {
  readonly identityRef: string;
  readonly projectId: string;
  readonly quotaProjectId: string;
  readonly token: ServerSecret;
}
/** Explicit controller loader only. No ADC, token refresh, environment lookup or retry is supplied here. */
export type CloudReferenceTokenLoader = (request: CloudReferenceTokenRequest) => Promise<CloudReferenceToken>;
export interface GeminiCloudReferenceConfig {
  readonly preparation: unknown;
  readonly binding: unknown;
  readonly accessToken: CloudReferenceTokenLoader;
  readonly transport: HttpTransport;
  readonly clock?: () => number;
}

export function cloudReferenceEndpoint(binding: CloudReferenceBinding): Endpoint {
  return Object.freeze({ origin: CLOUD_REFERENCE_PROFILE.origin,
    path: `/v1/projects/${binding.projectId}/locations/global/publishers/google/models/gemini-3.6-flash:generateContent` });
}

export function buildCloudReferenceRequestBody(input: ReferenceInput): string {
  assertReferenceInput(input);
  return JSON.stringify({
    contents: [{ role: 'user', parts: [
      referenceMediaPart(input),
      { text: buildReferencePrompt(input) },
    ] }],
    generationConfig: {
      maxOutputTokens: CLOUD_REFERENCE_PROFILE.maxOutputTokens,
      thinkingConfig: { thinkingLevel: CLOUD_REFERENCE_PROFILE.thinkingLevel },
    },
  });
}

export const extractCloudReferenceText = extractGenerateContentText;
export const parseCloudReferenceUsage = parseGenerateContentUsage;

/** Read a closed loader receipt without invoking getters or reflecting any credential/error content. */
function tokenValue(raw: unknown, binding: CloudReferenceBinding): string {
  try {
    if (!record(raw) || Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).sort().join(',') !== 'identityRef,projectId,quotaProjectId,token') throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const fields: Record<string, unknown> = {};
    for (const key of ['identityRef', 'projectId', 'quotaProjectId', 'token']) {
      const d = descriptors[key];
      if (!d || !Object.hasOwn(d, 'value')) throw new Error();
      fields[key] = d.value;
    }
    if (fields.identityRef !== binding.identityRef || fields.projectId !== binding.projectId || fields.quotaProjectId !== binding.quotaProjectId ||
      !(fields.token instanceof ServerSecret)) throw new Error();
    // The original method checks the private field, rejecting a prototype spoof or overridden reveal method.
    return ServerSecret.prototype.reveal.call(fields.token);
  } catch { throw new ProviderError('gemini', 'auth', false); }
}

export function createGeminiCloudReferenceAdapter(cfg: GeminiCloudReferenceConfig): ReferenceAdapter {
  const clock = cfg.clock ?? Date.now;
  const prepared = captureCloudReferencePreparation(cfg.preparation, cfg.binding, clock());
  if (!prepared.ok || typeof cfg.accessToken !== 'function' || typeof cfg.transport !== 'function') throw new ProviderError('gemini', 'config', false);
  const binding = prepared.binding, preparation = cfg.preparation;
  const accessToken = cfg.accessToken, transport = cfg.transport;
  const endpoint = cloudReferenceEndpoint(binding);
  const current = () => {
    if (!captureCloudReferencePreparation(preparation, binding, clock()).ok) throw new ProviderError('gemini', 'config', false);
  };
  return Object.freeze({
    synthetic: false,
    observationProfile: CLOUD_REFERENCE_OBSERVATION_PROFILE,
    observationProfileFor: (input: ReferenceInput) => isRecordedReference(input.reference) ? CLOUD_AUDIO_OBSERVATION_PROFILE : CLOUD_REFERENCE_OBSERVATION_PROFILE,
    async analyse(input: ReferenceInput, outerSignal: AbortSignal, observer?: CallObserver, execution?: ReferenceExecutionContext) {
      observer?.adapterEntered();
      current();
      if (!execution || !Number.isSafeInteger(execution.deadlineAt)) throw new ProviderError('gemini', 'config', false);
      // Capture the approved canonical URI and prompt before credential waiting; mutable caller data cannot change the send.
      const body = buildCloudReferenceRequestBody(input);
      const start = clock();
      if (!Number.isSafeInteger(start) || start < 0) throw new ProviderError('gemini', 'config', false);
      const deadlineAt = Math.min(execution.deadlineAt, start + CLOUD_REFERENCE_PROFILE.timeoutMs, binding.expiresAt);
      let dispatched = false;
      return withinReferenceDeadline({ signal: outerSignal, deadlineAt, now: clock }, async ({ signal, check }) => {
        check(); current();
        let token: string;
        try {
          token = tokenValue(await accessToken(Object.freeze({ identityRef: binding.identityRef, projectId: binding.projectId,
            quotaProjectId: binding.quotaProjectId, signal, deadlineAt })), binding);
        } catch { throw new ProviderError('gemini', 'auth', false); }
        check(); current();
        const headers = Object.freeze({ 'content-type': 'application/json', accept: 'application/json',
          authorization: `Bearer ${token}`, 'x-goog-user-project': binding.quotaProjectId });
        const send = () => sendOnce({
          provider: 'gemini', endpoint, url: new URL(endpoint.path, endpoint.origin), method: 'POST', headers, body,
          signal, timeoutMs: check(), maxResponseBytes: MAX_FINAL_TEXT_BYTES, observer,
          transport: request => {
            check(); current();
            if (request.method !== 'POST' || request.url.origin !== endpoint.origin || request.url.pathname !== endpoint.path ||
              request.url.search !== '' || request.url.hash !== '' || request.body !== body ||
              Object.keys(request.headers).sort().join(',') !== Object.keys(headers).sort().join(',') ||
              Object.keys(headers).some(key => request.headers[key] !== headers[key as keyof typeof headers])) {
              observer?.transportNotInvoked(); throw new ProviderError('gemini', 'config', false);
            }
            dispatched = true;
            return transport(request);
          },
          onResponse: response => {
            if (!observer) return;
            try {
              const decoded = decodeJson('gemini', response.body);
              observer.usage(record(decoded) ? decoded.usageMetadata : undefined, 'cloud_reference');
              observer.searchQueries(undefined);
              observer.usageDecoded();
            } catch { /* Accounting decode never supplies output or a fabricated zero. */ }
          },
        });
        const res = await (execution.dispatch ? execution.dispatch(send) : send());
        check(); current();
        if (res.status < 200 || res.status > 299) throw new ProviderError('gemini', classifyStatus(res.status), true, res.status);
        if (!res.contentType || !JSON_CONTENT.test(res.contentType)) throw new ProviderError('gemini', 'malformed', true);
        const response = decodeJson('gemini', res.body);
        const finalText = extractGenerateContentText(response);
        const output = parseReferenceOutput(finalText);
        check(); current();
        const provider: PrivateReferenceResult = { model: binding.model, finalText,
          usage: parseGenerateContentUsage(record(response) ? response.usageMetadata : null), uncertainArtistName: output.artistName };
        return { audioAccess: output.audioAccess, observations: output.observations, relationships: output.relationships, provider };
      }, () => dispatched);
    },
  });
}
