import { useEffect, useState } from 'react';
import Layout from '../../components/common/Layout';
import { getMyPerformance } from '../../services/api';
import { Star } from 'lucide-react';
import { SkeletonCards } from '../../components/common/Skeleton';
import clsx from 'clsx';

function StarDisplay({ value }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <Star
          key={s}
          className={clsx('w-4 h-4', s <= Math.round(value || 0) ? 'text-amber-400 fill-amber-400' : 'text-gray-200 fill-gray-200')}
        />
      ))}
    </div>
  );
}

export default function AgentPerformance() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMyPerformance()
      .then(r => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const maxDist = data ? Math.max(...Object.values(data.dist), 1) : 1;

  return (
    <Layout>
      <div className="max-w-3xl mx-auto py-8 px-4 space-y-6">
        <h1 className="text-xl font-bold text-gray-800">My Performance</h1>

        {loading ? (
          <SkeletonCards count={4} />
        ) : !data ? (
          <p className="text-sm text-gray-400">Failed to load performance data.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">CSAT Score</p>
                {data.combined_avg ? (
                  <>
                    <p className="text-2xl font-bold text-amber-600">{data.combined_avg}</p>
                    <div className="mt-1 flex justify-center"><StarDisplay value={data.combined_avg} /></div>
                  </>
                ) : (
                  <p className="text-sm text-gray-400 mt-2">No ratings yet</p>
                )}
              </div>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">Total Ratings</p>
                <p className="text-2xl font-bold text-gray-800">{data.total_ratings}</p>
              </div>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">Closed This Month</p>
                <p className="text-2xl font-bold text-green-600">{data.tickets_closed_this_month}</p>
              </div>
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-center">
                <p className="text-xs text-gray-500 mb-1">Open Tickets</p>
                <p className="text-2xl font-bold text-blue-600">{data.open_tickets}</p>
              </div>
            </div>

            {data.total_ratings > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-4">Rating Distribution</h2>
                <div className="space-y-2">
                  {[5, 4, 3, 2, 1].map(s => (
                    <div key={s} className="flex items-center gap-3">
                      <div className="flex items-center gap-1 w-12 flex-shrink-0">
                        <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                        <span className="text-xs text-gray-600">{s}</span>
                      </div>
                      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-amber-400 rounded-full transition-all"
                          style={{ width: `${Math.round((data.dist[s] / maxDist) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-400 w-6 text-right">{data.dist[s]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.recent_comments?.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-4">Recent Feedback</h2>
                <div className="space-y-3">
                  {data.recent_comments.map((c, i) => (
                    <div
                      key={i}
                      className={clsx(
                        'p-3 rounded-lg border text-sm',
                        c.score >= 4 ? 'bg-green-50 border-green-200' :
                        c.score <= 2 ? 'bg-red-50 border-red-200' :
                        'bg-gray-50 border-gray-200'
                      )}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <StarDisplay value={c.score} />
                        <span className="text-xs text-gray-400 capitalize">{c.type}</span>
                        <span className="text-xs text-gray-400 ml-auto">
                          {new Date(c.created_at).toLocaleDateString('en-IN')}
                        </span>
                      </div>
                      <p className="text-gray-700 text-xs leading-relaxed">{c.comment}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
