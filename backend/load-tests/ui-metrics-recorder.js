/**
 * UI metrics recorder
 * -------------------
 * Reusable Playwright helper that captures Core Web Vitals + interaction
 * timing from a live page. Designed to be attached at the START of a test
 * (via `attach(page)`); call `harvest()` at the end to get a flat object
 * suitable for JSON.stringify and later analysis.
 *
 * What we capture (browser-side via PerformanceObserver):
 *   - FCP   First Contentful Paint
 *   - LCP   Largest Contentful Paint (last reported value before harvest)
 *   - CLS   Cumulative Layout Shift (a proxy for render jank)
 *   - longTasks  count + total ms of main-thread tasks > 50 ms (blocked UI)
 *
 * What we capture (test-side via `recordInteraction`):
 *   - One entry per "click → visible response" round trip, with ms duration.
 *
 * Why this lives in Playwright-land rather than as a browser extension:
 * we need values back in the Node process to write them to disk and feed
 * the analyzer.
 */

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.resolve(__dirname, '..', '..', 'load-results');
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

// In-process collector. Each call to `attach(page)` returns its own handle
// so 20 parallel pages don't trample each other's metrics.
function createRecorder({ label }) {
  const interactions = [];
  let attachedPage = null;

  return {
    async attach(page) {
      attachedPage = page;
      // Browser-side PerformanceObserver setup. Hangs values on window.__metrics
      // so we can read them with page.evaluate later.
      await page.addInitScript(() => {
        window.__metrics = { fcp: null, lcp: null, cls: 0, longTaskCount: 0, longTaskMs: 0 };
        try {
          const fcpObserver = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (e.name === 'first-contentful-paint') window.__metrics.fcp = e.startTime;
            }
          });
          fcpObserver.observe({ type: 'paint', buffered: true });
        } catch {}
        try {
          const lcpObserver = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const last = entries[entries.length - 1];
            if (last) window.__metrics.lcp = last.startTime;
          });
          lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {}
        try {
          const clsObserver = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (!e.hadRecentInput) window.__metrics.cls += e.value;
            }
          });
          clsObserver.observe({ type: 'layout-shift', buffered: true });
        } catch {}
        try {
          const longTaskObserver = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              window.__metrics.longTaskCount += 1;
              window.__metrics.longTaskMs += e.duration;
            }
          });
          longTaskObserver.observe({ type: 'longtask', buffered: true });
        } catch {}
      });
    },

    // Measure click → "response visible" — caller provides a Playwright Locator
    // that resolves once the response is on screen (e.g. a modal, a row, an
    // updated badge). The returned ms is the wall-clock duration.
    async recordInteraction(name, fn) {
      const t0 = Date.now();
      try {
        await fn();
        const ms = Date.now() - t0;
        interactions.push({ name, ms, ok: true });
        return ms;
      } catch (err) {
        const ms = Date.now() - t0;
        interactions.push({ name, ms, ok: false, error: err.message?.slice(0, 200) });
        throw err;
      }
    },

    async harvest() {
      let perf = { fcp: null, lcp: null, cls: 0, longTaskCount: 0, longTaskMs: 0 };
      if (attachedPage) {
        try {
          perf = await attachedPage.evaluate(() => window.__metrics || perf);
        } catch {}
      }
      return { label, perf, interactions };
    },
  };
}

// Append a recorder's harvest to a JSONL file under load-results/. The
// analyzer reads this file later.
function appendResult(filename, payload) {
  const out = path.join(RESULTS_DIR, filename);
  fs.appendFileSync(out, JSON.stringify(payload) + '\n');
}

module.exports = { createRecorder, appendResult, RESULTS_DIR };
