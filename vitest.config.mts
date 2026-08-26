import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: [
      'tests/fixtures/**',
      'tests/**/*.spec.ts',
      'tests/**/*_run.ts',
      'tests/index.test.ts',
      'node_modules/**',
      'dist/**',
    ],
    testTimeout: 10000,
    hookTimeout: 10000,
    fileParallelism: false,
  },
});
