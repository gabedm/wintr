import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parsePersonalProfile, personalBindings, checkPersonalTotals, PERSONAL_EXPIRY } from '../src/server/personal-profile.js';
import { parsePersonalGoogleCredential, createPersonalGoogleIdentity } from '../src/server/personal-google.js';
import { recordPersonalAccounting } from '../src/server/personal-accounting.js';
import { WindowsPersonalSecrets, windowsProtection } from '../src/server/windows-secrets.js';
import { createDesktopProbe, verifyDesktopProbe } from '../src/server/desktop-probe.js';
import { probePersonalApp, desktopCommand } from '../src/server/desktop-launcher.js';
import { composePersonalRuntime } from '../src/server/personal-runtime.js';
import { FakeFirestore, FakeFirestoreServer } from './fixtures/fake-firestore.js';
import { transports } from './fixtures/live-fixtures.js';
import { ServerSecret } from '../src/server/providers/secret.js';
import { approvedSetup, finishPersonalSetup, stagePersonalProviders } from '../src/server/personal-setup.js';
import { runPersonalApp } from '../src/server/personal-entry.js';
import { acquirePersonalSetup } from '../src/server/personal-connect.js';

// Invented credentials/accounting only. No real Google, provider, source or account access.
const T = 1_800_000_000_000;
const baseline = () => ({ currency: 'GBP', counts: { qloo: 8, gemini: 7 }, unitsHeld: 600, active: 0, unresolved: 15 });
const rawProfile = () => ({ schema: 1, profileId: 'a'.repeat(32), approved: true, approvalId: 'call_invented_personal_approval', approvedAt: T - 1000,
  authority: 'until_revoked', enabled: true, projectId: 'invented-project', quotaProjectId: 'invented-project', geminiProjectId: 'invented-gemini',
  databaseId: 'invented-db', runtimeServiceAccount: 'invented-runtime@invented-project.iam.gserviceaccount.com',
  serviceId: 'svc-invented-personal', serviceIdentity: 'runtime-invented', settlementOwner: 'owner-invented', port: 4876,
  baseline: baseline(), allowance: { gbpMinor: 10000, qloo: 120, gemini: 80 }, deniedVideoIds: ['invDenied01'], deniedRecordedDigests: ['a'.repeat(64)], recordedMusicApprovalId: null });
const profile = () => parsePersonalProfile(rawProfile(), T);
const adc = () => ({ type: 'impersonated_service_account', delegates: [],
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${profile().runtimeServiceAccount}:generateAccessToken`,
  source_credentials: { type: 'authorized_user', client_id: 'invented-client.apps.googleusercontent.com', client_secret: 'invented-client-secret', refresh_token: 'invented-refresh-token', universe_domain: 'googleapis.com', account: '' } });
const temp: string[] = [], servers: Server[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'wintr-personal-invented-')); temp.push(dir); return dir; };
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  for (const dir of temp.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + '\\wintr-personal-invented-') && !resolve(dir).startsWith(resolve(tmpdir()) + '/wintr-personal-invented-')) throw new Error('Unexpected test directory');
    rmSync(dir, { recursive: true });
  }
});

describe('separate ongoing approval and cumulative allowance', () => {
  it.skipIf(process.platform !== 'win32')('serializes actual native setup holders, then permits the next holder after release', async () => {
    const dir = directory(), helper = resolve('runtime/WintrProtect.exe'), id = 'c'.repeat(32);
    const lock = await acquirePersonalSetup(dir, helper, id);
    try { await expect(acquirePersonalSetup(dir, helper, id)).rejects.toThrow('already_starting'); }
    finally { await lock.release(); }
    const next = await acquirePersonalSetup(dir, helper, id); await next.release();
  });
  it.each(['changed', 'missing', 'corrupt'] as const)('refuses a %s retained approval before protected loads', async kind => {
    const dir = directory(), raw = { ...rawProfile(), approvedAt: Date.now() - 1000 };
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(kind === 'changed' ? { ...raw, allowance: { ...raw.allowance, gbpMinor: 10001 } } : raw));
    if (kind !== 'missing') writeFileSync(join(dir, 'setup-approved.json'), kind === 'corrupt' ? '{' : JSON.stringify(raw));
    const read = vi.spyOn(WindowsPersonalSecrets.prototype, 'read').mockImplementation(() => { throw Error('invented protected-load probe'); });
    await expect(runPersonalApp(dir)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it('keeps the same binding across launches while sessions stay one hour and recording stays disabled', () => {
    const p = profile(), first = personalBindings(p, T), later = personalBindings(p, T + 3_600_001);
    expect(later).toEqual(first); expect(first.expiresAt).toBe(PERSONAL_EXPIRY);
    expect(first.limits.sessionLifetimeMs).toBe(3_600_000);
    expect(first.limits.maxJourneysPerSession).toBe(10);
    expect(first.exposurePolicy.session).toEqual({ capUnits: 10000, counts: { qloo: 120, gemini: 80 } });
    expect(first.exposurePolicy.journey).toEqual({ capUnits: 500, counts: { qloo: 6, gemini: 4 } });
    expect(first.exposurePolicy.service).toEqual({ capUnits: 10600, counts: { qloo: 128, gemini: 87 }, concurrency: 2 });
    expect(first.sourcePolicy.processing.recorded).toBe(false);
    expect(first.sourcePolicy.processing.deniedVideoIds).toContain('invDenied01');
    expect(parsePersonalProfile({ ...rawProfile(), databaseId: '(default)' }, T).databaseId).toBe('(default)');
  });
  it.each([{ approved: false }, { enabled: false }, { authority: 'test_hour' }, { approvedAt: T + 1 }, { debug: true },
    { quotaProjectId: 'another-project' }, { runtimeServiceAccount: 'invented-runtime@another-project.iam.gserviceaccount.com' },
    { allowance: { gbpMinor: 5000, qloo: 1_000_000, gemini: 40 } },
    { baseline: { ...baseline(), unitsHeld: Number.MAX_SAFE_INTEGER } }])('refuses malformed or unapproved setup before identity use: %j', change => {
    expect(() => parsePersonalProfile({ ...rawProfile(), ...change }, T)).toThrow();
  });
  it('enables recorded input only with its separate current approval and preserves both refusal sets', () => {
    const p = parsePersonalProfile({ ...rawProfile(), recordedMusicApprovalId: 'call_invented_recorded_music' }, T);
    const b = personalBindings(p, T);
    expect(b.sourcePolicy.processing.recorded).toBe(true);
    expect(b.sourcePolicy.processing.deniedRecordedDigests).toEqual(['a'.repeat(64)]);
    expect(b.sourcePolicy.processing.deniedVideoIds).toEqual(['invDenied01']);
    expect(() => parsePersonalProfile({ ...rawProfile(), recordedMusicApprovalId: '' }, T)).toThrow();
  });
  it('does not invoke profile accessors', () => {
    const getter = vi.fn(() => true), raw = rawProfile(); Object.defineProperty(raw, 'approved', { get: getter });
    expect(() => parsePersonalProfile(raw, T)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('rejects absent accounting, reduced unknown holds, reset counts and spending beyond any cap', () => {
    for (const value of [null, { ...baseline(), unitsHeld: 0 }, { ...baseline(), unresolved: 0 }, { ...baseline(), counts: { qloo: 0, gemini: 7 } },
      { ...baseline(), unitsHeld: 10601 }, { ...baseline(), counts: { qloo: 129, gemini: 7 } }, { ...baseline(), counts: { qloo: 8, gemini: 88 } }]) {
      expect(() => checkPersonalTotals(profile(), value)).toThrow();
    }
  });
  it('persists the high-water mark across process-like restarts and refuses rollback, a changed grant and torn receipts', () => {
    const file = join(directory(), 'accounting.jsonl'), p = profile();
    recordPersonalAccounting(file, p, baseline(), T);
    const consumed = { ...baseline(), unitsHeld: 719, counts: { qloo: 8, gemini: 8 }, unresolved: 16 };
    recordPersonalAccounting(file, profile(), consumed, T + 1);
    expect(() => recordPersonalAccounting(file, p, baseline(), T + 2)).toThrow();
    expect(() => recordPersonalAccounting(file, parsePersonalProfile({ ...rawProfile(), profileId: 'b'.repeat(32) }, T), consumed, T + 2)).toThrow();
    writeFileSync(file, readFileSync(file).subarray(0, -1));
    expect(() => recordPersonalAccounting(file, p, consumed, T + 3)).toThrow();
  });
  it('does not touch protected credentials when the ongoing approval is absent', async () => {
    const dir = directory(), read = vi.spyOn(WindowsPersonalSecrets.prototype, 'read');
    await expect(desktopCommand('probe', dir)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
  });
  it('does not freeze provisional never-sent reservations into the restart floor', () => {
    const file = join(directory(), 'accounting.jsonl'), p = profile();
    recordPersonalAccounting(file, p, baseline(), T);
    const stable = readFileSync(file);
    recordPersonalAccounting(file, p, { ...baseline(), counts: { qloo: 8, gemini: 9 }, unitsHeld: 838, active: 2, unresolved: 17 }, T + 1);
    expect(readFileSync(file)).toEqual(stable);
    // Both reserved calls were proven never sent and withdrawn in the ledger.
    expect(() => recordPersonalAccounting(file, p, baseline(), T + 2)).not.toThrow();
    const unknown = { ...baseline(), counts: { qloo: 8, gemini: 8 }, unitsHeld: 719, unresolved: 16 };
    recordPersonalAccounting(file, p, unknown, T + 3);
    expect(() => recordPersonalAccounting(file, p, baseline(), T + 4)).toThrow();
  });
  it('requires the exact approved opening checkpoint before the first local receipt', () => {
    const file = join(directory(), 'accounting.jsonl');
    expect(() => recordPersonalAccounting(file, profile(), { ...baseline(), unitsHeld: 719, counts: { qloo: 8, gemini: 8 }, unresolved: 16 }, T)).toThrow();
    expect(existsSync(file)).toBe(false);
    expect(() => recordPersonalAccounting(file, profile(), baseline(), T)).not.toThrow();
  });
});

describe('explicit renewable Google identity', () => {
  it('accepts the pinned CLI impersonation format and redacts refresh material', () => {
    const parsed = parsePersonalGoogleCredential(adc(), profile());
    expect(JSON.stringify(parsed)).not.toContain('invented-refresh-token'); expect(String(parsed.refreshToken)).toBe('[redacted]');
  });
  it.each(['type', 'target', 'endpoint', 'delegates', 'extra', 'source-type', 'source-url', 'quota'] as const)('refuses %s without discovery or requests', kind => {
    const raw: any = adc();
    if (kind === 'type') raw.type = 'service_account';
    if (kind === 'target') raw.service_account_impersonation_url = raw.service_account_impersonation_url.replace('invented-runtime', 'another-runtime');
    if (kind === 'endpoint') raw.service_account_impersonation_url = raw.service_account_impersonation_url.replace('iamcredentials.googleapis.com', 'example.invalid');
    if (kind === 'delegates') raw.delegates = ['another-account'];
    if (kind === 'extra') raw.credential_source = { file: 'anything' };
    if (kind === 'source-type') raw.source_credentials.type = 'external_account';
    if (kind === 'source-url') raw.source_credentials.token_uri = 'https://example.invalid';
    if (kind === 'quota') raw.quota_project_id = 'another-project';
    expect(() => parsePersonalGoogleCredential(raw, profile())).toThrow();
  });
  function identity(onRequest?: (url: string) => void) {
    let allowed = true;
    const x = createPersonalGoogleIdentity(parsePersonalGoogleCredential(adc(), profile()), profile(), () => { if (!allowed) throw new Error('revoked'); });
    // Mock below the real Google SDK interceptor and refresh chain. Nothing leaves this process.
    const source = (x.client as any).sourceClient, calls: string[] = [];
    source.transporter.defaults.adapter = async (options: any) => {
      const url = String(options.url); calls.push(url); onRequest?.(url);
      expect(options.retry).toBe(false); expect(options.maxRedirects).toBe(0);
      const data = url.includes('oauth2.') ? { access_token: 'invented-source-access', expires_in: 3600, token_type: 'Bearer' }
        : { accessToken: `invented-impersonated-access-${calls.length}`, expireTime: new Date(Date.now() + 3_600_000).toISOString() };
      return { config: options, status: 200, statusText: 'OK', headers: new Headers(), data };
    };
    return { x, source, calls, revoke: () => { allowed = false; } };
  }
  it('renews expired short-lived access through the real SDK without restarting or resetting a budget', async () => {
    const h = identity(); await h.x.accessToken(); expect(h.calls).toHaveLength(2);
    await h.x.accessToken(); expect(h.calls).toHaveLength(2);
    h.x.client.credentials.expiry_date = 1; await h.x.accessToken(); expect(h.calls).toHaveLength(3);
    expect(h.calls[2]).toContain(':generateAccessToken');
    h.x.close(); await expect(h.x.accessToken()).rejects.toThrow(); expect(h.calls).toHaveLength(3);
  });
  it('checks revocation between OAuth and IAM and refuses cached Firestore headers after revocation', async () => {
    let revoke = () => {};
    const h = identity(url => { if (url.includes('oauth2.')) revoke(); }); revoke = h.revoke;
    await expect(h.x.accessToken()).rejects.toThrow('sign_in_required'); expect(h.calls).toHaveLength(1);
    h.x.close();
    const cached = identity(); await cached.x.accessToken(); cached.revoke();
    await expect(cached.x.client.getRequestHeaders()).rejects.toThrow(); expect(cached.calls).toHaveLength(2); cached.x.close();
  });
});

describe('same shared backend on normal startup', () => {
  it('refuses a missing ledger and never sends a provider request or creates a replacement ledger', async () => {
    const db = new FakeFirestoreServer(), net = transports(), receipts = vi.fn();
    const google = { client: {} as any, accessToken: async () => new ServerSecret('invented-access-token'), close: () => {} };
    await expect(composePersonalRuntime({ profile: profile(), checkAuthority() {}, google,
      secret: async ref => new ServerSecret(ref === 'personal/sealing' ? 'invented-sealing-key-material-00000001' : 'invented-provider-secret'),
      recordAccounting: receipts, firestore: () => new FakeFirestore(db), network: net.network, clock: () => T })).rejects.toThrow('accounting_unavailable');
    expect(receipts).not.toHaveBeenCalled(); expect(db.entries('wintr_ledger')).toEqual([]);
    expect([net.reference.length, net.qloo.length, net.cat.calls.length, net.net.requests.length]).toEqual([0, 0, 0, 0]);
  });
  it('reads the existing namespace and preserves holds over two independent compositions', async () => {
    const p = profile(), db = new FakeFirestoreServer(), net = transports(), receipts: unknown[] = [];
    db.seed(`wintr_ledger_service/${p.serviceId}`, { schema: 1, kind: 'service', ...baseline(), updatedAt: T - 10 });
    const google = { client: {} as any, accessToken: async () => new ServerSecret('invented-access-token'), close() {} };
    let spent = baseline();
    for (let launch = 0; launch < 2; launch++) {
      const composed = await composePersonalRuntime({ profile: profile(), checkAuthority() {}, google,
        secret: async ref => new ServerSecret(ref === 'personal/sealing' ? 'invented-sealing-key-material-00000001' : 'invented-provider-secret'),
        recordAccounting: t => receipts.push(t), firestore: () => new FakeFirestore(db), network: net.network, clock: () => T + launch * 100 });
      expect(composed.runtime.config.mode).toBe('live'); expect(composed.totals).toEqual(spent);
      if (launch === 0) {
        const server = createServer((req, res) => void composed.runtime.handler(req, res)); servers.push(server);
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as AddressInfo).port;
        const send = (path: string, value: unknown, cookie?: string) => new Promise<{ status: number; cookie?: string; body: any }>((done, fail) => {
          const body = JSON.stringify(value);
          const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: composed.runtime.config.hostHeader, origin: composed.runtime.config.origin, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), ...(cookie ? { cookie } : {}) } }, res => {
            let data = ''; res.setEncoding('utf8'); res.on('data', c => data += c); res.on('end', () => done({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0]?.split(';')[0], body: JSON.parse(data) }));
          }); req.on('error', fail); req.end(body);
        });
        const session = await send('/api/session', {}); expect(session.status).toBe(201);
        const reference = await send('/api/reference', { url: 'https://youtu.be/invRefAAA01', actionKey: 'invented-personal-action-00000001' }, session.cookie);
        expect(reference.status).toBe(200); expect(reference.body.analysis.synthetic).toBe(false);
        spent = { ...baseline(), unitsHeld: 719, counts: { qloo: 8, gemini: 8 }, unresolved: 16 };
        expect(await composed.runtime.store.reconciliation().totals()).toEqual(spent);
      }
      await composed.runtime.close();
    }
    expect(receipts).toEqual([baseline(), spent]); expect(db.entries('wintr_ledger_service')).toHaveLength(1);
    expect([net.reference.length, net.qloo.length, net.cat.calls.length]).toEqual([1, 0, 0]);
  });
});

describe('authenticated local desktop reopening', () => {
  it('opens only the approved running instance, rejects unrelated services and stops reporting ready after revocation', async () => {
    const p = profile(), key = 'c'.repeat(64); let allowed = true;
    const server = createServer(); servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const port = (server.address() as AddressInfo).port;
    const probe = createDesktopProbe({ hostHeader: `127.0.0.1:${port}` }, p.profileId, key, () => { if (!allowed) throw new Error(); });
    server.on('request', (req, res) => { if (!probe.handle(req, res)) res.writeHead(404).end(); });
    const origin = `http://127.0.0.1:${port}`;
    expect(await probePersonalApp(origin, p.profileId, key)).toBe(true);
    expect(await probePersonalApp(origin, p.profileId, 'd'.repeat(64))).toBe(false);
    expect(await probePersonalApp(origin, 'b'.repeat(32), key)).toBe(false);
    const wrongHost = await new Promise<number>(r => { const req = request(`${origin}/api/desktop-status`, { headers: { host: 'localhost', 'x-wintr-challenge': 'e'.repeat(64) } }, res => { res.resume(); res.on('end', () => r(res.statusCode!)); }); req.end(); }); expect(wrongHost).toBe(421);
    allowed = false; expect(await probePersonalApp(origin, p.profileId, key)).toBe(false);
  });
  it('rejects forged/oversized responses and never fetches a remote origin', async () => {
    const send = vi.fn(async () => new Response('x'.repeat(4097)));
    expect(await probePersonalApp('https://example.invalid', profile().profileId, 'c'.repeat(64), send as typeof fetch)).toBe(false); expect(send).not.toHaveBeenCalled();
    expect(await probePersonalApp('http://127.0.0.1:4876', profile().profileId, 'c'.repeat(64), send as typeof fetch)).toBe(false);
    expect(verifyDesktopProbe({ profileId: profile().profileId, pid: 1, challenge: 'a'.repeat(64), proof: 'b'.repeat(64) }, profile().profileId, 'c'.repeat(64), 'a'.repeat(64))).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('Windows CurrentUser protection with invented values', () => {
  it('round-trips only its own purpose/profile and never overwrites an existing protected box', () => {
    const script = resolve('runtime/WintrProtect.exe'), dir = directory(), store = new WindowsPersonalSecrets(dir, script), p = profile();
    store.writeNew('desktop', p.profileId, 'c'.repeat(64)); expect(store.desktopKey(p.profileId)).toBe('c'.repeat(64));
    expect(() => store.desktopKey('b'.repeat(32))).toThrow(); expect(() => store.writeNew('desktop', p.profileId, 'd'.repeat(64))).toThrow();
    const cipher = readFileSync(join(dir, 'desktop.dpapi')); expect(cipher.toString()).not.toContain('c'.repeat(64));
    expect(() => windowsProtection('unprotect', cipher, 'google', script)).toThrow();
  }, 30000);
  it('publishes setup only after verified protected import, removes temporary ADC and reconnects without resetting anything', () => {
    const dir = directory(), helper = resolve('runtime/WintrProtect.exe');
    writeFileSync(join(dir, 'setup-approved.json'), JSON.stringify(rawProfile()));
    const providers = { reference: 'invented-reference-key', qloo: 'invented-qloo-key', sealing: 'invented-sealing-key-material-000000001' };
    stagePersonalProviders(dir, helper, providers, T);
    stagePersonalProviders(dir, helper, providers, T); // safe resume of an interrupted one-time setup
    expect(existsSync(join(dir, 'profile.json'))).toBe(false);
    mkdirSync(join(dir, 'onboarding'));
    const adcFile = join(dir, 'onboarding/application_default_credentials.json');
    writeFileSync(adcFile, JSON.stringify(adc()));
    expect(finishPersonalSetup(dir, helper, T)).toEqual({ ok: true }); expect(existsSync(adcFile)).toBe(false);
    const before = readFileSync(join(dir, 'profile.json'));
    recordPersonalAccounting(join(dir, 'accounting.jsonl'), profile(), baseline(), T);
    const journal = readFileSync(join(dir, 'accounting.jsonl')), providerBox = readFileSync(join(dir, 'providers.dpapi'));
    const renewed = adc(); renewed.source_credentials.refresh_token = 'invented-reconnected-refresh';
    writeFileSync(adcFile, JSON.stringify(renewed)); finishPersonalSetup(dir, helper, T + 1);
    expect(readFileSync(join(dir, 'profile.json'))).toEqual(before);
    expect(readFileSync(join(dir, 'accounting.jsonl'))).toEqual(journal);
    expect(readFileSync(join(dir, 'providers.dpapi'))).toEqual(providerBox);
    const stored = new WindowsPersonalSecrets(dir, helper).read('google', profile().profileId);
    expect(parsePersonalGoogleCredential(stored, profile()).refreshToken.reveal()).toBe('invented-reconnected-refresh');
    expect(JSON.stringify(stored)).not.toContain('"account"');
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...rawProfile(), enabled: false }));
    expect(() => approvedSetup(dir, T + 1)).toThrow();
  }, 30000);
});
