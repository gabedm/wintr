import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';

// Local launcher authentication only. No cookies, listener records or authority writes.
export interface DesktopProbe { handle(req: IncomingMessage, res: ServerResponse): boolean }
const CHALLENGE = /^[a-f0-9]{64}$/;
const sign = (key: string, profileId: string, challenge: string, pid: number) => createHmac('sha256', key).update(`wintr-desktop-v1|${profileId}|${challenge}|${pid}`).digest('hex');
export function createDesktopProbe(config: Pick<Config, 'hostHeader'>, profileId: string, key: string, check: () => void, pid = process.pid): DesktopProbe {
  if (!/^[a-f0-9]{32}$/.test(profileId) || !/^[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(pid) || pid < 1) throw new TypeError('Invalid desktop probe');
  return Object.freeze({ handle(req: IncomingMessage, res: ServerResponse) {
    if (req.url !== '/api/desktop-status') return false;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' || req.headers.host !== config.hostHeader) { res.writeHead(421).end(); return true; }
    const challenge = req.headers['x-wintr-challenge'];
    if (typeof challenge !== 'string' || !CHALLENGE.test(challenge)) { res.writeHead(400).end(); return true; }
    try { check(); } catch { res.writeHead(503).end(); return true; }
    const body = JSON.stringify({ profileId, challenge, pid, proof: sign(key, profileId, challenge, pid) });
    res.setHeader('Content-Type', 'application/json'); res.end(body); return true;
  } });
}
export function verifyDesktopProbe(raw: unknown, profileId: string, key: string, challenge: string): raw is { profileId: string; pid: number } {
  if (!raw || typeof raw !== 'object' || Object.getPrototypeOf(raw) !== Object.prototype || !CHALLENGE.test(challenge) || !/^[a-f0-9]{64}$/.test(key)) return false;
  const ds = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
  if (keys.some(k => typeof k !== 'string' || !Object.hasOwn(ds[k]!, 'value')) || keys.map(String).sort().join(',') !== 'challenge,pid,profileId,proof') return false;
  const r = Object.fromEntries((keys as string[]).map(k => [k, ds[k]!.value]));
  if (r.profileId !== profileId || r.challenge !== challenge || !Number.isSafeInteger(r.pid) || (r.pid as number) < 1 || typeof r.proof !== 'string' || !CHALLENGE.test(r.proof)) return false;
  return timingSafeEqual(Buffer.from(r.proof, 'hex'), Buffer.from(sign(key, profileId, challenge, r.pid as number), 'hex'));
}
