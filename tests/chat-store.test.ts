import { describe, expect, it } from 'vitest';
import type { Handle } from '../src/shared/records.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { newHandle, sha256 } from '../src/server/ids.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { MemoryStore, type AdmitResult, type Store } from '../src/server/store.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

const T = 1_800_000_000_000, HOUR = 3_600_000;
const reference = { videoId: '00000000001', canonicalUrl: 'https://www.youtube.com/watch?v=00000000001', focus: { start: 0, end: 30 } };
const analysis = { synthetic: true, audioAccess: 'synthetic_not_accessed' as const, observations: ['Invented observation'], relationships: ['Invented relationship'], provider: null };
function accepted(r: AdmitResult) { expect(r.kind).toBe('admitted'); if (r.kind !== 'admitted') throw new Error('admission expected'); return r; }
async function fixture(kind: 'memory' | 'shared', maxJourneysPerSession = 3) {
  const clock = { t: T }, db = new FakeFirestoreServer();
  const memory = new MemoryStore({ maxSessions: 10, maxJourneysPerSession });
  const make = (): Store => kind === 'memory' ? memory : new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'invented-chat-store', clock: () => clock.t, maxSessions: 10, maxJourneysPerSession,
    policy: { version: 'invented-chat-policy', currency: 'XTS', expiresAt: T + 2 * HOUR,
      service: { capUnits: 10000, concurrency: 8, counts: { qloo: 60, gemini: 40 } },
      session: { capUnits: 1000, counts: { qloo: 6, gemini: 4 } }, journey: { capUnits: 1000, counts: { qloo: 6, gemini: 4 } },
      reservations: Object.fromEntries(['reference_analysis', 'qloo_search', 'qloo_artist_insights', 'qloo_tag_insights', 'catalogue_generation'].map(s => [s, { units: 1, bound: 'enforceable' }])) } });
  const created = await make().createSession(clock.t);
  if (!created || created === 'rate_limited') throw new Error('session expected');
  const owner = { sessionId: created.session.id, epoch: created.session.epoch };
  let n = 0;
  const action = () => ({ actionKeyHash: sha256(`invented-chat-key-${++n}`), inputHash: sha256(`invented-chat-input-${n}`) });
  const create = async () => {
    const result = await make().changeChat(owner, { kind: 'create' }, action(), clock.t);
    expect(result.kind).toBe('ok'); if (result.kind === 'rejected' || !result.chat) throw new Error('chat expected'); return result.chat;
  };
  const start = (chat?: Handle) => (chat ? make().forChat(chat) : make()).admitReference({ ...owner, reference, listenerCue: null, now: clock.t, ...action() });
  const read = (chat?: Handle) => (chat ? make().forChat(chat) : make()).read(owner.sessionId, owner.epoch, clock.t);
  const complete = (chat: Handle | null, r: ReturnType<typeof accepted>) => (chat ? make().forChat(chat) : make()).commitAnalysis(owner.sessionId, owner.epoch, r.attempt.id, analysis, clock.t);
  return { make, clock, db, created, owner, action, create, start, read, complete };
}

describe.each(['memory', 'shared'] as const)('%s session-only owned chats', kind => {
  it('refuses aggregate intake-brief overflow before a new reference is admitted', async () => {
    const f = await fixture(kind), first = accepted(await f.start()); await f.complete(null, first);
    const state = (await f.read())!;
    let expectedBriefId: Handle | null = null;
    for (let i = 0; i < 20; i++) {
      const saved = await f.make().saveBrief(f.owner, { analysisId: state.analysis!.id, relationship: `Invented relationship ${i}`, relationshipSource: 'listener_text', proposedArtists: [], exclusions: [] }, { ...f.action(), expectedBriefId }, f.clock.t);
      if (saved.kind === 'rejected') throw new Error(saved.code); expectedBriefId = saved.brief.id;
    }
    const chat = await f.create();
    expect(await f.make().forChat(chat).admitReference({ ...f.owner, reference, listenerCue: 'Invented intake direction', now: f.clock.t, ...f.action() })).toEqual({ kind: 'rejected', code: 'capacity' });
    expect((await f.read(chat))!.journey).toBeNull();
  });

  it('reserves aggregate analysis room before admission and rechecks room at commit', async () => {
    const f = await fixture(kind, 10), first = accepted(await f.start()); await f.complete(null, first);
    const state = (await f.read())!;
    let expectedBriefId: Handle | null = null;
    for (let i = 0; i < 20; i++) {
      const saved = await f.make().saveBrief(f.owner, { analysisId: state.analysis!.id, relationship: `Invented direction ${i}`, relationshipSource: 'listener_text', proposedArtists: [], exclusions: [] }, { ...f.action(), expectedBriefId }, f.clock.t);
      if (saved.kind === 'rejected') throw new Error(saved.code); expectedBriefId = saved.brief.id;
    }
    const discover = accepted(await f.make().admitDiscover({ ...f.owner, briefId: expectedBriefId!, now: f.clock.t, ...f.action() }));
    expect(await f.make().recordSearch(f.owner, discover.attempt.id, { ...f.owner, id: newHandle(), journeyId: first.journey.id, query: 'Invented Artist', normalizedQuery: 'invented artist', candidates: [], returned: 0, rejected: 0, createdAt: f.clock.t, expiresAt: T + HOUR }, f.clock.t)).toBe(true);
    await f.make().settleAttempt(f.owner.sessionId, f.owner.epoch, discover.attempt.id, 'failed', 'no_seed', f.clock.t);
    f.clock.t += 61_000;
    const chats: Handle[] = [];
    for (let i = 0; i < 19; i++) chats.push(await f.create());
    for (let i = 0; i < 6; i++) { const r = accepted(await f.start(chats[i]!)); await f.complete(chats[i]!, r); }
    expect(await f.start(chats[6]!)).toEqual({ kind: 'rejected', code: 'capacity' });
    expect((await f.read(chats[6]!))!.analysis).toBeNull();
  });

  it('never returns another chat’s bound Attempt from Stop-by-key', async () => {
    const f = await fixture(kind), chat = await f.create(), guard = f.action();
    const first = accepted(await f.make().admitReference({ ...f.owner, reference, listenerCue: null, now: f.clock.t, ...guard }));
    expect(await f.make().forChat(chat).stopAction(f.owner.sessionId, f.owner.epoch, guard.actionKeyHash, f.clock.t)).toBeNull();
    expect((await f.read())!.attempt!.outcome).toBe('running');
    expect(await f.make().stopAction(f.owner.sessionId, f.owner.epoch, guard.actionKeyHash, f.clock.t)).toEqual({ attemptId: first.attempt.id });
  });
  it('retains distinct accepted references across explicit chat switches without extending Session expiry', async () => {
    const f = await fixture(kind);
    const a = accepted(await f.start()); await f.complete(null, a);
    const acceptedFirst = (await f.read())!;
    f.clock.t += 10_000;
    const chat = await f.create(), b = accepted(await f.start(chat)); await f.complete(chat, b);
    const first = (await f.read())!, second = (await f.read(chat))!;
    expect(first.analysis!.id).toBe(acceptedFirst.analysis!.id);
    expect(first.journey!.id).toBe(a.journey.id); expect(second.journey!.id).toBe(b.journey.id);
    expect(first.analysis!.id).not.toBe(second.analysis!.id);
    expect(second.session).toEqual(first.session); expect(second.session.expiresAt).toBe(T + HOUR);
    expect(first.chats!.items.map(c => c.handle)).toEqual([f.owner.sessionId, chat]);
    expect(second.chats!.current).toBe(chat);
  });

  it('serializes paid admissions across chats and permits the other chat only after completion', async () => {
    const f = await fixture(kind), chat = await f.create();
    const results = await Promise.all([f.start(), f.start(chat)]);
    expect(results.filter(r => r.kind === 'admitted')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'rejected')).toEqual([{ kind: 'rejected', code: 'operation_active' }]);
    const firstWins = results[0]!.kind === 'admitted';
    await f.complete(firstWins ? null : chat, accepted(results[firstWins ? 0 : 1]!));
    expect((await f.start(firstWins ? chat : undefined)).kind).toBe('admitted');
  });

  it('does not restore the bound Journey allowance through creating or deleting chats', async () => {
    const f = await fixture(kind, 1), a = accepted(await f.start()); await f.complete(null, a);
    const chat = await f.create();
    expect(await f.start(chat)).toEqual({ kind: 'rejected', code: 'capacity' });
    expect((await f.make().changeChat(f.owner, { kind: 'delete', chat: f.owner.sessionId, expectedRevision: 0 }, f.action(), f.clock.t)).kind).toBe('ok');
    expect(await f.start(chat)).toEqual({ kind: 'rejected', code: 'capacity' });
    expect(await f.make().admitReference({ ...f.owner, reference, listenerCue: null, now: f.clock.t, ...f.action() })).toEqual({ kind: 'rejected', code: 'not_ready' });
    expect((await f.read())!.chats!.current).toBeNull();
    expect(await f.read(f.owner.sessionId)).toBeNull();
  });

  it('revokes a deleted chat before late dispatch/commit while preserving the other chat and its directory fence', async () => {
    const f = await fixture(kind), chat = await f.create();
    const a = accepted(await f.start(chat));
    const held = (await f.read(chat))!, oldPrimary = (await f.read())!;
    const store = f.make().forChat(chat);
    const call = await store.reserveSubmission(f.owner, a.attempt.id, 'reference_analysis', f.clock.t);
    expect(call.ok).toBe(true);
    expect((await f.make().changeChat(f.owner, { kind: 'delete', chat, expectedRevision: 0 }, f.action(), f.clock.t)).kind).toBe('ok');
    expect(await store.authorizeRead(f.owner, f.clock.t, held.chats!.revision)).toBe(false);
    expect(await f.make().authorizeRead(f.owner, f.clock.t, oldPrimary.chats!.revision)).toBe(false);
    expect(await store.commitAnalysis(f.owner.sessionId, f.owner.epoch, a.attempt.id, analysis, f.clock.t)).toBe(false);
    if (call.ok) expect(await store.beginSubmission(f.owner, a.attempt.id, call.call, f.clock.t)).not.toBe('send');
    expect(await f.read(chat)).toBeNull(); expect((await f.read())!.session.id).toBe(f.owner.sessionId);
    expect((await f.read())!.chats!.items).toHaveLength(1);
  });

  it('binds directory writes and rename revisions without dispatch or changing unrelated chat content', async () => {
    const f = await fixture(kind), guard = f.action();
    const created = await f.make().changeChat(f.owner, { kind: 'create' }, guard, f.clock.t);
    expect(created.kind).toBe('ok'); if (created.kind === 'rejected' || !created.chat) throw new Error('chat expected');
    expect(await f.make().changeChat(f.owner, { kind: 'create' }, guard, f.clock.t)).toMatchObject({ kind: 'replay', chat: created.chat });
    const rename = { kind: 'rename' as const, chat: created.chat, title: 'Invented music chat', expectedRevision: 0 };
    expect((await f.make().changeChat(f.owner, rename, f.action(), f.clock.t)).kind).toBe('ok');
    expect(await f.make().changeChat(f.owner, rename, f.action(), f.clock.t)).toEqual({ kind: 'rejected', code: 'stale_version' });
    expect(await f.make().changeChat(f.owner, rename, { ...guard, inputHash: sha256('different invented input') }, f.clock.t)).toEqual({ kind: 'rejected', code: 'action_conflict' });
    expect((await f.read())!.chats!.items[1]!.title).toBe(rename.title);
    expect((await f.read(created.chat))!.journey).toBeNull();
  });

  it('rejects foreign chat handles, and fixed Session expiry/Clear revoke every chat', async () => {
    const f = await fixture(kind), chat = await f.create();
    const foreign = await f.make().createSession(f.clock.t);
    if (!foreign || foreign === 'rate_limited') throw new Error('session expected');
    expect(await f.make().forChat(chat).read(foreign.session.id, foreign.session.epoch, f.clock.t)).toBeNull();
    f.clock.t = T + HOUR;
    expect(await f.read(chat)).toBeNull(); expect(await f.make().forChat(chat).authorizeRead(f.owner, f.clock.t)).toBe(false);
    const fresh = await fixture(kind), other = await fresh.create();
    await fresh.make().clearSession(fresh.owner.sessionId);
    expect(await fresh.read(other)).toBeNull(); expect(await fresh.read()).toBeNull();
  });
});

it.each(['delete-one', 'clear-all'] as const)('never physically deletes foreign records through a tampered %s receipt', async action => {
  const f = await fixture('shared'), chat = await f.create();
  const other = await f.make().createSession(f.clock.t);
  if (!other || other === 'rate_limited') throw new Error('session expected');
  const owner = { sessionId: other.session.id, epoch: other.session.epoch };
  const referenceAttempt = accepted(await f.make().admitReference({ ...owner, reference, listenerCue: null, now: f.clock.t, ...f.action() }));
  await f.make().commitAnalysis(owner.sessionId, owner.epoch, referenceAttempt.attempt.id, analysis, f.clock.t);
  const otherState = (await f.make().read(owner.sessionId, owner.epoch, f.clock.t))!;
  const rootPath = `wintr_owned/session_${f.owner.sessionId}`;
  const stored = f.db.read(rootPath).data as any;
  f.db.seed(rootPath, { ...stored, body: { ...stored.body, chatState: { ...stored.body.chatState, cleanup: [`analysis_${otherState.analysis!.id}`, `analysistext_${otherState.analysis!.id}`] } } });
  if (action === 'clear-all') await f.make().clearSession(f.owner.sessionId);
  else expect((await f.make().changeChat(f.owner, { kind: 'delete', chat, expectedRevision: 0 }, f.action(), f.clock.t)).kind).toBe('ok');
  expect(f.db.read(`wintr_owned/analysis_${otherState.analysis!.id}`).data).not.toBeNull();
  expect((await f.make().read(owner.sessionId, owner.epoch, f.clock.t))!.analysis!.id).toBe(otherState.analysis!.id);
});
