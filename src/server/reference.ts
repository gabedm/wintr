import type { AudioAccess, CanonicalReference, PrivateReferenceResult } from '../shared/records.js';
import { LIMITS } from '../shared/records.js';
import type { CallObserver } from './providers/observation.js';
import type { ReferenceObservationProfile } from './ledger/observation.js';
import type { LiveAudioInput } from './live-audio.js';

// Reference analysis adapter seam. The synthetic adapter reads no environment,
// credentials or network and labels every output as synthetic. The Gemini
// adapters are selected only by the explicitly bound live composition.

export const MAX_FINAL_TEXT_BYTES = 512 * 1024;

export interface ReferenceInput {
  readonly reference: CanonicalReference;
  readonly listenerCue: string | null;
  /** Ephemeral, one admitted execute only. Never copied into any owned record. */
  readonly audio?: Uint8Array;
  /** A distinct admitted live stream, never persisted or treated as a completed recording. */
  readonly stream?: LiveAudioInput;
}

export interface ReferenceAdapterResult {
  readonly audioAccess: AudioAccess;
  readonly observations: readonly string[];
  readonly relationships: readonly string[];
  /** Server-only provider metadata (final text, usage). Null for synthetic output. */
  readonly provider?: PrivateReferenceResult | null;
}

export interface ReferenceAdapter {
  readonly synthetic: boolean;
  readonly liveListening?: { readonly maxSeconds: 20 };
  /** Server-only accounting identity; live adapters declare their exact observation profile. */
  readonly observationProfile?: ReferenceObservationProfile;
  readonly observationProfileFor?: (input: ReferenceInput) => ReferenceObservationProfile;
  analyse(input: ReferenceInput, signal: AbortSignal, observer?: CallObserver, execution?: ReferenceExecutionContext): Promise<ReferenceAdapterResult>;
}

/** Absolute end captured by the harness before asynchronous admission; it cannot be restarted by an adapter. */
export interface ReferenceExecutionContext {
  readonly deadlineAt: number;
  /** Perform the last durable owner read, then invoke send synchronously. No lease or write. */
  readonly dispatch?: <T>(send: () => Promise<T>) => Promise<T>;
}

export class AdapterOutputError extends Error {}

/** Rejects (never truncates) adapter output that exceeds H06 bounds. */
export function validateAdapterResult(value: unknown): ReferenceAdapterResult & { provider: PrivateReferenceResult | null } {
  if (typeof value !== 'object' || value === null) throw new AdapterOutputError('not an object');
  const { audioAccess, observations, relationships, provider } = value as Record<string, unknown>;
  if (provider !== undefined && provider !== null) {
    const p = provider as Partial<PrivateReferenceResult>;
    if (typeof p.model !== 'string' || typeof p.finalText !== 'string' || Buffer.byteLength(p.finalText) > MAX_FINAL_TEXT_BYTES) {
      throw new AdapterOutputError('provider');
    }
  }
  const access: readonly AudioAccess[] = ['synthetic_not_accessed', 'accessed', 'unavailable', 'refused'];
  if (!access.includes(audioAccess as AudioAccess)) throw new AdapterOutputError('audioAccess');
  const list = (v: unknown, max: number, chars: number, name: string) => {
    if (!Array.isArray(v) || v.length > max || v.some((s) => typeof s !== 'string' || s.trim() === '' || s.length > chars)) {
      throw new AdapterOutputError(name);
    }
    return v as string[];
  };
  return {
    audioAccess: audioAccess as AudioAccess,
    observations: list(observations, LIMITS.observations, LIMITS.observationChars, 'observations'),
    relationships: list(relationships, LIMITS.relationships, LIMITS.relationshipChars, 'relationships'),
    provider: (provider as PrivateReferenceResult | null | undefined) ?? null,
  };
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createSyntheticReferenceAdapter(delayMs: number): ReferenceAdapter {
  return {
    synthetic: true,
    async analyse(_input, signal) {
      await abortableDelay(delayMs, signal);
      return {
        audioAccess: 'synthetic_not_accessed',
        observations: [
          'Synthetic placeholder: no audio was analysed and no model was called. This text says nothing about your reference.',
        ],
        relationships: ['Synthetic option A (placeholder)', 'Synthetic option B (placeholder)', 'Synthetic option C (placeholder)'],
      };
    },
  };
}
