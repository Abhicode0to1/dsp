import { useEffect, useState } from 'react';
import Layout from '../../components/common/Layout';
import { getAdminPlans, updateAdminPlan } from '../../services/api';
import { CreditCard, Save, RefreshCw, MessageSquare, Phone, Ticket, Clock, Headphones, AlertCircle, Check } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

// Convert NULL/'' (unlimited) ↔ blank input value
const valOrBlank = (v) => v === null || v === undefined ? '' : String(v);
const blankToNull = (v) => v === '' ? null : Number(v);

function PlanCard({ plan, onSave }) {
  const [form, setForm] = useState({
    price: valOrBlank(plan.price),
    allow_chat: !!plan.allow_chat,
    allow_calls: !!plan.allow_calls,
    allow_email_ticket: !!plan.allow_email_ticket,
    chat_limit: valOrBlank(plan.chat_limit),
    calls_limit: valOrBlank(plan.calls_limit),
    tickets_limit: valOrBlank(plan.tickets_limit),
    sla_response_hours: valOrBlank(plan.sla_response_hours),
    sla_resolve_hours: valOrBlank(plan.sla_resolve_hours),
    agent_can_initiate_call: plan.agent_can_initiate_call === null ? !!plan.allow_calls : !!plan.agent_can_initiate_call,
  });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);

  const update = (k, v) => { setForm(f => ({ ...f, [k]: v })); setDirty(true); };

  // The Active toggle is a separate one-click action (not batched with the
  // Save button) because it has system-wide consequences: deactivating a plan
  // immediately hides it from customer upgrade pickers and admin assign
  // dropdowns. Confirm-before-deactivate prevents misclicks; reactivating is
  // safe and goes through silently.
  const isActive = plan.is_active !== 0;
  const isFreePlan = plan.name === 'free';
  const toggleActive = async () => {
    if (isFreePlan) return; // Free is the default for new customers — can't be turned off.
    if (isActive && !window.confirm(`Disable the ${plan.name} plan?\n\nCustomers currently on it keep their access, but it will be hidden from upgrade pickers and can't be assigned to anyone new until you re-enable it.`)) {
      return;
    }
    setTogglingActive(true);
    try {
      const r = await updateAdminPlan(plan.id, { is_active: isActive ? 0 : 1 });
      onSave(r.data.plan);
      toast.success(isActive ? `${plan.name} plan disabled` : `${plan.name} plan re-enabled`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update plan status');
    } finally { setTogglingActive(false); }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = {
        price: blankToNull(form.price),
        allow_chat: form.allow_chat ? 1 : 0,
        allow_calls: form.allow_calls ? 1 : 0,
        allow_email_ticket: form.allow_email_ticket ? 1 : 0,
        chat_limit: blankToNull(form.chat_limit),
        calls_limit: blankToNull(form.calls_limit),
        tickets_limit: blankToNull(form.tickets_limit),
        sla_response_hours: blankToNull(form.sla_response_hours),
        sla_resolve_hours: blankToNull(form.sla_resolve_hours),
        agent_can_initiate_call: form.agent_can_initiate_call ? 1 : 0,
      };
      const r = await updateAdminPlan(plan.id, body);
      onSave(r.data.plan);
      toast.success(`${plan.name} plan updated — changes apply immediately`);
      setDirty(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const PLAN_COLORS = {
    free:     'border-gray-300 bg-gray-50',
    basic:    'border-blue-300 bg-blue-50/40',
    moderate: 'border-amber-300 bg-amber-50/40',
    premium:  'border-purple-300 bg-purple-50/40',
  };

  return (
    <div className={clsx('rounded-2xl border-2 shadow-sm overflow-hidden', PLAN_COLORS[plan.name] || 'border-gray-200 bg-white', !isActive && 'opacity-60')}>
      <div className="px-5 py-3 border-b border-gray-200 bg-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-gray-600" />
          <h3 className="text-base font-bold text-gray-800 capitalize">{plan.name}</h3>
          {!isActive && <span className="text-[10px] uppercase tracking-wider font-bold text-gray-500 bg-gray-200 px-2 py-0.5 rounded-full">Disabled</span>}
        </div>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-[10px] uppercase tracking-wider font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">Unsaved</span>}
          <button
            type="button"
            onClick={toggleActive}
            disabled={togglingActive || isFreePlan}
            title={isFreePlan
              ? "Free plan can't be disabled — it's the default for new customers"
              : isActive
                ? 'Click to hide & disable this plan'
                : 'Click to re-enable this plan'}
            className={clsx(
              'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
              isActive ? 'bg-emerald-500' : 'bg-gray-300',
              (togglingActive || isFreePlan) && 'opacity-50 cursor-not-allowed',
            )}
            aria-label={isActive ? 'Disable plan' : 'Enable plan'}
          >
            <span
              className={clsx(
                'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
                isActive ? 'translate-x-5' : 'translate-x-1'
              )}
            />
          </button>
        </div>
      </div>

      <div className="p-5 space-y-5 bg-white">
        {/* Price */}
        <div>
          <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide block mb-1.5">Annual price (₹)</label>
          <input
            type="number"
            min={0}
            value={form.price}
            onChange={e => update('price', e.target.value)}
            placeholder="0 (free)"
            className="input text-sm w-full"
          />
        </div>

        {/* Customer-facing features */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Customer features</p>
          <div className="space-y-3">
            <ToggleRow
              icon={MessageSquare}
              label="Allow live chat"
              hint="Customer can initiate live chat from portal"
              checked={form.allow_chat}
              onChange={v => update('allow_chat', v)}
            />
            <ToggleRow
              icon={Phone}
              label="Allow voice calls"
              hint="Customer can initiate calls from portal"
              checked={form.allow_calls}
              onChange={v => update('allow_calls', v)}
            />
            <ToggleRow
              icon={Ticket}
              label="Allow email-to-ticket"
              hint="Customer can raise tickets by emailing support"
              checked={form.allow_email_ticket}
              onChange={v => update('allow_email_ticket', v)}
            />
          </div>
        </div>

        {/* Monthly limits */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Monthly limits <span className="text-gray-400 normal-case">(leave blank = unlimited)</span></p>
          <div className="grid grid-cols-3 gap-2">
            <LimitInput label="Chat /mo"    value={form.chat_limit}    disabled={!form.allow_chat}  onChange={v => update('chat_limit', v)} />
            <LimitInput label="Calls /mo"   value={form.calls_limit}   disabled={!form.allow_calls} onChange={v => update('calls_limit', v)} />
            <LimitInput label="Tickets /mo" value={form.tickets_limit} onChange={v => update('tickets_limit', v)} />
          </div>
        </div>

        {/* SLA */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">SLA (hours)</p>
          <div className="grid grid-cols-2 gap-2">
            <LimitInput label="Response within" value={form.sla_response_hours} onChange={v => update('sla_response_hours', v)} />
            <LimitInput label="Resolve within"  value={form.sla_resolve_hours}  onChange={v => update('sla_resolve_hours', v)} />
          </div>
        </div>

        {/* Agent-side controls */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-1">
            <Headphones className="w-3 h-3" /> Agent controls
          </p>
          <ToggleRow
            icon={Phone}
            label="Agents can initiate calls"
            hint="Agents see a 'Call customer' button on tickets and chats. Off = customer-initiated only."
            checked={form.agent_can_initiate_call}
            disabled={!form.allow_calls}
            disabledHint={!form.allow_calls && '(disabled — calls are off for this plan)'}
            onChange={v => update('agent_can_initiate_call', v)}
          />
        </div>

        {/* Save */}
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className={clsx('w-full flex items-center justify-center gap-1.5 py-2 rounded-lg font-medium text-sm transition-colors', dirty ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-100 text-gray-400')}
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

function ToggleRow({ icon: Icon, label, hint, checked, onChange, disabled, disabledHint }) {
  return (
    <div className={clsx('flex items-start gap-3', disabled && 'opacity-50')}>
      <button
        type="button"
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={clsx(
          'w-9 h-5 rounded-full flex items-center transition-colors flex-shrink-0 mt-0.5',
          checked ? 'bg-indigo-600' : 'bg-gray-300',
          disabled && 'cursor-not-allowed'
        )}
      >
        <span className={clsx('w-3.5 h-3.5 bg-white rounded-full transition-transform shadow-sm', checked ? 'translate-x-[18px]' : 'translate-x-1')} />
      </button>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
          {Icon && <Icon className="w-3.5 h-3.5 text-gray-400" />} {label}
        </p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
        {disabledHint && <p className="text-xs text-amber-600 mt-0.5">{disabledHint}</p>}
      </div>
    </div>
  );
}

function LimitInput({ label, value, onChange, disabled }) {
  return (
    <div>
      <label className="text-[10px] uppercase tracking-wide font-semibold text-gray-500 block mb-1">{label}</label>
      <input
        type="number"
        min={0}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="∞"
        disabled={disabled}
        className={clsx('input text-sm w-full', disabled && 'opacity-50 cursor-not-allowed')}
      />
    </div>
  );
}

export default function AdminPlans() {
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    getAdminPlans()
      .then(r => setPlans(r.data.plans))
      .catch(() => toast.error('Failed to load plans'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useGlobalRefresh(load);

  const handleSavedPlan = (updated) => {
    setPlans(prev => prev.map(p => p.id === updated.id ? updated : p));
  };

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Support Plans</h1>
          <p className="text-sm text-gray-500 mt-0.5">Edit plan limits and features. Changes apply immediately to customer + agent panels.</p>
        </div>
        <button onClick={load} className="hidden lg:inline-flex btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
      </div>

      <div className="mb-5 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 flex items-start gap-2 text-sm text-blue-800">
        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-medium">How it works</p>
          <ul className="text-xs mt-1 space-y-0.5 list-disc list-inside text-blue-700">
            <li>Customer-facing limits (chat, calls, tickets) appear on the customer Billing page automatically.</li>
            <li>Agent eligibility checks (e.g. "Call customer" button) read from the same plan values — no agent-side config needed.</li>
            <li>Per-customer overrides at <span className="font-mono text-[11px]">Customers → Feature overrides</span> take precedence over plan defaults.</li>
            <li>Plan names (free/basic/moderate/premium) are intentionally read-only — they're referenced in billing webhooks and the upgrade flow.</li>
          </ul>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-sm text-gray-400">Loading plans…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
          {plans.map(p => <PlanCard key={p.id} plan={p} onSave={handleSavedPlan} />)}
        </div>
      )}
    </Layout>
  );
}
