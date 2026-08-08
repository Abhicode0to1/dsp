import { useState } from 'react';
import Layout from '../../components/common/Layout';
import { aiKbSearch } from '../../services/api';
import { BookOpen, Search, ExternalLink, Youtube, Loader2, Lightbulb, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';

export default function KnowledgeBase() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [searchError, setSearchError] = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setResult(null);
    setSearchError('');
    try {
      const res = await aiKbSearch({ query });
      setResult(res.data);
    } catch (err) {
      const msg = err.response?.data?.error || 'Search failed. Please try again.';
      setSearchError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
            <BookOpen className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">AI Knowledge Base</h1>
            <p className="text-sm text-gray-500">Describe your issue and get instant documentation and tutorials</p>
          </div>
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="card p-5 mb-6">
          <label className="label mb-2">What do you need help with?</label>
          <div className="flex gap-3">
            <input
              type="text"
              className="input flex-1"
              placeholder="e.g. How to configure email forwarding, reset 2FA, export data..."
              value={query}
              onChange={e => setQuery(e.target.value)}
              required
            />
            <button type="submit" disabled={loading} className="btn-primary flex-shrink-0">
              {loading
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : <><Search className="w-4 h-4" /> Search</>}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-2">
            Powered by Claude AI — returns real documentation links and YouTube tutorials
          </p>
        </form>

        {/* Error state */}
        {searchError && !loading && (
          <div className="card p-5 flex items-start gap-3 border-red-200 bg-red-50">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-red-700">Search failed</p>
              <p className="text-sm text-red-600 mt-0.5">{searchError}</p>
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="card p-10 flex flex-col items-center gap-3 text-gray-500">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            <p className="text-sm">Finding the best resources for you...</p>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-5">
            {/* Articles */}
            {result.articles?.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Lightbulb className="w-4 h-4 text-amber-500" />
                  <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Documentation & Articles</h2>
                </div>
                <div className="space-y-3">
                  {result.articles.map((article, i) => (
                    <div key={i} className="card p-4 hover:shadow-md transition-shadow">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-gray-800 text-sm">{article.title}</h3>
                          {article.source && (
                            <span className="text-xs text-blue-600 font-medium">{article.source}</span>
                          )}
                          <p className="text-sm text-gray-600 mt-1.5 leading-relaxed">{article.solution}</p>
                        </div>
                        {article.url && (
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex-shrink-0 flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium border border-blue-200 rounded-md px-2 py-1 hover:bg-blue-50 transition-colors"
                          >
                            <ExternalLink className="w-3 h-3" />
                            Open
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Videos */}
            {result.videos?.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Youtube className="w-4 h-4 text-red-500" />
                  <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Video Tutorials</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {result.videos.map((video, i) => (
                    <a
                      key={i}
                      href={video.searchUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="card p-4 hover:shadow-md transition-shadow flex items-start gap-3 group"
                    >
                      <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0 group-hover:bg-red-100 transition-colors">
                        <Youtube className="w-5 h-5 text-red-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 group-hover:text-blue-700 transition-colors line-clamp-2">{video.title}</p>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">{video.query}</p>
                      </div>
                      <ExternalLink className="w-3.5 h-3.5 text-gray-400 flex-shrink-0 mt-0.5 group-hover:text-blue-500" />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {result.articles?.length === 0 && result.videos?.length === 0 && (
              <div className="card p-10 text-center text-gray-400">
                <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
                <p>No results found. Try rephrasing your question.</p>
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && (
          <div className="card p-10 text-center text-gray-400">
            <BookOpen className="w-12 h-12 mx-auto mb-4 opacity-30" />
            <p className="text-sm">Search for any topic to find documentation, guides, and video tutorials.</p>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              {['Email configuration', 'Reset password', 'API integration', 'Billing issues'].map(s => (
                <button key={s} onClick={() => setQuery(s)} className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-blue-50 hover:text-blue-700 rounded-full transition-colors">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
