import { defineConfig } from 'vitest/config';

// Standalone test config so the @crxjs plugin (vite.config.ts) never loads under
// Vitest. The unit-tested modules (normalization, chunking) are pure and run in
// a plain Node environment; extraction tests opt into happy-dom per-file.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
