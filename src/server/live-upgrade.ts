import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { LIVE_LISTENING as L } from '../shared/live-listening.js';
import type { ErrorCode } from '../shared/records.js';
import type { LiveAudioInput } from './live-audio.js';
import { refuseDuplicateKeys } from './providers/json-keys.js';

export interface LiveChannel {
  readonly signal: AbortSignal;
  attach(input: LiveAudioInput): void;
  ready(): void;
}
export type LiveStart = (raw: Record<string, unknown>, channel: LiveChannel) => Promise<void>;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** Fixed, small browser protocol. This is not a general WebSocket proxy. */
export function createLiveUpgrade(authorize: (req: IncomingMessage) => Promise<LiveStart>, errorCode: (error: unknown) => ErrorCode) {
  const sockets = new Set<Duplex>(), controllers = new Set<AbortController>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; for (const c of controllers) c.abort('runtime_closed');
    for (const s of sockets) s.destroy();
    for (const s of wss.clients) s.terminate(); wss.close();
  };
  const upgrade: UpgradeHandler = (req, rawSocket, head) => {
    if (closed || sockets.size >= 2 || head.byteLength > 16 * 1024) { rawSocket.destroy(); return; }
    rawSocket.on('error', () => {});
    sockets.add(rawSocket); rawSocket.once('close', () => sockets.delete(rawSocket));
    const authTimer = setTimeout(() => rawSocket.destroy(), 5000); authTimer.unref();
    void authorize(req).then(start => {
      clearTimeout(authTimer);
      if (closed || rawSocket.destroyed) return;
      wss.handleUpgrade(req, rawSocket, head, ws => {
        const abort = new AbortController(); controllers.add(abort);
        let input: LiveAudioInput | undefined, started = false, finished = false, packets = 0, ready = false;
        let endTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => fail('deadline'), L.executeMs); timer.unref();
        const startTimer = setTimeout(() => fail('bad_request'), L.setupMs); startTimer.unref();
        const send = (value: unknown) => {
          const payload = JSON.stringify(value);
          if (closed || abort.signal.aborted || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount + Buffer.byteLength(payload) + 10 > L.maxQueuedBytes) throw new Error('closed');
          ws.send(payload);
        };
        const fail = (code: ErrorCode) => {
          const payload = JSON.stringify({ type: 'error', code });
          if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN && ws.bufferedAmount + Buffer.byteLength(payload) + 10 <= L.maxQueuedBytes) ws.send(payload);
          abort.abort('stream_closed'); input?.cancel(); ws.close(1008);
          endTimer ??= setTimeout(() => ws.terminate(), 250); endTimer.unref();
        };
        ws.on('error', () => fail('bad_request'));
        ws.on('close', () => { clearTimeout(timer); clearTimeout(startTimer); clearTimeout(endTimer); abort.abort('stream_closed'); input?.cancel(); controllers.delete(abort); });
        ws.on('message', (data, binary) => {
          try {
            if (abort.signal.aborted || ++packets > L.maxPackets + 4) throw new Error('closed');
            const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            if (binary) {
              if (!ready || !input || finished) throw new Error('sequence');
              input.push(buffer); return;
            }
            if (buffer.byteLength > 4096) throw new Error('message');
            const text = buffer.toString(); refuseDuplicateKeys(text, () => new Error('keys'));
            const m: unknown = JSON.parse(text);
            if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('message');
            const msg = m as Record<string, unknown>;
            if (msg.type === 'cancel' && Object.keys(msg).length === 1) { fail('cancelled'); return; }
            if (msg.type === 'finish' && Object.keys(msg).length === 1 && input && ready && !finished) { finished = true; ready = false; input.finish(); return; }
            if (msg.type !== 'start' || started || Object.keys(msg).sort().join(',') !== 'actionKey,cue,type') throw new Error('sequence');
            started = true; clearTimeout(startTimer);
            void start(msg, { signal: abort.signal,
              attach(value) { if (input || abort.signal.aborted) { value.cancel(); throw new Error('closed'); } input = value; },
              ready() { if (!input || ready || finished) throw new Error('sequence'); ready = true; send({ type: 'ready', maxSeconds: L.maxSeconds }); },
            }).then(() => {
              if (abort.signal.aborted) return;
              send({ type: 'complete' }); ws.close(1000);
              endTimer = setTimeout(() => ws.terminate(), 250); endTimer.unref();
            }, error => fail(errorCode(error))).catch(() => fail('admission_unavailable'));
          } catch { fail('bad_request'); }
        });
      });
    }, () => {
      clearTimeout(authTimer);
      if (!rawSocket.destroyed) {
        rawSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        const timer = setTimeout(() => rawSocket.destroy(), 250); timer.unref(); rawSocket.once('close', () => clearTimeout(timer));
      }
    }).catch(() => rawSocket.destroy());
  };
  return { upgrade, close };
}
