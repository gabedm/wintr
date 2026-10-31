import { describe, expect, it, vi } from 'vitest';
import { createTicketmasterSearch } from '../src/server/concerts.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { createFirestoreDocStore, type DocStore } from '../src/server/persistence/docstore.js';
import { ownedPath } from '../src/server/persistence/owned.js';
import type { HttpTransport } from '../src/server/providers/http.js';
import { createTicketmasterRateGate, type TicketmasterAuthorization } from '../src/server/ticketmaster-rate.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';

const T = Date.UTC(2026, 9, 30, 18);
const query = { artists: ['Invented Artist'], city: null, from: '2026-10-30', to: null };
const empty = () => ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode('{"page":{"totalElements":0}}') });

/** Real Store, document adapter, shared counter and search; only SDK/network and time are invented. */
async function setup() {
  const db = new FakeFirestoreServer(), clock = { value: T }, abort = new AbortController();
  const base = createFirestoreDocStore(new FakeFirestore(db), { maxAttempts: 10 });
  const delays = { ack: 0, quotaRead: undefined as (() => void) | undefined, committed: undefined as (() => void) | undefined };
  const docs: DocStore = { ...base, transact: async fn => {
    const result = await base.transact(tx => fn({ ...tx, getAll: async paths => {
      const rows = await tx.getAll(paths);
      if (paths.some(p => p.id.startsWith('tm_'))) delays.quotaRead?.();
      return rows;
    } }));
    clock.value += delays.ack; delays.committed?.(); return result;
  } };
  const makeStore = () => new FirestoreStore({ docs, serviceId: 'invented-concert-service', policy: null, clock: () => clock.value, maxSessions: 20, maxJourneysPerSession: 3 });
  const store = makeStore(), created = await store.createSession(clock.value);
  if (!created || typeof created === 'string') throw new Error('fixture session');
  const session = created.session, owner = { sessionId: session.id, epoch: session.epoch };
  const gate = createTicketmasterRateGate({ docs, serviceId: 'invented-concert-service', dailyLimit: 250, expiresAt: T + 86400000, now: () => clock.value });
  const authorizeAdmission: TicketmasterAuthorization = work => store.withAuthorizedOperation(owner, clock.value, work);
  const transport = vi.fn<HttpTransport>(async () => empty());
  const authorize = vi.fn(async () => store.authorizeRead(owner, clock.value));
  const create = (atomic = true, auth: () => Promise<boolean> = authorize, admit = gate) => createTicketmasterSearch({
    transport, admit, now: () => clock.value, pause: async ms => { clock.value += ms; },
    access: () => ({ apiKey: 'invented_ticketmaster_key_not_real', validUntil: T + 86400000 }),
  }).search(query, { signal: abort.signal, isCurrent: () => clock.value < session.expiresAt && !abort.signal.aborted, authorize: auth, ...(atomic ? { authorizeAdmission } : {}) });
  const rows = () => db.entries('wintr_service_limits/').filter(([p]) => p.split('/')[1]?.startsWith('tm_'));
  return { db, clock, delays, docs, store, makeStore, session, owner, gate, authorizeAdmission, transport, authorize, create, rows, abort };
}

describe('owned atomic concert admission', () => {
  it('reproduces commit-plus-followup-read starvation and succeeds without that redundant read', async () => {
    const legacy = await setup(); legacy.delays.ack = 600;
    const oldAuth = async () => { legacy.clock.value += 500; return legacy.authorize(); };
    await expect(legacy.create(false, oldAuth)).rejects.toThrow('unavailable');
    expect(legacy.rows()[0]![1].stamps).toHaveLength(1); expect(legacy.transport).not.toHaveBeenCalled();
    const atomic = await setup(); atomic.delays.ack = 600;
    const finalAuth = async () => { atomic.clock.value += 500; return atomic.authorize(); };
    expect(await atomic.create(true, finalAuth)).toMatchObject({ events: [], incomplete: false });
    expect(atomic.transport).toHaveBeenCalledOnce(); expect(atomic.authorize).toHaveBeenCalledOnce();
    expect(atomic.rows()[0]![1].stamps).toEqual([T]);
  });

  it('aborts queued quota writes when Session expiry occurs during the quota read', async () => {
    const s = await setup(); s.delays.quotaRead = () => { s.clock.value = s.session.expiresAt; };
    await expect(s.create()).rejects.toThrow('unavailable'); expect(s.rows()).toEqual([]); expect(s.transport).not.toHaveBeenCalled();
  });

  it('conflicts with a second worker Clear and never commits or sends the refused admission', async () => {
    const s = await setup();
    s.db.beforeCommit = async () => { s.db.beforeCommit = null; await s.makeStore().clearSession(s.owner.sessionId); };
    await expect(s.create()).rejects.toThrow('unavailable');
    expect(s.db.conflicts).toBeGreaterThan(0); expect(s.rows()).toEqual([]); expect(s.transport).not.toHaveBeenCalled();
  });

  it('replans after a conflict but commits one stamp and performs transport only once', async () => {
    const s = await setup(), p = ownedPath('session', s.owner.sessionId);
    s.db.beforeCommit = () => { s.db.beforeCommit = null; const root = s.db.read(`${p.collection}/${p.id}`).data!; s.db.seed(`${p.collection}/${p.id}`, root); };
    expect(await s.create()).toMatchObject({ events: [], incomplete: false });
    expect(s.db.conflicts).toBe(1); expect(s.rows()[0]![1].stamps).toHaveLength(1); expect(s.transport).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'expiry', 'late_ack'] as const)('withholds transport after %s at commit while preserving the spent stamp', async how => {
    const s = await setup();
    s.delays.committed = () => { if (!s.rows().length) return; s.delays.committed = undefined; if (how === 'abort') s.abort.abort(); else s.clock.value = how === 'expiry' ? s.session.expiresAt : T + 1000; };
    await expect(s.create()).rejects.toThrow('unavailable'); expect(s.rows()[0]![1].stamps).toHaveLength(1); expect(s.transport).not.toHaveBeenCalled();
  });

  it('rejects a wrong epoch before calling its transaction planner', async () => {
    const s = await setup(), plan = vi.fn(async () => ({ allowed: true as const, dispatchBy: T + 1000 }));
    expect(await s.store.withAuthorizedOperation({ ...s.owner, epoch: 2 }, T, plan)).toBeNull();
    expect(plan).not.toHaveBeenCalled(); expect(s.rows()).toEqual([]);
  });

  it('refuses a capability grant that did not execute its planner, with no fallback transaction', async () => {
    const s = await setup(), transact = vi.spyOn(s.docs, 'transact');
    expect(await s.gate(s.abort.signal, async () => ({ allowed: true, dispatchBy: T + 1000 }))).toEqual({ allowed: false, reason: 'unavailable' });
    expect(transact).not.toHaveBeenCalled(); expect(s.rows()).toEqual([]);
    expect(await s.gate(s.abort.signal, async () => null)).toEqual({ allowed: false, reason: 'unavailable' });
    expect(transact).not.toHaveBeenCalled();
  });

  it('refuses an admit implementation that ignores the owned capability', async () => {
    const s = await setup();
    await expect(s.create(true, s.authorize, async () => ({ allowed: true, dispatchBy: T + 1000 }))).rejects.toThrow('unavailable');
    expect(s.rows()).toEqual([]); expect(s.transport).not.toHaveBeenCalled();
  });
});

describe('bounded completed concert coverage', () => {
  it.each([false, true])('stops between artists after genuine coverage (events=%s), with an incomplete reply', async hasEvents => {
    let clock = T, transports = 0;
    const transport: HttpTransport = async req => {
      transports++; clock += 9000;
      if (!hasEvents) return empty();
      if (req.url.pathname.endsWith('attractions.json')) return { ...empty(), body: new TextEncoder().encode(JSON.stringify({ _embedded: { attractions: [{ id: 'invented-id', name: 'Invented Artist' }] } })) };
      return { ...empty(), body: new TextEncoder().encode(JSON.stringify({ _embedded: { events: [{ id: 'invented-event', name: 'Invented gig', url: 'https://www.ticketmaster.com/event/invented-event', dates: { start: { localDate: '2026-11-01' }, status: { code: 'onsale' } }, _embedded: { attractions: [{ id: 'invented-id', name: 'Invented Artist' }], venues: [{ name: 'Invented room', city: { name: 'Invented city' } }] } }] } })) };
    };
    const search = createTicketmasterSearch({ transport, access: () => ({ apiKey: 'invented_ticketmaster_key_not_real', validUntil: T + 86400000 }), admit: async () => ({ allowed: true, dispatchBy: clock + 1000 }), now: () => clock, pause: async ms => { clock += ms; } });
    const result = await search.search({ ...query, artists: ['Invented Artist', 'Invented Two', 'Invented Three'] }, { signal: new AbortController().signal, authorize: async () => true, isCurrent: () => true });
    expect(result.incomplete).toBe(true); expect(result.events).toHaveLength(hasEvents ? 1 : 0); expect(transports).toBe(2);
  });

  it('withholds completed partial coverage if final shared authorization is revoked', async () => {
    let clock = T, calls = 0;
    const search = createTicketmasterSearch({ transport: async () => { clock += 18000; calls++; return empty(); }, access: () => ({ apiKey: 'invented_ticketmaster_key_not_real', validUntil: T + 86400000 }), admit: async () => ({ allowed: true, dispatchBy: clock + 1000 }), now: () => clock });
    await expect(search.search({ ...query, artists: ['Invented Artist', 'Invented Two'] }, { signal: new AbortController().signal, authorize: async () => calls === 0, isCurrent: () => true })).rejects.toThrow('unavailable');
    expect(calls).toBe(1);
  });
});
