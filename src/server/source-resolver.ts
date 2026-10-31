import { LIMITS } from '../shared/records.js';
import { validateProviderSourceUrl } from './destinations.js';
import { safeGet, SafeFetchError, type FetchGap, type SafeFetchContext, type SafeFetchDeps, type SafeFetchPolicy } from './net/safe-fetch.js';

// Native grounding attribution is distinct from an exact recording destination.
// Follow HTTP redirects only, using HEAD: no source/media body, HTML, meta-refresh,
// scripts, cookies or provider credentials. The original attribution URL is kept.
export type SourceResolution = { readonly ok: true } | { readonly ok: false; readonly reason: FetchGap | 'status' };
export interface SourceResolver {
  readonly synthetic: boolean;
  check(source: string, ctx: SafeFetchContext): Promise<SourceResolution>;
}
const POLICY: SafeFetchPolicy = {
  method: 'HEAD', maxBytes: 0,
  // All hops still pass the shared HTTPS/443/no-credentials and public DNS/IP
  // guard. Only the initial hop has Google's exact source-route allowlist.
  allow: (u) => u.href.length <= LIMITS.sourceUrlChars && u.hash === '' && u.hostname !== '',
};

export function createSourceResolver(deps: SafeFetchDeps, synthetic = false): SourceResolver {
  return {
    synthetic,
    async check(source, ctx) {
      const initial = validateProviderSourceUrl(source);
      if (!initial) return { ok: false, reason: 'unsafe_redirect' };
      try {
        const startedAt = deps.now();
        let last = startedAt;
        if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new SafeFetchError('deadline');
        // A backwards sample must not lengthen the timer between this source's
        // admission and the shared guard, or re-authorise a later hop.
        const clock = () => {
          const sampled = deps.now();
          if (!Number.isSafeInteger(sampled) || sampled < last) throw new SafeFetchError('deadline');
          last = sampled;
          return sampled;
        };
        const response = await safeGet({ ...deps, now: clock }, POLICY, new URL(initial), {
          ...ctx, deadlineAt: Math.min(ctx.deadlineAt, startedAt + LIMITS.metadataRequestMs),
        });
        // An initial 200 (possibly an intermediary page) is not evidence that
        // the native redirect resolved. Never infer a target from body text.
        return response.redirects > 0 && new URL(response.finalUrl).origin !== new URL(initial).origin && response.status >= 200 && response.status < 300
          ? { ok: true } : { ok: false, reason: 'status' };
      } catch (err) {
        return { ok: false, reason: err instanceof SafeFetchError ? err.gap : 'unreachable' };
      }
    },
  };
}
