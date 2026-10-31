import { afterEach, expect, it, vi } from 'vitest';
import { encodePcmWav } from '../src/shared/recording.js';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { SessionController } from '../src/client/controller.js';
import type { ApiPort } from '../src/client/api.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';

// Actual operation controller over fake API only: no device, microphone, socket or provider.
const receipt = 'a'.repeat(24) as Handle;
const blank = (): SafeSnapshot => ({ mode: 'synthetic', session: null, stage: 'idle', revision: 0, status: null, attempt: null, reference: null,
  listenerCue: null, analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null });
const owned = (): SafeSnapshot => ({ ...blank(), session: { context: 'invented-session-context', expiresAt: Date.now() + 3_600_000 } });
const registered = (): SafeSnapshot => ({ ...owned(), captureReceipt: { receipt, durationMs: 5000, expiresAt: Date.now() + 300000, approved: true } });
const audio = () => encodePcmWav(new Float32Array(120000));
const done = (): SafeSnapshot => ({ ...owned(), revision: 1, stage: 'awaiting_preference', reference: { kind: 'recorded', receipt, durationMs: 5000 } });
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const controllers: SessionController[] = [];
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); });
async function fixture(initial = owned()) {
  const no = vi.fn(async () => blank());
  const api = { state: vi.fn(async () => initial), createSession: vi.fn(async () => owned()), registerCapture: vi.fn<NonNullable<ApiPort['registerCapture']>>(async () => registered()),
    recordingReference: vi.fn<NonNullable<ApiPort['recordingReference']>>(async () => done()), reference: no, preference: no, artistChoice: no, feedback: no, discover: no, refine: no,
    stop: vi.fn(async () => owned()), clear: vi.fn(async () => blank()) } satisfies ApiPort;
  let key = 0;
  const c = new SessionController(api, { maxWatchReads: 0, watchIntervalMs: 1000000, newKey: () => `invented-action-key-${++key}` });
  controllers.push(c); c.activate(); await c.refresh(); return { c, api };
}
async function until(test: () => boolean) { for (let n = 0; n < 100 && !test(); n++) await new Promise<void>(r => setImmediate(r)); expect(test()).toBe(true); }
const metadata = { actionKey: 'invented-metadata-key', sha256: 'b'.repeat(64), frames: 120000 };
async function prepare(f: Awaited<ReturnType<typeof fixture>>) { const receipt = await f.c.prepareRecording(metadata, () => true); if (!receipt) throw Error('fixture preparation'); return receipt; }

it('submits one checked clip, exposes metadata only, then zeros its transient buffer', async () => {
  const f = await fixture(), clip = audio(), expected = Uint8Array.from(clip), held = deferred<SafeSnapshot>();
  f.api.recordingReference.mockImplementation(() => held.promise);
  const preparation = await prepare(f); expect(f.api.recordingReference).not.toHaveBeenCalled();
  const sent = f.c.submitRecording(clip, null, preparation); expect(sent.accepted).toBe(true);
  await until(() => f.api.recordingReference.mock.calls.length === 1);
  const call = f.api.recordingReference.mock.calls[0]!;
  expect(Buffer.from(call[0].audio, 'base64')).toEqual(Buffer.from(expected)); expect(call[0].receipt).toBe(receipt);
  expect(f.c.getView().submitted).toEqual({ kind: 'recorded', receipt, durationMs: 5000, cue: null });
  expect(JSON.stringify(f.c.getView())).not.toMatch(/sha256|"audio"|"frames"/);
  held.resolve(done()); await sent.done;
  expect(clip.every(b => b === 0)).toBe(true); expect(f.api.registerCapture).toHaveBeenCalledTimes(1); expect(f.api.recordingReference).toHaveBeenCalledTimes(1);
});

it('cancelling free preparation during session setup cannot register or transmit audio', async () => {
  const f = await fixture(blank()), create = deferred<SafeSnapshot>();
  f.api.createSession.mockImplementation(() => create.promise);
  const preparing = f.c.prepareRecording(metadata, () => true); f.c.cancelRecordingPreparation();
  expect(f.api.registerCapture).not.toHaveBeenCalled();
  create.resolve(owned()); expect(await preparing).toBeNull();
  expect(f.api.recordingReference).not.toHaveBeenCalled(); expect(f.api.stop).not.toHaveBeenCalled();
});

it('cancellation wins delayed metadata registration and never starts audio transport', async () => {
  const f = await fixture(), registration = deferred<SafeSnapshot>();
  f.api.registerCapture.mockImplementation(() => registration.promise);
  const preparing = f.c.prepareRecording(metadata, () => true);
  await until(() => f.api.registerCapture.mock.calls.length === 1);
  f.c.cancelRecordingPreparation();
  registration.resolve(registered()); expect(await preparing).toBeNull();
  expect(f.api.recordingReference).not.toHaveBeenCalled(); expect(f.c.getView().submitted).toBeNull();
});

it('does not adopt a metadata receipt from another context', async () => {
  const f = await fixture(); f.api.registerCapture.mockResolvedValue({ ...registered(), session: { context: 'invented-other-context', expiresAt: Date.now() + 10000 } });
  expect(await f.c.prepareRecording(metadata, () => true)).toBeNull();
  expect(f.api.recordingReference).not.toHaveBeenCalled();
});

it('Clear erases accepted transient audio and ignores a late execute result', async () => {
  const f = await fixture(), response = deferred<SafeSnapshot>(), clip = audio(); clip[44] = 99;
  f.api.recordingReference.mockImplementation(() => response.promise);
  const preparation = await prepare(f);
  const sent = f.c.submitRecording(clip, null, preparation); await until(() => f.api.recordingReference.mock.calls.length === 1);
  const clear = f.c.clear(); expect(clip.every(b => b === 0)).toBe(true);
  response.resolve(done()); await Promise.all([sent.done, clear]);
  expect(f.c.getView().snapshot?.session).toBeNull(); expect(f.c.getView().submitted).toBeNull();
});

it('refuses private digests/raw fields and malformed recorded DTOs', () => {
  expect(isSafeSnapshot(done())).toBe(true);
  for (const change of [{ sha256: 'b'.repeat(64) }, { audio: 'invented' }, { frames: 120000 }, { durationMs: 4999 }, { durationMs: Infinity }]) {
    expect(isSafeSnapshot({ ...done(), reference: { ...done().reference, ...change } })).toBe(false);
  }
  expect(isSafeSnapshot({ ...registered(), session: null })).toBe(false);
});

it('refuses new preparation and paid actions after disposal; explicit activation permits a fresh preparation', async () => {
  const f = await fixture(), preparation = await prepare(f);
  f.c.dispose();
  expect(await f.c.prepareRecording(metadata, () => true)).toBeNull();
  expect(f.api.registerCapture).toHaveBeenCalledTimes(1);
  const clip = audio();
  expect(f.c.submitRecording(clip, null, preparation).accepted).toBe(false); expect(clip.every(b => b === 0)).toBe(true);
  expect(f.c.submitReference({ url: 'https://youtu.be/aaaaaaaaaaa', focus: { start: 0, end: 30 }, cue: null,
    display: { videoId: 'aaaaaaaaaaa', canonicalUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', focus: { start: 0, end: 30 }, cue: null } }).accepted).toBe(false);
  expect(f.api.recordingReference).not.toHaveBeenCalled(); expect(f.api.reference).not.toHaveBeenCalled();
  f.c.activate(); expect(await f.c.prepareRecording(metadata, () => true)).not.toBeNull();
});
