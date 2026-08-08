import { useEffect, useState } from 'react';
import Layout from '../../components/common/Layout';
import { getAgentPerformance, getAgentReviews } from '../../services/api';
import { Star, TrendingUp, TrendingDown, AlertTriangle, Users, Award, ThumbsDown, RefreshCw, MessageSquare, Ticket, X, ChevronRight } from 'lucide-react';
import { timeAgo } from '../../utils/timeAgo';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

// ── Star display ──────────────────────────────────────────────────────────────
function Stars({ value, size = 'sm' }) {
  const full  = Math.floor(value || 0);
  const half  = (value || 0) - full >= 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  const sz = size === 'lg' ? 'w-5 h-5' : 'w-3.5 h-3.5';
  return (
    <span className="inline-flex items-center gap-0.5">
      {Array(full).fill(0).map((_, i) => (
        <Star key={`f${i}`} className={clsx(sz, 'text-amber-400 fill-amber-400')} />
      ))}
      {half && <Star key="h" className={clsx(sz, 'text-amber-400 fill-amber-200')} />}
      {Array(empty).fill(0).map((_, i) => (
        <Star key={`e${i}`} className={clsx(sz, 'text-gray-300')} />
      ))}
    </span>
  );
}

// ── Rating bar (distribution 1–5) ────────────────────────────────────────────
function DistBar({ dist, total }) {
  if (!total) return <span className="text-xs text-gray-400">No ratings</span>;
  return (
    <div className="space-y-0.5 w-36">
      {[5,4,3,2,1].map(n => {
        const pct = total ? Math.round(((dist[n] || 0) / total) * 100) : 0;
        return (
          <div key={n} className="flex items-center gap-1.5">
            <span className="text-[10px] text-gray-400 w-3 text-right">{n}</span>
            <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className={clsx('h-full rounded-full', n >= 4 ? 'bg-green-400' : n === 3 ? 'bg-amber-400' : 'bg-red-400')}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 w-6">{dist[n] || 0}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Score badge ───────────────────────────────────────────────────────────────
function ScoreBadge({ value }) {
  if (!value) return <span className="text-xs text-gray-400">—</span>;
  const cls = value >= 4 ? 'bg-green-50 text-green-700 border-green-200'
    : value >= 3 ? 'bg-amber-50 text-amber-700 border-amber-200'
    : 'bg-red-50 text-red-700 border-red-200';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${cls}`}>
      <Star className="w-3 h-3 fill-current" /> {value}
    </span>
  );
}

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, sub, color }) {
  return (
    <div className={clsx('card p-4 flex items-start gap-3', color)}>
      <div className={clsx('p-2 rounded-lg flex-shrink-0', color === 'border-l-4 border-green-400' ? 'bg-green-50' : color === 'border-l-4 border-amber-400' ? 'bg-amber-50' : color === 'border-l-4 border-red-400' ? 'bg-red-50' : 'bg-blue-50')}>
        <Icon className={clsx('w-5 h-5', color === 'border-l-4 border-green-400' ? 'text-green-600' : color === 'border-l-4 border-amber-400' ? 'text-amber-600' : color === 'border-l-4 border-red-400' ? 'text-red-600' : 'text-blue-600')} />
      </div>
      <div>
        <p className="text-xs text-gray-500 font-medium">{label}</p>
        <p className="text-2xl font-bold text-gray-800 leading-tight">{value ?? '—'}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

const PERIODS = [
  { value: '7',   label: '7 days' },
  { value: '30',  label: '30 days' },
  { value: '90',  label: '90 days' },
  { value: 'all', label: 'All time' },
];

export default function AdminPerformance() {
  const [data, setData]     = useState(null);
  // Default to "All time" so the dashboard always renders meaningful data on
  // first load — admins shouldn't see an empty page just because they happened
  // to land here on a week with no new ratings.
  const [period, setPeriod] = useState('all');
  const [loading, setLoading] = useState(true);
  // Click-into-agent drawer state. `selectedAgent` is the row we clicked (so
  // the drawer header has name + summary); `reviews` is the per-agent list
  // fetched on demand.
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [reviews, setReviews] = useState(null);
  const [reviewsLoading, setReviewsLoading] = useState(false);

  const load = () => {
    setLoading(true);
    getAgentPerformance({ days: period })
      .then(r => setData(r.data))
      .catch(() => toast.error('Failed to load performance data'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [period]);

  useGlobalRefresh(load);

  // Open drawer + fetch that agent's individual reviews. Period filter follows
  // the page's current period so the drawer is scoped to the same window.
  const openAgentReviews = (agent) => {
    setSelectedAgent(agent);
    setReviews(null);
    setReviewsLoading(true);
    getAgentReviews(agent.agent_id, { days: period })
      .then(r => setReviews(r.data))
      .catch(() => toast.error('Failed to load reviews'))
      .finally(() => setReviewsLoading(false));
  };

  const { agents = [], summary = {}, recentLow = [] } = data || {};
  const pctPositive = summary.total_ratings > 0
    ? Math.round((summary.positive / summary.total_ratings) * 100) : null;
  const topAgent  = agents[0];
  const worstAgent = [...agents].sort((a, b) => (a.combined_avg || 99) - (b.combined_avg || 99))[0];

  return (
    <Layout>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Agent Performance</h1>
          <p className="text-sm text-gray-500 mt-0.5">Combined CSAT from chats and tickets</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
            {PERIODS.map(p => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className={clsx('px-3 py-1.5 transition-colors', period === p.value ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button onClick={load} className="hidden lg:inline-flex btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <KpiCard
              icon={Star}
              label="Overall Avg Rating"
              value={summary.avg_score ?? '—'}
              sub={`${summary.total_ratings || 0} total ratings`}
              color="border-l-4 border-amber-400"
            />
            <KpiCard
              icon={TrendingUp}
              label="% Positive (4–5★)"
              value={pctPositive !== null ? `${pctPositive}%` : '—'}
              sub={`${summary.positive || 0} positive ratings`}
              color="border-l-4 border-green-400"
            />
            <KpiCard
              icon={Award}
              label="Top Agent"
              value={topAgent ? topAgent.combined_avg : '—'}
              sub={topAgent?.agent_name}
              color="border-l-4 border-blue-400"
            />
            <KpiCard
              icon={Users}
              label="Agents Rated"
              value={agents.length}
              sub="with at least 1 rating"
              color="border-l-4 border-gray-400"
            />
          </div>

          {/* Agent table */}
          <div className="card mb-6 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Per-Agent Breakdown</h2>
              {agents.length > 0 && (
                <p className="text-[11px] text-gray-400">Click any row to read that agent's reviews</p>
              )}
            </div>
            {agents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                <Users className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">No ratings in this period</p>
                {period !== 'all' && (
                  <button
                    onClick={() => setPeriod('all')}
                    className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium"
                  >
                    Show all ratings instead
                  </button>
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-100 bg-gray-50">
                      <th className="px-5 py-3 text-left font-semibold">#</th>
                      <th className="px-5 py-3 text-left font-semibold">Agent</th>
                      <th className="px-4 py-3 text-center font-semibold">
                        <span className="flex items-center justify-center gap-1"><MessageSquare className="w-3 h-3" /> Chat Rating</span>
                      </th>
                      <th className="px-4 py-3 text-center font-semibold">
                        <span className="flex items-center justify-center gap-1"><Ticket className="w-3 h-3" /> Ticket Rating</span>
                      </th>
                      <th className="px-4 py-3 text-center font-semibold">Combined</th>
                      <th className="px-4 py-3 text-center font-semibold">Total Ratings</th>
                      <th className="px-5 py-3 text-left font-semibold">Distribution</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {agents.map((a, idx) => (
                      <tr
                        key={a.agent_id}
                        onClick={() => openAgentReviews(a)}
                        className="hover:bg-blue-50/40 cursor-pointer transition-colors"
                        title="Click to read this agent's reviews"
                      >
                        <td className="px-5 py-4 text-xs text-gray-400 font-mono">{idx + 1}</td>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-xs font-bold text-blue-700 flex-shrink-0">
                              {a.agent_name?.[0]?.toUpperCase()}
                            </div>
                            <span className="font-medium text-gray-800 underline-offset-2 group-hover:underline">{a.agent_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-center">
                          {a.avg_chat_rating ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <Stars value={a.avg_chat_rating} />
                              <span className="text-xs text-gray-500">{a.avg_chat_rating} ({a.total_chat_ratings})</span>
                            </div>
                          ) : <span className="text-xs text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-4 text-center">
                          {a.avg_ticket_rating ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <Stars value={a.avg_ticket_rating} />
                              <span className="text-xs text-gray-500">{a.avg_ticket_rating} ({a.total_ticket_ratings})</span>
                            </div>
                          ) : <span className="text-xs text-gray-400">—</span>}
                        </td>
                        <td className="px-4 py-4 text-center">
                          <div className="flex flex-col items-center gap-1">
                            <ScoreBadge value={a.combined_avg} />
                            <Stars value={a.combined_avg} />
                          </div>
                        </td>
                        <td className="px-4 py-4 text-center">
                          <span className="text-sm font-semibold text-gray-700">{a.total_ratings}</span>
                        </td>
                        <td className="px-5 py-4">
                          <DistBar dist={a.dist} total={a.total_ratings} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent low ratings */}
          <div className="card overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <ThumbsDown className="w-4 h-4 text-red-500" />
              <h2 className="text-sm font-semibold text-gray-700">Recent Low Ratings (1–2★)</h2>
              {recentLow.length > 0 && (
                <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200 font-medium">
                  {recentLow.length}
                </span>
              )}
            </div>
            {recentLow.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-gray-400">
                <TrendingUp className="w-10 h-10 mb-2 opacity-20" />
                <p className="text-sm">No low ratings in this period</p>
                {period !== 'all' && (
                  <button
                    onClick={() => setPeriod('all')}
                    className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium"
                  >
                    Check all-time low ratings
                  </button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {recentLow.map((r, i) => (
                  <div key={i} className="px-5 py-3 flex items-start gap-4">
                    <div className="flex-shrink-0 mt-0.5">
                      <span className={clsx('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border',
                        r.type === 'chat' ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-purple-50 text-purple-700 border-purple-200'
                      )}>
                        {r.type === 'chat' ? <MessageSquare className="w-3 h-3" /> : <Ticket className="w-3 h-3" />}
                        {r.type} #{r.ref_id}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Stars value={r.score} />
                        <span className="text-xs text-gray-500">{r.agent_name || 'Unassigned'}</span>
                        <span className="text-xs text-gray-400 ml-auto">{timeAgo(r.created_at)}</span>
                      </div>
                      {r.comment && <p className="text-xs text-gray-600 truncate">{r.comment}</p>}
                      {!r.comment && <p className="text-xs text-gray-400 italic">No comment</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {selectedAgent && (
        <AgentReviewsDrawer
          agent={selectedAgent}
          data={reviews}
          loading={reviewsLoading}
          period={period}
          onClose={() => { setSelectedAgent(null); setReviews(null); }}
        />
      )}
    </Layout>
  );
}

// Slide-in drawer that lists every review the selected agent has received in
// the current period. Chat + ticket reviews are merged and sorted newest first;
// reviews with no comment are still shown (just labelled "No comment") so an
// admin sees the full rating list, not a filtered subset.
function AgentReviewsDrawer({ agent, data, loading, period, onClose }) {
  const reviews = data?.reviews || [];
  const s = data?.summary || {};
  const periodLabel = period === 'all' ? 'All time'
    : period === '7'  ? 'Last 7 days'
    : period === '30' ? 'Last 30 days'
    : period === '90' ? 'Last 90 days'
    : `Last ${period} days`;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <div className="w-full max-w-xl bg-white shadow-2xl flex flex-col h-full">
        <div className="px-6 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] text-gray-400 uppercase tracking-wide font-semibold">Reviews · {periodLabel}</p>
            <h2 className="text-lg font-bold text-gray-800 truncate">{agent.agent_name}</h2>
            {!loading && (
              <p className="text-xs text-gray-500 mt-1">
                {s.total || 0} review{s.total === 1 ? '' : 's'}
                {s.avg != null && <> · avg <span className="font-semibold text-gray-700">{s.avg}★</span></>}
                {s.with_comment > 0 && <> · {s.with_comment} with comment{s.with_comment === 1 ? '' : 's'}</>}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40">
              <div className="w-7 h-7 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : reviews.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <MessageSquare className="w-10 h-10 mb-2 opacity-20" />
              <p className="text-sm">No reviews for {agent.agent_name} in this period</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {reviews.map((r, i) => {
                const score = Number(r.score);
                const tone = score >= 4 ? 'border-l-green-400' : score === 3 ? 'border-l-amber-400' : 'border-l-red-400';
                return (
                  <div key={`${r.type}-${r.ref_id}-${i}`} className={clsx('px-6 py-4 border-l-4', tone)}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <Stars value={score} />
                      <span className="text-xs font-semibold text-gray-700">{score}.0</span>
                      <span className={clsx(
                        'inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border',
                        r.type === 'chat'
                          ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : 'bg-purple-50 text-purple-700 border-purple-200'
                      )}>
                        {r.type === 'chat' ? <MessageSquare className="w-2.5 h-2.5" /> : <Ticket className="w-2.5 h-2.5" />}
                        {r.type} #{r.ref_id}
                      </span>
                      <span className="text-xs text-gray-400 ml-auto" title={new Date(r.created_at).toLocaleString()}>
                        {timeAgo(r.created_at)}
                      </span>
                    </div>
                    {r.comment ? (
                      <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{r.comment}</p>
                    ) : (
                      <p className="text-xs text-gray-400 italic">No comment</p>
                    )}
                    {r.customer_name && (
                      <p className="text-[11px] text-gray-400 mt-1.5">— {r.customer_name}</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
