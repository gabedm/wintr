import { LIVE_LISTENING as L } from '../shared/live-listening.js';
import { isErrorCode } from './snapshot-validation.js';
import { ApiError } from './api.js';
import type { LiveMusicCapture } from './live-music-capture.js';

export type BrowserLiveSocket = Pick<WebSocket, 'readyState' | 'bufferedAmount' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'binaryType'>;
/** No provider key, model configuration, private result or reconnection logic reaches this transport. */
export async function streamLiveReference(path: string, input: { actionKey: string; cue: string | null }, capture: LiveMusicCapture, signal: AbortSignal,
  connect: (url: string) => BrowserLiveSocket = url => new WebSocket(url), origin = globalThis.location?.origin): Promise<void> {
  await capture.prepare(signal); // Permission failure never opens a counted provider connection.
  if (signal.aborted) { capture.cancel(); throw new ApiError(0, 'aborted', null); }
  let socket: BrowserLiveSocket | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let done = false, ready = false, finished = false, messages = 0;
      const settle = (error?: ApiError) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); removePage(); error ? reject(error) : resolve(); };
      const payloadBytes = (value: string | Uint8Array) => typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength;
      const fits = (value: string | Uint8Array) => socket && Number.isSafeInteger(socket.bufferedAmount) && socket.bufferedAmount >= 0 && socket.bufferedAmount + payloadBytes(value) <= L.maxQueuedBytes;
      const abort = () => { try { const cancel = JSON.stringify({ type: 'cancel' }); if (socket?.readyState === 1 && fits(cancel)) socket.send(cancel); } catch { /* Close remains authoritative locally. */ }
        capture.cancel(); socket?.close(); settle(new ApiError(0, 'aborted', null)); };
      const hidden = () => { if (globalThis.document?.visibilityState === 'hidden') abort(); };
      globalThis.document?.addEventListener('visibilitychange', hidden); globalThis.window?.addEventListener('pagehide', abort);
      const removePage = () => { globalThis.document?.removeEventListener('visibilitychange', hidden); globalThis.window?.removeEventListener('pagehide', abort); };
      const timer = setTimeout(() => { capture.cancel(); socket?.close(); settle(new ApiError(0, 'timeout', null)); }, L.executeMs);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const url = new URL(path, origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = connect(url.href); socket.binaryType = 'arraybuffer';
        const send = (value: string | Uint8Array) => {
          if (done || signal.aborted || socket!.readyState !== 1 || !fits(value)) throw new ApiError(0, 'network', null);
          socket!.send(typeof value === 'string' ? value : Uint8Array.from(value).buffer);
        };
        socket.onopen = () => { try { send(JSON.stringify({ type: 'start', ...input })); } catch { abort(); } };
        socket.onerror = () => settle(new ApiError(0, 'network', null));
        socket.onclose = () => { if (!done) settle(new ApiError(0, signal.aborted ? 'aborted' : 'network', null)); };
        socket.onmessage = event => {
          try {
            if (done || ++messages > 4 || typeof event.data !== 'string' || event.data.length > 1024) throw new Error('message');
            const m = JSON.parse(event.data);
            if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('message');
            if (m.type === 'error' && Object.keys(m).sort().join(',') === 'code,type' && isErrorCode(m.code)) { settle(new ApiError(400, m.code, null)); return; }
            if (m.type === 'ready' && Object.keys(m).sort().join(',') === 'maxSeconds,type' && m.maxSeconds === L.maxSeconds && !ready) {
              ready = true; capture.begin(pcm => send(pcm)); return;
            }
            if (m.type === 'complete' && Object.keys(m).length === 1) {
              // Replays can complete without readiness. Their owned state is read normally; never stream twice.
              settle(); return;
            }
            throw new Error('sequence');
          } catch { settle(new ApiError(0, 'network', null)); }
        };
        void capture.completion.then(() => { if (!done) { finished = true; try { send(JSON.stringify({ type: 'finish' })); } catch { settle(new ApiError(0, 'network', null)); } } }, () => { if (!done) settle(new ApiError(0, 'aborted', capture.getSnapshot().error)); });
        if (signal.aborted) abort();
      } catch { settle(new ApiError(0, 'network', null)); }
    });
  } finally {
    if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
    capture.cancel();
  }
}
