import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { getAdminTickets, getAdminTicketDetail, updateAdminTicket, getAdminAgents, bulkUpdateTickets, exportReportCsv } from '../../services/api';
import { Search, RefreshCw, X, Download, CheckSquare, Square, Lock, MessageSquare } from 'lucide-react';
import { SkeletonTableRows } from '../../components/common/Skeleton';
import { timeAgo, fullDate } from '../../utils/timeAgo';
import { renderMarkdown } from '../../utils/renderMarkdown';
import InternalNotesTab from '../../components/common/InternalNotesTab';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import clsx from 'clsx';
import toast from 'react-hot-toast';

const STATUS_COLORS = {
  open: 'bg-yellow-100 text-yellow-700',
  pending: 'bg-orange-100 text-orange-700',
  closed: 'bg-gray-100 text-gray-500',
};

const PRIORITY_COLORS = {
  low: 'bg-gray-100 text-gray-600',
  normal: 'bg-blue-100 text-blue-700',
  medium: 'bg-amber-100 text-amber-700',
  high: 'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
};

export default function AdminTickets() {
  const [tickets, setTickets] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailMsgs, setDetailMsgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filters, setFilters] = useState({ status: '', priority: '', agent_id: '', search: '' });
  const [saving, setSaving] = useState(false);
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [bulkAgentId, setBulkAgentId] = useState('');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [activeTab, setActiveTab] = useState('messages');

  const loadTickets = useCallback(() => {
    setLoading(true);
    const params = {};
    if (filters.status) params.status = filters.status;
    if (filters.priority) params.priority = filters.priority;
    if (filters.agent_id) params.agent_id = filters.agent_id;
    if (filters.search) params.search = filters.search;
    getAdminTickets(params)
      .then(res => setTickets(res.data.tickets || []))
      .catch(() => toast.error('Failed to load tickets'))
      .finally(() => setLoading(false));
  }, [filters]);

  useEffect(() => { loadTickets(); }, [loadTickets]);
  useEffect(() => {
    getAdminAgents().then(res => setAgents(res.data.agents || [])).catch(() => {});
  }, []);

  useGlobalRefresh(loadTickets);

  // Deep-link support: /admin/tickets?openTicket=N auto-opens that ticket on
  // first paint. Used by the customer-detail "All Tickets" list to jump
  // straight to the conversation. The id is stripped from the URL once
  // consumed so a manual refresh doesn't re-open it endlessly.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const openId = Number(searchParams.get('openTicket'));
    if (!openId) return;
    setDetailLoading(true);
    setSelected({ id: openId });
    setDetail(null);
    setDetailMsgs([]);
    setActiveTab('messages');
    getAdminTicketDetail(openId)
      .then(res => { setDetail(res.data.ticket); setDetailMsgs(res.data.messages || []); })
      .catch(() => toast.error(`Ticket #${openId} not found`))
      .finally(() => setDetailLoading(false));
    // Clear the query param so a refresh of the page (or another navigation
    // landing back here) doesn't re-trigger the open.
    const next = new URLSearchParams(searchParams);
    next.delete('openTicket');
    setSearchParams(next, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDetail = (ticket) => {
    setSelected(ticket);
    setDetail(null);
    setDetailMsgs([]);
    setActiveTab('messages');
    setDetailLoading(true);
    getAdminTicketDetail(ticket.id)
      .then(res => { setDetail(res.data.ticket); setDetailMsgs(res.data.messages || []); })
      .catch(() => toast.error('Failed to load ticket details'))
      .finally(() => setDetailLoading(false));
  };

  const handleUpdate = (field, value) => {
    if (!selected) return;
    setSaving(true);
    updateAdminTicket(selected.id, { [field]: value })
      .then(() => {
        toast.success('Ticket updated');
        setSelected(s => ({ ...s, [field]: value }));
        setDetail(d => d ? { ...d, [field]: value } : d);
        loadTickets();
      })
      .catch(() => toast.error('Failed to update ticket'))
      .finally(() => setSaving(false));
  };

  const toggleCheck = (id) => {
    setCheckedIds(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const toggleAll = () => {
    if (checkedIds.size === tickets.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(tickets.map(t => t.id)));
    }
  };

  const handleBulkClose = async () => {
    if (!checkedIds.size) return;
    setBulkLoading(true);
    try {
      await bulkUpdateTickets({ ids: [...checkedIds], action: 'close' });
      toast.success(`${checkedIds.size} tickets closed`);
      setCheckedIds(new Set());
      loadTickets();
    } catch { toast.error('Bulk close failed'); }
    finally { setBulkLoading(false); }
  };

  const handleBulkAssign = async () => {
    if (!checkedIds.size || !bulkAgentId) return;
    setBulkLoading(true);
    try {
      await bulkUpdateTickets({ ids: [...checkedIds], action: 'assign', agent_id: Number(bulkAgentId) });
      toast.success(`${checkedIds.size} tickets assigned`);
      setCheckedIds(new Set());
      setBulkAgentId('');
      loadTickets();
    } catch { toast.error('Bulk assign failed'); }
    finally { setBulkLoading(false); }
  };

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const res = await exportReportCsv({ type: 'tickets' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `tickets_export_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('CSV downloaded');
    } catch { toast.error('Export failed'); }
    finally { setExporting(false); }
  };

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">All Tickets</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage and assign all support tickets</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportCsv} disabled={exporting} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Download className="w-4 h-4" />
            {exporting ? 'Exporting...' : 'Export CSV'}
          </button>
          <button onClick={loadTickets} className="btn-secondary hidden lg:inline-flex"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 mb-4">
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input className="input pl-9 w-full" placeholder="Search tickets..."
              value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
          </div>
          <select className="input" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All Status</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="closed">Closed</option>
          </select>
          <select className="input" value={filters.priority} onChange={e => setFilters(f => ({ ...f, priority: e.target.value }))}>
            <option value="">All Priority</option>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
          <select className="input" value={filters.agent_id} onChange={e => setFilters(f => ({ ...f, agent_id: e.target.value }))}>
            <option value="">All Agents</option>
            <option value="unassigned">Unassigned</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>

      {/* Bulk actions bar */}
      {checkedIds.size > 0 && (
        <div className="card p-3 mb-4 bg-blue-50 border-blue-200 flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-blue-700">{checkedIds.size} selected</span>
          <button onClick={handleBulkClose} disabled={bulkLoading} className="btn-secondary text-sm py-1.5">
            Close All
          </button>
          <div className="flex items-center gap-2">
            <select className="input text-sm py-1.5" value={bulkAgentId} onChange={e => setBulkAgentId(e.target.value)}>
              <option value="">Assign to agent...</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button onClick={handleBulkAssign} disabled={bulkLoading || !bulkAgentId} className="btn-primary text-sm py-1.5">
              Assign
            </button>
          </div>
          <button onClick={() => setCheckedIds(new Set())} className="ml-auto text-xs text-gray-500 hover:text-gray-700">
            Clear selection
          </button>
        </div>
      )}

      <div className={`flex gap-4 ${selected ? 'items-start' : ''}`}>
        {/* Ticket list. On mobile the two-pane doesn't fit: when a ticket is
            open we hide the list (drill-in) and show only the detail, whose
            close (X) returns to the list. Desktop keeps the side-by-side split. */}
        <div className={`card overflow-hidden ${selected ? 'hidden lg:block lg:w-1/2 lg:flex-shrink-0' : 'w-full'}`}>
          <div className="overflow-x-auto">
          <table className={`w-full text-sm ${selected ? '' : 'min-w-[680px] lg:min-w-0'}`}>
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="w-1 p-0" />
                <th className="px-4 py-3 w-10">
                  <button onClick={toggleAll} className="text-gray-400 hover:text-blue-600">
                    {checkedIds.size === tickets.length && tickets.length > 0
                      ? <CheckSquare className="w-4 h-4 text-blue-600" />
                      : <Square className="w-4 h-4" />}
                  </button>
                </th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">#</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Subject</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Assigned To</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Priority</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <SkeletonTableRows rows={8} cols={8} />
              ) : tickets.length === 0 ? (
                <tr><td colSpan="9" className="text-center py-12 text-gray-400">No tickets found</td></tr>
              ) : tickets.map(t => {
                const priorityBg = { urgent: 'bg-red-600', high: 'bg-orange-400', medium: 'bg-amber-400', normal: 'bg-blue-300', low: 'bg-gray-300' };
                return (
                  <tr key={t.id}
                    className={`hover:bg-gray-50 transition-colors ${selected?.id === t.id ? 'bg-blue-50' : t.status !== 'closed' && (Date.now() - new Date(t.created_at).getTime()) > 72 * 3600000 ? 'bg-red-50/40' : t.status !== 'closed' && (Date.now() - new Date(t.created_at).getTime()) > 24 * 3600000 ? 'bg-amber-50/40' : ''}`}
                  >
                    <td className={`p-0 w-1 ${priorityBg[t.priority] || 'bg-gray-200'}`} />
                    <td className="px-4 py-3" onClick={e => { e.stopPropagation(); toggleCheck(t.id); }}>
                      {checkedIds.has(t.id)
                        ? <CheckSquare className="w-4 h-4 text-blue-600 cursor-pointer" />
                        : <Square className="w-4 h-4 text-gray-300 cursor-pointer hover:text-gray-500" />}
                    </td>
                    <td className="px-4 py-3 text-gray-400 font-mono text-xs cursor-pointer" onClick={() => openDetail(t)}>#{t.id}</td>
                    <td className="px-4 py-3 font-medium text-gray-800 max-w-xs cursor-pointer" onClick={() => openDetail(t)}>
                      <p className="truncate">{t.subject}</p>
                      {t.sla_breached && <span className="inline-flex items-center gap-0.5 text-xs text-red-600 font-semibold">⚠ SLA Breached</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs cursor-pointer" onClick={() => openDetail(t)}>{t.customer_name}</td>
                    <td className="px-4 py-3 text-xs cursor-pointer" onClick={() => openDetail(t)}>
                      {t.agent_name || <span className="text-gray-400">Unassigned</span>}
                    </td>
                    <td className="px-4 py-3 cursor-pointer" onClick={() => openDetail(t)}>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${PRIORITY_COLORS[t.priority] || ''}`}>{t.priority}</span>
                    </td>
                    <td className="px-4 py-3 cursor-pointer" onClick={() => openDetail(t)}>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[t.status] || ''}`}>{t.status?.replace('_', ' ')}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-400 cursor-pointer" title={fullDate(t.created_at)} onClick={() => openDetail(t)}>
                      {timeAgo(t.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

        {/* Detail panel */}
        {selected && (
          <div className="flex-1 card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-gray-800 text-sm">Ticket #{selected.id}</h3>
              <button onClick={() => { setSelected(null); setDetail(null); setDetailMsgs([]); }} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {detailLoading ? (
              <div className="flex h-48 items-center justify-center">
                <div className="w-6 h-6 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : detail ? (
              <div className="p-5 space-y-4">
                <div>
                  <p className="text-xs text-gray-400 mb-0.5">Subject</p>
                  <p className="font-semibold text-gray-800">{detail.subject}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-0.5">Customer</p>
                  <p className="text-sm text-gray-700">{detail.customer_name} · {detail.customer_email || detail.customer_domain}</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Status</p>
                    <select className="input w-full text-sm" value={detail.status || ''} disabled={saving}
                      onChange={e => handleUpdate('status', e.target.value)}>
                      <option value="open">Open</option>
                      <option value="pending">Pending</option>
                      <option value="closed">Closed</option>
                    </select>
                  </div>
                  <div>
                    <p className="text-xs text-gray-400 mb-1">Priority</p>
                    <select className="input w-full text-sm" value={detail.priority || ''} disabled={saving}
                      onChange={e => handleUpdate('priority', e.target.value)}>
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </div>
                </div>

                <div>
                  <p className="text-xs text-gray-400 mb-1">Assign To Agent</p>
                  <select className="input w-full text-sm" value={detail.assigned_agent_id || ''} disabled={saving}
                    onChange={e => handleUpdate('assigned_agent_id', e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Unassigned</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <p className="text-xs text-gray-400 mb-2">Original Message</p>
                  <p className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 whitespace-pre-wrap break-words">{renderMarkdown(detail.description)}</p>
                </div>

                <div className="border-t border-gray-100 pt-3">
                  <div className="flex border-b border-gray-100 mb-3">
                    <button
                      type="button"
                      onClick={() => setActiveTab('messages')}
                      className={clsx('px-3 py-2 text-xs font-semibold border-b-2 flex items-center gap-1.5 -mb-px',
                        activeTab === 'messages' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700')}
                    >
                      <MessageSquare className="w-3 h-3" /> Messages ({detailMsgs.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('notes')}
                      className={clsx('px-3 py-2 text-xs font-semibold border-b-2 flex items-center gap-1.5 -mb-px',
                        activeTab === 'notes' ? 'border-amber-500 text-amber-700' : 'border-transparent text-gray-500 hover:text-gray-700')}
                    >
                      <Lock className="w-3 h-3" /> Internal Notes
                    </button>
                  </div>

                  {activeTab === 'notes' ? (
                    <div className="h-80 border border-gray-100 rounded-lg overflow-hidden">
                      <InternalNotesTab ticketId={selected.id} />
                    </div>
                  ) : detailMsgs.length > 0 ? (
                    <div className="space-y-3 max-h-80 overflow-y-auto">
                      {detailMsgs.map(msg => (
                        <div key={msg.id} className={`flex ${msg.sender_role !== 'customer' ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${
                            msg.sender_role !== 'customer' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-800'
                          }`}>
                            <p className="text-xs opacity-70 mb-0.5 font-medium">{msg.sender_name}</p>
                            <p className="whitespace-pre-wrap break-words">{msg.message}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400 text-center py-6">No replies yet</p>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Layout>
  );
}
