import { describe, expect, it } from 'vitest';
import { appleCatalogueSearchUrl, APPLE_SEARCH_SOURCE_KIND, createAppleCatalogueSearch, type AppleCatalogueSearchRequest } from '../src/server/apple-catalogue-search.js';
import { isCanonicalDestination } from '../src/server/destinations.js';
import { toQlooArtistId } from '../src/server/providers/qloo.js';
import { createMetadataBudget, METADATA_HEADERS, type PinnedHttpClient, type PinnedRequest, type PinnedResponse } from '../src/server/net/safe-fetch.js';
import { AID } from './fixtures/catalogue-fixtures.js';

// Explicit Apple catalogue SEARCH candidate retrieval. Every artist, title and
// ID is invented; the fake transport records requests and never touches the network.

const ARTIST = { entityId: toQlooArtistId('00000000-0000-4000-8000-000000000001')!, name: 'Neighbour X11' };
const REQ = (over: Partial<AppleCatalogueSearchRequest> = {}, name = ARTIST.name): AppleCatalogueSearchRequest => ({ artist: { ...ARTIST, name }, storefront: 'us', ...over });

type Row = Record<string, unknown>;
const row = (n: number, over: Row = {}, storefront = 'us'): Row => ({
  wrapperType: 'track',
  kind: 'song',
  trackId: Number(AID(n)),
  trackName: `Invented Song ${n}`,
  artistName: 'Neighbour X11',
  collectionName: 'Invented Collection',
  trackViewUrl: `https://music.apple.com/${storefront}/album/invented-collection/9000000001?i=${AID(n)}&uo=4`,
  previewUrl: 'https://audio-ssl.itunes.apple.com/invented/preview.m4a',
  artworkUrl100: 'https://is1-ssl.mzstatic.com/invented/100x100bb.jpg',
  trackPrice: 1.29,
  isStreamable: true,
  ...over,
});

const json = (results: unknown[], resultCount = results.length): PinnedResponse => ({ status: 200, location: null, body: new TextEncoder().encode(JSON.stringify({ resultCount, results })) });
const status = (s: number, location: string | null = null): PinnedResponse => ({ status: s, location, body: new Uint8Array() });

function harness(answer: PinnedResponse | ((req: PinnedRequest) => Promise<PinnedResponse>), dns: string[] = ['17.253.1.1']) {
  const requests: PinnedRequest[] = [];
  const resolved: string[] = [];
  const http: PinnedHttpClient = async (req) => {
    requests.push(req);
    return typeof answer === 'function' ? answer(req) : answer;
  };
  const search = createAppleCatalogueSearch({
    resolve: async (host) => {
      resolved.push(host);
      return dns;
    },
    http,
    now: Date.now,
  });
  return { search, requests, resolved };
}

const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget() });

describe('Apple catalogue search request', () => {
  it('construction and import perform no DNS or request', () => {
    const h = harness(json([]));
    expect(h.requests).toEqual([]);
    expect(h.resolved).toEqual([]);
  });

  it.each<unknown>([
    null, undefined, [], {}, { artist: null, storefront: 'us' },
    { artist: { name: ARTIST.name }, storefront: 'us' },
    { artist: { ...ARTIST, entityId: {} }, storefront: 'us' },
    { artist: { ...ARTIST, entityId: 'not-a-qloo-artist' }, storefront: 'us' },
    { artist: ARTIST, storefront: { toString: () => 'us' } },
  ])('refuses malformed runtime identity or request before DNS: %j', async (request) => {
    const h = harness(json([row(1)]));
    expect(await h.search.search(request as AppleCatalogueSearchRequest, ctx())).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(h.resolved).toEqual([]);
    expect(h.requests).toEqual([]);
  });

  it('retains the requested artist and storefront when caller aliases mutate during I/O', async () => {
    const request = { artist: { ...ARTIST }, storefront: 'us' };
    const h = harness(async () => {
      request.artist.entityId = toQlooArtistId('00000000-0000-4000-8000-000000000002')!;
      request.artist.name = 'Another Artist';
      request.storefront = 'gb';
      return json([row(1)]);
    });
    expect(await h.search.search(request, ctx())).toMatchObject({
      status: 'candidates', artist: ARTIST, storefront: 'us',
      candidates: [{ artistName: ARTIST.name, storefront: 'us' }],
    });
    expect(h.requests[0]!.url.searchParams.get('country')).toBe('us');
    expect(h.requests[0]!.url.searchParams.get('term')).toBe(ARTIST.name);
  });

  it('makes one exact, code-built, credential-free GET with only the six allowed query keys', async () => {
    const h = harness(json([row(1, { artistName: 'Neighbour X11 & Co=1' }, 'gb')]));
    const out = await h.search.search(REQ({ storefront: 'gb' }, 'Neighbour X11 & Co=1'), ctx());
    expect(out.status).toBe('candidates');
    expect(h.requests).toHaveLength(1);
    const req = h.requests[0]!;
    expect(req.url.href).toBe('https://itunes.apple.com/search?term=Neighbour+X11+%26+Co%3D1&attribute=artistTerm&entity=song&media=music&country=gb&limit=6');
    expect(req.url.hostname).toBe('itunes.apple.com');
    expect(req.url.pathname).toBe('/search');
    expect([...req.url.searchParams.keys()]).toEqual(['term', 'attribute', 'entity', 'media', 'country', 'limit']);
    expect(req.url.username + req.url.password + req.url.hash).toBe('');
    expect(req.method).toBeUndefined();
    expect(req.headers).toEqual(METADATA_HEADERS);
    expect(Object.keys(req.headers).join(',')).not.toMatch(/auth|cookie|key|goog/i);
    expect(req.maxBytes).toBe(32 * 1024);
    expect(h.resolved).toEqual(['itunes.apple.com']);
  });

  it('encodes a non-Latin term and builds the same URL as the exported builder', async () => {
    const h = harness(json([]));
    await h.search.search(REQ({}, '\u30c6\u30b9\u30c8 \u30d0\u30f3\u30c9'), ctx());
    expect(h.requests[0]!.url.href).toBe(appleCatalogueSearchUrl('\u30c6\u30b9\u30c8 \u30d0\u30f3\u30c9', 'us')!.href);
    expect(h.requests[0]!.url.searchParams.get('term')).toBe('\u30c6\u30b9\u30c8 \u30d0\u30f3\u30c9');
  });

  it.each([
    ['uppercase storefront', 'US', 'Neighbour X11'],
    ['three-letter storefront', 'usa', 'Neighbour X11'],
    ['empty storefront', '', 'Neighbour X11'],
    ['storefront with a query', 'us&x=1', 'Neighbour X11'],
    ['empty name', 'us', '   '],
    ['punctuation-only name', 'us', '---'],
    ['control character in the name', 'us', 'Neighbour\nX11'],
    ['bidi override in the name', 'us', 'Neighbour \u202Ex11'],
    ['over-long name', 'us', 'x'.repeat(257)],
  ])('refuses %s before any DNS or request', async (_label, storefront, name) => {
    const h = harness(json([row(1)]));
    expect(await h.search.search(REQ({ storefront }, name), ctx())).toEqual({ status: 'unavailable', reason: 'invalid_request' });
    expect(h.requests).toEqual([]);
    expect(h.resolved).toEqual([]);
  });
});

describe('Apple catalogue search candidates', () => {
  it('returns bounded candidates with the canonical destination, dropping tracking, preview, artwork and price', async () => {
    const h = harness(json([row(1), row(2, { artistName: 'neighbour x11' })]));
    const out = await h.search.search(REQ(), ctx());
    expect(out).toEqual({
      status: 'candidates',
      artist: { entityId: ARTIST.entityId, name: 'Neighbour X11' },
      storefront: 'us',
      candidates: [
        {
          sourceKind: 'first_party_catalogue_search_candidate',
          title: 'Invented Song 1',
          artistName: 'Neighbour X11',
          trackId: AID(1),
          storefront: 'us',
          destination: { kind: 'apple_music', storefront: 'us', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}` },
        },
        expect.objectContaining({ trackId: AID(2), artistName: 'neighbour x11' }),
      ],
      rejected: [],
    });
    if (out.status !== 'candidates') throw new Error('unreachable');
    expect(APPLE_SEARCH_SOURCE_KIND).toBe('first_party_catalogue_search_candidate');
    for (const c of out.candidates) {
      expect(isCanonicalDestination(c.destination)).toBe(true);
      expect(c.destination.url).not.toMatch(/uo=|\?/);
      expect(Object.keys(c).sort()).toEqual(['artistName', 'destination', 'sourceKind', 'storefront', 'title', 'trackId']);
      expect(Object.isFrozen(c)).toBe(true);
      expect(JSON.stringify(c)).not.toMatch(/preview|mzstatic|artwork|price|choice|fit/i);
    }
    // Nothing returned was fetched: one request, to the search route only.
    expect(h.requests.map((r) => r.url.pathname)).toEqual(['/search']);
    expect(h.resolved).toEqual(['itunes.apple.com']);
  });

  it('an empty result is unavailable, not a fallback', async () => {
    const h = harness(json([]));
    expect(await h.search.search(REQ(), ctx())).toEqual({ status: 'unavailable', reason: 'no_results' });
    expect(h.requests).toHaveLength(1);
  });

  it('matches the Qloo artist exactly with the Unicode-safe form (case and Latin accents fold; other scripts do not collapse)', async () => {
    const accents = harness(json([row(1, { artistName: 'Bj\u00f6rkest\u00e5' })]));
    expect((await accents.search.search(REQ({}, 'Bjorkesta'), ctx())).status).toBe('candidates');
    const other = harness(json([row(1, { artistName: '\u30c6\u30b9\u30c8\u30d0\u30f3\u30c9' })]));
    expect(await other.search.search(REQ({}, '\u30c6\u30b9\u30c8\u30d0\u30f3\u30c8'), ctx())).toEqual({ status: 'unavailable', reason: 'no_matching_candidates' });
  });

  it.each<[string, Row, string]>([
    ['a lookalike artist', { artistName: 'Neighbour X111' }, 'artist_mismatch'],
    ['a prefix artist', { artistName: 'Neighbour' }, 'artist_mismatch'],
    ['a collaboration credit', { artistName: 'Neighbour X11 & Guest Y' }, 'artist_mismatch'],
    ['a featuring credit in the artist field', { artistName: 'Neighbour X11 feat. Guest Y' }, 'artist_mismatch'],
    ['a collection', { wrapperType: 'collection' }, 'not_song'],
    ['a music video', { kind: 'music-video' }, 'not_song'],
    ['a missing kind', { kind: undefined }, 'not_song'],
    ['a string track id', { trackId: AID(1) }, 'invalid_track_id'],
    ['a zero track id', { trackId: 0 }, 'invalid_track_id'],
    ['a negative track id', { trackId: -5 }, 'invalid_track_id'],
    ['a fractional track id', { trackId: 12.5 }, 'invalid_track_id'],
    ['an unsafe track id', { trackId: 2 ** 60 }, 'invalid_track_id'],
    ['a 16-digit track id', { trackId: 1234567890123456 }, 'invalid_track_id'],
    ['another storefront in the track-view URL', { trackViewUrl: `https://music.apple.com/gb/album/x/9000000001?i=${AID(1)}` }, 'destination_mismatch'],
    ['a track-view URL for another track', { trackViewUrl: `https://music.apple.com/us/album/x/9000000001?i=${AID(2)}` }, 'destination_mismatch'],
    ['a missing track-view URL', { trackViewUrl: null }, 'destination_mismatch'],
    ['a non-streamable song', { isStreamable: false }, 'not_streamable'],
    ['a missing streamable flag', { isStreamable: undefined }, 'not_streamable'],
    ['a truthy non-boolean streamable flag', { isStreamable: 'true' }, 'not_streamable'],
    ['a control character in the title', { trackName: 'Invented\u0007Song' }, 'invalid_text'],
    ['an empty title', { trackName: '  ' }, 'invalid_text'],
    ['an over-long title', { trackName: 'x'.repeat(301) }, 'invalid_text'],
    ['a non-string artist', { artistName: 7 }, 'invalid_text'],
  ])('does not accept %s', async (_label, over, reason) => {
    const h = harness(json([row(1, over)]));
    expect(await h.search.search(REQ(), ctx())).toEqual({ status: 'unavailable', reason: 'no_matching_candidates' });
    // Alongside a valid row the reason is reported and the valid row survives.
    const mixed = harness(json([row(1, over), row(2)]));
    const out = await mixed.search.search(REQ(), ctx());
    expect(out).toMatchObject({ status: 'candidates', rejected: [reason], candidates: [{ trackId: AID(2) }] });
    expect(h.requests.length + mixed.requests.length).toBe(2);
  });

  it.each([
    ['http scheme', `http://music.apple.com/us/album/x/9000000001?i=${AID(1)}`],
    ['foreign host', `https://invalid.example/us/album/x/9000000001?i=${AID(1)}`],
    ['lookalike host', `https://music.apple.com.invalid/us/album/x/9000000001?i=${AID(1)}`],
    ['userinfo', `https://user:pw@music.apple.com/us/album/x/9000000001?i=${AID(1)}`],
    ['explicit port', `https://music.apple.com:8443/us/album/x/9000000001?i=${AID(1)}`],
    ['fragment', `https://music.apple.com/us/album/x/9000000001?i=${AID(1)}#frag`],
    ['non-numeric tracking field', `https://music.apple.com/us/album/x/9000000001?i=${AID(1)}&uo=javascript`],
    ['unknown extra query', `https://music.apple.com/us/album/x/9000000001?i=${AID(1)}&redirect=https://invalid.example`],
    ['duplicate track field', `https://music.apple.com/us/album/x/9000000001?i=${AID(1)}&i=${AID(2)}`],
    ['artist page', `https://music.apple.com/us/artist/x/${AID(1)}`],
    ['javascript scheme', 'javascript:alert(1)'],
    ['encoded slash slug', `https://music.apple.com/us/song/a%2Fb/${AID(1)}`],
    ['backslash', `https://music.apple.com/us/song\\x/${AID(1)}`],
    ['a non-string', 42],
  ])('does not accept a %s track-view URL', async (_label, trackViewUrl) => {
    const out = await harness(json([row(1, { trackViewUrl })])).search.search(REQ(), ctx());
    expect(out).toEqual({ status: 'unavailable', reason: 'no_matching_candidates' });
  });

  it('deduplicates exact track IDs without inventing alternatives and keeps the first', async () => {
    const h = harness(json([row(1), row(1, { trackName: 'Different Title For Same Id' }), row(2)]));
    expect(await h.search.search(REQ(), ctx())).toMatchObject({
      status: 'candidates',
      candidates: [{ trackId: AID(1), title: 'Invented Song 1' }, { trackId: AID(2) }],
      rejected: ['duplicate_track_id'],
    });
  });

  it('accepts exactly six results and refuses a seventh', async () => {
    const six = await harness(json([1, 2, 3, 4, 5, 6].map((n) => row(n)))).search.search(REQ(), ctx());
    expect(six).toMatchObject({ status: 'candidates' });
    if (six.status === 'candidates') expect(six.candidates).toHaveLength(6);
    expect(await harness(json([1, 2, 3, 4, 5, 6, 7].map((n) => row(n)))).search.search(REQ(), ctx())).toEqual({ status: 'unavailable', reason: 'too_many_results' });
  });

  it.each<[string, PinnedResponse, string]>([
    ['a count that disagrees', json([row(1)], 2), 'malformed'],
    ['a count that disagrees with an empty list', json([], 1), 'malformed'],
    ['a non-array results field', { status: 200, location: null, body: new TextEncoder().encode('{"resultCount":1,"results":{"a":1}}') }, 'malformed'],
    ['a non-record result', json(['x']), 'malformed'],
    ['an array result', json([[1]]), 'malformed'],
    ['a null result', json([null]), 'malformed'],
    ['a missing resultCount', { status: 200, location: null, body: new TextEncoder().encode('{"results":[]}') }, 'malformed'],
    ['a non-object body', { status: 200, location: null, body: new TextEncoder().encode('[]') }, 'malformed'],
    ['malformed JSON', { status: 200, location: null, body: new TextEncoder().encode('{"resultCount":1,') }, 'malformed'],
    ['invalid UTF-8', { status: 200, location: null, body: new Uint8Array([0x7b, 0xff, 0x7d]) }, 'malformed'],
    ['an empty body', { status: 200, location: null, body: new Uint8Array() }, 'malformed'],
    ['an oversize body', { status: 200, location: null, body: new TextEncoder().encode(`{"pad":"${'x'.repeat(33 * 1024)}"}`) }, 'oversize'],
    ['a server error', status(503), 'http_error'],
    ['not found', status(404), 'http_error'],
  ])('refuses %s', async (_label, answer, reason) => {
    const h = harness(answer);
    expect(await h.search.search(REQ(), ctx())).toEqual({ status: 'unavailable', reason });
    expect(h.requests).toHaveLength(1);
  });
});

describe('Apple catalogue search guard', () => {
  it.each([
    ['throttling', 429],
    ['a forbidden answer', 403],
  ])('treats %s as unavailable with zero retry', async (_label, code) => {
    const h = harness(status(code));
    const c = ctx();
    expect(await h.search.search(REQ(), c)).toEqual({ status: 'unavailable', reason: 'throttled' });
    expect(h.requests).toHaveLength(1);
    expect(c.budget.used()).toBe(1);
  });

  it.each([
    ['another host', 'https://invalid.example/search?term=Neighbour+X11'],
    ['the lookup route', `https://itunes.apple.com/lookup?id=${AID(1)}&country=us&entity=song`],
    ['another term on the search route', 'https://itunes.apple.com/search?term=Other&attribute=artistTerm&entity=song&media=music&country=us&limit=6'],
    ['a wider limit', 'https://itunes.apple.com/search?term=Neighbour+X11&attribute=artistTerm&entity=song&media=music&country=us&limit=200'],
    ['an extra key', 'https://itunes.apple.com/search?term=Neighbour+X11&attribute=artistTerm&entity=song&media=music&country=us&limit=6&callback=x'],
    ['the identical URL again', 'https://itunes.apple.com/search?term=Neighbour+X11&attribute=artistTerm&entity=song&media=music&country=us&limit=6'],
    ['plain http', 'http://itunes.apple.com/search?term=Neighbour+X11'],
    ['a credentialed URL', 'https://user:pw@itunes.apple.com/search?term=Neighbour+X11'],
  ])('refuses a redirect to %s after exactly one request', async (_label, location) => {
    const h = harness(status(302, location));
    expect(await h.search.search(REQ(), ctx())).toEqual({ status: 'unavailable', reason: 'unsafe_redirect' });
    expect(h.requests).toHaveLength(1);
  });

  it.each([
    ['a private address', ['10.0.0.8']],
    ['loopback', ['127.0.0.1']],
    ['a mixed answer', ['17.253.1.1', '169.254.169.254']],
    ['no address', []],
  ])('refuses %s before any connection', async (_label, dns) => {
    const h = harness(json([row(1)]), dns);
    expect(await h.search.search(REQ(), ctx())).toEqual({ status: 'unavailable', reason: 'unsafe_address' });
    expect(h.requests).toEqual([]);
  });

  it('pins the connection to the validated address', async () => {
    const h = harness(json([]), ['17.253.1.9']);
    await h.search.search(REQ(), ctx());
    expect(h.requests[0]!.address).toBe('17.253.1.9');
  });

  it('shares the metadata budget: an exhausted cap makes no further request and no DNS lookup', async () => {
    const h = harness(json([row(1)]));
    const c = { signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget(1) };
    expect((await h.search.search(REQ(), c)).status).toBe('candidates');
    expect(await h.search.search(REQ(), c)).toEqual({ status: 'unavailable', reason: 'metadata_cap' });
    expect(h.requests).toHaveLength(1);
    expect(h.resolved).toHaveLength(1);
    const spent = createMetadataBudget(2);
    spent.take();
    spent.take();
    expect(await h.search.search(REQ(), { ...c, budget: spent })).toEqual({ status: 'unavailable', reason: 'metadata_cap' });
    expect(h.requests).toHaveLength(1);
  });

  it('a Stop before the call makes no lookup, request or budget use', async () => {
    const h = harness(json([row(1)]));
    const controller = new AbortController();
    controller.abort();
    const c = { signal: controller.signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget() };
    expect(await h.search.search(REQ(), c)).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(h.requests).toEqual([]);
    expect(h.resolved).toEqual([]);
    expect(c.budget.used()).toBe(0);
  });

  it('an elapsed deadline makes no lookup or request', async () => {
    const h = harness(json([row(1)]));
    const c = { signal: new AbortController().signal, deadlineAt: Date.now() - 1, budget: createMetadataBudget() };
    expect(await h.search.search(REQ(), c)).toEqual({ status: 'unavailable', reason: 'deadline' });
    expect(h.requests).toEqual([]);
    expect(c.budget.used()).toBe(0);
    expect(await h.search.search(REQ(), { ...c, deadlineAt: Number.NaN })).toEqual({ status: 'unavailable', reason: 'deadline' });
  });

  it('a Stop during the request ends it promptly without retry', async () => {
    const controller = new AbortController();
    const h = harness(() => new Promise<PinnedResponse>(() => undefined));
    const c = { signal: controller.signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget() };
    const pending = h.search.search(REQ(), c);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    expect(await pending).toEqual({ status: 'unavailable', reason: 'aborted' });
    expect(h.requests).toHaveLength(1);
  });

  it('a deadline during the request ends it without retry', async () => {
    const h = harness(() => new Promise<PinnedResponse>(() => undefined));
    const c = { signal: new AbortController().signal, deadlineAt: Date.now() + 30, budget: createMetadataBudget() };
    expect(await h.search.search(REQ(), c)).toEqual({ status: 'unavailable', reason: 'deadline' });
    expect(h.requests).toHaveLength(1);
  });

  it('a transport failure is unreachable, never retried', async () => {
    const h = harness(() => Promise.reject(new Error('boom')));
    expect(await h.search.search(REQ(), ctx())).toEqual({ status: 'unavailable', reason: 'unreachable' });
    expect(h.requests).toHaveLength(1);
  });
});
