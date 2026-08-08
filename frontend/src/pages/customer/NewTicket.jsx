import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { createTicket, botSuggest, getTicketTemplates, getMyTickets } from '../../services/api';
import { Ticket, Lightbulb, ArrowLeft, Send, AlertTriangle, X, ChevronRight, LayoutTemplate, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';

const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DRAFT_KEY  = 'dsp_new_ticket_draft';

const REQUEST_TYPES = [
  'User Management',
  'Domain & Setup',
  'Plan Change',
  'Billing',
  'Email & Migration',
  'Access Issue',
  'Feature Help',
  'Escalation to Google',
];

const GW_EDITIONS = [
  'Business Starter',
  'Business Standard',
  'Business Plus',
  'Enterprise',
  'Frontline',
  'Nonprofits',
];

export default function CustomerNewTicket() {
  const navigate = useNavigate();
  const [step, setStep]             = useState('template'); // 'template' | 'form'
  const [templates, setTemplates]   = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [form, setForm] = useState(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      return saved ? JSON.parse(saved) : { subject: '', description: '', request_type: '', gw_edition: '', affected_users: '' };
    } catch { return { subject: '', description: '', request_type: '', gw_edition: '', affected_users: '' }; }
  });
  const [ccInput, setCcInput]       = useState('');
  const [ccEmails, setCcEmails]     = useState([]);
  const [ccError, setCcError]       = useState('');
  const [recentTickets, setRecentTickets] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [fetchingSuggestions, setFetchingSuggestions] = useState(false);
  const debounceTimer               = useRef(null);
  const subjectRef                  = useRef(form.subject);

  useEffect(() => {
    getTicketTemplates()
      .then(r => setTemplates(r.data.templates || []))
      .catch(() => {})
      .finally(() => setTemplatesLoading(false));
    getMyTickets({ limit: 3, page: 1 })
      .then(r => setRecentTickets(r.data.tickets?.slice(0, 3) || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (form.subject || form.description) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(form));
    }
  }, [form]);

  const applyTemplate = (tpl) => {
    setForm(f => ({
      ...f,
      subject:      tpl.subject_template || f.subject,
      description:  tpl.description_template,
      request_type: tpl.request_type || f.request_type,
    }));
    setStep('form');
  };

  const handleDescChange = (val) => {
    setForm(f => ({ ...f, description: val }));
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(async () => {
      if (val.length > 10) {
        setFetchingSuggestions(true);
        try {
          // Use ref for subject to avoid stale closure inside setTimeout
          const res = await botSuggest({ message: `${subjectRef.current} ${val}` });
          setSuggestions(res.data.suggestions || []);
        } catch {}
        finally { setFetchingSuggestions(false); }
      }
    }, 600);
  };

  const addCcEmail = (raw) => {
    const email = raw.trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) { setCcError(`"${email}" is not a valid email`); return; }
    if (ccEmails.includes(email)) { setCcError('Already added'); return; }
    setCcEmails(p => [...p, email]);
    setCcInput('');
    setCcError('');
  };

  const handleCcKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault(); addCcEmail(ccInput);
    }
    if (e.key === 'Backspace' && !ccInput && ccEmails.length) {
      setCcEmails(p => p.slice(0, -1));
    }
  };

  const handleCcPaste = (e) => {
    e.preventDefault();
    e.clipboardData.getData('text').split(/[\s,;]+/).forEach(addCcEmail);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (ccInput.trim()) addCcEmail(ccInput);
    setError('');
    setLoading(true);
    try {
      const payload = {
        ...form,
        affected_users: form.affected_users ? parseInt(form.affected_users) : undefined,
        ...(ccEmails.length ? { cc_emails: ccEmails.join(', ') } : {}),
      };
      const res = await createTicket(payload);
      localStorage.removeItem(DRAFT_KEY);
      toast.success('Ticket created successfully!');
      navigate(`/customer/tickets/${res.data.ticket.id}`);
    } catch (err) {
      const data = err.response?.data;
      if (data?.limit_exceeded) {
        setError(`Monthly ticket limit reached (${data.used}/${data.limit}). Please upgrade your plan.`);
      } else {
        setError(data?.error || 'Failed to create ticket');
      }
    } finally {
      setLoading(false);
    }
  };

  const numAffected = parseInt(form.affected_users) || 0;
  const autoPriorityHint = numAffected >= 25
    ? { label: 'Will be set to Urgent', cls: 'text-red-600' }
    : numAffected >= 10
    ? { label: 'Will be set to High', cls: 'text-amber-600' }
    : null;

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => navigate('/customer/tickets')}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800 mb-5 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Tickets
        </button>

        {/* Step 1: Template selector */}
        {step === 'template' && (
          <div className="card p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                <LayoutTemplate className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-800">What do you need help with?</h1>
                <p className="text-sm text-gray-500">Choose a template or start from scratch</p>
              </div>
            </div>

            <div className="space-y-2 mb-4">
              {templatesLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
                  <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  Loading templates…
                </div>
              ) : templates.length === 0 ? null : templates.map(tpl => (
                <button
                  key={tpl.id}
                  onClick={() => applyTemplate(tpl)}
                  className="w-full text-left flex items-center justify-between px-4 py-3 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 transition-colors group"
                >
                  <div>
                    <p className="text-sm font-semibold text-gray-800 group-hover:text-blue-700">{tpl.name}</p>
                    {tpl.request_type && (
                      <span className="text-xs text-gray-400">{tpl.request_type}</span>
                    )}
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-blue-500" />
                </button>
              ))}
            </div>

            <button
              onClick={() => setStep('form')}
              className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-dashed border-gray-300 hover:border-blue-300 hover:bg-gray-50 transition-colors text-sm text-gray-600 hover:text-blue-600"
            >
              <span className="font-medium">Custom — describe my issue</span>
              <ChevronRight className="w-4 h-4" />
            </button>

            {recentTickets.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Recent Issues</p>
                <div className="space-y-1">
                  {recentTickets.map(t => (
                    <button
                      key={t.id}
                      onClick={() => {
                        setForm(f => ({ ...f, subject: t.subject, description: '', request_type: t.request_type || f.request_type }));
                        setStep('form');
                      }}
                      className="w-full text-left flex items-center justify-between px-3 py-2 rounded-lg hover:bg-blue-50 transition-colors group"
                    >
                      <span className="text-sm text-gray-600 group-hover:text-blue-700 truncate">{t.subject}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500 flex-shrink-0 ml-2" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Form */}
        {step === 'form' && (
          <div className="card p-6">
            <div className="flex items-center justify-between gap-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                  <Ticket className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-800">Raise a Support Ticket</h1>
                  <p className="text-sm text-gray-500">Describe your issue clearly for faster resolution</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {(form.subject || form.description) && (
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                    Draft saved
                  </span>
                )}
                <button onClick={() => setStep('template')} className="text-xs text-blue-600 hover:underline">
                  ← Templates
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3 mb-5 text-sm text-red-700">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Request type + GW edition */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Request Type</label>
                  <select
                    className="input"
                    value={form.request_type}
                    onChange={e => setForm(f => ({ ...f, request_type: e.target.value }))}
                  >
                    <option value="">Select type…</option>
                    {REQUEST_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Google Workspace Edition</label>
                  <select
                    className="input"
                    value={form.gw_edition}
                    onChange={e => setForm(f => ({ ...f, gw_edition: e.target.value }))}
                  >
                    <option value="">Select edition…</option>
                    {GW_EDITIONS.map(e => <option key={e} value={e}>{e}</option>)}
                  </select>
                </div>
              </div>

              {/* Affected users */}
              <div>
                <label className="label">
                  Number of Affected Users
                  <span className="text-gray-400 font-normal ml-1">(optional)</span>
                </label>
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <Users className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      type="number"
                      min="0"
                      className="input pl-9"
                      placeholder="e.g. 5"
                      value={form.affected_users}
                      onChange={e => setForm(f => ({ ...f, affected_users: e.target.value }))}
                    />
                  </div>
                  {autoPriorityHint && (
                    <span className={`text-xs font-medium ${autoPriorityHint.cls}`}>
                      {autoPriorityHint.label}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  10+ users → High priority · 25+ users → Urgent
                </p>
              </div>

              <div>
                <label className="label">Subject *</label>
                <input
                  type="text"
                  className="input"
                  placeholder="Brief description of the issue"
                  value={form.subject}
                  onChange={e => { subjectRef.current = e.target.value; setForm(f => ({ ...f, subject: e.target.value })); }}
                  required
                  maxLength={500}
                />
              </div>

              <div>
                <label className="label">Description *</label>
                <textarea
                  className="input min-h-32 resize-y"
                  placeholder="Provide detailed information — include error messages, affected users, steps to reproduce…"
                  value={form.description}
                  onChange={e => handleDescChange(e.target.value)}
                  required
                  rows={5}
                />
              </div>

              {/* CC field */}
              <div>
                <label className="label">
                  CC — Email Aliases
                  <span className="text-gray-400 font-normal ml-1">(optional)</span>
                </label>
                <div
                  className={`input flex flex-wrap gap-1.5 min-h-[42px] cursor-text ${ccError ? 'border-red-400' : ''}`}
                  onClick={() => document.getElementById('cc-input').focus()}
                >
                  {ccEmails.map(email => (
                    <span key={email} className="inline-flex items-center gap-1 bg-blue-100 text-blue-700 text-xs font-medium px-2 py-0.5 rounded-full">
                      {email}
                      <button type="button" onClick={e => { e.stopPropagation(); setCcEmails(p => p.filter(x => x !== email)); }}>
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    id="cc-input"
                    type="text"
                    className="flex-1 min-w-[180px] outline-none bg-transparent text-sm"
                    placeholder={ccEmails.length === 0 ? 'Type email and press Enter or comma...' : ''}
                    value={ccInput}
                    onChange={e => { setCcInput(e.target.value); setCcError(''); }}
                    onKeyDown={handleCcKeyDown}
                    onPaste={handleCcPaste}
                    onBlur={() => ccInput.trim() && addCcEmail(ccInput)}
                  />
                </div>
                {ccError
                  ? <p className="text-xs text-red-500 mt-1">{ccError}</p>
                  : <p className="text-xs text-gray-400 mt-1">CC'd addresses will receive all ticket notifications.</p>
                }
              </div>

              <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5">
                {loading
                  ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  : <><Send className="w-4 h-4" /> Submit Ticket</>}
              </button>
            </form>
          </div>
        )}

        {/* Bot suggestions */}
        {step === 'form' && (suggestions.length > 0 || fetchingSuggestions) && (
          <div className="mt-4 card p-5">
            <div className="flex items-center gap-2 mb-3 text-amber-700">
              <Lightbulb className="w-4 h-4" />
              <h3 className="text-sm font-semibold">
                {fetchingSuggestions ? 'Looking for solutions...' : 'Knowledge Base Suggestions'}
              </h3>
            </div>
            {fetchingSuggestions ? (
              <div className="flex gap-2 items-center text-sm text-gray-400">
                <div className="w-4 h-4 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                Searching knowledge base...
              </div>
            ) : (
              <div className="space-y-3">
                {suggestions.map((s, i) => (
                  <div key={i} className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p className="text-sm font-semibold text-amber-800">{s.title}</p>
                    <p className="text-sm text-amber-700 mt-1">{s.solution}</p>
                    {s.link && (
                      <a href={s.link} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline mt-1 inline-block">
                        Learn more →
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
