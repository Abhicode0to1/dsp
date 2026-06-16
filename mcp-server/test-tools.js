// End-to-end test: spawns the MCP server as a subprocess and speaks JSON-RPC
// over stdio exactly the way Claude Code will. Verifies every tool round-trips.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const child = spawn('node', [path.join(__dirname, 'server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buf = '';
const pending = new Map();
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    } catch { /* ignore partial */ }
  }
});

let nextId = 1;
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 5000);
});

// MCP handshake first
await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-harness', version: '0.1' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

console.log('\n──────── 1. tools/list ────────');
const list = await call('tools/list', {});
console.log('Tools exposed:', list.tools.map(t => t.name));

console.log('\n──────── 2. list_approved_bugs ────────');
const approved = await call('tools/call', { name: 'list_approved_bugs', arguments: { limit: 5 } });
console.log(approved.content[0].text);

console.log('\n──────── 3. get_bug_details(id=1) ────────');
const details = await call('tools/call', { name: 'get_bug_details', arguments: { id: 1 } });
console.log(details.content[0].text);

console.log('\n──────── 4. mark_bug_fixed(id=999) — expect ERROR (not found) ────────');
const notFound = await call('tools/call', { name: 'mark_bug_fixed', arguments: { id: 999, fix_summary: 'test' } });
console.log('isError:', notFound.isError, '|', notFound.content[0].text);

console.log('\n──────── Done ────────');
child.kill();
process.exit(0);
