import { describe, expect, it } from 'vitest';
import { createTicketmasterRateGate } from '../src/server/ticketmaster-rate.js';
import { createFirestoreDocStore, type DocStore } from '../src/server/persistence/docstore.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
const T = 1000000;
function setup(limit = 250) {
  const server = new FakeFirestoreServer(), clock = { value: T };
  const docs = createFirestoreDocStore(new FakeFirestore(server), { maxAttempts: 10 });
  const create = (store = docs) => createTicketmasterRateGate({ docs: store, serviceId: 'invented-ticket-service', dailyLimit: limit, expiresAt: T + 10 * 86400000, now: () => clock.value });
  return { server, docs, clock, create, signal: () => new AbortController().signal, rows: () => server.entries('wintr_service_limits/') };
}
describe('independent durable Ticketmaster admission', () => {
  it('constructs without I/O, stores no content and uses no music-ledger namespace', async () => { const s=setup();const gate=s.create();expect(s.rows()).toEqual([]);expect((await gate(s.signal())).allowed).toBe(true);const row=s.rows()[0]![1];expect(Object.keys(row).sort()).toEqual(['lastSeen','schema','scope','stamps']);expect(serverText(s.server)).not.toMatch(/artist|city|apiKey|session|reservation|GBP/);expect(s.server.entries('wintr_ledger_service/')).toEqual([]); });
  it('shares its rate ceiling across concurrent independent instances', async () => { const s=setup();const a=s.create(),b=s.create();const results=await Promise.all([a(s.signal()),b(s.signal()),a(s.signal()),b(s.signal()),a(s.signal()),b(s.signal())]);expect(results.filter(r=>r.allowed)).toHaveLength(4);expect(results.filter(r=>!r.allowed)).toHaveLength(2);expect((s.rows()[0]![1].stamps as unknown[])).toHaveLength(4); });
  it('does not reset the rolling allowance on recreation or a later launch', async () => { const s=setup(3);for(let i=0;i<3;i++){expect((await s.create()(s.signal())).allowed).toBe(true);s.clock.value+=2001;}expect(await s.create()(s.signal())).toEqual({allowed:false,reason:'limited'});s.clock.value=T+86400000+1001;expect((await s.create()(s.signal())).allowed).toBe(true); });
  it('fails closed on database failure and never substitutes an in-memory allowance', async () => { const s=setup();const broken:DocStore={...s.docs,transact:async()=>{throw new Error('unavailable');}};expect(await s.create(broken)(s.signal())).toEqual({allowed:false,reason:'unavailable'});expect(s.rows()).toEqual([]); });
  it('rejects a regressed clock while preserving already-counted admissions', async()=>{const s=setup();await s.create()(s.signal());s.clock.value=T-1;expect((await s.create()(s.signal())).allowed).toBe(false);expect((s.rows()[0]![1].stamps as number[])).toEqual([T]);});
  it('keeps a delayed committed ticket spent even when it has become too late to dispatch', async()=>{const s=setup();let release!:()=>void;const delay=new Promise<void>(r=>{release=r;});const slow:DocStore={...s.docs,transact:async fn=>{const result=await s.docs.transact(fn);await delay;return result;}};const pending=s.create(slow)(s.signal());while(s.rows().length===0)await Promise.resolve();s.clock.value=T+1000;release();expect(await pending).toEqual({allowed:false,reason:'unavailable'});expect((s.rows()[0]![1].stamps as unknown[])).toHaveLength(1);});
  it('makes no transaction after cancellation or expiry',async()=>{const s=setup();const a=new AbortController();a.abort();expect((await s.create()(a.signal)).allowed).toBe(false);s.clock.value=T+11*86400000;expect((await s.create()(s.signal())).allowed).toBe(false);expect(s.rows()).toEqual([]);});
});
const serverText=(server:FakeFirestoreServer)=>JSON.stringify(server.entries('wintr_service_limits/'));
