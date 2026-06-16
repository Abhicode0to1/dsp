require('dotenv').config();
const http = require('http');
const { Server } = require('socket.io');
const app = require('./app');
const { testConnection } = require('./config/database');
const { runMigrations } = require('./config/migrate');
const chatSocket = require('./socket/chatSocket');
const { startSlaWorker } = require('./utils/slaWorker');
const inboundEmailWorker = require('./utils/inboundEmailWorker');
const billingRetryWorker = require('./utils/billingRetryWorker');
const expiryWorker = require('./utils/expiryWorker');

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map(s => s.trim());

const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      // Allow requests with no origin (mobile/curl), localhost, and ngrok URLs
      if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.ngrok-free.app') || origin.endsWith('.ngrok.io')) {
        cb(null, true);
      } else {
        cb(new Error(`CORS blocked: ${origin}`));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

chatSocket(io);
startSlaWorker(io);
// Inbound email worker polls the configured IMAP inbox every 60s when
// `inbound_enabled = 1` in admin_settings. No-op until admin turns it on
// and fills in the IMAP creds in Settings → Inbound Email.
inboundEmailWorker.start().catch(err => console.error('[inbound-email start]', err));
// Billing-app sync retry worker — re-posts failed Zoho notifications every
// 5 min, max 5 attempts per row. Fires admin alert email on first failure
// AND when retries are exhausted.
billingRetryWorker.start();
// Expiry worker — daily at 1am, drops lapsed customers to Free + emails
// (gated by admin_settings.auto_lapse_to_free).
expiryWorker.start();

// Make io accessible to the per-request middleware registered in app.js (which runs
// BEFORE routes). Without this, req.io would be undefined inside controllers like
// closeChat — because the middleware ordering in app.js requires `io` to be set
// via app.set() rather than added as a late app.use().
app.set('io', io);

async function start() {
  await testConnection();
  await runMigrations();
  server.listen(PORT, () => {
    console.log(`🚀 DSP Backend running on http://localhost:${PORT}`);
  });
}

start();
