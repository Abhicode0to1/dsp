require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Note: login + change-password are rate-limited inside routes/auth.js (per-route),
// so /api/auth/me (called on every page load) isn't accidentally throttled.
const otpLimiter  = rateLimit({ windowMs: 10 * 60 * 1000, max: 5,  message: { error: 'Too many OTP requests, try again in 10 minutes' } });

// General API backstop limiter — caps per-IP API bursts to blunt scripted
// abuse / hammering. Cloudflare's edge WAF is the PRIMARY DDoS layer; this is a
// second line at the app. Deliberately generous (300/min) so normal multi-call
// page loads AND org staff (admin/agent) behind a single shared NAT IP are
// never falsely throttled. If a busy office still trips it, raise `max` or key
// by authenticated user. Auth/OTP keep their own stricter per-route limits.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again shortly.' },
});

const authRoutes        = require('./routes/auth');
const customerRoutes    = require('./routes/customer');
const ticketRoutes      = require('./routes/ticket');
const chatRoutes        = require('./routes/chat');
const callRoutes        = require('./routes/call');
const agentRoutes       = require('./routes/agent');
const adminRoutes       = require('./routes/admin');
const attachmentRoutes  = require('./routes/attachments');
const csatRoutes        = require('./routes/csat');
const cannedRoutes      = require('./routes/canned');
const auditRoutes       = require('./routes/audit');
const notesRoutes       = require('./routes/notes');
const otpRoutes         = require('./routes/otp');
const syncRoutes        = require('./routes/sync');
const feedbackRoutes    = require('./routes/feedback');
const pushRoutes        = require('./routes/push');
const turnRoutes        = require('./routes/turn');
const integrationRoutes = require('./routes/integrations');

const app = express();

// Security headers. CSP is intentionally OFF for now — a strict policy easily
// breaks the SPA, socket.io and WebRTC; it should be added later with careful
// per-directive testing. crossOriginEmbedderPolicy is disabled to avoid
// blocking cross-origin media/resources (audio elements, Cloudflare assets).
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

const isProd = process.env.NODE_ENV === 'production';

const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',').map(s => s.trim());

// In production, ONLY the configured FRONTEND_URL origin(s) are allowed.
// In development we additionally allow any localhost:port / 127.0.0.1 and
// ngrok host suffixes — admin may set FRONTEND_URL to a public ngrok URL (so
// email links work for remote testers) while localhost:5173 must still be
// reachable. Those dev allowances are gated behind NODE_ENV !== 'production'
// so they can't widen the prod attack surface.
app.use(cors({
  origin: (origin, cb) => {
    if (
      !origin
      || allowedOrigins.includes(origin)
      || (!isProd && (
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        || origin.endsWith('.ngrok-free.app')
        || origin.endsWith('.ngrok.io')
      ))
    ) {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Attach socket.io to every request BEFORE routes are mounted.
// server.js will populate the actual io instance via app.set('io', io) at boot,
// so by the time any request arrives, req.io is available to controllers.
app.use((req, _res, next) => { req.io = req.app.get('io') || null; next(); });

// Trust the first hop so req.ip returns the real client IP when behind a
// reverse proxy / load balancer (most production setups). Required for the
// admin IP allowlist + rate limiting to work against real client IPs rather
// than the proxy's loopback. Safe even in direct-connect setups.
app.set('trust proxy', 1);

app.get('/api/health', (_, res) => res.json({ status: 'ok', service: 'DSP API' }));

// Apply the general backstop limiter to all /api/* traffic (health above is
// intentionally exempt so uptime monitors can ping it freely).
app.use('/api', apiLimiter);

// Public read of admin-configured settings that the frontend needs even
// before login (maintenance banner, brand color/name/footer, channel toggles,
// password rules for signup). Anonymous-readable — no sensitive values exposed.
app.get('/api/public-settings', async (_req, res) => {
  try {
    const { getAllSettings } = require('./utils/settings');
    const all = await getAllSettings();
    const pick = (k) => all[k] ?? '';
    const bool = (k, def = false) => {
      const v = all[k];
      if (v === undefined) return def;
      return v === '1' || v === 'true' || v === 1 || v === true;
    };
    res.json({
      maintenance_mode:        bool('maintenance_mode'),
      maintenance_message:     pick('maintenance_message'),
      brand_sender_name:       pick('brand_sender_name'),
      brand_footer_text:       pick('brand_footer_text'),
      brand_color:             pick('brand_color'),
      bot_widget_enabled:      bool('bot_widget_enabled', true),
      calls_system_enabled:    bool('calls_system_enabled', true),
      screen_share_enabled:    bool('screen_share_enabled', false),
      whatsapp_enabled:        bool('whatsapp_enabled', false),
      csat_after_chat:         bool('csat_after_chat', true),
      csat_after_ticket:       bool('csat_after_ticket', true),
      allow_chat_attachments:  bool('allow_chat_attachments', true),
      chat_attachment_max_mb:  parseInt(pick('chat_attachment_max_mb') || '10', 10),
      chat_attachment_types:   pick('chat_attachment_types') || 'jpg,png,gif,pdf,doc,docx,txt,zip',
      admin_idle_timeout_minutes: parseInt(pick('admin_idle_timeout_minutes') || '30', 10),
      password_min_length:     parseInt(pick('password_min_length') || '8', 10),
      password_require_digit:  bool('password_require_digit'),
      password_require_symbol: bool('password_require_symbol'),
    });
  } catch (err) {
    console.error('[public-settings]', err);
    res.json({});
  }
});

// Maintenance-mode gate: when enabled, customer-facing API endpoints return
// 503 with a clear message. Admin + agent endpoints stay alive so support
// staff can keep working during the window. The customer panel reads the
// flag from /api/public-settings and shows a banner instead of the normal UI.
app.use(async (req, res, next) => {
  // Allow these regardless of maintenance mode: auth + public-settings + admin paths
  if (req.path.startsWith('/api/auth')
      || req.path.startsWith('/api/admin')
      || req.path.startsWith('/api/agent')
      || req.path === '/api/health'
      || req.path === '/api/public-settings') {
    return next();
  }
  try {
    const { getBoolSetting, getSetting } = require('./utils/settings');
    if (await getBoolSetting('maintenance_mode', false)) {
      const msg = (await getSetting('maintenance_message', '')).trim()
        || "We're doing maintenance. Support will resume shortly.";
      return res.status(503).json({ error: 'maintenance', message: msg });
    }
  } catch {}
  next();
});

app.use('/api/auth',        authRoutes);
app.use('/api/customer',   customerRoutes);
app.use('/api/tickets',    ticketRoutes);
app.use('/api/chat',       chatRoutes);
app.use('/api/calls',      callRoutes);
app.use('/api/agent',      agentRoutes);
app.use('/api/admin',      adminRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/csat',       csatRoutes);
app.use('/api/canned',     cannedRoutes);
app.use('/api/audit',      auditRoutes);
app.use('/api/notes',      notesRoutes);
app.use('/api/otp',        otpLimiter, otpRoutes);
app.use('/api/sync',       syncRoutes);
app.use('/api/feedback',   feedbackRoutes);
app.use('/api/push',       pushRoutes);
app.use('/api/turn',       turnRoutes);
app.use('/api/integrations', integrationRoutes);

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Serve uploaded chat files (no auth required — filenames are random UUIDs)
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Serve frontend build if it exists
const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

module.exports = app;
