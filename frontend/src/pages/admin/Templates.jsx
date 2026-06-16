import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import {
  getAdminTemplates, createAdminTemplate, updateAdminTemplate, deleteAdminTemplate,
} from '../../services/api';
import { LayoutTemplate, Plus, Pencil, Trash2, X, ChevronDown, Mail, MessageSquare, Eye } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { EmailTemplatesPanel } from './EmailTemplates';
import ChatSnippetsPanel from './ChatSnippetsPanel';
import VariableSuggestInput from '../../components/admin/VariableSuggestInput';
import TemplatePreviewModal from '../../components/admin/TemplatePreviewModal';

// Variables a ticket template author can drop into the subject + description.
// The customer's ticket-form code substitutes these when the template is picked.
const TICKET_TEMPLATE_VARIABLES = [
  { name: 'customer_name', hint: 'Logged-in customer name' },
  { name: 'domain',        hint: 'Customer\'s domain' },
  { name: 'gw_edition',    hint: 'Google Workspace edition' },
  { name: 'current_plan',  hint: 'Customer\'s current support plan' },
];

const REQUEST_TYPES = [
  'User Management', 'Domain & Setup', 'Plan Change', 'Billing',
  'Email & Migration', 'Access Issue', 'Feature Help', 'Escalation to Google',
];

const EMPTY_FORM = {
  name: '',
  subject_template: '',
  description_template: '',
  request_type: '',
};

function TemplateModal({ template, onClose, onSaved }) {
  const [form, setForm] = useState(template || EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.description_template.trim()) return;
    setSaving(true);
    try {
      if (template?.id) {
        await updateAdminTemplate(template.id, form);
        toast.success('Template updated');
      } else {
        await createAdminTemplate(form);
        toast.success('Template created');
      }
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-800">
            {template?.id ? 'Edit Template' : 'New Template'}
          </h2>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Template Name *</label>
            <input
              className="input"
              required
              maxLength={100}
              placeholder="e.g. Add Users Request"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="label">Request Type</label>
            <div className="relative">
              <select
                className="input appearance-none pr-8"
                value={form.request_type}
                onChange={e => setForm(f => ({ ...f, request_type: e.target.value }))}
              >
                <option value="">Select type (optional)…</option>
                {REQUEST_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
            </div>
          </div>
          <div>
            <label className="label">Subject Pre-fill</label>
            <VariableSuggestInput
              maxLength={500}
              placeholder="Pre-fill the subject line (optional)"
              value={form.subject_template}
              onChange={(v) => setForm(f => ({ ...f, subject_template: v }))}
              variables={TICKET_TEMPLATE_VARIABLES}
            />
          </div>
          <div>
            <label className="label">Description Template *</label>
            <VariableSuggestInput
              multiline
              rows={6}
              required
              placeholder={'Hi {{customer_name}}, regarding {{domain}}…'}
              value={form.description_template}
              onChange={(v) => setForm(f => ({ ...f, description_template: v }))}
              variables={TICKET_TEMPLATE_VARIABLES}
            />
            <p className="text-xs text-gray-400 mt-1">
              Type <span className="font-mono bg-gray-100 px-1 rounded">{'{'}</span> to insert a variable. Available: {TICKET_TEMPLATE_VARIABLES.map(v => `{{${v.name}}}`).join(', ')}
            </p>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center">
              {saving ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : (template?.id ? 'Save Changes' : 'Create Template')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Ticket templates panel — same UI as before, just lifted out so the hub
// can render it inside one of the two tabs without a duplicate Layout.
function TicketTemplatesPanel() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [modal, setModal]         = useState(null);
  const [previewing, setPreviewing] = useState(null);

  const load = () => {
    setLoading(true);
    getAdminTemplates()
      .then(r => setTemplates(r.data.templates || []))
      .catch(() => toast.error('Failed to load templates'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id) => {
    if (!confirm('Delete this template? Customers will no longer see it.')) return;
    try {
      await deleteAdminTemplate(id);
      toast.success('Template deleted');
      setTemplates(t => t.filter(x => x.id !== id));
    } catch {
      toast.error('Failed to delete');
    }
  };

  return (
    <>
      {modal !== null && (
        <TemplateModal
          template={modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
      {previewing && (
        <TemplatePreviewModal
          title={`Preview · ${previewing.name}`}
          subject={previewing.subject_template}
          body={previewing.description_template}
          meta={[
            previewing.request_type ? { label: 'Request type', value: previewing.request_type } : null,
          ].filter(Boolean)}
          onClose={() => setPreviewing(null)}
        />
      )}

      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-gray-500">Pre-fill ticket forms for common GW support requests.</p>
        <button onClick={() => setModal(EMPTY_FORM)} className="btn-primary flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New Template
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-10 justify-center">
          <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
          Loading templates…
        </div>
      ) : templates.length === 0 ? (
        <div className="card p-12 text-center text-gray-400">
          <LayoutTemplate className="w-12 h-12 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">No templates yet</p>
          <p className="text-xs mt-1 opacity-70">Create templates to help customers submit better-structured tickets</p>
          <button onClick={() => setModal(EMPTY_FORM)} className="btn-primary mt-4 mx-auto flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> Create first template
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map(t => (
            <div key={t.id} className="card p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="text-sm font-bold text-gray-800">{t.name}</h3>
                    {t.request_type && (
                      <span className="text-xs bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full font-medium">
                        {t.request_type}
                      </span>
                    )}
                  </div>
                  {t.subject_template && (
                    <p className="text-xs text-gray-500 mb-1">
                      <span className="font-medium text-gray-600">Subject:</span> {t.subject_template}
                    </p>
                  )}
                  <p className="text-sm text-gray-600 line-clamp-3 whitespace-pre-wrap">{t.description_template}</p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button
                    onClick={() => setPreviewing(t)}
                    className="p-2 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                    title="Preview with sample values"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setModal(t)}
                    className="p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(t.id)}
                    className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// Unified Templates hub — sidebar has a single "Templates" entry now, this
// page hosts both Ticket Templates and Email Templates as tabs. Default tab
// is Ticket; legacy /admin/email-templates URL routes here too and opens the
// Email tab via ?tab=email.
export default function AdminTemplates() {
  const location = useLocation();
  const navigate = useNavigate();
  // Pick initial tab from URL: ?tab=email OR the legacy /admin/email-templates path.
  const searchParams = new URLSearchParams(location.search);
  const tabFromQuery = searchParams.get('tab');
  const initialTab = ['ticket', 'email', 'snippets'].includes(tabFromQuery)
    ? tabFromQuery
    : (location.pathname.includes('email-templates') ? 'email' : 'ticket');
  const [tab, setTab] = useState(initialTab);

  const setActiveTab = (next) => {
    setTab(next);
    // Keep the URL in sync so deep-links + browser back/forward work.
    const params = new URLSearchParams(location.search);
    if (next === 'ticket') params.delete('tab');
    else params.set('tab', next);
    navigate(`/admin/templates${params.toString() ? `?${params.toString()}` : ''}`, { replace: true });
  };

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center">
            <LayoutTemplate className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Templates</h1>
            <p className="text-sm text-gray-500 mt-0.5">Ticket pre-fills and customer email wording — both in one place.</p>
          </div>
        </div>

        <div className="flex items-center gap-1 mb-5 border-b border-gray-200">
          {[
            { key: 'ticket',   label: 'Ticket Templates', icon: LayoutTemplate },
            { key: 'email',    label: 'Email Templates',  icon: Mail           },
            { key: 'snippets', label: 'Chat Snippets',    icon: MessageSquare  },
          ].map(t => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={clsx(
                  'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                  active
                    ? 'text-indigo-700 border-indigo-600'
                    : 'text-gray-500 border-transparent hover:text-gray-700'
                )}
              >
                <Icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'ticket'   && <TicketTemplatesPanel />}
        {tab === 'email'    && <EmailTemplatesPanel />}
        {tab === 'snippets' && <ChatSnippetsPanel />}
      </div>
    </Layout>
  );
}
