import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tmp',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: process.env.BASE_URL, viewport: { width: 1440, height: 900 } },
});
