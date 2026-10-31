import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parsePersonalProfile, personalFingerprint, PersonalSetupError } from './personal-profile.js';
import { parsePersonalGoogleCredential, createPersonalGoogleIdentity } from './personal-google.js';
import { WindowsPersonalSecrets, parsePrivateJson, readPrivateFile } from './windows-secrets.js';
import { composePersonalRuntime } from './personal-runtime.js';
import { createDesktopProbe } from './desktop-probe.js';
import { recordPersonalAccounting } from './personal-accounting.js';
import { startLiveServer } from './live-runtime.js';
import { approvedSetup } from './personal-setup.js';
import { capturePersonalLivePermission } from './personal-live.js';
import { captureWindowsTicketmaster } from './personal-ticketmaster.js';

export const personalDataDirectory = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Wintr');
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const atomicJson = (file: string, value: unknown) => {
  const pending = `${file}.${randomBytes(8).toString('hex')}.pending`;
  writeFileSync(pending, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(pending, file);
};
export async function runPersonalApp(dataDirectory: string, applicationRoot = appRoot) {
  // The normal desktop product must use its approved shared database. The SDK
  // otherwise silently lets an inherited development variable redirect it.
  if (process.env.FIRESTORE_EMULATOR_HOST !== undefined) throw new PersonalSetupError('setup_changed');
  const dir = resolve(dataDirectory), profileFile = join(dir, 'profile.json');
  // Absent/revoked approval refuses before any protected-file or identity load.
  const readProfile = () => parsePersonalProfile(parsePrivateJson(readPrivateFile(profileFile, 65536)), Date.now());
  const profile = readProfile(), fingerprint = personalFingerprint(profile), bootNonce = randomBytes(16).toString('hex');
  // Compare the retained controller-approved anchor before any protected load.
  if (personalFingerprint(approvedSetup(dir)) !== fingerprint) throw new PersonalSetupError('setup_changed');
  const liveListening = capturePersonalLivePermission(dir, profile);
  let stopped = false;
  const checkProfile = () => { if (personalFingerprint(readProfile()) !== fingerprint || personalFingerprint(approvedSetup(dir)) !== fingerprint) throw new PersonalSetupError('setup_changed'); };
  const check = () => { if (stopped) throw new PersonalSetupError('setup_changed'); checkProfile(); };
  check();
  const secrets = new WindowsPersonalSecrets(dir, join(applicationRoot, 'runtime/WintrProtect.exe'));
  const google = createPersonalGoogleIdentity(parsePersonalGoogleCredential(secrets.read('google', profile.profileId), profile), profile, checkProfile);
  const readyFile = join(dir, 'instance.json');
  let composed: Awaited<ReturnType<typeof composePersonalRuntime>> | undefined;
  let server: Awaited<ReturnType<typeof startLiveServer>> | undefined;
  let watcher: ReturnType<typeof setInterval> | undefined, closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    // Stop dispatch synchronously; retain the still-approved identity for Store
    // draining. Disabling the ongoing profile revokes that identity immediately.
    stopped = true; if (watcher) clearInterval(watcher);
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    closing = (async () => {
      try { if (server?.ok) await server.close(); else if (composed) await composed.runtime.close(); }
      finally {
        google.close();
        try { const ready = JSON.parse(readFileSync(readyFile, 'utf8')); if (ready.bootNonce === bootNonce) unlinkSync(readyFile); } catch { /* No other instance's file is touched. */ }
      }
    })();
    return closing;
  };
  const onSignal = () => void close().catch(() => {});
  try {
    check(); const providers = secrets.providers(profile.profileId); check();
    const desktopKey = secrets.desktopKey(profile.profileId); check();
    composed = await composePersonalRuntime({ profile, checkAuthority: check, google,
      ...(liveListening ? { liveListening } : {}),
      ticketmaster: captureWindowsTicketmaster(dir, profile, join(applicationRoot, 'runtime/WintrProtect.exe'), check),
      secret: async ref => { check(); const secret = ({ 'personal/reference': providers.reference, 'personal/qloo': providers.qloo, 'personal/sealing': providers.sealing } as const)[ref as 'personal/reference']; if (!secret) throw new PersonalSetupError('setup_required'); return secret; },
      recordAccounting: totals => recordPersonalAccounting(join(dir, 'accounting.jsonl'), profile, totals, Date.now()),
    });
    check();
    const desktopProbe = createDesktopProbe(composed.runtime.config, profile.profileId, desktopKey, check);
    server = await startLiveServer(composed.runtime, { clientRoot: join(applicationRoot, 'dist/client'), desktopProbe });
    if (!server.ok) throw new PersonalSetupError('startup_failed');
    check();
    atomicJson(readyFile, { schema: 1, profileId: profile.profileId, pid: process.pid, bootNonce, origin: server.origin, startedAt: Date.now(), mode: 'live' });
    watcher = setInterval(() => {
      try {
        check(); liveListening?.checkAuthority();
        const stopFile = join(dir, 'stop-request.json');
        if (existsSync(stopFile)) {
          const request = parsePrivateJson(readPrivateFile(stopFile, 4096)) as Record<string, unknown>;
          if (request.profileId === profile.profileId && request.bootNonce === bootNonce) void close().catch(() => {});
        }
      } catch { void close().catch(() => {}); }
    }, 500);
    watcher.unref();
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    console.log(JSON.stringify({ ok: true, mode: 'live', origin: server.origin, providerRequestsDuringStartup: 0 }));
    return { close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--data-dir' || !args[1] || process.platform !== 'win32') {
    console.log(JSON.stringify({ ok: false, code: 'setup_required' })); process.exitCode = 1;
  } else {
    let shutdown: (() => Promise<void>) | undefined;
    let fatal = false;
    const fail = () => {
      if (fatal) return; fatal = true;
      console.error(JSON.stringify({ ok: false, code: 'startup_failed' }));
      if (!shutdown) { process.exit(1); }
      const timeout = setTimeout(() => process.exit(1), 5000); timeout.unref();
      void shutdown().catch(() => {}).finally(() => process.exit(1));
    };
    process.on('unhandledRejection', fail); process.on('uncaughtException', fail);
    void runPersonalApp(args[1]).then(app => { shutdown = app.close; }).catch(error => {
      console.log(JSON.stringify({ ok: false, code: error instanceof PersonalSetupError ? error.code : 'startup_failed' })); process.exitCode = 1;
    });
  }
}
