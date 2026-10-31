import type { CandidateGap } from '../shared/records.js';
import { appleTrackViewIdentity, type ListeningDestination } from './destinations.js';
import { appleArtwork, type AppleArtwork } from '../shared/apple-artwork.js';
import { safeGet, SafeFetchError, type SafeFetchContext, type SafeFetchDeps, type SafeFetchPolicy } from './net/safe-fetch.js';

// Deterministic recording metadata for exact destinations.
// - YouTube: the public oEmbed route (title and channel only). It establishes
//   that the exact video exists and what it is titled/uploaded as; never, on its
//   own, proof of official identity or credits.
// - Apple Music: Apple's first-party ID lookup, constructed in code from the
//   validated track ID and storefront only (no model URL is ever fetched). It
//   returns separate track-name and artist fields for that exact catalogue track.
// Both run over the same pinned/DNS/address/redirect/body/deadline/budget guard,
// send no credentials and never fetch media, previews or artwork.

export interface YouTubeMetadata {
  readonly kind?: 'youtube';
  readonly videoId: string;
  readonly title: string;
  readonly channelName: string;
}

export interface AppleMusicMetadata {
  readonly kind: 'apple_music';
  readonly trackId: string;
  readonly storefront: string;
  readonly trackName: string;
  readonly artistName: string;
  readonly artwork?: AppleArtwork;
}

export type RecordingMetadata = YouTubeMetadata | AppleMusicMetadata;

export type MetadataResult = { readonly ok: true; readonly metadata: RecordingMetadata } | {
  readonly ok: false;
  readonly gap: CandidateGap;
  /** Internal outcome only: the check could not complete, rather than a completed missing/unsupported recording. Never projected. */
  readonly operational?: true;
};

export interface DestinationVerifier {
  /** True when backed by the labelled local fixture rather than the network. */
  readonly synthetic: boolean;
  lookup(destination: ListeningDestination, ctx: SafeFetchContext): Promise<MetadataResult>;
}

const OEMBED_HOSTS = new Set(['www.youtube.com', 'youtube.com']);

export const YOUTUBE_METADATA_POLICY: SafeFetchPolicy = {
  allow: (u) => OEMBED_HOSTS.has(u.hostname) && u.pathname === '/oembed',
  maxBytes: 32 * 1024,
};

/** The single first-party lookup route; a redirect anywhere else is refused by the fetch guard. */
export const APPLE_LOOKUP_ORIGIN = 'https://itunes.apple.com';
export const APPLE_METADATA_POLICY: SafeFetchPolicy = {
  allow: (u) => u.hostname === 'itunes.apple.com' && u.pathname === '/lookup',
  maxBytes: 32 * 1024,
};

const GAP: Record<SafeFetchError['gap'], CandidateGap> = {
  unsafe_redirect: 'unsafe_redirect',
  too_many_redirects: 'unsafe_redirect',
  unsafe_address: 'unsafe_address',
  unreachable: 'destination_unavailable',
  oversize: 'metadata_unreadable',
  deadline: 'deadline',
  // Stop/Clear: the execute is revoked and this result is never committed.
  aborted: 'deadline',
  metadata_cap: 'metadata_cap',
};

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\u0000-\u001F\u007F]/.test(v) ? v.trim() : null);

const parseJson = (body: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function fetchMetadata(deps: SafeFetchDeps, policy: SafeFetchPolicy, url: URL, ctx: SafeFetchContext) {
  try {
    return { ok: true as const, res: await safeGet(deps, policy, url, ctx) };
  } catch (err) {
    return { ok: false as const, gap: err instanceof SafeFetchError ? GAP[err.gap] : ('destination_unavailable' as CandidateGap) };
  }
}

export function createYouTubeVerifier(deps: SafeFetchDeps, synthetic = false): DestinationVerifier {
  return {
    synthetic,
    async lookup(destination, ctx) {
      if (destination.kind !== 'youtube') return { ok: false, gap: 'unsupported_destination' };
      const url = new URL('https://www.youtube.com/oembed');
      url.search = new URLSearchParams({ url: destination.url, format: 'json' }).toString();
      const got = await fetchMetadata(deps, YOUTUBE_METADATA_POLICY, url, ctx);
      if (!got.ok) return got;
      const { res } = got;
      if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, gap: 'destination_unavailable' };
      if (res.status !== 200) return { ok: false, gap: 'metadata_unreadable' };
      const json = parseJson(res.body);
      const o = isRecord(json) ? json : {};
      const title = text(o.title, 300);
      const channelName = text(o.author_name, 200);
      if (!title || !channelName) return { ok: false, gap: 'metadata_unreadable' };
      return { ok: true, metadata: { videoId: destination.videoId, title, channelName } };
    },
  };
}

/** The exact lookup URL for one validated track: built from the ID and storefront only. */
export function appleLookupUrl(trackId: string, storefront: string): URL {
  const url = new URL('/lookup', APPLE_LOOKUP_ORIGIN);
  url.search = new URLSearchParams({ id: trackId, country: storefront, entity: 'song' }).toString();
  return url;
}

/**
 * Apple Music song identity via the public ID lookup. Success requires exactly
 * one result: a streamable song track (`wrapperType: track`, `kind: song`) with
 * the exact requested track ID and a first-party track-view URL naming that same
 * track and storefront. Throttling (429, or 403 as Apple sometimes signals it),
 * a missing or unavailable track, another ID/type/storefront and malformed or
 * oversize bodies are explicit gaps, never retried and never a fallback.
 * Previews and other media are ignored. After identity passes, an optional
 * thumbnail/store-link pair may accompany the song for client display only.
 * The server never fetches that thumbnail; invalid display data is dropped.
 */
export function createAppleMusicVerifier(deps: SafeFetchDeps, synthetic = false): DestinationVerifier {
  return {
    synthetic,
    async lookup(destination, ctx) {
      if (destination.kind !== 'apple_music') return { ok: false, gap: 'unsupported_destination' };
      const got = await fetchMetadata(deps, APPLE_METADATA_POLICY, appleLookupUrl(destination.trackId, destination.storefront), ctx);
      if (!got.ok) return { ...got, operational: true };
      const { res } = got;
      if (res.status === 429 || res.status === 403) return { ok: false, gap: 'metadata_throttled', operational: true };
      if (res.status === 404) return { ok: false, gap: 'destination_unavailable' };
      if (res.status !== 200) return { ok: false, gap: 'metadata_unreadable', operational: true };
      const json = parseJson(res.body);
      if (!isRecord(json) || !Array.isArray(json.results) || json.resultCount !== json.results.length) return { ok: false, gap: 'metadata_unreadable', operational: true };
      if (json.results.length === 0) return { ok: false, gap: 'destination_unavailable' };
      if (json.results.length !== 1 || !isRecord(json.results[0])) return { ok: false, gap: 'destination_mismatch' };
      const r = json.results[0];
      if (r.wrapperType !== 'track' || r.kind !== 'song') return { ok: false, gap: 'destination_mismatch' };
      if (typeof r.trackId !== 'number' || !Number.isSafeInteger(r.trackId) || String(r.trackId) !== destination.trackId) return { ok: false, gap: 'destination_mismatch' };
      const view = appleTrackViewIdentity(r.trackViewUrl);
      if (!view || view.trackId !== destination.trackId || view.storefront !== destination.storefront) return { ok: false, gap: 'destination_mismatch' };
      if (r.isStreamable !== true) return { ok: false, gap: 'destination_unavailable' };
      const trackName = text(r.trackName, 300);
      const artistName = text(r.artistName, 300);
      if (!trackName || !artistName) return { ok: false, gap: 'metadata_unreadable', operational: true };
      const artwork = appleArtwork(r.artworkUrl100, r.trackViewUrl, destination.url) ?? appleArtwork(r.artworkUrl60, r.trackViewUrl, destination.url);
      return { ok: true, metadata: { kind: 'apple_music', trackId: destination.trackId, storefront: destination.storefront, trackName, artistName, ...(artwork ? { artwork } : {}) } };
    },
  };
}
