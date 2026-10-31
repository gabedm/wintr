import type { ProviderUsage } from '../../shared/records.js';
import { MAX_FINAL_TEXT_BYTES } from '../reference.js';
import { ProviderError } from './http.js';

// Strict, endpoint-neutral parsing of a non-streaming generateContent response,
// shared by the Developer API and the inactive Cloud reference adapters. It holds
// no endpoint, credential or retention claim.

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (kind: 'schema' | 'incomplete' | 'refused') => new ProviderError('gemini', kind, true);
const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);
export const JSON_CONTENT = /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i;

function safety(raw: unknown): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > 16) throw fail('schema');
  for (const rating of raw) {
    if (!isRecord(rating) || (rating.blocked !== undefined && typeof rating.blocked !== 'boolean')) throw fail('schema');
    if (rating.blocked === true) throw fail('refused');
  }
}

/** Exactly one completed text candidate. Thought text/signatures never enter the product or private final text. */
export function extractGenerateContentText(response: unknown): string {
  if (!isRecord(response)) throw fail('schema');
  if (response.error !== undefined) throw fail('incomplete');
  if (response.promptFeedback !== undefined) {
    if (!isRecord(response.promptFeedback)) throw fail('schema');
    if (response.promptFeedback.blockReason !== undefined) {
      if (typeof response.promptFeedback.blockReason !== 'string' || !response.promptFeedback.blockReason) throw fail('schema');
      throw fail('refused');
    }
    safety(response.promptFeedback.safetyRatings);
  }
  if (!Array.isArray(response.candidates) || response.candidates.length !== 1 || !isRecord(response.candidates[0])) throw fail('schema');
  const candidate = response.candidates[0];
  if (candidate.index !== undefined && candidate.index !== 0) throw fail('schema');
  safety(candidate.safetyRatings);
  if (typeof candidate.finishReason === 'string' && REFUSALS.has(candidate.finishReason)) throw fail('refused');
  if (candidate.finishReason !== 'STOP' || (candidate.continuationToken !== undefined && candidate.continuationToken !== '')) throw fail('incomplete');
  if (!isRecord(candidate.content) || candidate.content.role !== 'model' || !Array.isArray(candidate.content.parts) ||
    candidate.content.parts.length === 0 || candidate.content.parts.length > 64) throw fail('schema');
  let text = '';
  for (const part of candidate.content.parts) {
    if (!isRecord(part) || Object.keys(part).some(key => !['text', 'thought', 'thoughtSignature'].includes(key)) ||
      (part.thought !== undefined && typeof part.thought !== 'boolean') ||
      (part.thoughtSignature !== undefined && typeof part.thoughtSignature !== 'string') || typeof part.text !== 'string') throw fail('schema');
    if (part.thought === true) continue;
    text += part.text;
    if (Buffer.byteLength(text) > MAX_FINAL_TEXT_BYTES) throw fail('schema');
  }
  if (text.trim() === '') throw fail('incomplete');
  return text;
}

const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Keeps only known numeric usageMetadata fields; unknown or malformed fields become null. Not a billing settlement. */
export function parseGenerateContentUsage(raw: unknown): ProviderUsage | null {
  if (!isRecord(raw)) return null;
  const details = Array.isArray(raw.promptTokensDetails) ? raw.promptTokensDetails.slice(0, 8) : [];
  return {
    totalInputTokens: count(raw.promptTokenCount), totalOutputTokens: count(raw.candidatesTokenCount),
    totalThoughtTokens: count(raw.thoughtsTokenCount), totalCachedTokens: count(raw.cachedContentTokenCount),
    totalToolUseTokens: count(raw.toolUsePromptTokenCount), totalTokens: count(raw.totalTokenCount),
    inputTokensByModality: details.flatMap(detail => isRecord(detail) && typeof detail.modality === 'string' && detail.modality.length <= 32 && count(detail.tokenCount) !== null
      ? [{ modality: detail.modality, tokens: count(detail.tokenCount)! }] : []),
  };
}
