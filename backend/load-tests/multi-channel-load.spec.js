/**
 * Multi-channel mixed-load spec.
 * ------------------------------
 * The "real production" scenario from the brief: tickets + live chat +
 * phone calls all firing simultaneously from 100 mixed-plan customers
 * against 2 agents. Driven via REST (Playwright `request` fixture) so we
 * can fire 100 concurrent customer actions without paying the per-context
 * RAM cost of 100 browsers.
 *
 * Pre-seeded by ../load-tests/seed-mixed-plans.js — this spec only reads
 * the manifest, never seeds. Cleanup is the orchestrator's job.
 */

const { test } = require('@playwright/test');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { appendResult } = require('./ui-metrics-recorder');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'load-results', 'seed-manifest.json');

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Seed manifest not found at ${MANIFEST_PATH}. Run seed-mixed-plans.js first.`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function pickByPlan(customers, plan, n) {
  return customers.filter(c => c.plan === plan).slice(0, n);
}

// Time a single HTTP call and return a structured result row. We never throw
// from inside — we want every failure shape (network, 4xx, 5xx) captured in
// the metrics so the analyzer can roll them up.
async function timedPost(request, url, token, body, meta) {
  const t0 = Date.now();
  let status = 0, errCode = null, payload = null;
  try {
    const r = await request.post(`${API_BASE_URL}${url}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: body,
      failOnStatusCode: false,
      timeout: 30_000,
    });
    status = r.status();
    try { payload = await r.json(); } catch {}
    if (status >= 400) errCode = payload?.error || `HTTP ${status}`;
  } catch (err) {
    errCode = err.message?.slice(0, 200);
  }
  return { ...meta, ms: Date.now() - t0, status, errCode, ok: status >= 200 && status < 300 };
}

test('Multi-channel mixed-load — 40 tickets + 40 chats + 20 calls concurrent', async ({ request }) => {
  test.setTimeout(180_000);
  const manifest = loadManifest();
  // Pull a slice of each plan. Free customers are intentionally included in
  // the chat + call buckets — we want to see the plan gate fire under load.
  const free      = manifest.customers.filter(c => c.plan === 'free');
  const basic     = manifest.customers.filter(c => c.plan === 'basic');
  const moderate  = manifest.customers.filter(c => c.plan === 'moderate');
  const premium   = manifest.customers.filter(c => c.plan === 'premium');

  // Channel cohorts — these mirror the brief's "40/40/20" target. We mix
  // plans inside each cohort to surface plan-aware bottlenecks (e.g. does
  // the chat gate query take longer for Free customers?).
  const ticketCohort = [
    ...free.slice(0, 10), ...basic.slice(0, 10),
    ...moderate.slice(0, 10), ...premium.slice(0, 10),
  ];                                                     // 40 ticket creators
  const chatCohort = [
    ...basic.slice(10, 20), ...moderate.slice(10, 20),
    ...premium.slice(10, 20), ...free.slice(10, 20),     // free included to verify 403
  ];                                                     // 40 chat requesters
  const callCohort = [
    ...moderate.slice(20, 25), ...premium.slice(20, 25),
    ...basic.slice(20, 25), ...free.slice(20, 25),       // basic + free → expect 403
  ];                                                     // 20 call requesters

  console.log(`[mixed] tickets=${ticketCohort.length} chats=${chatCohort.length} calls=${callCohort.length}`);

  // Phase 1 + 2 fused: fire all three cohorts in parallel. We're measuring
  // server-side throughput + gating under burst load, not paced steady-state.
  const t0 = Date.now();
  const [ticketResults, chatResults, callResults] = await Promise.all([
    Promise.all(ticketCohort.map((c, i) => timedPost(
      request, '/api/customer/bot/ticket', c.token,
      { subject: `mc-load #${i}`, description: 'multi-channel ticket flood' },
      { channel: 'ticket', plan: c.plan, userId: c.userId, cohortIdx: i }
    ))),
    Promise.all(chatCohort.map((c, i) => timedPost(
      request, '/api/chat/initiate', c.token, {},
      { channel: 'chat', plan: c.plan, userId: c.userId, cohortIdx: i }
    ))),
    Promise.all(callCohort.map((c, i) => timedPost(
      request, '/api/calls/initiate', c.token, {},
      { channel: 'call', plan: c.plan, userId: c.userId, cohortIdx: i }
    ))),
  ]);
  const wallMs = Date.now() - t0;

  const all = [...ticketResults, ...chatResults, ...callResults];
  console.log(`[mixed] ${all.length} requests in ${wallMs}ms · ok=${all.filter(r => r.ok).length} · errs=${all.filter(r => !r.ok).length}`);

  // Emit each row as a separate JSONL entry so the analyzer can group by
  // channel + plan without re-parsing nested arrays.
  for (const row of all) appendResult('multi-channel-mixed.jsonl', row);
});
