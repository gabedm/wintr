import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePcmWav, RECORDING } from '../src/shared/recording.js';
import type { RecordedReference, SafeSnapshot } from '../src/shared/records.js';
import { createApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { runReferenceStage } from '../src/server/harness.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { validRecord } from '../src/server/persistence/record-schema.js';
import { buildReferenceRequestBody } from '../src/server/providers/gemini-reference.js';
import { createGeminiCloudReferenceAdapter, type CloudReferenceToken } from '../src/server/providers/gemini-cloud-reference.js';
import { createSyntheticReferenceAdapter, type ReferenceAdapter } from '../src/server/reference.js';
import { parseSourcePolicy } from '../src/server/source-policy.js';
import { MemoryStore, type Store } from '../src/server/store.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';
import { cloudBinding, cloudResponse, cloudToken, deferred, prepared, CLOUD_INPUT } from './fixtures/cloud-reference-fixtures.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { policy } from './fixtures/live-fixtures.js';
import { createHttpFixture } from './fixtures/http-lifecycle.js';

// Invented zero PCM and fake stores/transports only. No microphone or external service.
const bytes = () => encodePcmWav(new Float32Array(RECORDING.minFrames));
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const sha = digest(bytes());
const cfg = loadConfig(['--mode=synthetic'], {});
const key = (n: number) => `invented-capture-key-${n.toString().padStart(4, '0')}`;
const unused = new AbortController().signal;
async function setupStore(kind: 'memory' | 'shared') {
  let time = Date.now();
  const db = new FakeFirestoreServer();
  const make = (): Store => kind === 'shared' ? new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'invented-capture-service',
    clock: () => time, maxSessions: 20, maxJourneysPerSession: 3, policy: policy(time + 3_600_000) }) : memory;
  const memory = new MemoryStore(cfg), store = make();
  const session = await store.createSession(time);
  if (!session || session === 'rate_limited') throw Error('fixture session');
  const owner = { sessionId: session.session.id, epoch: session.session.epoch };
  const register = (n = 1, target = make()) => target.registerCapture({ ...owner, now: time, sha256: sha, frames: RECORDING.minFrames, actionKeyHash: key(n), inputHash: key(n) });
  const ref = (receipt: RecordedReference['receipt']): RecordedReference => ({ kind: 'recorded', receipt, sha256: sha, frames: RECORDING.minFrames });
  const admit = (reference: RecordedReference, n = 10, target = make(), inputHash = 'same-audio-and-cue') => target.admitReference({ ...owner, now: time, reference,
    listenerCue: null, actionKeyHash: key(n), inputHash });
  return { db, make, store, owner, register, ref, admit, now: () => time, advance: (ms: number) => { time += ms; } };
}

describe.each(['memory', 'shared'] as const)('owned recorded input (%s)', kind => {
  it('registers only metadata, binds exact replay and consumes once atomically', async () => {
    const f = await setupStore(kind), r = await f.register();
    if (r.kind === 'rejected') throw Error(r.code);
    expect(r.capture.consumedAttempt).toBeNull();
    expect((await f.make().read(f.owner.sessionId, 1, f.now()))?.journey).toBeNull();
    expect((await f.register()).kind).toBe('replay');
    const ref = f.ref(r.capture.id), admitted = await f.admit(ref);
    expect(admitted.kind).toBe('admitted');
    expect((await f.admit(ref)).kind).toBe('replay');
    expect(await f.admit(ref, 11)).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect(await f.admit({ ...ref, sha256: 'b'.repeat(64) }, 10, f.make(), 'changed-bytes')).toEqual({ kind: 'rejected', code: 'action_conflict' });
    expect(JSON.stringify(f.db.entries())).not.toMatch(/"audio"|"samples"|"base64"/);
  });

  it('replaces one unused receipt without renewing old action bindings', async () => {
    const f = await setupStore(kind), a = await f.register(), b = await f.register(2);
    if (a.kind === 'rejected' || b.kind === 'rejected') throw Error('fixture registration');
    expect(b.capture.id).not.toBe(a.capture.id);
    expect(await f.admit(f.ref(a.capture.id))).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect(await f.register()).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect((await f.admit(f.ref(b.capture.id))).kind).toBe('admitted');
    if (kind === 'shared') expect(f.db.entries('wintr_owned/capture_')).toHaveLength(1);
  });

  it('does not let a receipt cross chat ownership or survive delete/Clear', async () => {
    const f = await setupStore(kind), r = await f.register();
    if (r.kind === 'rejected') throw Error(r.code);
    const chat = await f.make().changeChat(f.owner, { kind: 'create' }, { actionKeyHash: key(3), inputHash: 'new-chat' }, f.now());
    if (chat.kind === 'rejected' || !chat.chat) throw Error('fixture chat');
    expect(await f.admit(f.ref(r.capture.id), 10, f.make().forChat(chat.chat))).toEqual({ kind: 'rejected', code: 'stale_operation' });
    const r2 = await f.register(4, f.make().forChat(chat.chat));
    if (r2.kind === 'rejected') throw Error(r2.code);
    await f.make().changeChat(f.owner, { kind: 'delete', chat: chat.chat, expectedRevision: 0 }, { actionKeyHash: key(5), inputHash: 'delete-chat' }, f.now());
    expect((await f.admit(f.ref(r2.capture.id), 11, f.make().forChat(chat.chat))).kind).toBe('rejected');
    await f.make().clearSession(f.owner.sessionId);
    expect((await f.admit(f.ref(r.capture.id))).kind).toBe('rejected');
    if (kind === 'shared') expect(f.db.entries('wintr_owned/capture_')).toHaveLength(0);
  });

  it('expires unused capture authority without extending the session', async () => {
    const f = await setupStore(kind), r = await f.register();
    if (r.kind === 'rejected') throw Error(r.code);
    f.advance(300_000);
    expect(await f.admit(f.ref(r.capture.id))).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect(await f.register()).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect(await f.make().authorizeRead(f.owner, f.now())).toBe(true);
  });

  it('refuses mismatched frames/digest before admission and allows only fresh read authority', async () => {
    const f = await setupStore(kind), r = await f.register();
    if (r.kind === 'rejected') throw Error(r.code);
    const ref = f.ref(r.capture.id);
    expect((await f.admit({ ...ref, frames: ref.frames + 1 })).kind).toBe('rejected');
    expect((await f.admit({ ...ref, sha256: 'b'.repeat(64) })).kind).toBe('rejected');
    const a = await f.admit(ref);
    if (a.kind !== 'admitted') throw Error('fixture admission');
    expect(await f.make().authorizeReference(f.owner, a.attempt.id, ref, f.now())).toBe(true);
    await f.make().stopAttempt(f.owner.sessionId, 1, a.attempt.id, f.now());
    expect(await f.make().authorizeReference(f.owner, a.attempt.id, ref, f.now())).toBe(false);
  });

  it('rejects structurally typed extra audio fields before binding or writing a reference', async () => {
    const f = await setupStore(kind), r = await f.register();
    if (r.kind === 'rejected') throw Error(r.code);
    const extra = { ...f.ref(r.capture.id), audio: 'invented-forbidden-raw-field' };
    expect(await f.admit(extra)).toEqual({ kind: 'rejected', code: 'stale_operation' });
    expect((await f.make().read(f.owner.sessionId, 1, f.now()))?.journey).toBeNull();
    expect(JSON.stringify(f.db.entries())).not.toContain(extra.audio);
    expect((await f.admit(f.ref(r.capture.id))).kind).toBe('admitted');
  });
});

it('strictly rejects persisted capture payloads, malformed metadata and wrong owner', () => {
  const id = 'a'.repeat(24), ctx = { sessionId: 'b'.repeat(24), epoch: 1, sessionExpiresAt: 3_601_000 };
  const good = { id, sessionId: ctx.sessionId, epoch: 1, createdAt: 1000, expiresAt: ctx.sessionExpiresAt, usableUntil: 301000,
    chat: ctx.sessionId, sha256: sha, frames: 120000, consumedAttempt: null };
  expect(validRecord('capture', good, id, ctx)).toBe(true);
  for (const change of [{ audio: 'forbidden' }, { frames: 119999 }, { sha256: 'invalid' }, { usableUntil: 301001 }, { sessionId: 'c'.repeat(24) }]) {
    expect(validRecord('capture', { ...good, ...change }, id, ctx)).toBe(false);
  }
});

it('keeps recorded source permission finite, immutable and independent of intake', () => {
  const raw = { version: 'invented-recordings', expiresAt: Date.now() + 10000, videoIds: [], recordedDigests: [sha] };
  const parsed = parseSourcePolicy(raw); expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  raw.recordedDigests[0] = 'b'.repeat(64);
  expect(parsed.policy.allowsRecording(sha, Date.now())).toBe(true);
  expect(parsed.policy.allowsRecording('b'.repeat(64), Date.now())).toBe(false);
  expect(parsed.policy.allowsRecording(sha, parsed.policy.expiresAt)).toBe(false);
  let calls = 0;
  const getter = { ...raw }; Object.defineProperty(getter, 'recordedDigests', { enumerable: true, get: () => { calls++; return [sha]; } });
  expect(parseSourcePolicy(getter).ok).toBe(false); expect(calls).toBe(0);
  expect(parseSourcePolicy({ ...raw, recordedDigests: undefined }).ok).toBe(false);
  let inherited = 0;
  const array = [sha], prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, 'every', { get: () => { inherited++; return Array.prototype.every; } });
  Object.setPrototypeOf(array, prototype);
  expect(parseSourcePolicy({ ...raw, recordedDigests: array }).ok).toBe(false); expect(inherited).toBe(0);
});

it('constructs native inline WAV only from matching validated ephemeral bytes', () => {
  const audio = bytes(), reference: RecordedReference = { kind: 'recorded', receipt: 'a'.repeat(24) as RecordedReference['receipt'], sha256: sha, frames: 120000 };
  const body = JSON.parse(buildReferenceRequestBody({ reference, audio, listenerCue: null }));
  expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'audio/wav', data: Buffer.from(audio).toString('base64') } });
  expect(JSON.stringify(body)).not.toMatch(/fileUri|receipt|sha256/);
  audio[44] = 1;
  expect(() => buildReferenceRequestBody({ reference, audio, listenerCue: null })).toThrow();
  expect(() => buildReferenceRequestBody({ reference, listenerCue: null })).toThrow();
});

it.each(['recorded', 'youtube'] as const)('fresh shared revocation wins a held Cloud token (%s)', async kind => {
  const f = await setupStore('shared');
  let reference = CLOUD_INPUT.reference as typeof CLOUD_INPUT.reference | RecordedReference;
  const audio = kind === 'recorded' ? bytes() : undefined;
  if (audio) { const r = await f.register(); if (r.kind === 'rejected') throw Error(r.code); reference = f.ref(r.capture.id); }
  const admitted = await f.store.admitReference({ ...f.owner, now: f.now(), reference, listenerCue: null, actionKeyHash: key(10), inputHash: 'held-token' });
  if (admitted.kind !== 'admitted') throw Error('fixture admission');
  const raw = cloudBinding(), preparation = prepared(raw), token = deferred<CloudReferenceToken>(), entered = deferred<void>();
  let calls = 0;
  const adapter = createGeminiCloudReferenceAdapter({ binding: raw, preparation, clock: f.now,
    accessToken: () => { entered.resolve(); return token.promise; }, transport: async () => { calls++; return cloudResponse(); } });
  const running = runReferenceStage({ store: f.store, adapter, now: f.now, inflight: new Map() }, admitted.attempt, { reference, audio, listenerCue: null });
  try {
    await entered.promise;
    await f.make().clearSession(f.owner.sessionId);
  } finally { token.resolve(cloudToken(preparation.binding)); }
  await running;
  expect(calls).toBe(0);
  // Durable dispatch intent remains an unknown hold, even though this adapter never reached transport.
  expect(f.db.entries('wintr_ledger_reservations/')).toHaveLength(1);
});

const http = createHttpFixture(), servers: Server[] = [];
afterEach(async () => http.close(servers.splice(0)));
async function apiTest(approved = true, selfService = false) {
  const server = createServer(); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port, config = loadConfig(['--mode=synthetic'], { WINTR_PORT: String(port) });
  const parsed = parseSourcePolicy({ version: 'invented-intake', expiresAt: Date.now() + 60000, videoIds: ['aaaaaaaaaaa'], recordedDigests: approved ? [sha] : [],
    ...(selfService ? { processing: { kind: 'user_directed_music', permissionVersion: 'invented-server-owner-permission', youtube: true, recorded: true,
      deniedVideoIds: approved ? [] : ['aaaaaaaaaaa'], deniedRecordedDigests: approved ? [] : [sha] } } : {}) });
  if (!parsed.ok) throw Error('fixture policy');
  let calls = 0;
  const fake = createSyntheticReferenceAdapter(0);
  const adapter: ReferenceAdapter = { synthetic: true, analyse: (...args) => { calls++; return fake.analyse(...args); } };
  const store = new MemoryStore(config);
  server.on('request', createApiHandler({ config, store, sourcePolicy: parsed.policy, referenceAdapter: adapter, shutdown: http.shutdown() }));
  let cookie = '';
  const send = (path: string, body: unknown, headers: Record<string, string> = {}) => http.observe(new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { origin: config.origin, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('error', reject);
      res.on('end', () => { try { if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0]!.split(';')[0]!;
        const data = JSON.parse(text); if (res.statusCode! < 300) expect(isSafeSnapshot(data)).toBe(true);
        resolve({ status: res.statusCode!, body: data }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(payload);
  }));
  return { send, calls: () => calls };
}

it('projects only an opaque intake receipt and recorded reference through the real HTTP routes', async () => {
  const f = await apiTest(); await f.send('/api/session', {});
  const r = await f.send('/api/capture', { actionKey: key(1), sha256: sha, frames: 120000 });
  expect(r.status).toBe(201); expect(r.body.captureReceipt.durationMs).toBe(5000); expect(JSON.stringify(r.body)).not.toContain(sha);
  const request = { actionKey: key(10), receipt: r.body.captureReceipt.receipt, audio: Buffer.from(bytes()).toString('base64'), cue: 'invented cue' };
  const result = await f.send('/api/recording-reference', request);
  expect(result.status).toBe(200); expect(result.body.reference).toEqual({ kind: 'recorded', receipt: request.receipt, durationMs: 5000 });
  expect(JSON.stringify(result.body)).not.toMatch(/sha256|"audio"|"frames"/);
  expect((await f.send('/api/recording-reference', request)).status).toBe(200); expect(f.calls()).toBe(1);
  expect((await f.send('/api/recording-reference', { ...request, receipt: 'z'.repeat(24) })).body.error).toBe('action_conflict');
  expect(f.calls()).toBe(1);
  expect((await f.send('/api/reference', { url: 'https://youtu.be/aaaaaaaaaaa', actionKey: key(11), cue: 'x'.repeat(17000) })).status).toBe(413);
});

it('refuses an unapproved recorded digest and invalid encoding before provider admission', async () => {
  const f = await apiTest(false);
  expect((await f.send('/api/recording-reference', { audio: 'x'.repeat(20000) })).status).toBe(401);
  await f.send('/api/session', {});
  const r = await f.send('/api/capture', { actionKey: key(1), sha256: sha, frames: 120000 });
  const request = { actionKey: key(10), receipt: r.body.captureReceipt.receipt, audio: Buffer.from(bytes()).toString('base64') };
  expect((await f.send('/api/recording-reference', { ...request, audio: request.audio + '\n' })).status).toBe(400);
  expect((await f.send('/api/recording-reference', request)).body.error).toBe('unsupported_source');
  expect(f.calls()).toBe(0);
});

it.each([true, false])('self-service processing is server-owned and known denial vetoes admission (%s)', async allowed => {
  const f = await apiTest(allowed, true);
  const session = await f.send('/api/session', {});
  expect(session.body.recordingSelfService).toBe(true);
  expect((await f.send('/api/capture', { actionKey: key(1), sha256: sha, frames: 120000, recordingSelfService: true })).status).toBe(400);
  const r = await f.send('/api/capture', { actionKey: key(2), sha256: sha, frames: 120000 });
  expect(r.body.captureReceipt.approved).toBe(allowed); expect(f.calls()).toBe(0);
  expect(JSON.stringify(r.body)).not.toMatch(/permissionVersion|deniedVideoIds|deniedRecordedDigests|sha256/);
  const response = await f.send('/api/recording-reference', { actionKey: key(10), receipt: r.body.captureReceipt.receipt, audio: Buffer.from(bytes()).toString('base64') });
  expect(response.status).toBe(allowed ? 200 : 422); expect(f.calls()).toBe(allowed ? 1 : 0);
  if (!allowed) {
    expect(response.body.error).toBe('unsupported_source');
    const video = await f.send('/api/reference', { actionKey: key(11), url: 'https://youtu.be/aaaaaaaaaaa' });
    expect(video.body.error).toBe('unsupported_source'); expect(f.calls()).toBe(0);
  }
});
