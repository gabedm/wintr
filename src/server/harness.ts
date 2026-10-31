import type { Attempt, Handle, SubmissionStage } from '../shared/records.js';
import { LIMITS } from '../shared/records.js';
import { ProviderError, providerServiceCause } from './providers/http.js';
import { liveObservationProfile, type ObservationProfile } from './ledger/observation.js';
import { validateAdapterResult, type ReferenceAdapter, type ReferenceInput } from './reference.js';
import type { Owner, Store, SubmissionGrant, SubmissionReserve } from './store.js';
import { createCallObserver, type CallObserver } from './providers/observation.js';

// Finite harness. The harness (not adapters or models) owns stage transitions.
// - Cancellation is registered before any dispatch-authority transaction, so a
//   Stop/Clear that lands while it is pending is still observed.
// - The signal is checked synchronously immediately before invoking an adapter.
// - Execution is raced against Stop/Clear/deadline so the request settles
//   promptly even if an adapter ignores its abort signal.
// - Every commit is re-authorised against the store; a late result is dropped.
// - Once an adapter has been invoked, a Stop/deadline leaves its dispatch
//   'in_flight' (unknown, held). It is never treated as a refund.

export interface HarnessDeps {
  readonly store: Store;
  readonly adapter: ReferenceAdapter;
  readonly now: () => number;
  /** Best-effort abort signals for in-flight work. Authority stays in the store. */
  readonly inflight: Map<Handle, AbortController>;
}

export interface Execution {
  readonly signal: AbortSignal;
  /** Resolves with p, or rejects as soon as the execution is aborted (Stop/Clear/deadline). */
  race<T>(p: Promise<T>): Promise<T>;
  /** 'deadline', another abort reason, or null when not aborted. */
  abortReason(): unknown;
  close(): void;
}

/** Registers cancellation and the execute deadline for one admitted Attempt. */
export function openExecution(attempt: Attempt, budgetMs: number, inflight: Map<Handle, AbortController>): Execution {
  const controller = new AbortController();
  inflight.set(attempt.id, controller);
  const timer = setTimeout(() => controller.abort('deadline'), Math.max(0, budgetMs));
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => {});
  return {
    signal: controller.signal,
    race: <T>(p: Promise<T>) => Promise.race([p, aborted]),
    abortReason: () => (controller.signal.aborted ? (controller.signal.reason ?? 'aborted') : null),
    close() {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      inflight.delete(attempt.id);
    },
  };
}

/** Invokes synchronously after the caller's last check; a synchronous throw becomes a rejection. */
export function invoke<T>(call: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(call());
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Accounting-only follow-up that can never crash the process or log content. */
export function afterSettled(p: Promise<unknown>, note: () => Promise<void>) {
  const run = () => {
    Promise.resolve()
      .then(note)
      .catch(() => {});
  };
  p.then(run, run);
}

/** A submission the store did not authorise; nothing was sent by this process. */
export class SubmissionRefused extends Error {
  constructor(readonly code: 'revoked' | 'capacity' | 'unavailable' | 'held' | 'deadline') {
    super(code);
  }
}

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

/**
 * One stage-specific provider submission:
 *   1. reserve counts/exposure under current session/epoch/Attempt/deadline authority;
 *   2. record the one-use dispatch intent under the same authority;
 *   3. invoke the adapter exactly once, only on a 'send' grant.
 * Revocation before intent withdraws only provably unsent work; once intent is
 * durable the work is held (unknown) even if the adapter is never invoked. An
 * existing intent ('held') is never a second send. No retries. The Attempt
 * deadline is rechecked synchronously immediately before the invocation, so a
 * grant that lapsed while it was being delivered is never used.
 */
export async function submit<T>(
  store: Store,
  exec: Execution,
  owner: Owner,
  attemptId: Handle,
  deadlineAt: number,
  stage: SubmissionStage,
  now: () => number,
  call: (signal: AbortSignal, observer?: CallObserver) => Promise<T>,
  observationProfile?: ObservationProfile,
): Promise<T> {
  if (observationProfile !== undefined && !liveObservationProfile(stage, observationProfile)) throw new ProviderError('gemini', 'config', false);
  if (exec.signal.aborted) throw exec.signal.reason;
  const reserving = store.reserveSubmission(owner, attemptId, stage, now());
  let reserved: SubmissionReserve;
  try {
    reserved = await exec.race(reserving);
  } catch (err) {
    // Revoked while reserving: once the reservation lands it is released (no intent can exist).
    quiet(reserving.then((r) => (r.ok ? store.withdrawSubmission(owner.sessionId, attemptId, r.call) : undefined)));
    throw err;
  }
  if (!reserved.ok) throw new SubmissionRefused(reserved.code);
  const index = reserved.call;
  if (exec.signal.aborted) {
    await store.withdrawSubmission(owner.sessionId, attemptId, index).catch(() => {});
    throw exec.signal.reason;
  }
  const beginning = store.beginSubmission(owner, attemptId, index, now());
  let grant: SubmissionGrant;
  try {
    grant = await exec.race(beginning);
  } catch (err) {
    // Revoked while recording intent: committed intent is held (never sent); otherwise release.
    quiet(beginning.then((g) => (g === 'send' ? store.endSubmission(owner.sessionId, attemptId, index, 'cancelled') : store.withdrawSubmission(owner.sessionId, attemptId, index))));
    throw err;
  }
  if (grant !== 'send') {
    // Releases only if intent provably never committed (e.g. a lost acknowledgement keeps it held).
    await store.withdrawSubmission(owner.sessionId, attemptId, index).catch(() => {});
    throw new SubmissionRefused(grant);
  }
  if (exec.signal.aborted) {
    quiet(store.endSubmission(owner.sessionId, attemptId, index, 'cancelled'));
    throw exec.signal.reason;
  }
  // Send boundary: the earliest of the Attempt deadline and the reservation's
  // validity (session and policy expiry) is rechecked synchronously right
  // before the invocation. A lapsed grant stays held (unknown), never invoked.
  const t = now();
  const usableClock = Number.isSafeInteger(t) && t >= 0;
  if (!(usableClock && t < Math.min(deadlineAt, reserved.validUntil))) {
    quiet(store.endSubmission(owner.sessionId, attemptId, index, 'cancelled'));
    throw new SubmissionRefused(usableClock && t >= deadlineAt ? 'deadline' : 'unavailable');
  }
  const observation = createCallObserver(stage, t, now, (value) => store.observeSubmission(owner.sessionId, attemptId, index, value), observationProfile);
  const interrupted = () => observation.interrupt(exec.signal.reason === 'deadline');
  exec.signal.addEventListener('abort', interrupted, { once: true });
  const work = invoke(() => call(exec.signal, observation.observer)).then(
    (result) => { observation.finish(); return result; },
    (error: unknown) => { observation.finish(error, true); throw error; },
  ).finally(() => exec.signal.removeEventListener('abort', interrupted));
  // Accounting only: the call ended without a known-cost receipt, so it stays held as unknown.
  afterSettled(work, () => store.endSubmission(owner.sessionId, attemptId, index, 'returned'));
  return exec.race(work);
}

export async function runReferenceStage(deps: HarnessDeps, attempt: Attempt, input: ReferenceInput): Promise<void> {
  const { store, adapter, now, inflight } = deps;
  const { sessionId, epoch, id } = attempt;
  const startedAt = now();
  const budget = Math.min(LIMITS.providerRequestMs, attempt.deadlineAt - startedAt);
  if (budget <= 0) {
    await store.settleAttempt(sessionId, epoch, id, 'failed', 'deadline', now());
    return;
  }

  const exec = openExecution(attempt, budget, inflight);
  const reference = structuredClone(input.reference);
  const execution = Object.freeze({ deadlineAt: startedAt + budget, dispatch: async <T>(send: () => Promise<T>): Promise<T> => {
    const authorized = await store.authorizeReference({ sessionId, epoch }, id, reference, now(), { journeyId: attempt.journeyId });
    if (!authorized || exec.signal.aborted) throw new SubmissionRefused('revoked');
    const t = now();
    if (!Number.isSafeInteger(t) || t < startedAt || t >= startedAt + budget) throw new SubmissionRefused('deadline');
    return send();
  } });
  // Stop, Clear and the deadline win over any late error; only then is a provider's own 429/503 named (value-free), else generic.
  const settleFromSignal = async (err: unknown) => {
    const reason = exec.abortReason();
    if (reason === 'deadline') await store.settleAttempt(sessionId, epoch, id, 'failed', 'deadline', now());
    else if (reason !== null) await store.settleAttempt(sessionId, epoch, id, 'cancelled', null, now());
    else {
      const cause = providerServiceCause(err);
      await store.settleAttempt(sessionId, epoch, id, 'failed', cause === null ? 'adapter_failed' : now() >= attempt.deadlineAt ? 'deadline' : cause, now());
    }
  };

  try {
    let result;
    try {
      result = validateAdapterResult(await submit(store, exec, { sessionId, epoch }, id, attempt.deadlineAt, 'reference_analysis', now,
        (signal, observer) => adapter.analyse(input, signal, observer, execution), adapter.observationProfileFor?.(input) ?? adapter.observationProfile));
    } catch (err) {
      if (err instanceof SubmissionRefused) {
        // Not authorised (revoked, expired, out of time, over a shared cap or admission unavailable).
        // Settling is a guarded no-op unless the Attempt is still running.
        const failure =
          err.code === 'capacity'
            ? 'capacity'
            : err.code === 'unavailable'
              ? 'admission_unavailable'
              : err.code === 'deadline' || now() >= attempt.deadlineAt
                ? 'deadline'
                : 'adapter_failed';
        await store.settleAttempt(sessionId, epoch, id, 'failed', failure, now());
        return;
      }
      await settleFromSignal(err);
      return;
    }
    const committed = await store.commitAnalysis(sessionId, epoch, id, { ...result, synthetic: adapter.synthetic }, now());
    if (!committed) {
      const failure = now() >= attempt.deadlineAt ? 'deadline' : 'adapter_failed';
      await store.settleAttempt(sessionId, epoch, id, 'failed', failure, now());
    }
  } finally {
    exec.close();
  }
}
