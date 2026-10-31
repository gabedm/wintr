// One compilation before workers start; never race writers of native helpers.
import { execFileSync } from 'node:child_process';
export default function setup() {
  if (process.platform === 'win32') execFileSync(process.execPath, ['scripts/build-windows-host.mjs'], { windowsHide: true, stdio: 'pipe' });
}
