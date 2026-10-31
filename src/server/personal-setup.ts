import { existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parsePersonalProfile, personalFingerprint, ownData, PersonalSetupError } from './personal-profile.js';
import { parsePersonalGoogleCredential } from './personal-google.js';
import { WindowsPersonalSecrets, parsePrivateJson, readPrivateFile, windowsProtection } from './windows-secrets.js';
import { ServerSecret } from './providers/secret.js';

/** One-time controller-approved local import. No Cloud role/key creation or network. */
export function approvedSetup(directory: string, now = Date.now()) {
  const pending = parsePersonalProfile(parsePrivateJson(readPrivateFile(join(directory, 'setup-approved.json'), 65536)), now);
  const currentFile = join(directory, 'profile.json');
  if (existsSync(currentFile)) {
    const current = parsePersonalProfile(parsePrivateJson(readPrivateFile(currentFile, 65536)), now);
    if (personalFingerprint(current) !== personalFingerprint(pending)) throw new PersonalSetupError('setup_changed');
  }
  return pending;
}
export function stagePersonalProviders(directory: string, helper: string, raw: unknown, now = Date.now()) {
  const p = approvedSetup(directory, now), values = ownData(raw, ['reference', 'qloo', 'sealing']);
  const checked = { reference: new ServerSecret(values.reference as string), qloo: new ServerSecret(values.qloo as string), sealing: new ServerSecret(values.sealing as string) };
  if (checked.sealing.reveal().length < 32 || existsSync(join(directory, 'profile.json'))) throw new PersonalSetupError('setup_required');
  const store = new WindowsPersonalSecrets(directory, helper);
  if (existsSync(join(directory, 'providers.dpapi'))) {
    const existing = store.providers(p.profileId);
    if (existing.reference.reveal() !== checked.reference.reveal() || existing.qloo.reveal() !== checked.qloo.reveal() || existing.sealing.reveal() !== checked.sealing.reveal()) throw new PersonalSetupError('setup_changed');
  } else store.writeNew('providers', p.profileId, values);
  if (existsSync(join(directory, 'desktop.dpapi'))) store.desktopKey(p.profileId);
  else store.writeNew('desktop', p.profileId, randomBytes(32).toString('hex'));
  // Verify protection before any Google connection is attempted.
  store.providers(p.profileId); store.desktopKey(p.profileId);
}
export function finishPersonalSetup(directory: string, helper: string, now = Date.now()) {
  const p = approvedSetup(directory, now), store = new WindowsPersonalSecrets(directory, helper);
  store.providers(p.profileId); store.desktopKey(p.profileId);
  const adcFile = join(directory, 'onboarding', 'application_default_credentials.json');
  const credential = parsePersonalGoogleCredential(parsePrivateJson(readPrivateFile(adcFile, 65536)), p);
  // Keep only the refresh material the explicit client needs. No account/email,
  // scopes, local file paths, default-account selectors or private key are saved.
  const normalized = { type: 'impersonated_service_account', delegates: [],
    service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + p.runtimeServiceAccount + ':generateAccessToken',
    source_credentials: { type: 'authorized_user', client_id: credential.clientId, client_secret: credential.clientSecret.reveal(), refresh_token: credential.refreshToken.reveal() } };
  const packet = Buffer.from(JSON.stringify({ kind: 'wintr-personal-google-v1', profileId: p.profileId, value: normalized }));
  const pending = join(directory, 'google.' + randomBytes(8).toString('hex') + '.pending');
  try {
    writeFileSync(pending, windowsProtection('protect', packet, 'google', helper), { flag: 'wx', mode: 0o600 });
    // Verify this exact pending blob under this Windows account before replacing
    // a disconnected identity. Reconnection never writes the budget or journal.
    const cipher = readPrivateFile(pending), plain = windowsProtection('unprotect', cipher, 'google', helper);
    try { if (!plain.equals(packet)) throw new PersonalSetupError('setup_required'); } finally { plain.fill(0); }
    approvedSetup(directory, now); renameSync(pending, join(directory, 'google.dpapi'));
    parsePersonalGoogleCredential(store.read('google', p.profileId), p);
    unlinkSync(adcFile);
    if (!existsSync(join(directory, 'profile.json'))) writeFileSync(join(directory, 'profile.json'), JSON.stringify(p), { flag: 'wx', mode: 0o600 });
    return { ok: true };
  } finally { packet.fill(0); if (existsSync(pending)) unlinkSync(pending); }
}
