import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { composeLiveRuntime, startLiveServer, type LiveRuntime } from '../src/server/live-runtime.js';
import { createFirestoreDocStore, type DocData, type DocStore } from '../src/server/persistence/docstore.js';
import { createOwnedFirestoreDocStore, isManagedDocStore, manageDocStore } from '../src/server/persistence/docstore-lifecycle.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { APPROVED, binding, loaders, transports, policy } from './fixtures/live-fixtures.js';
import { createExposureLedger } from '../src/server/ledger/ledger.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { LIMITS } from '../src/shared/records.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const PATH = { collection: 'wintr_owned' as const, id: 'invented_lifecycle_document' };
class OwnedFake extends FakeFirestore {
  terminate = vi.fn(async () => {});
}

describe('owned DocStore lifecycle (public seams, synthetic clients)', () => {
  it('revokes even a detached inherited cleanup context before releasing the SDK', async () => {
    const sdk = new OwnedFake(new FakeFirestoreServer()), docs = createOwnedFirestoreDocStore(sdk), resume = deferred<void>();
    let detached!: Promise<unknown>;
    await docs.close(async () => { detached = (async () => { await resume.promise; return docs.get(PATH); })(); });
    resume.resolve(); await expect(detached).rejects.toMatchObject({ code: 'unavailable' }); expect(sdk.terminate).toHaveBeenCalledTimes(1);
  });
  it('admits only the trusted close cleanup while every ordinary caller stays closed', async () => {
    const sdk = new OwnedFake(new FakeFirestoreServer()), docs = createOwnedFirestoreDocStore(sdk);
    const entered = deferred<void>(), finish = deferred<void>();
    const closing = docs.close(async () => { await docs.get(PATH); entered.resolve(); await finish.promise; await docs.get(PATH); });
    await entered.promise;
    await expect(docs.get(PATH)).rejects.toMatchObject({ code: 'unavailable' });
    expect(sdk.terminate).not.toHaveBeenCalled(); finish.resolve(); await closing;
    expect(sdk.terminate).toHaveBeenCalledTimes(1); await expect(docs.get(PATH)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('invalidates synchronously, closes once, and refuses all later entry before the borrowed SDK is called', async () => {
    const sdk = new OwnedFake(new FakeFirestoreServer());
    const tx = vi.spyOn(sdk, 'runTransaction'); const collection = vi.spyOn(sdk, 'collection');
    const docs = createOwnedFirestoreDocStore(sdk);
    expect(isManagedDocStore(docs)).toBe(true);
    const close = docs.close(); expect(docs.close()).toBe(close);
    await expect(docs.get(PATH)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(docs.query('wintr_owned', [{ field: 'kind', op: '==', value: 'invented' }], 1)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(docs.transact(async () => {})).rejects.toMatchObject({ code: 'unavailable' });
    await close; expect(sdk.terminate).toHaveBeenCalledTimes(1);
    expect(tx).not.toHaveBeenCalled(); expect(collection).not.toHaveBeenCalled();
  });

  it('drains an admitted transaction, refusing its late writes before release/SDK termination', async () => {
    const db = new FakeFirestoreServer(); const sdk = new OwnedFake(db); const docs = createOwnedFirestoreDocStore(sdk);
    const entered = deferred<void>(); const release = deferred<void>();
    const work = docs.transact(async (tx) => {
      await tx.getAll([PATH]); entered.resolve(); await release.promise;
      tx.set(PATH, { invented: true });
    }).catch((error: unknown) => error);
    await entered.promise;
    const close = docs.close();
    await expect(docs.get(PATH)).rejects.toMatchObject({ code: 'unavailable' });
    expect(sdk.terminate).not.toHaveBeenCalled();
    release.resolve(); expect(await work).toMatchObject({ code: 'unavailable' });
    await close; expect(sdk.terminate).toHaveBeenCalledTimes(1); expect(db.entries()).toEqual([]);
  });

  it('waits for all admitted reads/queries, withholding their results after revocation', async () => {
    const get = deferred<DocData | null>(); const query = deferred<{ id: string; data: DocData }[]>();
    const release = vi.fn(async () => {});
    const inner: DocStore = { get: () => get.promise, query: () => query.promise, transact: async (fn) => createFirestoreDocStore(new FakeFirestore(new FakeFirestoreServer())).transact(fn) };
    const docs = manageDocStore(inner, release);
    const a = docs.get(PATH).catch((error: unknown) => error);
    const b = docs.query('wintr_owned', [{ field: 'kind', op: '==', value: 'invented' }], 1).catch((error: unknown) => error);
    const close = docs.close();
    get.resolve({ private: 'invented' }); expect(await a).toMatchObject({ code: 'unavailable' }); expect(release).not.toHaveBeenCalled();
    query.resolve([]); expect(await b).toMatchObject({ code: 'unavailable' }); await close;
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a failed release remains observable/idempotent and never re-opens operations', async () => {
    const release = vi.fn(async () => { throw new Error('invented release failure'); });
    const docs = manageDocStore(createFirestoreDocStore(new FakeFirestore(new FakeFirestoreServer())), release);
    const close = docs.close(); await expect(close).rejects.toThrow('invented release failure');
    expect(docs.close()).toBe(close); await expect(docs.get(PATH)).rejects.toMatchObject({ code: 'unavailable' });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

/** Direct canonical handler invocation; no listener, provider, credential file or network. */
async function send(runtime: Extract<LiveRuntime, { ok: true }>, method: string, path: string, body?: unknown, cookie?: string) {
  const req = new IncomingMessage(new Socket());
  const text = body === undefined ? '' : JSON.stringify(body);
  req.method = method; req.url = path;
  req.headers = { host: runtime.config.hostHeader, origin: runtime.config.origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }) };
  if (body !== undefined) req.push(Buffer.from(text)); req.push(null);
  const res = new ServerResponse(req); let result = '';
  res.end = ((chunk: unknown) => { result = String(chunk); return res; }) as typeof res.end;
  await runtime.handler(req, res); req.destroy();
  return { status: res.statusCode, body: JSON.parse(result), cookie: String(res.getHeader('set-cookie') ?? '').split(';')[0] };
}

describe('live composition uses the public managed lifecycle without changing auth requirements', () => {
  it('three interrupted restarts release only local concurrency and keep every dispatched hold', async () => {
    const db = new FakeFirestoreServer(); const b = binding();
    const ledger = createExposureLedger({ docs: createFirestoreDocStore(new FakeFirestore(db)), policy: b.exposurePolicy, serviceId: b.serviceId });
    for (let i = 0; i < 3; i++) {
      const entered = deferred<void>(), t = transports(), l = loaders(db);
      const runtime = await composeLiveRuntime({ config: loadConfig([], { WINTR_MODE: 'disabled' }), bindings: b, loaders: l.loaders,
        network: { ...t.network, reference: async request => {
          entered.resolve(); return new Promise((_, reject) => { request.signal?.addEventListener('abort', () => reject(Error('invented abort')), { once: true }); });
        } } });
      if (!runtime.ok) throw Error('invented composition failed');
      const session = await send(runtime, 'POST', '/api/session', {});
      const request = send(runtime, 'POST', '/api/reference', { url: 'https://youtu.be/' + APPROVED, actionKey: randomUUID() }, session.cookie);
      await entered.promise; const closing = runtime.close();
      expect(await send(runtime, 'GET', '/api/state', undefined, session.cookie)).toMatchObject({ status: 503 });
      await expect(runtime.store.createSession(Date.now())).rejects.toThrow('store unavailable');
      await Promise.all([closing, request]);
      expect(await ledger.totals()).toMatchObject({ active: 0, unresolved: i + 1, counts: { gemini: i + 1, qloo: 0 }, unitsHeld: 300 * (i + 1) });
    }
  });

  it('restart recovery leaves a current foreign worker active and only ends elapsed intents without a refund', async () => {
    const db = new FakeFirestoreServer(), docs = createFirestoreDocStore(new FakeFirestore(db)), t = Date.now(), p = policy(t + 3_600_000);
    const ledger = createExposureLedger({ docs, policy: p, serviceId: 'svc-invented-recovery' });
    let current = t;
    const store = new FirestoreStore({ docs, policy: p, serviceId: 'svc-invented-recovery', clock: () => current, maxSessions: 20, maxJourneysPerSession: 3 });
    const add = async (name: string, now: number) => {
      const r = await ledger.reserve({ reservationKey: name.repeat(16), stage: 'reference_analysis', sessionId: name.repeat(16), journeyId: name.repeat(16), attemptId: name.repeat(16), now });
      if (!r.ok) throw Error('invented reservation failed');
      expect(await ledger.markIntent(r.reservation.id, now)).toMatchObject({ ok: true }); return r.reservation.id;
    };
    const old = await add('a', t), recent = await add('b', t + 1);
    current = t + LIMITS.executeDeadlineMs;
    await store.recoverExpiredSubmissions();
    expect(await ledger.read(old)).toMatchObject({ state: 'unknown', unknownReason: 'abandoned_after_restart' });
    expect(await ledger.read(recent)).toMatchObject({ state: 'intent' });
    expect(await ledger.totals()).toMatchObject({ active: 1, unresolved: 2, counts: { gemini: 2, qloo: 0 }, unitsHeld: 600 });
    current++; await store.recoverExpiredSubmissions();
    expect(await ledger.totals()).toMatchObject({ active: 0, unresolved: 2, unitsHeld: 600 });
  });
  it('expiry before listening revokes the runtime and closes the owned SDK without opening a listener', async () => {
    const db = new FakeFirestoreServer(); const sdk = new OwnedFake(db); const l = loaders(db); const t = transports();
    const clock = { t: Date.now() };
    const runtime = await composeLiveRuntime({ config: loadConfig([], { WINTR_MODE: 'disabled' }), bindings: binding(), clock: () => clock.t,
      loaders: { ...l.loaders, firestore: async () => createOwnedFirestoreDocStore(sdk) }, network: t.network });
    if (!runtime.ok) throw new Error('synthetic composition failed');
    clock.t = runtime.validUntil;
    expect(await startLiveServer(runtime)).toMatchObject({ ok: false });
    expect(await send(runtime, 'GET', '/api/state')).toMatchObject({ status: 503 });
    expect(sdk.terminate).toHaveBeenCalledTimes(1);
    expect(t.reference).toHaveLength(0); expect(t.qloo).toHaveLength(0); expect(t.cat.calls).toHaveLength(0);
  });

  it('explicit runtime close gates handler/Store and prevents restart before awaiting a pending operation', async () => {
    const db = new FakeFirestoreServer(); const sdk = new OwnedFake(db);
    const docs = createOwnedFirestoreDocStore(sdk);
    const t = transports(); const l = loaders(db);
    const runtime = await composeLiveRuntime({ config: loadConfig([], { WINTR_MODE: 'disabled' }), bindings: binding(), loaders: { ...l.loaders, firestore: async () => docs }, network: t.network });
    if (!runtime.ok) throw new Error('synthetic composition failed');
    const entered = deferred<void>(); const release = deferred<void>();
    const work = docs.transact(async () => { entered.resolve(); await release.promise; }).catch((error: unknown) => error);
    await entered.promise;
    const close = runtime.close(); expect(runtime.close()).toBe(close);
    expect(await send(runtime, 'GET', '/api/state')).toMatchObject({ status: 503, body: { error: 'admission_unavailable' } });
    await expect(runtime.store.createSession(Date.now())).rejects.toThrow('store unavailable');
    expect(await startLiveServer(runtime)).toMatchObject({ ok: false, problems: ['runtime:closed'] });
    expect(sdk.terminate).not.toHaveBeenCalled();
    release.resolve(); expect(await work).toMatchObject({ code: 'unavailable' }); await close;
    expect(sdk.terminate).toHaveBeenCalledTimes(1);
    expect(t.reference).toHaveLength(0); expect(t.qloo).toHaveLength(0); expect(t.cat.calls).toHaveLength(0);
  });

  it('runtime close aborts pending token preparation; a late token cannot send or refund its held intent', async () => {
    const db = new FakeFirestoreServer(); const sdk = new OwnedFake(db); const docs = createOwnedFirestoreDocStore(sdk);
    const t = transports(); const l = loaders(db); const entered = deferred<void>(); const release = deferred<void>(); let tokens = 0;
    const runtime = await composeLiveRuntime({
      config: loadConfig([], { WINTR_MODE: 'disabled' }), bindings: binding(), network: t.network,
      loaders: { ...l.loaders, firestore: async () => docs, googleAccessToken: async (ref) => {
        const token = await l.loaders.googleAccessToken(ref);
        if (++tokens === 2) { entered.resolve(); await release.promise; }
        return token;
      } },
    });
    if (!runtime.ok) throw new Error('synthetic composition failed');
    const created = await send(runtime, 'POST', '/api/session', {}); const cookie = created.cookie;
    const ref = await send(runtime, 'POST', '/api/reference', { url: `https://youtu.be/${APPROVED}`, actionKey: randomUUID() }, cookie);
    const brief = await send(runtime, 'POST', '/api/preference', { analysis: ref.body.analysis.handle, relationship: { choice: 0 }, artists: ['Generic Artist'], actionKey: randomUUID(), expectedBrief: null }, cookie);
    const discovery = send(runtime, 'POST', '/api/discover', { brief: brief.body.brief.handle, actionKey: randomUUID() }, cookie);
    await entered.promise;
    const before = await runtime.store.reconciliation().totals(); const close = runtime.close();
    expect(await discovery).toMatchObject({ status: 503, body: { error: 'admission_unavailable' } });
    release.resolve(); await close; await Promise.resolve();
    expect(t.cat.calls).toHaveLength(0);
    const after = await createExposureLedger({ docs: createFirestoreDocStore(new FakeFirestore(db)), policy: binding().exposurePolicy, serviceId: 'svc-invented-live' }).totals();
    expect(after).toEqual({ ...before, active: 0 });
    expect(db.entries('wintr_ledger_reservations').some(([, value]) => value.state === 'unknown' && value.unknownReason === 'cancelled')).toBe(true);
  });

  it('borrowed compatibility clients remain open for their owner while the composed Store is closed', async () => {
    const db = new FakeFirestoreServer(); const sdk = new OwnedFake(db); const l = loaders(db);
    const runtime = await composeLiveRuntime({ config: loadConfig([], { WINTR_MODE: 'disabled' }), bindings: binding(), loaders: { ...l.loaders, firestore: async () => sdk }, network: transports().network });
    if (!runtime.ok) throw new Error('synthetic composition failed');
    await runtime.close(); expect(sdk.terminate).not.toHaveBeenCalled();
    await expect(runtime.store.createSession(Date.now())).rejects.toThrow('store unavailable');
    await sdk.terminate(); expect(sdk.terminate).toHaveBeenCalledTimes(1);
  });
});
