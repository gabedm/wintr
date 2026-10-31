import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { DECOR, Fade, tokenExitDecision, visualCapture } from '../src/client/decor.js';
import { PreferencePanel } from '../src/client/discovery.js';
import { focusStranded, FocusHandoff } from '../src/client/handoff.js';
import { STANDARD_EASING } from '../src/client/motion.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// Focus hand-off after explicit actions and the saved-token exit. Pure decisions plus server-rendered
// markup contracts: they are not browser, keyboard-in-a-real-browser or assistive-technology evidence.

const BODY = { isConnected: true };
const live = (extra: { disabled?: boolean } = {}) => ({ isConnected: true, ...extra });

describe('focusStranded: only a removed, disabled or absent holder counts', () => {
  it('the page itself, a removed element, a disabled element and nothing are stranded', () => {
    expect(focusStranded(null, BODY)).toBe(true);
    expect(focusStranded(BODY, BODY)).toBe(true);
    expect(focusStranded({ isConnected: false }, BODY)).toBe(true);
    expect(focusStranded(live({ disabled: true }), BODY)).toBe(true);
  });

  it('a surviving enabled control the listener chose is never stranded', () => {
    expect(focusStranded(live(), BODY)).toBe(false);
    expect(focusStranded(live({ disabled: false }), BODY)).toBe(false);
  });
});

describe('FocusHandoff: armed by a gesture, taken once, never by anything else', () => {
  it('does nothing unless armed (restoration, remote progress and automatic refresh never arm it)', () => {
    const h = new FocusHandoff();
    expect(h.pending).toBe(false);
    expect(h.take(true)).toBe(false);
  });

  it('an explicit gesture whose trigger was removed takes the hand-off exactly once', () => {
    const h = new FocusHandoff();
    h.arm();
    expect(h.pending).toBe(true);
    expect(h.take(true)).toBe(true);
    expect(h.pending).toBe(false);
    expect(h.take(true)).toBe(false);
  });

  it('a control the listener moved to during an asynchronous save is never taken over, and the hand-off ends', () => {
    const h = new FocusHandoff();
    h.arm();
    expect(h.take(focusStranded(live(), BODY))).toBe(false);
    expect(h.pending).toBe(false);
    expect(h.take(true)).toBe(false);
  });

  it('a refused, failed or superseded action disarms it so a later unrelated commit cannot steal focus', () => {
    const h = new FocusHandoff();
    h.arm();
    h.cancel();
    expect(h.take(true)).toBe(false);
  });
});

describe('token exit: the real Edit removal leaves for 120 ms; everything else is immediate', () => {
  const base = { edited: true, hasRect: true, opacity: 1, reducedMotion: false, hidden: false };

  it('uses the locked 120 ms', () => {
    expect(DECOR.token.exitMs).toBe(120);
  });

  it('plays only for an Edit with a measured rectangle, something visible, a visible page and motion allowed', () => {
    expect(tokenExitDecision(base)).toBe(true);
    expect(tokenExitDecision({ ...base, opacity: 0.4 })).toBe(true);
    expect(tokenExitDecision({ ...base, edited: false })).toBe(false);
    expect(tokenExitDecision({ ...base, hasRect: false })).toBe(false);
    expect(tokenExitDecision({ ...base, opacity: 0 })).toBe(false);
    expect(tokenExitDecision({ ...base, reducedMotion: true })).toBe(false);
    expect(tokenExitDecision({ ...base, hidden: true })).toBe(false);
  });
});

describe('token exit continues the presentation at the Edit gesture: geometry and opacity', () => {
  // The conversation host starts 100 px below the viewport top and 20 px in, with a 1 px border, and is scrolled.
  const host = (scrollTop = 0) => ({ box: { top: 100, left: 20, width: 400, height: 900 }, clientTop: 1, clientLeft: 1, scrollTop, scrollLeft: 0 });

  it('uses the rendered rectangle in the host coordinates, not offsets relative to the nearest wrapper', () => {
    // Layout offsets of the token inside its (transformed) entrance wrapper are 0,0; the wrapper itself sits at 340 in the host
    // and is still 2.1 px down from its rest position mid-entrance. The rendered box already contains that translation.
    const rest = { top: 100 + 1 + 340, left: 20 + 1 + 0, width: 360, height: 120 };
    const mid = { ...rest, top: rest.top + 2.1 };
    expect(visualCapture(mid, host(), [0.3]).rect).toEqual({ top: 342.1, left: 0, width: 360, height: 120 });
    expect(visualCapture(rest, host(), []).rect).toEqual({ top: 340, left: 0, width: 360, height: 120 });
    // An offset-parent measurement would have reported 0,0 here: the failure this replaces.
    expect(visualCapture(mid, host(), [0.3]).rect.top).not.toBe(0);
  });

  it('accounts for the host border and its scroll position, so an absolute sibling lands on the same pixels', () => {
    const box = { top: 100 + 1 + 340 - 50, left: 21, width: 360, height: 120 };
    expect(visualCapture(box, host(50), []).rect.top).toBe(340);
    expect(visualCapture(box, host(0), []).rect.top).toBe(290);
  });

  it('opacity is the product of every entrance still playing on the element or its wrappers; at rest it is 1', () => {
    const box = { top: 0, left: 0, width: 1, height: 1 };
    expect(visualCapture(box, host(), []).opacity).toBe(1);
    expect(visualCapture(box, host(), [0.5]).opacity).toBe(0.5);
    expect(visualCapture(box, host(), [0.5, 0.4]).opacity).toBeCloseTo(0.2);
    expect(visualCapture(box, host(), [Number.NaN]).opacity).toBe(1);
    expect(visualCapture(box, host(), [-1, 2]).opacity).toBe(0);
  });

  function exit(from: number | undefined) {
    const frames = new FakeFrames();
    const writes: number[] = [];
    let gone = 0;
    const f = new Fade({ frames, reducedMotion: () => false, enterMs: 0, exitMs: DECOR.token.exitMs, exitEasing: STANDARD_EASING, write: (p) => writes.push(p), onGone: () => (gone += 1) });
    f.begin(false, from);
    f.hide();
    return { frames, writes, f, gone: () => gone };
  }

  it('an exit started mid-entrance begins at the opacity the listener sees (no jump to 1) and ends at 0 in the scaled time', () => {
    // The real entrance: 160 ms of the token enter, interrupted at 60 ms.
    const frames = new FakeFrames();
    let seen = 0;
    const enter = new Fade({ frames, reducedMotion: () => false, enterMs: DECOR.token.enterMs, exitMs: 0, enterEasing: STANDARD_EASING, write: (p) => (seen = p) });
    enter.begin(true);
    frames.step(60);
    const current = seen;
    expect(current).toBeGreaterThan(0);
    expect(current).toBeLessThan(1);

    const x = exit(current);
    expect(x.writes[0]).toBe(current);
    expect(x.writes.every((w) => w <= current)).toBe(true);
    x.frames.step(DECOR.token.exitMs * current - 1);
    expect(x.gone()).toBe(0);
    expect(x.f.value).toBeGreaterThan(0);
    x.frames.step(1.001);
    expect(x.f.value).toBe(0);
    expect(x.gone()).toBe(1);
    expect(x.frames.queue.size).toBe(0);
  });

  it('a token at rest still leaves over the full 120 ms from opacity 1', () => {
    const x = exit(undefined);
    expect(x.writes[0]).toBe(1);
    x.frames.step(DECOR.token.exitMs - 1);
    expect(x.gone()).toBe(0);
    x.frames.step(1);
    expect(x.gone()).toBe(1);
  });

  it('reduced motion adopts rest and removes at once; no frame is left running', () => {
    const frames = new FakeFrames();
    let gone = 0;
    const f = new Fade({ frames, reducedMotion: () => true, enterMs: 0, exitMs: 120, write: () => undefined, onGone: () => (gone += 1) });
    f.begin(false, 0.4);
    f.hide();
    expect(gone).toBe(1);
    expect(frames.queue.size).toBe(0);
  });

  it('finish() (a hidden page) lands on gone at once and leaves no stale frame', () => {
    const x = exit(0.6);
    x.frames.step(20);
    x.f.finish();
    expect(x.f.value).toBe(0);
    expect(x.gone()).toBe(1);
    x.frames.step(500);
    expect(x.gone()).toBe(1);
  });
});

describe('the saved choice markup: a deliberate focus target, with no outgoing picture at rest', () => {
  const h = (s: string) => s.padEnd(24, '0') as Handle;
  const snap = (brief: object | null, panel: object | null = null) =>
    ({
      mode: 'synthetic',
      session: { context: 'ctx', expiresAt: 1 },
      stage: 'awaiting_preference',
      revision: 1,
      status: 'reference_ready',
      attempt: null,
      reference: null,
      listenerCue: null,
      analysis: { handle: h('analysis'), synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['An observation.'], relationships: ['The groove'], proposedArtist: null },
      brief,
      identity: null,
      connection: null,
      panel,
      history: [],
      refinement: null,
      code: null,
    }) as unknown as SafeSnapshot;
  const saved = { handle: h('brief'), version: 1, relationship: 'The groove', source: 'analysis_choice', artists: ['Generic Artist'] };
  const render = (s: SafeSnapshot) => renderToStaticMarkup(<PreferencePanel snapshot={s} disabled={false} onSave={async () => true} onDiscover={() => {}} />);

  it('the saved choice region is programmatically focusable but not a tab stop, and keeps its two explicit actions', () => {
    const html = render(snap(saved));
    expect(html).toMatch(/<section class="assistant" aria-label="Your choice" tabindex="-1">/);
    expect(html).toContain('>Edit<');
    expect(html).toContain('Discover connections');
  });

  it('the compact context line is the same kind of focus target', () => {
    expect(render(snap(saved, { handle: h('panel') }))).toMatch(/<section class="assistant context" aria-label="Your choice" tabindex="-1">/);
  });

  it('nothing outgoing, hidden or inert is rendered for a restored choice or for the form', () => {
    for (const html of [render(snap(saved)), render(snap(null))]) {
      expect(html).not.toMatch(/token-ghost|welcome-ghost|inert|data-playing/);
      expect(html).not.toMatch(/<div[^>]*aria-hidden/);
    }
    expect(render(snap(null))).toContain('aria-label="Choose what to keep"');
  });
});
