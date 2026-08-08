import { useEffect, useState, useCallback, useRef } from 'react';
import RowsPerPageSelect, { readStoredPageSize } from '../../components/common/RowsPerPageSelect';
import { useNavigate, Link as RouterLink, useSearchParams } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { PlanBadge, StatusBadge } from '../../components/common/PlanBadge';
import {
  getAdminCustomers, getAdminCustomerById, updateAdminCustomer, updateCustomerTags, getAdminPlans,
  getCustomerOverrides, updateCustomerOverrides, clearCustomerOverrides,
  lookupBillingCustomer, importBillingCustomer, triggerBillingSync, createManualCustomer, changeCustomerPassword,
  resetCustomerUsage, getAdminAgents, startCustomerOnboarding,
  deleteAdminCustomer, bulkImportCustomers, bulkCustomerAction, getAuditLogs,
  getCustomerPlanHistory, renewCustomerPlan, recordPaymentProof,
} from '../../services/api';
import { calculateFinalPriceFE, planView } from '../../utils/planUtils';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import {
  Search, RefreshCw, X, Save, Globe, Calendar,
  Package, Ticket, IndianRupee, Link, ShieldAlert, Trash2, UserPlus, KeyRound, RotateCcw, Sparkles, UserCheck, AlertTriangle, FileUp, CheckCircle2, XCircle, SkipForward, Mail, CreditCard, UsersRound, Tag,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';

// ── Feature Overrides Panel ────────────────────────────────────────────────
function OverridesPanel({ customerId, planName, onClose }) {
  const NONE = null; // null = use plan default

  const [form, setForm] = useState({
    allow_chat:    null,
    allow_calls:   null,
    tickets_limit: '',
    calls_limit:   '',
    chat_limit:    '',
    override_reason: '',
  });
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [clearing, setClearing] = useState(false);
  const [hasOverride, setHasOverride] = useState(false);

  useEffect(() => {
    setLoading(true);
    getCustomerOverrides(customerId)
      .then(r => {
        const o = r.data.overrides;
        if (o) {
          setHasOverride(true);
          setForm({
            allow_chat:    o.allow_chat    === null ? null : Boolean(o.allow_chat),
            allow_calls:   o.allow_calls   === null ? null : Boolean(o.allow_calls),
            tickets_limit: o.tickets_limit ?? '',
            calls_limit:   o.calls_limit   ?? '',
            chat_limit:    o.chat_limit    ?? '',
            override_reason: o.override_reason || '',
          });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [customerId]);

  const handleSave = async () => {
    if (!form.override_reason.trim()) {
      toast.error('Override reason is required');
      return;
    }
    setSaving(true);
    try {
      await updateCustomerOverrides(customerId, {
        allow_chat:    form.allow_chat,
        allow_calls:   form.allow_calls,
        tickets_limit: form.tickets_limit !== '' ? parseInt(form.tickets_limit) : null,
        calls_limit:   form.calls_limit   !== '' ? parseInt(form.calls_limit)   : null,
        chat_limit:    form.chat_limit    !== '' ? parseInt(form.chat_limit)    : null,
        override_reason: form.override_reason,
      });
      setHasOverride(true);
      toast.success('Access overrides saved');
    } catch {
      toast.error('Failed to save overrides');
    } finally { setSaving(false); }
  };

  const handleClear = async () => {
    if (!confirm('Remove all overrides for this customer? They will use plan defaults.')) return;
    setClearing(true);
    try {
      await clearCustomerOverrides(customerId);
      setHasOverride(false);
      setForm({ allow_chat: null, allow_calls: null, tickets_limit: '', calls_limit: '', chat_limit: '', override_reason: '' });
      toast.success('Overrides cleared — using plan defaults');
    } catch {
      toast.error('Failed to clear overrides');
    } finally { setClearing(false); }
  };

  const TriToggle = ({ label, field }) => {
    const val = form[field];
    return (
      <div className="flex items-center justify-between py-1.5">
        <span className="text-sm text-gray-700">{label}</span>
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setForm(f => ({ ...f, [field]: null }))}
            className={`px-2.5 py-1 rounded-md transition-colors ${val === null ? 'bg-white shadow text-gray-700' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Plan default
          </button>
          <button
            type="button"
            onClick={() => setForm(f => ({ ...f, [field]: true }))}
            className={`px-2.5 py-1 rounded-md transition-colors ${val === true ? 'bg-green-100 text-green-700 shadow' : 'text-gray-400 hover:text-green-600'}`}
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => setForm(f => ({ ...f, [field]: false }))}
            className={`px-2.5 py-1 rounded-md transition-colors ${val === false ? 'bg-red-100 text-red-700 shadow' : 'text-gray-400 hover:text-red-600'}`}
          >
            Block
          </button>
        </div>
      </div>
    );
  };

  if (loading) return <div className="py-6 text-center text-xs text-gray-400">Loading overrides…</div>;

  return (
    <div className="border-t border-gray-100 p-4 bg-orange-50/40 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <ShieldAlert className="w-4 h-4 text-orange-500" />
          <span className="text-sm font-bold text-gray-700">Support Access Overrides</span>
          {hasOverride && <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-medium">Active</span>}
        </div>
        {hasOverride && (
          <button onClick={handleClear} disabled={clearing} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700">
            <Trash2 className="w-3 h-3" /> Clear overrides
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500">
        Override plan defaults for this specific customer. <span className="font-medium">Plan default</span> = no override.
      </p>
      <TriToggle label="Live Chat access" field="allow_chat" />
      <TriToggle label="Call support access" field="allow_calls" />

      {/* Until the admin actually picks Allow or Block on at least one of the
          toggles above, an override doesn't exist — and the number / reason
          fields below have nothing to attach to. Fade them so it's obvious
          they're idle. Once a toggle moves off Plan default, they snap to
          fully active. (Previously these looked editable even with no override
          selected, which let admins type a reason + Save and wonder why
          nothing changed.) */}
      {(() => {
        const bothAtDefault = form.allow_chat === null && form.allow_calls === null;
        const fadeCls = bothAtDefault ? 'opacity-50 pointer-events-none select-none' : '';
        return (
          <>
            <div className={`grid grid-cols-3 gap-3 transition-opacity ${fadeCls}`}>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Ticket limit/month</label>
                <input
                  type="number"
                  min="0"
                  className="input text-sm py-1.5"
                  placeholder={bothAtDefault ? 'Pick toggle above' : 'Plan default'}
                  value={form.tickets_limit}
                  onChange={e => setForm(f => ({ ...f, tickets_limit: e.target.value }))}
                  disabled={bothAtDefault}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Chat limit/month</label>
                <input
                  type="number"
                  min="0"
                  className="input text-sm py-1.5"
                  placeholder={bothAtDefault ? 'Pick toggle above' : 'Plan default'}
                  value={form.chat_limit}
                  onChange={e => setForm(f => ({ ...f, chat_limit: e.target.value }))}
                  disabled={bothAtDefault}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Call limit/month</label>
                <input
                  type="number"
                  min="0"
                  className="input text-sm py-1.5"
                  placeholder={bothAtDefault ? 'Pick toggle above' : 'Plan default'}
                  value={form.calls_limit}
                  onChange={e => setForm(f => ({ ...f, calls_limit: e.target.value }))}
                  disabled={bothAtDefault}
                />
              </div>
            </div>
            <div className={`transition-opacity ${fadeCls}`}>
              <label className="block text-xs font-medium text-gray-600 mb-1">Reason for override *</label>
              <input
                type="text"
                className="input text-sm py-1.5"
                placeholder={bothAtDefault ? 'Pick a toggle above first' : 'e.g. Trial extension, courtesy upgrade...'}
                value={form.override_reason}
                onChange={e => setForm(f => ({ ...f, override_reason: e.target.value }))}
                disabled={bothAtDefault}
              />
            </div>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || bothAtDefault}
              title={bothAtDefault ? 'Set Live Chat or Call access to Allow / Block above before saving' : 'Save these overrides'}
              className="btn-primary w-full justify-center text-sm py-2"
            >
              {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Save className="w-3.5 h-3.5" /> Save Overrides</>}
            </button>
          </>
        );
      })()}
    </div>
  );
}

// ── Change Password Modal ──────────────────────────────────────────────────
function ChangePasswordModal({ customer, onClose }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [saving, setSaving]     = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    setSaving(true);
    try {
      await changeCustomerPassword(customer.id, { password });
      toast.success(`Password updated for ${customer.name}`);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update password');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">Change Password</h2>
            <p className="text-xs text-gray-400 mt-0.5">{customer.name} — {customer.email}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-4">
            <div>
              <label className="label">New Password</label>
              <input
                type="password"
                className="input"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Min 6 characters"
                autoFocus
                required
              />
            </div>
            <div>
              <label className="label">Confirm Password</label>
              <input
                type="password"
                className="input"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat password"
                required
              />
            </div>
          </div>
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving
                ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : <><KeyRound className="w-4 h-4" /> Update Password</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit Modal ─────────────────────────────────────────────────────────────
function EditModal({ customer, plans, onClose, onSave }) {
  const isSynced = Boolean(customer.billing_customer_id);
  // Every customer must have a plan. If the row somehow has no plan_id
  // (legacy data), default the form to the Free plan so the admin can't
  // re-save the customer back into a planless state.
  const freePlanId = plans.find(p => p.name === 'free')?.id;
  const [form, setForm] = useState({
    planId: customer.plan_id || freePlanId || '',
    planExpiry: customer.plan_expiry ? customer.plan_expiry.split('T')[0] : '',
    invoiceSubtotal: customer.invoice_subtotal || 0,
    domain: customer.domain || '',
    transactionRef: '',
    is_vip: !!customer.is_vip,
    favorite_agent_id: customer.favorite_agent_id || '',
  });
  const [agents, setAgents] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAdminAgents().then(r => setAgents(r.data.agents || [])).catch(() => {});
  }, []);

  const selectedPlan = plans.find(p => p.id === parseInt(form.planId));
  const finalPrice = selectedPlan && selectedPlan.name !== 'free'
    ? calculateFinalPriceFE(selectedPlan.name, parseFloat(form.invoiceSubtotal) || 0)
    : 0;

  const handleSave = async () => {
    // Paid plans require an expiry date (free never expires) — bug #34.
    if (selectedPlan && selectedPlan.name !== 'free' && !form.planExpiry) {
      toast.error('Please set a plan expiry date for paid plans.');
      return;
    }
    setSaving(true);
    try {
      await updateAdminCustomer(customer.id, {
        planId: form.planId ? parseInt(form.planId) : null,
        planExpiry: form.planExpiry || null,
        invoiceSubtotal: parseFloat(form.invoiceSubtotal) || 0,
        domain: form.domain,
        transactionRef: form.transactionRef || null,
        is_vip: form.is_vip,
        favorite_agent_id: form.favorite_agent_id ? parseInt(form.favorite_agent_id) : null,
      });
      toast.success('Customer updated');
      onSave();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800">Edit Customer</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div>
            <label className="label">Customer</label>
            <p className="text-sm font-semibold text-gray-800">
              {customer.name}
              <span className="text-gray-400 font-normal"> ({customer.email})</span>
            </p>
            {isSynced && (
              <p className="text-xs text-blue-600 flex items-center gap-1 mt-1">
                <Link className="w-3 h-3" /> Billing ID: {customer.billing_customer_id}
              </p>
            )}
          </div>
          <div>
            <label className="label">Domain</label>
            <input type="text" className="input" value={form.domain} onChange={e => setForm(f => ({ ...f, domain: e.target.value }))} />
          </div>
          <div>
            <label className="label">
              Support Plan
              {isSynced && <span className="ml-1.5 text-xs text-amber-600 font-normal">(managed by your billing app — changes will be overwritten on next sync)</span>}
            </label>
            <select className="input" value={form.planId} onChange={e => setForm(f => ({ ...f, planId: e.target.value }))}>
              {plans
                // Hide deactivated plans EXCEPT the one this customer is currently on
                // — so admin can still edit their other fields without being forced
                // to migrate them to a different plan first.
                .filter(p => p.is_active !== 0 || p.id === customer.plan_id)
                .map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name.charAt(0).toUpperCase() + p.name.slice(1)}
                    {p.is_active === 0 ? ' (disabled — current plan only)' : ''}
                  </option>
                ))}
            </select>
          </div>
          {selectedPlan?.name === 'free' ? (
            <div>
              <label className="label">Plan Expiry Date</label>
              <p className="text-xs text-gray-500 italic">Free plan never expires — no expiry date applies.</p>
            </div>
          ) : (
            <div>
              <label className="label">Plan Expiry Date <span className="text-red-500">*</span></label>
              <input type="date" required className="input" value={form.planExpiry} onChange={e => setForm(f => ({ ...f, planExpiry: e.target.value }))} />
            </div>
          )}
          <div>
            <label className="label">Invoice Subtotal (₹)</label>
            <input type="number" className="input" value={form.invoiceSubtotal} onChange={e => setForm(f => ({ ...f, invoiceSubtotal: e.target.value }))} min="0" />
          </div>
          <div>
            <label className="label">Payment Reference / Transaction ID</label>
            <input
              type="text"
              className="input"
              placeholder="e.g. NEFT UTR, cheque no., Razorpay ID"
              value={form.transactionRef}
              onChange={e => setForm(f => ({ ...f, transactionRef: e.target.value }))}
            />
            <p className="text-xs text-gray-400 mt-1">Sent to your billing app to link this payment to the plan change.</p>
          </div>
          {selectedPlan && selectedPlan.name !== 'free' && (
            <div className="bg-blue-50 rounded-lg p-3 text-sm">
              <p className="text-blue-700 font-medium">Calculated Plan Price</p>
              <p className="text-blue-600 mt-0.5">
                max(₹{(parseFloat(form.invoiceSubtotal) || 0).toLocaleString()} × {(selectedPlan.percentage * 100).toFixed(0)}%, ₹{Number(selectedPlan.minimum_price).toLocaleString()})
                = <strong>₹{finalPrice.toLocaleString('en-IN')}</strong>
              </p>
            </div>
          )}

          {/* Routing preferences */}
          <div className="border-t border-gray-100 pt-4 space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Support Routing</p>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_vip}
                onChange={e => setForm(f => ({ ...f, is_vip: e.target.checked }))}
                className="mt-0.5"
              />
              <div>
                <p className="text-sm font-medium text-gray-700">VIP customer</p>
                <p className="text-xs text-gray-400">Shows a VIP badge to agents. Useful for high-priority accounts.</p>
              </div>
            </label>
            <div>
              <label className="label">Favorite agent (preferred for this customer)</label>
              <select
                value={form.favorite_agent_id}
                onChange={e => setForm(f => ({ ...f, favorite_agent_id: e.target.value }))}
                className="input w-full"
              >
                <option value="">— No preference (use routing rules) —</option>
                {agents.filter(a => a.is_active).map(a => (
                  <option key={a.id} value={a.id}>{a.name} {a.role === 'admin' ? '(admin)' : ''}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                If this agent is online, all new tickets/chats/calls from this customer go to them first. Otherwise normal routing applies.
              </p>
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary">
            {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <><Save className="w-4 h-4" /> Save Changes</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Customer Detail Panel ──────────────────────────────────────────────────
function CustomerDetail({ customerId, plans, onEdit, onDelete, onClose, onTagClick }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [tagInput, setTagInput] = useState('');
  const [showChangePw, setShowChangePw] = useState(false);
  const [resettingUsage, setResettingUsage] = useState(false);
  const [startingOnboard, setStartingOnboard] = useState(false);
  const [showOnboardModal, setShowOnboardModal] = useState(false);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [showProofModal, setShowProofModal] = useState(false);
  const [tab, setTab] = useState('overview');   // 'overview' | 'tickets' | 'plan_history' | 'activity'

  useEffect(() => {
    getAdminCustomerById(customerId).then(res => setData(res.data)).catch(() => toast.error('Failed to load'));
  }, [customerId]);

  const handleResetUsage = async () => {
    if (!window.confirm('Reset all usage counters (tickets, calls, chats) for this customer for the current month?')) return;
    setResettingUsage(true);
    try {
      await resetCustomerUsage(customerId);
      toast.success('Usage counters reset for current month');
    } catch {
      toast.error('Failed to reset usage');
    } finally {
      setResettingUsage(false);
    }
  };

  // The actual API call — used by the modal. Modal handles agent selection.
  const doStartOnboarding = async (agentId) => {
    setStartingOnboard(true);
    try {
      const r = await startCustomerOnboarding(customerId, agentId ? { agent_id: agentId } : {});
      const id = r.data.onboarding_ticket_id;
      const agent = r.data.assigned_agent?.name;
      if (r.data.reused_existing) {
        toast(`Existing onboarding ticket #${id} is still open` + (agent ? ` (assigned to ${agent})` : ''), { duration: 5000 });
      } else {
        toast.success(`Onboarding ticket #${id} created` + (agent ? ` · assigned to ${agent}` : ''), { duration: 5000 });
      }
      setShowOnboardModal(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to start onboarding');
    } finally {
      setStartingOnboard(false);
    }
  };

  // Save a customer's tag list (add/remove), optimistically updating the panel.
  const saveTags = async (nextTags) => {
    try {
      const res = await updateCustomerTags(customerId, nextTags);
      setData(d => ({ ...d, customer: { ...d.customer, tags: res.data.tags } }));
    } catch { toast.error('Failed to update tags'); }
  };
  const addTag = () => {
    const t = tagInput.trim();
    setTagInput('');
    if (!t) return;
    const current = data?.customer?.tags || [];
    if (current.some(x => x.toLowerCase() === t.toLowerCase())) return;
    saveTags([...current, t]);
  };
  const removeTag = (t) => saveTags((data?.customer?.tags || []).filter(x => x !== t));

  if (!data) return (
    <div className="card p-8 flex items-center justify-center">
      <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  const c = data.customer;
  const tags = c.tags || [];
  // Canonical plan status (shared with the customer panel via utils/planUtils).
  const { active: planActive, noExpirySet } = planView(c);
  const isSynced = Boolean(c.billing_customer_id);

  // Avatar initials — matches the Zoho-style header card
  const initial = (c.name?.[0] || '?').toUpperCase();

  return (
    // h-full lets the card stretch to the height of the grid cell (which itself
    // stretches to match the tallest sibling — the customer list rail). Without
    // it the card shrinks to its content and leaves a gap under the detail.
    <div className="card overflow-hidden h-full flex flex-col">
      {/* Header — name + primary actions */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between flex-wrap gap-y-2">
        <div className="flex items-center gap-2">
          <p className="text-base font-semibold text-gray-800">{c.name}</p>
          {isSynced && (
            <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded-full font-medium">
              <Link className="w-2.5 h-2.5" /> Billing
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => onEdit(c)} className="btn-primary text-xs py-1">Edit</button>
          <button onClick={() => setShowChangePw(true)} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200 transition-colors" title="Change password">
            <KeyRound className="w-3.5 h-3.5" /> Password
          </button>
          <button onClick={() => setShowOnboardModal(true)} disabled={startingOnboard} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 transition-colors disabled:opacity-50" title="Open an onboarding ticket + assign an agent">
            <Sparkles className={`w-3.5 h-3.5 ${startingOnboard ? 'animate-pulse' : ''}`} /> Start Onboarding
          </button>
          <button onClick={handleResetUsage} disabled={resettingUsage} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 transition-colors disabled:opacity-50" title="One-time goodwill: drop this month's tickets/chats/calls counters back to 0. Plan rules unchanged. (Use Support Access Overrides below for permanent rule exceptions.)">
            <RotateCcw className={`w-3.5 h-3.5 ${resettingUsage ? 'animate-spin' : ''}`} /> Reset Usage
          </button>
          <button onClick={() => setShowRenewModal(true)} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 transition-colors" title="Manually renew or extend this customer's support plan (e.g. they paid by bank transfer / cheque outside the panel)">
            <Calendar className="w-3.5 h-3.5" /> Renew Plan
          </button>
          {c.missing_payment_proof && (
            <button onClick={() => setShowProofModal(true)} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-amber-100 text-amber-800 hover:bg-amber-200 border border-amber-300 transition-colors" title="Attach the missing transaction ID for this customer's current plan">
              <CreditCard className="w-3.5 h-3.5" /> Record Proof
            </button>
          )}
          <button onClick={() => onDelete?.(c)} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 transition-colors" title="Permanently delete this customer + all their data">
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded"><X className="w-4 h-4 text-gray-400" /></button>
        </div>
      </div>

      {/* Missing-payment-proof banner — paying customer with zero non-NULL
          payment_ref rows in plan_change_history. Clicking opens the proof
          backfill modal; the banner stays until a ref is attached. */}
      {c.missing_payment_proof && (
        <div className="px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex items-center justify-between flex-wrap gap-2">
          <p className="text-xs text-amber-800 inline-flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
            <span><strong>Missing payment proof.</strong> This customer is on a paid plan but has no transaction ID on file. Add one so the Revenue tile reflects verified payments.</span>
          </p>
          <button
            onClick={() => setShowProofModal(true)}
            className="text-xs font-medium px-2.5 py-1 rounded-lg bg-amber-100 text-amber-900 hover:bg-amber-200 border border-amber-300 transition-colors"
          >
            Record proof now
          </button>
        </div>
      )}

      {/* Tags — admin labels; click a tag to filter the list by it */}
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs text-gray-400 font-medium mr-0.5"><Tag className="w-3.5 h-3.5" /> Tags</span>
        {tags.map(t => (
          <span key={t} className="inline-flex items-center gap-1 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 pl-2 pr-1 py-0.5 rounded-full">
            <button onClick={() => onTagClick?.(t)} className="hover:underline" title={`Filter by "${t}"`}>{t}</button>
            <button onClick={() => removeTag(t)} className="text-blue-400 hover:text-red-600" title="Remove tag"><X className="w-3 h-3" /></button>
          </span>
        ))}
        <input
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
          onBlur={addTag}
          placeholder={tags.length ? 'Add tag…' : 'Add a tag (e.g. VIP)…'}
          className="text-xs px-2 py-1 rounded-full border border-dashed border-gray-300 focus:border-blue-400 focus:outline-none w-32"
        />
      </div>

      {/* Tabs (Zoho-style horizontal tabs under the header) */}
      <div className="border-b border-gray-100 px-4 flex items-center gap-1 text-sm">
        {[
          { id: 'overview',     label: 'Overview' },
          { id: 'tickets',      label: `Tickets (${data.tickets.length})` },
          { id: 'plan_history', label: 'Plan History' },
          { id: 'activity',     label: 'Activity' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-2.5 -mb-px border-b-2 font-medium transition-colors ${tab === t.id ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4 overflow-y-auto flex-1 min-h-0">
        {tab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            {/* LEFT column — customer info card + sectioned details */}
            <div className="lg:col-span-3 space-y-5">
              {/* Customer info card — avatar + email + plan + status + overrides badge */}
              <div className="flex items-start gap-3 pb-4 border-b border-gray-100">
                <div className="w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center text-white text-xl font-bold flex-shrink-0">
                  {initial}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-gray-800">{c.name}</p>
                    <span
                      className="text-[10px] text-gray-500 font-mono bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded"
                      title="Customer ID — used in Audit Log entries and URLs"
                    >
                      #{c.id}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 font-mono">{c.email}</p>
                  <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                    <PlanBadge plan={c.plan_name} />
                    <StatusBadge isActive={planActive} expiry={c.plan_expiry} />
                    {noExpirySet && (
                      <span
                        className="inline-flex items-center gap-0.5 text-[10px] bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium"
                        title="Paid plan with no expiry date set. Edit the customer and set an expiry date."
                      >
                        <AlertTriangle className="w-2.5 h-2.5" /> Expiry not set
                      </span>
                    )}
                    {data.override && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium"
                        title={`Has support access overrides${data.override.override_reason ? `: ${data.override.override_reason}` : ''}`}
                      >
                        <ShieldAlert className="w-2.5 h-2.5" /> Overrides
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Plan</p>
                <table className="w-full text-sm">
                  <tbody>
                    <tr><td className="text-gray-500 py-1.5 w-40">Current plan</td><td className="capitalize text-gray-800 font-medium">{c.plan_name || '—'}</td></tr>
                    <tr><td className="text-gray-500 py-1.5">Expires on</td><td className="text-gray-800">{
                      c.plan_name === 'free'
                        ? <span className="text-emerald-600 font-medium">Never (Free plan)</span>
                        : (c.plan_expiry ? new Date(c.plan_expiry).toLocaleDateString('en-IN') : '—')
                    }</td></tr>
                    <tr><td className="text-gray-500 py-1.5">Invoice subtotal</td><td className="text-gray-800">₹{Number(c.invoice_subtotal || 0).toLocaleString('en-IN')}</td></tr>
                  </tbody>
                </table>
              </div>

              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Address</p>
                <table className="w-full text-sm">
                  <tbody>
                    <tr><td className="text-gray-500 py-1.5 w-40">Domain</td><td className="text-gray-800">{c.domain || '—'}</td></tr>
                  </tbody>
                </table>
              </div>

              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Other details</p>
                <table className="w-full text-sm">
                  <tbody>
                    {isSynced && (
                      <>
                        <tr><td className="text-gray-500 py-1.5 w-40">Billing ID</td><td className="text-gray-800 font-mono">{c.billing_customer_id}</td></tr>
                        {c.billing_synced_at && <tr><td className="text-gray-500 py-1.5">Last synced</td><td className="text-gray-800">{new Date(c.billing_synced_at).toLocaleString('en-IN')}</td></tr>}
                      </>
                    )}
                    {c.products?.length > 0 && (
                      <tr>
                        <td className="text-gray-500 py-1.5 align-top">Products</td>
                        <td><div className="flex flex-wrap gap-1.5">{c.products.map(p => <span key={p} className="badge bg-blue-50 text-blue-700">{p}</span>)}</div></td>
                      </tr>
                    )}
                    {!isSynced && (!c.products || c.products.length === 0) && (
                      <tr><td className="text-gray-400 italic text-xs py-1.5" colSpan={2}>No extra details</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Support Access Overrides — always visible (no dropdown toggle).
                  The section is rendered inline like Plan / Address / Other details
                  because (a) there's space, (b) hiding it cost an extra click and
                  hurt discoverability, (c) the "Overrides" badge in the info card
                  now flags customers who have any set. */}
              <div>
                <p
                  className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1"
                  title="Permanent per-customer exceptions to the plan rules — e.g. let a Free customer chat, or block calls for a noisy account. Different from 'Reset Usage' which is a one-time goodwill gesture."
                >
                  <ShieldAlert className="w-3 h-3 text-orange-500" /> Support Access Overrides
                </p>
                <OverridesPanel customerId={customerId} planName={c.plan_name} onClose={() => {}} />
              </div>
            </div>

            {/* RIGHT column — usage snapshot (Zoho's screenshot has receivables
                here; we show what's actually meaningful for a support panel:
                this month's ticket / chat / call counts vs the plan cap) */}
            <div className="lg:col-span-2">
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="bg-gray-50 px-4 py-2.5 border-b border-gray-200">
                  <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Usage this month</p>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-500">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Channel</th>
                      <th className="text-right px-4 py-2 font-medium">Used</th>
                      <th className="text-right px-4 py-2 font-medium">Limit</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    <tr>
                      <td className="px-4 py-2 text-gray-700">Tickets</td>
                      <td className="px-4 py-2 text-right font-medium">{data.tickets_used ?? 0}</td>
                      <td className="px-4 py-2 text-right text-gray-400">{c.tickets_limit ?? '∞'}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2 text-gray-700">Live chats</td>
                      <td className="px-4 py-2 text-right font-medium">{data.chats_used ?? 0}</td>
                      <td className="px-4 py-2 text-right text-gray-400">{c.chat_limit ?? '∞'}</td>
                    </tr>
                    <tr>
                      <td className="px-4 py-2 text-gray-700">Phone calls</td>
                      <td className="px-4 py-2 text-right font-medium">{data.calls_used ?? 0}</td>
                      <td className="px-4 py-2 text-right text-gray-400">{c.calls_limit ?? '∞'}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="bg-gray-50 px-4 py-2.5 border-t border-gray-200 text-xs text-gray-500">
                  Counters reset on the 1st of every month.
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'tickets' && (
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1">
              <Ticket className="w-3 h-3" /> All tickets ({data.tickets.length})
            </p>
            <div className="space-y-1.5">
              {data.tickets.map(t => (
                // Real <a> link via RouterLink so middle-click / ctrl-click /
                // right-click "Open in new tab" all work natively. Plain <button>
                // wouldn't expose the URL to the browser.
                <RouterLink
                  key={t.id}
                  to={`/admin/tickets?openTicket=${t.id}`}
                  className="flex items-center justify-between text-xs bg-gray-50 hover:bg-blue-50 hover:text-blue-700 rounded px-2.5 py-2 transition-colors no-underline text-gray-700"
                  title="Open the full conversation on the Tickets page (Ctrl/⌘+click for new tab)"
                >
                  <span className="truncate max-w-md">#{t.id} {t.subject}</span>
                  <span className={`ml-2 badge capitalize text-xs ${t.status === 'open' ? 'bg-blue-100 text-blue-700' : t.status === 'closed' ? 'bg-gray-100 text-gray-600' : 'bg-yellow-100 text-yellow-700'}`}>{t.status}</span>
                </RouterLink>
              ))}
              {data.tickets.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No tickets yet</p>}
            </div>
          </div>
        )}

        {tab === 'plan_history' && <PlanHistoryTab customerId={customerId} />}
        {tab === 'activity' && <ActivityTab customerId={customerId} />}
      </div>

      {showChangePw && (
        <ChangePasswordModal
          customer={c}
          onClose={() => setShowChangePw(false)}
        />
      )}

      {showOnboardModal && (
        <StartOnboardingModal
          customerName={c.name}
          onClose={() => setShowOnboardModal(false)}
          onConfirm={doStartOnboarding}
          submitting={startingOnboard}
        />
      )}

      {showRenewModal && (
        <RenewPlanModal
          customer={c}
          plans={plans}
          onClose={() => setShowRenewModal(false)}
          onSuccess={() => {
            setShowRenewModal(false);
            getAdminCustomerById(customerId).then(res => setData(res.data));
          }}
        />
      )}

      {showProofModal && (
        <RecordPaymentProofModal
          customer={c}
          onClose={() => setShowProofModal(false)}
          onSuccess={() => {
            setShowProofModal(false);
            getAdminCustomerById(customerId).then(res => setData(res.data));
          }}
        />
      )}
    </div>
  );
}

// ── Renew Plan modal — admin manually renews/extends a customer's plan ─────
// Used when payment happened OUTSIDE the panel (bank transfer, cheque,
// quote-based offline payment, etc.). Writes the same plan_change_history
// row as a customer-initiated upgrade so the history tab + Reports KPI
// stay accurate.
function RenewPlanModal({ customer, plans, onClose, onSuccess }) {
  const [targetPlanId, setTargetPlanId] = useState(customer.plan_id || '');
  const [newExpiry, setNewExpiry]       = useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split('T')[0];
  });
  const [amountPaid, setAmountPaid] = useState('');
  const [paymentRef, setPaymentRef] = useState('');
  const [note, setNote]             = useState('');
  const [saving, setSaving]         = useState(false);

  // Only show ACTIVE paid plans — Free isn't a renewal target
  const eligiblePlans = (plans || []).filter(p => p.is_active && p.name !== 'free');

  const handleSave = async () => {
    if (!targetPlanId) { toast.error('Pick a plan'); return; }
    if (!newExpiry) { toast.error('Pick a new expiry date'); return; }
    if (!paymentRef.trim()) { toast.error('Payment reference is required — enter the bank ref / cheque no / UPI ID.'); return; }
    const amt = Number(amountPaid);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Amount paid must be a positive number.'); return; }
    setSaving(true);
    try {
      const r = await renewCustomerPlan(customer.id, {
        target_plan_id: Number(targetPlanId),
        new_expiry: newExpiry,
        amount_paid: amt,
        payment_ref: paymentRef.trim(),
        note: note.trim() || null,
      });
      toast.success(r.data.message || 'Plan renewed');
      onSuccess?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Renewal failed');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-gray-800 inline-flex items-center gap-2">
            <Calendar className="w-5 h-5 text-emerald-500" /> Renew Plan
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Records a payment made outside the panel. The customer's plan_id + expiry will be updated and the change logged to their Plan History.
        </p>

        <label className="label">Target plan <span className="text-red-500">*</span></label>
        <select className="input w-full mb-3" value={targetPlanId} onChange={e => setTargetPlanId(e.target.value)}>
          <option value="">— Pick a plan —</option>
          {eligiblePlans.map(p => (
            <option key={p.id} value={p.id}>
              {p.name.charAt(0).toUpperCase() + p.name.slice(1)}
            </option>
          ))}
        </select>

        <label className="label">New expiry date <span className="text-red-500">*</span></label>
        <input type="date" className="input w-full mb-3" value={newExpiry} onChange={e => setNewExpiry(e.target.value)} />

        <label className="label">Amount paid (₹) <span className="text-red-500">*</span></label>
        <input type="number" step="0.01" min="0" placeholder="e.g. 4999"
          className="input w-full mb-3"
          value={amountPaid}
          onChange={e => setAmountPaid(e.target.value)} required />

        <label className="label">Payment reference / Transaction ID <span className="text-red-500">*</span></label>
        <input type="text" placeholder="e.g. NEFT-2026-0411 / UPI ref / Cheque #12345"
          className="input w-full mb-1"
          value={paymentRef}
          maxLength={120}
          onChange={e => setPaymentRef(e.target.value)} required />
        <p className="text-[11px] text-gray-500 mb-3">
          Required — provides the audit trail proving payment was received. Bank ref, UPI ID, cheque number, or Razorpay payment ID all work.
        </p>

        <label className="label">Note (optional)</label>
        <textarea placeholder="e.g. Annual renewal — paid via NEFT on 11 Jun 2026"
          className="input w-full text-sm"
          rows={2}
          maxLength={500}
          value={note}
          onChange={e => setNote(e.target.value)} />

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Renew Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Record Payment Proof modal ─────────────────────────────────────────────
// For paying customers whose plan_change_history has no payment_ref on file —
// either the original signup row (backfilled at migration time, before refs
// were tracked) or a pre-enforcement manual renewal. Does NOT change the
// customer's plan or expiry; it only attaches the missing transaction ID to
// their most recent NULL-ref history row.
function RecordPaymentProofModal({ customer, onClose, onSuccess }) {
  const [paymentRef, setPaymentRef] = useState('');
  const [amountPaid, setAmountPaid] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const cleanRef = paymentRef.trim();
    if (!cleanRef) { toast.error('Transaction ID is required.'); return; }
    const amt = Number(amountPaid);
    if (!Number.isFinite(amt) || amt <= 0) { toast.error('Amount paid must be a positive number.'); return; }
    setSaving(true);
    try {
      await recordPaymentProof(customer.id, {
        payment_ref: cleanRef,
        amount_paid: amt,
        note: note.trim() || null,
      });
      toast.success('Payment proof recorded');
      onSuccess?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not record payment proof');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-gray-800 inline-flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-amber-500" /> Record Payment Proof
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Attach the missing transaction ID to <strong>{customer.name}</strong>'s most recent plan record.
          Plan and expiry stay the same — this is just an audit-trail backfill.
        </p>

        <label className="label">Transaction ID <span className="text-red-500">*</span></label>
        <input type="text" placeholder="e.g. NEFT-2026-0411 / UPI ref / Cheque #12345 / pay_xyz"
          className="input w-full mb-3"
          value={paymentRef}
          maxLength={120}
          onChange={e => setPaymentRef(e.target.value)} required />

        <label className="label">Amount paid (₹) <span className="text-red-500">*</span></label>
        <input type="number" step="0.01" min="0" placeholder="e.g. 4999"
          className="input w-full mb-3"
          value={amountPaid}
          onChange={e => setAmountPaid(e.target.value)} required />

        <label className="label">Note (optional)</label>
        <textarea placeholder="e.g. Paid by NEFT on signup, ref missed in initial entry"
          className="input w-full text-sm"
          rows={2}
          maxLength={500}
          value={note}
          onChange={e => setNote(e.target.value)} />

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : 'Record Proof'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Start Onboarding modal — same agent picker as the import flow ─────────
function StartOnboardingModal({ customerName, onClose, onConfirm, submitting }) {
  const [agentId, setAgentId] = useState('');
  const [agents, setAgents]   = useState([]);

  useEffect(() => {
    getAdminAgents()
      .then(res => setAgents((res.data.agents || res.data || []).filter(a => a.role === 'agent' || a.role === 'admin')))
      .catch(() => {});
  }, []);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" />
            <h2 className="text-lg font-bold text-gray-800">Start Onboarding</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-600">
            This will open an onboarding ticket for <strong>{customerName}</strong>, add the
            <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded mx-1">onboarding-pending</span>
            tag, and assign an agent. The customer will see the ticket in their portal.
          </p>

          <div>
            <label className="label">Assign onboarding to</label>
            <select
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              className="input w-full"
              disabled={submitting}
            >
              <option value="">Auto-assign (least loaded available agent)</option>
              {agents.length === 0 && <option disabled>Loading agents…</option>}
              {agents.map(a => (
                <option key={a.id} value={a.id}>{a.name} {a.role === 'admin' ? '(admin)' : ''}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Pick a specific agent if you want a known person to drive the onboarding (e.g. their account manager).
            </p>
          </div>

          <div className="bg-purple-50 border border-purple-100 rounded-lg p-3 text-xs text-purple-800">
            <p className="font-semibold mb-1">What happens after this:</p>
            <ul className="space-y-0.5 ml-4 list-disc">
              <li>Onboarding ticket is opened with a checklist (which email service, domain, users, migration source).</li>
              <li>The assigned agent gets a real-time notification.</li>
              <li>The customer's tour will reference the ticket on first login.</li>
            </ul>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} disabled={submitting} className="btn-secondary">Cancel</button>
          <button
            onClick={() => onConfirm(agentId ? Number(agentId) : null)}
            disabled={submitting}
            className="btn-primary inline-flex items-center gap-1.5"
          >
            {submitting
              ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Starting…</>
              : <><Sparkles className="w-4 h-4" /> Start Onboarding</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Manual Customer Modal ──────────────────────────────────────────────────
// Admin-driven creation for customers who aren't (yet) in the billing app.
// Distinct from the import flow: no billing lookup, admin types everything.
function ManualCustomerModal({ onClose, onCreated }) {
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');     // optional — leave blank to send setup link
  const [domain, setDomain]     = useState('');
  const [planId, setPlanId]     = useState('');     // hydrated to Free plan id once /admin/plans returns
  const [planExpiry, setPlanExpiry] = useState('');
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [onboardingAgentId, setOnboardingAgentId] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [plans, setPlans]       = useState([]);
  const [agentOptions, setAgentOptions] = useState([]);
  const [creating, setCreating] = useState(false);

  // Load plan list + agents up-front so the dropdowns are populated when the
  // admin reaches them. Both are tiny lookups. Default planId to Free so the
  // admin can't create a customer with no plan assigned.
  useEffect(() => {
    getAdminPlans().then(r => {
      const list = r.data.plans || [];
      setPlans(list);
      const free = list.find(p => p.name === 'free');
      if (free) setPlanId(String(free.id));
    }).catch(() => {});
    getAdminAgents().then(r => setAgentOptions(r.data.agents || [])).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) {
      toast.error('Name and email are required.');
      return;
    }
    if (password && password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    // Paid plans require an expiry date (free never expires) — bug #34.
    const selIsFree = plans.find(p => p.id === parseInt(planId))?.name === 'free';
    if (planId && !selIsFree && !planExpiry) {
      toast.error('Please set a plan expiry date for paid plans.');
      return;
    }
    setCreating(true);
    try {
      const res = await createManualCustomer({
        name: name.trim(),
        email: email.trim(),
        password: password || undefined,
        domain: domain.trim() || undefined,
        plan_id: planId ? Number(planId) : undefined,
        plan_expiry: planId && planExpiry ? planExpiry : undefined,
        needs_onboarding: needsOnboarding,
        onboarding_agent_id: needsOnboarding && onboardingAgentId ? Number(onboardingAgentId) : undefined,
        send_setup_email: sendEmail,
      });
      const onboarded = res.data.onboarding_ticket_id;
      const credLine = password
        ? ' Password set — share it with the customer directly.'
        : sendEmail ? ' Setup-link email sent.' : ' No email sent (admin opted out).';
      toast.success(`Customer created${onboarded ? ` · onboarding ticket #${onboarded}` : ''}.${credLine}`, { duration: 5000 });
      onCreated?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create customer');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100 sticky top-0 bg-white">
          <div className="flex items-center gap-3">
            <UserCheck className="w-5 h-5 text-blue-500" />
            <h2 className="text-lg font-bold text-gray-800">Add Customer</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-4">
          <p className="text-xs text-gray-500 -mt-1">Create a portal account directly — for customers who aren't in your billing app yet (trials, manually-acquired accounts, etc.).</p>

          <div>
            <label className="text-xs font-semibold text-gray-700 block mb-1">Full Name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required disabled={creating}
              placeholder="Jane Doe"
              className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-700 block mb-1">Email *</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required disabled={creating}
              placeholder="jane@company.com"
              className="input w-full text-sm" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-700 block mb-1">
              Initial Password <span className="font-normal text-gray-400">(optional · leave blank to send setup link)</span>
            </label>
            <input type="text" value={password} onChange={e => setPassword(e.target.value)} disabled={creating}
              placeholder="At least 8 characters"
              className="input w-full text-sm font-mono" />
            <p className="text-[11px] text-gray-500 mt-1">
              {password
                ? 'Account will be ready immediately. Share this password with the customer over a secure channel.'
                : 'A one-time setup link (24h valid) will be emailed instead — the customer picks their own password.'}
            </p>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-700 block mb-1">Company Domain <span className="font-normal text-gray-400">(optional)</span></label>
            <input type="text" value={domain} onChange={e => setDomain(e.target.value)} disabled={creating}
              placeholder="company.com"
              className="input w-full text-sm" />
          </div>
          {(() => {
            const selectedPlanIsFree = plans.find(p => p.id === parseInt(planId))?.name === 'free';
            return (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-gray-700 block mb-1">Plan</label>
                  <select value={planId} onChange={e => setPlanId(e.target.value)} disabled={creating} className="input w-full text-sm">
                    {plans
                      .filter(p => p.is_active !== 0)
                      .map(p => <option key={p.id} value={p.id}>{p.name.charAt(0).toUpperCase() + p.name.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-700 block mb-1">
                    Plan Expiry {!selectedPlanIsFree && <span className="text-red-500">*</span>}
                  </label>
                  {selectedPlanIsFree ? (
                    <p className="text-[11px] text-gray-500 italic pt-2">Free plan never expires.</p>
                  ) : (
                    <input type="date" required value={planExpiry} onChange={e => setPlanExpiry(e.target.value)} disabled={creating || !planId} className="input w-full text-sm" />
                  )}
                </div>
              </div>
            );
          })()}

          {/* Onboarding toggle — mirrors the import flow. Off by default. */}
          <div className={`p-3 rounded-xl border ${needsOnboarding ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={needsOnboarding} onChange={e => setNeedsOnboarding(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <div className="flex-1 text-sm">
                <p className="font-semibold text-gray-800">Open an onboarding ticket for this customer</p>
                <p className="text-xs text-gray-600 mt-0.5">Check this for new customers who need email setup (Google Workspace / M365 / Zoho). An onboarding ticket will be auto-opened and assigned to an agent.</p>
              </div>
            </label>
            {needsOnboarding && (
              <div className="mt-3 pl-7">
                <label className="text-xs font-semibold text-gray-700 mb-1 block">Assign onboarding to</label>
                <select value={onboardingAgentId} onChange={e => setOnboardingAgentId(e.target.value)} className="input text-sm w-full">
                  <option value="">Auto-assign (least loaded)</option>
                  {agentOptions.map(a => (<option key={a.id} value={a.id}>{a.name} {a.role === 'admin' ? '(admin)' : ''}</option>))}
                </select>
              </div>
            )}
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-xl p-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span className="text-sm text-gray-700">Send welcome email <span className="text-xs text-gray-500">(setup link if no password, otherwise login info)</span></span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={creating} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" disabled={creating} className="btn-primary flex items-center gap-1.5">
              {creating
                ? <><RotateCcw className="w-4 h-4 animate-spin" /> Creating…</>
                : <><UserCheck className="w-4 h-4" /> Create Account</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Import Customer Modal ──────────────────────────────────────────────────
function ImportCustomerModal({ onClose, onImported }) {
  const [email, setEmail]       = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound]       = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [importing, setImporting] = useState(false);
  // Default OFF — most imports are of existing customers being migrated. Admin opts in
  // when this is genuinely a brand-new customer who needs the full email-setup flow.
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  // '' means "auto-assign via pickAgent" — anything else is a specific agent's id.
  const [onboardingAgentId, setOnboardingAgentId] = useState('');
  const [agentOptions, setAgentOptions] = useState([]);

  // Load the agent roster once when admin first ticks "needs onboarding". Lazy so we
  // don't pay the round-trip for the common (existing-customer migration) case.
  useEffect(() => {
    if (!needsOnboarding || agentOptions.length) return;
    getAdminAgents()
      .then(res => setAgentOptions((res.data.agents || res.data || []).filter(a => a.role === 'agent' || a.role === 'admin')))
      .catch(() => {});
  }, [needsOnboarding, agentOptions.length]);

  const handleSearch = async () => {
    if (!email.trim()) return;
    setSearching(true);
    setFound(null);
    setNotFound(false);
    try {
      const res = await lookupBillingCustomer({ email: email.trim() });
      setFound(res.data.customer);
    } catch (err) {
      if (err.response?.status === 404) setNotFound(true);
      else toast.error(err.response?.data?.error || 'Search failed — check the billing app URL in Settings');
    } finally { setSearching(false); }
  };

  const handleImport = async () => {
    if (!found) return;
    setImporting(true);
    try {
      const res = await importBillingCustomer({
        ...found,
        needs_onboarding: needsOnboarding,
        onboarding_agent_id: needsOnboarding && onboardingAgentId ? Number(onboardingAgentId) : null,
      });
      const created = res.data.action === 'created';
      const ticketId = res.data.onboarding_ticket_id;
      const agent = res.data.assigned_agent?.name;
      toast.success(
        created
          ? (ticketId
              ? `Account created · Onboarding ticket #${ticketId} → ${agent || 'agent'} · Setup email sent`
              : 'Account created · Setup email sent')
          : 'Customer account updated from billing app',
        { duration: 5000 }
      );
      onImported();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Import failed');
    } finally { setImporting(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-blue-500" />
            <h2 className="text-lg font-bold text-gray-800">Import Customer</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X className="w-4 h-4" /></button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-gray-500">
            Search your billing app for a customer by email and create their support portal account.
          </p>

          <div>
            <label className="label">Customer Email</label>
            <div className="flex gap-2">
              <input
                type="email"
                className="input flex-1"
                placeholder="customer@company.com"
                value={email}
                onChange={e => { setEmail(e.target.value); setFound(null); setNotFound(false); }}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                autoFocus
              />
              <button
                onClick={handleSearch}
                disabled={searching || !email.trim()}
                className="btn-secondary flex items-center gap-1.5 whitespace-nowrap"
              >
                {searching
                  ? <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                  : <Search className="w-4 h-4" />
                }
                Search
              </button>
            </div>
          </div>

          {notFound && (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
              No customer found with that email in your billing app.
            </div>
          )}

          {found && (
            <>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2">
                <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-2">Found in billing app</p>
                <div className="grid grid-cols-2 gap-y-1.5 text-sm">
                  <div><span className="text-gray-500">Name </span><span className="font-medium text-gray-800">{found.name}</span></div>
                  <div><span className="text-gray-500">Email </span><span className="font-medium text-gray-800">{found.email}</span></div>
                  <div><span className="text-gray-500">Domain </span><span className="font-medium text-gray-800">{found.domain || '—'}</span></div>
                  <div><span className="text-gray-500">Billing ID </span><span className="font-medium text-gray-800 font-mono">{found.billing_customer_id || '—'}</span></div>
                </div>
                {found.subscriptions?.length > 0 && (
                  <div className="pt-2 mt-2 border-t border-blue-100">
                    <p className="text-xs font-semibold text-blue-700 uppercase tracking-wide mb-1">Products ({found.subscriptions.length})</p>
                    <div className="space-y-1">
                      {found.subscriptions.slice(0, 4).map((s, i) => (
                        <div key={i} className="text-xs text-gray-600 flex justify-between gap-2">
                          <span className="truncate">{s.name}{s.seats ? ` · ${s.seats} seats` : ''}</span>
                          {s.renewal_date && <span className="text-gray-400 whitespace-nowrap">renews {new Date(s.renewal_date).toLocaleDateString('en-IN')}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-400 -mt-1">
                The support tier (Free / Basic / Moderate / Premium) is set inside the panel after import — it isn't taken from the billing app.
              </p>

              {/* Onboarding toggle — off by default. Most imports are existing customers
                  being migrated; only check this for genuinely-new signups that need
                  the email-setup workflow (creates a ticket + assigns an agent). */}
              <div className={`p-3 rounded-xl border ${needsOnboarding ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={needsOnboarding}
                    onChange={e => setNeedsOnboarding(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <div className="flex-1 text-sm">
                    <p className="font-semibold text-gray-800">This customer needs onboarding setup</p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      Check this for <strong>new customers</strong> who need email setup (Google Workspace / M365 / Zoho).
                      An onboarding ticket will be auto-opened, assigned to an agent, and referenced in the welcome email.
                    </p>
                    <p className="text-xs text-gray-500 mt-1">Leave unchecked for existing customers just being migrated to the portal.</p>
                  </div>
                </label>

                {/* Agent picker — only when the box is ticked. Empty = auto-assign via pickAgent. */}
                {needsOnboarding && (
                  <div className="mt-3 pl-7">
                    <label className="text-xs font-semibold text-gray-700 mb-1 block">Assign onboarding to</label>
                    <select
                      value={onboardingAgentId}
                      onChange={e => setOnboardingAgentId(e.target.value)}
                      className="input text-sm w-full"
                    >
                      <option value="">Auto-assign (least loaded available agent)</option>
                      {agentOptions.length === 0 ? <option disabled>Loading agents…</option> : null}
                      {agentOptions.map(a => (
                        <option key={a.id} value={a.id}>{a.name} {a.role === 'admin' ? '(admin)' : ''}</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 mt-1">
                      Leave on auto-assign unless you want a specific agent (e.g. their account manager) on this onboarding.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          {found && (
            <button onClick={handleImport} disabled={importing} className="btn-primary flex items-center gap-1.5">
              {importing
                ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : <><UserPlus className="w-4 h-4" /> Create Account</>
              }
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

// Read the URL deep-link params ONCE at module-eval time so the initial state
// reflects them on first render — avoids the "list flashes unfiltered then
// refilters" race when a useEffect tries to apply them post-mount.
function readUrlPlanParam() {
  if (typeof window === 'undefined') return '';
  const p = (new URLSearchParams(window.location.search).get('plan') || '').toLowerCase();
  return ['free', 'basic', 'moderate', 'premium'].includes(p) ? p : '';
}
function readUrlFocusParam() {
  if (typeof window === 'undefined') return null;
  const f = parseInt(new URLSearchParams(window.location.search).get('focus') || '', 10);
  return f || null;
}

export default function AdminCustomers() {
  const [customers, setCustomers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  // planFilter seeded from ?plan= so the very first load() fetches the right
  // slice instead of flashing the full list then refiltering.
  const [planFilter, setPlanFilter] = useState(readUrlPlanParam);
  const [page, setPage] = useState(1);
  // Rows-per-page persists across refreshes so an admin who prefers 100 rows
  // doesn't have to re-pick it every time. Stored as a string in localStorage;
  // coerced back to a number on read. Defaults to 20 (the previous hard-coded value).
  const [pageSize, setPageSize] = useState(() => readStoredPageSize('dsp_admin_customers_page_size'));
  const [loading, setLoading] = useState(true);
  // Same trick as planFilter — seed from ?focus= so the detail panel opens on
  // the very first render instead of waiting for a post-mount useEffect.
  const [selectedId, setSelectedId] = useState(readUrlFocusParam);
  const [editCustomer, setEditCustomer] = useState(null);
  const [deleteCust, setDeleteCust] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncBanner, setSyncBanner] = useState(null); // { ok, unsupported, message, stats }

  // Bulk-action selection — IDs of rows the admin has ticked. Held in a Set
  // so toggle/has lookups are O(1); rendered as the visible-page count.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showBulkChangePlan, setShowBulkChangePlan] = useState(false);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Reset selection when the visible page or filter changes — the IDs the
  // admin ticked might not even be on screen anymore, so it's cleaner to
  // start fresh than to leak a selection across pages.
  const toggleOne = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllOnPage = () => setSelectedIds(prev => {
    const allOnPage = customers.map(c => c.id);
    const allSelected = allOnPage.every(id => prev.has(id));
    const next = new Set(prev);
    if (allSelected) allOnPage.forEach(id => next.delete(id));
    else allOnPage.forEach(id => next.add(id));
    return next;
  });
  const clearSelection = () => setSelectedIds(new Set());

  const load = useCallback(() => {
    setLoading(true);
    getAdminCustomers({ search: search || undefined, plan: planFilter || undefined, page, limit: pageSize })
      .then(res => { setCustomers(res.data.customers); setTotal(res.data.total); })
      .catch(() => toast.error('Failed to load'))
      .finally(() => setLoading(false));
  }, [search, planFilter, page, pageSize]);

  const handleSyncAll = async () => {
    setSyncingAll(true);
    setSyncBanner(null);
    try {
      const res = await triggerBillingSync();
      const { created = 0, updated = 0, total = 0, errors = 0 } = res.data;
      setSyncBanner({ ok: true, stats: { created, updated, total, errors } });
      toast.success(`Synced — ${created} created, ${updated} updated`);
      load();
    } catch (err) {
      if (err.response?.status === 501 || err.response?.data?.code === 'list_unsupported') {
        setSyncBanner({ unsupported: true, message: err.response.data.error });
      } else {
        toast.error(err.response?.data?.error || 'Sync failed');
      }
    } finally { setSyncingAll(false); }
  };

  useEffect(() => {
    getAdminPlans().then(res => setPlans(res.data.plans));
  }, []);

  useEffect(() => { load(); }, [load]);

  useGlobalRefresh(load);

  // ?focus= and ?plan= state are already seeded into useState above. This
  // effect just CLEANS those params out of the URL on first mount so a
  // refresh doesn't keep haunting state changes — e.g. if admin closes the
  // detail panel after a ?focus= link, refresh would re-open it.
  const [searchParamsCust, setSearchParamsCust] = useSearchParams();
  const urlCleanedRef = useRef(false);
  useEffect(() => {
    if (urlCleanedRef.current) return;
    let dirty = false;
    if (searchParamsCust.has('focus'))  { searchParamsCust.delete('focus'); dirty = true; }
    if (searchParamsCust.has('plan'))   { searchParamsCust.delete('plan');  dirty = true; }
    urlCleanedRef.current = true;
    if (dirty) setSearchParamsCust(searchParamsCust, { replace: true });
  }, [searchParamsCust, setSearchParamsCust]);

  const runBulkAction = async (action, params = {}, confirmMsg = null) => {
    if (!selectedIds.size) return;
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBulkBusy(true);
    try {
      const r = await bulkCustomerAction({
        customer_ids: [...selectedIds],
        action,
        params,
      });
      const { succeeded, failed } = r.data.summary || {};
      if (failed > 0) {
        toast(`${succeeded} succeeded · ${failed} failed`, { icon: '⚠️', duration: 5000 });
      } else {
        const verb = action === 'reset-usage'      ? 'Usage reset for'
                   : action === 'resend-welcome'   ? 'Welcome email re-sent to'
                   : action === 'change-plan'      ? 'Plan changed for'
                   : action === 'delete'           ? 'Deleted'
                   : 'Updated';
        toast.success(`${verb} ${succeeded} customer${succeeded === 1 ? '' : 's'}`);
      }
      clearSelection();
      if (action === 'delete' || action === 'change-plan' || action === 'reset-usage') load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bulk action failed');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Customers</h1>
          <p className="text-sm text-gray-500 mt-0.5">{total} total customers</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowManual(true)} className="btn-primary flex items-center gap-1.5">
            <UserCheck className="w-4 h-4" /> Add Customer
          </button>
          <button onClick={() => setShowBulkImport(true)} className="btn-secondary flex items-center gap-1.5" title="Upload a CSV to bulk-create customer accounts">
            <FileUp className="w-4 h-4" /> Bulk Import (CSV)
          </button>
          <button onClick={() => setShowImport(true)} className="btn-secondary flex items-center gap-1.5">
            <UserPlus className="w-4 h-4" /> Import from Billing
          </button>
          <button onClick={handleSyncAll} disabled={syncingAll} className="btn-secondary flex items-center gap-1.5" title="Pull every customer from your billing app in one click">
            {syncingAll
              ? <><span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" /> Syncing…</>
              : <><UsersRound className="w-4 h-4" /> Sync all from Billing</>}
          </button>
          <button onClick={load} className="btn-secondary p-2 hidden lg:inline-flex"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Sync-all result / guidance banner */}
      {syncBanner && (
        <div className={`card p-4 mb-4 flex items-start gap-3 ${syncBanner.unsupported ? 'border-amber-200 bg-amber-50' : 'border-green-200 bg-green-50'}`}>
          {syncBanner.unsupported
            ? <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            : <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0 text-sm">
            {syncBanner.unsupported ? (
              <>
                <p className="font-semibold text-amber-800">Can't sync all yet — billing app has no "list customers" endpoint</p>
                <p className="text-amber-700 mt-0.5">{syncBanner.message}</p>
              </>
            ) : (
              <p className="text-green-800">
                <span className="font-semibold">Sync complete.</span>{' '}
                {syncBanner.stats.created} created · {syncBanner.stats.updated} updated
                {syncBanner.stats.total ? ` · ${syncBanner.stats.total} in billing` : ''}
                {syncBanner.stats.errors ? ` · ${syncBanner.stats.errors} errors` : ''}
              </p>
            )}
          </div>
          <button onClick={() => setSyncBanner(null)} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X className="w-4 h-4" /></button>
        </div>
      )}

      {/* Filters */}
      <div className="card p-4 mb-4 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            className="input pl-9 pr-9"
            placeholder="Search name, email, domain, tag… (type ‘billing’ for billing-linked)"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(''); setPage(1); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              title="Clear search"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <select className="input w-auto" value={planFilter} onChange={e => { setPlanFilter(e.target.value); setPage(1); }}>
          <option value="">All Plans</option>
          {plans.map(p => <option key={p.id} value={p.name}>{p.name.charAt(0).toUpperCase() + p.name.slice(1)}</option>)}
        </select>
      </div>

      {/* Layout: full-width table by default; when a customer is selected the
          layout flips to a narrow rail (1/4) + wide detail (3/4), mirroring
          Zoho Books' customer-detail screen. */}
      <div className={selectedId ? 'grid grid-cols-1 lg:grid-cols-4 gap-4' : ''}>
        {/* Table — full width by default, narrow rail when a customer is open.
            On mobile the two-pane doesn't fit, so when a customer is selected we
            hide the list entirely (drill-in): only the detail shows, and its
            close (X) acts as "back to list". Desktop keeps the side-by-side rail. */}
        <div className={`card overflow-hidden ${selectedId ? 'hidden lg:block lg:col-span-1' : ''}`}>
          {loading ? (
            <div className="flex items-center justify-center h-48">
              <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : customers.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400">
              <p className="text-sm">No customers found</p>
            </div>
          ) : (
            <>
              {/* Sticky bulk-action bar — replaces the column header when 1+ rows are selected */}
              {selectedIds.size > 0 && (
                <div className="bg-blue-50 border-b border-blue-200 px-4 py-2.5 flex items-center gap-2 flex-wrap sticky top-0 z-10">
                  <span className="text-sm font-medium text-blue-700">
                    {selectedIds.size} selected
                  </span>
                  <span className="text-xs text-blue-400">·</span>
                  <button
                    onClick={() => runBulkAction('reset-usage', {}, `Reset monthly usage counters for ${selectedIds.size} customer${selectedIds.size === 1 ? '' : 's'}?`)}
                    disabled={bulkBusy}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-white text-amber-700 hover:bg-amber-50 border border-amber-200 transition-colors disabled:opacity-50"
                    title="Zero out the tickets / chats / calls counters for the current month"
                  >
                    <RotateCcw className={`w-3.5 h-3.5 ${bulkBusy ? 'animate-spin' : ''}`} /> Reset Usage
                  </button>
                  <button
                    onClick={() => runBulkAction('resend-welcome', {}, `Re-send the welcome (password setup) email to ${selectedIds.size} customer${selectedIds.size === 1 ? '' : 's'}?`)}
                    disabled={bulkBusy}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-white text-blue-700 hover:bg-blue-50 border border-blue-200 transition-colors disabled:opacity-50"
                    title="Mint a new 24h setup link and email it"
                  >
                    <Mail className="w-3.5 h-3.5" /> Resend Welcome
                  </button>
                  <button
                    onClick={() => setShowBulkChangePlan(true)}
                    disabled={bulkBusy}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-white text-purple-700 hover:bg-purple-50 border border-purple-200 transition-colors disabled:opacity-50"
                  >
                    <CreditCard className="w-3.5 h-3.5" /> Change Plan
                  </button>
                  <button
                    onClick={() => setShowBulkDelete(true)}
                    disabled={bulkBusy}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium bg-white text-red-700 hover:bg-red-50 border border-red-200 transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                  <button
                    onClick={clearSelection}
                    className="ml-auto text-xs text-gray-500 hover:text-gray-800 px-2 py-1"
                  >
                    Clear selection
                  </button>
                </div>
              )}

              {/* overflow-x-auto lets the full-column table scroll sideways on
                  phones instead of overflowing the card; min-w only kicks in on
                  mobile when all columns are shown (desktop is w-full, unchanged). */}
              <div className="overflow-x-auto">
              <table className={clsx('w-full', !selectedId && 'min-w-[760px] lg:min-w-0')}>
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="w-10 px-4 py-3">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 cursor-pointer"
                        checked={customers.length > 0 && customers.every(c => selectedIds.has(c.id))}
                        ref={el => { if (el) el.indeterminate = customers.some(c => selectedIds.has(c.id)) && !customers.every(c => selectedIds.has(c.id)); }}
                        onChange={toggleAllOnPage}
                        title="Select all on this page"
                      />
                    </th>
                    {!selectedId && (
                      <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-16">ID</th>
                    )}
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                    {!selectedId && (
                      <>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Domain</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Plan</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Expiry</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {customers.map(c => {
                    // Canonical plan status (shared with the customer panel).
                    const { active, noExpirySet } = planView(c);
                    const synced = Boolean(c.billing_customer_id);
                    const isChecked = selectedIds.has(c.id);
                    return (
                      <tr
                        key={c.id}
                        className={`cursor-pointer transition-colors ${selectedId === c.id ? 'bg-blue-50' : isChecked ? 'bg-blue-50/40' : 'hover:bg-gray-50'}`}
                        onClick={() => setSelectedId(c.id)}
                      >
                        <td className="px-4 py-3 align-top" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 cursor-pointer"
                            checked={isChecked}
                            onChange={() => toggleOne(c.id)}
                          />
                        </td>
                        {!selectedId && (
                          <td className="px-4 py-3 text-xs text-gray-500 font-mono">#{c.id}</td>
                        )}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                            {synced && !selectedId && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] bg-blue-50 text-blue-600 border border-blue-200 px-1.5 py-0.5 rounded-full">
                                <Link className="w-2.5 h-2.5" /> Billing
                              </span>
                            )}
                          </div>
                          {/* In narrow-rail mode, surface a single subtitle line —
                              plan name + expiry — since the dedicated columns are hidden. */}
                          {selectedId && (
                            <p className="text-xs text-gray-400 mt-0.5 capitalize truncate">
                              {c.plan_name || 'no plan'}
                              {c.plan_name === 'free'
                                ? ' · never expires'
                                : (c.plan_expiry ? ` · expires ${new Date(c.plan_expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : '')}
                            </p>
                          )}
                        </td>
                        {!selectedId && (
                          <>
                            <td className="px-4 py-3 text-xs text-gray-600 font-mono">{c.email || '—'}</td>
                            <td className="px-4 py-3 text-xs text-gray-500">{c.domain || '—'}</td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <PlanBadge plan={c.plan_name} />
                                {!active && c.plan_expiry && <StatusBadge isActive={false} expiry={c.plan_expiry} />}
                                {noExpirySet && (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[10px] bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium"
                                    title="Paid plan with no expiry date set — open the detail page and set an expiry date."
                                  >
                                    <AlertTriangle className="w-2.5 h-2.5" /> Expiry not set
                                  </span>
                                )}
                                {c.missing_payment_proof && (
                                  <span
                                    className="inline-flex items-center gap-0.5 text-[10px] bg-amber-50 text-amber-800 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium"
                                    title="Paying customer with no transaction ID on file — open the detail page and click 'Record Proof' to backfill."
                                  >
                                    <AlertTriangle className="w-2.5 h-2.5" /> No proof
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-500">
                              {c.plan_name === 'free'
                                ? <span className="text-emerald-600">Never</span>
                                : (c.plan_expiry ? new Date(c.plan_expiry).toLocaleDateString('en-IN') : '—')}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {/* Pagination */}
              <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500 flex-wrap gap-y-2">
                <span>Showing {total === 0 ? 0 : (page-1)*pageSize + 1}–{Math.min(page*pageSize, total)} of {total}</span>
                <div className="flex items-center gap-4">
                  <RowsPerPageSelect
                    value={pageSize}
                    onChange={(n) => { setPageSize(n); setPage(1); }}
                    storageKey="dsp_admin_customers_page_size"
                  />
                  <div className="flex items-center gap-2">
                    <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1} className="btn-secondary py-1 text-xs">Prev</button>
                    <button onClick={() => setPage(p => p+1)} disabled={page * pageSize >= total} className="btn-secondary py-1 text-xs">Next</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Detail panel — only rendered when a customer is open. The empty-state
            placeholder is gone; the table takes the whole row when nothing is
            selected (Zoho-style default). */}
        {selectedId && (
          <div className="lg:col-span-3">
            <CustomerDetail
              key={selectedId}
              customerId={selectedId}
              plans={plans}
              onEdit={setEditCustomer}
              onDelete={setDeleteCust}
              onClose={() => setSelectedId(null)}
              onTagClick={(t) => { setSearch(t); setPage(1); }}
            />
          </div>
        )}
      </div>

      {editCustomer && (
        <EditModal
          customer={editCustomer}
          plans={plans}
          onClose={() => setEditCustomer(null)}
          onSave={() => { setEditCustomer(null); load(); }}
        />
      )}

      {showImport && (
        <ImportCustomerModal
          onClose={() => setShowImport(false)}
          onImported={load}
        />
      )}
      {deleteCust && (
        <DeleteCustomerModal
          customer={deleteCust}
          onClose={() => setDeleteCust(null)}
          onDeleted={() => { setDeleteCust(null); setSelectedId(null); load(); }}
        />
      )}
      {showManual && (
        <ManualCustomerModal
          onClose={() => setShowManual(false)}
          onCreated={load}
        />
      )}
      {showBulkImport && (
        <BulkImportModal
          plans={plans}
          onClose={() => setShowBulkImport(false)}
          onImported={load}
        />
      )}
      {showBulkChangePlan && (
        <BulkChangePlanModal
          plans={plans}
          count={selectedIds.size}
          busy={bulkBusy}
          onClose={() => setShowBulkChangePlan(false)}
          onConfirm={async (planId, planExpiry) => {
            await runBulkAction('change-plan', { plan_id: planId, plan_expiry: planExpiry || null });
            setShowBulkChangePlan(false);
          }}
        />
      )}
      {showBulkDelete && (
        <BulkDeleteConfirmation
          count={selectedIds.size}
          busy={bulkBusy}
          onClose={() => setShowBulkDelete(false)}
          onConfirm={async () => {
            await runBulkAction('delete');
            setShowBulkDelete(false);
          }}
        />
      )}
    </Layout>
  );
}

// Two-step delete for customers. Their data is destroyed — tickets, chats, calls,
// usage rows, the user account itself. Admin types the email to confirm.
function DeleteCustomerModal({ customer, onClose, onDeleted }) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const canConfirm = confirmText.trim().toLowerCase() === (customer.email || '').toLowerCase();

  const submit = async () => {
    setDeleting(true);
    try {
      const res = await deleteAdminCustomer(customer.id);
      const d = res.data.deleted;
      toast.success(`Removed ${customer.name}. Deleted ${d.tickets} ticket(s), ${d.chats} chat(s), ${d.calls} call(s).`, { duration: 6000 });
      onDeleted?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete customer');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-100 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-500" />
          </div>
          <div className="flex-1">
            <h2 className="font-semibold text-gray-800">Delete customer</h2>
            <p className="text-xs text-gray-500 mt-0.5">This destroys all their data permanently.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
            <p className="font-medium mb-1">{customer.name} &lt;{customer.email}&gt;</p>
            <p className="text-xs">All of this customer's <strong>tickets, chats, calls, attachments, and usage history</strong> will be permanently deleted. The account will be unable to log in immediately. This cannot be undone.</p>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-700 block mb-1">Type the customer's email to confirm</label>
            <input
              type="text"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder={customer.email}
              autoFocus
              className="input w-full text-sm font-mono"
            />
          </div>
        </div>
        <div className="px-5 py-4 bg-gray-50 rounded-b-2xl flex justify-end gap-2">
          <button onClick={onClose} disabled={deleting} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button
            onClick={submit}
            disabled={!canConfirm || deleting}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4" /> {deleting ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk import modal ──────────────────────────────────────────────────────
// Admin uploads a CSV with columns: name, email, plan (optional), domain (optional).
// We parse client-side so the admin can preview before submitting. Server validates
// + creates accounts row-by-row and returns a per-row outcome we render below.
function BulkImportModal({ plans, onClose, onImported }) {
  const [fileName, setFileName] = useState(null);
  const [rows, setRows] = useState([]);          // parsed rows pending import
  const [parseError, setParseError] = useState(null);
  const [sendEmail, setSendEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);    // server response after import

  const parseCsv = (text) => {
    // Lightweight CSV parser — handles commas, quoted cells, and \r\n.
    // Good enough for the simple format we ask admins to use. Anything fancier
    // (multi-line cells, escaped quotes) is outside scope; admins re-export
    // their sheet as CSV from Excel/Sheets and it lands in this shape.
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim().length);
    if (!lines.length) return { rows: [], error: 'File is empty' };
    const parseLine = (line) => {
      const out = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; continue; }
        if (c === ',' && !inQ) { out.push(cur.trim()); cur = ''; continue; }
        cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    const header = parseLine(lines[0]).map(h => h.toLowerCase());
    const needed = ['name', 'email'];
    const missing = needed.filter(n => !header.includes(n));
    if (missing.length) return { rows: [], error: `Missing required column(s): ${missing.join(', ')}` };
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseLine(lines[i]);
      const row = {};
      header.forEach((h, idx) => { row[h] = cells[idx] || ''; });
      if (!row.name && !row.email) continue;   // skip blank lines
      out.push(row);
    }
    return { rows: out, error: null };
  };

  const handleFile = (file) => {
    setParseError(null);
    setResult(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const { rows: parsed, error } = parseCsv(String(e.target.result || ''));
      if (error) { setParseError(error); setRows([]); return; }
      // Server caps each import at 500 rows. Catch it on the client so the
      // admin doesn't waste a click hitting Import only to get a late 400.
      if (parsed.length > 500) {
        setParseError(`This file has ${parsed.length.toLocaleString()} rows — the per-import cap is 500. Split it into smaller batches and try again.`);
        setRows([]);
        return;
      }
      setRows(parsed);
    };
    reader.onerror = () => setParseError('Could not read the file');
    reader.readAsText(file);
  };

  const downloadTemplate = () => {
    const csv = 'name,email,plan,domain\nAcme Pvt Ltd,billing@acme.com,basic,acme.com\nGamma Corp,hello@gamma.io,premium,gamma.io\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'customers-template.csv';
    a.click(); URL.revokeObjectURL(url);
  };

  const submit = async () => {
    if (!rows.length) return;
    setSubmitting(true);
    try {
      const r = await bulkImportCustomers({ rows, send_setup_email: sendEmail });
      setResult(r.data);
      const { created, skipped, failed } = r.data.summary || {};
      if (created > 0) toast.success(`${created} customer${created === 1 ? '' : 's'} created${skipped ? ` · ${skipped} skipped` : ''}${failed ? ` · ${failed} failed` : ''}`);
      else if (skipped > 0) toast(`All ${skipped} row(s) skipped — already existed`, { icon: '⚠️' });
      else toast.error(`Import failed — see details below`);
      if (created > 0) onImported?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bulk import failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <FileUp className="w-5 h-5 text-blue-500" />
            Bulk Import Customers
          </h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          {!result ? (
            <>
              <p className="text-sm text-gray-600">
                Upload a CSV with columns: <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">name</code>, <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">email</code>, <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">plan</code> (optional — free/basic/moderate/premium), <code className="bg-gray-100 px-1 py-0.5 rounded text-xs">domain</code> (optional). Up to 500 rows per import.
              </p>
              <button onClick={downloadTemplate} className="text-xs text-blue-600 hover:underline">
                Download a template CSV
              </button>

              <div>
                <label className="block">
                  <div className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${rows.length ? 'border-green-300 bg-green-50' : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'}`}>
                    <FileUp className="w-8 h-8 mx-auto text-gray-400 mb-2" />
                    {fileName ? (
                      <>
                        <p className="text-sm font-medium text-gray-700">{fileName}</p>
                        <p className="text-xs text-gray-500 mt-1">{rows.length} row(s) ready to import — click to choose a different file</p>
                      </>
                    ) : (
                      <p className="text-sm text-gray-600">Click to select a CSV file</p>
                    )}
                  </div>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
                  />
                </label>
              </div>

              {parseError && (
                <div className="bg-red-50 text-red-700 text-sm px-3 py-2 rounded border border-red-200 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" /> {parseError}
                </div>
              )}

              {rows.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-600 mb-2">Preview ({Math.min(rows.length, 5)} of {rows.length})</p>
                  <div className="border border-gray-200 rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-gray-600">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">Name</th>
                          <th className="px-3 py-2 text-left font-medium">Email</th>
                          <th className="px-3 py-2 text-left font-medium">Plan</th>
                          <th className="px-3 py-2 text-left font-medium">Domain</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {rows.slice(0, 5).map((r, i) => (
                          <tr key={i}>
                            <td className="px-3 py-2 text-gray-700">{r.name || <span className="text-red-500">—</span>}</td>
                            <td className="px-3 py-2 text-gray-700 font-mono text-[11px]">{r.email || <span className="text-red-500">—</span>}</td>
                            <td className="px-3 py-2 text-gray-500">{r.plan || <span className="text-gray-300">(none)</span>}</td>
                            <td className="px-3 py-2 text-gray-500">{r.domain || <span className="text-gray-300">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={e => setSendEmail(e.target.checked)}
                  className="rounded"
                />
                Send a welcome email with a 24-hour password setup link to each new customer
              </label>
            </>
          ) : (
            <>
              {/* Results screen */}
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                  <CheckCircle2 className="w-6 h-6 text-green-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-green-700">{result.summary.created}</p>
                  <p className="text-xs text-gray-600 mt-0.5">Created</p>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center">
                  <SkipForward className="w-6 h-6 text-amber-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-amber-700">{result.summary.skipped}</p>
                  <p className="text-xs text-gray-600 mt-0.5">Skipped (already exist)</p>
                </div>
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
                  <XCircle className="w-6 h-6 text-red-500 mx-auto mb-1" />
                  <p className="text-2xl font-bold text-red-700">{result.summary.failed}</p>
                  <p className="text-xs text-gray-600 mt-0.5">Failed</p>
                </div>
              </div>

              <div>
                <p className="text-xs font-medium text-gray-600 mb-2">Per-row outcome</p>
                <div className="border border-gray-200 rounded-lg overflow-hidden max-h-80 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-gray-600 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium w-10">#</th>
                        <th className="px-3 py-2 text-left font-medium">Email</th>
                        <th className="px-3 py-2 text-left font-medium">Status</th>
                        <th className="px-3 py-2 text-left font-medium">Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {result.rows.map(r => (
                        <tr key={r.row}>
                          <td className="px-3 py-2 text-gray-400">{r.row}</td>
                          <td className="px-3 py-2 font-mono text-[11px]">{r.email}</td>
                          <td className="px-3 py-2">
                            {r.status === 'created'  && <span className="text-green-600 font-medium flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Created</span>}
                            {r.status === 'skipped' && <span className="text-amber-600 font-medium flex items-center gap-1"><SkipForward className="w-3.5 h-3.5" /> Skipped</span>}
                            {r.status === 'failed'  && <span className="text-red-600 font-medium flex items-center gap-1"><XCircle className="w-3.5 h-3.5" /> Failed</span>}
                          </td>
                          <td className="px-3 py-2 text-gray-500">{r.error || (r.plan ? `plan: ${r.plan}` : '')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={submit}
              disabled={!rows.length || submitting}
              className="btn-primary"
            >
              {submitting ? 'Importing…' : `Import ${rows.length} customer${rows.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Bulk change-plan modal ───────────────────────────────────────────────
// Pick a target plan + optional new expiry date, hit Confirm. The parent
// component does the actual API call via runBulkAction('change-plan', ...).
function BulkChangePlanModal({ plans, count, busy, onClose, onConfirm }) {
  const [planId, setPlanId] = useState('');
  const [planExpiry, setPlanExpiry] = useState('');

  const submit = () => {
    if (!planId) { toast.error('Pick a plan to switch them to'); return; }
    onConfirm(Number(planId), planExpiry);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-purple-500" />
            Change Plan ({count})
          </h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            Move <strong>{count} customer{count === 1 ? '' : 's'}</strong> to a new plan. Their existing usage counters stay as-is — if you also want to reset usage, do that separately.
          </p>
          <div>
            <label className="label">Target plan</label>
            <select className="input" value={planId} onChange={e => setPlanId(e.target.value)}>
              <option value="">Pick a plan…</option>
              {plans.filter(p => p.is_active !== 0).map(p => (
                <option key={p.id} value={p.id}>{p.name.charAt(0).toUpperCase() + p.name.slice(1)}</option>
              ))}
            </select>
          </div>
          {plans.find(p => p.id === Number(planId))?.name === 'free' ? (
            <div>
              <label className="label">New expiry date</label>
              <p className="text-xs text-gray-500 italic">Free plan never expires — switching customers to Free will clear their current expiry.</p>
            </div>
          ) : (
            <div>
              <label className="label">New expiry date <span className="text-gray-400 font-normal">(optional)</span></label>
              <input
                type="date"
                className="input"
                value={planExpiry}
                onChange={e => setPlanExpiry(e.target.value)}
              />
              <p className="text-xs text-gray-400 mt-1">Leave blank to keep each customer's existing expiry.</p>
            </div>
          )}
        </div>
        <div className="px-5 py-4 bg-gray-50 rounded-b-2xl flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={busy || !planId} className="btn-primary">
            {busy ? 'Applying…' : 'Apply change'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk delete confirmation ─────────────────────────────────────────────
// Admin types DELETE to confirm — same friction guard as the single-customer
// delete, just scaled to a count instead of one named customer.
function BulkDeleteConfirmation({ count, busy, onClose, onConfirm }) {
  const [confirmText, setConfirmText] = useState('');
  const canConfirm = confirmText.trim().toUpperCase() === 'DELETE';
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-red-700 flex items-center gap-2">
            <Trash2 className="w-5 h-5" />
            Delete {count} customer{count === 1 ? '' : 's'}?
          </h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              This will permanently remove <strong>{count} customer account{count === 1 ? '' : 's'}</strong> and all their data — tickets, chats, calls, messages, and usage history. <strong>This cannot be undone.</strong>
            </div>
          </div>
          <div>
            <label className="label">Type <span className="font-mono">DELETE</span> to confirm</label>
            <input
              type="text"
              autoFocus
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              className="input font-mono text-sm"
              placeholder="DELETE"
            />
          </div>
        </div>
        <div className="px-5 py-4 bg-gray-50 rounded-b-2xl flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm || busy}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-semibold rounded-lg flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-4 h-4" /> {busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Activity tab — per-customer audit log ────────────────────────────────
// Pulls audit_log entries that target this customer (either entity_type='customer'
// with their customer_id, or entity_type='user' with their user_id — handled
// server-side by the `customer_id` filter on /api/audit).
function ActivityTab({ customerId }) {
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLogs(null); setError(null);
    getAuditLogs({ customer_id: customerId, limit: 100 })
      .then(r => setLogs(r.data.logs || []))
      .catch(err => setError(err.response?.data?.error || 'Could not load activity'));
  }, [customerId]);

  // Human-friendly labels for the raw action strings. Anything not in the
  // map renders as the underscored action verbatim — fine for new actions
  // until someone gets around to adding a label.
  const LABELS = {
    password_changed:           { label: 'Password changed by admin',                 icon: KeyRound,   color: 'text-blue-600' },
    password_changed_self:      { label: 'Password changed by customer (password)',   icon: KeyRound,   color: 'text-emerald-600' },
    password_changed_self_otp:  { label: 'Password changed by customer (email OTP)',  icon: KeyRound,   color: 'text-emerald-600' },
    usage_reset:                { label: 'Usage counters reset',                      icon: RotateCcw,  color: 'text-amber-600'  },
    usage_reset_bulk:           { label: 'Usage reset (bulk action)',                 icon: RotateCcw,  color: 'text-amber-600'  },
    profile_updated:            { label: 'Profile updated',                           icon: UserCheck,  color: 'text-gray-600'   },
    plan_changed_bulk:          { label: 'Plan changed (bulk)',                       icon: CreditCard, color: 'text-purple-600' },
    welcome_email_resent:       { label: 'Welcome email re-sent',                     icon: Mail,       color: 'text-blue-600' },
  };

  if (error) {
    return <div className="text-sm text-red-500 text-center py-8">{error}</div>;
  }
  if (logs == null) {
    return <div className="flex items-center justify-center py-8">
      <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>;
  }
  if (!logs.length) {
    return <div className="text-sm text-gray-400 text-center py-8">
      No activity recorded yet for this customer.
    </div>;
  }
  return (
    <div className="space-y-2">
      {logs.map(l => {
        const meta = LABELS[l.action] || { label: l.action.replace(/_/g, ' '), icon: ShieldAlert, color: 'text-gray-500' };
        const Icon = meta.icon;
        let detail = null;
        try {
          if (l.new_value) {
            const v = JSON.parse(l.new_value);
            if (v.fields?.length)  detail = `fields: ${v.fields.join(', ')}`;
            else if (v.plan_id)     detail = `new plan id: ${v.plan_id}${v.plan_expiry ? ` · expires ${v.plan_expiry}` : ''}`;
            else if (v.month)       detail = `month: ${v.month}`;
          }
        } catch {}
        return (
          <div key={l.id} className="flex items-start gap-3 text-sm bg-gray-50 rounded-lg px-3 py-2.5">
            <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${meta.color}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-gray-800 truncate">{meta.label}</p>
                <p className="text-xs text-gray-400 flex-shrink-0">
                  {new Date(l.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                by <strong className="capitalize">{l.actor_role}</strong> {l.actor_name}
                {detail ? <span className="text-gray-400"> · {detail}</span> : null}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Plan History tab — chronological plan_change_history for one customer ──
// Shows every signup/upgrade/downgrade/renewal/manual_admin/expiry_lapse
// transition with the from→to plan, payment ref, expiry change, and
// (for manual_admin rows) which admin made the change.
function PlanHistoryTab({ customerId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setRows(null); setError(null);
    getCustomerPlanHistory(customerId)
      .then(r => setRows(r.data.items || []))
      .catch(err => setError(err.response?.data?.error || 'Could not load plan history'));
  }, [customerId]);

  const KIND_META = {
    signup:        { label: 'Signed up',         color: 'bg-blue-100 text-blue-700 border-blue-200' },
    upgrade:       { label: 'Upgraded',          color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    downgrade:     { label: 'Downgraded',        color: 'bg-amber-100 text-amber-700 border-amber-200' },
    renewal:       { label: 'Renewed',           color: 'bg-blue-100 text-blue-700 border-blue-200' },
    manual_admin:  { label: 'Admin change',      color: 'bg-purple-100 text-purple-700 border-purple-200' },
    expiry_lapse:  { label: 'Lapsed to Free',    color: 'bg-gray-200 text-gray-700 border-gray-300' },
  };

  if (error) return <div className="text-sm text-red-500 text-center py-8">{error}</div>;
  if (rows == null) {
    return <div className="flex items-center justify-center py-8">
      <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>;
  }
  if (!rows.length) {
    return <div className="text-sm text-gray-400 text-center py-8">
      No plan changes recorded yet for this customer.
    </div>;
  }

  return (
    <div className="space-y-3">
      {rows.map(r => {
        const meta = KIND_META[r.change_kind] || { label: r.change_kind, color: 'bg-gray-100 text-gray-700 border-gray-200' };
        return (
          <div key={r.id} className="bg-white border border-gray-200 rounded-xl p-3 hover:border-gray-300 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`badge text-xs border ${meta.color}`}>{meta.label}</span>
                  <span className="text-sm text-gray-700">
                    {r.from_plan_name ? <><strong className="capitalize">{r.from_plan_name}</strong> → </> : null}
                    <strong className="capitalize text-blue-700">{r.to_plan_name || '—'}</strong>
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {r.amount_paid != null && Number(r.amount_paid) > 0 && (
                    <span>Paid <strong>₹{Number(r.amount_paid).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
                  )}
                  {r.expiry_after && (
                    <span>New expiry: <strong>{new Date(r.expiry_after).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</strong></span>
                  )}
                  {r.payment_ref && (
                    <span className="font-mono text-[10px] text-gray-400">Ref: {r.payment_ref}</span>
                  )}
                  {r.changed_by_name && (
                    <span>by <strong>{r.changed_by_name}</strong></span>
                  )}
                </div>
                {r.note && (
                  <p className="text-[11px] text-gray-400 italic mt-1">{r.note}</p>
                )}
              </div>
              <p className="text-xs text-gray-400 flex-shrink-0 whitespace-nowrap">
                {new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
