import type {
  ArtistCandidate,
  Attempt,
  AttemptFailure,
  BriefVersion,
  CanonicalReference,
  ChoicePanel,
  Handle,
  IdentityCheckpoint,
  InvestigationPlan,
  PoolArtist,
  PoolSeed,
  PoolTag,
  QlooCandidatePool,
  SealedArtistIdentity,
  SearchRecord,
  SeedRole,
  SeedSlot,
  ShownRecording,
  SubmissionStage,
} from '../shared/records.js';
import { isAudioReference, LIMITS } from '../shared/records.js';
import { allowedAnchor, buildCatalogueHandoff, HandoffTooLarge, type CatalogueHandoff, type CatalogueSeam } from './catalogue.js';
import { destinationKey, shownDestinationKey, shownRecordingFor } from './destinations.js';
import { invoke, openExecution, submit, SubmissionRefused } from './harness.js';
import { newHandle, sha256 } from './ids.js';
import { recordingExclusionKeys } from './recording-identity.js';
import {
  canonicalFilter,
  classifyCandidates,
  normalizeName,
  rehydrateIdentity,
  sealIdentity,
  type IdentityOwner,
  type VerifiedSeed,
} from './identity.js';
import { ProviderError, providerServiceCause } from './providers/http.js';
import type { CallObserver } from './providers/observation.js';
import type { ObservationProfile } from './ledger/observation.js';
import type { QlooArtistInsights, QlooClient, QlooTagInsights } from './providers/qloo.js';
import { canonicalJson, type RecordSealer } from './seal.js';
import type { DiscoverContext, Owner, Store } from './store.js';

// Finite graph harness.
// Discover (one admitted Attempt):
//   resolve seeds (Qloo Search, persisted and reused) -> human identity
//   checkpoint when genuinely ambiguous (execute ends) -> artist Insights
//   (required) + tag Insights (optional) -> owned pool -> InvestigationPlan ->
//   catalogue seam, all in one execute and without another confirmation.
// Refine (one admitted Attempt, the single shared Journey allowance):
//   follow_connection: rehydrate the sealed starting seed and the liked owned
//     anchor -> exactly one artist Insights call -> new pool/plan -> catalogue.
//   correct_direction: re-validate and reuse the owned pool under its same
//     fingerprint -> derived plan (corrected relationship, explicit artist and
//     shown-recording exclusions) -> catalogue, with zero Qloo calls.
// Every provider call first re-authorises and counts against the shared caps;
// every commit re-checks the exact current brief version and Attempt.

export interface GraphDeps {
  readonly store: Store;
  readonly qloo: QlooClient;
  /** True when the Qloo transport is the labelled local fixture, not Qloo. */
  readonly qlooSynthetic: boolean;
  readonly catalogue: CatalogueSeam;
  readonly sealer: RecordSealer;
  readonly now: () => number;
  readonly inflight: Map<Handle, AbortController>;
}

class GraphStop extends Error {
  constructor(readonly failure: AttemptFailure) {
    super(failure);
  }
}

/** A failed required Qloo call: its own 429/503 is named (value-free); anything else keeps the generic code. */
const qlooStop = (err: unknown) => new GraphStop(providerServiceCause(err) ?? 'qloo_failed');

const PRIORITIES = ['preserve_listener_relationship', 'prefer_distinct_anchor_artists', 'exact_recordings_only'] as const;

/**
 * Binding of a pool to its seeds (owned handles, entities and roles), the Search
 * queries of its source brief, the reference analysis and source brief. Reuse
 * requires recomputing exactly this value from current owned records.
 */
export function poolFingerprint(input: {
  readonly origin: QlooCandidatePool['origin'];
  readonly sourceBriefId: Handle;
  readonly analysisId: Handle;
  readonly reference: CanonicalReference;
  readonly seeds: readonly PoolSeed[];
  readonly queries: readonly string[];
}): string {
  return sha256(
    canonicalJson({
      origin: input.origin,
      sourceBriefId: input.sourceBriefId,
      analysisId: input.analysisId,
      reference: isAudioReference(input.reference) ? input.reference : { videoId: input.reference.videoId, start: input.reference.focus.start, end: input.reference.focus.end },
      seeds: input.seeds.map((s) => [s.handle, s.entityId.toLowerCase(), s.role]),
      queries: input.queries.map(normalizeName),
    }),
  );
}

export type ValidatedSeed = VerifiedSeed & { readonly handle: Handle; readonly role: SeedRole };

/**
 * Server-only validation boundary for reusing an owned pool: the recomputed
 * fingerprint must match, every seed must rehydrate from its own sealed owned
 * record to the same entity, and every pool artist must rehydrate too. Any
 * edited, foreign, stale or expired record invalidates reuse.
 */
export function validateOwnedPool(input: {
  readonly pool: QlooCandidatePool;
  readonly sourceBrief: BriefVersion;
  readonly analysisId: Handle;
  readonly reference: CanonicalReference;
  readonly identities: ReadonlyMap<Handle, SealedArtistIdentity>;
  readonly owner: IdentityOwner;
  readonly now: number;
  readonly sealer: RecordSealer;
}): { readonly seeds: ValidatedSeed[] } | null {
  const { pool, sourceBrief, owner, now, sealer } = input;
  if (pool.sourceBriefId !== sourceBrief.id || now >= pool.expiresAt || pool.journeyId !== owner.journeyId) return null;
  const expected = poolFingerprint({
    origin: pool.origin,
    sourceBriefId: sourceBrief.id,
    analysisId: input.analysisId,
    reference: input.reference,
    seeds: pool.seeds,
    queries: sourceBrief.proposedArtists.slice(0, LIMITS.maxSeeds),
  });
  if (expected !== pool.fingerprint) return null;
  const seeds: ValidatedSeed[] = [];
  for (const s of pool.seeds) {
    const sealed = input.identities.get(s.handle);
    const seed = sealed ? rehydrateIdentity(sealed, owner, now, sealer) : null;
    if (!seed || seed.entityId !== s.entityId) return null;
    seeds.push({ ...seed, handle: s.handle, role: s.role });
  }
  for (const a of pool.artists) {
    if (
      a.identity.provenance.operation !== 'artist_insights' ||
      a.identity.provenance.sourceRecordId !== pool.id ||
      !rehydrateIdentity(a.identity, owner, now, sealer)
    ) return null;
  }
  return { seeds };
}

/** Owned sealed identities by handle: Search candidates and pool artists of this Journey. */
export const ownedIdentities = (searches: readonly SearchRecord[], pools: readonly QlooCandidatePool[]) =>
  new Map<Handle, SealedArtistIdentity>([
    ...searches.flatMap((s) => s.candidates
      .filter((c) => c.identity.provenance.operation === 'search' && c.identity.provenance.sourceRecordId === s.id)
      .map((c) => [c.handle, c.identity] as const)),
    ...pools.flatMap((p) => p.artists
      .filter((a) => a.identity.provenance.operation === 'artist_insights' && a.identity.provenance.sourceRecordId === p.id)
      .map((a) => [a.handle, a.identity] as const)),
  ]);

/** Every recording already displayed in the Journey, by canonical key (any upload is the same recording). */
export function shownRecordings(panels: readonly ChoicePanel[]): ShownRecording[] {
  const out = new Map<string, ShownRecording>();
  for (const p of panels) for (const c of p.choices) if (!out.has(c.recordingKey)) out.set(c.recordingKey, shownRecordingFor(c.recordingKey, c.destination, c.title, c.credits));
  return [...out.values()];
}

interface Kit {
  readonly owner: Owner;
  readonly attempt: Attempt;
  readonly exec: ReturnType<typeof openExecution>;
  dispatch<T>(stage: SubmissionStage, call: (signal: AbortSignal, observer?: CallObserver) => Promise<T>, profile?: ObservationProfile): Promise<T>;
  commitOrStop(ok: Promise<boolean>): Promise<void>;
  phase: 'graph' | 'catalogue';
}

/** Opens one bounded execute; settles failures/revocation conservatively; always closes. */
async function runAttempt(deps: GraphDeps, attempt: Attempt, body: (kit: Kit) => Promise<void>): Promise<void> {
  const { store, now, inflight } = deps;
  const owner: Owner = { sessionId: attempt.sessionId, epoch: attempt.epoch };
  const budget = attempt.deadlineAt - now();
  if (budget <= 0) {
    await store.settleAttempt(owner.sessionId, owner.epoch, attempt.id, 'failed', 'deadline', now());
    return;
  }
  const exec = openExecution(attempt, budget, inflight);
  const kit: Kit = {
    owner,
    attempt,
    exec,
    phase: 'graph',
    /** Stage-specific reserve + one-use intent under current authority, then exactly one invocation. */
    async dispatch(stage, call, profile) {
      try {
        return await submit(store, exec, owner, attempt.id, attempt.deadlineAt, stage, now, call, profile);
      } catch (err) {
        if (!(err instanceof SubmissionRefused)) throw err;
        throw new GraphStop(err.code === 'capacity' ? 'capacity' : err.code === 'unavailable' ? 'admission_unavailable' : err.code === 'deadline' ? 'deadline' : 'stale_version');
      }
    },
    async commitOrStop(ok) {
      if (!(await exec.race(ok))) throw new GraphStop('stale_version');
    },
  };
  try {
    await body(kit);
  } catch (err) {
    const reason = exec.abortReason();
    const settle = (outcome: 'failed' | 'cancelled', failure: AttemptFailure | null) =>
      store.settleAttempt(owner.sessionId, owner.epoch, attempt.id, outcome, failure, now());
    if (reason === 'deadline') await settle('failed', 'deadline');
    else if (reason !== null) await settle('cancelled', null);
    else {
      const failure = err instanceof GraphStop ? err.failure : (providerServiceCause(err) ?? (kit.phase === 'catalogue' ? 'catalogue_failed' : 'qloo_failed'));
      // A provider's own 429/503 that arrives after the Attempt's clock ran out is a deadline, not a service cause.
      await settle('failed', (failure === 'provider_limited' || failure === 'provider_unavailable') && now() >= attempt.deadlineAt ? 'deadline' : failure);
    }
  } finally {
    exec.close();
  }
}

function handoffFor(plan: InvestigationPlan): CatalogueHandoff {
  try {
    return buildCatalogueHandoff(plan);
  } catch (err) {
    if (err instanceof HandoffTooLarge) throw new GraphStop('qloo_failed');
    throw err;
  }
}

/** One counted catalogue generation for the committed plan, then a guarded panel commit. */
async function investigateAndCommit(deps: GraphDeps, kit: Kit, plan: InvestigationPlan, pool: QlooCandidatePool, handoff: CatalogueHandoff, expiresAt: number) {
  const { store, now } = deps;
  kit.phase = 'catalogue';
  const outcome = await kit.exec.race(
    invoke(() =>
      deps.catalogue.investigate(
        handoff,
        { plan, pool },
        {
          signal: kit.exec.signal,
          now,
          deadlineAt: kit.attempt.deadlineAt,
          executeRef: kit.attempt.id,
          authorizeMetadata: () => kit.exec.race(store.authorizeCatalogue(kit.owner, kit.attempt.id, plan.id, pool.id, now(), { journeyId: plan.journeyId, briefId: plan.briefId })),
          dispatchGemini: (call, profile) => kit.dispatch('catalogue_generation', call, profile),
          newHandle,
        },
      ),
    ),
  );
  if (outcome.kind === 'not_configured') throw new GraphStop('catalogue_not_configured');
  if (outcome.kind === 'failed') throw new GraphStop(outcome.failure);
  const draft = outcome.panel;
  // Re-validate before commit: every choice must keep an owned anchor from this plan's (derived) pool,
  // and no already shown/known recording may return, even if the model ignored the prompt.
  if (draft.choices.some((c) => allowedAnchor(plan, c.anchor.handle)?.name !== c.anchor.name)) throw new GraphStop('catalogue_failed');
  const excluded = recordingExclusionKeys(plan.recordingExclusions);
  const shownDestinations = new Set(plan.recordingExclusions.shown.map(shownDestinationKey));
  if (draft.choices.some((c) => excluded.has(c.recordingKey) || shownDestinations.has(destinationKey(c.destination)))) throw new GraphStop('catalogue_failed');
  const panel: ChoicePanel = {
    sessionId: kit.owner.sessionId,
    epoch: kit.owner.epoch,
    createdAt: now(),
    expiresAt,
    id: newHandle(),
    journeyId: plan.journeyId,
    briefId: plan.briefId,
    briefVersion: plan.briefVersion,
    planId: plan.id,
    poolId: plan.poolId,
    attemptId: kit.attempt.id,
    ...draft,
  };
  await kit.commitOrStop(store.commitPanel(kit.owner, kit.attempt.id, panel, now()));
}

/** Seals and canonically filters returned artists into an owned pool artist list. */
function poolArtistsFrom(
  returned: QlooArtistInsights,
  seeds: readonly VerifiedSeed[],
  poolId: Handle,
  identityOwner: IdentityOwner,
  sealer: RecordSealer,
) {
  // Canonical supported-identity filter before any pool/plan: seed aliases are removed and
  // equivalent neighbours collapse, without relying on the provider honouring filter.exclude.entities.
  const filtered = canonicalFilter({ seeds, exclusions: [], candidates: returned.artists.slice(0, LIMITS.insightsTake).map((a) => ({ identity: a })) });
  if (filtered.candidates.length === 0) throw new GraphStop('pool_empty');
  const artists: PoolArtist[] = filtered.candidates.map(({ identity: a }) => ({
    handle: newHandle(),
    identity: sealIdentity(a, { operation: 'artist_insights', sourceRecordId: poolId }, identityOwner, sealer),
  }));
  return { artists, aliasesRemoved: filtered.aliasesRemoved, duplicatesRemoved: filtered.duplicatesRemoved };
}

export async function runDiscover(deps: GraphDeps, attempt: Attempt): Promise<void> {
  const { store, qloo, sealer, now } = deps;
  await runAttempt(deps, attempt, async (kit) => {
    const { owner, exec, dispatch, commitOrStop } = kit;

    /** Searches pending seeds once each (reusing completed Searches) and classifies them. */
    const resolveSeeds = async (ctx: DiscoverContext, identityOwner: IdentityOwner) => {
      const searches = [...ctx.searches];
      const pendingSearches = new Map<string, Promise<SearchRecord>>();
      const prior = ctx.checkpoint;
      const base: SeedSlot[] =
        prior?.slots ??
        ctx.brief.proposedArtists.slice(0, LIMITS.maxSeeds).map((proposal) => ({ proposal, searchId: null, status: 'pending', options: [], chosen: null }));

      const slots = await Promise.all(
        base.map(async (slot): Promise<SeedSlot> => {
          if (slot.status !== 'pending') return slot;
          const key = normalizeName(slot.proposal);
          let search = searches.find((s) => s.normalizedQuery === key);
          if (!search) {
            let pending = pendingSearches.get(key);
            if (!pending) {
              pending = (async () => {
                const result = await dispatch('qloo_search', (signal, observer) => qloo.searchArtists(slot.proposal, LIMITS.searchTake, signal, observer)).catch((err) => {
                  if (err instanceof GraphStop || exec.signal.aborted) throw err;
                  throw qlooStop(err);
                });
                const id = newHandle();
                const record: SearchRecord = {
                  sessionId: owner.sessionId,
                  epoch: owner.epoch,
                  createdAt: now(),
                  expiresAt: ctx.journey.expiresAt,
                  id,
                  journeyId: ctx.journey.id,
                  query: slot.proposal,
                  normalizedQuery: key,
                  candidates: result.artists.map(
                    (a): ArtistCandidate => ({
                      handle: newHandle(),
                      identity: sealIdentity(a, { operation: 'search', sourceRecordId: id }, identityOwner, sealer),
                    }),
                  ),
                  returned: result.lineage.returned,
                  rejected: result.lineage.rejected,
                };
                // Persist each completed Search at once so a continuation never repeats it.
                await commitOrStop(store.recordSearch(owner, attempt.id, record, now()));
                searches.push(record);
                return record;
                  })();
              // Equivalent proposals share the same persisted Search and candidate handles.
              pendingSearches.set(key, pending);
            }
            search = await pending;
          }
          const c = classifyCandidates(slot.proposal, search.candidates);
          if (c.status === 'resolved') return { ...slot, searchId: search.id, status: 'resolved', options: [c.handle], chosen: c.handle };
          if (c.status === 'not_found') return { ...slot, searchId: search.id, status: 'not_found', options: [], chosen: null };
          return { ...slot, searchId: search.id, status: 'ambiguous', options: c.options, chosen: null };
        }),
      );

      const undecided = slots.some((s) => s.status === 'ambiguous' && s.chosen === null);
      // One useful clarification per Journey; after that an unresolved slot is honest unavailable coverage.
      const awaiting = undecided && !ctx.journey.clarificationUsed;
      const finalSlots = awaiting
        ? slots
        : slots.map((s): SeedSlot => (s.status === 'ambiguous' && s.chosen === null ? { ...s, status: 'skipped' } : s));
      const checkpoint: IdentityCheckpoint = {
        sessionId: owner.sessionId,
        epoch: owner.epoch,
        createdAt: prior?.createdAt ?? now(),
        expiresAt: ctx.journey.expiresAt,
        id: prior?.id ?? newHandle(),
        journeyId: ctx.journey.id,
        briefId: ctx.brief.id,
        slots: finalSlots,
        awaiting,
        revision: prior?.revision ?? 0,
      };
      return { checkpoint, searches };
    };

    const ctx = await exec.race(store.loadDiscoverContext(owner, attempt.id, now()));
    if (!ctx) throw new GraphStop('stale_version');
    const identityOwner: IdentityOwner = { ...owner, journeyId: ctx.journey.id, expiresAt: ctx.journey.expiresAt };

    const { checkpoint, searches } = await resolveSeeds(ctx, identityOwner);
    await commitOrStop(store.saveCheckpoint(owner, attempt.id, checkpoint, now()));
    if (checkpoint.awaiting) return;

    // Authority boundary: seeds come only from owned, sealed records rehydrated now.
    // Roles follow the listener's slots: slot 0 is the starting artist, slot 1 the optional favourite.
    const rehydrated: ValidatedSeed[] = [];
    for (const [i, slot] of checkpoint.slots.entries()) {
      const handle = (slot.status === 'resolved' || slot.status === 'ambiguous') && slot.chosen ? slot.chosen : null;
      if (!handle) continue;
      const search = searches.find((s) => s.id === slot.searchId);
      const candidate = search?.candidates.find((c) => c.handle === handle);
      if (candidate && (candidate.identity.provenance.operation !== 'search' || candidate.identity.provenance.sourceRecordId !== search!.id)) {
        throw new GraphStop('stale_version');
      }
      const seed = candidate ? rehydrateIdentity(candidate.identity, identityOwner, now(), sealer) : null;
      if (!seed) throw new GraphStop('stale_version');
      rehydrated.push({ ...seed, handle, role: i === 0 ? 'starting' : 'favourite' });
    }
    // Equivalent seeds (same entity or shared supported external ID) count once.
    const seeds = canonicalFilter({ seeds: rehydrated, exclusions: [], candidates: [] }).seeds;
    if (seeds.length === 0) throw new GraphStop('no_seed');

    await commitOrStop(store.setStage(owner, attempt.id, 'retrieving_taste', now()));
    const seedIds = seeds.map((s) => s.entityId);
    const artistCall = dispatch('qloo_artist_insights', (signal, observer) => qloo.artistInsights({ seedIds, excludeIds: seedIds, take: LIMITS.insightsTake }, signal, observer));
    const tagCall = ctx.brief.relationshipSource === 'automatic_match' ? Promise.resolve('not_admitted' as const) : dispatch('qloo_tag_insights', (signal, observer) => qloo.tagInsights({ seedIds, take: LIMITS.insightsTake }, signal, observer)).then(
      (r): QlooTagInsights | 'unsupported' | 'failed' | 'not_admitted' => r,
      (err): 'unsupported' | 'failed' | 'not_admitted' => {
        if (exec.signal.aborted) return 'failed';
        if (err instanceof GraphStop) return 'not_admitted';
        return err instanceof ProviderError && err.kind === 'unsupported' ? 'unsupported' : 'failed';
      },
    );
    let returned: QlooArtistInsights;
    try {
      returned = await artistCall;
    } catch (err) {
      await tagCall;
      if (err instanceof GraphStop || exec.signal.aborted) throw err;
      throw qlooStop(err);
    }
    const tags = await tagCall;

    const poolId = newHandle();
    const at = now();
    const ownedFields = { sessionId: owner.sessionId, epoch: owner.epoch, createdAt: at, expiresAt: ctx.journey.expiresAt };
    const built = poolArtistsFrom(returned, seeds, poolId, identityOwner, sealer);
    const poolTags: PoolTag[] =
      typeof tags === 'object' ? tags.tags.slice(0, LIMITS.tags).map((t) => ({ handle: newHandle(), tagId: t.tagId, name: t.name, subtype: t.subtype })) : [];
    const poolSeeds: PoolSeed[] = seeds.map((s) => ({ handle: s.handle, name: s.name, entityId: s.entityId, role: s.role }));
    const pool: QlooCandidatePool = {
      ...ownedFields,
      id: poolId,
      journeyId: ctx.journey.id,
      sourceBriefId: ctx.brief.id,
      origin: 'initial',
      fingerprint: poolFingerprint({
        origin: 'initial',
        sourceBriefId: ctx.brief.id,
        analysisId: ctx.analysis.id,
        reference: ctx.analysis.reference,
        seeds: poolSeeds,
        queries: ctx.brief.proposedArtists.slice(0, LIMITS.maxSeeds),
      }),
      synthetic: deps.qlooSynthetic,
      seeds: poolSeeds,
      artists: built.artists,
      tags: poolTags,
      capability: poolTags.length > 0 ? 'artists_and_tags' : 'artists_only',
      lineage: {
        artistReturned: returned.lineage.returned,
        artistRejected: returned.lineage.rejected,
        aliasesRemoved: built.aliasesRemoved,
        duplicatesRemoved: built.duplicatesRemoved,
        tagOutcome: typeof tags === 'object' ? 'returned' : tags,
        tagReturned: typeof tags === 'object' ? tags.lineage.returned : 0,
      },
    };
    const plan: InvestigationPlan = {
      ...ownedFields,
      id: newHandle(),
      journeyId: ctx.journey.id,
      briefId: ctx.brief.id,
      briefVersion: ctx.brief.version,
      poolId,
      relationship: ctx.brief.relationship,
      referenceObservations: [...ctx.analysis.observations],
      seedNames: pool.seeds.map((s) => s.name),
      anchors: built.artists.map((a) => ({ handle: a.handle, name: a.identity.name })),
      associations: poolTags.map((t) => ({ handle: t.handle, name: t.name })),
      exclusions: [...new Set([...pool.seeds.map((s) => s.name), ...ctx.brief.exclusions])].slice(0, LIMITS.exclusions),
      recordingExclusions: { shown: [], known: [] },
      priorities: [...PRIORITIES],
      refinementMode: null,
      refinement: null,
      attribution: 'seed_mix',
      provenance: { analysisId: ctx.analysis.id, analysisReuse: 'same_source_focus', poolSourceBriefId: ctx.brief.id, poolReuse: 'created' },
    };
    const handoff = handoffFor(plan);
    await commitOrStop(store.commitPlan(owner, attempt.id, pool, plan, now()));
    // Same execute, no extra confirmation: the catalogue consumes the owned plan and canonical pool.
    await investigateAndCommit(deps, kit, plan, pool, handoff, ctx.journey.expiresAt);
  });
}

export async function runRefine(deps: GraphDeps, attempt: Attempt): Promise<void> {
  const { store, qloo, sealer, now } = deps;
  await runAttempt(deps, attempt, async (kit) => {
    const { owner, exec, dispatch, commitOrStop } = kit;
    const ctx = await exec.race(store.loadRefineContext(owner, attempt.id, now()));
    if (!ctx) throw new GraphStop('stale_version');
    const basis = ctx.brief.refinement;
    const identityOwner: IdentityOwner = { ...owner, journeyId: ctx.journey.id, expiresAt: ctx.journey.expiresAt };
    const sourceBrief = ctx.fromPool.sourceBriefId === ctx.fromBrief.id ? ctx.fromBrief : null;
    const identities = ownedIdentities(ctx.searches, [ctx.fromPool]);
    // Re-validate the consumed pool at the authority boundary (the route validated it before admission too).
    const valid = sourceBrief
      ? validateOwnedPool({
          pool: ctx.fromPool,
          sourceBrief,
          analysisId: ctx.analysis.id,
          reference: ctx.analysis.reference,
          identities,
          owner: identityOwner,
          now: now(),
          sealer,
        })
      : null;
    if (!valid || ctx.fromPlan.provenance.analysisId !== ctx.analysis.id) throw new GraphStop('stale_version');

    // Exclusions by recording identity: everything shown in this Journey, plus known flags as admitted.
    const shown = shownRecordings(ctx.panels);
    const known = basis.admittedFeedback.flatMap((f) => {
      const choice = f.familiarity === 'known' ? ctx.fromPanel.choices.find((c) => c.handle === f.choice) : undefined;
      return choice ? [choice.recordingKey] : [];
    });
    const at = now();
    const ownedFields = { sessionId: owner.sessionId, epoch: owner.epoch, createdAt: at, expiresAt: ctx.journey.expiresAt };

    if (basis.mode === 'follow_connection') {
      const followed = ctx.fromPool.artists.find((a) => a.handle === basis.followAnchor);
      const anchorSeed = followed ? rehydrateIdentity(followed.identity, identityOwner, now(), sealer) : null;
      if (!followed || !anchorSeed) throw new GraphStop('stale_version');
      // Keep the verified starting seed (never re-searched); the optional favourite, if any, is replaced.
      const starting = valid.seeds.find((s) => s.role === 'starting') ?? null;
      const replaced = valid.seeds.filter((s) => s.role !== 'starting').map((s) => s.name);
      const candidateSeeds: ValidatedSeed[] = [...(starting ? [starting] : []), { ...anchorSeed, handle: followed.handle, role: 'followed' }];
      const seeds = canonicalFilter({ seeds: candidateSeeds, exclusions: [], candidates: [] }).seeds.slice(0, LIMITS.maxSeeds);
      const seedIds = seeds.map((s) => s.entityId);
      // Exactly one artist-Insights call; no optional tag call in this first-pair path.
      let returned: QlooArtistInsights;
      try {
        returned = await dispatch('qloo_artist_insights', (signal, observer) => qloo.artistInsights({ seedIds, excludeIds: seedIds, take: LIMITS.insightsTake }, signal, observer));
      } catch (err) {
        if (err instanceof GraphStop || exec.signal.aborted) throw err;
        throw qlooStop(err);
      }
      const poolId = newHandle();
      const built = poolArtistsFrom(returned, seeds, poolId, identityOwner, sealer);
      const poolSeeds: PoolSeed[] = seeds.map((s) => ({ handle: s.handle, name: s.name, entityId: s.entityId, role: s.role }));
      const pool: QlooCandidatePool = {
        ...ownedFields,
        id: poolId,
        journeyId: ctx.journey.id,
        sourceBriefId: ctx.brief.id,
        origin: 'follow_connection',
        fingerprint: poolFingerprint({
          origin: 'follow_connection',
          sourceBriefId: ctx.brief.id,
          analysisId: ctx.analysis.id,
          reference: ctx.analysis.reference,
          seeds: poolSeeds,
          queries: ctx.brief.proposedArtists.slice(0, LIMITS.maxSeeds),
        }),
        synthetic: deps.qlooSynthetic,
        seeds: poolSeeds,
        artists: built.artists,
        tags: [],
        capability: 'artists_only',
        lineage: {
          artistReturned: returned.lineage.returned,
          artistRejected: returned.lineage.rejected,
          aliasesRemoved: built.aliasesRemoved,
          duplicatesRemoved: built.duplicatesRemoved,
          tagOutcome: 'not_admitted',
          tagReturned: 0,
        },
      };
      const plan: InvestigationPlan = {
        ...ownedFields,
        id: newHandle(),
        journeyId: ctx.journey.id,
        briefId: ctx.brief.id,
        briefVersion: ctx.brief.version,
        poolId,
        relationship: ctx.brief.relationship,
      referenceObservations: [...ctx.analysis.observations],
        seedNames: poolSeeds.map((s) => s.name),
        anchors: built.artists.map((a) => ({ handle: a.handle, name: a.identity.name })),
        associations: [],
        // The liked (followed) artist stays eligible as a credit; only the kept starting seed and
        // explicit artist exclusions are excluded. Shown recordings are excluded by identity instead.
        exclusions: [...new Set([...(starting ? [starting.name] : []), ...ctx.brief.exclusions])].slice(0, LIMITS.exclusions),
        recordingExclusions: { shown, known },
        priorities: [...PRIORITIES],
        refinementMode: 'follow_connection',
        refinement: {
          followed: anchorSeed.name,
          keptStarting: starting?.name ?? null,
          replaced,
          excludedArtists: [],
          relationshipChanged: false,
          fromPanelId: ctx.fromPanel.id,
        },
        attribution: 'seed_mix',
        provenance: { analysisId: ctx.analysis.id, analysisReuse: 'same_source_focus', poolSourceBriefId: ctx.brief.id, poolReuse: 'created' },
      };
      const handoff = handoffFor(plan);
      await commitOrStop(store.commitPlan(owner, attempt.id, pool, plan, now()));
      await investigateAndCommit(deps, kit, plan, pool, handoff, ctx.journey.expiresAt);
      return;
    }

    // correct_direction: zero Qloo calls. The historical pool is never mutated; explicit artist
    // exclusions narrow a derived allowed list in this new plan only.
    const excluded = new Set(basis.excludedAnchors);
    const anchors = ctx.fromPlan.anchors.filter((a) => !excluded.has(a.handle));
    if (anchors.length === 0) throw new GraphStop('pool_empty');
    const excludedArtists = ctx.fromPlan.anchors.filter((a) => excluded.has(a.handle)).map((a) => a.name);
    const plan: InvestigationPlan = {
      ...ownedFields,
      id: newHandle(),
      journeyId: ctx.journey.id,
      briefId: ctx.brief.id,
      briefVersion: ctx.brief.version,
      poolId: ctx.fromPool.id,
      relationship: ctx.brief.relationship,
      referenceObservations: [...ctx.analysis.observations],
      seedNames: ctx.fromPlan.seedNames,
      anchors,
      associations: ctx.fromPlan.associations,
      exclusions: [...new Set([...ctx.fromPlan.exclusions, ...ctx.brief.exclusions, ...excludedArtists])].slice(0, LIMITS.exclusions),
      recordingExclusions: { shown, known },
      priorities: [...PRIORITIES],
      refinementMode: 'correct_direction',
      refinement: {
        followed: null,
        keptStarting: null,
        replaced: [],
        excludedArtists,
        relationshipChanged: ctx.brief.relationship !== ctx.fromBrief.relationship,
        fromPanelId: ctx.fromPanel.id,
      },
      attribution: 'seed_mix',
      provenance: {
        analysisId: ctx.analysis.id,
        analysisReuse: 'same_source_focus',
        poolSourceBriefId: ctx.fromPool.sourceBriefId,
        poolReuse: 'reused_same_fingerprint',
      },
    };
    const handoff = handoffFor(plan);
    await commitOrStop(store.commitPlan(owner, attempt.id, null, plan, now()));
    await investigateAndCommit(deps, kit, plan, ctx.fromPool, handoff, ctx.journey.expiresAt);
  });
}
