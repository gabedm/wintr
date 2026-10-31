// Compile the launcher, credential helper and optional concert key-entry window
// using the OS .NET compiler.
// No downloads, account access, execution-policy changes or package scripts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
if (process.platform !== 'win32') { console.log('Windows helpers are built on Windows only.'); process.exit(0); }
const root = resolve(import.meta.dirname, '..');
const compiler = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
if (!existsSync(compiler)) throw new Error('Windows .NET compiler is unavailable.');
mkdirSync(join(root, 'runtime'), { recursive: true });
for (const name of ['WintrProtect', 'Wintr', 'WintrConcerts']) {
  const references = name === 'Wintr' ? ['System.Web.Extensions.dll', 'System.Windows.Forms.dll'] : name === 'WintrConcerts' ? ['System.Web.Extensions.dll', 'System.Windows.Forms.dll', 'System.Security.dll', 'System.Drawing.dll'] : ['System.Web.Extensions.dll', 'System.Security.dll'];
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:' + (name === 'WintrProtect' ? 'exe' : 'winexe'), '/out:' + join(root, 'runtime', name + '.exe'),
    ...(name === 'WintrProtect' ? [] : ['/win32icon:' + join(root, 'src/client/public/assets/wintr-mobile-v1.ico')]),
    ...references.map(x => '/reference:' + x), join(root, 'scripts/windows', name + '.cs')], { windowsHide: true, stdio: 'pipe' });
}
console.log('Built Windows launcher, CurrentUser credential helper and private Ticketmaster key-entry window.');
