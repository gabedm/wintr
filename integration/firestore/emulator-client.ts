import { createRequire } from 'node:module';
import type { Settings } from '@google-cloud/firestore';
import type { GoogleAuthOptions, PassThroughClient } from 'google-auth-library';
import { assertEmulatorEnvironment } from '../../scripts/firestore-emulator-preflight.mjs';

/** Only this opt-in test harness constructs an emulator SDK. No app startup uses it. */
export async function createEmulatorClient(
  loadSdk: () => Promise<Pick<typeof import('@google-cloud/firestore'), 'Firestore'>> = () => import('@google-cloud/firestore'),
) {
  assertEmulatorEnvironment();
  const require = createRequire(import.meta.url);
  if (require('@google-cloud/firestore/package.json').version !== '9.3.1') throw new Error('E05 SDK version refused');
  if (require('google-auth-library/package.json').version !== '11.3.1') throw new Error('E05 auth library version refused');
  const [sdk, auth] = await Promise.all([loadSdk(), import('google-auth-library')]);
  const target = assertEmulatorEnvironment(); // Refresh after asynchronous loading.
  // Public GoogleAuth options forwarded by the SDK/GAX; emulator-only and never
  // shared with the live identity factories. An endpoint alone does not prevent ADC.
  const settings: Settings & GoogleAuthOptions<PassThroughClient> = {
    projectId: target.projectId, databaseId: target.databaseId, host: target.host, ssl: false, preferRest: false,
    authClient: new auth.PassThroughClient({ projectId: target.projectId, universeDomain: 'googleapis.com' }),
    universeDomain: 'googleapis.com',
  };
  return new sdk.Firestore(settings);
}
