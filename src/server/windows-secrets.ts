import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownData, PersonalSetupError } from './personal-profile.js';
import { ServerSecret } from './providers/secret.js';

export type PersonalBox = 'google' | 'providers' | 'desktop';
export function readPrivateFile(file: string, maxBytes = 131072): Buffer {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > maxBytes) throw new PersonalSetupError('setup_required');
  const bytes = readFileSync(file); if (bytes.length !== stat.size || bytes.length > maxBytes) throw new PersonalSetupError('setup_required'); return bytes;
}
export function parsePrivateJson(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new PersonalSetupError('setup_required'); }
}
/** Windows CurrentUser only. No account discovery or plaintext credential files. */
export function windowsProtection(mode: 'protect' | 'unprotect', data: Buffer, box: PersonalBox, script: string): Buffer {
  if (process.platform !== 'win32' || !['google', 'providers', 'desktop'].includes(box) || !['protect', 'unprotect'].includes(mode) || !data.length || data.length > 131072) throw new PersonalSetupError('setup_required');
  try {
    const encoded = execFileSync(resolve(script), [mode], {
      input: JSON.stringify({ purpose: `wintr-personal-${box}-v1`, data: data.toString('base64') }), windowsHide: true, timeout: 15000,
      maxBuffer: 512 * 1024, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8',
    }).trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    return Buffer.from(encoded, 'base64');
  } catch { throw new PersonalSetupError('setup_required'); }
}
export class WindowsPersonalSecrets {
  constructor(readonly directory: string, private readonly script: string) {}
  read(box: PersonalBox, profileId: string): unknown {
    let plain: Buffer | undefined;
    try {
      plain = windowsProtection('unprotect', readPrivateFile(join(this.directory, `${box}.dpapi`)), box, this.script);
      const packet = ownData(parsePrivateJson(plain), ['kind', 'profileId', 'value']);
      if (packet.kind !== `wintr-personal-${box}-v1` || packet.profileId !== profileId) throw new Error();
      return packet.value;
    } catch { throw new PersonalSetupError('setup_required'); }
    finally { plain?.fill(0); }
  }
  writeNew(box: PersonalBox, profileId: string, value: unknown): void {
    const plain = Buffer.from(JSON.stringify({ kind: `wintr-personal-${box}-v1`, profileId, value }));
    try { writeFileSync(join(this.directory, `${box}.dpapi`), windowsProtection('protect', plain, box, this.script), { flag: 'wx', mode: 0o600 }); }
    finally { plain.fill(0); }
  }
  desktopKey(profileId: string): string {
    const raw = this.read('desktop', profileId);
    if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw new PersonalSetupError('setup_required'); return raw;
  }
  providers(profileId: string) {
    const p = ownData(this.read('providers', profileId), ['reference', 'qloo', 'sealing']);
    try { return Object.freeze({ reference: new ServerSecret(p.reference as string), qloo: new ServerSecret(p.qloo as string), sealing: new ServerSecret(p.sealing as string) }); }
    catch { throw new PersonalSetupError('setup_required'); }
  }
}
