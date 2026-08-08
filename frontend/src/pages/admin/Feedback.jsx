import { useEffect, useState, useCallback } from 'react';
import { Bug, ExternalLink, FileImage, FileVideo, Loader2, RefreshCw, Pencil, Check,
         Search, Calendar, ChevronLeft, ChevronRight, X, CheckSquare, Square } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import Layout from '../../components/common/Layout';
import RowsPerPageSelect, { readStoredPageSize } from '../../components/common/RowsPerPageSelect';
import {
  adminListFeedback, adminUpdateFeedback,
  adminListFeedbackReporters, adminBulkUpdateFeedback,
} from '../../services/api';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

const PAGE_SIZE_KEY = 'dsp_admin_feedback_page_size';

function presetRange(preset) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  switch (preset) {
    case '24h': { const d = new Date(); d.setDate(d.getDate() - 1); return { from: fmt(d), to: fmt(today) }; }
    case '7d':  { const d = new Date(); d.setDate(d.getDate() - 7); return { from: fmt(d), to: fmt(today) }; }
    case '30d': { const d = new Date(); d.setDate(d.getDate() - 30); return { from: fmt(d), to: fmt(today) }; }
    case 'year':return { from: `${today.getFullYear()}-01-01`, to: fmt(today) };
    default:    return { from: '', to: '' };
  }
}

const STATUS_OPTIONS = [
  { value: 'new',      label: 'New',      color: 'bg-blue-100 text-blue-700 border-blue-200' },
  { value: 'reviewed', label: 'Reviewed', color: 'bg-amber-100 text-amber-700 border-amber-200' },
  { value: 'approved', label: 'Approved', color: 'bg-green-100 text-green-700 border-green-200' },
  { value: 'rejected', label: 'Rejected', color: 'bg-red-100 text-red-700 border-red-200' },
  { value: 'fixed',    label: 'Fixed',    color: 'bg-gray-100 text-gray-700 border-gray-200' },
];
const statusMeta = (s) => STATUS_OPTIONS.find(o => o.value === s) || STATUS_OPTIONS[0];

export default function AdminFeedback() {
  const [reports, setReports] = useState([]);
  const [statusCounts, setStatusCounts] = useState({ new: 0, reviewed: 0, approved: 0, rejected: 0, fixed: 0, total: 0 });
  const [filteredTotal, setFilteredTotal] = useState(0);
  const [reporters, setReporters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const [filters, setFilters] = useState({
    status: '',
    panel: '',
    reporter_id: '',
    search: '',
    from: '',
    to: '',
    page: 1,
  });
  const [activePreset, setActivePreset] = useState('all');
  const [pageSize, setPageSize] = useState(() => readStoredPageSize(PAGE_SIZE_KEY));
  const [searchInput, setSearchInput] = useState('');

  // Debounce search 400ms
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters(f => f.search === searchInput.trim() ? f : { ...f, search: searchInput.trim(), page: 1 });
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    setLoading(true);
    const params = { limit: pageSize, offset: (filters.page - 1) * pageSize };
    if (filters.status)      params.status = filters.status;
    if (filters.panel)       params.panel = filters.panel;
    if (filters.reporter_id) params.reporter_id = filters.reporter_id;
    if (filters.search)      params.search = filters.search;
    if (filters.from)        params.from = filters.from;
    if (filters.to)          params.to = filters.to;
    adminListFeedback(params)
      .then(r => {
        setReports(r.data.reports || []);
        if (r.data.counts) setStatusCounts(r.data.counts);
        setFilteredTotal(r.data.total || 0);
      })
      .catch(() => toast.error('Failed to load feedback'))
      .finally(() => setLoading(false));
  }, [filters, pageSize]);

  useEffect(() => { load(); }, [load]);

  useGlobalRefresh(load);

  useEffect(() => {
    adminListFeedbackReporters()
      .then(r => setReporters(r.data.reporters || []))
      .catch(() => {});
  }, []);

  // Drop selections that aren't on the current page anymore (filter / page change)
  useEffect(() => {
    const visible = new Set(reports.map(r => r.id));
    setSelectedIds(prev => new Set([...prev].filter(id => visible.has(id))));
  }, [reports]);

  const totalPages = Math.max(1, Math.ceil(filteredTotal / pageSize));

  const applyPreset = (preset) => {
    const { from, to } = presetRange(preset);
    setActivePreset(preset);
    setFilters(f => ({ ...f, from, to, page: 1 }));
  };

  const toggleOne = (id) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allOnPageSelected = reports.length > 0 && reports.every(r => selectedIds.has(r.id));
  const toggleAllOnPage = () => {
    if (allOnPageSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(reports.map(r => r.id)));
  };

  const handleBulkStatus = async (status) => {
    if (!selectedIds.size) return;
    if (!confirm(`Mark ${selectedIds.size} report${selectedIds.size === 1 ? '' : 's'} as ${status}?`)) return;
    setBulkBusy(true);
    try {
      const r = await adminBulkUpdateFeedback([...selectedIds], status);
      toast.success(`Updated ${r.data.updated} report${r.data.updated === 1 ? '' : 's'}`);
      setSelectedIds(new Set());
      load();
    } catch {
      toast.error('Bulk update failed');
    } finally { setBulkBusy(false); }
  };

  const updateReport = async (id, patch) => {
    setSavingId(id);
    try {
      await adminUpdateFeedback(id, patch);
      toast.success('Updated');
      load();
    } catch {
      toast.error('Update failed');
    } finally {
      setSavingId(null);
    }
  };

  // Pull counts from the backend-provided map so they reflect the full table,
  // not just the currently-filtered subset.
  const counts = STATUS_OPTIONS.map(o => ({
    ...o,
    count: statusCounts[o.value] || 0,
  }));

  return (
    <Layout>
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <Bug className="w-6 h-6 text-amber-500" /> Bug Reports & Feedback
            </h1>
            <p className="text-sm text-gray-500 mt-1">Reports submitted by customers and agents via the in-app Report Bug widget.</p>
          </div>
          <button onClick={load} className="text-sm text-gray-600 hover:text-gray-800 hidden lg:flex items-center gap-1.5">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {/* Status filter chips */}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setFilters(f => ({ ...f, status: '', page: 1 }))}
            className={`text-xs px-3 py-1.5 rounded-full border ${!filters.status ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'}`}
          >
            All <span className="opacity-75">· {statusCounts.total}</span>
          </button>
          {counts.map(c => (
            <button
              key={c.value}
              onClick={() => setFilters(f => ({ ...f, status: c.value === f.status ? '' : c.value, page: 1 }))}
              className={`text-xs px-3 py-1.5 rounded-full border ${filters.status === c.value ? 'bg-blue-600 text-white border-blue-600' : `${c.color} hover:opacity-90`}`}
            >
              {c.label} <span className="opacity-75">· {c.count}</span>
            </button>
          ))}
        </div>

        {/* Filters row */}
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                className="input pl-8 w-full"
                placeholder="Search title, description, reporter…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
              />
            </div>
            <select
              className="input"
              value={filters.panel}
              onChange={e => setFilters(f => ({ ...f, panel: e.target.value, page: 1 }))}
            >
              <option value="">All Panels</option>
              <option value="customer">Customer Panel</option>
              <option value="agent">Agent Panel</option>
              <option value="admin">Admin Panel</option>
            </select>
            <select
              className="input"
              value={filters.reporter_id}
              onChange={e => setFilters(f => ({ ...f, reporter_id: e.target.value, page: 1 }))}
            >
              <option value="">All Reporters ({reporters.length})</option>
              {reporters.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.role}) · {r.report_count}
                </option>
              ))}
            </select>
          </div>

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
                    ? 'border-blue-300 bg-blue-50 text-blue-700'
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
            {(filters.from || filters.to || filters.search || filters.panel || filters.reporter_id) && (
              <button
                onClick={() => {
                  setFilters({ status: filters.status, panel: '', reporter_id: '', search: '', from: '', to: '', page: 1 });
                  setSearchInput('');
                  setActivePreset('all');
                }}
                className="ml-auto text-xs text-gray-500 hover:text-gray-800 inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" /> Clear filters
              </button>
            )}
          </div>
        </div>

        {/* Bulk action bar — appears when at least one row is selected */}
        {selectedIds.size > 0 && (
          <div className="card p-3 bg-blue-50 border-blue-200 flex items-center justify-between flex-wrap gap-2">
            <span className="text-sm text-blue-800 font-medium">
              {selectedIds.size} report{selectedIds.size === 1 ? '' : 's'} selected
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-600">Mark all as:</span>
              {['reviewed', 'approved', 'rejected', 'fixed'].map(s => (
                <button
                  key={s}
                  onClick={() => handleBulkStatus(s)}
                  disabled={bulkBusy}
                  className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 bg-white hover:border-blue-300 capitalize disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-gray-500 hover:text-gray-800 ml-2 inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" /> Clear selection
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-48 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        ) : reports.length === 0 ? (
          <div className="card p-12 flex flex-col items-center text-gray-400">
            <Bug className="w-10 h-10 mb-3 opacity-20" />
            <p className="text-sm font-medium">No reports yet</p>
            <p className="text-xs mt-1">Customers and agents will see a floating "Report Bug" button in the bottom-right of their panel.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Select-all + total count strip */}
            <div className="flex items-center justify-between text-xs text-gray-500 px-1">
              <label className="inline-flex items-center gap-2 cursor-pointer hover:text-gray-800">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 cursor-pointer"
                  checked={allOnPageSelected}
                  ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && !allOnPageSelected; }}
                  onChange={toggleAllOnPage}
                />
                <span>{allOnPageSelected ? 'Deselect all on this page' : 'Select all on this page'}</span>
              </label>
              <span>Showing {(filters.page - 1) * pageSize + 1}–{Math.min(filters.page * pageSize, filteredTotal)} of {filteredTotal}</span>
            </div>

            {reports.map(r => {
              const meta = statusMeta(r.status);
              const expanded = expandedId === r.id;
              // attachments is JSON in DB; mysql2 returns it as a JS array (when JSON
              // column type) or as a string we have to parse. Handle both.
              const atts = !r.attachments ? [] : Array.isArray(r.attachments) ? r.attachments : (() => { try { return JSON.parse(r.attachments); } catch { return []; } })();
              const isChecked = selectedIds.has(r.id);
              return (
                <div key={r.id} className={clsx('card p-4', isChecked && 'ring-2 ring-blue-300 ring-offset-1')}>
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 rounded border-gray-300 cursor-pointer flex-shrink-0"
                      checked={isChecked}
                      onChange={() => toggleOne(r.id)}
                      onClick={e => e.stopPropagation()}
                      title="Select for bulk action"
                    />
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setExpandedId(expanded ? null : r.id)}>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-xs font-mono text-gray-400">#{r.id}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${meta.color}`}>{meta.label}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium capitalize">{r.panel} panel</span>
                        {atts.length > 0 && <span className="text-xs text-gray-500">📎 {atts.length}</span>}
                      </div>
                      <p className="font-semibold text-gray-800 truncate">{r.title}</p>
                      <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
                        <span>{r.reporter_name} ({r.reporter_email})</span>
                        <span>·</span>
                        <span>{new Date(r.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-4 pt-4 border-t border-gray-100 space-y-4">
                      <EditableTitleDesc
                        report={r}
                        saving={savingId === r.id}
                        onSave={(patch) => updateReport(r.id, patch)}
                      />

                      {r.page_url && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Page</p>
                          <a href={r.page_url} target="_blank" rel="noreferrer" className="text-sm text-blue-600 hover:underline flex items-center gap-1 break-all">
                            <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" /> {r.page_url}
                          </a>
                        </div>
                      )}
                      {r.browser_info && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Browser</p>
                          <p className="text-xs text-gray-500 font-mono break-all">{r.browser_info}</p>
                        </div>
                      )}

                      {atts.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Attachments</p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {atts.map((a, i) => {
                              const isImage = a.mime?.startsWith('image/');
                              const isVideo = a.mime?.startsWith('video/');
                              return (
                                <a key={i} href={a.path} target="_blank" rel="noreferrer" className="block border border-gray-200 rounded-lg overflow-hidden hover:border-blue-300 transition-colors">
                                  {isImage ? (
                                    <img src={a.path} alt={a.name} className="w-full h-32 object-cover" />
                                  ) : isVideo ? (
                                    <video src={a.path} className="w-full h-32 object-cover" controls />
                                  ) : (
                                    <div className="h-32 flex items-center justify-center bg-gray-50 text-gray-400">
                                      <FileImage className="w-8 h-8" />
                                    </div>
                                  )}
                                  <div className="p-2 text-xs text-gray-600 flex items-center gap-1.5">
                                    {isVideo ? <FileVideo className="w-3.5 h-3.5" /> : <FileImage className="w-3.5 h-3.5" />}
                                    <span className="truncate flex-1">{a.name}</span>
                                  </div>
                                </a>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <FeedbackActions
                        report={r}
                        saving={savingId === r.id}
                        onSave={(patch) => updateReport(r.id, patch)}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {/* Pagination footer */}
            <div className="card px-4 py-3 flex items-center justify-between text-sm text-gray-600 flex-wrap gap-2">
              <span className="text-xs">{filteredTotal} matching report{filteredTotal === 1 ? '' : 's'}</span>
              <div className="flex items-center gap-4">
                <RowsPerPageSelect
                  value={pageSize}
                  onChange={(n) => { setPageSize(n); setFilters(f => ({ ...f, page: 1 })); }}
                  storageKey={PAGE_SIZE_KEY}
                />
                {totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setFilters(f => ({ ...f, page: Math.max(1, f.page - 1) }))}
                      disabled={filters.page <= 1}
                      className="p-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs">Page {filters.page} of {totalPages}</span>
                    <button
                      onClick={() => setFilters(f => ({ ...f, page: Math.min(totalPages, f.page + 1) }))}
                      disabled={filters.page >= totalPages}
                      className="p-1.5 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

// Editable title + description. Reporter text is the starting value; admin can
// rewrite it before approving so the auto-fix bot (or a developer) has a clear,
// actionable spec. Backend snapshots the original into admin_notes the first
// time the admin edits, so nothing is lost.
function EditableTitleDesc({ report, saving, onSave }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(report.title);
  const [description, setDescription] = useState(report.description);

  const dirty = title !== report.title || description !== report.description;

  const save = () => {
    if (!title.trim() || !description.trim()) {
      toast.error('Title and description can\'t be blank.');
      return;
    }
    onSave({ title: title.trim(), description: description.trim() });
    setEditing(false);
  };

  const cancel = () => {
    setTitle(report.title);
    setDescription(report.description);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-gray-800">{report.title}</p>
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 flex-shrink-0"
          >
            <Pencil className="w-3.5 h-3.5" /> Edit
          </button>
        </div>
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Description</p>
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{report.description}</p>
          <p className="text-[11px] text-gray-400 mt-2 italic">Tip: edit the description to add reproduction steps, expected vs. actual behaviour, or file paths — the auto-fix workflow uses this text verbatim.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 bg-amber-50 border border-amber-200 rounded-lg p-3">
      <div>
        <label className="text-xs font-semibold text-amber-800 uppercase tracking-wide block mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={255}
          className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500 bg-white"
        />
      </div>
      <div>
        <label className="text-xs font-semibold text-amber-800 uppercase tracking-wide block mb-1">Description (rewrite for clarity)</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={6}
          maxLength={5000}
          className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500 resize-y bg-white"
        />
        <p className="text-[11px] text-gray-500 mt-1">{description.length}/5000 · Original reporter text will be preserved in admin notes.</p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" /> Save edits
        </button>
        <button
          onClick={cancel}
          disabled={saving}
          className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:text-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FeedbackActions({ report, saving, onSave }) {
  const [notes, setNotes] = useState(report.admin_notes || '');
  return (
    <div className="bg-gray-50 -mx-4 -mb-4 px-4 py-3 rounded-b-2xl">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Admin review</p>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        rows={2}
        placeholder="Add a note for yourself (e.g. repro steps confirmed, severity, who to assign)…"
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none mb-2"
      />
      <div className="flex flex-wrap gap-2">
        {STATUS_OPTIONS.map(s => (
          <button
            key={s.value}
            disabled={saving || report.status === s.value}
            onClick={() => onSave({ status: s.value, admin_notes: notes })}
            className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${report.status === s.value ? 'opacity-50 cursor-default' : s.color} hover:opacity-90 disabled:cursor-not-allowed`}
          >
            {report.status === s.value ? `✓ ${s.label}` : `Mark as ${s.label}`}
          </button>
        ))}
        {report.admin_notes !== notes && (
          <button
            disabled={saving}
            onClick={() => onSave({ admin_notes: notes })}
            className="text-xs px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 font-medium hover:opacity-90"
          >
            {saving ? 'Saving…' : 'Save note'}
          </button>
        )}
      </div>
      {report.reviewer_name && (
        <p className="text-[11px] text-gray-400 mt-2">Last reviewed by {report.reviewer_name} on {new Date(report.reviewed_at).toLocaleString('en-IN')}</p>
      )}
    </div>
  );
}
