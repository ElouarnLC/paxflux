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

// The operator acceptance scenario has to start from an instance nobody has
// touched: it goes through /setup in the browser and creates the very first
// administrator. The shared instance above cannot serve that, because
// global-setup bootstraps its admin before any spec runs — by the time a test
// executes, /setup is already done. So acceptance gets a second server, on its
// own port and its own empty data directory, that nothing else ever talks to.
export const ACCEPTANCE_PORT = 4311;
export const ACCEPTANCE_BASE_URL = `http://127.0.0.1:${ACCEPTANCE_PORT}`;
export const ACCEPTANCE_DATA_DIR = './tests/e2e/.acceptance-data';
export const ACCEPTANCE_BACKUP_DIR = './tests/e2e/.acceptance-backups';

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
  webServer: [
    {
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
    {
      // Virgin instance for the operator acceptance scenario. `pretest:e2e`
      // removes its data and backup directories, so every run really does
      // begin at first boot: no admin, no event, one unredeemed setup token.
      command: 'node apps/server/dist/server.js',
      url: `${ACCEPTANCE_BASE_URL}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(ACCEPTANCE_PORT),
        DATA_DIR: ACCEPTANCE_DATA_DIR,
        BACKUP_DIR: ACCEPTANCE_BACKUP_DIR,
        LOG_LEVEL: 'silent',
      },
    },
  ],
  // The responsive suite (`mobile-*.spec.ts`) runs across the whole device
  // matrix; every other spec runs once, on the desktop `functional`
  // project. `desktop-1280` re-runs the responsive suite at desktop size so
  // a mobile-first fix that breaks the large layout fails here rather than
  // in review.
  projects: [
    {
      name: 'functional',
      testIgnore: /mobile-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    // The smallest screen still in service, and the one the counter must
    // fit both primary buttons into without scrolling.
    {
      name: 'mobile-320',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { viewport: { width: 320, height: 568 } },
    },
    {
      name: 'mobile-360',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { viewport: { width: 360, height: 800 } },
    },
    {
      name: 'mobile-375',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { viewport: { width: 375, height: 667 } },
    },
    {
      name: 'mobile-390',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { viewport: { width: 390, height: 844 } },
    },
    {
      name: 'mobile-412',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { viewport: { width: 412, height: 915 } },
    },
    {
      name: 'tablet-768',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop-1280',
      testMatch: /mobile-.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
