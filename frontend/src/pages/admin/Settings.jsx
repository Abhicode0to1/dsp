import { useEffect, useState } from 'react';
import Layout from '../../components/common/Layout';
import { getAdminSettings, updateAdminSettings, triggerBillingSync, testBillingConnection, sendTestEmail } from '../../services/api';
import { Settings, Save, RefreshCw, Link, Eye, EyeOff, Copy, Check, RefreshCcw, CreditCard, Clock, Mail, Send, Shield, Palette, Wrench, Power, AlertTriangle, MessageSquare, Phone, Sparkles } from 'lucide-react';
import TwoFactorPanel from '../../components/admin/TwoFactorPanel';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`,
}));

const DAY_OPTIONS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function generateSecret() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Mirrors backend TEMPLATE_REGISTRY in utils/emailUtils.js. Kept hardcoded
// (instead of fetched) because (a) it's tiny, (b) it's stable, (c) loads
// instantly without an extra HTTP round-trip on Settings page open.
const TEST_EMAIL_TEMPLATES = [
  { value: 'generic',                 label: 'Generic SMTP test (no template)' },
  { group: 'Customer · Account' },
  { value: 'welcome_setup_link',      label: 'Welcome — set-up link' },
  { value: 'account_ready',           label: 'Account Ready — with password' },
  { value: 'otp_login',               label: 'Login OTP' },
  { value: 'usage_reset',             label: 'Monthly Usage Reset' },
  { group: 'Customer · Ticket' },
  { value: 'ticket_created',          label: 'Ticket Created' },
  { value: 'agent_reply',             label: 'Agent Replied on Ticket' },
  { value: 'rating_request',          label: 'CSAT Rating Request' },
  { value: 'cc_added_to_ticket',      label: 'You\'ve been added as CC' },
  { group: 'Customer · Chat & Call' },
  { value: 'chat_transcript',         label: 'Chat Transcript' },
  { value: 'call_missed',             label: 'Missed Call Notification' },
  { group: 'Customer · Billing' },
  { value: 'plan_upgraded_customer',      label: 'Plan Upgraded — receipt' },
  { value: 'plan_expired_lapsed_to_free', label: 'Plan Expired — moved to Free' },
  { group: 'Agent' },
  { value: 'agent_welcome',           label: 'Agent Account Created' },
  { value: 'customer_reply_to_agent', label: 'Customer Replied to Ticket' },
  { group: 'Admin' },
  { value: 'sla_breach_admin',          label: 'SLA Breach Alert' },
  { value: 'plan_upgraded_admin',       label: 'New Plan Upgrade (revenue alert)' },
  { value: 'billing_sync_failed_admin', label: 'Billing Sync Failed (reconcile alert)' },
  { value: 'plan_lapsed_admin',         label: 'Daily Lapsed-to-Free Digest' },
];

export default function AdminSettings() {
  const [settings, setSettings] = useState({
    auto_close_days: '14',
    work_hours_start: '10',
    work_hours_end: '18',
    work_hours_days: '1,2,3,4,5,6',
    billing_provider: 'reselleros',
    billing_auth_style: 'bearer',
    billing_api_url: '',
    billing_api_key: '',
    billing_webhook_secret: '',
    billing_last_sync: '',
    razorpay_key_id: '',
    razorpay_key_secret: '',
    // Routing
    assignment_mode: 'least_loaded',
    heavy_load_threshold: '8',
    heavy_load_chat_threshold: '3',
    heavy_load_call_threshold: '1',
    block_outside_work_hours: '0',
    // Flips the Subscriptions / Paid Invoices / Pending Payments tabs on the
    // customer Billing page out of "Coming soon" stub state. Default OFF.
    billing_extras_enabled: '0',
    // Calls shorter than this (in seconds, agent-connected time) don't count
    // toward the customer's monthly call_limit. Default 30s.
    min_billable_call_seconds: '30',
    // Cap on how many short-cut calls a single customer can have forgiven per
    // month. After this many, additional short calls START counting. Default 3.
    max_short_cut_forgivals_per_month: '3',
    // ── SLA & Queue alerts
    queue_sla_minutes: '5',
    ticket_warning_pct: '80',
    ticket_breach_action: 'notify_admin',
    // ── SMTP server config (overrides env vars when set)
    smtp_host: '',
    smtp_port: '587',
    smtp_user: '',
    smtp_password: '',
    smtp_from: '',
    smtp_secure: '0',
    // ── Runtime API credentials (override env; read live, no restart)
    cloudflare_turn_key_id: '',
    cloudflare_turn_api_token: '',
    anthropic_api_key: '',
    // ── Inbound email (IMAP poller for customer replies → tickets)
    inbound_enabled: '0',
    imap_host: '',
    imap_port: '993',
    imap_user: '',
    imap_password: '',
    imap_secure: '1',
    imap_mailbox: 'INBOX',
    support_email_address: '',
    // ── Email defaults
    reply_to_email: '',
    bcc_email: '',
    emails_disabled: '0',
    // ── Customer experience
    csat_after_chat: '1',
    csat_after_ticket: '1',
    allow_chat_attachments: '1',
    chat_attachment_max_mb: '10',
    chat_attachment_types: 'jpg,png,gif,pdf,doc,docx,txt,zip',
    ticket_created_email_enabled: '1',
    // ── Security
    admin_idle_timeout_minutes: '30',
    require_admin_2fa: '0',
    admin_ip_allowlist: '',
    agent_ip_allowlist: '',
    password_min_length: '8',
    password_require_digit: '0',
    password_require_symbol: '0',
    // ── Branding
    brand_sender_name: '',
    brand_footer_text: '',
    brand_color: '',
    // ── Operations
    maintenance_mode: '0',
    maintenance_message: '',
    audit_retention_days: '180',
    // ── Channel kill switches
    bot_widget_enabled: '1',
    calls_system_enabled: '1',
    screen_share_enabled: '0',
    whatsapp_enabled: '0',
    // ── Renewal & expiry (Phase 4)
    renewal_window_days: '30',
    auto_lapse_to_free: '1',
  });
  const [testEmailRecipient, setTestEmailRecipient] = useState('');
  const [testEmailTemplate, setTestEmailTemplate]   = useState('generic');
  const [sendingTest, setSendingTest] = useState(false);
  const [showSmtpPw, setShowSmtpPw] = useState(false);
  const [showTurnTok, setShowTurnTok] = useState(false);
  const [showAiKey, setShowAiKey] = useState(false);
  const [showImapPw, setShowImapPw] = useState(false);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [showApiKey, setShowApiKey]   = useState(false);
  const [showRzpSecret, setShowRzpSecret] = useState(false);
  const [copied, setCopied]           = useState(false);
  const [syncing, setSyncing]         = useState(false);
  const [testing, setTesting]         = useState(false);
  const [testResult, setTestResult]   = useState(null); // { ok, message }
  const [testCustomerId, setTestCustomerId] = useState('');

  const load = () => {
    setLoading(true);
    getAdminSettings()
      .then(r => setSettings(prev => ({ ...prev, ...r.data.settings })))
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useGlobalRefresh(load);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateAdminSettings({ settings });
      toast.success('Settings saved');
    } catch {
      toast.error('Failed to save settings');
    } finally { setSaving(false); }
  };

  const handleGenerateSecret = () => {
    const secret = generateSecret();
    setSettings(s => ({ ...s, billing_webhook_secret: secret }));
  };

  const handleCopySecret = () => {
    navigator.clipboard.writeText(settings.billing_webhook_secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleTestEmail = async () => {
    if (!testEmailRecipient.trim()) { toast.error('Enter a recipient email first'); return; }
    setSendingTest(true);
    try {
      const r = await sendTestEmail(testEmailRecipient.trim(), testEmailTemplate);
      if (r.data.skipped) {
        toast(r.data.message || 'Email was suppressed', { icon: '⚠️', duration: 6000 });
      } else {
        toast.success(r.data.message || 'Test email sent');
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Test email failed — check SMTP config');
    } finally { setSendingTest(false); }
  };

  const handleTestBilling = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Test the values currently in the form (may be unsaved).
      const r = await testBillingConnection({
        url:         settings.billing_api_url,
        key:         settings.billing_api_key,
        provider:    settings.billing_provider,
        auth_style:  settings.billing_auth_style,
        customer_id: testCustomerId.trim() || undefined,
      });
      setTestResult(r.data);
      if (r.data.ok) toast.success('Billing connection OK');
      else toast.error('Billing connection failed');
    } catch (err) {
      const msg = err.response?.data?.message || 'Test request failed';
      setTestResult({ ok: false, message: msg });
      toast.error(msg);
    } finally { setTesting(false); }
  };

  const handleSyncNow = async () => {
    if (!settings.billing_api_url) {
      toast.error('Enter your billing app URL first and save settings');
      return;
    }
    setSyncing(true);
    try {
      const res = await triggerBillingSync();
      const { synced, created, updated, errors } = res.data;
      toast.success(`Sync complete: ${created} created, ${updated} updated${errors ? `, ${errors} errors` : ''}`);
      load(); // refresh last sync time
    } catch (err) {
      toast.error(err.response?.data?.error || 'Sync failed — check API URL and key');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Settings</h1>
          <p className="text-sm text-gray-500 mt-0.5">Configure system-wide behavior</p>
        </div>
        <button onClick={load} className="hidden lg:inline-flex btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <form onSubmit={save} className="max-w-xl space-y-6">
          {/* Auto-close */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-4">
              <Settings className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-bold text-gray-700">Ticket Automation</h2>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Auto-close stale tickets after (days)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min="1"
                  max="365"
                  className="input w-32"
                  value={settings.auto_close_days}
                  onChange={e => setSettings(s => ({ ...s, auto_close_days: e.target.value }))}
                />
                <p className="text-xs text-gray-400">
                  Tickets with no activity for this many days will be automatically closed at midnight.
                </p>
              </div>
            </div>
          </div>

          {/* Customer Billing tabs */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-bold text-gray-700">Customer Billing Page</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              The Subscriptions / Paid Invoices / Pending Payments tabs depend on billing-app integrations. Keep them faded ("Coming soon") until those flows are wired up.
            </p>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.billing_extras_enabled === '1' || settings.billing_extras_enabled === 1 || settings.billing_extras_enabled === true}
                onChange={e => setSettings(s => ({ ...s, billing_extras_enabled: e.target.checked ? '1' : '0' }))}
                className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer"
              />
              <div>
                <p className="text-sm font-medium text-gray-700">Show Subscriptions / Paid Invoices / Pending Payments tabs</p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  When OFF (default), customers see those tabs faded with a "Coming soon" tooltip and clicks show a toast. Toggle ON to make them live.
                </p>
              </div>
            </label>
          </div>

          {/* Call Billing — minimum-duration gate + monthly forgivals cap */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Settings className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-bold text-gray-700">Call Billing</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Protects customers from agent spam-cuts AND closes the customer-side abuse vector. Short calls (under the threshold) don't count against the monthly call_limit — but only up to a cap per customer per month.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Minimum billable call duration (seconds)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="0"
                    max="600"
                    className="input w-32"
                    value={settings.min_billable_call_seconds}
                    onChange={e => setSettings(s => ({ ...s, min_billable_call_seconds: e.target.value }))}
                  />
                  <p className="text-xs text-gray-400">
                    Default 30s (telecom industry standard). Calls shorter than this are recorded but not charged. Set 0 to count every accepted call.
                  </p>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Max short-call forgivals per customer per month
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min="0"
                    max="999"
                    className="input w-32"
                    value={settings.max_short_cut_forgivals_per_month}
                    onChange={e => setSettings(s => ({ ...s, max_short_cut_forgivals_per_month: e.target.value }))}
                  />
                  <p className="text-xs text-gray-400">
                    Default 3. After this many short calls, additional ones START counting against the customer's quota — prevents abuse via repeated sub-threshold calls. Set 0 to forgive nothing, 999 to effectively disable the cap.
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* SLA & Queue Alerts */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <h2 className="text-sm font-bold text-gray-700">SLA & Queue Alerts</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              When the system warns agents about approaching deadlines + what happens when an SLA is breached.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="label">Chat queue alarm (mins)</label>
                <input type="number" min={1} max={120} className="input w-full"
                  value={settings.queue_sla_minutes}
                  onChange={e => setSettings(s => ({ ...s, queue_sla_minutes: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">Warn admin when a customer has been waiting longer than this.</p>
              </div>
              <div>
                <label className="label">Warning threshold (%)</label>
                <input type="number" min={1} max={99} className="input w-full"
                  value={settings.ticket_warning_pct}
                  onChange={e => setSettings(s => ({ ...s, ticket_warning_pct: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">Warn assigned agent when this much of the SLA window has elapsed. Default 80%.</p>
              </div>
              <div>
                <label className="label">On SLA breach</label>
                <select className="input w-full" value={settings.ticket_breach_action}
                  onChange={e => setSettings(s => ({ ...s, ticket_breach_action: e.target.value }))}>
                  <option value="notify_admin">Email admin (daily digest)</option>
                  <option value="escalate">Auto-escalate priority</option>
                  <option value="both">Both (escalate + email)</option>
                  <option value="none">Mark breached only (silent)</option>
                </select>
                <p className="text-[11px] text-gray-400 mt-1">What the system does when a ticket misses its SLA.</p>
              </div>
            </div>
          </div>

          {/* SMTP Configuration — outgoing email server */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Mail className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">SMTP Configuration</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Outgoing-email server. Leave blank to fall back to the values in your <code className="bg-gray-100 px-1 rounded text-[10px]">.env</code> file. After saving, click <strong>Send Test Email</strong> below to verify the connection.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="label">Sender (From: address)</label>
                <input type="text" className="input w-full"
                  placeholder='e.g. "Anutech Support" <support@yourdomain.com>'
                  value={settings.smtp_from}
                  onChange={e => setSettings(s => ({ ...s, smtp_from: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">What customers see in their inbox. Display name + email in angle brackets.</p>
              </div>
              <div>
                <label className="label">SMTP host</label>
                <input type="text" className="input w-full"
                  placeholder="smtp.gmail.com / smtp.office365.com / smtp.sendgrid.net"
                  value={settings.smtp_host}
                  onChange={e => setSettings(s => ({ ...s, smtp_host: e.target.value }))} />
              </div>
              <div>
                <label className="label">SMTP port</label>
                <input type="number" min={1} max={65535} className="input w-full"
                  placeholder="587"
                  value={settings.smtp_port}
                  onChange={e => setSettings(s => ({ ...s, smtp_port: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">587 for STARTTLS (most common), 465 for implicit TLS.</p>
              </div>
              <div>
                <label className="label">SMTP username</label>
                <input type="text" className="input w-full" autoComplete="off"
                  placeholder="usually the sender email"
                  value={settings.smtp_user}
                  onChange={e => setSettings(s => ({ ...s, smtp_user: e.target.value }))} />
              </div>
              <div>
                <label className="label">SMTP password / app password</label>
                <div className="relative">
                  <input type={showSmtpPw ? 'text' : 'password'} className="input w-full pr-10" autoComplete="new-password"
                    placeholder="••••••••••••"
                    value={settings.smtp_password}
                    onChange={e => setSettings(s => ({ ...s, smtp_password: e.target.value }))} />
                  <button type="button" onClick={() => setShowSmtpPw(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                    {showSmtpPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">For Gmail / Google Workspace, generate an "App password" at myaccount.google.com → Security → 2-Step Verification → App passwords.</p>
              </div>
            </div>
            <label className="flex items-start gap-3 cursor-pointer mt-3 pt-3 border-t border-gray-100">
              <input type="checkbox"
                checked={settings.smtp_secure === '1'}
                onChange={e => setSettings(s => ({ ...s, smtp_secure: e.target.checked ? '1' : '0' }))}
                className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
              <div>
                <p className="text-sm font-medium text-gray-700">Use implicit TLS (port 465)</p>
                <p className="text-[11px] text-gray-400">Leave unchecked for STARTTLS on port 587. Some legacy hosts require this.</p>
              </div>
            </label>
            <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
              ⚠ Passwords entered here are stored in the database. Make sure your DB is properly secured. After saving, the test email below uses the new values immediately — no restart needed.
            </div>
          </div>

          {/* Cloudflare TURN — voice/video calls relay */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Phone className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Cloudflare TURN (Calls)</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Relay credentials for voice/video calls. Leave blank to fall back to the values in your <code>.env</code>. Get them from Cloudflare → Realtime → TURN. Applied live — no restart.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">TURN Key ID</label>
                <input type="text" className="input w-full" placeholder="e.g. 8eac…" autoComplete="off"
                  value={settings.cloudflare_turn_key_id}
                  onChange={e => setSettings(s => ({ ...s, cloudflare_turn_key_id: e.target.value }))} />
              </div>
              <div>
                <label className="label">TURN API Token</label>
                <div className="relative">
                  <input type={showTurnTok ? 'text' : 'password'} className="input w-full pr-10" autoComplete="new-password"
                    value={settings.cloudflare_turn_api_token}
                    onChange={e => setSettings(s => ({ ...s, cloudflare_turn_api_token: e.target.value }))} />
                  <button type="button" onClick={() => setShowTurnTok(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                    {showTurnTok ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
            <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
              ⚠ Stored in the database. If left blank, calls use the free public STUN/TURN fallback (less reliable at scale).
            </div>
          </div>

          {/* Anthropic — AI bot / KB assistant */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Anthropic (AI Assistant)</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Claude API key powering the AI bot + knowledge-base search. Leave blank to fall back to <code>.env</code>. Get a key at console.anthropic.com. Applied live — no restart.
            </p>
            <div>
              <label className="label">Anthropic API key</label>
              <div className="relative">
                <input type={showAiKey ? 'text' : 'password'} className="input w-full pr-10" autoComplete="new-password" placeholder="sk-ant-…"
                  value={settings.anthropic_api_key}
                  onChange={e => setSettings(s => ({ ...s, anthropic_api_key: e.target.value }))} />
                <button type="button" onClick={() => setShowAiKey(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                  {showAiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
              ⚠ Stored in the database. If left blank, the AI bot / KB search is disabled until a key is set.
            </div>
          </div>

          {/* Email Defaults */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Mail className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Email Defaults</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Customise outgoing emails and verify your SMTP wiring without triggering a real customer flow.
            </p>
            <div className="space-y-4">
              <div>
                <label className="label">Reply-To address</label>
                <input type="email" className="input w-full" placeholder="support@yourdomain.com"
                  value={settings.reply_to_email}
                  onChange={e => setSettings(s => ({ ...s, reply_to_email: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">When customers reply to system emails, replies go here. Leave blank to use the From address.</p>
              </div>
              <div>
                <label className="label">BCC (compliance archive)</label>
                <input type="email" className="input w-full" placeholder="archive@yourdomain.com (optional)"
                  value={settings.bcc_email}
                  onChange={e => setSettings(s => ({ ...s, bcc_email: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">Silently CC every outgoing customer email to this address. Useful for compliance / audit logs.</p>
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox"
                  checked={settings.emails_disabled === '1'}
                  onChange={e => setSettings(s => ({ ...s, emails_disabled: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-red-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Disable all outgoing emails (kill switch)</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">Use during maintenance or if you suspect a misconfiguration is about to spam customers. In-app notifications still work.</p>
                </div>
              </label>
              <div className="pt-3 border-t border-gray-100">
                <label className="label">Send a test email</label>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr,1fr,auto] gap-2">
                  <input type="email" className="input" placeholder="you@example.com"
                    value={testEmailRecipient}
                    onChange={e => setTestEmailRecipient(e.target.value)} />
                  <select className="input"
                    value={testEmailTemplate}
                    onChange={e => setTestEmailTemplate(e.target.value)}>
                    {TEST_EMAIL_TEMPLATES.map((t, i) =>
                      t.group ? (
                        <optgroup key={`g-${i}`} label={t.group} />
                      ) : (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      )
                    )}
                  </select>
                  <button type="button" onClick={handleTestEmail} disabled={sendingTest}
                    className="btn-primary inline-flex items-center gap-1.5 whitespace-nowrap">
                    <Send className="w-3.5 h-3.5" /> {sendingTest ? 'Sending…' : 'Send Test'}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  {testEmailTemplate === 'generic'
                    ? 'Plain SMTP smoke test — verifies host, port, credentials, reply-to, BCC, sender name.'
                    : <>Renders the <strong>{TEST_EMAIL_TEMPLATES.find(t => t.value === testEmailTemplate)?.label}</strong> template with clearly-fake sample data (Sarah Chen / ticket #1247 / fake setup token / etc.) so you can audit how the real email looks.</>
                  }
                </p>
              </div>
            </div>
          </div>

          {/* Inbound Email — IMAP poller for customer replies → ticket messages */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Mail className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Inbound Email (customer replies → tickets)</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Point the poller at the mailbox that <strong>receives replies to system emails</strong> — typically the same address you send from (e.g. <code className="bg-gray-100 px-1 rounded text-[10px]">noreply@yourdomain.com</code>). The poller polls every 60 seconds, parses new replies, and routes them to the right ticket. Review what gets ingested in <strong>System Health → Inbound Mail</strong>.
            </p>
            <div className="mb-4 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-200 text-[11px] text-indigo-900">
              <strong>⚠ Don't point this at your publicly-advertised support address.</strong> The publicly-advertised <code>support@</code> mailbox is for human-handled general queries — keep it as a regular Gmail inbox that an agent checks manually. The poller below is for the automated reply loop only.
            </div>
            <label className="flex items-start gap-3 cursor-pointer mb-4">
              <input type="checkbox" checked={settings.inbound_enabled === '1'}
                onChange={e => setSettings(s => ({ ...s, inbound_enabled: e.target.checked ? '1' : '0' }))}
                className="mt-0.5 w-4 h-4 accent-emerald-600 cursor-pointer" />
              <div>
                <p className="text-sm font-medium text-gray-700">Enable inbound email ingestion</p>
                <p className="text-[11px] text-gray-400">When ON, the IMAP poller starts within ~60s. Off (default) = manual inbox review only.</p>
              </div>
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="label">Public-facing support address <span className="text-gray-400 font-normal">(optional)</span></label>
                <input type="email" className="input w-full"
                  placeholder="support@anutech.in"
                  value={settings.support_email_address}
                  onChange={e => setSettings(s => ({ ...s, support_email_address: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">
                  Your human-monitored mailbox (the one you'd put on your website). When a non-customer accidentally emails the inbound mailbox below, their message is auto-forwarded here for a human to triage. Leave blank if you don't have a separate support inbox set up yet.
                </p>
              </div>
              <div>
                <label className="label">IMAP host</label>
                <input type="text" className="input w-full"
                  placeholder="imap.gmail.com"
                  value={settings.imap_host}
                  onChange={e => setSettings(s => ({ ...s, imap_host: e.target.value }))} />
              </div>
              <div>
                <label className="label">IMAP port</label>
                <input type="number" min={1} max={65535} className="input w-full"
                  placeholder="993"
                  value={settings.imap_port}
                  onChange={e => setSettings(s => ({ ...s, imap_port: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">993 (TLS, recommended) or 143 (STARTTLS).</p>
              </div>
              <div>
                <label className="label">IMAP username (the mailbox to poll)</label>
                <input type="text" className="input w-full" autoComplete="off"
                  placeholder="noreply@anutech.in"
                  value={settings.imap_user}
                  onChange={e => setSettings(s => ({ ...s, imap_user: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">Usually the same address you send from. NOT your public support address.</p>
              </div>
              <div>
                <label className="label">IMAP password / app password</label>
                <div className="relative">
                  <input type={showImapPw ? 'text' : 'password'} className="input w-full pr-10" autoComplete="new-password"
                    placeholder="••••••••••••"
                    value={settings.imap_password}
                    onChange={e => setSettings(s => ({ ...s, imap_password: e.target.value }))} />
                  <button type="button" onClick={() => setShowImapPw(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700">
                    {showImapPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400 mt-1">For Gmail / Workspace, use an App Password (the same kind as your SMTP one).</p>
              </div>
              <div>
                <label className="label">Mailbox to poll</label>
                <input type="text" className="input w-full"
                  placeholder="INBOX"
                  value={settings.imap_mailbox}
                  onChange={e => setSettings(s => ({ ...s, imap_mailbox: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">Almost always <code>INBOX</code>. Override only if you've set up a Gmail filter routing replies to a sub-label.</p>
              </div>
              <div>
                <label className="flex items-center gap-2 mt-7 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={settings.imap_secure === '1'}
                    onChange={e => setSettings(s => ({ ...s, imap_secure: e.target.checked ? '1' : '0' }))}
                    className="w-4 h-4 accent-indigo-600" />
                  Use implicit TLS (port 993)
                </label>
              </div>
            </div>
            <div className="mt-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800">
              ⚠ The poller only ingests email from existing customers / CC participants. Unknown senders get a soft auto-reply (throttled to once per 7 days per address) AND — if you've set a Public-facing support address above — their original message is forwarded there so a human can decide.
            </div>
          </div>

          {/* Customer Experience */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <MessageSquare className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Customer Experience</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">Toggles for survey timing, attachments, and email noise.</p>
            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={settings.csat_after_chat === '1'}
                  onChange={e => setSettings(s => ({ ...s, csat_after_chat: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Show CSAT rating after a chat ends</p>
                  <p className="text-[11px] text-gray-400">Customer is asked to rate the agent immediately after the chat closes.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={settings.csat_after_ticket === '1'}
                  onChange={e => setSettings(s => ({ ...s, csat_after_ticket: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Email CSAT survey when a ticket closes</p>
                  <p className="text-[11px] text-gray-400">Sends the survey link via email a few minutes after ticket close.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={settings.ticket_created_email_enabled === '1'}
                  onChange={e => setSettings(s => ({ ...s, ticket_created_email_enabled: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Send confirmation email when a ticket is created</p>
                  <p className="text-[11px] text-gray-400">Off = ticket appears in customer portal only, no email noise.</p>
                </div>
              </label>
              <div className="pt-3 border-t border-gray-100">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input type="checkbox" checked={settings.allow_chat_attachments === '1'}
                    onChange={e => setSettings(s => ({ ...s, allow_chat_attachments: e.target.checked ? '1' : '0' }))}
                    className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                  <div>
                    <p className="text-sm font-medium text-gray-700">Allow file attachments in live chat</p>
                    <p className="text-[11px] text-gray-400">Off = paperclip icon hidden for customers + agents.</p>
                  </div>
                </label>
                {settings.allow_chat_attachments === '1' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 ml-7">
                    <div>
                      <label className="label">Max attachment size (MB)</label>
                      <input type="number" min={1} max={100} className="input w-full"
                        value={settings.chat_attachment_max_mb}
                        onChange={e => setSettings(s => ({ ...s, chat_attachment_max_mb: e.target.value }))} />
                    </div>
                    <div>
                      <label className="label">Allowed file types</label>
                      <input type="text" className="input w-full" placeholder="jpg,png,pdf,doc,docx"
                        value={settings.chat_attachment_types}
                        onChange={e => setSettings(s => ({ ...s, chat_attachment_types: e.target.value }))} />
                      <p className="text-[11px] text-gray-400 mt-1">Comma-separated extensions (no dots).</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Security & Access */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Shield className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Security & Access</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Admin session controls, 2FA, IP allowlist, and password rules. <span className="text-gray-500">Password rules are saved but not yet enforced on signup forms — placeholder for now.</span>
            </p>
            <div className="mb-4">
              <TwoFactorPanel />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Admin idle auto-logout (mins)</label>
                <input type="number" min={5} max={1440} className="input w-full"
                  value={settings.admin_idle_timeout_minutes}
                  onChange={e => setSettings(s => ({ ...s, admin_idle_timeout_minutes: e.target.value }))} />
              </div>
              <div>
                <label className="label">Minimum password length</label>
                <input type="number" min={6} max={32} className="input w-full"
                  value={settings.password_min_length}
                  onChange={e => setSettings(s => ({ ...s, password_min_length: e.target.value }))} />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={settings.password_require_digit === '1'}
                  onChange={e => setSettings(s => ({ ...s, password_require_digit: e.target.checked ? '1' : '0' }))}
                  className="w-4 h-4 accent-indigo-600" />
                Require digit
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={settings.password_require_symbol === '1'}
                  onChange={e => setSettings(s => ({ ...s, password_require_symbol: e.target.checked ? '1' : '0' }))}
                  className="w-4 h-4 accent-indigo-600" />
                Require symbol
              </label>
            </div>
            <label className="flex items-start gap-3 cursor-pointer mt-4 pt-3 border-t border-gray-100">
              <input type="checkbox" checked={settings.require_admin_2fa === '1'}
                onChange={e => setSettings(s => ({ ...s, require_admin_2fa: e.target.checked ? '1' : '0' }))}
                className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
              <div>
                <p className="text-sm font-medium text-gray-700">Require 2-factor authentication for all admin accounts</p>
                <p className="text-[11px] text-gray-400">When ON, admins who haven't enrolled are prompted at next sign-in. Active admins are NOT immediately logged out — they're given a grace period to enrol.</p>
              </div>
            </label>
            <div className="mt-3">
              <label className="label">Admin IP allowlist</label>
              <input type="text" className="input w-full" placeholder="e.g. 203.0.113.0/24, 198.51.100.1 (empty = allow all)"
                value={settings.admin_ip_allowlist}
                onChange={e => setSettings(s => ({ ...s, admin_ip_allowlist: e.target.value }))} />
              <p className="text-[11px] text-gray-400 mt-1">Comma-separated IPv4 addresses and/or CIDR ranges. Gates <strong>admin</strong> logins only. Empty = allow all.</p>
            </div>
            <div className="mt-3">
              <label className="label">Agent IP allowlist</label>
              <input type="text" className="input w-full" placeholder="e.g. 203.0.113.0/24, 198.51.100.1 (empty = allow all)"
                value={settings.agent_ip_allowlist}
                onChange={e => setSettings(s => ({ ...s, agent_ip_allowlist: e.target.value }))} />
              <p className="text-[11px] text-gray-400 mt-1">Comma-separated IPv4 addresses and/or CIDR ranges. Gates <strong>agent</strong> logins only. Customer logins are never restricted. Empty = allow all.</p>
            </div>
          </div>

          {/* Branding */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Palette className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Branding</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">Customise outgoing emails + customer portal for white-labelling.</p>
            <div className="space-y-4">
              <div>
                <label className="label">Sender name on outgoing emails</label>
                <input type="text" className="input w-full" placeholder="e.g. Anutech Support"
                  value={settings.brand_sender_name}
                  onChange={e => setSettings(s => ({ ...s, brand_sender_name: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">"From" name customers see. Sender address stays the same (constrained by SMTP).</p>
              </div>
              <div>
                <label className="label">Customer panel footer text</label>
                <input type="text" className="input w-full" placeholder="© Your Company 2026"
                  value={settings.brand_footer_text}
                  onChange={e => setSettings(s => ({ ...s, brand_footer_text: e.target.value }))} />
              </div>
              <div>
                <label className="label">Brand accent color</label>
                <div className="flex items-center gap-2">
                  <input type="color" className="w-12 h-9 rounded border border-gray-200 cursor-pointer"
                    value={settings.brand_color || '#4f46e5'}
                    onChange={e => setSettings(s => ({ ...s, brand_color: e.target.value }))} />
                  <input type="text" className="input flex-1" placeholder="#4f46e5"
                    value={settings.brand_color}
                    onChange={e => setSettings(s => ({ ...s, brand_color: e.target.value }))} />
                </div>
              </div>
            </div>
          </div>

          {/* Operations */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Wrench className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Operations & Maintenance</h2>
            </div>
            <div className="space-y-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={settings.maintenance_mode === '1'}
                  onChange={e => setSettings(s => ({ ...s, maintenance_mode: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-red-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Maintenance mode (customer portal disabled)</p>
                  <p className="text-[11px] text-gray-400">Customer endpoints return 503; admin + agent panels stay working. Use during planned outages.</p>
                </div>
              </label>
              {settings.maintenance_mode === '1' && (
                <div className="ml-7">
                  <label className="label">Message shown to customers</label>
                  <textarea className="input w-full" rows={2} placeholder="We're doing scheduled maintenance, back online at 6 PM IST."
                    value={settings.maintenance_message}
                    onChange={e => setSettings(s => ({ ...s, maintenance_message: e.target.value }))} />
                </div>
              )}
              <div className="pt-3 border-t border-gray-100">
                <label className="label">Audit log retention (days)</label>
                <input type="number" min={30} max={3650} className="input w-32"
                  value={settings.audit_retention_days}
                  onChange={e => setSettings(s => ({ ...s, audit_retention_days: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">Entries older than this are auto-pruned overnight. Default 180.</p>
              </div>
            </div>
          </div>

          {/* Renewal & Expiry (Phase 4) */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Renewal & Expiry</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              When customers see renewal/downgrade options and what happens when a paid plan expires without renewal.
            </p>
            <div className="space-y-3">
              <div>
                <label className="label">Renewal window (days before expiry)</label>
                <input type="number" min={1} max={180} className="input w-32"
                  value={settings.renewal_window_days}
                  onChange={e => setSettings(s => ({ ...s, renewal_window_days: e.target.value }))} />
                <p className="text-[11px] text-gray-400 mt-1">
                  Customers see Renew / Downgrade / Upgrade options on their Billing page during the last N days of their plan. Outside the window only upgrades are visible. Default 30.
                </p>
              </div>
              <label className="flex items-start gap-3 cursor-pointer pt-2 border-t border-gray-100">
                <input type="checkbox" checked={settings.auto_lapse_to_free === '1'}
                  onChange={e => setSettings(s => ({ ...s, auto_lapse_to_free: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Auto-lapse expired customers to Free</p>
                  <p className="text-[11px] text-gray-400">
                    A daily cron at 1am IST moves customers whose plan expired without renewal to the Free plan + emails them. When OFF, expired plans stay assigned (revenue leak) — only use this for emergencies.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Channel Kill Switches */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Power className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Channel Kill Switches</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">System-wide on/off for entire channels — useful during an outage. Per-plan toggles still apply on top.</p>
            <div className="space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={settings.bot_widget_enabled === '1'}
                  onChange={e => setSettings(s => ({ ...s, bot_widget_enabled: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Show in-app AI bot to customers</p>
                  <p className="text-[11px] text-gray-400">Off = hide the bot widget across the customer panel.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={settings.calls_system_enabled === '1'}
                  onChange={e => setSettings(s => ({ ...s, calls_system_enabled: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Allow voice calls system-wide</p>
                  <p className="text-[11px] text-gray-400">Off = block all new call attempts (e.g. during a WebRTC outage). Existing active calls finish normally.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={settings.screen_share_enabled === '1'}
                  onChange={e => setSettings(s => ({ ...s, screen_share_enabled: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Allow agents to request customer screen view</p>
                  <p className="text-[11px] text-gray-400">Off = hides the "Request screen view" button in live chat. View-only; the customer must approve each time.</p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer opacity-70">
                <input type="checkbox" checked={settings.whatsapp_enabled === '1'}
                  onChange={e => setSettings(s => ({ ...s, whatsapp_enabled: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5 w-4 h-4 accent-indigo-600 cursor-pointer" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Enable WhatsApp channel <span className="text-[10px] text-amber-700 uppercase font-bold ml-1">placeholder</span></p>
                  <p className="text-[11px] text-gray-400">Reserved for the WhatsApp integration — saved but not yet wired.</p>
                </div>
              </label>
            </div>
          </div>

          {/* Assignment Routing */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Settings className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Assignment Routing</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              How tickets, chats, and calls are distributed among agents. Changes apply within ~60 seconds.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="label">Assignment mode</label>
                <select
                  value={settings.assignment_mode}
                  onChange={e => setSettings(s => ({ ...s, assignment_mode: e.target.value }))}
                  className="input w-full"
                >
                  <option value="least_loaded">Least-loaded (fair load)</option>
                  <option value="round_robin">Round-robin (rotate evenly)</option>
                </select>
                <p className="text-[11px] text-gray-400 mt-1">
                  Least-loaded picks the agent with fewest open tickets+chats. Round-robin rotates regardless of load.
                </p>
              </div>
              <div>
                <label className="label">Heavy-load threshold (tickets)</label>
                <input
                  type="number"
                  min={1}
                  value={settings.heavy_load_threshold}
                  onChange={e => setSettings(s => ({ ...s, heavy_load_threshold: e.target.value }))}
                  className="input w-full"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Auto-routing skips agents who already have ≥ this many open tickets + active chats. Falls through to the least-loaded agent if everyone is over.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Chat threshold</label>
                  <input
                    type="number"
                    min={1}
                    value={settings.heavy_load_chat_threshold}
                    onChange={e => setSettings(s => ({ ...s, heavy_load_chat_threshold: e.target.value }))}
                    className="input w-full"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Auto-routing skips an agent who already has this many active chats. Falls through to the least-loaded agent if everyone is over.
                  </p>
                </div>
                <div>
                  <label className="label">Call threshold</label>
                  <input
                    type="number"
                    min={1}
                    value={settings.heavy_load_call_threshold}
                    onChange={e => setSettings(s => ({ ...s, heavy_load_call_threshold: e.target.value }))}
                    className="input w-full"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Auto-routing skips an agent who already has this many active calls. Default is 1 — a person can only handle one call at a time.
                  </p>
                </div>
              </div>
              <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                Admins are routed to like any other agent — but only while they have agent view open. Closing the agent tab removes them from the routing pool automatically.
              </div>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.block_outside_work_hours === '1' || settings.block_outside_work_hours === 1}
                  onChange={e => setSettings(s => ({ ...s, block_outside_work_hours: e.target.checked ? '1' : '0' }))}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium text-gray-700">Block auto-assignment outside work hours</p>
                  <p className="text-xs text-gray-400">Tickets created outside work hours wait until the next workday to be assigned.</p>
                </div>
              </label>
            </div>
          </div>

          {/* Working Hours */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Working Hours</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Customers see agent availability only within these hours (IST). Outside these hours they see "Outside working hours".
            </p>
            <div className="space-y-4">
              <div className="flex items-center gap-4 flex-wrap">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start time</label>
                  <select
                    className="input w-32"
                    value={settings.work_hours_start}
                    onChange={e => setSettings(s => ({ ...s, work_hours_start: e.target.value }))}
                  >
                    {HOUR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">End time</label>
                  <select
                    className="input w-32"
                    value={settings.work_hours_end}
                    onChange={e => setSettings(s => ({ ...s, work_hours_end: e.target.value }))}
                  >
                    {HOUR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Working days</label>
                <div className="flex gap-1.5 flex-wrap">
                  {DAY_OPTIONS.map(d => {
                    const activeDays = (settings.work_hours_days || '').split(',').map(Number);
                    const isOn = activeDays.includes(d.value);
                    return (
                      <button
                        key={d.value}
                        type="button"
                        onClick={() => {
                          const days = (settings.work_hours_days || '').split(',').map(Number).filter(n => !isNaN(n));
                          const next = isOn ? days.filter(x => x !== d.value) : [...days, d.value];
                          next.sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
                          setSettings(s => ({ ...s, work_hours_days: next.join(',') }));
                        }}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                          isOn ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200'
                        }`}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-gray-400 mt-2">All times are in Indian Standard Time (IST, UTC+5:30).</p>
              </div>
            </div>
          </div>

          {/* Billing App Integration */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <Link className="w-4 h-4 text-indigo-500" />
              <h2 className="text-sm font-bold text-gray-700">Billing App Integration</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Connect your billing app so the customer panel can show live plans, invoices,
              quotes and payments. Pick the provider, paste the base URL + key, and set each
              customer's Billing ID on the Customers page.
            </p>

            <div className="space-y-4">
              {/* Provider + auth style */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                  <select
                    className="input"
                    value={settings.billing_provider}
                    onChange={e => setSettings(s => ({ ...s, billing_provider: e.target.value }))}
                  >
                    <option value="reselleros">ResellerOS</option>
                    <option value="generic-rest">Generic REST (spec-shaped)</option>
                    <option value="zoho">Zoho Books (legacy)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Auth header</label>
                  <select
                    className="input"
                    value={settings.billing_auth_style}
                    onChange={e => setSettings(s => ({ ...s, billing_auth_style: e.target.value }))}
                  >
                    <option value="bearer">Authorization: Bearer</option>
                    <option value="x-api-key">X-API-Key</option>
                  </select>
                </div>
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Billing API Base URL
                </label>
                <input
                  type="url"
                  className="input"
                  placeholder="https://your-billing-app/api/v1"
                  value={settings.billing_api_url}
                  onChange={e => setSettings(s => ({ ...s, billing_api_url: e.target.value }))}
                />
                <p className="text-xs text-gray-400 mt-1">
                  Include the full base incl. any version prefix (e.g. <code className="bg-gray-100 px-1 rounded">/api/v1</code>). Do not add a trailing slash.
                </p>
              </div>

              {/* API Key */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Billing API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey ? 'text' : 'password'}
                    className="input pr-10"
                    placeholder="Key issued by your billing app"
                    value={settings.billing_api_key}
                    onChange={e => setSettings(s => ({ ...s, billing_api_key: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Test connection */}
              <div className="border-t border-gray-100 pt-4">
                <div className="flex items-end gap-2 flex-wrap">
                  <div className="flex-1 min-w-[160px]">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Test with Billing ID <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      className="input"
                      placeholder="C-00001"
                      value={testCustomerId}
                      onChange={e => setTestCustomerId(e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleTestBilling}
                    disabled={testing || !settings.billing_api_url || !settings.billing_api_key}
                    className="btn-secondary flex items-center gap-1.5 flex-shrink-0"
                    title="Call the billing app with these settings and report the result"
                  >
                    {testing
                      ? <><span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" /> Testing…</>
                      : <><RefreshCw className="w-4 h-4" /> Test connection</>}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Tests the values above (even before saving). Uses <code className="bg-gray-100 px-1 rounded">C-00001</code> if left blank.
                </p>
                {testResult && (
                  <div className={clsx(
                    'mt-3 flex items-start gap-2 rounded-lg p-3 text-sm border',
                    testResult.ok
                      ? 'bg-green-50 border-green-200 text-green-800'
                      : 'bg-red-50 border-red-200 text-red-700'
                  )}>
                    {testResult.ok ? <Check className="w-4 h-4 flex-shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />}
                    <div className="min-w-0">
                      <p className="font-medium">{testResult.message}</p>
                      {testResult.url && <p className="text-xs opacity-70 break-all mt-0.5">GET {testResult.url}</p>}
                      {testResult.ok && testResult.sampleKeys?.length > 0 && (
                        <p className="text-xs opacity-70 mt-0.5">Fields returned: {testResult.sampleKeys.join(', ')}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Webhook Secret */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Webhook Secret
                  <span className="text-gray-400 font-normal ml-1">(only if your billing app pushes webhooks)</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    className="input font-mono text-sm flex-1"
                    readOnly
                    placeholder="Generate a secret below"
                    value={settings.billing_webhook_secret}
                  />
                  <button
                    type="button"
                    onClick={handleCopySecret}
                    disabled={!settings.billing_webhook_secret}
                    className="btn-secondary p-2 flex-shrink-0"
                    title="Copy to clipboard"
                  >
                    {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerateSecret}
                    className="btn-secondary text-xs px-3 py-2 flex-shrink-0"
                  >
                    Generate
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  If your billing app supports webhooks, it should send this as an{' '}
                  <code className="bg-gray-100 px-1 rounded">X-Webhook-Secret</code> header when pushing to{' '}
                  <code className="bg-gray-100 px-1 rounded">/api/sync/customer</code>. (ResellerOS is read-only / poll-based — leave blank.)
                </p>
              </div>

              {/* Sync Now — bulk pull; only providers with a list-all endpoint support it */}
              <div className="border-t border-gray-100 pt-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-700">Manual bulk sync</p>
                  <p className="text-xs text-gray-400">
                    {settings.billing_last_sync
                      ? `Last synced: ${new Date(settings.billing_last_sync).toLocaleString('en-IN')}`
                      : 'Never synced'}
                    {settings.billing_provider === 'reselleros' && ' · ResellerOS has no list-all endpoint — set Billing IDs per customer instead'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={syncing || !settings.billing_api_url || settings.billing_provider === 'reselleros'}
                  className="btn-primary flex items-center gap-1.5"
                  title={settings.billing_provider === 'reselleros'
                    ? 'ResellerOS does not expose a bulk customer list — link customers individually'
                    : (!settings.billing_api_url ? 'Save your billing URL first' : 'Pull customers from the billing app')}
                >
                  {syncing
                    ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Syncing…</>
                    : <><RefreshCcw className="w-4 h-4" /> Bulk sync</>}
                </button>
              </div>
            </div>
          </div>

          {/* Payment Gateway */}
          <div className="card p-5">
            <div className="flex items-center gap-2 mb-1">
              <CreditCard className="w-4 h-4 text-green-500" />
              <h2 className="text-sm font-bold text-gray-700">Payment Gateway (Razorpay)</h2>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              Used for customer plan upgrades. Get your keys from the Razorpay Dashboard.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Key ID</label>
                <input
                  type="text"
                  className="input font-mono text-sm"
                  placeholder="rzp_live_..."
                  value={settings.razorpay_key_id}
                  onChange={e => setSettings(s => ({ ...s, razorpay_key_id: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Key Secret</label>
                <div className="relative">
                  <input
                    type={showRzpSecret ? 'text' : 'password'}
                    className="input pr-10 font-mono text-sm"
                    placeholder="Razorpay key secret"
                    value={settings.razorpay_key_secret}
                    onChange={e => setSettings(s => ({ ...s, razorpay_key_secret: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => setShowRzpSecret(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showRzpSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">Never share this key. Used only server-side.</p>
              </div>
            </div>
          </div>

          <button type="submit" disabled={saving} className="btn-primary flex items-center gap-1.5">
            <Save className="w-4 h-4" />
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </form>
      )}
    </Layout>
  );
}
