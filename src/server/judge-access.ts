import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiHandler } from './app.js';
import { staticHandler, type WebHandler } from './http-server.js';
import type { Config } from './config.js';
import { refuseDuplicateKeys } from './providers/json-keys.js';

const COOKIE = '__Host-wintr-judge';
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const headers = (res: ServerResponse) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
};
/** The link is a reusable access capability, separate from each visitor's private Session. */
export function createJudgeAccess(config: Pick<Config, 'origin' | 'hostHeader'>, api: ApiHandler, options: {
  readonly tokenHash: string; readonly sealingKey: string; readonly expiresAt: number;
  readonly checkAuthority: () => void; readonly now?: () => number; readonly clientRoot?: string;
}): { api: ApiHandler; web: WebHandler } {
  const { tokenHash, sealingKey, expiresAt, checkAuthority, clientRoot } = options;
  const now = options.now ?? Date.now;
  if (!/^[a-f0-9]{64}$/.test(tokenHash) || sealingKey.length < 32 || !Number.isSafeInteger(expiresAt) || expiresAt <= now() ||
    !config.origin.startsWith('https://') || new URL(config.origin).origin !== config.origin || new URL(config.origin).host !== config.hostHeader) throw Error('judge_access_config');
  const cookie = createHmac('sha256', sealingKey).update(`wintr-judge-v1:${config.origin}:${expiresAt}:${tokenHash}`).digest('hex');
  const current = () => { try { checkAuthority(); return now() < expiresAt; } catch { return false; } };
  const allowed = (req: IncomingMessage) => {
    if (req.headers.host !== config.hostHeader || !current()) return false;
    const values = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(COOKIE + '='));
    const value = values.length === 1 ? values[0]!.slice(COOKIE.length + 1) : '';
    return /^[a-f0-9]{64}$/.test(value) && equal(value, cookie);
  };
  const reject = (res: ServerResponse, status = 403) => { headers(res); res.writeHead(status).end('Open your private Wintr link.'); };
  const redeem = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') return reject(res, 405);
    if (req.headers.host !== config.hostHeader || req.headers.origin !== config.origin || !current() || req.headers['content-type'] !== 'application/json') return reject(res);
    let size = 0, text = '';
    const timer = setTimeout(() => { if (!res.writableEnded) reject(res, 408); req.destroy(); }, 5000); timer.unref();
    try {
      for await (const part of req) { size += part.length; if (size > 160) { reject(res, 413); req.destroy(); return; } text += part.toString('utf8'); }
      if (res.writableEnded) return;
      refuseDuplicateKeys(text, () => Error('access_body'));
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'access') return reject(res);
      const access = (value as { access: unknown }).access;
      if (typeof access !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(access) || !equal(createHash('sha256').update(access).digest('hex'), tokenHash) || !current()) return reject(res);
      headers(res); res.setHeader('Set-Cookie', `${COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}`);
      res.writeHead(204).end();
    } catch { if (!res.writableEnded && !res.destroyed) reject(res, 400); }
    finally { clearTimeout(timer); text = ''; }
  };
  const upgrade: NonNullable<ApiHandler['upgrade']> = (req, socket, head) => {
    if (!allowed(req) || !api.upgrade) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    api.upgrade(req, socket, head);
  };
  const gated: ApiHandler = Object.assign(async (req: IncomingMessage, res: ServerResponse) => req.url === '/api/judge-access' ? redeem(req, res) : allowed(req) ? api(req, res) : reject(res), { upgrade, closeLive: () => api.closeLive?.() });
  const serve = staticHandler(config, clientRoot, true);
  const web: WebHandler = (req, res) => {
    if (allowed(req)) return serve(req, res);
    if (req.url !== '/' || req.headers.host !== config.hostHeader || !current() || !['GET', 'HEAD'].includes(req.method ?? '')) return reject(res);
    const nonce = randomBytes(24).toString('base64url'); headers(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    // Fragments never reach HTTP/access logs. Remove it before the one same-origin redemption POST.
    const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wintr</title><style nonce="${nonce}">body{font-family:system-ui;background:white;color:black;display:grid;place-items:center;min-height:90vh}p{max-width:24rem;text-align:center}</style><p id="status">Open your private Wintr link.</p><script nonce="${nonce}">const match=location.hash.match(/^#access=([A-Za-z0-9_-]{43})$/);history.replaceState(null,'',location.pathname);if(match){document.getElementById('status').textContent='Opening Wintr…';fetch('/api/judge-access',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({access:match[1]})}).then(r=>{if(!r.ok)throw Error();location.replace('/')}).catch(()=>{document.getElementById('status').textContent='This link is unavailable.'})}</script></html>`;
    res.writeHead(200).end(req.method === 'HEAD' ? undefined : page);
  };
  return { api: gated, web };
}
