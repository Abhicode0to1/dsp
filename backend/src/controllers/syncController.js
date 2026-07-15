const { pool } = require('../config/database');
const bcrypt = require('bcryptjs');
const https = require('https');
const http = require('http');
const { sendWelcomeEmail } = require('../utils/emailUtils');

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Fetch a setting value from admin_settings
async function getSetting(key) {
  const [[row]] = await pool.query('SELECT value FROM admin_settings WHERE `key` = ?', [key]);
  return row?.value || '';
}

// Map any billing-app plan label to a DSP plan name (free/basic/moderate/premium)
function normalizePlanName(raw) {
  if (!raw) return 'free';
  const s = raw.toLowerCase();
  if (s.includes('premium') || s.includes('enterprise')) return 'premium';
  if (s.includes('moderate') || s.includes('standard'))   return 'moderate';
  if (s.includes('basic')    || s.includes('starter'))    return 'basic';
  return 'free';
}

// Upsert one customer record from billing data.
// Returns { action: 'created'|'updated'|'skipped', customer_id }
async function upsertCustomer(data) {
  // Try multiple field names the billing app might use for plan
  const planRaw = data.plan || data.plan_name || data.support_plan || data.subscription || data.current_plan || '';
  // Try multiple field names for status
  const statusRaw = data.plan_status || data.status || data.subscription_status || '';

  // billing app sends its customer PK as "id" — accept either field name
  const billing_customer_id = data.billing_customer_id || data.id || null;
  const { name, email, domain, plan_expiry, products, invoice_subtotal } = data;

  console.log(`[Sync] upsertCustomer: email=${email} planRaw="${planRaw}" statusRaw="${statusRaw}" raw_keys=${Object.keys(data).join(',')}`);

  if (!email || !name) return { action: 'skipped', reason: 'missing email or name' };

  // Resolve plan_id — normalize billing app label to DSP plan name first
  const resolvedPlan = normalizePlanName(planRaw);
  console.log(`[Sync] resolved plan: "${planRaw}" → "${resolvedPlan}"`);
  const [[planRow]] = await pool.query('SELECT id FROM plans WHERE name = ?', [resolvedPlan]);
  const planId = planRow?.id || null;

  const isActive = (statusRaw.toLowerCase() === 'active') ? 1 : 0;
  const expiry = plan_expiry || null;
  const productsJson = Array.isArray(products) ? JSON.stringify(products) : null;
  const subtotal = invoice_subtotal ? parseFloat(invoice_subtotal) : 0;

  // Check if customer already exists (by billing_customer_id OR email)
  const [[existing]] = await pool.query(
    `SELECT c.id AS customer_id, u.id AS user_id
     FROM customers c
     JOIN users u ON u.id = c.user_id
     WHERE c.billing_customer_id = ? OR u.email = ?
     LIMIT 1`,
    [billing_customer_id || null, email]
  );

  if (existing) {
    // Update name always; update email only if no other user already owns the new email
    const [[emailOwner]] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (!emailOwner || emailOwner.id === existing.user_id) {
      await pool.query('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, existing.user_id]);
    } else {
      // Another account owns that email — update name only, skip email to avoid collision
      console.warn(`[Sync] Email ${email} already owned by user ${emailOwner.id} — skipping email update for user ${existing.user_id}`);
      await pool.query('UPDATE users SET name = ? WHERE id = ?', [name, existing.user_id]);
    }
    // Only update plan fields if the billing app actually provided plan data
    if (planRaw) {
      await pool.query(
        `UPDATE customers
         SET plan_id = ?, plan_expiry = ?, domain = ?,
             products = ?, invoice_subtotal = ?,
             billing_customer_id = ?, billing_synced_at = NOW()
         WHERE id = ?`,
        [planId, expiry, domain || null, productsJson, subtotal, billing_customer_id || null, existing.customer_id]
      );
    } else {
      // No plan data from billing app — only update non-plan fields
      await pool.query(
        `UPDATE customers
         SET domain = COALESCE(?, domain),
             invoice_subtotal = COALESCE(NULLIF(?, 0), invoice_subtotal),
             billing_customer_id = COALESCE(?, billing_customer_id),
             billing_synced_at = NOW()
         WHERE id = ?`,
        [domain || null, subtotal || null, billing_customer_id || null, existing.customer_id]
      );
    }
    return { action: 'updated', customer_id: existing.customer_id };
  }

  // Create new user + customer.
  // We DON'T email plaintext passwords. Instead each new account gets a one-time
  // setup token (24h expiry); the welcome email points them at /setup-password/:token
  // where they pick their own password and auto-login. The random `password` we put
  // in here is a placeholder — they'll overwrite it from the setup page. It's bcrypt-
  // hashed so even if leaked the placeholder isn't usable.
  const crypto = require('crypto');
  const setupToken = crypto.randomBytes(32).toString('hex');
  const placeholderPassword = crypto.randomBytes(24).toString('hex');
  const hashedPlaceholder = await bcrypt.hash(placeholderPassword, 10);
  const [userResult] = await pool.query(
    `INSERT INTO users (name, email, password, role, is_active, password_setup_token, password_setup_expires_at)
     VALUES (?, ?, ?, 'customer', ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       is_active = VALUES(is_active),
       password_setup_token = VALUES(password_setup_token),
       password_setup_expires_at = VALUES(password_setup_expires_at)`,
    [name, email, hashedPlaceholder, isActive, setupToken]
  );

  // Get the user id (may be existing if email already exists as non-customer)
  const [[userRow]] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  const userId = userRow.id;

  // Create customer record — only set plan_id if billing app provided plan data
  const [custResult] = await pool.query(
    `INSERT INTO customers (user_id, plan_id, plan_expiry, domain, products, invoice_subtotal, billing_customer_id, billing_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       plan_id = IF(? IS NOT NULL, VALUES(plan_id), plan_id),
       plan_expiry = IF(? IS NOT NULL, VALUES(plan_expiry), plan_expiry),
       domain = VALUES(domain), products = VALUES(products),
       invoice_subtotal = VALUES(invoice_subtotal),
       billing_customer_id = VALUES(billing_customer_id),
       billing_synced_at = NOW()`,
    [userId, planRaw ? planId : null, planRaw ? expiry : null, domain || null, productsJson, subtotal, billing_customer_id || null,
     planRaw || null, planRaw || null]
  );

  return {
    action: 'created',
    customer_id: custResult.insertId,
    user_id: userId,
    setup_token: setupToken,
    email, name,
  };
}

async function updateLastSync() {
  await pool.query(
    `INSERT INTO admin_settings (\`key\`, value) VALUES ('billing_last_sync', ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [new Date().toISOString()]
  );
}

// POST /api/sync/customer — receives webhook from billing app
exports.receiveBillingWebhook = async (req, res) => {
  try {
    const secret = await getSetting('billing_webhook_secret');
    if (!secret) return res.status(403).json({ error: 'Webhook not configured' });
    if (req.headers['x-webhook-secret'] !== secret) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    const event   = req.body.event_type || req.body.event || null;
    const payload = req.body.data || req.body; // billing app may nest data under .data

    // Invoice/quote events — data fetched live from billing app; no DSP DB update needed
    if (event && (event.startsWith('invoice.') || event.startsWith('quote.'))) {
      console.log(`[Webhook] ${event} received — acknowledged (no DB action needed)`);
      await updateLastSync();
      return res.json({ synced: true, action: 'acknowledged', event });
    }

    // customer.*, plan.*, subscription.*, or no event_type → upsertCustomer
    const result = await upsertCustomer(payload);
    if (result.action === 'skipped') {
      return res.status(400).json({ error: result.reason });
    }
    if (result.action === 'created') {
      sendWelcomeEmail({ to: result.email, name: result.name, tempPassword: result.temp_password }).catch(() => {});
    }

    await updateLastSync();
    res.json({ synced: true, action: result.action, customer_id: result.customer_id });
  } catch (err) {
    console.error('[Sync Webhook]', err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
};

// POST /admin/sync/pull — one-click "Sync all from Billing".
// Pages through the billing app's customer list via the provider adapter and
// creates/links every customer in DSP. Their subscriptions/invoices/payments
// load live in the Billing tab, so we only store the link + basic products here.
// The DSP support tier is NOT set from billing (managed inside DSP).
exports.triggerPullSync = async (req, res) => {
  const billing = require('../billing');
  try {
    if (!(await billing.isConfigured())) {
      return res.status(400).json({ error: 'Billing app URL is not configured in Settings' });
    }

    let page = 1, pages = 1, total = 0;
    let created = 0, updated = 0, errors = 0;
    const errorLog = [];

    do {
      let batch;
      try {
        batch = await billing.listCustomers({ page, perPage: 100 });
      } catch (e) {
        if (billing.isListUnsupportedError(e)) {
          return res.status(501).json({
            code: 'list_unsupported',
            error: 'Your billing app has no "list all customers" endpoint yet, so DSP can\'t pull everyone automatically. Ask your billing dev to add GET /customers?page=&per_page= returning { customers:[...], pages, total }. Meanwhile use "Import from Billing" to add customers one at a time.',
          });
        }
        throw e;
      }

      pages = batch.pages || 1;
      total = batch.total || total;

      for (const cust of batch.customers) {
        try {
          // Best-effort: attach product names so the admin sees them; non-fatal.
          let products;
          try {
            const subs = await billing.getSubscriptions(cust.billing_customer_id);
            products = subs.map(s => s.name).filter(Boolean);
          } catch { /* ignore */ }

          const result = await upsertCustomer({ ...cust, products });
          if (result.action === 'created') {
            created++;
            sendWelcomeEmail({ to: result.email, name: result.name, setupToken: result.setup_token }).catch(() => {});
          } else if (result.action === 'updated') {
            updated++;
          }
        } catch (e) {
          errors++;
          errorLog.push(`${cust.email || cust.billing_customer_id}: ${e.message}`);
        }
      }
      page++;
    } while (page <= pages);

    await updateLastSync();
    res.json({ synced: created + updated, created, updated, total, errors, errorLog });
  } catch (err) {
    console.error('[Pull Sync]', err.message);
    res.status(502).json({ error: err.message || 'Failed to connect to billing API' });
  }
};

// POST /admin/billing/test — probe the billing app with saved or typed config
exports.testBillingConnection = async (req, res) => {
  try {
    const billing = require('../billing');
    const { url, key, provider, auth_style, customer_id } = req.body || {};
    const result = await billing.testConnection({
      url, key, provider, authStyle: auth_style, customerId: customer_id,
    });
    res.json(result);
  } catch (err) {
    console.error('[billing test]', err.message);
    res.status(500).json({ ok: false, message: 'Test failed to run' });
  }
};

// GET /admin/customers/:id/overrides
exports.getCustomerOverrides = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT * FROM customer_feature_overrides WHERE customer_id = ?',
      [req.params.id]
    );
    res.json({ overrides: row || null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// PUT /admin/customers/:id/overrides
exports.upsertCustomerOverrides = async (req, res) => {
  try {
    const { allow_chat, allow_calls, tickets_limit, calls_limit, chat_limit, override_reason } = req.body;
    await pool.query(
      `INSERT INTO customer_feature_overrides
         (customer_id, allow_chat, allow_calls, tickets_limit, calls_limit, chat_limit, override_reason, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         allow_chat = VALUES(allow_chat), allow_calls = VALUES(allow_calls),
         tickets_limit = VALUES(tickets_limit), calls_limit = VALUES(calls_limit),
         chat_limit = VALUES(chat_limit),
         override_reason = VALUES(override_reason), updated_by = VALUES(updated_by),
         updated_at = NOW()`,
      [
        req.params.id,
        allow_chat === null ? null : (allow_chat ? 1 : 0),
        allow_calls === null ? null : (allow_calls ? 1 : 0),
        tickets_limit ?? null,
        calls_limit ?? null,
        chat_limit ?? null,
        override_reason || null,
        req.user.id,
      ]
    );
    // Tell the customer their limits changed — fire-and-forget. Also audit log.
    notifyCustomerOfOverrides(req, req.params.id, 'overrides_updated').catch(() => {});
    res.json({ message: 'Overrides saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// DELETE /admin/customers/:id/overrides — clear all overrides
exports.deleteCustomerOverrides = async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM customer_feature_overrides WHERE customer_id = ?', [req.params.id]);
    notifyCustomerOfOverrides(req, req.params.id, 'overrides_cleared').catch(() => {});
    res.json({ message: 'Overrides cleared', cleared: result.affectedRows });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// Push a socket event to the customer + write an audit row when an admin
// changes their overrides. The customer's NotificationBell handler shows a
// toast/bell entry; their dashboard re-fetches its usage panel automatically.
async function notifyCustomerOfOverrides(req, customerId, action) {
  try {
    const [[row]] = await pool.query('SELECT user_id FROM customers WHERE id = ?', [customerId]);
    if (!row) return;
    // Socket nudge — handler is wired in CustomerNotificationBell.jsx
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${row.user_id}`).emit('overrides_changed', {
        action,
        actor_name: req.user?.name || 'Admin',
        at: new Date().toISOString(),
      });
    }
    // Audit log — same format as other admin-customer actions
    pool.query(
      `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, ip_address)
       VALUES (?, ?, ?, ?, 'customer', ?, ?)`,
      [req.user.id, req.user.name, req.user.role, action, customerId, req.ip || null]
    ).catch(() => {});
  } catch (err) {
    console.error('[notifyCustomerOfOverrides]', err.message);
  }
}

function postJson(url, bearerToken, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
    };
    const req = lib.request(options, (resp) => {
      let buf = '';
      resp.on('data', c => { buf += c; });
      resp.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

// Export shared helpers for use in adminController / customerController
exports.upsertCustomer = upsertCustomer;
exports.getSetting     = getSetting;
exports.fetchJson      = fetchJson;
exports.postJson       = postJson;

// Simple HTTP/HTTPS JSON fetch helper (no external dependencies)
function fetchJson(url, bearerToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      },
    };
    const req = lib.request(options, (resp) => {
      let body = '';
      resp.on('data', chunk => { body += chunk; });
      resp.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Invalid JSON from billing API (status ${resp.statusCode}): ${body.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Billing API request timed out')); });
    req.end();
  });
}
