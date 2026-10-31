import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { ActionButton, SettledState } from '../src/client/App.js';
import { actionDecision, CONTROL, isPressable, PressManager, PressScale, Toggle } from '../src/client/control.js';
import { Chip, SelectMark } from '../src/client/control-hooks.js';
import { DECOR, FreshTracker } from '../src/client/decor.js';
import { IdentityPanel, PreferencePanel } from '../src/client/discovery.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// Control and selection motion (M03.control, M07.selection), the settled cancellation /
// recovery entrance (M03.cancel, M08.recovery) and the single Send/Stop action. Logic tests
// over injected frames, visibility and reduced-motion state, plus server-rendered markup
// contracts. They are not browser, phone, keyboard-in-a-real-browser or zoom evidence.

const spec = JSON.parse(readFileSync(new URL('../docs/design/MOTION_SPEC.json', import.meta.url), 'utf8')) as {
  transitions: { id: string; duration_ms: Record<string, number>; properties_and_geometry: Record<string, unknown> }[];
};
const t = (id: string) => spec.transitions.find((x) => x.id === id)!;

const env = (reduced = false) => {
  const frames = new FakeFrames();
  const flags = { reduced, hidden: false };
  return { frames, flags, env: { frames, reducedMotion: () => flags.reduced, hidden: () => flags.hidden } };
};

describe('the locked numbers are the active spec', () => {
  it('matches MOTION_SPEC.json', () => {
    const c = t('M03.control');
    expect([CONTROL.pressMs, CONTROL.releaseMs, CONTROL.iconCrossfadeMs, CONTROL.toggleMs]).toEqual([c.duration_ms.press, c.duration_ms.release, c.duration_ms.icon_crossfade, c.duration_ms.toggle]);
    expect(c.properties_and_geometry.press).toEqual({ scale: [1, CONTROL.pressScale] });
    expect(DECOR.settled.enterMs).toBe(t('M03.cancel').duration_ms.settled_state);
    expect(DECOR.settled.enterMs).toBe(t('M08.recovery').duration_ms.state_crossfade);
    const sel = t('M07.selection');
    expect([CONTROL.toggleMs, DECOR.token.enterMs, DECOR.token.exitMs]).toEqual([sel.duration_ms.row_state, sel.duration_ms.token_enter, sel.duration_ms.token_exit]);
    expect(sel.properties_and_geometry.token_exit).toEqual({ opacity: [1, 0] });
    expect((sel.properties_and_geometry.token_enter as { translate_y_css_px: number[] }).translate_y_css_px).toEqual([DECOR.token.y, 0]);
  });
});

describe('PressScale: press 80 ms to 0.97, release 120 ms, from the current value', () => {
  function press(reduced = false) {
    const e = env(reduced);
    const writes: number[] = [];
    let rests = 0;
    const p = new PressScale(e.env, (v) => writes.push(v), () => (rests += 1));
    return { ...e, p, writes, rest: () => rests };
  }

  it('presses over exactly 80 ms and releases over exactly 120 ms', () => {
    const x = press();
    x.p.press();
    x.frames.step(79);
    expect(x.p.scale).toBeLessThan(1);
    expect(x.p.scale).toBeGreaterThan(0.97);
    x.frames.step(1);
    expect(x.p.scale).toBe(0.97);
    x.p.release();
    x.frames.step(119);
    expect(x.p.scale).toBeLessThan(1);
    x.frames.step(1);
    expect(x.p.scale).toBe(1);
    expect(x.rest()).toBe(1);
    expect(x.frames.queue.size).toBe(0);
  });

  it('a release mid-press retargets from the current scale over the nominal time scaled by what is left; no snap', () => {
    const x = press();
    x.p.press();
    x.frames.step(40);
    const mid = x.p.scale;
    expect(mid).toBeGreaterThan(0.97);
    expect(mid).toBeLessThan(1);
    const writes = x.writes.length;
    x.p.release();
    expect(x.p.scale).toBe(mid);
    expect(x.writes.length).toBe(writes);
    const expectedMs = (CONTROL.releaseMs * (1 - mid)) / (1 - CONTROL.pressScale);
    x.frames.step(expectedMs - 1);
    expect(x.p.scale).toBeLessThan(1);
    x.frames.step(1.001);
    expect(x.p.scale).toBe(1);
    // And pressing again while it returns continues from where it is.
    x.p.press();
    x.frames.step(30);
    const back = x.p.scale;
    x.p.release();
    x.p.press();
    expect(x.p.scale).toBe(back);
  });

  it('a pointer cancel (release) at any moment restores scale 1, including a release before any frame ran', () => {
    const x = press();
    x.p.press();
    x.p.release();
    x.frames.run(500);
    expect(x.p.scale).toBe(1);
    expect(x.rest()).toBe(1);
  });

  it('a control that was never pressed rests at once: zero distance needs no frame', () => {
    const x = press();
    x.p.release();
    expect(x.rest()).toBe(1);
    expect(x.frames.queue.size).toBe(0);
    expect(x.writes).toEqual([]);
  });

  it('sparse frames land on the end; duplicate frames change nothing', () => {
    const x = press();
    x.p.press();
    x.frames.step(0);
    x.frames.step(0);
    expect(x.p.scale).toBe(1);
    x.frames.step(5_000);
    expect(x.p.scale).toBe(0.97);
    const writes = x.writes.length;
    x.frames.step(5_000);
    expect(x.writes.length).toBe(writes);
  });

  it('reduced motion never scales; a live change or a hidden page restores scale 1 at once with no stale frame', () => {
    const r = press(true);
    r.p.press();
    expect(r.writes).toEqual([]);
    expect(r.p.scale).toBe(1);
    r.p.release();
    expect(r.rest()).toBe(1);

    const live = press();
    live.p.press();
    live.frames.step(30);
    live.flags.reduced = true;
    live.p.restore();
    expect(live.p.scale).toBe(1);
    expect(live.frames.queue.size).toBe(0);
    const writes = live.writes.length;
    live.frames.step(500);
    expect(live.writes.length).toBe(writes);
  });
});

describe('PressManager: one delegated binding for many controls', () => {
  it('holds an entry only while a control is pressed or returning, and controls are independent', () => {
    const e = env();
    const a = {};
    const b = {};
    const scales = new Map<object, number>();
    const m = new PressManager<object>(e.env, (target, v) => scales.set(target, v));
    m.down(a);
    m.down(b);
    expect(m.size).toBe(2);
    e.frames.step(80);
    expect([scales.get(a), scales.get(b)]).toEqual([0.97, 0.97]);
    m.up(a);
    e.frames.step(120);
    expect(scales.get(a)).toBe(1);
    expect(scales.get(b)).toBe(0.97);
    expect(m.size).toBe(1);
    m.up();
    e.frames.step(120);
    expect(scales.get(b)).toBe(1);
    expect(m.size).toBe(0);
    expect(e.frames.queue.size).toBe(0);
  });

  it('pointer cancel, a hidden page and a live reduced-motion change restore every control at once', () => {
    const e = env();
    const a = {};
    const b = {};
    const scales = new Map<object, number>();
    const m = new PressManager<object>(e.env, (target, v) => scales.set(target, v));
    m.down(a);
    m.down(b);
    e.frames.step(40);
    m.restoreAll();
    expect([scales.get(a), scales.get(b)]).toEqual([1, 1]);
    expect(m.size).toBe(0);
    expect(e.frames.queue.size).toBe(0);
  });

  it('a disabled or aria-disabled control is never pressable', () => {
    const el = (disabled: boolean, ariaDisabled: string | null) => ({ disabled, getAttribute: (n: string) => (n === 'aria-disabled' ? ariaDisabled : null) });
    expect(isPressable(el(false, null))).toBe(true);
    expect(isPressable(el(true, null))).toBe(false);
    expect(isPressable(el(false, 'true'))).toBe(false);
    expect(isPressable(el(false, 'false'))).toBe(true);
  });
});

describe('Toggle: selected mark (160 ms) and Send/Stop glyph (100 ms)', () => {
  function toggle(ms: number, reduced = false) {
    const e = env(reduced);
    const writes: number[] = [];
    const tg = new Toggle(e.env, ms, (v) => writes.push(v));
    return { ...e, tg, writes };
  }

  it('is seeded without motion, then crossfades over exactly its time', () => {
    const x = toggle(CONTROL.toggleMs);
    x.tg.seed(false);
    expect(x.frames.queue.size).toBe(0);
    x.tg.set(true);
    x.frames.step(CONTROL.toggleMs - 1);
    expect(x.tg.value).toBeLessThan(1);
    x.frames.step(1);
    expect(x.tg.value).toBe(1);
    const icon = toggle(CONTROL.iconCrossfadeMs);
    icon.tg.seed(false);
    icon.tg.set(true);
    icon.frames.step(CONTROL.iconCrossfadeMs - 1);
    expect(icon.tg.value).toBeLessThan(1);
    icon.frames.step(1);
    expect(icon.tg.value).toBe(1);
  });

  it('re-asserts the current value before moving, so the picture never flashes the final state first', () => {
    const x = toggle(CONTROL.toggleMs);
    x.tg.seed(false);
    x.writes.length = 0;
    x.tg.set(true);
    expect(x.writes[0]).toBe(0);
  });

  it('a reversal retargets from the current value over the remaining path; a repeated state is a no-op', () => {
    const x = toggle(160);
    x.tg.seed(false);
    x.tg.set(true);
    x.frames.step(80);
    const mid = x.tg.value!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    x.tg.set(false);
    expect(x.tg.value).toBe(mid);
    x.frames.step(160 * mid + 0.001);
    expect(x.tg.value).toBe(0);
    x.tg.set(false);
    expect(x.frames.queue.size).toBe(0);
    expect(x.tg.value).toBe(0);
  });

  it('reduced motion and finish() change the state at once; no stale frame writes afterwards', () => {
    const r = toggle(160, true);
    r.tg.seed(false);
    r.tg.set(true);
    expect(r.tg.value).toBe(1);
    expect(r.frames.queue.size).toBe(0);
    const x = toggle(160);
    x.tg.seed(false);
    x.tg.set(true);
    x.frames.step(60);
    x.tg.finish();
    expect(x.tg.value).toBe(1);
    const writes = x.writes.length;
    x.frames.step(500);
    expect(x.writes.length).toBe(writes);
  });
});

describe('Toggle on an already-hidden page: the actual state lands at once and no motion starts', () => {
  function hiddenToggle() {
    const e = env();
    const writes: number[] = [];
    const tg = new Toggle(e.env, CONTROL.toggleMs, (v) => writes.push(v));
    return { ...e, tg, writes };
  }

  it('a state change while hidden writes the final value immediately with no frame requested', () => {
    const x = hiddenToggle();
    x.tg.seed(false);
    x.flags.hidden = true;
    x.writes.length = 0;
    x.tg.set(true);
    expect(x.tg.value).toBe(1);
    expect(x.writes).toEqual([1]);
    expect(x.frames.queue.size).toBe(0);
    x.tg.set(false);
    expect(x.tg.value).toBe(0);
    expect(x.frames.queue.size).toBe(0);
    x.frames.step(500);
    expect(x.writes).toEqual([1, 0]);
  });

  it('a change that arrives while hidden ends a motion left running by it and never leaves a stale frame', () => {
    const x = hiddenToggle();
    x.tg.seed(false);
    x.tg.set(true);
    x.frames.step(40);
    expect(x.tg.running).toBe(true);
    x.flags.hidden = true;
    x.tg.set(false);
    expect(x.tg.value).toBe(0);
    expect(x.tg.running).toBe(false);
    expect(x.frames.queue.size).toBe(0);
  });

  it('attaching a node while hidden shows the real state, not a stale or in-progress value', () => {
    const x = hiddenToggle();
    x.tg.seed(false);
    x.tg.set(true);
    x.frames.step(40);
    x.flags.hidden = true;
    expect(x.tg.attach(true)).toBe(1);
    expect(x.tg.running).toBe(false);
    expect(x.frames.queue.size).toBe(0);
    // The very first attachment while hidden is simply seeded.
    const first = hiddenToggle();
    first.flags.hidden = true;
    expect(first.tg.attach(true)).toBe(1);
    expect(first.frames.queue.size).toBe(0);
  });

  it('while visible the semantics are unchanged: the value in progress is retargeted and an attached node continues it', () => {
    const x = hiddenToggle();
    x.tg.seed(false);
    x.tg.set(true);
    x.frames.step(80);
    const mid = x.tg.value!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(x.tg.attach(true)).toBe(mid);
    expect(x.tg.running).toBe(true);
    x.tg.set(false);
    expect(x.tg.value).toBe(mid);
    expect(x.tg.running).toBe(true);
  });

  it('reduced motion stays immediate whether or not the page is hidden', () => {
    const r = env(true);
    const tg = new Toggle(r.env, CONTROL.toggleMs, () => undefined);
    tg.seed(false);
    tg.set(true);
    expect(tg.value).toBe(1);
    expect(r.frames.queue.size).toBe(0);
  });
});

describe('the single Send/Stop action: state decides, never motion', () => {
  it('stop only while working and not already stopping; send only when ready; nothing while a request is running', () => {
    expect(actionDecision({ working: true, stopping: false, canAnalyse: false })).toBe('stop');
    expect(actionDecision({ working: true, stopping: true, canAnalyse: false })).toBe('none');
    expect(actionDecision({ working: false, stopping: false, canAnalyse: true })).toBe('send');
    expect(actionDecision({ working: false, stopping: false, canAnalyse: false })).toBe('none');
    // Even a stale "can analyse" can never start a second request while work is running.
    expect(actionDecision({ working: true, stopping: false, canAnalyse: true })).toBe('stop');
    expect(actionDecision({ working: true, stopping: true, canAnalyse: true })).toBe('none');
  });

  const render = (o: { working: boolean; unavailable: boolean; title?: string }) => renderToStaticMarkup(<ActionButton working={o.working} unavailable={o.unavailable} title={o.title} onClick={() => {}} />);

  it('is one button element in every state; its name follows the real state; unavailable is aria-disabled, never disabled (so focus is not lost)', () => {
    const idle = render({ working: false, unavailable: true, title: 'Choose a reference first' });
    const ready = render({ working: false, unavailable: false });
    const running = render({ working: true, unavailable: false });
    const stopping = render({ working: true, unavailable: true });
    for (const html of [idle, ready, running, stopping]) {
      expect(html).toMatch(/^<button type="button" class="send"/);
      expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
      // Both glyphs are always present in one cell: the width never changes.
      expect(html.match(/<svg class="icon-(send|stop)"/g)).toHaveLength(2);
    }
    expect(idle).toMatch(/aria-label="Analyse reference"/);
    expect(idle).toMatch(/aria-disabled="true"/);
    expect(idle).toContain('title="Choose a reference first"');
    expect(ready).not.toMatch(/aria-disabled|data-working/);
    expect(running).toMatch(/aria-label="Stop"/);
    expect(running).toMatch(/data-working="true"/);
    expect(running).not.toMatch(/aria-disabled/);
    expect(stopping).toMatch(/aria-label="Stop"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Stop"/);
  });
});

describe('selection marks: reserved slot, immediate semantics, only for owned selected state', () => {
  it('a chip carries its label first and an always-present mark; aria-pressed is the semantic state', () => {
    const on = renderToStaticMarkup(<Chip pressed onClick={() => {}}>Like it</Chip>);
    const off = renderToStaticMarkup(<Chip pressed={false} onClick={() => {}}>Like it</Chip>);
    expect(on).toMatch(/aria-pressed="true"[^>]*>Like it<span class="select-mark" data-on="true" aria-hidden="true">/);
    expect(off).toMatch(/aria-pressed="false"[^>]*>Like it<span class="select-mark" aria-hidden="true">/);
    expect(off).not.toContain('data-on');
    // The slot exists either way, so selecting changes no width or wrapping.
    expect(on).toContain('select-mark');
    expect(off).toContain('select-mark');
    expect(renderToStaticMarkup(<Chip pressed disabled onClick={() => {}}>Like it</Chip>)).toMatch(/disabled=""/);
    expect(renderToStaticMarkup(<SelectMark selected={false} />)).not.toContain('data-on');
  });

  const h = (s: string) => s.padEnd(24, '0') as Handle;
  const identity = (chosen: Handle | null) => ({
    handle: h('checkpoint'),
    revision: 1,
    awaiting: true,
    slots: [
      {
        proposal: 'Generic Artist',
        status: 'ambiguous' as const,
        options: [
          { handle: h('optionone'), name: 'Generic Artist', disambiguation: 'Invented band, formed in an invented year' },
          { handle: h('optiontwo'), name: 'Generic Artist', disambiguation: 'Invented solo singer-songwriter with a very long descriptive qualifier that must wrap' },
        ],
        chosen,
      },
    ],
  });
  const row = (html: string, index: number) => html.split('<button type="button" class="identity-row"')[index + 1]!.split('</button>')[0]!;

  it('two similarly named branches stay distinguishable by name and full accessible label; long text wraps rather than truncating', () => {
    const html = renderToStaticMarkup(<IdentityPanel identity={identity(h('optiontwo'))} brief={h('brief')} disabled={false} onChoose={() => {}} onContinue={() => {}} onEditArtists={() => {}} />);
    expect(row(html, 0)).toContain('aria-label="Generic Artist, Invented band, formed in an invented year"');
    expect(row(html, 1)).toContain('aria-label="Generic Artist, Invented solo singer-songwriter with a very long descriptive qualifier that must wrap"');
    expect(row(html, 1)).toContain('very long descriptive qualifier that must wrap');
    expect(html).not.toMatch(/text-overflow|ellipsis|…/);
  });

  it('only the owned, resolved choice is marked selected; no choice means no mark and no confirmation, in the same slot', () => {
    const chosen = renderToStaticMarkup(<IdentityPanel identity={identity(h('optiontwo'))} brief={h('brief')} disabled={false} onChoose={() => {}} onContinue={() => {}} onEditArtists={() => {}} />);
    expect(row(chosen, 0)).toMatch(/aria-pressed="false"/);
    expect(row(chosen, 0)).not.toContain('data-on');
    expect(row(chosen, 1)).toMatch(/aria-pressed="true"/);
    expect(row(chosen, 1)).toContain('data-on="true"');
    const none = renderToStaticMarkup(<IdentityPanel identity={identity(null)} brief={h('brief')} disabled={false} onChoose={() => {}} onContinue={() => {}} onEditArtists={() => {}} />);
    expect(none).not.toContain('data-on');
    for (const i of [0, 1]) expect(row(none, i)).toContain('class="select-mark"');
    // Choosing is free: no row, mark or token starts discovery (only the explicit Continue button does).
    expect(none.match(/>Continue discovery<\/button>/g)).toHaveLength(1);
  });

  it('the saved relationship choice is one complete token with its actions; Edit and Discover remain explicit', () => {
    const snap = {
      mode: 'synthetic',
      session: { context: 'ctx', expiresAt: 1 },
      stage: 'awaiting_preference',
      revision: 1,
      status: 'reference_ready',
      attempt: null,
      reference: null,
      listenerCue: null,
      analysis: { handle: h('analysis'), synthetic: true, audioAccess: 'synthetic_not_accessed', observations: ['An observation.'], relationships: ['The groove'], proposedArtist: null },
      brief: { handle: h('brief'), version: 1, relationship: 'The groove', source: 'analysis_choice', artists: ['Generic Artist'] },
      identity: null,
      connection: null,
      panel: null,
      history: [],
      refinement: null,
      code: null,
    } as unknown as SafeSnapshot;
    const html = renderToStaticMarkup(<PreferencePanel snapshot={snap} disabled={false} onSave={async () => true} onDiscover={() => {}} />);
    // At rest (a restored or returned choice) the token is simply there, wrapped without any pending decoration.
    expect(html).toMatch(/^<div class="appear" data-appear="true" data-appear-y="3"/);
    expect(html).not.toContain('data-playing');
    expect(html).toContain('Keeping:');
    expect(html).toContain('The groove');
    expect(html).toContain('>Edit<');
    expect(html).toContain('Discover connections');
  });
});

describe('settled cancellation and recovery states: the entrance never gates, the latest wins', () => {
  it('arrive during work: fresh once; restored or returned: never; a newer state is a different key', () => {
    const f = new FreshTracker();
    f.commit([], true);
    expect(f.isFresh('attempt-1:cancelled:cancelled', false)).toBe(true);
    f.commit(['attempt-1:cancelled:cancelled'], false);
    // The same state re-rendering (progress, feedback, a return) never replays.
    for (const working of [false, true, false]) {
      expect(f.isFresh('attempt-1:cancelled:cancelled', working && false)).toBe(false);
      f.commit(['attempt-1:cancelled:cancelled'], working);
    }
    // A new run then fails: its own key is fresh again; the old one is not.
    f.commit([], true);
    expect(f.isFresh('attempt-2:failed:deadline', false)).toBe(true);
    expect(f.isFresh('attempt-1:cancelled:cancelled', false)).toBe(false);

    const restored = new FreshTracker();
    expect(restored.isFresh('attempt-9:failed:', false)).toBe(false);
    restored.commit(['attempt-9:failed:'], false);
    expect(restored.isFresh('attempt-9:failed:', false)).toBe(false);
  });

  it('a wipe (Clear, expiry, another tab) forgets everything so nothing replays or resurrects', () => {
    const f = new FreshTracker();
    f.commit([], true);
    f.commit(['attempt-1:failed:deadline'], false);
    f.reset();
    expect(f.isFresh('attempt-1:failed:deadline', false)).toBe(false);
  });

  it('wraps only generic text, in flow, as one plain element keyed by its state', () => {
    const html = renderToStaticMarkup(
      <SettledState stateKey="attempt-1:cancelled:cancelled" play={false}>
        <p className="assistant">Stopped. Nothing from that request will be added.</p>
      </SettledState>,
    );
    expect(html).toBe('<div class="appear" data-appear="true" data-appear-y="0" style="--fade-y:0px"><p class="assistant">Stopped. Nothing from that request will be added.</p></div>');
    expect(html).not.toMatch(/aria-hidden|inert|data-playing|data-exiting/);
  });
});
