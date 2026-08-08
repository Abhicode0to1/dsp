import { Fragment, useEffect, useState, useCallback, useRef } from 'react';
import Layout from '../../components/common/Layout';
import { useSocket } from '../../contexts/SocketContext';
import { useAuth } from '../../contexts/AuthContext';
import { getAgentMyCalls, searchCustomers } from '../../services/api';
import {
  Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, PhoneOff,
  RefreshCw, Search, Clock, History, Check, X,
} from 'lucide-react';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import toast from 'react-hot-toast';

function formatDuration(seconds) {
  if (!seconds || seconds < 1) return '< 1s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function relativeTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const STATUS_BADGE = {
  ended:    { label: 'Connected', cls: 'bg-green-100 text-green-700', Icon: Phone },
  active:   { label: 'In progress', cls: 'bg-blue-100 text-blue-700 animate-pulse', Icon: Phone },
  ringing:  { label: 'Ringing', cls: 'bg-amber-100 text-amber-700 animate-pulse', Icon: Phone },
  missed:   { label: 'Missed', cls: 'bg-red-100 text-red-600', Icon: PhoneMissed },
  failed:   { label: 'Failed', cls: 'bg-gray-100 text-gray-500', Icon: PhoneOff },
};

export default function AgentCalls() {
  const { socket } = useSocket();
  const { user } = useAuth();
  const [data, setData] = useState({ calls: [], stats: { calls_today: 0, seconds_today: 0, connected_30d: 0 } });
  const [loading, setLoading] = useState(true);

  // Customer search state
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [showResults, setShowResults] = useState(false);
  const searchTimer = useRef(null);
  const wrapRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    getAgentMyCalls()
      .then(res => setData(res.data))
      .catch(() => toast.error('Failed to load call history'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useGlobalRefresh(load);

  // Debounced customer search
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!q.trim() || q.trim().length < 2) { setResults([]); return; }
    searchTimer.current = setTimeout(() => {
      setSearching(true);
      searchCustomers(q.trim())
        .then(res => { setResults(res.data.customers || res.data || []); setShowResults(true); })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(searchTimer.current);
  }, [q]);

  // Close dropdown on click-outside
  useEffect(() => {
    const onClick = (e) => { if (!wrapRef.current?.contains(e.target)) setShowResults(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleCall = (c) => {
    // Dispatch the same event the OutboundCallOverlay listens to — reuses the existing
    // WebRTC plumbing so this page doesn't reinvent any call flow.
    window.dispatchEvent(new CustomEvent('dsp:agent-call-customer', {
      detail: { customerId: c.id, customerName: c.name || c.user_name },
    }));
    setQ('');
    setResults([]);
    setShowResults(false);
  };

  const handleRedial = (call) => {
    if (!call.customer_id) { toast.error('No customer linked to this call'); return; }
    window.dispatchEvent(new CustomEvent('dsp:agent-call-customer', {
      detail: { customerId: call.customer_id, customerName: call.customer_name },
    }));
  };

  // Calls that AgentCallOverlay is currently showing as a popup. We HIDE
  // those calls from the inline banner below so the agent doesn't see two
  // sets of Accept/Reject buttons for the same call — one in the popup,
  // one in the banner — which was the "two accept options confusing" bug.
  // AgentCallOverlay dispatches `dsp:call-popup-active` when its state
  // becomes 'ringing' and `dsp:call-popup-cleared` when it transitions away.
  const [popupActiveIds, setPopupActiveIds] = useState(() => new Set());
  useEffect(() => {
    const onActive = (e) => {
      const id = e.detail?.callId;
      if (id == null) return;
      setPopupActiveIds(prev => new Set([...prev, id]));
    };
    const onCleared = (e) => {
      const id = e.detail?.callId;
      if (id == null) return;
      setPopupActiveIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    };
    window.addEventListener('dsp:call-popup-active', onActive);
    window.addEventListener('dsp:call-popup-cleared', onCleared);
    return () => {
      window.removeEventListener('dsp:call-popup-active', onActive);
      window.removeEventListener('dsp:call-popup-cleared', onCleared);
    };
  }, []);

  // Calls that are currently ringing TO me — fallback pickup UX. When the
  // AgentCallOverlay's popup gets missed/dismissed, the agent can still pick
  // up the call from here. Emits resume_ringing_call → backend re-emits
  // incoming_call → the overlay re-appears with the original offer.
  // /api/agent/calls/mine is already scoped to the current agent server-side
  // (WHERE ca.agent_id = req.user.id), so we just check status here.
  // Also: if the popup is already showing this call, skip the banner.
  const ringingForMe = (data.calls || []).filter(
    c => c.status === 'ringing' && !popupActiveIds.has(c.id)
  );

  const handleResume = (callId) => {
    if (!socket) { toast.error('Socket not connected'); return; }
    socket.emit('resume_ringing_call', { callId });
  };

  const handleRejectRinging = (callId) => {
    if (!socket) { toast.error('Socket not connected'); return; }
    socket.emit('call_reject', { callId });
    toast('Call rejected');
    setTimeout(load, 500); // refresh table
  };

  // Auto-refresh whenever a call event lands so the ringing-banner stays in
  // sync without the agent hitting Refresh manually.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => load();
    socket.on('incoming_call', refresh);
    socket.on('call_ended', refresh);
    socket.on('call_cancelled', refresh);
    socket.on('call_accepted', refresh);
    return () => {
      socket.off('incoming_call', refresh);
      socket.off('call_ended', refresh);
      socket.off('call_cancelled', refresh);
      socket.off('call_accepted', refresh);
    };
  }, [socket, load]);

  return (
    <Layout>
      <div className="p-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <Phone className="w-6 h-6 text-blue-600" />
              Calls
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Dial a customer directly or review your recent call history.
            </p>
          </div>
          <button onClick={load} disabled={loading} className="hidden lg:inline-flex btn-secondary p-2" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Ringing-call banner — surfaces calls assigned to me that are still
            in 'ringing' state. Belt-and-braces for cases where the floating
            AgentCallOverlay popup was missed or dismissed: agent can re-open
            it (Accept) or decline (Reject) right from here. */}
        {ringingForMe.length > 0 && (
          <div className="mb-5 space-y-2">
            {ringingForMe.map(c => (
              <div
                key={c.id}
                className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4 flex items-center justify-between gap-3 animate-pulse"
                style={{ animation: 'pulse 2s ease-in-out infinite' }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                    <PhoneIncoming className="w-5 h-5 text-amber-700" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-800 truncate">
                      Incoming call from {c.customer_name || 'Customer'}
                    </p>
                    <p className="text-xs text-amber-700">Ringing now — pick up or decline</p>
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => handleResume(c.id)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition-colors"
                  >
                    <Check className="w-4 h-4" /> Accept
                  </button>
                  <button
                    onClick={() => handleRejectRinging(c.id)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 rounded-lg text-sm font-semibold transition-colors"
                  >
                    <X className="w-4 h-4" /> Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center">
                <Phone className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Calls today</p>
                <p className="text-2xl font-bold text-gray-800">{data.stats.calls_today}</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center">
                <Clock className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Talk time today</p>
                <p className="text-2xl font-bold text-gray-800">{formatDuration(data.stats.seconds_today)}</p>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-green-50 flex items-center justify-center">
                <History className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Connected (30d)</p>
                <p className="text-2xl font-bold text-gray-800">{data.stats.connected_30d}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Call a customer */}
        <div className="card p-5 mb-5">
          <h3 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
            <PhoneOutgoing className="w-4 h-4 text-blue-600" /> Call a customer
          </h3>
          <div ref={wrapRef} className="relative">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Type customer name or email to find them…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onFocus={() => results.length && setShowResults(true)}
                className="input pl-9 w-full"
              />
              {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />}
            </div>
            {showResults && results.length > 0 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                {results.map(c => (
                  <button
                    key={c.id}
                    onClick={() => handleCall(c)}
                    className="w-full text-left px-4 py-2.5 hover:bg-blue-50 border-b border-gray-50 last:border-b-0 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-800 truncate">{c.name || c.user_name}</p>
                      <p className="text-xs text-gray-500 truncate">{c.email} · {c.domain || '—'}</p>
                    </div>
                    <span className="text-xs px-2 py-1 rounded-full bg-blue-600 text-white flex-shrink-0 inline-flex items-center gap-1">
                      <Phone className="w-3 h-3" /> Call
                    </span>
                  </button>
                ))}
              </div>
            )}
            {showResults && !searching && results.length === 0 && q.trim().length >= 2 && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow p-4 text-sm text-gray-500 text-center">
                No customers found for "{q}"
              </div>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Outbound calls don't count against the customer's monthly call quota.
          </p>
        </div>

        {/* Recent calls table */}
        <div className="card p-0 overflow-hidden">
          <div className="p-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-700">Recent calls (last 30 days)</h3>
          </div>
          {loading ? (
            <div className="p-12 flex justify-center">
              <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : data.calls.length === 0 ? (
            <div className="p-12 text-center text-gray-400">
              <Phone className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p className="text-sm">No calls yet</p>
              <p className="text-xs mt-1">Use the search above to call your first customer.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[760px] lg:min-w-0">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Direction</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Duration</th>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map(c => {
                  const badge = STATUS_BADGE[c.status] || { label: c.status, cls: 'bg-gray-100 text-gray-600', Icon: Phone };
                  const Icon = badge.Icon;
                  return (
                    <Fragment key={c.id}>
                    <tr className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">{c.customer_name || '—'}</p>
                        <p className="text-xs text-gray-500">{c.customer_domain || ''}</p>
                      </td>
                      <td className="px-4 py-3">
                        {c.initiated_by === 'agent'
                          ? <span className="text-xs inline-flex items-center gap-1 text-blue-600"><PhoneOutgoing className="w-3.5 h-3.5" /> Outbound</span>
                          : <span className="text-xs inline-flex items-center gap-1 text-gray-600"><PhoneIncoming className="w-3.5 h-3.5" /> Inbound</span>}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${badge.cls}`}>
                          <Icon className="w-3 h-3" /> {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        <span
                          title={c.call_start_time
                            ? `Started: ${new Date(c.call_start_time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}${c.call_end_time ? `\nEnded: ${new Date(c.call_end_time).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}` : ''}`
                            : ''}
                        >
                          {c.call_start_time ? formatDuration(c.duration) : '—'}
                        </span>
                      </td>
                      <td
                        className="px-4 py-3 text-gray-500 text-xs"
                        title={new Date(c.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}
                      >
                        {relativeTime(c.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRedial(c)}
                          disabled={!c.customer_id}
                          className="text-xs px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium inline-flex items-center gap-1.5 disabled:opacity-40"
                          title={c.customer_id ? 'Call this customer again' : 'No customer linked'}
                        >
                          <Phone className="w-3 h-3" /> Redial
                        </button>
                      </td>
                    </tr>
                    {/* Participants timeline — only shown if the call was actually
                        transferred (more than one agent on the participants log).
                        Each segment shows the agent's name and how long they
                        held the call before either transferring out or the
                        call ending. Lets agents see "I was on for 2m, then
                        Anita took over for the remaining 5m". */}
                    {(() => {
                      const parts = Array.isArray(c.participants)
                        ? c.participants
                        : (() => { try { return JSON.parse(c.participants || '[]'); } catch { return []; } })();
                      if (!parts || parts.length < 2) return null;
                      const fmt = (s) => {
                        if (s < 1) return '<1s';
                        const m = Math.floor(s / 60);
                        const sec = Math.round(s % 60);
                        return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
                      };
                      // Compute each segment's duration. Final segment ends at
                      // call_end_time (or now, for an in-flight call).
                      const endRef = c.call_end_time ? new Date(c.call_end_time) : new Date();
                      const segments = parts.map((p, i) => {
                        const joined = new Date(p.joined_at);
                        const next = i + 1 < parts.length ? new Date(parts[i + 1].joined_at) : endRef;
                        const dur = Math.max(0, (next - joined) / 1000);
                        return { name: p.agent_name, joined, dur };
                      });
                      return (
                        <tr className="bg-violet-50/40 border-b border-gray-50">
                          <td colSpan={6} className="px-4 py-2">
                            <div className="flex items-start gap-2 text-xs">
                              <span className="text-violet-700 font-semibold mt-0.5">🔁 Transferred:</span>
                              <div className="flex flex-wrap items-center gap-1.5 text-gray-700">
                                {segments.map((s, i) => (
                                  <span key={i} className="inline-flex items-center gap-1">
                                    <span className="font-medium" title={s.joined.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium' })}>
                                      {s.name}
                                    </span>
                                    <span className="text-gray-500">({fmt(s.dur)})</span>
                                    {i < segments.length - 1 && <span className="text-violet-500">→</span>}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })()}
                    {/* Quick notes the agent jotted down during the call. Pulled from
                        calls.agent_notes — set automatically when the call ends. */}
                    {c.agent_notes && (
                      <tr className="bg-amber-50/30 border-b border-gray-50">
                        <td colSpan={6} className="px-4 py-2">
                          <div className="flex items-start gap-2 text-xs">
                            <span className="text-amber-600 font-semibold mt-0.5">📝 Notes:</span>
                            <span className="text-gray-700 whitespace-pre-wrap break-words flex-1">{c.agent_notes}</span>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
