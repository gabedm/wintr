import { describe, expect, it } from 'vitest';
import type { AttemptFailure, SafePanel, SafeSnapshot } from '../src/shared/records.js';
import { discoveryOutcome, referenceFailure } from '../src/client/discovery.js';

// The in-flow sentences for a provider-side 429/503. Copy contract only: not browser, device or listener evidence.

const DENIED = /quota|daily|payment|billing|\bpay\b|upgrade|minutes|seconds|tomorrow|later today|bad match|not a match|no match|rights|copyright|licen[cs]e|http|429|503|key|project/i;
const panel = (outcome: SafePanel['outcome']) => ({ handle: 'panel-handle-000000000001', outcome, choices: outcome === 'choices' ? [{ title: 'Invented Song' }] : [] }) as unknown as SafePanel;
const snapshot = (kind: 'reference' | 'discover' | 'refine', code: AttemptFailure, shown: SafePanel | null = kind === 'refine' ? panel('choices') : null, stage: 'failed' | 'cancelled' = 'failed') =>
  ({ stage, code, panel: shown, attempt: { kind, active: false, handle: 'attempt-handle-0000000001' } }) as unknown as SafeSnapshot;

describe('reference step', () => {
  it.each(['provider_limited', 'provider_unavailable'] as const)('%s names the service, says nothing was added and that nothing was retried, and judges nothing', (code) => {
    const text = referenceFailure(code);
    expect(text).toMatch(code === 'provider_limited' ? /limited this request/ : /is unavailable/);
    expect(text).toContain('No analysis was added');
    expect(text.split(/\s+/).length).toBeLessThan(25);
    expect(text).not.toMatch(DENIED);
  });

  it('keeps the existing wording for the deadline and for every other failure, distinct from the service causes', () => {
    expect(referenceFailure('deadline')).toBe('The reference step ran out of time, so no analysis was added.');
    for (const code of ['adapter_failed', 'capacity', 'admission_unavailable', null] as const) {
      expect(referenceFailure(code)).toBe('The reference step did not finish, so no analysis was added.');
    }
    expect(referenceFailure('provider_limited')).not.toBe(referenceFailure('provider_unavailable'));
  });
});

describe('discovery and refinement', () => {
  it.each(['provider_limited', 'provider_unavailable'] as const)('Discover %s: a service statement, no automatic retry, no new action or claim', (code) => {
    const text = discoveryOutcome(snapshot('discover', code))!;
    expect(text).toMatch(code === 'provider_limited' ? /limited this request/ : /is unavailable/);
    expect(text).toContain('No new picks were added');
    expect(text).not.toMatch(DENIED);
    expect(text).not.toMatch(/try again|retry (now|later)|wait/i);
  });

  it.each(['provider_limited', 'provider_unavailable'] as const)('a refinement %s still counts as used and keeps the earlier choices, and says so', (code) => {
    const text = discoveryOutcome(snapshot('refine', code))!;
    expect(text).toContain('Refinement used.');
    expect(text.endsWith('Your previous picks are still here.')).toBe(true);
    expect(text).not.toMatch(DENIED);
  });

  describe.each(['provider_limited', 'provider_unavailable'] as const)('refinement %s over each kind of retained earlier panel', (code) => {
    const cause = code === 'provider_limited' ? /limited this request/ : /is unavailable/;

    it('real choices: the full "kept above" wording is unchanged and exact', () => {
      const text = discoveryOutcome(snapshot('refine', code, panel('choices')))!;
      expect(text).toMatch(cause);
      expect(text).toContain('Refinement used.');
      expect(text.endsWith(' Refinement used. Your previous picks are still here.')).toBe(true);
    });

    it('a hidden earlier panel (required source information unavailable) stays hidden and is never called choices or kept above', () => {
      const text = discoveryOutcome(snapshot('refine', code, panel('source_unavailable')))!;
      expect(text).toMatch(cause);
      expect(text).toContain('Refinement used.');
      expect(text.endsWith('Previous results stay hidden while sources are unavailable.')).toBe(true);
      expect(text).not.toMatch(/choices|kept above|shown above|suggest(ed)? above/i);
      expect(text).not.toMatch(DENIED);
    });

    it('an earlier no-match is described as that result, not as choices', () => {
      const text = discoveryOutcome(snapshot('refine', code, panel('no_match')))!;
      expect(text.endsWith('Your previous search is still here.')).toBe(true);
      expect(text).not.toContain('Earlier choices');
    });

    it('a Discover failure (nothing earlier exists) never mentions an earlier panel', () => {
      expect(discoveryOutcome(snapshot('discover', code))).not.toMatch(/earlier/i);
    });
  });

  it('the same suffix truth applies to a refinement that was stopped and to the other refinement failures', () => {
    const stopped = (shown: SafePanel) => discoveryOutcome(snapshot('refine', 'cancelled' as AttemptFailure, shown, 'cancelled'))!;
    expect(stopped(panel('choices'))).toBe('Stopped. Refinement used. Your previous picks are still here.');
    expect(stopped(panel('source_unavailable'))).toBe(
      'Stopped. Refinement used. Previous results stay hidden while sources are unavailable.',
    );
    expect(discoveryOutcome(snapshot('refine', 'deadline', panel('source_unavailable')))).toBe(
      'Discovery ran out of time, so nothing was suggested. Previous results stay hidden while sources are unavailable.',
    );
    // Nothing is claimed about an earlier panel that is not there.
    expect(discoveryOutcome(snapshot('refine', 'deadline', null))).toBe('Discovery ran out of time, so nothing was suggested.');
  });

  it('existing outcomes are unchanged, and none of them is mistaken for a service cause', () => {
    expect(discoveryOutcome(snapshot('discover', 'qloo_failed'))).toBe('The artist connection service did not answer usefully, so nothing was suggested.');
    expect(discoveryOutcome(snapshot('discover', 'catalogue_failed'))).toBe('Recording search did not return a usable answer, so nothing was suggested.');
    expect(discoveryOutcome(snapshot('discover', 'capacity'))).toBe('This reference has used its allowed lookups.');
    expect(discoveryOutcome(snapshot('refine', 'catalogue_failed'))).toBe('Recording search did not return a usable answer, so nothing was suggested. Your previous picks are still here.');
    const cause = new Set([discoveryOutcome(snapshot('discover', 'provider_limited')), discoveryOutcome(snapshot('discover', 'provider_unavailable'))]);
    for (const code of ['qloo_failed', 'catalogue_failed', 'capacity', 'pool_empty', 'deadline', 'admission_unavailable'] as const) expect(cause.has(discoveryOutcome(snapshot('discover', code)))).toBe(false);
  });
});
