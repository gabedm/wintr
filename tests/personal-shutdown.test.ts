import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WindowsPersonalSecrets } from '../src/server/windows-secrets.js';
import { runPersonalApp } from '../src/server/personal-entry.js';

// Invented protected files and held shutdown; no network or real account.
const state = vi.hoisted(() => ({ options: null as any, release: null as (() => void) | null }));
vi.mock('../src/server/personal-runtime.js', () => ({ composePersonalRuntime: async (options: any) => {
  state.options = options;
  options.google.client.credentials = { access_token: 'invented-cached-google-access', expiry_date: Date.now() + 3_600_000 };
  return { runtime: { config: { hostHeader: '127.0.0.1:4876' }, close: async () => {} } };
} }));
vi.mock('../src/server/live-runtime.js', () => ({ startLiveServer: async () => ({
  ok: true, origin: 'http://127.0.0.1:4876', close: async () => new Promise<void>(done => { state.release = done; }),
}) }));
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + '\\wintr-shutdown-invented-')) throw new Error('Unexpected test path');
    rmSync(dir, { recursive: true });
  }
});
it('refuses an inherited emulator before profile or protected credential access', async () => {
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:9999');
  await expect(runPersonalApp('missing-invented-profile')).rejects.toThrow('setup_changed');
});
it.skipIf(process.platform !== 'win32')('stops dispatch immediately, drains with approved identity, and revokes on profile removal or completed close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wintr-shutdown-invented-')); dirs.push(dir);
  const id = 'a'.repeat(32), sa = 'wintr-runtime@invented-project.iam.gserviceaccount.com';
  const profile = { schema: 1, profileId: id, approved: true, approvalId: 'call_invented_shutdown', approvedAt: Date.now() - 1000, authority: 'until_revoked', enabled: true,
    projectId: 'invented-project', quotaProjectId: 'invented-project', geminiProjectId: 'invented-gemini', databaseId: 'invented-db', runtimeServiceAccount: sa,
    serviceId: 'svc-invented-personal', serviceIdentity: 'runtime-invented', settlementOwner: 'owner-invented', port: 4876,
    baseline: { currency: 'GBP', counts: { qloo: 0, gemini: 0 }, unitsHeld: 0, unresolved: 0, active: 0 }, allowance: { gbpMinor: 10000, qloo: 120, gemini: 80 },
    deniedVideoIds: [], deniedRecordedDigests: [], recordedMusicApprovalId: null };
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile));
  writeFileSync(join(dir, 'setup-approved.json'), JSON.stringify(profile));
  const store = new WindowsPersonalSecrets(dir, resolve('runtime/WintrProtect.exe'));
  store.writeNew('google', id, { type: 'impersonated_service_account', delegates: [],
    service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + sa + ':generateAccessToken',
    source_credentials: { type: 'authorized_user', client_id: 'invented-client.apps.googleusercontent.com', client_secret: 'invented-client-secret', refresh_token: 'invented-refresh-token' } });
  store.writeNew('providers', id, { reference: 'invented-reference', qloo: 'invented-qloo-key', sealing: 'invented-sealing-material-000000001' });
  store.writeNew('desktop', id, 'b'.repeat(64));
  const app = await runPersonalApp(dir, resolve('.'));
  const pending = app.close();
  try {
    expect(() => state.options.checkAuthority()).toThrow();
    expect((await state.options.google.client.getRequestHeaders()).get('authorization')).toContain('invented-cached-google-access');
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...profile, enabled: false }));
    await expect(state.options.google.client.getRequestHeaders()).rejects.toThrow();
  } finally { state.release!(); await pending; }
  expect(existsSync(join(dir, 'instance.json'))).toBe(false);
  await expect(state.options.google.accessToken()).rejects.toThrow();
}, 30000);
