import { useEffect, useState, useCallback, Fragment } from 'react';
import Layout from '../../components/common/Layout';
import RowsPerPageSelect, { readStoredPageSize } from '../../components/common/RowsPerPageSelect';
import { useSocket } from '../../contexts/SocketContext';
import {
  getAdminCalls, getAdminAgents, getAttachmentDownloadUrl,
  getCallBlacklist, blockCustomerCalls, unblockCustomerCalls,
  redirectRingingCall,
} from '../../services/api';
import { Phone, Search, RefreshCw, Headphones, ArrowUpRight, X, AlertCircle, Mic, Shield, Activity, UserCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

const STATUS_COLOR = {
  ended:     'bg-green-50 text-green-700 border-green-200',
  active:    'bg-blue-50 text-blue-700 border-blue-200',
  ringing:   'bg-amber-50 text-amber-700 border-amber-200',
  initiated: 'bg-amber-50 text-amber-700 border-amber-200',
  missed:    'bg-red-50 text-red-700 border-red-200',
  failed:    'bg-gray-100 text-gray-600 border-gray-200',
};

function formatDuration(s) {
  if (!s || s <= 0) return '—';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatBytes(b) {
  if (!b) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Modal for redirecting a currently-ringing call to a different agent.
// The current agent (the one being rung right now) is excluded from the
// dropdown — redirecting to themselves would be a no-op.
function RedirectCallModal({ call, agents, onClose, onDone }) {
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const eligible = (agents || []).filter(a => a.is_active !== 0 && String(a.id) !== String(call.agent_id || ''));

  const submit = async () => {
    if (!targetId) { toast.error('Pick an agent to redirect to'); return; }
    setBusy(true);
    try {
      const r = await redirectRingingCall(call.id, Number(targetId));
      toast.success(`Call redirected to ${r.data.new_agent_name || 'the chosen agent'}`);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not redirect this call');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      {/* No backdrop-click-to-close — losing the agent picker mid-redirect on
          an accidental click would be confusing. Close via X or Cancel. */}
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <UserCheck className="w-5 h-5 text-amber-600" />
            Redirect Ringing Call
          </h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700"><X className="w-4 h-4" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div className="text-sm text-gray-600">
            Pull this call away from <strong>{call.agent_name || 'the current agent'}</strong> and ring a different agent instead.
            The new agent gets 30s to pick up — if they miss, the call is marked missed (no further escalation).
          </div>
          <div>
            <label className="label">New agent</label>
            <select value={targetId} onChange={e => setTargetId(e.target.value)} className="input" disabled={busy}>
              <option value="">Pick an agent…</option>
              {eligible.map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.role === 'admin' ? ' (admin)' : ''}</option>
              ))}
            </select>
            {eligible.length === 0 && (
              <p className="text-xs text-amber-700 mt-2">No other agents available to redirect to.</p>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="btn-secondary">Cancel</button>
          <button onClick={submit} disabled={busy || !targetId} className="btn-primary">
            {busy ? 'Redirecting…' : 'Redirect'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline player row — only mounted when admin clicks "Play"
function RecordingPlayer({ attachmentId, mime, size, onClose }) {
  const url = getAttachmentDownloadUrl(attachmentId);
  return (
    <div className="flex items-center gap-3 p-3 bg-indigo-50/40 border-t border-indigo-100">
      <Mic className="w-4 h-4 text-indigo-600 flex-shrink-0" />
      <audio controls src={url} className="flex-1 h-9" />
      <a
        href={url}
        download
        className="text-xs px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1 flex-shrink-0"
      >
        <ArrowUpRight className="w-3 h-3" /> Download
      </a>
      <span className="text-[10px] text-gray-400 flex-shrink-0">{formatBytes(size)} · {mime?.replace('audio/', '') || ''}</span>
      <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

export default function AdminCalls() {
  const { socket } = useSocket();
  const [tab, setTab] = useState('records'); // 'records' | 'blacklist'
  const [calls, setCalls] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState([]);
  const [page, setPage] = useState(1);
  const [playingId, setPlayingId] = useState(null);
  // Call being redirected — {} closes the modal, an object with the row opens it.
  const [redirectCall, setRedirectCall] = useState(null);

  // Filters
  const [q, setQ] = useState('');
  const [agentId, setAgentId] = useState('');
  const [hasRecording, setHasRecording] = useState(''); // '' | '1' | '0'
  const [shortOnly, setShortOnly] = useState(false);    // spam-cut audit lens
  const [rangeDays, setRangeDays] = useState(30);
  // Threshold echoed back by the backend so the row marker matches the
  // current admin setting (Settings → Call Billing).
  const [shortThreshold, setShortThreshold] = useState(30);

  const [limit, setLimit] = useState(() => readStoredPageSize('dsp_admin_calls_page_size'));

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit };
    if (q.trim())   params.q = q.trim();
    if (agentId)    params.agent_id = agentId;
    if (hasRecording !== '') params.has_recording = hasRecording;
    if (shortOnly) params.short_only = '1';
    if (rangeDays !== 'all') {
      const from = new Date(Date.now() - rangeDays * 24 * 3600 * 1000);
      params.from = from.toISOString().slice(0, 19).replace('T', ' ');
    }
    getAdminCalls(params)
      .then(r => {
        setCalls(r.data.calls);
        setTotal(r.data.total);
        if (r.data.min_billable_call_seconds != null) setShortThreshold(r.data.min_billable_call_seconds);
      })
      .catch(() => toast.error('Failed to load calls'))
      .finally(() => setLoading(false));
  }, [page, limit, q, agentId, hasRecording, shortOnly, rangeDays]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [q, agentId, hasRecording, shortOnly, rangeDays]);

  useGlobalRefresh(load);

  useEffect(() => {
    getAdminAgents().then(r => setAgents(r.data.agents || [])).catch(() => {});
  }, []);

  // Live updates: join the call_monitors socket room so any meaningful
  // call lifecycle transition (new ring, accept, end, miss, redirect) fires
  // a refresh without the admin having to click the refresh button. Pairs
  // with the new admin Redirect action — ringing calls now appear in real
  // time so the admin can act on them while they're still hot.
  useEffect(() => {
    if (!socket) return;
    socket.emit('join_call_monitor_room');
    const refresh = () => load();
    socket.on('call_list_changed', refresh);
    return () => { socket.off('call_list_changed', refresh); };
  }, [socket, load]);

  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Phone className="w-5 h-5 text-indigo-500" /> Calls
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">All voice call records. Recordings are retained for 30 days.</p>
        </div>
        <button onClick={load} className="hidden lg:inline-flex btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
        {[
          { key: 'records',   label: 'Call Records', icon: <Activity className="w-3.5 h-3.5" /> },
          { key: 'blacklist', label: 'Blacklist',    icon: <Shield className="w-3.5 h-3.5" /> },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'text-indigo-700 border-indigo-600'
                : 'text-gray-500 border-transparent hover:text-gray-700'
            )}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'blacklist' && <CallBlacklistPanel />}

      {tab === 'records' && <>
      <div className="mb-5 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 flex items-start gap-2 text-xs text-blue-800">
        <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="font-medium">Privacy</p>
          <p>Only admin users can listen to call recordings. Recordings auto-delete after 30 days. Customers are informed at call start.</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search by customer name, email, domain…"
              className="input text-sm w-full pl-9"
            />
          </div>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} className="input text-sm">
            <option value="">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={hasRecording} onChange={e => setHasRecording(e.target.value)} className="input text-sm">
            <option value="">All calls</option>
            <option value="1">With recording</option>
            <option value="0">Without recording</option>
          </select>
          <select value={rangeDays} onChange={e => setRangeDays(e.target.value === 'all' ? 'all' : parseInt(e.target.value))} className="input text-sm">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value="all">All time</option>
          </select>
          <label
            title={`Spam-cut audit: customer calls that ended in under ${shortThreshold}s of agent-connected time. These calls did NOT count against the customer's monthly call_limit.`}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium cursor-pointer transition-colors',
              shortOnly
                ? 'bg-amber-50 border-amber-300 text-amber-800'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            )}
          >
            <input
              type="checkbox"
              checked={shortOnly}
              onChange={e => setShortOnly(e.target.checked)}
              className="w-3.5 h-3.5 accent-amber-600"
            />
            Short-cut only (&lt;{shortThreshold}s)
          </label>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : calls.length === 0 ? (
          <div className="py-12 text-center">
            <Phone className="w-10 h-10 mx-auto text-gray-300 mb-2" />
            <p className="text-sm text-gray-500">No calls found.</p>
            <p className="text-xs text-gray-400 mt-1">Try widening the date range or clearing filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/60 border-b border-gray-100">
                <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5">Agent</th>
                  <th className="px-4 py-2.5 text-center">Direction</th>
                  <th className="px-4 py-2.5 text-center">Duration</th>
                  <th className="px-4 py-2.5 text-center">Status</th>
                  <th className="px-4 py-2.5 text-center">Ended by</th>
                  <th className="px-4 py-2.5 text-right">Recording</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {calls.map(c => (
                  <Fragment key={c.id}>
                    <tr className="hover:bg-gray-50/50">
                      <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                        {new Date(c.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">{c.customer_name}</p>
                        <p className="text-xs text-gray-400">{c.customer_domain || c.customer_email}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{c.agent_name || <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={clsx('text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded',
                          c.initiated_by === 'agent' ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-blue-700')}>
                          {c.initiated_by === 'agent' ? 'outbound' : 'inbound'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-gray-600 whitespace-nowrap">
                        {formatDuration(c.duration)}
                        {c.status === 'ended'
                          && c.initiated_by !== 'agent'
                          && c.duration != null
                          && c.duration < shortThreshold
                          && c.duration > 0 && (
                            <span
                              title={`Call ended in ${c.duration}s — under the ${shortThreshold}s billable threshold, so it did NOT count against the customer's monthly call_limit. Watch for agents with many of these.`}
                              className="ml-1 inline-block text-[9px] uppercase tracking-wider font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded"
                            >
                              short-cut
                            </span>
                          )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={clsx('text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full border', STATUS_COLOR[c.status] || STATUS_COLOR.failed)}>
                          {c.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {c.ended_by ? (
                          <span className={clsx(
                            'text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap',
                            c.ended_by === 'customer' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                            c.ended_by === 'agent'    ? 'bg-purple-50 text-purple-700 border-purple-200' :
                            c.ended_by === 'admin'    ? 'bg-indigo-50 text-indigo-700 border-indigo-200' :
                                                         'bg-gray-50 text-gray-600 border-gray-200'
                          )} title={
                            c.ended_by === 'customer' ? 'Customer hung up' :
                            c.ended_by === 'agent'    ? 'Agent hung up' :
                            c.ended_by === 'admin'    ? 'Admin force-ended (block/redirect)' :
                                                         'System (network drop / disconnect cleanup)'
                          }>
                            {c.ended_by}
                          </span>
                        ) : <span className="text-xs text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {c.status === 'ringing' ? (
                          // Live "ringing" row — admin can hand the call off to
                          // a different agent before it auto-times-out.
                          <button
                            onClick={() => setRedirectCall(c)}
                            className="text-xs px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 font-medium inline-flex items-center gap-1"
                          >
                            <UserCheck className="w-3 h-3" /> Redirect
                          </button>
                        ) : c.recording_attachment_id ? (
                          playingId === c.id ? (
                            <span className="text-xs text-indigo-600 font-medium">Playing below ↓</span>
                          ) : (
                            <button
                              onClick={() => setPlayingId(c.id)}
                              className="text-xs px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 font-medium inline-flex items-center gap-1"
                            >
                              <Headphones className="w-3 h-3" /> Play
                            </button>
                          )
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                    {playingId === c.id && c.recording_attachment_id && (
                      <tr>
                        <td colSpan={8} className="p-0">
                          <RecordingPlayer
                            attachmentId={c.recording_attachment_id}
                            mime={c.recording_mime}
                            size={c.recording_size}
                            onClose={() => setPlayingId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {calls.length > 0 && (
          <div className="px-4 py-2.5 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500 flex-wrap gap-2">
            <span>{total} total · page {page} of {pages}</span>
            <div className="flex items-center gap-4">
              <RowsPerPageSelect
                value={limit}
                onChange={(n) => { setLimit(n); setPage(1); }}
                storageKey="dsp_admin_calls_page_size"
              />
              {pages > 1 && (
                <div className="flex gap-1.5">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary text-xs py-1 px-2 disabled:opacity-40">Prev</button>
                  <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page === pages} className="btn-secondary text-xs py-1 px-2 disabled:opacity-40">Next</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      </>}
      {redirectCall && (
        <RedirectCallModal
          call={redirectCall}
          agents={agents}
          onClose={() => setRedirectCall(null)}
          onDone={() => { setRedirectCall(null); load(); }}
        />
      )}
    </Layout>
  );
}

// ── Blacklist panel — admin blocks customers from initiating voice calls ─────
function CallBlacklistPanel() {
  const [list, setList]             = useState([]);
  const [loading, setLoading]       = useState(true);
  const [identifier, setIdentifier] = useState('');
  const [reason, setReason]         = useState('');
  const [saving, setSaving]         = useState(false);

  const load = () => {
    setLoading(true);
    getCallBlacklist().then(r => setList(r.data.blacklist || [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleBlock = async (e) => {
    e.preventDefault();
    if (!identifier.trim()) return;
    setSaving(true);
    try {
      const res = await blockCustomerCalls({ identifier: identifier.trim(), reason });
      toast.success(res.data?.message || 'Customer blocked from calls');
      setIdentifier(''); setReason('');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to block'); }
    finally { setSaving(false); }
  };

  const handleUnblock = async (id) => {
    try {
      await unblockCustomerCalls(id);
      toast.success('Customer unblocked from calls');
      load();
    } catch { toast.error('Failed to unblock'); }
  };

  return (
    <div className="space-y-5">
      {/* Block form */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4 text-red-500" /> Block a Customer from Calls
        </h3>
        <form onSubmit={handleBlock} className="flex flex-wrap gap-2">
          <input
            className="input text-sm py-1.5 w-72"
            type="text"
            placeholder="Email or domain (e.g. gamma@client.com or gamma.tech)"
            value={identifier}
            onChange={e => setIdentifier(e.target.value)}
          />
          <input
            className="input text-sm py-1.5 flex-1 min-w-48"
            placeholder="Reason (optional)"
            value={reason}
            onChange={e => setReason(e.target.value)}
          />
          <button type="submit" disabled={saving || !identifier.trim()} className="btn-primary text-sm py-1.5 flex items-center gap-1.5">
            <Shield className="w-4 h-4" /> {saving ? 'Blocking…' : 'Block'}
          </button>
        </form>
        <p className="text-[11px] text-gray-400 mt-2">
          Type the customer's email (e.g. <span className="font-mono">gamma@client.com</span>) or their company domain (e.g. <span className="font-mono">gamma.tech</span>). Only blocks new calls — tickets and live chat remain available. Any in-flight call is ended immediately.
        </p>
      </div>

      {/* Blacklist table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">
          Blocked Customers ({list.length})
        </div>
        {loading ? (
          <div className="py-8 text-center text-xs text-gray-400">Loading…</div>
        ) : list.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-400">No customers are blocked from calls.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50/60 border-b border-gray-100">
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Reason</th>
                <th className="px-4 py-2.5">Blocked By</th>
                <th className="px-4 py-2.5">Blocked At</th>
                <th className="px-4 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {list.map(row => (
                <tr key={row.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-800">{row.customer_name}</p>
                    <p className="text-xs text-gray-400">{row.customer_email}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">{row.reason || <span className="text-gray-300 italic">—</span>}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">{row.blocked_by_name}</td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {new Date(row.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleUnblock(row.id)}
                      className="text-xs px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700"
                    >
                      Unblock
                    </button>
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
