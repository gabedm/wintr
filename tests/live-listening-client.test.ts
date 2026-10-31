import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveMusicCapture, IDLE_LIVE_CAPTURE, type LiveMusicCapture } from '../src/client/live-music-capture.js';
import type { CaptureDevice, CaptureProcessor, MusicCapturePort } from '../src/client/music-capture.js';
import { streamLiveReference, type BrowserLiveSocket } from '../src/client/live-transport.js';
import { SessionController } from '../src/client/controller.js';
import type { ApiPort } from '../src/client/api.js';
import type { Handle, SafeSnapshot } from '../src/shared/records.js';
import { isSafeSnapshot } from '../src/client/snapshot-validation.js';
import { LIVE_LISTENING as L } from '../src/shared/live-listening.js';

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const captures: LiveMusicCapture[] = [], controllers: SessionController[] = [];
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1000); });
afterEach(async () => { for (const c of controllers.splice(0)) c.dispose(); for (const c of captures.splice(0)) c.cancel(); await flush(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(permission?: Promise<CaptureDevice>) {
  let now = 0, receive!: (m: unknown) => void, revoke = () => {}, frames = 0;
  const stops = vi.fn(), closes = vi.fn(), begin = vi.fn(), disconnect = vi.fn(), watch = vi.fn();
  const device: CaptureDevice = { stop: stops, watchInterruption: fn => { watch.mockImplementation(fn); return () => {}; } };
  const processor: CaptureProcessor = { sampleRate: 24000, prepare: async () => {}, begin, disconnectInput: disconnect,
    finish() { receive({ type: 'stopped', frames }); }, close: closes };
  const request = vi.fn(() => permission ?? Promise.resolve(device));
  const port: MusicCapturePort = { requestDevice: request, createProcessor(_d, message) { receive = message; return processor; }, now: () => now,
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>), isVisible: () => true,
    watchRevocation(fn) { revoke = fn; return () => {}; } };
  const capture = createLiveMusicCapture(port); captures.push(capture);
  const feed = (count: number, value = 0.25) => {
    while (count) { const n = Math.min(count, 4096), samples = new Float32Array(n).fill(value); now += n * 1000 / 24000; frames += n; receive({ type: 'frames', samples }); expect(samples.every(n => n === 0)).toBe(true); count -= n; }
  };
  return { capture, port, device, processor, request, stops, closes, begin, disconnect, feed, receive: (m: unknown) => receive(m), hide: () => revoke() };
}
describe('deliberate streaming capture', () => {
  it('adopts one device preparation, never begins early and honours either abort signal', async () => {
    const f = fixture(), first = new AbortController(), second = new AbortController();
    await Promise.all([f.capture.prepare(first.signal), f.capture.prepare(second.signal)]);
    expect(f.request).toHaveBeenCalledOnce(); expect(f.begin).not.toHaveBeenCalled();
    second.abort(); await expect(f.capture.completion).rejects.toThrow();
    expect(f.stops).toHaveBeenCalledOnce(); expect(f.closes).toHaveBeenCalledOnce();
    await expect(f.capture.prepare(first.signal)).rejects.toThrow();
  });
  it('finishes a valid excerpt at eight seconds while retaining the minimum and hard cap', async () => {
    const f = fixture(); await f.capture.prepare(new AbortController().signal); f.capture.begin(() => {});
    f.feed(L.sampleRate * 8); await vi.advanceTimersByTimeAsync(7999);
    expect(f.capture.getSnapshot().phase).toBe('listening'); await vi.advanceTimersByTimeAsync(1);
    await f.capture.completion; expect(f.capture.getSnapshot()).toMatchObject({ phase: 'analysing', durationMs: 8000 });
    const slow = fixture(); await slow.capture.prepare(new AbortController().signal); slow.capture.begin(() => {}); slow.feed(L.sampleRate * 4);
    await vi.advanceTimersByTimeAsync(8000); expect(slow.capture.getSnapshot().phase).toBe('listening');
    const failed = expect(slow.capture.completion).rejects.toThrow(); await vi.advanceTimersByTimeAsync(12000); await failed;
  });
  it('requests no device until explicit prepare, streams bounded PCM chunks and releases input on Finish', async () => {
    const f = fixture(), chunks: Uint8Array[] = [], scratch: Uint8Array[] = [];
    expect(f.request).not.toHaveBeenCalled(); expect(f.capture.getSnapshot()).toBe(IDLE_LIVE_CAPTURE);
    await f.capture.prepare(new AbortController().signal); expect(f.begin).not.toHaveBeenCalled();
    f.capture.begin(pcm => { chunks.push(Uint8Array.from(pcm)); scratch.push(pcm); }); f.feed(120000);
    expect(f.capture.getSnapshot()).toMatchObject({ phase: 'listening', durationMs: 5000 });
    expect(chunks.every(c => c.length <= 8192)).toBe(true); expect(new DataView(chunks[0]!.buffer).getInt16(0, true)).toBe(8192);
    expect(scratch.every(c => c.every(b => b === 0))).toBe(true);
    f.capture.finish(); expect(f.stops).toHaveBeenCalledTimes(1); expect(f.disconnect).toHaveBeenCalled();
    await f.capture.completion; expect(f.capture.getSnapshot().phase).toBe('analysing'); expect(f.closes).toHaveBeenCalledTimes(1);
    expect(Object.keys(f.capture.getSnapshot()).sort()).toEqual(['durationMs', 'error', 'phase']);
  });
  it('automatically finishes at twenty seconds without creating a ready recording', async () => {
    const f = fixture(); await f.capture.prepare(new AbortController().signal); let bytes = 0;
    f.capture.begin(pcm => { bytes += pcm.length; }); f.feed(480000); await f.capture.completion;
    expect(bytes).toBe(960000); expect(f.capture.getSnapshot()).toMatchObject({ phase: 'analysing', durationMs: 20000 });
  });
  it('stops a permission grant arriving after cancellation without preparing a processor', async () => {
    const gate = deferred<CaptureDevice>(), f = fixture(gate.promise), abort = new AbortController();
    const pending = f.capture.prepare(abort.signal); abort.abort(); gate.resolve(f.device);
    await expect(pending).rejects.toThrow(); expect(f.stops).toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled();
  });
  it.each(['hidden', 'abort', 'nonfinite', 'oversize', 'backpressure'] as const)('releases capture on %s and never treats it as Finish', async reason => {
    const f = fixture(), abort = new AbortController(); await f.capture.prepare(abort.signal);
    f.capture.begin(() => { if (reason === 'backpressure') throw Error('blocked'); });
    if (reason === 'hidden') f.hide(); else if (reason === 'abort') abort.abort();
    else f.receive({ type: 'frames', samples: new Float32Array(reason === 'oversize' ? 4097 : 200).fill(reason === 'nonfinite' ? NaN : 0) });
    await expect(f.capture.completion).rejects.toThrow(); expect(f.stops).toHaveBeenCalled(); expect(f.closes).toHaveBeenCalled();
    expect(f.capture.getSnapshot().phase).toBe('error');
  });
  it('bounds permission time and releases a late grant after timeout', async () => {
    const gate = deferred<CaptureDevice>(), f = fixture(gate.promise), pending = f.capture.prepare(new AbortController().signal);
    const observed = expect(pending).rejects.toThrow(); await vi.advanceTimersByTimeAsync(30000); await observed;
    gate.resolve(f.device); await flush(); expect(f.stops).toHaveBeenCalled();
  });
});

class BrowserSocket {
  readyState = 0; bufferedAmount = 0; binaryType: BinaryType = 'arraybuffer'; sent: (string | ArrayBuffer)[] = []; closed = false;
  onopen: WebSocket['onopen'] = null; onmessage: WebSocket['onmessage'] = null; onerror: WebSocket['onerror'] = null; onclose: WebSocket['onclose'] = null;
  send(value: string | ArrayBuffer) { this.sent.push(value); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.call(this as any, {} as Event); }
  message(data: unknown) { this.onmessage?.call(this as any, { data: JSON.stringify(data) } as MessageEvent); }
}
describe('browser stream protocol', () => {
  it('keeps permission before connection and sends PCM before the single Finish message', async () => {
    const f = fixture(), ws = new BrowserSocket(), connect = vi.fn(() => ws as BrowserLiveSocket), abort = new AbortController();
    const result = streamLiveReference('/api/live-reference', { actionKey: 'invented-key-0001', cue: null }, f.capture, abort.signal, connect, 'http://127.0.0.1:4329');
    await flush(); expect(connect).toHaveBeenCalledOnce(); ws.open();
    expect(ws.sent).toEqual([JSON.stringify({ type: 'start', actionKey: 'invented-key-0001', cue: null })]);
    expect(f.begin).not.toHaveBeenCalled(); ws.message({ type: 'ready', maxSeconds: 20 }); f.feed(120000); expect(ws.sent.length).toBeGreaterThan(2);
    f.capture.finish(); await flush(); expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: 'finish' }));
    ws.message({ type: 'complete' }); await result; expect(ws.closed).toBe(true);
  });
  it('does not open any connection when permission fails', async () => {
    const denied = Promise.reject(new Error('invented denied')); void denied.catch(() => {});
    const f = fixture(denied), connect = vi.fn();
    await expect(streamLiveReference('/api/live-reference', { actionKey: 'invented-key-0001', cue: null }, f.capture, new AbortController().signal, connect, 'http://127.0.0.1:4329')).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([0, 1])('includes the next raw PCM payload at the browser queue boundary (+%i byte)', async over => {
    const f = fixture(), ws = new BrowserSocket(), abort = new AbortController();
    const result = streamLiveReference('/api/live-reference', { actionKey: 'invented-key-0001', cue: null }, f.capture, abort.signal, () => ws as BrowserLiveSocket, 'http://127.0.0.1:4329');
    await flush(); ws.open(); ws.message({ type: 'ready', maxSeconds: 20 }); ws.bufferedAmount = L.maxQueuedBytes - 8192 + over; f.feed(4096);
    if (!over) { expect(ws.sent.filter(s => s instanceof ArrayBuffer)).toHaveLength(1); abort.abort(); }
    await expect(result).rejects.toThrow(); if (over) expect(ws.sent.filter(s => s instanceof ArrayBuffer)).toHaveLength(0);
    expect(ws.closed).toBe(true);
  });
  it.each([0, 1])('uses UTF-8 bytes for start control payloads at the queue boundary (+%i byte)', async over => {
    const f = fixture(), ws = new BrowserSocket(), abort = new AbortController(), input = { actionKey: 'invented-key-0001', cue: 'é'.repeat(100) };
    const start = JSON.stringify({ type: 'start', ...input }); ws.bufferedAmount = L.maxQueuedBytes - new TextEncoder().encode(start).length + over;
    const result = streamLiveReference('/api/live-reference', input, f.capture, abort.signal, () => ws as BrowserLiveSocket, 'http://127.0.0.1:4329');
    await flush(); ws.open();
    expect(ws.sent.includes(start)).toBe(!over); if (!over) abort.abort(); await expect(result).rejects.toThrow();
  });
  it('never sends Finish or Cancel above the browser queue cap', async () => {
    const f = fixture(), ws = new BrowserSocket(), abort = new AbortController();
    const result = streamLiveReference('/api/live-reference', { actionKey: 'invented-key-0001', cue: null }, f.capture, abort.signal, () => ws as BrowserLiveSocket, 'http://127.0.0.1:4329');
    await flush(); ws.open(); ws.message({ type: 'ready', maxSeconds: 20 }); f.feed(120000); ws.bufferedAmount = L.maxQueuedBytes;
    f.capture.finish(); await expect(result).rejects.toThrow();
    expect(ws.sent.filter(s => typeof s === 'string').some(s => /"type":"(?:finish|cancel)"/.test(s as string))).toBe(false);
  });
  it('cancels both transports on Stop and never reconnects after a late ready message', async () => {
    const f = fixture(), ws = new BrowserSocket(), connect = vi.fn(() => ws as BrowserLiveSocket), abort = new AbortController();
    const result = streamLiveReference('/api/live-reference', { actionKey: 'invented-key-0001', cue: null }, f.capture, abort.signal, connect, 'http://127.0.0.1:4329');
    await flush(); ws.open(); abort.abort(); await expect(result).rejects.toMatchObject({ code: 'aborted' }); ws.message({ type: 'ready', maxSeconds: 20 });
    expect(f.stops).toHaveBeenCalled(); expect(f.begin).not.toHaveBeenCalled(); expect(ws.closed).toBe(true); expect(connect).toHaveBeenCalledOnce();
  });
});

const blank = (): SafeSnapshot => ({ mode: 'live', liveListening: { maxSeconds: 20 }, session: null, stage: 'idle', revision: 0, status: null, attempt: null, reference: null,
  listenerCue: null, analysis: null, brief: null, identity: null, connection: null, panel: null, history: [], refinement: null, code: null });
const owned = (): SafeSnapshot => ({ ...blank(), session: { context: 'invented-session-context', expiresAt: Date.now() + 3600000 } });
const ended = (): SafeSnapshot => ({ ...owned(), stage: 'awaiting_preference', revision: 2, reference: { kind: 'streamed', receipt: 'S'.repeat(24) as Handle } });
describe('Live owns the ordinary client operation slot', () => {
  async function controller() {
    const no = vi.fn(async () => owned()), result = deferred<SafeSnapshot>();
    const api = { state: no, createSession: no, reference: no, preference: no, artistChoice: no, feedback: no, discover: no, refine: no, stop: no, clear: vi.fn(async () => blank()),
      liveReference: vi.fn<NonNullable<ApiPort['liveReference']>>(() => result.promise) } satisfies ApiPort;
    const c = new SessionController(api, { maxWatchReads: 0, watchIntervalMs: 1000000 }); controllers.push(c); c.activate(); await c.refresh();
    return { c, api, result };
  }
  it.each(['stop', 'clear', 'dispose'] as const)('%s cancels capture immediately and a late result cannot resurrect it', async reason => {
    const f = await controller(), capture = fixture().capture, cancel = vi.spyOn(capture, 'cancel');
    const sent = f.c.submitLive(capture, null); expect(sent.accepted).toBe(true); expect(f.api.liveReference).toHaveBeenCalledOnce();
    expect(f.c.submitLive(fixture().capture, null).accepted).toBe(false);
    if (reason === 'dispose') f.c.dispose(); else await f.c[reason]();
    expect(cancel).toHaveBeenCalled(); expect(f.api.liveReference.mock.calls[0]![2].aborted).toBe(true);
    f.result.resolve(ended()); await sent.done; expect(f.c.getView().snapshot?.reference).toBeNull();
  });
  it('validates the distinct safe DTO and refuses fake duration/digest/configuration fields', () => {
    expect(isSafeSnapshot(ended())).toBe(true);
    for (const change of [{ reference: { ...ended().reference, sha256: 'a'.repeat(64) } }, { liveListening: { maxSeconds: 60 } }, { mode: 'synthetic' }]) expect(isSafeSnapshot({ ...ended(), ...change })).toBe(false);
  });
});
