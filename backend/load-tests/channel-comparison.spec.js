/**
 * Channel-by-channel latency comparison.
 * ---------------------------------------
 * Fires N requests against ONE channel at a time, captures per-channel
 * percentiles, then the analyzer compares them. Different from
 * multi-channel-load.spec.js, which fires all three at once — this one
 * isolates each channel so we can attribute slowness to a specific path.
 *
 * Same N for each channel = apples-to-apples.
 */

const { test } = require('@playwright/test');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { appendResult } = require('./ui-metrics-recorder');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'load-results', 'seed-manifest.json');
// Default 8 so 3 disjoint slices fit in premium's 25 customers at SCALE=1.
// Override with MC_PER_CHANNEL=20 at SCALE>=3 (which gives 75+ premium).
const N = Number(process.env.MC_PER_CHANNEL || 8);

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

async function timed(request, url, token, body, meta) {
  const t0 = Date.now();
  let status = 0, errCode = null;
  try {
    const r = await request.post(`${API_BASE_URL}${url}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: body,
      failOnStatusCode: false,
      timeout: 30_000,
    });
    status = r.status();
    if (status >= 400) {
      try { errCode = (await r.json())?.error || `HTTP ${status}`; } catch { errCode = `HTTP ${status}`; }
    }
  } catch (err) { errCode = err.message?.slice(0, 200); }
  return { ...meta, ms: Date.now() - t0, status, errCode, ok: status >= 200 && status < 300 };
}

// Each channel uses a DISJOINT slice of premium customers so the previous
// test's side effects (e.g. starting a chat closes the door on a call from
// the same customer with a 409 "active chat") don't pollute the next
// channel's numbers. n=20 across three channels → premium.slice(0,60) used.
function premiumCohort(start, n) {
  return loadManifest().customers
    .filter(c => c.plan === 'premium')
    .slice(start, start + n);
}

test('Channel comparison — ticket latency baseline', async ({ request }) => {
  test.setTimeout(120_000);
  const cohort = premiumCohort(0, N);
  const results = await Promise.all(cohort.map((c, i) => timed(
    request, '/api/customer/bot/ticket', c.token,
    { subject: `chan-cmp ticket ${i}`, description: 'baseline channel comparison' },
    { channel: 'ticket', plan: c.plan, userId: c.userId, cohortIdx: i }
  )));
  for (const r of results) appendResult('mc-channel-comparison.jsonl', r);
});

test('Channel comparison — chat-init latency baseline', async ({ request }) => {
  test.setTimeout(120_000);
  const cohort = premiumCohort(N, N);
  const results = await Promise.all(cohort.map((c, i) => timed(
    request, '/api/chat/initiate', c.token, {},
    { channel: 'chat', plan: c.plan, userId: c.userId, cohortIdx: i }
  )));
  for (const r of results) appendResult('mc-channel-comparison.jsonl', r);
});

test('Channel comparison — call-init latency baseline', async ({ request }) => {
  test.setTimeout(120_000);
  const cohort = premiumCohort(N * 2, N);
  const results = await Promise.all(cohort.map((c, i) => timed(
    request, '/api/calls/initiate', c.token, {},
    { channel: 'call', plan: c.plan, userId: c.userId, cohortIdx: i }
  )));
  for (const r of results) appendResult('mc-channel-comparison.jsonl', r);
});
