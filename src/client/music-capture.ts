import { encodePcmWav, inspectPcmWav, RECORDING, RecordingFormatError, type RecordingProblem } from '../shared/recording.js';

// Local capture only. Importing/constructing this module never requests a device.
// The parent must cancel on Session/chat/wipe changes; no audio belongs in its
// per-chat drafts, snapshots, retry state or persistent storage.
export type MusicCapturePhase = 'idle' | 'permission' | 'preparing' | 'recording' | 'finalising' | 'ready' | 'consumed' | 'error' | 'disposed';
export type MusicCaptureProblem = RecordingProblem | 'permission_denied' | 'capture_unavailable' | 'permission_timeout'
  | 'preparation_timeout' | 'unsupported_sample_rate' | 'capture_failed' | 'capture_interrupted' | 'flush_timeout' | 'ready_expired';
export interface MusicCaptureSnapshot {
  readonly phase: MusicCapturePhase;
  /** Derived from received PCM frames, never permission time or a pretend progress clock. */
  readonly durationMs: number;
  readonly error: MusicCaptureProblem | null;
}

export interface CaptureDevice {
  stop(): void;
  watchInterruption(callback: () => void): () => void;
}
export interface CaptureProcessor {
  readonly sampleRate: number;
  /** Resources are already owned before this asynchronous preparation begins. */
  prepare(): Promise<void>;
  begin(): void;
  /** Stop new input immediately, but keep the worklet port alive for its flush. */
  disconnectInput(): void;
  finish(): void;
  close(): void | Promise<void>;
}
export interface MusicCapturePort {
  requestDevice(): Promise<CaptureDevice>;
  createProcessor(device: CaptureDevice, message: (value: unknown) => void, fault: () => void): CaptureProcessor;
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
  isVisible(): boolean;
  watchRevocation(callback: () => void): () => void;
}
export interface MusicCaptureOptions {
  readonly port?: MusicCapturePort;
  /** Also bounds an unsent entry capture before any Session exists. Default: five minutes. */
  readonly readyTtlMs?: number;
}
export interface MusicCapture {
  getSnapshot(): MusicCaptureSnapshot;
  subscribe(listener: () => void): () => void;
  /** Call only from an explicit user action. Settles on recording, failure or cancellation. */
  start(): Promise<void>;
  /** Releases device input now; waits at most one second for existing PCM to flush. */
  stop(): Promise<void>;
  cancel(): void;
  discard(): void;
  dispose(): void;
  /** Explicit metadata preparation only; does not transfer or extend the ready clip. */
  readyMetadata(): Promise<{ readonly sha256: string; readonly frames: number } | null>;
  /** One-use ownership transfer. Later cancel/dispose cannot alter caller-owned bytes. */
  takeBytes(): Uint8Array | null;
}

const PREPARATION_MS = 30_000;
const FLUSH_MS = 1_000;
const MAX_BATCH = 4_096;
const MAX_READY_MS = 60 * 60 * 1_000;
// Vite emits this relative asset under /assets/, which the canonical server serves.
// A bare /recording-worklet.js would receive its HTML fallback in production.
const WORKLET_URL = new URL('./recording-worklet.js', import.meta.url).href;
const safely = (fn: () => unknown) => { try { const result = fn(); if (result instanceof Promise) void result.catch(() => {}); } catch { /* Cleanup never echoes device errors. */ } };

interface Run {
  device: CaptureDevice | null;
  processor: CaptureProcessor | null;
  unwatch: (() => void) | null;
  timers: Set<unknown>;
  samples: Float32Array | null;
  frames: number;
  startedAt: number;
  released: boolean;
  finishing: boolean;
  ended: Promise<void>;
  end(): void;
  cancelled: Promise<null>;
  revoke(): void;
}

/** Fake ports exercise the same owner/flush/TTL engine without a native device. */
export function createMusicCapture(options: MusicCaptureOptions = {}): MusicCapture {
  const port = options.port ?? browserMusicCapturePort();
  const ttl = options.readyTtlMs ?? 5 * 60 * 1_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_READY_MS) throw new RangeError('invalid recording retention bound');
  let snapshot: MusicCaptureSnapshot = Object.freeze({ phase: 'idle', durationMs: 0, error: null });
  let run: Run | null = null;
  let ready: Uint8Array | null = null;
  let readySince = 0;
  let readyUntil = 0;
  let disposed = false;
  const pendingHashes = new Set<Uint8Array>();
  const clearHashes = () => { for (const copy of pendingHashes) copy.fill(0); pendingHashes.clear(); };
  const listeners = new Set<() => void>();
  const stoppedDevices = new WeakSet<CaptureDevice>();
  const publish = (phase: MusicCapturePhase, durationMs = snapshot.durationMs, error: MusicCaptureProblem | null = null) => {
    if (snapshot.phase === phase && snapshot.durationMs === durationMs && snapshot.error === error) return;
    snapshot = Object.freeze({ phase, durationMs, error });
    for (const listener of [...listeners]) safely(listener);
  };
  const stopDevice = (device: CaptureDevice) => {
    if (stoppedDevices.has(device)) return;
    stoppedDevices.add(device); safely(() => device.stop());
  };
  const duration = (r: Run) => r.frames * 1_000 / RECORDING.sampleRate;
  const live = (r: Run) => !disposed && run === r && !r.released;
  const clearTimers = (r: Run) => { for (const t of r.timers) safely(() => port.clearTimeout(t)); r.timers.clear(); };
  const timer = (r: Run, ms: number, fn: () => void) => {
    const t = port.setTimeout(() => { r.timers.delete(t); if (run === r && !disposed) fn(); }, ms);
    r.timers.add(t);
    return t;
  };
  const release = (r: Run) => {
    if (r.released) return;
    r.released = true; clearTimers(r); r.revoke();
    if (r.unwatch) safely(r.unwatch);
    r.unwatch = null;
    if (r.device) stopDevice(r.device);
    if (r.processor) { safely(() => r.processor!.disconnectInput()); safely(() => r.processor!.close()); }
    r.device = null; r.processor = null;
    r.samples?.fill(0); r.samples = null; r.end();
  };
  const dropReady = () => { clearHashes(); ready?.fill(0); ready = null; readySince = 0; readyUntil = 0; };
  const fail = (r: Run, code: MusicCaptureProblem) => {
    if (!live(r)) return;
    const ms = duration(r); release(r);
    if (disposed || run !== r) return;
    run = null; dropReady(); publish('error', ms, code);
  };
  const cancel = () => {
    if (disposed) return;
    const previous = run; run = null;
    if (previous) { clearTimers(previous); release(previous); }
    if (disposed || run !== null) return;
    dropReady(); publish('idle', 0);
  };
  const finish = (r: Run) => {
    if (!live(r)) return;
    try {
      const bytes = encodePcmWav(r.samples!.subarray(0, r.frames));
      const info = inspectPcmWav(bytes);
      const now = port.now();
      if (!Number.isFinite(now) || now < r.startedAt) { bytes.fill(0); fail(r, 'capture_failed'); return; }
      release(r);
      if (disposed || run !== r) { bytes.fill(0); return; }
      ready = bytes; readySince = now; readyUntil = now + ttl;
      // The run remains an identity fence for this one ready buffer, not a resource owner.
      timer(r, ttl, () => { clearTimers(r); run = null; dropReady(); publish('error', 0, 'ready_expired'); });
      publish('ready', info.durationMs);
    } catch (error) { fail(r, error instanceof RecordingFormatError ? error.code : 'recording_invalid'); }
  };
  const stop = (): Promise<void> => {
    const r = run;
    if (!r || disposed || r.released) return Promise.resolve();
    if (snapshot.phase !== 'recording' && snapshot.phase !== 'finalising') { cancel(); return Promise.resolve(); }
    if (r.finishing) return r.ended;
    r.finishing = true; clearTimers(r);
    // Revoke device input before yielding or asking the audio thread to flush.
    if (r.device) stopDevice(r.device);
    if (r.unwatch) safely(r.unwatch);
    r.unwatch = null;
    safely(() => r.processor!.disconnectInput());
    if (!live(r)) return r.ended;
    publish('finalising', duration(r));
    if (!live(r)) return r.ended;
    timer(r, FLUSH_MS, () => fail(r, 'flush_timeout'));
    try { r.processor!.finish(); } catch { fail(r, 'capture_failed'); }
    return r.ended;
  };
  const message = (r: Run, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) { if (live(r)) fail(r, 'recording_invalid'); return; }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const own = (key: string) => { const d = descriptors[key]; return d && Object.hasOwn(d, 'value') ? d.value as unknown : undefined; };
    const chunk = own('samples');
    if (!live(r)) { if (chunk instanceof Float32Array) chunk.fill(0); return; }
    const type = own('type');
    const keys = Reflect.ownKeys(raw);
    const exact = (expected: string) => keys.every(k => typeof k === 'string') && (keys as string[]).sort().join(',') === expected;
    if (type === 'frames' && exact('samples,type') && chunk instanceof Float32Array) {
      if (!r.samples || chunk.length === 0 || chunk.length > MAX_BATCH || r.frames + chunk.length > RECORDING.maxFrames ||
        chunk.some(sample => !Number.isFinite(sample))) { chunk.fill(0); fail(r, 'recording_invalid'); return; }
      r.samples.set(chunk, r.frames); r.frames += chunk.length; chunk.fill(0);
      publish(r.finishing ? 'finalising' : 'recording', duration(r));
      if (!live(r)) return;
      const now = port.now();
      if (!Number.isFinite(now) || now < r.startedAt) { fail(r, 'capture_interrupted'); return; }
      if (now - r.startedAt >= RECORDING.maxFrames * 1_000 / RECORDING.sampleRate) void stop();
    } else if (type === 'stopped' && exact('frames,type')) {
      if (own('frames') !== r.frames || (!r.finishing && r.frames !== RECORDING.maxFrames)) { fail(r, 'recording_invalid'); return; }
      finish(r);
    } else { fail(r, type === 'fault' && exact('type') ? 'capture_failed' : 'recording_invalid'); }
  };
  const start = async () => {
    if (disposed || (run && !run.released)) return;
    cancel();
    if (!port.isVisible()) { publish('error', 0, 'capture_interrupted'); return; }
    let end!: () => void, revoke!: () => void;
    const r: Run = { device: null, processor: null, unwatch: null, timers: new Set(), samples: null, frames: 0,
      startedAt: 0, released: false, finishing: false, ended: new Promise(resolve => { end = resolve; }), end: () => end(),
      cancelled: new Promise(resolve => { revoke = () => resolve(null); }), revoke: () => revoke() };
    run = r; publish('permission', 0);
    if (!live(r)) return;
    try {
      timer(r, PREPARATION_MS, () => fail(r, 'permission_timeout'));
      const requested = port.requestDevice();
      // getUserMedia has no app-owned cancellation primitive: a late grant is stopped on arrival.
      requested.then(device => { if (!live(r)) stopDevice(device); }, () => {});
      const device = await Promise.race([requested, r.cancelled]);
      if (!device || !live(r)) { if (device) stopDevice(device); return; }
      clearTimers(r); r.device = device;
      const unwatchDevice = device.watchInterruption(() => { if (!r.finishing) fail(r, 'capture_interrupted'); });
      if (!live(r)) { safely(unwatchDevice); return; }
      r.unwatch = unwatchDevice;
      const processor = port.createProcessor(device, value => message(r, value), () => fail(r, 'capture_interrupted'));
      if (!live(r)) { safely(() => processor.disconnectInput()); safely(() => processor.close()); return; }
      r.processor = processor;
      if (r.processor.sampleRate !== RECORDING.sampleRate) { fail(r, 'unsupported_sample_rate'); return; }
      publish('preparing', 0);
      if (!live(r)) return;
      timer(r, PREPARATION_MS, () => fail(r, 'preparation_timeout'));
      await Promise.race([r.processor.prepare(), r.cancelled]);
      if (!live(r)) return;
      clearTimers(r); r.startedAt = port.now();
      if (!Number.isFinite(r.startedAt) || r.startedAt < 0) { fail(r, 'capture_failed'); return; }
      r.samples = new Float32Array(RECORDING.maxFrames);
      timer(r, RECORDING.maxFrames * 1_000 / RECORDING.sampleRate, () => { void stop(); });
      publish('recording', 0);
      if (!live(r)) return;
      r.processor.begin();
    } catch (error) {
      const name = error instanceof DOMException || error instanceof Error ? error.name : '';
      fail(r, snapshot.phase === 'permission'
        ? name === 'NotAllowedError' || name === 'SecurityError' ? 'permission_denied'
          : name === 'NotFoundError' || name === 'NotSupportedError' ? 'capture_unavailable' : 'capture_failed'
        : 'capture_failed');
    }
  };
  const unwatch = port.watchRevocation(cancel);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    start, stop, cancel, discard: cancel,
    async readyMetadata() {
      if (disposed || !ready || snapshot.phase !== 'ready' || pendingHashes.size > 0) return null;
      const original = ready, copy = Uint8Array.from(ready);
      pendingHashes.add(copy);
      try {
        const info = inspectPcmWav(copy);
        const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
        const now = port.now();
        if (disposed || ready !== original || snapshot.phase !== 'ready' || !Number.isFinite(now) || now < readySince || now >= readyUntil) return null;
        return Object.freeze({ sha256: [...hash].map(b => b.toString(16).padStart(2, '0')).join(''), frames: info.frames });
      } catch { return null; }
      finally { pendingHashes.delete(copy); copy.fill(0); }
    },
    takeBytes() {
      const now = port.now();
      if (disposed || !ready || snapshot.phase !== 'ready') return null;
      if (!Number.isFinite(now) || now < readySince || now >= readyUntil) { if (run) clearTimers(run); run = null; dropReady(); publish('error', 0, 'ready_expired'); return null; }
      const bytes = ready; ready = null; readySince = 0; readyUntil = 0;
      clearHashes();
      if (run) clearTimers(run); run = null;
      publish('consumed'); return bytes;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (run) { clearTimers(run); release(run); run = null; }
      dropReady(); safely(unwatch); publish('disposed', 0); listeners.clear();
    },
  };
}

/** Native port: self-hosted worklet, mono 24kHz context, zero output; never an audible microphone monitor. */
export function browserMusicCapturePort(): MusicCapturePort {
  const streams = new WeakMap<CaptureDevice, MediaStream>();
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: timer => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
    isVisible: () => typeof document !== 'undefined' && document.visibilityState !== 'hidden',
    watchRevocation(callback) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
      const doc = document, win = window;
      const visibility = () => { if (doc.visibilityState === 'hidden') callback(); };
      doc.addEventListener('visibilitychange', visibility); win.addEventListener('pagehide', callback);
      return () => { doc.removeEventListener('visibilitychange', visibility); win.removeEventListener('pagehide', callback); };
    },
    async requestDevice() {
      if (!globalThis.isSecureContext || !globalThis.navigator?.mediaDevices?.getUserMedia) throw new DOMException('Capture unavailable', 'NotSupportedError');
      const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: 1, sampleRate: RECORDING.sampleRate,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      let stopped = false;
      const device: CaptureDevice = {
        stop() { if (stopped) return; stopped = true; for (const track of stream.getTracks()) safely(() => track.stop()); },
        watchInterruption(callback) {
          const tracks = stream.getAudioTracks();
          for (const track of tracks) { track.addEventListener('ended', callback); track.addEventListener('mute', callback); }
          if (!tracks.length || tracks.some(track => track.readyState === 'ended')) queueMicrotask(callback);
          return () => { for (const track of tracks) { track.removeEventListener('ended', callback); track.removeEventListener('mute', callback); } };
        },
      };
      streams.set(device, stream); return device;
    },
    createProcessor(device, onMessage, onFault) {
      const stream = streams.get(device);
      if (!stream || typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') throw new DOMException('Capture unavailable', 'NotSupportedError');
      const context = new AudioContext({ sampleRate: RECORDING.sampleRate });
      let source: MediaStreamAudioSourceNode | null = null, node: AudioWorkletNode | null = null, closed = false, begun = false;
      const changed = () => { if (!closed && begun && context.state !== 'running') onFault(); };
      context.addEventListener('statechange', changed);
      return {
        sampleRate: context.sampleRate,
        async prepare() {
          await context.audioWorklet.addModule(WORKLET_URL);
          if (closed) return;
          node = new AudioWorkletNode(context, 'wintr-recording', { numberOfInputs: 1, numberOfOutputs: 1,
            outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
          node.port.onmessage = event => { if (!closed) onMessage(event.data); };
          node.onprocessorerror = () => { if (!closed) onFault(); };
          source = context.createMediaStreamSource(stream);
          await context.resume();
          if (!closed && context.state !== 'running') throw new Error('capture unavailable');
        },
        begin() {
          if (closed || !node || !source || context.state !== 'running') throw new Error('capture unavailable');
          // The processor fills every output channel with zeros. Connection drives processing only.
          node.connect(context.destination); source.connect(node); begun = true;
        },
        disconnectInput() { safely(() => source?.disconnect()); },
        finish() { if (closed || !node) throw new Error('capture unavailable'); node.port.postMessage({ type: 'stop' }); },
        close() {
          if (closed) return; closed = true; context.removeEventListener('statechange', changed);
          safely(() => source?.disconnect());
          if (node) { node.port.onmessage = null; node.onprocessorerror = null; safely(() => node!.port.postMessage({ type: 'cancel' })); safely(() => node!.port.close()); safely(() => node!.disconnect()); }
          source = null; node = null;
          return context.close();
        },
      };
    },
  };
}
