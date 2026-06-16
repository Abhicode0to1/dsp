import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import { getAgentDashboard } from '../../services/api';
import {
  Headphones, Ticket, MessageSquare, CheckCircle, RefreshCw,
  AlertTriangle, Star, ArrowRight, Clock, Phone,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

function StatCard({ icon: Icon, label, value, color = 'indigo', onClick }) {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-600',
    green:  'bg-green-50 text-green-600',
    amber:  'bg-amber-50 text-amber-600',
    blue:   'bg-blue-50 text-blue-600',
    red:    'bg-red-50 text-red-600',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 flex items-center gap-5 text-left w-full hover:shadow-md hover:border-indigo-200 transition-all cursor-pointer"
    >
      <div className={`w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 ${colors[color]}`}>
        <Icon className="w-7 h-7" />
      </div>
      <div>
        <p className="text-4xl font-bold text-gray-800 leading-none">{value}</p>
        <p className="text-sm text-gray-500 mt-1.5">{label}</p>
      </div>
    </button>
  );
}

export default function AgentDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { socket } = useSocket();
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getAgentDashboard()
      .then(r => setStats(r.data.stats || {}))
      .catch(() => toast.error('Failed to load stats'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useGlobalRefresh(load);
  // Refresh every 60 seconds so the numbers stay current without manual reload
  useEffect(() => {
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // Live-sync with the ring lifecycle. The Next Action / pending-chats counter
  // is ring-ownership-aware on the server, so we must re-fetch the moment the
  // ring moves on/off this agent — otherwise the dashboard would lag the
  // toast/sidebar by up to 60s and show a phantom "Ringing you" card.
  useEffect(() => {
    if (!socket) return;
    const refresh = () => load();
    socket.on('new_chat_request',        refresh);
    socket.on('chat_request_cancelled',  refresh);
    socket.on('chat_request_accepted',   refresh);
    socket.on('chat_cancelled',          refresh);
    socket.on('chat_auto_assigned',      refresh);
    socket.on('chat_transferred_to_you', refresh);
    socket.on('chat_removed',            refresh);
    return () => {
      socket.off('new_chat_request',        refresh);
      socket.off('chat_request_cancelled',  refresh);
      socket.off('chat_request_accepted',   refresh);
      socket.off('chat_cancelled',          refresh);
      socket.off('chat_auto_assigned',      refresh);
      socket.off('chat_transferred_to_you', refresh);
      socket.off('chat_removed',            refresh);
    };
  }, [socket, load]);

  const nextAction = stats.nextAction;
  const csat = stats.csatToday || { avg: null, total: 0 };
  const slaAtRisk = stats.slaAtRisk ?? 0;

  return (
    <Layout>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-8">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-800">Overview</h1>
          <p className="text-sm text-gray-500 mt-0.5 truncate">Welcome back, {user.name}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Two prominent quick-actions for "I'm starting a new conversation" workflows.
              Both pages handle the actual flow (search customer + form). Putting the
              entry points here means agents don't have to dig through the Tickets or
              Calls subpages to find the New-Ticket / Outbound-Call buttons. */}
          <button
            onClick={() => navigate('/agent/tickets?new=1')}
            className="btn-secondary text-sm py-2 px-3 inline-flex items-center gap-1.5"
            title="Create a ticket on behalf of a customer"
          >
            <Ticket className="w-4 h-4" /> New Ticket
          </button>
          <button
            onClick={() => navigate('/agent/calls')}
            className="btn-secondary text-sm py-2 px-3 inline-flex items-center gap-1.5"
            title="Call a customer"
          >
            <Phone className="w-4 h-4" /> Call Customer
          </button>
          <button onClick={load} className="hidden lg:inline-flex btn-secondary p-2" title="Refresh stats"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-5">
          {/* SLA-breached banner — only renders when the agent has overdue tickets.
              Names the worst 3 by overdue duration so it's immediately actionable. */}
          {stats.slaBreached > 0 && (
            <div className="rounded-2xl border-2 border-red-300 bg-gradient-to-r from-red-50 to-amber-50 p-4 flex items-start gap-3">
              <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5 animate-pulse" />
              <div className="flex-1">
                <p className="font-bold text-red-800 text-sm">
                  {stats.slaBreached} of your tickets {stats.slaBreached === 1 ? 'is' : 'are'} past SLA
                </p>
                <p className="text-xs text-red-700 mt-0.5">
                  No response yet from you. Customers expecting a reply.
                </p>
                {stats.slaBreachedTickets?.length > 0 && (
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {stats.slaBreachedTickets.map(t => (
                      <button key={t.id}
                        onClick={() => navigate(`/agent/tickets?openTicket=${t.id}`)}
                        className="text-xs bg-white border border-red-200 hover:bg-red-100 px-2 py-1 rounded-md inline-flex items-center gap-1.5 transition-colors">
                        <span className="text-red-700 font-semibold">#{t.id}</span>
                        <span className="text-gray-700 truncate max-w-[200px]">{t.customer_name || t.subject}</span>
                        <span className="text-red-600 font-medium">· {t.hours_overdue}h late</span>
                      </button>
                    ))}
                    {stats.slaBreached > stats.slaBreachedTickets.length && (
                      <span className="text-xs text-red-700">+ {stats.slaBreached - stats.slaBreachedTickets.length} more</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Top: 4 core counters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5">
            <StatCard icon={Ticket}        label="Open Tickets"   value={stats.openTickets   ?? 0} color="indigo" onClick={() => navigate('/agent/tickets')} />
            <StatCard icon={MessageSquare} label="Waiting Chats"  value={stats.pendingChats  ?? 0} color="amber"  onClick={() => navigate('/agent/chats')} />
            <StatCard icon={Headphones}    label="Active Chats"   value={stats.activeChats   ?? 0} color="blue"   onClick={() => navigate('/agent/chats')} />
            <StatCard icon={CheckCircle}   label="Resolved Today" value={stats.resolvedToday ?? 0} color="green"  onClick={() => navigate('/agent/performance')} />
          </div>

          {/* Middle: Next action + SLA risk + CSAT today */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* Next action — biggest single workflow widget */}
            <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                  <ArrowRight className="w-4 h-4 text-indigo-500" /> Next Action
                </h3>
                <p className="text-xs text-gray-400">What needs your attention now</p>
              </div>
              {!nextAction ? (
                <div className="flex items-center gap-3 py-4 text-gray-500">
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  <p className="text-sm">All caught up — no unresponded tickets and the queue is empty.</p>
                </div>
              ) : nextAction.type === 'ticket' ? (
                <button
                  type="button"
                  onClick={() => navigate(`/agent/tickets?openTicket=${nextAction.id}`)}
                  className="w-full text-left p-4 rounded-xl border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50/40 transition-colors flex items-center gap-3"
                >
                  <div className="w-10 h-10 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center flex-shrink-0">
                    <Ticket className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs font-mono text-gray-400">#{nextAction.id}</p>
                      <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium capitalize',
                        nextAction.priority === 'urgent' ? 'bg-red-100 text-red-700' :
                        nextAction.priority === 'high' ? 'bg-orange-100 text-orange-700' :
                        nextAction.priority === 'medium' ? 'bg-amber-100 text-amber-700' :
                        'bg-gray-100 text-gray-600')}>{nextAction.priority}</span>
                      {typeof nextAction.minsToSla === 'number' && (
                        <span className={clsx('text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1',
                          nextAction.minsToSla < 0 ? 'bg-red-100 text-red-700' :
                          nextAction.minsToSla < 30 ? 'bg-amber-100 text-amber-700' :
                          'bg-gray-100 text-gray-600')}>
                          <Clock className="w-3 h-3" />
                          {nextAction.minsToSla < 0 ? `${Math.abs(nextAction.minsToSla)}m overdue` : `${nextAction.minsToSla}m to SLA`}
                        </span>
                      )}
                    </div>
                    <p className="text-sm font-semibold text-gray-800 truncate mt-0.5">{nextAction.subject}</p>
                    <p className="text-xs text-gray-500 mt-0.5">Reply to this ticket first — no agent response yet</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => navigate('/agent/chats')}
                  className="w-full text-left p-4 rounded-xl border border-gray-200 hover:border-amber-300 hover:bg-amber-50/40 transition-colors flex items-center gap-3"
                >
                  <div className="w-10 h-10 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                    <MessageSquare className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Ringing you</span>
                      {nextAction.category && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium capitalize">
                          {nextAction.category}
                        </span>
                      )}
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {nextAction.minsWaiting}m waiting
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-gray-800 truncate mt-1">{nextAction.customerName} is ringing your line</p>
                    <p className="text-xs text-gray-500 mt-0.5">Accept now — this chat will escalate to the next agent in 30s</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                </button>
              )}
            </div>

            {/* SLA at-risk */}
            <button
              type="button"
              onClick={() => navigate('/agent/tickets')}
              className={clsx('text-left rounded-2xl border shadow-sm p-5 transition-all',
                slaAtRisk > 0 ? 'bg-red-50 border-red-200 hover:shadow-md' : 'bg-white border-gray-100')}
            >
              <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2 mb-2">
                <AlertTriangle className={clsx('w-4 h-4', slaAtRisk > 0 ? 'text-red-600' : 'text-gray-400')} />
                SLA at risk
              </h3>
              <p className={clsx('text-4xl font-bold leading-none', slaAtRisk > 0 ? 'text-red-700' : 'text-gray-300')}>
                {slaAtRisk}
              </p>
              <p className="text-xs text-gray-500 mt-2">
                {slaAtRisk > 0
                  ? `${slaAtRisk} ticket${slaAtRisk === 1 ? '' : 's'} will breach within 30 min — respond now`
                  : 'No tickets nearing SLA breach right now'}
              </p>
            </button>

          </div>

          {/* Bottom: CSAT today */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <h3 className="text-sm font-semibold text-gray-800 flex items-center gap-2 mb-2">
                <Star className="w-4 h-4 text-yellow-500" /> Today's CSAT
              </h3>
              {csat.total > 0 ? (
                <>
                  <div className="flex items-baseline gap-1.5">
                    <p className="text-4xl font-bold text-gray-800 leading-none">{csat.avg?.toFixed(1) ?? '—'}</p>
                    <p className="text-lg text-gray-400">/ 5</p>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Across {csat.total} rating{csat.total === 1 ? '' : 's'} today
                  </p>
                </>
              ) : (
                <>
                  <p className="text-4xl font-bold text-gray-300 leading-none">—</p>
                  <p className="text-xs text-gray-500 mt-2">No ratings received yet today</p>
                </>
              )}
            </div>
            <div className="lg:col-span-2 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-2xl text-white p-5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold opacity-90 mb-1">Want a full breakdown?</h3>
                <p className="text-xs opacity-80 max-w-md">
                  Performance has CSAT trends, response-time history, and your weekly/monthly stats.
                </p>
              </div>
              <button
                onClick={() => navigate('/agent/performance')}
                className="bg-white/15 hover:bg-white/25 text-white text-sm font-medium px-4 py-2 rounded-lg flex items-center gap-2 transition-colors flex-shrink-0"
              >
                Open Performance <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>

        </div>
      )}
    </Layout>
  );
}
