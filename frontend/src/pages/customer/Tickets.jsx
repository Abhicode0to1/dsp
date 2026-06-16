import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { TicketStatusBadge, PriorityBadge } from '../../components/common/PlanBadge';
import { getMyTickets } from '../../services/api';
import { Ticket, RefreshCw, ChevronRight, Search, MessageCircle } from 'lucide-react';
import { timeAgo, fullDate } from '../../utils/timeAgo';
import { SkeletonTableRows } from '../../components/common/Skeleton';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import toast from 'react-hot-toast';

const PRIORITY_STRIPE = {
  urgent:   'bg-red-500',
  high:     'bg-orange-400',
  medium:   'bg-amber-400',
  normal:   'bg-blue-300',
  low:      'bg-gray-300',
};

const PAGE_SIZE = 20;
const LAST_SEEN_KEY = 'dsp_tickets_last_seen';

export default function CustomerTickets() {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const navigate = useNavigate();
  // Capture the last-seen timestamp from previous visit before updating it
  const lastSeenRef = useRef(localStorage.getItem(LAST_SEEN_KEY));

  // Debounce search input by 400ms to avoid firing on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback((p, append = false) => {
    if (!append) setLoading(true); else setLoadingMore(true);
    const params = { limit: PAGE_SIZE, page: p };
    if (statusFilter) params.status = statusFilter;
    if (debouncedSearch.trim()) params.search = debouncedSearch.trim();
    getMyTickets(params)
      .then(res => {
        setTotal(res.data.total);
        if (!append) { setTickets(res.data.tickets); setPage(1); }
        else { setTickets(prev => [...prev, ...res.data.tickets]); setPage(p); }
      })
      .catch(() => toast.error('Failed to load tickets'))
      .finally(() => { setLoading(false); setLoadingMore(false); });
  }, [statusFilter, debouncedSearch]);

  useEffect(() => { fetchPage(1, false); }, [statusFilter, debouncedSearch]);

  // Record this visit so next visit can detect new replies
  useEffect(() => {
    localStorage.setItem(LAST_SEEN_KEY, new Date().toISOString());
  }, []);

  const handleRefresh = () => fetchPage(1, false);
  const handleLoadMore = () => fetchPage(page + 1, true);

  useGlobalRefresh(handleRefresh);

  // "New activity since last visit" dot — shared by the desktop table row and
  // the mobile card so the two layouts can't drift.
  const isUnread = (t) => lastSeenRef.current
    && t.status !== 'closed'
    && new Date(t.updated_at) > new Date(lastSeenRef.current)
    && t.updated_at !== t.created_at;

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">My Tickets</h1>
          <p className="text-sm text-gray-500 mt-0.5">Track and manage your support requests</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleRefresh} className="hidden lg:inline-flex btn-secondary">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            data-testid="CustomerTickets-RaiseTicketButton"
            onClick={() => window.dispatchEvent(new CustomEvent('open-bot-widget'))}
            className="btn-primary"
          >
            <MessageCircle className="w-4 h-4" /> Raise a Ticket
          </button>
        </div>
      </div>

      {/* Filters + Search */}
      <div className="card p-4 mb-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-2 flex-wrap">
            {['', 'open', 'pending', 'closed'].map(s => (
              <button
                key={s}
                data-testid={`CustomerTickets-StatusFilter-${s || 'all'}`}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${statusFilter === s ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
              >
                {s === '' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-48 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              data-testid="CustomerTickets-SearchInput"
              type="text"
              className="input pl-9 py-1.5 text-sm w-full"
              placeholder="Search by subject..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Tickets list */}
      <div className="card overflow-hidden">
        {loading ? (
          <>
            {/* Desktop skeleton — the table layout. */}
            <table className="hidden lg:table w-full">
              <tbody><SkeletonTableRows rows={6} cols={6} /></tbody>
            </table>
            {/* Mobile skeleton — stacked card placeholders. */}
            <div className="lg:hidden p-4 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-16 rounded-lg skeleton-shimmer" />
              ))}
            </div>
          </>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-400 gap-1">
            <Ticket className="w-10 h-10 mb-2 opacity-30" />
            <p className="text-sm">No tickets yet</p>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('open-bot-widget'))}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold mt-1"
            >
              Use the assistant to raise one →
            </button>
          </div>
        ) : (
          <>
            {/* ── Desktop: table (unchanged, lg+ only) ───────────────────── */}
            <table className="hidden lg:table w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="w-1 p-0" />
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">ID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Subject</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Priority</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Agent</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Created</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {tickets.map(t => {
                  const hasUnread = isUnread(t);
                  return (
                  <tr
                    key={t.id}
                    data-testid={`CustomerTickets-Row-${t.id}`}
                    onClick={() => navigate(`/customer/tickets/${t.id}`)}
                    className="hover:bg-indigo-50/40 transition-colors cursor-pointer"
                  >
                    <td className={`p-0 w-1 ${PRIORITY_STRIPE[t.priority] || 'bg-gray-200'}`} />
                    <td className="px-4 py-3 text-sm text-gray-500 font-mono">#{t.id}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {hasUnread && (
                          <span className="w-2 h-2 rounded-full bg-indigo-500 flex-shrink-0" title="New activity since last visit" />
                        )}
                        <p className="text-sm font-medium text-gray-800 line-clamp-1">{t.subject}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3"><TicketStatusBadge status={t.status} /></td>
                    <td className="px-4 py-3"><PriorityBadge priority={t.priority} /></td>
                    <td className="px-4 py-3 text-sm text-gray-500">{t.agent_name || '—'}</td>
                    <td className="px-4 py-3 text-sm text-gray-500" title={fullDate(t.created_at)}>
                      {timeAgo(t.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronRight className="w-4 h-4 text-gray-300 inline" />
                    </td>
                  </tr>
                );
                })}
              </tbody>
            </table>

            {/* ── Mobile: stacked cards (< lg only) ──────────────────────── */}
            <ul className="lg:hidden divide-y divide-gray-100">
              {tickets.map(t => {
                const hasUnread = isUnread(t);
                return (
                  <li key={t.id}>
                    <button
                      data-testid={`CustomerTickets-Row-${t.id}`}
                      onClick={() => navigate(`/customer/tickets/${t.id}`)}
                      className="w-full text-left flex items-stretch gap-3 px-3 py-3 hover:bg-indigo-50/40 active:bg-indigo-50 transition-colors"
                    >
                      <span className={`w-1 rounded-full flex-shrink-0 ${PRIORITY_STRIPE[t.priority] || 'bg-gray-200'}`} aria-hidden="true" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-mono text-gray-400">#{t.id}</span>
                          <span className="text-xs text-gray-400" title={fullDate(t.created_at)}>{timeAgo(t.created_at)}</span>
                        </div>
                        <div className="flex items-start gap-1.5 mt-0.5">
                          {hasUnread && (
                            <span className="w-2 h-2 rounded-full bg-indigo-500 flex-shrink-0 mt-1.5" title="New activity since last visit" />
                          )}
                          <p className="text-sm font-medium text-gray-800 line-clamp-2">{t.subject}</p>
                        </div>
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          <TicketStatusBadge status={t.status} />
                          <PriorityBadge priority={t.priority} />
                          {t.agent_name && <span className="text-xs text-gray-500 truncate">· {t.agent_name}</span>}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-300 self-center flex-shrink-0" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      {/* Load more */}
      {tickets.length < total && !loading && (
        <div className="mt-4 text-center">
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="btn-secondary px-6"
          >
            {loadingMore
              ? <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin inline-block" />
              : `Load more (${total - tickets.length} remaining)`}
          </button>
        </div>
      )}
    </Layout>
  );
}
