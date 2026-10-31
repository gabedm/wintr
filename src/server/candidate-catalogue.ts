import { LIMITS, type CandidateGap, type Handle, type TrackChoice } from '../shared/records.js';
import { createAppleCandidateBatchBuilder, trustedAppleCandidate, type OwnedAppleCandidate } from './apple-candidate-batch.js';
import type { AppleCatalogueSearch } from './apple-catalogue-search.js';
import { APPLE_DISPATCH_LAG_MS, type AppleMetadataRateGate } from './apple-metadata-rate.js';
import { buildCatalogueHandoff, generationBudget, type CatalogueSeam, type PanelDraft } from './catalogue.js';
import { destinationKey, shownDestinationKey } from './destinations.js';
import type { IdentityOwner } from './identity.js';
import { createMetadataBudget } from './net/safe-fetch.js';
import { withinCatalogueDeadline } from './providers/catalogue-deadline.js';
import { parseCandidateSelection, type CandidateSelector } from './providers/gemini-candidate-selector.js';
import { ProviderError, providerServiceCause } from './providers/http.js';
import { matchFirstPartyIdentity, matchForm, recordingExclusionKeys } from './recording-identity.js';
import type { RecordSealer } from './seal.js';
import type { DestinationVerifier } from './verifier.js';
import { CANDIDATE_SELECTOR_OBSERVATION_PROFILE } from './ledger/observation.js';

/** Explicit alternative catalogue seam. Importing/constructing it never activates live access. */
export interface CandidateCatalogueDeps {
  readonly search: AppleCatalogueSearch;
  readonly searchSynthetic: boolean;
  readonly gate: AppleMetadataRateGate;
  readonly sealer: RecordSealer;
  readonly selector: CandidateSelector;
  readonly verifier: DestinationVerifier;
  readonly storefront: string;
  readonly expiresAt: number;
}

export function createCandidateCatalogue(deps: CandidateCatalogueDeps): CatalogueSeam {
  const { gate, sealer, search, searchSynthetic, selector, verifier, storefront, expiresAt } = deps;
  if (!/^[a-z]{2}$/.test(storefront) || !Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > gate.bindingExpiresAt) throw new TypeError('Invalid candidate catalogue binding');
  const builder = createAppleCandidateBatchBuilder({ search, gate, sealer, syntheticTransport: searchSynthetic });
  const build = builder.build.bind(builder), select = selector.select.bind(selector), lookup = verifier.lookup.bind(verifier), admit = gate.admit.bind(gate);
  const profile = selector.observationProfile;
  if (profile !== CANDIDATE_SELECTOR_OBSERVATION_PROFILE) throw new TypeError('Invalid selector observation profile');
  const selectorSynthetic = selector.synthetic, verifierSynthetic = verifier.synthetic;
  return Object.freeze({
    async investigate(_handoff, input, context) {
      // Capture once. Neither another request nor a late caller mutation can replace this execute's authority.
      const { signal, now: clock, deadlineAt: executeDeadline, executeRef, newHandle, dispatchGemini, authorizeMetadata } = context;
      if (typeof authorizeMetadata !== 'function' || typeof executeRef !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(executeRef)) return { kind: 'failed', failure: 'catalogue_failed' };
      const { plan, pool } = structuredClone(input);
      const owner: IdentityOwner = Object.freeze({ sessionId: plan.sessionId, epoch: plan.epoch, journeyId: plan.journeyId, expiresAt: plan.expiresAt });
      const expected = Object.freeze({ owner, executeRef, planId: plan.id, poolId: pool.id });
      const handoff = buildCatalogueHandoff(plan);
      const deadlineAt = Math.min(executeDeadline - 1000, owner.expiresAt, expiresAt, gate.bindingExpiresAt);
      let latest = clock();
      const now = () => {
        const t = clock();
        if (!Number.isSafeInteger(t) || t < 0 || t < latest) throw new ProviderError('gemini', 'config', false);
        latest = t; return t;
      };
      const gaps = new Map<CandidateGap, number>();
      const gap = (why: CandidateGap, n = 1) => gaps.set(why, (gaps.get(why) ?? 0) + n);
      const metadataBudget = createMetadataBudget(); // Search AND every selected-ID lookup share this exact budget.
      const excludedKeys = recordingExclusionKeys(plan.recordingExclusions);
      const excludedDestinations = new Set(plan.recordingExclusions.shown.map(shownDestinationKey));
      const excludedArtists = new Set(plan.exclusions.map(matchForm));
      const finish = (choices: readonly TrackChoice[], synthetic: boolean): { readonly kind: 'panel'; readonly panel: PanelDraft } => ({
        kind: 'panel', panel: {
          catalogueMode: 'first_party_candidates', synthetic, outcome: choices.length ? 'choices' : 'no_match', choices,
          answerText: choices.length
            ? `These are exploratory choices from ${pool.synthetic ? 'synthetic artist connections' : 'Qloo’s artist connections'}, with identity checked against the catalogue. Fit remains a hypothesis.\n\n${choices.map(c => `${c.title} — ${c.credits.join(', ')}. ${c.fitHypothesis}`).join('\n\n')}`
            : 'No recording was confirmed in this bounded catalogue search. This does not mean no suitable recordings exist.',
          marks: [], citations: [], suggestionsHtml: null,
          gaps: [...gaps].map(([reason, count]) => ({ reason, count })), recordingKeys: choices.map(c => c.recordingKey),
        },
      });
      try {
        return await withinCatalogueDeadline({ signal, deadlineAt, now }, async guard => {
          const authorize = async () => { guard.check(); const allowed = await authorizeMetadata(); guard.check(); return allowed; };
          const built = await build({ plan, pool, owner, executeRef, storefront }, {
            signal: guard.signal, deadlineAt, now, newHandle, budget: metadataBudget, authorize,
          });
          guard.check();
          if (built.status !== 'batch') return { kind: 'failed', failure: ['deadline', 'expired', 'binding_expired'].includes(built.reason) ? 'deadline' : 'catalogue_failed' };
          const batch = built.batch;
          const synthetic = batch.synthetic.pool || batch.synthetic.transport || selectorSynthetic || verifierSynthetic;
          for (const a of batch.anchors) if (a.status === 'unavailable') {
            gap(a.reason.includes('throttled') || a.reason === 'admission_rate_limited' ? 'metadata_throttled'
              : a.reason === 'metadata_cap' ? 'metadata_cap'
              : a.reason === 'no_results' || a.reason === 'no_matching_candidates' ? 'candidate_set_empty' : 'catalogue_search_unavailable');
          }
          if (batch.dropped.alreadyShown) gap('previously_shown', batch.dropped.alreadyShown);
          const candidates: OwnedAppleCandidate[] = [];
          const candidateKeys = new Set<string>();
          for (const value of batch.candidates) {
            const c = trustedAppleCandidate(batch, value.ref, expected, now());
            if (!c) throw new ProviderError('gemini', 'schema', false);
            // The initial conservative search supports a single exact anchor credit. Ambiguous collaborations abstain.
            const identity = matchFirstPartyIdentity({ title: c.title, artists: [c.anchor.name] }, c.anchor.name, { trackName: c.title, artistName: c.artistName });
            if (!identity.ok) { gap(identity.gap); continue; }
            if (identity.credits.some(a => excludedArtists.has(matchForm(a)))) { gap('excluded_artist'); continue; }
            if (excludedKeys.has(identity.recordingKey) || excludedDestinations.has(destinationKey(c.destination))) { gap('previously_shown'); continue; }
            if (candidateKeys.has(identity.recordingKey)) { gap('duplicate_recording'); continue; }
            candidateKeys.add(identity.recordingKey); candidates.push(c);
          }
          if (candidates.length === 0) {
            // An outage is a failed investigation, not evidence of empty coverage.
            // Never submit Gemini without candidates or refund an admitted attempt.
            if (batch.anchors.every(a => a.status === 'unavailable' && a.reason !== 'no_results' && a.reason !== 'no_matching_candidates')) {
              return { kind: 'failed', failure: 'catalogue_failed' };
            }
            if (gaps.size === 0) gap('candidate_set_empty');
            return finish([], synthetic); // No useful candidates means no Gemini submission.
          }
          const generationStartedAt = now();
          const generationMs = generationBudget(deadlineAt, generationStartedAt);
          if (generationMs <= 0) throw new ProviderError('gemini', 'deadline', false);
          const selectionDeadline = generationStartedAt + generationMs;
          const selection = await withinCatalogueDeadline({ signal: guard.signal, deadlineAt: selectionDeadline, now }, selectionGuard =>
            dispatchGemini((countedSignal, observer) => {
              selectionGuard.check(); guard.check();
              for (const c of candidates) if (!trustedAppleCandidate(batch, c.ref, expected, now())) throw new ProviderError('gemini', 'config', false);
              return select(handoff, candidates.map(c => ({ ref: c.ref, title: c.title, artist: c.artistName, anchor: c.anchor.name })), {
                signal: AbortSignal.any([countedSignal, selectionGuard.signal, guard.signal]), now, deadlineAt: selectionDeadline, observer,
              });
            }, profile));
          guard.check();
          const selected = parseCandidateSelection(JSON.stringify({ choices: selection.choices }), new Set(candidates.map(c => c.ref)));
          const choices: TrackChoice[] = [];
          let verificationAttempts = 0, unavailableVerifications = 0;
          const recordingKeys = new Set<string>();
          const verify = async (item: (typeof selected)[number]): Promise<TrackChoice | null> => {
            const c = trustedAppleCandidate(batch, item.candidateRef, expected, now());
            if (!c) throw new ProviderError('gemini', 'schema', true);
            verificationAttempts += 1;
            const result = await metadataBudget.slot(async () => {
              guard.check();
              if (!(await authorize())) throw new ProviderError('gemini', 'config', true);
              guard.check();
              if (!metadataBudget.take()) return { ok: false as const, gap: 'metadata_cap' as const, operational: true as const };
              const grant = await admit({ signal: guard.signal, deadlineAt, scopeExpiresAt: owner.expiresAt });
              guard.check();
              // The verifier's safeGet performs fresh post-admission authority
              // before DNS and again before HTTP; avoid a duplicate read here.
              if (!grant.admitted) return { ok: false as const, gap: grant.reason === 'rate_limited' ? 'metadata_throttled' as const : 'catalogue_search_unavailable' as const, operational: true as const };
              const dispatchBy = Math.min(grant.dispatchBy, grant.at + APPLE_DISPATCH_LAG_MS, deadlineAt, expiresAt);
              const t = now();
              if (!Number.isSafeInteger(grant.at) || !Number.isSafeInteger(dispatchBy) || t < grant.at || t >= dispatchBy) return { ok: false as const, gap: 'deadline' as const, operational: true as const };
              if (!trustedAppleCandidate(batch, c.ref, expected, t)) throw new ProviderError('gemini', 'config', true);
              let spent = false;
              return lookup(c.destination, { signal: guard.signal, deadlineAt, dispatchBy,
                budget: { take: () => !spent && (spent = true), slot: fn => fn(), used: () => metadataBudget.used() }, authorize });
            });
            guard.check();
            if (!result.ok) { gap(result.gap); if (result.operational === true) unavailableVerifications += 1; return null; }
            const meta = result.metadata;
            if (meta.kind !== 'apple_music' || meta.trackId !== c.trackId || meta.storefront !== c.storefront) { gap('destination_mismatch'); return null; }
            const identity = matchFirstPartyIdentity({ title: c.title, artists: [c.anchor.name] }, c.anchor.name, meta);
            if (!identity.ok) { gap(identity.gap); return null; }
            if (excludedKeys.has(identity.recordingKey) || excludedDestinations.has(destinationKey(c.destination))) { gap('previously_shown'); return null; }
            if (!trustedAppleCandidate(batch, c.ref, expected, now())) throw new ProviderError('gemini', 'config', true);
            return { handle: newHandle(), title: c.title, credits: identity.credits, unverifiedCredits: 0, anchor: c.anchor,
              recordingKey: identity.recordingKey, destination: c.destination, ...(meta.artwork ? { artwork: meta.artwork } : {}), fitHypothesis: item.fitHypothesis,
              evidence: { kind: 'first_party_search_plus_exact_metadata', service: 'apple_music', creditSource: 'first_party_artist_field', artistName: meta.artistName, versions: identity.versions }, sources: [] };
          };
          // Independent artist checks overlap within the existing three-slot
          // budget. Same-artist alternatives remain sequential, so neither the
          // lookup count nor the fallback behavior grows. Publish in selector order.
          const groups = new Map<Handle, (typeof selected)[number][]>();
          for (const item of selected) {
            const c = trustedAppleCandidate(batch, item.candidateRef, expected, now());
            if (!c) throw new ProviderError('gemini', 'schema', true);
            const group = groups.get(c.anchor.handle) ?? []; group.push(item); groups.set(c.anchor.handle, group);
          }
          const verified = await Promise.allSettled([...groups.values()].map(async items => {
            for (let i = 0; i < items.length; i++) {
              const choice = await verify(items[i]!);
              if (choice) {
                if (i + 1 < items.length) gap('duplicate_recording', items.length - i - 1);
                return { index: selected.indexOf(items[i]!), choice };
              }
            }
            return null;
          }));
          guard.check();
          const ordered: { index: number; choice: TrackChoice }[] = [];
          for (const result of verified) {
            if (result.status === 'rejected') throw result.reason;
            if (result.value) ordered.push(result.value);
          }
          for (const { choice } of ordered.sort((a, b) => a.index - b.index)) {
            if (recordingKeys.has(choice.recordingKey)) { gap('duplicate_recording'); continue; }
            recordingKeys.add(choice.recordingKey); choices.push(choice);
          }
          guard.check();
          if (choices.length === 0 && verificationAttempts > 0 && unavailableVerifications === verificationAttempts) return { kind: 'failed', failure: 'catalogue_failed' };
          return finish(choices, synthetic);
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof ProviderError) return { kind: 'failed', failure: error.kind === 'refused' ? 'catalogue_refused' : error.kind === 'deadline' ? 'deadline' : providerServiceCause(error) ?? 'catalogue_failed' };
        throw error;
      }
    },
  } satisfies CatalogueSeam);
}
