import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Handle, SafePanel } from '../src/shared/records.js';
import { Appear, appearOffset, IntroCard, PendingStatus, WelcomeGhost } from '../src/client/conversation-motion.js';
import { DECOR, dotOpacity, Fade, FreshTracker, ghostDecision, IntroSequence, introAt, introDecision, PendingLoop, STATIC_DOTS, type IntroProgress } from '../src/client/decor.js';
import { editDraft, EMPTY_DRAFT, initialComposer, visibleDraft, type Draft } from '../src/client/draft.js';
import { ChoicesPanel } from '../src/client/discovery.js';
import { Emblem } from '../src/client/emblem-view.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// First conversation motion group: M01.intro, M01.suggestions, M03.send (welcome and
// message), M04.pending, M04.result. Logic tests over injected frames, visibility and
// reduced-motion state, plus server-rendered markup contracts. They are not browser,
// phone or frame-pacing evidence, and a synthetic fixture is never music acceptance.

const spec = JSON.parse(readFileSync(new URL('../docs/design/MOTION_SPEC.json', import.meta.url), 'utf8')) as { transitions: { id: string; duration_ms: Record<string, number> }[] };
const specMs = (id: string) => spec.transitions.find((t) => t.id === id)!.duration_ms;

const env = (reduced = false) => {
  const frames = new FakeFrames();
  const flags = { reduced };
  return { frames, flags, env: { frames, reducedMotion: () => flags.reduced } };
};

describe('the locked numbers are the active spec, not copies that can drift', () => {
  it('matches MOTION_SPEC.json for every transition in this group', () => {
    const intro = specMs('M01.intro');
    expect([DECOR.intro.cardMs, DECOR.intro.motifMs, DECOR.intro.motifStaggerMs, DECOR.intro.maxTotalMs]).toEqual([intro.card, intro.motifs, intro.motif_stagger, intro.maximum_total]);
    // The five motifs end by the maximum total: the last starts at 4 x stagger and runs its own duration.
    expect((DECOR.intro.motifs - 1) * DECOR.intro.motifStaggerMs + DECOR.intro.motifMs).toBeLessThanOrEqual(DECOR.intro.maxTotalMs);
    const sug = specMs('M01.suggestions');
    expect([DECOR.suggestions.enterMs, DECOR.suggestions.exitMs]).toEqual([sug.enter, sug.exit]);
    const send = specMs('M03.send');
    expect([DECOR.welcome.exitMs, DECOR.userBubble.enterMs]).toEqual([send.welcome_exit, send.user_message_enter]);
    const pend = specMs('M04.pending');
    expect([DECOR.pending.enterMs, DECOR.pending.exitMs, DECOR.pending.crossfadeMs, DECOR.pending.dotCycleMs, DECOR.pending.dotPhaseStepMs]).toEqual([
      pend.enter,
      pend.exit,
      pend.stage_crossfade,
      pend.dot_cycle,
      pend.dot_phase_step,
    ]);
    expect(DECOR.result.enterMs).toBe(specMs('M04.result').complete_unit_enter);
  });
});

describe('Fade: retargetable enter and exit from the current value', () => {
  function fade(o: { enterMs?: number; exitMs?: number; reduced?: boolean; onGone?: () => void } = {}) {
    const t = env(o.reduced);
    const writes: number[] = [];
    const f = new Fade({ ...t.env, enterMs: o.enterMs ?? 180, exitMs: o.exitMs ?? 100, write: (p) => writes.push(p), onGone: o.onGone });
    return { ...t, f, writes };
  }

  it('enters over exactly its enter time and leaves over exactly its exit time', () => {
    const t = fade();
    t.f.begin(true);
    expect(t.f.value).toBe(0);
    t.frames.step(179);
    expect(t.f.value).toBeLessThan(1);
    expect(t.f.value).toBeGreaterThan(0);
    t.frames.step(1);
    expect(t.f.value).toBe(1);
    t.f.hide();
    t.frames.step(99);
    expect(t.f.value).toBeGreaterThan(0);
    t.frames.step(1);
    expect(t.f.value).toBe(0);
    expect(t.frames.queue.size).toBe(0);
  });

  it('a first appearance at rest never plays, and reduced motion is always at rest', () => {
    const rest = fade();
    rest.f.begin(false);
    expect(rest.writes).toEqual([1]);
    expect(rest.frames.queue.size).toBe(0);
    const reduced = fade({ reduced: true });
    reduced.f.begin(true);
    expect(reduced.writes).toEqual([1]);
    reduced.f.hide();
    expect(reduced.f.value).toBe(0);
    expect(reduced.frames.queue.size).toBe(0);
  });

  it('a reversal retargets from the current value over the remaining path, with no snap in either direction', () => {
    const t = fade({ enterMs: 200, exitMs: 100 });
    t.f.begin(true);
    t.frames.step(100);
    const mid = t.f.value!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    const before = t.writes.length;
    t.f.hide();
    expect(t.f.value).toBe(mid);
    expect(t.writes.length).toBe(before);
    // The remaining path takes the nominal time scaled by what is left (100 ms x mid), no more.
    t.frames.step(100 * mid - 1);
    expect(t.f.value).toBeGreaterThan(0);
    t.frames.step(1.001);
    expect(t.f.value).toBe(0);
    // And back up from partway out.
    t.f.show();
    t.frames.step(60);
    const up = t.f.value!;
    t.f.hide();
    expect(t.f.value).toBe(up);
    t.f.show();
    expect(t.f.value).toBe(up);
    t.frames.step(200 * (1 - up) + 0.001);
    expect(t.f.value).toBe(1);
  });

  it('zero distance is immediate, sparse frames land on the end, duplicate frames change nothing', () => {
    const t = fade();
    t.f.begin(false);
    t.f.show();
    expect(t.writes).toEqual([1, 1]);
    t.f.hide();
    t.frames.step(0);
    t.frames.step(0);
    expect(t.f.value).toBe(1);
    t.frames.step(10_000);
    expect(t.f.value).toBe(0);
    const writes = t.writes.length;
    t.frames.step(10_000);
    expect(t.writes.length).toBe(writes);
  });

  it('a live reduced-motion change or a hidden page finishes the spatial motion at once; no stale frame writes afterwards', () => {
    const t = fade();
    t.f.begin(true);
    t.frames.step(60);
    t.flags.reduced = true;
    t.f.finish();
    expect(t.f.value).toBe(1);
    expect(t.frames.queue.size).toBe(0);
    const writes = t.writes.length;
    t.frames.step(500);
    expect(t.writes.length).toBe(writes);
  });

  it('onGone fires exactly once, when the exit really ends; revoked authority is gone at 0 ms with no exit picture', () => {
    let gone = 0;
    const t = fade({ onGone: () => (gone += 1) });
    t.f.begin(true);
    t.frames.run(300);
    t.f.hide();
    t.frames.step(50);
    expect(gone).toBe(0);
    t.frames.run(100);
    expect(gone).toBe(1);

    let revoked = 0;
    const r = fade({ onGone: () => (revoked += 1) });
    r.f.begin(true);
    r.frames.run(300);
    r.f.hardHide();
    expect(r.f.value).toBe(0);
    expect(revoked).toBe(1);
    expect(r.frames.queue.size).toBe(0);
    r.f.hardHide();
    r.frames.run(500);
    expect(r.f.value).toBe(0);
  });

  it('a show during an exit cancels the pending removal', () => {
    let gone = 0;
    const t = fade({ onGone: () => (gone += 1) });
    t.f.begin(false);
    t.f.hide();
    t.frames.step(40);
    t.f.show();
    t.frames.run(500);
    expect(t.f.value).toBe(1);
    expect(gone).toBe(0);
  });
});

describe('IntroSequence: the card and five motifs, once', () => {
  function intro(reduced = false) {
    const t = env(reduced);
    const writes: IntroProgress[] = [];
    const seq = new IntroSequence(t.env, (p) => writes.push(p));
    return { ...t, seq, writes };
  }
  const last = (w: IntroProgress[]) => w[w.length - 1]!;

  it('starts the card at t=0 and the motifs at 0/40/80/120/160 ms', () => {
    const a = introAt(0);
    expect(a.card).toBe(0);
    expect(a.motifs).toEqual([0, 0, 0, 0, 0]);
    const at40 = introAt(40);
    expect(at40.motifs[0]).toBeGreaterThan(0);
    expect(at40.motifs[1]).toBe(0);
    const at160 = introAt(160);
    expect(at160.motifs[3]).toBeGreaterThan(0);
    expect(at160.motifs[4]).toBe(0);
    expect(introAt(161).motifs[4]).toBeGreaterThan(0);
    // The card is done at 280 ms; each motif 240 ms after its own start; all by 400 ms.
    expect(introAt(279).card).toBeLessThan(1);
    expect(introAt(280).card).toBe(1);
    expect(introAt(239).motifs[0]).toBeLessThan(1);
    expect(introAt(240).motifs[0]).toBe(1);
    expect(introAt(399).motifs[4]).toBeLessThan(1);
    expect(introAt(400)).toEqual({ card: 1, motifs: [1, 1, 1, 1, 1] });
    // Every value stays within 0..1 and never goes backwards.
    let prev = introAt(0);
    for (let t = 1; t <= 420; t += 1) {
      const p = introAt(t);
      for (const [i, v] of [p.card, ...p.motifs].entries()) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual([prev.card, ...prev.motifs][i]!);
      }
      prev = p;
    }
  });

  it('plays over frames, settles exactly once by 400 ms and then stays still', () => {
    const t = intro();
    t.seq.start();
    expect(t.seq.phase).toBe('running');
    expect(last(t.writes)).toEqual(introAt(0));
    t.frames.step(200);
    expect(last(t.writes)).toEqual(introAt(200));
    t.frames.step(199);
    expect(t.seq.phase).toBe('running');
    t.frames.step(1);
    expect(t.seq.phase).toBe('done');
    expect(last(t.writes)).toEqual({ card: 1, motifs: [1, 1, 1, 1, 1] });
    const writes = t.writes.length;
    t.frames.run(2000);
    expect(t.writes.length).toBe(writes);
    expect(t.frames.queue.size).toBe(0);
  });

  it('typing or the first send finishes it at once; a stale frame cannot write afterwards', () => {
    const t = intro();
    t.seq.start();
    t.frames.step(90);
    t.seq.finish();
    expect(t.seq.phase).toBe('done');
    expect(last(t.writes)).toEqual({ card: 1, motifs: [1, 1, 1, 1, 1] });
    expect(t.frames.queue.size).toBe(0);
    const writes = t.writes.length;
    t.frames.step(500);
    t.seq.finish();
    expect(t.writes.length).toBe(writes);
  });

  it('never replays: start after done, or a second start while running, does nothing', () => {
    const t = intro();
    t.seq.start();
    t.seq.start();
    expect(t.frames.queue.size).toBe(1);
    t.frames.run(500);
    const writes = t.writes.length;
    t.seq.start();
    t.seq.hold();
    expect(t.writes.length).toBe(writes);
    expect(t.seq.phase).toBe('done');
  });

  it('sparse frames land on the end; reduced motion shows the final card and motifs instantly with no loop', () => {
    const sparse = intro();
    sparse.seq.start();
    sparse.frames.step(5_000);
    expect(sparse.seq.phase).toBe('done');
    expect(last(sparse.writes)).toEqual({ card: 1, motifs: [1, 1, 1, 1, 1] });

    const reduced = intro(true);
    reduced.seq.hold();
    reduced.seq.start();
    expect(reduced.seq.phase).toBe('done');
    expect(reduced.writes).toEqual([{ card: 1, motifs: [1, 1, 1, 1, 1] }]);
    expect(reduced.frames.queue.size).toBe(0);
  });

  it('holds hidden while the first state is unknown, reserving layout without a frame', () => {
    const t = intro();
    t.seq.hold();
    expect(t.seq.phase).toBe('held');
    expect(last(t.writes)).toEqual({ card: 0, motifs: [0, 0, 0, 0, 0] });
    expect(t.frames.queue.size).toBe(0);
  });
});

describe('when the welcome plays, and when its exit copy is shown', () => {
  const facts = { phase: 'idle' as const, resolved: true, empty: true, interrupted: false, wipe: 0 };

  it('only the first empty view of a resolved page plays; everything else just rests', () => {
    expect(introDecision(facts)).toBe('start');
    expect(introDecision({ ...facts, resolved: false })).toBe('hold');
    expect(introDecision({ ...facts, phase: 'held', resolved: false })).toBe('hold');
    // Restored content, an answer, a reference already present: no welcome motion.
    expect(introDecision({ ...facts, empty: false })).toBe('finish');
    expect(introDecision({ ...facts, empty: false, resolved: false })).toBe('finish');
    // Typing, a wipe (Clear here or in another tab) and an unreadable first state with a barrier.
    expect(introDecision({ ...facts, interrupted: true })).toBe('finish');
    expect(introDecision({ ...facts, wipe: 1 })).toBe('finish');
    // Once played or finished, nothing replays it: after an answer, a return, a Clear.
    for (const phase of ['done'] as const) expect(introDecision({ ...facts, phase })).toBe('none');
    expect(introDecision({ ...facts, phase: 'done', empty: true, wipe: 3 })).toBe('none');
  });

  it('the outgoing welcome is shown only for this page\'s own send, with a rectangle, and never under reduced motion', () => {
    const base = { wasWelcome: true, welcome: false, sentHere: true, hasRect: true, reducedMotion: false };
    expect(ghostDecision(base)).toBe(true);
    expect(ghostDecision({ ...base, sentHere: false })).toBe(false);
    expect(ghostDecision({ ...base, wasWelcome: false })).toBe(false);
    expect(ghostDecision({ ...base, welcome: true })).toBe(false);
    expect(ghostDecision({ ...base, hasRect: false })).toBe(false);
    expect(ghostDecision({ ...base, reducedMotion: true })).toBe(false);
  });
});

describe('pending dots', () => {
  it('each dot runs 0.35 -> 1 -> 0.35 linearly over 900 ms, phase-shifted by 100 ms per dot', () => {
    for (const i of [0, 1, 2]) {
      const t0 = i * 100;
      expect(dotOpacity(t0, i)).toBeCloseTo(0.35, 10);
      expect(dotOpacity(t0 + 450, i)).toBeCloseTo(1, 10);
      expect(dotOpacity(t0 + 900, i)).toBeCloseTo(0.35, 10);
      expect(dotOpacity(t0 + 225, i)).toBeCloseTo((0.35 + 1) / 2, 10);
      expect(dotOpacity(t0 + 675, i)).toBeCloseTo((0.35 + 1) / 2, 10);
      expect(dotOpacity(t0 + 900 + 450, i)).toBeCloseTo(1, 10);
    }
    // A dot that has not reached its phase yet rests at the low value; nothing leaves 0.35..1.
    expect(dotOpacity(50, 2)).toBe(0.35);
    for (let t = 0; t < 2000; t += 7) for (const i of [0, 1, 2]) expect(dotOpacity(t, i)).toBeGreaterThanOrEqual(0.35 - 1e-9);
    for (let t = 0; t < 2000; t += 7) for (const i of [0, 1, 2]) expect(dotOpacity(t, i)).toBeLessThanOrEqual(1 + 1e-9);
  });

  function loop(reduced = false) {
    const t = env(reduced);
    const writes: (readonly number[])[] = [];
    const l = new PendingLoop(t.env, (o) => writes.push(o));
    return { ...t, l, writes };
  }

  it('animates only while started: one write per frame, and stop ends it at once with static dots and no queued frame', () => {
    const t = loop();
    t.l.start();
    expect(t.writes.length).toBe(1);
    t.frames.step(100);
    expect(t.writes.at(-1)).toEqual([0, 1, 2].map((i) => dotOpacity(100, i)));
    t.frames.step(16);
    expect(t.writes.length).toBe(3);
    t.l.stop();
    expect(t.writes.at(-1)).toEqual(STATIC_DOTS);
    expect(t.l.active).toBe(false);
    expect(t.frames.queue.size).toBe(0);
    const writes = t.writes.length;
    t.frames.step(5_000);
    expect(t.writes.length).toBe(writes);
  });

  it('a hidden page suspends it and becoming visible resumes it only while the operation is still active', () => {
    const t = loop();
    t.l.start();
    t.frames.step(50);
    t.l.visibilityChanged(true);
    expect(t.frames.queue.size).toBe(0);
    expect(t.writes.at(-1)).toEqual(STATIC_DOTS);
    t.frames.step(5_000);
    t.l.visibilityChanged(false);
    expect(t.frames.queue.size).toBe(1);
    expect(t.writes.at(-1)).toEqual([0, 1, 2].map((i) => dotOpacity(0, i)));

    const ended = loop();
    ended.l.start();
    ended.l.stop();
    ended.l.visibilityChanged(true);
    ended.l.visibilityChanged(false);
    expect(ended.frames.queue.size).toBe(0);
  });

  it('reduced motion is static dots with no loop, and a live change ends or resumes it', () => {
    const r = loop(true);
    r.l.start();
    expect(r.writes).toEqual([STATIC_DOTS]);
    expect(r.frames.queue.size).toBe(0);

    const live = loop();
    live.l.start();
    live.frames.step(40);
    live.flags.reduced = true;
    live.l.reducedMotionChanged();
    expect(live.writes.at(-1)).toEqual(STATIC_DOTS);
    expect(live.frames.queue.size).toBe(0);
    live.flags.reduced = false;
    live.l.reducedMotionChanged();
    expect(live.frames.queue.size).toBe(1);
  });
});

describe('which result entrance plays', () => {
  const A = 'panelA';
  const B = 'panelB';

  it('a restored or returned panel is simply complete: no entrance, ever', () => {
    const f = new FreshTracker();
    expect(f.isFresh(A, false)).toBe(false);
    f.commit([A], false);
    expect(f.isFresh(A, false)).toBe(false);
    f.commit([A], false);
    expect(f.isFresh(B, false)).toBe(false);
  });

  it('a panel that first appears while this page was working plays once; later changes to it cannot replay it', () => {
    const f = new FreshTracker();
    f.commit([], true);
    expect(f.isFresh(A, false)).toBe(true);
    expect(f.isFresh(A, true)).toBe(true);
    f.commit([A], false);
    // Feedback, progress, a re-render, a return: the same handle is never fresh again.
    for (const working of [false, true, false]) {
      expect(f.isFresh(A, working)).toBe(false);
      f.commit([A], working);
    }
  });

  it('a panel visible in the very commit this page starts work counts as arriving during work, once a baseline exists', () => {
    const f = new FreshTracker();
    f.commit([], false);
    expect(f.isFresh(A, true)).toBe(true);
    // Before any state is known nothing can be fresh, whatever the working flag says.
    expect(new FreshTracker().isFresh(A, true)).toBe(false);
  });

  it('restoration while a refinement is active: the old initial panel and history never animate; only a later new result enters, once', () => {
    const H = 'historyH';
    const f = new FreshTracker();
    // First observed state: panel A and an older entry are already owned while the server reports active work.
    expect(f.isFresh(A, true)).toBe(false);
    f.commit([A, H], true);
    for (const working of [true, true]) {
      expect(f.isFresh(A, working)).toBe(false);
      expect(f.isFresh(H, working)).toBe(false);
      f.commit([A, H], working);
    }
    // The refinement completes: B is new in the very render work ends, A moves to history and is still not fresh.
    expect(f.isFresh(B, false)).toBe(true);
    expect(f.isFresh(A, false)).toBe(false);
    f.commit([B, A, H], false);
    expect(f.isFresh(B, false)).toBe(false);
    f.commit([B, A, H], false);
    expect(f.isFresh(B, true)).toBe(false);
  });

  it('restoration while active that ends without a result, or is cancelled, leaves nothing armed', () => {
    const f = new FreshTracker();
    f.commit([A], true);
    f.commit([A], false);
    expect(f.isFresh(B, false)).toBe(false);
    f.commit([B], false);
    expect(f.isFresh(B, false)).toBe(false);
  });

  it('a state that is not yet known is no baseline: a later first known state still is one', () => {
    const f = new FreshTracker();
    f.commit([], true, false);
    expect(f.isFresh(A, true)).toBe(false);
    f.commit([A], true, true);
    expect(f.isFresh(A, true)).toBe(false);
  });

  it('a genuine fast completion still enters once: no panel, then working, then the panel the moment work ends', () => {
    const f = new FreshTracker();
    f.commit([], false);
    f.commit([], true);
    expect(f.isFresh(A, false)).toBe(true);
    f.commit([A], false);
    expect(f.isFresh(A, false)).toBe(false);
    // And a result that is already present in the very commit work starts is fresh too.
    const g = new FreshTracker();
    g.commit([], false);
    expect(g.isFresh(A, true)).toBe(true);
  });

  it('a wipe drops the baseline: the state after it is baselined again, so a restored panel after Clear is not fresh', () => {
    const f = new FreshTracker();
    f.commit([], false);
    f.commit([], true);
    f.reset();
    expect(f.isFresh(A, true)).toBe(false);
    f.commit([A], true);
    expect(f.isFresh(A, true)).toBe(false);
    f.commit([A], false);
    f.commit([], true);
    expect(f.isFresh(B, true)).toBe(true);
  });

  it('a refinement is fresh; the earlier panel in history never animates', () => {
    const f = new FreshTracker();
    f.commit([], true);
    f.commit([A], false);
    f.commit([A], true);
    expect(f.isFresh(B, true)).toBe(true);
    f.commit([B, A], false);
    expect(f.isFresh(A, false)).toBe(false);
    expect(f.isFresh(B, false)).toBe(false);
  });

  it('work that ended without a new panel does not leave the next unrelated panel armed', () => {
    const f = new FreshTracker();
    f.commit([], true);
    f.commit([], false);
    expect(f.isFresh(A, false)).toBe(false);
  });

  it('a wipe (Clear, another tab, redaction) forgets everything, and a restored panel afterwards is still not fresh', () => {
    const f = new FreshTracker();
    f.commit([], true);
    f.commit([A], false);
    f.reset();
    expect(f.isFresh(A, false)).toBe(false);
    f.commit([A], false);
    expect(f.isFresh(A, false)).toBe(false);
    f.commit([], true);
    expect(f.isFresh(B, false)).toBe(true);
  });
});

describe('the unsaved draft is never touched by decoration, only by a wipe', () => {
  const typed: Draft = { url: 'https://youtu.be/dQw4w9WgXcQ?t=12', start: '0:12', end: '0:57', cue: 'the groove', focusEdited: true };

  it('a new draft typed while an old send animates is kept exactly; a suggestion tap merges into it without changing the rest', () => {
    let held = initialComposer(0);
    held = editDraft(held, 0, typed);
    // The send commits and its decorations start, finish, exit: none of that is an edit.
    expect(visibleDraft(held, 0)).toBe(typed);
    // While the old message animates the listener starts a new draft and a suggestion fills only the note.
    held = editDraft(held, 0, (d) => ({ ...d, url: 'https://youtu.be/AAAAAAAAAAA' }));
    held = editDraft(held, 0, (d) => ({ ...d, cue: 'The vocal' }));
    expect(visibleDraft(held, 0)).toEqual({ ...typed, url: 'https://youtu.be/AAAAAAAAAAA', cue: 'The vocal' });
  });

  it('a wipe hides the old draft in the same render, and the next edit starts from empty', () => {
    const held = editDraft(initialComposer(0), 0, typed);
    expect(visibleDraft(held, 1)).toBe(EMPTY_DRAFT);
    const next = editDraft(held, 1, (d) => ({ ...d, cue: 'The groove' }));
    expect(visibleDraft(next, 1)).toEqual({ ...EMPTY_DRAFT, cue: 'The groove' });
    expect(visibleDraft(next, 1).url).toBe('');
    // An edit still carrying the old epoch cannot resurrect the wiped draft either.
    expect(visibleDraft(editDraft(held, 1, (d) => ({ ...d, cue: 'x' })), 1).url).toBe('');
  });
});

describe('appearOffset: layout reads never see decoration', () => {
  const wrapper = (playing: boolean, p: string, y: string) => ({
    hasAttribute: (n: string) => n === 'data-playing' && playing,
    style: { getPropertyValue: (n: string) => (n === '--p' ? p : '') },
    dataset: { appearY: y },
  });
  const within = (w: ReturnType<typeof wrapper> | null) => ({ closest: () => w }) as unknown as Element;

  it('subtracts only the translation still in effect', () => {
    expect(appearOffset(within(wrapper(true, '0.25', '6')))).toBeCloseTo(4.5, 10);
    expect(appearOffset(within(wrapper(true, '0', '6')))).toBe(6);
    expect(appearOffset(within(wrapper(false, '', '6')))).toBe(0);
    expect(appearOffset(within(null))).toBe(0);
    expect(appearOffset(within(wrapper(true, 'oops', '6')))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Markup contracts (server-rendered: initial, at-rest state; no effects run)

const h = (s: string) => s.padEnd(24, '0') as Handle;
const choice = (n: number): SafePanel['choices'][number] => ({
  handle: h(`choice${n}`),
  title: `Invented Song ${n}`,
  credits: [`Neighbour X${n}`],
  unverifiedCredits: 0,
  anchor: `Neighbour X${n}`,
  playUrl: null,
  service: 'youtube',
  fitHypothesis: 'It may keep the groove.',
  sources: [],
  feedback: { fit: null, familiarity: null, revision: 0 },
});
const panel: SafePanel = {
  handle: h('panel'),
  synthetic: false,
  role: 'initial',
  mode: null,
  basis: [],
  outcome: 'choices',
  choices: [choice(1), choice(2)],
  answer: { text: 'An invented complete answer.', marks: [{ end: 11, citations: [0, 1] }] },
  citations: [
    { title: 'Invented source one', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/a', domain: 'example.test' },
    { title: 'Invented source two', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/b', domain: null },
  ],
  suggestionsUrl: `/api/suggestions/${h('panel')}`,
  gaps: [],
};

describe('markup contracts', () => {
  it('keeps unverified YouTube uploader status contextual and never applies it to synthetic or catalogue-only results', () => {
    const label = 'Title, credits and version are checked; YouTube uploader status is unverified.';
    const youtube = renderToStaticMarkup(<ChoicesPanel panel={panel} />);
    expect(youtube).toContain(label);
    expect(youtube.indexOf(label)).toBeGreaterThan(youtube.indexOf('Full answer and sources'));
    expect(renderToStaticMarkup(<ChoicesPanel panel={{ ...panel, synthetic: true }} />)).not.toContain(label);
    const apple = { ...panel, choices: panel.choices.map((c) => ({ ...c, service: 'apple_music' as const, playUrl: null })) };
    expect(renderToStaticMarkup(<ChoicesPanel panel={apple} />)).not.toContain(label);
  });

  it('the complete result unit sits unchanged inside the wrapper: answer, every citation and the Suggestions frame together', () => {
    const unit = renderToStaticMarkup(<ChoicesPanel panel={panel} />);
    const wrapped = renderToStaticMarkup(
      <Appear play enterMs={DECOR.result.enterMs} y={DECOR.result.y}>
        <ChoicesPanel panel={panel} />
      </Appear>,
    );
    expect(wrapped).toContain(unit);
    expect(wrapped).toMatch(/^<div class="appear" data-appear="true" data-appear-y="6"/);
    // The mark sits at its true offset inside the one answer (after "An invented"), not appended later.
    expect(wrapped).toContain('An invented<sup>[1][2]</sup> complete answer.');
    for (const text of ['Invented source one', 'Invented source two', 'Invented Song 1', 'Invented Song 2']) expect(wrapped).toContain(text);
    expect(wrapped).toContain(`src="/api/suggestions/${h('panel')}"`);
    // Nothing is split or staged: no per-item delay, reveal class or hidden state in the markup.
    expect(wrapped).not.toMatch(/animation-delay|data-playing|visibility:\s*hidden|opacity:\s*0/);
  });

  it('entry carries the original emblem without an extra heading or action, and the outgoing copy is noninteractive', () => {
    const emblem = <Emblem out={{ steps: 0, busy: false, found: false, halted: true }} />;
    const real = renderToStaticMarkup(<IntroCard>{emblem}</IntroCard>);
    expect(real).toMatch(/<section class="intro" aria-label="Wintr">/);
    expect(real).toContain('role="img" aria-label="Wintr"');
    expect(real).not.toMatch(/<h1|<button|Add a song|Keep the part you love/);
    // Entry has no animation state at rest; the SVG retains its factual band variables.
    expect(real).not.toMatch(/<section[^>]*style=|data-playing|--intro-card:/);
    const ghost = renderToStaticMarkup(<IntroCard ghost>{emblem}</IntroCard>);
    expect(ghost).not.toMatch(/<h1|id="intro-title"|aria-labelledby/);
    expect(ghost).toContain('<svg');
    expect(ghost).not.toMatch(/<button|tabindex=/);
  });

  it('the pending row shows only the given true label, announced once in one live region, with three dots hidden from assistive technology', () => {
    const html = renderToStaticMarkup(<PendingStatus label="Exploring artist connections…" wanted active revoked={false} />);
    expect(html).toMatch(/class="assistant status pending"/);
    expect(html.match(/<i class="dot"/g)).toHaveLength(3);
    expect(html).toMatch(/<span class="dots" aria-hidden="true">/);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html.match(/Exploring artist connections…/g)).toHaveLength(2);
    expect(html).toMatch(/<span class="stage-layer" aria-hidden="true">Exploring artist connections…<\/span>/);
    expect(html).toMatch(/<span class="visually-hidden" role="status">Exploring artist connections…<\/span>/);
    // No percentage, count or finished mark of any kind.
    expect(html).not.toMatch(/%|✓|check|progress|aria-valuenow|<svg/i);
  });

  it('a pending row that is not wanted, or whose authority is revoked, renders nothing at all', () => {
    expect(renderToStaticMarkup(<PendingStatus label="Starting the search…" wanted={false} active={false} revoked={false} />)).toBe('');
    expect(renderToStaticMarkup(<PendingStatus label="Starting the search…" wanted active revoked />)).toBe('');
  });

  it('the outgoing welcome copy is inert, hidden from assistive technology and pinned to the old rectangle', () => {
    const html = renderToStaticMarkup(<WelcomeGhost rect={{ top: 12, left: 0, width: 320, height: 130 }} onGone={() => {}} />);
    expect(html).toMatch(/class="welcome-ghost" aria-hidden="true" inert=""/);
    expect(html).toContain('top:12px');
    expect(html).toContain('height:130px');
    expect(html).not.toMatch(/<h1|<button|<a /);
  });
});

describe('already-hidden animation admission', () => {
  it('settles fades without requesting frames', () => {
    const frames = new FakeFrames();
    const fade = new Fade({ frames, reducedMotion: () => false, hidden: () => true, enterMs: 180, exitMs: 100, write() {} });
    fade.begin(true); expect(fade.value).toBe(1); expect(frames.queue.size).toBe(0);
    fade.hide(); expect(fade.value).toBe(0); expect(frames.queue.size).toBe(0);
    fade.show(); expect(fade.value).toBe(1); expect(frames.queue.size).toBe(0);
  });
  it('does not start the intro or pending loop while hidden', () => {
    const frames = new FakeFrames();
    const e = { frames, reducedMotion: () => false, hidden: () => true };
    const intro = new IntroSequence(e, () => {}); intro.start();
    expect(intro.phase).toBe('done'); expect(frames.queue.size).toBe(0);
    const loop = new PendingLoop(e, () => {}); loop.start();
    expect(loop.active).toBe(false); expect(frames.queue.size).toBe(0);
  });
});
