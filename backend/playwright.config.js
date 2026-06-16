// Minimal Playwright config for the DSP UI test suite at src/tests/ui.spec.js.
// Runs against the LIVE Vite dev server (frontend on :5173) + LIVE backend
// (:5000). Spawning either inside Playwright would require shutting down the
// already-running nodemon + Vite — assume the dev environment is up.

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './src/tests',
  testMatch: /ui\.spec\.js/,
  timeout: 30 * 1000,
  expect: { timeout: 5000 },
  // UI suite seeds + mutates DB rows; one worker keeps cleanup deterministic.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.UI_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
