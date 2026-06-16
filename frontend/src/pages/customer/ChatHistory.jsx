import { useEffect, useState } from 'react';
import Layout from '../../components/common/Layout';
import { getChatHistory, rateChat } from '../../services/api';
import { MessageSquare, Star, RefreshCw, Clock, UserCircle2 } from 'lucide-react';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import toast from 'react-hot-toast';

function duration(created, closed) {
  if (!created || !closed) return null;
  const mins = Math.round((new Date(closed) - new Date(created)) / 60000);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function StarRow({ count, filled }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <Star key={s} className={`w-3.5 h-3.5 ${s <= count ? 'text-amber-400 fill-amber-400' : 'text-gray-200'}`} />
      ))}
    </div>
  );
}

function RatingModal({ chatId, onClose, onSaved }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover]   = useState(0);
  const [comment, setComment] = useState('');
  const [saving, setSaving]   = useState(false);

  const save = async () => {
    if (!rating) { toast.error('Please select a rating'); return; }
    setSaving(true);
    try {
      await rateChat(chatId, { rating, comment: comment.trim() || undefined });
      toast.success('Rating saved — thank you!');
      onSaved(rating);
      onClose();
    } catch {
      toast.error('Failed to save rating');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <h3 className="text-base font-bold text-gray-800 mb-1">Rate your chat session</h3>
        <p className="text-sm text-gray-500 mb-5">How satisfied were you with the support you received?</p>
        <div className="flex justify-center gap-2 mb-5">
          {[1, 2, 3, 4, 5].map(s => (
            <button key={s} onMouseEnter={() => setHover(s)} onMouseLeave={() => setHover(0)} onClick={() => setRating(s)}>
              <Star className={`w-9 h-9 transition-colors ${s <= (hover || rating) ? 'text-amber-400 fill-amber-400' : 'text-gray-200 hover:text-amber-200'}`} />
            </button>
          ))}
        </div>
        <textarea
          className="input text-sm resize-none"
          rows={2}
          placeholder="Optional comment about your experience..."
          value={comment}
          onChange={e => setComment(e.target.value)}
        />
        <div className="flex gap-2 mt-4">
          <button onClick={onClose} className="btn-secondary flex-1">Cancel</button>
          <button onClick={save} disabled={saving || !rating} className="btn-primary flex-1 justify-center">
            {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Submit Rating'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CustomerChatHistory() {
  const [chats, setChats]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [ratingFor, setRatingFor] = useState(null);

  const load = () => {
    setLoading(true);
    getChatHistory()
      .then(r => setChats(r.data.chats))
      .catch(() => toast.error('Failed to load chat history'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useGlobalRefresh(load);

  return (
    <Layout>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Chat History</h1>
          <p className="text-sm text-gray-500 mt-0.5">Your past support chat sessions</p>
        </div>
        <button onClick={load} className="hidden lg:inline-flex btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : chats.length === 0 ? (
        <div className="card p-12 flex flex-col items-center text-gray-400">
          <MessageSquare className="w-10 h-10 mb-3 opacity-20" />
          <p className="text-sm font-medium">No chat history yet</p>
          <p className="text-xs mt-1 text-center max-w-xs">Your completed live chat sessions will appear here once you've had a conversation with our team.</p>
        </div>
      ) : (
        <div className="space-y-3 max-w-2xl">
          {chats.map(c => {
            const dur = duration(c.created_at, c.closed_at);
            return (
              <div key={c.id} className="card p-4">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                    <UserCircle2 className="w-5 h-5 text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <p className="text-sm font-semibold text-gray-800">
                        {c.agent_name ? `Chat with ${c.agent_name}` : 'Support Chat'}
                      </p>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium capitalize flex-shrink-0 ${c.status === 'closed' ? 'bg-gray-100 text-gray-500' : 'bg-yellow-100 text-yellow-700'}`}>
                        {c.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-gray-400 mb-2">
                      <span>{new Date(c.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      {dur && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />{dur}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between">
                      {c.rating
                        ? <StarRow count={c.rating} />
                        : <span className="text-xs text-gray-400 italic">Not rated</span>
                      }
                      {c.status === 'closed' && !c.rating && (
                        <button
                          onClick={() => setRatingFor(c.id)}
                          className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold"
                        >
                          Rate session →
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {ratingFor && (
        <RatingModal
          chatId={ratingFor}
          onClose={() => setRatingFor(null)}
          onSaved={(rating) => {
            setChats(prev => prev.map(c => c.id === ratingFor ? { ...c, rating } : c));
            setRatingFor(null);
          }}
        />
      )}
    </Layout>
  );
}
