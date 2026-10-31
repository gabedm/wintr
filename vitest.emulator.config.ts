import { defineConfig } from 'vitest/config';
import { assertEmulatorEnvironment } from './scripts/firestore-emulator-preflight.mjs';

// Direct use of --config must obey the same preflight as the package script.
assertEmulatorEnvironment();
export default defineConfig({
  test: {
    include: ['integration/firestore/**/*.test.ts'], environment: 'node',
    fileParallelism: false, maxWorkers: 1, testTimeout: 60_000, hookTimeout: 60_000,
    retry: 0, passWithNoTests: false,
  },
});
