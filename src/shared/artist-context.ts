import type { SafeArtistContext } from './records.js';

const routes = {
  spotify: { prefix: 'https://open.spotify.com/artist/', id: /^[0-9A-Za-z]{22}$/ },
  musicbrainz: { prefix: 'https://musicbrainz.org/artist/', id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
  wikidata: { prefix: 'https://www.wikidata.org/wiki/', id: /^Q[1-9][0-9]{0,11}$/ },
} as const;

/** Construct public identity navigation from an exact supported ID, never a returned URL. */
export function artistContext(service: unknown, id: unknown): SafeArtistContext | undefined {
  if (typeof service !== 'string' || !Object.hasOwn(routes, service) || typeof id !== 'string') return undefined;
  const key = service as SafeArtistContext['service'];
  return routes[key].id.test(id) ? { service: key, url: routes[key].prefix + id } : undefined;
}

/** The DTO and renderer accept only the exact canonical public route of its declared service. */
export function isSafeArtistContext(value: unknown): value is SafeArtistContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== 2 || !Object.hasOwn(v, 'service') || !Object.hasOwn(v, 'url') || typeof v.url !== 'string') return false;
  if (typeof v.service !== 'string' || !Object.hasOwn(routes, v.service)) return false;
  const route = routes[v.service as SafeArtistContext['service']];
  if (!v.url.startsWith(route.prefix)) return false;
  return artistContext(v.service, v.url.slice(route.prefix.length))?.url === v.url;
}
