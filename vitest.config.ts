import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/fixtures/windows-native-setup.mjs'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // Real SDK/emulator acceptance is an explicit, fail-closed separate target.
    exclude: ['integration/**', 'node_modules/**'],
    environment: 'node',
  },
});
