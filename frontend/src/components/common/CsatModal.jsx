import { useState } from 'react';
import { submitRating, markGmbClicked } from '../../services/api';
import { Star, X, ExternalLink, ThumbsUp } from 'lucide-react';
import toast from 'react-hot-toast';

export default function CsatModal({ refType, refId, gmbUrl, onClose }) {
  const [score, setScore] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [ratingId, setRatingId] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!score) return;
    setLoading(true);
    try {
      const res = await submitRating({ ref_type: refType, ref_id: refId, score, comment });
      setRatingId(res.data.id);
      setSubmitted(true);
      toast.success('Thank you for your feedback!');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit rating');
    } finally {
      setLoading(false);
    }
  };

  const handleGmbClick = async () => {
    if (ratingId) {
      try { await markGmbClicked(ratingId); } catch {}
    }
    window.open(gmbUrl, '_blank', 'noreferrer');
  };

  const labels = ['', 'Very Poor', 'Poor', 'Okay', 'Good', 'Excellent'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {!submitted ? (
          <div className="p-6">
            <div className="text-center mb-5">
              <div className="w-12 h-12 bg-amber-50 rounded-xl flex items-center justify-center mx-auto mb-3">
                <Star className="w-6 h-6 text-amber-500" />
              </div>
              <h2 className="text-lg font-bold text-gray-800">Rate Your Experience</h2>
              <p className="text-sm text-gray-500 mt-1">How did we do? Your feedback helps us improve.</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Star rating */}
              <div className="flex items-center justify-center gap-2 py-2">
                {[1, 2, 3, 4, 5].map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScore(s)}
                    onMouseEnter={() => setHover(s)}
                    onMouseLeave={() => setHover(0)}
                    className="w-12 h-12 flex items-center justify-center"
                  >
                    <span className={`inline-flex transition-transform duration-150 ${s <= (hover || score) ? 'scale-125' : 'scale-100'}`}>
                      <Star
                        className={`w-9 h-9 transition-colors ${
                          s <= (hover || score)
                            ? 'fill-amber-400 text-amber-400'
                            : 'text-gray-200'
                        }`}
                      />
                    </span>
                  </button>
                ))}
              </div>
              {(hover || score) > 0 && (
                <p className="text-center text-sm font-medium text-amber-600 -mt-2">
                  {labels[hover || score]}
                </p>
              )}

              <div>
                <label className="label">Comment <span className="text-gray-400 font-normal">(optional)</span></label>
                <textarea
                  className="input resize-none"
                  rows={3}
                  placeholder="Tell us about your experience..."
                  value={comment}
                  onChange={e => setComment(e.target.value)}
                />
              </div>

              <button
                type="submit"
                disabled={!score || loading}
                className="btn-primary w-full justify-center py-2.5"
              >
                {loading
                  ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  : 'Submit Rating'}
              </button>
            </form>
          </div>
        ) : (
          <div className="p-6 text-center">
            <div className="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <ThumbsUp className="w-7 h-7 text-green-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-800">Thank you!</h2>
            <p className="text-sm text-gray-500 mt-1 mb-5">Your feedback has been recorded.</p>

            {score >= 4 && gmbUrl && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
                <p className="text-sm font-semibold text-amber-800 mb-2">
                  Enjoying our service?
                </p>
                <p className="text-xs text-amber-700 mb-3">
                  A Google review goes a long way — it only takes 30 seconds!
                </p>
                <button
                  onClick={handleGmbClick}
                  className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Leave a Google Review
                </button>
              </div>
            )}

            <button onClick={onClose} className="btn-secondary w-full justify-center">
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
