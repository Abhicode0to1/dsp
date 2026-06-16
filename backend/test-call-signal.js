/**
 * Tests the WebRTC call signaling chain without a browser.
 * Simulates: customer creates call → emits call_offer → agent receives incoming_call
 *
 * Run from: dsp/backend/
 *   node test-call-signal.js
 */

const http = require('http');
// socket.io-client lives in the frontend node_modules
const { io: ioClient } = require('../frontend/node_modules/socket.io-client');

const BASE = 'http://localhost:5000';

function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 5000, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPostAuth(path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: 5000, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${token}`,
      },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function login(email, password) {
  const res = await httpPost('/api/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`Login failed ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data.token;
}

async function run() {
  console.log('\n=== DSP Call Signaling Test ===\n');

  // 1. Login
  console.log('1. Logging in...');
  let customerToken, agentToken;
  try {
    customerToken = await login('gamma@client.com', 'Password@123');
    agentToken    = await login('agent1@dsp.com',   'Password@123');
    console.log('   ✓ Customer token:', customerToken.slice(0, 20) + '...');
    console.log('   ✓ Agent token:   ', agentToken.slice(0, 20) + '...');
  } catch (err) {
    console.error('   ✗ Login failed:', err.message);
    process.exit(1);
  }

  // 2. Connect sockets
  console.log('\n2. Connecting sockets...');
  const agentSocket    = ioClient(BASE, { auth: { token: agentToken },    transports: ['websocket'] });
  const customerSocket = ioClient(BASE, { auth: { token: customerToken }, transports: ['websocket'] });

  await Promise.all([
    new Promise(r => agentSocket.on('connect', r)),
    new Promise(r => customerSocket.on('connect', r)),
  ]);
  console.log('   ✓ Agent socket:   ', agentSocket.id);
  console.log('   ✓ Customer socket:', customerSocket.id);

  // 3. Agent joins agents room (verify via auto_assign_status echo)
  console.log('\n3. Agent joining agents room...');
  const joinResult = await new Promise(r => {
    const t = setTimeout(() => r('timeout — no auto_assign_status echo (server may be running old code)'), 2000);
    agentSocket.once('auto_assign_status', ({ enabled }) => {
      clearTimeout(t);
      r(`ok — auto_assign=${enabled}`);
    });
    agentSocket.emit('join_agent_room');
  });
  console.log('   join_agent_room result:', joinResult);
  if (joinResult.startsWith('timeout')) {
    console.error('   ✗ Server did not echo auto_assign_status — backend may be running old code.');
    console.error('   Restart the backend with: npm run dev (in dsp/backend)');
    agentSocket.disconnect();
    customerSocket.disconnect();
    process.exit(1);
  }

  // 4. Create call via REST
  console.log('\n4. Creating call via REST...');
  let callId;
  try {
    const res = await httpPostAuth('/api/calls/initiate', {}, customerToken);
    if (res.status !== 201) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    callId = res.data.call.id;
    console.log('   ✓ Call created, id:', callId, 'status:', res.data.call.status);
  } catch (err) {
    console.error('   ✗ initiateCall failed:', err.message);
    agentSocket.disconnect();
    customerSocket.disconnect();
    process.exit(1);
  }

  // 5. Listen for incoming_call on agent
  console.log('\n5. Sending call_offer from customer, waiting for incoming_call on agent...');
  // Log ALL events on both sockets so we can see what the server sends back
  agentSocket.onAny((event, ...args) => console.log('   [AGENT  event]', event, JSON.stringify(args).slice(0, 200)));
  customerSocket.onAny((event, ...args) => console.log('   [CUST   event]', event, JSON.stringify(args).slice(0, 200)));

  // Verify onAny is working with a ping
  console.log('   [DEBUG] onAny registered, emitting call_offer now...');

  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ success: false, reason: 'timeout — no incoming_call received after 5s' }), 5000);

    agentSocket.on('incoming_call', ({ callId: cid, customer }) => {
      clearTimeout(timeout);
      resolve({ success: true, callId: cid, customer });
    });

    agentSocket.on('call_no_agents', () => {
      clearTimeout(timeout);
      resolve({ success: false, reason: 'call_no_agents — server found no online agents (agent not in agents room?)' });
    });

    customerSocket.on('call_error', ({ message }) => {
      clearTimeout(timeout);
      resolve({ success: false, reason: `call_error: ${message}` });
    });

    customerSocket.on('call_no_agents', () => {
      clearTimeout(timeout);
      resolve({ success: false, reason: 'call_no_agents — no agents online' });
    });

    // Send a fake SDP offer (real WebRTC not needed to test routing)
    console.log('   [DEBUG] emitting call_offer with callId:', callId);
    customerSocket.emit('call_offer', {
      callId,
      offerSdp: { type: 'offer', sdp: 'v=0\r\nfake-sdp-for-routing-test\r\n' },
      chatId: null,
    });
    console.log('   [DEBUG] call_offer emitted, waiting for server response...');
  });

  // 6. Results
  console.log('\n=== RESULT ===');
  if (result.success) {
    console.log('✅ PASS — incoming_call received on agent!');
    console.log('   callId:', result.callId);
    console.log('   customer:', result.customer);
    console.log('\n   Socket signaling is working correctly.');
    console.log('   If the agent overlay still does not appear in the browser,');
    console.log('   do a hard refresh (Ctrl+F5) on the agent browser tab.');
  } else {
    console.log('❌ FAIL —', result.reason);
    console.log('\n   This means the socket routing has a bug.');
  }

  agentSocket.disconnect();
  customerSocket.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
