import { refuseDuplicateKeys } from './json-keys.js';
import { LIMITS } from '../../shared/records.js';
import { validateProviderSourceUrl } from '../destinations.js';
import { classifyStatus, ProviderError, sendOnce, type Endpoint, type HttpTransport } from './http.js';
import type { ServerSecret } from './secret.js';
import { withinCatalogueDeadline, type CatalogueDeadline } from './catalogue-deadline.js';
import type { CallObserver } from './observation.js';

// Native catalogue adapter for the fixed H07 catalogue profile: Google Cloud
// Vertex AI, global location, v1beta1, gemini-3.6-flash, streamGenerateContent
// (SSE), LOW thinking, 4096 output tokens and native Google Search.
// - One credential mode only: a short-lived OAuth bearer token from an injected
//   server-only provider plus an explicit quota project. No API key, no SDK, no
//   Interactions fallback, no retry, no repair generation.
// - The SSE body is bounded (512 KiB) and assembled into complete final text
//   (thought parts excluded) plus grounding metadata; a complete STOP finish is
//   required. Actual compatibility is a separate controller verification gate.

export const GEMINI_CATALOGUE_PROFILE = {
  origin: 'https://aiplatform.googleapis.com',
  apiVersion: 'v1beta1',
  location: 'global',
  model: 'gemini-3.6-flash',
  maxOutputTokens: 4096,
  thinkingLevel: 'LOW',
  maxResponseBytes: LIMITS.catalogueTextBytes,
  maxTimeoutMs: LIMITS.providerRequestMs,
} as const;

export const CATALOGUE_GROUNDING_LIMITS = {
  queries: 10,
  queryChars: 200,
  chunks: 32,
  chunkTitleChars: 200,
  supports: 64,
  renderedContentBytes: 64 * 1024,
} as const;

/** Google Cloud project IDs: 6-30 chars, lower-case letters, digits and hyphens. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export interface GeminiCatalogueConfig {
  readonly transport: HttpTransport;
  readonly project: string;
  readonly quotaProject: string;
  /** Server-only short-lived OAuth access token provider (workload identity in a later binding). */
  readonly accessToken: () => Promise<ServerSecret>;
}

export interface GroundingChunk {
  readonly uri: string;
  readonly title: string;
  readonly domain: string | null;
}

export interface ParsedGrounding {
  readonly queries: readonly string[];
  readonly renderedContent: string | null;
  /** Index-preserving: an invalid/unsupported chunk is null so support indices keep their meaning. */
  readonly chunks: readonly (GroundingChunk | null)[];
  readonly supports: readonly { readonly startByte: number; readonly endByte: number; readonly chunks: readonly number[] }[];
  readonly invalidChunks: number;
  readonly invalidSupports: number;
}

export interface CatalogueGeneration {
  readonly text: string;
  readonly grounding: ParsedGrounding;
  readonly usage: Readonly<Record<string, number>> | null;
}

export interface CatalogueAdapter {
  readonly synthetic: boolean;
  generate(prompt: string, options: CatalogueDeadline & { readonly observer?: CallObserver }): Promise<CatalogueGeneration>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (kind: 'malformed' | 'schema' | 'incomplete' | 'refused') => new ProviderError('gemini', kind, true);

export function catalogueEndpoint(project: string): Endpoint {
  const p = GEMINI_CATALOGUE_PROFILE;
  return {
    origin: p.origin,
    path: `/${p.apiVersion}/projects/${project}/locations/${p.location}/publishers/google/models/${p.model}:streamGenerateContent`,
  };
}

export function buildCatalogueRequestBody(prompt: string): string {
  return JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      maxOutputTokens: GEMINI_CATALOGUE_PROFILE.maxOutputTokens,
      thinkingConfig: { thinkingLevel: GEMINI_CATALOGUE_PROFILE.thinkingLevel },
    },
  });
}

const REFUSAL_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

/** Parses a bounded SSE body into ordered JSON events. */
export function parseSseEvents(body: Uint8Array, visit?: (event: unknown) => void): unknown[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw fail('malformed');
  }
  const events: unknown[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length === 0) return;
    const payload = data.join('\n').trim();
    data = [];
    if (payload === '' || payload === '[DONE]') return;
    try {
      const event: unknown = JSON.parse(payload);
      refuseDuplicateKeys(payload, () => fail('malformed'));
      visit?.(event);
      events.push(event);
    } catch {
      throw fail('malformed');
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === '') flush();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) continue;
    else throw fail('malformed');
  }
  flush();
  return events;
}

export function parseGrounding(raw: unknown, text: string): ParsedGrounding {
  const encoded = Buffer.from(text);
  const boundary = (at: number) => at === encoded.length || (encoded[at]! & 0xc0) !== 0x80;
  if (raw !== undefined && !isRecord(raw)) throw fail('schema');
  const g = isRecord(raw) ? raw : {};
  const L = CATALOGUE_GROUNDING_LIMITS;
  // A malformed native field is not an absent field: treating it as empty can erase all attribution.
  for (const key of ['webSearchQueries', 'groundingChunks', 'groundingSupports']) {
    if (g[key] !== undefined && !Array.isArray(g[key])) throw fail('schema');
  }
  if (g.searchEntryPoint !== undefined && !isRecord(g.searchEntryPoint)) throw fail('schema');
  const queries = g.webSearchQueries === undefined ? [] : g.webSearchQueries as unknown[];
  if (queries.length > L.queries || queries.some(q => typeof q !== 'string' || q.length > L.queryChars)) throw fail('schema');
  const entry = isRecord(g.searchEntryPoint) ? g.searchEntryPoint.renderedContent : undefined;
  const renderedContent = typeof entry === 'string' && entry.trim() !== '' && Buffer.byteLength(entry) <= L.renderedContentBytes ? entry : null;
  const rawChunks = Array.isArray(g.groundingChunks) ? g.groundingChunks : [];
  if (rawChunks.length > L.chunks) throw fail('schema');
  let invalidChunks = 0;
  const chunks = rawChunks.map((c): GroundingChunk | null => {
    const web = isRecord(c) && isRecord(c.web) ? c.web : null;
    const uri = web ? validateProviderSourceUrl(web.uri) : null;
    const title = web && typeof web.title === 'string' ? web.title.replace(/\s+/g, ' ').trim() : '';
    if (!uri || title === '' || title.length > L.chunkTitleChars) {
      invalidChunks += 1;
      return null;
    }
    const domain = typeof web!.domain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(web!.domain) ? web!.domain.toLowerCase() : null;
    return { uri, title, domain };
  });
  const rawSupports = Array.isArray(g.groundingSupports) ? g.groundingSupports : [];
  if (rawSupports.length > L.supports) throw fail('schema');
  let invalidSupports = 0;
  const supports = rawSupports.flatMap((s) => {
    const seg = isRecord(s) && isRecord(s.segment) ? s.segment : null;
    const start = seg?.startIndex === undefined ? 0 : seg.startIndex;
    const end = seg?.endIndex;
    const idx = isRecord(s) && Array.isArray(s.groundingChunkIndices) ? s.groundingChunkIndices : null;
    const valid =
      seg &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      (start as number) >= 0 &&
      (end as number) > (start as number) &&
      (end as number) <= encoded.length &&
      boundary(start as number) && boundary(end as number) &&
      (seg.partIndex === undefined || seg.partIndex === 0) &&
      (seg.text === undefined || (typeof seg.text === 'string' && seg.text === encoded.subarray(start as number, end as number).toString('utf8'))) &&
      idx &&
      idx.length > 0 &&
      idx.every((i) => Number.isSafeInteger(i) && i >= 0 && i < chunks.length && chunks[i] !== null);
    if (!valid) {
      invalidSupports += 1;
      return [];
    }
    return [{ startByte: start as number, endByte: end as number, chunks: [...new Set(idx as number[])] }];
  });
  return { queries: queries as string[], renderedContent, chunks, supports, invalidChunks, invalidSupports };
}

/**
 * Accept only a complete final attribution snapshot: repeated metadata may be identical or cumulative,
 * but must retain every earlier support, its indexed source and the native Suggestions unit. No guessed
 * delta merge may silently discard or reassign a citation. Actual provider compatibility remains separate.
 */
function retainsGrounding(previous: ParsedGrounding, final: ParsedGrounding): boolean {
  const supportKey = (s: ParsedGrounding['supports'][number]) => JSON.stringify([s.startByte, s.endByte, [...s.chunks].sort((a, b) => a - b)]);
  const supports = new Set(final.supports.map(supportKey));
  return previous.invalidSupports === 0 &&
    previous.supports.every(s => supports.has(supportKey(s)) && s.chunks.every(i => JSON.stringify(previous.chunks[i]) === JSON.stringify(final.chunks[i]))) &&
    (!previous.renderedContent || previous.renderedContent === final.renderedContent) &&
    previous.queries.every(q => final.queries.includes(q));
}

/** Assembles the supported single-text-part stream, complete grounding and a required STOP finish. */
export function assembleStream(events: readonly unknown[]): CatalogueGeneration {
  if (events.length === 0) throw fail('malformed');
  let text = '';
  let finish: string | null = null;
  const metadata: unknown[] = [];
  let usage: Readonly<Record<string, number>> | null = null;
  const safety = (container: Record<string, unknown>) => {
    if (!Object.hasOwn(container, 'safetyRatings')) return;
    const ratings = container.safetyRatings;
    if (!Array.isArray(ratings) || ratings.length > 32) throw fail('schema');
    for (const rating of ratings) {
      if (!isRecord(rating) || (Object.hasOwn(rating, 'blocked') && typeof rating.blocked !== 'boolean')) throw fail('schema');
      if (rating.blocked === true) throw fail('refused');
    }
  };
  for (const e of events) {
    if (!isRecord(e)) throw fail('malformed');
    if (e.error !== undefined) throw fail('incomplete');
    if (Object.hasOwn(e, 'continuationToken') && e.continuationToken !== '') throw fail('incomplete');
    if (Object.hasOwn(e, 'promptFeedback')) {
      if (!isRecord(e.promptFeedback)) throw fail('schema');
      safety(e.promptFeedback);
      if (Object.hasOwn(e.promptFeedback, 'blockReason')) {
        if (typeof e.promptFeedback.blockReason !== 'string') throw fail('schema');
        throw fail('refused');
      }
    }
    if (isRecord(e.usageMetadata)) {
      usage = Object.fromEntries(
        Object.entries(e.usageMetadata).filter(([, v]) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) as [string, number][],
      );
    }
    if (e.candidates === undefined) continue;
    if (!Array.isArray(e.candidates) || e.candidates.length !== 1 || !isRecord(e.candidates[0])) throw fail('schema');
    const c = e.candidates[0];
    safety(c);
    if (c.index !== undefined && c.index !== 0) throw fail('schema');
    if (c.content !== undefined && (!isRecord(c.content) || (c.content.role !== undefined && c.content.role !== 'model'))) throw fail('schema');
    const parts = isRecord(c.content) ? c.content.parts : undefined;
    if (parts !== undefined) {
      if (!Array.isArray(parts)) throw fail('schema');
      if (finish !== null && parts.some(p => isRecord(p) && p.thought !== true && typeof p.text === 'string' && p.text !== '')) throw fail('incomplete');
      // Segment offsets are part-local. Multiple visible Parts need a separately verified mapping;
      // flattening them would let a source for one recording support another. Thought parts do not count.
      if (parts.filter(p => isRecord(p) && p.thought !== true && typeof p.text === 'string').length > 1) throw fail('schema');
      for (const part of parts) {
        if (!isRecord(part) || Object.keys(part).some(key => !['text', 'thought', 'thoughtSignature'].includes(key))
          || (Object.hasOwn(part, 'text') && typeof part.text !== 'string')
          || (Object.hasOwn(part, 'thought') && typeof part.thought !== 'boolean')
          || (Object.hasOwn(part, 'thoughtSignature') && (typeof part.thoughtSignature !== 'string' || part.thoughtSignature.length > 16 * 1024))) throw fail('schema');
        if (part.thought === true) continue;
        if (typeof part.text === 'string') text += part.text;
        else if (part.thoughtSignature === undefined) throw fail('schema');
      }
    }
    if (c.groundingMetadata !== undefined) metadata.push(c.groundingMetadata);
    if (c.finishReason !== undefined && typeof c.finishReason !== 'string') throw fail('schema');
    if (typeof c.finishReason === 'string' && c.finishReason !== 'FINISH_REASON_UNSPECIFIED') {
      // Terminal outcomes are monotonic: a later STOP cannot undo a refusal or token-limit finish.
      if (REFUSAL_FINISH.has(c.finishReason)) throw fail('refused');
      if (c.finishReason !== 'STOP') throw fail('incomplete');
      finish = 'STOP';
    }
  }
  if (finish !== 'STOP') throw fail('incomplete');
  const bytes = Buffer.byteLength(text);
  if (text.trim() === '') throw fail('incomplete');
  if (bytes > LIMITS.catalogueTextBytes) throw fail('schema');
  const snapshots = metadata.map(raw => parseGrounding(raw, text));
  const grounding = snapshots.at(-1) ?? parseGrounding(undefined, text);
  const lost = snapshots.slice(0, -1).some(previous => !retainsGrounding(previous, grounding));
  return { text, grounding: lost ? { ...grounding, invalidSupports: grounding.invalidSupports + 1 } : grounding, usage };
}

export function createGeminiCatalogueAdapter(cfg: GeminiCatalogueConfig): CatalogueAdapter {
  if (!PROJECT_ID.test(cfg.project) || !PROJECT_ID.test(cfg.quotaProject)) throw new TypeError('Invalid Google Cloud project binding');
  const endpoint = catalogueEndpoint(cfg.project);
  return {
    synthetic: false,
    async generate(prompt, options) {
      options.observer?.adapterEntered();
      if (typeof prompt !== 'string' || prompt.trim() === '' || Buffer.byteLength(prompt) > LIMITS.catalogueHandoffBytes * 2) {
        throw new ProviderError('gemini', 'config', false);
      }
      // Never restart the allocation after admission or asynchronous credential preparation.
      const deadlineAt = Math.min(options.deadlineAt, options.now() + GEMINI_CATALOGUE_PROFILE.maxTimeoutMs);
      let dispatched = false;
      return withinCatalogueDeadline({ ...options, deadlineAt }, async ({ signal, check }) => {
        let token: ServerSecret;
        try {
          token = await cfg.accessToken();
        } catch {
          // Credential acquisition failed before any submission; nothing was sent.
          throw new ProviderError('gemini', 'auth', false);
        }
        check();
        const url = new URL(endpoint.path, endpoint.origin);
        url.search = 'alt=sse';
        const res = await sendOnce({
          provider: 'gemini',
          transport: (request) => {
            check();
            dispatched = true;
            return cfg.transport(request);
          },
          endpoint,
          method: 'POST',
          url,
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${token.reveal()}`,
            'x-goog-user-project': cfg.quotaProject,
          },
          body: buildCatalogueRequestBody(prompt),
          timeoutMs: check(),
          maxResponseBytes: GEMINI_CATALOGUE_PROFILE.maxResponseBytes,
          signal,
          observer: options.observer,
          onResponse: (response) => {
            const observer = options.observer;
            if (!observer) return;
            let decoded = false;
            try {
              // Scan every cumulative usage snapshot before candidate/finish/grounding validation.
              parseSseEvents(response.body, (event) => {
                decoded = true;
                if (isRecord(event) && Object.hasOwn(event, 'usageMetadata')) observer.usage(event.usageMetadata, 'catalogue');
                const candidates = isRecord(event) && Array.isArray(event.candidates) ? event.candidates : [];
                for (const c of candidates.slice(0, 1)) if (isRecord(c) && isRecord(c.groundingMetadata)) observer.searchQueries(c.groundingMetadata.webSearchQueries);
              });
              if (decoded) { observer.usage(undefined, 'catalogue'); observer.searchQueries(undefined); }
            } catch { /* Earlier decoded accounting survives a malformed later SSE event. */ }
            observer.usageDecoded();
          },
        });
        check();
        if (res.status < 200 || res.status > 299) throw new ProviderError('gemini', classifyStatus(res.status), true, res.status);
        const generation = assembleStream(parseSseEvents(res.body));
        check();
        return generation;
      }, () => dispatched);
    },
  };
}
