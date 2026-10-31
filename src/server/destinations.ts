import type { RecordingDestination, RecordingService, ShownRecording } from '../shared/records.js';
import { parseYouTubeReference } from '../shared/youtube.js';

// Separate server-owned validators. A native provider-source redirect is a
// citation link, never a listening destination; a listening destination is an
// exact recording route, never a citation. Suggestion links are their own class.

const PROVIDER_SOURCE_HOST = 'vertexaisearch.cloud.google.com';
const PROVIDER_SOURCE_PATH = '/grounding-api-redirect/';

const parseStrictHttps = (raw: unknown, maxChars = 2048): URL | null => {
  if (typeof raw !== 'string' || raw.length > maxChars || !/^https:\/\//.test(raw) || /[\s\\]/.test(raw)) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '' || u.hash !== '') return null;
    return u;
  } catch {
    return null;
  }
};

/** Native Google grounding redirect (citation) URL, or null. */
export function validateProviderSourceUrl(raw: unknown): string | null {
  const u = parseStrictHttps(raw);
  if (!u || u.hostname !== PROVIDER_SOURCE_HOST || !u.pathname.startsWith(PROVIDER_SOURCE_PATH) || u.pathname.length <= PROVIDER_SOURCE_PATH.length) {
    return null;
  }
  return u.href;
}

export type ListeningDestination = RecordingDestination;

// ---------------------------------------------------------------------------
// Apple Music song destinations (docs/decisions/RECORDING_DESTINATIONS.md).
//   https://music.apple.com/{storefront}/song[/{slug}]/{trackId}
//   https://music.apple.com/{storefront}/album[/{slug}]/{albumId}?i={trackId}
// Exact host, HTTPS on the default port, no credentials or fragment, a two-letter
// lowercase storefront, canonical decimal IDs, no encoded separators and no
// other query parameter. Artist, album-only, playlist, search and every other
// route is refused. The canonical form is rebuilt from the storefront and track
// ID only, so it can never name a different recording.

export const APPLE_MUSIC_HOST = 'music.apple.com';
const STOREFRONT = /^[a-z]{2}$/;
/** Canonical positive decimal ID: no sign, no leading zero, at most 15 digits (a safe integer). */
const CATALOGUE_ID = /^[1-9][0-9]{0,14}$/;
/** Slug characters as Apple emits them; percent-encoded bytes allowed only if they decode and are not separators. */
const SLUG = /^[A-Za-z0-9._~%-]{1,200}$/;
const ENCODED_SEPARATOR = /%(?:2f|5c|3f|23|25|2e|00|0a|0d|09|20)/i;

const validSlug = (s: string) => {
  if (!SLUG.test(s) || ENCODED_SEPARATOR.test(s)) return false;
  try {
    return !/[/\\?#\u0000-\u001F\u007F]/.test(decodeURIComponent(s));
  } catch {
    return false;
  }
};

export const canonicalAppleSongUrl = (storefront: string, trackId: string) => `https://${APPLE_MUSIC_HOST}/${storefront}/song/${trackId}`;

/** Path segments of a raw URL string, read before any normalisation can hide a dot-segment or empty segment. */
function rawPathSegments(raw: string): string[] | null {
  const m = /^https:\/\/[^/?#]+(\/[^?#]*)?(?:\?[^#]*)?$/.exec(raw);
  if (!m) return null;
  const path = m[1] ?? '';
  if (path === '' || path === '/') return [];
  const segs = path.slice(1).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segs;
}

/**
 * The raw authority must be exactly the Apple Music host (hostname case aside),
 * checked on the string itself because URL parsing would silently normalise an
 * explicit default port, a percent-encoded host, a trailing dot or userinfo into
 * a passing value.
 */
const RAW_APPLE_AUTHORITY = /^https:\/\/music\.apple\.com(?=[/?]|$)/i;

/** Parses an Apple Music URL into its storefront and track ID, or null. `extraQuery` lists harmless parameters tolerated (track-view URLs only). Never throws. */
function parseAppleMusic(raw: unknown, extraQuery: ReadonlyMap<string, RegExp> = new Map()): { storefront: string; trackId: string } | null {
  if (typeof raw !== 'string' || !RAW_APPLE_AUTHORITY.test(raw)) return null;
  const u = parseStrictHttps(raw);
  if (!u || u.hostname !== APPLE_MUSIC_HOST) return null;
  const segs = rawPathSegments(raw);
  if (!segs || segs.length < 3 || segs.length > 4) return null;
  const [storefront, route, ...rest] = segs as [string, string, ...string[]];
  if (!STOREFRONT.test(storefront)) return null;
  const params = [...u.searchParams.entries()];
  const names = params.map(([k]) => k);
  if (new Set(names).size !== names.length) return null;
  for (const [k, v] of params) {
    if (k === 'i') continue;
    // A Map (own entries only): names such as __proto__ or toString are simply unsupported, never inherited.
    const allowed = extraQuery.get(k);
    if (allowed === undefined || !allowed.test(v)) return null;
  }
  const id = rest[rest.length - 1]!;
  const slug = rest.length === 2 ? rest[0]! : null;
  if (slug !== null && !validSlug(slug)) return null;
  if (!CATALOGUE_ID.test(id)) return null;
  const i = u.searchParams.get('i');
  if (route === 'song') {
    if (i !== null) return null;
    return { storefront, trackId: id };
  }
  if (route === 'album') {
    if (i === null || !CATALOGUE_ID.test(i) || i === id) return null;
    return { storefront, trackId: i };
  }
  return null;
}

/** Exact Apple Music song destination, rebuilt canonically from storefront and track ID; null otherwise. */
export function appleMusicDestination(raw: unknown): Extract<RecordingDestination, { kind: 'apple_music' }> | null {
  const p = parseAppleMusic(raw);
  return p ? { kind: 'apple_music', storefront: p.storefront, trackId: p.trackId, url: canonicalAppleSongUrl(p.storefront, p.trackId) } : null;
}

const TRACK_VIEW_QUERY: ReadonlyMap<string, RegExp> = new Map([['uo', /^[0-9]{1,3}$/]]);

/**
 * Identity named by a first-party track-view URL (as returned by Apple's lookup):
 * the same strict parse, additionally tolerating Apple's numeric `uo` tracking
 * parameter. Used only to compare against the requested destination, never fetched.
 */
export function appleTrackViewIdentity(raw: unknown): { storefront: string; trackId: string } | null {
  return parseAppleMusic(raw, TRACK_VIEW_QUERY);
}

/**
 * Exact supported listening destination for the enabled services only, rebuilt
 * canonically from its validated identity. A service outside `services` is
 * unsupported however well-formed its URL is; neither the model nor a client
 * can enable one.
 */
export function canonicalListeningDestination(raw: unknown, services: ReadonlySet<RecordingService> = YOUTUBE_ONLY): ListeningDestination | null {
  // (YOUTUBE_ONLY is module-private, so no caller can widen the default capability.)
  if (services.has('youtube')) {
    const parsed = parseYouTubeReference(raw);
    if (parsed.ok) return { kind: 'youtube', videoId: parsed.videoId, url: parsed.canonicalUrl };
  }
  if (services.has('apple_music')) return appleMusicDestination(raw);
  return null;
}

const YOUTUBE_ONLY: ReadonlySet<RecordingService> = new Set<RecordingService>(['youtube']);

/**
 * A stored or committed destination is authoritative only in its exact canonical
 * form: a known kind, valid identifiers and the URL rebuilt from exactly them.
 */
export function isCanonicalDestination(d: unknown): d is RecordingDestination {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (o.kind === 'youtube') {
    if (keys !== 'kind,url,videoId' || typeof o.videoId !== 'string' || typeof o.url !== 'string') return false;
    const yt = parseYouTubeReference(o.url);
    return yt.ok && yt.videoId === o.videoId && yt.canonicalUrl === o.url;
  }
  if (o.kind === 'apple_music') {
    if (keys !== 'kind,storefront,trackId,url' || typeof o.storefront !== 'string' || typeof o.trackId !== 'string') return false;
    return STOREFRONT.test(o.storefront) && CATALOGUE_ID.test(o.trackId) && o.url === canonicalAppleSongUrl(o.storefront, o.trackId);
  }
  return false;
}

/** Provider-scoped identifier of a destination (an Apple track ID is the same recording in every storefront). */
export const destinationKey = (d: RecordingDestination) => (d.kind === 'youtube' ? `youtube:${d.videoId}` : `apple_music:${d.trackId}`);

export const shownDestinationKey = (s: ShownRecording) => ('videoId' in s ? `youtube:${s.videoId}` : `apple_music:${s.appleTrackId}`);

/** The shown-recording entry for a displayed destination. */
export const shownRecordingFor = (key: string, d: RecordingDestination, title: string, credits: readonly string[]): ShownRecording =>
  d.kind === 'youtube' ? { key, videoId: d.videoId, title, credits: [...credits] } : { key, appleTrackId: d.trackId, title, credits: [...credits] };

/** Navigation target allowed inside the isolated Search Suggestions unit. */
export function validateSuggestionLink(raw: unknown): string | null {
  const u = parseStrictHttps(raw, 4096);
  if (!u || u.hostname !== 'www.google.com' || u.pathname !== '/search') return null;
  return u.href;
}

/** Static provider image (logo) allowed inside the isolated Search Suggestions unit: exactly the host SUGGESTIONS_CSP allows. */
export function validateSuggestionImage(raw: unknown): string | null {
  const u = parseStrictHttps(raw);
  if (!u || u.hostname !== 'www.gstatic.com') return null;
  return u.href;
}
