import { useEffect, useState, useCallback } from 'react';
import Layout from '../../components/common/Layout';
import RowsPerPageSelect, { readStoredPageSize } from '../../components/common/RowsPerPageSelect';
import {
  getAdminChats, assignAdminChat, getAdminAgents,
  getAdminChatAnalytics, getAdminChatArchive, getArchivedMessages,
  getAgentChatStatuses, getBlacklist, blockCustomer, unblockCustomer,
} from '../../services/api';
import { useSocket } from '../../contexts/SocketContext';
import { timeAgo } from '../../utils/timeAgo';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import { renderMarkdown } from '../../utils/renderMarkdown';
import {
  MessageSquare, RefreshCw, UserCheck, Zap, ZapOff, Clock, CheckCircle,
  AlertTriangle, X, Search, BarChart2, Archive, Shield, Eye,
  TrendingUp, Star, Users, Activity,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';

const TABS = ['live', 'monitor', 'analytics', 'archive', 'blacklist'];

// ── Agent availability table ──────────────────────────────────────────────────
function AgentAvailability({ socket }) {
  const [agents, setAgents]   = useState([]);
  const [statuses, setStatuses] = useState({});

  useEffect(() => {
    getAgentChatStatuses()
      .then(r => setAgents(r.data.agents || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!socket) return;
    socket.emit('get_agent_statuses');
    const onStatuses = (data) => setStatuses(data);
    const onChange   = ({ agentId, status }) => setStatuses(s => ({ ...s, [agentId]: status }));
    socket.on('agent_statuses',       onStatuses);
    socket.on('agent_status_changed', onChange);
    return () => {
      socket.off('agent_statuses',       onStatuses);
      socket.off('agent_status_changed', onChange);
    };
  }, [socket]);

  const statusColor = { online: 'bg-green-500', busy: 'bg-amber-500', away: 'bg-gray-400', offline: 'bg-gray-300' };

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
        <Users className="w-4 h-4 text-blue-500" />
        <h3 className="text-sm font-semibold text-gray-700">Agent Availability</h3>
      </div>
      <div className="divide-y divide-gray-50">
        {agents.length === 0 && <div className="text-center py-8 text-sm text-gray-400">No agents</div>}
        {agents.map(a => {
          const s = statuses[a.id] || 'offline';
          return (
            <div key={a.id} className="flex items-center gap-3 px-5 py-3">
              <div className="relative">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-xs font-bold text-blue-700">
                  {a.name?.[0]?.toUpperCase()}
                </div>
                <span className={clsx('absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-white', statusColor[s] || statusColor.offline)} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{a.name}</p>
                <p className="text-xs text-gray-400 capitalize">{s}</p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-sm font-bold text-gray-700">{a.active_chats || 0}</p>
                <p className="text-xs text-gray-400">active chats</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Analytics panel ────────────────────────────────────────────────────────────
function AnalyticsPanel() {
  const [days, setDays]   = useState(7);
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getAdminChatAnalytics({ days })
      .then(r => setData(r.data))
      .catch(() => toast.error('Failed to load analytics'))
      .finally(() => setLoading(false));
  }, [days]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" /></div>;
  if (!data) return null;

  const { totals, byAgent, byHour, ratings } = data;
  const fmtSecs = (s) => {
    if (!s) return '—';
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${Math.floor(s % 60)}s` : `${Math.floor(s)}s`;
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 mb-2">
        {[7, 14, 30].map(d => (
          <button key={d} onClick={() => setDays(d)}
            className={clsx('text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors',
              days === d ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-500 hover:border-gray-300')}>
            {d}d
          </button>
        ))}
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total Chats',       value: totals.total,        icon: <MessageSquare className="w-5 h-5 text-blue-500" />, bg: 'bg-blue-50' },
          { label: 'Resolved',          value: totals.closed,       icon: <CheckCircle className="w-5 h-5 text-green-500" />, bg: 'bg-green-50' },
          { label: 'Avg First Response',value: fmtSecs(totals.avg_first_response_secs), icon: <Clock className="w-5 h-5 text-amber-500" />, bg: 'bg-amber-50' },
          { label: 'Avg CSAT',          value: ratings.avg_rating ? `${parseFloat(ratings.avg_rating).toFixed(1)} ★` : '—', icon: <Star className="w-5 h-5 text-amber-400" />, bg: 'bg-yellow-50' },
        ].map(s => (
          <div key={s.label} className="card p-4 flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${s.bg}`}>{s.icon}</div>
            <div>
              <p className="text-xl font-bold text-gray-800">{s.value ?? '—'}</p>
              <p className="text-xs text-gray-500">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* By agent */}
      {byAgent.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold text-gray-700">Agent Performance</h3>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px] lg:min-w-0">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-5 py-2.5">Agent</th>
                <th className="text-right px-4 py-2.5">Handled</th>
                <th className="text-right px-4 py-2.5">Avg Duration</th>
                <th className="text-right px-5 py-2.5">CSAT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {byAgent.map(a => (
                <tr key={a.agent_id} className="hover:bg-gray-50">
                  <td className="px-5 py-3 font-medium text-gray-800">{a.agent_name}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{a.handled}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{fmtSecs(a.avg_duration_secs)}</td>
                  <td className="px-5 py-3 text-right">{a.avg_rating ? `${parseFloat(a.avg_rating).toFixed(1)} ★` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      {/* Hourly heatmap */}
      {byHour.length > 0 && (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold text-gray-700">Peak Hours</h3>
          </div>
          <div className="flex items-end gap-1 h-24">
            {Array.from({ length: 24 }, (_, h) => {
              const rec = byHour.find(x => x.hour === h);
              const cnt = rec?.count || 0;
              const max = Math.max(...byHour.map(x => x.count), 1);
              const pct = cnt / max;
              return (
                <div key={h} className="flex-1 flex flex-col items-center gap-1" title={`${h}:00 — ${cnt} chats`}>
                  <div className="w-full rounded-sm bg-blue-500 opacity-80 transition-all" style={{ height: `${Math.max(4, pct * 80)}px` }} />
                  {h % 6 === 0 && <span className="text-[9px] text-gray-400">{h}h</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chat archive ───────────────────────────────────────────────────────────────
function ArchivePanel({ agents }) {
  const [chats, setChats]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [pageSize, setPageSize] = useState(() => readStoredPageSize('dsp_admin_chats_archive_page_size'));
  const [q, setQ]             = useState('');
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(false);
  const [viewChat, setViewChat] = useState(null);
  const [viewMsgs, setViewMsgs] = useState([]);

  const load = useCallback(() => {
    setLoading(true);
    getAdminChatArchive({ q: q || undefined, agent_id: agentId || undefined, page, limit: pageSize })
      .then(r => { setChats(r.data.chats); setTotal(r.data.total); })
      .catch(() => toast.error('Failed to load archive'))
      .finally(() => setLoading(false));
  }, [q, agentId, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  const openChat = async (chat) => {
    setViewChat(chat);
    const r = await getArchivedMessages(chat.id).catch(() => ({ data: { messages: [] } }));
    setViewMsgs(r.data.messages);
  };

  const fmtSecs = (s) => { if (!s) return '—'; const m = Math.floor(s / 60); return m > 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`; };

  return (
    <div className="space-y-4">
      {viewChat && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col overflow-hidden" style={{ maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-bold text-gray-800">Chat #{viewChat.id}</h3>
                <p className="text-xs text-gray-400">{viewChat.customer_name} · {viewChat.agent_name || 'Unassigned'}</p>
              </div>
              <button onClick={() => setViewChat(null)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/40">
              {viewMsgs.map(m => {
                const isAgent = m.sender_role === 'agent' || m.sender_role === 'admin';
                return (
                  <div key={m.id} className={clsx('flex gap-2', isAgent ? 'flex-row-reverse' : 'flex-row')}>
                    <div className={clsx('max-w-xs flex flex-col', isAgent ? 'items-end' : 'items-start')}>
                      <div className={clsx('px-3 py-2 rounded-xl text-sm whitespace-pre-wrap break-words', isAgent ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-white border border-gray-200 rounded-tl-none')}>
                        {renderMarkdown(m.message)}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{m.sender_name}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input className="input pl-8 py-1.5 text-sm w-full" placeholder="Search by customer or message…" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} />
        </div>
        <select className="input text-sm py-1.5 w-40" value={agentId} onChange={e => { setAgentId(e.target.value); setPage(1); }}>
          <option value="">All Agents</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button onClick={load} className="btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[720px] lg:min-w-0">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="text-left px-4 py-2.5">ID</th>
              <th className="text-left px-4 py-2.5">Customer</th>
              <th className="text-left px-4 py-2.5">Agent</th>
              <th className="text-right px-4 py-2.5">Messages</th>
              <th className="text-right px-4 py-2.5">Duration</th>
              <th className="text-right px-4 py-2.5">CSAT</th>
              <th className="text-right px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading && (
              <tr><td colSpan={8} className="text-center py-8 text-gray-400">Loading…</td></tr>
            )}
            {!loading && chats.length === 0 && (
              <tr><td colSpan={8} className="text-center py-10 text-gray-400">No archived chats found</td></tr>
            )}
            {chats.map(c => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-gray-400 text-xs">#{c.id}</td>
                <td className="px-4 py-3 font-medium text-gray-800">{c.customer_name}</td>
                <td className="px-4 py-3 text-gray-600">{c.agent_name || '—'}</td>
                <td className="px-4 py-3 text-right text-gray-600">{c.message_count}</td>
                <td className="px-4 py-3 text-right text-gray-600">{fmtSecs(c.duration_secs)}</td>
                <td className="px-4 py-3 text-right">{c.rating ? `${c.rating} ★` : '—'}</td>
                <td className="px-4 py-3 text-right text-gray-400 text-xs">{timeAgo(c.closed_at)}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => openChat(c)} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                    <Eye className="w-3.5 h-3.5" /> View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-xs text-gray-500 flex-wrap gap-2">
          <span>{total} total</span>
          <div className="flex items-center gap-4">
            <RowsPerPageSelect
              value={pageSize}
              onChange={(n) => { setPageSize(n); setPage(1); }}
              storageKey="dsp_admin_chats_archive_page_size"
            />
            {total > pageSize && (
              <div className="flex gap-2">
                <button disabled={page === 1} onClick={() => setPage(p => p - 1)} className="btn-secondary text-xs py-1 px-2 disabled:opacity-40">Prev</button>
                <span className="px-2 py-1">Page {page}</span>
                <button disabled={page * pageSize >= total} onClick={() => setPage(p => p + 1)} className="btn-secondary text-xs py-1 px-2 disabled:opacity-40">Next</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Blacklist panel ────────────────────────────────────────────────────────────
function BlacklistPanel() {
  const [list, setList]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [identifier, setIdentifier] = useState('');
  const [reason, setReason]     = useState('');
  const [saving, setSaving]     = useState(false);

  const load = () => {
    setLoading(true);
    getBlacklist().then(r => setList(r.data.blacklist || [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleBlock = async (e) => {
    e.preventDefault();
    if (!identifier.trim()) return;
    setSaving(true);
    try {
      const res = await blockCustomer({ identifier: identifier.trim(), reason });
      toast.success(res.data?.message || 'Customer blocked');
      setIdentifier(''); setReason('');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to block'); }
    finally { setSaving(false); }
  };

  const handleUnblock = async (id) => {
    try {
      await unblockCustomer(id);
      toast.success('Customer unblocked');
      load();
    } catch { toast.error('Failed to unblock'); }
  };

  return (
    <div className="space-y-5">
      {/* Block form */}
      <div className="card p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4 text-red-500" /> Block a Customer
        </h3>
        <form onSubmit={handleBlock} className="flex flex-wrap gap-2">
          <input
            className="input text-sm py-1.5 w-72"
            type="text"
            placeholder="Email or domain (e.g. gamma@client.com or gamma.tech)"
            value={identifier}
            onChange={e => setIdentifier(e.target.value)}
          />
          <input className="input text-sm py-1.5 flex-1 min-w-48" placeholder="Reason (optional)" value={reason} onChange={e => setReason(e.target.value)} />
          <button type="submit" disabled={saving || !identifier.trim()} className="btn-primary text-sm py-1.5 flex items-center gap-1.5">
            <Shield className="w-4 h-4" /> {saving ? 'Blocking…' : 'Block'}
          </button>
        </form>
        <p className="text-[11px] text-gray-400 mt-2">
          Type the customer's email (e.g. <span className="font-mono">gamma@client.com</span>) or their company domain (e.g. <span className="font-mono">gamma.tech</span>). Only blocks new chats — tickets, calls, and login remain available.
        </p>
      </div>

      {/* Blacklist table */}
      <div className="card overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-700">Blocked Customers ({list.length})</h3>
        </div>
        {loading ? (
          <div className="text-center py-8 text-gray-400">Loading…</div>
        ) : list.length === 0 ? (
          <div className="text-center py-10 text-sm text-gray-400">No blocked customers</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-5 py-2.5">Customer</th>
                <th className="text-left px-4 py-2.5">Reason</th>
                <th className="text-left px-4 py-2.5">Blocked By</th>
                <th className="text-right px-4 py-2.5">When</th>
                <th className="px-5 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {list.map(b => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-5 py-3">
                    <p className="font-medium text-gray-800">{b.customer_name}</p>
                    <p className="text-xs text-gray-400">{b.customer_email}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{b.reason || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{b.blocked_by_name}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">{timeAgo(b.created_at)}</td>
                  <td className="px-5 py-3 text-right">
                    <button onClick={() => handleUnblock(b.id)} className="text-xs text-red-600 hover:underline">Unblock</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdminChats() {
  const { socket } = useSocket();
  const [tab, setTab]               = useState('live');
  const [chats, setChats]           = useState([]);
  const [agents, setAgents]         = useState([]);
  const [loading, setLoading]       = useState(true);
  const [autoAssign, setAutoAssign] = useState(false);
  const [assigning, setAssigning]   = useState(null);
  const [selectedAgent, setSelectedAgent] = useState({});
  const [queueAlerts, setQueueAlerts] = useState([]);
  const [monitorChat, setMonitorChat] = useState(null);
  const [monitorMsgs, setMonitorMsgs] = useState([]);

  const load = () => {
    setLoading(true);
    getAdminChats()
      .then(res => setChats(res.data.chats || []))
      .catch(() => toast.error('Failed to load chats'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    getAdminAgents().then(res => setAgents(res.data.agents || [])).catch(() => {});
  }, []);

  useGlobalRefresh(load);

  useEffect(() => {
    if (!socket) return;
    // Join the read-only monitor room (NOT the agents routing pool). This page
    // is for managing the queue, not handling chats — we want live event
    // updates but the admin must NOT show up as an available agent to
    // customers just because they have this page open. The agent view tab is
    // the only place that joins 'agents'.
    socket.emit('join_chat_monitor_room');
    const handleStatus  = ({ enabled }) => setAutoAssign(enabled);
    const handleNewReq  = ({ chatId, customer }) => {
      setChats(prev => {
        if (prev.find(c => c.id === chatId)) return prev;
        return [...prev, { id: chatId, status: 'waiting', customer_name: customer.customer_name, customer_email: customer.domain, created_at: new Date().toISOString() }];
      });
    };
    const onAccepted    = ({ chatId }) => setChats(prev => prev.map(c => c.id === chatId ? { ...c, status: 'active' } : c));
    const onQueueAlert  = ({ chatId, customerName, minsWaiting }) => {
      setQueueAlerts(a => [...a.filter(x => x.chatId !== chatId), { chatId, customerName, minsWaiting }]);
    };
    // chat_removed = customer cancelled / agent closed / cleanup — drop the row.
    // chat_closed   = explicit close — same outcome from this page's point of view.
    // Was missing entirely; without it the admin's Chats list grew indefinitely
    // until the next manual refresh, confusing admin about real queue depth.
    const onRemoved = ({ chatId }) => {
      setChats(prev => prev.filter(c => c.id !== chatId));
      setQueueAlerts(a => a.filter(x => x.chatId !== chatId));
    };

    socket.on('auto_assign_status',    handleStatus);
    socket.on('new_chat_request',      handleNewReq);
    socket.on('chat_request_accepted', onAccepted);
    socket.on('queue_sla_alert',       onQueueAlert);
    socket.on('chat_removed',          onRemoved);
    socket.on('chat_closed',           onRemoved);
    return () => {
      socket.off('auto_assign_status',    handleStatus);
      socket.off('new_chat_request',      handleNewReq);
      socket.off('chat_request_accepted', onAccepted);
      socket.off('queue_sla_alert',       onQueueAlert);
      socket.off('chat_removed',          onRemoved);
      socket.off('chat_closed',           onRemoved);
    };
  }, [socket]);

  // Monitor socket: join monitor chat room
  useEffect(() => {
    if (!socket || !monitorChat) return;
    socket.emit('join_chat', { chatId: monitorChat.id });
    const onMsg = ({ message }) => setMonitorMsgs(m => [...m, message]);
    const onHistory = ({ messages: msgs }) => setMonitorMsgs(msgs);
    socket.on('new_message',  onMsg);
    socket.on('chat_history', onHistory);
    return () => {
      socket.off('new_message',  onMsg);
      socket.off('chat_history', onHistory);
    };
  }, [socket, monitorChat]);

  const toggleAutoAssign = () => {
    if (!socket) return;
    const next = !autoAssign;
    socket.emit('toggle_auto_assign', { enabled: next });
    setAutoAssign(next);
    toast.success(`Auto-assign ${next ? 'enabled' : 'disabled'}`);
  };

  const handleAssign = (chatId) => {
    const agentId = selectedAgent[chatId];
    if (!agentId) { toast.error('Select an agent first'); return; }
    setAssigning(chatId);
    assignAdminChat(chatId, { agent_id: agentId })
      .then(res => {
        // Backend always queues now — chat stays 'waiting' until the agent
        // clicks Accept on their side. Toast reflects that they're waiting.
        toast.success(res.data?.message || 'Chat assigned — waiting for agent to accept', { duration: 5000 });
        load();
      })
      .catch(err => toast.error(err.response?.data?.error || 'Failed'))
      .finally(() => setAssigning(null));
  };

  const pending = chats.filter(c => c.status === 'waiting');
  const active  = chats.filter(c => c.status === 'active');

  const tabCfg = [
    { key: 'live',      label: 'Live',      icon: <Activity className="w-3.5 h-3.5" /> },
    { key: 'monitor',   label: 'Monitor',   icon: <Eye className="w-3.5 h-3.5" /> },
    { key: 'analytics', label: 'Analytics', icon: <BarChart2 className="w-3.5 h-3.5" /> },
    { key: 'archive',   label: 'Archive',   icon: <Archive className="w-3.5 h-3.5" /> },
    { key: 'blacklist', label: 'Blacklist', icon: <Shield className="w-3.5 h-3.5" /> },
  ];

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Chat Management</h1>
          <p className="text-sm text-gray-500 mt-0.5">Monitor, assign, and analyse support chats</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn-secondary hidden lg:inline-flex"><RefreshCw className="w-4 h-4" /></button>
          <button
            onClick={toggleAutoAssign}
            className={clsx('flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              autoAssign ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-gray-200 text-gray-700 hover:bg-gray-300')}
          >
            {autoAssign ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
            Auto-Assign {autoAssign ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Queue SLA alerts */}
      {queueAlerts.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {queueAlerts.map(a => (
            <div key={a.chatId} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1"><strong>{a.customerName}</strong> has been waiting <strong>{a.minsWaiting} min</strong> — assign to an agent</span>
              <button onClick={() => setQueueAlerts(q => q.filter(x => x.chatId !== a.chatId))}><X className="w-3.5 h-3.5 text-amber-600" /></button>
            </div>
          ))}
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-yellow-50 rounded-lg flex items-center justify-center">
            <Clock className="w-5 h-5 text-yellow-600" />
          </div>
          <div><p className="text-2xl font-bold text-gray-800">{pending.length}</p><p className="text-sm text-gray-500">Pending</p></div>
        </div>
        <div className="card p-4 flex items-center gap-4">
          <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-green-600" />
          </div>
          <div><p className="text-2xl font-bold text-gray-800">{active.length}</p><p className="text-sm text-gray-500">Active</p></div>
        </div>
        <div className="card p-4 flex items-center gap-4">
          <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center', autoAssign ? 'bg-green-50' : 'bg-gray-50')}>
            {autoAssign ? <Zap className="w-5 h-5 text-green-600" /> : <ZapOff className="w-5 h-5 text-gray-400" />}
          </div>
          <div><p className={clsx('text-lg font-bold', autoAssign ? 'text-green-700' : 'text-gray-500')}>{autoAssign ? 'Enabled' : 'Disabled'}</p><p className="text-sm text-gray-500">Auto-Assign</p></div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-6">
        {tabCfg.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={clsx('flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
              tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700')}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* ── Live tab ── */}
      {tab === 'live' && (
        loading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Pending */}
              <div className="card overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <Clock className="w-4 h-4 text-yellow-500" /> Pending ({pending.length})
                  </h2>
                </div>
                <div className="divide-y divide-gray-50">
                  {pending.length === 0 && <div className="text-center py-10 text-gray-400 text-sm">No pending chats</div>}
                  {pending.map(chat => (
                    <div key={chat.id} className="p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-yellow-100 flex items-center justify-center text-sm font-bold text-yellow-700 flex-shrink-0">
                            {chat.customer_name?.[0] || '?'}
                          </div>
                          <div>
                            <p className="font-medium text-gray-800 text-sm">{chat.customer_name}</p>
                            <p className="text-xs text-gray-400">{timeAgo(chat.created_at)}</p>
                          </div>
                        </div>
                        {queueAlerts.some(a => a.chatId === chat.id) && (
                          <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> Waiting long
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <select className="input flex-1 text-sm" value={selectedAgent[chat.id] || ''} onChange={e => setSelectedAgent(s => ({ ...s, [chat.id]: e.target.value }))}>
                          <option value="">Select agent…</option>
                          {agents.filter(a => a.is_active).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                        <button disabled={assigning === chat.id} onClick={() => handleAssign(chat.id)} className="btn-primary text-sm flex items-center gap-1.5">
                          <UserCheck className="w-4 h-4" />
                          {assigning === chat.id ? 'Assigning…' : 'Assign'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Active */}
              <div className="card overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100">
                  <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-500" /> Active ({active.length})
                  </h2>
                </div>
                <div className="divide-y divide-gray-50">
                  {active.length === 0 && <div className="text-center py-10 text-gray-400 text-sm">No active chats</div>}
                  {active.map(chat => (
                    <div key={chat.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-sm font-bold text-green-700 flex-shrink-0">
                          {chat.customer_name?.[0] || '?'}
                        </div>
                        <div>
                          <p className="font-medium text-gray-800 text-sm">{chat.customer_name}</p>
                          <p className="text-xs text-gray-400">{chat.agent_name ? `with ${chat.agent_name}` : 'Unassigned'}</p>
                        </div>
                      </div>
                      <button onClick={() => { setMonitorChat(chat); setMonitorMsgs([]); setTab('monitor'); }} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                        <Eye className="w-3.5 h-3.5" /> Monitor
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Agent availability */}
            <AgentAvailability socket={socket} />
          </div>
        )
      )}

      {/* ── Monitor tab ── */}
      {tab === 'monitor' && (
        <div className="space-y-4">
          {!monitorChat ? (
            <div className="card p-8 text-center text-gray-400">
              <Eye className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">Click "Monitor" on an active chat from the Live tab</p>
            </div>
          ) : (
            <div className="card overflow-hidden flex flex-col" style={{ height: 'calc(100vh - 340px)' }}>
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between flex-shrink-0">
                <div>
                  <p className="text-sm font-semibold text-gray-800">{monitorChat.customer_name}</p>
                  <p className="text-xs text-gray-400">Agent: {monitorChat.agent_name || 'Unassigned'} · Read-only supervisor view</p>
                </div>
                <button onClick={() => setMonitorChat(null)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/40">
                {monitorMsgs.length === 0 && <p className="text-center text-gray-400 text-sm py-8">No messages yet — monitoring live…</p>}
                {monitorMsgs.map(m => {
                  const isAgent = m.sender_role === 'agent' || m.sender_role === 'admin';
                  return (
                    <div key={m.id} className={clsx('flex gap-2', isAgent ? 'flex-row-reverse' : 'flex-row')}>
                      <div className={clsx('max-w-sm flex flex-col', isAgent ? 'items-end' : 'items-start')}>
                        <div className={clsx('px-3 py-2 rounded-xl text-sm whitespace-pre-wrap break-words', isAgent ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-white border border-gray-200 rounded-tl-none')}>
                          {renderMarkdown(m.message)}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{m.sender_name}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-gray-100 px-4 py-2.5 bg-amber-50 text-xs text-amber-700 flex items-center gap-1.5 flex-shrink-0">
                <Eye className="w-3.5 h-3.5" /> Supervisor view — read only. The agent cannot see you are monitoring.
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Analytics tab ── */}
      {tab === 'analytics' && <AnalyticsPanel />}

      {/* ── Archive tab ── */}
      {tab === 'archive' && <ArchivePanel agents={agents} />}

      {/* ── Blacklist tab ── */}
      {tab === 'blacklist' && <BlacklistPanel />}
    </Layout>
  );
}
