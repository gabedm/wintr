import { describe, expect, it } from 'vitest';
import type { TrackChoice } from '../src/shared/records.js';
import {
  appleMusicDestination,
  appleTrackViewIdentity,
  canonicalListeningDestination,
  destinationKey,
  isCanonicalDestination,
  shownDestinationKey,
  shownRecordingFor,
} from '../src/server/destinations.js';
import { validateLiveBindings } from '../src/server/live-bindings.js';
import { gatedVerifier } from '../src/server/live-runtime.js';
import { recordingCapability } from '../src/server/native-catalogue.js';
import { createMetadataBudget, METADATA_HEADERS } from '../src/server/net/safe-fetch.js';
import { validRecord } from '../src/server/persistence/record-schema.js';
import { matchFirstPartyIdentity, matchRecordingIdentity } from '../src/server/recording-identity.js';
import { appleLookupUrl, createAppleMusicVerifier, createYouTubeVerifier, type DestinationVerifier } from '../src/server/verifier.js';
import { AID, appleResult, fakeNetwork, VID, type AppleEntry } from './fixtures/catalogue-fixtures.js';
import { binding } from './fixtures/live-fixtures.js';

// Apple Music destinations: strict URLs, explicit capability, first-party ID
// lookup and direct field identity. Every ID, title and artist is invented;
// no test touches the network or Apple.

const SONG = (sf = 'us', id = AID(1)) => `https://music.apple.com/${sf}/song/invented-song/${id}`;
const ctx = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 10_000, budget: createMetadataBudget() });
const BOTH = new Set(['youtube', 'apple_music'] as const);
const APPLE_ONLY = new Set(['apple_music'] as const);

describe('Apple Music destination URLs', () => {
  it('accepts exact song and album-with-track routes and rebuilds only that track and storefront', () => {
    expect(appleMusicDestination(SONG('us', AID(1)))).toEqual({ kind: 'apple_music', storefront: 'us', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}` });
    expect(appleMusicDestination(`https://music.apple.com/gb/song/${AID(2)}`)).toMatchObject({ storefront: 'gb', trackId: AID(2) });
    // Album route: the track is the `i` identifier, never the album ID.
    expect(appleMusicDestination(`https://music.apple.com/jp/album/invented-album/${AID(90)}?i=${AID(3)}`)).toEqual({
      kind: 'apple_music',
      storefront: 'jp',
      trackId: AID(3),
      url: `https://music.apple.com/jp/song/${AID(3)}`,
    });
    expect(appleMusicDestination(`https://music.apple.com/de/album/${AID(90)}?i=${AID(4)}`)).toMatchObject({ trackId: AID(4) });
    // Encoded non-separator characters in a slug are tolerated; the canonical URL drops the slug.
    expect(appleMusicDestination(`https://music.apple.com/fr/song/caf%C3%A9-invented/${AID(5)}`)).toMatchObject({ trackId: AID(5), url: `https://music.apple.com/fr/song/${AID(5)}` });
  });

  it.each([
    ['plain http', `http://music.apple.com/us/song/x/${AID(1)}`],
    ['port', `https://music.apple.com:8443/us/song/x/${AID(1)}`],
    ['userinfo', `https://user:pw@music.apple.com/us/song/x/${AID(1)}`],
    ['fragment', `https://music.apple.com/us/song/x/${AID(1)}#t=1`],
    ['lookalike suffix host', `https://music.apple.com.invalid/us/song/x/${AID(1)}`],
    ['lookalike prefix host', `https://evil-music.apple.com/us/song/x/${AID(1)}`],
    ['subdomain host', `https://www.music.apple.com/us/song/x/${AID(1)}`],
    ['host in path', `https://invalid.example/music.apple.com/us/song/x/${AID(1)}`],
    ['lookup host', `https://itunes.apple.com/us/song/x/${AID(1)}`],
    ['trailing-dot host', `https://music.apple.com./us/song/x/${AID(1)}`],
    ['uppercase storefront', `https://music.apple.com/US/song/x/${AID(1)}`],
    ['three-letter storefront', `https://music.apple.com/usa/song/x/${AID(1)}`],
    ['missing storefront', `https://music.apple.com/song/x/${AID(1)}`],
    ['artist page', `https://music.apple.com/us/artist/invented-artist/${AID(1)}`],
    ['playlist', `https://music.apple.com/us/playlist/invented/pl.u-abc123`],
    ['search', `https://music.apple.com/us/search?term=invented`],
    ['album only', `https://music.apple.com/us/album/invented-album/${AID(90)}`],
    ['duplicate track ids', `https://music.apple.com/us/album/x/${AID(90)}?i=${AID(1)}&i=${AID(2)}`],
    ['track id on a song route', `https://music.apple.com/us/song/x/${AID(1)}?i=${AID(2)}`],
    ['album id reused as track id', `https://music.apple.com/us/album/x/${AID(90)}?i=${AID(90)}`],
    ['extra query parameter', `https://music.apple.com/us/song/x/${AID(1)}?uo=4`],
    ['language parameter', `https://music.apple.com/us/album/x/${AID(90)}?i=${AID(1)}&l=en`],
    ['encoded slash in slug', `https://music.apple.com/us/song/a%2Fb/${AID(1)}`],
    ['encoded dot segment', `https://music.apple.com/us/song/%2e%2e/${AID(1)}`],
    ['dot segment', `https://music.apple.com/us/song/../album/x/${AID(90)}?i=${AID(1)}`],
    ['empty segment', `https://music.apple.com/us//song/${AID(1)}`],
    ['trailing slash', `https://music.apple.com/us/song/x/${AID(1)}/`],
    ['leading zero id', `https://music.apple.com/us/song/x/0${AID(1)}`],
    ['sixteen-digit id', `https://music.apple.com/us/song/x/1234567890123456`],
    ['encoded digits', `https://music.apple.com/us/song/x/%31%32%33`],
    ['non-numeric track', `https://music.apple.com/us/album/x/${AID(90)}?i=abc`],
    ['backslash', `https://music.apple.com/us/song\\x/${AID(1)}`],
    ['too many segments', `https://music.apple.com/us/song/a/b/${AID(1)}`],
    ['not a string', 12345],
  ])('rejects %s', (_label, raw) => {
    expect(appleMusicDestination(raw)).toBeNull();
    expect(canonicalListeningDestination(raw, BOTH)).toBeNull();
  });

  it('track-view identity tolerates only Apple\'s numeric uo marker, and still names one exact track', () => {
    expect(appleTrackViewIdentity(`https://music.apple.com/us/album/x/${AID(90)}?i=${AID(1)}&uo=4`)).toEqual({ storefront: 'us', trackId: AID(1) });
    expect(appleTrackViewIdentity(`https://music.apple.com/us/album/x/${AID(90)}?i=${AID(1)}&uo=x`)).toBeNull();
    expect(appleTrackViewIdentity(`https://music.apple.com/us/album/x/${AID(90)}?i=${AID(1)}&at=1`)).toBeNull();
    expect(appleTrackViewIdentity(`https://itunes.apple.com/us/album/x/${AID(90)}?i=${AID(1)}&uo=4`)).toBeNull();
  });

  it('stored destinations are authoritative only in exact canonical form', () => {
    expect(isCanonicalDestination({ kind: 'apple_music', storefront: 'us', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}` })).toBe(true);
    expect(isCanonicalDestination({ kind: 'youtube', videoId: VID(1), url: `https://www.youtube.com/watch?v=${VID(1)}` })).toBe(true);
    for (const bad of [
      { kind: 'apple_music', storefront: 'us', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(2)}` },
      { kind: 'apple_music', storefront: 'gb', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}` },
      { kind: 'apple_music', storefront: 'us', trackId: AID(1), url: SONG('us', AID(1)) },
      { kind: 'apple_music', storefront: 'us', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}`, videoId: VID(1) },
      // An Apple ID in a field that claims to be a video ID is never a valid YouTube destination.
      { kind: 'youtube', videoId: AID(1), url: `https://www.youtube.com/watch?v=${AID(1)}` },
      { kind: 'youtube', videoId: VID(1), url: `https://youtu.be/${VID(1)}` },
      { kind: 'spotify', id: 'x', url: 'https://invalid.example/' },
    ]) {
      expect(isCanonicalDestination(bad)).toBe(false);
    }
  });
});

describe('recording-service capability', () => {
  it('only an explicitly enabled service is a supported destination; the default is YouTube only', () => {
    const yt = `https://www.youtube.com/watch?v=${VID(1)}`;
    expect(canonicalListeningDestination(SONG())).toBeNull();
    expect(canonicalListeningDestination(SONG(), new Set(['youtube']))).toBeNull();
    expect(canonicalListeningDestination(SONG(), APPLE_ONLY)).toMatchObject({ kind: 'apple_music' });
    expect(canonicalListeningDestination(yt, APPLE_ONLY)).toBeNull();
    expect(canonicalListeningDestination(yt)).toMatchObject({ kind: 'youtube', videoId: VID(1) });
  });

  it('a catalogue capability must be known, unique and non-empty', () => {
    expect([...recordingCapability(undefined)]).toEqual(['youtube']);
    expect([...recordingCapability(['youtube', 'apple_music'])]).toEqual(['youtube', 'apple_music']);
    expect(() => recordingCapability([])).toThrow();
    expect(() => recordingCapability(['youtube', 'youtube'])).toThrow();
    expect(() => recordingCapability(['spotify' as never])).toThrow();
  });

  it('destination keys are provider-scoped: an Apple track is one key in every storefront, separate from video IDs', () => {
    const us = appleMusicDestination(SONG('us', AID(1)))!;
    const gb = appleMusicDestination(SONG('gb', AID(1)))!;
    expect(destinationKey(us)).toBe(destinationKey(gb));
    expect(destinationKey(us)).not.toBe(destinationKey({ kind: 'youtube', videoId: VID(1), url: `https://www.youtube.com/watch?v=${VID(1)}` }));
    const shown = shownRecordingFor('k', us, 'T', ['A']);
    expect(shown).toEqual({ key: 'k', appleTrackId: AID(1), title: 'T', credits: ['A'] });
    expect('videoId' in shown).toBe(false);
    expect(shownDestinationKey(shown)).toBe(destinationKey(gb));
  });
});

describe('live binding: recordingServices', () => {
  const validate = (o: Record<string, unknown>) => validateLiveBindings(binding(o), Date.now());

  it('absent means YouTube only; an explicit list may enable Apple Music', () => {
    const absent = validate({});
    expect(absent.ok && absent.bindings.recordingServices).toEqual(['youtube']);
    const both = validate({ recordingServices: ['youtube', 'apple_music'] });
    expect(both.ok && both.bindings.recordingServices).toEqual(['youtube', 'apple_music']);
    const apple = validate({ recordingServices: ['apple_music'] });
    expect(apple.ok && apple.bindings.recordingServices).toEqual(['apple_music']);
  });

  it.each([
    ['empty list', [], 'recordingServices:empty'],
    ['duplicate', ['youtube', 'youtube'], 'recordingServices:duplicate'],
    ['unknown service', ['youtube', 'spotify'], 'recordingServices:unknown'],
    ['case variant', ['Apple_Music'], 'recordingServices:unknown'],
    ['not a list', 'apple_music', 'recordingServices:invalid'],
    ['null', null, 'recordingServices:invalid'],
    ['object', { apple_music: true }, 'recordingServices:invalid'],
    ['non-string entry', [1], 'recordingServices:unknown'],
  ])('fails closed on %s', (_label, value, problem) => {
    const r = validate({ recordingServices: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toContain(problem);
  });

  it('snapshots the list before returning: later mutation of the caller\'s array cannot enable a service', () => {
    const list: string[] = ['youtube'];
    const r = validate({ recordingServices: list });
    list.push('apple_music');
    list[0] = 'apple_music';
    expect(r.ok && r.bindings.recordingServices).toEqual(['youtube']);
    expect(r.ok && Object.isFrozen(r.bindings.recordingServices)).toBe(true);
    if (r.ok) expect(() => (r.bindings.recordingServices as string[]).push('apple_music')).toThrow();
  });
});

describe('Apple first-party lookup verifier', () => {
  const dest = (sf = 'us', id = AID(1)) => appleMusicDestination(SONG(sf, id))!;
  const verify = async (apple: Record<string, AppleEntry>, d = dest(), dns: Record<string, string[]> = {}) => {
    const net = fakeNetwork({}, dns, apple);
    const v = createAppleMusicVerifier({ resolve: net.resolve, http: net.http, now: Date.now });
    return { result: await v.lookup(d, ctx()), net };
  };

  it('makes one fixed, code-constructed, credential-free request and returns the separate first-party fields', async () => {
    const { result, net } = await verify({ [AID(1)]: { trackName: 'Invented Song', artistName: 'Neighbour X11' } }, dest('gb'));
    expect(result).toEqual({ ok: true, metadata: { kind: 'apple_music', trackId: AID(1), storefront: 'gb', trackName: 'Invented Song', artistName: 'Neighbour X11' } });
    expect(net.requests).toHaveLength(1);
    const req = net.requests[0]!;
    expect(req.url.href).toBe(`https://itunes.apple.com/lookup?id=${AID(1)}&country=gb&entity=song`);
    expect(req.url.href).toBe(appleLookupUrl(AID(1), 'gb').href);
    expect(req.headers).toEqual(METADATA_HEADERS);
    expect(Object.keys(req.headers).join(',')).not.toMatch(/auth|cookie|key|goog/i);
    expect(req.maxBytes).toBe(32 * 1024);
    // The preview and artwork URLs in the answer are never fetched.
    expect(net.requests.every((r) => r.url.hostname === 'itunes.apple.com')).toBe(true);
  });

  it.each<[string, AppleEntry, string]>([
    ['another track id', { trackName: 'X', artistName: 'Y', trackId: Number(AID(2)) }, 'destination_mismatch'],
    ['a string track id', { trackName: 'X', artistName: 'Y', trackId: AID(1) }, 'destination_mismatch'],
    ['a collection result', { trackName: 'X', artistName: 'Y', wrapperType: 'collection' }, 'destination_mismatch'],
    ['a music video', { trackName: 'X', artistName: 'Y', kind: 'music-video' }, 'destination_mismatch'],
    ['another storefront in the track-view URL', { trackName: 'X', artistName: 'Y', storefront: 'gb' }, 'destination_mismatch'],
    ['a track-view URL for another track', { trackName: 'X', artistName: 'Y', trackViewUrl: `https://music.apple.com/us/album/x/${AID(90)}?i=${AID(2)}&uo=4` }, 'destination_mismatch'],
    ['a foreign track-view host', { trackName: 'X', artistName: 'Y', trackViewUrl: `https://invalid.example/us/album/x/${AID(90)}?i=${AID(1)}` }, 'destination_mismatch'],
    ['a missing track-view URL', { trackName: 'X', artistName: 'Y', trackViewUrl: null }, 'destination_mismatch'],
    ['a non-streamable track', { trackName: 'X', artistName: 'Y', isStreamable: false }, 'destination_unavailable'],
    ['a missing streamable flag', { trackName: 'X', artistName: 'Y', isStreamable: null }, 'destination_unavailable'],
    ['a control character', { trackName: 'Invented\u0007Song', artistName: 'Y' }, 'metadata_unreadable'],
    ['an empty artist', { trackName: 'X', artistName: '  ' }, 'metadata_unreadable'],
    ['an oversized title field', { trackName: 'x'.repeat(301), artistName: 'Y' }, 'metadata_unreadable'],
    ['throttling', { status: 429 }, 'metadata_throttled'],
    ['a forbidden answer', { status: 403 }, 'metadata_throttled'],
    ['not found', { status: 404 }, 'destination_unavailable'],
    ['a server error', { status: 503 }, 'metadata_unreadable'],
    ['malformed JSON', { raw: '{"resultCount":1,' }, 'metadata_unreadable'],
    ['invalid UTF-8', { raw: new Uint8Array([0x7b, 0xff, 0x7d]) }, 'metadata_unreadable'],
    ['an oversize body', { raw: `{"pad":"${'x'.repeat(33 * 1024)}"}` }, 'metadata_unreadable'],
    ['a count that disagrees', { results: [], resultCount: 1 }, 'metadata_unreadable'],
    ['two results', { results: [appleResult(AID(1), { trackName: 'X', artistName: 'Y' }, 'us'), appleResult(AID(1), { trackName: 'X', artistName: 'Y' }, 'us')] }, 'destination_mismatch'],
    ['a redirect elsewhere', { redirect: 'https://invalid.example/lookup' }, 'unsafe_redirect'],
  ])('refuses %s', async (_label, entry, gap) => {
    const { result, net } = await verify({ [AID(1)]: entry });
    expect(result).toEqual({ ok: false, gap, ...(['metadata_throttled', 'metadata_unreadable', 'unsafe_redirect'].includes(gap) ? { operational: true } : {}) });
    // Never retried, never a second fetch of anything returned.
    expect(net.requests.filter((r) => r.url.hostname !== 'itunes.apple.com')).toEqual([]);
    expect(net.requests.length).toBeLessThanOrEqual(1);
  });

  it('an empty lookup (no such track) is an unavailable destination, not a fallback', async () => {
    const { result } = await verify({});
    expect(result).toEqual({ ok: false, gap: 'destination_unavailable' });
  });

  it('retains safe optional artwork only after exact lookup identity passes, without fetching an image or preview', async () => {
    const image = 'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg';
    for (const url of [image, 'https://outside.invalid/image.jpg']) {
      const row = { ...appleResult(AID(1), { trackName: 'Invented Song', artistName: 'Neighbour X11' }, 'us'), artworkUrl100: url };
      const { result, net } = await verify({ [AID(1)]: { results: [row] } });
      expect(result.ok).toBe(true);
      if (result.ok && result.metadata.kind === 'apple_music') expect(result.metadata.artwork).toEqual(url === image ? { url, storeUrl: row.trackViewUrl } : undefined);
      expect(net.requests).toHaveLength(1); expect(net.requests[0]!.url.hostname).toBe('itunes.apple.com');
    }
  });

  it('refuses private addresses and never verifies a YouTube destination', async () => {
    const { result, net } = await verify({ [AID(1)]: { trackName: 'X', artistName: 'Y' } }, dest(), { 'itunes.apple.com': ['10.0.0.8'] });
    expect(result).toEqual({ ok: false, gap: 'unsafe_address', operational: true });
    expect(net.requests).toHaveLength(0);
    const v = createAppleMusicVerifier({ resolve: net.resolve, http: net.http, now: Date.now });
    expect(await v.lookup({ kind: 'youtube', videoId: VID(1), url: `https://www.youtube.com/watch?v=${VID(1)}` }, ctx())).toEqual({ ok: false, gap: 'unsupported_destination' });
    const yt = createYouTubeVerifier({ resolve: net.resolve, http: net.http, now: Date.now });
    expect(await yt.lookup(dest(), ctx())).toEqual({ ok: false, gap: 'unsupported_destination' });
    expect(net.requests).toHaveLength(0);
  });

  it('a lapsed binding gate makes no metadata request at all', async () => {
    const net = fakeNetwork({}, {}, { [AID(1)]: { trackName: 'X', artistName: 'Y' } });
    // One clock for the gate and the fetch guard, as in the composed runtime.
    const clock = { t: Date.now() };
    const until = clock.t + 1_000;
    const v: DestinationVerifier = gatedVerifier(createAppleMusicVerifier({ resolve: net.resolve, http: net.http, now: () => clock.t }), until, () => clock.t);
    const live = () => ({ signal: new AbortController().signal, deadlineAt: clock.t + 10_000, budget: createMetadataBudget() });
    expect((await v.lookup(dest(), live())).ok).toBe(true);
    clock.t = until;
    expect(await v.lookup(dest(), live())).toEqual({ ok: false, gap: 'destination_unavailable' });
    clock.t = Number.NaN;
    expect(await v.lookup(dest(), live())).toEqual({ ok: false, gap: 'destination_unavailable' });
    expect(net.requests).toHaveLength(1);
  });
});

describe('direct first-party identity', () => {
  const fp = (title: string, artists: string[], trackName: string, artistName: string, anchor = artists[0]!) => matchFirstPartyIdentity({ title, artists }, anchor, { trackName, artistName });

  it('matches exact title and full credits from separate fields, with feature credits from the track name', () => {
    expect(fp('Invented Song', ['Neighbour X11'], 'Invented Song', 'Neighbour X11')).toMatchObject({ ok: true, credits: ['Neighbour X11'], versions: [] });
    expect(fp('Invented Duet', ['Neighbour X11', 'Guest Y'], 'Invented Duet', 'Neighbour X11 & Guest Y')).toMatchObject({ ok: true });
    expect(fp('Invented Duet', ['Neighbour X11', 'Guest Y', 'Guest Z'], 'Invented Duet', 'Neighbour X11, Guest Y & Guest Z')).toMatchObject({ ok: true });
    expect(fp('Invented Duet', ['Neighbour X11', 'Guest Y'], 'Invented Duet (feat. Guest Y)', 'Neighbour X11')).toMatchObject({ ok: true });
    expect(fp('Invented Song (Live)', ['Neighbour X11'], 'Invented Song (Live)', 'Neighbour X11')).toMatchObject({ ok: true, versions: ['live'] });
    expect(fp('Invented Song', ['Neighbour X11'], 'Invented Song (Explicit)', 'Neighbour X11')).toMatchObject({ ok: true, versions: [] });
  });

  it.each([
    ['an undeclared feature credit', 'Invented Song', ['Neighbour X11'], 'Invented Song (feat. Guest Y)', 'Neighbour X11', 'credits_extra'],
    ['an undeclared co-artist', 'Invented Song', ['Neighbour X11'], 'Invented Song', 'Neighbour X11 & Guest Y', 'credits_extra'],
    ['a declared credit missing', 'Invented Song', ['Neighbour X11', 'Guest Y'], 'Invented Song', 'Neighbour X11', 'credits_unconfirmed'],
    ['a live version for the studio proposal', 'Invented Song', ['Neighbour X11'], 'Invented Song (Live)', 'Neighbour X11', 'version_mismatch'],
    ['a dashed remaster tail', 'Invented Song', ['Neighbour X11'], 'Invented Song - Remastered 2011', 'Neighbour X11', 'version_mismatch'],
    ['the studio recording for a live proposal', 'Invented Song (Live)', ['Neighbour X11'], 'Invented Song', 'Neighbour X11', 'version_mismatch'],
    ['a longer title', 'Invented Song', ['Neighbour X11'], 'Invented Song Two', 'Neighbour X11', 'title_mismatch'],
    ['a title substring', 'Invented Song Two', ['Neighbour X11'], 'Invented Song', 'Neighbour X11', 'title_mismatch'],
    ['a namesake without the anchor', 'Invented Song', ['Neighbour X11'], 'Invented Song', 'Neighbour X111', 'anchor_not_credited'],
    ['a cover', 'Invented Song', ['Neighbour X11'], 'Invented Song (Karaoke Version)', 'Neighbour X11', 'uncertain_identity'],
    // The artist cannot be read out of the title: no "Artist - Title" interpretation of a first-party track name.
    ['a credit only in the title', 'Invented Song', ['Neighbour X11'], 'Neighbour X11 - Invented Song', 'Various Artists', 'title_mismatch'],
  ])('rejects %s', (_label, title, artists, trackName, artistName, gap) => {
    expect(fp(title, artists, trackName, artistName)).toEqual({ ok: false, gap });
  });

  it('one recording has one key across an upload and the first-party catalogue', () => {
    const apple = fp('Invented Duet', ['Neighbour X11', 'Guest Y'], 'Invented Duet', 'Neighbour X11 & Guest Y');
    const upload = matchRecordingIdentity({ title: 'Invented Duet', artists: ['Guest Y', 'Neighbour X11'] }, 'Neighbour X11', { title: 'Neighbour X11 & Guest Y - Invented Duet (Official Audio)', channelName: 'Neighbour X11' });
    expect(apple.ok && upload.ok).toBe(true);
    if (apple.ok && upload.ok) expect(apple.recordingKey).toBe(upload.recordingKey);
    const live = fp('Invented Duet (Live)', ['Neighbour X11', 'Guest Y'], 'Invented Duet (Live)', 'Neighbour X11 & Guest Y');
    if (apple.ok && live.ok) expect(live.recordingKey).not.toBe(apple.recordingKey);
  });
});

describe('persisted panel schema with Apple destinations', () => {
  const H = (s: string) => s.padEnd(24, '0');
  const ctxR = { sessionId: H('session'), epoch: 1, sessionExpiresAt: 10_000 };
  const appleChoice: TrackChoice = {
    handle: H('choiceapple') as never,
    title: 'Invented Song',
    credits: ['Neighbour X11'],
    unverifiedCredits: 0,
    anchor: { handle: H('anchor11') as never, name: 'Neighbour X11' },
    recordingKey: 'invented song|neighbour x11|',
    destination: { kind: 'apple_music', storefront: 'us', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}` },
    fitHypothesis: 'It may keep the groove.',
    evidence: { kind: 'native_identity_support_plus_first_party_metadata', service: 'apple_music', creditSource: 'first_party_artist_field', artistName: 'Neighbour X11', versions: [] },
    sources: [0],
  };
  const youtubeChoice: TrackChoice = {
    ...appleChoice,
    handle: H('choiceyt') as never,
    recordingKey: 'other song|neighbour x12|',
    destination: { kind: 'youtube', videoId: VID(1), url: `https://www.youtube.com/watch?v=${VID(1)}` },
    evidence: { kind: 'native_identity_support_plus_exact_metadata', creditSource: 'title', channelName: 'Neighbour X12', topicChannel: false, versions: [] },
  };
  const panel = (choices: unknown[]) => ({
    sessionId: ctxR.sessionId,
    epoch: 1,
    createdAt: 1,
    expiresAt: 5_000,
    id: H('panel'),
    journeyId: H('journey'),
    briefId: H('brief'),
    briefVersion: 1,
    planId: H('plan'),
    poolId: H('pool'),
    attemptId: H('attempt'),
    synthetic: false,
    outcome: choices.length > 0 ? 'choices' : 'no_match',
    choices,
    gaps: [{ reason: 'metadata_throttled', count: 1 }, { reason: 'destination_mismatch', count: 2 }],
    recordingKeys: choices.map((c) => (c as TrackChoice).recordingKey),
  });
  const valid = (choices: unknown[]) => validRecord('panel', panel(choices), H('panel'), ctxR);

  it('decodes existing YouTube choices unchanged and the new Apple variant, with the new gaps', () => {
    expect(valid([youtubeChoice])).toBe(true);
    expect(valid([appleChoice, youtubeChoice])).toBe(true);
  });

  it('decodes an optional exact-track display pair and refuses cross-recording artwork', () => {
    const artwork = { url: 'https://is1-ssl.mzstatic.com/image/thumb/Music001/v4/invented/100x100bb.jpg', storeUrl: appleChoice.destination.url };
    expect(valid([{ ...appleChoice, artwork }])).toBe(true);
    expect(valid([{ ...youtubeChoice, artwork }])).toBe(false);
    expect(valid([{ ...appleChoice, artwork: { ...artwork, storeUrl: `https://music.apple.com/us/song/${AID(2)}` } }])).toBe(false);
  });

  it.each([
    ['Apple evidence on a YouTube link', { ...youtubeChoice, evidence: appleChoice.evidence }],
    ['YouTube evidence on an Apple link', { ...appleChoice, evidence: youtubeChoice.evidence }],
    ['a non-canonical Apple URL', { ...appleChoice, destination: { ...appleChoice.destination, url: SONG('us', AID(1)) } }],
    ['an Apple URL for another track', { ...appleChoice, destination: { ...appleChoice.destination, url: `https://music.apple.com/us/song/${AID(2)}` } }],
    ['an Apple ID stashed in videoId', { ...appleChoice, destination: { kind: 'youtube', videoId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}` } }],
    ['an extra destination field', { ...appleChoice, destination: { ...appleChoice.destination, previewUrl: 'https://invalid.example/p.m4a' } }],
    ['an unknown destination kind', { ...appleChoice, destination: { kind: 'other', url: 'https://invalid.example/' } }],
    ['an empty first-party artist', { ...appleChoice, evidence: { ...appleChoice.evidence, artistName: '' } }],
    ['an invented credit source', { ...appleChoice, evidence: { ...appleChoice.evidence, creditSource: 'uploader_name' } }],
  ])('refuses %s', (_label, choice) => {
    expect(valid([choice])).toBe(false);
  });

  it('plan exclusions decode legacy YouTube entries and Apple entries, and nothing else', () => {
    const shown = (entries: unknown[]) => ({
      sessionId: ctxR.sessionId,
      epoch: 1,
      createdAt: 1,
      expiresAt: 5_000,
      id: H('plan'),
      journeyId: H('journey'),
      briefId: H('brief'),
      briefVersion: 2,
      poolId: H('pool'),
      relationship: 'the groove',
      seedNames: ['Generic Artist'],
      anchors: [{ handle: H('anchor11'), name: 'Neighbour X11' }],
      associations: [],
      exclusions: [],
      recordingExclusions: { shown: entries, known: [] },
      priorities: [],
      refinementMode: 'correct_direction',
      refinement: { followed: null, keptStarting: null, replaced: [], excludedArtists: [], relationshipChanged: false, fromPanelId: H('panel') },
      attribution: 'seed_mix',
      provenance: { analysisId: H('analysis'), analysisReuse: 'same_source_focus', poolSourceBriefId: H('brief'), poolReuse: 'reused_same_fingerprint' },
    });
    const ok = (entries: unknown[]) => validRecord('plan', shown(entries), H('plan'), ctxR);
    expect(ok([{ key: 'k1', videoId: VID(1), title: 'T', credits: ['A'] }])).toBe(true);
    expect(ok([{ key: 'k2', appleTrackId: AID(1), title: 'T', credits: ['A'] }])).toBe(true);
    expect(ok([{ key: 'k3', videoId: AID(1), title: 'T', credits: ['A'] }])).toBe(false);
    expect(ok([{ key: 'k4', appleTrackId: VID(1), title: 'T', credits: ['A'] }])).toBe(false);
    expect(ok([{ key: 'k5', videoId: VID(1), appleTrackId: AID(1), title: 'T', credits: ['A'] }])).toBe(false);
  });
});

describe('H1 corrections: raw authority, inherited query names, validity-bounded deadline', () => {
  const VIEW = (suffix: string) => `https://music.apple.com/us/album/x/${AID(90)}?i=${AID(1)}${suffix}`;

  it.each([
    ['__proto__', '?__proto__=x'],
    ['toString', '?toString=x'],
    ['constructor', '?constructor=x'],
    ['hasOwnProperty', '?hasOwnProperty=x'],
    ['valueOf', '?valueOf=x'],
    ['__defineGetter__', '?__defineGetter__=x'],
  ])('a song URL with the inherited name %s is rejected, never thrown', (_name, query) => {
    const raw = `https://music.apple.com/us/song/x/${AID(1)}${query}`;
    expect(() => appleMusicDestination(raw)).not.toThrow();
    expect(appleMusicDestination(raw)).toBeNull();
    expect(canonicalListeningDestination(raw, BOTH)).toBeNull();
    // An album-with-track proposal and a first-party track-view URL behave the same way.
    const album = VIEW(`&${query.slice(1)}`);
    expect(() => appleMusicDestination(album)).not.toThrow();
    expect(appleMusicDestination(album)).toBeNull();
    expect(() => appleTrackViewIdentity(album)).not.toThrow();
    expect(appleTrackViewIdentity(album)).toBeNull();
    expect(appleTrackViewIdentity(VIEW(`&uo=4&${query.slice(1)}`))).toBeNull();
  });

  it('a track-view URL with an inherited name is a destination mismatch in the verifier, not an exception', async () => {
    for (const name of ['__proto__', 'toString', 'constructor']) {
      const net = fakeNetwork({}, {}, { [AID(1)]: { trackName: 'X', artistName: 'Y', trackViewUrl: VIEW(`&${name}=x`) } });
      const v = createAppleMusicVerifier({ resolve: net.resolve, http: net.http, now: Date.now });
      expect(await v.lookup(appleMusicDestination(SONG())!, ctx())).toEqual({ ok: false, gap: 'destination_mismatch' });
    }
  });

  it('supported parameters are unchanged: i on an album route, and a numeric uo only on a track-view URL', () => {
    expect(appleMusicDestination(VIEW(''))).toMatchObject({ trackId: AID(1) });
    expect(appleTrackViewIdentity(VIEW('&uo=4'))).toEqual({ storefront: 'us', trackId: AID(1) });
    expect(appleMusicDestination(VIEW('&uo=4'))).toBeNull();
    expect(appleTrackViewIdentity(VIEW('&uo=x'))).toBeNull();
  });

  it.each([
    ['explicit default port', `https://music.apple.com:443/us/song/x/${AID(1)}`],
    ['empty port', `https://music.apple.com:/us/song/x/${AID(1)}`],
    ['percent-encoded host letter', `https://music.%61pple.com/us/song/x/${AID(1)}`],
    ['percent-encoded dot', `https://music%2eapple.com/us/song/x/${AID(1)}`],
    ['percent-encoded host start', `https://%6dusic.apple.com/us/song/x/${AID(1)}`],
    ['trailing dot', `https://music.apple.com./us/song/x/${AID(1)}`],
    ['userinfo', `https://u@music.apple.com/us/song/x/${AID(1)}`],
    ['userinfo that looks like the host', `https://music.apple.com@invalid.example/us/song/x/${AID(1)}`],
    ['host followed by a colon trick', `https://music.apple.com:@invalid.example/us/song/x/${AID(1)}`],
    ['fullwidth lookalike host', `https://music.apple.com/us/song/x/${AID(1)}`.replace('music', 'ｍusic')],
    ['query straight after host (no path)', `https://music.apple.com?x=1/us/song/x/${AID(1)}`],
  ])('rejects a raw authority with %s, also as a track-view URL', (_label, raw) => {
    expect(appleMusicDestination(raw)).toBeNull();
    expect(appleTrackViewIdentity(raw)).toBeNull();
    expect(canonicalListeningDestination(raw, BOTH)).toBeNull();
  });

  it('hostname letter case is still equivalent, and legitimate song and album-with-track links keep their canonical IDs', () => {
    expect(appleMusicDestination(`https://MUSIC.Apple.COM/us/song/x/${AID(1)}`)).toEqual({ kind: 'apple_music', storefront: 'us', trackId: AID(1), url: `https://music.apple.com/us/song/${AID(1)}` });
    expect(appleMusicDestination(`https://music.apple.com/us/album/invented/${AID(90)}?i=${AID(2)}`)).toMatchObject({ trackId: AID(2) });
    expect(appleMusicDestination(`https://music.apple.com/gb/song/${AID(3)}`)).toMatchObject({ storefront: 'gb', trackId: AID(3) });
    expect(appleTrackViewIdentity(`https://music.apple.com/us/album/invented/${AID(90)}?i=${AID(2)}&uo=4`)).toEqual({ storefront: 'us', trackId: AID(2) });
  });

  describe('the metadata operation cannot outlive the binding/exposure validity', () => {
    /** DNS advances the injected clock while pending, like a slow lookup. */
    function slowDns(advanceMs: number, validForMs: number, opts: { operationMs?: number; gate?: boolean } = {}) {
      const clock = { t: 1_000_000 };
      const net = fakeNetwork({}, {}, { [AID(1)]: { trackName: 'Invented Song', artistName: 'Neighbour X11' } });
      const resolve = async () => {
        clock.t += advanceMs;
        return ['142.250.1.1'];
      };
      const inner = createAppleMusicVerifier({ resolve, http: net.http, now: () => clock.t });
      const verifier = gatedVerifier(inner, clock.t + validForMs, () => clock.t);
      const signal = new AbortController();
      const context = { signal: signal.signal, deadlineAt: clock.t + (opts.operationMs ?? 10_000), budget: createMetadataBudget() };
      return { clock, net, verifier, signal, context };
    }

    it('expiry while DNS is pending means zero HTTP, however generous the operation deadline', async () => {
      const t = slowDns(200, 100);
      expect(await t.verifier.lookup(appleMusicDestination(SONG())!, t.context)).toEqual({ ok: false, gap: 'deadline', operational: true });
      expect(t.net.requests).toHaveLength(0);
    });

    it('control: validity that outlasts the DNS wait lets the one ordinary request through', async () => {
      const t = slowDns(50, 5_000);
      const r = await t.verifier.lookup(appleMusicDestination(SONG())!, t.context);
      expect(r.ok).toBe(true);
      expect(t.net.requests).toHaveLength(1);
    });

    it('validity never extends the execute deadline: an operation deadline that lapses in DNS also means zero HTTP', async () => {
      const t = slowDns(200, 1_000_000, { operationMs: 100 });
      expect(await t.verifier.lookup(appleMusicDestination(SONG())!, t.context)).toEqual({ ok: false, gap: 'deadline', operational: true });
      expect(t.net.requests).toHaveLength(0);
    });

    it('Stop during DNS still ends the operation before any HTTP', async () => {
      const t = slowDns(10, 5_000);
      const clock = t.clock;
      const net = fakeNetwork({}, {}, { [AID(1)]: { trackName: 'X', artistName: 'Y' } });
      const stop = new AbortController();
      const inner = createAppleMusicVerifier({
        resolve: async () => {
          stop.abort();
          return ['142.250.1.1'];
        },
        http: net.http,
        now: () => clock.t,
      });
      const v = gatedVerifier(inner, clock.t + 5_000, () => clock.t);
      expect(await v.lookup(appleMusicDestination(SONG())!, { signal: stop.signal, deadlineAt: clock.t + 10_000, budget: createMetadataBudget() })).toEqual({ ok: false, gap: 'deadline', operational: true });
      expect(net.requests).toHaveLength(0);
    });

    it('the same bound applies to the YouTube verifier, and a lapse before the call still makes no request', async () => {
      const clock = { t: 1_000_000 };
      const net = fakeNetwork({ [VID(1)]: { title: 'Neighbour X11 - Invented Song', author_name: 'Neighbour X11' } });
      const resolve = async () => {
        clock.t += 200;
        return ['142.250.1.1'];
      };
      const v = gatedVerifier(createYouTubeVerifier({ resolve, http: net.http, now: () => clock.t }), clock.t + 100, () => clock.t);
      const yt = { kind: 'youtube' as const, videoId: VID(1), url: `https://www.youtube.com/watch?v=${VID(1)}` };
      expect(await v.lookup(yt, { signal: new AbortController().signal, deadlineAt: clock.t + 10_000, budget: createMetadataBudget() })).toEqual({ ok: false, gap: 'deadline' });
      expect(net.requests).toHaveLength(0);
      expect(await v.lookup(yt, { signal: new AbortController().signal, deadlineAt: clock.t + 10_000, budget: createMetadataBudget() })).toEqual({ ok: false, gap: 'destination_unavailable' });
      expect(net.requests).toHaveLength(0);
    });
  });
});
