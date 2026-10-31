import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { parseSourcePolicy, type SourcePolicy } from '../src/server/source-policy.js';
import { MemoryStore } from '../src/server/store.js';
import type { RuntimeMode, SafeSnapshot } from '../src/shared/records.js';

// Projection-only HTTP checks: injected mode + local MemoryStore + null provider
// adapter. This does not activate or validate a live composition, read media,
// contact providers or supply a credential. The public example metadata was
// deliberately approved for the editable demo; all policy identifiers are invented.
const EXAMPLE_ID = 'sMcWOaJFuw0';
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done())))); });
function approved(ids = [EXAMPLE_ID]) {
  const result = parseSourcePolicy({ version: 'invented-example-policy', expiresAt: 2000, videoIds: ids });
  if (!result.ok) throw new Error('Invalid synthetic policy fixture');
  return result.policy;
}
async function setup(mode: RuntimeMode, sourcePolicy?: SourcePolicy) {
  const server = createServer(); servers.push(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  const base = loadConfig([], { WINTR_PORT: String(port), WINTR_MODE: 'synthetic' });
  const clock = { now: 1000 };
  const store = new MemoryStore(base);
  server.on('request', createApiHandler({ config: { ...base, mode }, store, referenceAdapter: null, sourcePolicy, now: () => clock.now }));
  const state = () => new Promise<{ status: number; body: SafeSnapshot }>((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: base.hostHeader } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', part => { text += part; });
      res.on('end', () => done({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', fail); req.end();
  });
  return { clock, state };
}

describe('server-derived example capability', () => {
  it.each([
    ['disabled', undefined, false],
    ['disabled', approved(), false],
    ['synthetic', undefined, true],
    ['live', undefined, false],
    ['live', approved(), true],
    ['live', approved(['aaaaaaaaaaa']), false],
    ['synthetic', approved(['aaaaaaaaaaa']), false],
  ] as const)('%s offers only what its current bound mode/policy allows', async (mode, policy, offered) => {
    const app = await setup(mode, policy);
    const result = await app.state();
    expect(result.status).toBe(200);
    expect(result.body.exampleSource).toBe(offered);
    expect(result.body.session).toBeNull();
    expect(result.body.revision).toBe(0);
    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain('invented-example-policy');
    expect(serialised).not.toContain('videoIds');
    expect(serialised).not.toContain(EXAMPLE_ID);
  });

  it('re-evaluates the policy at its exact expiry without admission, session creation or a stale capability cache', async () => {
    const app = await setup('live', approved());
    expect((await app.state()).body.exampleSource).toBe(true);
    app.clock.now = 2000;
    const expired = await app.state();
    expect(expired.body.exampleSource).toBe(false);
    expect(expired.body.session).toBeNull();
    expect(expired.body.revision).toBe(0);
  });
});
