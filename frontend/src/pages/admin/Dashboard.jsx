import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { PlanBadge, StatusBadge } from '../../components/common/PlanBadge';
import { getAdminDashboard } from '../../services/api';
import {
  Users, Ticket, TrendingUp, MessageSquare,
  UserCheck, ChevronRight, RefreshCw, ArrowUp, ArrowDown,
  Settings as SettingsIcon, X, Clock, AlertTriangle, CalendarClock,
  Phone, CheckCircle2,
} from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

// ── Widget registry ─────────────────────────────────────────────────────────
// Single source of truth for which widgets exist + their default visibility.
// The Customize modal renders one checkbox per entry; the dashboard renders
// only the widgets whose id is in the visibleWidgets set.
const ALL_WIDGETS = [
  { id: 'greeting',  label: 'Greeting + date',                      defaultVisible: true  },
  { id: 'today',     label: 'Today\'s snapshot (last 24h)',          defaultVisible: true  },
  { id: 'kpis',      label: 'Lifetime KPIs (5 tiles)',               defaultVisible: true  },
  { id: 'sla_queue', label: 'SLA & queue health',                    defaultVisible: true  },
  { id: 'expiring',  label: 'Plans expiring soon',                   defaultVisible: true  },
  { id: 'recent',    label: 'Recent customers',                      defaultVisible: true  },
  { id: 'plans',     label: 'Plan distribution',                     defaultVisible: true  },
];
const VISIBLE_STORAGE_KEY = 'dsp_admin_dashboard_widgets';
const readVisibleWidgets = () => {
  try {
    const stored = JSON.parse(localStorage.getItem(VISIBLE_STORAGE_KEY) || 'null');
    if (Array.isArray(stored)) return new Set(stored);
  } catch {}
  return new Set(ALL_WIDGETS.filter(w => w.defaultVisible).map(w => w.id));
};

// ── Reusable bits ───────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, sub, delta, deltaLabel, color = 'indigo', onClick, title }) {
  const colors = {
    indigo: { bg: 'bg-blue-50', text: 'text-blue-600' },
    green:  { bg: 'bg-green-50',  text: 'text-green-600'  },
    amber:  { bg: 'bg-amber-50',  text: 'text-amber-600'  },
    blue:   { bg: 'bg-blue-50',   text: 'text-blue-600'   },
    red:    { bg: 'bg-red-50',    text: 'text-red-600'    },
  };
  const c = colors[color];
  const clickable = typeof onClick === 'function';
  const showDelta = delta != null && delta !== 0;
  const deltaUp = delta > 0;
  return (
    <div
      onClick={clickable ? onClick : undefined}
      title={title}
      className={`card p-5 transition-all text-left w-full ${clickable ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 hover:border-gray-200' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 ${c.bg} rounded-lg flex items-center justify-center`}>
          <Icon className={`w-5 h-5 ${c.text}`} />
        </div>
        {clickable && <ChevronRight className="w-4 h-4 text-gray-300" />}
      </div>
      <p className="text-2xl font-bold text-gray-800">{value}</p>
      <p className="text-sm font-medium text-gray-600 mt-0.5">{label}</p>
      {showDelta && (
        <p className={clsx(
          'text-xs mt-1 font-medium inline-flex items-center gap-0.5',
          deltaUp ? 'text-emerald-600' : 'text-red-600'
        )}>
          {deltaUp ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
          {Math.abs(delta).toLocaleString('en-IN')}{deltaLabel ? ` ${deltaLabel}` : ' vs prev 30d'}
        </p>
      )}
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Widget: Greeting + date ─────────────────────────────────────────────────
function GreetingWidget({ userName }) {
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="mb-4">
      <p className="text-base font-semibold text-gray-700">
        {greet}{userName ? `, ${userName}` : ''} <span className="text-gray-400 font-normal">·</span> <span className="text-sm font-normal text-gray-500">{dateStr}</span>
      </p>
    </div>
  );
}

// ── Widget: Today's snapshot ────────────────────────────────────────────────
function TodaySnapshotWidget({ today }) {
  if (!today) return null;
  const items = [
    { label: 'New customers',    value: today.newCustomers,   icon: Users,         tone: 'indigo' },
    { label: 'New tickets',      value: today.newTickets,     icon: Ticket,        tone: 'amber' },
    { label: 'Closed tickets',   value: today.closedTickets,  icon: CheckCircle2,  tone: 'green' },
    { label: 'Chats started',    value: today.newChats,       icon: MessageSquare, tone: 'blue' },
    { label: 'Calls made',       value: today.newCalls,       icon: Phone,         tone: 'purple' },
    { label: 'Revenue collected',value: `₹${Number(today.revenue || 0).toLocaleString('en-IN')}`, icon: TrendingUp, tone: 'green' },
  ];
  const tones = {
    indigo: 'bg-blue-50  text-blue-700  border-blue-100',
    green:  'bg-emerald-50 text-emerald-700 border-emerald-100',
    amber:  'bg-amber-50   text-amber-700   border-amber-100',
    blue:   'bg-blue-50    text-blue-700    border-blue-100',
    purple: 'bg-purple-50  text-purple-700  border-purple-100',
  };
  return (
    <div className="card p-4 mb-4">
      <p className="text-xs uppercase tracking-wider font-semibold text-gray-500 mb-3 inline-flex items-center gap-1.5">
        <Clock className="w-3.5 h-3.5" /> Today · last 24h
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {items.map(it => (
          <div key={it.label} className={clsx('rounded-lg border p-3', tones[it.tone])}>
            <div className="flex items-start justify-between mb-1">
              <span className="text-[11px] font-medium opacity-80">{it.label}</span>
              <it.icon className="w-3.5 h-3.5 opacity-50" />
            </div>
            <p className="text-xl font-bold leading-none">{it.value || 0}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Widget: SLA & queue health ──────────────────────────────────────────────
function SlaQueueWidget({ slaQueue, navigate }) {
  if (!slaQueue) return null;
  const { openByPriority, approachingBreach, avgFirstResponseMinutes, waitingChats, agentsOnline } = slaQueue;
  const totalOpen = Object.values(openByPriority || {}).reduce((s, n) => s + n, 0);
  const fmtMins = (m) => m == null ? '—' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  return (
    <div className="card p-5 mb-4">
      <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
        <AlertTriangle className="w-4 h-4 text-amber-500" /> SLA & Queue Health
      </h2>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <button
          type="button"
          onClick={() => navigate('/admin/tickets')}
          className="rounded-lg border border-gray-200 p-3 text-left hover:border-blue-300 transition-colors"
          title="Click to open Tickets page"
        >
          <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Open tickets</p>
          <p className="text-xl font-bold text-gray-800 mt-1">{totalOpen}</p>
          <div className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
            {openByPriority.urgent > 0 && <span className="px-1.5 py-0 rounded bg-red-100 text-red-700">urgent · {openByPriority.urgent}</span>}
            {openByPriority.high > 0 && <span className="px-1.5 py-0 rounded bg-amber-100 text-amber-700">high · {openByPriority.high}</span>}
            {openByPriority.medium > 0 && <span className="px-1.5 py-0 rounded bg-yellow-100 text-yellow-700">med · {openByPriority.medium}</span>}
            {openByPriority.normal > 0 && <span className="px-1.5 py-0 rounded bg-blue-50 text-blue-700">normal · {openByPriority.normal}</span>}
            {openByPriority.low > 0 && <span className="px-1.5 py-0 rounded bg-gray-100 text-gray-600">low · {openByPriority.low}</span>}
          </div>
        </button>
        <div className={clsx(
          'rounded-lg border p-3',
          approachingBreach > 0 ? 'border-red-300 bg-red-50' : 'border-gray-200'
        )}>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Approaching SLA breach</p>
          <p className={clsx('text-xl font-bold mt-1', approachingBreach > 0 ? 'text-red-700' : 'text-gray-800')}>{approachingBreach}</p>
          <p className="text-[10px] text-gray-500 mt-1">in next 4 hours</p>
        </div>
        <div className="rounded-lg border border-gray-200 p-3">
          <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Avg first response</p>
          <p className="text-xl font-bold text-gray-800 mt-1">{fmtMins(avgFirstResponseMinutes)}</p>
          <p className="text-[10px] text-gray-500 mt-1">today</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/admin/chats')}
          className={clsx(
            'rounded-lg border p-3 text-left transition-colors',
            waitingChats > 0 ? 'border-amber-300 bg-amber-50 hover:border-amber-400' : 'border-gray-200 hover:border-blue-300'
          )}
          title="Click to open Chats page"
        >
          <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Chats waiting</p>
          <p className={clsx('text-xl font-bold mt-1', waitingChats > 0 ? 'text-amber-700' : 'text-gray-800')}>{waitingChats}</p>
          <p className="text-[10px] text-gray-500 mt-1">in queue right now</p>
        </button>
        <div className={clsx(
          'rounded-lg border p-3',
          agentsOnline === 0 ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50/50'
        )}>
          <p className="text-[11px] text-gray-500 uppercase tracking-wider font-medium">Agents online</p>
          <p className={clsx('text-xl font-bold mt-1', agentsOnline === 0 ? 'text-amber-700' : 'text-emerald-700')}>{agentsOnline}</p>
          <p className="text-[10px] text-gray-500 mt-1">connected right now</p>
        </div>
      </div>
    </div>
  );
}

// ── Widget: Plans expiring soon ─────────────────────────────────────────────
function ExpiringPlansWidget({ expiring, navigate }) {
  if (!expiring) return null;
  if (expiring.count === 0) {
    return (
      <div className="card p-4 mb-4 border-2 border-emerald-100 bg-emerald-50/40">
        <p className="text-sm text-emerald-800 inline-flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <strong>No plans expiring in the next 30 days.</strong>
        </p>
      </div>
    );
  }
  return (
    <div className="card p-5 mb-4 border-2 border-amber-200 bg-amber-50/30">
      <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
          <CalendarClock className="w-4 h-4 text-amber-600" />
          {expiring.count} plan{expiring.count === 1 ? '' : 's'} expiring in next 30 days
        </h2>
        <span className="text-xs font-bold text-amber-800">
          ₹{Number(expiring.arrAtRisk).toLocaleString('en-IN')} ARR at risk
        </span>
      </div>
      <div className="divide-y divide-amber-100 max-h-56 overflow-y-auto">
        {expiring.items.map(it => (
          <button
            key={it.customer_id}
            type="button"
            onClick={() => navigate(`/admin/customers?focus=${it.customer_id}`)}
            className="w-full text-left flex items-center justify-between px-1 py-2 hover:bg-amber-100/50 transition-colors text-sm"
            title={`Open ${it.customer_name}'s detail`}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-800 truncate">{it.customer_name}</p>
              <p className="text-xs text-gray-500 truncate">{it.email} · <span className="capitalize">{it.plan_name}</span></p>
            </div>
            <div className="text-right flex-shrink-0 ml-2">
              <p className="text-xs font-semibold text-amber-700">{it.days_left} day{it.days_left === 1 ? '' : 's'} left</p>
              <p className="text-[11px] text-gray-500">₹{Number(it.plan_price).toLocaleString('en-IN')}/yr</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Widget: Customize modal ─────────────────────────────────────────────────
function CustomizeModal({ visibleWidgets, onToggle, onResetDefaults, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold text-gray-800 inline-flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-blue-500" /> Customize dashboard
          </h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Pick which widgets show on your dashboard. Saved per browser.
        </p>
        <div className="space-y-2">
          {ALL_WIDGETS.map(w => (
            <label key={w.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                className="w-4 h-4 accent-blue-600 cursor-pointer"
                checked={visibleWidgets.has(w.id)}
                onChange={() => onToggle(w.id)}
              />
              <span className="text-sm text-gray-700">{w.label}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-between items-center mt-5 pt-4 border-t border-gray-100">
          <button onClick={onResetDefaults} className="text-xs text-blue-600 hover:underline">
            Reset to defaults
          </button>
          <button onClick={onClose} className="btn-primary text-sm">Done</button>
        </div>
      </div>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────
export default function AdminDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState(null);
  const [visibleWidgets, setVisibleWidgets] = useState(readVisibleWidgets);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const navigate = useNavigate();

  // Two-mode loader: the initial visit shows the full-page spinner; background
  // polls and tab-focus refreshes use the smaller spinner on the refresh icon
  // so the numbers don't flash every 30 seconds.
  const load = ({ silent = false } = {}) => {
    if (silent) setRefreshing(true); else setLoading(true);
    getAdminDashboard()
      .then(res => {
        setData(res.data);
        setLastRefreshAt(new Date());
      })
      .catch(() => { if (!silent) toast.error('Failed to load dashboard'); })
      .finally(() => {
        if (silent) setRefreshing(false); else setLoading(false);
      });
  };

  useEffect(() => { load(); }, []);

  useGlobalRefresh(() => load());

  // Auto-refresh every 30s while the tab is visible. Pauses immediately on
  // tab hide (saves bandwidth + avoids stale POSTs racing the next render),
  // and does one immediate refresh when the tab regains focus so admins
  // returning from another window don't read stale numbers thinking they're
  // live.
  useEffect(() => {
    let intervalId = null;
    const start = () => {
      if (intervalId != null) return;
      intervalId = window.setInterval(() => load({ silent: true }), 30_000);
    };
    const stop = () => {
      if (intervalId != null) { window.clearInterval(intervalId); intervalId = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        load({ silent: true });
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  const toggleWidget = (id) => {
    setVisibleWidgets(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { localStorage.setItem(VISIBLE_STORAGE_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const resetDefaults = () => {
    const defaults = new Set(ALL_WIDGETS.filter(w => w.defaultVisible).map(w => w.id));
    setVisibleWidgets(defaults);
    try { localStorage.setItem(VISIBLE_STORAGE_KEY, JSON.stringify([...defaults])); } catch {}
  };

  if (loading) return <Layout><div className="flex h-64 items-center justify-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div></Layout>;
  if (!data) return null;

  const planColors = { free: 'bg-gray-200', basic: 'bg-blue-400', moderate: 'bg-purple-400', premium: 'bg-amber-400' };
  const trends = data.trends || {};

  return (
    <Layout>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Admin Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Overview of your support operations
            {lastRefreshAt && (
              <span className="ml-2 text-xs text-gray-400">
                · Auto-refreshes every 30s · Updated {lastRefreshAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setCustomizeOpen(true)} className="btn-secondary inline-flex items-center gap-1.5 text-sm" title="Pick which widgets to show">
            <SettingsIcon className="w-3.5 h-3.5" /> Customize
          </button>
          <button onClick={() => load()} className="hidden lg:inline-flex btn-secondary" title="Refresh now">
            <RefreshCw className={clsx('w-4 h-4', refreshing && 'animate-spin')} />
          </button>
        </div>
      </div>

      {visibleWidgets.has('greeting') && <GreetingWidget userName="Admin" />}

      {visibleWidgets.has('today') && <TodaySnapshotWidget today={data.today} />}

      {visibleWidgets.has('kpis') && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          <StatCard
            icon={Users}
            label="Total Customers"
            value={data.stats.totalCustomers}
            delta={trends.customersDelta}
            deltaLabel="vs prev 30d"
            color="indigo"
            onClick={() => navigate('/admin/customers')}
            title="Open the Customers page"
          />
          <StatCard
            icon={UserCheck}
            label="Active Plans"
            value={data.stats.activeCustomers}
            sub={data.stats.activePaidCustomers != null
              ? `${data.stats.activePaidCustomers} paying · ${data.stats.activeFreeCustomers || 0} Free`
              : null}
            color="green"
            onClick={() => navigate('/admin/customers')}
            title="Open the Customers page"
          />
          <StatCard
            icon={Ticket}
            label="Open Tickets"
            value={data.stats.openTickets}
            delta={trends.ticketsDelta}
            deltaLabel="vs prev 30d (volume)"
            color="amber"
            onClick={() => navigate('/admin/tickets')}
            title="Open the Tickets page"
          />
          <StatCard
            icon={MessageSquare}
            label="Waiting Chats"
            value={data.stats.waitingChats}
            color="blue"
            onClick={() => navigate('/admin/chats')}
            title="Open the Chats page"
          />
          <StatCard
            icon={TrendingUp}
            label="Revenue"
            value={`₹${Number(data.stats.arr ?? data.stats.totalRevenue ?? 0).toLocaleString('en-IN')}`}
            sub={data.stats.payingCustomers != null
              ? `Annual · ${data.stats.payingCustomers} paying${data.stats.freeCustomers ? ` · ${data.stats.freeCustomers} Free` : ''}`
              : 'Annual recurring'}
            delta={trends.revenueDelta}
            deltaLabel="collected vs prev 30d"
            color="green"
            onClick={() => navigate('/admin/reports?tab=revenue')}
            title="ARR = sum of current paying customers × their plan price. Click for date-ranged historical revenue."
          />
        </div>
      )}

      {visibleWidgets.has('sla_queue') && <SlaQueueWidget slaQueue={data.slaQueue} navigate={navigate} />}

      {visibleWidgets.has('expiring') && <ExpiringPlansWidget expiring={data.expiring} navigate={navigate} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent customers */}
        {visibleWidgets.has('recent') && (
          <div className={clsx(
            'card overflow-hidden',
            visibleWidgets.has('plans') ? 'lg:col-span-2' : 'lg:col-span-3'
          )}>
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Recent Customers</h2>
              <button onClick={() => navigate('/admin/customers')} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                View all <ChevronRight className="w-3 h-3" />
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {data.recentCustomers.map(c => (
                <div
                  key={c.id}
                  className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => navigate(`/admin/customers?focus=${c.id}`)}
                  title={`Open ${c.name}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-sm font-bold text-blue-700">
                      {c.name[0]}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-800">{c.name}</p>
                      <p className="text-xs text-gray-400">{c.domain} · {c.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <PlanBadge plan={c.plan_name} />
                    <StatusBadge isActive={c.plan_expiry && new Date(c.plan_expiry) >= new Date()} expiry={c.plan_expiry} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Plan distribution */}
        {visibleWidgets.has('plans') && (
          <div className={clsx('card p-5', !visibleWidgets.has('recent') && 'lg:col-span-3')}>
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Plan Distribution</h2>
            <div className="space-y-3">
              {data.planDistribution.map(p => (
                <button
                  key={p.plan_name}
                  type="button"
                  onClick={() => navigate(`/admin/customers?plan=${p.plan_name}`)}
                  className="w-full text-left rounded p-1 -m-1 hover:bg-gray-50 transition-colors"
                  title={`Show ${p.plan_name} customers`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`w-3 h-3 rounded-full ${planColors[p.plan_name] || 'bg-gray-300'}`} />
                      <span className="text-sm capitalize text-gray-700">{p.plan_name}</span>
                    </div>
                    <span className="text-sm font-bold text-gray-800">{p.count}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-1.5 rounded-full ${planColors[p.plan_name] || 'bg-gray-300'}`}
                      style={{ width: `${data.stats.totalCustomers ? (p.count / data.stats.totalCustomers) * 100 : 0}%` }}
                    />
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-5 pt-4 border-t border-gray-100 space-y-2">
              <button onClick={() => navigate('/admin/customers')} className="btn-primary w-full justify-center text-sm">
                Manage Customers
              </button>
              <button onClick={() => navigate('/admin/reports')} className="btn-secondary w-full justify-center text-sm">
                View Reports
              </button>
            </div>
          </div>
        )}
      </div>

      {customizeOpen && (
        <CustomizeModal
          visibleWidgets={visibleWidgets}
          onToggle={toggleWidget}
          onResetDefaults={resetDefaults}
          onClose={() => setCustomizeOpen(false)}
        />
      )}
    </Layout>
  );
}
