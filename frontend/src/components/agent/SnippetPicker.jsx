import { useEffect, useRef, useState } from 'react';
import { Zap, Search, X } from 'lucide-react';
import clsx from 'clsx';
import { getAgentCannedResponses, bumpCannedResponseUsage } from '../../services/api';

// Small popover that lists the active canned chat snippets and lets the
// agent click one to insert its body into the composer. Calls onInsert with
// the snippet body; the parent owns the textarea state. Also bumps usage
// count on the backend so admins can see which snippets actually get use.
//
// Triggered by clicking the lightning icon next to the textarea OR by typing
// `/` at the start of an empty message (handled by parent — when parent sees
// a leading `/<word>` it can show a filtered version via `forceFilter`).
export default function SnippetPicker({ onInsert, forceFilter = null }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [snippets, setSnippets] = useState([]);
  const [q, setQ] = useState('');
  const wrapRef = useRef(null);

  // Lazy-load on first open. The list is small; no point re-fetching every
  // open, but keep it cheap.
  const loadOnce = async () => {
    if (snippets.length) return;
    setLoading(true);
    try {
      const r = await getAgentCannedResponses();
      setSnippets(r.data.responses || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    if (open) loadOnce();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // External slash-command driver — when parent sees `/word` it sets the
  // forceFilter prop, which auto-opens us with that filter.
  useEffect(() => {
    if (forceFilter != null) {
      setOpen(true);
      setQ(forceFilter);
      loadOnce();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceFilter]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = snippets.filter(s => {
    if (!q) return true;
    const needle = q.toLowerCase();
    return s.name.toLowerCase().includes(needle)
        || (s.shortcut || '').toLowerCase().includes(needle)
        || (s.category || '').toLowerCase().includes(needle)
        || s.body.toLowerCase().includes(needle);
  });

  const handlePick = (s) => {
    onInsert(s.body);
    setOpen(false);
    setQ('');
    bumpCannedResponseUsage(s.id).catch(() => {});
  };

  return (
    <div ref={wrapRef} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Insert a chat snippet"
        className={clsx(
          'transition-colors',
          open ? 'text-indigo-600' : 'text-gray-400 hover:text-indigo-600'
        )}
      >
        <Zap className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 w-80 max-h-96 bg-white rounded-xl shadow-xl border border-gray-200 overflow-hidden z-30 flex flex-col">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search snippets…"
              className="flex-1 text-sm outline-none bg-transparent"
            />
            <button type="button" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-700">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-xs text-gray-400">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-center text-xs text-gray-400">
                {snippets.length === 0 ? 'No snippets yet — ask admin to add some.' : 'No matches'}
              </div>
            ) : (
              filtered.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handlePick(s)}
                  className="w-full text-left px-3 py-2 hover:bg-indigo-50 border-b border-gray-50 last:border-b-0 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-sm font-semibold text-gray-800 truncate">{s.name}</span>
                    {s.shortcut && (
                      <span className="text-[10px] font-mono bg-indigo-50 text-indigo-700 px-1 py-0.5 rounded">/{s.shortcut}</span>
                    )}
                    {s.category && (
                      <span className="text-[10px] text-gray-500">· {s.category}</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-2 whitespace-pre-wrap">{s.body}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
