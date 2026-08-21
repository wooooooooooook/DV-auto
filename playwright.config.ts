import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*_e2e.{test,spec}.ts',
  timeout: 60000,
  use: {
    headless: true,
  },
  reporter: 'list',
});
