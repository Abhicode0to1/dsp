import { useState, useRef, useCallback, useEffect } from 'react';
import { Bug, X, Paperclip, Loader2, CheckCircle2, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { submitFeedback } from '../../services/api';
import useImagePaste from '../../hooks/useImagePaste';

// Floating bug-report widget. Mounted by Layout for customer + agent + admin
// (admin can also flag issues for themselves). Behaviour:
//   - Floating bottom-right button (above the existing bot/incoming-call widgets).
//   - Click opens a modal with title, description, optional file attachments.
//   - On submit, posts multipart/form-data to /api/feedback.
//   - Auto-captures location and user agent so the admin doesn't have to ask.
export default function FeedbackWidget({ hideLauncherOnMobile = false }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // Pre-filled with window.location.href at open-time; user can edit if they
  // navigated away from the buggy page before opening the widget. Editable so
  // the captured URL reflects where the bug WAS, not just where they happened
  // to be when reporting.
  const [pageUrl, setPageUrl] = useState('');
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const fileInputRef = useRef(null);

  // Snapshot the current URL each time the dialog opens. Done in a useEffect
  // (not inline) so closing + reopening refreshes the URL to wherever the user
  // is now — and so we don't overwrite the user's hand-edited value while the
  // dialog is open.
  useEffect(() => {
    if (open) setPageUrl(prev => prev || window.location.href);
  }, [open]);

  // Allow other components (the FloatingDock) to open this modal without
  // rendering our own launcher button.
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('open-feedback-widget', handler);
    return () => window.removeEventListener('open-feedback-widget', handler);
  }, []);

  // Ctrl+V on the description box accepts clipboard screenshots — same caps as
  // the file picker (50 MB each, 5 files total).
  const onPasteImage = useCallback((file) => {
    if (file.size > 50 * 1024 * 1024) {
      toast.error(`${file.name} is over 50 MB. Trim it down and re-attach.`);
      return;
    }
    setFiles(prev => {
      if (prev.length >= 5) {
        toast.error('Max 5 attachments per report.');
        return prev;
      }
      return [...prev, file];
    });
  }, []);
  const pasteRef = useImagePaste(onPasteImage);

  const reset = () => {
    setTitle('');
    setDescription('');
    setPageUrl('');
    setFiles([]);
    setSubmitted(false);
  };

  const handleFiles = (e) => {
    const picked = Array.from(e.target.files || []);
    // Multer also enforces; we just give early feedback.
    const tooBig = picked.find(f => f.size > 50 * 1024 * 1024);
    if (tooBig) {
      toast.error(`${tooBig.name} is over 50 MB. Trim it down and re-attach.`);
      return;
    }
    if (files.length + picked.length > 5) {
      toast.error('Max 5 attachments per report.');
      return;
    }
    setFiles(prev => [...prev, ...picked]);
  };

  const removeFile = (idx) => setFiles(prev => prev.filter((_, i) => i !== idx));

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) {
      toast.error('Add a short title and what went wrong.');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('title', title.trim());
      fd.append('description', description.trim());
      // Prefer the (possibly-edited) value the user confirmed in the form,
      // fall back to current URL if they somehow cleared it.
      fd.append('page_url', (pageUrl && pageUrl.trim()) || window.location.href);
      fd.append('browser_info', `${navigator.userAgent.slice(0, 200)} · ${window.innerWidth}x${window.innerHeight}`);
      for (const f of files) fd.append('files', f);
      await submitFeedback(fd);
      setSubmitted(true);
      // Auto-close after a beat so the user sees the confirmation.
      setTimeout(() => { setOpen(false); reset(); }, 2200);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit — try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* Floating launcher. On mobile it's hidden (the FloatingDock provides the
          trigger); on desktop it stays as the original bottom-right button. */}
      <button
        data-testid="FeedbackWidget-Launcher"
        onClick={() => setOpen(true)}
        title="Report a bug or share feedback"
        className={`fixed bottom-20 right-6 z-40 w-12 h-12 rounded-full bg-amber-500 hover:bg-amber-600 text-white shadow-lg items-center justify-center transition-colors ${hideLauncherOnMobile ? 'hidden lg:flex' : 'flex'}`}
      >
        <Bug className="w-5 h-5" />
      </button>


      {open && (
        // Backdrop is decorative only — does NOT dismiss the dialog on click.
        // Agents were losing half-typed bug reports because a stray click on
        // the dimmed area closed everything and wiped the title/description
        // they'd been writing. Now the dialog only closes via the explicit
        // X button (top-right) or the Cancel button (bottom-left).
        <div data-testid="FeedbackWidget-Modal" className="fixed inset-0 z-[10000] bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg shadow-xl">
            <div className="flex items-start justify-between p-5 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center">
                  <Bug className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-gray-800">Report a bug or share feedback</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Sent to admin for review. Attach a screenshot or short video if it helps.</p>
                </div>
              </div>
              <button onClick={() => !submitting && setOpen(false)} className="text-gray-400 hover:text-gray-600 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>

            {submitted ? (
              <div className="p-8 flex flex-col items-center text-center">
                <CheckCircle2 className="w-12 h-12 text-green-500 mb-3" />
                <p className="font-semibold text-gray-800">Thanks — we got it!</p>
                <p className="text-sm text-gray-500 mt-1">Admin will review and follow up if more info is needed.</p>
              </div>
            ) : (
              <form onSubmit={submit} className="p-5 space-y-4">
                <div>
                  <label className="text-xs font-semibold text-gray-700 block mb-1">Short title</label>
                  <input
                    data-testid="FeedbackWidget-TitleInput"
                    type="text"
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    placeholder="e.g. Reply button doesn't work on ticket #42"
                    maxLength={255}
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-700 block mb-1">What went wrong? What did you expect?</label>
                  <textarea
                    data-testid="FeedbackWidget-DescriptionInput"
                    ref={pasteRef}
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Steps to reproduce, what you saw, what should've happened…  (paste a screenshot with Ctrl+V)"
                    rows={5}
                    maxLength={5000}
                    disabled={submitting}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500 resize-none"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">{description.length}/5000</p>
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-700 block mb-1">Attachments <span className="font-normal text-gray-400">(optional · screenshots or short video, up to 5 files, 50 MB each)</span></label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    onChange={handleFiles}
                    disabled={submitting}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={submitting || files.length >= 5}
                    className="text-sm text-amber-700 hover:text-amber-800 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Paperclip className="w-4 h-4" /> Add file
                  </button>
                  {files.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {files.map((f, i) => (
                        <li key={i} className="text-xs bg-gray-50 border border-gray-200 rounded px-2 py-1 flex items-center justify-between">
                          <span className="truncate">{f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB</span>
                          <button type="button" onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500 ml-2"><X className="w-3.5 h-3.5" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-semibold text-gray-700">
                      Where did this happen? <span className="font-normal text-gray-400">(URL)</span>
                    </label>
                    {pageUrl !== window.location.href && (
                      <button
                        type="button"
                        onClick={() => setPageUrl(window.location.href)}
                        disabled={submitting}
                        className="text-[11px] text-amber-700 hover:text-amber-800 inline-flex items-center gap-1"
                        title="Reset to the page you're on right now"
                      >
                        <RotateCcw className="w-3 h-3" /> Reset to current page
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={pageUrl}
                    onChange={e => setPageUrl(e.target.value)}
                    disabled={submitting}
                    placeholder={window.location.href}
                    maxLength={500}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono text-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Pre-filled with the page you're on. Edit if the bug actually happened on a different page. Your browser info is also captured automatically.
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    data-testid="FeedbackWidget-CancelButton"
                    type="button"
                    onClick={() => { setOpen(false); reset(); }}
                    disabled={submitting}
                    className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
                  >
                    Cancel
                  </button>
                  <button
                    data-testid="FeedbackWidget-SubmitButton"
                    type="submit"
                    disabled={submitting}
                    className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold rounded-lg flex items-center gap-2 disabled:opacity-60"
                  >
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    {submitting ? 'Sending…' : 'Send to admin'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
