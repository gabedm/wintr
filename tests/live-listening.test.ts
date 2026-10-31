import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { Handle, StreamedReference } from '../src/shared/records.js';
import { LIVE_LISTENING as L } from '../src/shared/live-listening.js';
import { createLiveAudioInput } from '../src/server/live-audio.js';
import { buildLiveSetup, createGeminiLiveReferenceAdapter, GEMINI_LIVE_PROFILE } from '../src/server/providers/gemini-live-reference.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { parseSourcePolicy } from '../src/server/source-policy.js';
import { createCallObserver } from '../src/server/providers/observation.js';
import { LIVE_AUDIO_OBSERVATION_PROFILE, OBSERVATION_PROFILES, parseObservation } from '../src/server/ledger/observation.js';
import { FirestoreStore } from '../src/server/firestore-store.js';
import { createFirestoreDocStore } from '../src/server/persistence/docstore.js';
import { validRecord } from '../src/server/persistence/record-schema.js';
import { runReferenceStage } from '../src/server/harness.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { policy } from './fixtures/live-fixtures.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const receipt = 'inventedLiveReceipt000001' as Handle;
const reference: StreamedReference = { kind: 'streamed', receipt };
const args = { audio_access: 'accessed', observations: ['An invented steady beat.'], relationships: ['Keep the steady rhythm'], artist_name: null };
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING; bufferedAmount = 0; sent: Record<string, any>[] = []; closes = 0; terminated = false;
  constructor(readonly mode = 'normal') { super(); queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.emit('open'); }); }
  send(text: string) {
    const m = JSON.parse(text); this.sent.push(m);
    if (m.setup) { this.message({ setupComplete: {} }); if (this.mode === 'fill-after-setup') this.bufferedAmount = L.maxQueuedBytes; }
    if (m.realtimeInput?.activityStart && this.mode === 'early') this.result();
    if (m.realtimeInput?.activityEnd) {
      this.message({ usageMetadata: { promptTokenCount: 12, responseTokenCount: 7 } });
      this.message({ usageMetadata: { promptTokenCount: 10, responseTokenCount: 6 } });
      if (this.mode === 'missing') this.message({ serverContent: { turnComplete: true } });
      else if (this.mode === 'cancelled') this.message({ toolCallCancellation: { ids: ['invented-call'] } });
      else { this.result(); if (this.mode === 'duplicate') this.result(); }
    }
  }
  result() {
    const id = this.mode === 'no-id' ? {} : { id: this.mode === 'opaque-id' ? 'invented/live+call=1' : this.mode === 'numeric-id' ? 42 : this.mode === 'oversize-id' ? 'x'.repeat(257) : this.mode === 'control-id' ? 'invented\ncall' : 'invented-call' };
    this.message({ toolCall: { functionCalls: [{ ...id, name: 'report_reference', args: this.mode === 'malformed' ? { ...args, extra: true } : args }] } });
  }
  message(m: unknown) { this.emit('message', Buffer.from(JSON.stringify(m)), this.mode === 'binary'); }
  close() { this.closes++; this.readyState = WebSocket.CLOSED; this.emit('close'); }
  terminate() { this.terminated = true; this.close(); }
}
function providerFixture(mode = 'normal') {
  let now = 1000, ready = false, socket: Socket | undefined, allowed = true, reads = 0;
  const abort = new AbortController();
  const stream = createLiveAudioInput(receipt, abort.signal, () => { ready = true; }, () => now);
  const adapter = createGeminiLiveReferenceAdapter({ apiKey: new ServerSecret('invented-only-key'), clock: () => now,
    checkAuthority: () => { if (!allowed) throw Error('invented revoked approval'); },
    socket: () => (socket = new Socket(mode)) as unknown as WebSocket });
  const observation = createCallObserver('reference_analysis', now, () => now, async () => 'stored', LIVE_AUDIO_OBSERVATION_PROFILE);
  const result = adapter.analyse({ reference, listenerCue: null, stream }, abort.signal, observation.observer,
    { deadlineAt: 91_000, dispatch: async send => { reads++; return send(); } });
  void result.catch(() => {});
  const feed = async (frames = L.minFrames, beforeFinish?: () => void) => {
    await vi.waitFor(() => expect(ready).toBe(true));
    for (let left = frames; left > 0;) { const n = Math.min(4096, left); now += Math.ceil(n * 1000 / L.sampleRate); stream.push(new Uint8Array(n * 2)); left -= n; await tick(); }
    beforeFinish?.(); stream.finish();
  };
  return { stream, adapter, result, feed, abort, observation, socket: () => socket!, reads: () => reads, advance: (n: number) => { now += n; }, revoke: () => { allowed = false; } };
}
describe('fixed genuine Live protocol (invented audio and sockets only)', () => {
  it('requests English analysis explicitly while keeping a different-language listener note as data', () => {
    const setup = buildLiveSetup({ reference, listenerCue: 'Una nota inventada' }).setup;
    expect(setup.systemInstruction.parts[0]!.text).toContain('Write every observation and musical relationship in English, regardless of the language in the audio or listener note.');
    expect(setup.systemInstruction.parts[0]!.text).toContain('Listener note, JSON encoded: "Una nota inventada"');
    expect(setup.tools[0]!.functionDeclarations[0]!.parameters.properties.observations.description).toContain('English');
    expect(setup.tools[0]!.functionDeclarations[0]!.parameters.properties.relationships.description).toContain('English');
    expect(setup.tools[0]!.functionDeclarations[0]!.parameters.properties.artist_name).toMatchObject({ nullable: true, description: expect.stringContaining('never identified source performer') });
    expect(setup.systemInstruction.parts[0]!.text).toContain('Do not force a celebrity guess');
  });
  it('waits for setup, sends PCM before Finish, reports bounded function arguments and keeps cumulative usage', async () => {
    const f = providerFixture(); await f.feed(); const result = await f.result;
    expect(result.audioAccess).toBe('accessed'); expect(result.provider?.model).toBe(GEMINI_LIVE_PROFILE.model);
    expect(result.provider?.usage).toMatchObject({ totalInputTokens: 12, totalOutputTokens: 7, totalThoughtTokens: null });
    expect(JSON.parse(result.provider!.finalText)).toEqual(args);
    const sent = f.socket().sent; expect(sent[0]).toEqual(buildLiveSetup({ reference, listenerCue: null }));
    expect(sent[1]).toEqual({ realtimeInput: { activityStart: {} } });
    expect(sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
    expect(sent.slice(2, -1).every(m => m.realtimeInput.audio.mimeType === 'audio/pcm;rate=24000')).toBe(true);
    expect(f.reads()).toBe(sent.length + 1); // Durable fence for connection, setup, start, every chunk and end.
    expect(f.observation.snapshot()).toMatchObject({ invocation: 'one', status: 101, profile: LIVE_AUDIO_OBSERVATION_PROFILE,
      usage: { outputTokens: { state: 'known', value: 7 } } });
    expect(JSON.stringify(sent[0])).not.toMatch(/thinkingConfig|responseSchema|proactiveAudio|inputAudioTranscription/);
  });
  it.each([
    ['early', 'live_report_early'], ['duplicate', 'live_report_duplicate'], ['missing', 'incomplete'], ['cancelled', 'incomplete'], ['malformed', 'live_report_args'],
    ['numeric-id', 'live_report_envelope'], ['oversize-id', 'live_report_envelope'], ['control-id', 'live_report_envelope'],
  ])('fails %s reports with a content-free cause and no reconnect or retry', async (mode, kind) => {
    const f = providerFixture(mode);
    if (mode !== 'early') await f.feed();
    await expect(f.result).rejects.toMatchObject({ kind }); expect(f.socket().closes).toBeGreaterThan(0);
    const error = await f.result.catch(error => error); f.observation.finish(error);
    const snapshot = f.observation.snapshot();
    expect(snapshot).toMatchObject({ error: kind, outcome: 'failed' });
    expect(parseObservation(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('invented-call');
    expect(JSON.stringify(snapshot)).not.toContain(args.observations[0]);
    if (kind.startsWith('live_')) {
      expect(parseObservation({ ...snapshot, profile: OBSERVATION_PROFILES.reference_analysis })).toBeNull();
      expect(parseObservation({ ...snapshot, responseBody: 'invented private body' })).toBeNull();
    }
  });
  it('accepts binary-carried UTF-8 JSON setup, usage and terminal report frames', async () => {
    const f = providerFixture('binary'); await f.feed();
    expect(await f.result).toMatchObject({ audioAccess: 'accessed', provider: { usage: { totalOutputTokens: 7 } } });
    expect(f.socket().sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
  });
  it.each(['no-id', 'opaque-id'])('accepts a complete report with documented %s correlation metadata', async mode => {
    const f = providerFixture(mode); await f.feed();
    const result = await f.result;
    expect(result.audioAccess).toBe('accessed');
    expect(JSON.parse(result.provider!.finalText)).toEqual(args);
    expect(f.socket().sent.at(-1)).toEqual({ realtimeInput: { activityEnd: {} } });
    expect(f.socket().closes).toBe(1);
  });
  it.each([Buffer.from([0xff, 0xfe]), Buffer.alloc(64)])('rejects non-JSON/invalid-UTF-8 binary output %j', async bytes => {
    const f = providerFixture(); await vi.waitFor(() => expect(f.socket()?.sent.length).toBe(2));
    f.socket().emit('message', bytes, true); await expect(f.result).rejects.toMatchObject({ kind: 'live_invalid_json' });
  });
  it.each([0, 1])('includes the next encoded PCM payload at the upstream buffer boundary (+%i byte)', async over => {
    const f = providerFixture(); await vi.waitFor(() => expect(f.socket()?.sent.length).toBe(2));
    const payload = JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(8192).toString('base64') } } });
    f.socket().bufferedAmount = L.maxQueuedBytes - Buffer.byteLength(payload) - 14 + over;
    f.stream.push(new Uint8Array(8192));
    if (over) { await expect(f.result).rejects.toThrow(); expect(f.socket().sent).toHaveLength(2); }
    else { await vi.waitFor(() => expect(f.socket().sent).toHaveLength(3)); f.abort.abort(); await expect(f.result).rejects.toThrow(); }
  });
  it('does not exempt activityStart from the upstream transport cap', async () => {
    const f = providerFixture('fill-after-setup'); await expect(f.result).rejects.toThrow(); expect(f.socket().sent).toHaveLength(1);
  });
  it('does not exempt activityEnd from the upstream transport cap', async () => {
    const f = providerFixture(); await f.feed(L.minFrames, () => { f.socket().bufferedAmount = L.maxQueuedBytes; });
    await expect(f.result).rejects.toThrow(); expect(f.socket().sent.some(m => m.realtimeInput?.activityEnd)).toBe(false);
  });
  it('checks changed controller authority before the next owned chunk', async () => {
    const f = providerFixture(); await vi.waitFor(() => expect(f.socket()?.sent.length).toBe(2));
    f.revoke(); f.stream.push(new Uint8Array(8192)); await expect(f.result).rejects.toThrow();
    expect(f.socket().sent).toHaveLength(2);
  });
  it('cancels and terminates on revocation rather than turning disconnect into Finish', async () => {
    const f = providerFixture(); await vi.waitFor(() => expect(f.socket()?.sent.length).toBe(2)); f.abort.abort();
    await expect(f.result).rejects.toThrow(); expect(f.socket().terminated).toBe(true);
    expect(f.socket().sent.some(m => m.realtimeInput?.activityEnd)).toBe(false);
  });
  it('refuses upstream backpressure before sending another owned chunk', async () => {
    const f = providerFixture(); await vi.waitFor(() => expect(f.socket()?.sent.length).toBe(2)); f.socket().bufferedAmount = L.maxQueuedBytes + 1;
    f.stream.push(new Uint8Array(8192)); await expect(f.result).rejects.toThrow(); expect(f.socket().sent).toHaveLength(2);
  });
  it('bounds discarded output as well as function reports', async () => {
    const f = providerFixture(); await vi.waitFor(() => expect(f.socket()?.sent.length).toBe(2));
    for (let i = 0; i < 6; i++) f.socket().message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'A'.repeat(450_000) } }] } } });
    await expect(f.result).rejects.toThrow();
  });
});

describe('streamed source and transient queue authority', () => {
  it('keeps real-time PCM flowing through 1.15-second durable fences without raising the queue or transport cap', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1000);
    const abort = new AbortController(), batches: number[] = [];
    const stream = createLiveAudioInput(receipt, abort.signal, () => {});
    stream.ready();
    const consuming = (async () => {
      for await (const chunk of stream) {
        // Model the authorization wait before this batch can leave the server.
        await new Promise<void>(resolve => setTimeout(resolve, 1150));
        batches.push(chunk.byteLength);
      }
    })();
    void consuming.catch(() => {});
    try {
      for (let frames = 0; frames < L.maxFrames;) {
        const count = Math.min(4096, L.maxFrames - frames);
        await vi.advanceTimersByTimeAsync(Math.ceil(count * 1000 / L.sampleRate));
        stream.push(new Uint8Array(count * 2)); frames += count;
      }
      stream.finish(); await vi.runAllTimersAsync(); await consuming;
      expect(batches.reduce((n, size) => n + size, 0)).toBe(L.maxFrames * 2);
      expect(Math.max(...batches)).toBeLessThanOrEqual(65_536);
      const payload = JSON.stringify({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(Math.max(...batches)).toString('base64') } } });
      expect(Buffer.byteLength(payload) + 14).toBeLessThanOrEqual(131_072);
      expect(L.maxQueuedBytes).toBe(131_072);
    } finally { stream.cancel(); vi.useRealTimers(); }
  });
  it('still cancels an overfull queue when a consumer cannot keep up with real-time PCM', () => {
    let time = 1000;
    const stream = createLiveAudioInput(receipt, new AbortController().signal, () => {}, () => time);
    stream.ready();
    expect(() => {
      for (let i = 0; i < 17; i++) { time += 171; stream.push(new Uint8Array(8192)); }
    }).toThrow();
    expect(stream.finished).toBe(false); stream.cancel();
  });
  const raw = () => ({ version: 'invented-live-v1', expiresAt: 10_000, videoIds: [], processing: { kind: 'user_directed_music', permissionVersion: 'invented-grant', youtube: true, recorded: true, live: true, deniedVideoIds: [], deniedRecordedDigests: [] } });
  it('never inherits Live from recording and includes the new flag in the permission identity', () => {
    const a = raw(), b = raw(); delete (b.processing as Partial<typeof b.processing>).live;
    const p = parseSourcePolicy(a), q = parseSourcePolicy(b); expect(p.ok && q.ok).toBe(true);
    if (!p.ok || !q.ok) throw Error('fixture');
    expect(p.policy.version).not.toBe(q.policy.version); expect(q.policy.allowsLiveAudio?.(1)).toBe(false);
    expect(p.policy.allowsLiveAudio?.(1)).toBe(true); expect(p.policy.allowsLiveAudio?.(10_000)).toBe(false);
    a.processing.live = false; expect(p.policy.allowsLiveAudio?.(1)).toBe(true); // Captured immutable binding.
  });
  it('fails closed for any digest refusal and rejects getter/inherited Live grants without evaluating them', () => {
    const p = raw(); (p.processing.deniedRecordedDigests as string[]).push('a'.repeat(64)); expect(parseSourcePolicy(p).ok).toBe(false);
    const getter = vi.fn(() => true), q = raw(); Object.defineProperty(q.processing, 'live', { get: getter });
    expect(parseSourcePolicy(q).ok).toBe(false); expect(getter).not.toHaveBeenCalled();
    const inherited = raw(); Object.setPrototypeOf(inherited.processing, { live: true }); expect(parseSourcePolicy(inherited).ok).toBe(false);
  });
  it.each(['before_ready', 'odd', 'oversize', 'pace', 'too_short', 'after_cancel'] as const)('refuses %s PCM without retaining a clip', kind => {
    const abort = new AbortController(); let time = 1000;
    const stream = createLiveAudioInput(receipt, abort.signal, () => {}, () => time);
    if (kind !== 'before_ready') stream.ready();
    if (kind === 'after_cancel') stream.cancel();
    expect(() => {
      if (kind === 'too_short') stream.finish();
      else if (kind === 'pace') for (let i = 0; i < 20; i++) stream.push(new Uint8Array(8192));
      else stream.push(new Uint8Array(kind === 'odd' ? 3 : kind === 'oversize' ? 8194 : 8192));
    }).toThrow(); stream.cancel(); time++;
    expect(Object.keys(stream)).not.toContain('audio');
  });
});

describe('shared streamed admission and held accounting', () => {
  async function shared() {
    let now = Date.now(); const db = new FakeFirestoreServer();
    const make = () => new FirestoreStore({ docs: createFirestoreDocStore(new FakeFirestore(db)), serviceId: 'invented-stream-service', policy: policy(now + 3_600_000), clock: () => now, maxSessions: 20, maxJourneysPerSession: 3 });
    const store = make(), session = await store.createSession(now); if (!session || session === 'rate_limited') throw Error('fixture');
    const owner = { sessionId: session.session.id, epoch: session.session.epoch };
    const admit = (target = store, key = 'invented-stream-action') => target.admitReference({ ...owner, now, reference: { kind: 'streamed' }, listenerCue: null, actionKeyHash: key, inputHash: 'invented-stream-input' });
    return { store, make, db, owner, admit, now: () => now, advance: (n: number) => { now += n; } };
  }
  it('mints one immutable owned receipt, serializes it, rejects caller receipts and replays without a second admission', async () => {
    const f = await shared(), admitted = await f.admit(); if (admitted.kind !== 'admitted') throw Error('fixture');
    expect(admitted.journey.reference).toMatchObject({ kind: 'streamed', receipt: expect.stringMatching(/^[A-Za-z0-9_-]{24}$/) });
    expect(validRecord('journey', admitted.journey, admitted.journey.id, { sessionId: f.owner.sessionId, epoch: f.owner.epoch, sessionExpiresAt: admitted.journey.expiresAt })).toBe(true);
    expect(await f.admit(f.make())).toEqual({ kind: 'replay', attemptId: admitted.attempt.id });
    expect(await f.store.admitReference({ ...f.owner, now: f.now(), reference: { kind: 'streamed', receipt } as any, listenerCue: null, actionKeyHash: 'other', inputHash: 'other' })).toMatchObject({ kind: 'rejected' });
    expect(await f.make().authorizeReference(f.owner, admitted.attempt.id, admitted.journey.reference, f.now())).toBe(true);
    await f.make().clearSession(f.owner.sessionId);
    expect(await f.make().authorizeReference(f.owner, admitted.attempt.id, admitted.journey.reference, f.now())).toBe(false);
    expect(JSON.stringify(f.db.entries())).not.toMatch(/"audio"|"samples"|"base64"/);
  });
  it('cannot use a stream receipt in another chat or after that chat is deleted', async () => {
    const f = await shared(), a = await f.admit(); if (a.kind !== 'admitted') throw Error('fixture');
    const other = await f.store.changeChat(f.owner, { kind: 'create' }, { actionKeyHash: 'new', inputHash: 'new' }, f.now());
    if (other.kind === 'rejected' || !other.chat) throw Error('fixture');
    expect(await f.make().forChat(other.chat).authorizeReference(f.owner, a.attempt.id, a.journey.reference, f.now())).toBe(false);
  });
  it('cross-worker Clear between chunks stops further sends and retains the unknown intent across restart', async () => {
    const f = await shared(), a = await f.admit(); if (a.kind !== 'admitted' || !('kind' in a.journey.reference)) throw Error('fixture');
    let socket: Socket | undefined, ready = false;
    const abort = new AbortController(), inflight = new Map();
    const stream = createLiveAudioInput(a.journey.reference.receipt, abort.signal, () => { ready = true; }, f.now);
    const adapter = createGeminiLiveReferenceAdapter({ apiKey: new ServerSecret('invented-only-key'), clock: f.now, checkAuthority() {}, socket: () => (socket = new Socket()) as unknown as WebSocket });
    const running = runReferenceStage({ store: f.store, adapter, now: f.now, inflight }, a.attempt, { reference: a.journey.reference, listenerCue: null, stream });
    await vi.waitFor(() => expect(ready).toBe(true)); await f.make().clearSession(f.owner.sessionId);
    stream.push(new Uint8Array(8192)); await running; stream.cancel();
    expect(socket!.sent).toHaveLength(2);
    const totals = await f.make().reconciliation().totals(); expect(totals).toMatchObject({ counts: { gemini: 1 }, active: 0, unresolved: 1 });
    expect(totals!.unitsHeld).toBeGreaterThan(0);
  });
});
