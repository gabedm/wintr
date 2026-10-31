import type {
  AnswerMark,
  AttemptFailure,
  CandidateGap,
  GroundingCitation,
  Handle,
  InvestigationPlan,
  QlooCandidatePool,
  TrackChoice,
} from '../shared/records.js';
import { LIMITS } from '../shared/records.js';
import type { CallObserver } from './providers/observation.js';
import type { ObservationProfile } from './ledger/observation.js';

// Seam to the catalogue investigation. The graph hands it the owned
// InvestigationPlan (with its canonical pool) inside the same execute, so
// Discover continues without another human confirmation. The native
// implementation lives in native-catalogue.ts. The not-configured seam is never
// a recommendation, never a claim that no tracks exist and never marks the
// product complete.

/** Minimal catalogue handoff: public names plus internal owned handles. No provider IDs, scores or raw results. */
export interface CatalogueHandoff {
  readonly plan: Handle;
  readonly briefVersion: number;
  readonly relationship: string;
  readonly referenceObservations?: readonly string[];
  readonly seedMix: readonly string[];
  readonly attribution: 'seed_mix';
  readonly allowedArtists: readonly { readonly ref: Handle; readonly name: string }[];
  readonly associations: readonly { readonly ref: Handle; readonly name: string }[];
  /** Artist names whose recordings must not be chosen. Never recording identities. */
  readonly exclusions: readonly string[];
  /** Exact recordings already shown (public title and credits only), kept separate from artist exclusions. */
  readonly excludedRecordings: readonly { readonly title: string; readonly artists: readonly string[] }[];
  readonly priorities: readonly string[];
}

/** A verified panel ready for the harness to re-validate and commit. */
export interface PanelDraft {
  readonly synthetic: boolean;
  readonly catalogueMode?: 'native_google' | 'first_party_candidates';
  readonly outcome: 'choices' | 'no_match';
  readonly choices: readonly TrackChoice[];
  readonly answerText: string;
  readonly marks: readonly AnswerMark[];
  readonly citations: readonly GroundingCitation[];
  readonly suggestionsHtml: string | null;
  readonly gaps: readonly { readonly reason: CandidateGap; readonly count: number }[];
  readonly recordingKeys: readonly string[];
}

export type CatalogueOutcome =
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'panel'; readonly panel: PanelDraft }
  | { readonly kind: 'failed'; readonly failure: AttemptFailure };

export interface CatalogueContext {
  /** Current actual Attempt, required by the candidate mode; native compatibility contexts may omit it. */
  readonly executeRef?: Handle;
  /** Fresh shared owner/Attempt/brief/plan/pool authority for metadata; live graph supplies it to both catalogue paths. */
  readonly authorizeMetadata?: () => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly now: () => number;
  /** The Attempt's execute deadline. */
  readonly deadlineAt: number;
  /** Re-authorises the running Attempt, counts one Gemini submission against the shared caps, checks the signal and invokes once. */
  readonly dispatchGemini: <T>(call: (signal: AbortSignal, observer?: CallObserver) => Promise<T>, profile?: ObservationProfile) => Promise<T>;
  readonly newHandle: () => Handle;
}

export interface CatalogueSeam {
  investigate(
    handoff: CatalogueHandoff,
    inputs: { readonly plan: InvestigationPlan; readonly pool: QlooCandidatePool },
    ctx: CatalogueContext,
  ): Promise<CatalogueOutcome>;
}

/** Generation gets min(90 s, remaining execute time minus the 20 s validation/commit reserve). */
export const generationBudget = (deadlineAt: number, now: number) =>
  Math.min(LIMITS.providerRequestMs, deadlineAt - now - LIMITS.validationReserveMs);

export const notConfiguredCatalogue: CatalogueSeam = {
  async investigate() {
    return { kind: 'not_configured' };
  },
};

export class HandoffTooLarge extends Error {}

export function buildCatalogueHandoff(plan: InvestigationPlan): CatalogueHandoff {
  const handoff: CatalogueHandoff = {
    plan: plan.id,
    briefVersion: plan.briefVersion,
    relationship: plan.relationship,
    ...(plan.referenceObservations ? { referenceObservations: [...plan.referenceObservations] } : {}),
    seedMix: plan.seedNames,
    attribution: plan.attribution,
    allowedArtists: plan.anchors.map((a) => ({ ref: a.handle, name: a.name })),
    associations: plan.associations.map((a) => ({ ref: a.handle, name: a.name })),
    exclusions: plan.exclusions,
    excludedRecordings: plan.recordingExclusions.shown.map((r) => ({ title: r.title, artists: r.credits })),
    priorities: plan.priorities,
  };
  if (Buffer.byteLength(JSON.stringify(handoff)) > LIMITS.catalogueHandoffBytes) throw new HandoffTooLarge();
  return handoff;
}

/** A recording's anchor must be an artist owned by this plan's pool; anything else is outside the allowed space. */
export const allowedAnchor = (plan: InvestigationPlan, ref: unknown) =>
  typeof ref === 'string' ? (plan.anchors.find((a) => a.handle === ref) ?? null) : null;

const list = (names: readonly string[], max = 4) => {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
};

/** Factual connection chain rendered from validated owned records, not generated text. */
export function connectionWhy(plan: InvestigationPlan, pool: QlooCandidatePool): string[] {
  const source = pool.synthetic ? 'The synthetic local fixture (not Qloo)' : 'Qloo';
  const seeds = plan.seedNames.join(' and ');
  const reused = plan.provenance.poolReuse === 'reused_same_fingerprint';
  const lines = [
    `You chose to keep: “${plan.relationship}”.`,
    `Starting ${plan.seedNames.length > 1 ? 'artists' : 'artist'}: ${seeds}.`,
    `${source} returned ${pool.artists.length} connected ${pool.artists.length === 1 ? 'artist' : 'artists'} for ${
      plan.seedNames.length > 1 ? 'that seed mix' : 'that artist'
    }, including ${list(pool.artists.map((a) => a.identity.name))}.`,
    ...(reused
      ? [
          'These artist connections were reused from the earlier search; no new artist lookup was made.',
          ...(plan.anchors.length < pool.artists.length ? [`${plan.anchors.length} of them are used now, after the artists you left out.`] : []),
        ]
      : []),
    plan.associations.length > 0
      ? `Associated tags returned for ${plan.seedNames.length > 1 ? 'the seed mix' : 'the artist'}: ${list(
          plan.associations.map((t) => t.name),
          6,
        )}. These describe artists culturally, not the sound of any recording.`
      : pool.lineage.tagOutcome === 'not_admitted' && pool.origin === 'follow_connection'
        ? 'Tags were not requested for this follow-up search, so only artist connections are used.'
        : 'Tag associations were not available, so only artist connections are used.',
    'No recording has been checked yet.',
  ];
  return lines;
}

/** Factual description of how a panel's plan was produced (no invented per-seed causal claims). */
export function refinementBasisLines(plan: InvestigationPlan, pool: QlooCandidatePool): string[] {
  const r = plan.refinement;
  if (!r) return [];
  const source = pool.synthetic ? 'the synthetic local fixture (not Qloo)' : 'Qloo';
  const shown = plan.recordingExclusions.shown.length;
  const shownLine = shown > 0 ? `${shown} ${shown === 1 ? 'recording' : 'recordings'} already shown ${shown === 1 ? 'was' : 'were'} left out.` : null;
  if (plan.refinementMode === 'follow_connection') {
    return [
      `Followed ${r.followed} from a recording you liked.`,
      r.keptStarting ? `Kept your starting artist ${r.keptStarting}.` : `No verified starting artist was available to keep, so the new search starts from ${r.followed} alone.`,
      ...(r.replaced.length > 0 ? [`${list([...r.replaced])} (your optional artist) was replaced by ${r.followed} for this search.`] : []),
      `A new artist lookup asked ${source} for artists connected to ${plan.seedNames.join(' and ')} together.`,
      ...(shownLine ? [shownLine] : []),
    ];
  }
  return [
    'The artist connections from the earlier search were reused; no new artist lookup was made.',
    r.relationshipChanged ? `Now keeping: “${plan.relationship}”.` : `Still keeping: “${plan.relationship}”.`,
    ...(r.excludedArtists.length > 0 ? [`Left out at your request: ${list([...r.excludedArtists])}.`] : []),
    ...(shownLine ? [shownLine] : []),
  ];
}
