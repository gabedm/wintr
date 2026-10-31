import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personalDataDirectory } from './personal-entry.js';
import { approvedSetup, finishPersonalSetup } from './personal-setup.js';
import { ownData, personalFingerprint, PersonalSetupError } from './personal-profile.js';
import { parsePrivateJson, readPrivateFile, WindowsPersonalSecrets } from './windows-secrets.js';
import { desktopCommand } from './desktop-launcher.js';

async function holdNativeSetup(helper: string, profileId: string) {
  if (!/^[a-f0-9]{32}$/.test(profileId)) throw new PersonalSetupError('setup_required');
  const child = spawn(helper, ['setup-lock', profileId], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let ended = false, held = false;
  const exited = new Promise<void>(done => { child.once('exit', () => { ended = true; done(); }); child.once('error', () => { ended = true; done(); }); });
  child.stderr.resume();
  try {
    await new Promise<void>((done, fail) => {
      let text = '';
      const timer = setTimeout(() => { child.stdin.end(); fail(new PersonalSetupError('already_starting')); }, 5000);
      const finish = () => { clearTimeout(timer); child.stdout.removeListener('data', data); };
      const data = (bytes: Buffer) => {
        text += bytes.toString('utf8');
        if (text === 'locked\r\n' || text === 'locked\n') { held = true; finish(); child.stdout.resume(); done(); }
        else if (text.length > 64) { finish(); child.stdin.end(); fail(new PersonalSetupError('setup_required')); }
      };
      child.stdout.on('data', data);
      void exited.then(() => { finish(); if (!held) fail(new PersonalSetupError('already_starting')); });
    });
  } catch (error) { child.stdin.end(); throw error; }
  return {
    check() { if (!held || ended) throw new PersonalSetupError('setup_changed'); },
    async release() {
      held = false; child.stdin.end(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<void>((_, fail) => { timer = setTimeout(() => fail(new PersonalSetupError('setup_changed')), 5000); })]); }
      finally { clearTimeout(timer); }
    },
  };
}

/** A native mutex serializes even simultaneous reclamation of an old PID file. */
export async function acquirePersonalSetup(directory: string, helper: string, profileId: string) {
  const holder = await holdNativeSetup(helper, profileId);
  try {
  const file = join(directory, 'setup-lock.json'), nonce = randomBytes(16).toString('hex');
  const live = (pid: unknown) => {
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  if (existsSync(file)) {
    const before = readPrivateFile(file, 4096), old = ownData(parsePrivateJson(before), ['schema', 'pid', 'childPid', 'nonce']);
    if (old.schema !== 1 || typeof old.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(old.nonce) ||
        typeof old.pid !== 'number' || !Number.isSafeInteger(old.pid) || old.pid < 1 ||
        (old.childPid !== null && (typeof old.childPid !== 'number' || !Number.isSafeInteger(old.childPid) || old.childPid < 1))) throw new PersonalSetupError('setup_required');
    if (live(old.pid) || live(old.childPid)) throw new PersonalSetupError('already_starting');
    if (!before.equals(readPrivateFile(file, 4096))) throw new PersonalSetupError('already_starting');
    unlinkSync(file);
  }
  const value = { schema: 1, pid: process.pid, childPid: null as number | null, nonce };
  try { writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch { throw new PersonalSetupError('already_starting'); }
  return {
    check: () => holder.check(),
    child(pid: number) {
      holder.check();
      value.childPid = pid; const pending = file + '.' + nonce + '.pending';
      writeFileSync(pending, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); renameSync(pending, file);
    },
    async release() { try { if ((parsePrivateJson(readPrivateFile(file, 4096)) as Record<string, unknown>).nonce === nonce) unlinkSync(file); } finally { await holder.release(); } },
  };
  } catch (error) { await holder.release(); throw error; }
}

/** Official Google browser sign-in, only on an explicit user setup/reconnect action. */
export async function connectPersonalGoogle(directory: string, helper: string) {
  const p = approvedSetup(directory), fingerprint = personalFingerprint(p);
  const lock = await acquirePersonalSetup(directory, helper, p.profileId);
  const check = () => { lock.check(); if (personalFingerprint(approvedSetup(directory)) !== fingerprint) throw new PersonalSetupError('setup_changed'); };
  try {
  check();
  const store = new WindowsPersonalSecrets(directory, helper); store.providers(p.profileId); store.desktopKey(p.profileId);
  const tools = ownData(parsePrivateJson(readPrivateFile(join(directory, 'setup-tools.json'), 4096)), ['schema', 'sdkRoot']);
  if (tools.schema !== 1 || typeof tools.sdkRoot !== 'string' || !tools.sdkRoot || resolve(tools.sdkRoot) !== tools.sdkRoot) throw new PersonalSetupError('setup_required');
  const sdk = tools.sdkRoot, python = join(sdk, 'platform/bundledpython/python.exe'), cli = join(sdk, 'lib/gcloud.py');
  if (!existsSync(python) || !existsSync(cli)) throw new PersonalSetupError('setup_required');
  const config = join(directory, 'onboarding'); mkdirSync(config, { recursive: true });
  if (lstatSync(config).isSymbolicLink() || !lstatSync(config).isDirectory()) throw new PersonalSetupError('setup_required');
  // The official CLI necessarily writes one temporary ADC file here. It is
  // protected and removed after a verified successful import, or removed after
  // a failed connection. Never discover or replace the user's normal gcloud ADC.
  const adc = join(config, 'application_default_credentials.json');
  // Explicit setup retry discards only this bounded regular app-owned temporary
  // file, after serialization proves no previous setup process can still use it.
  if (existsSync(adc)) { readPrivateFile(adc, 65536); check(); unlinkSync(adc); }
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CLOUDSDK_|GOOGLE_|GCLOUD_)/i.test(key)));
  Object.assign(env, { CLOUDSDK_CONFIG: config, CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: 'true', CLOUDSDK_PYTHON: python });
  check();
  const child = spawn(python, [cli, 'auth', 'application-default', 'login', '--impersonate-service-account=' + p.runtimeServiceAccount, '--project=' + p.projectId, '--disable-quota-project'],
    { env, cwd: sdk, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // OAuth URLs and CLI diagnostics stay in this child pipe and are not logged.
  child.stdout.resume(); child.stderr.resume();
  if (child.pid) lock.child(child.pid);
  let ended = false;
  const guard = setInterval(() => { try { check(); } catch { if (!ended) child.kill(); } }, 500);
  const timeout = setTimeout(() => { if (!ended) child.kill(); }, 5 * 60_000);
  try {
    const code = await new Promise<number | null>((done, fail) => { child.once('error', fail); child.once('exit', done); });
    ended = true; check(); if (code !== 0) throw new PersonalSetupError('sign_in_required');
    const result = finishPersonalSetup(directory, helper);
    // A reconnect must replace the captured in-memory identity, not just disk.
    await desktopCommand('stop-and-wait', directory);
    return result;
  } finally {
    ended = true; clearInterval(guard); clearTimeout(timeout);
    if (existsSync(adc)) unlinkSync(adc);
  }
  } finally { await lock.release(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), root = fileURLToPath(new URL('../../../', import.meta.url));
  if (args.length !== 2 || args[0] !== '--data-dir' || !args[1] || process.platform !== 'win32') process.exitCode = 1;
  else void connectPersonalGoogle(args[1] ?? personalDataDirectory(), join(root, 'runtime/WintrProtect.exe')).then(() => console.log(JSON.stringify({ ok: true }))).catch(() => { console.log(JSON.stringify({ ok: false, code: 'sign_in_required' })); process.exitCode = 1; });
}
