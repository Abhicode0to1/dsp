import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import {
  getTicketReport, getRevenueReport, getUsageReport, exportReportCsv, getPlanChangeReport,
  getReportTickets, getReportInvoices, getReportCalls, getReportChats, getReportCustomers, getReportAgents,
  listCustomReports, deleteCustomReport, getCustomReportCount,
} from '../../services/api';
import { RefreshCw, TrendingUp, Ticket, Phone, BarChart2, Download, Clock, ShieldCheck, Tag, UserCog, MessageSquare, Users, CreditCard, ArrowUpCircle, Sparkles, Plus, MoreVertical, Edit, Trash2, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import DrillDownModal from '../../components/admin/DrillDownModal';
import DateRangeFilter from '../../components/admin/DateRangeFilter';
import CustomReportBuilder from '../../components/admin/CustomReportBuilder';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import { COLUMN_SPEC, RESOURCE_LABELS, formatCustomCell } from '../../components/admin/customReportSpec';

const DEFAULT_RANGE = (() => {
  // Default: Last 30 days. Same code path as the DateRangeFilter preset to
  // keep them aligned.
  const now = new Date();
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  return { presetId: '30', from: isoDay(start), to: isoDay(now) };
})();

// Column definitions reused by the drill-down modals. Defined at module scope
// so they don't get reconstructed on every render and they stay easy to grep.
const TICKET_COLS = [
  { key: 'id',             label: '#',         width: 'w-16',  format: (v) => `#${v}` },
  { key: 'subject',        label: 'Subject' },
  { key: 'customer_name',  label: 'Customer' },
  { key: 'agent_name',     label: 'Agent',     format: (v) => v || 'Unassigned' },
  { key: 'status',         label: 'Status',    format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'priority',       label: 'Priority',  format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'plan_name',      label: 'Plan',      format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'created_at',     label: 'Created' },
];

const INVOICE_COLS = [
  { key: 'id',             label: '#',         width: 'w-16',  format: (v) => `#${v}` },
  { key: 'customer_name',  label: 'Customer' },
  { key: 'domain',         label: 'Domain' },
  { key: 'plan_name',      label: 'Plan',      format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'final_price',    label: 'Amount',    align: 'right',
    format: (v) => `₹${Number(v || 0).toLocaleString('en-IN')}` },
  { key: 'status',         label: 'Status',    format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'created_at',     label: 'Created' },
  { key: 'due_date',       label: 'Due' },
];

const CALL_COLS = [
  { key: 'id',             label: '#',         width: 'w-16',  format: (v) => `#${v}` },
  { key: 'customer_name',  label: 'Customer' },
  { key: 'agent_name',     label: 'Agent',     format: (v) => v || 'Unassigned' },
  { key: 'status',         label: 'Status',    format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'duration',       label: 'Duration',  align: 'right',
    format: (v) => v != null ? `${Math.floor(v/60)}m ${v%60}s` : '—' },
  { key: 'initiated_by',   label: 'Started by', format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'created_at',     label: 'Created' },
];

const CUSTOMER_COLS = [
  { key: 'id',             label: '#',         width: 'w-12',  format: (v) => `#${v}` },
  { key: 'customer_name',  label: 'Customer' },
  { key: 'email',          label: 'Email' },
  { key: 'domain',         label: 'Domain',    format: (v) => v || '—' },
  { key: 'plan_name',      label: 'Plan',      format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '(no plan)' },
  { key: 'created_at',     label: 'Joined' },
  { key: 'plan_expiry',    label: 'Plan expiry', format: (v) => v ? new Date(v).toLocaleDateString('en-IN') : 'Never' },
];

const CHAT_COLS = [
  { key: 'id',             label: '#',         width: 'w-16',  format: (v) => `#${v}` },
  { key: 'customer_name',  label: 'Customer' },
  { key: 'agent_name',     label: 'Agent',     format: (v) => v || 'Unassigned' },
  { key: 'status',         label: 'Status',    format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'category',       label: 'Category',  format: (v) => v ? v.charAt(0).toUpperCase() + v.slice(1) : '—' },
  { key: 'created_at',     label: 'Created' },
  { key: 'closed_at',      label: 'Closed' },
];

// Canonical orders so the charts always render every category (with 0 if no
// rows), instead of dropping rows that happen to have zero count — which was
// the original "Why does this only show Closed?" confusion.
const STATUS_ORDER   = ['open', 'pending', 'closed'];
const PRIORITY_ORDER = ['low', 'normal', 'medium', 'high', 'urgent'];

const STATUS_COLOR = {
  open:    'bg-blue-500',
  pending: 'bg-amber-500',
  closed:  'bg-gray-400',
};
const PRIORITY_COLOR = {
  low:    'bg-gray-400',
  normal: 'bg-blue-400',
  medium: 'bg-amber-400',
  high:   'bg-orange-500',
  urgent: 'bg-red-500',
};
const PLAN_COLOR = {
  free:     'bg-gray-400',
  basic:    'bg-blue-500',
  moderate: 'bg-purple-500',
  premium:  'bg-amber-500',
};

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// "2026-05" → "May 2026"
function prettyMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(n => parseInt(n, 10));
  return `${MONTH_NAMES[(m - 1) || 0]} ${y}`;
}

// Backfill the last 6 months (ending at the current month) with 0 for any
// month that's missing from the DB result. The bar chart needs every month to
// render even if no tickets were raised, otherwise the trend looks misleading.
function backfillSixMonths(rows, countKey = 'count') {
  const keyed = Object.fromEntries(rows.map(r => [r.month, Number(r[countKey] || 0)]));
  const now = new Date();
  const out = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const key = `${yyyy}-${mm}`;
    out.push({ month: key, [countKey]: keyed[key] || 0 });
  }
  return out;
}

function ReportCard({ title, children, icon: Icon }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function SimpleBar({ label, value, max, color = 'bg-indigo-500', onClick }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  // Disable click + cursor when value is 0 — nothing to drill into.
  const clickable = !!onClick && value > 0;
  const Wrap = clickable ? 'button' : 'div';
  const wrapProps = clickable
    ? { type: 'button', onClick, className: 'flex items-center gap-3 w-full text-left hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer' }
    : { className: 'flex items-center gap-3' };
  return (
    <Wrap {...wrapProps}>
      <span className="text-xs text-gray-600 w-20 truncate capitalize">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-bold text-gray-700 w-8 text-right">{value}</span>
    </Wrap>
  );
}

function SummaryRow({ label, value, color = 'text-gray-800', onClick }) {
  const baseCls = 'flex items-center justify-between py-2 border-b border-gray-50 last:border-0';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${baseCls} w-full text-left hover:bg-gray-50 -mx-2 px-2 rounded transition-colors cursor-pointer`}
      >
        <span className="text-sm text-gray-600">{label}</span>
        <span className={`text-sm font-bold ${color}`}>{value}</span>
      </button>
    );
  }
  return (
    <div className={baseCls}>
      <span className="text-sm text-gray-600">{label}</span>
      <span className={`text-sm font-bold ${color}`}>{value}</span>
    </div>
  );
}

// KPI card: small label + big number + optional sub-line. Used in the strip
// at the top of the Tickets tab.
function KpiCard({ icon: Icon, label, value, sub, tone = 'indigo' }) {
  const tones = {
    indigo: 'bg-indigo-50 text-indigo-600',
    green:  'bg-emerald-50 text-emerald-600',
    amber:  'bg-amber-50 text-amber-600',
    purple: 'bg-purple-50 text-purple-600',
  };
  return (
    <div className="card p-4 flex items-start gap-3">
      <div className={`p-2 rounded-lg flex-shrink-0 ${tones[tone]}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-gray-500 font-medium">{label}</p>
        <p className="text-2xl font-bold text-gray-800 leading-tight truncate">{value ?? '—'}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5 truncate">{sub}</p>}
      </div>
    </div>
  );
}

export default function AdminReports() {
  const [tickets, setTickets] = useState(null);
  const [revenue, setRevenue] = useState(null);
  const [planChanges, setPlanChanges] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  // Initial tab can be pre-set via ?tab=tickets|revenue|usage|custom — used by
  // Admin Dashboard's Revenue KPI tile so the click lands directly on the
  // Revenue report instead of the default Tickets one. Seeded from
  // window.location.search at module-eval time (not via a post-mount effect)
  // so the FIRST render uses the right tab — avoids a flash of the default
  // Tickets tab before the URL param effect can switch it.
  const [searchParamsReports, setSearchParamsReports] = useSearchParams();
  const [tab, setTab] = useState(() => {
    if (typeof window === 'undefined') return 'tickets';
    const t = (new URLSearchParams(window.location.search).get('tab') || '').toLowerCase();
    return ['tickets', 'revenue', 'usage', 'custom'].includes(t) ? t : 'tickets';
  });
  // Clean the URL once on mount so refresh + manual tab clicks aren't haunted by it.
  const tabParamConsumedRef = useRef(false);
  useEffect(() => {
    if (tabParamConsumedRef.current) return;
    if (searchParamsReports.get('tab')) {
      searchParamsReports.delete('tab');
      setSearchParamsReports(searchParamsReports, { replace: true });
    }
    tabParamConsumedRef.current = true;
  }, [searchParamsReports, setSearchParamsReports]);
  const [exporting, setExporting] = useState(false);
  // Drill-down modal state. `drill` is null when closed, or an object describing
  // which slice to fetch and how to render it. Each click handler sets this
  // shape; the modal renders + closes via setDrill(null).
  const [drill, setDrill] = useState(null);

  // Page-level date range. Hydrated from localStorage so a user's pick sticks
  // across refreshes. If the saved value was a relative preset (Last 30 days
  // etc.), recompute the actual from/to today rather than reusing the stale
  // dates from when the choice was first made.
  const [dateRange, setDateRange] = useState(() => {
    try {
      const stored = localStorage.getItem('admin_reports_date_range');
      if (!stored) return DEFAULT_RANGE;
      const parsed = JSON.parse(stored);
      if (parsed.presetId && parsed.presetId !== 'custom' && parsed.presetId !== 'all') {
        // Recompute relative presets so "Last 30 days" stays current
        const now = new Date();
        const isoDay = (d) => d.toISOString().slice(0, 10);
        if (parsed.presetId === 'year') {
          return { ...parsed, from: isoDay(new Date(now.getFullYear(), 0, 1)), to: isoDay(now) };
        }
        const days = parseInt(parsed.presetId, 10);
        if (isFinite(days)) {
          const start = new Date(now);
          start.setDate(start.getDate() - days + 1);
          return { ...parsed, from: isoDay(start), to: isoDay(now) };
        }
      }
      return parsed;
    } catch { return DEFAULT_RANGE; }
  });

  const handleDateRangeChange = (next) => {
    setDateRange(next);
    try { localStorage.setItem('admin_reports_date_range', JSON.stringify(next)); } catch {}
  };

  // Build the params object every fetch / drill sends. Omits keys when value
  // is null so the backend's "no filter" path keeps working.
  const dateParams = () => {
    const out = {};
    if (dateRange?.from) out.from = dateRange.from;
    if (dateRange?.to)   out.to   = dateRange.to;
    return out;
  };

  // ── Custom Reports tab state ───────────────────────────────────────────
  const [customReports, setCustomReports]   = useState([]);
  const [builderOpen, setBuilderOpen]       = useState(false);
  const [builderExisting, setBuilderExisting] = useState(null); // report being edited
  const loadCustomReports = () => {
    listCustomReports()
      .then(r => setCustomReports(r.data.reports || []))
      .catch(() => {});
  };
  useEffect(() => { loadCustomReports(); }, []);

  // Open shortcuts — one per resource. Each builds a drill descriptor and
  // merges in the page-level date range so the modal stays scoped to whatever
  // the admin filtered to. `defaultView` tells the modal which tab to land on
  // — picked per-click-source so it matches the natural question being asked
  // (e.g. an agent-row click defaults to By Agent, a usage-month click
  // defaults to By Customer). `groupable` controls whether the modal shows
  // the view tabs at all (invoices skip them).
  const openTickets  = (title, params, subtitle, defaultView = 'records') => setDrill({
    kind: 'tickets',  title, subtitle, params: { ...dateParams(), ...params },
    fetcher: getReportTickets,  dataKey: 'tickets',  columns: TICKET_COLS,  exportName: 'tickets',
    groupable: true, defaultView,
  });
  const openInvoices = (title, params, subtitle) => setDrill({
    kind: 'invoices', title, subtitle, params: { ...dateParams(), ...params },
    fetcher: getReportInvoices, dataKey: 'invoices', columns: INVOICE_COLS, exportName: 'invoices',
    groupable: false, defaultView: 'records',
  });
  const openCalls    = (title, params, subtitle, defaultView = 'records') => setDrill({
    kind: 'calls',    title, subtitle, params: { ...dateParams(), ...params },
    fetcher: getReportCalls,    dataKey: 'calls',    columns: CALL_COLS,    exportName: 'calls',
    groupable: true, defaultView,
  });
  const openChats    = (title, params, subtitle, defaultView = 'records') => setDrill({
    kind: 'chats',    title, subtitle, params: { ...dateParams(), ...params },
    fetcher: getReportChats,    dataKey: 'chats',    columns: CHAT_COLS,    exportName: 'chats',
    groupable: true, defaultView,
  });
  // Customers drill — used by the Revenue tab KPI cards + Plan Distribution
  // rows. Each customer is a unique entity, so the modal doesn't show grouped
  // views (groupable=false). The date range doesn't filter the list itself
  // (customers are point-in-time state, not events) — but the "New Conversions"
  // click DOES want the date range, which is forwarded as converted_from/to.
  const openCustomers = (title, params, subtitle) => setDrill({
    kind: 'customers', title, subtitle, params,
    fetcher: getReportCustomers, dataKey: 'customers', columns: CUSTOMER_COLS, exportName: 'customers',
    groupable: false, defaultView: 'records',
  });

  const handleExport = async () => {
    setExporting(true);
    try {
      // Export the dataset that matches the active tab — previously this
      // always exported "tickets" or "csat" regardless of which tab the
      // admin was looking at, which was confusing.
      const res = await exportReportCsv({ type: tab });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${tab}_export_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('CSV downloaded');
    } catch { toast.error('Export failed'); }
    finally { setExporting(false); }
  };

  const load = () => {
    setLoading(true);
    const p = dateParams();
    Promise.all([
      getTicketReport(p),
      getRevenueReport(p),
      getUsageReport(p),
      getPlanChangeReport(p.from, p.to).catch(() => ({ data: { counts: {} } })),
    ])
      .then(([t, r, u, pc]) => {
        setTickets(t.data);
        setRevenue(r.data);
        setUsage(u.data);
        setPlanChanges(pc.data.counts || {});
      })
      .catch(() => toast.error('Failed to load reports'))
      .finally(() => setLoading(false));
  };

  // Refetch every time the date range changes — preset clicks and custom
  // applies both flow through this. eslint-disable because handleDateRange-
  // Change captures `dateRange` only via re-render, not via deps.
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dateRange?.from, dateRange?.to]);

  useGlobalRefresh(load);

  const tabs = [
    { id: 'tickets', label: 'Tickets',         icon: Ticket     },
    { id: 'revenue', label: 'Revenue',         icon: TrendingUp },
    { id: 'usage',   label: 'Usage',           icon: BarChart2  },
    { id: 'custom',  label: 'Custom Reports',  icon: Sparkles   },
  ];

  if (loading) return <Layout><div className="flex h-64 items-center justify-center"><div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" /></div></Layout>;

  // Derived (post-backfill) views — keep the JSX clean by computing once.
  const statusMap   = Object.fromEntries((tickets?.byStatus   || []).map(s => [s.status,   Number(s.count)]));
  const priorityMap = Object.fromEntries((tickets?.byPriority || []).map(p => [p.priority, Number(p.count)]));
  const ticketMonthly  = tickets ? backfillSixMonths(tickets.monthly, 'count') : [];
  const revenueMonthly = revenue ? backfillSixMonths(revenue.monthly, 'revenue') : [];

  // Usage tab: the backend now returns `displayMonth` indicating which month
  // the topCustomers list is actually for (falls back to most-recent-month if
  // the current month is empty). The UI labels it explicitly so the admin
  // isn't confused by "Top Customers This Month" showing last month's names.
  const usageDisplayMonth = usage?.displayMonth || null;

  // KPI strip — only renders when the backend KPIs payload is present.
  const k = tickets?.kpis || {};

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Reports</h1>
          <p className="text-sm text-gray-500 mt-0.5">Analytics and operational insights</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setBuilderExisting(null); setBuilderOpen(true); }}
            className="btn-primary flex items-center gap-1.5 text-sm"
          >
            <Plus className="w-4 h-4" /> Custom Report
          </button>
          <button onClick={handleExport} disabled={exporting} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button onClick={load} className="btn-secondary hidden lg:inline-flex"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      <DateRangeFilter value={dateRange} onChange={handleDateRangeChange} />

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-colors ${tab === t.id ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tickets report */}
      {tab === 'tickets' && tickets && (
        <>
          {/* KPI strip — quick numbers an admin would read first. Each card is
              clickable: opens a drill modal listing the underlying tickets. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <button type="button" onClick={() => openTickets('All tickets', {}, null, 'customer')} className="text-left">
              <KpiCard
                icon={Ticket}
                label="Total Tickets"
                value={k.total ?? 0}
                sub={k.closedCount != null ? `${k.closedCount} closed` : null}
                tone="indigo"
              />
            </button>
            <button type="button" onClick={() => openTickets('Closed tickets', { status: 'closed' }, 'Used to compute the average resolution time', 'agent')} className="text-left">
              <KpiCard
                icon={Clock}
                label="Avg Resolution Time"
                value={k.avgResolutionHours != null ? `${k.avgResolutionHours} h` : '—'}
                sub={k.avgResolutionHours != null ? 'closed-ticket avg' : 'no closed tickets yet'}
                tone="purple"
              />
            </button>
            <button type="button" onClick={() => openTickets('Tickets that met their SLA', { sla_met: 'true' }, 'Closed before the SLA-resolve deadline', 'agent')} className="text-left">
              <KpiCard
                icon={ShieldCheck}
                label="% SLA Met"
                value={k.slaMetPct != null ? `${k.slaMetPct}%` : '—'}
                sub={k.slaMetPct != null ? 'closed before SLA due' : 'no SLA-tracked tickets'}
                tone={k.slaMetPct == null ? 'indigo' : k.slaMetPct >= 90 ? 'green' : k.slaMetPct >= 70 ? 'amber' : 'indigo'}
              />
            </button>
            <button
              type="button"
              disabled={!k.topRequestType}
              onClick={() => k.topRequestType && openTickets(`Top request type: ${k.topRequestType}`, { request_type: k.topRequestType }, null, 'customer')}
              className="text-left disabled:cursor-default"
            >
              <KpiCard
                icon={Tag}
                label="Top Request Type"
                value={k.topRequestType || '—'}
                sub={k.topRequestTypeCount > 0 ? `${k.topRequestTypeCount} tickets` : 'not categorised'}
                tone="amber"
              />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <ReportCard title="Tickets by Status" icon={Ticket}>
              <div className="space-y-3">
                {STATUS_ORDER.map(s => {
                  const value = statusMap[s] || 0;
                  const max = Math.max(...STATUS_ORDER.map(x => statusMap[x] || 0), 1);
                  return (
                    <SimpleBar
                      key={s} label={s} value={value} max={max} color={STATUS_COLOR[s]}
                      onClick={() => openTickets(`${s.charAt(0).toUpperCase() + s.slice(1)} tickets`, { status: s }, null, 'customer')}
                    />
                  );
                })}
              </div>
            </ReportCard>

            <ReportCard title="Tickets by Priority" icon={Ticket}>
              <div className="space-y-3">
                {PRIORITY_ORDER.map(p => {
                  const value = priorityMap[p] || 0;
                  const max = Math.max(...PRIORITY_ORDER.map(x => priorityMap[x] || 0), 1);
                  return (
                    <SimpleBar
                      key={p} label={p} value={value} max={max} color={PRIORITY_COLOR[p]}
                      onClick={() => openTickets(`${p.charAt(0).toUpperCase() + p.slice(1)} priority tickets`, { priority: p }, null, 'customer')}
                    />
                  );
                })}
              </div>
            </ReportCard>

            <ReportCard title="Tickets by Plan" icon={Ticket}>
              <div className="space-y-3">
                {(tickets.byPlan || []).map(p => {
                  const isNoPlan = p.plan_name == null;
                  const label = isNoPlan ? '(no plan)' : p.plan_name;
                  return (
                    <SimpleBar
                      key={label}
                      label={label}
                      value={Number(p.ticket_count)}
                      max={Math.max(...tickets.byPlan.map(x => Number(x.ticket_count)), 1)}
                      color={isNoPlan ? 'bg-gray-300' : (PLAN_COLOR[p.plan_name] || 'bg-gray-400')}
                      onClick={() => openTickets(
                        isNoPlan ? 'Tickets without a plan' : `${p.plan_name.charAt(0).toUpperCase() + p.plan_name.slice(1)} plan tickets`,
                        isNoPlan ? { no_plan: 'true' } : { plan: p.plan_name },
                        null,
                        'customer'
                      )}
                    />
                  );
                })}
                {!tickets.byPlan?.length && (
                  <p className="text-xs text-gray-400">No data</p>
                )}
              </div>
            </ReportCard>

            <ReportCard title="Tickets by Agent (closed)" icon={UserCog}>
              <div className="space-y-3">
                {(tickets.byAgent || []).map(a => {
                  const isUnassigned = a.id == null;
                  const label = isUnassigned ? 'Unassigned' : a.agent_name;
                  return (
                    <SimpleBar
                      key={a.id ?? '__unassigned__'}
                      label={label}
                      value={Number(a.ticket_count)}
                      max={Math.max(...tickets.byAgent.map(x => Number(x.ticket_count)), 1)}
                      color={isUnassigned ? 'bg-gray-300' : 'bg-indigo-500'}
                      onClick={() => openTickets(
                        isUnassigned ? 'Closed tickets — unassigned' : `${a.agent_name} — closed tickets`,
                        isUnassigned ? { status: 'closed', no_agent: 'true' } : { agent_id: a.id, status: 'closed' },
                        null,
                        'records'
                      )}
                    />
                  );
                })}
                {!tickets.byAgent?.length && (
                  <p className="text-xs text-gray-400">No closed tickets yet</p>
                )}
              </div>
            </ReportCard>

            <div className="md:col-span-2">
              <ReportCard title="Monthly Ticket Volume (Last 6 Months)" icon={BarChart2}>
                <div className="flex items-end gap-3 h-32">
                  {ticketMonthly.map(m => {
                    const maxVal = Math.max(...ticketMonthly.map(x => x.count), 1);
                    const pct = (m.count / maxVal) * 100;
                    const clickable = m.count > 0;
                    const inner = (
                      <>
                        <span className="text-xs font-bold text-gray-600">{m.count}</span>
                        <div className="w-full bg-gray-100 rounded-t-md overflow-hidden flex items-end" style={{ height: '70px' }}>
                          <div className={`w-full rounded-t-md transition-all ${m.count > 0 ? 'bg-indigo-500' : 'bg-gray-200'}`} style={{ height: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-gray-400 truncate w-full text-center">{prettyMonth(m.month)}</span>
                      </>
                    );
                    return clickable ? (
                      <button
                        key={m.month}
                        type="button"
                        onClick={() => openTickets(`Tickets in ${prettyMonth(m.month)}`, { month: m.month }, null, 'customer')}
                        className="flex-1 flex flex-col items-center gap-1 min-w-0 hover:opacity-80 cursor-pointer"
                      >
                        {inner}
                      </button>
                    ) : (
                      <div key={m.month} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                        {inner}
                      </div>
                    );
                  })}
                </div>
              </ReportCard>
            </div>
          </div>
        </>
      )}

      {/* Revenue report */}
      {tab === 'revenue' && revenue && (() => {
        const rk = revenue.kpis || {};
        const arrK = revenue.arrBreakdown || {};
        const totalC = rk.totalCustomers || 0;
        const pct = (n) => totalC > 0 ? Math.round((n / totalC) * 100) : 0;
        return (
        <>
          {/* === ARR / MRR strip — forward-looking subscription value ====== */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <KpiCard
              icon={TrendingUp}
              label="Annual Recurring Revenue"
              value={`₹${Number(arrK.arr || 0).toLocaleString('en-IN')}`}
              sub={`${arrK.payingCustomers || 0} paying customer${(arrK.payingCustomers || 0) === 1 ? '' : 's'}`}
              tone="green"
            />
            <KpiCard
              icon={TrendingUp}
              label="Monthly Recurring Revenue"
              value={`₹${Number(arrK.mrr || 0).toLocaleString('en-IN')}`}
              sub="ARR ÷ 12 · what we bill per month at current prices"
              tone="indigo"
            />
            <KpiCard
              icon={CreditCard}
              label="Paying Customers"
              value={arrK.payingCustomers || 0}
              sub="Basic / Moderate / Premium with non-expired plans"
              tone="purple"
            />
            <KpiCard
              icon={CreditCard}
              label="Free Customers"
              value={arrK.freeCustomers || 0}
              sub="₹0 contribution to ARR — upsell candidates"
              tone="amber"
            />
          </div>

          {/* === ARR by plan — what each tier contributes to recurring revenue */}
          {revenue.arrByPlan && revenue.arrByPlan.length > 0 && (
            <div className="card p-5 mb-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-500" />
                ARR by plan
              </h3>
              <div className="space-y-2">
                {revenue.arrByPlan.filter(p => p.plan_name !== 'free').map(p => {
                  const max = Math.max(...revenue.arrByPlan.filter(x => x.plan_name !== 'free').map(x => x.plan_arr), 1);
                  const widthPct = (p.plan_arr / max) * 100;
                  return (
                    <div key={p.plan_name}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="capitalize font-medium text-gray-700">
                          {p.plan_name} · {p.active_customers} customer{p.active_customers === 1 ? '' : 's'} × ₹{p.plan_price.toLocaleString('en-IN')}/yr
                        </span>
                        <span className="font-bold text-gray-800">₹{p.plan_arr.toLocaleString('en-IN')}</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
                        <div className="h-1.5 rounded-full bg-emerald-400" style={{ width: `${widthPct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-gray-400 mt-3">
                Annual Recurring Revenue from active paid customers, broken down by plan. Forward-looking — assumes no churn. Set prices in Plans → each card's "Yearly price".
              </p>
            </div>
          )}

          {/* Customer KPI strip. "Conversions" uses first-paid-invoice as the
              proxy — see getRevenueReport for the SQL. Not clickable yet since
              we don't have a customers drill modal; the count itself is the
              answer. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <button type="button" onClick={() => openCustomers('All customers', {})} className="text-left">
              <KpiCard
                icon={Users}
                label="Total Customers"
                value={totalC}
                sub={rk.noPlanCustomers ? `${rk.noPlanCustomers} with no plan link` : null}
                tone="indigo"
              />
            </button>
            <button type="button" onClick={() => openCustomers('Customers on Free plan', { plan: 'free' })} className="text-left">
              <KpiCard
                icon={CreditCard}
                label="On Free Plan"
                value={rk.freeCustomers || 0}
                sub={totalC ? `${pct(rk.freeCustomers || 0)}% of customers` : null}
                tone="amber"
              />
            </button>
            <button type="button" onClick={() => openCustomers('Customers on Paid plans', { plan_group: 'paid' }, 'Basic / Moderate / Premium')} className="text-left">
              <KpiCard
                icon={CreditCard}
                label="On Paid Plan"
                value={rk.paidCustomers || 0}
                sub={totalC ? `${pct(rk.paidCustomers || 0)}% of customers · basic / moderate / premium` : null}
                tone="green"
              />
            </button>
            <button
              type="button"
              disabled={!rk.conversionsInRange}
              onClick={() => openCustomers(
                'New conversions in date range',
                { converted_from: dateRange?.from || undefined, converted_to: dateRange?.to || undefined },
                "Customers whose first paid invoice fell in the selected date range"
              )}
              className="text-left disabled:cursor-default"
            >
              <KpiCard
                icon={ArrowUpCircle}
                label="New Conversions"
                value={rk.conversionsInRange || 0}
                sub="Customers with first paid invoice in this range"
                tone="purple"
              />
            </button>
          </div>

          {/* Plan Changes in date range — counts of state transitions from
              the plan_change_history table. Shows churn signal at a glance.
              Net = upgrades − downgrades − expiry_lapse. */}
          {planChanges && (
            <div className="mb-4">
              <ReportCard title="Plan Changes (in date range)" icon={ArrowUpCircle}>
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                  {[
                    { kind: 'signup',       label: 'Signups',         tone: 'text-blue-700 bg-blue-50 border-blue-100' },
                    { kind: 'upgrade',      label: 'Upgrades',        tone: 'text-emerald-700 bg-emerald-50 border-emerald-100' },
                    { kind: 'renewal',      label: 'Renewals',        tone: 'text-indigo-700 bg-indigo-50 border-indigo-100' },
                    { kind: 'downgrade',    label: 'Downgrades',      tone: 'text-amber-700 bg-amber-50 border-amber-100' },
                    { kind: 'expiry_lapse', label: 'Lapsed to Free',  tone: 'text-gray-700 bg-gray-50 border-gray-200' },
                    { kind: 'manual_admin', label: 'Admin changes',   tone: 'text-purple-700 bg-purple-50 border-purple-100' },
                  ].map(c => (
                    <div key={c.kind} className={`rounded-lg border px-3 py-2 ${c.tone}`}>
                      <div className="text-2xl font-bold leading-none">{planChanges[c.kind] || 0}</div>
                      <div className="text-[11px] mt-1 opacity-80">{c.label}</div>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400 mt-3">
                  Net plan movement (upgrades − downgrades − lapses):{' '}
                  <strong className={
                    ((planChanges.upgrade || 0) - (planChanges.downgrade || 0) - (planChanges.expiry_lapse || 0)) >= 0
                      ? 'text-emerald-600' : 'text-red-600'
                  }>
                    {(() => {
                      const net = (planChanges.upgrade || 0) - (planChanges.downgrade || 0) - (planChanges.expiry_lapse || 0);
                      return (net > 0 ? '+' : '') + net;
                    })()}
                  </strong>
                </p>
              </ReportCard>
            </div>
          )}

          {/* Plan Distribution card — point-in-time counts per plan. Sits
              full-width above the existing revenue cards. */}
          <div className="mb-4">
            <ReportCard title="Plan Distribution (current customers)" icon={CreditCard}>
              <div className="space-y-3">
                {(revenue.planCounts || []).length === 0 ? (
                  <p className="text-xs text-gray-400">No customers yet</p>
                ) : (
                  (revenue.planCounts || []).map(p => {
                    const labelRaw = p.plan_name == null ? '(no plan)' : p.plan_name;
                    const label = p.plan_name == null ? '(no plan)' : labelRaw.charAt(0).toUpperCase() + labelRaw.slice(1);
                    const max = Math.max(...(revenue.planCounts || []).map(x => x.count), 1);
                    const color = p.plan_name == null
                      ? 'bg-gray-300'
                      : (PLAN_COLOR[p.plan_name] || 'bg-gray-400');
                    return (
                      <SimpleBar
                        key={labelRaw}
                        label={label}
                        value={p.count}
                        max={max}
                        color={color}
                        onClick={() => openCustomers(
                          p.plan_name == null ? 'Customers with no plan' : `Customers on ${label} plan`,
                          p.plan_name == null ? { no_plan: 'true' } : { plan: p.plan_name }
                        )}
                      />
                    );
                  })
                )}
              </div>
            </ReportCard>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ReportCard title="Revenue Summary" icon={TrendingUp}>
            <SummaryRow
              label="Paid Revenue"
              value={`₹${Number(revenue.summary?.paid_revenue || 0).toLocaleString('en-IN')}`}
              color="text-green-600"
              onClick={() => openInvoices('Paid invoices', { status: 'paid' })}
            />
            <SummaryRow
              label="Pending Revenue"
              value={`₹${Number(revenue.summary?.pending_revenue || 0).toLocaleString('en-IN')}`}
              color="text-amber-600"
              onClick={() => openInvoices('Pending invoices', { status: 'pending' })}
            />
            <SummaryRow
              label="Overdue Revenue"
              value={`₹${Number(revenue.summary?.overdue_revenue || 0).toLocaleString('en-IN')}`}
              color="text-red-600"
              onClick={() => openInvoices('Overdue invoices', { status: 'overdue' })}
            />
          </ReportCard>

          <ReportCard title="Revenue by Plan" icon={TrendingUp}>
            <div className="space-y-3">
              {revenue.byPlan.map(p => (
                <button
                  key={p.plan_name}
                  type="button"
                  onClick={() => openInvoices(`Paid invoices · ${p.plan_name.charAt(0).toUpperCase() + p.plan_name.slice(1)} plan`, { status: 'paid', plan: p.plan_name })}
                  className="w-full text-left hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="capitalize text-gray-600">{p.plan_name}</span>
                    <span className="font-bold text-gray-800">₹{Number(p.revenue || 0).toLocaleString('en-IN')} ({p.count})</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                    <div className="h-2 rounded-full bg-green-500" style={{ width: `${revenue.summary?.paid_revenue ? (p.revenue / revenue.summary.paid_revenue) * 100 : 0}%` }} />
                  </div>
                </button>
              ))}
              {!revenue.byPlan.length && <p className="text-xs text-gray-400">No paid revenue yet</p>}
            </div>
          </ReportCard>

          <ReportCard title="Monthly Revenue (Last 6 Months)" icon={TrendingUp}>
            <div className="space-y-2">
              {revenueMonthly.map(m => {
                const hasData = m.revenue > 0;
                const inner = (
                  <>
                    <span className="text-gray-600">{prettyMonth(m.month)}</span>
                    <span className={`font-bold ${hasData ? 'text-green-600' : 'text-gray-300'}`}>
                      ₹{Number(m.revenue || 0).toLocaleString('en-IN')}
                    </span>
                  </>
                );
                return hasData ? (
                  <button
                    key={m.month}
                    type="button"
                    onClick={() => openInvoices(`Paid invoices · ${prettyMonth(m.month)}`, { status: 'paid', month: m.month })}
                    className="flex items-center justify-between text-sm w-full hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer"
                  >
                    {inner}
                  </button>
                ) : (
                  <div key={m.month} className="flex items-center justify-between text-sm">{inner}</div>
                );
              })}
            </div>
          </ReportCard>
          </div>
        </>
        );
      })()}

      {/* Usage report */}
      {tab === 'usage' && usage && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ReportCard title="Monthly Ticket Usage" icon={Ticket}>
            <div className="space-y-2">
              {usage.ticketUsage.length === 0 ? <p className="text-sm text-gray-400">No data</p> : usage.ticketUsage.map(u => (
                <button
                  key={u.month_year}
                  type="button"
                  onClick={() => openTickets(`Tickets in ${prettyMonth(u.month_year)}`, { month: u.month_year }, null, 'customer')}
                  className="flex items-center justify-between text-sm w-full hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer"
                >
                  <span className="text-gray-600">{prettyMonth(u.month_year)}</span>
                  <span className="font-bold text-indigo-600">{u.total_tickets} tickets</span>
                </button>
              ))}
            </div>
          </ReportCard>

          <ReportCard title="Monthly Chat Usage" icon={MessageSquare}>
            <div className="space-y-2">
              {!usage.chatUsage?.length ? <p className="text-sm text-gray-400">No chats yet</p> : usage.chatUsage.map(u => (
                <button
                  key={u.month_year}
                  type="button"
                  onClick={() => openChats(`Chats in ${prettyMonth(u.month_year)}`, { month: u.month_year }, null, 'customer')}
                  className="flex items-center justify-between text-sm w-full hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer"
                >
                  <span className="text-gray-600">{prettyMonth(u.month_year)}</span>
                  <span className="font-bold text-purple-600">{u.total_chats} chats</span>
                </button>
              ))}
            </div>
          </ReportCard>

          <ReportCard title="Monthly Call Usage" icon={Phone}>
            <div className="space-y-2">
              {usage.callUsage.length === 0 ? <p className="text-sm text-gray-400">No calls yet</p> : usage.callUsage.map(u => (
                <button
                  key={u.month_year}
                  type="button"
                  onClick={() => openCalls(`Calls in ${prettyMonth(u.month_year)}`, { month: u.month_year }, null, 'customer')}
                  className="flex items-center justify-between text-sm w-full hover:bg-gray-50 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer"
                >
                  <span className="text-gray-600">{prettyMonth(u.month_year)}</span>
                  <span className="font-bold text-amber-600">{u.total_calls} calls</span>
                </button>
              ))}
            </div>
          </ReportCard>

          <div className="md:col-span-2 lg:col-span-3">
            <ReportCard title={`Top Customers by Ticket Volume · ${usageDisplayMonth ? prettyMonth(usageDisplayMonth) : 'This Month'}`} icon={BarChart2}>
              {usage.topCustomers.length === 0 ? (
                <p className="text-sm text-gray-400 py-3">No customer ticket activity this month yet.</p>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[560px] lg:min-w-0">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-100">
                      <th className="text-left py-2">Customer</th>
                      <th className="text-left py-2">Domain</th>
                      <th className="text-left py-2">Plan</th>
                      <th className="text-right py-2">Tickets</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {usage.topCustomers.map((c, i) => (
                      <tr
                        key={i}
                        className="text-sm hover:bg-gray-50 cursor-pointer"
                        onClick={() => openTickets(
                          `${c.name} — tickets in ${prettyMonth(usageDisplayMonth || new Date().toISOString().slice(0,7))}`,
                          { customer_id: c.customer_id, month: usageDisplayMonth || undefined }
                        )}
                      >
                        <td className="py-2 font-medium text-gray-700">{c.name}</td>
                        <td className="py-2 text-gray-500">{c.domain}</td>
                        <td className="py-2"><span className="badge bg-indigo-50 text-indigo-700 capitalize">{c.plan_name}</span></td>
                        <td className="py-2 text-right font-bold text-indigo-600">{c.tickets_this_month}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </ReportCard>
          </div>
        </div>
      )}

      {/* Custom Reports tab — every saved report shows as a card. Card body
          fetches its live count via /custom-reports/:id/count; the View
          button opens the standard DrillDownModal pre-populated with the
          saved filters and the admin's chosen column subset. */}
      {tab === 'custom' && (
        <CustomReportsTab
          reports={customReports}
          dateParams={dateParams()}
          onCreate={() => { setBuilderExisting(null); setBuilderOpen(true); }}
          onEdit={(r) => { setBuilderExisting(r); setBuilderOpen(true); }}
          onDeleted={loadCustomReports}
          onOpenDrill={(report) => {
            // Build column defs from the saved column-key list using the
            // canonical COLUMN_SPEC so cell formatting matches the rest of
            // the Reports page.
            const savedCols = typeof report.columns === 'string' ? JSON.parse(report.columns) : report.columns;
            const specCols = COLUMN_SPEC[report.resource] || [];
            const orderedCols = specCols
              .filter(c => savedCols.includes(c.key))
              .map(c => ({
                key: c.key,
                label: c.label,
                align: c.align,
                format: (v) => formatCustomCell(v, c.key),
              }));
            const savedFilters = typeof report.filters === 'string' ? JSON.parse(report.filters) : report.filters;
            const fetcher = {
              tickets: getReportTickets, invoices: getReportInvoices, calls: getReportCalls,
              chats: getReportChats, customers: getReportCustomers, agents: getReportAgents,
            }[report.resource];
            setDrill({
              kind: report.resource,
              title: report.name,
              subtitle: `Saved custom report · ${RESOURCE_LABELS[report.resource]}`,
              params: { ...dateParams(), ...(savedFilters || {}) },
              fetcher,
              dataKey: report.resource,
              columns: orderedCols,
              exportName: report.name.replace(/\s+/g, '_'),
              groupable: report.resource !== 'invoices' && report.resource !== 'customers' && report.resource !== 'agents',
              defaultView: 'records',
            });
          }}
        />
      )}

      {builderOpen && (
        <CustomReportBuilder
          existing={builderExisting}
          dateParams={dateParams()}
          onClose={() => setBuilderOpen(false)}
          onSaved={() => { setBuilderOpen(false); loadCustomReports(); }}
        />
      )}

      {drill && (
        <DrillDownModal
          title={drill.title}
          subtitle={drill.subtitle}
          fetcher={drill.fetcher}
          dataKey={drill.dataKey}
          params={drill.params}
          columns={drill.columns}
          exportName={drill.exportName}
          groupable={drill.groupable}
          defaultView={drill.defaultView}
          onClose={() => setDrill(null)}
        />
      )}
    </Layout>
  );
}

// ── Custom Reports tab ────────────────────────────────────────────────────
// Lives on the Reports page. Renders saved reports as a grid of cards; each
// card live-fetches its current count using the page-level date range. An
// empty state nudges the admin to click "+ Custom Report" up in the header.
function CustomReportsTab({ reports, dateParams, onCreate, onEdit, onDeleted, onOpenDrill }) {
  if (!reports.length) {
    return (
      <div className="card p-12 flex flex-col items-center text-gray-400">
        <Sparkles className="w-10 h-10 mb-3 opacity-30" />
        <p className="text-sm font-medium text-gray-600">No custom reports yet</p>
        <p className="text-xs mt-1">Click the "Custom Report" button above to build one.</p>
        <button onClick={onCreate} className="btn-primary mt-4 text-sm flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New custom report
        </button>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {reports.map(r => (
        <CustomReportCard
          key={r.id}
          report={r}
          dateParams={dateParams}
          onEdit={() => onEdit(r)}
          onDeleted={onDeleted}
          onOpen={() => onOpenDrill(r)}
        />
      ))}
    </div>
  );
}

function CustomReportCard({ report, dateParams, onEdit, onDeleted, onOpen }) {
  const [count, setCount] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    getCustomReportCount(report.id, dateParams)
      .then(r => setCount(r.data.count))
      .catch(() => setCount('—'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report.id, dateParams.from, dateParams.to]);

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${report.name}"? This can't be undone.`)) return;
    try {
      await deleteCustomReport(report.id);
      toast.success('Report deleted');
      onDeleted?.();
    } catch { toast.error('Delete failed'); }
  };

  // Summarise the saved filters as "k: v · k: v" so the admin sees at a
  // glance what the report queries without opening it. Empty when no
  // filters were saved.
  const filters = typeof report.filters === 'string' ? JSON.parse(report.filters) : report.filters || {};
  const filterSummary = Object.entries(filters).map(([k, v]) => `${k}: ${v}`).join(' · ');

  return (
    <div className="card p-5 relative">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">{RESOURCE_LABELS[report.resource]}</p>
          <h3 className="text-sm font-semibold text-gray-800 truncate">{report.name}</h3>
        </div>
        <div className="relative flex-shrink-0">
          <button onClick={() => setMenuOpen(v => !v)} className="p-1 -mr-1 text-gray-400 hover:text-gray-600">
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-1 bg-white border border-gray-100 rounded-lg shadow-lg z-10 w-32 py-1 text-sm">
              <button onClick={() => { setMenuOpen(false); onEdit(); }} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 text-gray-700">
                <Edit className="w-3.5 h-3.5" /> Edit
              </button>
              <button onClick={() => { setMenuOpen(false); handleDelete(); }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 flex items-center gap-2 text-red-600">
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
      <p className="text-3xl font-bold text-gray-800 leading-tight mb-1">
        {count === null ? <span className="text-gray-300">…</span> : count}
      </p>
      <p className="text-xs text-gray-400 mb-3">records in current date range</p>
      {filterSummary && (
        <p className="text-[11px] text-gray-500 mb-3 line-clamp-2" title={filterSummary}>
          Filters: <span className="font-mono">{filterSummary}</span>
        </p>
      )}
      {report.created_by_name && (
        <p className="text-[11px] text-gray-400 mb-3">Created by {report.created_by_name}</p>
      )}
      <button onClick={onOpen} className="btn-secondary w-full text-xs py-1.5 flex items-center justify-center gap-1.5">
        <Eye className="w-3.5 h-3.5" /> View →
      </button>
    </div>
  );
}
