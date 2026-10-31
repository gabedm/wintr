import type { Handle } from '../shared/records.js';
import { LIVE_LISTENING as L } from '../shared/live-listening.js';
import { ProviderError } from './providers/http.js';

const owned = new WeakSet<object>();
export interface LiveAudioInput extends AsyncIterable<Uint8Array> {
  readonly receipt: Handle;
  readonly finished: boolean;
  ready(): void;
  push(bytes: Uint8Array): void;
  finish(): void;
  cancel(): void;
}
export const isLiveAudioInput = (input: unknown): input is LiveAudioInput => typeof input === 'object' && input !== null && owned.has(input);

/** One admitted input. Never stores a complete clip or survives its Attempt. */
export function createLiveAudioInput(receipt: Handle, signal: AbortSignal, onReady: () => void, now = Date.now): LiveAudioInput {
  const queue: Uint8Array[] = [];
  let bytes = 0, frames = 0, packets = 0, started: number | null = null, ended = false, cancelled = false;
  let wake: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const bad = () => new ProviderError('gemini', 'aborted', true);
  const cancel = () => {
    cancelled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
    for (const chunk of queue) chunk.fill(0);
    queue.length = 0; bytes = 0; wake?.(); wake = undefined;
  };
  const input: LiveAudioInput = {
    receipt,
    get finished() { return ended && !cancelled; },
    ready() {
      if (signal.aborted || cancelled || started !== null) throw bad();
      started = now();
      timer = setTimeout(cancel, L.maxSeconds * 1000 + L.inputGraceMs);
      timer.unref(); onReady();
    },
    push(chunk) {
      const t = now();
      if (signal.aborted || cancelled || ended || started === null || !Number.isSafeInteger(t) || t < started || t - started > L.maxSeconds * 1000 + L.inputGraceMs ||
        !(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength % 2 || chunk.byteLength > L.maxChunkBytes || ++packets > L.maxPackets ||
        frames + chunk.byteLength / 2 > L.maxFrames || bytes + chunk.byteLength > L.maxQueuedBytes ||
        (frames + chunk.byteLength / 2) * 1000 / L.sampleRate > t - started + 1000) { cancel(); throw bad(); }
      const copy = Uint8Array.from(chunk);
      frames += copy.byteLength / 2; bytes += copy.byteLength; queue.push(copy); wake?.(); wake = undefined;
    },
    finish() {
      if (signal.aborted || cancelled || ended || started === null || frames < L.minFrames) { cancel(); throw bad(); }
      ended = true; clearTimeout(timer); wake?.(); wake = undefined;
    },
    cancel,
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (cancelled || signal.aborted) throw bad();
          const chunk = queue.shift();
          if (chunk) {
            // Coalesce already queued frames so a shared authorization read per
            // upstream message does not require one database round trip per worklet batch.
            const parts = [chunk]; let size = chunk.byteLength;
            while (queue[0] && size + queue[0].byteLength <= L.maxUpstreamChunkBytes) { const next = queue.shift()!; parts.push(next); size += next.byteLength; }
            bytes -= size;
            const combined = parts.length === 1 ? chunk : new Uint8Array(size);
            if (parts.length > 1) { let at = 0; for (const part of parts) { combined.set(part, at); at += part.byteLength; part.fill(0); } }
            try { yield combined; } finally { combined.fill(0); }
          }
          else if (ended) return;
          else await new Promise<void>(resolve => { wake = resolve; });
        }
      } finally { if (!ended) cancel(); }
    },
  };
  owned.add(input); signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  return Object.freeze(input);
}
