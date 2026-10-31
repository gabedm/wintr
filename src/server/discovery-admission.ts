import type { DiscoveryAvailability } from '../shared/records.js';
import { LIMITS } from '../shared/records.js';
import { normalizeName } from './identity.js';
import type { SessionBucket } from './store.js';

type DiscoveryState = Pick<SessionBucket, 'journey' | 'analysis' | 'attempt' | 'brief' | 'briefs' | 'checkpoint' | 'panel'>;
const artistSet = (names: readonly string[]) => JSON.stringify([...new Set(names.map(normalizeName))].sort());

/** Read-only derived availability; admission recomputes it inside the same Store transaction. */
export function discoveryAvailability(state: DiscoveryState): DiscoveryAvailability {
  const { journey, analysis, attempt, brief, checkpoint, panel } = state;
  if (!journey || !analysis || !brief || panel) return 'unavailable';
  if (journey.discoverRuns === 0) return 'available';
  if (!attempt || attempt.kind !== 'discover' || attempt.outcome === 'running') return 'unavailable';
  // A successful human boundary resumes its unexecuted stages, not a failed submission.
  const returned = attempt.calls.every(c => c.state === 'returned' || c.state === 'withdrawn');
  if (checkpoint?.awaiting && checkpoint.briefId === attempt.briefId && brief.id === attempt.briefId && attempt.outcome === 'succeeded' && returned) return 'available';
  if (journey.discoverRuns >= LIMITS.discoverRunsPerJourney) return 'unavailable';
  const previous = state.briefs.find(b => b.id === attempt.briefId);
  // With no panel, a succeeded Discover ended at the human identity boundary.
  // An explicit changed-artist save is a legitimate counted correction, not a
  // resend of a failed or uncertain provider submission.
  if (attempt.outcome === 'succeeded' && returned && previous) {
    return artistSet(previous.proposedArtists) === artistSet(brief.proposedArtists) ? 'edit_artists' : 'available';
  }
  if (attempt.outcome !== 'failed') return 'unavailable';
  // Unknown dispatch, deadline and refusal are never evidence that sending again is safe.
  if (attempt.failure === 'deadline' || attempt.failure === 'catalogue_refused' || attempt.calls.some(c => c.state === 'in_flight')) return 'unavailable';
  // Only the durable absence of dispatch intent permits an ordinary pre-send retry.
  if (attempt.calls.every(c => c.state === 'not_started' || c.state === 'reserved' || c.state === 'withdrawn') &&
    (attempt.failure === 'capacity' || attempt.failure === 'admission_unavailable' || attempt.failure === 'catalogue_not_configured')) return 'available';
  // These are known semantic outcomes, not generic HTTP/schema/transport failures.
  // Correcting their artist set changes the investigation; editing prose or provenance does not.
  if ((attempt.failure === 'no_seed' || attempt.failure === 'pool_empty') &&
    attempt.calls.every(c => c.state === 'returned' || c.state === 'withdrawn')) {
    if (previous) return artistSet(previous.proposedArtists) === artistSet(brief.proposedArtists) ? 'edit_artists' : 'available';
  }
  return 'unavailable';
}
