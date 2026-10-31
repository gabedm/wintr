import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { browserMusicCapturePort, createMusicCapture, type CaptureDevice, type CaptureProcessor, type MusicCapture, type MusicCapturePort } from '../src/client/music-capture.js';
import { inspectPcmWav, RECORDING } from '../src/shared/recording.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const captures: MusicCapture[] = [];
const own = (capture: MusicCapture) => { captures.push(capture); return capture; };

class Device implements CaptureDevice {
  stops = 0;
  watching = 0;
  interruption: (() => void) | null = null;
  constructor(private readonly events: string[]) {}
  stop() { this.stops++; this.events.push('device-stop'); }
  watchInterruption(callback: () => void) {
    this.interruption = callback; this.watching++;
    return () => { this.watching--; };
  }
}
class Processor implements CaptureProcessor {
  sampleRate: number = RECORDING.sampleRate;
  preparation = Promise.resolve();
  begins = 0; disconnects = 0; finishes = 0; closes = 0; frames = 0;
  constructor(readonly message: (value: unknown) => void, readonly fault: () => void, readonly events: string[]) {}
  prepare() { return this.preparation; }
  begin() { this.begins++; }
  disconnectInput() { this.disconnects++; this.events.push('disconnect'); }
  finish() { this.finishes++; this.events.push('finish'); }
  close() { this.closes++; this.events.push('processor-close'); }
  feed(frames: number, value = 0.25) {
    while (frames > 0) {
      const count = Math.min(frames, 4096), samples = new Float32Array(count).fill(value);
      this.frames += count; this.message({ type: 'frames', samples });
      expect(samples.every(sample => sample === 0)).toBe(true); // Received scratch batches are not retained.
      frames -= count;
    }
  }
  ack(frames = this.frames) { this.message({ type: 'stopped', frames }); }
}
function fixture(options: { permission?: Promise<CaptureDevice>; preparation?: Promise<void>; rate?: number; ttl?: number } = {}) {
  const events: string[] = [], device = new Device(events), processors: Processor[] = [];
  let revoke = () => {}, visible = true, unwatches = 0;
  let requestedDevices = 0;
  const request = vi.fn(() => options.permission ?? Promise.resolve(requestedDevices++ === 0 ? device : new Device(events)));
  const port: MusicCapturePort = {
    requestDevice: request,
    createProcessor(_device, message, fault) {
      const processor = new Processor(message, fault, events);
      processor.preparation = options.preparation ?? Promise.resolve();
      processor.sampleRate = options.rate ?? RECORDING.sampleRate;
      processors.push(processor); return processor;
    },
    now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    isVisible: () => visible,
    watchRevocation(callback) { revoke = callback; return () => { unwatches++; }; },
  };
  const capture = own(createMusicCapture({ port, readyTtlMs: options.ttl }));
  return { capture, device, processors, request, events, port, hide: () => { visible = false; revoke(); }, unwatches: () => unwatches };
}
async function ready(f: ReturnType<typeof fixture>, frames: number = RECORDING.minFrames) {
  await f.capture.start(); const processor = f.processors[0]!;
  processor.feed(frames);
  const stopped = f.capture.stop(); processor.ack(); await stopped;
  return processor;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1000); });
afterEach(async () => {
  try {
    for (const capture of captures.splice(0)) capture.dispose();
    await flush(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe('one-owner local microphone engine', () => {
  it('prepares metadata without consuming the ready clip or exposing raw snapshot data', async () => {
    const f = fixture(); await ready(f); const before = f.capture.getSnapshot();
    const metadata = await f.capture.readyMetadata();
    expect(f.capture.getSnapshot()).toBe(before);
    const bytes = f.capture.takeBytes()!;
    expect(metadata).toEqual({ sha256: createHash('sha256').update(bytes).digest('hex'), frames: RECORDING.minFrames });
    expect(await f.capture.readyMetadata()).toBeNull();
  });
  it('does not extend ready retention when checking its metadata', async () => {
    const f = fixture({ ttl: 2000 }); await ready(f); await vi.advanceTimersByTimeAsync(1000);
    expect(await f.capture.readyMetadata()).not.toBeNull(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.capture.getSnapshot().error).toBe('ready_expired'); expect(await f.capture.readyMetadata()).toBeNull();
  });
  it('zeros an app-owned hash copy immediately on cancel, and ignores its late digest', async () => {
    const f = fixture(); await ready(f); const gate = deferred<ArrayBuffer>(); let copy: Uint8Array | null = null;
    vi.stubGlobal('crypto', { subtle: { digest: (_name: string, buffer: ArrayBuffer) => { copy = new Uint8Array(buffer); return gate.promise; } } });
    const metadata = f.capture.readyMetadata(); expect(await f.capture.readyMetadata()).toBeNull();
    f.capture.cancel(); expect(copy).not.toBeNull(); expect((copy as unknown as Uint8Array).every(b => b === 0)).toBe(true);
    gate.resolve(new ArrayBuffer(32)); expect(await metadata).toBeNull();
  });
  it('allows metadata for a replacement clip while a cancelled digest remains held', async () => {
    const f = fixture(); await ready(f); const held = deferred<ArrayBuffer>();
    const digest = vi.fn().mockImplementationOnce(() => held.promise).mockResolvedValue(new ArrayBuffer(32));
    vi.stubGlobal('crypto', { subtle: { digest } });
    const old = f.capture.readyMetadata(); f.capture.cancel();
    await f.capture.start(); const processor = f.processors.at(-1)!; processor.feed(RECORDING.minFrames);
    const stopping = f.capture.stop(); processor.ack(); await stopping;
    expect(await f.capture.readyMetadata()).toEqual({ sha256: '0'.repeat(64), frames: RECORDING.minFrames });
    expect(digest).toHaveBeenCalledTimes(2); held.resolve(new ArrayBuffer(32)); expect(await old).toBeNull();
  });
  it('does nothing on construction/subscription and never exposes raw data in snapshots', async () => {
    const f = fixture(), notice = vi.fn(); const unwatch = f.capture.subscribe(notice);
    expect(f.request).not.toHaveBeenCalled(); expect(f.processors).toHaveLength(0);
    expect(f.capture.getSnapshot()).toEqual({ phase: 'idle', durationMs: 0, error: null });
    await f.capture.start(); f.processors[0]!.feed(2400);
    const snapshot = f.capture.getSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['durationMs', 'error', 'phase']);
    expect(Object.isFrozen(snapshot)).toBe(true); expect(snapshot.durationMs).toBe(100); expect(notice).toHaveBeenCalled();
    unwatch(); const count = notice.mock.calls.length; f.capture.cancel(); expect(notice).toHaveBeenCalledTimes(count);
  });
  it('names permission denial without reflecting an error body', async () => {
    const gate = deferred<CaptureDevice>(), f = fixture({ permission: gate.promise });
    const starting = f.capture.start(); expect(f.capture.getSnapshot().phase).toBe('permission');
    gate.reject(new DOMException('invented private detail', 'NotAllowedError')); await starting;
    expect(f.capture.getSnapshot()).toEqual({ phase: 'error', durationMs: 0, error: 'permission_denied' });
    expect(f.processors).toHaveLength(0);
  });
  it('settles hung permission at its bound and stops a later returned stream', async () => {
    const gate = deferred<CaptureDevice>(), f = fixture({ permission: gate.promise });
    const starting = f.capture.start(); await vi.advanceTimersByTimeAsync(30000); await starting;
    expect(f.capture.getSnapshot().error).toBe('permission_timeout');
    gate.resolve(f.device); await flush(); expect(f.device.stops).toBe(1); expect(f.processors).toHaveLength(0);
  });
  it.each(['cancel', 'stop', 'dispose'] as const)('%s during pending permission settles and releases a late grant', async action => {
    const gate = deferred<CaptureDevice>(), f = fixture({ permission: gate.promise });
    const starting = f.capture.start(); await f.capture[action](); await starting;
    gate.resolve(f.device); await flush();
    expect(f.device.stops).toBe(1); expect(f.processors).toHaveLength(0);
    expect(f.capture.getSnapshot().phase).toBe(action === 'dispose' ? 'disposed' : 'idle');
  });
  it('owns processor resources while async preparation is held and ignores its late completion', async () => {
    const gate = deferred<void>(), f = fixture({ preparation: gate.promise });
    const starting = f.capture.start(); await flush(); const p = f.processors[0]!;
    expect(f.capture.getSnapshot().phase).toBe('preparing'); f.capture.cancel(); await starting;
    expect(p.closes).toBe(1); expect(f.device.stops).toBe(1); expect(f.device.watching).toBe(0);
    gate.resolve(); await flush(); expect(p.begins).toBe(0); expect(f.capture.getSnapshot().phase).toBe('idle');
  });
  it('fails bounded preparation and releases input/context before a late rejection', async () => {
    const gate = deferred<void>(), f = fixture({ preparation: gate.promise });
    const starting = f.capture.start(); await flush(); await vi.advanceTimersByTimeAsync(30000); await starting;
    expect(f.capture.getSnapshot().error).toBe('preparation_timeout');
    expect(f.processors[0]!.closes).toBe(1); expect(f.device.stops).toBe(1);
    gate.reject(new Error('invented preparation failure')); await flush();
    expect(f.capture.getSnapshot().error).toBe('preparation_timeout');
  });
  it('rejects a mismatched actual context rate before preparation or capture', async () => {
    const f = fixture({ rate: 48000 }); await f.capture.start();
    expect(f.capture.getSnapshot().error).toBe('unsupported_sample_rate');
    expect(f.device.stops).toBe(1); expect(f.processors[0]!.begins).toBe(0); expect(f.processors[0]!.closes).toBe(1);
  });
  it('releases input immediately on Stop, flushes existing samples, then transfers exactly once', async () => {
    const f = fixture(); await f.capture.start(); const p = f.processors[0]!;
    p.feed(RECORDING.minFrames - 17); const stopping = f.capture.stop();
    expect(f.device.stops).toBe(1); expect(f.device.watching).toBe(0); expect(p.disconnects).toBeGreaterThan(0);
    expect(f.events.indexOf('device-stop')).toBeLessThan(f.events.indexOf('finish'));
    expect(f.capture.getSnapshot().phase).toBe('finalising'); expect(f.capture.takeBytes()).toBeNull();
    p.feed(17); p.ack(); await stopping;
    expect(f.capture.getSnapshot()).toEqual({ phase: 'ready', durationMs: 5000, error: null });
    const bytes = f.capture.takeBytes()!, before = bytes.slice();
    expect(inspectPcmWav(bytes).frames).toBe(120000); expect(f.capture.takeBytes()).toBeNull();
    f.capture.cancel(); f.capture.dispose(); expect(bytes).toEqual(before); expect(p.closes).toBe(1); expect(f.device.stops).toBe(1);
  });
  it('reports too-short PCM honestly after flushing and exposes no clip', async () => {
    const f = fixture(); await ready(f, RECORDING.minFrames - 1);
    expect(f.capture.getSnapshot().error).toBe('recording_too_short'); expect(f.capture.takeBytes()).toBeNull();
    expect(f.processors[0]!.closes).toBe(1); expect(f.device.stops).toBe(1);
  });
  it('ends a missing flush acknowledgement at one second; a late completion cannot become ready', async () => {
    const f = fixture(); await f.capture.start(); const p = f.processors[0]!; p.feed(RECORDING.minFrames);
    const stopping = f.capture.stop(); await vi.advanceTimersByTimeAsync(1000); await stopping;
    expect(f.capture.getSnapshot().error).toBe('flush_timeout'); expect(p.closes).toBe(1);
    p.ack(); expect(f.capture.getSnapshot().error).toBe('flush_timeout'); expect(f.capture.takeBytes()).toBeNull();
  });
  it('bounds elapsed capture independently of PCM duration and flushes without fabricating seconds', async () => {
    const f = fixture(); await f.capture.start(); const p = f.processors[0]!; p.feed(RECORDING.minFrames);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.device.stops).toBe(1); expect(p.finishes).toBe(1); expect(f.capture.getSnapshot().phase).toBe('finalising');
    p.ack(); expect(f.capture.getSnapshot().durationMs).toBe(5000);
  });
  it('accepts the exact processor frame ceiling and rejects a received overflow', async () => {
    const f = fixture(); await f.capture.start(); const p = f.processors[0]!; p.feed(RECORDING.maxFrames); p.ack();
    expect(inspectPcmWav(f.capture.takeBytes()!).durationMs).toBe(60000); expect(f.device.stops).toBe(1);
    const g = fixture(); await g.capture.start(); const q = g.processors[0]!; q.feed(RECORDING.maxFrames); q.feed(1); q.ack();
    expect(g.capture.getSnapshot().error).toBe('recording_invalid'); expect(g.capture.takeBytes()).toBeNull(); expect(q.closes).toBe(1);
  });
  it.each(['device', 'processor'] as const)('releases all resources on %s interruption; stale events cannot resurrect another generation', async cause => {
    const f = fixture(); await f.capture.start(); const p = f.processors[0]!;
    if (cause === 'device') f.device.interruption!(); else p.fault();
    expect(f.capture.getSnapshot().error).toBe('capture_interrupted'); expect(p.closes).toBe(1); expect(f.device.watching).toBe(0);
    await f.capture.start(); const current = f.capture.getSnapshot(); p.feed(12); p.ack(); p.fault();
    expect(f.capture.getSnapshot()).toBe(current); expect(f.processors[1]!.closes).toBe(0);
  });
  it('rejects malformed/nonfinite batches, forged stop counts and early unsolicited completion', async () => {
    for (const message of [{ type: 'frames', samples: new Float32Array(4097) }, { type: 'frames', samples: new Float32Array([NaN]) }, { type: 'stopped', frames: 0 }, { type: 'frames', samples: new Float32Array(1), extra: true }]) {
      const f = fixture(); await f.capture.start(); f.processors[0]!.message(message);
      expect(f.capture.getSnapshot().error).toBe('recording_invalid'); expect(f.device.stops).toBe(1);
    }
    const f = fixture(); await f.capture.start(); f.processors[0]!.feed(RECORDING.minFrames); const stopping = f.capture.stop(); f.processors[0]!.ack(1); await stopping;
    expect(f.capture.getSnapshot().error).toBe('recording_invalid');
  });
  it('discards untransferred ready bytes on hidden/revocation and never starts while hidden', async () => {
    const f = fixture(); await ready(f); f.hide();
    expect(f.capture.getSnapshot().phase).toBe('idle'); expect(f.capture.takeBytes()).toBeNull();
    await f.capture.start(); expect(f.request).toHaveBeenCalledTimes(1); expect(f.capture.getSnapshot().error).toBe('capture_interrupted');
  });
  it('bounds ready retention before a Session exists and refuses elapsed/clock-invalid transfers', async () => {
    const f = fixture({ ttl: 2000 }); await ready(f); await vi.advanceTimersByTimeAsync(2000);
    expect(f.capture.getSnapshot().error).toBe('ready_expired'); expect(f.capture.takeBytes()).toBeNull();
    const g = fixture(); await ready(g); vi.setSystemTime(0);
    expect(g.capture.takeBytes()).toBeNull(); expect(g.capture.getSnapshot().error).toBe('ready_expired');
    expect(() => createMusicCapture({ port: g.port, readyTtlMs: 3600001 })).toThrow(RangeError);
  });
  it('tolerates cleanup faults and subscription-time cancellation without new permission/preparation', async () => {
    const f = fixture(); f.capture.subscribe(() => { if (f.capture.getSnapshot().phase === 'permission') f.capture.cancel(); });
    await f.capture.start(); expect(f.request).not.toHaveBeenCalled();
    const g = fixture(); await g.capture.start(); const p = g.processors[0]!;
    p.close = () => { p.closes++; throw new Error('invented cleanup fault'); };
    g.capture.dispose(); expect(g.device.stops).toBe(1); expect(g.unwatches()).toBe(1);
    await g.capture.start(); expect(g.request).toHaveBeenCalledTimes(1); expect(g.capture.getSnapshot().phase).toBe('disposed');
  });
  it('cleans resources acquired during synchronous interruption or cancellation callbacks', async () => {
    const f = fixture(), removed = vi.fn();
    f.device.watchInterruption = callback => { callback(); return removed; };
    await f.capture.start(); expect(removed).toHaveBeenCalledTimes(1); expect(f.device.stops).toBe(1); expect(f.processors).toHaveLength(0);
    const g = fixture(); let acquired!: Processor;
    g.port.createProcessor = (_device, message, fault) => { acquired = new Processor(message, fault, g.events); fault(); return acquired; };
    await g.capture.start(); expect(acquired.closes).toBe(1); expect(g.device.stops).toBe(1); expect(g.capture.getSnapshot().error).toBe('capture_interrupted');
    const h = fixture(); h.capture.subscribe(() => { if (h.capture.getSnapshot().phase === 'preparing') h.capture.cancel(); });
    await h.capture.start(); expect(h.processors[0]!.begins).toBe(0); expect(h.processors[0]!.closes).toBe(1); expect(h.capture.getSnapshot().phase).toBe('idle');
  });
  it('cancels a pending Stop and drops later chunks/faults/ack without resurrecting ready audio', async () => {
    const f = fixture(); await f.capture.start(); const p = f.processors[0]!; p.feed(RECORDING.minFrames);
    const stopping = f.capture.stop(); f.capture.discard(); await stopping;
    const snapshot = f.capture.getSnapshot(); p.feed(7); p.ack(); p.fault();
    expect(f.capture.getSnapshot()).toBe(snapshot); expect(snapshot.phase).toBe('idle'); expect(f.capture.takeBytes()).toBeNull();
    expect(p.closes).toBe(1); expect(f.device.stops).toBe(1);
  });
  it('does not publish ready/error after cleanup itself causes cancellation, and idle cancellation is a no-op', async () => {
    const f = fixture(); await f.capture.start(); const p = f.processors[0]!; p.feed(RECORDING.minFrames);
    const stopping = f.capture.stop(); p.close = () => { p.closes++; f.capture.cancel(); }; p.ack(); await stopping;
    expect(f.capture.getSnapshot().phase).toBe('idle'); expect(f.capture.takeBytes()).toBeNull();
    const snapshot = f.capture.getSnapshot(), notice = vi.fn(); f.capture.subscribe(notice); f.capture.cancel();
    expect(f.capture.getSnapshot()).toBe(snapshot); expect(notice).not.toHaveBeenCalled();
    const g = fixture(); await g.capture.start(); const q = g.processors[0]!;
    q.close = () => { q.closes++; g.capture.cancel(); }; q.fault();
    expect(g.capture.getSnapshot().phase).toBe('idle');
  });
});

// These are fake native objects; no browser, permission or device API runs.
function fakeBrowser(module: Promise<void> = Promise.resolve()) {
  const contexts: FakeContext[] = [], nodes: FakeNode[] = [];
  const track = new EventTarget() as EventTarget & { stop: ReturnType<typeof vi.fn>; readyState: string };
  track.stop = vi.fn(); track.readyState = 'live';
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const getUserMedia = vi.fn(async () => stream);
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' }), window = new EventTarget();
  class FakeContext extends EventTarget {
    sampleRate = 24000; state = 'suspended'; destination = {};
    input = { connect: vi.fn(), disconnect: vi.fn() };
    audioWorklet = { addModule: vi.fn(() => module) };
    close = vi.fn(async () => { this.state = 'closed'; });
    resume = vi.fn(async () => { this.state = 'running'; });
    constructor(readonly options: unknown) { super(); contexts.push(this); }
    createMediaStreamSource = vi.fn(() => this.input);
  }
  class FakeNode {
    port = { onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: vi.fn(), close: vi.fn() };
    onprocessorerror: (() => void) | null = null;
    connect = vi.fn(); disconnect = vi.fn();
    constructor(readonly context: unknown, readonly name: string, readonly options: unknown) { nodes.push(this); }
  }
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('AudioContext', FakeContext); vi.stubGlobal('AudioWorkletNode', FakeNode);
  return { contexts, nodes, track, getUserMedia, document, window };
}
describe('default browser resource composition over fake native objects', () => {
  it('requests only explicitly, binds self-hosted mono processing and cleans tracks/port/nodes/context', async () => {
    const f = fakeBrowser(), capture = own(createMusicCapture({ port: browserMusicCapturePort() }));
    expect(f.getUserMedia).not.toHaveBeenCalled(); expect(f.contexts).toHaveLength(0);
    await capture.start();
    expect(f.getUserMedia).toHaveBeenCalledWith({ video: false, audio: { channelCount: 1, sampleRate: 24000, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    expect(f.contexts[0]!.options).toEqual({ sampleRate: 24000 });
    expect(f.contexts[0]!.audioWorklet.addModule).toHaveBeenCalledWith(new URL('../src/client/recording-worklet.js', import.meta.url).href);
    expect(f.nodes[0]!.name).toBe('wintr-recording'); expect(f.nodes[0]!.options).toMatchObject({ channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] });
    f.window.dispatchEvent(new Event('pagehide'));
    expect(capture.getSnapshot().phase).toBe('idle'); expect(f.track.stop).toHaveBeenCalledTimes(1);
    expect(f.nodes[0]!.port.close).toHaveBeenCalledTimes(1); expect(f.nodes[0]!.disconnect).toHaveBeenCalled(); expect(f.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(f.nodes[0]!.port.onmessage).toBeNull(); expect(f.nodes[0]!.onprocessorerror).toBeNull();
  });
  it('closes context while module preparation is held and cannot create a node on late completion', async () => {
    const gate = deferred<void>(), f = fakeBrowser(gate.promise), capture = own(createMusicCapture());
    const starting = capture.start(); await flush(); expect(capture.getSnapshot().phase).toBe('preparing');
    capture.cancel(); await starting; expect(f.contexts[0]!.close).toHaveBeenCalledTimes(1); expect(f.track.stop).toHaveBeenCalledTimes(1);
    gate.resolve(); await flush(); expect(f.nodes).toHaveLength(0); expect(f.contexts[0]!.resume).not.toHaveBeenCalled();
  });
  it('keeps only the port alive for explicit Stop flush, then closes all fake native resources', async () => {
    const f = fakeBrowser(), capture = own(createMusicCapture()); await capture.start();
    const node = f.nodes[0]!;
    for (let frames = RECORDING.minFrames; frames > 0;) {
      const count = Math.min(frames, 4096); node.port.onmessage!({ data: { type: 'frames', samples: new Float32Array(count).fill(0.5) } }); frames -= count;
    }
    const stopping = capture.stop();
    expect(f.track.stop).toHaveBeenCalledTimes(1); expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'stop' });
    expect(node.port.close).not.toHaveBeenCalled(); expect(f.contexts[0]!.close).not.toHaveBeenCalled();
    node.port.onmessage!({ data: { type: 'stopped', frames: RECORDING.minFrames } }); await stopping;
    expect(capture.getSnapshot().phase).toBe('ready'); expect(node.port.close).toHaveBeenCalledTimes(1); expect(f.contexts[0]!.close).toHaveBeenCalledTimes(1);
    expect(inspectPcmWav(capture.takeBytes()!).durationMs).toBe(5000);
  });
  it('refuses insecure capture without asking permission and stops on processor/context/mute failures', async () => {
    const f = fakeBrowser(); vi.stubGlobal('isSecureContext', false); const unavailable = own(createMusicCapture()); await unavailable.start();
    expect(unavailable.getSnapshot().error).toBe('capture_unavailable'); expect(f.getUserMedia).not.toHaveBeenCalled();
    vi.stubGlobal('isSecureContext', true);
    for (const cause of ['processor', 'context', 'mute']) {
      const capture = own(createMusicCapture()); await capture.start(); const c = f.contexts.at(-1)!;
      if (cause === 'processor') f.nodes.at(-1)!.onprocessorerror!();
      else if (cause === 'context') { c.state = 'suspended'; c.dispatchEvent(new Event('statechange')); }
      else f.track.dispatchEvent(new Event('mute'));
      expect(capture.getSnapshot().error).toBe('capture_interrupted'); expect(c.close).toHaveBeenCalledTimes(1);
    }
  });
});

interface Worklet {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
function worklet(rate = 24000) {
  const messages: { type: string; samples?: Float32Array; frames?: number }[] = [];
  let Constructor!: new () => Worklet;
  class Base { port = { onmessage: null, postMessage: (value: typeof messages[number]) => { messages.push(value); } }; }
  runInNewContext(readFileSync(new URL('../src/client/recording-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: Base, sampleRate: rate, Float32Array,
    registerProcessor: (name: string, type: typeof Constructor) => { expect(name).toBe('wintr-recording'); Constructor = type; },
  });
  return { processor: new Constructor(), messages };
}
describe('actual static worklet over VM audio globals', () => {
  it('counts variable quantum frames, flushes partial batches in order and outputs only zeros', () => {
    const { processor, messages } = worklet(); let frames = 0;
    for (const count of [17, 5000, 3, 127, 288]) {
      const input = new Float32Array(count).fill(0.75), output = new Float32Array(count).fill(1);
      expect(processor.process([[input]], [[output]])).toBe(true); expect(output.every(n => n === 0)).toBe(true); frames += count;
    }
    processor.port.onmessage!({ data: { type: 'stop' } });
    expect(messages.at(-1)).toEqual({ type: 'stopped', frames });
    expect(messages.filter(m => m.type === 'frames').reduce((n, m) => n + m.samples!.length, 0)).toBe(frames);
    expect(messages.filter(m => m.type === 'frames').every(m => m.samples!.length <= 4096 && m.samples!.every(n => n === 0.75))).toBe(true);
    const count = messages.length; processor.port.onmessage!({ data: { type: 'stop' } }); expect(messages).toHaveLength(count);
  });
  it('caps exactly at the shared frame ceiling even when a quantum crosses it', () => {
    const { processor, messages } = worklet(); const quantum = new Float32Array(997).fill(-0.5);
    let active = true; for (let i = 0; active && i < 2000; i++) active = processor.process([[quantum]], [[new Float32Array(997).fill(1)]]);
    expect(active).toBe(false); expect(messages.at(-1)).toEqual({ type: 'stopped', frames: RECORDING.maxFrames });
    expect(messages.filter(m => m.type === 'frames').reduce((n, m) => n + m.samples!.length, 0)).toBe(RECORDING.maxFrames);
    const count = messages.length; const output = new Float32Array(17).fill(1);
    expect(processor.process([[quantum]], [[output]])).toBe(false); expect(output.every(n => n === 0)).toBe(true); expect(messages).toHaveLength(count);
  });
  it('fails closed on wrong rate, nonfinite samples or multiple input channels and cancels without a clip', () => {
    expect(worklet(48000).messages).toEqual([{ type: 'fault' }]);
    for (const input of [[new Float32Array([NaN])], [new Float32Array(4), new Float32Array(4)]]) {
      const { processor, messages } = worklet(); expect(processor.process([input], [[new Float32Array(4)]])).toBe(false);
      expect(messages).toEqual([{ type: 'fault' }]);
    }
    const { processor, messages } = worklet(); processor.process([[new Float32Array(12)]], [[]]);
    processor.port.onmessage!({ data: { type: 'cancel' } }); processor.port.onmessage!({ data: { type: 'stop' } });
    expect(messages).toEqual([]); expect(processor.process([], [[]])).toBe(false);
  });
});
