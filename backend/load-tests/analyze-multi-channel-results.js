/**
 * Multi-channel result analyzer.
 * -------------------------------
 *   node backend/load-tests/analyze-multi-channel-results.js
 *
 * Reads:
 *   mc-channel-comparison.jsonl   — per-channel baseline latency
 *   multi-channel-mixed.jsonl     — concurrent mixed-load latency + plan rows
 *   mc-plan-gating.jsonl          — gate correctness assertions
 *   mc-agent-stress.jsonl         — agent panel UI metrics with mixed queue
 *
 * Output: stdout report with:
 *   - per-channel p50/p95/p99/max
 *   - per-plan error rates (focusing on 403 distribution)
 *   - plan-gating leak count (Free → chat allowed = critical bug)
 *   - SLO violations flagged by channel (ticket: 2s, chat: 1.5s, call: 1s)
 */

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.resolve(__dirname, '..', '..', 'load-results');

function readJsonl(file) {
  const out = [];
  const fullPath = path.join(RESULTS_DIR, file);
  if (!fs.existsSync(fullPath)) return out;
  for (const line of fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function section(title) {
  console.log('');
  console.log('─'.repeat(74));
  console.log(' ' + title);
  console.log('─'.repeat(74));
}

const SLO = {
  ticket: 2000,   // brief: p99 < 2s
  chat:   1500,   // brief: p99 < 1.5s
  call:   1000,   // brief: p99 < 1s
};

function reportPerChannel(rows, scopeLabel, flags) {
  if (!rows.length) return;
  const byChannel = new Map();
  for (const r of rows) {
    if (!r.channel) continue;
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, []);
    byChannel.get(r.channel).push(r);
  }
  console.log(`  Channel    n    ok    err   p50    p95    p99    max    err_rate`);
  for (const ch of ['ticket', 'chat', 'call']) {
    const items = byChannel.get(ch) || [];
    if (!items.length) continue;
    const ms = items.map(i => i.ms);
    const ok = items.filter(i => i.ok).length;
    const err = items.length - ok;
    const p99 = percentile(ms, 99);
    const errRate = (100 * err / items.length).toFixed(1) + '%';
    console.log(`  ${ch.padEnd(10)} ${String(items.length).padStart(3)} ${String(ok).padStart(5)} ${String(err).padStart(5)}  ${String(Math.round(percentile(ms, 50))).padStart(5)}  ${String(Math.round(percentile(ms, 95))).padStart(5)}  ${String(Math.round(p99)).padStart(5)}  ${String(Math.max(...ms)).padStart(5)}    ${errRate}`);
    if (p99 > SLO[ch]) flags.push(`[${scopeLabel}] ${ch} p99=${Math.round(p99)}ms exceeds SLO ${SLO[ch]}ms`);
  }
}

function reportPerPlan(rows, flags) {
  // Group ticket/chat/call rows by (channel, plan), show ok / blocked counts.
  // The key insight is: Free customers in 'chat' or 'call' should be 100%
  // blocked (403). If any ok=true row appears for Free, that's a critical leak.
  const groups = new Map();
  for (const r of rows) {
    if (!r.channel || !r.plan) continue;
    const k = `${r.channel}|${r.plan}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  if (!groups.size) return;
  console.log(`  Channel/Plan         n    accepted    blocked   p50_blocked   sample_err`);
  for (const [key, items] of [...groups.entries()].sort()) {
    const [ch, plan] = key.split('|');
    const accepted = items.filter(i => i.ok).length;
    const blocked  = items.length - accepted;
    const blockedMs = items.filter(i => !i.ok).map(i => i.ms);
    const p50Blocked = blockedMs.length ? Math.round(percentile(blockedMs, 50)) : '-';
    const sampleErr = items.find(i => !i.ok)?.errCode?.slice(0, 38) || '';
    console.log(`  ${ch}/${plan.padEnd(10)} ${String(items.length).padStart(5)} ${String(accepted).padStart(9)} ${String(blocked).padStart(10)}    ${String(p50Blocked).padStart(10)}   ${sampleErr}`);

    // Plan-gate correctness checks against the mixed-load rows.
    if ((ch === 'chat' || ch === 'call') && plan === 'free' && accepted > 0) {
      flags.push(`[plan-leak] ${accepted} Free customers were allowed on ${ch} — gate is broken`);
    }
    if (ch === 'call' && plan === 'basic' && accepted > 0) {
      flags.push(`[plan-leak] ${accepted} Basic customers were allowed on call — gate is broken`);
    }
  }
}

function reportGatingTests(rows, flags) {
  // mc-plan-gating.jsonl rows have a `test` discriminator. Report each.
  for (const r of rows) {
    if (r.test === 'free-blocked-from-chat' || r.test === 'free-basic-blocked-from-calls') {
      console.log(`  ${r.test}: total=${r.total} blocked=${r.blocked} leaked=${r.leaked}`);
      if (r.leaked > 0) flags.push(`[gating] ${r.test} leaked ${r.leaked} request(s)`);
    } else if (r.test?.endsWith('-cap')) {
      // New schema: each row is a single attempt at-cap; limitExceeded must be true.
      const verdict = r.limitExceeded === true ? 'OK (gate fired)' : `LEAKED (status=${r.status})`;
      console.log(`  ${r.test} user=${r.userId} → ${verdict}`);
      if (r.limitExceeded !== true) {
        flags.push(`[gating] ${r.test} user=${r.userId} bypassed the cap (status=${r.status}, err=${r.err})`);
      }
    }
  }
}

function reportAgentPanel(rows, flags) {
  for (const r of rows) {
    const perf = r.perf || {};
    console.log(`  Queue: tickets=${r.queue_depth?.tickets} chats=${r.queue_depth?.chats} calls=${r.queue_depth?.calls}`);
    console.log(`  FCP=${perf.fcp ? Math.round(perf.fcp) + 'ms' : 'n/a'}  LCP=${perf.lcp ? Math.round(perf.lcp) + 'ms' : 'n/a'}  CLS=${(perf.cls || 0).toFixed(3)}  LongTasks=${Math.round(perf.longTaskMs || 0)}ms`);
    if (r.heap) {
      const mb = (r.heap.usedJSHeap / 1024 / 1024).toFixed(1);
      console.log(`  Heap (used): ${mb} MB`);
      if (mb > 200) flags.push(`[agent-panel] used JS heap ${mb}MB exceeds 200MB threshold`);
    }
    for (const it of r.interactions || []) {
      console.log(`    ${it.name.padEnd(28)} ${it.ms}ms`);
      if (it.ms > 2000) flags.push(`[agent-panel] interaction '${it.name}' took ${it.ms}ms > 2s`);
    }
    if (perf.fcp > 2000) flags.push(`[agent-panel] FCP ${Math.round(perf.fcp)}ms > 2s`);
  }
}

function main() {
  const flags = [];

  const baseline = readJsonl('mc-channel-comparison.jsonl');
  const mixed    = readJsonl('multi-channel-mixed.jsonl');
  const gating   = readJsonl('mc-plan-gating.jsonl');
  const agentMc  = readJsonl('mc-agent-stress.jsonl');

  if (!baseline.length && !mixed.length && !gating.length && !agentMc.length) {
    console.error('No multi-channel result files found in', RESULTS_DIR);
    process.exit(1);
  }

  if (baseline.length) {
    section(`Channel baseline latency (one channel at a time, n=${baseline.length / 3})`);
    reportPerChannel(baseline, 'baseline', flags);
  }

  if (mixed.length) {
    section('Mixed-load — all three channels concurrent');
    reportPerChannel(mixed, 'mixed', flags);
    console.log('');
    reportPerPlan(mixed, flags);
  }

  if (gating.length) {
    section('Plan-gating correctness');
    reportGatingTests(gating, flags);
  }

  if (agentMc.length) {
    section('Agent panel under mixed queue depth');
    reportAgentPanel(agentMc, flags);
  }

  section('FLAGS');
  if (!flags.length) console.log('  none — every channel met its SLO and every gate held');
  else flags.forEach(f => console.log('  🔴 ' + f));
  console.log('');
}

main();
