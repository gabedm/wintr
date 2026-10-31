import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { ApiHandler } from './app.js';
import type { Config } from './config.js';
import type { DesktopProbe } from './desktop-probe.js';

// The one Node HTTP composition: same-origin API under /api/, the built client
// (and its shipped licence notices) otherwise, exact Host checks, CSP and
// timeouts. Importing it starts nothing. The ordinary CLI (index.ts) and the
// controller-only live start seam (live-runtime.ts) both use createWintrServer.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://s1.ticketm.net https://is1-ssl.mzstatic.com",
  "font-src 'self'",
  "connect-src 'self'",
  // Only Wintr's own sandboxed Search Suggestions document may be framed.
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const REQUEST_TIMEOUT_MS = 150_000;

export type WebHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Default location of the built client, relative to the working directory. */
export const DEFAULT_CLIENT_ROOT = 'dist/client';

export function staticHandler(config: Pick<Config, 'hostHeader' | 'origin'>, clientRoot: string = DEFAULT_CLIENT_ROOT, privateAssets = false): WebHandler {
  const root = resolve(clientRoot);
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), display-capture=()');
    if (req.headers.host !== config.hostHeader) {
      res.statusCode = 421;
      return res.end('Misdirected request. Open ' + config.origin);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      return res.end();
    }
    let path: string;
    try {
      path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    const isAsset = path.startsWith('/assets/');
    // Third-party licence notices shipped verbatim with the build (fonts).
    const isNotice = path.startsWith('/licenses/');
    const file = resolve(root, '.' + (isAsset || isNotice ? path : '/index.html'));
    if (!file.startsWith(root + sep)) {
      res.statusCode = 404;
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Cache-Control', isAsset && !privateAssets ? 'public, max-age=31536000, immutable' : 'no-store');
      // Some browsers do not include same-host WebSockets in connect-src 'self'.
      res.setHeader('Content-Security-Policy', CSP.replace("connect-src 'self'", `connect-src 'self' ${config.origin.replace(/^http/, 'ws')}`));
      res.setHeader('X-Frame-Options', 'DENY');
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  };
}

export interface WintrServerOptions {
  /** Explicit personal-launcher probe; absent from ordinary disabled/synthetic startup. */
  readonly desktopProbe?: DesktopProbe;
  /** Replaces the static client (the ordinary CLI's Vite dev middleware only). */
  readonly web?: WebHandler;
  readonly clientRoot?: string;
  /** Attach to an existing server (Vite HMR needs it before middleware creation). */
  readonly server?: Server;
}

/** Builds (does not start) the canonical server for a validated config and API handler. */
export function createWintrServer(config: Config, api: ApiHandler, opts: WintrServerOptions = {}): Server {
  const server = opts.server ?? createServer();
  const web = opts.web ?? staticHandler(config, opts.clientRoot);
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (opts.desktopProbe?.handle(req, res)) return;
    if ((req.url ?? '').startsWith('/api/')) void api(req, res);
    else void web(req, res);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] === '/api/live-reference' && api.upgrade) api.upgrade(req, socket, head);
    else if ((req.url ?? '').startsWith('/api/')) socket.destroy();
    // Other upgrades belong to the explicitly supplied Vite development server.
    else if (!opts.web) socket.destroy();
  });
  server.on('close', () => api.closeLive?.());
  return server;
}

/** Listens on the config's own backend host/port; the ordinary CLI supplies loopback only. */
export function listen(server: Server, config: Pick<Config, 'host' | 'port'>): Promise<void> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(config.port, config.host, () => {
      server.off('error', fail);
      ok();
    });
  });
}
