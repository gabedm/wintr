import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { parsePersonalProfile } from '../src/server/personal-profile.js';
import { composePersonalRuntime } from '../src/server/personal-runtime.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { transports } from './fixtures/live-fixtures.js';

// Consumer API over the actual personal composition and shared Store. Every
// account, provider response and source below is invented; no external request.
it.each([80, 4])('several chats share one expiry and the approved cumulative %i-call budget', async gemini => {
  const time = 1_800_000_000_000, baseline = { currency: 'GBP', counts: { qloo: 8, gemini: 7 }, unitsHeld: 600, active: 0, unresolved: 15 };
  const p = parsePersonalProfile({ schema: 1, profileId: 'a'.repeat(32), approved: true, approvalId: 'call_invented_multichat', approvedAt: time - 1000, authority: 'until_revoked', enabled: true,
    projectId: 'invented-project', quotaProjectId: 'invented-project', geminiProjectId: 'invented-gemini', databaseId: 'invented-db', runtimeServiceAccount: 'wintr-runtime@invented-project.iam.gserviceaccount.com',
    serviceId: 'svc-invented-multichat', serviceIdentity: 'runtime-invented', settlementOwner: 'owner-invented', port: 4876, baseline,
    allowance: { gbpMinor: 10000, qloo: 120, gemini }, deniedVideoIds: [], deniedRecordedDigests: [], recordedMusicApprovalId: null }, time);
  const db = new FakeFirestoreServer(), net = transports();
  db.seed('wintr_ledger_service/' + p.serviceId, { schema: 1, kind: 'service', ...baseline, updatedAt: time - 10 });
  const google = { client: {} as any, accessToken: async () => new ServerSecret('invented-access-token'), close() {} };
  const { runtime } = await composePersonalRuntime({ profile: p, checkAuthority() {}, google,
    secret: async ref => new ServerSecret(ref === 'personal/sealing' ? 'invented-sealing-material-00000000001' : 'invented-provider-secret'),
    recordAccounting() {}, firestore: () => new FakeFirestore(db), network: net.network, clock: () => time });
  const server = createServer((req, res) => void runtime.handler(req, res));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const send = (path: string, value: unknown, cookie?: string) => new Promise<{ status: number; cookie?: string; body: any }>((done, fail) => {
    const body = JSON.stringify(value), req = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method: 'POST',
      headers: { host: runtime.config.hostHeader, origin: runtime.config.origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...(cookie ? { cookie } : {}) } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk); res.on('end', () => done({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], body: JSON.parse(data) }));
    }); req.on('error', fail); req.end(body);
  });
  try {
    const session = await send('/api/session', {}); expect(session.status).toBe(201);
    const expiry = session.body.session.expiresAt; let first = '', last: any;
    for (let i = 0; i < 5; i++) {
      const chat = await send('/api/chats', { kind: 'create', actionKey: randomUUID() }, session.cookie);
      expect(chat.status).toBe(201); expect(chat.body.session.expiresAt).toBe(expiry);
      const handle = chat.body.chats.current; if (!i) first = handle;
      const ref = await send('/api/reference?chat=' + handle, { url: 'https://youtu.be/invRefAAA01', actionKey: randomUUID() }, session.cookie);
      if (i < gemini) { expect(ref.status).toBe(200); expect(ref.body.analysis.synthetic).toBe(false); expect(ref.body.session.expiresAt).toBe(expiry); last = ref.body; }
      // Admission succeeded, but the terminal Attempt reports a budget refusal.
      // It must not invoke the provider or spend another reservation.
      else expect(ref).toMatchObject({ status: 200, body: { code: 'capacity', analysis: null, stage: 'failed' } });
    }
    const used = Math.min(5, gemini), held = await runtime.store.reconciliation().totals();
    expect(net.reference).toHaveLength(used);
    expect(held).toEqual({ ...baseline, counts: { qloo: 8, gemini: 7 + used }, unitsHeld: 600 + 119 * used, unresolved: 15 + used });
    const firstItem = last.chats.items.find((row: any) => row.handle === first);
    expect((await send('/api/chats', { kind: 'delete', chat: first, expectedRevision: firstItem.revision, actionKey: randomUUID() }, session.cookie)).status).toBe(200);
    expect(await runtime.store.reconciliation().totals()).toEqual(held);
    expect(net.reference).toHaveLength(used);
  } finally { await runtime.close(); await new Promise<void>(done => server.close(() => done())); }
});
