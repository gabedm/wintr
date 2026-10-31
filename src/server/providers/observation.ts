import type { StageKey } from '../ledger/policy.js';
import { STAGE_PROVIDER } from '../ledger/policy.js';
import { elapsed, emptyObservedUsage, liveObservationProfile, OBSERVATION_PROFILES, observeUsage, type ObservationProfile, type ObservationWrite, type SubmissionObservation, type UsageFormat } from '../ledger/observation.js';
import { ProviderError } from './http.js';

/** Explicit call-local capability. It carries no prompt, URL, response content or credentials. */
export interface CallObserver {
  adapterEntered(): void;
  transportPending(): void;
  /** A trusted transport guard refused before invoking its inner transport. */
  transportNotInvoked(): void;
  transportStarted(): void;
  transportFinished(status: number | null): void;
  usage(raw: unknown, format: UsageFormat): void;
  searchQueries(raw: unknown): void;
  usageDecoded(): void;
}

export function createCallObserver(stage: StageKey, startedAt: number, now: () => number, persist: (o: SubmissionObservation) => Promise<ObservationWrite>, profile: ObservationProfile = OBSERVATION_PROFILES[stage]) {
  if (!liveObservationProfile(stage, profile)) throw new ProviderError('gemini', 'config', false);
  const o: SubmissionObservation = {
    version: 1, revision: 0, provider: STAGE_PROVIDER[stage], stage, profile,
    adapterStartedAt: startedAt, adapterEndedAt: null, preparationMs: null, invocation: 'pending', transportStartedAt: null, transportEndedAt: null, transportMs: null,
    transportOutcome: 'pending', status: null, outcome: 'pending', error: null, clockInvalid: false, usage: emptyObservedUsage(),
  };
  let entered = false; let attempted = false; let refusedBeforeTransport = false; let latest = startedAt; let last = ''; let scheduled = false;
  const writes: Promise<ObservationWrite>[] = [];
  const time = () => {
    let t: number;
    try { t = now(); } catch { o.clockInvalid = true; return null; }
    if (!Number.isSafeInteger(t) || t < latest) { o.clockInvalid = true; return null; }
    latest = t; return latest;
  };
  const updateElapsed = () => {
    o.preparationMs = elapsed(startedAt, o.transportStartedAt ?? (o.invocation === 'zero' ? o.adapterEndedAt : null));
    o.transportMs = elapsed(o.transportStartedAt, o.transportEndedAt);
  };
  const publish = () => {
    updateElapsed();
    // All preparation, transport and cumulative SSE events stay in memory.
    // Coalesce terminal/interrupt updates in this turn. Only genuinely later
    // completion can enrich again: at most three writes, never event-per-write.
    if (o.outcome === 'pending' || scheduled || writes.length >= 3) return;
    scheduled = true;
    const revision = writes.length;
    const previous = writes.at(-1) ?? Promise.resolve<ObservationWrite>('replay');
    const pending = new Promise<ObservationWrite>((resolve) => {
      setTimeout(() => {
        scheduled = false; updateElapsed();
        const json = JSON.stringify({ ...o, revision: 0 });
        if (json === last) { resolve('replay'); return; }
        last = json; o.revision = revision;
        const snapshot = structuredClone(o);
        // A new enrichment is attempted once, after the preceding write has
        // answered. A failed write is reported; no retry loop is introduced.
        previous.then(() => persist(snapshot)).then(resolve, () => resolve('unavailable'));
      }, 0);
    });
    writes.push(pending);
  };
  const observer: CallObserver = Object.freeze({
    adapterEntered() { entered = true; },
    transportPending() { attempted = true; },
    transportNotInvoked() { if (o.invocation !== 'one') refusedBeforeTransport = true; },
    transportStarted() {
      if (o.invocation === 'one') return;
      o.invocation = 'one'; o.transportStartedAt = time(); publish();
    },
    transportFinished(status: number | null) {
      if (refusedBeforeTransport && o.invocation !== 'one') return;
      if (o.transportOutcome !== 'pending') return;
      if (o.invocation === 'one') o.transportEndedAt = time();
      o.transportOutcome = status === null ? 'error' : 'response'; o.status = status; publish();
    },
    usage(raw: unknown, format: UsageFormat) { observeUsage(o.usage, raw, format); },
    searchQueries(raw: unknown) {
      const c = o.usage.searchQueries;
      if (raw === undefined) { if (c.state === 'unknown') c.state = 'missing'; return; }
      if (Array.isArray(raw) && raw.length <= 10 && raw.every((s) => typeof s === 'string' && s.length <= 200)) {
        c.state = 'known'; c.value = Math.max(c.value ?? 0, raw.length);
      } else { if (c.state === 'unknown') c.state = 'missing'; c.malformed = true; }
    },
    usageDecoded() { publish(); },
  });
  return {
    observer,
    interrupt(deadline: boolean) {
      if (o.outcome !== 'pending') return;
      o.outcome = deadline ? 'deadline' : 'aborted'; o.error = deadline ? 'deadline' : 'aborted';
      if (o.invocation === 'pending') o.invocation = 'unknown'; publish();
    },
    finish(error?: unknown, failed = error !== undefined) {
      o.adapterEndedAt ??= time();
      if (o.invocation !== 'one') o.invocation = entered && (!attempted || refusedBeforeTransport) && o.adapterEndedAt !== null ? 'zero' : 'unknown';
      if (o.outcome === 'pending') {
        o.error = !failed ? null : error instanceof ProviderError ? error.kind : 'unclassified';
        o.outcome = !failed ? 'returned' : o.error === 'aborted' ? 'aborted' : o.error === 'deadline' ? 'deadline' : 'failed';
      }
      publish();
    },
    snapshot: () => { updateElapsed(); return structuredClone(o); },
    /** Explicit controller/test acknowledgement wait; never used to delay Stop/Clear. */
    flush: () => Promise.all(writes),
  };
}
