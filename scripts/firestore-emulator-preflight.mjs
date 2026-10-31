// Pure, value-free validation. This module imports no SDK, credentials or network code.
export const E05_TARGET = Object.freeze({ host: '127.0.0.1:8089', projectId: 'demo-wintr-e05', databaseId: '(default)', sdkVersion: '9.3.1' });

export function assertEmulatorEnvironment(env = process.env) {
  const fail = () => { throw new Error('E05 emulator preflight refused'); };
  // Refuse before importing SDK/GAX: their certificate discovery is independent of ssl:false.
  if (env.GOOGLE_API_USE_CLIENT_CERTIFICATE !== undefined && env.GOOGLE_API_USE_CLIENT_CERTIFICATE !== 'false') fail();
  if (env.FIRESTORE_EMULATOR_HOST !== E05_TARGET.host || env.GCLOUD_PROJECT !== E05_TARGET.projectId || env.WINTR_E05_DATABASE !== E05_TARGET.databaseId) fail();
  for (const key of ['GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT']) {
    if (env[key] !== undefined && env[key] !== E05_TARGET.projectId) fail();
  }
  if (env.FIREBASE_FIRESTORE_EMULATOR_ADDRESS !== undefined && env.FIREBASE_FIRESTORE_EMULATOR_ADDRESS !== E05_TARGET.host) fail();
  if (env.FIREBASE_CONFIG !== undefined) {
    let config;
    try { config = JSON.parse(env.FIREBASE_CONFIG); } catch { fail(); }
    if (!config || config.projectId !== E05_TARGET.projectId || (config.databaseId !== undefined && config.databaseId !== E05_TARGET.databaseId)) fail();
  }
  return E05_TARGET;
}
