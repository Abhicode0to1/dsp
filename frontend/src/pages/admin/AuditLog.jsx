import { useEffect, useState, useCallback, useRef } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import RowsPerPageSelect, { readStoredPageSize } from '../../components/common/RowsPerPageSelect';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import {
  getAuditLogs, getAuditActors, getAuditSummary, exportAuditCsv,
} from '../../services/api';
import {
  ClipboardList, RefreshCw, ChevronLeft, ChevronRight, X, ExternalLink, Globe2, User,
  Search, Calendar, Download, ArrowUp, ArrowDown, Zap, Activity, AlertTriangle,
} from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';

const PAGE_SIZE_KEY = 'dsp_admin_audit_page_size';

const ACTION_LABELS = {
  password_changed:           'Password changed by admin',
  password_changed_self:      'Password changed by customer (password)',
  password_changed_self_otp:  'Password changed by customer (email OTP)',
  profile_updated:            'Profile updated',
  usage_reset:                'Usage counters reset',
  usage_reset_bulk:           'Usage reset (bulk)',
  overrides_updated:          'Support access overrides updated',
  overrides_cleared:          'Support access overrides cleared',
  plan_changed_bulk:          'Plan changed (bulk)',
  welcome_email_resent:       'Welcome email re-sent',
  'agent.promoted_to_admin':  'Agent promoted to admin',
  'agent.demoted_to_agent':   'Admin demoted to agent',
};

function inferLabel(action) {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  return String(action || '')
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function actionColor(action) {
  const a = String(action || '').toLowerCase();
  if (a.includes('_self')) return 'bg-emerald-100 text-emerald-700 border-emerald-200';
  if (a.includes('promoted')) return 'bg-purple-100 text-purple-700 border-purple-200';
  if (a.includes('demoted'))  return 'bg-amber-100 text-amber-700 border-amber-200';
  if (a.includes('cleared') || a.includes('deleted') || a.includes('removed'))
    return 'bg-red-100 text-red-700 border-red-200';
  if (a.includes('reset'))    return 'bg-amber-100 text-amber-700 border-amber-200';
  if (a.includes('resent') || a.includes('added') || a.includes('created'))
    return 'bg-indigo-100 text-indigo-700 border-indigo-200';
  if (a.includes('changed') || a.includes('updated'))
    return 'bg-blue-100 text-blue-700 border-blue-200';
  return 'bg-gray-100 text-gray-600 border-gray-200';
}

function roleColor(role) {
  switch (role) {
    case 'admin':    return 'bg-indigo-50 text-indigo-700 border-indigo-200';
    case 'agent':    return 'bg-purple-50 text-purple-700 border-purple-200';
    case 'customer': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    default:         return 'bg-gray-50 text-gray-600 border-gray-200';
  }
}

function entityLink(entity_type, entity_id) {
  if (!entity_id) return null;
  switch (entity_type) {
    case 'customer': return `/admin/customers?focus=${entity_id}`;
    case 'user':     return `/admin/agents`;
    case 'ticket':   return `/admin/tickets?focus=${entity_id}`;
    default:         return null;
  }
}

function formatChange(old_val, new_val) {
  try {
    const o = old_val ? JSON.parse(old_val) : null;
    const n = new_val ? JSON.parse(new_val) : null;
    if (!o && n) return `Created: ${JSON.stringify(n).slice(0, 80)}`;
    if (o && !n) return `Deleted: ${JSON.stringify(o).slice(0, 80)}`;
    if (o && n) {
      const changed = Object.keys(n).filter(k => JSON.stringify(o[k]) !== JSON.stringify(n[k]));
      if (changed.length === 0) return '—';
      return changed.map(k => `${k}: ${JSON.stringify(o[k])} → ${JSON.stringify(n[k])}`).join(', ').slice(0, 100);
    }
    return '—';
  } catch { return '—'; }
}

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// Date presets — value is a function returning {from, to} as YYYY-MM-DD.
// Empty {from:'', to:''} = "all time".
function presetRange(preset) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  switch (preset) {
    case '24h': {
      const d = new Date(); d.setDate(d.getDate() - 1);
      return { from: fmt(d), to: fmt(today) };
    }
    case '7d': {
      const d = new Date(); d.setDate(d.getDate() - 7);
      return { from: fmt(d), to: fmt(today) };
    }
    case '30d': {
      const d = new Date(); d.setDate(d.getDate() - 30);
      return { from: fmt(d), to: fmt(today) };
    }
    case 'year': {
      return { from: `${today.getFullYear()}-01-01`, to: fmt(today) };
    }
    default: return { from: '', to: '' };
  }
}

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actors, setActors] = useState([]);
  const [summary, setSummary] = useState(null);

  // Filters — kept as one object so a single setFilters call from a preset
  // button can update multiple fields atomically (resetting page in the bargain).
  const [filters, setFilters] = useState({
    entity_type: '',
    actor_id: '',
    actor_role: '',     // 'admin' | 'agent' | 'customer' | 'system' — driven by KPI tile
    entity_id: '',
    search: '',
    actions: '',        // CSV of action codes — driven by Sensitive tile
    from: '',
    to: '',
    sort: 'created_at',
    order: 'desc',
    page: 1,
  });
  const [activePreset, setActivePreset] = useState('all'); // '24h' | '7d' | '30d' | 'year' | 'custom' | 'all'
  const [pageSize, setPageSize] = useState(() => readStoredPageSize(PAGE_SIZE_KEY));
  const [selectedLog, setSelectedLog] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Debounce search box → filters.search by 400ms so we don't fire on every keystroke
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim(), page: 1 });
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    setLoading(true);
    const params = {
      limit: pageSize,
      offset: (filters.page - 1) * pageSize,
      sort: filters.sort,
      order: filters.order,
    };
    if (filters.entity_type) params.entity_type = filters.entity_type;
    if (filters.actor_id)    params.actor_id = filters.actor_id;
    if (filters.actor_role)  params.actor_role = filters.actor_role;
    if (filters.entity_id)   params.entity_id = filters.entity_id;
    if (filters.search)      params.search = filters.search;
    if (filters.actions)     params.actions = filters.actions;
    if (filters.from)        params.from = filters.from;
    if (filters.to)          params.to = filters.to;
    getAuditLogs(params)
      .then(res => {
        setLogs(res.data.logs || []);
        setTotal(res.data.total || 0);
      })
      .catch(() => toast.error('Failed to load audit logs'))
      .finally(() => setLoading(false));
  }, [filters, pageSize]);

  useEffect(() => { load(); }, [load]);

  useGlobalRefresh(load);

  useEffect(() => {
    getAuditActors().then(r => setActors(r.data.actors || [])).catch(() => {});
    getAuditSummary().then(r => setSummary(r.data)).catch(() => {});
  }, []);

  // Auto-refresh — 30s interval while toggle is on. Refreshes both the table
  // and the KPI tiles so admin watching for an event can see it the moment
  // it's logged.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      load();
      getAuditSummary().then(r => setSummary(r.data)).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const applyPreset = (preset) => {
    const { from, to } = presetRange(preset);
    setActivePreset(preset);
    setFilters(f => ({ ...f, from, to, page: 1 }));
  };

  const toggleSort = (col) => {
    setFilters(f => {
      if (f.sort === col) return { ...f, order: f.order === 'asc' ? 'desc' : 'asc', page: 1 };
      return { ...f, sort: col, order: 'desc', page: 1 };
    });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const params = {
        sort: filters.sort, order: filters.order,
      };
      if (filters.entity_type) params.entity_type = filters.entity_type;
      if (filters.actor_id)    params.actor_id = filters.actor_id;
      if (filters.actor_role)  params.actor_role = filters.actor_role;
      if (filters.entity_id)   params.entity_id = filters.entity_id;
      if (filters.search)      params.search = filters.search;
      if (filters.actions)     params.actions = filters.actions;
      if (filters.from)        params.from = filters.from;
      if (filters.to)          params.to = filters.to;
      const r = await exportAuditCsv(params);
      const blob = new Blob([r.data], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Exported');
    } catch {
      toast.error('Export failed');
    } finally { setExporting(false); }
  };

  // Sort indicator on a column header — arrow only when this column is active.
  const SortIcon = ({ col }) => {
    if (filters.sort !== col) return <span className="inline-block w-3" />;
    return filters.order === 'asc'
      ? <ArrowUp   className="w-3 h-3 inline-block ml-0.5 text-indigo-500" />
      : <ArrowDown className="w-3 h-3 inline-block ml-0.5 text-indigo-500" />;
  };

  return (
    <Layout>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-50 rounded-lg flex items-center justify-center">
            <ClipboardList className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Audit Log</h1>
            <p className="text-sm text-gray-500 mt-0.5">All system changes tracked here · click any row for full details</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600 inline-flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="w-3.5 h-3.5 accent-indigo-600"
            />
            <Zap className={clsx('w-3.5 h-3.5', autoRefresh ? 'text-amber-500' : 'text-gray-400')} />
            <span>Live (30s)</span>
          </label>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="btn-secondary inline-flex items-center gap-1.5 text-sm"
            title="Download filtered view as CSV"
          >
            <Download className="w-3.5 h-3.5" />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <button onClick={load} className="btn-secondary p-2 hidden lg:inline-flex" title="Refresh">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* KPI tiles */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <KpiTile
            label="Actions in last 24h"
            value={summary.today}
            icon={Activity}
            tone="indigo"
            onClick={() => {
              // Pure date filter — clear any sensitive/role narrowing.
              setActivePreset('24h');
              setFilters(f => ({ ...f, ...presetRange('24h'), actions: '', actor_role: '', page: 1 }));
            }}
            active={activePreset === '24h' && !filters.actions && !filters.actor_role}
          />
          <KpiTile
            label="Sensitive actions (last 7d)"
            value={summary.sensitive_7d}
            sub="Admin promotions, password changes, plan/overrides edits"
            icon={AlertTriangle}
            tone="amber"
            onClick={() => {
              // Apply 7d range + the sensitive_actions list from the summary
              // endpoint as the `actions` CSV. Backend filters action IN (...).
              setActivePreset('7d');
              setFilters(f => ({
                ...f,
                ...presetRange('7d'),
                actions: (summary.sensitive_actions || []).join(','),
                actor_role: '',
                page: 1,
              }));
            }}
            active={!!filters.actions}
          />
          <KpiTile
            label="Customer self-actions (last 7d)"
            value={summary.self_7d}
            sub="Customers changing their own password/email"
            icon={User}
            tone="emerald"
            onClick={() => {
              setActivePreset('7d');
              setFilters(f => ({
                ...f,
                ...presetRange('7d'),
                actor_role: 'customer',
                actions: '',
                page: 1,
              }));
            }}
            active={filters.actor_role === 'customer'}
          />
        </div>
      )}

      {/* Filters row */}
      <div className="card p-4 mb-4 space-y-3">
        {/* Top: search + entity ID + dropdowns */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              className="input pl-8 w-full"
              placeholder="Search actor, action, entity ID…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
            />
          </div>
          <input
            type="text"
            inputMode="numeric"
            className="input w-32"
            placeholder="Entity ID #"
            value={filters.entity_id}
            onChange={e => setFilters(f => ({ ...f, entity_id: e.target.value.replace(/[^0-9]/g, ''), page: 1 }))}
          />
          <select
            className="input"
            value={filters.entity_type}
            onChange={e => setFilters(f => ({ ...f, entity_type: e.target.value, page: 1 }))}
          >
            <option value="">All Types</option>
            {['ticket', 'chat', 'user', 'customer', 'canned_response', 'csat', 'settings'].map(t => (
              <option key={t} value={t}>{t.replace('_', ' ')}</option>
            ))}
          </select>
          <select
            className="input"
            value={filters.actor_id}
            onChange={e => setFilters(f => ({ ...f, actor_id: e.target.value, page: 1 }))}
          >
            <option value="">All Users ({actors.reduce((s, a) => s + (a.action_count || 0), 0)} entries)</option>
            {actors.map(a => (
              <option key={a.actor_id} value={a.actor_id}>
                {a.actor_name} ({a.actor_role}) · {a.action_count}
              </option>
            ))}
          </select>
        </div>

        {/* Bottom: date range presets + custom */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Calendar className="w-3.5 h-3.5 text-gray-400" />
          {[
            { id: 'all',  label: 'All time'   },
            { id: '24h',  label: 'Last 24h'   },
            { id: '7d',   label: 'Last 7d'    },
            { id: '30d',  label: 'Last 30d'   },
            { id: 'year', label: 'This year'  },
          ].map(p => (
            <button
              key={p.id}
              onClick={() => applyPreset(p.id)}
              className={clsx(
                'px-2.5 py-1 rounded-lg border text-xs font-medium',
                activePreset === p.id
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                  : 'border-gray-200 hover:border-gray-300 text-gray-600'
              )}
            >
              {p.label}
            </button>
          ))}
          <span className="text-gray-300 mx-1">·</span>
          <span className="text-gray-500">Custom:</span>
          <input
            type="date"
            className="border border-gray-200 rounded px-2 py-1 text-xs"
            value={filters.from}
            onChange={e => { setActivePreset('custom'); setFilters(f => ({ ...f, from: e.target.value, page: 1 })); }}
          />
          <span className="text-gray-400">→</span>
          <input
            type="date"
            className="border border-gray-200 rounded px-2 py-1 text-xs"
            value={filters.to}
            onChange={e => { setActivePreset('custom'); setFilters(f => ({ ...f, to: e.target.value, page: 1 })); }}
          />
          {(filters.from || filters.to || filters.search || filters.entity_id || filters.actor_id || filters.entity_type || filters.actor_role || filters.actions) && (
            <button
              onClick={() => {
                setFilters({ entity_type: '', actor_id: '', actor_role: '', entity_id: '', search: '', actions: '', from: '', to: '', sort: 'created_at', order: 'desc', page: 1 });
                setSearchInput('');
                setActivePreset('all');
              }}
              className="ml-auto text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Clear all
            </button>
          )}
        </div>
      </div>

      {/* Active special-filter chips (only visible when actions/actor_role
          are set by a KPI tile — date/search are already visually
          represented by their own inputs). */}
      {(filters.actions || filters.actor_role) && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          {filters.actions && (
            <span className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 text-amber-800 px-2.5 py-1 rounded-full">
              <AlertTriangle className="w-3 h-3" />
              Sensitive actions only
              <button
                onClick={() => setFilters(f => ({ ...f, actions: '', page: 1 }))}
                className="hover:text-amber-900"
                title="Clear filter"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
          {filters.actor_role && (
            <span className={clsx(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border',
              filters.actor_role === 'customer' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-gray-50 border-gray-200 text-gray-700'
            )}>
              <User className="w-3 h-3" />
              Role: {filters.actor_role}
              <button
                onClick={() => setFilters(f => ({ ...f, actor_role: '', page: 1 }))}
                className="hover:opacity-70"
                title="Clear filter"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="w-7 h-7 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px] lg:min-w-0">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <SortableHeader col="created_at" onSort={toggleSort} sortIcon={<SortIcon col="created_at" />} className="w-40">When</SortableHeader>
                  <SortableHeader col="actor_name" onSort={toggleSort} sortIcon={<SortIcon col="actor_name" />} className="w-32">Actor</SortableHeader>
                  <SortableHeader col="action"     onSort={toggleSort} sortIcon={<SortIcon col="action"     />}>Action</SortableHeader>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600 w-24">Type</th>
                  <SortableHeader col="entity_id" onSort={toggleSort} sortIcon={<SortIcon col="entity_id" />} className="w-16">ID</SortableHeader>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {logs.length === 0 && (
                  <tr><td colSpan="6" className="text-center py-12 text-gray-400">No audit logs match these filters</td></tr>
                )}
                {logs.map(log => (
                  <tr
                    key={log.id}
                    onClick={() => setSelectedLog(log)}
                    className={clsx(
                      'cursor-pointer transition-colors hover:bg-gray-50',
                      log.actor_role === 'customer' && 'bg-emerald-50/30'
                    )}
                    title="Click for full details"
                  >
                    <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
                      {new Date(log.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="px-4 py-3 truncate max-w-[8rem]">
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium text-gray-700 text-xs truncate">
                          {log.actor_name || <span className="text-gray-400 italic">System</span>}
                        </span>
                        {log.actor_role && (
                          <span className={clsx('text-[10px] uppercase tracking-wider px-1.5 py-0 rounded border self-start', roleColor(log.actor_role))}>
                            {log.actor_role}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap', actionColor(log.action))}>
                        {inferLabel(log.action)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600 capitalize">{log.entity_type?.replace('_', ' ')}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">{log.entity_id ? `#${log.entity_id}` : '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-600 truncate max-w-xs" title={formatChange(log.old_value, log.new_value)}>
                      {formatChange(log.old_value, log.new_value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm text-gray-600 flex-wrap gap-2">
              <span>{total} total entries</span>
              <div className="flex items-center gap-4">
                <RowsPerPageSelect
                  value={pageSize}
                  onChange={(n) => { setPageSize(n); setFilters(f => ({ ...f, page: 1 })); }}
                  storageKey={PAGE_SIZE_KEY}
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setFilters(f => ({ ...f, page: Math.max(1, f.page - 1) }))}
                    disabled={filters.page <= 1}
                    className="p-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span>Page {filters.page} of {totalPages}</span>
                  <button
                    onClick={() => setFilters(f => ({ ...f, page: Math.min(totalPages, f.page + 1) }))}
                    disabled={filters.page >= totalPages}
                    className="p-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {selectedLog && <AuditDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} />}
    </Layout>
  );
}

function SortableHeader({ col, onSort, sortIcon, className, children }) {
  return (
    <th
      onClick={() => onSort(col)}
      className={clsx('text-left px-4 py-3 font-semibold text-gray-600 cursor-pointer select-none hover:text-gray-900', className)}
      title="Click to sort"
    >
      <span className="inline-flex items-center gap-0.5">{children}{sortIcon}</span>
    </th>
  );
}

function KpiTile({ label, value, sub, icon: Icon, tone, onClick, active }) {
  const tones = {
    indigo:  'border-indigo-200 bg-indigo-50 text-indigo-800',
    amber:   'border-amber-200 bg-amber-50 text-amber-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-lg border p-3 text-left transition-all',
        tones[tone] || tones.indigo,
        active ? 'ring-2 ring-offset-1 ring-current/40' : 'hover:shadow-sm'
      )}
    >
      <div className="flex items-start justify-between mb-1">
        <span className="text-[11px] font-medium opacity-80">{label}</span>
        {Icon && <Icon className="w-4 h-4 opacity-50" />}
      </div>
      <div className="text-2xl font-bold leading-none">{value}</div>
      {sub && <p className="text-[10px] opacity-60 mt-1">{sub}</p>}
    </button>
  );
}

function AuditDetailModal({ log, onClose }) {
  const link = entityLink(log.entity_type, log.entity_id);
  const oldJson = safeJson(log.old_value);
  const newJson = safeJson(log.new_value);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardList className="w-5 h-5 text-indigo-600 flex-shrink-0" />
            <h2 className="text-lg font-bold text-gray-800 truncate">{inferLabel(log.action)}</h2>
            <span className={clsx('text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ml-1 flex-shrink-0', actionColor(log.action))}>
              {log.action}
            </span>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto flex-1 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <Field label="When" value={new Date(log.created_at).toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'medium' })} />
            <Field
              label="Actor"
              value={(
                <span className="inline-flex items-center gap-2">
                  <User className="w-3.5 h-3.5 text-gray-400" />
                  {log.actor_name || 'System'}
                  {log.actor_role && (
                    <span className={clsx('text-[10px] uppercase tracking-wider px-1.5 py-0 rounded border', roleColor(log.actor_role))}>
                      {log.actor_role}
                    </span>
                  )}
                </span>
              )}
            />
            <Field
              label="Entity"
              value={(
                <span className="inline-flex items-center gap-1.5">
                  <span className="capitalize">{(log.entity_type || '').replace('_', ' ')}</span>
                  {log.entity_id && (
                    <span className="font-mono text-gray-500">#{log.entity_id}</span>
                  )}
                  {link && (
                    <RouterLink to={link} className="text-indigo-600 hover:underline inline-flex items-center gap-0.5 text-xs">
                      open <ExternalLink className="w-3 h-3" />
                    </RouterLink>
                  )}
                </span>
              )}
            />
            <Field
              label="IP address"
              value={(
                <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                  <Globe2 className="w-3.5 h-3.5 text-gray-400" />
                  {log.ip_address || <span className="text-gray-400 italic">(not captured)</span>}
                </span>
              )}
            />
          </div>

          {(oldJson != null || newJson != null) && (
            <div className="border-t border-gray-100 pt-4">
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-2">Change payload</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <JsonBlock label="Before" data={oldJson} tone="red" />
                <JsonBlock label="After"  data={newJson} tone="green" />
              </div>
            </div>
          )}

          <p className="text-[11px] text-gray-400 border-t border-gray-100 pt-3">
            <strong>Note:</strong> the change payload typically lists WHICH fields changed but not their actual values (to keep PII out of the log). For current values, open the entity above.
          </p>
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex justify-end flex-shrink-0">
          <button onClick={onClose} className="btn-secondary">Close</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400 mb-1">{label}</p>
      <div className="text-sm text-gray-700">{value || <span className="text-gray-400 italic">—</span>}</div>
    </div>
  );
}

function JsonBlock({ label, data, tone }) {
  const tones = {
    red:   'bg-red-50 border-red-100 text-red-900',
    green: 'bg-emerald-50 border-emerald-100 text-emerald-900',
  };
  return (
    <div>
      <p className={clsx('text-[10px] uppercase tracking-wider font-bold mb-1', tone === 'red' ? 'text-red-600' : 'text-emerald-600')}>
        {label}
      </p>
      <pre className={clsx('text-[11px] font-mono p-2 rounded border whitespace-pre-wrap break-all max-h-48 overflow-y-auto', tones[tone])}>
        {data == null
          ? <span className="text-gray-400 italic">(not set)</span>
          : (typeof data === 'object'
              ? JSON.stringify(data, null, 2)
              : String(data))}
      </pre>
    </div>
  );
}
