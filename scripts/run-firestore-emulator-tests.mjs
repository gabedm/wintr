import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { assertEmulatorEnvironment } from './firestore-emulator-preflight.mjs';

try { assertEmulatorEnvironment(); } catch {
  process.stderr.write('E05 emulator preflight refused; see docs/validation/FIRESTORE_EMULATOR.md\n');
  process.exit(1);
}
// Vitest and the real SDK are unreachable before the explicit environment check.
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const result = spawnSync(process.execPath, [cli, 'run', '--config', 'vitest.emulator.config.ts'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
