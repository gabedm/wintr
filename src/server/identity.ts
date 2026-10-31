import type { Handle, SealedArtistIdentity, SeedSlot } from '../shared/records.js';
import { LIMITS } from '../shared/records.js';
import { artistContext } from '../shared/artist-context.js';
import { SUPPORTED_EXTERNAL_IDS, toQlooArtistId, type QlooArtist, type QlooArtistId } from './providers/qloo.js';
import type { RecordSealer } from './seal.js';

// Owned artist identity boundary.
// - sealIdentity binds a validated Qloo artist to its owner (session, epoch,
//   Journey, expiry) and provenance, and seals the canonical form.
// - rehydrateIdentity is the only way a stored identity regains authority to be
//   sent to Qloo: it strictly re-validates shape, UUID, owner, expiry and seal.
//   A record from another session/epoch/Journey, an expired one, or any edited
//   field is rejected before any transport call.
// - classifyCandidates decides resolution from verified identity evidence only.

export interface IdentityOwner {
  readonly sessionId: Handle;
  readonly epoch: number;
  readonly journeyId: Handle;
  readonly expiresAt: number;
}

export interface VerifiedSeed {
  readonly entityId: QlooArtistId;
  readonly name: string;
  /** Sealed supported external IDs: equivalence evidence and optional public identity navigation. */
  readonly external: Readonly<Record<string, readonly string[]>>;
}

/** Identity evidence: the entity ID plus supported, format-valid external artist IDs. */
export interface IdentityEvidence {
  readonly entityId: string;
  readonly external: Readonly<Record<string, readonly string[]>>;
}

/** One useful public cross-reference from an already rehydrated owned identity. No lookup or affiliation claim. */
export function publicArtistContext(identity: VerifiedSeed) {
  for (const service of ['spotify', 'musicbrainz', 'wikidata'] as const) {
    for (const id of identity.external[service] ?? []) {
      const context = artistContext(service, id);
      if (context) return context;
    }
  }
  return undefined;
}

/** Upper bound on identities considered in one equivalence computation (2 seeds + exclusions + 15 + slack). */
export const MAX_EQUIVALENCE_NODES = 64;

const evidenceKeys = (e: IdentityEvidence): string[] => [
  `id:${e.entityId.toLowerCase()}`,
  ...Object.entries(e.external).flatMap(([ns, ids]) => {
    const format = SUPPORTED_EXTERNAL_IDS[ns];
    return format ? ids.filter((id) => format.test(id)).map((id) => `${ns}:${id}`) : [];
  }),
];

/**
 * Union-find over all nodes at once: two identities are equivalent when they share
 * an entity ID or a supported external ID, transitively. Evidence from every node
 * (including ones later dropped) participates, so a skipped alias cannot hide
 * another alias. Names, spelling and biographies never establish equivalence.
 */
export function equivalenceClasses(nodes: readonly IdentityEvidence[]): number[] {
  if (nodes.length > MAX_EQUIVALENCE_NODES) throw new RangeError('too many identities');
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  nodes.forEach((node, i) => {
    for (const key of evidenceKeys(node)) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  return nodes.map((_, i) => find(i));
}

export interface CanonicalResult<S, T> {
  readonly seeds: S[];
  readonly candidates: T[];
  /** Candidates equivalent to a seed or an explicit exclusion. */
  readonly aliasesRemoved: number;
  /** Candidates equivalent to an earlier kept candidate. */
  readonly duplicatesRemoved: number;
}

/**
 * Canonical supported-identity filter applied before pool/plan construction:
 * deduplicates equivalent seeds, removes candidates equivalent to any seed or
 * explicit (verified) exclusion, and deduplicates equivalent candidates. It does
 * not rely on the provider honouring an exclude parameter.
 */
export function canonicalFilter<S extends IdentityEvidence, T extends { readonly identity: IdentityEvidence }>(input: {
  readonly seeds: readonly S[];
  readonly exclusions: readonly IdentityEvidence[];
  readonly candidates: readonly T[];
}): CanonicalResult<S, T> {
  const { seeds, exclusions, candidates } = input;
  const classes = equivalenceClasses([...seeds, ...exclusions, ...candidates.map((c) => c.identity)]);
  const seedClasses = new Set<number>();
  const keptSeeds: S[] = [];
  seeds.forEach((s, i) => {
    if (!seedClasses.has(classes[i]!)) keptSeeds.push(s);
    seedClasses.add(classes[i]!);
  });
  const blocked = new Set([...seedClasses, ...exclusions.map((_, i) => classes[seeds.length + i]!)]);
  const offset = seeds.length + exclusions.length;
  const seen = new Set<number>();
  const kept: T[] = [];
  let aliasesRemoved = 0;
  let duplicatesRemoved = 0;
  candidates.forEach((c, i) => {
    const k = classes[offset + i]!;
    if (blocked.has(k)) aliasesRemoved += 1;
    else if (seen.has(k)) duplicatesRemoved += 1;
    else {
      seen.add(k);
      kept.push(c);
    }
  });
  return { seeds: keptSeeds, candidates: kept, aliasesRemoved, duplicatesRemoved };
}

type Unsealed = Omit<SealedArtistIdentity, 'seal'>;

export function sealIdentity(
  artist: QlooArtist,
  provenance: SealedArtistIdentity['provenance'],
  owner: IdentityOwner,
  sealer: RecordSealer,
): SealedArtistIdentity {
  const body: Unsealed = {
    entityId: artist.entityId,
    name: artist.name,
    disambiguation: artist.disambiguation,
    external: Object.fromEntries(Object.entries(artist.external).map(([k, v]) => [k, [...v]])),
    subtypeEvidence: artist.subtypeEvidence,
    provenance: { ...provenance },
    owner: { sessionId: owner.sessionId, epoch: owner.epoch, journeyId: owner.journeyId, expiresAt: owner.expiresAt },
  };
  return deepFreeze({ ...body, seal: sealer.seal(body) });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEYS = ['disambiguation', 'entityId', 'external', 'name', 'owner', 'provenance', 'seal', 'subtypeEvidence'];

export function rehydrateIdentity(raw: unknown, owner: IdentityOwner, now: number, sealer: RecordSealer): VerifiedSeed | null {
  if (!isRecord(raw) || Object.keys(raw).sort().join() !== KEYS.join()) return null;
  const { seal, ...body } = raw;
  const entityId = toQlooArtistId(body.entityId);
  if (!entityId || entityId !== body.entityId) return null;
  if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.length > 256) return null;
  const o = body.owner;
  if (
    !isRecord(o) ||
    o.sessionId !== owner.sessionId ||
    o.epoch !== owner.epoch ||
    o.journeyId !== owner.journeyId ||
    o.expiresAt !== owner.expiresAt ||
    typeof o.expiresAt !== 'number' ||
    now >= o.expiresAt
  ) {
    return null;
  }
  const p = body.provenance;
  if (!isRecord(p) || (p.operation !== 'search' && p.operation !== 'artist_insights') || typeof p.sourceRecordId !== 'string') return null;
  const external = body.external;
  if (!isRecord(external)) return null;
  for (const [ns, ids] of Object.entries(external)) {
    const format = SUPPORTED_EXTERNAL_IDS[ns];
    if (!format || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !format.test(id))) return null;
  }
  if (!sealer.verify(body, seal)) return null;
  return deepFreeze({ entityId, name: body.name, external: structuredClone(external) as Record<string, string[]> });
}

export const normalizeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Deduplicates only by verified identity evidence (same entity ID or a shared supported external ID, transitively). */
export const dedupeIdentities = <T extends { readonly identity: IdentityEvidence }>(items: readonly T[]): T[] =>
  canonicalFilter({ seeds: [] as IdentityEvidence[], exclusions: [], candidates: items }).candidates;

export type Classification =
  | { readonly status: 'resolved'; readonly handle: Handle }
  | { readonly status: 'ambiguous'; readonly options: readonly Handle[] }
  | { readonly status: 'not_found' };

/**
 * A unique exact (normalised) name match among distinct verified identities resolves.
 * Several distinct identities with that name, or only inexact matches, need the
 * listener. Spelling alone never picks between namesakes.
 */
export function classifyCandidates(query: string, candidates: readonly { handle: Handle; identity: SealedArtistIdentity }[]): Classification {
  const distinct = dedupeIdentities(candidates);
  if (distinct.length === 0) return { status: 'not_found' };
  const q = normalizeName(query);
  const exact = distinct.filter((c) => normalizeName(c.identity.name) === q);
  if (exact.length === 1) return { status: 'resolved', handle: exact[0]!.handle };
  const pool = exact.length > 1 ? exact : distinct;
  return { status: 'ambiguous', options: pool.slice(0, LIMITS.identityChoicesShown).map((c) => c.handle) };
}

/** Handles that should seed Insights, in slot order. */
export const chosenSeedHandles = (slots: readonly SeedSlot[]): Handle[] =>
  slots.flatMap((s) => (s.status === 'resolved' || (s.status === 'ambiguous' && s.chosen)) && s.chosen ? [s.chosen] : []);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
