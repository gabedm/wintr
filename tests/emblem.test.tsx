import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { Emblem } from '../src/client/emblem-view.js';
import type { PendingAction } from '../src/client/controller.js';
import { breathAt, EMBLEM, EMBLEM_GEOMETRY, EMBLEM_START, EmblemMotion, emblemStep, type EmblemFacts, type EmblemOutput, type EmblemState } from '../src/client/emblem.js';
import { FakeFrames } from './fixtures/fake-frames.js';

// The header emblem: factual stage mapping (pure), its separate fill/breath motion over injected frames,
// and its markup. These are logic and server-rendered markup contracts, not browser, phone or owner
// visual evidence, and a synthetic fixture is never a found song.

const h = (v: string) => v.padEnd(24, '0') as Handle;
const choice = { handle: h('choice'), title: 'Invented Recording', credits: [], unverifiedCredits: 0, anchor: 'Invented', service: 'youtube' as const, playUrl: null, fitHypothesis: '', sources: [], feedback: { fit: null, familiarity: null, revision: 0 } };
const panel = (handle: string, outcome: 'choices' | 'no_match' | 'source_unavailable' = 'choices', count = 1) => ({
  handle: h(handle), synthetic: true, role: 'initial' as const, mode: null, basis: [], outcome,
  choices: Array.from({ length: count }, () => choice), answer: { text: '', marks: [] }, citations: [], suggestionsUrl: null, gaps: [],
});
const attempt = (handle: string, kind: 'reference' | 'discover' | 'refine', active: boolean) => ({ handle: h(handle), kind, active, outcome: (active ? 'running' : 'succeeded') as 'running' | 'succeeded' });

const base = (over: Partial<SafeSnapshot> = {}): SafeSnapshot => ({
  mode: 'synthetic', session: { context: 'invented-session', expiresAt: 1 }, stage: 'idle', revision: 1, status: null, attempt: null,
  reference: null, listenerCue: null, analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null, ...over,
});
const analysis = { handle: h('analysis'), synthetic: true, audioAccess: 'synthetic_not_accessed' as const, observations: [], relationships: [], proposedArtist: null };
const brief = { handle: h('brief'), version: 1, relationship: 'A low line', source: 'intake_cue' as const, artists: [] };
const connection = { synthetic: true, seeds: [], artists: [], anchors: [], tags: [], capability: 'artists_and_tags' as const, attribution: 'seed_mix' as const, why: [] };
const identity = (awaiting: boolean) => ({ handle: h('identity'), revision: 1, awaiting, slots: [] });

const ready = base({ stage: 'awaiting_preference', status: 'reference_ready', analysis, attempt: attempt('a-ref', 'reference', false) });
const briefed = base({ stage: 'awaiting_preference', status: 'reference_ready', analysis, brief });
const found = base({ stage: 'complete', status: 'choices_ready', analysis, brief, identity: identity(false), connection, panel: panel('p1'), attempt: attempt('a-disc', 'discover', false) });

const readyNew = base({ stage: 'awaiting_preference', status: 'reference_ready', analysis, attempt: attempt('a-new', 'reference', false) });
const sessionB = (over: Partial<SafeSnapshot> = {}) => base({ ...over, session: { context: 'other-invented-session', expiresAt: 1 } });
/** Each started local action is one fresh object that stays the same object while it is awaited (see PendingAction). */
const act = (kind: 'reference' | 'discover' | 'refine'): PendingAction => ({ kind });
const facts = (snapshot: SafeSnapshot | null, over: Partial<EmblemFacts> = {}): EmblemFacts => ({ snapshot, action: null, working: false, stopping: false, revoked: false, wipe: 0, ...over });
const live = (snapshot: SafeSnapshot | null, action: PendingAction | null, over: Partial<EmblemFacts> = {}) => facts(snapshot, { working: true, action, ...over });
/** Feeds facts in order, as the page does (render derives, commit advances), returning every output. */
function drive(...steps: EmblemFacts[]): EmblemOutput[] {
  let state: EmblemState = EMBLEM_START;
  return steps.map((f) => {
    const next = emblemStep(state, f);
    state = emblemStep(state, f).state;
    return next.out;
  });
}
const view = (steps: number, busy = false, f = false, halted = false): EmblemOutput => ({ steps, busy, found: f, halted });

describe('geometry: original, code-native, five radial bands', () => {
  it('draws six-fold radial rings from the centre outward, inside the viewBox, with no raster or external reference', () => {
    expect(EMBLEM_GEOMETRY).toHaveLength(EMBLEM.rings);
    for (const ring of EMBLEM_GEOMETRY) {
      // Six identical arms, plus at most one closed hexagon (the core and the outer closure).
      expect([0, 1]).toContain(ring.lines.length % 6);
      expect(ring.nodes.length % 6).toBe(0);
      for (const n of ring.nodes) for (const v of [n.cx, n.cy]) expect(v - n.r).toBeGreaterThanOrEqual(0), expect(v + n.r).toBeLessThanOrEqual(128);
      for (const d of ring.lines) for (const num of d.match(/-?\d+(\.\d+)?/g)!) expect(Number(num)).toBeGreaterThanOrEqual(0), expect(Number(num)).toBeLessThanOrEqual(128);
    }
    const html = renderToStaticMarkup(<Emblem out={view(0)} />);
    expect(html).not.toMatch(/<image|<img|href=|url\((?!#)|xlink/);
    const pair = renderToStaticMarkup(<><Emblem out={view(0)} /><Emblem out={view(5, false, true)} /></>);
    const masks = [...pair.matchAll(/<mask id="([^"]+)"/g)].map(m => m[1]);
    expect(masks).toHaveLength(2);
    expect(new Set(masks).size).toBe(2);
    for (const id of masks) expect(pair).toContain(`mask="url(#${id})"`);
  });
});

describe('factual stage mapping', () => {
  it('shows nothing without an owned session, and never time-based progress', () => {
    expect(drive(facts(null))[0]).toEqual(view(0));
    expect(drive(facts(base({ session: null, analysis })))[0]).toEqual(view(0));
    // The mapping has no clock input at all: identical facts always give identical output.
    expect(emblemStep(EMBLEM_START, facts(ready)).out).toEqual(emblemStep(EMBLEM_START, facts(ready)).out);
  });

  it('a new reference starts from nothing even over an older finished journey, then fills from its own admitted Attempt', () => {
    const r = act('reference');
    const out = drive(
      facts(found),
      live(found, r),
      live({ ...found, attempt: attempt('a-new', 'reference', true), stage: 'analysing_reference' }, r),
      facts(readyNew),
    );
    expect(out).toEqual([view(5, false, true), view(0, true), view(0, true), view(1)]);
  });

  it('a new reference whose pending ends with no admitted Attempt keeps only what it demonstrated, never the unchanged older journey', () => {
    const r = act('reference');
    // Failed, stopped before anything was sent or refused: the snapshot is still exactly the old completed one.
    expect(drive(facts(found), live(found, r), live(found, r), facts(found))).toEqual([view(5, false, true), view(0, true), view(0, true), view(0)]);
    // Even its later repeated reads stay at what the run proved.
    expect(drive(facts(found), live(found, r), facts(found), facts(found))[3]).toEqual(view(0));
    // A run bound to its own admitted Attempt (a-new) is not completed by an unrelated terminal Attempt (a-ref) and its older analysis.
    const analysing = { ...found, attempt: attempt('a-new', 'reference', true), stage: 'analysing_reference' as const };
    expect(drive(facts(found), live(found, r), live(analysing, r), facts(ready))[3]).toEqual(view(0));
  });

  it('a direct fast success (no active read was observed) needs a genuinely new corresponding terminal Attempt, with no forced dwell', () => {
    const r = act('reference');
    expect(drive(facts(found), live(found, r), facts(readyNew))).toEqual([view(5, false, true), view(0, true), view(1)]);
    const d = act('discover');
    const fresh = base({ ...found, panel: panel('p2'), attempt: attempt('a-disc-2', 'discover', false) });
    // Over an older finished panel and Attempt: the new Attempt and the new verified panel together are the evidence.
    expect(drive(facts(found), live(found, d), facts(fresh))).toEqual([view(5, false, true), view(2, true), view(5, false, true)]);
    // From a journey that had no panel yet.
    expect(drive(facts(briefed), live(briefed, d), facts(found))).toEqual([view(2), view(2, true), view(5, false, true)]);
    const e = act('refine');
    const refined = base({ ...found, panel: panel('p3'), history: [panel('p1')], attempt: attempt('a-ref-2', 'refine', false) });
    expect(drive(facts(found), live(found, e), facts(refined))[2]).toEqual(view(5, false, true));
  });

  it('adopts genuinely newer terminal facts after a settled run even when no working render was observed', () => {
    const reference = act('reference');
    const discovered = base({ ...found, panel: panel('fast-panel'), attempt: attempt('fast-discover', 'discover', false) });
    const refined = base({ ...discovered, panel: panel('fast-refined-panel'), attempt: attempt('fast-refine', 'refine', false) });
    expect(drive(live(found, reference), facts(readyNew), facts(discovered), facts(refined)))
      .toEqual([view(0, true), view(1), view(5, false, true), view(5, false, true)]);

    const nextReference = base({ ...readyNew, attempt: attempt('fast-reference-two', 'reference', false) });
    expect(drive(live(found, reference), facts(readyNew), facts(nextReference))[2]).toEqual(view(1));
    // A new terminal Attempt with the same old panel must not claim a newly found recording.
    const unchangedPanel = base({ ...discovered, attempt: attempt('fast-refine-empty', 'refine', false) });
    expect(drive(live(found, reference), facts(readyNew), facts(discovered), facts(unchangedPanel))[3]!.found).toBe(false);
  });

  it('does not promote a mismatched terminal reply merely because the same rejected snapshot is read again', () => {
    const d = act('discover');
    const active = base({ ...briefed, stage: 'finding_tracks', attempt: attempt('owned-active', 'discover', true), identity: identity(false), connection });
    const unrelated = base({ ...found, attempt: attempt('other-terminal', 'discover', false) });
    expect(drive(live(active, d), facts(unrelated), facts(unrelated))).toEqual([view(4, true), view(4), view(4)]);
  });

  it('a changed unrelated panel, an older analysis or another kind of Attempt is not enough to complete or extend a run', () => {
    const d = act('discover');
    // Another panel appears but the Attempt is still the old one: not this run's output.
    const unrelatedPanel = base({ ...found, panel: panel('p9') });
    expect(drive(facts(found), live(found, d), facts(unrelatedPanel))[2]).toEqual(view(2));
    // A new Attempt of a different kind is not this run's Attempt.
    const otherKind = base({ ...found, panel: panel('p9'), attempt: attempt('a-other', 'refine', false) });
    expect(drive(facts(found), live(found, d), facts(otherKind))[2]).toEqual(view(2));
    // A failed or cancelled new Attempt completes nothing, even beside a changed panel.
    const failed = base({ ...found, panel: panel('p9'), stage: 'failed', code: 'catalogue_failed', attempt: { ...attempt('a-f', 'discover', false), outcome: 'failed' } });
    expect(drive(facts(found), live(found, d), facts(failed))[2]).toEqual(view(2));
    // A bound run (its active Attempt was observed) is lifted only by that exact Attempt.
    const active = base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-mine', 'discover', true), identity: identity(false), connection });
    const someoneElses = base({ ...found, attempt: attempt('a-theirs', 'discover', false) });
    expect(drive(live(active, d), facts(someoneElses))).toEqual([view(4, true), view(4)]);
    expect(drive(live(active, d), facts(base({ ...found, attempt: attempt('a-mine', 'discover', false) })))[1]).toEqual(view(5, false, true));
  });

  it('Discover counts its own phases: inputs, then artists, then taste, and only its own verified panel completes it', () => {
    const d = act('discover');
    const pending = live(briefed, d);
    const resolving = live(base({ ...briefed, stage: 'resolving_artists', attempt: attempt('a-d', 'discover', true) }), d);
    const taste = live(base({ ...briefed, stage: 'retrieving_taste', attempt: attempt('a-d', 'discover', true), identity: identity(false) }), d);
    const tracks = live(base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-d', 'discover', true), identity: identity(false), connection }), d);
    const done = base({ ...found, attempt: attempt('a-d', 'discover', false) });
    expect(drive(pending, resolving, taste, tracks, facts(done))).toEqual([view(2, true), view(2, true), view(3, true), view(4, true), view(5, false, true)]);
  });

  it('human-wait states do not keep searching and are not complete', () => {
    const awaitingArtist = base({ ...briefed, stage: 'awaiting_artist', status: 'artist_choices_ready', identity: identity(true), attempt: attempt('a-d', 'discover', false) });
    expect(drive(facts(awaitingArtist))[0]).toEqual(view(2));
    expect(drive(facts(ready))[0]).toEqual(view(1));
    expect(drive(facts(briefed))[0]).toEqual(view(2));
  });

  it('a refinement resets: the old complete panel, connection and ready status cannot complete it', () => {
    const e = act('refine');
    const refinePending = live(found, e);
    const refineActive = live({ ...found, stage: 'finding_tracks', attempt: attempt('a-r', 'refine', true) }, e);
    const done = facts({ ...found, stage: 'complete', panel: panel('p2'), history: [panel('p1')], attempt: attempt('a-r', 'refine', false) });
    expect(drive(facts(found), refinePending, refinePending, refineActive, done)).toEqual([view(5, false, true), view(2, true), view(2, true), view(4, true), view(5, false, true)]);
  });

  it('a refinement that adds no new verified panel never reports a found song, even with the older panel still shown', () => {
    const sameOldPanel = facts({ ...found, stage: 'complete', attempt: attempt('a-r', 'refine', false) });
    const out = drive(facts(found), live(found, act('refine')), sameOldPanel);
    expect(out[2]!.found).toBe(false);
    expect(out[2]!.steps).toBeLessThan(5);
  });

  it('no-match, source-unavailable, failure and cancellation never complete it, and failure holds what the attempt proved', () => {
    const noMatch = base({ ...found, stage: 'no_match', panel: panel('p1', 'no_match', 0) });
    expect(drive(facts(noMatch))[0]).toMatchObject({ found: false, busy: false });
    expect(drive(facts(noMatch))[0]!.steps).toBeLessThan(5);
    const hidden = base({ ...found, panel: panel('p1', 'source_unavailable', 0) });
    expect(drive(facts(hidden))[0]).toMatchObject({ found: false });
    const emptyChoices = base({ ...found, panel: panel('p1', 'choices', 0) });
    expect(drive(facts(emptyChoices))[0]).toMatchObject({ found: false });

    const tracks = live(base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-d', 'discover', true), identity: identity(false), connection }), act('discover'));
    const failed = facts(base({ ...briefed, stage: 'failed', code: 'catalogue_failed', identity: identity(false), connection, attempt: { ...attempt('a-d', 'discover', false), outcome: 'failed' } }));
    const cancelled = facts(base({ ...briefed, stage: 'cancelled', code: 'cancelled', attempt: { ...attempt('a-d', 'discover', false), outcome: 'cancelled' } }));
    expect(drive(tracks, failed)[1]).toEqual(view(4));
    expect(drive(tracks, cancelled)[1]).toEqual(view(4));
  });

  it('Stop halts busy at once and keeps only the stages already proven', () => {
    const taste = base({ ...briefed, stage: 'retrieving_taste', attempt: attempt('a-d', 'discover', true), identity: identity(false) });
    const d = act('discover');
    const out = drive(live(taste, d), facts(taste, { working: true, stopping: true }));
    expect(out).toEqual([view(3, true), view(3, false, false, true)]);
    // Stop before the Attempt was ever read as active: the controller drops the local action but the run continues, halted, keeping its own stages.
    const unadmitted = drive(live(briefed, d), facts(briefed, { working: true, stopping: true }), facts(base({ ...briefed, stage: 'cancelled', code: 'cancelled', attempt: { ...attempt('a-c', 'discover', false), outcome: 'cancelled' } })));
    expect(unadmitted).toEqual([view(2, true), view(2, false, false, true), view(2)]);
  });

  it('an ACK of a different Attempt starts over instead of lifting the current one', () => {
    const a = facts(base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-old', 'discover', true), identity: identity(false), connection }), { working: true });
    const b = facts(base({ ...briefed, stage: 'resolving_artists', attempt: attempt('a-new', 'discover', true) }), { working: true });
    expect(drive(a, b)).toEqual([view(4, true), view(2, true)]);
  });

  it('Clear, redaction, a recovery barrier and expiry remove progress immediately and are not inherited by the next run', () => {
    for (const revoked of [{ revoked: true }, {}]) {
      const out = drive(facts(found), facts(found, revoked.revoked ? { revoked: true } : {}));
      expect(out[1]).toEqual(revoked.revoked ? view(0) : view(5, false, true));
    }
    expect(drive(facts(found), facts(base({ session: null, code: 'session_expired' })))[1]).toEqual(view(0));
    const next = drive(facts(found), facts(found, { revoked: true }), live(briefed, act('discover')));
    expect(next[2]).toEqual(view(2, true));
  });

  it('a run is bound to the opaque session context: a directly replaced session never inherits another session\'s progress', () => {
    const d = act('discover');
    const tracksA = base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-d', 'discover', true), identity: identity(false), connection });
    // Session A discovery reaches four, then session B (brief and analysis, no active Attempt) has an unadmitted Discover.
    expect(drive(live(tracksA, d), live(sessionB({ ...briefed }), act('discover')))).toEqual([view(4, true), view(2, true)]);
    // Even the very same local action object cannot carry progress across contexts.
    expect(drive(live(tracksA, d), live(sessionB({ ...briefed }), d))[1]).toEqual(view(2, true));
    // Without any new work, session B simply shows its own owned facts.
    expect(drive(live(tracksA, d), facts(sessionB({ ...briefed })))[1]).toEqual(view(2));
    expect(drive(live(tracksA, d), facts(sessionB({ ...found })))[1]).toEqual(view(5, false, true));
    // A run that finished under A is not B's evidence: B's own restored facts show.
    const doneA = base({ ...found, attempt: attempt('a-d', 'discover', false) });
    expect(drive(live(tracksA, d), facts(doneA), facts(sessionB({ ...briefed })))[2]).toEqual(view(2));
    expect(drive(live(briefed, d), facts(sessionB({ ...briefed })))[1]).toEqual(view(2));
  });

  it('a run is bound to the controller wipe: a wiped same-context view starts over and never inherits the earlier run', () => {
    const d = act('discover');
    const tracksA = base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-d', 'discover', true), identity: identity(false), connection });
    expect(drive(live(tracksA, d), live(briefed, d, { wipe: 1 }))).toEqual([view(4, true), view(2, true)]);
    // A wiped view is a restored one: the retained run is dropped, not held at its old stage count.
    expect(drive(live(tracksA, d), facts(briefed, { wipe: 1 }))[1]).toEqual(view(2));
    expect(drive(live(tracksA, d), facts(found, { wipe: 1 }))[1]).toEqual(view(5, false, true));
    // Same wipe: the run persists.
    expect(drive(live(tracksA, d), live(briefed, d, { wipe: 0 }))[1]).toEqual(view(4, true));
  });

  it('local action identity: repeated renders of one action keep progress; a later action of the same kind resets independently', () => {
    const first = act('discover');
    const tracks = base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-d', 'discover', true), identity: identity(false), connection });
    const settled = base({ ...briefed, identity: identity(false), connection });
    // Re-rendering the same action (with or without the admitted Attempt in view) never resets or lowers the fill.
    expect(drive(live(briefed, first), live(tracks, first), live(tracks, first), live(settled, first), live(settled, first))).toEqual([view(2, true), view(4, true), view(4, true), view(4, true), view(4, true)]);
    // A new action object of the same kind begins its own run from its inputs.
    expect(drive(live(tracks, first), live(settled, act('discover')))[1]).toEqual(view(2, true));
    expect(drive(live(tracks, first), live(briefed, act('discover')))[1]).toEqual(view(2, true));
    // Once an action ended and the unfinished server Attempt remains (no local action), it is the same run.
    expect(drive(live(briefed, first), live(tracks, first), live(tracks, null))).toEqual([view(2, true), view(4, true), view(4, true)]);
    // A later action after a finished one is independent: the finished one's evidence cannot complete it.
    const done = base({ ...found, attempt: attempt('a-d', 'discover', false) });
    const second = act('discover');
    expect(drive(live(briefed, first), facts(done), live(done, second), facts(done))).toEqual([view(2, true), view(5, false, true), view(2, true), view(2)]);
  });

  it('Stop, Clear, expiry, replacement and a late completion of a revoked run never restore its progress', () => {
    const d = act('discover');
    const tracks = base({ ...briefed, stage: 'finding_tracks', attempt: attempt('a-d', 'discover', true), identity: identity(false), connection });
    const lateFound = base({ ...found, attempt: attempt('a-d', 'discover', false) });
    const wipedBlank = base({ session: null });
    // Clear: revoked and blanked now, and the blank stays (the controller itself drops a late reply of the cleared session).
    expect(drive(live(tracks, d), facts(tracks, { revoked: true, wipe: 1 }), facts(wipedBlank, { wipe: 1 }))).toEqual([view(4, true), view(0), view(0)]);
    // After a wipe the earlier run has no memory: a later run of the same session context starts from its own inputs.
    expect(drive(live(tracks, d), facts(tracks, { revoked: true, wipe: 1 }), live(briefed, act('discover'), { wipe: 1 }))).toEqual([view(4, true), view(0), view(2, true)]);
    // Expiry: no session, then a new session has no memory of the old run.
    expect(drive(live(tracks, d), facts(base({ session: null, code: 'session_expired' }), { wipe: 1 }), facts(sessionB({ ...briefed }), { wipe: 1 }))).toEqual([view(4, true), view(0), view(2)]);
    // Stop: busy stops now, the stages already proven stay, and the Attempt ending cancelled adds nothing.
    const stopped = base({ ...briefed, stage: 'cancelled', code: 'cancelled', identity: identity(false), connection, attempt: { ...attempt('a-d', 'discover', false), outcome: 'cancelled' } });
    expect(drive(live(tracks, d), facts(tracks, { working: true, stopping: true }), facts(stopped))).toEqual([view(4, true), view(4, false, false, true), view(4)]);
    // A same-session late completion after Stop (a succeeded read of the SAME Attempt) is that run's own evidence, not another's.
    expect(drive(live(tracks, d), facts(tracks, { working: true, stopping: true }), facts(lateFound))[2]).toEqual(view(5, false, true));
  });

  it('a restored finished session (no run seen by this page) shows the factual state at once', () => {
    expect(drive(facts(found))[0]).toEqual(view(5, false, true));
    // A restored failure never claims a found song even though an earlier panel exists.
    expect(drive(facts(base({ ...found, stage: 'failed', code: 'catalogue_failed' })))[0]!.found).toBe(false);
  });
});

describe('fill and breath motion', () => {
  function motion(reduced = false, hidden = false) {
    const frames = new FakeFrames();
    const flags = { reduced, hidden };
    const fills: number[][] = [];
    const breaths: (number | null)[] = [];
    const m = new EmblemMotion({ frames, reducedMotion: () => flags.reduced, hidden: () => flags.hidden }, { fill: (r) => fills.push([...r]), breath: (b) => breaths.push(b) });
    return { frames, flags, fills, breaths, m, last: () => fills[fills.length - 1]! };
  }

  it('the new constants are the documented extension, not a timer on facts', () => {
    expect([EMBLEM.fillMs, EMBLEM.breathMs, EMBLEM.rings]).toEqual([600, 1800, 5]);
    const spec = JSON.parse(readFileSync(new URL('../docs/design/MOTION_SPEC.json', import.meta.url), 'utf8')) as { theme_update: { emblem_extension: { fill: { duration_ms: number; easing_token: string }; breath: { cycle_ms: number } } } };
    expect([spec.theme_update.emblem_extension.fill.duration_ms, spec.theme_update.emblem_extension.breath.cycle_ms]).toEqual([EMBLEM.fillMs, EMBLEM.breathMs]);
    expect(spec.theme_update.emblem_extension.fill.easing_token).toBe('enter');
  });

  it('a first value is drawn at rest with no motion; an increase fills over 600 ms and lands exactly on the fact', () => {
    const t = motion();
    t.m.setSteps(3);
    expect(t.m.value).toBe(3);
    expect(t.last()).toEqual([1, 1, 1, 0, 0]);
    expect(t.frames.queue.size).toBe(0);
    t.m.setSteps(4);
    t.frames.step(300);
    expect(t.m.value).toBeGreaterThan(3);
    expect(t.m.value).toBeLessThan(4);
    t.frames.step(299);
    expect(t.m.value).toBeLessThan(4);
    t.frames.step(1);
    expect(t.m.value).toBe(4);
    expect(t.last()).toEqual([1, 1, 1, 1, 0]);
    expect(t.frames.queue.size).toBe(0);
  });

  it('a phase change mid-fill retargets from the current visible value: monotonic, no snap back, no restart', () => {
    const t = motion();
    t.m.setSteps(2);
    t.m.setSteps(3);
    t.frames.step(200);
    const mid = t.m.value!;
    expect(mid).toBeGreaterThan(2);
    t.m.setSteps(4);
    const seen: number[] = [];
    for (let i = 0; i < 80; i++) {
      t.frames.step(16);
      seen.push(t.m.value!);
    }
    expect(seen[0]!).toBeGreaterThanOrEqual(mid);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(t.m.value).toBe(4);
  });

  it('a decrease (new attempt, Clear, expiry, replacement) lands at once, even mid-fill', () => {
    const t = motion();
    t.m.setSteps(4);
    t.m.setSteps(5);
    t.frames.step(100);
    t.m.setSteps(0);
    expect(t.m.value).toBe(0);
    expect(t.last()).toEqual([0, 0, 0, 0, 0]);
    t.frames.step(1000);
    expect(t.m.value).toBe(0);
  });

  it('Stop, a hidden page and reduced motion land a partly drawn fill on its factual end without loops', () => {
    const stop = motion();
    stop.m.setSteps(2);
    stop.m.setSteps(3);
    stop.frames.step(100);
    stop.m.finish();
    expect(stop.m.value).toBe(3);
    expect(stop.frames.queue.size).toBe(0);

    const reduced = motion(true);
    reduced.m.setSteps(1);
    reduced.m.setSteps(4);
    expect(reduced.m.value).toBe(4);
    reduced.m.setBusy(true);
    expect(reduced.frames.queue.size).toBe(0);
    expect(reduced.breaths).toEqual([]);

    const live = motion();
    live.m.setSteps(1);
    live.m.setSteps(4);
    live.m.setBusy(true);
    live.frames.step(50);
    live.flags.reduced = true;
    live.m.reducedMotionChanged();
    expect(live.m.value).toBe(4);
    expect(live.m.breathing).toBe(false);
    expect(live.breaths[live.breaths.length - 1]).toBeNull();

    const hidden = motion(false, true);
    hidden.m.setSteps(1);
    hidden.m.setSteps(4);
    expect(hidden.m.value).toBe(4);
    hidden.m.setBusy(true);
    expect(hidden.frames.queue.size).toBe(0);
  });

  it('the breath is one in-phase 1800 ms cycle only while genuinely busy, and never advances the fill', () => {
    expect(breathAt(0)).toBe(0);
    expect(breathAt(900)).toBeCloseTo(1, 6);
    expect(breathAt(1800)).toBeCloseTo(0, 6);
    expect(breathAt(450)).toBeCloseTo(0.5, 6);
    const t = motion();
    t.m.setSteps(2);
    const fillWrites = t.fills.length;
    t.m.setBusy(true);
    expect(t.m.breathing).toBe(true);
    t.frames.run(5400);
    expect(t.breaths.filter((b) => b !== null).length).toBeGreaterThan(100);
    expect(t.fills.length).toBe(fillWrites);
    expect(t.m.value).toBe(2);
    t.m.setBusy(false);
    expect(t.m.breathing).toBe(false);
    expect(t.breaths[t.breaths.length - 1]).toBeNull();
    expect(t.frames.queue.size).toBe(0);
  });

  it('an already hidden mount draws no frame, and showing the page later starts the breath only then and only while still busy', () => {
    const t = motion(false, true);
    t.m.setSteps(2);
    t.m.setBusy(true);
    expect(t.m.breathing).toBe(false);
    expect(t.frames.queue.size).toBe(0);
    expect(t.breaths).toEqual([]);
    t.frames.run(500);
    expect(t.breaths).toEqual([]);
    t.flags.hidden = false;
    t.m.visibilityChanged(false);
    expect(t.m.breathing).toBe(true);
    expect(t.breaths).toEqual([0]);
    t.m.setBusy(false);
    expect(t.m.breathing).toBe(false);
    expect(t.frames.queue.size).toBe(0);

    // The same mount, work already finished before it was ever shown: nothing starts.
    const idle = motion(false, true);
    idle.m.setBusy(true);
    idle.m.setBusy(false);
    idle.flags.hidden = false;
    idle.m.visibilityChanged(false);
    expect(idle.m.breathing).toBe(false);
    expect(idle.frames.queue.size).toBe(0);
  });

  it('a page hidden between frames stops the loop at the next tick even before its event arrives, and the late event resumes it exactly once', () => {
    const t = motion();
    t.m.setSteps(1);
    t.m.setBusy(true);
    t.frames.step(16);
    expect(t.m.breathing).toBe(true);
    t.flags.hidden = true;
    t.frames.step(16);
    expect(t.m.breathing).toBe(false);
    expect(t.frames.queue.size).toBe(0);
    expect(t.breaths[t.breaths.length - 1]).toBeNull();
    const before = t.breaths.length;
    t.frames.run(500);
    expect(t.breaths.length).toBe(before);
    t.flags.hidden = false;
    t.m.visibilityChanged(false);
    t.m.visibilityChanged(false);
    expect(t.m.breathing).toBe(true);
    expect(t.frames.queue.size).toBe(1);
    // A live reduced-motion switch has the same guard, and the work ending leaves no resurrected frame.
    t.flags.reduced = true;
    t.frames.step(16);
    expect(t.m.breathing).toBe(false);
    expect(t.frames.queue.size).toBe(0);
    t.flags.reduced = false;
    t.m.setBusy(false);
    t.m.reducedMotionChanged();
    t.frames.run(100);
    expect(t.m.breathing).toBe(false);
    expect(t.frames.queue.size).toBe(0);
  });

  it('unmounting while breathing or filling cancels every frame and a late event cannot bring one back', () => {
    const t = motion();
    t.m.setSteps(1);
    t.m.setSteps(3);
    t.m.setBusy(true);
    t.frames.step(100);
    t.m.dispose();
    expect(t.frames.queue.size).toBe(0);
    const fills = t.fills.length;
    const breaths = t.breaths.length;
    t.m.visibilityChanged(true);
    t.m.visibilityChanged(false);
    t.m.reducedMotionChanged();
    t.frames.run(1000);
    // Only the removal of a breath (null) may still be written; no fill and no new breath value, and no frame.
    expect(t.fills.length).toBe(fills);
    expect(t.breaths.slice(breaths).every((b) => b === null)).toBe(true);
    expect(t.frames.queue.size).toBe(0);
    expect(t.m.breathing).toBe(false);
  });

  it('hiding the page suspends the breath and showing it resumes only while still busy', () => {
    const t = motion();
    t.m.setSteps(1);
    t.m.setBusy(true);
    t.m.visibilityChanged(true);
    expect(t.m.breathing).toBe(false);
    expect(t.frames.queue.size).toBe(0);
    t.m.visibilityChanged(false);
    expect(t.m.breathing).toBe(true);
    t.m.setBusy(false);
    t.m.visibilityChanged(true);
    t.m.visibilityChanged(false);
    expect(t.m.breathing).toBe(false);
  });
});

describe('markup', () => {
  it('is a named image whose factual state is data, with the frontier ring marked only while busy', () => {
    const idle = renderToStaticMarkup(<Emblem out={view(2)} />);
    expect(idle).toMatch(/<svg[^>]*class="emblem"[^>]*viewBox="0 0 128 128"[^>]*role="img"[^>]*aria-label="Wintr"[^>]*data-steps="2"/);
    expect(idle).not.toMatch(/data-busy|data-found|data-frontier/);
    const busy = renderToStaticMarkup(<Emblem out={view(2, true)} />);
    expect(busy).toMatch(/data-busy="true"/);
    expect(busy.match(/data-frontier="true"/g)).toHaveLength(1);
    expect(busy).toMatch(/class="ring ring-2"[^>]*data-frontier="true"/);
    const done = renderToStaticMarkup(<Emblem out={view(5, false, true)} />);
    expect(done).toMatch(/data-found="true"/);
    expect(done).not.toMatch(/data-frontier/);
    // Decorative state is never a live region and never spoken as progress.
    expect(done).not.toMatch(/aria-live|role="status"|role="progressbar"|aria-valuenow/);
  });
});
