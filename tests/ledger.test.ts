import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExposureLedger, type ExposureLedger, type ReserveRequest } from '../src/server/ledger/ledger.js';
import { parseExposurePolicy, PolicyError } from '../src/server/ledger/policy.js';
import { createFirestoreDocStore, DocStoreError, LEDGER_COLLECTIONS, MAX_DOC_BYTES, type DocStore } from '../src/server/persistence/docstore.js';
import { decodeOwned, encodeOwned, ownedPath } from '../src/server/persistence/owned.js';
import { FakeFirestore, FakeFirestoreServer, FakeTimestamp } from './fixtures/fake-firestore.js';

// W05 foundation (F1): shared transactional persistence and the durable
// exposure/count ledger, exercised through the real Firestore adapter over an
// SDK-shaped fake shared by several client instances. All money figures are
// synthetic minor units of the ISO testing currency XTS; names are symbolic.
// No test here is hosted Firestore acceptance.

const T0 = 1_800_000_000_000;
const SERVICE = 'svc-synthetic-a';
const SESSION_A = 'session-handle-a-000001';
const SESSION_B = 'session-handle-b-000002';
const JOURNEY_A = 'journey-handle-a-000001';
const JOURNEY_B = 'journey-handle-b-000002';
const ATTEMPT = 'attempt-handle-0000001';
const key = (n: number) => `reservation-key-${String(n).padStart(8, '0')}`;

const policy = (o: Record<string, unknown> = {}) => ({
  version: 'synthetic-policy-1',
  currency: 'XTS',
  expiresAt: T0 + 3_600_000,
  service: { capUnits: 10_000, concurrency: 4, counts: { qloo: 100, gemini: 100 } },
  session: { capUnits: 5_000, counts: { qloo: 6, gemini: 4 } },
  journey: { capUnits: 5_000, counts: { qloo: 6, gemini: 4 } },
  reservations: {
    reference_analysis: { units: 300, bound: 'estimate_with_residual' },
    qloo_search: { units: 10, bound: 'enforceable' },
    qloo_artist_insights: { units: 10, bound: 'enforceable' },
    qloo_tag_insights: { units: 10, bound: 'enforceable' },
    catalogue_generation: { units: 500, bound: 'estimate_with_residual' },
  },
  ...o,
});

const docsOn = (server: FakeFirestoreServer, maxAttempts?: number) => createFirestoreDocStore(new FakeFirestore(server), maxAttempts ? { maxAttempts } : {});
/** A separate client instance (process) over the shared server. */
const instance = (server: FakeFirestoreServer, p: unknown = policy(), maxAttempts?: number) => createExposureLedger({ docs: docsOn(server, maxAttempts), policy: p, serviceId: SERVICE });
const req = (n: number, o: Partial<ReserveRequest> = {}): ReserveRequest => ({
  reservationKey: key(n),
  stage: 'catalogue_generation',
  sessionId: SESSION_A,
  journeyId: JOURNEY_A,
  attemptId: ATTEMPT,
  now: T0,
  ...o,
});
const receipt = (units: number, o: Record<string, unknown> = {}) => ({ kind: 'provider_usage', currency: 'XTS', units, reference: 'synthetic-usage-0001', issuedAt: T0 + 5, ...o });

async function reserved(l: ExposureLedger, n: number, o: Partial<ReserveRequest> = {}) {
  const r = await l.reserve(req(n, o));
  if (!r.ok) throw new Error(`reserve refused: ${r.code}`);
  return r.reservation.id;
}
async function inFlight(l: ExposureLedger, n: number, o: Partial<ReserveRequest> = {}) {
  const id = await reserved(l, n, o);
  const i = await l.markIntent(id, T0 + 1);
  if (!i.ok) throw new Error('intent refused');
  return id;
}

describe('Firestore document adapter over the SDK-shaped fake', () => {
  it('writes individual bounded documents in one transaction and reads them back (dates via Timestamp)', async () => {
    const server = new FakeFirestoreServer();
    const docs = docsOn(server);
    const owned = ownedPath('brief', 'brief-handle-000000000001');
    const expiresAt = T0 + 3_600_000;
    await docs.transact(async (tx) => {
      const [before] = await tx.getAll([owned]);
      expect(before).toBeNull();
      tx.create(owned, encodeOwned('brief', { sessionId: SESSION_A, epoch: 1 }, expiresAt, { relationship: 'invented', version: 1 }));
      tx.set({ collection: 'wintr_ledger_service', id: 'svc-probe' }, { probe: 1 });
    });
    expect(server.entries().map(([p]) => p).sort()).toEqual(['wintr_ledger_service/svc-probe', 'wintr_owned/brief_brief-handle-000000000001']);
    // The SDK stores Date as a Timestamp; the adapter reads it back as a Date.
    expect(server.entries('wintr_owned/')[0]![1].expireAt).toBeInstanceOf(FakeTimestamp);
    const back = await docs.get(owned);
    expect(back!.expireAt).toEqual(new Date(expiresAt));
    expect(decodeOwned(back, 'brief', { sessionId: SESSION_A, epoch: 1 }, T0)).toEqual({ relationship: 'invented', version: 1 });
    // Ownership, epoch, kind and server-time expiry are checked on every decode (no existence leak).
    expect(decodeOwned(back, 'brief', { sessionId: SESSION_B, epoch: 1 }, T0)).toBeNull();
    expect(decodeOwned(back, 'brief', { sessionId: SESSION_A, epoch: 2 }, T0)).toBeNull();
    expect(decodeOwned(back, 'plan', { sessionId: SESSION_A, epoch: 1 }, T0)).toBeNull();
    expect(decodeOwned(back, 'brief', { sessionId: SESSION_A, epoch: 1 }, expiresAt)).toBeNull();
    expect(await docs.query('wintr_owned', [{ field: 'sessionId', op: '==', value: SESSION_A }], 10)).toHaveLength(1);
    // Query shapes outside the bounded form are refused before reaching the database.
    for (const filters of [[], [{ field: 'a', op: 'in', value: ['x'] }, { field: 'b', op: 'in', value: ['y'] }], [{ field: 'bad.field', op: '==', value: 'x' }], [{ field: 'a', op: 'in', value: [] }]]) {
      await expect(docs.query('wintr_owned', filters as never, 10)).rejects.toBeInstanceOf(DocStoreError);
    }
    await expect(docs.query('wintr_owned', [{ field: 'a', op: '==', value: 'x' }], 501)).rejects.toBeInstanceOf(DocStoreError);
  });

  it('enforces reads-before-writes, create preconditions, allowlisted paths and bounded plain data', async () => {
    const server = new FakeFirestoreServer();
    const docs = docsOn(server);
    const p = { collection: 'wintr_ledger_service', id: 'svc-probe' } as const;
    await expect(
      docs.transact(async (tx) => {
        tx.set(p, { a: 1 });
        await tx.getAll([p]);
      }),
    ).rejects.toBeInstanceOf(DocStoreError);
    await docs.transact(async (tx) => tx.create(p, { a: 1 }));
    await expect(docs.transact(async (tx) => tx.create(p, { a: 2 }))).rejects.toMatchObject({ code: 6 });
    expect((await docs.get(p))!.a).toBe(1);
    for (const bad of [
      { collection: 'sessions_everything', id: 'x' },
      { collection: 'wintr_owned', id: '../escape' },
      { collection: 'wintr_owned', id: 'a/b' },
      { collection: 'wintr_owned', id: '' },
    ]) {
      await expect(docs.get(bad as never)).rejects.toMatchObject({ code: 'invalid_path' });
    }
    for (const data of [{ n: Number.NaN }, { n: Infinity }, { u: undefined }, { f: () => 1 }, { m: new Map() }, { 'bad.key': 1 }, { big: 'x'.repeat(MAX_DOC_BYTES) }]) {
      await expect(docs.transact(async (tx) => tx.set(p, data as never))).rejects.toBeInstanceOf(DocStoreError);
    }
    // Nothing partial was committed by the refused transactions.
    expect(server.commits).toBe(1);
  });

  it('re-runs a callback on contention and applies its writes exactly once', async () => {
    const server = new FakeFirestoreServer();
    const a = docsOn(server);
    const b = docsOn(server);
    const counter = { collection: 'wintr_ledger_service', id: 'svc-counter' } as const;
    const increment = (docs: DocStore) =>
      docs.transact(async (tx) => {
        const [cur] = await tx.getAll([counter]);
        tx.set(counter, { n: ((cur?.n as number | undefined) ?? 0) + 1 });
      });
    let interleaved = false;
    server.beforeCommit = async () => {
      if (interleaved) return;
      interleaved = true;
      await increment(b); // Another instance commits between A's read and A's commit.
    };
    await increment(a);
    expect((await a.get(counter))!.n).toBe(2);
    expect(server.conflicts).toBe(1);
    expect(server.callbackRuns).toBe(3);
    expect(server.commits).toBe(2);
  });

  it('never constructs the SDK client at import or in tests (type-only SDK use; no default-credential probe)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') || p.endsWith('.tsx')) files.push(p);
      }
    };
    walk(new URL('../src', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
    const loadsSdk = /(?:^\s*import\b[^;]*?from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]@google-cloud\/firestore['"]/m;
    const rel = (f: string) => f.replace(/\\/g, '/').split('/src/')[1];
    const sdkImports = files.filter((f) => loadsSdk.test(readFileSync(f, 'utf8')));
    expect(sdkImports.map(rel).sort()).toEqual(['server/live-runtime.ts', 'server/persistence/firestore-sdk-check.ts']);
    const check = readFileSync(files.find((f) => rel(f) === 'server/persistence/firestore-sdk-check.ts')!, 'utf8');
    expect(check).toMatch(/^import type \{ DocumentReference, Firestore \} from '@google-cloud\/firestore';/m);
    // The only runtime load is one dynamic import in one private helper, reached only from controller-invoked factories.
    const live = readFileSync(files.find((f) => rel(f) === 'server/live-runtime.ts')!, 'utf8');
    expect(live).not.toMatch(/^\s*import\b[^;]*?from\s*['"]@google-cloud\/firestore['"]/m);
    expect(live.match(/import\(\s*'@google-cloud\/firestore'\s*\)/g)).toHaveLength(1);
    expect(files.filter((f) => /new Firestore\(/.test(readFileSync(f, 'utf8'))).map(rel)).toEqual(['server/live-runtime.ts']);
    expect(live.match(/new Firestore\(/g)).toHaveLength(1);
    const helper = live.slice(live.indexOf('async function constructOfficialFirestore'), live.indexOf('export interface ExplicitFirestoreCredentials'));
    expect(helper).toMatch(/await import\('@google-cloud\/firestore'\);\s*return createOwnedFirestoreDocStore\(sdkOwnedFirestoreSatisfiesAdapter\(new Firestore\(settings\)\)\);/);
    // All three factories pass an explicit project/database and one explicit auth
    // source: key credentials, a bounded token, or the approved renewable client.
    expect(live.match(/constructOfficialFirestore\(\{/g)).toHaveLength(3);
    expect(live).toMatch(/constructOfficialFirestore\(\{\s*projectId: settings\.projectId,\s*databaseId: settings\.databaseId,\s*credentials:/);
    expect(live).toMatch(/constructOfficialFirestore\(\{ projectId: settings\.projectId, databaseId: settings\.databaseId, authClient: /);
    expect(live.match(/constructOfficialFirestore\(\{ projectId: settings\.projectId, databaseId: settings\.databaseId, authClient: /g)).toHaveLength(2);
    expect(live).not.toMatch(/keyFilename|keyFile\b|GOOGLE_APPLICATION_CREDENTIALS|process\.env/);
  });
});

describe('exposure policy validation (fail closed)', () => {
  it('accepts a well-formed injected policy and keeps the first-pair counts as a ceiling', () => {
    const p = parseExposurePolicy(policy());
    expect(p.journey.counts).toEqual({ qloo: 6, gemini: 4 });
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('allows only an explicit shared-chat session to use the service allowance across Journeys', async () => {
    const raw = policy({ sessionMode: 'shared_chats', session: { capUnits: 5_000, counts: { qloo: 12, gemini: 5 } } });
    expect(parseExposurePolicy(raw).session.counts.gemini).toBe(5);
    const server = new FakeFirestoreServer(), a = instance(server, raw), b = instance(server, raw);
    // The original per-Journey ceiling still refuses a fifth Gemini call.
    for (let i = 1; i <= 4; i++) {
      const id = await inFlight(a, i);
      expect(await a.markUnknown(id, 'timeout', T0 + 2)).toMatchObject({ ok: true });
    }
    expect(await b.reserve(req(5))).toEqual({ ok: false, code: 'capacity_journey_count' });
    const id = await inFlight(b, 6, { journeyId: JOURNEY_B });
    expect(await b.markUnknown(id, 'timeout', T0 + 2)).toMatchObject({ ok: true });
    expect(await a.reserve(req(7, { journeyId: 'journey-handle-c-000003' }))).toEqual({ ok: false, code: 'capacity_session_count' });
    expect(await instance(server, raw).totals()).toMatchObject({ counts: { gemini: 5 }, unitsHeld: 2_500, active: 0, unresolved: 5 });
  });

  it('keeps the service ceiling across shared-chat sessions and recreated clients', async () => {
    const raw = policy({ sessionMode: 'shared_chats', service: { capUnits: 10_000, counts: { qloo: 10, gemini: 1 }, concurrency: 2 }, session: { capUnits: 5_000, counts: { qloo: 10, gemini: 1 } } });
    const server = new FakeFirestoreServer(), a = instance(server, raw);
    const id = await inFlight(a, 1);
    await a.markUnknown(id, 'timeout', T0 + 2);
    expect(await instance(server, raw).reserve(req(2, { sessionId: SESSION_B, journeyId: JOURNEY_B }))).toEqual({ ok: false, code: 'capacity_service_count' });
    expect(await a.totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 500, unresolved: 1 });
  });

  it('rejects malformed shared-chat mode or bounds without invoking accessors or touching the store', async () => {
    let reads = 0;
    const bad = [
      policy({ sessionMode: 'anything' }),
      policy({ sessionMode: undefined }),
      policy({ sessionMode: 'shared_chats', session: { capUnits: 10_001, counts: { qloo: 6, gemini: 4 } } }),
      policy({ sessionMode: 'shared_chats', session: { capUnits: 5_000, counts: { qloo: 101, gemini: 4 } } }),
      policy({ sessionMode: 'shared_chats', journey: { capUnits: 5_000, counts: { qloo: 7, gemini: 4 } } }),
      Object.defineProperty(policy(), 'sessionMode', { enumerable: true, get() { reads++; return 'shared_chats'; } }),
      Object.defineProperty(policy(), 'sessionMode', { value: 'shared_chats' }),
    ];
    for (const raw of bad) {
      expect(() => parseExposurePolicy(raw)).toThrow(PolicyError);
      const server = new FakeFirestoreServer();
      expect(await instance(server, raw).reserve(req(1))).toEqual({ ok: false, code: 'policy_invalid' });
      expect(server.log).toHaveLength(0);
    }
    expect(reads).toBe(0);
  });

  it.each([
    ['missing field', (p: Record<string, unknown>) => delete p.journey],
    ['extra field', (p: Record<string, unknown>) => (p.discount = 1)],
    ['negative reservation', (p: any) => (p.reservations.qloo_search.units = -1)],
    ['zero reservation', (p: any) => (p.reservations.qloo_search.units = 0)],
    ['fractional money', (p: any) => (p.reservations.catalogue_generation.units = 500.5)],
    ['NaN money', (p: any) => (p.service.capUnits = Number.NaN)],
    ['infinite money', (p: any) => (p.service.capUnits = Infinity)],
    ['overflowing money', (p: any) => (p.service.capUnits = Number.MAX_SAFE_INTEGER + 2)],
    ['string money', (p: any) => (p.session.capUnits = '5000')],
    ['negative count', (p: any) => (p.service.counts.qloo = -1)],
    ['fractional count', (p: any) => (p.service.counts.gemini = 1.5)],
    ['journey above first-pair Qloo', (p: any) => (p.journey.counts.qloo = 7)],
    ['session above first-pair Gemini', (p: any) => (p.session.counts.gemini = 5)],
    ['zero concurrency', (p: any) => (p.service.concurrency = 0)],
    ['malformed currency', (p: any) => (p.currency = 'usd')],
    ['unknown stage', (p: any) => (p.reservations.hidden_repair = { units: 1, bound: 'enforceable' })],
    ['unknown bound kind', (p: any) => (p.reservations.qloo_search.bound = 'guaranteed')],
    ['reservation above the narrowest cap', (p: any) => (p.reservations.catalogue_generation.units = 5_001)],
  ])('rejects %s', async (_label, mutate) => {
    const raw = structuredClone(policy()) as Record<string, unknown>;
    mutate(raw);
    expect(() => parseExposurePolicy(raw)).toThrow(PolicyError);
    const server = new FakeFirestoreServer();
    expect(await instance(server, raw).reserve(req(1))).toEqual({ ok: false, code: 'policy_invalid' });
    expect(server.log).toHaveLength(0);
  });

  it('refuses admission with a missing or expired policy, without writing', async () => {
    const server = new FakeFirestoreServer();
    expect(await instance(server, null).reserve(req(1))).toEqual({ ok: false, code: 'policy_missing' });
    expect(await createExposureLedger({ docs: docsOn(server), policy: undefined, serviceId: SERVICE }).reserve(req(1))).toEqual({ ok: false, code: 'policy_missing' });
    expect(await instance(server).reserve(req(1, { now: T0 + 3_600_000 }))).toEqual({ ok: false, code: 'policy_expired' });
    expect(server.log).toHaveLength(0);
  });
});

describe('dispatch reservation lifecycle', () => {
  it('reserve -> durable intent -> settle from a typed receipt; replay is idempotent and conflicting reuse is refused', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    const first = await l.reserve(req(1));
    expect(first).toMatchObject({ ok: true, replay: false, reservation: { state: 'reserved', provider: 'gemini', units: 500, bound: 'estimate_with_residual', policyVersion: 'synthetic-policy-1' } });
    const id = first.ok ? first.reservation.id : '';
    // Exact replay never allocates twice.
    expect(await l.reserve(req(1))).toMatchObject({ ok: true, replay: true, reservation: { id } });
    expect(await l.totals()).toEqual({ currency: 'XTS', counts: { qloo: 0, gemini: 1 }, unitsHeld: 500, active: 1, unresolved: 1 });
    // Same key, different stage / scope / attempt: refused.
    expect(await l.reserve(req(1, { stage: 'qloo_search' }))).toEqual({ ok: false, code: 'conflict' });
    expect(await l.reserve(req(1, { journeyId: JOURNEY_B }))).toEqual({ ok: false, code: 'conflict' });
    expect(await l.reserve(req(1, { attemptId: 'attempt-handle-0000002' }))).toEqual({ ok: false, code: 'conflict' });

    expect(await l.markIntent(id, T0 + 1)).toMatchObject({ ok: true, grant: 'send', reservation: { state: 'intent', intentAt: T0 + 1 } });
    // A repeated intent observes possibly-sent work; it is never a second send grant.
    expect(await l.markIntent(id, T0 + 2)).toMatchObject({ ok: false, code: 'intent_exists', reservation: { intentAt: T0 + 1 } });
    const settled = await l.settle(id, receipt(420), T0 + 10);
    expect(settled).toMatchObject({ ok: true, reservation: { state: 'settled', settlement: { kind: 'provider_usage', units: 420, overrunUnits: 0 } } });
    expect(await l.totals()).toEqual({ currency: 'XTS', counts: { qloo: 0, gemini: 1 }, unitsHeld: 420, active: 0, unresolved: 0 });
    expect(await l.settle(id, receipt(420), T0 + 11)).toMatchObject({ ok: true, replay: true });
    expect(await l.settle(id, receipt(1), T0 + 11)).toEqual({ ok: false, code: 'conflict' });
    expect(await l.withdraw(id, { kind: 'intent_never_recorded' }, T0 + 12)).toEqual({ ok: false, code: 'invalid_state' });
  });

  it('timeouts, failures, cancellation and unusable output are never refunds: unknown work stays held', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    const reasons = ['timeout', 'failed', 'cancelled', 'output_unusable', 'transport_returned_without_receipt'] as const;
    const ids: string[] = [];
    for (const [i, reason] of reasons.entries()) {
      const id = await inFlight(l, i + 1, { stage: 'qloo_search' });
      expect(await l.markUnknown(id, reason, T0 + 2)).toMatchObject({ ok: true, reservation: { state: 'unknown', unknownReason: reason } });
      ids.push(id);
    }
    // Counts and money stay held; only the in-flight slot is released.
    expect(await l.totals()).toEqual({ currency: 'XTS', counts: { qloo: 5, gemini: 0 }, unitsHeld: 50, active: 0, unresolved: 5 });
    expect(await l.markUnknown(ids[0]!, 'timeout', T0 + 3)).toMatchObject({ ok: true, replay: true });
    expect(await l.withdraw(ids[0]!, { kind: 'intent_never_recorded' }, T0 + 3)).toEqual({ ok: false, code: 'invalid_state' });
    // The Journey cap still counts held unknown work: one more Qloo submission, then refused.
    await reserved(l, 50, { stage: 'qloo_artist_insights' });
    expect(await l.reserve(req(51, { stage: 'qloo_tag_insights' }))).toEqual({ ok: false, code: 'capacity_session_count' });
    // Only a typed receipt resolves it; an overrun is recorded, not hidden.
    expect(await l.settle(ids[0]!, receipt(25, { kind: 'controller_reconciliation', reference: 'reconcile-2026-10-25-01' }), T0 + 9)).toMatchObject({
      ok: true,
      reservation: { state: 'settled', settlement: { units: 25, overrunUnits: 15 } },
    });
    expect((await l.totals())!.unitsHeld).toBe(50 + 10 + 15);
  });

  it('withdraws only a reservation whose intent was never recorded, with explicit proof', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    const id = await reserved(l, 1);
    expect(await l.withdraw(id, {}, T0 + 1)).toEqual({ ok: false, code: 'invalid_state' });
    expect(await l.withdraw(id, { kind: 'trust_me' }, T0 + 1)).toEqual({ ok: false, code: 'invalid_state' });
    expect(await l.settle(id, receipt(0), T0 + 1)).toEqual({ ok: false, code: 'invalid_state' });
    expect(await l.withdraw(id, { kind: 'intent_never_recorded' }, T0 + 1)).toMatchObject({ ok: true, reservation: { state: 'withdrawn' } });
    expect(await l.withdraw(id, { kind: 'intent_never_recorded' }, T0 + 2)).toMatchObject({ ok: true, replay: true });
    expect(await l.markIntent(id, T0 + 3)).toEqual({ ok: false, code: 'invalid_state' });
    expect(await l.totals()).toEqual({ currency: 'XTS', counts: { qloo: 0, gemini: 0 }, unitsHeld: 0, active: 0, unresolved: 0 });
    const after = await inFlight(l, 2);
    expect(await l.withdraw(after, { kind: 'intent_never_recorded' }, T0 + 4)).toEqual({ ok: false, code: 'invalid_state' });
  });

  it('rejects malformed receipts and inputs without changing state', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    const id = await inFlight(l, 1);
    const before = server.log.length;
    for (const bad of [
      receipt(-1),
      receipt(1.5),
      receipt(Number.MAX_SAFE_INTEGER + 1),
      receipt(Number.NaN),
      { ...receipt(1), units: '1' },
      receipt(1, { currency: 'EUR' }),
      receipt(1, { kind: 'browser_claim' }),
      receipt(1, { reference: 'has spaces' }),
      { ...receipt(1), extra: true },
      null,
      'receipt',
    ]) {
      const r = await l.settle(id, bad, T0 + 2);
      expect(r).toEqual({ ok: false, code: 'invalid_receipt' });
    }
    // No document was written by any refused settlement.
    expect(server.log.length).toBe(before);
    expect((await l.read(id))!.state).toBe('intent');
    for (const bad of [req(2, { reservationKey: 'short' }), req(2, { stage: 'hidden_repair' as never }), req(2, { now: -1 }), req(2, { now: 1.5 }), req(2, { sessionId: 'x' })]) {
      expect(await l.reserve(bad)).toEqual({ ok: false, code: 'invalid_input' });
    }
    expect(await l.markIntent('not-a-reservation-id', T0)).toEqual({ ok: false, code: 'invalid_input' });
    expect(await l.markUnknown(id, 'refund_please' as never, T0)).toEqual({ ok: false, code: 'invalid_input' });
    expect(await l.markIntent(`r_${'0'.repeat(48)}`, T0)).toEqual({ ok: false, code: 'not_found' });
  });
});

describe('cross-instance admission over one shared store', () => {
  it('racing final-slot admissions from two instances admit exactly one (callback re-run, no duplicate effect)', async () => {
    const server = new FakeFirestoreServer();
    const p = policy({ service: { capUnits: 10_000, concurrency: 4, counts: { qloo: 100, gemini: 1 } } });
    const a = instance(server, p);
    const b = instance(server, p);
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    server.beforeCommit = async (attempt) => {
      if (attempt !== 1) return;
      arrived += 1;
      if (arrived === 2) release();
      await both; // Both callbacks have read the same pre-state before either commits.
    };
    const [ra, rb] = await Promise.all([a.reserve(req(1)), b.reserve(req(2, { sessionId: SESSION_B, journeyId: JOURNEY_B }))]);
    const results = [ra, rb];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.code)).toEqual(['capacity_service_count']);
    expect(server.conflicts).toBe(1);
    expect(await a.totals()).toMatchObject({ counts: { qloo: 0, gemini: 1 }, unitsHeld: 500, active: 1 });
    expect(server.entries('wintr_ledger_reservations/')).toHaveLength(1);
  });

  it('enforces the shared session/Journey count cap across instances under contention', async () => {
    const server = new FakeFirestoreServer();
    const p = policy({ service: { capUnits: 10_000, concurrency: 50, counts: { qloo: 100, gemini: 100 } } });
    const [a, b, c] = [instance(server, p, 10), instance(server, p, 10), instance(server, p, 10)];
    // Ten concurrent Gemini reservations for one session/Journey from three instances: four are allowed.
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => [a, b, c][i % 3]!.reserve(req(i + 1, { stage: 'reference_analysis' }))));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(new Set(results.flatMap((r) => (r.ok ? [] : [r.code])))).toEqual(new Set(['capacity_session_count']));
    const t = await a.totals();
    expect(t).toMatchObject({ counts: { gemini: 4 }, unitsHeld: 1_200 });
    // Aggregates equal the sum of the individual reservation records.
    const recs = server.entries('wintr_ledger_reservations/').map(([, d]) => d);
    expect(recs).toHaveLength(4);
    expect(recs.reduce((n, d) => n + (d.units as number), 0)).toBe(t!.unitsHeld);
  });

  it('enforces service concurrency and monetary cap across sessions and new instances', async () => {
    const server = new FakeFirestoreServer();
    const p = policy({ service: { capUnits: 1_000, concurrency: 2, counts: { qloo: 100, gemini: 100 } } });
    const a = instance(server, p);
    const id1 = await inFlight(a, 1);
    await inFlight(instance(server, p), 2, { sessionId: SESSION_B, journeyId: JOURNEY_B });
    expect(await instance(server, p).reserve(req(3, { stage: 'qloo_search', sessionId: 'session-handle-c-000003', journeyId: 'journey-handle-c-000003' }))).toEqual({
      ok: false,
      code: 'concurrency',
    });
    // Settling frees the slot but the actual spend stays against the service cap.
    await a.settle(id1, receipt(450), T0 + 5);
    expect(await a.reserve(req(4, { sessionId: 'session-handle-c-000003', journeyId: 'journey-handle-c-000003' }))).toEqual({ ok: false, code: 'capacity_service_units' });
    expect(await a.reserve(req(5, { stage: 'qloo_search', sessionId: 'session-handle-c-000003', journeyId: 'journey-handle-c-000003' }))).toMatchObject({ ok: true });
  });

  it('a commit whose response is lost is not allocated twice when the caller retries', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    server.faults.push('ack_lost');
    expect(await l.reserve(req(1))).toEqual({ ok: false, code: 'store_unavailable' });
    const retry = await l.reserve(req(1));
    expect(retry).toMatchObject({ ok: true, replay: true, reservation: { state: 'reserved' } });
    expect(await l.totals()).toMatchObject({ counts: { gemini: 1 }, unitsHeld: 500, active: 1, unresolved: 1 });
    expect(server.entries('wintr_ledger_reservations/')).toHaveLength(1);
  });
});

describe('crash, restart, Clear, expiry and TTL never reset unresolved exposure', () => {
  it('a crash after intent stays held across instances, Clear, session expiry, TTL and new sessions until reconciled', async () => {
    const server = new FakeFirestoreServer();
    const p = policy({ service: { capUnits: 10_000, concurrency: 1, counts: { qloo: 100, gemini: 100 } } });
    const docsA = docsOn(server);
    const a = createExposureLedger({ docs: docsA, policy: p, serviceId: SERVICE });
    // Listener-owned content for session A (with the TTL field), and an in-flight dispatch.
    await docsA.transact(async (tx) => {
      tx.set(ownedPath('session', SESSION_A), encodeOwned('session', { sessionId: SESSION_A, epoch: 1 }, T0 + 3_600_000, { revoked: false }));
      tx.set(ownedPath('brief', 'brief-handle-000000000001'), encodeOwned('brief', { sessionId: SESSION_A, epoch: 1 }, T0 + 3_600_000, { relationship: 'invented' }));
    });
    const id = await inFlight(a, 1);
    // Process A crashes here: no unknown/settle is ever recorded by it.

    // A different instance after restart sees the held intent and cannot reuse its slot.
    const b = instance(server, p);
    expect(await b.read(id)).toMatchObject({ state: 'intent', units: 500 });
    expect((await b.unresolved(10)).map((r) => [r.id, r.state])).toEqual([[id, 'intent']]);
    expect(await b.reserve(req(2, { sessionId: SESSION_B, journeyId: JOURNEY_B }))).toEqual({ ok: false, code: 'concurrency' });

    // Clear deletes listener-owned records; expiry passes; TTL sweeps. None of it touches the ledger.
    const docsB = docsOn(server);
    const ownedIds = (await docsB.query('wintr_owned', [{ field: 'sessionId', op: '==', value: SESSION_A }], 64)).map((r) => r.id);
    await docsB.transact(async (tx) => {
      for (const oid of ownedIds) tx.delete({ collection: 'wintr_owned', id: oid });
    });
    const swept = server.sweepTtl(T0 + 7_200_000);
    expect(swept.every((path) => path.startsWith('wintr_owned/'))).toBe(true);
    expect(server.entries('wintr_owned/')).toHaveLength(0);
    for (const [path, data] of server.entries('wintr_ledger_')) {
      expect(LEDGER_COLLECTIONS.some((c) => path.startsWith(`${c}/`))).toBe(true);
      expect(data).not.toHaveProperty('expireAt');
    }
    expect(await b.totals()).toEqual({ currency: 'XTS', counts: { qloo: 0, gemini: 1 }, unitsHeld: 500, active: 1, unresolved: 1 });

    // An explicit controller reconciliation (not automatic) releases only the slot; money stays held.
    expect(await b.markUnknown(id, 'abandoned_after_restart', T0 + 7_200_001)).toMatchObject({ ok: true, reservation: { state: 'unknown' } });
    // A brand-new session starts with a fresh session scope but inherits the service exposure.
    const fresh = await b.reserve(req(3, { sessionId: SESSION_B, journeyId: JOURNEY_B, now: T0 + 7_200_002 }));
    expect(fresh).toEqual({ ok: false, code: 'policy_expired' });
    const renewed = instance(server, { ...p, version: 'synthetic-policy-2', expiresAt: T0 + 10_000_000 });
    expect(await renewed.reserve(req(3, { sessionId: SESSION_B, journeyId: JOURNEY_B, now: T0 + 7_200_002 }))).toMatchObject({ ok: true, reservation: { policyVersion: 'synthetic-policy-2' } });
    expect(await renewed.totals()).toMatchObject({ counts: { gemini: 2 }, unitsHeld: 1_000, unresolved: 2 });
    // The crashed dispatch is only resolved by a typed receipt.
    expect(await renewed.settle(id, receipt(480, { kind: 'controller_reconciliation', reference: 'reconcile-synthetic-0001' }), T0 + 7_300_000)).toMatchObject({
      ok: true,
      reservation: { state: 'settled' },
    });
    expect(await renewed.totals()).toMatchObject({ unitsHeld: 980, unresolved: 1 });
  });

  it('ledger records hold only opaque hashes, codes, integers and timestamps (no listener content or keys)', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    const id = await inFlight(l, 1);
    await l.settle(id, receipt(400), T0 + 3);
    const dump = JSON.stringify(server.entries('wintr_ledger_'));
    for (const raw of [SESSION_A, JOURNEY_A, ATTEMPT, key(1)]) expect(dump).not.toContain(raw);
    const [, rec] = server.entries('wintr_ledger_reservations/')[0]!;
    expect(Object.keys(rec).sort()).toEqual(
      [
        'attemptRef', 'bound', 'createdAt', 'currency', 'inputHash', 'intentAt', 'journeyScope', 'kind', 'observation', 'policyVersion', 'provider', 'resolvedAt',
        'schema', 'service', 'sessionScope', 'settlement', 'stage', 'state', 'units', 'unknownReason', 'withdrawal',
      ].sort(),
    );
  });
});

describe('F1 corrections: intent boundary, service ownership, reconciliation limit, intent replay', () => {
  const SERVICE_B = 'svc-synthetic-b';
  /** An explicitly passed `undefined` policy stays undefined (no default substitution). */
  const onService = (server: FakeFirestoreServer, serviceId: string, ...p: [unknown?]) =>
    createExposureLedger({ docs: docsOn(server), policy: p.length > 0 ? p[0] : policy(), serviceId });

  it('new durable intent requires a valid, compatible, unexpired policy; reconciliation still works after expiry', async () => {
    const server = new FakeFirestoreServer();
    const short = policy({ expiresAt: T0 + 1_000 });
    const a = onService(server, SERVICE, short);
    const first = await reserved(a, 1, { now: T0 + 999 });
    const second = await reserved(a, 2, { now: T0 + 999, stage: 'qloo_search' });
    const third = await reserved(a, 3, { now: T0 + 999, stage: 'qloo_search' });
    const held = await reserved(a, 4, { now: T0 + 999, stage: 'qloo_search' });
    expect((await a.markIntent(held, T0 + 999)).ok).toBe(true);
    const writes = server.log.length;

    // Expired at the intent boundary: no new dispatch intent.
    expect(await a.markIntent(first, T0 + 1_001)).toEqual({ ok: false, code: 'policy_expired' });
    // The same service recreated over the same documents with a missing / malformed / rotated / other-currency policy.
    expect(await onService(server, SERVICE, undefined).markIntent(second, T0 + 500)).toEqual({ ok: false, code: 'policy_missing' });
    expect(await onService(server, SERVICE, { ...short, currency: 'usd' }).markIntent(second, T0 + 500)).toEqual({ ok: false, code: 'policy_invalid' });
    expect(await onService(server, SERVICE, { ...short, version: 'synthetic-policy-rotated' }).markIntent(second, T0 + 500)).toEqual({ ok: false, code: 'policy_mismatch' });
    expect(await onService(server, SERVICE, { ...short, currency: 'XXX' }).markIntent(third, T0 + 500)).toEqual({ ok: false, code: 'policy_mismatch' });
    expect(server.log.length).toBe(writes);
    for (const id of [first, second, third]) expect((await a.read(id))!.state).toBe('reserved');
    // Positive control: the compatible, unexpired policy grants intent.
    expect(await a.markIntent(third, T0 + 998)).toMatchObject({ ok: true, grant: 'send' });

    // After expiry, without any policy: read, withdrawal of never-sent work, unknown and known settlement still work.
    const reconcile = onService(server, SERVICE, undefined);
    expect(await reconcile.read(held)).toMatchObject({ state: 'intent' });
    expect(await reconcile.withdraw(first, { kind: 'intent_never_recorded' }, T0 + 2_000)).toMatchObject({ ok: true, reservation: { state: 'withdrawn' } });
    expect(await reconcile.markUnknown(held, 'timeout', T0 + 2_000)).toMatchObject({ ok: true, reservation: { state: 'unknown' } });
    expect(await reconcile.settle(held, receipt(7), T0 + 2_001)).toMatchObject({ ok: true, reservation: { state: 'settled' } });
    expect(await reconcile.totals()).toMatchObject({ unitsHeld: 10 + 10 + 7 });
  });

  it('enforces service ownership on every path, with and without aggregates; same-service instances still share', async () => {
    const server = new FakeFirestoreServer();
    const a = onService(server, SERVICE);
    const b = onService(server, SERVICE_B);
    const aId = await reserved(a, 1);
    const aIntent = await reserved(a, 2, { stage: 'qloo_search' });
    expect((await a.markIntent(aIntent, T0 + 1)).ok).toBe(true);
    const before = server.log.length;
    // A foreign service sees nothing and changes nothing.
    expect(await b.read(aId)).toBeNull();
    expect(await b.markIntent(aId, T0 + 2)).toEqual({ ok: false, code: 'not_found' });
    expect(await b.withdraw(aId, { kind: 'intent_never_recorded' }, T0 + 2)).toEqual({ ok: false, code: 'not_found' });
    expect(await b.markUnknown(aIntent, 'timeout', T0 + 2)).toEqual({ ok: false, code: 'not_found' });
    expect(await b.settle(aIntent, receipt(1), T0 + 2)).toEqual({ ok: false, code: 'not_found' });
    expect(await b.unresolved(10)).toEqual([]);
    expect(await b.totals()).toBeNull();
    expect(server.log.length).toBe(before);
    expect((await a.read(aId))!.state).toBe('reserved');
    // Positive control: another instance of the SAME service may act on it.
    expect(await onService(server, SERVICE).markIntent(aId, T0 + 3)).toMatchObject({ ok: true, grant: 'send' });
  });

  it('restricts reconciliation queries to the service before applying the limit', async () => {
    const server = new FakeFirestoreServer();
    const a = onService(server, SERVICE);
    const b = onService(server, SERVICE_B);
    const aIds = [await reserved(a, 1, { stage: 'qloo_search' }), await reserved(a, 2, { stage: 'qloo_search' }), await reserved(a, 3, { stage: 'qloo_search' })];
    const bId = await reserved(b, 4, { stage: 'qloo_search' });
    expect((await b.unresolved(1)).map((r) => r.id)).toEqual([bId]);
    const aFirstTwo = await a.unresolved(2);
    expect(aFirstTwo).toHaveLength(2);
    expect(aFirstTwo.every((r) => aIds.includes(r.id))).toBe(true);
    // The restriction is part of the bounded database query itself (equality on service, `in` on state, then limit).
    expect(server.queries.at(-2)).toEqual({
      collection: 'wintr_ledger_reservations',
      filters: [
        { field: 'service', op: '==', value: SERVICE_B },
        { field: 'state', op: 'in', value: ['reserved', 'intent', 'unknown'] },
      ],
      limit: 1,
    });
  });

  it('a repeated or racing intent is an observation, never a second send grant', async () => {
    const server = new FakeFirestoreServer();
    const a = onService(server, SERVICE);
    const b = onService(server, SERVICE);
    const id = await reserved(a, 1);
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    server.beforeCommit = async (attempt) => {
      if (attempt !== 1) return;
      arrived += 1;
      if (arrived === 2) release();
      await both;
    };
    const results = await Promise.all([a.markIntent(id, T0 + 1), b.markIntent(id, T0 + 1)]);
    server.beforeCommit = null;
    expect(results.filter((r) => r.ok && r.grant === 'send')).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: 'intent_exists', reservation: { id, state: 'intent' } });
    // Sequential repeat: observation only.
    expect(await a.markIntent(id, T0 + 2)).toMatchObject({ ok: false, code: 'intent_exists' });

    // Acknowledgement lost after the intent commit: no grant now, and the retry is an observation, not a grant.
    const lost = await reserved(a, 2, { stage: 'qloo_search' });
    server.faults.push('ack_lost');
    expect(await a.markIntent(lost, T0 + 3)).toEqual({ ok: false, code: 'store_unavailable' });
    expect(await a.markIntent(lost, T0 + 4)).toMatchObject({ ok: false, code: 'intent_exists', reservation: { state: 'intent', intentAt: T0 + 3 } });
    // Intent is durable, so the work cannot be proven unsent: it can only be held as unknown and reconciled.
    expect(await a.withdraw(lost, { kind: 'intent_never_recorded' }, T0 + 5)).toEqual({ ok: false, code: 'invalid_state' });
    expect(await a.markUnknown(lost, 'transport_returned_without_receipt', T0 + 5)).toMatchObject({ ok: true, reservation: { state: 'unknown' } });
  });
});

describe('store failure and corruption fail closed', () => {
  it('an unavailable store refuses admission and intent; a reservation without durable intent can be withdrawn', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    server.faults.push('unavailable');
    expect(await l.reserve(req(1))).toEqual({ ok: false, code: 'store_unavailable' });
    expect(server.entries('wintr_ledger_')).toHaveLength(0);
    const id = await reserved(l, 2);
    server.faults.push('unavailable');
    // Intent did not commit: the caller must not invoke the adapter.
    expect(await l.markIntent(id, T0 + 1)).toEqual({ ok: false, code: 'store_unavailable' });
    expect((await l.read(id))!.state).toBe('reserved');
    expect(await l.withdraw(id, { kind: 'intent_never_recorded' }, T0 + 2)).toMatchObject({ ok: true, reservation: { state: 'withdrawn' } });
  });

  it('malformed stored aggregates or overflowing arithmetic refuse admission', async () => {
    const corrupt = new FakeFirestoreServer();
    corrupt.seed(`wintr_ledger_service/${SERVICE}`, { schema: 1, kind: 'service', currency: 'XTS', counts: { qloo: 0, gemini: 0 }, unitsHeld: -5, active: 0, unresolved: 0, updatedAt: T0 });
    expect(await instance(corrupt).reserve(req(1))).toEqual({ ok: false, code: 'store_corrupt' });
    corrupt.seed(`wintr_ledger_service/${SERVICE}`, { schema: 1, kind: 'service', currency: 'XTS', counts: { qloo: '0', gemini: 0 }, unitsHeld: 0, active: 0, unresolved: 0, updatedAt: T0 });
    expect(await instance(corrupt).reserve(req(1))).toEqual({ ok: false, code: 'store_corrupt' });
    expect(corrupt.entries('wintr_ledger_reservations/')).toHaveLength(0);

    const mismatched = new FakeFirestoreServer();
    mismatched.seed(`wintr_ledger_service/${SERVICE}`, { schema: 1, kind: 'service', currency: 'EUR', counts: { qloo: 0, gemini: 0 }, unitsHeld: 0, active: 0, unresolved: 0, updatedAt: T0 });
    expect(await instance(mismatched).reserve(req(1))).toEqual({ ok: false, code: 'policy_mismatch' });

    const huge = new FakeFirestoreServer();
    const big = policy({
      service: { capUnits: Number.MAX_SAFE_INTEGER, concurrency: 4, counts: { qloo: 100, gemini: 100 } },
      session: { capUnits: Number.MAX_SAFE_INTEGER, counts: { qloo: 6, gemini: 4 } },
      journey: { capUnits: Number.MAX_SAFE_INTEGER, counts: { qloo: 6, gemini: 4 } },
    });
    huge.seed(`wintr_ledger_service/${SERVICE}`, {
      schema: 1, kind: 'service', currency: 'XTS', counts: { qloo: 0, gemini: 0 }, unitsHeld: Number.MAX_SAFE_INTEGER - 1, active: 0, unresolved: 0, updatedAt: T0,
    });
    expect(await instance(huge, big).reserve(req(1))).toEqual({ ok: false, code: 'overflow' });
    expect(huge.entries('wintr_ledger_reservations/')).toHaveLength(0);
  });

  it('a reservation record edited into an inconsistent state is refused, not trusted', async () => {
    const server = new FakeFirestoreServer();
    const l = instance(server);
    const id = await inFlight(l, 1);
    const [path, data] = server.entries('wintr_ledger_reservations/')[0]!;
    server.seed(path, { ...data, state: 'settled' }); // claims settlement without a receipt
    expect(await l.settle(id, receipt(1), T0 + 2)).toEqual({ ok: false, code: 'store_corrupt' });
    expect(await l.markUnknown(id, 'timeout', T0 + 2)).toEqual({ ok: false, code: 'store_corrupt' });
  });
});
