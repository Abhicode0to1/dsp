// Simulates the agent fixing one bug end-to-end via the MCP server.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fix-sim', version: '0.1' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

console.log('═══ Step 1: list_approved_bugs ═══');
const queue = await call('tools/call', { name: 'list_approved_bugs', arguments: {} });
const parsed = JSON.parse(queue.content[0].text);
console.log(`Found ${parsed.count} approved bug(s) waiting:`);
parsed.bugs.forEach(b => console.log(`  #${b.id} — ${b.title} (panel: ${b.panel})`));

const targetId = parsed.bugs[parsed.bugs.length - 1]?.id; // pick oldest unfixed
if (!targetId) { console.log('Queue empty, nothing to do.'); child.kill(); process.exit(0); }

console.log(`\n═══ Step 2: get_bug_details(${targetId}) ═══`);
const det = await call('tools/call', { name: 'get_bug_details', arguments: { id: targetId } });
const bug = JSON.parse(det.content[0].text);
console.log('Title       :', bug.title);
console.log('Description :', bug.description.slice(0, 200) + (bug.description.length > 200 ? '…' : ''));
console.log('Attachments :', bug.attachments.length, bug.attachments.map(a => a.name).join(', '));
console.log('Reporter    :', bug.reporter_name, `<${bug.reporter_email}>`);
console.log('Has admin_notes (original snapshot):', !!bug.admin_notes);

console.log(`\n═══ Step 3: (would read code + fix here) ═══`);
console.log('(skipping actual fix — this is a simulated test bug)');

console.log(`\n═══ Step 4: mark_bug_fixed(${targetId}) ═══`);
const done = await call('tools/call', { name: 'mark_bug_fixed', arguments: {
  id: targetId,
  fix_summary: 'SIMULATED — would have fixed TicketDetail.jsx submit handler. Commit abc1234.',
} });
console.log(done.content[0].text);

console.log(`\n═══ Step 5: verify queue shrunk ═══`);
const after = await call('tools/call', { name: 'list_approved_bugs', arguments: {} });
const afterParsed = JSON.parse(after.content[0].text);
console.log(`Queue now: ${afterParsed.count} bug(s). Fixed bug #${targetId} should no longer appear.`);

child.kill();
process.exit(0);
