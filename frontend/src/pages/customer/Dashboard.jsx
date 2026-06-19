import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { PlanBadge, StatusBadge } from '../../components/common/PlanBadge';
import UsageBar from '../../components/common/UsageBar';
import { getCustomerDashboard, getCustomerSubscriptions, getCustomerQuotes } from '../../services/api';
import { useSocket } from '../../contexts/SocketContext';
import {
  Globe, Ticket, Phone, Calendar,
  Package, AlertTriangle, MessageCircle, MessageSquare, Lock,
  Shield, FileText, ChevronRight, Users,
} from 'lucide-react';
import toast from 'react-hot-toast';
import WelcomeTour from '../../components/customer/WelcomeTour';

function SubscriptionCard({ sub, onClick }) {
  const isSupport = sub._type === 'support';

  // Resolve display name — try every common field the billing app might use
  const rawName = sub.sku_name || sub.name || sub.service_name || sub.product_name
    || sub.subscription_name || sub.package_name || sub.title || sub.label
    || sub.workspace_edition || sub.product || sub.description || sub.plan_name || null;

  // For support type: prefer DSP plan name if billing app didn't return a name
  let name;
  if (isSupport) {
    const dspPlan = sub._dsp_plan_name;
    name = rawName
      || (dspPlan ? dspPlan.charAt(0).toUpperCase() + dspPlan.slice(1) + ' Support Plan' : 'Support Plan');
  } else {
    name = rawName || 'Google Workspace';
  }

  const qty  = sub.quantity ?? sub.seats ?? sub.users ?? sub.licenses ?? null;
  const renewalRaw = sub.renewal_date || sub.next_billing_date || sub.expiry_date
    || sub.end_date || sub.valid_till || sub.valid_until || sub.expires_at || null;
  const rawStatus  = (sub.status || 'active').toLowerCase();
  const isActive   = rawStatus === 'active' || rawStatus === 'paid' || rawStatus === 'running';

  const renewal = renewalRaw ? new Date(renewalRaw) : null;
  const today   = new Date(); today.setHours(0, 0, 0, 0);
  const daysLeft = renewal ? Math.ceil((renewal - today) / 86400000) : null;
  const renewalStr = renewal
    ? renewal.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const renewalSoon = daysLeft !== null && daysLeft <= 30 && daysLeft >= 0;
  const isExpired   = daysLeft !== null && daysLeft < 0;

  const color = !isActive || isExpired ? 'red' : renewalSoon ? 'amber' : 'green';
  const colorMap = {
    green: { bg: 'bg-green-50',  iconBg: 'bg-green-100 text-green-600',  dot: 'bg-green-500',  text: 'text-green-700'  },
    amber: { bg: 'bg-amber-50',  iconBg: 'bg-amber-100 text-amber-600',  dot: 'bg-amber-500',  text: 'text-amber-700'  },
    red:   { bg: 'bg-red-50',    iconBg: 'bg-red-100 text-red-600',      dot: 'bg-red-500',    text: 'text-red-700'    },
  };
  const c    = colorMap[color];
  const Icon = isSupport ? Shield : Package;

  return (
    <div
      className={`card p-5 cursor-pointer hover:shadow-md transition-all group ${c.bg}`}
      onClick={onClick}
    >
      {/* Icon + type label row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${c.iconBg}`}>
            <Icon className="w-4 h-4" />
          </div>
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            {isSupport ? 'Support Plan' : 'Workspace'}
          </span>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
      </div>

      {/* Subscription name */}
      <p className="text-sm font-bold text-gray-800 leading-snug mb-2 truncate" title={name}>
        {name}
      </p>

      {/* Seat count */}
      {qty != null && (
        <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1.5">
          <Users className="w-3.5 h-3.5" />
          <span>{qty} {isSupport ? 'seat' : 'user'}{Number(qty) !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Renewal date */}
      {renewalStr && (
        <p className={`text-xs font-medium mb-2 ${isExpired ? 'text-red-500' : renewalSoon ? 'text-amber-600' : 'text-gray-500'}`}>
          {isExpired ? '⚠ Expired ' : 'Renews '}{renewalStr}
          {renewalSoon && !isExpired && ` · ${daysLeft}d`}
        </p>
      )}

      {/* Status dot */}
      <div className="flex items-center gap-1.5 mt-auto">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${c.dot}`} />
        <span className={`text-xs font-semibold ${c.text}`}>
          {!isActive || isExpired ? (isExpired ? 'Expired' : 'Inactive') : 'Active'}
        </span>
      </div>
    </div>
  );
}

function PendingPaymentsCard({ quotes, loading, onClick, disabled }) {
  const list  = quotes || [];
  const total = list.reduce((s, q) => s + Number(q.total || q.total_amount || q.amount || 0), 0);
  const count = list.length;

  // When the admin's billing_extras_enabled flag is OFF, this card is faded +
  // non-clickable (mirrors the Billing-page tab treatment) instead of linking
  // to a feature that's still "coming soon".
  if (disabled) {
    return (
      <div
        className="card p-5 bg-amber-50 opacity-50 cursor-not-allowed select-none"
        aria-disabled="true"
        title="Coming soon — billing integrations are in progress"
      >
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-amber-100 text-amber-600">
              <FileText className="w-4 h-4" />
            </div>
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Payments</span>
          </div>
          <span className="text-[9px] uppercase tracking-wider font-bold bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">Soon</span>
        </div>
        <p className="text-sm font-bold text-gray-800 mb-2">Pending Payments</p>
        <p className="text-xl font-bold text-gray-400 mb-1">₹0</p>
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-gray-300" />
          <span className="text-xs font-semibold text-gray-400">No pending</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card p-5 cursor-pointer hover:shadow-md transition-all group bg-amber-50"
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-amber-100 text-amber-600">
            <FileText className="w-4 h-4" />
          </div>
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Payments</span>
        </div>
        <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-gray-500 transition-colors" />
      </div>
      <p className="text-sm font-bold text-gray-800 mb-2">Pending Payments</p>
      {loading ? (
        <div className="w-24 h-6 bg-amber-200 rounded animate-pulse" />
      ) : count > 0 ? (
        <>
          <p className="text-xl font-bold text-amber-700 mb-1">
            ₹{total.toLocaleString('en-IN')}
          </p>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            <span className="text-xs font-semibold text-amber-700">
              {count} open quotation{count !== 1 ? 's' : ''}
            </span>
          </div>
        </>
      ) : (
        <>
          <p className="text-xl font-bold text-gray-400 mb-1">₹0</p>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-300" />
            <span className="text-xs font-semibold text-gray-400">No pending</span>
          </div>
        </>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="card p-5 bg-gray-50">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-8 h-8 bg-gray-200 rounded-lg animate-pulse flex-shrink-0" />
        <div className="h-3 bg-gray-200 rounded w-20 animate-pulse" />
      </div>
      <div className="h-4 bg-gray-200 rounded w-3/4 animate-pulse mb-2" />
      <div className="h-3 bg-gray-200 rounded w-1/2 animate-pulse mb-2" />
      <div className="h-3 bg-gray-200 rounded w-2/3 animate-pulse" />
    </div>
  );
}

function LockedUsageBar({ label, icon: Icon, featureLabel }) {
  const navigate = useNavigate();
  const slug = String(label || 'usage').toLowerCase().trim().replace(/\s+/g, '-');
  return (
    <div
      data-testid={`Dashboard-LockedUsageBar-${slug}`}
      className="card p-4 bg-gray-50 relative cursor-pointer hover:shadow-md transition-shadow group"
      onClick={() => navigate('/customer/billing', { state: { tab: 'plan' } })}
    >
      <div className="flex items-center justify-between mb-2 opacity-40">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-500">
          {Icon && <Icon className="w-4 h-4 text-gray-400" />}
          {label}
        </div>
        <span className="text-sm font-bold text-gray-400">— / —</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 mb-3 opacity-40" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <Lock className="w-3 h-3" />
          {featureLabel} not on your plan
        </div>
        <button
          data-testid={`Dashboard-UpgradeButton-${slug}`}
          onClick={e => { e.stopPropagation(); navigate('/customer/billing'); }}
          className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 bg-indigo-50 border border-indigo-200 px-2.5 py-1 rounded-lg transition-colors"
        >
          Upgrade →
        </button>
      </div>
    </div>
  );
}

export default function CustomerDashboard() {
  const [data,          setData]          = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [subscriptions, setSubscriptions] = useState(null);  // null = loading
  const [quotes,        setQuotes]        = useState(null);   // null = loading
  const navigate = useNavigate();
  const { socket } = useSocket();

  useEffect(() => {
    getCustomerDashboard()
      .then(res => setData(res.data))
      .catch(() => toast.error('Failed to load dashboard'))
      .finally(() => setLoading(false));

    getCustomerSubscriptions()
      .then(res => setSubscriptions(res.data.subscriptions || []))
      .catch(() => setSubscriptions([]));

    getCustomerQuotes()
      .then(res => setQuotes(res.data.quotes || []))
      .catch(() => setQuotes([]));
  }, []);

  useEffect(() => {
    if (!socket) return;
    const refetch = () => {
      getCustomerDashboard().then(res => setData(res.data)).catch(() => {});
    };
    socket.on('usage_reset', refetch);
    socket.on('overrides_changed', refetch);    // admin saved/cleared overrides → new caps
    socket.on('plan_changed',      refetch);    // admin edited the plan itself → new limits/SLA
    return () => {
      socket.off('usage_reset', refetch);
      socket.off('overrides_changed', refetch);
      socket.off('plan_changed', refetch);
    };
  }, [socket]);

  if (loading) return (
    <Layout>
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
      </div>
    </Layout>
  );

  if (!data) return (
    <Layout>
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
        <AlertTriangle className="w-10 h-10 text-red-400" />
        <p className="text-sm font-medium text-gray-600">Failed to load dashboard</p>
        <button
          onClick={() => window.location.reload()}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold underline"
        >
          Retry
        </button>
      </div>
    </Layout>
  );

  const planActive = data.plan?.isActive ?? false;

  // Fallback card when no billing subscriptions available
  const fallbackSub = {
    _type: 'support',
    plan_name: data.plan?.name
      ? data.plan.name.charAt(0).toUpperCase() + data.plan.name.slice(1) + ' Plan'
      : 'Free Plan',
    renewal_date: data.plan?.expiry || null,
    status: planActive ? 'active' : 'expired',
  };

  const showSubs = subscriptions !== null && subscriptions.length > 0
    ? subscriptions
    : subscriptions !== null
      ? [fallbackSub]
      : null; // still loading

  // Check if any subscription renews within 30 days
  const renewalSoonSub = subscriptions?.find(sub => {
    const renewalRaw = sub.renewal_date || sub.next_billing_date || sub.expiry_date
      || sub.end_date || sub.valid_till || sub.valid_until || sub.expires_at;
    if (!renewalRaw) return false;
    const renewal = new Date(renewalRaw);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const daysLeft = Math.ceil((renewal - today) / 86400000);
    return daysLeft >= 0 && daysLeft <= 30;
  });

  return (
    <Layout>
      {/* First-login walkthrough — no-op if the customer has logged in before */}
      <WelcomeTour />
      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-800 break-words">Welcome, {data.name}</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-gray-500">
              <Globe className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{data.domain}</span>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap flex-shrink-0">
            <PlanBadge plan={data.plan?.name} />
            <StatusBadge isActive={planActive} expiry={data.plan?.expiry} />
          </div>
        </div>
      </div>

      {/* Expired plan alert */}
      {!planActive && (
        <div className="mb-5 flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4">
          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-red-700">Your support plan has expired</p>
            <p className="text-sm text-red-600 mt-0.5">Chat and call support are unavailable. You can still raise a support ticket to reach us — contact your account manager to renew.</p>
          </div>
        </div>
      )}

      {/* Renewal reminder banner */}
      {renewalSoonSub && planActive && (
        <div className="mb-5 flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4">
          <Calendar className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-amber-700">Subscription renewing soon</p>
            <p className="text-sm text-amber-600 mt-0.5">
              One or more of your subscriptions is due for renewal within 30 days. Contact your account manager to ensure uninterrupted service.
            </p>
          </div>
        </div>
      )}

      {/* Dynamic subscription + pending payments cards */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Active Subscriptions &amp; Payments
        </p>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {showSubs === null ? (
            <><SkeletonCard /><SkeletonCard /><SkeletonCard /></>
          ) : (
            showSubs.map((sub, i) => (
              <SubscriptionCard
                key={i}
                sub={sub}
                onClick={() => navigate('/customer/billing', { state: { tab: 'subscriptions' } })}
              />
            ))
          )}
          <PendingPaymentsCard
            quotes={quotes}
            loading={quotes === null}
            disabled={!data?.billing_extras_enabled}
            onClick={() => navigate('/customer/billing', { state: { tab: 'quotes' } })}
          />
        </div>
      </div>

      {/* Usage bars */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <UsageBar
          label="Ticket Usage"
          used={data.usage.ticketsUsed}
          limit={data.usage.ticketsLimit}
          icon={Ticket}
          onClick={() => navigate('/customer/tickets')}
        />
        {data.plan?.allowChat ? (
          <UsageBar
            label="Chat Usage"
            used={data.usage.chatUsed}
            limit={data.usage.chatLimit}
            icon={MessageSquare}
            color="green"
            onClick={() => navigate('/customer/chat')}
          />
        ) : (
          <LockedUsageBar label="Chat Usage" icon={MessageSquare} featureLabel="Live Chat" />
        )}
        {data.plan?.allowCalls ? (
          <UsageBar
            label="Call Usage"
            used={data.usage.callsUsed}
            limit={data.usage.callsLimit}
            icon={Phone}
            color="amber"
            onClick={() => navigate('/customer/call')}
          />
        ) : (
          <LockedUsageBar label="Call Usage" icon={Phone} featureLabel="Phone Support" />
        )}
      </div>

      {/* Get Support hero */}
      <div className="card p-5 sm:p-6 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-indigo-200" style={{ background: 'linear-gradient(to right, #eef2ff, #fff)' }}>
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 bg-indigo-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <MessageCircle className="w-6 h-6 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-gray-800">Need help? Talk to our assistant</p>
            <p className="text-sm text-gray-500 mt-0.5">Raise a ticket, start a chat, or request a call — all guided by AI.</p>
          </div>
        </div>
        <button
          data-testid="Dashboard-OpenAssistantButton"
          onClick={() => window.dispatchEvent(new CustomEvent('open-bot-widget'))}
          className="btn-primary flex-shrink-0 w-full sm:w-auto justify-center"
        >
          <MessageCircle className="w-4 h-4" /> Open Assistant
        </button>
      </div>

      {/* Products */}
      {data.products?.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Package className="w-4 h-4 text-gray-500" />
            <h3 className="font-semibold text-gray-700 text-sm">Your Products</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.products.map((p) => (
              <span key={p} className="badge bg-indigo-50 text-indigo-700">{p}</span>
            ))}
          </div>
        </div>
      )}
    </Layout>
  );
}
