import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createWintrServer, listen, type WebHandler } from './http-server.js';
import { createLocalApi } from './local-app.js';

// Ordinary CLI: disabled or labelled synthetic only (loadConfig refuses live and
// createLocalApi takes no credentials). Live is started only through the
// controller-only seam in live-runtime.ts, which this entry never imports.
async function main() {
  let config: Config;
  try {
    config = loadConfig(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[wintr] refusing to start: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const api = createLocalApi(config);
  const server = createServer();
  let web: WebHandler | undefined;
  if (config.dev) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      server: { middlewareMode: true, hmr: { server }, allowedHosts: [config.host] },
      appType: 'spa',
    });
    web = (req: IncomingMessage, res: ServerResponse) => vite.middlewares(req, res);
  }
  await listen(createWintrServer(config, api, { server, web }), config);
  console.log(`[wintr] ${config.mode} mode on ${config.origin}${config.dev ? ' (dev)' : ''}`);
}

void main();
