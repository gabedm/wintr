import { createGeminiCatalogueAdapter, type CatalogueAdapter } from './providers/gemini-catalogue.js';
import type { HttpTransport } from './providers/http.js';
import { ServerSecret } from './providers/secret.js';
import type { DnsResolver, PinnedHttpClient } from './net/safe-fetch.js';
import { createYouTubeVerifier, type DestinationVerifier } from './verifier.js';
import { createSourceResolver, type SourceResolver } from './source-resolver.js';

// Labelled local fixture for synthetic mode only. It answers the genuine
// catalogue adapter with an invented SSE envelope (invented titles, invented
// video IDs, invented grounding sources and a fake Suggestions unit) and answers
// the genuine verifier's oEmbed lookups in-process. No network, no credential.
// Panels built from it are marked synthetic; their Play links are never shown.

/** Never contacted: the synthetic pinned client below is in-process. */
const FIXTURE_ADDRESS = '9.9.9.9';

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 11);
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const inventedVideoId = (seed: string) => {
  let h = hash(seed);
  let id = '';
  for (let i = 0; i < 11; i += 1) {
    id += ID_CHARS[h % 64];
    h = Math.floor(h / 64) + hash(`${seed}${i}`);
  }
  return id;
};

export interface SyntheticCatalogue {
  readonly sources: SourceResolver;
  readonly adapter: CatalogueAdapter;
  readonly verifier: DestinationVerifier;
}

const sse = (events: unknown[]) => new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));

export function createSyntheticCatalogue(): SyntheticCatalogue {
  const metadata = new Map<string, { title: string; author_name: string }>();

  const transport: HttpTransport = async (req) => {
    if (req.signal.aborted) throw new Error('aborted');
    req.observer?.transportStarted();
    const body = JSON.parse(req.body ?? '{}') as { contents?: { parts?: { text?: string }[] }[] };
    const prompt = body.contents?.[0]?.parts?.[0]?.text ?? '';
    const block = /```json\n([\s\S]*?)\n```/.exec(prompt);
    const data = block ? (JSON.parse(block[1]!) as { allowed_artists?: string[]; already_shown_recordings?: { title: string }[] }) : {};
    const anchors = (data.allowed_artists ?? []).slice(0, 3);
    // Invented titles skip anything already shown, so a labelled synthetic refinement shows different invented tracks.
    const shown = new Set((data.already_shown_recordings ?? []).map((r) => r.title));
    const titles: string[] = [];
    for (let n = 0; titles.length < anchors.length && n < 26; n += 1) {
      const t = `Synthetic Track ${String.fromCharCode(65 + n)}`;
      if (!shown.has(t)) titles.push(t);
    }
    let text = '';
    const supports: unknown[] = [];
    anchors.forEach((anchor, i) => {
      const title = titles[i]!;
      const videoId = inventedVideoId(`${anchor}|${title}`);
      metadata.set(videoId, { title: `${anchor} - ${title}`, author_name: `${anchor} (synthetic fixture)` });
      if (i > 0) text += '\n\n';
      text += `CHOICE ${i + 1}\n`;
      // The fixture's single support segment covers the identity claims (Title and Artists lines).
      const start = Buffer.byteLength(text);
      text += `Title: ${title}\nArtists: ${anchor}`;
      const end = Buffer.byteLength(text);
      text += `\nAnchor: ${anchor}\nListen: https://www.youtube.com/watch?v=${videoId}\nWhy it may fit: Synthetic placeholder text, not a real suggestion.`;
      supports.push({ segment: { startIndex: start, endIndex: end }, groundingChunkIndices: [i] });
    });
    if (anchors.length === 0) text = 'NO SUPPORTED CHOICE\nReason: Synthetic fixture had no allowed artists.';
    const grounding = {
      webSearchQueries: ['synthetic fixture query'],
      searchEntryPoint: { renderedContent: '<div class="fixture"><span>Synthetic Search Suggestions (fixture, not from Google)</span></div>' },
      groundingChunks: anchors.map((_, i) => ({
        web: { uri: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/synthetic-fixture-${i + 1}`, title: `Synthetic source ${i + 1} (fixture)`, domain: 'fixture.invalid' },
      })),
      groundingSupports: supports,
    };
    return {
      status: 200,
      contentType: 'text/event-stream',
      body: sse([
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Synthetic thinking (excluded).', thought: true }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', groundingMetadata: grounding }], usageMetadata: { totalTokenCount: 1 } },
      ]),
    };
  };

  const resolve: DnsResolver = async () => [FIXTURE_ADDRESS];
  const http: PinnedHttpClient = async (req) => {
    if (req.method === 'HEAD') return {
      status: req.url.hostname === 'vertexaisearch.cloud.google.com' ? 302 : 200,
      location: req.url.hostname === 'vertexaisearch.cloud.google.com' ? `https://source.fixture.invalid${req.url.pathname}` : null,
      body: new Uint8Array(),
    };
    const videoUrl = req.url.searchParams.get('url') ?? '';
    const id = /v=([A-Za-z0-9_-]{11})/.exec(videoUrl)?.[1];
    const meta = id ? metadata.get(id) : undefined;
    return meta
      ? { status: 200, location: null, body: new TextEncoder().encode(JSON.stringify({ ...meta, type: 'video' })) }
      : { status: 404, location: null, body: new Uint8Array() };
  };

  const adapter = createGeminiCatalogueAdapter({
    transport,
    project: 'synthetic-fixture',
    quotaProject: 'synthetic-fixture',
    accessToken: async () => new ServerSecret('synthetic-fixture-not-a-token'),
  });
  return {
    sources: createSourceResolver({ resolve, http, now: Date.now }, true),
    adapter: { synthetic: true, generate: adapter.generate },
    verifier: createYouTubeVerifier({ resolve, http, now: Date.now }, true),
  };
}
