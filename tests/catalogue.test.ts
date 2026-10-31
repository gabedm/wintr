import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Handle } from '../src/shared/records.js';
import { generationBudget } from '../src/server/catalogue.js';
import { buildCitationUnit, identitySupport, parseCatalogueAnswer, sanitizeSuggestions, SUGGESTIONS_CSP } from '../src/server/catalogue-format.js';
import { canonicalListeningDestination, validateProviderSourceUrl } from '../src/server/destinations.js';
import { matchMetadata } from '../src/server/native-catalogue.js';
import { createMetadataBudget, ipv6Bytes, isPublicAddress, safeGet, SafeFetchError } from '../src/server/net/safe-fetch.js';
import {
  assembleStream,
  buildCatalogueRequestBody,
  createGeminiCatalogueAdapter,
  parseGrounding,
  parseSseEvents,
} from '../src/server/providers/gemini-catalogue.js';
import { ProviderError } from '../src/server/providers/http.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { createYouTubeVerifier, YOUTUBE_METADATA_POLICY } from '../src/server/verifier.js';
import { AnswerText, ChoicesPanel, safeHref } from '../src/client/discovery.js';
import { buildAnswer, catalogueTransport, envelope, fakeNetwork, REDIRECT, sseBody, VID } from './fixtures/catalogue-fixtures.js';

const generationOptions = (timeoutMs: number, signal = new AbortController().signal) => ({ signal, deadlineAt: Date.now() + timeoutMs, now: Date.now });

const TOKEN = 'invented-access-token-0001';
const token = async () => new ServerSecret(TOKEN);
const CHOICE = { title: 'Invented Song', artists: ['Neighbour X11'], anchor: 'Neighbour X11', videoId: VID(1) };

async function providerFailure(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected ProviderError');
}

afterEach(() => vi.useRealTimers());

describe('native catalogue adapter (fake transport only)', () => {
  const adapterWith = (respond: Parameters<typeof catalogueTransport>[0]) => {
    const t = catalogueTransport(respond);
    return { ...t, adapter: createGeminiCatalogueAdapter({ transport: t.transport, project: 'invented-project', quotaProject: 'invented-quota', accessToken: token }) };
  };

  it('sends the fixed global v1beta1 gemini-3.6-flash streaming profile once, with bearer + quota project only', async () => {
    const { adapter, calls } = adapterWith(() => envelope([CHOICE]));
    await adapter.generate('invented prompt', generationOptions(60_000));
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe('POST');
    expect(req.url.href).toBe(
      'https://aiplatform.googleapis.com/v1beta1/projects/invented-project/locations/global/publishers/google/models/gemini-3.6-flash:streamGenerateContent?alt=sse',
    );
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${TOKEN}`,
      'x-goog-user-project': 'invented-quota',
    });
    expect(req.maxResponseBytes).toBe(512 * 1024);
    const body = JSON.parse(req.body!);
    expect(Object.keys(body).sort()).toEqual(['contents', 'generationConfig', 'tools']);
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'invented prompt' }] }]);
    expect(req.body).not.toMatch(/processing|key=|interactions|thinkingBudget/i);
    expect(buildCatalogueRequestBody('x')).toBe(JSON.stringify(body).replace('invented prompt', 'x'));
  });

  it('assembles complete final text from streamed parts, excluding thought parts, with grounding', async () => {
    const { adapter } = adapterWith(() => envelope([CHOICE]));
    const g = await adapter.generate('p', generationOptions(60_000));
    expect(g.text).toBe(buildAnswer([CHOICE]).text);
    expect(g.text).not.toContain('hidden reasoning');
    expect(g.grounding.chunks).toHaveLength(1);
    expect(g.grounding.supports).toHaveLength(1);
    expect(g.grounding.renderedContent).toContain('invented query');
  });

  it.each(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'MAX_TOKENS'])('a later STOP cannot revive a %s terminal stream', finishReason => {
    const { text, grounding } = buildAnswer([CHOICE]);
    expect(() => assembleStream([
      { candidates: [{ content: { parts: [{ text }] }, groundingMetadata: grounding, finishReason }] },
      { candidates: [{ finishReason: 'STOP' }] },
    ])).toThrow(ProviderError);
  });

  it('rejects answer content after a terminal STOP instead of appending it', () => {
    const { text, grounding } = buildAnswer([CHOICE]);
    expect(() => assembleStream([
      { candidates: [{ content: { parts: [{ text: text.slice(0, 12) }] }, finishReason: 'STOP' }] },
      { candidates: [{ content: { parts: [{ text: text.slice(12) }] }, groundingMetadata: grounding, finishReason: 'STOP' }] },
    ])).toThrow(ProviderError);
  });

  it.each([1, -1, '0'])('rejects candidate index %s instead of splicing its text into the selected candidate', index => {
    const { text, grounding } = buildAnswer([CHOICE]);
    expect(() => assembleStream([
      { candidates: [{ index: 0, content: { parts: [{ text: text.slice(0, 12) }] } }] },
      { candidates: [{ index, content: { parts: [{ text: text.slice(12) }] }, groundingMetadata: grounding, finishReason: 'STOP' }] },
    ])).toThrow(ProviderError);
  });

  it.each([
    ['missing finish', envelope([CHOICE], { finishReason: null }), 'incomplete'],
    ['token limit', envelope([CHOICE], { finishReason: 'MAX_TOKENS' }), 'incomplete'],
    ['safety stop', envelope([CHOICE], { finishReason: 'SAFETY' }), 'refused'],
    ['blocked prompt', { status: 200, contentType: null, body: sseBody([{ promptFeedback: { blockReason: 'SAFETY' } }]) }, 'refused'],
    ['bad JSON line', { status: 200, contentType: null, body: new TextEncoder().encode('data: {"candidates":\n\n') }, 'malformed'],
    ['non-SSE garbage', { status: 200, contentType: null, body: new TextEncoder().encode('<html>oops</html>') }, 'malformed'],
    ['empty stream', { status: 200, contentType: null, body: new Uint8Array() }, 'malformed'],
    ['two candidates', { status: 200, contentType: null, body: sseBody([{ candidates: [{}, {}] }]) }, 'schema'],
    ['in-stream error', { status: 200, contentType: null, body: sseBody([{ error: { code: 500 } }]) }, 'incomplete'],
    ['oversize', { status: 200, contentType: null, body: new Uint8Array(512 * 1024 + 1) }, 'oversize'],
    ['forbidden', { status: 403, contentType: null, body: new Uint8Array() }, 'auth'],
    ['quota', { status: 429, contentType: null, body: new Uint8Array() }, 'quota'],
  ])('fails honestly on %s with one invocation', async (_label, response, kind) => {
    const { adapter, calls } = adapterWith(() => response as never);
    expect((await providerFailure(adapter.generate('p', generationOptions(60_000)))).kind).toBe(kind);
    expect(calls).toHaveLength(1);
  });

  it('enforces the generation budget and caller abort, and sends nothing without budget or credential', async () => {
    vi.useFakeTimers();
    const hung = adapterWith(() => new Promise(() => {}));
    const pending = providerFailure(hung.adapter.generate('p', generationOptions(30_000)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ kind: 'deadline', dispatched: true });
    expect(hung.calls[0]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const none = adapterWith(() => envelope([CHOICE]));
    expect(await providerFailure(none.adapter.generate('p', generationOptions(0)))).toMatchObject({ kind: 'deadline', dispatched: false });
    expect(await providerFailure(none.adapter.generate('p', generationOptions(1000, AbortSignal.abort())))).toMatchObject({ kind: 'aborted', dispatched: false });
    const noCred = createGeminiCatalogueAdapter({
      transport: none.transport,
      project: 'invented-project',
      quotaProject: 'invented-quota',
      accessToken: async () => {
        throw new Error('no credential bound');
      },
    });
    expect(await providerFailure(noCred.generate('p', generationOptions(1000)))).toMatchObject({ kind: 'auth', dispatched: false });
    expect(none.calls).toHaveLength(0);
  });

  it('rejects invalid project bindings at construction', () => {
    const t = catalogueTransport(() => envelope([CHOICE]));
    expect(() => createGeminiCatalogueAdapter({ transport: t.transport, project: 'Bad_Project', quotaProject: 'invented-quota', accessToken: token })).toThrow();
    expect(() => createGeminiCatalogueAdapter({ transport: t.transport, project: 'invented-project/../x', quotaProject: 'invented-quota', accessToken: token })).toThrow();
  });

  it('reserves the last 20 s for validation and caps generation at 90 s', () => {
    expect(generationBudget(200_000, 0)).toBe(90_000);
    expect(generationBudget(100_000, 0)).toBe(80_000);
    expect(generationBudget(20_000, 0)).toBe(0);
  });
});

describe('grounding parse and citation unit', () => {
  it.each([null, [], { groundingSupports: {} }, { groundingChunks: {} }, { webSearchQueries: 'q' }, { searchEntryPoint: [] }])('refuses a malformed native metadata shape instead of treating it as absent', raw => {
    expect(() => parseGrounding(raw, 'Invented answer')).toThrow(ProviderError);
  });

  it('rejects multiple visible text parts rather than letting part-local evidence verify the wrong recording', () => {
    const { text, grounding } = buildAnswer([CHOICE]);
    expect(() => assembleStream([{ candidates: [{ content: { parts: [{ text: 'Unrelated text' }, { text }] },
      groundingMetadata: grounding, finishReason: 'STOP' }] }])).toThrow(ProviderError);
  });

  it('accepts complete cumulative stream metadata without losing or duplicating earlier sources', () => {
    const choices = [CHOICE, { ...CHOICE, title: 'Invented Song Two', videoId: VID(2) }];
    const first = buildAnswer([CHOICE]), final = buildAnswer(choices);
    const result = assembleStream([
      { candidates: [{ content: { parts: [{ text: first.text }] }, groundingMetadata: first.grounding }] },
      { candidates: [{ content: { parts: [{ text: final.text.slice(first.text.length) }] }, groundingMetadata: final.grounding, finishReason: 'STOP' }] },
    ]);
    expect(result.text).toBe(final.text);
    expect(result.grounding.invalidSupports).toBe(0);
    expect(buildCitationUnit(result.text, result.grounding).citations.map(c => c.url)).toEqual([REDIRECT(1), REDIRECT(2)]);
  });

  it('keeps chunk indices stable, drops forged/unsupported sources and out-of-range supports', () => {
    const { text } = buildAnswer([CHOICE]);
    const bytes = Buffer.byteLength(text);
    const g = parseGrounding(
      {
        webSearchQueries: ['q'],
        searchEntryPoint: { renderedContent: '<div>x</div>' },
        groundingChunks: [
          { web: { uri: 'javascript:alert(1)', title: 'Forged' } },
          { web: { uri: 'https://evil.invalid/grounding-api-redirect/x', title: 'Wrong host' } },
          { web: { uri: 'http://vertexaisearch.cloud.google.com/grounding-api-redirect/x', title: 'Plain http' } },
          { web: { uri: REDIRECT(1), title: 'Valid', domain: 'source.invalid' } },
        ],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0] },
          { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [9] },
          { segment: { startIndex: 0, endIndex: bytes + 1 }, groundingChunkIndices: [3] },
          { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [3] },
        ],
      },
      text,
    );
    expect(g.chunks.map((c) => c?.title ?? null)).toEqual([null, null, null, 'Valid']);
    expect(g.invalidChunks).toBe(3);
    expect(g.supports).toEqual([{ startByte: 0, endByte: 5, chunks: [3] }]);
    expect(g.invalidSupports).toBe(3);
  });

  it('ties citations to the exact block they support and marks the complete answer without rewriting it', () => {
    const choices = [CHOICE, { title: 'Invented Song Two', artists: ['Neighbour Y21'], anchor: 'Neighbour Y21', videoId: VID(2) }];
    const { text, grounding } = buildAnswer(choices);
    const g = assembleStream(parseSseEvents(sseBody([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', groundingMetadata: grounding }] }])));
    const parsed = parseCatalogueAnswer(g.text);
    if (parsed.kind !== 'choices') throw new Error('expected choices');
    expect(identitySupport(parsed.blocks[0]!, g.grounding)).toEqual({ title: [0], artists: [0], any: [0] });
    expect(identitySupport(parsed.blocks[1]!, g.grounding)).toEqual({ title: [1], artists: [1], any: [1] });
    const unit = buildCitationUnit(g.text, g.grounding);
    expect(unit.citations.map((c) => c.title)).toEqual(['Invented source 1', 'Invented source 2']);
    const html = renderToStaticMarkup(createElement(AnswerText, { answer: { text: g.text, marks: unit.marks } }));
    expect(html.replace(/<sup>.*?<\/sup>/g, '').replace(/<\/?p[^>]*>/g, '')).toBe(g.text.replace(/&/g, '&amp;'));
    expect(html).toContain('<sup>[1]</sup>');
    expect(html).toContain('<sup>[2]</sup>');
  });

  it('maps byte offsets correctly for non-ASCII answer text', () => {
    const c = { ...CHOICE, title: 'Invénted Sóng ✓' };
    const { text, grounding } = buildAnswer([c]);
    const g = assembleStream(parseSseEvents(sseBody([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', groundingMetadata: grounding }] }])));
    const unit = buildCitationUnit(g.text, g.grounding);
    const artistsEnd = g.text.indexOf('\nAnchor:');
    expect(unit.marks).toEqual([{ end: artistsEnd, citations: [0] }]);
    const parsed = parseCatalogueAnswer(g.text);
    if (parsed.kind !== 'choices') throw new Error('expected choices');
    // Field ranges are UTF-8 byte offsets of the exact values.
    const r = parsed.blocks[0]!.ranges.title;
    expect(Buffer.from(g.text).subarray(r.start, r.end).toString()).toBe('Invénted Sóng ✓');
    expect(identitySupport(parsed.blocks[0]!, g.grounding).title).toEqual([0]);
  });

  it('counts support only for the claim its segment covers: fit, anchor, link or a name fragment is not identity support', () => {
    const support = (kind: 'identity' | 'title' | 'artists' | 'anchor' | 'fit', extra: unknown[] = []) => {
      const { text, grounding } = buildAnswer([{ ...CHOICE, support: kind }], { extraSupports: extra });
      const g = assembleStream(parseSseEvents(sseBody([{ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', groundingMetadata: grounding }] }])));
      const parsed = parseCatalogueAnswer(g.text);
      if (parsed.kind !== 'choices') throw new Error('expected choices');
      return { s: identitySupport(parsed.blocks[0]!, g.grounding), block: parsed.blocks[0]! };
    };
    expect(support('identity').s).toEqual({ title: [0], artists: [0], any: [0] });
    expect(support('fit').s).toEqual({ title: [], artists: [], any: [0] });
    expect(support('anchor').s).toEqual({ title: [], artists: [], any: [0] });
    expect(support('title').s).toEqual({ title: [0], artists: [], any: [0] });
    expect(support('artists').s).toEqual({ title: [], artists: [0], any: [0] });
    // A segment covering only part of the title value ("Invented") does not support the title claim.
    const { block } = support('fit');
    const partial = { segment: { startIndex: block.ranges.title.start, endIndex: block.ranges.title.start + 8 }, groundingChunkIndices: [0] };
    expect(support('fit', [partial]).s.title).toEqual([]);
  });
});

describe('strict answer parser', () => {
  const ok = (choices: Parameters<typeof buildAnswer>[0]) => parseCatalogueAnswer(buildAnswer(choices).text);
  it('parses up to three blocks and the explicit no-choice form', () => {
    const three = ok([1, 2, 3].map((n) => ({ ...CHOICE, title: `Song ${n}`, videoId: VID(n) })));
    expect(three.kind === 'choices' && three.blocks.map((b) => b.title)).toEqual(['Song 1', 'Song 2', 'Song 3']);
    expect(parseCatalogueAnswer('NO SUPPORTED CHOICE\nReason: nothing confirmable')).toEqual({ kind: 'none', reason: 'nothing confirmable' });
  });
  it.each([
    ['four blocks', buildAnswer([1, 2, 3, 4].map((n) => ({ ...CHOICE, videoId: VID(n) }))).text],
    ['prose preamble', `Here are some ideas!\n\n${buildAnswer([CHOICE]).text}`],
    ['JSON instead', JSON.stringify({ title: 'x' })],
    ['missing field', buildAnswer([CHOICE]).text.replace(/\nAnchor: .*/, '')],
    ['fields out of order', buildAnswer([CHOICE]).text.replace(/Title: (.*)\nArtists: (.*)/, 'Artists: $2\nTitle: $1')],
    ['wrong numbering', buildAnswer([CHOICE]).text.replace('CHOICE 1', 'CHOICE 2')],
    ['overlong title', buildAnswer([{ ...CHOICE, title: 'x'.repeat(201) }]).text],
    ['blocks without blank line', buildAnswer([CHOICE, CHOICE]).text.replace('\n\nCHOICE 2', '\nCHOICE 2')],
    ['control character', buildAnswer([CHOICE]).text.replace('Invented', 'Inv\u0007ented')],
  ])('rejects %s as a whole answer (no repair)', (_label, text) => {
    expect(() => parseCatalogueAnswer(text)).toThrow();
  });
});

describe('separate destination validators', () => {
  it('accepts only exact YouTube recordings as listening destinations and only provider redirects as citations', () => {
    expect(canonicalListeningDestination(`https://youtu.be/${VID(1)}`)).toEqual({ kind: 'youtube', videoId: VID(1), url: `https://www.youtube.com/watch?v=${VID(1)}` });
    expect(canonicalListeningDestination('https://www.youtube.com/playlist?list=PLinvented')).toBeNull();
    expect(canonicalListeningDestination(REDIRECT(1))).toBeNull();
    expect(canonicalListeningDestination('https://open.invalid/track/x')).toBeNull();
    expect(validateProviderSourceUrl(REDIRECT(1))).toBe(REDIRECT(1));
    expect(validateProviderSourceUrl(`https://www.youtube.com/watch?v=${VID(1)}`)).toBeNull();
    expect(validateProviderSourceUrl('https://vertexaisearch.cloud.google.com:8443/grounding-api-redirect/x')).toBeNull();
    expect(validateProviderSourceUrl('https://user@vertexaisearch.cloud.google.com/grounding-api-redirect/x')).toBeNull();
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://evil.invalid/watch?v=x')).toBeNull();
    expect(safeHref(`https://www.youtube.com/watch?v=${VID(1)}`)).toBe(`https://www.youtube.com/watch?v=${VID(1)}`);
  });
});

describe('Search Suggestions isolation (fake HTML proves controls only)', () => {
  it('strips scripts, handlers, forms, frames and non-allowlisted links/resources', () => {
    const dirty = [
      '<style>.a{}</style>',
      '<script>alert(1)</script>',
      '<div onclick="steal()" class="a">x</div>',
      '<form action="https://evil.invalid"><input name="q"></form>',
      '<iframe src="https://evil.invalid"></iframe>',
      '<img src="https://evil.invalid/pixel.gif"><img src="https://www.gstatic.com/ok.png">',
      '<a href="https://www.google.com/search?q=ok&amp;y=1">ok</a>',
      '<a href="https://evil.invalid/">bad</a>',
      '<a href="javascript:alert(1)">js</a>',
      '<base href="https://evil.invalid/"><meta http-equiv="refresh" content="0;url=https://evil.invalid">',
    ].join('');
    const clean = sanitizeSuggestions(dirty);
    expect(clean).not.toMatch(/<script|onclick|<form|<input|<iframe|evil\.invalid|javascript:|<base|<meta/i);
    expect(clean).toContain('https://www.gstatic.com/ok.png');
    expect(clean).toContain('href="https://www.google.com/search?q=ok&amp;y=1" target="_blank" rel="noopener noreferrer"');
    expect(clean).toContain('<style>');
  });

  it('declares a sandbox CSP with no scripts, forms, connections or same-origin access', () => {
    expect(SUGGESTIONS_CSP).toMatch(/^sandbox allow-popups allow-popups-to-escape-sandbox;/);
    expect(SUGGESTIONS_CSP).not.toMatch(/allow-scripts|allow-same-origin|allow-forms/);
    for (const d of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) {
      expect(SUGGESTIONS_CSP).toContain(d);
    }
  });

  it('renders the unit only in a sandboxed frame without script or same-origin privileges', () => {
    const html = renderToStaticMarkup(
      createElement(ChoicesPanel, {
        panel: {
          handle: 'panel-handle-000000000001' as Handle,
          synthetic: false,
          role: 'initial',
          mode: null,
          basis: [],
          outcome: 'choices',
          choices: [
            {
              handle: 'choice-handle-00000000001' as Handle,
              title: 'Invented Song',
              credits: ['Neighbour X11'],
              unverifiedCredits: 1,
              anchor: 'Neighbour X11',
              playUrl: `https://www.youtube.com/watch?v=${VID(1)}`,
              service: 'youtube',
              fitHypothesis: 'It may keep the groove.',
              sources: [0],
              feedback: { fit: null, familiarity: null, revision: 0 },
            },
          ],
          answer: { text: 'Invented answer.', marks: [] },
          citations: [{ title: 'Invented source 1', url: REDIRECT(1), domain: 'source1.invalid' }],
          suggestionsUrl: '/api/suggestions/panel-handle-000000000001',
          gaps: [{ reason: 'title_mismatch', count: 1 }],
        },
      }),
    );
    expect(html).toMatch(/<iframe[^>]*sandbox="allow-popups allow-popups-to-escape-sandbox"/);
    expect(html).not.toMatch(/allow-scripts|allow-same-origin/);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('1 other credit not confirmed');
    expect(html).toContain('Wintr has not listened to it');
    expect(html).toContain('1 proposed recording was not shown');
  });
});

describe('network-safe metadata fetching', () => {
  const ctx = (over: Partial<Parameters<typeof safeGet>[3]> = {}) => ({
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 10_000,
    budget: createMetadataBudget(),
    ...over,
  });
  const oembed = (id: string) => new URL(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);

  const NON_PUBLIC = [
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '172.16.5.5',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::2',
    '0:0:0:0:0:0:0:2',
    '::ff',
    'fec0::1',
    'FEC0:0:0:0:0:0:0:1',
    'feff::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
    '0:0:0:0:0:FFFF:127.0.0.1',
    '::127.0.0.1',
    '::8.8.8.8',
    '64:ff9b::a00:1',
    '64:ff9b::8.8.8.8',
    '100::1',
    '2001::1',
    '2001:0:4136:e378::1',
    '2001:db8::1',
    '2002:a00:1::1',
    '3fff::1',
    '3ffe::1',
    '4000::1',
    'not-an-ip',
    '',
  ];
  it.each(NON_PUBLIC)('treats %s as non-public', (address) => expect(isPublicAddress(address)).toBe(false));

  it('classifies equivalent IPv6 spellings identically and mapped IPv4 as its embedded address', () => {
    expect(ipv6Bytes('::ffff:127.0.0.1')).toEqual(ipv6Bytes('0:0:0:0:0:ffff:7f00:1'));
    expect(ipv6Bytes('::2')).toEqual([...Array(15).fill(0), 2]);
    expect(ipv6Bytes('fe80::1%eth0')).toBeNull();
    expect(ipv6Bytes('1:2:3:4:5:6:7:8:9')).toBeNull();
    for (const a of ['2607:f8b0:4004:800::200e', '2607:F8B0:4004:0800:0000:0000:0000:200E', '2a00:1450:4001::1', '::ffff:142.250.1.1', '::ffff:8efa:101', '142.250.1.1']) {
      expect(isPublicAddress(a)).toBe(true);
    }
  });

  it('refuses every non-public DNS answer form before any pinned connection', async () => {
    for (const address of ['::2', 'fec0::1', '0:0:0:0:0:0:0:1', '::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', 'fe80::1%eth0']) {
      const net = fakeNetwork({ [VID(1)]: { title: 'x', author_name: 'y' } }, { 'www.youtube.com': [address] });
      const err = await safeGet({ resolve: net.resolve, http: net.http, now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx()).catch((e) => e);
      expect([address, err.gap]).toEqual([address, 'unsafe_address']);
      expect(net.requests).toHaveLength(0);
    }
  });

  it('accepts public addresses and pins the connection to the validated one, sending no cookies or credentials', async () => {
    expect(isPublicAddress('142.250.1.1')).toBe(true);
    expect(isPublicAddress('2607:f8b0:4004:800::200e')).toBe(true);
    const net = fakeNetwork({ [VID(1)]: { title: 'x', author_name: 'y' } }, { 'www.youtube.com': ['142.250.1.1'] });
    await safeGet({ resolve: net.resolve, http: net.http, now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx());
    expect(net.requests[0]!.address).toBe('142.250.1.1');
    expect(net.requests[0]!.headers).toEqual({ accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'wintr-metadata/0.1' });
  });

  it('rejects private or mixed DNS answers before connecting', async () => {
    for (const answer of [['10.0.0.5'], ['142.250.1.1', '127.0.0.1'], []]) {
      const net = fakeNetwork({}, { 'www.youtube.com': answer });
      const err = await safeGet({ resolve: net.resolve, http: net.http, now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx()).catch((e) => e);
      expect(err).toBeInstanceOf(SafeFetchError);
      expect(err.gap).toBe('unsafe_address');
      expect(net.requests).toHaveLength(0);
    }
  });

  it('validates every redirect hop: host allowlist, scheme, port, credentials, public DNS and the 3-hop cap', async () => {
    const run = (location: string, dns: Record<string, string[]> = {}) => {
      const net = fakeNetwork({ [VID(1)]: { redirect: location } }, dns);
      return safeGet({ resolve: net.resolve, http: net.http, now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx()).then(
        () => ({ gap: null, net }),
        (e: SafeFetchError) => ({ gap: e.gap, net }),
      );
    };
    expect((await run('https://evil.invalid/oembed')).gap).toBe('unsafe_redirect');
    expect((await run('http://www.youtube.com/oembed')).gap).toBe('unsafe_redirect');
    expect((await run('https://www.youtube.com:8443/oembed')).gap).toBe('unsafe_redirect');
    expect((await run('https://user:pw@www.youtube.com/oembed')).gap).toBe('unsafe_redirect');
    expect((await run('https://www.youtube.com/watch?v=x')).gap).toBe('unsafe_redirect');
    // A redirect to an allowlisted host whose DNS now points inward (rebinding) is refused before connecting.
    let calls = 0;
    const rebinding = fakeNetwork({ [VID(1)]: { redirect: 'https://youtube.com/oembed?url=x' } });
    const resolve = async (host: string) => (host === 'youtube.com' ? ['127.0.0.1'] : ['142.250.1.1']);
    const err = await safeGet({ resolve, http: rebinding.http, now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx()).catch((e) => e);
    expect(err.gap).toBe('unsafe_address');
    expect(rebinding.requests).toHaveLength(1);
    // Endless allowlisted redirects stop after three hops.
    const loop = { resolve: async () => ['142.250.1.1'], http: async () => ((calls += 1), { status: 302, location: 'https://youtube.com/oembed?again=1', body: new Uint8Array() }), now: Date.now };
    expect((await safeGet(loop, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx()).catch((e) => e)).gap).toBe('too_many_redirects');
    expect(calls).toBe(4);
  });

  it('enforces the aggregate cap, three-way concurrency, body bound and deadline', async () => {
    const budget = createMetadataBudget(2, 3);
    const net = fakeNetwork({ [VID(1)]: { title: 'x', author_name: 'y' } });
    const deps = { resolve: net.resolve, http: net.http, now: Date.now };
    await safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx({ budget }));
    await safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx({ budget }));
    expect((await safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx({ budget })).catch((e) => e)).gap).toBe('metadata_cap');

    let active = 0;
    let peak = 0;
    const slots = createMetadataBudget(12, 3);
    await Promise.all(
      Array.from({ length: 7 }, () =>
        slots.slot(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(3);

    const big = { resolve: net.resolve, http: async () => ({ status: 200, location: null, body: new Uint8Array(40 * 1024) }), now: Date.now };
    expect((await safeGet(big, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx()).catch((e) => e)).gap).toBe('oversize');
    expect((await safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx({ deadlineAt: Date.now() - 1 })).catch((e) => e)).gap).toBe('deadline');

    vi.useFakeTimers();
    let seen: AbortSignal | null = null;
    const hung = { resolve: net.resolve, http: (req: { signal: AbortSignal }) => ((seen = req.signal), new Promise<never>((_, rej) => req.signal.addEventListener('abort', () => rej(new Error('aborted'))))), now: () => 0 };
    const p = safeGet(hung as never, YOUTUBE_METADATA_POLICY, oembed(VID(1)), ctx({ deadlineAt: 60_000 })).catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await p).gap).toBe('deadline');
    expect(seen!.aborted).toBe(true);
  });
});

describe('metadata cancellation and deadline cover DNS, HTTP and every hop', () => {
  const oembed = (id: string) => new URL(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
  const OK = { status: 200, location: null, body: new TextEncoder().encode('{"title":"x","author_name":"y"}') };
  /** DNS that ignores abort and settles only when told to. */
  const heldDns = (answer: readonly string[] = ['142.250.1.1']) => {
    let release!: () => void;
    let fail!: () => void;
    const gate = new Promise<void>((res, rej) => ((release = res), (fail = () => rej(new Error('late dns failure')))));
    let calls = 0;
    return { resolve: async () => ((calls += 1), await gate, answer), release: () => release(), fail: () => fail(), calls: () => calls };
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  beforeAll(() => process.on('unhandledRejection', onUnhandled));
  afterAll(() => process.off('unhandledRejection', onUnhandled));
  afterEach(() => expect(unhandled).toEqual([]));

  it('A: abort during a held lookup rejects promptly and never connects, even when DNS later answers', async () => {
    const dns = heldDns();
    let http = 0;
    const ac = new AbortController();
    const p = safeGet({ resolve: dns.resolve, http: async () => ((http += 1), OK), now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), {
      signal: ac.signal,
      deadlineAt: Date.now() + 10_000,
      budget: createMetadataBudget(),
    }).catch((e: SafeFetchError) => e);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    const err = await p;
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).gap).toBe('aborted');
    dns.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(http).toBe(0);
  });

  it('B: a lookup held past the deadline rejects at the deadline and never connects afterwards', async () => {
    const dns = heldDns();
    let http = 0;
    const started = Date.now();
    const p = safeGet({ resolve: dns.resolve, http: async () => ((http += 1), OK), now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), {
      signal: new AbortController().signal,
      deadlineAt: started + 25,
      budget: createMetadataBudget(),
    }).catch((e: SafeFetchError) => e);
    setTimeout(() => dns.release(), 80);
    const err = (await p) as SafeFetchError;
    expect(err.gap).toBe('deadline');
    expect(Date.now() - started).toBeLessThan(75);
    await new Promise((r) => setTimeout(r, 100));
    expect(http).toBe(0);
  });

  it('a late DNS failure after abort is absorbed (no unhandled rejection)', async () => {
    const dns = heldDns();
    const ac = new AbortController();
    const p = safeGet({ resolve: dns.resolve, http: async () => OK, now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), {
      signal: ac.signal,
      deadlineAt: Date.now() + 10_000,
      budget: createMetadataBudget(),
    }).catch((e: SafeFetchError) => e);
    ac.abort();
    expect(((await p) as SafeFetchError).gap).toBe('aborted');
    dns.fail();
    await new Promise((r) => setTimeout(r, 20));
  });

  it('already-aborted or expired operations never resolve or connect', async () => {
    let resolves = 0;
    let http = 0;
    const deps = { resolve: async () => ((resolves += 1), ['142.250.1.1']), http: async () => ((http += 1), OK), now: Date.now };
    const ac = new AbortController();
    ac.abort();
    expect(((await safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), { signal: ac.signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget() }).catch((e) => e)) as SafeFetchError).gap).toBe('aborted');
    expect(((await safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), { signal: new AbortController().signal, deadlineAt: Date.now() - 1, budget: createMetadataBudget() }).catch((e) => e)) as SafeFetchError).gap).toBe('deadline');
    expect([resolves, http]).toEqual([0, 0]);
  });

  it('an uncooperative HTTP client that ignores abort cannot hold the operation past Stop', async () => {
    let seen: AbortSignal | null = null;
    const ac = new AbortController();
    const p = safeGet({ resolve: async () => ['142.250.1.1'], http: (req) => ((seen = req.signal), new Promise<never>(() => undefined)), now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), {
      signal: ac.signal,
      deadlineAt: Date.now() + 10_000,
      budget: createMetadataBudget(),
    }).catch((e: SafeFetchError) => e);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(((await p) as SafeFetchError).gap).toBe('aborted');
    expect(seen!.aborted).toBe(true);
  });

  it('an uncooperative HTTP client cannot hold the operation past the whole-operation deadline', async () => {
    const started = Date.now();
    const p = safeGet({ resolve: async () => ['142.250.1.1'], http: () => new Promise<never>(() => undefined), now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), {
      signal: new AbortController().signal,
      deadlineAt: started + 30,
      budget: createMetadataBudget(),
    }).catch((e: SafeFetchError) => e);
    expect(((await p) as SafeFetchError).gap).toBe('deadline');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('re-authorises before each redirect hop: Stop or the deadline between hops prevents the next lookup and connection', async () => {
    for (const mode of ['abort', 'deadline'] as const) {
      const ac = new AbortController();
      let clock = 1_000;
      const resolved: string[] = [];
      const requested: string[] = [];
      const deps = {
        resolve: async (host: string) => (resolved.push(host), ['142.250.1.1']),
        http: async (req: { url: URL }) => {
          requested.push(req.url.hostname);
          // The first hop answers with an allowlisted redirect, and Stop/deadline lands in the same tick.
          if (mode === 'abort') ac.abort();
          else clock = 10_000;
          return { status: 302, location: 'https://youtube.com/oembed?url=x', body: new Uint8Array() };
        },
        now: () => clock,
      };
      const err = (await safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), { signal: ac.signal, deadlineAt: 5_000, budget: createMetadataBudget() }).catch((e) => e)) as SafeFetchError;
      expect(err.gap).toBe(mode === 'abort' ? 'aborted' : 'deadline');
      expect(resolved).toEqual(['www.youtube.com']);
      expect(requested).toEqual(['www.youtube.com']);
    }
  });

  it('a second-hop lookup held across Stop never connects the second hop', async () => {
    const ac = new AbortController();
    let hop2Release!: () => void;
    const hop2 = new Promise<void>((r) => (hop2Release = r));
    const requested: string[] = [];
    const deps = {
      resolve: async (host: string) => {
        if (host === 'youtube.com') await hop2;
        return ['142.250.1.1'];
      },
      http: async (req: { url: URL }) => (requested.push(req.url.hostname), req.url.hostname === 'www.youtube.com' ? { status: 302, location: 'https://youtube.com/oembed?url=x', body: new Uint8Array() } : OK),
      now: Date.now,
    };
    const p = safeGet(deps, YOUTUBE_METADATA_POLICY, oembed(VID(1)), { signal: ac.signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget() }).catch((e: SafeFetchError) => e);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(((await p) as SafeFetchError).gap).toBe('aborted');
    hop2Release();
    await new Promise((r) => setTimeout(r, 20));
    expect(requested).toEqual(['www.youtube.com']);
  });

  it('counts each attempted hop against the aggregate cap even when it is cancelled (no refund, no retry)', async () => {
    const dns = heldDns();
    const ac = new AbortController();
    const budget = createMetadataBudget(12, 3);
    const p = safeGet({ resolve: dns.resolve, http: async () => OK, now: Date.now }, YOUTUBE_METADATA_POLICY, oembed(VID(1)), { signal: ac.signal, deadlineAt: Date.now() + 10_000, budget }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await p;
    dns.release();
    expect(budget.used()).toBe(1);
    expect(dns.calls()).toBe(1);
  });
});

describe('deterministic YouTube metadata and evidence matching', () => {
  const block = (o: Partial<{ title: string; artists: string[]; anchor: string }> = {}) => ({
    index: 0,
    title: o.title ?? 'Invented Song',
    artists: o.artists ?? ['Neighbour X11'],
    anchor: o.anchor ?? 'Neighbour X11',
    listen: '',
    why: '',
    startByte: 0,
    endByte: 1,
  });
  const meta = (title: string, channelName: string) => ({ videoId: VID(1), title, channelName });

  it('verifies title and anchor credit from metadata; never by title substring or familiar channel alone', () => {
    expect(matchMetadata(block(), 'Neighbour X11', meta('Neighbour X11 - Invented Song (Official Audio)', 'Neighbour X11'))).toMatchObject({ ok: true, credits: ['Neighbour X11'], creditSource: 'title' });
    expect(matchMetadata(block(), 'Neighbour X11', meta('Invented Song', 'Neighbour X11 - Topic'))).toMatchObject({ ok: true, topic: true, creditSource: 'uploader_name' });
    expect(matchMetadata(block(), 'Neighbour X11', meta('Another Song', 'Neighbour X11'))).toEqual({ ok: false, gap: 'title_mismatch' });
    expect(matchMetadata(block(), 'Neighbour X11', meta('Invented Song', 'Some Uploader'))).toEqual({ ok: false, gap: 'anchor_not_credited' });
    // An artist name inside the title phrase is not a credit.
    expect(matchMetadata(block({ title: 'Song For Neighbour X11' }), 'Neighbour X11', meta('Song For Neighbour X11', 'Some Uploader'))).toEqual({ ok: false, gap: 'anchor_not_credited' });
    expect(matchMetadata(block(), 'Neighbour X11', meta('Neighbour X11 - Invented Song (Karaoke Version)', 'Karaoke Hub'))).toEqual({ ok: false, gap: 'uncertain_identity' });
  });

  const SKY = (artists: string[] = ['Generic Artist']) => block({ title: 'Sky', artists, anchor: 'Generic Artist' });
  const sky = (title: string, channel = 'Generic Artist', artists?: string[]) => matchMetadata(SKY(artists), 'Generic Artist', meta(title, channel));

  it('accepts only an exact title: a longer title containing the proposal is a different recording', () => {
    expect(sky('Generic Artist - Sky High (Official Audio)')).toEqual({ ok: false, gap: 'title_mismatch' });
    expect(sky('Generic Artist - Blue Sky')).toEqual({ ok: false, gap: 'title_mismatch' });
    expect(sky('Generic Artist - Sky Sky')).toEqual({ ok: false, gap: 'title_mismatch' });
    expect(sky('Sky High', 'Generic Artist - Topic')).toEqual({ ok: false, gap: 'title_mismatch' });
    // The model-selected title is never replaced: a proposal for "Sky High" stays "Sky High".
    expect(matchMetadata(block({ title: 'Sky High', artists: ['Generic Artist'] }), 'Generic Artist', meta('Generic Artist - Sky', 'Generic Artist'))).toEqual({ ok: false, gap: 'title_mismatch' });
  });

  it('never turns an undeclared live/remix/remaster/edit upload into the proposed recording, in either direction', () => {
    for (const t of [
      'Generic Artist - Sky (Live)',
      'Generic Artist - Sky [Live at Invented Hall]',
      'Generic Artist - Sky (Invented Remix)',
      'Generic Artist - Sky (Remastered 2011)',
      'Generic Artist - Sky - Radio Edit',
      'Generic Artist - Sky (Acoustic) [Official Video]',
      'Generic Artist - Sky | Live Session',
    ]) {
      expect([t, sky(t)]).toEqual([t, { ok: false, gap: 'version_mismatch' }]);
    }
    // A declared live version matches only the same version.
    const live = block({ title: 'Sky (Live)', artists: ['Generic Artist'] });
    expect(matchMetadata(live, 'Generic Artist', meta('Generic Artist - Sky (Live)', 'Generic Artist'))).toMatchObject({ ok: true, versions: ['live'] });
    expect(matchMetadata(live, 'Generic Artist', meta('Generic Artist - Sky (Official Audio)', 'Generic Artist'))).toEqual({ ok: false, gap: 'version_mismatch' });
    expect(sky('Generic Artist - Sky (Live)', 'Generic Artist')).toEqual({ ok: false, gap: 'version_mismatch' });
  });

  it('accepts legitimate upload decorations and collaboration credits', () => {
    for (const [title, channel] of [
      ['Generic Artist - Sky (Official Audio)', 'Generic Artist'],
      ['Generic Artist - Sky [Official Music Video]', 'Invented Label'],
      ['Generic Artist - Sky | Official Visualizer', 'Generic Artist'],
      ['Generic Artist – Sky (HD)', 'Generic Artist'],
      ['GENERIC ARTIST - SKY', 'Generic Artist'],
      ['Sky', 'Generic Artist - Topic'],
      ['Sky (Official Audio)', 'Generic Artist'],
      ['Sky - Generic Artist', 'Invented Label'],
    ]) {
      expect([title, sky(title!, channel)]).toEqual([title, expect.objectContaining({ ok: true, credits: ['Generic Artist'], versions: [] })]);
    }
    const duo = ['Generic Artist', 'Generic Collaborator'];
    for (const [title, channel] of [
      ['Generic Artist & Generic Collaborator - Sky (Official Audio)', 'Generic Artist'],
      ['Generic Artist, Generic Collaborator - Sky', 'Invented Label'],
      ['Generic Artist x Generic Collaborator - Sky', 'Generic Artist'],
      ['Generic Artist - Sky (feat. Generic Collaborator)', 'Generic Artist'],
      ['Generic Artist - Sky ft. Generic Collaborator [Official Video]', 'Generic Artist'],
      ['Sky (with Generic Collaborator)', 'Generic Artist - Topic'],
    ]) {
      expect([title, sky(title!, channel, duo)]).toEqual([title, expect.objectContaining({ ok: true, credits: duo })]);
    }
    // A feat. credit written into the proposed title must itself be declared.
    expect(matchMetadata(block({ title: 'Sky (feat. Generic Collaborator)', artists: duo }), 'Generic Artist', meta('Generic Artist - Sky (feat. Generic Collaborator)', 'Generic Artist'))).toMatchObject({ ok: true });
    expect(matchMetadata(block({ title: 'Sky (feat. Someone Undeclared)', artists: ['Generic Artist'] }), 'Generic Artist', meta('Generic Artist - Sky (feat. Someone Undeclared)', 'Generic Artist'))).toEqual({ ok: false, gap: 'credits_unconfirmed' });
  });

  it('requires the complete credit set: missing declared credits and extra metadata credits are both rejected', () => {
    const duo = ['Generic Artist', 'Generic Collaborator'];
    // The controller reproduction: declared duo, metadata names only the anchor.
    expect(sky('Generic Artist - Sky (Official Audio)', 'Generic Artist', duo)).toEqual({ ok: false, gap: 'credits_unconfirmed' });
    expect(sky('Sky', 'Generic Artist - Topic', duo)).toEqual({ ok: false, gap: 'credits_unconfirmed' });
    // Declared solo, metadata credits someone else too.
    expect(sky('Generic Artist & Generic Collaborator - Sky')).toEqual({ ok: false, gap: 'credits_extra' });
    expect(sky('Generic Artist - Sky (feat. Generic Collaborator)')).toEqual({ ok: false, gap: 'credits_extra' });
    // Namesake-like uploader strings never count as the credited artist.
    expect(sky('Generic Artist Tribute Band - Sky')).toEqual({ ok: false, gap: 'uncertain_identity' });
    expect(sky('Generic Artists - Sky', 'Generic Artists')).toEqual({ ok: false, gap: 'anchor_not_credited' });
    expect(sky('Other Artist - Sky', 'Generic Artist')).toEqual({ ok: false, gap: 'anchor_not_credited' });
    expect(sky('Generic Artist Official - Sky', 'Generic Artist')).toEqual({ ok: false, gap: 'credits_extra' });
    expect(sky('Sky', 'GenericArtistVEVO')).toEqual({ ok: false, gap: 'anchor_not_credited' });
  });

  it('builds one recording key per recording, independent of declared credit order', () => {
    const duo = sky('Generic Artist & Generic Collaborator - Sky', 'Generic Artist', ['Generic Artist', 'Generic Collaborator']);
    const reversed = matchMetadata(block({ title: 'Sky', artists: ['Generic Collaborator', 'Generic Artist'] }), 'Generic Artist', meta('Generic Artist & Generic Collaborator - Sky (Official Video)', 'Invented Label'));
    if (!duo.ok || !reversed.ok) throw new Error('expected matches');
    expect(reversed.recordingKey).toBe(duo.recordingKey);
    // A partial declared subset cannot mint a second key for the same recording: it is rejected.
    expect(sky('Generic Artist & Generic Collaborator - Sky')).toEqual({ ok: false, gap: 'credits_extra' });
    // Different versions are different recordings.
    const live = matchMetadata(block({ title: 'Sky (Live)', artists: ['Generic Artist'] }), 'Generic Artist', meta('Generic Artist - Sky (Live)', 'Generic Artist'));
    const studio = sky('Generic Artist - Sky');
    if (!live.ok || !studio.ok) throw new Error('expected matches');
    expect(live.recordingKey).not.toBe(studio.recordingKey);
  });

  it('reads only bounded title/channel metadata through the safe fetcher', async () => {
    const net = fakeNetwork({ [VID(1)]: { title: 'Neighbour X11 - Invented Song', author_name: 'Neighbour X11' }, [VID(2)]: { status: 404 } });
    const verifier = createYouTubeVerifier({ resolve: net.resolve, http: net.http, now: Date.now });
    const c = { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget() };
    expect(await verifier.lookup(canonicalListeningDestination(`https://www.youtube.com/watch?v=${VID(1)}`)!, c)).toEqual({
      ok: true,
      metadata: { videoId: VID(1), title: 'Neighbour X11 - Invented Song', channelName: 'Neighbour X11' },
    });
    expect(await verifier.lookup(canonicalListeningDestination(`https://www.youtube.com/watch?v=${VID(2)}`)!, c)).toEqual({ ok: false, gap: 'destination_unavailable' });
    expect(net.requests.map((r) => `${r.url.hostname}${r.url.pathname}`)).toEqual(['www.youtube.com/oembed', 'www.youtube.com/oembed']);
  });
});

describe('client bundle sources hold no provider endpoints or credentials', () => {
  it('src/client never references provider hosts, tokens or project bindings', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(join(process.cwd(), 'src', 'client'));
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      expect(s).not.toMatch(/aiplatform\.googleapis|generativelanguage|api\.qloo|x-api-key|x-goog|Bearer |accessToken/i);
    }
  });
});
