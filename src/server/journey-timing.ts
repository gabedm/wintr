import type { Attempt, Journey, JourneyTiming } from '../shared/records.js';

type Phase = JourneyTiming['phase'];
type Milestone = keyof JourneyTiming['milestones'];
const safe = (n: number) => Number.isSafeInteger(n) && n >= 0;

export function initialJourneyTiming(now: number): JourneyTiming {
  return {
    version: 1, phase: 'processing', cursorAt: now,
    processingMs: 0, listenerWaitMs: 0, unobservedMs: 0,
    quality: 'complete', clock: 'ordered',
    milestones: { reference_result: null, connection: null, panel_outcome: null, recording_choices: null },
  };
}

/** Legacy elapsed time has no known phase; never infer milestones from retained content. */
function summary(j: Journey): JourneyTiming {
  if (!j.timing) {
    j.timing = initialJourneyTiming(j.createdAt);
    j.timing.quality = 'partial';
    j.timing.phase = 'closed';
    j.timing.milestones = { reference_result: 'unknown', connection: 'unknown', panel_outcome: 'unknown', recording_choices: 'unknown' };
  }
  return j.timing;
}

/** One logical wall interval, irrespective of the number of overlapping calls. */
function accrue(j: Journey, now: number, forceUnobserved = false): JourneyTiming {
  const t = summary(j);
  if (!safe(now) || now < t.cursorAt || now > j.expiresAt) {
    t.quality = 'partial';
    t.clock = 'recovering';
    return t;
  }
  const elapsed = now - t.cursorAt;
  if (forceUnobserved || t.clock === 'recovering' || t.phase === 'closed') {
    t.unobservedMs += elapsed;
    if (elapsed > 0) t.quality = 'partial';
  } else if (t.phase === 'processing') t.processingMs += elapsed;
  else t.listenerWaitMs += elapsed;
  if (t.clock === 'recovering') t.clock = 'regressed';
  t.cursorAt = now;
  return t;
}

export function timingPhase(j: Journey, now: number, phase: Phase) {
  accrue(j, now).phase = phase;
}

/** Authority may keep a conservative clock floor; timing must still disclose its regression. */
export function timingRegression(j: Journey) {
  const t = summary(j);
  t.quality = 'partial';
  t.clock = 'recovering';
}

export function timingMilestone(j: Journey, now: number, key: Milestone) {
  const t = accrue(j, now);
  if (t.milestones[key] !== null) return;
  t.milestones[key] = t.cursorAt !== now || t.clock === 'recovering' ? 'unknown' : {
    at: now, processingMs: t.processingMs, listenerWaitMs: t.listenerWaitMs,
    unobservedMs: t.unobservedMs, quality: t.quality,
  };
}

/** Called once, while the Attempt still has running authority, before changing its outcome. */
export function finishTiming(j: Journey, a: Attempt, now: number, phase: Phase, deadline = false) {
  if (a.timing && a.timing.finishBasis !== null) return;
  const t = summary(j);
  const finish = deadline ? a.deadlineAt : now;
  const ordered = safe(now) && now <= a.expiresAt && finish >= a.createdAt && finish >= t.cursorAt && now >= finish && t.clock !== 'recovering';
  if (ordered) {
    accrue(j, finish);
    if (deadline) accrue(j, now, true);
  } else {
    // An uncertain interval is never disguised as processing or listener waiting.
    t.quality = 'partial';
    t.clock = 'recovering';
    accrue(j, now, true);
  }
  t.phase = phase;
  a.timing = {
    version: 1,
    finishedAt: ordered ? finish : null,
    recordedAt: safe(now) && now >= a.createdAt && now <= a.expiresAt ? now : null,
    finishBasis: ordered ? (deadline ? 'deadline' : 'transition') : 'clock_regression',
  };
}

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const timestamp = (v: unknown): v is number => typeof v === 'number' && safe(v);
const partial = (v: unknown) => v === 'complete' || v === 'partial';
const TOTALS = ['processingMs', 'listenerWaitMs', 'unobservedMs'] as const;
const MILESTONES = ['reference_result', 'connection', 'panel_outcome', 'recording_choices'] as const;
function totals(v: Record<string, unknown>, elapsed: number): boolean {
  return TOTALS.every((k) => timestamp(v[k])) &&
    Number.isSafeInteger(Number(v.processingMs) + Number(v.listenerWaitMs) + Number(v.unobservedMs)) &&
    Number(v.processingMs) + Number(v.listenerWaitMs) + Number(v.unobservedMs) === elapsed;
}

/** Strict owned-record decoder; omission is handled separately as exact legacy. */
export function validJourneyTiming(v: unknown, createdAt: number, expiresAt: number, stage: string): boolean {
  if (!exact(v, ['version', 'phase', 'cursorAt', ...TOTALS, 'quality', 'clock', 'milestones']) || v.version !== 1 ||
    !timestamp(v.cursorAt) || v.cursorAt < createdAt || v.cursorAt > expiresAt ||
    !partial(v.quality) || !(v.clock === 'ordered' || v.clock === 'recovering' || v.clock === 'regressed') ||
    !totals(v, v.cursorAt - createdAt) || !exact(v.milestones, MILESTONES)) return false;
  const stages = {
    processing: ['validating', 'analysing_reference', 'resolving_artists', 'retrieving_taste', 'finding_tracks'],
    awaiting_listener: ['awaiting_preference', 'awaiting_artist', 'complete', 'no_match'],
    closed: ['failed', 'cancelled', 'expired'],
  };
  if (!(v.phase === 'processing' || v.phase === 'awaiting_listener' || v.phase === 'closed') || !stages[v.phase].includes(stage)) return false;
  if (v.quality === 'complete' && (v.unobservedMs !== 0 || v.clock !== 'ordered')) return false;
  let previous: Record<string, unknown> | null = null;
  for (const key of MILESTONES) {
    const m = v.milestones[key];
    if (m === null) continue;
    if (m === 'unknown') { if (v.quality !== 'partial') return false; continue; }
    if (!exact(m, ['at', ...TOTALS, 'quality']) || !timestamp(m.at) || m.at < createdAt || m.at > v.cursorAt ||
      !partial(m.quality) || !totals(m, m.at - createdAt) ||
      (m.quality === 'complete' && m.unobservedMs !== 0) ||
      (v.quality === 'complete' && m.quality !== 'complete') ||
      TOTALS.some((k) => Number(m[k]) > Number(v[k]))) return false;
    if (previous && (Number(previous.at) > m.at || TOTALS.some((k) => Number(previous![k]) > Number(m[k])))) return false;
    previous = m;
  }
  // Actual choices always follow a panel outcome and a connection; a partial legacy history is explicit.
  if (object(v.milestones.connection) && v.milestones.reference_result === null) return false;
  if (object(v.milestones.panel_outcome) && v.milestones.connection === null) return false;
  if (object(v.milestones.recording_choices) && (v.milestones.panel_outcome === null || v.milestones.connection === null)) return false;
  if (stage === 'complete' && v.milestones.recording_choices === null) return false;
  if (stage === 'no_match' && v.milestones.panel_outcome === null) return false;
  return true;
}

export function validAttemptTiming(v: unknown, createdAt: number, expiresAt: number, deadlineAt: number, outcome: string): boolean {
  if (!exact(v, ['version', 'finishedAt', 'recordedAt', 'finishBasis']) || v.version !== 1) return false;
  if (outcome === 'running') return v.finishedAt === null && v.recordedAt === null && v.finishBasis === null;
  const inBounds = (n: unknown): n is number => timestamp(n) && n >= createdAt && n <= expiresAt;
  if (outcome === 'succeeded' && timestamp(v.recordedAt) && v.recordedAt >= deadlineAt) return false;
  if (v.finishBasis === 'clock_regression') return v.finishedAt === null && (v.recordedAt === null || inBounds(v.recordedAt));
  if (!inBounds(v.finishedAt) || !inBounds(v.recordedAt) || v.recordedAt < v.finishedAt) return false;
  if (v.finishBasis === 'transition') return v.finishedAt === v.recordedAt && v.finishedAt < deadlineAt;
  return v.finishBasis === 'deadline' && v.finishedAt === deadlineAt && outcome !== 'succeeded';
}
