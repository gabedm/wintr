import { LIMITS } from '../../shared/records.js';
import { classifyStatus, decodeJson, ProviderError, sendOnce, type Endpoint, type HttpTransport } from './http.js';
import type { ServerSecret } from './secret.js';
import type { CallObserver } from './observation.js';

// Qloo Search and artist/tag Insights (QLOO_AND_DISCOVERY Q02/Q03). Server-only
// typed data: provider IDs never leave the server, nothing acoustic is inferred
// and no namesake is resolved here. Returned artists are frozen snapshots.
// This module only validates shape (UUID entity IDs). Seed *authority* comes
// from owned, sealed durable records rehydrated by server/identity.ts; browser
// input never reaches these methods. Request shapes are live-unverified.

/** Supported base hosts; the controller binds exactly one. Never taken from user or model text. */
export const QLOO_HOSTS = ['hackathon.api.qloo.com', 'api.qloo.com'] as const;
export type QlooHost = (typeof QLOO_HOSTS)[number];

export const QLOO_LIMITS = {
  timeoutMs: 10_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxTake: 15,
  maxSeeds: LIMITS.maxSeeds,
  maxExclusions: 32,
  queryChars: LIMITS.artistNameChars,
  nameChars: 256,
  disambiguationChars: 300,
  externalIdsPerKey: 4,
  externalIdChars: 128,
} as const;

const ARTIST = 'urn:entity:artist';
const ENTITY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Qloo artist entity ID with a validated UUID shape. Shape is not ownership. */
export type QlooArtistId = string & { readonly __qlooArtistId: unique symbol };

/** Canonical lower-case UUID, or null. */
export const toQlooArtistId = (raw: unknown): QlooArtistId | null =>
  typeof raw === 'string' && ENTITY_ID.test(raw) ? (raw.toLowerCase() as QlooArtistId) : null;
const TAG_ID = /^urn:tag:[a-z0-9_:.-]{1,180}$/i;

/** A validated, frozen artist from a Qloo response. Provider fields stay server-side. */
export interface QlooArtist {
  readonly entityId: QlooArtistId;
  readonly name: string;
  readonly subtypeEvidence: 'subtype' | 'types';
  readonly disambiguation: string | null;
  /** Supported external identities, for dedup/identity checks only. */
  readonly external: Readonly<Record<string, readonly string[]>>;
  /** Cultural relevance as returned (Insights only); not a personal probability or audio score. */
  readonly affinity: number | null;
}

export interface QlooTag {
  readonly tagId: string;
  readonly name: string;
  readonly subtype: string | null;
  readonly affinity: number | null;
}

export interface QlooLineage {
  readonly operation: 'search' | 'artist_insights' | 'tag_insights';
  readonly host: QlooHost;
  readonly seedIds: readonly QlooArtistId[];
  readonly excludeIds: readonly QlooArtistId[];
  readonly take: number;
  readonly returned: number;
  /** Entities/tags that failed identity validation and were not retained. */
  readonly rejected: number;
}

export interface QlooSearchResult {
  readonly artists: readonly QlooArtist[];
  readonly noResults: boolean;
  readonly lineage: QlooLineage;
}

export interface QlooArtistInsights {
  readonly artists: readonly QlooArtist[];
  readonly lineage: QlooLineage;
}

export interface QlooTagInsights {
  readonly tags: readonly QlooTag[];
  readonly lineage: QlooLineage;
}

export interface QlooConfig {
  readonly transport: HttpTransport;
  readonly apiKey: ServerSecret;
  readonly host: QlooHost;
}

export interface QlooClient {
  searchArtists(query: string, take: number, signal: AbortSignal, observer?: CallObserver): Promise<QlooSearchResult>;
  artistInsights(
    input: { seedIds: readonly QlooArtistId[]; excludeIds?: readonly QlooArtistId[]; take: number },
    signal: AbortSignal,
    observer?: CallObserver,
  ): Promise<QlooArtistInsights>;
  tagInsights(input: { seedIds: readonly QlooArtistId[]; take: number }, signal: AbortSignal, observer?: CallObserver): Promise<QlooTagInsights>;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const schema = () => new ProviderError('qloo', 'schema', true);
const config = () => new ProviderError('qloo', 'config', false);

const boundedString = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\u0000-\u001F\u007F]/.test(v) ? v.trim() : null;

const affinityOf = (e: Record<string, unknown>): number | null => {
  const a = isRecord(e.query) ? e.query.affinity : undefined;
  return typeof a === 'number' && Number.isFinite(a) ? a : null;
};

/**
 * External artist-ID namespaces that may establish identity equivalence, each with
 * a strict ID format. Anything else (other keys, URLs, free strings, bad shapes)
 * is ignored: it never becomes identity evidence.
 */
export const SUPPORTED_EXTERNAL_IDS: Readonly<Record<string, RegExp>> = {
  spotify: /^[0-9A-Za-z]{22}$/,
  musicbrainz: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  wikidata: /^Q[1-9][0-9]{0,11}$/,
};

/** Keeps only supported namespaces whose values are `[{ id }]` objects with a valid ID. */
export function parseSupportedExternal(v: unknown): Record<string, string[]> {
  if (!isRecord(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, format] of Object.entries(SUPPORTED_EXTERNAL_IDS)) {
    const list = v[key];
    if (!Array.isArray(list)) continue;
    const ids = list.slice(0, QLOO_LIMITS.externalIdsPerKey).flatMap((item) => {
      const id = isRecord(item) ? item.id : undefined;
      return typeof id === 'string' && id.length <= QLOO_LIMITS.externalIdChars && format.test(id) ? [id] : [];
    });
    if (ids.length > 0) out[key] = [...new Set(ids)];
  }
  return out;
}

function parseArtist(v: unknown, withAffinity: boolean): QlooArtist | null {
  if (!isRecord(v)) return null;
  const entityId = toQlooArtistId(v.entity_id);
  const name = boundedString(v.name, QLOO_LIMITS.nameChars);
  let subtypeEvidence: QlooArtist['subtypeEvidence'] | null = null;
  if (v.subtype !== undefined) subtypeEvidence = v.subtype === ARTIST ? 'subtype' : null;
  else if (Array.isArray(v.types) && v.types.includes(ARTIST)) subtypeEvidence = 'types';
  if (!entityId || !name || !subtypeEvidence) return null;
  const props = isRecord(v.properties) ? v.properties : {};
  return deepFreeze({
    entityId,
    name,
    subtypeEvidence,
    disambiguation: boundedString(v.disambiguation ?? props.disambiguation, QLOO_LIMITS.disambiguationChars),
    external: parseSupportedExternal(v.external),
    affinity: withAffinity ? affinityOf(v) : null,
  });
}

function parseTag(v: unknown): QlooTag | null {
  if (!isRecord(v)) return null;
  const tagId = typeof v.tag_id === 'string' && TAG_ID.test(v.tag_id) ? v.tag_id : null;
  const name = boundedString(v.name, LIMITS.artistNameChars);
  const subtype = v.subtype === undefined || v.subtype === null ? null : typeof v.subtype === 'string' && TAG_ID.test(v.subtype) ? v.subtype : undefined;
  if (!tagId || !name || subtype === undefined) return null;
  return Object.freeze({ tagId, name, subtype, affinity: affinityOf(v) });
}

export function createQlooClient(cfg: QlooConfig): QlooClient {
  if (!(QLOO_HOSTS as readonly string[]).includes(cfg.host)) throw new TypeError('Unsupported Qloo host');
  const { transport, apiKey, host } = cfg;
  const origin = `https://${host}`;

  const call = async (path: string, params: URLSearchParams, signal: AbortSignal, observer?: CallObserver) => {
    const endpoint: Endpoint = { origin, path };
    const url = new URL(path, origin);
    url.search = params.toString();
    const res = await sendOnce({
      provider: 'qloo',
      transport,
      endpoint,
      method: 'GET',
      url,
      headers: { accept: 'application/json', 'x-api-key': apiKey.reveal() },
      timeoutMs: QLOO_LIMITS.timeoutMs,
      maxResponseBytes: QLOO_LIMITS.maxResponseBytes,
      signal,
      observer,
      onResponse: () => { observer?.usage(undefined, 'qloo'); observer?.searchQueries(undefined); observer?.usageDecoded(); },
    });
    return res;
  };

  const checkTake = (take: number) => {
    if (!Number.isSafeInteger(take) || take < 1 || take > QLOO_LIMITS.maxTake) throw config();
  };

  /** Shape check only: authority for these IDs is established by the owned-record boundary before this call. */
  const checkIds = (ids: readonly QlooArtistId[], min: number, max: number) => {
    if (!Array.isArray(ids) || ids.length < min || ids.length > max) throw config();
    const valid = ids.map(toQlooArtistId);
    if (valid.some((id) => id === null)) throw config();
    return [...new Set(valid as QlooArtistId[])];
  };

  const insightsResults = (status: number, body: Uint8Array, key: 'entities' | 'tags', take: number): unknown[] => {
    if (status < 200 || status > 299) throw new ProviderError('qloo', classifyStatus(status), true, status);
    const json = decodeJson('qloo', body);
    if (!isRecord(json) || json.success !== true || !isRecord(json.results)) throw schema();
    const list = json.results[key];
    if (!Array.isArray(list) || list.length > take) throw schema();
    return list;
  };

  const keepArtists = (list: unknown[], withAffinity: boolean, excluded: ReadonlySet<string>) => {
    const seen = new Set<string>();
    const artists: QlooArtist[] = [];
    let rejected = 0;
    for (const item of list) {
      const artist = parseArtist(item, withAffinity);
      if (!artist) {
        rejected += 1;
        continue;
      }
      if (seen.has(artist.entityId) || excluded.has(artist.entityId)) continue;
      seen.add(artist.entityId);
      artists.push(artist);
    }
    return { artists, rejected };
  };

  return {
    async searchArtists(query, take, signal, observer) {
      observer?.adapterEntered();
      const q = boundedString(query, QLOO_LIMITS.queryChars);
      if (!q) throw config();
      checkTake(take);
      const params = new URLSearchParams({ query: q, types: ARTIST, take: String(take) });
      const res = await call('/search', params, signal, observer);
      const lineage = (returned: number, rejected: number): QlooLineage => ({
        operation: 'search',
        host,
        seedIds: [],
        excludeIds: [],
        take,
        returned,
        rejected,
      });
      // Qloo documents 404 as "No results": an honest empty coverage outcome, not an error.
      if (res.status === 404) return { artists: [], noResults: true, lineage: lineage(0, 0) };
      if (res.status < 200 || res.status > 299) throw new ProviderError('qloo', classifyStatus(res.status), true, res.status);
      const json = decodeJson('qloo', res.body);
      if (!isRecord(json) || !Array.isArray(json.results) || json.results.length > take) throw schema();
      const { artists, rejected } = keepArtists(json.results, false, new Set());
      return { artists, noResults: artists.length === 0, lineage: lineage(json.results.length, rejected) };
    },

    async artistInsights({ seedIds, excludeIds: extra = [], take }, signal, observer) {
      observer?.adapterEntered();
      checkTake(take);
      const ids = checkIds(seedIds, 1, QLOO_LIMITS.maxSeeds);
      const excludeIds = [...new Set([...ids, ...checkIds(extra, 0, QLOO_LIMITS.maxExclusions)])];
      const params = new URLSearchParams({
        'filter.type': ARTIST,
        'signal.interests.entities': ids.join(','),
        'filter.exclude.entities': excludeIds.join(','),
        take: String(take),
      });
      const res = await call('/v2/insights', params, signal, observer);
      const list = insightsResults(res.status, res.body, 'entities', take);
      const { artists, rejected } = keepArtists(list, true, new Set(excludeIds));
      return {
        artists,
        lineage: { operation: 'artist_insights', host, seedIds: ids, excludeIds, take, returned: list.length, rejected },
      };
    },

    async tagInsights({ seedIds, take }, signal, observer) {
      observer?.adapterEntered();
      checkTake(take);
      const ids = checkIds(seedIds, 1, QLOO_LIMITS.maxSeeds);
      const params = new URLSearchParams({
        'filter.type': 'urn:tag',
        'signal.interests.entities': ids.join(','),
        'filter.parents.types': ARTIST,
        'filter.tag.types': 'urn:tag:music:qloo',
        take: String(take),
      });
      const res = await call('/v2/insights', params, signal, observer);
      const list = insightsResults(res.status, res.body, 'tags', take);
      const seen = new Set<string>();
      const tags: QlooTag[] = [];
      let rejected = 0;
      for (const item of list) {
        const tag = parseTag(item);
        if (!tag) rejected += 1;
        else if (!seen.has(tag.tagId)) {
          seen.add(tag.tagId);
          tags.push(tag);
        }
      }
      return { tags, lineage: { operation: 'tag_insights', host, seedIds: ids, excludeIds: [], take, returned: list.length, rejected } };
    },
  };
}
