import { ProviderError } from './http.js';

/** Internal authority only: the absolute end and clock come from the server harness. */
export interface CatalogueDeadline {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly now: () => number;
}

/** Bounds waiting work too. An uncooperative late continuation must check again before sending. */
export async function withinCatalogueDeadline<T>(
  options: CatalogueDeadline,
  work: (guard: { readonly signal: AbortSignal; readonly check: () => number }) => Promise<T>,
  dispatched: () => boolean = () => false,
): Promise<T> {
  const controller = new AbortController();
  const check = () => {
    // Stop/Clear/owner expiry retain precedence over a simultaneous generation timeout.
    if (options.signal.aborted) throw new ProviderError('gemini', 'aborted', dispatched());
    const now = options.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(options.deadlineAt)) {
      throw new ProviderError('gemini', 'config', dispatched());
    }
    const remaining = options.deadlineAt - now;
    if (controller.signal.aborted || remaining <= 0) throw new ProviderError('gemini', 'deadline', dispatched());
    return remaining;
  };
  const remaining = check();
  const onOuterAbort = () => controller.abort();
  options.signal.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), remaining);
  let onAbort = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => {
      try { check(); } catch (err) { reject(err); }
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => {
      check();
      return work({ signal: controller.signal, check });
    });
    const result = await Promise.race([pending, stopped]);
    check();
    return result;
  } catch (err) {
    check();
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onOuterAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
