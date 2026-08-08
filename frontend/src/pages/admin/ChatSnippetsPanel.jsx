import { useEffect, useState } from 'react';
import {
  getAdminCannedResponses, createAdminCannedResponse,
  updateAdminCannedResponse, deleteAdminCannedResponse,
} from '../../services/api';
import { MessageSquare, Plus, Pencil, Trash2, X, ChevronDown, Hash, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import VariableSuggestInput from '../../components/admin/VariableSuggestInput';
import TemplatePreviewModal from '../../components/admin/TemplatePreviewModal';

const CATEGORIES = [
  'Greeting', 'Holding', 'Verification', 'Troubleshooting',
  'Resolution', 'Escalation', 'Closing',
];

// Variables agents commonly need in a live chat reply. Typed as `{` triggers
// a popup; agents (not customers) see the rendered values when the backend
// applies the substitution at send time.
const CHAT_VARIABLES = [
  { name: 'customer_name', hint: 'Customer\'s display name' },
  { name: 'agent_name',    hint: 'Your name (the agent)' },
  { name: 'domain',        hint: 'Customer\'s domain' },
  { name: 'plan_name',     hint: 'Customer\'s current plan' },
  { name: 'ticket_id',     hint: 'Open ticket id (if any)' },
];

const EMPTY_FORM = { name: '', shortcut: '', category: '', body: '' };

function SnippetModal({ snippet, onClose, onSaved }) {
  const [form, setForm] = useState(snippet || EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.body.trim()) {
      toast.error('Name and body are required');
      return;
    }
    setSaving(true);
    try {
      if (snippet?.id) {
        await updateAdminCannedResponse(snippet.id, form);
        toast.success('Snippet updated');
      } else {
        await createAdminCannedResponse(form);
        toast.success('Snippet created');
      }
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      {/* No backdrop-click-to-close: accidental misses would lose half-typed
          snippet content. Admin closes via the X icon or the Cancel button. */}
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-800">{snippet?.id ? 'Edit Snippet' : 'New Chat Snippet'}</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Name *</label>
            <input className="input" required maxLength={120} placeholder="e.g. Domain verification — opening line"
              value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label flex items-center gap-1.5"><Hash className="w-3.5 h-3.5 text-gray-400" /> Shortcut</label>
              <input className="input" maxLength={60} placeholder="e.g. greet, wait, dkim"
                value={form.shortcut} onChange={e => setForm(f => ({ ...f, shortcut: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') }))} />
              <p className="text-[11px] text-gray-400 mt-1">Type "/" + this in chat to insert</p>
            </div>
            <div>
              <label className="label">Category</label>
              <div className="relative">
                <select className="input appearance-none pr-8"
                  value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
                  <option value="">(none)</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
              </div>
            </div>
          </div>
          <div>
            <label className="label">Snippet body *</label>
            <VariableSuggestInput
              multiline
              rows={6}
              required
              value={form.body}
              onChange={(v) => setForm(f => ({ ...f, body: v }))}
              variables={CHAT_VARIABLES}
              placeholder={'Hi {{customer_name}}, I see you\'re asking about {{domain}}. Let me check…'}
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Type <span className="font-mono bg-gray-100 px-1 rounded">{'{'}</span> to insert a variable. Available: {CHAT_VARIABLES.map(v => `{{${v.name}}}`).join(', ')}
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center">
              {saving ? '…' : (snippet?.id ? 'Save Changes' : 'Create Snippet')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ChatSnippetsPanel() {
  const [list, setList]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]   = useState(null);
  const [previewing, setPreviewing] = useState(null);

  const load = () => {
    setLoading(true);
    getAdminCannedResponses()
      .then(r => setList(r.data.responses || []))
      .catch(() => toast.error('Failed to load snippets'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id) => {
    if (!confirm('Delete this snippet? This cannot be undone — usage history will be lost.')) return;
    try {
      await deleteAdminCannedResponse(id);
      toast.success('Snippet deleted');
      load();
    } catch { toast.error('Failed to delete'); }
  };

  return (
    <>
      {modal !== null && <SnippetModal snippet={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
      {previewing && (
        <TemplatePreviewModal
          title={`Preview · ${previewing.name}`}
          body={previewing.body}
          meta={[
            previewing.shortcut ? { label: 'Shortcut', value: `/${previewing.shortcut}` } : null,
            previewing.category ? { label: 'Category', value: previewing.category } : null,
          ].filter(Boolean)}
          onClose={() => setPreviewing(null)}
        />
      )}

      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-gray-500">Short reusable replies agents insert into live chats with a slash-command or a click.</p>
        <button onClick={() => setModal(EMPTY_FORM)} className="btn-primary flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New Snippet
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-10 justify-center">
          <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          Loading…
        </div>
      ) : list.length === 0 ? (
        <div className="card p-12 text-center text-gray-400">
          <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">No snippets yet</p>
          <p className="text-xs mt-1 opacity-70">Create your first snippet to save agents time on repetitive replies.</p>
          <button onClick={() => setModal(EMPTY_FORM)} className="btn-primary mt-4 mx-auto flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Create snippet
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map(s => (
            <div key={s.id} className={`card p-4 ${s.is_active === 0 ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="text-sm font-bold text-gray-800">{s.name}</h3>
                    {s.shortcut && (
                      <span className="text-[11px] font-mono bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded">
                        /{s.shortcut}
                      </span>
                    )}
                    {s.category && (
                      <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">{s.category}</span>
                    )}
                    {s.is_active === 0 && (
                      <span className="text-[10px] uppercase tracking-wider font-bold text-gray-500 bg-gray-200 px-1.5 py-0.5 rounded">Disabled</span>
                    )}
                    <span className="ml-auto text-[11px] text-gray-400">used {s.usage_count}× this period</span>
                  </div>
                  <p className="text-sm text-gray-600 line-clamp-3 whitespace-pre-wrap">{s.body}</p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button onClick={() => setPreviewing(s)} className="p-2 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg" title="Preview with sample values"><Eye className="w-4 h-4" /></button>
                  <button onClick={() => setModal(s)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg" title="Edit"><Pencil className="w-4 h-4" /></button>
                  <button onClick={() => handleDelete(s.id)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Delete"><Trash2 className="w-4 h-4" /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
