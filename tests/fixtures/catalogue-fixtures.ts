import type { HttpTransport, ProviderRequest, ProviderResponse } from '../../src/server/providers/http.js';
import type { DnsResolver, PinnedHttpClient, PinnedRequest } from '../../src/server/net/safe-fetch.js';

// Invented catalogue envelopes and network seams for tests. All titles, artists,
// video IDs and sources are invented; nothing here is a real recording or result.

export interface FixtureChoice {
  readonly title: string;
  readonly artists: readonly string[];
  readonly anchor: string;
  readonly videoId: string;
  readonly why?: string;
  /** Grounding chunk index for this block's support segment; null = unsupported. */
  readonly chunk?: number | null;
  /**
   * Which claim the support segment covers (default 'identity': the Title and
   * Artists lines together). 'fit' = only the Why line, 'anchor' = only the
   * Anchor line, 'title'/'artists' = only that line.
   */
  readonly support?: 'identity' | 'title' | 'artists' | 'anchor' | 'fit';
  /** Override the Listen line verbatim. */
  readonly listen?: string;
  /** Override the Artists value without changing the legacy default or its grounding byte ranges. */
  readonly artistsLine?: string;
}

export interface EnvelopeOptions {
  readonly rendered?: string | null;
  readonly chunks?: readonly unknown[];
  readonly finishReason?: string | null;
  readonly none?: boolean;
  readonly extraSupports?: readonly unknown[];
  readonly queries?: readonly string[];
}

export const REDIRECT = (n: number) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/invented-source-${n}`;
export const RENDERED = '<style>.c{color:#fff}</style><div class="c"><a class="chip" href="https://www.google.com/search?q=invented+query&amp;x=1">invented query</a></div>';

/** Builds the answer text and grounding exactly as the native format specifies. */
export function buildAnswer(choices: readonly FixtureChoice[], opts: EnvelopeOptions = {}) {
  let text = '';
  const supports: unknown[] = [];
  if (opts.none) text = 'NO SUPPORTED CHOICE\nReason: Invented fixture found nothing confirmable.';
  choices.forEach((c, i) => {
    if (i > 0) text += '\n\n';
    text += `CHOICE ${i + 1}\n`;
    const lines = {
      title: `Title: ${c.title}`,
      artists: `Artists: ${c.artistsLine ?? c.artists.join('; ')}`,
      anchor: `Anchor: ${c.anchor}`,
      listen: `Listen: ${c.listen ?? `https://www.youtube.com/watch?v=${c.videoId}`}`,
      fit: `Why it may fit: ${c.why ?? 'It may keep the loose groove you chose.'}`,
    };
    const at: Record<string, { start: number; end: number }> = {};
    for (const [k, line] of Object.entries(lines)) {
      if (k !== 'title') text += '\n';
      const start = Buffer.byteLength(text);
      text += line;
      at[k] = { start, end: Buffer.byteLength(text) };
    }
    const chunk = c.chunk === undefined ? i : c.chunk;
    const kind = c.support ?? 'identity';
    const range = kind === 'identity' ? { start: at.title!.start, end: at.artists!.end } : at[kind]!;
    if (chunk !== null) {
      supports.push({
        segment: { startIndex: range.start, endIndex: range.end, text: Buffer.from(text).subarray(range.start, range.end).toString() },
        groundingChunkIndices: [chunk],
      });
    }
  });
  const chunkCount = Math.max(choices.length, 1);
  const grounding = {
    webSearchQueries: opts.queries ?? ['invented query'],
    ...(opts.rendered === null ? {} : { searchEntryPoint: { renderedContent: opts.rendered ?? RENDERED } }),
    groundingChunks: opts.chunks ?? Array.from({ length: chunkCount }, (_, i) => ({ web: { uri: REDIRECT(i + 1), title: `Invented source ${i + 1}`, domain: `source${i + 1}.invalid` } })),
    groundingSupports: [...supports, ...(opts.extraSupports ?? [])],
  };
  return { text, grounding };
}

export function sseBody(events: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
}

export function envelope(choices: readonly FixtureChoice[], opts: EnvelopeOptions = {}): ProviderResponse {
  const { text, grounding } = buildAnswer(choices, opts);
  const half = Math.floor(text.length / 2);
  const finish = opts.finishReason === undefined ? 'STOP' : opts.finishReason;
  return {
    status: 200,
    contentType: 'text/event-stream',
    body: sseBody([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'invented hidden reasoning', thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: text.slice(0, half) }] } }] },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: text.slice(half) }] }, ...(finish ? { finishReason: finish } : {}), groundingMetadata: grounding }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
      },
    ]),
  };
}

export function catalogueTransport(respond: (req: ProviderRequest) => ProviderResponse | Promise<ProviderResponse>) {
  const calls: ProviderRequest[] = [];
  const transport: HttpTransport = async (req) => {
    req.observer?.transportStarted();
    calls.push(req);
    return respond(req);
  };
  return { transport, calls };
}

export type MetaEntry = { title: string; author_name: string } | { status: number } | { redirect: string };

/**
 * Invented Apple lookup answers keyed by track ID. A song entry builds one
 * lookup result for that exact track (overridable field by field); `status`,
 * `raw` and `results` produce error, arbitrary-body and arbitrary-result answers.
 */
export type AppleEntry =
  | {
      trackName: string;
      artistName: string;
      storefront?: string;
      trackId?: unknown;
      wrapperType?: unknown;
      kind?: unknown;
      isStreamable?: unknown;
      trackViewUrl?: unknown;
    }
  | { status: number }
  | { raw: string | Uint8Array }
  | { results: unknown[]; resultCount?: number }
  | { redirect: string };

/** Invented Apple catalogue track IDs (decimal, no leading zero). */
export const AID = (n: number) => String(9_100_000_000 + n);

export function appleResult(id: string, e: Extract<AppleEntry, { trackName: string }>, requestedStorefront: string) {
  const storefront = e.storefront ?? requestedStorefront;
  // An explicitly given field (even null) overrides the default.
  const pick = <K extends keyof typeof e>(k: K, fallback: unknown) => (k in e ? e[k] : fallback);
  return {
    wrapperType: pick('wrapperType', 'track'),
    kind: pick('kind', 'song'),
    trackId: pick('trackId', Number(id)),
    trackName: e.trackName,
    artistName: e.artistName,
    collectionName: 'Invented Collection',
    trackViewUrl: pick('trackViewUrl', `https://music.apple.com/${storefront}/album/invented-collection/9000000001?i=${id}&uo=4`),
    // Present in real lookups; must never be fetched.
    previewUrl: 'https://audio-ssl.itunes.apple.com/invented/preview.m4a',
    artworkUrl100: 'https://is1-ssl.mzstatic.com/invented/100x100bb.jpg',
    isStreamable: pick('isStreamable', true),
    country: 'USA',
  };
}

/** In-process DNS and pinned HTTP: records every pinned request; never touches the network. */
export function fakeNetwork(meta: Record<string, MetaEntry>, dns: Record<string, readonly string[]> = {}, apple: Record<string, AppleEntry> = {}) {
  const requests: PinnedRequest[] = [];
  const metadataRequests: PinnedRequest[] = [];
  const resolve: DnsResolver = async (host) => dns[host] ?? ['142.250.1.1'];
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  const http: PinnedHttpClient = async (req) => {
    requests.push(req);
    if (req.method === 'HEAD') return {
      status: req.url.hostname === 'vertexaisearch.cloud.google.com' ? 302 : 200,
      location: req.url.hostname === 'vertexaisearch.cloud.google.com' ? `https://source.fixture.invalid${req.url.pathname}` : null,
      body: new Uint8Array(),
    };
    metadataRequests.push(req);
    if (req.url.hostname === 'itunes.apple.com') {
      const id = req.url.searchParams.get('id') ?? '';
      const e = apple[id];
      if (!e) return { status: 200, location: null, body: encode({ resultCount: 0, results: [] }) };
      if ('redirect' in e) return { status: 302, location: e.redirect, body: new Uint8Array() };
      if ('status' in e) return { status: e.status, location: null, body: new Uint8Array() };
      if ('raw' in e) return { status: 200, location: null, body: typeof e.raw === 'string' ? new TextEncoder().encode(e.raw) : e.raw };
      if ('results' in e) return { status: 200, location: null, body: encode({ resultCount: e.resultCount ?? e.results.length, results: e.results }) };
      return { status: 200, location: null, body: encode({ resultCount: 1, results: [appleResult(id, e, req.url.searchParams.get('country') ?? 'us')] }) };
    }
    const id = /v=([A-Za-z0-9_-]{11})/.exec(req.url.searchParams.get('url') ?? '')?.[1] ?? req.url.pathname;
    const m = meta[id];
    if (!m) return { status: 404, location: null, body: new Uint8Array() };
    if ('redirect' in m) return { status: 302, location: m.redirect, body: new Uint8Array() };
    if ('status' in m) return { status: m.status, location: null, body: new Uint8Array() };
    return { status: 200, location: null, body: new TextEncoder().encode(JSON.stringify({ ...m, type: 'video' })) };
  };
  return { resolve, http, requests, metadataRequests };
}

/** Invented 11-character video IDs. */
export const VID = (n: number) => `invVid${String(n).padStart(5, '0')}`;
