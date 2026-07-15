const { pool } = require('../config/database');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const https = require('https');
const http = require('http');
const {
  getCustomerWithPlan,
  isPlanActive,
  getTicketUsage,
  incrementTicketUsage,
  getCallUsage,
  getChatUsage,
  calculateFinalPrice,
} = require('../utils/planUtils');
const { pickAgent } = require('../utils/assignment');
const {
  sendTicketAssignedEmail,
  sendPlanUpgradedCustomerEmail,
  sendPlanUpgradedAdminEmail,
  sendBillingSyncFailedEmail,
} = require('../utils/emailUtils');
const { logPlanChange, inferKind } = require('../utils/planHistory');
const billing = require('../billing');

async function getSetting(key) {
  const [[row]] = await pool.query('SELECT value FROM admin_settings WHERE `key` = ?', [key]);
  return row?.value || '';
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
      resp.on('data', chunk => { buf += chunk; });
      resp.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

const PLAN_TIER  = { free: 0, basic: 1, moderate: 2, premium: 3 };
const PLAN_PRICE = { free: 0, basic: 3000, moderate: 8000, premium: 20000 };

exports.getDashboard = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer profile not found' });

    const planActive = isPlanActive(customer);
    const ticketUsed = await getTicketUsage(customer.id);
    const callUsed   = await getCallUsage(customer.id);
    const chatUsed   = await getChatUsage(customer.id);

    // Surface chat + call blacklists so the customer's restricted pages show
    // truthful "access restricted" screens instead of a misleading plan-upgrade
    // CTA. Blacklists are keyed by user_id.
    const [[chatBlockRow]] = await pool.query(
      'SELECT id FROM chat_blacklist WHERE customer_user_id = ?',
      [req.user.id]
    );
    const chatBlocked = !!chatBlockRow;
    const [[callBlockRow]] = await pool.query(
      'SELECT id FROM call_blacklist WHERE customer_user_id = ?',
      [req.user.id]
    );
    const callBlocked = !!callBlockRow;

    let products = [];
    try { products = JSON.parse(customer.products || '[]'); } catch {}

    // Same admin flag the Billing page uses to gate the extra tabs
    // (Subscriptions / Paid Invoices / Pending Payments). Surfaced here so the
    // dashboard's Pending Payments card can match — faded + non-clickable when OFF.
    const [[extrasRow]] = await pool.query(
      "SELECT value FROM admin_settings WHERE `key` = 'billing_extras_enabled' LIMIT 1"
    );
    const billing_extras_enabled = extrasRow?.value === '1' || extrasRow?.value === 'true';

    res.json({
      id: customer.id,
      name: customer.user_name,
      email: customer.email,
      domain: customer.domain,
      products,
      plan: {
        id: customer.plan_id,
        name: customer.plan_name,
        isActive: planActive,
        expiry: customer.plan_expiry,
        allowChat: !!(customer.allow_chat && planActive),
        allowCalls: !!(customer.allow_calls && planActive),
        // Tickets are NOT gated by expiry (bug #34) — an expired customer must
        // still be able to raise a ticket to reach support / renew.
        allowEmailTicket: !!customer.allow_email_ticket,
        ticketsLimit: customer.tickets_limit,
        callsLimit: customer.calls_limit,
        chatLimit: customer.chat_limit,
        priority: customer.priority,
      },
      usage: {
        ticketsUsed: ticketUsed,
        ticketsLimit: customer.tickets_limit,
        callsUsed: callUsed,
        callsLimit: customer.calls_limit,
        chatUsed: chatUsed,
        chatLimit: customer.chat_limit,
      },
      chatBlocked,
      callBlocked,
      invoiceSubtotal: customer.invoice_subtotal,
      billing_extras_enabled,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/customer/plans
exports.getCustomerPlans = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer profile not found' });

    // Hide plans the admin has retired (is_active = 0). If the customer's
    // current plan is one of them, we surface a `current_plan_retired` flag
    // so the Billing page can show a clear banner — but the disabled plan
    // doesn't appear in the Available Plans grid (admin disabled it for a
    // reason; the customer shouldn't see it as an option).
    const [plans] = await pool.query(
      'SELECT * FROM plans WHERE is_active = 1 ORDER BY id'
    );
    // Detect retired-current-plan case for the banner.
    let currentPlanRetired = false;
    if (customer.plan_id) {
      const [[stillActive]] = await pool.query(
        'SELECT id FROM plans WHERE id = ? AND is_active = 1',
        [customer.plan_id]
      );
      currentPlanRetired = !stillActive;
    }

    const pricedPlans = plans.map(p => ({
      id: p.id,
      name: p.name,
      allow_chat: p.allow_chat,
      allow_calls: p.allow_calls,
      allow_email_ticket: p.allow_email_ticket,
      tickets_limit: p.tickets_limit,
      chat_limit: p.chat_limit,
      calls_limit: p.calls_limit,
      priority: p.priority,
      sla_response_hours: p.sla_response_hours,
      sla_resolve_hours: p.sla_resolve_hours,
      // Read from the DB column (admin-editable in Settings → Plans). Fall
      // back to the legacy PLAN_PRICE map only if the DB row hasn't been
      // populated yet — so a fresh install without admin-edited prices still
      // shows something sensible on customer Billing.
      price: p.minimum_price != null ? Number(p.minimum_price) : (PLAN_PRICE[p.name] ?? 0),
    }));

    // Read the admin flag that controls whether the extra Billing tabs
    // (Subscriptions / Paid Invoices / Pending Payments) are live or in
    // "Coming soon" stub state. Default OFF until the billing flows are wired.
    const [[extrasRow]] = await pool.query(
      "SELECT value FROM admin_settings WHERE `key` = 'billing_extras_enabled' LIMIT 1"
    );
    const billing_extras_enabled = extrasRow?.value === '1' || extrasRow?.value === 'true';

    // Phase 4 — renewal window + days-to-expiry.
    // Frontend uses these to reveal downgrade options + show the banner.
    let isRenewalWindow = false;
    let daysUntilExpiry = null;
    if (customer.plan_expiry) {
      const renewalDays = parseInt((await getSetting('renewal_window_days', '30')).toString(), 10) || 30;
      const msToExpiry = new Date(customer.plan_expiry).getTime() - Date.now();
      daysUntilExpiry = Math.ceil(msToExpiry / (24 * 60 * 60 * 1000));
      isRenewalWindow = daysUntilExpiry <= renewalDays && daysUntilExpiry >= 0;
    }

    res.json({
      plans: pricedPlans,
      current_plan_id: customer.plan_id,
      current_plan_name: customer.plan_name,
      current_plan_retired: currentPlanRetired,
      expiry: customer.plan_expiry,
      is_active: isPlanActive(customer),
      billing_extras_enabled,
      is_renewal_window: isRenewalWindow,
      days_until_expiry: daysUntilExpiry,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/customer/upgrade/initiate
exports.initiateUpgrade = async (req, res) => {
  try {
    const { plan: targetPlan } = req.body;
    const validPaidPlans = ['basic', 'moderate', 'premium'];
    if (!validPaidPlans.includes(targetPlan)) {
      return res.status(400).json({ error: 'Invalid upgrade plan. Must be basic, moderate, or premium.' });
    }

    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer profile not found' });

    // Soft lock — block initiate when this customer has 5+ failures in the
    // last hour. Prevents bot retries and runaway loops. The lock window
    // (30 min from the most recent failure) auto-clears.
    const [[lockRow]] = await pool.query(
      `SELECT COUNT(*) AS failure_count, MAX(created_at) AS latest_failure
       FROM payment_attempts
       WHERE customer_id = ?
         AND status = 'failed'
         AND created_at >= NOW() - INTERVAL 60 MINUTE`,
      [customer.id]
    );
    if (Number(lockRow?.failure_count || 0) >= 5) {
      const latest = lockRow.latest_failure ? new Date(lockRow.latest_failure) : new Date();
      const cooldownUntil = new Date(latest.getTime() + 30 * 60 * 1000);
      if (cooldownUntil > new Date()) {
        return res.status(429).json({
          error: `Too many failed payment attempts. Please wait until ${cooldownUntil.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} or contact support.`,
          cooldown_until: cooldownUntil.toISOString(),
        });
      }
    }

    const currentTier = PLAN_TIER[customer.plan_name] ?? 0;
    const targetTier = PLAN_TIER[targetPlan];

    // Phase 4 — relax the "no downgrade" guard inside the renewal window.
    // Customer can pick any paid plan (including a cheaper one or the same
    // plan = renewal) during the last N days of their current plan. Outside
    // that window: upgrade-only, as before. Customers on Free can upgrade
    // any time.
    let withinRenewalWindow = false;
    if (customer.plan_expiry) {
      const renewalDays = parseInt((await getSetting('renewal_window_days', '30')).toString(), 10) || 30;
      const msToExpiry = new Date(customer.plan_expiry).getTime() - Date.now();
      const daysToExpiry = Math.ceil(msToExpiry / (24 * 60 * 60 * 1000));
      withinRenewalWindow = daysToExpiry <= renewalDays;
    }
    if (targetTier <= currentTier && !withinRenewalWindow) {
      return res.status(400).json({ error: 'Downgrades are only allowed in the last 30 days before your plan expires. Contact admin if you need an exception.' });
    }

    const keyId = await getSetting('razorpay_key_id');
    const keySecret = await getSetting('razorpay_key_secret');
    if (!keyId || !keySecret) {
      return res.status(503).json({ error: 'Payment gateway not configured. Please contact support.' });
    }

    // Read the admin-set price from the plans table (minimum_price column).
    // Falls back to the legacy hardcoded map only if the DB column is empty —
    // so admin's edits in Settings → Plans flow through to Razorpay charges.
    const [[planRow]] = await pool.query(
      'SELECT minimum_price FROM plans WHERE name = ? LIMIT 1',
      [targetPlan]
    );
    const price = planRow?.minimum_price != null
      ? Number(planRow.minimum_price)
      : (PLAN_PRICE[targetPlan] ?? 0);
    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await rzp.orders.create({
      amount: Math.round(price * 100),
      currency: 'INR',
      receipt: `upg_${customer.id}_${Date.now()}`,
      notes: { customer_id: String(customer.id), plan: targetPlan },
    });

    // Audit row — flip to 'succeeded' in verifyUpgrade or 'failed' via the
    // log-failure endpoint. Stored at initiate time so we have the order_id
    // even if the user closes the popup without the frontend ever calling
    // back.
    pool.query(
      `INSERT INTO payment_attempts (customer_id, target_plan, razorpay_order_id, amount, status, user_agent)
       VALUES (?, ?, ?, ?, 'initiated', ?)`,
      [customer.id, targetPlan, order.id, price, (req.get('user-agent') || '').slice(0, 500)]
    ).catch(e => console.error('[payment_attempts insert]', e.message));

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: keyId,
      plan: targetPlan,
      price_display: price,
    });
  } catch (err) {
    console.error('[Upgrade Initiate]', err.message);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
};

// ── Category topic knowledge base ─────────────────────────────────────────────

// Google Workspace
const GWS_TOPICS = [
  {
    test: /licen[sc]e.{0,30}(increase|add|more|buy|upgrade)|(increase|add|buy|upgrade).{0,40}licen|add.{0,15}seat|need.more.user|how.many.licen/,
    answer: "**License increases are managed by us** as your Google Workspace reseller — you cannot do this directly in Admin Console.\n\nTo add more licenses:\n1. Raise a support ticket below with the number of additional seats needed\n2. We'll process the upgrade and update your subscription\n3. New users can be created once licenses are active\n\nLicense changes typically take 1–2 business hours.",
    links: [],
    show_followup: false,
    show_options: true,
    ticket_context: 'gws_license',
  },
  {
    test: /reset.{0,20}password|password.{0,10}reset|forgot.{0,10}password|change.{0,10}password|user.password|reset.{0,6}user/,
    answer: "**To reset a user's password** (Admin steps):\n1. Go to **admin.google.com** → Directory → Users\n2. Click the user's name\n3. Click **Reset password** (top right)\n4. Choose auto-generate or set manually\n5. Enable **'Ask for a password change at next sign-in'**\n6. Click Reset → share the new password with the user\n\nFor your own admin password, visit accounts.google.com/signin/recovery",
    links: [
      { label: 'Reset Password Guide', url: 'https://support.google.com/a/answer/33561', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'gws_password',
  },
  {
    test: /new.{0,40}(id|account|user|email)|create.{0,60}(user|account|email|id)|add.{0,30}(new.user|user)|onboard/,
    answer: "**To create a new Google Workspace user:**\n1. Go to **admin.google.com** → Directory → Users\n2. Click **Add new user** (top-left button)\n3. Enter First name, Last name, and desired email address\n4. Set a temporary password (user must change on first sign-in)\n5. Click **Add new user** to confirm\n\n⚠️ You need an available license for each new user. If you've used all licenses, raise a ticket to increase your license count first.",
    links: [
      { label: 'Create New Users Guide', url: 'https://support.google.com/a/answer/33310', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'gws_new_user',
  },
  {
    test: /active.user.{0,6}list|list.{0,6}(active|all).user|user.list|export.user|all.user|user.report|how.many.user/,
    answer: "**To get a list of active users:**\n\n**Quick view:** admin.google.com → Directory → Users\n(Filter by Status: Active to see only active accounts)\n\n**Full report with last login & storage:**\nadmin.google.com → Reports → Users\n\n**To export as CSV:**\n1. Open the Users list\n2. Click the **Download** icon (top-right)\n3. Choose CSV format\n\nThe export includes name, email, last sign-in date, and storage used.",
    links: [{ label: 'User Activity Reports Guide', url: 'https://support.google.com/a/answer/4580176', external: true }],
    show_followup: true,
    show_options: false,
    ticket_context: 'gws_user_list',
  },
  {
    test: /login.challenge|login.prompt|2.?step|2fa|mfa|two.factor|turn.off.{0,10}verif|disable.{0,10}(2|verif)|sign.in.challenge/,
    answer: "**To manage Login Challenges / 2-Step Verification:**\n1. Go to **admin.google.com** → Security → Authentication → **2-step verification**\n2. Click **Allow users to turn off 2-step verification** — or set enforcement to **Optional**\n3. You can apply this to specific Organisational Units (OUs) if needed\n4. Save changes — it takes effect within a few minutes\n\n⚠️ **Security note:** Disabling 2SV reduces account security. Google may still require verification in high-risk scenarios.",
    links: [
      { label: 'Manage 2-Step Verification', url: 'https://support.google.com/a/answer/9176657', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'gws_login_challenge',
  }
];
const GWS_SUBTOPICS = [
  { label: 'License Increase',         msg: 'I need to increase my Google Workspace licenses' },
  { label: 'Password Reset',           msg: 'How do I reset a user password in Google Workspace?' },
  { label: 'Create New User / ID',     msg: 'How do I create a new Google Workspace user account?' },
  { label: 'Active User List',         msg: 'How do I get a list of active users in Google Workspace?' },
  { label: 'Turn Off Login Challenge', msg: 'How do I turn off the login challenge in Google Workspace?' }
];

// Domain
const DOMAIN_TOPICS = [
  {
    test: /transfer.{0,20}domain|domain.transfer|epp.code|auth.code|move.{0,15}domain/,
    answer: "**To transfer your domain:**\n1. **Unlock** your domain (Registrar Lock must be OFF)\n2. Get the **EPP / Auth code** from your current registrar's control panel\n3. Initiate the transfer at the receiving registrar using that code\n4. Approve the transfer confirmation email sent to your registrar contact\n\n**Transferring to us?** Raise a ticket with your domain name and we'll guide you.\n\n⚠️ Transfers take 5–7 days and renew the domain by 1 year.",
    show_followup: true,
    show_options: false,
    ticket_context: 'domain_transfer',
  },
  {
    test: /\bdns\b|mx.record|spf|dkim|dmarc|nameserver|\bns\b|a.record|cname|txt.record|dns.setting|dns.config/,
    answer: "**To update DNS records for your domain:**\n1. Log in to your domain registrar's control panel\n2. Find **DNS Management** or **Zone Editor**\n3. Add/edit the required record (A, CNAME, MX, TXT, etc.)\n4. Save — changes propagate in **24–48 hours**\n\n**Common records:**\n- **A record** → points domain to an IP\n- **CNAME** → alias to another domain\n- **MX** → email routing\n- **TXT** → SPF / DKIM / DMARC for email security\n\nNot sure what to add? Raise a ticket with the service you're configuring.",
    links: [
      { label: 'Check DNS Propagation', url: 'https://www.whatsmydns.net', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'domain_dns',
  },
  {
    test: /renew.{0,15}domain|domain.renew|domain.expir|expiring.{0,10}domain/,
    answer: "**To renew your domain:**\n1. Log in to your registrar control panel\n2. Find the domain under **My Domains**\n3. Click **Renew** and choose the period (1–10 years)\n4. Complete payment\n\n**Tip:** Enable **Auto-Renewal** to avoid accidental expiry. Domains have a 30-day grace period after expiry, then enter **redemption** which is costly to recover.\n\nIf your domain is registered through us, raise a ticket and we'll process the renewal.",
    show_followup: true,
    show_options: false,
    ticket_context: 'domain_renewal',
  },
  {
    test: /domain.{0,10}not.{0,5}point|not.{0,5}point|not.resolving|website.{0,10}not.{0,5}load|propagat|domain.{0,10}not.work|site.{0,5}not.open/,
    answer: "**Domain not pointing to your website?**\n\n**Step 1 — Check propagation:** Visit whatsmydns.net to see if DNS has propagated globally.\n\n**Common causes:**\n- DNS changes take **24–48 hours** to propagate\n- Wrong A record IP address\n- Nameservers not updated to your hosting provider's\n\n**Fix steps:**\n1. Confirm your A record points to the correct server IP\n2. Confirm nameservers match your hosting provider's NS values\n3. Clear browser cache (Ctrl+Shift+R) or test in incognito\n\nIf still unresolved after 48 hours, raise a ticket.",
    links: [
      { label: 'Check DNS Propagation', url: 'https://www.whatsmydns.net', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'domain_pointing',
  },
  {
    test: /lock.{0,15}domain|unlock.{0,15}domain|domain.lock|transfer.lock|registrar.lock/,
    answer: "**Domain Lock / Unlock:**\n\n**Registrar Lock** prevents unauthorised transfers. Always keep it **ON** unless actively transferring.\n\n**To unlock your domain:**\n1. Log in to your registrar control panel\n2. Go to the domain → **Security / Lock settings**\n3. Toggle Registrar Lock to **OFF**\n4. Complete your transfer — re-enable lock once done\n\n⚠️ Never leave your domain unlocked longer than necessary.",
    show_followup: true,
    show_options: false,
    ticket_context: 'domain_lock',
  }
];
const DOMAIN_SUBTOPICS = [
  { label: 'Domain Transfer',      msg: 'How do I transfer my domain?' },
  { label: 'DNS / MX Records',     msg: 'How do I configure DNS or MX records for my domain?' },
  { label: 'Domain Renewal',       msg: 'How do I renew my domain?' },
  { label: 'Domain Not Pointing',  msg: 'My domain is not pointing to my website' },
  { label: 'Domain Lock / Unlock', msg: 'How do I lock or unlock my domain for transfer?' }
];

// Web Hosting
const HOSTING_TOPICS = [
  {
    test: /website.{0,10}down|site.{0,10}down|website.{0,15}not.{0,5}load|not.opening|500.error|\b503\b|\b502\b|website.error|server.error|site.offline/,
    answer: "**Website down — troubleshooting steps:**\n\n**Step 1 — Check if it's only you:**\nVisit downforeveryoneorjustme.com and enter your domain.\n\n**Step 2 — Check your hosting account:**\n1. Log in to cPanel\n2. Confirm the account is **Active** (not suspended)\n3. Check **Error Logs** (cPanel → Metrics → Errors)\n\n**Common causes:**\n- Account suspended (billing)\n- PHP / script error — check error logs\n- .htaccess misconfiguration\n- Server overload\n\nRaise a ticket with your domain name and error details.",
    links: [
      { label: 'Is My Site Down?', url: 'https://downforeveryoneorjustme.com', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'hosting_down',
  },
  {
    test: /cpanel|control.panel|whm|plesk|hosting.login|hosting.dashboard|access.hosting|hosting.panel/,
    answer: "**Accessing your hosting control panel:**\n\n**cPanel URL:** `yourdomain.com/cpanel` or the login URL we sent you.\n\n**Login details** were emailed when your account was created. Forgot password? Use the **Forgot Password** link on the login page.\n\n**Direct access:**\n- cPanel: `https://server-hostname:2083`\n- WHM (resellers): `https://server-hostname:2087`\n\nIf you never received your login details, raise a ticket and we'll resend them.",
    show_followup: true,
    show_options: false,
    ticket_context: 'hosting_cpanel',
  },
  {
    test: /hosting.{0,20}email|email.{0,20}hosting|webmail|email.setup|roundcube|create.email|email.account|hosting.mail/,
    answer: "**Email on hosting — setup guide:**\n\n**Create an email account:**\n1. cPanel → **Email Accounts** → Create\n2. Enter username, domain, password and storage quota\n\n**Access webmail:**\nVisit `yourdomain.com/webmail` and log in with your full email + password.\n\n**Configure on Outlook / phone:**\n- **IMAP:** mail.yourdomain.com | Port 993 (SSL)\n- **SMTP:** mail.yourdomain.com | Port 587 (STARTTLS)\n\nIf email is not delivering, check your domain's MX records point to your hosting server.",
    show_followup: true,
    show_options: false,
    ticket_context: 'hosting_email',
  },
  {
    test: /\bssl\b|https|certificate|secure.site|ssl.install|ssl.renew|ssl.error|not.secure/,
    answer: "**SSL Certificate — Install / Renew:**\n\n**Free SSL via Let's Encrypt (cPanel):**\n1. cPanel → **SSL/TLS** → **Let's Encrypt SSL**\n2. Select your domain → **Issue**\n3. Valid 90 days — auto-renews\n\n**Force HTTPS:**\ncPanel → Domains → enable **Force HTTPS Redirect**\n\n**Not showing padlock?**\n- Mixed content: some elements still load over HTTP\n- Certificate mismatch: domain in cert differs from site URL\n\nFor paid SSL (EV/OV) or if auto-install fails, raise a ticket.",
    show_followup: true,
    show_options: false,
    ticket_context: 'hosting_ssl',
  },
  {
    test: /disk.full|disk.space|storage.full|quota.exceed|out.of.space|hosting.space|disk.usage/,
    answer: "**Hosting disk space full:**\n\n**Check what's using space:**\ncPanel → **Disk Usage** (under Files)\n\n**Free up space quickly:**\n1. Delete old backups (cPanel → Backup section)\n2. Empty webmail trash folders\n3. Remove unused databases (phpMyAdmin)\n4. Delete old error/access log files\n5. Compress large folders via File Manager\n\n**Long-term:**\n- Move media to cloud storage\n- Upgrade your hosting plan\n\nRaise a ticket for a storage upgrade.",
    show_followup: true,
    show_options: false,
    ticket_context: 'hosting_storage',
  }
];
const HOSTING_SUBTOPICS = [
  { label: 'Website Down',           msg: 'My website is down or not loading' },
  { label: 'cPanel / Control Panel', msg: 'How do I access my hosting control panel?' },
  { label: 'Email on Hosting',       msg: 'How do I set up or access email on my hosting?' },
  { label: 'SSL Certificate',        msg: 'How do I install or renew my SSL certificate?' },
  { label: 'Disk Space Full',        msg: 'My hosting disk space is full' }
];

// Microsoft 365
const M365_TOPICS = [
  {
    test: /m365.licen|microsoft.365.licen|office.365.licen|(increase|add|buy|more).{0,50}(m365|microsoft.365|office.365|ms365)/,
    answer: "**Microsoft 365 license increases are managed by us** as your reseller.\n\nTo add more licenses:\n1. Raise a support ticket with the number of additional licenses needed\n2. We'll process through Microsoft Partner Center\n3. New users can be assigned within 1–2 business hours\n\nNote: Licenses are billed from the date of activation.",
    links: [],
    show_followup: false,
    show_options: true,
    ticket_context: 'm365_license',
  },
  {
    test: /m365.password|microsoft.365.password|office.365.password|microsoft.{0,20}reset.password|reset.{0,20}microsoft/,
    answer: "**To reset a Microsoft 365 user password:**\n1. Go to **admin.microsoft.com**\n2. Navigate to **Users → Active users**\n3. Click the user → **Reset password**\n4. Choose auto-generate or set manually\n5. Click **Reset** — user receives reset instructions\n\n**For your own admin password:**\nVisit account.microsoft.com → Security → Password reset",
    links: [
      { label: 'M365 Password Reset Guide', url: 'https://support.microsoft.com/en-us/office/reset-passwords-7a5d073b-7fae-4aa5-8f96-9ecd041aba9c', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'm365_password',
  },
  {
    test: /new.{0,40}(microsoft.365|office.365|m365).user|create.{0,50}(microsoft|m365).user|add.{0,30}m365.user|microsoft.365.new.user/,
    answer: "**To create a new Microsoft 365 user:**\n1. Go to **admin.microsoft.com**\n2. Navigate to **Users → Active users**\n3. Click **Add a user**\n4. Fill in name and username (@yourdomain)\n5. Assign a **license**\n6. Set a temporary password\n7. Click **Finish adding**\n\n⚠️ You must have an available license. If all are used, raise a ticket for a license increase first.",
    links: [
      { label: 'Add M365 User Guide', url: 'https://support.microsoft.com/en-us/office/add-users-and-assign-licenses-87c6e5e6-3b8e-47cb-bf5c-5d3310f3c4d7', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'm365_new_user',
  },
  {
    test: /outlook.{0,30}issue|outlook.{0,20}email|outlook.not.working|outlook.error|microsoft.{0,20}email.{0,20}issue|cannot.send.{0,20}microsoft|cannot.receive.{0,20}microsoft/,
    answer: "**Outlook / M365 email troubleshooting:**\n\n**Not sending/receiving?**\n1. Check mailbox quota: admin.microsoft.com → Users → Mailbox size\n2. Check spam/junk folder\n3. Verify MX records point to Microsoft (use MX Toolbox)\n4. Try **Outlook Web App** (outlook.office.com) to isolate desktop vs server\n\n**Outlook app issues:**\n1. Run in **Safe Mode** (hold Ctrl while opening Outlook)\n2. Repair Office: Control Panel → Programs → Microsoft 365 → Repair\n3. Remove and re-add your account in Outlook Account Settings\n\nStill stuck? Raise a ticket with the error details.",
    links: [
      { label: 'MX Toolbox', url: 'https://mxtoolbox.com/MXLookup.aspx', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'm365_outlook',
  },
  {
    test: /teams.issue|teams.not.working|onedrive.not.sync|microsoft.teams|sharepoint.issue|teams.call|onedrive.issue/,
    answer: "**Microsoft Teams / OneDrive troubleshooting:**\n\n**Teams issues:**\n1. Sign out and back in\n2. Clear Teams cache: close Teams → delete contents of `%AppData%\\Microsoft\\Teams` → reopen\n3. Check Microsoft Service Status: **status.office.com**\n\n**OneDrive not syncing?**\n1. Click the OneDrive icon in taskbar → Help & Settings → **Resume syncing**\n2. Check available disk space (low space stops sync)\n3. Unlink and re-link: OneDrive → Settings → Account → **Unlink this PC**\n\n**Service outage?** Check status.office.com — many issues are Microsoft-side.",
    links: [
      { label: 'Microsoft Service Status', url: 'https://status.office.com', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'm365_teams',
  }
];
const M365_SUBTOPICS = [
  { label: 'License Increase',       msg: 'I need to increase my Microsoft 365 licenses' },
  { label: 'Password Reset',         msg: 'How do I reset a Microsoft 365 user password?' },
  { label: 'Add New User',           msg: 'How do I create a new Microsoft 365 user account?' },
  { label: 'Outlook / Email Issue',  msg: 'I am having Outlook or email issues on Microsoft 365' },
  { label: 'Teams / OneDrive Issue', msg: 'I am having issues with Microsoft Teams or OneDrive' }
];

// Zoho Office
const ZOHO_TOPICS = [
  {
    test: /zoho.licen|(increase|add|buy|more).{0,30}zoho/,
    answer: "**Zoho license increases are managed by us** as your Zoho partner.\n\nTo add more licenses:\n1. Raise a support ticket with the number of additional licenses\n2. We'll process through the Zoho Partner Portal\n3. New users can be added once licenses are active\n\nChanges typically take 1–2 business hours.",
    links: [],
    show_followup: false,
    show_options: true,
    ticket_context: 'zoho_license',
  },
  {
    test: /zoho.password|reset.{0,20}zoho|zoho.{0,20}password/,
    answer: "**To reset a Zoho user password (Admin steps):**\n1. Go to **accounts.zoho.com** → sign in as admin\n2. Navigate to **Admin Panel → User Management → Users**\n3. Click the user → **Reset Password**\n4. A reset link is sent to the user's recovery email\n\n**User forgot their own password?**\nVisit accounts.zoho.com → click **Forgot Password**\n\nFor admin account recovery, raise a ticket and we'll assist.",
    links: [
      { label: 'Zoho Password Reset Guide', url: 'https://www.zoho.com/accounts/help/password/password-reset.html', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'zoho_password',
  },
  {
    test: /add.{0,40}user.{0,20}zoho|new.{0,40}user.{0,20}zoho|create.{0,30}zoho|add.{0,30}zoho.{0,20}user|zoho.{0,10}(new.user|add.user)/,
    answer: "**To add a new user to Zoho:**\n1. Log in to **admin.zoho.com**\n2. Go to **User Management → Users**\n3. Click **Add User** (top right)\n4. Enter name, email, and role\n5. Assign apps and a license\n6. Click **Add** — user receives an invitation email\n\n⚠️ Make sure you have available licenses. If not, raise a ticket for a license increase first.",
    links: [
      { label: 'Add Zoho User Guide', url: 'https://www.zoho.com/accounts/help/org-accounts/user-management.html', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'zoho_new_user',
  },
  {
    test: /zoho.mail.issue|zoho.mail.not.working|zoho.email.issue|email.not.working.zoho|zoho.mail.error/,
    answer: "**Zoho Mail troubleshooting:**\n\n**Not receiving emails?**\n1. Check spam/junk in Zoho Mail\n2. Verify MX records point to `mx.zoho.in` (or your region's Zoho MX)\n3. Check mailbox storage: Zoho Mail → Settings → Storage\n\n**Not sending emails?**\n1. SPF record must include Zoho: `v=spf1 include:zoho.in ~all`\n2. Configure DKIM in Zoho Mail Admin Console → Domains\n\n**Webmail access:** mail.zoho.in\n\nRaise a ticket with your domain and error details if the issue persists.",
    links: [
      { label: 'Zoho Mail MX Setup', url: 'https://www.zoho.com/mail/help/adminconsole/mx-configuration.html', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'zoho_mail',
  },
  {
    test: /zoho.{0,30}(access|permission)|cannot.{0,20}access.{0,20}zoho|zoho.{0,20}app.{0,20}(issue|not.work)|zoho.crm.issue/,
    answer: "**Zoho app access / permission issues:**\n\n**Can't access a Zoho app?**\n1. Confirm the app is assigned to your user: Admin Panel → Users → click user → Apps\n2. Check if the app is active in your subscription: admin.zoho.com → Subscription\n3. Sign out and back in at accounts.zoho.com\n\n**Permission errors inside an app:**\n1. Admin adjusts your role: e.g. Zoho CRM → Settings → Users & Control → Profiles\n2. Profiles control what data and features each user can access\n\nIf locked out completely, raise a ticket.",
    links: [
      { label: 'Zoho User Role Management', url: 'https://www.zoho.com/accounts/help/org-accounts/user-roles.html', external: true }
    ],
    show_followup: true,
    show_options: false,
    ticket_context: 'zoho_access',
  }
];
const ZOHO_SUBTOPICS = [
  { label: 'License Increase',  msg: 'I need to increase my Zoho licenses' },
  { label: 'Password Reset',    msg: 'How do I reset a Zoho user password?' },
  { label: 'Add New User',      msg: 'How do I add a new user to Zoho?' },
  { label: 'Zoho Mail Issue',   msg: 'I am having Zoho Mail issues' },
  { label: 'Zoho App Access',   msg: 'I cannot access my Zoho app or have permission issues' }
];

// Unified category config — looped in botChat
const CATEGORY_CONFIG = [
  {
    broadTest: /google.?workspace|gws|admin.console|workspace.setup|google.apps|help.with.google/,
    broadReply: "I can help with **Google Workspace**. What do you need help with?",
    broadLinks: [{ label: 'Google Admin Console', url: 'https://admin.google.com', external: true }],
    subtopics: GWS_SUBTOPICS,
    topics: GWS_TOPICS,
  },
  {
    broadTest: /\bdomain\b|domain.name|my.domain|domain.issue|domain.help/,
    broadReply: "I can help with your **Domain**. What do you need help with?",
    broadLinks: [{ label: 'Check DNS Propagation', url: 'https://www.whatsmydns.net', external: true }],
    subtopics: DOMAIN_SUBTOPICS,
    topics: DOMAIN_TOPICS,
  },
  {
    broadTest: /web.hosting|\bhosting\b|cpanel|site.hosting|shared.hosting|my.hosting/,
    broadReply: "I can help with your **Web Hosting**. What do you need help with?",
    broadLinks: [],
    subtopics: HOSTING_SUBTOPICS,
    topics: HOSTING_TOPICS,
  },
  {
    broadTest: /microsoft.365|office.365|\bm365\b|ms365|microsoft.office/,
    broadReply: "I can help with **Microsoft 365**. What do you need help with?",
    broadLinks: [{ label: 'Microsoft 365 Admin Center', url: 'https://admin.microsoft.com', external: true }],
    subtopics: M365_SUBTOPICS,
    topics: M365_TOPICS,
  },
  {
    broadTest: /\bzoho\b|zoho.office|zoho.workplace|zoho.mail|zoho.crm/,
    broadReply: "I can help with **Zoho Office**. What do you need help with?",
    broadLinks: [{ label: 'Zoho Admin Console', url: 'https://admin.zoho.in', external: true }],
    subtopics: ZOHO_SUBTOPICS,
    topics: ZOHO_TOPICS,
  }
];

// ── General knowledge base (fallback) ─────────────────────────────────────────
const KB = [
  {
    test: /password|forgot|reset.pass|locked.out|can.t log|sign.?in.issue/,
    answer: "To reset your password, click **'Forgot Password'** on the login page — a reset link will be emailed to you. If you're still locked out after resetting, please raise a support ticket so we can investigate.",
  },
  {
    test: /email.deliver|not.receiv|bounce|email.not.arriving/,
    answer: "Email delivery issues are usually caused by incorrect **MX, SPF, DKIM, or DMARC** records. Check your DNS settings and raise a ticket if the issue persists.",
    links: [
      { label: 'Set Up MX Records', url: 'https://support.google.com/a/answer/33352', external: true },
      { label: 'Configure SPF, DKIM & DMARC', url: 'https://support.google.com/a/topic/2759192', external: true }
    ],
  },
  {
    test: /storage|quota|disk.full|space|out.of.storage/,
    answer: "Storage is pooled across your account. Check current usage in your service's admin console. To free space, delete old emails, files, and backups.",
    links: [{ label: 'Manage Workspace Storage', url: 'https://support.google.com/a/answer/1385626', external: true }],
  },
  {
    test: /migrate|import.email|move.email|migration|old.email/,
    answer: "Email migration is supported via your admin console's **Data Migration** tool. It supports Gmail, Exchange, Outlook, and IMAP sources. Raise a ticket if you need assistance.",
    links: [{ label: 'Email Migration Guide', url: 'https://support.google.com/a/answer/6351474', external: true }],
  }
];

// Specific sub-query handlers — matched before broad category checks
const SUB_QUERY_HANDLERS = [
  // Billing
  { test: /tax.invoice.not.received|invoice.not.received|payment.*complete.*invoice/, reply: "Our billing team will resend your tax invoice right away. Tax invoices are generated within 1–2 business days of payment confirmation. You can also check your paid invoices on the **Billing** tab.", links: [{ label: 'Go to Billing', url: '/customer/billing', internal: true }], action: 'raise_ticket', ticket_context: 'billing_invoice' },
  { test: /payment.done.*reminder|still.receiv.*reminder|payment.made.*reminder|payment.*reminders/, reply: "Payment reminders are automatically stopped within 24 hours of payment confirmation. You can verify your payment status and invoices on the **Billing** tab.", links: [{ label: 'Go to Billing', url: '/customer/billing', internal: true }], action: 'raise_ticket', ticket_context: 'billing_reminders' },
  { test: /subscription.period.incorrect|period.is.incorrect|incorrect.*subscription.period/, reply: "We'll check and correct your subscription period. You can view your current subscription details on the **Billing** tab.", links: [{ label: 'Go to Billing', url: '/customer/billing', internal: true }], action: 'raise_ticket', ticket_context: 'billing_subscription' },
  { test: /revise.*bill|reduce.*bill|revise.*amount|reduce.*amount/, reply: "Bill revisions require review by our accounts team. You can view your invoices and pending payments on the **Billing** tab.", links: [{ label: 'Go to Billing', url: '/customer/billing', internal: true }], action: 'raise_ticket', ticket_context: 'billing_reduce' },
  { test: /update.*gst.number|please.update.*gst|gst.number/, reply: "We'll update your GSTIN in our billing records so future invoices carry the correct details. You can track your invoices on the **Billing** tab.", links: [{ label: 'Go to Billing', url: '/customer/billing', internal: true }], action: 'raise_ticket', ticket_context: 'billing_gst' },
  { test: /update.*billing.address|please.update.*billing.address/, reply: "We'll update your billing address for future invoices. Your subscription and invoice details are available on the **Billing** tab.", links: [{ label: 'Go to Billing', url: '/customer/billing', internal: true }], action: 'raise_ticket', ticket_context: 'billing_address' },
  // Domain
  { test: /renewal.price.*domain|domain.*renewal.price|renewal.price.*my.domain/, reply: "Domain renewal prices vary by extension (.com, .in, .org, etc.). Please raise a ticket with your domain name and we'll share the exact renewal price.", action: 'raise_ticket', ticket_context: 'domain_price_query' },
  { test: /domain.has.expired|my.domain.*expired|domain.*expired.*please/, reply: "⚠️ Expired domains need urgent renewal — after the grace period they may become available to others. Our team will prioritise this immediately.", action: 'raise_ticket', ticket_context: 'domain_expired_now' },
  { test: /please.renew.*domain|renew.*my.domain/, reply: "We'll process your domain renewal right away.", action: 'raise_ticket', ticket_context: 'domain_renewal' },
  { test: /domain.login.details|domain.*login.details|share.*domain.*login/, reply: "Domain login credentials are shared securely. Please raise a ticket specifying your domain name and the type of access you need.", action: 'raise_ticket', ticket_context: 'domain_login_req' },
  // Hosting
  { test: /hosting.plans.available|what.*hosting.plans|available.*hosting.plans/, reply: "We offer Shared Hosting, WordPress Hosting, and VPS plans. Please raise a ticket with your requirements and our team will share a detailed quote.", action: 'raise_ticket', ticket_context: 'hosting_plans_query' },
  { test: /my.hosting.*suspended|hosting.*has.been.suspended/, reply: "⚠️ Hosting suspensions are usually due to resource overuse or billing. Our team will investigate and reactivate it immediately.", action: 'raise_ticket', ticket_context: 'hosting_suspended_ticket' },
  { test: /hosting.cpanel.login|need.*hosting.*cpanel|cpanel.login.details|hosting.*cpanel.*login/, reply: "Hosting/cPanel credentials are shared securely. Please raise a ticket with your domain name and the type of access needed.", action: 'raise_ticket', ticket_context: 'hosting_login_req' },
  { test: /pricing.*1.gb.hosting|1.gb.hosting|1gb.*hosting/, reply: "Our 1 GB hosting plan is priced competitively. Please raise a ticket for the exact pricing and any specific requirements.", action: 'raise_ticket', ticket_context: 'hosting_1gb_price' },
  // Microsoft 365
  { test: /not.logging.into.outlook|account.not.logging.*outlook|cannot.log.*outlook/, reply: "Outlook login issues are usually caused by incorrect credentials, MFA prompts, or account suspension. Our team will investigate and resolve this.", action: 'raise_ticket', ticket_context: 'm365_outlook_login' },
  { test: /reset.*microsoft.365.password|microsoft.365.*password.reset|please.reset.*microsoft/, reply: "We'll reset the Microsoft 365 account password right away.", action: 'raise_ticket', ticket_context: 'm365_pwd_reset' },
  { test: /microsoft.365.*emails.*going.*spam|microsoft.*365.*spam|m365.*spam|365.*emails.*spam/, reply: "Emails going to spam are usually fixed by configuring SPF, DKIM, and DMARC records on your domain DNS. Our team will check and fix this.", action: 'raise_ticket', ticket_context: 'm365_spam' },
  { test: /not.receiving.*emails.*specific.*email.*microsoft|not.receiving.*specific.*microsoft|microsoft.*365.*not.receiving.*specific/, reply: "Email delivery issues between specific addresses can be caused by block lists, mail filters, or DNS misconfigurations. Our team will investigate.", action: 'raise_ticket', ticket_context: 'm365_not_receiving' },
  { test: /microsoft.365.*storage.is.full|microsoft.365.*storage.full|m365.*storage.full/, reply: "When your Microsoft 365 mailbox is full, new emails are bounced back to senders. We can increase your storage or help archive old emails.", action: 'raise_ticket', ticket_context: 'm365_storage' },
  { test: /restore.*microsoft.365|microsoft.365.*restore|emails.deleted.*restore.*microsoft|restore.*microsoft/, reply: "Deleted emails can be recovered from the Recoverable Items folder within 30 days. Our team will restore them for you.", action: 'raise_ticket', ticket_context: 'm365_restore' },
  // Zoho
  { test: /zoho.office.*pricing.details|please.share.*zoho.*pricing|zoho.*pricing.details/, reply: "Zoho Office pricing depends on the specific product and number of licenses. Our team will share a customised quote.", action: 'raise_ticket', ticket_context: 'zoho_pricing_req' },
  { test: /please.add.1.zoho.license|add.1.zoho.license|add.*zoho.*license/, reply: "We'll add the Zoho license to your account right away.", action: 'raise_ticket', ticket_context: 'zoho_add_license' },
  { test: /configure.*zoho.*iphone|configure.*zoho.*mobile|zoho.*configure.*mobile|zoho.*iphone/, reply: "Configuring Zoho Mail on iPhone/mobile is straightforward with IMAP settings. Our team will guide you through the setup step by step.", action: 'raise_ticket', ticket_context: 'zoho_mobile_config' },
  { test: /zoho.*emails.*deleted.*automatically|zoho.*auto.*delet.*mailbox|emails.*deleted.*automatically.*zoho/, reply: "Auto-deletion of Zoho emails is usually caused by retention policies or server-side filters. Our team will investigate and stop this.", action: 'raise_ticket', ticket_context: 'zoho_auto_delete' },
  { test: /create.*zoho.*email.alias|please.create.*zoho.*alias|zoho.*email.*alias/, reply: "We'll create the email alias in Zoho for you right away.", action: 'raise_ticket', ticket_context: 'zoho_alias' },
  { test: /zoho.*outgoing.*emails.*rejected|zoho.*outgoing.*rejected|outgoing.emails.*rejected.*zoho/, reply: "Outgoing email rejections from Zoho are usually due to SPF/DKIM misconfigurations or being on a blocklist. Our team will fix this.", action: 'raise_ticket', ticket_context: 'zoho_outgoing' }
];

function buildPlanInfo(customer, planActive) {
  return {
    name: customer.plan_name || 'free',
    allow_chat: !!(customer.allow_chat && planActive),
    allow_calls: !!(customer.allow_calls && planActive),
    is_active: planActive,
  };
}

// POST /api/customer/bot — intelligent support assistant
exports.botChat = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ reply: 'Please send a message.' });

    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const planActive = isPlanActive(customer);
    const canChat    = !!(customer.allow_chat  && planActive);
    const canCall    = !!(customer.allow_calls && planActive);
    const plan_info  = buildPlanInfo(customer, planActive);

    const lower = message.toLowerCase().trim();

    // ── 0. Greeting intercept ────────────────────────────────────────────────
    if (/^(hi|hello|hey|howdy|hiya|good\s*(morning|afternoon|evening)|greetings|sup)[\s!?.]*$/.test(lower)) {
      return res.json({
        reply: "Hi there! I'm your support assistant. What can I help you with today?",
        links: [], billing_summary: null, show_followup: false, show_options: true,
        action: null, plan_info,
      });
    }

    // ── 1. Direct channel requests ──────────────────────────────────────────
    if (/\bchat\b|live.?chat|talk to.{0,8}agent|speak to.{0,8}(agent|human|person)|connect me/.test(lower)) {
      return res.json({
        reply: canChat
          ? "Sure! I'll connect you with a live support agent. Click below to start."
          : "Live chat is available on the **Basic plan and above**. Upgrade to access it.",
        links: [], billing_summary: null, show_followup: false, show_options: !canChat,
        action: canChat ? 'chat' : null,
        upgrade_hint: !canChat,
        plan_info,
      });
    }

    if (/\bcall\b|phone.support|ring me|call.back|voice.call/.test(lower)) {
      return res.json({
        reply: canCall
          ? "I'll connect you via voice support. Click below to initiate a call."
          : "Voice call support is available on the **Moderate plan and above**. Upgrade to access it.",
        links: [], billing_summary: null, show_followup: false, show_options: !canCall,
        action: canCall ? 'call' : null,
        upgrade_hint: !canCall,
        plan_info,
      });
    }

    // ── 1b. Specific sub-query handlers ──────────────────────────────────────
    for (const handler of SUB_QUERY_HANDLERS) {
      if (handler.test.test(lower)) {
        return res.json({
          reply: handler.reply,
          links: handler.links || [],
          billing_summary: null,
          show_followup: false,
          show_options: false,
          action: handler.action || null,
          ticket_context: handler.ticket_context || null,
          subtopics: null,
          plan_info,
        });
      }
    }

    // ── 1c. Share account details (async — needs billing data) ────────────────
    if (/share.*account.details|please.share.*account.details/.test(lower)) {
      const expiry = customer.plan_expiry
        ? new Date(customer.plan_expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'N/A';
      const ticketsUsed = await getTicketUsage(customer.id);
      return res.json({
        reply: 'Here are your current account and subscription details. For full billing history and invoices, visit the Billing page.',
        links: [{ label: 'View Billing Page', url: '/customer/billing', internal: true }],
        billing_summary: {
          plan: customer.plan_name || 'free',
          status: planActive ? 'Active' : 'Expired',
          expiry,
          invoice_subtotal: customer.invoice_subtotal || 0,
          allow_chat: canChat,
          allow_calls: canCall,
          tickets_used: ticketsUsed,
          tickets_limit: customer.tickets_limit,
        },
        show_followup: true,
        show_options: false,
        action: null,
        ticket_context: 'general',
        plan_info,
      });
    }

    // ── 1d. Domain renewal date (tries billing app) ───────────────────────────
    if (/renewal.date.*domain|domain.*renewal.date|what.*renewal.date.*domain/.test(lower)) {
      let reply = 'For your domain renewal date, please check the Subscriptions tab on the Billing page, or raise a ticket and our team will share it.';
      try {
        if (customer.billing_customer_id && await billing.isConfigured()) {
          const subs = await billing.getSubscriptions(customer.billing_customer_id);
          const domainSub = subs.find(s => /domain/i.test(s.name || ''));
          if (domainSub && domainSub.renewal_date) {
            const formatted = new Date(domainSub.renewal_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            reply = `Your domain subscription (**${domainSub.name || 'Domain'}**) is due for renewal on **${formatted}**. You can view all subscriptions on the Billing page.`;
          }
        }
      } catch {}
      return res.json({
        reply,
        links: [{ label: 'View Subscriptions', url: '/customer/billing', internal: true }],
        billing_summary: null,
        show_followup: true,
        show_options: false,
        action: null,
        ticket_context: 'domain_renewal',
        plan_info,
      });
    }

    // ── 2. Billing / plan queries — return customer's own data ───────────────
    if (/\bplan\b|billing|invoice|payment|subscription|price|cost|upgrade|my\.plan|current\.plan/.test(lower)) {
      const expiry = customer.plan_expiry
        ? new Date(customer.plan_expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'N/A';
      const ticketsUsed = await getTicketUsage(customer.id);
      const billing_summary = {
        plan: customer.plan_name || 'free',
        status: planActive ? 'Active' : 'Expired',
        expiry,
        invoice_subtotal: customer.invoice_subtotal || 0,
        allow_chat: canChat,
        allow_calls: canCall,
        tickets_used: ticketsUsed,
        tickets_limit: customer.tickets_limit,
      };
      return res.json({
        reply: `Here's a summary of your current subscription. You're on the **${(customer.plan_name || 'Free').toUpperCase()} plan** — status: **${billing_summary.status}**, expiry: **${expiry}**. Visit the Billing page to upgrade or view full details.`,
        links: [{ label: 'Go to Billing Page', url: '/customer/billing', internal: true }],
        billing_summary,
        show_followup: true,
        show_options: false,
        action: null,
        plan_info,
      });
    }

    // ── 3. Category-specific topics (GWS, Domain, Hosting, M365, Zoho) ────────
    // Pass 1: identify category via broadTest first, then match topic within it.
    // This prevents GWS topic regexes from firing on M365/Zoho messages.
    for (const cat of CATEGORY_CONFIG) {
      if (!cat.broadTest.test(lower)) continue;
      const topicMatch = cat.topics.find(e => e.test.test(lower));
      if (topicMatch) {
        return res.json({
          reply: topicMatch.answer,
          links: topicMatch.links || [],
          billing_summary: null,
          show_followup: !!topicMatch.show_followup,
          show_options: !!topicMatch.show_options,
          subtopics: null,
          action: null,
          ticket_context: topicMatch.ticket_context || null,
          plan_info,
        });
      }
      return res.json({
        reply: cat.broadReply,
        links: cat.broadLinks || [],
        billing_summary: null,
        show_followup: false,
        show_options: false,
        subtopics: cat.subtopics,
        action: null,
        plan_info,
      });
    }
    // Pass 2: no broadTest matched — scan topic patterns across all categories.
    // Handles free-text queries where customer doesn't specify a service name.
    for (const cat of CATEGORY_CONFIG) {
      const topicMatch = cat.topics.find(e => e.test.test(lower));
      if (topicMatch) {
        return res.json({
          reply: topicMatch.answer,
          links: topicMatch.links || [],
          billing_summary: null,
          show_followup: !!topicMatch.show_followup,
          show_options: !!topicMatch.show_options,
          subtopics: null,
          action: null,
          ticket_context: topicMatch.ticket_context || null,
          plan_info,
        });
      }
    }

    // ── 4. General knowledge base lookup ─────────────────────────────────────
    const kbMatch = KB.find(entry => entry.test.test(lower));
    if (kbMatch) {
      return res.json({
        reply: kbMatch.answer,
        links: kbMatch.links || [],
        billing_summary: null,
        show_followup: true,
        show_options: false,
        subtopics: null,
        action: null,
        plan_info,
      });
    }

    // ── 5. Ticket intent ─────────────────────────────────────────────────────
    if (/ticket|raise.{0,8}issue|report.{0,8}(issue|bug|problem)|not.working|broken|error/.test(lower)) {
      return res.json({
        reply: "I can help you raise a support ticket right here — no need to leave the chat. Our team will get back to you within your plan's SLA window.",
        links: [], billing_summary: null, show_followup: false, show_options: false,
        action: 'raise_ticket',
        plan_info,
      });
    }

    // ── 5. No match — show all support options ───────────────────────────────
    return res.json({
      reply: "I'm not sure I have a specific answer for that. Here are the best ways to get help:",
      links: [], billing_summary: null, show_followup: false, show_options: true,
      action: null,
      plan_info,
    });

  } catch (err) {
    console.error('[BotChat]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/customer/bot/ticket — raise ticket directly from bot
exports.botRaiseTicket = async (req, res) => {
  try {
    const { subject, description } = req.body;
    if (!subject?.trim() || !description?.trim()) {
      return res.status(400).json({ error: 'Subject and description are required.' });
    }

    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Tickets stay available even when the plan has expired — it's the one
    // channel an expired customer can still use to reach support and renew
    // (bug #34). Chat & calls remain blocked on expiry. The monthly ticket
    // limit below still applies.

    // Respect monthly ticket limit
    const ticketsUsed = await getTicketUsage(customer.id);
    if (customer.tickets_limit !== null && ticketsUsed >= customer.tickets_limit) {
      return res.status(403).json({
        error: `Monthly ticket limit of ${customer.tickets_limit} reached. Please upgrade your plan.`,
        limit_exceeded: true,
      });
    }

    // Detect priority from customer's words (basic heuristic — admin can change later)
    const combined = `${subject} ${description}`.toLowerCase();
    let detectedPriority = 'normal';
    if (/\b(urgent|asap|critical|emergency|outage|down|cannot work)\b/.test(combined)) detectedPriority = 'urgent';
    else if (/\b(important|high priority|blocking)\b/.test(combined)) detectedPriority = 'high';

    const trimmedSubject = subject.trim().substring(0, 200);
    const trimmedDescription = description.trim().substring(0, 2000);

    const [result] = await pool.query(
      `INSERT INTO tickets (customer_id, subject, description, status, priority)
       VALUES (?, ?, ?, 'open', ?)`,
      [customer.id, trimmedSubject, trimmedDescription, detectedPriority]
    );

    await incrementTicketUsage(customer.id);
    const ticketId = result.insertId;

    // Auto-assign via centralized helper (fixes bug: bot tickets were never assigned)
    try {
      const { agentId, reason } = await pickAgent({
        io: req.io,
        channel: 'ticket',
        customerId: customer.id,
        priority: detectedPriority,
        requireOnline: false,
      });
      if (agentId) {
        const [[assignedAgent]] = await pool.query(
          'SELECT id, name, email FROM users WHERE id = ?', [agentId]
        );
        await pool.query('UPDATE tickets SET assigned_agent_id = ? WHERE id = ?', [agentId, ticketId]);
        if (req.io) {
          req.io.to(`user_${agentId}`).emit('ticket_assigned', {
            ticketId, subject: trimmedSubject, customerName: req.user.name, reason,
          });
        }
        sendTicketAssignedEmail({
          to: assignedAgent.email, agentName: assignedAgent.name,
          customerName: req.user.name, ticketId,
          subject: trimmedSubject, description: trimmedDescription,
        });
        console.log(`[BotTicket] #${ticketId} (${detectedPriority}) assigned to ${assignedAgent.name} via ${reason}`);
      }
    } catch (err) { console.error('[BotTicket] auto-assign error:', err.message); }

    res.json({
      ticket_id: ticketId,
      message: `Ticket #${ticketId} raised successfully! Our team will respond to you at **${customer.email}** within your plan's SLA window.`,
    });
  } catch (err) {
    console.error('[BotRaiseTicket]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/customer/agent-status — returns agent availability considering working hours (IST).
// Now also returns availableCount / busyCount / totalOnline so the customer can see
// how many agents are actually free vs already in a chat or on a call.
exports.getAgentStatus = async (req, res) => {
  try {
    const { getOnlineAgentIds } = require('../socket/chatSocket');
    // Pass req.app's socket.io instance so room membership is used as ground truth
    // — survives backend restarts that wipe the in-memory status map.
    const onlineIds = getOnlineAgentIds(req.app.get('io'));
    const totalOnline = onlineIds.length;

    // How many of those are tied up on an active chat or call right now?
    let busyOnline = 0;
    if (totalOnline) {
      const ph = onlineIds.map(() => '?').join(',');
      const [chatBusy] = await pool.query(
        `SELECT DISTINCT agent_id FROM chats WHERE status = 'active' AND agent_id IN (${ph})`,
        onlineIds
      );
      // Only count calls that are recent — a row stuck in 'ringing'/'active' for more
      // than an hour is a zombie (agent disconnected without proper end). It shouldn't
      // make the agent look busy forever.
      const [callBusy] = await pool.query(
        `SELECT DISTINCT agent_id FROM calls
         WHERE status IN ('ringing','active')
           AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
           AND agent_id IN (${ph})`,
        onlineIds
      );
      const busySet = new Set([
        ...chatBusy.map(r => Number(r.agent_id)),
        ...callBusy.map(r => Number(r.agent_id))
      ]);
      busyOnline = busySet.size;
    }
    const availableCount = Math.max(0, totalOnline - busyOnline);

    const workStart  = parseInt(await getSetting('work_hours_start') || '10');
    const workEnd    = parseInt(await getSetting('work_hours_end')   || '18');
    const workDayNums = (await getSetting('work_hours_days') || '1,2,3,4,5,6')
      .split(',').map(Number).filter(n => !isNaN(n));

    // Convert current UTC time to IST (UTC+5:30)
    const istMs  = Date.now() + 5.5 * 60 * 60 * 1000;
    const ist    = new Date(istMs);
    const istHour = ist.getUTCHours();
    const istDay  = ist.getUTCDay(); // 0=Sun … 6=Sat

    const withinHours = workDayNums.includes(istDay) && istHour >= workStart && istHour < workEnd;

    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let workDaysLabel;
    if (workDayNums.length === 7) workDaysLabel = 'Every day';
    else if (workDayNums.length === 6 && !workDayNums.includes(0)) workDaysLabel = 'Mon–Sat';
    else if (workDayNums.length === 5 && !workDayNums.includes(0) && !workDayNums.includes(6)) workDaysLabel = 'Mon–Fri';
    else workDaysLabel = workDayNums.map(d => DAY_NAMES[d]).join(', ');

    res.json({
      online:       totalOnline > 0 && withinHours,
      availableCount,
      busyCount: busyOnline,
      totalOnline,
      withinHours,
      workStart,
      workEnd,
      workDaysLabel,
    });
  } catch {
    res.json({ online: false, availableCount: 0, busyCount: 0, totalOnline: 0, withinHours: false, workStart: 10, workEnd: 18, workDaysLabel: 'Mon–Sat' });
  }
};

// POST /api/customer/upgrade/verify
exports.verifyUpgrade = async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, plan: targetPlan, amount } = req.body;
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const keySecret = await getSetting('razorpay_key_secret');
    if (!keySecret) return res.status(503).json({ error: 'Payment gateway not configured' });

    const expectedSig = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSig !== razorpay_signature) {
      // Record the verification failure so it counts toward the soft-lock and
      // shows up in the Payment Failures card.
      pool.query(
        `UPDATE payment_attempts
         SET status = 'failed', razorpay_payment_id = ?, error_code = 'SIGNATURE_MISMATCH',
             error_description = 'Razorpay signature did not match — possible payment tampering'
         WHERE razorpay_order_id = ? AND status = 'initiated'`,
        [razorpay_payment_id, razorpay_order_id]
      ).catch(() => {});
      return res.status(400).json({ error: 'Payment verification failed. Please contact support.' });
    }

    // Look up the target plan
    const [planRows] = await pool.query('SELECT id FROM plans WHERE name = ? LIMIT 1', [targetPlan]);
    if (!planRows.length) {
      return res.status(400).json({ error: `Unknown plan: ${targetPlan}` });
    }
    const newPlanId = planRows[0].id;

    // Set expiry to 1 year from now (YYYY-MM-DD format for MySQL)
    const expiryDate = new Date();
    expiryDate.setFullYear(expiryDate.getFullYear() + 1);
    const expiryStr = expiryDate.toISOString().split('T')[0];

    // Get customer row id (not user id) + current plan_id/expiry so we can
    // log a precise from→to row in plan_change_history.
    const [custRows] = await pool.query(
      'SELECT id, plan_id, plan_expiry FROM customers WHERE user_id = ?',
      [req.user.id]
    );
    if (!custRows.length) return res.status(404).json({ error: 'Customer not found' });
    const customerId = custRows[0].id;
    const fromPlanId = custRows[0].plan_id;
    const expiryBefore = custRows[0].plan_expiry;

    // Update plan in database
    await pool.query(
      'UPDATE customers SET plan_id = ?, plan_expiry = ? WHERE id = ?',
      [newPlanId, expiryStr, customerId]
    );

    // Flip the initiated payment_attempts row → succeeded
    pool.query(
      `UPDATE payment_attempts
       SET status = 'succeeded', razorpay_payment_id = ?
       WHERE razorpay_order_id = ? AND status = 'initiated'`,
      [razorpay_payment_id, razorpay_order_id]
    ).catch(() => {});

    // Best-effort audit row. inferKind covers upgrade/downgrade/renewal based
    // on tier movement; will be 'renewal' when fromPlanId === newPlanId (same
    // plan, fresh year) which happens in Phase 4's renewal-window flow.
    const [[fromPlanRow]] = await pool.query('SELECT name FROM plans WHERE id = ?', [fromPlanId]);
    logPlanChange({
      customerId,
      fromPlanId,
      toPlanId: newPlanId,
      changeKind: inferKind(fromPlanRow?.name, targetPlan),
      amountPaid: amount || null,
      paymentRef: razorpay_payment_id,
      expiryBefore,
      expiryAfter: expiryStr,
    });

    // No local invoice insert — Revenue is now computed from plan × price math,
    // not from the invoices table. The Zoho billing app remains the canonical
    // source for invoice records; this controller's job is to update the plan
    // and audit the change (already done via plan_change_history above).

    // Notify billing app to update support subscription + create invoice.
    // On failure: queue a row in pending_billing_syncs for the retry worker
    // AND fire an immediate admin alert email so manual reconciliation can
    // start before the worker exhausts retries. The customer's plan is
    // already active in DSP — the missing piece is the Zoho invoice.
    const customer = await getCustomerWithPlan(req.user.id);
    const billingUrl = await getSetting('billing_api_url');
    const apiKey = await getSetting('billing_api_key');
    let billingSynced = false;
    let billingError = null;
    if (billingUrl && customer) {
      try {
        const billingRes = await postJson(`${billingUrl.replace(/\/$/, '')}/api/support-upgrade`, apiKey, {
          billing_customer_id: customer.billing_customer_id || null,
          email: customer.email,
          plan: targetPlan,
          plan_expiry: expiryStr,
          payment_ref: razorpay_payment_id,
          payment_mode: 'Razorpay',
          amount: amount || 0,
        });
        console.log('[Upgrade] Billing app notified successfully:', JSON.stringify(billingRes));
        billingSynced = true;
      } catch (e) {
        billingError = e.message || String(e);
        console.error('[Upgrade] Billing app notification failed (plan updated in DSP):', billingError);
        try {
          await pool.query(
            `INSERT INTO pending_billing_syncs
              (customer_id, plan, payment_ref, amount, plan_expiry, attempts, last_error, last_attempt_at, admin_notified)
             VALUES (?, ?, ?, ?, ?, 1, ?, NOW(), 1)`,
            [customerId, targetPlan, razorpay_payment_id, amount || 0, expiryStr, billingError.slice(0, 1000)]
          );
        } catch (dbErr) {
          console.error('[Upgrade] Failed to queue pending_billing_sync row:', dbErr.message);
        }
        // Fire-and-forget admin alert
        try {
          const [admins] = await pool.query("SELECT email FROM users WHERE role = 'admin' AND is_active = TRUE");
          const adminEmails = admins.map(a => a.email).filter(Boolean);
          if (adminEmails.length) {
            const planLabelForAlert = String(targetPlan).charAt(0).toUpperCase() + String(targetPlan).slice(1);
            const amountForAlert = amount
              ? `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : `₹0.00`;
            sendBillingSyncFailedEmail({
              to: adminEmails.join(', '),
              customerName: customer.name || customer.email,
              customerEmail: customer.email,
              planLabel: planLabelForAlert,
              amount: amountForAlert,
              paymentRef: razorpay_payment_id,
              lastError: billingError,
            }).catch(err => console.error('[Billing sync alert email]', err.message));
          }
        } catch (e) {
          console.error('[Billing sync alert — admin lookup]', e.message);
        }
      }
    }

    // Fire-and-forget: email receipt to the customer + revenue alert to admins.
    // Errors are swallowed so an SMTP blip doesn't fail the upgrade response.
    if (customer) {
      const planLabel = String(targetPlan).charAt(0).toUpperCase() + String(targetPlan).slice(1);
      const amountDisplay = amount
        ? `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : `₹0.00`;
      const expiryHuman = new Date(expiryStr).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
      });

      sendPlanUpgradedCustomerEmail({
        to: customer.email,
        customerName: customer.name || 'there',
        planLabel,
        amount: amountDisplay,
        expiryDate: expiryHuman,
        paymentRef: razorpay_payment_id,
      }).catch(err => console.error('[Upgrade email — customer]', err.message));

      try {
        const [admins] = await pool.query(
          "SELECT email FROM users WHERE role = 'admin' AND is_active = TRUE"
        );
        const adminEmails = admins.map(a => a.email).filter(Boolean);
        if (adminEmails.length) {
          sendPlanUpgradedAdminEmail({
            to: adminEmails.join(', '),
            customerName: customer.name || customer.email,
            customerEmail: customer.email,
            planLabel,
            amount: amountDisplay,
            paymentRef: razorpay_payment_id,
          }).catch(err => console.error('[Upgrade email — admin]', err.message));
        }
      } catch (e) {
        console.error('[Upgrade email — admin lookup]', e.message);
      }
    }

    res.json({ success: true, message: 'Payment verified. Your plan has been upgraded successfully.' });
  } catch (err) {
    console.error('[Upgrade Verify]', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
};

// POST /api/customer/upgrade/log-failure
// Frontend posts here when the Razorpay popup errors / customer cancels.
// We update the existing 'initiated' row to 'failed' or 'cancelled' with
// Razorpay's reason. Powers the System Health failure count and the soft-lock
// trigger in initiateUpgrade.
exports.logUpgradeFailure = async (req, res) => {
  try {
    const { order_id, error_code, error_description, cancelled } = req.body || {};
    if (!order_id) return res.status(400).json({ error: 'order_id required' });
    const [[cust]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cust) return res.status(404).json({ error: 'Customer not found' });
    const status = cancelled ? 'cancelled' : 'failed';
    await pool.query(
      `UPDATE payment_attempts
       SET status = ?,
           error_code = ?,
           error_description = ?
       WHERE razorpay_order_id = ? AND customer_id = ? AND status = 'initiated'`,
      [status, (error_code || '').slice(0, 100), (error_description || '').slice(0, 1000), order_id, cust.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[logUpgradeFailure]', err.message);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/customer/subscriptions
exports.getCustomerSubscriptions = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer?.billing_customer_id) return res.json({ subscriptions: [] });
    const subscriptions = await billing.getSubscriptions(customer.billing_customer_id);
    res.json({ subscriptions });
  } catch (err) {
    console.error('[Subscriptions]', err.message);
    res.status(500).json({ error: 'Unable to load subscriptions' });
  }
};

// GET /api/customer/invoices
exports.getCustomerInvoices = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer?.billing_customer_id) return res.json({ invoices: [] });
    const invoices = await billing.getInvoices(customer.billing_customer_id);
    res.json({ invoices });
  } catch (err) {
    console.error('[Invoices]', err.message);
    res.status(500).json({ error: 'Unable to load invoices' });
  }
};

// GET /api/customer/quotes — pending only (unpaid / not cancelled)
exports.getCustomerQuotes = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer?.billing_customer_id) return res.json({ quotes: [] });
    const all = await billing.getQuotes(customer.billing_customer_id);
    const DONE_STATUSES = ['paid', 'payment', 'cancelled', 'expired', 'rejected'];
    const pending = all.filter(q => !DONE_STATUSES.includes((q.status || '').toLowerCase()));
    res.json({ quotes: pending });
  } catch (err) {
    console.error('[Quotes]', err.message);
    res.status(500).json({ error: 'Unable to load pending payments' });
  }
};

// POST /api/customer/quotes/:id/pay/initiate
exports.initiateQuotePayment = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer?.billing_customer_id) return res.status(403).json({ error: 'Forbidden' });

    if (!(await billing.isConfigured())) return res.status(503).json({ error: 'Billing service not configured' });

    // Verify the quote belongs to this customer and use the authoritative amount
    const allQuotes = await billing.getQuotes(customer.billing_customer_id);
    const quote = allQuotes.find(q => String(q.id) === String(req.params.id));
    if (!quote) return res.status(404).json({ error: 'Quote not found or not yours' });

    const amount = quote.amount;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Invalid quote amount' });

    const keyId     = await getSetting('razorpay_key_id');
    const keySecret = await getSetting('razorpay_key_secret');
    if (!keyId || !keySecret) return res.status(503).json({ error: 'Payment gateway not configured. Contact support.' });

    const rzp   = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const order = await rzp.orders.create({
      amount:   Math.round(Number(amount) * 100),
      currency: 'INR',
      receipt:  `quote_${req.params.id}_${Date.now()}`,
      notes:    { quote_id: String(req.params.id), quote_number: quote.quote_number || '' },
    });
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: keyId });
  } catch (err) {
    console.error('[Quote Pay Initiate]', err.message);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
};

// POST /api/customer/quotes/:id/pay/verify
exports.verifyQuotePayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const quoteId = req.params.id;

    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer?.billing_customer_id) return res.status(403).json({ error: 'Forbidden' });

    if (!(await billing.isConfigured())) return res.status(503).json({ error: 'Billing service not configured' });

    // Verify the quote belongs to this customer before confirming payment
    const allQuotes = await billing.getQuotes(customer.billing_customer_id);
    const quote = allQuotes.find(q => String(q.id) === String(quoteId));
    if (!quote) return res.status(404).json({ error: 'Quote not found or not yours' });

    const keySecret = await getSetting('razorpay_key_secret');
    const hmac = crypto.createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (hmac !== razorpay_signature) return res.status(400).json({ error: 'Payment verification failed' });

    // NOTE: ResellerOS is read-only (no write API), so DSP does not push the
    // "mark paid" back to billing. Reconciliation is handled on the billing
    // side / manually. When a provider exposes a write endpoint, wire it here.
    res.json({ success: true });
  } catch (err) {
    console.error('[Quote Pay Verify]', err.message);
    res.status(500).json({ error: 'Payment verification failed' });
  }
};

// GET /api/customer/invoices/:id/pdf
exports.proxyInvoicePdf = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer?.billing_customer_id) return res.status(403).json({ error: 'Not authorized' });

    if (!(await billing.isConfigured())) return res.status(503).json({ error: 'Billing service not configured' });

    const invoiceId = req.params.id;
    if (!/^\d+$/.test(invoiceId)) return res.status(400).json({ error: 'Invalid ID' });

    const invoices = await billing.getInvoices(customer.billing_customer_id);
    const ownedInvoice = invoices.find(inv => String(inv.id) === String(invoiceId));
    if (!ownedInvoice) return res.status(404).json({ error: 'Invoice not found or not yours' });

    const inline = req.query.view === '1';
    const target = await billing.pdfTarget('invoice', { ...ownedInvoice, billing_customer_id: customer.billing_customer_id });
    if (!target) return res.status(503).json({ error: 'PDF not available yet. Please contact your account manager.' });

    streamPdf(res, target, `invoice-${invoiceId}.pdf`, inline);
    return;
  } catch (err) {
    console.error('[Invoice PDF]', err.message);
    res.status(500).json({ error: 'Failed to download invoice' });
  }
};

// GET /api/customer/quotes/:id/pdf
exports.proxyQuotePdf = async (req, res) => {
  try {
    const customer = await getCustomerWithPlan(req.user.id);
    if (!customer?.billing_customer_id) return res.status(403).json({ error: 'Not authorized' });

    if (!(await billing.isConfigured())) return res.status(503).json({ error: 'Billing service not configured' });

    const quoteId = req.params.id;
    if (!/^\d+$/.test(quoteId)) return res.status(400).json({ error: 'Invalid ID' });

    const allQuotes = await billing.getQuotes(customer.billing_customer_id);
    const ownedQuote = allQuotes.find(q => String(q.id) === String(quoteId));
    if (!ownedQuote) return res.status(404).json({ error: 'Quote not found or not yours' });

    const inline = req.query.view === '1';
    const target = await billing.pdfTarget('quote', { ...ownedQuote, billing_customer_id: customer.billing_customer_id });
    if (!target) return res.status(503).json({ error: 'PDF not available yet. Please contact your account manager.' });

    streamPdf(res, target, `quotation-${quoteId}.pdf`, inline);
    return;
  } catch (err) {
    console.error('[Quote PDF]', err.message);
    res.status(500).json({ error: 'Failed to download quotation' });
  }
};

// Stream a PDF from the billing app through DSP (keeps the API key server-side).
// target = { url, headers } from billing.pdfTarget().
function streamPdf(res, target, filename, inline) {
  const parsed = new URL(target.url);
  const lib = parsed.protocol === 'https:' ? https : http;
  const proxyReq = lib.request({
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers:  target.headers,
  }, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    if (proxyRes.statusCode !== 200 || !ct.includes('pdf')) {
      proxyRes.resume();
      if (!res.headersSent) res.status(503).json({ error: 'PDF not available yet. Please contact your account manager.' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch PDF' }); });
  proxyReq.setTimeout(20000, () => { proxyReq.destroy(); if (!res.headersSent) res.status(504).json({ error: 'PDF request timed out' }); });
  proxyReq.end();
}
