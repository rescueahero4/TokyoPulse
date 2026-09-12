import { defineConfig, devices } from '@playwright/test';

/**
 * QA-E2E owns this file exclusively (contracts/OWNERSHIP.md).
 * A1a (port 5173) and A3 (port 8000) own and run their own dev servers —
 * this config never starts either. See tests/e2e/demo.spec.ts header for
 * the poll-before-run contract.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }]],
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
