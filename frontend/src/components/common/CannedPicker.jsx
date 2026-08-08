import { useEffect, useState, useRef } from 'react';
import { getCannedResponses, createCannedResponse, deleteCannedResponse, bumpCannedResponseUsage } from '../../services/api';
import { Zap, Search, ChevronDown, ChevronUp, Plus, Trash2, Globe, User, X, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';

function resolveVars(text, ctx) {
  if (!ctx) return text;
  return text
    .replace(/\{\{customer_name\}\}/g, ctx.customer_name || '')
    .replace(/\{\{ticket_id\}\}/g,     ctx.ticket_id ? `#${ctx.ticket_id}` : '')
    .replace(/\{\{gw_edition\}\}/g,    ctx.gw_edition || '')
    .replace(/\{\{domain\}\}/g,        ctx.domain || '')
    .replace(/\{\{agent_name\}\}/g,    ctx.agent_name || '');
}

export default function CannedPicker({ onSelect, context }) {
  const [open, setOpen] = useState(false);
  const [responses, setResponses] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newGlobal, setNewGlobal] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);

  // Read current user role to gate "share globally" toggle (admin-only)
  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem('dsp_user') || '{}'); } catch { return {}; }
  })();

  const load = () => {
    setLoading(true);
    getCannedResponses()
      .then(r => setResponses(r.data.responses || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setCreating(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = responses.filter(r =>
    r.title.toLowerCase().includes(search.toLowerCase()) ||
    r.body.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newTitle.trim() || !newBody.trim()) return;
    setSaving(true);
    try {
      await createCannedResponse({
        title: newTitle.trim(),
        body: newBody.trim(),
        is_global: newGlobal && currentUser.role === 'admin',
      });
      toast.success('Canned response saved');
      setNewTitle('');
      setNewBody('');
      setNewGlobal(false);
      setCreating(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    if (!window.confirm('Delete this canned response?')) return;
    try {
      await deleteCannedResponse(id);
      setResponses(prev => prev.filter(r => r.id !== id));
      toast.success('Deleted');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 transition-colors"
      >
        <Zap className="w-4 h-4" />
        Canned
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-96 bg-white border border-gray-200 rounded-xl shadow-xl z-50">
          {/* Header: search + new */}
          <div className="p-3 border-b border-gray-100 flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Search responses…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
            </div>
            <button
              type="button"
              onClick={() => setCreating(c => !c)}
              className={clsx(
                'flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors',
                creating ? 'bg-gray-100 text-gray-600' : 'bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200'
              )}
            >
              {creating ? <><X className="w-3 h-3" /> Cancel</> : <><Plus className="w-3 h-3" /> New</>}
            </button>
          </div>

          {/* Create form */}
          {creating && (
            <form onSubmit={handleCreate} className="p-3 border-b border-gray-100 bg-blue-50/30 space-y-2">
              <input
                type="text"
                className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                placeholder="Title (e.g. GW — DNS propagation note)"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                maxLength={255}
                required
              />
              <textarea
                className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white resize-none"
                placeholder="Body — use {{customer_name}}, {{ticket_id}}, {{domain}}, {{gw_edition}}, {{agent_name}}"
                value={newBody}
                onChange={e => setNewBody(e.target.value)}
                rows={4}
                required
              />
              <div className="flex items-center justify-between">
                {currentUser.role === 'admin' ? (
                  <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                    <input type="checkbox" checked={newGlobal} onChange={e => setNewGlobal(e.target.checked)} />
                    Share globally with all agents
                  </label>
                ) : (
                  <span className="text-[11px] text-gray-400 flex items-center gap-1">
                    <User className="w-3 h-3" /> Saved as personal (only you can use it)
                  </span>
                )}
                <button
                  type="submit"
                  disabled={saving || !newTitle.trim() || !newBody.trim()}
                  className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}

          <div className="max-h-72 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-6 text-gray-400 text-sm">Loading…</div>
            )}
            {!loading && filtered.length === 0 && !creating && (
              <div className="text-center py-6 text-gray-400 text-sm">
                {search ? 'No responses match' : 'No responses yet — click + New to create one'}
              </div>
            )}
            {!loading && filtered.map(r => {
              const isTeam = r.kind === 'team';
              const isOwn = r.created_by === currentUser.id;
              // Team snippets are admin-managed via Templates → Chat Snippets;
              // disable inline delete here so an agent doesn't accidentally
              // hit /canned/:id (different table). Admin can delete from the
              // dedicated Templates page.
              const canDelete = !isTeam && (isOwn || currentUser.role === 'admin');
              const handlePick = () => {
                onSelect(resolveVars(r.body, context));
                setOpen(false);
                setSearch('');
                if (isTeam) bumpCannedResponseUsage(r.id).catch(() => {});
              };
              return (
                <div
                  key={`${r.kind || 'legacy'}_${r.id}`}
                  onClick={handlePick}
                  className="group w-full text-left px-4 py-3 hover:bg-blue-50 transition-colors border-b border-gray-50 last:border-0 cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-0.5 gap-2">
                    <p className="text-sm font-medium text-gray-800 truncate flex-1">{r.title}</p>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {r.shortcut && (
                        <span className="text-[10px] font-mono bg-blue-50 text-blue-700 px-1 py-0.5 rounded">/{r.shortcut}</span>
                      )}
                      {isTeam ? (
                        <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-0.5"
                              title="Curated by admin in Templates → Chat Snippets">
                          <Users className="w-2.5 h-2.5" /> Team
                        </span>
                      ) : r.is_global ? (
                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-0.5">
                          <Globe className="w-2.5 h-2.5" /> Global
                        </span>
                      ) : (
                        <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-0.5">
                          <User className="w-2.5 h-2.5" /> Personal
                        </span>
                      )}
                      {canDelete && (
                        <button
                          onClick={(e) => handleDelete(r.id, e)}
                          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition-opacity"
                          title="Delete"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 line-clamp-2">{r.body}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
