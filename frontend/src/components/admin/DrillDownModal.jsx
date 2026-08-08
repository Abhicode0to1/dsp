import { useEffect, useState, useCallback } from 'react';
import { X, Download, ArrowLeft, Users, UserCog, List } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';

// Two-step drill modal for the Reports page. State machine: the modal can be
// in one of three views — Records (flat list), By Customer (count per
// customer), or By Agent (count per agent). The user can flip between views
// via the toggle in the header, OR click a grouped row to "zoom in" — that
// keeps the same modal open, adds the customer_id / agent_id filter to the
// params, and switches to Records. A back-arrow returns to the grouped view.
//
// Backend contract:
//   /admin/reports/drill/<resource>?group_by=customer  → { groups: [{customer_id, customer_name, count}] }
//   /admin/reports/drill/<resource>?group_by=agent     → { groups: [{agent_id, agent_name, count}] }
//   /admin/reports/drill/<resource>                    → { <dataKey>: [...records] }
//
// Props:
//   fetcher(params) → axios promise
//   dataKey         : 'tickets' | 'invoices' | 'calls' | 'chats'
//   columns         : column defs for Records view
//   groupable       : whether to show the By Customer / By Agent tabs at all
//   defaultView     : 'records' | 'customer' | 'agent' — initial view

function formatCell(row, col) {
  const v = row[col.key];
  if (col.format) return col.format(v, row);
  if (v == null) return '—';
  if (col.key === 'created_at' || col.key === 'closed_at' || col.key === 'accepted_at'
      || col.key === 'due_date' || col.key === 'call_start_time' || col.key === 'call_end_time') {
    try { return new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return String(v); }
  }
  return String(v);
}

function toCsv(rows, columns) {
  const headers = columns.map(c => c.label);
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(columns.map(c => escape(row[c.key] ?? '')).join(','));
  return lines.join('\n');
}

const GROUP_COLS = {
  customer: [
    { key: 'customer_name', label: 'Customer', format: (v) => v || '(no customer)' },
    { key: 'domain',        label: 'Domain',   format: (v) => v || '—' },
    { key: 'count',         label: 'Count',    align: 'right', format: (v) => String(v) },
  ],
  agent: [
    { key: 'agent_name', label: 'Agent',  format: (v) => v || 'Unassigned' },
    { key: 'count',      label: 'Count',  align: 'right', format: (v) => String(v) },
  ],
};

export default function DrillDownModal({
  title,
  subtitle,
  fetcher,
  dataKey,
  params,
  columns,
  exportName,
  groupable = false,
  defaultView = 'records',
  onClose,
}) {
  // `view` is one of 'records' | 'customer' | 'agent'.
  const [view, setView] = useState(defaultView);
  // Additional filter applied when the user zoomed into a grouped row — e.g.
  // { customer_id: 5 } or { agent_id: 2 }. Cleared by the back arrow.
  const [zoom, setZoom] = useState(null); // { kind: 'customer'|'agent', id, label }

  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetch = useCallback(() => {
    setLoading(true);
    setError(null);
    const extraParams = { ...params };
    if (zoom?.kind === 'customer') extraParams.customer_id = zoom.id;
    if (zoom?.kind === 'agent')    extraParams.agent_id    = zoom.id;
    if (view === 'customer') extraParams.group_by = 'customer';
    if (view === 'agent')    extraParams.group_by = 'agent';
    fetcher(extraParams)
      .then(r => {
        if (view === 'records') setRows(r.data[dataKey] || []);
        else                    setRows(r.data.groups || []);
      })
      .catch(err => {
        console.error(err);
        setError('Failed to load details.');
      })
      .finally(() => setLoading(false));
  }, [fetcher, dataKey, view, params, zoom]);

  // Re-fetch whenever view/zoom changes.
  useEffect(() => { fetch(); /* eslint-disable-next-line */ }, [view, zoom?.kind, zoom?.id]);

  const isGrouped  = view !== 'records';
  const activeCols = isGrouped ? GROUP_COLS[view] : columns;
  const total      = rows?.length || 0;
  const capped     = total === 500 || total === 100;

  // Click a row in grouped view → zoom into that record and flip to Records.
  const zoomInto = (row) => {
    if (view === 'customer') setZoom({ kind: 'customer', id: row.customer_id, label: row.customer_name || '(no customer)' });
    else if (view === 'agent') setZoom({ kind: 'agent', id: row.agent_id, label: row.agent_name || 'Unassigned' });
    setView('records');
  };

  // Back from records-with-zoom → grouped view we came from.
  const backFromZoom = () => {
    if (!zoom) return;
    setView(zoom.kind);
    setZoom(null);
  };

  const downloadCsv = () => {
    if (!rows?.length) { toast.error('Nothing to export'); return; }
    const csv = toCsv(rows, activeCols);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportName || 'export'}_${view}${zoom ? '_' + zoom.kind + zoom.id : ''}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded');
  };

  const viewTabs = [
    { id: 'customer', label: 'By Customer', icon: Users },
    { id: 'agent',    label: 'By Agent',    icon: UserCog },
    { id: 'records',  label: 'Records',     icon: List },
  ];

  // Breadcrumb — shows when zoomed.
  const crumb = zoom ? ` · ${zoom.label}` : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold">Drill-down</p>
            <div className="flex items-center gap-2 mt-0.5">
              {zoom && (
                <button
                  onClick={backFromZoom}
                  className="p-1 -ml-1 rounded hover:bg-gray-100 text-gray-500"
                  title="Back to grouped view"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <h2 className="text-lg font-bold text-gray-800 truncate">{title}{crumb}</h2>
            </div>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
            {!loading && (
              <p className="text-xs text-gray-500 mt-1">
                {total} {isGrouped ? (view === 'customer' ? 'customer' : 'agent') : 'record'}{total === 1 ? '' : 's'}
                {capped && view === 'records' && <span className="ml-1 text-amber-600">· capped at 500 — narrow filters to see more</span>}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={downloadCsv}
              disabled={loading || !rows?.length}
              className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" /> Export CSV
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* View tabs (hidden when not groupable or when zoomed into records) */}
        {groupable && !zoom && (
          <div className="px-6 pt-3 border-b border-gray-100 flex gap-1 flex-shrink-0">
            {viewTabs.map(t => (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors',
                  view === t.id
                    ? 'text-blue-700 border-blue-600'
                    : 'text-gray-500 border-transparent hover:text-gray-700'
                )}
              >
                <t.icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-7 h-7 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : error ? (
            <p className="px-6 py-8 text-sm text-red-600">{error}</p>
          ) : total === 0 ? (
            <p className="px-6 py-12 text-center text-sm text-gray-400">No matching records.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50/60 border-b border-gray-100 sticky top-0">
                <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {activeCols.map(c => (
                    <th key={c.key} className={`px-4 py-2.5 ${c.width || ''} ${c.align === 'right' ? 'text-right' : ''}`}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r, i) => (
                  <tr
                    key={r.id ?? `${r.customer_id ?? r.agent_id ?? i}`}
                    className={isGrouped ? 'hover:bg-blue-50/40 cursor-pointer' : 'hover:bg-gray-50/60'}
                    onClick={isGrouped ? () => zoomInto(r) : undefined}
                  >
                    {activeCols.map(c => (
                      <td key={c.key} className={`px-4 py-2.5 text-xs text-gray-700 align-top ${c.align === 'right' ? 'text-right font-semibold' : ''}`}>
                        {formatCell(r, c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
