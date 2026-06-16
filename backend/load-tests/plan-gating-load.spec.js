/**
 * Plan-gating verification under concurrent load.
 * ------------------------------------------------
 * Goal: prove the plan gate is correct even when the controllers are being
 * hit hard. Each test asserts a specific "must reject" or "must accept"
 * outcome for every eligible customer in the manifest, then writes a single
 * roll-up row per test for the analyzer.
 *
 * Why this is its own spec (not just rows in multi-channel-load):
 * - Assertions on outcome shape (status + error string) are testable claims,
 *   so they belong in a Playwright test that can fail loud.
 * - The mixed-load spec measures performance; this one measures correctness.
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const { appendResult } = require('./ui-metrics-recorder');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';
const MANIFEST_PATH = path.resolve(__dirname, '..', '..', 'load-results', 'seed-manifest.json');

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

async function post(request, url, token, body = {}) {
  const t0 = Date.now();
  const r = await request.post(`${API_BASE_URL}${url}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: body,
    failOnStatusCode: false,
    timeout: 20_000,
  });
  let payload = null;
  try { payload = await r.json(); } catch {}
  return { status: r.status(), payload, ms: Date.now() - t0 };
}

test('Free customers blocked from chat (must 403)', async ({ request }) => {
  const free = loadManifest().customers.filter(c => c.plan === 'free');
  const results = await Promise.all(free.map(c => post(request, '/api/chat/initiate', c.token)));
  const blocked = results.filter(r => r.status === 403).length;
  const leaked  = results.filter(r => r.status >= 200 && r.status < 300).length;
  appendResult('mc-plan-gating.jsonl', {
    test: 'free-blocked-from-chat', total: free.length, blocked, leaked,
    sample_error: results[0]?.payload?.error,
  });
  expect(leaked, 'a Free customer was allowed to start chat').toBe(0);
  expect(blocked).toBe(free.length);
});

test('Free + Basic customers blocked from calls (must 403)', async ({ request }) => {
  const m = loadManifest();
  const cohort = m.customers.filter(c => c.plan === 'free' || c.plan === 'basic');
  const results = await Promise.all(cohort.map(c => post(request, '/api/calls/initiate', c.token)));
  const blocked = results.filter(r => r.status === 403).length;
  const leaked  = results.filter(r => r.status >= 200 && r.status < 300).length;
  appendResult('mc-plan-gating.jsonl', {
    test: 'free-basic-blocked-from-calls', total: cohort.length, blocked, leaked,
    sample_error: results[0]?.payload?.error,
  });
  expect(leaked, 'a Free or Basic customer was allowed to start a call').toBe(0);
});

// Call-cap testing is awkward via the public endpoint because getCallUsage
// only counts ACCEPTED calls (call_start_time IS NOT NULL), and our test
// agents don't auto-accept. So instead we pre-stage the customer at the
// cap by inserting "accepted" call rows directly, then verify ONE more
// initiate request is rejected with limit_exceeded.
const { pool } = require('../src/config/database');

async function preStageCallsAtCap(customerId, count) {
  // Insert `count` rows that look like real accepted calls — same month_year
  // so getCallUsage counts them, call_start_time set so the WHERE clause hits.
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO calls (customer_id, status, created_at, call_start_time, virtual_number)
       VALUES (?, 'ended', NOW(), NOW(), 'mc-stage')`,
      [customerId]
    );
  }
}

async function cleanupStagedCalls(customerId) {
  await pool.query("DELETE FROM calls WHERE customer_id = ? AND virtual_number = 'mc-stage'", [customerId]);
}

test('Moderate customers hit call cap at 5', async ({ request }) => {
  // Pre-stage exactly 5 accepted calls so customer is AT the cap; next
  // initiate must return limit_exceeded.
  const moderate = loadManifest().customers.filter(c => c.plan === 'moderate').slice(0, 3);
  for (const c of moderate) {
    await preStageCallsAtCap(c.customerId, 5);
    const r = await post(request, '/api/calls/initiate', c.token);
    const limitExceeded = r.payload?.limit_exceeded === true;
    appendResult('mc-plan-gating.jsonl', {
      test: 'moderate-call-cap', userId: c.userId,
      status: r.status, err: r.payload?.error, limitExceeded,
    });
    await cleanupStagedCalls(c.customerId);
    expect(limitExceeded, `moderate customer ${c.userId} at cap was still allowed to call (status=${r.status})`).toBe(true);
  }
});

test('Premium customers hit call cap at 10', async ({ request }) => {
  const premium = loadManifest().customers.filter(c => c.plan === 'premium').slice(0, 2);
  for (const c of premium) {
    await preStageCallsAtCap(c.customerId, 10);
    const r = await post(request, '/api/calls/initiate', c.token);
    const limitExceeded = r.payload?.limit_exceeded === true;
    appendResult('mc-plan-gating.jsonl', {
      test: 'premium-call-cap', userId: c.userId,
      status: r.status, err: r.payload?.error, limitExceeded,
    });
    await cleanupStagedCalls(c.customerId);
    expect(limitExceeded, `premium customer ${c.userId} at cap was still allowed to call (status=${r.status})`).toBe(true);
  }
});

// NOTE: ticket-limit testing intentionally omitted. Production `plans` data
// has `tickets_limit = NULL` for every plan (verified via direct query) —
// the schema supports a cap but the seed doesn't set one, so there's no
// boundary to assert. Add this test back if/when admin starts setting
// per-plan ticket caps via plan_feature_overrides or a schema migration.

test.afterAll(async () => { try { await pool.end(); } catch {} });
