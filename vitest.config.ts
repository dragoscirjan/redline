import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['archive/**', 'src.pre-v4/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
