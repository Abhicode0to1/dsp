import { useEffect, useState, useMemo } from 'react';
import { Mail, Eye, RotateCcw, Save, Loader2, CheckCircle2, Info, Search, Users, UserCog, Shield, UserPlus } from 'lucide-react';
import clsx from 'clsx';
import VariableSuggestInput from '../../components/admin/VariableSuggestInput';
import toast from 'react-hot-toast';
import Layout from '../../components/common/Layout';
import {
  listAdminEmailTemplates,
  getAdminEmailTemplate,
  saveAdminEmailTemplate,
  resetAdminEmailTemplate,
  previewAdminEmailTemplate,
} from '../../services/api';

// Inner panel — same UI but without the <Layout> wrapper, so the unified
// Templates hub page can render it inside its own Layout + tab strip.
export function EmailTemplatesPanel() {
  const [items, setItems] = useState([]);          // sidebar list
  const [selectedKey, setSelectedKey] = useState(null);
  const [meta, setMeta] = useState(null);          // currently-loaded template metadata
  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [originalSubject, setOriginalSubject] = useState('');
  const [originalBody, setOriginalBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewHtml, setPreviewHtml] = useState(null);
  const [previewSubject, setPreviewSubject] = useState('');

  const dirty = subject !== originalSubject || bodyHtml !== originalBody;

  // Initial load — list of templates
  useEffect(() => {
    listAdminEmailTemplates()
      .then(r => {
        setItems(r.data.items || []);
        if (r.data.items?.length && !selectedKey) setSelectedKey(r.data.items[0].key);
      })
      .catch(() => toast.error('Could not load templates'));
  }, []);

  // Whenever selection changes, fetch that template
  useEffect(() => {
    if (!selectedKey) return;
    setLoading(true);
    setPreviewHtml(null);
    getAdminEmailTemplate(selectedKey)
      .then(r => {
        setMeta(r.data);
        setSubject(r.data.subject || '');
        setBodyHtml(r.data.body_html || '');
        setOriginalSubject(r.data.subject || '');
        setOriginalBody(r.data.body_html || '');
      })
      .catch(() => toast.error('Could not load template'))
      .finally(() => setLoading(false));
  }, [selectedKey]);

  const handleSave = async () => {
    if (!selectedKey) return;
    if (!subject.trim() || !bodyHtml.trim()) {
      toast.error('Subject and body cannot be empty');
      return;
    }
    setSaving(true);
    try {
      await saveAdminEmailTemplate(selectedKey, { subject, body_html: bodyHtml });
      toast.success('Template saved — new emails will use this version');
      setOriginalSubject(subject);
      setOriginalBody(bodyHtml);
      // Refresh the sidebar so the "customised" pill appears
      const r = await listAdminEmailTemplates();
      setItems(r.data.items || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!selectedKey) return;
    if (!window.confirm('Reset this template to the system default? Any customisations will be lost.')) return;
    setSaving(true);
    try {
      await resetAdminEmailTemplate(selectedKey);
      toast.success('Template reset — using system default');
      // Re-fetch to get the defaults back into the editor
      const r = await getAdminEmailTemplate(selectedKey);
      setMeta(r.data);
      setSubject(r.data.subject || '');
      setBodyHtml(r.data.body_html || '');
      setOriginalSubject(r.data.subject || '');
      setOriginalBody(r.data.body_html || '');
      const list = await listAdminEmailTemplates();
      setItems(list.data.items || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reset');
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    if (!selectedKey) return;
    try {
      const r = await previewAdminEmailTemplate(selectedKey, { subject, body_html: bodyHtml });
      setPreviewSubject(r.data.subject || '');
      setPreviewHtml(r.data.body_html || '');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not render preview');
    }
  };

  const insertVar = (name) => {
    setBodyHtml(prev => prev + `{{${name}}}`);
  };

  // Search filter — narrows the sidebar list by label / audience / category
  // when admin is hunting for a specific template among the ~13 in the list.
  const [searchQ, setSearchQ] = useState('');
  const filteredItems = items.filter(i => {
    if (!searchQ.trim()) return true;
    const q = searchQ.trim().toLowerCase();
    return i.label.toLowerCase().includes(q)
        || (i.audience || '').toLowerCase().includes(q)
        || (i.category || '').toLowerCase().includes(q)
        || i.key.toLowerCase().includes(q);
  });
  // Group by category so the sidebar reads as sections (Account, Ticket, ...)
  // rather than one flat list of 13 items.
  const grouped = filteredItems.reduce((acc, item) => {
    const cat = item.category || 'Other';
    (acc[cat] = acc[cat] || []).push(item);
    return acc;
  }, {});
  const CATEGORY_ORDER = ['Account', 'Ticket', 'Chat & Call', 'Team', 'Operations', 'Other'];
  const categories = Object.keys(grouped).sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));

  // Colored audience badges. Each audience has a consistent dot + label.
  const AUDIENCE_STYLE = {
    'Customer':     { bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200',    icon: Users    },
    'Agent':        { bg: 'bg-indigo-50',  text: 'text-indigo-700',  border: 'border-indigo-200',  icon: UserCog  },
    'Admin':        { bg: 'bg-red-50',     text: 'text-red-700',     border: 'border-red-200',     icon: Shield   },
    'CC Recipient': { bg: 'bg-gray-100',   text: 'text-gray-600',    border: 'border-gray-200',    icon: UserPlus },
  };
  const AudienceBadge = ({ audience }) => {
    const s = AUDIENCE_STYLE[audience] || AUDIENCE_STYLE['Customer'];
    const Icon = s.icon;
    return (
      <span className={clsx('inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border', s.bg, s.text, s.border)}>
        <Icon className="w-2.5 h-2.5" /> {audience}
      </span>
    );
  };

  return (
    <div className="space-y-5">
        <div>
          <p className="text-sm text-gray-500">
            Customise the wording of every email the system sends — customer onboarding, ticket replies, agent welcome, SLA alerts. Changes apply to new emails sent from this point on. Click any template to edit its subject + HTML body.
          </p>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Left: template list, grouped by category */}
          <aside className="col-span-12 md:col-span-3">
            <div className="card p-0 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                <Search className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                <input
                  value={searchQ}
                  onChange={e => setSearchQ(e.target.value)}
                  placeholder="Search templates…"
                  className="flex-1 text-xs outline-none bg-transparent"
                />
                {searchQ && (
                  <button onClick={() => setSearchQ('')} className="text-[10px] text-gray-400 hover:text-gray-700">clear</button>
                )}
              </div>
              {items.length === 0 && (
                <p className="text-xs text-gray-400 px-3 py-4 text-center">Loading…</p>
              )}
              {filteredItems.length === 0 && items.length > 0 && (
                <p className="text-xs text-gray-400 px-3 py-4 text-center">No matches</p>
              )}
              <div className="max-h-[70vh] overflow-y-auto">
                {categories.map(cat => (
                  <div key={cat}>
                    <p className="text-[10px] uppercase font-bold tracking-wider text-gray-400 px-3 pt-3 pb-1 bg-gray-50/50 border-y border-gray-100">{cat}</p>
                    <ul className="py-1">
                      {grouped[cat].map(item => {
                        const active = item.key === selectedKey;
                        return (
                          <li key={item.key}>
                            <button
                              onClick={() => setSelectedKey(item.key)}
                              className={clsx(
                                'w-full text-left px-3 py-2 text-sm transition-colors',
                                active ? 'bg-indigo-50 border-l-2 border-indigo-600' : 'hover:bg-gray-50 border-l-2 border-transparent'
                              )}
                            >
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className={clsx('truncate', active ? 'text-indigo-700 font-semibold' : 'text-gray-700')}>{item.label}</span>
                                {item.customized && (
                                  <span title="Custom version saved" className="flex-shrink-0">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                                  </span>
                                )}
                              </div>
                              <AudienceBadge audience={item.audience} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </aside>

          {/* Right: editor + sidebar */}
          <section className="col-span-12 md:col-span-9">
            {loading ? (
              <div className="card p-8 flex items-center justify-center text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : meta ? (
              <div className="grid grid-cols-12 gap-4">
                {/* Editor */}
                <div className="col-span-12 lg:col-span-9 space-y-4">
                  <div className="card p-5">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h2 className="text-lg font-bold text-gray-800">{meta.label}</h2>
                          <AudienceBadge audience={meta.audience} />
                          {meta.category && (
                            <span className="text-[10px] uppercase font-bold tracking-wider text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{meta.category}</span>
                          )}
                        </div>
                        <p className="text-sm text-gray-500">{meta.description}</p>
                      </div>
                      {meta.customized ? (
                        <span className="text-xs px-2 py-1 bg-green-50 text-green-700 rounded-full border border-green-200 font-medium flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Customised
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-1 bg-gray-50 text-gray-500 rounded-full border border-gray-200">
                          Using default
                        </span>
                      )}
                    </div>

                    <div className="space-y-3">
                      <div>
                        <label className="label">Subject line</label>
                        <VariableSuggestInput
                          value={subject}
                          onChange={(v) => setSubject(v)}
                          variables={meta.variables || []}
                          placeholder="e.g. Your ticket has been received"
                          maxLength={500}
                        />
                      </div>
                      <div>
                        <label className="label flex items-center justify-between">
                          <span>Email body (HTML)</span>
                          <span className="text-xs font-normal text-gray-400">{bodyHtml.length.toLocaleString()} chars · type {'{'} for placeholder picker</span>
                        </label>
                        <VariableSuggestInput
                          multiline
                          rows={20}
                          value={bodyHtml}
                          onChange={(v) => setBodyHtml(v)}
                          variables={meta.variables || []}
                          placeholder="HTML body — type { to insert {{placeholder}} values"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 mt-5">
                      <button
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        className="btn-primary"
                      >
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Save
                      </button>
                      <button
                        onClick={handlePreview}
                        disabled={saving}
                        className="btn-secondary"
                      >
                        <Eye className="w-4 h-4" />
                        Preview
                      </button>
                      <button
                        onClick={handleReset}
                        disabled={saving || !meta.customized}
                        className="btn-secondary"
                        title={meta.customized ? 'Remove customisation and use the system default' : 'Already using default'}
                      >
                        <RotateCcw className="w-4 h-4" />
                        Reset to default
                      </button>
                      {dirty && (
                        <span className="text-xs text-amber-600 ml-auto">Unsaved changes</span>
                      )}
                    </div>
                  </div>

                  {/* Preview pane (appears when admin clicks Preview) */}
                  {previewHtml !== null && (
                    <div className="card p-5">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-gray-700">Preview (with sample data)</h3>
                        <button onClick={() => setPreviewHtml(null)} className="text-xs text-gray-400 hover:text-gray-600">Close</button>
                      </div>
                      <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 text-xs">
                          <span className="text-gray-400">Subject: </span>
                          <span className="font-medium text-gray-700">{previewSubject}</span>
                        </div>
                        <div className="p-4 bg-white">
                          <iframe
                            title="Email preview"
                            srcDoc={previewHtml}
                            sandbox=""
                            className="w-full min-h-[400px] border-0"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Placeholders sidebar — now with proper descriptions for each
                    variable, mono-font names, and a callout tip about the body
                    textarea's `{` autocomplete shortcut. */}
                <aside className="col-span-12 lg:col-span-3">
                  <div className="card p-0 sticky top-4 overflow-hidden">
                    <div className="px-4 py-3 border-b border-gray-100 bg-indigo-50/40">
                      <p className="text-xs font-bold text-indigo-900 flex items-center gap-1.5">
                        <Info className="w-3.5 h-3.5" />
                        Available placeholders
                      </p>
                      <p className="text-[11px] text-indigo-700/80 mt-1 leading-snug">
                        Click any chip to insert at end of body. <strong>Inside the body</strong>, type <code className="bg-white border border-indigo-200 px-1 rounded font-mono">{'{'}</code> for an autocomplete picker. For the subject line, type or paste <code className="bg-white border border-indigo-200 px-1 rounded font-mono">{'{{name}}'}</code> manually.
                      </p>
                    </div>
                    <div className="p-3 space-y-1.5">
                      {(meta.variables || []).map(v => {
                        // Backend may send variables as either bare strings (legacy)
                        // or {name, hint} objects (new). Handle both for safety.
                        const name = typeof v === 'string' ? v : v.name;
                        const hint = typeof v === 'string' ? '' : (v.hint || '');
                        return (
                          <button
                            key={name}
                            onClick={() => insertVar(name)}
                            className="w-full text-left px-2.5 py-2 rounded-lg bg-gray-50 hover:bg-emerald-50 border border-gray-200 hover:border-emerald-300 transition-colors group min-w-0"
                            title={`Insert {{${name}}} at end of body`}
                          >
                            {/* break-all + min-w-0 prevents long names like
                                {{onboardingTicketId}} from overflowing the narrow
                                sidebar column. text-[11px] is a hair smaller than
                                text-xs to fit more without wrapping for short names. */}
                            <div className="font-mono text-[11px] font-semibold text-indigo-700 group-hover:text-emerald-700 mb-0.5 break-all leading-tight">
                              {`{{${name}}}`}
                            </div>
                            {hint && (
                              <p className="text-[10px] text-gray-500 leading-tight line-clamp-2 break-words">{hint}</p>
                            )}
                          </button>
                        );
                      })}
                      {(!meta.variables || meta.variables.length === 0) && (
                        <p className="text-[11px] text-gray-400 italic px-2 py-3">No placeholders for this template.</p>
                      )}
                    </div>
                    {meta.updated_at && (
                      <p className="text-[10px] text-gray-400 px-4 py-2 border-t border-gray-100 bg-gray-50/50">
                        Last saved: {new Date(meta.updated_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </p>
                    )}
                  </div>
                </aside>
              </div>
            ) : (
              <div className="card p-8 text-center text-gray-400 text-sm">Select a template from the left</div>
            )}
          </section>
        </div>
      </div>
  );
}

// Standalone page kept for backwards compatibility with the old
// /admin/email-templates route. The route now redirects to /admin/templates,
// but if anything still renders this directly, it still works.
export default function AdminEmailTemplates() {
  return (
    <Layout>
      <div>
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2 mb-4">
          <Mail className="w-6 h-6 text-indigo-500" />
          Email Templates
        </h1>
        <EmailTemplatesPanel />
      </div>
    </Layout>
  );
}
