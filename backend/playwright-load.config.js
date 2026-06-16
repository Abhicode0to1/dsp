// Playwright config for the UI load/stress suite.
// Use:  npx playwright test --config playwright-load.config.js
//
// The "normal" UI spec config (playwright.config.js) is single-worker. This
// one allows multiple worker processes for the stress specs but keeps each
// individual test serial — the specs use multiple browser contexts per test
// to drive concurrency, not multiple test runs.

const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: path.resolve(__dirname, 'load-tests'),
  testMatch: /.*\.spec\.js/,
  timeout: 5 * 60 * 1000,        // each test may run for minutes under load
  expect: { timeout: 10_000 },
  // Stress specs seed + mutate DB rows in big batches. Keep serial.
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.UI_BASE_URL || 'http://localhost:5173',
    trace: 'off',                // traces blow up disk under load — keep off
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
