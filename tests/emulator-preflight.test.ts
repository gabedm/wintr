import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleAuth, PassThroughClient, type GoogleAuthOptions } from 'google-auth-library';
import type { Settings } from '@google-cloud/firestore';
import { assertEmulatorEnvironment } from '../scripts/firestore-emulator-preflight.mjs';
import { createEmulatorClient } from '../integration/firestore/emulator-client.js';
import defaultConfig from '../vitest.config.js';

// Pure preflight and loader probes only. No SDK module is loaded/constructed,
// no emulator is contacted, and none of these cases claim emulator acceptance.
const valid = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8089', GCLOUD_PROJECT: 'demo-wintr-e05', WINTR_E05_DATABASE: '(default)' };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('opt-in emulator preflight and default isolation', () => {
  it.each([
    {}, { ...valid, FIRESTORE_EMULATOR_HOST: undefined }, { ...valid, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' },
    { ...valid, FIRESTORE_EMULATOR_HOST: '0.0.0.0:8089' }, { ...valid, FIRESTORE_EMULATOR_HOST: 'localhost:8089' },
    { ...valid, FIRESTORE_EMULATOR_HOST: 'http://127.0.0.1:8089' }, { ...valid, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' },
    { ...valid, GCLOUD_PROJECT: undefined }, { ...valid, GCLOUD_PROJECT: 'real-project' }, { ...valid, WINTR_E05_DATABASE: undefined },
    { ...valid, WINTR_E05_DATABASE: 'other-db' }, { ...valid, GOOGLE_CLOUD_PROJECT: 'other-project' },
    { ...valid, GCP_PROJECT: 'other-project' }, { ...valid, FIREBASE_CONFIG: '{bad-json' },
    { ...valid, FIREBASE_CONFIG: '{"projectId":"other-project"}' },
    { ...valid, FIREBASE_CONFIG: '{"projectId":"demo-wintr-e05","databaseId":"other-db"}' },
    { ...valid, FIREBASE_FIRESTORE_EMULATOR_ADDRESS: 'elsewhere.invalid:8089' },
    { ...valid, GOOGLE_API_USE_CLIENT_CERTIFICATE: 'true' },
    { ...valid, GOOGLE_API_USE_CLIENT_CERTIFICATE: 'TRUE' },
  ])('rejects missing or conflicting authority with a value-free error (%#)', (env) => {
    expect(() => assertEmulatorEnvironment(env)).toThrow(/^E05 emulator preflight refused$/);
  });

  it('accepts the exact fictional target, including matching CLI-injected project configuration', () => {
    expect(assertEmulatorEnvironment({ ...valid, FIREBASE_CONFIG: '{"projectId":"demo-wintr-e05"}' })).toMatchObject({ projectId: 'demo-wintr-e05', databaseId: '(default)' });
  });

  it('never loads the SDK on missing authority', async () => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', undefined);
    const load = vi.fn(async () => { throw new Error('SDK must not load'); });
    await expect(createEmulatorClient(load)).rejects.toThrow('E05 emulator preflight refused');
    expect(load).not.toHaveBeenCalled();
  });

  it('refreshes authority after an asynchronous SDK load before constructing any client', async () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');
    for (const key of ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'FIREBASE_CONFIG', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS']) vi.stubEnv(key, undefined);
    const construct = vi.fn();
    const load = async () => {
      vi.stubEnv('FIRESTORE_EMULATOR_HOST', 'elsewhere.invalid:443');
      return { Firestore: construct } as unknown as typeof import('@google-cloud/firestore');
    };
    await expect(createEmulatorClient(load)).rejects.toThrow('E05 emulator preflight refused');
    expect(construct).not.toHaveBeenCalled();
  });

  it('refuses certificate discovery before the SDK loader and leaves the setting unchanged', async () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    const load = vi.fn(async () => { throw new Error('SDK must not load'); });
    await expect(createEmulatorClient(load)).rejects.toThrow('E05 emulator preflight refused');
    expect(load).not.toHaveBeenCalled(); expect(process.env.GOOGLE_API_USE_CLIENT_CERTIFICATE).toBe('true');
  });

  it('the emulator constructor receives explicit public no-auth/universe options independent of ADC', async () => {
    for (const [key, value] of Object.entries(valid)) vi.stubEnv(key, value);
    for (const key of ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT', 'FIREBASE_CONFIG', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS']) vi.stubEnv(key, undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');
    const captured: (Settings & GoogleAuthOptions<PassThroughClient>)[] = [];
    class ConstructorProbe { constructor(settings: Settings & GoogleAuthOptions<PassThroughClient>) { captured.push(settings); } }
    const load = async () => ({ Firestore: ConstructorProbe }) as unknown as Pick<typeof import('@google-cloud/firestore'), 'Firestore'>;
    await createEmulatorClient(load);
    const options = captured[0]!;
    expect(options).toMatchObject({ projectId: 'demo-wintr-e05', databaseId: '(default)', host: '127.0.0.1:8089', ssl: false, universeDomain: 'googleapis.com' });
    expect(options.authClient).toBeInstanceOf(PassThroughClient);
    expect(options.authClient!.projectId).toBe('demo-wintr-e05'); expect(options.authClient!.universeDomain).toBe('googleapis.com');
    const adc = vi.spyOn(GoogleAuth.prototype, 'getApplicationDefault').mockRejectedValue(new Error('ADC must not be discovered'));
    const auth = new GoogleAuth<PassThroughClient>(options);
    expect(await auth.getUniverseDomain()).toBe('googleapis.com'); expect(await auth.getProjectId()).toBe('demo-wintr-e05');
    expect(await auth.getClient()).toBe(options.authClient);
    expect([...(await auth.getRequestHeaders()).entries()]).toEqual([]);
    expect(adc).not.toHaveBeenCalled();
  });

  it('the explicit runner exits nonzero before test discovery when preflight fails', () => {
    const run = spawnSync(process.execPath, ['scripts/run-firestore-emulator-tests.mjs'], { encoding: 'utf8', env: { ...process.env, FIRESTORE_EMULATOR_HOST: '' } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('E05 emulator preflight refused');
    expect(run.stdout).not.toContain('RUN');
  });

  it('default discovery and startup do not include the opt-in target; the checked-in config binds all listeners to loopback', () => {
    expect(defaultConfig.test!.include).toEqual(['tests/**/*.test.{ts,tsx}']);
    expect(defaultConfig.test!.exclude).toContain('integration/**');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.test).toBe('vitest run');
    expect(pkg.dependencies['firebase-tools']).toBeUndefined();
    expect(pkg.devDependencies['firebase-tools']).toBeUndefined();
    const cfg = JSON.parse(readFileSync('firebase.e05.json', 'utf8'));
    expect(cfg.firestore.database).toBe('(default)'); expect(cfg.emulators.ui.enabled).toBe(false);
    for (const name of ['firestore', 'hub', 'logging']) expect(cfg.emulators[name].host).toBe('127.0.0.1');
    expect(Object.keys(cfg).sort()).toEqual(['emulators', 'firestore']);
  });
});
