/**
 * Analyse the JSONL output the stress specs leave under load-results/.
 *
 *   node backend/load-tests/analyze-ui-results.js
 *
 * Reads every *.jsonl, computes percentiles per interaction name, aggregates
 * Web Vitals, and flags violations of the SLOs from the brief:
 *
 *   - any interaction > 2000 ms          (unacceptable click→response)
 *   - any new_message send→recv > 1000ms (customers see lag)
 *   - any CLS > 0.1                      (render jank)
 *   - any longTaskMs > 500 cumulative    (main thread blocked too long)
 */

const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.resolve(__dirname, '..', '..', 'load-results');

function readJsonl(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtMs(n) { return n == null ? 'n/a' : `${Math.round(n)} ms`; }

function summarise(rows) {
  const perInteraction = new Map();
  const fcps = [], lcps = [], cls = [], longMs = [];
  let totalInteractions = 0;
  let interactionsOver2s = 0;

  for (const row of rows) {
    if (row.perf?.fcp != null) fcps.push(row.perf.fcp);
    if (row.perf?.lcp != null) lcps.push(row.perf.lcp);
    if (row.perf?.cls != null) cls.push(row.perf.cls);
    if (row.perf?.longTaskMs != null) longMs.push(row.perf.longTaskMs);
    for (const it of row.interactions || []) {
      totalInteractions += 1;
      if (it.ms > 2000) interactionsOver2s += 1;
      if (!perInteraction.has(it.name)) perInteraction.set(it.name, []);
      perInteraction.get(it.name).push(it.ms);
    }
  }

  return { perInteraction, fcps, lcps, cls, longMs, totalInteractions, interactionsOver2s };
}

function printSection(title) {
  console.log('');
  console.log('─'.repeat(70));
  console.log(' ' + title);
  console.log('─'.repeat(70));
}

function main() {
  if (!fs.existsSync(RESULTS_DIR)) {
    console.error(`No results directory at ${RESULTS_DIR}. Run a spec first.`);
    process.exit(1);
  }
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.error(`No *.jsonl files in ${RESULTS_DIR}. Run a spec first.`);
    process.exit(1);
  }

  const flags = [];
  for (const file of files) {
    const rows = readJsonl(path.join(RESULTS_DIR, file));
    printSection(`${file}  (${rows.length} samples)`);
    const s = summarise(rows);

    // Per-interaction percentiles
    if (s.perInteraction.size) {
      console.log('  Interactions (ms):  p50 / p95 / p99 / max');
      const sortedNames = [...s.perInteraction.keys()].sort();
      for (const name of sortedNames) {
        const arr = s.perInteraction.get(name);
        const p50 = percentile(arr, 50), p95 = percentile(arr, 95), p99 = percentile(arr, 99), max = Math.max(...arr);
        console.log(`    ${name.padEnd(34)}  ${String(Math.round(p50)).padStart(5)} / ${String(Math.round(p95)).padStart(5)} / ${String(Math.round(p99)).padStart(5)} / ${String(Math.round(max)).padStart(5)}`);
        if (max > 2000) flags.push(`[${file}] interaction '${name}' max=${Math.round(max)}ms > 2 s SLO`);
      }
    }

    // Web Vitals
    if (s.fcps.length || s.lcps.length || s.cls.length || s.longMs.length) {
      console.log('  Web Vitals (samples):');
      if (s.fcps.length) console.log(`    FCP   p50=${fmtMs(percentile(s.fcps, 50))}  p95=${fmtMs(percentile(s.fcps, 95))}`);
      if (s.lcps.length) console.log(`    LCP   p50=${fmtMs(percentile(s.lcps, 50))}  p95=${fmtMs(percentile(s.lcps, 95))}`);
      if (s.cls.length) {
        const maxCls = Math.max(...s.cls);
        console.log(`    CLS   p50=${(percentile(s.cls, 50) || 0).toFixed(3)}  max=${maxCls.toFixed(3)}`);
        if (maxCls > 0.1) flags.push(`[${file}] CLS max=${maxCls.toFixed(3)} > 0.1 (render jank)`);
      }
      if (s.longMs.length) {
        const maxLong = Math.max(...s.longMs);
        console.log(`    LongTasks (total ms): p50=${fmtMs(percentile(s.longMs, 50))}  max=${fmtMs(maxLong)}`);
        if (maxLong > 500) flags.push(`[${file}] cumulative long-task ms max=${Math.round(maxLong)} > 500 (UI blocked)`);
      }
    }

    // Socket-level metrics
    let totalEmits = 0, totalRecvs = 0, totalDisc = 0, totalRec = 0;
    for (const row of rows) {
      const ss = row.sockets;
      if (!ss) continue;
      const all = Array.isArray(ss) ? ss : [ss];
      for (const s2 of all) {
        totalEmits += s2.emits?.length || 0;
        totalRecvs += s2.events?.length || 0;
        totalDisc += s2.disconnects || 0;
        totalRec += s2.reconnects || 0;
      }
    }
    if (totalEmits || totalRecvs) {
      console.log(`  Socket traffic: ${totalEmits} emits · ${totalRecvs} events received`);
      if (totalDisc || totalRec) console.log(`                disconnects=${totalDisc}, reconnects=${totalRec}`);
    }

    if (s.interactionsOver2s) {
      flags.push(`[${file}] ${s.interactionsOver2s}/${s.totalInteractions} interactions exceeded 2 s SLO`);
    }

    // Customer→agent message-delivery latency (only present in scenario2-chat-latency.jsonl)
    const allLat = rows.flatMap(r => r.latency_ms || []);
    if (allLat.length) {
      const p50 = percentile(allLat, 50), p95 = percentile(allLat, 95), p99 = percentile(allLat, 99);
      const max = Math.max(...allLat);
      console.log(`  Message delivery (ms): p50=${Math.round(p50)} p95=${Math.round(p95)} p99=${Math.round(p99)} max=${Math.round(max)} (n=${allLat.length})`);
      if (max > 1000) flags.push(`[${file}] message delivery max=${Math.round(max)}ms > 1 s SLO`);
      const totalSent = rows.reduce((a, r) => a + (r.customer_emits || 0), 0);
      const totalRecv = rows.reduce((a, r) => a + (r.agent_receives || 0), 0);
      if (totalSent && totalRecv < totalSent) {
        flags.push(`[${file}] message loss: sent=${totalSent}, recv=${totalRecv} (${totalSent - totalRecv} dropped)`);
      }
    }

    // Notification-flood roll-up (scenario3-dashboard-notif.jsonl)
    const floodRows = rows.filter(r => r.flood);
    if (floodRows.length) {
      const totalSent = floodRows.reduce((a, r) => a + (r.flood.sent || 0), 0);
      const totalRecv = floodRows.reduce((a, r) => a + (r.flood.received_on_customer || 0), 0);
      const totalLoss = floodRows.reduce((a, r) => a + (r.flood.loss || 0), 0);
      console.log(`  Notification flood: sent=${totalSent} recv=${totalRecv} loss=${totalLoss} across ${floodRows.length} customers`);
      if (totalLoss > 0) flags.push(`[${file}] notification loss: ${totalLoss}/${totalSent} events did not reach the customer`);
    }

    // Concurrent-action race roll-up (agent-scenario5-race.jsonl)
    const raceRows = rows.filter(r => r.label === 'race');
    if (raceRows.length) {
      for (const r of raceRows) {
        const persisted = r.messagesPersisted || 0;
        const order = r.order || [];
        // Detect order anomalies: identical bodies stored twice (duplicates) and
        // monotonic ID violations (ids should be ascending — anything else
        // means the persistence ordering disagrees with insertion order).
        const dupBodies = order.map(o => o.m).filter((m, i, a) => a.indexOf(m) !== i);
        const ids = order.map(o => o.id);
        const ascending = ids.every((id, i) => i === 0 || id > ids[i - 1]);
        console.log(`  Race: persisted=${persisted} ids_monotonic=${ascending} duplicate_bodies=${dupBodies.length}`);
        if (dupBodies.length) flags.push(`[${file}] race: ${dupBodies.length} duplicate message bodies persisted`);
        if (!ascending) flags.push(`[${file}] race: persisted ids are not monotonic — ordering anomaly`);
        if (persisted < 4) flags.push(`[${file}] race: only ${persisted}/4 expected messages persisted — message loss`);
      }
    }
  }

  printSection('FLAGS');
  if (flags.length === 0) console.log('  none — every interaction landed under the SLOs');
  else flags.forEach(f => console.log('  🔴 ' + f));
  console.log('');
}

main();
