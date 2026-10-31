import type { RecordingDestination } from '../shared/records.js';
import { appleTrackViewIdentity, canonicalAppleSongUrl } from './destinations.js';
import type { VerifiedSeed } from './identity.js';
import { toQlooArtistId } from './providers/qloo.js';
import { safeGet, SafeFetchError, type FetchGap, type SafeFetchContext, type SafeFetchDeps, type SafeFetchPolicy } from './net/safe-fetch.js';
import { matchForm } from './recording-identity.js';

// Explicitly prepared candidate retrieval (docs/decisions/CANDIDATE_CATALOGUE.md); ordinary startup never selects it.
// - One server-built GET to Apple's public search API for one resolved Qloo
//   artist: exact host, /search path and every query key/value; no credentials,
//   no model/client URL, no retry, no redirect, no fallback.
// - Runs over the shared pinned DNS/address/body/deadline/budget guard.
// - Returns bounded catalogue SEARCH candidates only. A candidate is not a
//   TrackChoice, not verified by the first-party ID lookup, not native Google
//   grounding and not evidence of musical fit or audio character.
// - Preview, artwork, price and every other returned field are dropped and never fetched.
// - Nothing happens at import or construction; only search() performs a request.

export const APPLE_SEARCH_ORIGIN = 'https://itunes.apple.com';
export const APPLE_SEARCH_PATH = '/search';
export const APPLE_SEARCH_LIMIT = 6;
export const APPLE_SEARCH_MAX_BYTES = 32 * 1024;
export const APPLE_SEARCH_MAX_NAME_CHARS = 256;
const MAX_TEXT_CHARS = 300;
const STOREFRONT = /^[a-z]{2}$/;
const SAFE_CATALOGUE_ID = /^[1-9][0-9]{0,14}$/;
const UNCLEAN_TEXT = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

export const APPLE_SEARCH_SOURCE_KIND = 'first_party_catalogue_search_candidate';

export interface AppleCatalogueSearchRequest {
  /** Resolved Qloo artist; the name is the server-owned term and the identity the only relevance reference. */
  readonly artist: Pick<VerifiedSeed, 'entityId' | 'name'>;
  /** Server-owned lowercase two-letter storefront. */
  readonly storefront: string;
}

export interface AppleCatalogueSearchCandidate {
  readonly sourceKind: typeof APPLE_SEARCH_SOURCE_KIND;
  readonly title: string;
  readonly artistName: string;
  /** Canonical positive decimal catalogue track ID. */
  readonly trackId: string;
  readonly storefront: string;
  readonly destination: Extract<RecordingDestination, { kind: 'apple_music' }>;
}

export type AppleCandidateRejection =
  | 'not_song'
  | 'invalid_track_id'
  | 'destination_mismatch'
  | 'not_streamable'
  | 'invalid_text'
  | 'artist_mismatch'
  | 'duplicate_track_id';

export type AppleSearchUnavailableReason =
  | FetchGap
  | 'invalid_request'
  | 'throttled'
  | 'http_error'
  | 'malformed'
  | 'too_many_results'
  | 'no_results'
  | 'no_matching_candidates';

export type AppleCatalogueSearchOutcome =
  | {
      readonly status: 'candidates';
      readonly artist: { readonly entityId: string; readonly name: string };
      readonly storefront: string;
      readonly candidates: readonly AppleCatalogueSearchCandidate[];
      readonly rejected: readonly AppleCandidateRejection[];
    }
  | { readonly status: 'unavailable'; readonly reason: AppleSearchUnavailableReason };

export interface AppleCatalogueSearch {
  search(request: AppleCatalogueSearchRequest, ctx: SafeFetchContext): Promise<AppleCatalogueSearchOutcome>;
}

const cleanText = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' && v.length <= max && !UNCLEAN_TEXT.test(v) ? v.trim() : null);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const parseJson = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
};

/** The exact search URL for one artist term and storefront, or null for an invalid term/storefront. */
export function appleCatalogueSearchUrl(artistName: string, storefront: string): URL | null {
  const term = cleanText(artistName, APPLE_SEARCH_MAX_NAME_CHARS);
  if (term === null || matchForm(term) === '' || typeof storefront !== 'string' || !STOREFRONT.test(storefront)) return null;
  const url = new URL(APPLE_SEARCH_PATH, APPLE_SEARCH_ORIGIN);
  url.search = new URLSearchParams([
    ['term', term],
    ['attribute', 'artistTerm'],
    ['entity', 'song'],
    ['media', 'music'],
    ['country', storefront],
    ['limit', String(APPLE_SEARCH_LIMIT)],
  ]).toString();
  return url;
}

/**
 * Allows exactly the one built URL, once. The guard also asks this policy about
 * every redirect hop, so a redirect (even to the same URL) is refused and a
 * second Apple request can never be spent.
 */
function singleUsePolicy(url: URL): SafeFetchPolicy {
  let open = true;
  return {
    maxBytes: APPLE_SEARCH_MAX_BYTES,
    allow: (u) => {
      const ok = open && u.hostname === 'itunes.apple.com' && u.pathname === APPLE_SEARCH_PATH && u.href === url.href;
      open = false;
      return ok;
    },
  };
}

type Screened = { readonly candidate: AppleCatalogueSearchCandidate } | { readonly rejection: AppleCandidateRejection };

function screen(raw: Record<string, unknown>, storefront: string, artistKey: string): Screened {
  if (raw.wrapperType !== 'track' || raw.kind !== 'song') return { rejection: 'not_song' };
  const id = raw.trackId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !SAFE_CATALOGUE_ID.test(String(id))) return { rejection: 'invalid_track_id' };
  const trackId = String(id);
  const view = appleTrackViewIdentity(raw.trackViewUrl);
  if (!view || view.trackId !== trackId || view.storefront !== storefront) return { rejection: 'destination_mismatch' };
  if (raw.isStreamable !== true) return { rejection: 'not_streamable' };
  const title = cleanText(raw.trackName, MAX_TEXT_CHARS);
  const artistName = cleanText(raw.artistName, MAX_TEXT_CHARS);
  if (!title || !artistName) return { rejection: 'invalid_text' };
  if (matchForm(artistName) !== artistKey) return { rejection: 'artist_mismatch' };
  return {
    candidate: Object.freeze({
      sourceKind: APPLE_SEARCH_SOURCE_KIND,
      title,
      artistName,
      trackId,
      storefront,
      destination: Object.freeze({ kind: 'apple_music' as const, storefront, trackId, url: canonicalAppleSongUrl(storefront, trackId) }),
    }),
  };
}

export function createAppleCatalogueSearch(deps: SafeFetchDeps): AppleCatalogueSearch {
  const unavailable = (reason: AppleSearchUnavailableReason): AppleCatalogueSearchOutcome => ({ status: 'unavailable', reason });
  return {
    async search(request, ctx) {
      // Capture the complete provenance before awaiting untrusted I/O. Later
      // mutations of a caller-owned request cannot relabel another request's
      // response. A TypeScript identity type alone supplies no runtime proof.
      if (!isRecord(request) || !isRecord(request.artist)) return unavailable('invalid_request');
      const entityId = toQlooArtistId(request.artist.entityId);
      const name = cleanText(request.artist.name, APPLE_SEARCH_MAX_NAME_CHARS);
      const storefront = request.storefront;
      const url = name === null ? null : appleCatalogueSearchUrl(name, storefront);
      if (entityId === null || name === null || url === null) return unavailable('invalid_request');
      let res;
      try {
        res = await safeGet(deps, singleUsePolicy(url), url, ctx);
      } catch (err) {
        return unavailable(err instanceof SafeFetchError ? err.gap : 'unreachable');
      }
      if (res.status === 429 || res.status === 403) return unavailable('throttled');
      if (res.status !== 200) return unavailable('http_error');
      const json = parseJson(res.body);
      if (!isRecord(json) || !Array.isArray(json.results) || json.resultCount !== json.results.length) return unavailable('malformed');
      if (json.results.length > APPLE_SEARCH_LIMIT) return unavailable('too_many_results');
      if (json.results.length === 0) return unavailable('no_results');
      if (!json.results.every(isRecord)) return unavailable('malformed');

      const artistKey = matchForm(name);
      const candidates: AppleCatalogueSearchCandidate[] = [];
      const rejected: AppleCandidateRejection[] = [];
      const seen = new Set<string>();
      for (const raw of json.results as Record<string, unknown>[]) {
        const s = screen(raw, storefront, artistKey);
        if ('rejection' in s) rejected.push(s.rejection);
        else if (seen.has(s.candidate.trackId)) rejected.push('duplicate_track_id');
        else {
          seen.add(s.candidate.trackId);
          candidates.push(s.candidate);
        }
      }
      if (candidates.length === 0) return unavailable('no_matching_candidates');
      return {
        status: 'candidates',
        artist: Object.freeze({ entityId, name }),
        storefront,
        candidates: Object.freeze(candidates),
        rejected: Object.freeze(rejected),
      };
    },
  };
}
