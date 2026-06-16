import { useEffect, useState } from 'react';
import { Lock, Trash2 } from 'lucide-react';
import { getInternalNotes, addInternalNote, deleteInternalNote } from '../../services/api';
import { timeAgo } from '../../utils/timeAgo';
import toast from 'react-hot-toast';

export default function InternalNotesTab({ ticketId }) {
  const [notes, setNotes]   = useState([]);
  const [input, setInput]   = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    getInternalNotes(ticketId).then(r => setNotes(r.data.notes)).catch(() => {}).finally(() => setLoading(false));
  }, [ticketId]);

  const submit = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setSaving(true);
    try {
      const res = await addInternalNote(ticketId, { note: input });
      setNotes(n => [...n, res.data.note]);
      setInput('');
    } catch { toast.error('Failed to add note'); }
    finally { setSaving(false); }
  };

  const del = async (noteId) => {
    try {
      await deleteInternalNote(ticketId, noteId);
      setNotes(n => n.filter(x => x.id !== noteId));
      toast.success('Note deleted');
    } catch { toast.error('Failed to delete note'); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loading ? <div className="text-xs text-gray-400 text-center py-8">Loading…</div> : null}
        {!loading && notes.length === 0 && (
          <div className="text-center text-gray-400 py-8">
            <Lock className="w-8 h-8 mx-auto mb-2 opacity-20" />
            <p className="text-xs">No internal notes yet</p>
          </div>
        )}
        {notes.map(n => (
          <div key={n.id} className="group bg-amber-50 border border-amber-200 rounded-xl p-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm text-gray-800 flex-1 whitespace-pre-wrap">{n.note}</p>
              <button onClick={() => del(n.id)} className="hidden group-hover:flex text-red-400 hover:text-red-600 flex-shrink-0">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-xs text-amber-600 mt-1">{n.agent_name} · {timeAgo(n.created_at)}</p>
          </div>
        ))}
      </div>
      <form onSubmit={submit} className="border-t border-gray-100 p-3 bg-white flex gap-2">
        <textarea
          className="input flex-1 text-sm resize-y"
          style={{ minHeight: '60px', maxHeight: '40vh' }}
          rows={3}
          placeholder="Add a private note…"
          value={input}
          onChange={e => setInput(e.target.value)}
        />
        <button type="submit" disabled={saving || !input.trim()} className="btn-primary px-3 flex items-center gap-1 self-end">
          <Lock className="w-3.5 h-3.5" /> {saving ? '…' : 'Note'}
        </button>
      </form>
    </div>
  );
}
