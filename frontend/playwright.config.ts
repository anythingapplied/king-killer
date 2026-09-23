import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Every test boots its own API on :3000 (see tests/fixtures.ts) - the
  // frontend derives the API address from its own hostname, so the port can't
  // vary per test. One test at a time is the price of each getting a fresh
  // server and database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  // The site itself. Reused if one is already running, so a dev server you
  // have open for manual testing is fine.
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
        },
      },
    },
  ],
});
