import { useEffect, useMemo, useState } from 'react';
import { X, Save, Eye, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import {
  FILTER_SPEC, COLUMN_SPEC, RESOURCE_LABELS, formatCustomCell,
  widgetValueFromParams, applyWidgetValue,
} from './customReportSpec';
import {
  getReportTickets, getReportInvoices, getReportCalls, getReportChats, getReportCustomers, getReportAgents,
  createCustomReport, updateCustomReport,
  getAdminCustomers, getAdminAgents,
} from '../../services/api';

// Standalone builder for the Reports → Custom Reports tab. The admin picks
// a resource (tickets / invoices / calls / chats / customers), fills in any
// filters the underlying drill endpoint supports, picks which columns to
// show, previews the result, and saves with a name. Saved reports show on
// the Custom Reports tab as cards. Date range is applied at run-time using
// the parent's page-level date filter, not saved with the report.
//
// If `existing` is supplied, the modal opens in edit mode prefilled with
// that report's resource/filters/columns. The resource itself stays locked
// in edit mode (changing it would invalidate all filters/columns anyway).

const FETCHERS = {
  tickets:   getReportTickets,
  invoices:  getReportInvoices,
  calls:     getReportCalls,
  chats:     getReportChats,
  customers: getReportCustomers,
  agents:    getReportAgents,
};

const DATA_KEY = {
  tickets:   'tickets',
  invoices:  'invoices',
  calls:     'calls',
  chats:     'chats',
  customers: 'customers',
  agents:    'agents',
};

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

export default function CustomReportBuilder({ existing, dateParams, onClose, onSaved }) {
  const isEdit = !!existing;
  const [resource, setResource] = useState(existing?.resource || 'tickets');
  const [name, setName] = useState(existing?.name || '');
  // Filters value-map keyed by filter key. Strings only (the dropdown / input
  // widgets all produce strings). Empty strings = "not filtered".
  const [filters, setFilters] = useState(() => {
    const f = existing?.filters || {};
    // filters might come from DB as a string when the JSON column round-trips
    return typeof f === 'string' ? JSON.parse(f) : f;
  });
  // Which columns are checked. Defaults to the resource's defaultOn picks.
  const [selectedCols, setSelectedCols] = useState(() => {
    const cols = existing?.columns;
    const parsed = typeof cols === 'string' ? JSON.parse(cols) : cols;
    if (parsed && Array.isArray(parsed) && parsed.length) return new Set(parsed);
    return new Set(COLUMN_SPEC[existing?.resource || 'tickets'].filter(c => c.defaultOn).map(c => c.key));
  });
  const [previewRows, setPreviewRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Customer and agent name lookups for the picker widgets. Fetched once on
  // mount and cached for the lifetime of the modal — the lists are small
  // enough that we don't bother with search/pagination.
  const [customerList, setCustomerList] = useState([]);
  const [agentList,    setAgentList]    = useState([]);
  useEffect(() => {
    getAdminCustomers({ limit: 500 })
      .then(r => setCustomerList((r.data.customers || []).map(c => ({ id: c.id, name: c.name || c.user_name || c.domain || `#${c.id}` }))))
      .catch(() => {});
    getAdminAgents()
      .then(r => setAgentList((r.data.agents || []).map(a => ({ id: a.id, name: a.name }))))
      .catch(() => {});
  }, []);

  // When resource changes (only allowed in CREATE mode), reset filters and
  // re-pick the default columns for the new resource so the form doesn't
  // leak invalid keys.
  useEffect(() => {
    if (isEdit) return;
    setFilters({});
    setSelectedCols(new Set(COLUMN_SPEC[resource].filter(c => c.defaultOn).map(c => c.key)));
    setPreviewRows(null);
  }, [resource, isEdit]);

  const filterSpec = FILTER_SPEC[resource] || [];
  const columnSpec = COLUMN_SPEC[resource] || [];

  // The columns to actually render in the preview (and to persist) — in
  // their canonical display order, filtered to the admin's selection.
  const orderedSelectedCols = useMemo(
    () => columnSpec.filter(c => selectedCols.has(c.key)),
    [columnSpec, selectedCols]
  );

  // Update one filter widget. Goes through applyWidgetValue so compound/picker
  // widgets that own multiple backend keys clear them all atomically.
  const setWidget = (filter, value) => {
    setFilters(prev => applyWidgetValue(filter, prev, value));
  };

  const toggleCol = (key) => {
    setSelectedCols(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Runs the report once for preview. Sends merged params: saved filters +
  // the parent's current page-level date range (so previews + saved reports
  // both honour the active date window).
  const runPreview = async () => {
    setLoading(true);
    setPreviewRows(null);
    try {
      const params = { ...filters, ...(dateParams || {}) };
      const res = await FETCHERS[resource](params);
      const rows = res.data[DATA_KEY[resource]] || [];
      setPreviewRows(rows);
    } catch (err) {
      toast.error('Preview failed');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = () => {
    if (!previewRows?.length) { toast.error('Run preview first'); return; }
    if (!orderedSelectedCols.length) { toast.error('Select at least one column'); return; }
    const csv = toCsv(previewRows, orderedSelectedCols);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || resource).replace(/\s+/g, '_')}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded');
  };

  const save = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    if (!orderedSelectedCols.length) { toast.error('Pick at least one column'); return; }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        resource,
        filters,
        columns: orderedSelectedCols.map(c => c.key),
      };
      const res = isEdit
        ? await updateCustomReport(existing.id, payload)
        : await createCustomReport(payload);
      toast.success(isEdit ? 'Report updated' : 'Report saved');
      onSaved?.(res.data.report);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-4 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold">{isEdit ? 'Edit' : 'New'} Custom Report</p>
            <h2 className="text-lg font-bold text-gray-800">Report builder</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Pick a resource, choose filters, select which columns to show, then save. The page-level date range is applied automatically when the report is run.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body — two-column layout */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left: name + resource + filters */}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Report name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Premium customers — Open tickets"
                className="input w-full text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">Resource</label>
              <select
                value={resource}
                onChange={e => setResource(e.target.value)}
                disabled={isEdit}
                className="input w-full text-sm disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {Object.entries(RESOURCE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              {isEdit && (
                <p className="text-[11px] text-gray-400 mt-1">Resource can't change once saved — create a new report instead.</p>
              )}
            </div>

            <div>
              <p className="block text-xs font-semibold text-gray-700 mb-2">Filters <span className="text-gray-400 font-normal">(leave blank to skip)</span></p>
              <div className="space-y-2">
                {filterSpec.map(f => {
                  const currentValue = widgetValueFromParams(f, filters);
                  return (
                    <div key={f.key} className="flex items-center gap-2">
                      <label className="text-xs text-gray-600 w-32 truncate flex-shrink-0">{f.label}</label>

                      {f.type === 'select' && (
                        <select
                          value={currentValue}
                          onChange={e => setWidget(f, e.target.value)}
                          className="input text-xs py-1 flex-1"
                        >
                          <option value="">— any —</option>
                          {f.options.map(o => (
                            <option key={o} value={o}>{o}</option>
                          ))}
                        </select>
                      )}

                      {f.type === 'compound' && (
                        <select
                          value={currentValue}
                          onChange={e => setWidget(f, e.target.value)}
                          className="input text-xs py-1 flex-1"
                        >
                          {f.options.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      )}

                      {f.type === 'customer-picker' && (
                        <select
                          value={currentValue || ''}
                          onChange={e => setWidget(f, e.target.value)}
                          className="input text-xs py-1 flex-1"
                        >
                          <option value="">— any customer —</option>
                          {customerList.map(c => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      )}

                      {f.type === 'agent-picker' && (
                        <select
                          value={currentValue || ''}
                          onChange={e => setWidget(f, e.target.value)}
                          className="input text-xs py-1 flex-1"
                        >
                          <option value="">— any agent —</option>
                          {agentList.map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                          ))}
                          <option value="__unassigned__">Unassigned</option>
                        </select>
                      )}

                      {(f.type === 'text' || f.type === 'number') && (
                        <input
                          type={f.type === 'number' ? 'number' : 'text'}
                          value={currentValue || ''}
                          onChange={e => setWidget(f, e.target.value)}
                          placeholder={f.placeholder || ''}
                          className="input text-xs py-1 flex-1"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: column picker */}
          <div>
            <p className="block text-xs font-semibold text-gray-700 mb-2">Columns to include</p>
            <div className="space-y-1.5 border border-gray-100 rounded-lg p-3 bg-gray-50/40">
              {columnSpec.map(c => (
                <label key={c.key} className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer hover:bg-white px-1.5 py-1 rounded">
                  <input
                    type="checkbox"
                    checked={selectedCols.has(c.key)}
                    onChange={() => toggleCol(c.key)}
                  />
                  <span className="flex-1">{c.label}</span>
                  <span className="text-[10px] text-gray-400 font-mono">{c.key}</span>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              {selectedCols.size} of {columnSpec.length} selected
            </p>
          </div>

          {/* Bottom: preview */}
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-700">Preview</p>
              <div className="flex items-center gap-2">
                <button onClick={runPreview} disabled={loading} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                  <Eye className="w-3.5 h-3.5" /> {loading ? 'Running…' : 'Run preview'}
                </button>
                <button onClick={downloadCsv} disabled={!previewRows?.length} className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>

            <div className="border border-gray-100 rounded-lg overflow-auto max-h-72 bg-white">
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="w-6 h-6 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : previewRows == null ? (
                <p className="px-4 py-8 text-center text-xs text-gray-400">Click "Run preview" to see how the report looks with current filters.</p>
              ) : previewRows.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-gray-400">No matching records.</p>
              ) : orderedSelectedCols.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-gray-400">Pick at least one column to show.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50/60 border-b border-gray-100 sticky top-0">
                    <tr className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                      {orderedSelectedCols.map(c => (
                        <th key={c.key} className={clsx('px-3 py-2', c.align === 'right' && 'text-right')}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {previewRows.slice(0, 50).map((r, i) => (
                      <tr key={r.id ?? i}>
                        {orderedSelectedCols.map(c => (
                          <td key={c.key} className={clsx('px-3 py-2 text-gray-700 align-top', c.align === 'right' && 'text-right')}>
                            {formatCustomCell(r[c.key], c.key)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {previewRows?.length > 50 && (
              <p className="text-[11px] text-gray-400 mt-1">Showing first 50 of {previewRows.length} rows in preview. CSV / saved report includes all rows.</p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-end gap-2 flex-shrink-0">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button
            onClick={save}
            disabled={saving || !name.trim() || selectedCols.size === 0}
            className="btn-primary text-sm flex items-center gap-1.5 disabled:opacity-50"
          >
            <Save className="w-4 h-4" /> {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Save report')}
          </button>
        </div>
      </div>
    </div>
  );
}
