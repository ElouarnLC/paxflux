import { defineConfig, devices } from '@playwright/test';

// Before running `npm run test:e2e` locally for the first time, install the
// Playwright-managed browser this config uses (Chromium only — no other
// browser is configured here):
//   npx playwright install chromium
// This project intentionally does not hardcode a browser executable path:
// Playwright resolves its own managed browser (honoring PLAYWRIGHT_BROWSERS_PATH
// if set), which keeps this config portable across machines and CI.

export const E2E_PORT = 4310;
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_DATA_DIR = './tests/e2e/.data';
export const E2E_BACKUP_DIR = './tests/e2e/.backups';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node apps/server/dist/server.js',
    url: `${E2E_BASE_URL}/health/live`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(E2E_PORT),
      DATA_DIR: E2E_DATA_DIR,
      BACKUP_DIR: E2E_BACKUP_DIR,
      LOG_LEVEL: 'silent',
    },
  },
  projects: [
    {
      name: 'functional',
      testIgnore: /mobile-viewport-overflow\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-320',
      testMatch: /mobile-viewport-overflow\.spec\.ts/,
      use: { viewport: { width: 320, height: 690 } },
    },
    {
      name: 'mobile-375',
      testMatch: /mobile-viewport-overflow\.spec\.ts/,
      use: { viewport: { width: 375, height: 812 } },
    },
    {
      name: 'mobile-390',
      testMatch: /mobile-viewport-overflow\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: 'mobile-412',
      testMatch: /mobile-viewport-overflow\.spec\.ts/,
      use: { viewport: { width: 412, height: 915 } },
    },
  ],
});
