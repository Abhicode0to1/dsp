// One-shot seed for the chat_canned_responses table.
// Populates a starter set of GW-product + general support snippets.
// Safe to run multiple times — UNIQUE(shortcut) means re-runs skip duplicates.
//
// Usage: node seed-chat-snippets.js
require('dotenv').config();
const mysql = require('mysql2/promise');

const snippets = [
  // ── Greetings ──────────────────────────────────────────────────────────────
  {
    name: 'Greeting — opening',
    shortcut: 'greet',
    category: 'Greeting',
    body: `Hi {{customer_name}}, thanks for reaching out to Anutech support. I'm {{agent_name}} and I'll be helping you today. How can I help?`,
  },
  {
    name: 'Greeting — returning customer',
    shortcut: 'welcome',
    category: 'Greeting',
    body: `Hi {{customer_name}}, good to hear from you again. What can I help you with today?`,
  },

  // ── Holding ────────────────────────────────────────────────────────────────
  {
    name: 'Holding — checking',
    shortcut: 'check',
    category: 'Holding',
    body: `Thanks for waiting, {{customer_name}}. Let me check on that for you — give me just a moment.`,
  },
  {
    name: 'Holding — investigating',
    shortcut: 'wait',
    category: 'Holding',
    body: `I'm looking into this on my end now. Hold tight, this should take just a couple of minutes.`,
  },
  {
    name: 'Holding — checking with team',
    shortcut: 'team',
    category: 'Holding',
    body: `I want to double-check this with my team to give you the most accurate answer. I'll be back with you shortly.`,
  },

  // ── Verification (security gates) ──────────────────────────────────────────
  {
    name: 'Verify — domain ownership',
    shortcut: 'verify-domain',
    category: 'Verification',
    body: `Before I make changes to {{domain}}, I need to verify domain ownership. Can you confirm the primary admin email address registered with Google Workspace for this domain?`,
  },
  {
    name: 'Verify — admin access',
    shortcut: 'verify-admin',
    category: 'Verification',
    body: `For security, can you confirm you have super-admin access to the Google Workspace admin console for {{domain}}? This is needed before we make any changes.`,
  },

  // ── GW Troubleshooting — Email / DNS ───────────────────────────────────────
  {
    name: 'GW — DNS propagation note',
    shortcut: 'dns',
    category: 'Troubleshooting',
    body: `DNS changes can take up to 48 hours to fully propagate worldwide, though most providers update within 1-4 hours. You can check propagation status at https://dnschecker.org by entering {{domain}}. If records show inconsistent results across servers, propagation is still in progress.`,
  },
  {
    name: 'GW — SPF / DKIM / DMARC setup',
    shortcut: 'spf',
    category: 'Troubleshooting',
    body: `For deliverability on {{domain}}, you need three DNS records configured:

1. SPF (TXT @ {{domain}}): v=spf1 include:_spf.google.com ~all
2. DKIM (TXT): Get your unique key from Admin Console → Apps → Google Workspace → Gmail → Authenticate email
3. DMARC (TXT @ _dmarc.{{domain}}): v=DMARC1; p=quarantine; rua=mailto:postmaster@{{domain}}

After publishing, allow up to 48 hours for verification.`,
  },
  {
    name: 'GW — MX records (Google Workspace)',
    shortcut: 'mx',
    category: 'Troubleshooting',
    body: `For Google Workspace mail on {{domain}}, your MX records should be:

• ASPMX.L.GOOGLE.COM (priority 1)
• ALT1.ASPMX.L.GOOGLE.COM (priority 5)
• ALT2.ASPMX.L.GOOGLE.COM (priority 5)
• ALT3.ASPMX.L.GOOGLE.COM (priority 10)
• ALT4.ASPMX.L.GOOGLE.COM (priority 10)

Remove any other MX records to avoid mail-routing conflicts.`,
  },
  {
    name: 'GW — emails going to spam (diagnosis)',
    shortcut: 'spam',
    category: 'Troubleshooting',
    body: `Emails going to spam usually means one of:
(a) missing or misconfigured SPF/DKIM/DMARC on {{domain}},
(b) the sending domain has low reputation, or
(c) message content triggers filters (links, attachments, certain keywords).

Can you share a sample message header (Gmail → ⋮ → Show original) so I can check the authentication results?`,
  },
  {
    name: 'GW — email delivery delay',
    shortcut: 'delay',
    category: 'Troubleshooting',
    body: `Mail delivery delays are usually queued at either Google's side or the receiving server. Can you share the message ID (from Gmail → Show original) so I can trace it in Email Log Search in your admin console?`,
  },

  // ── GW Troubleshooting — Users / Admin ─────────────────────────────────────
  {
    name: 'GW — add a new user',
    shortcut: 'newuser',
    category: 'Troubleshooting',
    body: `To add a new user to Google Workspace ({{domain}}):

1. Sign in to admin.google.com
2. Directory → Users → Add new user
3. Fill in name, primary email, and optionally a temporary password
4. Click Add new user

The new user can sign in immediately. They'll be prompted to change the password on first login if "Ask for a password change at the next sign-in" is enabled.`,
  },
  {
    name: 'GW — reset user password',
    shortcut: 'pwreset',
    category: 'Troubleshooting',
    body: `To reset a user's password from your admin console:

1. admin.google.com → Directory → Users
2. Click the user's name
3. "Reset password" in the right panel
4. Either generate or type a new password
5. Keep "Ask for a password change at the next sign-in" enabled

Share the new password with the user via a secure channel — they'll be prompted to change it on first login.`,
  },
  {
    name: 'GW — 2-step verification recovery',
    shortcut: '2fa',
    category: 'Troubleshooting',
    body: `For 2-step verification recovery on {{domain}}: an admin can generate backup codes or disable 2FA for the affected user from admin.google.com → Directory → Users → [user] → Security. If the affected user is a super-admin and you're locked out, recovery requires the account recovery email/phone OR a request to Google support (which I can help start).`,
  },
  {
    name: 'GW — Drive / storage quota',
    shortcut: 'storage',
    category: 'Troubleshooting',
    body: `Storage usage on {{domain}} is shared across the org or per-user depending on your plan. To check: admin.google.com → Reports → Apps reports → Account usage → Storage. To free space: have users empty Trash, remove large files in Drive, or upgrade pooled storage at admin.google.com → Billing.`,
  },
  {
    name: 'GW — Shared Drive access',
    shortcut: 'shared',
    category: 'Troubleshooting',
    body: `For Shared Drive access issues: confirm the user is a Member or Manager of the drive (Drive → Shared drives → [drive] → Manage members). External access also requires "Allow members to invite people outside {{domain}}" toggled on at admin console → Apps → Drive and Docs → Sharing settings.`,
  },
  {
    name: 'GW — Gmail / Calendar mobile sync',
    shortcut: 'mobile',
    category: 'Troubleshooting',
    body: `For Gmail/Calendar sync issues on mobile:
1. Confirm the account is signed in with the {{domain}} address
2. Check if mobile management policies are enforced at admin.google.com → Devices
3. On iOS, try removing and re-adding the account in Settings → Mail → Accounts
4. On Android, clear the Gmail app cache (Settings → Apps → Gmail → Storage → Clear cache)

Let me know which device and OS so I can give more specific steps.`,
  },
  {
    name: 'GW — Calendar invite not delivered',
    shortcut: 'calendar',
    category: 'Troubleshooting',
    body: `For Calendar invites not arriving:
1. The recipient must have a Google account OR allow event email notifications
2. Check the sender's Calendar settings → Event settings → Add invitations to my calendar: "From everyone"
3. Look at the recipient's spam folder
4. If recipient is external, your admin must allow external sharing at admin.google.com → Apps → Calendar → Sharing settings

If you share the meeting ID I can check the delivery log.`,
  },

  // ── Resolution ─────────────────────────────────────────────────────────────
  {
    name: 'Resolution — confirmed working',
    shortcut: 'resolved',
    category: 'Resolution',
    body: `Great, glad we got that sorted out, {{customer_name}}! If you run into any related issues, just open a new ticket or hop back on chat. Is there anything else I can help with?`,
  },
  {
    name: 'Resolution — workaround in place',
    shortcut: 'workaround',
    category: 'Resolution',
    body: `I've set up a workaround for now while the underlying issue gets investigated. You should be able to continue working. I'll follow up on ticket {{ticket_id}} as soon as I have a permanent fix.`,
  },

  // ── Escalation ─────────────────────────────────────────────────────────────
  {
    name: 'Escalate — to Google Workspace support',
    shortcut: 'escalate-google',
    category: 'Escalation',
    body: `This looks like an issue I'll need to escalate to Google Workspace support directly. I'll open a P-case on your behalf with the details from ticket {{ticket_id}} and keep you posted as soon as Google responds (usually within a business day for non-critical issues).`,
  },
  {
    name: 'Escalate — to senior engineer',
    shortcut: 'escalate',
    category: 'Escalation',
    body: `I want to make sure we get this right — let me bring in a senior support engineer who specialises in this area. They'll review ticket {{ticket_id}} and be in touch with you shortly. Apologies for the wait, {{customer_name}}.`,
  },

  // ── Closing ────────────────────────────────────────────────────────────────
  {
    name: 'Closing — anything else',
    shortcut: 'else',
    category: 'Closing',
    body: `Is there anything else I can help you with today, {{customer_name}}?`,
  },
  {
    name: 'Closing — thanks',
    shortcut: 'bye',
    category: 'Closing',
    body: `Thanks for reaching out to Anutech support, {{customer_name}}. Have a great rest of your day!`,
  },
  {
    name: 'Closing — will follow up',
    shortcut: 'followup',
    category: 'Closing',
    body: `I'll follow up on ticket {{ticket_id}} as soon as I have an update. You'll get an email from me — feel free to reply to it or come back to chat anytime if anything changes on your end.`,
  },
];

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    const [[admin]] = await pool.query("SELECT id, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
    const createdBy = admin?.id || null;
    console.log(`Seeding ${snippets.length} chat snippets (created_by = ${createdBy || 'NULL'} · ${admin?.email || 'no admin user found'}).`);

    let added = 0, skipped = 0, failed = 0;
    for (const s of snippets) {
      try {
        await pool.query(
          'INSERT INTO chat_canned_responses (name, shortcut, category, body, created_by) VALUES (?, ?, ?, ?, ?)',
          [s.name, s.shortcut, s.category, s.body, createdBy]
        );
        added++;
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') { skipped++; continue; }
        console.error(`  ! Failed [${s.shortcut}]:`, err.message);
        failed++;
      }
    }
    console.log(`\n  ✓ Added:   ${added}`);
    console.log(`  ⊖ Skipped: ${skipped}  (already in DB)`);
    if (failed) console.log(`  ✗ Failed:  ${failed}`);
    const [[count]] = await pool.query('SELECT COUNT(*) AS c FROM chat_canned_responses');
    console.log(`\nTotal snippets now in DB: ${count.c}`);
  } finally {
    await pool.end();
  }
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
