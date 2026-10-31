import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personalDataDirectory } from './personal-entry.js';
import { parsePersonalProfile, PersonalSetupError } from './personal-profile.js';
import { parsePrivateJson, readPrivateFile, WindowsPersonalSecrets } from './windows-secrets.js';
import { verifyDesktopProbe } from './desktop-probe.js';

export async function probePersonalApp(origin: string, profileId: string, key: string, send: typeof fetch = fetch): Promise<boolean> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)) return false;
  const challenge = randomBytes(32).toString('hex');
  try {
    const response = await send(`${origin}/api/desktop-status`, { headers: { 'x-wintr-challenge': challenge }, signal: AbortSignal.timeout(1500), redirect: 'error', cache: 'no-store' });
    if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > 4096) return false;
    const reader = response.body?.getReader(); if (!reader) return false;
    const parts: Uint8Array[] = []; let size = 0;
    for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > 4096) { await reader.cancel(); return false; } parts.push(result.value); }
    return verifyDesktopProbe(JSON.parse(Buffer.concat(parts).toString('utf8')), profileId, key, challenge);
  } catch { return false; }
}
export async function desktopCommand(command: string, directory = personalDataDirectory()) {
  const profile = parsePersonalProfile(parsePrivateJson(readPrivateFile(join(directory, 'profile.json'), 65536)), Date.now());
  const origin = `http://127.0.0.1:${profile.port}`;
  if (command === 'describe') return { ok: true, profileId: profile.profileId, origin };
  if (command === 'stop' || command === 'stop-and-wait') {
    const readyFile = join(directory, 'instance.json');
    if (command === 'stop-and-wait' && !existsSync(readyFile)) return { ok: true };
    const instance = parsePrivateJson(readPrivateFile(join(directory, 'instance.json'), 4096)) as Record<string, unknown>;
    if (instance.profileId !== profile.profileId || typeof instance.bootNonce !== 'string' || !/^[a-f0-9]{32}$/.test(instance.bootNonce)) throw new PersonalSetupError('startup_failed');
    writeFileSync(join(directory, 'stop-request.json'), JSON.stringify({ profileId: profile.profileId, bootNonce: instance.bootNonce }), { mode: 0o600 });
    if (command === 'stop-and-wait') {
      const end = Date.now() + 45000;
      while (existsSync(readyFile)) {
        const current = parsePrivateJson(readPrivateFile(readyFile, 4096)) as Record<string, unknown>;
        if (current.bootNonce !== instance.bootNonce || current.profileId !== profile.profileId) throw new PersonalSetupError('startup_failed');
        if (Date.now() >= end) throw new PersonalSetupError('startup_failed');
        await new Promise(done => setTimeout(done, 100));
      }
    }
    return { ok: true };
  }
  if (!['probe', 'wait'].includes(command)) throw new PersonalSetupError('setup_required');
  const appRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
  const key = new WindowsPersonalSecrets(directory, join(appRoot, 'runtime/WintrProtect.exe')).desktopKey(profile.profileId);
  const end = Date.now() + (command === 'wait' ? 45000 : 0);
  do {
    if (await probePersonalApp(origin, profile.profileId, key)) return { ok: true, origin };
    if (Date.now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  } while (true);
  throw new PersonalSetupError('startup_failed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, flag, directory] = process.argv.slice(2);
  if (!command || flag !== '--data-dir' || !directory || process.argv.length !== 5) {
    console.log(JSON.stringify({ ok: false, code: 'setup_required' })); process.exitCode = 1;
  } else void desktopCommand(command, directory).then(value => console.log(JSON.stringify(value))).catch(error => {
    console.log(JSON.stringify({ ok: false, code: error instanceof PersonalSetupError ? error.code : 'setup_required' })); process.exitCode = 1;
  });
}
