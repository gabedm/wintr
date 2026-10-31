import type { CandidateGap, RecordingService, TrackChoice } from '../shared/records.js';
import { LIMITS, RECORDING_SERVICES } from '../shared/records.js';
import { allowedAnchor, generationBudget, type CatalogueSeam, type PanelDraft } from './catalogue.js';
import { buildCataloguePrompt, buildCitationUnit, CatalogueFormatError, CHOICE_LIMITS, identitySupport, parseCatalogueAnswer, sanitizeSuggestions, type ParsedBlock } from './catalogue-format.js';
import { canonicalListeningDestination, destinationKey, shownDestinationKey, type ListeningDestination } from './destinations.js';
import { createMetadataBudget } from './net/safe-fetch.js';
import { ProviderError, providerServiceCause } from './providers/http.js';
import type { CatalogueAdapter, CatalogueGeneration } from './providers/gemini-catalogue.js';
import { withinCatalogueDeadline } from './providers/catalogue-deadline.js';
import { matchFirstPartyIdentity, matchForm, matchRecordingIdentity, recordingExclusionKeys, type IdentityMatch } from './recording-identity.js';
import type { DestinationVerifier, MetadataResult, RecordingMetadata, YouTubeMetadata } from './verifier.js';
import type { SourceResolver } from './source-resolver.js';

// Native catalogue investigation for one owned InvestigationPlan.
//   one counted generation (native Google Search) -> strict parse -> citation
//   unit -> code pre-checks (owned anchor, exclusions, destination, native
//   support covering the title AND credit claims) -> bounded deterministic
//   metadata checks (exact title/version, complete credits) -> distinct-anchor
//   selection of at most three. Every rejection is recorded as a precise gap;
//   fewer or zero choices is a correct outcome. Titles are never replaced.

export { matchForm };

interface Candidate {
  readonly block: ParsedBlock;
  readonly anchor: { readonly handle: TrackChoice['anchor']['handle']; readonly name: string };
  readonly destination: ListeningDestination;
  readonly sources: number[];
}

export interface NativeCatalogueDeps {
  readonly sources: SourceResolver;
  readonly adapter: CatalogueAdapter;
  /** YouTube destination verifier. */
  readonly verifier: DestinationVerifier;
  /** Apple Music verifier; required exactly when `services` enables apple_music. */
  readonly appleVerifier?: DestinationVerifier;
  /**
   * The controller's immutable recording-service capability (from the live
   * binding). Absent means YouTube only. Copied at construction: nothing the
   * model, a client or a later caller does can widen it.
   */
  readonly services?: readonly RecordingService[];
}

/** Matches deterministic upload metadata against the exact model proposal (exact title/version, complete credits). */
export function matchMetadata(block: Pick<ParsedBlock, 'title' | 'artists'>, anchorName: string, meta: YouTubeMetadata): IdentityMatch {
  return matchRecordingIdentity(block, anchorName, meta);
}

type Identity = { readonly ok: true; readonly credits: string[]; readonly recordingKey: string; readonly evidence: TrackChoice['evidence']; readonly artwork?: TrackChoice['artwork'] } | { readonly ok: false; readonly gap: CandidateGap };

/**
 * Identity for one candidate from the metadata of its own destination kind only:
 * an upload is matched as an upload, a first-party track by its separate fields.
 * Metadata for a different destination than the one requested is a mismatch.
 */
function identityFor(c: Candidate, meta: RecordingMetadata): Identity {
  const d = c.destination;
  if (d.kind === 'youtube') {
    if (meta.kind === 'apple_music' || meta.videoId !== d.videoId) return { ok: false, gap: 'destination_mismatch' };
    const m = matchMetadata(c.block, c.anchor.name, meta);
    if (!m.ok) return m;
    return {
      ok: true,
      credits: m.credits,
      recordingKey: m.recordingKey,
      evidence: { kind: 'native_identity_support_plus_exact_metadata', creditSource: m.creditSource, channelName: meta.channelName, topicChannel: m.topic, versions: m.versions },
    };
  }
  if (meta.kind !== 'apple_music' || meta.trackId !== d.trackId || meta.storefront !== d.storefront) return { ok: false, gap: 'destination_mismatch' };
  const m = matchFirstPartyIdentity(c.block, c.anchor.name, meta);
  if (!m.ok) return m;
  return {
    ok: true,
    credits: m.credits,
    recordingKey: m.recordingKey,
    evidence: { kind: 'native_identity_support_plus_first_party_metadata', service: 'apple_music', creditSource: 'first_party_artist_field', artistName: meta.artistName, versions: m.versions },
    ...(meta.artwork ? { artwork: meta.artwork } : {}),
  };
}

/** Validates a capability list: known, unique, non-empty. */
export function recordingCapability(services: readonly RecordingService[] | undefined): ReadonlySet<RecordingService> {
  const list = services ?? ['youtube'];
  if (list.length === 0 || new Set(list).size !== list.length || !list.every((s) => RECORDING_SERVICES.includes(s))) throw new Error('invalid recording-service capability');
  return new Set(list);
}

export function createNativeCatalogue(deps: NativeCatalogueDeps): CatalogueSeam {
  if (!deps.sources) throw new Error('source resolver required');
  const capability = recordingCapability(deps.services);
  const enabled: readonly RecordingService[] = Object.freeze([...capability]);
  if (capability.has('apple_music') && !deps.appleVerifier) throw new Error('apple_music enabled without its verifier');
  const verifiers: Readonly<Record<RecordingService, DestinationVerifier | null>> = Object.freeze({
    youtube: capability.has('youtube') ? deps.verifier : null,
    apple_music: capability.has('apple_music') ? (deps.appleVerifier ?? null) : null,
  });
  const anySynthetic = deps.sources.synthetic || deps.verifier.synthetic || (deps.appleVerifier?.synthetic ?? false);
  return {
    async investigate(handoff, { plan }, ctx) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      const startedAt = ctx.now();
      const budget = generationBudget(ctx.deadlineAt, startedAt);
      if (budget <= 0) return { kind: 'failed', failure: 'deadline' };
      const deadlineAt = startedAt + budget;

      let generation: CatalogueGeneration;
      try {
        generation = await withinCatalogueDeadline({ signal: ctx.signal, deadlineAt, now: ctx.now }, (guard) =>
          ctx.dispatchGemini((signal, observer) => {
            guard.check();
            return deps.adapter.generate(buildCataloguePrompt(handoff, enabled), {
              signal: AbortSignal.any([signal, guard.signal]), deadlineAt, now: ctx.now, observer,
            });
          }),
        );
      } catch (err) {
        if (err instanceof ProviderError && !ctx.signal.aborted) {
          return { kind: 'failed', failure: err.kind === 'refused' ? 'catalogue_refused' : err.kind === 'deadline' ? 'deadline' : (providerServiceCause(err) ?? 'catalogue_failed') };
        }
        throw err;
      }

      let parsed;
      try {
        parsed = parseCatalogueAnswer(generation.text, new Set(plan.anchors.filter(a => allowedAnchor(plan, a.handle)).map(a => a.name)));
      } catch (err) {
        if (err instanceof CatalogueFormatError) return { kind: 'failed', failure: 'catalogue_failed' };
        throw err;
      }
      const g = generation.grounding;
      // A lost native support would silently change the answer's attribution. Fail the complete unit,
      // even when other valid supports could still verify a recording. Unreferenced chunks are not fetched.
      if (g.invalidSupports > 0) return { kind: 'failed', failure: 'grounding_unavailable' };
      // Search Suggestions are mandatory whenever native Search grounding was used; a missing unit, or one that
      // cannot be presented safely within bounds, is a real failure.
      const searched = g.queries.length > 0 || g.chunks.length > 0 || g.supports.length > 0;
      const suggestionsHtml = g.renderedContent ? sanitizeSuggestions(g.renderedContent) : null;
      if (searched && !suggestionsHtml) return { kind: 'failed', failure: 'grounding_unavailable' };
      const unit = buildCitationUnit(generation.text, g);

      // Preserve the complete attribution unit or fail it whole. Check only
      // citations actually rendered, once per distinct initial URL, with the
      // same aggregate request/concurrency cap as recording metadata below.
      const metaBudget = createMetadataBudget();
      const verifyDeadline = ctx.deadlineAt - 1_000;
      const sources = [...new Set(unit.citations.map((c) => c.url))];
      if (sources.length > LIMITS.metadataRequestsPerExecute) return { kind: 'failed', failure: 'grounding_unavailable' };
      const resolved = await Promise.all(sources.map((url) => metaBudget.slot(() => deps.sources.check(url, {
        signal: ctx.signal, deadlineAt: verifyDeadline, budget: metaBudget, authorize: ctx.authorizeMetadata,
      }))));
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (ctx.now() >= verifyDeadline || resolved.some((r) => !r.ok && (r.reason === 'deadline' || r.reason === 'aborted'))) return { kind: 'failed', failure: 'deadline' };
      if (resolved.some((r) => !r.ok)) return { kind: 'failed', failure: 'grounding_unavailable' };

      const gaps = new Map<CandidateGap, number>();
      const gap = (reason: CandidateGap) => gaps.set(reason, (gaps.get(reason) ?? 0) + 1);
      const exclusions = handoff.exclusions.map(matchForm);
      // Recording-identity exclusions come from the owned plan (never from the model or handoff text).
      // Provider-scoped destination IDs (a YouTube video, an Apple track in any storefront) and,
      // after verification, recording keys shared across providers, storefronts and uploads.
      const shownDestinations = new Set(plan.recordingExclusions.shown.map(shownDestinationKey));
      const excludedKeys = recordingExclusionKeys(plan.recordingExclusions);
      const candidates: Candidate[] = [];
      const seenDestinations = new Set<string>();
      for (const block of parsed.kind === 'choices' ? parsed.blocks : []) {
        const anchor = plan.anchors.find((a) => matchForm(a.name) === matchForm(block.anchor));
        if (!anchor || !allowedAnchor(plan, anchor.handle)) {
          gap('outside_anchor');
          continue;
        }
        if (!block.artists.some((a) => matchForm(a) === matchForm(anchor.name))) {
          gap('anchor_not_declared');
          continue;
        }
        if (block.artists.length > CHOICE_LIMITS.creditArtists) {
          gap('too_many_credits');
          continue;
        }
        if (block.artists.some((a) => exclusions.includes(matchForm(a)))) {
          gap('excluded_artist');
          continue;
        }
        const destination = canonicalListeningDestination(block.listen, capability);
        if (!destination) {
          gap('unsupported_destination');
          continue;
        }
        const destKey = destinationKey(destination);
        if (shownDestinations.has(destKey)) {
          gap('previously_shown');
          continue;
        }
        // Native support must cover the identity-bearing claims (title and credited artists) of this
        // exact block; support for the fit sentence, the anchor line or another block does not count.
        const toCitations = (chunks: readonly number[]) => chunks.map((c) => unit.chunkToCitation.get(c)).filter((n): n is number => n !== undefined);
        const support = identitySupport(block, g);
        const titleSources = toCitations(support.title);
        const artistSources = toCitations(support.artists);
        if (titleSources.length === 0 || artistSources.length === 0) {
          gap(toCitations(support.any).length > 0 ? 'no_identity_support' : 'no_native_support');
          continue;
        }
        const sources = [...titleSources, ...artistSources];
        if (seenDestinations.has(destKey)) {
          gap('duplicate_recording');
          continue;
        }
        seenDestinations.add(destKey);
        candidates.push({ block, anchor, destination, sources: [...new Set(sources)].sort((a, b) => a - b) });
      }

      const checked = await Promise.all(
        candidates.map((c) =>
          metaBudget.slot(async () => {
            const verifier = verifiers[c.destination.kind];
            const result: MetadataResult = verifier
              ? await verifier.lookup(c.destination, { signal: ctx.signal, deadlineAt: verifyDeadline, budget: metaBudget, authorize: ctx.authorizeMetadata })
              : { ok: false, gap: 'unsupported_destination' };
            return { c, result };
          }),
        ),
      );
      if (ctx.signal.aborted) throw ctx.signal.reason;

      const verified: TrackChoice[] = [];
      const keys = new Set<string>();
      for (const { c, result } of checked) {
        if (!result.ok) {
          gap(result.gap);
          continue;
        }
        const m = identityFor(c, result.metadata);
        if (!m.ok) {
          gap(m.gap);
          continue;
        }
        // Mandatory post-verification exclusion: another upload of a shown/known recording is not fresh.
        if (excludedKeys.has(m.recordingKey)) {
          gap('previously_shown');
          continue;
        }
        if (keys.has(m.recordingKey)) {
          gap('duplicate_recording');
          continue;
        }
        keys.add(m.recordingKey);
        verified.push({
          handle: ctx.newHandle(),
          title: c.block.title,
          credits: m.credits,
          unverifiedCredits: 0,
          anchor: { handle: c.anchor.handle, name: c.anchor.name },
          recordingKey: m.recordingKey,
          destination: c.destination,
          ...(m.artwork ? { artwork: m.artwork } : {}),
          fitHypothesis: c.block.why,
          evidence: m.evidence,
          sources: c.sources,
        });
      }

      // One recording per distinct Qloo anchor; fewer choices are valid.
      const chosen: TrackChoice[] = [];
      for (const v of verified) if (chosen.length < LIMITS.trackChoicesPerPanel && !chosen.some((x) => x.anchor.handle === v.anchor.handle)) chosen.push(v);

      const panel: PanelDraft = {
        synthetic: deps.adapter.synthetic || anySynthetic,
        outcome: chosen.length > 0 ? 'choices' : 'no_match',
        choices: chosen,
        answerText: generation.text,
        marks: unit.marks,
        citations: unit.citations,
        suggestionsHtml: suggestionsHtml || null,
        gaps: [...gaps.entries()].map(([reason, count]) => ({ reason, count })),
        recordingKeys: chosen.map((c) => c.recordingKey),
      };
      return { kind: 'panel', panel };
    },
  };
}
