import { LIVE_LISTENING as L } from '../shared/live-listening.js';
import { browserMusicCapturePort, type CaptureDevice, type CaptureProcessor, type MusicCapturePort } from './music-capture.js';

export interface LiveCaptureSnapshot { readonly phase: 'idle' | 'permission' | 'connecting' | 'listening' | 'finishing' | 'analysing' | 'error'; readonly durationMs: number; readonly error: string | null }
export interface LiveMusicCapture {
  getSnapshot(): LiveCaptureSnapshot;
  subscribe(callback: () => void): () => void;
  prepare(signal: AbortSignal): Promise<void>;
  begin(send: (pcm: Uint8Array) => void): void;
  finish(): void;
  cancel(): void;
  readonly completion: Promise<void>;
}
export const IDLE_LIVE_CAPTURE: LiveCaptureSnapshot = Object.freeze({ phase: 'idle', durationMs: 0, error: null });
const safe = (fn: () => unknown) => { try { const p = fn(); if (p instanceof Promise) void p.catch(() => {}); } catch { /* Device failures never escape cleanup. */ } };

/** Chunk capture: no ready clip, full-length allocation, draft, replay or storage. */
export function createLiveMusicCapture(port: MusicCapturePort = browserMusicCapturePort()): LiveMusicCapture {
  let snapshot = IDLE_LIVE_CAPTURE, device: CaptureDevice | null = null, processor: CaptureProcessor | null = null;
  let frames = 0, started = 0, closed = false, finishing = false, completed = false, sink: ((pcm: Uint8Array) => void) | null = null;
  const listeners = new Set<() => void>(), timers = new Set<unknown>();
  let unwatchDevice: (() => void) | undefined, unwatchPage: (() => void) | undefined, preparation: Promise<void> | undefined;
  const abortSignals = new Map<AbortSignal, () => void>();
  let resolve!: () => void, reject!: (reason: Error) => void;
  const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void completion.catch(() => {});
  const update = (phase: LiveCaptureSnapshot['phase'], error: string | null = null) => {
    snapshot = Object.freeze({ phase, durationMs: frames * 1000 / L.sampleRate, error }); for (const l of listeners) l();
  };
  const timer = (fn: () => void, ms: number) => { const t = port.setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const releaseInput = () => { unwatchDevice?.(); unwatchDevice = undefined; safe(() => processor?.disconnectInput()); safe(() => device?.stop()); device = null; };
  const cleanup = () => {
    releaseInput(); unwatchPage?.(); unwatchPage = undefined;
    for (const remove of abortSignals.values()) remove(); abortSignals.clear();
    for (const t of timers) port.clearTimeout(t); timers.clear(); safe(() => processor?.close()); processor = null; sink = null;
  };
  const fail = (message = 'Listening stopped. Try again.') => {
    if (closed) return; closed = true; cleanup(); if (!completed) { update('error', message); reject(new Error(message)); }
  };
  const finish = () => {
    if (closed || finishing || snapshot.phase !== 'listening') return;
    if (frames < L.minFrames) return;
    finishing = true; releaseInput(); update('finishing');
    timer(() => fail('Listening could not finish. Try again.'), 1000);
    try { processor!.finish(); } catch { fail(); }
  };
  const message = (raw: unknown) => {
    if (closed || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const m = raw as Record<string, unknown>;
    if (m.type === 'fault') { fail(); return; }
    if (m.type === 'stopped') {
      if (!finishing || !Number.isSafeInteger(m.frames) || (m.frames as number) < frames || (m.frames as number) > frames + 4096 || frames < L.minFrames) { fail(); return; }
      completed = true; cleanup(); update('analysing'); resolve(); return;
    }
    if (m.type !== 'frames' || Object.keys(m).sort().join(',') !== 'samples,type' || !sink || !['listening', 'finishing'].includes(snapshot.phase) ||
      !(m.samples instanceof Float32Array) || !m.samples.length || m.samples.length > 4096) { fail(); return; }
    const samples = m.samples;
    try {
      if ([...samples].some(n => !Number.isFinite(n))) throw new Error('samples');
      const count = Math.min(samples.length, L.maxFrames - frames);
      const elapsed = port.now() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0 || (frames + count) * 1000 / L.sampleRate > elapsed + 1000) throw new Error('clock');
      if (count) {
        const pcm = new Uint8Array(count * 2), view = new DataView(pcm.buffer);
        for (let i = 0; i < count; i++) { const n = Math.max(-1, Math.min(1, samples[i]!)); view.setInt16(i * 2, Math.round(n < 0 ? n * 32768 : n * 32767), true); }
        try { sink(pcm); frames += count; update(snapshot.phase); } finally { pcm.fill(0); }
      }
      if (frames === L.maxFrames && !finishing) finish();
    } catch { fail('The connection could not keep up. Try again.'); }
    finally { samples.fill(0); }
  };
  const within = async <T>(pending: Promise<T>): Promise<T> => {
    let t: unknown;
    const timeout = new Promise<never>((_, no) => { t = timer(() => { fail('The microphone did not become ready. Try again.'); no(new Error('timeout')); }, 30_000); });
    try { return await Promise.race([pending, timeout, completion.then(() => { throw new Error('cancelled'); })]); }
    finally { if (t !== undefined) { port.clearTimeout(t); timers.delete(t); } }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    completion,
    async prepare(signal) {
      if (closed || !['idle', 'permission', 'connecting'].includes(snapshot.phase) || signal.aborted || !port.isVisible()) { fail(); throw new Error('cancelled'); }
      if (!abortSignals.has(signal)) {
        const abort = () => fail(); signal.addEventListener('abort', abort, { once: true });
        abortSignals.set(signal, () => signal.removeEventListener('abort', abort));
      }
      // One explicit tap may prepare the device alongside Session creation.
      // Transport adopts the same preparation; it never requests a second mic.
      preparation ??= (async () => {
        unwatchPage = port.watchRevocation(() => fail('Listening stopped when you left Wintr.'));
        update('permission');
        try {
        const granted = await within(port.requestDevice().then(value => { if (closed || signal.aborted) { value.stop(); throw new Error('cancelled'); } return value; }));
        device = granted;
        if (closed || signal.aborted) { safe(() => device?.stop()); throw new Error('cancelled'); }
        unwatchDevice = granted.watchInterruption(() => fail('The microphone was disconnected.'));
        processor = port.createProcessor(granted, message, () => fail());
        if (processor.sampleRate !== L.sampleRate) throw new Error('format');
        await within(processor.prepare());
        if (closed || signal.aborted || !port.isVisible()) throw new Error('cancelled');
        update('connecting');
        } catch { fail('The microphone is unavailable. Check its permission and try again.'); throw new Error(snapshot.error ?? 'cancelled'); }
      })();
      await preparation;
      if (closed || signal.aborted || snapshot.phase !== 'connecting' || !port.isVisible()) { fail(); throw new Error('cancelled'); }
    },
    begin(send) {
      if (closed || snapshot.phase !== 'connecting' || !port.isVisible()) { fail(); throw new Error('cancelled'); }
      sink = send; started = port.now(); update('listening');
      timer(() => { if (frames >= L.minFrames) finish(); }, L.autoFinishSeconds * 1000);
      timer(() => { if (frames >= L.minFrames) finish(); else fail('No music was captured. Try again.'); }, L.maxSeconds * 1000);
      try { processor!.begin(); } catch { fail(); }
    },
    finish,
    cancel() { fail(); },
  };
}
