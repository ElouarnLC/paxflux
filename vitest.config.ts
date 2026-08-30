import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Playwright E2E specs (tests/e2e/**) are a separate suite driven by
    // `npm run test:e2e` (playwright.config.ts) — they use @playwright/test's
    // own test()/expect() and must not be collected by vitest.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      'tests/e2e/**',
    ],
  },
});
