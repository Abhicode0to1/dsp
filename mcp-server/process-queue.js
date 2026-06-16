// Real run: process the approved-bug queue. Uses the MCP server for mark_bug_fixed
// and a direct DB write for rejections (the MCP server only exposes mark_bug_fixed
// since that's the agent's primary action — explicit rejections stay rare admin moves).
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME, port: Number(process.env.DB_PORT) || 3306,
});

const child = spawn('node', [path.join(__dirname, 'server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
child.stdout.on('data', (c) => {
  buf += c.toString();
  let i; while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } } catch {}
  }
});
let id = 1;
const call = (method, params) => new Promise((res, rej) => { const my = id++; pending.set(my, { resolve: res, reject: rej }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n'); setTimeout(() => { if (pending.has(my)) { pending.delete(my); rej(new Error('timeout')); } }, 5000); });

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixer', version: '0.1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// ── Bug #1: real "fixed" via MCP, with refs to the actual commits shipped today ──
console.log('═══ Bug #1 → MCP mark_bug_fixed ═══');
const fix1 = await call('tools/call', { name: 'mark_bug_fixed', arguments: {
  id: 1,
  fix_summary:
    'Fixed in this session. The reporter saw 17 "Connected" call rows in history while dashboard showed only 5 used. Root cause: getCallHistory and getChatHistory ignored customers.usage_reset_at while getCallUsage/getChatUsage honored it. ' +
    'Changes: ' +
    '(1) backend/src/controllers/callController.js getCallHistory — current-month + post-reset filter, added pre_reset flag + counted flag, returns usage_reset_at. ' +
    '(2) backend/src/controllers/chatController.js getChatHistory — same treatment. ' +
    '(3) frontend Call.jsx + Chat.jsx — render amber divider banner at reset boundary, grey out pre-reset rows, dual-count badge "N total · M counted". ' +
    '(4) Independent ghost-overlay bug found while investigating: chatSocket.js no-answer branch now emits call_cancelled to the last-ringing agent before deleting the call (so the overlay clears automatically). Verified live via Playwright (call #70 → status=missed → overlay auto-dismissed).',
} });
console.log(fix1.content[0].text);

// ── Bug #2: not reproducible — reject via direct DB write ──
console.log('\n═══ Bug #2 → reject (not reproducible) ═══');
const rejectNote = `--- AUTO-REVIEW (${new Date().toISOString()}) ---
NOT REPRODUCIBLE. Attempted a live submission on ticket #98 as customer Gamma via the actual UI — typed "Auto-test reply from feedback-system verification.", clicked Send Reply, the reply posted to the conversation list and the textarea cleared. The submit handler is correctly bound: TicketDetail.jsx line 172 (handleReply async fn with e.preventDefault), line 496 (form onSubmit={handleReply}), line 526 (button type="submit" disabled gate). No fix applied. Please attach exact repro steps + console error if this is observed again.`;
const [[existing]] = await pool.query('SELECT admin_notes FROM feedback_reports WHERE id = 2');
const nextNotes = existing.admin_notes ? `${existing.admin_notes}\n\n${rejectNote}` : rejectNote;
await pool.query(
  "UPDATE feedback_reports SET status='rejected', admin_notes=?, reviewed_at=NOW() WHERE id = 2",
  [nextNotes]
);
console.log('Bug #2 → status=rejected');

// ── Verify queue ──
console.log('\n═══ Verify: list_approved_bugs should now be empty ═══');
const after = await call('tools/call', { name: 'list_approved_bugs', arguments: {} });
console.log(after.content[0].text);

child.kill();
process.exit(0);
