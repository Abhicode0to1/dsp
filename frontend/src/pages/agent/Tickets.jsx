import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import useImagePaste from '../../hooks/useImagePaste';
import Layout from '../../components/common/Layout';
import { TicketStatusBadge, PriorityBadge, PlanBadge } from '../../components/common/PlanBadge';
import { useSocket } from '../../contexts/SocketContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  getAgentTickets, updateTicket, replyToTicket, requestReassignment,
  getAgentTicketDetail, getAgentList, searchCustomers, createAgentTicket,
  getInternalNotes, addInternalNote, deleteInternalNote,
  getMacros, createMacro, deleteMacro, mergeTicket, getRelatedTickets,
  bulkUpdateAgentTickets,
  getAttachments, uploadAttachment, deleteAttachment, getAttachmentDownloadUrl,
  getAgentTemplates, getCustomerHistory, getCannedResponses,
} from '../../services/api';
import {
  Ticket, CheckCircle, RefreshCw, Send, User, Headphones,
  Plus, Search, ChevronDown, X, AlertCircle, Lock, Clock, Tag,
  GitMerge, LayoutGrid, List as ListIcon, Zap, Trash2, Eye,
  ChevronRight, Bold, Italic, Code, Globe, ExternalLink, AlertTriangle,
  Paperclip, Download, FileText, MessageSquare, Phone,
} from 'lucide-react';
import CannedPicker from '../../components/common/CannedPicker';
import InternalNotesTab from '../../components/common/InternalNotesTab';
import { SkeletonCards } from '../../components/common/Skeleton';
import { timeAgo, fullDate } from '../../utils/timeAgo';
import { renderMarkdown } from '../../utils/renderMarkdown';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import toast from 'react-hot-toast';
import clsx from 'clsx';

function useEscapeKey(onEscape) {
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onEscape(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onEscape]);
}

const PRIORITIES = ['low', 'normal', 'medium', 'high', 'urgent'];
const STATUSES   = ['open', 'pending', 'closed'];

const REQUEST_TYPES = [
  'User Management', 'Domain & Setup', 'Plan Change', 'Billing',
  'Email & Migration', 'Access Issue', 'Feature Help', 'Escalation to Google',
];
const GW_EDITIONS = [
  'Business Starter', 'Business Standard', 'Business Plus', 'Enterprise', 'Frontline', 'Nonprofits',
];
const PENDING_REASONS = [
  'Waiting for customer action', 'Waiting for Google support', 'Awaiting payment', 'Under investigation',
];

const PRIORITY_STRIPE = {
  urgent: 'border-l-[3px] border-l-red-500',
  high:   'border-l-[3px] border-l-orange-400',
  medium: 'border-l-[3px] border-l-amber-400',
  normal: 'border-l-[3px] border-l-blue-300',
  low:    'border-l-[3px] border-l-gray-300',
};

const PRIORITY_KANBAN_COLOR = {
  urgent: 'bg-red-50 border-red-200',
  high:   'bg-orange-50 border-orange-200',
  medium: 'bg-amber-50 border-amber-200',
  normal: 'bg-blue-50 border-blue-200',
  low:    'bg-gray-50 border-gray-200',
};

function ageClass(createdAt, status) {
  if (status === 'closed') return '';
  const hours = (Date.now() - new Date(createdAt).getTime()) / 3600000;
  if (hours > 72) return 'bg-red-50/60';
  if (hours > 24) return 'bg-amber-50/60';
  return 'bg-green-50/30';
}

const SLA_HOURS = { urgent: 1, high: 4, medium: 8, normal: 24, low: 48 };

function SlaCountdown({ ticket, compact = false }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (ticket.status === 'closed') return;
    const t = setInterval(() => setTick(n => n + 1), 15000);
    return () => clearInterval(t);
  }, [ticket.status]);

  if (ticket.status === 'closed') return null;

  const needsResponse = !ticket.first_response_at;

  let deadline = null;
  let actionLabel = '';

  if (needsResponse) {
    if (ticket.sla_response_due) {
      deadline = new Date(ticket.sla_response_due);
    } else {
      const hours = SLA_HOURS[ticket.priority] || 24;
      deadline = new Date(new Date(ticket.created_at).getTime() + hours * 3600000);
    }
    actionLabel = 'Respond in';
  } else if (ticket.sla_resolve_due) {
    deadline = new Date(ticket.sla_resolve_due);
    actionLabel = 'Resolve in';
  }

  if (!deadline) return null;

  const msLeft = deadline.getTime() - Date.now();
  const breached = msLeft < 0;

  if (breached || ticket.sla_breached) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-bold text-white bg-red-600 px-2.5 py-1 rounded-full">
        <AlertCircle className="w-3 h-3" />
        {compact ? 'OVERDUE' : `SLA OVERDUE — ${needsResponse ? 'No response given' : 'Unresolved'}`}
      </span>
    );
  }

  const totalMs = (SLA_HOURS[ticket.priority] || 24) * 3600000;
  const pctLeft = msLeft / totalMs;
  const hoursLeft = Math.floor(msLeft / 3600000);
  const minsLeft = Math.floor((msLeft % 3600000) / 60000);
  const timeStr = hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}m` : `${minsLeft}m`;

  const cls = pctLeft < 0.15
    ? 'bg-red-50 text-red-700 border-red-300'
    : pctLeft < 0.4
    ? 'bg-amber-50 text-amber-700 border-amber-300'
    : 'bg-green-50 text-green-700 border-green-300';

  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${cls}`}>
      <Clock className="w-3 h-3" />
      {compact ? timeStr : `${actionLabel} ${timeStr}`}
    </span>
  );
}

function TagsDisplay({ tags }) {
  if (!tags?.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map(t => (
        <span key={t} className="inline-flex items-center gap-0.5 text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full">
          <Tag className="w-2.5 h-2.5" />{t}
        </span>
      ))}
    </div>
  );
}

function FirstResponseBadge({ ticket }) {
  if (!ticket.first_response_at || !ticket.created_at) return null;
  const secs = Math.floor((new Date(ticket.first_response_at) - new Date(ticket.created_at)) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
      <Zap className="w-2.5 h-2.5" /> First reply {timeStr}
    </span>
  );
}

function PendingReasonBadge({ reason }) {
  if (!reason) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-amber-50 border border-amber-200 text-amber-700 px-2 py-0.5 rounded-full">
      <Clock className="w-2.5 h-2.5" /> {reason}
    </span>
  );
}

function RequestTypeBadge({ type }) {
  if (!type) return null;
  return (
    <span className="inline-flex items-center text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full font-medium">
      {type}
    </span>
  );
}

function Select({ value, onChange, options, placeholder = 'Select', className = '' }) {
  return (
    <div className={`relative ${className}`}>
      <select value={value} onChange={e => onChange(e.target.value)} className="input appearance-none pr-8 py-1.5 text-sm cursor-pointer w-full">
        {placeholder && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
    </div>
  );
}

// ── Tags Input ───────────────────────────────────────────────────────────────
function TagsInput({ tags = [], onChange }) {
  const [input, setInput] = useState('');

  const add = (tag) => {
    tag = tag.trim().toLowerCase();
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag]);
    setInput('');
  };

  const remove = (t) => onChange(tags.filter(x => x !== t));

  return (
    <div className="flex flex-wrap gap-1 items-center min-h-8 px-2 py-1.5 border border-gray-200 rounded-lg bg-white text-sm">
      {tags.map(t => (
        <span key={t} className="inline-flex items-center gap-0.5 bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-full text-xs">
          {t}
          <button type="button" onClick={() => remove(t)}><X className="w-2.5 h-2.5 hover:text-red-600" /></button>
        </span>
      ))}
      <input
        className="outline-none flex-1 min-w-20 text-xs bg-transparent"
        placeholder="Add tag, press Enter"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(input); }
          if (e.key === 'Backspace' && !input && tags.length) remove(tags[tags.length - 1]);
        }}
      />
    </div>
  );
}

// ── Macros Picker ────────────────────────────────────────────────────────────
function MacrosPicker({ onApply }) {
  const [macros, setMacros] = useState([]);
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newReply, setNewReply] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const [newTag, setNewTag] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    getMacros().then(r => setMacros(r.data.macros)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const actions = [];
    if (newReply.trim()) actions.push({ type: 'reply', value: newReply.trim() });
    if (newStatus) actions.push({ type: 'status', value: newStatus });
    if (newTag.trim()) actions.push({ type: 'tag', value: newTag.trim().toLowerCase() });
    if (!actions.length) return toast.error('Add at least one action');
    try {
      await createMacro({ name: newName.trim(), actions });
      const r = await getMacros();
      setMacros(r.data.macros);
      setShowCreate(false); setNewName(''); setNewReply(''); setNewStatus(''); setNewTag('');
      toast.success('Macro created');
    } catch { toast.error('Failed to create macro'); }
  };

  const handleDelete = async (id) => {
    try {
      await deleteMacro(id);
      setMacros(m => m.filter(x => x.id !== id));
      toast.success('Macro deleted');
    } catch { toast.error('Failed to delete macro'); }
  };

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-xs text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 px-2.5 py-1.5 rounded-lg font-medium transition-colors">
        <Zap className="w-3.5 h-3.5" /> Macros
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-30 w-64 bg-white rounded-xl border border-gray-200 shadow-lg p-2">
          <p className="text-xs font-semibold text-gray-500 px-1 mb-1.5">Quick Actions</p>
          {macros.length === 0 && !showCreate && (
            <p className="text-xs text-gray-400 px-1 py-2">No macros yet</p>
          )}
          {macros.map(m => (
            <div key={m.id} className="flex items-center group">
              <button type="button" onClick={() => { onApply(m.actions); setOpen(false); }}
                className="flex-1 text-left text-xs text-gray-700 hover:bg-blue-50 px-2 py-1.5 rounded-lg transition-colors">
                {m.name}
              </button>
              <button type="button" onClick={() => handleDelete(m.id)} className="hidden group-hover:flex p-1 text-red-400 hover:text-red-600">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
          {showCreate ? (
            <div className="border-t border-gray-100 mt-2 pt-2 space-y-1.5">
              <input className="input text-xs py-1 w-full" placeholder="Macro name *" value={newName} onChange={e => setNewName(e.target.value)} />
              <input className="input text-xs py-1 w-full" placeholder="Reply text (optional)" value={newReply} onChange={e => setNewReply(e.target.value)} />
              <select className="input text-xs py-1 w-full" value={newStatus} onChange={e => setNewStatus(e.target.value)}>
                <option value="">Status change (optional)</option>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <input className="input text-xs py-1 w-full" placeholder="Add tag (optional)" value={newTag} onChange={e => setNewTag(e.target.value)} />
              <div className="flex gap-1.5 pt-1">
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 text-xs btn-secondary py-1 justify-center">Cancel</button>
                <button type="button" onClick={handleCreate} className="flex-1 text-xs btn-primary py-1 justify-center">Save</button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setShowCreate(true)} className="mt-1.5 w-full text-xs text-blue-600 hover:bg-blue-50 px-2 py-1.5 rounded-lg flex items-center gap-1">
              <Plus className="w-3 h-3" /> New macro
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Resolve {{customer_name}}, {{ticket_id}}, etc. — mirrors CannedPicker's behavior
// so templates produce a personalised reply, not a string with literal {{vars}}.
function resolveTemplateVars(text, ctx) {
  if (!ctx || !text) return text || '';
  return text
    .replace(/\{\{customer_name\}\}/g, ctx.customer_name || '')
    .replace(/\{\{ticket_id\}\}/g,     ctx.ticket_id ? `#${ctx.ticket_id}` : '')
    .replace(/\{\{gw_edition\}\}/g,    ctx.gw_edition || '')
    .replace(/\{\{domain\}\}/g,        ctx.domain || '')
    .replace(/\{\{agent_name\}\}/g,    ctx.agent_name || '');
}

// ── Templates Picker ──────────────────────────────────────────────────────────
function TemplatesPicker({ onApply, context }) {
  const [templates, setTemplates] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const load = () => {
    if (templates !== null) { setOpen(o => !o); return; }
    getAgentTemplates().then(r => { setTemplates(r.data.templates); setOpen(true); }).catch(() => {});
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={load} className="flex items-center gap-1 text-xs text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 px-2.5 py-1.5 rounded-lg font-medium transition-colors">
        <FileText className="w-3.5 h-3.5" /> Templates
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-30 w-72 bg-white rounded-xl border border-gray-200 shadow-lg p-2">
          <p className="text-xs font-semibold text-gray-500 px-1 mb-1.5">Reply Templates</p>
          {templates?.length === 0 && <p className="text-xs text-gray-400 px-1 py-2">No active templates</p>}
          {templates?.map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                const resolved = resolveTemplateVars(t.description_template, context);
                onApply(resolved, t);
                setOpen(false);
              }}
              className="w-full text-left text-xs text-gray-700 hover:bg-blue-50 px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2"
            >
              <span className="flex-1 font-medium">{t.name}</span>
              {t.default_priority && (
                <span className="text-[10px] text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded flex-shrink-0">{t.default_priority}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Markdown Toolbar ─────────────────────────────────────────────────────────
function MarkdownToolbar({ onInsert }) {
  const tools = [
    { icon: <Bold className="w-3.5 h-3.5" />, wrap: ['**', '**'], title: 'Bold' },
    { icon: <Italic className="w-3.5 h-3.5" />, wrap: ['*', '*'], title: 'Italic' },
    { icon: <Code className="w-3.5 h-3.5" />, wrap: ['`', '`'], title: 'Code' },
    { icon: <ListIcon className="w-3.5 h-3.5" />, prefix: '- ', title: 'Bullet' },
  ];
  return (
    <div className="flex items-center gap-0.5 border-b border-gray-100 pb-1.5 mb-1.5">
      {tools.map((t, i) => (
        <button key={i} type="button" title={t.title}
          onClick={() => onInsert(t.wrap, t.prefix)}
          className="p-1 rounded text-gray-500 hover:text-blue-600 hover:bg-blue-50 transition-colors">
          {t.icon}
        </button>
      ))}
    </div>
  );
}

// ── Merge Ticket Modal ────────────────────────────────────────────────────────
function MergeModal({ ticket, onClose, onMerged }) {
  useEscapeKey(onClose);
  const [targetId, setTargetId] = useState('');
  const [saving, setSaving]     = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!targetId) return;
    setSaving(true);
    try {
      await mergeTicket(ticket.id, { merge_into_id: parseInt(targetId) });
      toast.success(`Ticket #${ticket.id} merged into #${targetId}`);
      onMerged(parseInt(targetId));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Merge failed');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-bold text-gray-800">Merge Ticket</h2>
            <p className="text-xs text-gray-400 mt-0.5">Ticket #{ticket.id} will be closed and its messages moved</p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Merge into Ticket # *</label>
            <input className="input w-full" type="number" placeholder="Enter ticket ID" value={targetId} onChange={e => setTargetId(e.target.value)} required />
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving || !targetId} className="btn-primary flex-1 justify-center flex items-center gap-1.5">
              <GitMerge className="w-4 h-4" /> {saving ? 'Merging…' : 'Merge'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Reply Assistant — chips that surface above the reply textarea ────────────
// Two helpers folded into one component:
//   • "Asked before" chip: if this customer has prior tickets whose subject shares
//     2+ words with the current one, show their IDs. Click to open the older
//     ticket in a new tab so the agent can copy that earlier reply.
//   • Template-match chip: as the agent types, fuzzy-match the first ~30 chars of
//     reply text against template bodies. If a template's first line contains those
//     words, suggest inserting it.
// Both pull from data the parent component already fetched (customerHistory +
// templates) — no extra round-trips.
function ReplyAssistant({ currentTicket, history, replyText, templates, onUseTemplate }) {
  if (!currentTicket) return null;

  // 1. Asked-before — past tickets with overlapping subject keywords
  const stopwords = new Set(['the','and','for','with','from','about','this','that','your','have','need','want','will','can','our','their','please','help','issue','problem','setup','support']);
  const keywords = (currentTicket.subject || '').toLowerCase().split(/\W+/).filter(w => w.length > 3 && !stopwords.has(w));
  const askedBefore = (history?.tickets || []).filter(t =>
    t.id !== currentTicket.id &&
    keywords.some(k => (t.subject || '').toLowerCase().includes(k))
  ).slice(0, 3);

  // 2. Template suggestion — only kicks in once agent has typed a few words
  const head = (replyText || '').trim().toLowerCase().slice(0, 50);
  let templateMatch = null;
  if (head.length >= 8 && templates?.length) {
    const headWords = head.split(/\W+/).filter(w => w.length > 3 && !stopwords.has(w));
    if (headWords.length >= 2) {
      templateMatch = templates.find(t => {
        const body = (t.body || t.content || '').toLowerCase();
        return headWords.filter(w => body.includes(w)).length >= Math.min(2, headWords.length);
      });
    }
  }

  if (!askedBefore.length && !templateMatch) return null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
      {templateMatch && (
        <button
          type="button"
          onClick={() => onUseTemplate(templateMatch)}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
          title="Insert this template"
        >
          💡 Use snippet: <strong>{templateMatch.title || templateMatch.name}</strong>
        </button>
      )}
      {askedBefore.length > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
          Asked before:{' '}
          {askedBefore.map((t, i) => (
            <a key={t.id} href={`/agent/tickets?openTicket=${t.id}`} target="_blank" rel="noreferrer"
              className="underline hover:text-amber-800 font-mono ml-0.5">
              #{t.id}{i < askedBefore.length - 1 ? ',' : ''}
            </a>
          ))}
        </span>
      )}
    </div>
  );
}

// ── Context strip + plan badge ────────────────────────────────────────────────
// Rendered immediately under the ticket subject. Two layers:
//   • Plan / billing badge — green if plan active far out, amber if expiring soon,
//     red if expired/payment issue. Pulls plan_name + plan_expiry off the ticket
//     (already populated by getAgentTicketDetail).
//   • "Recent history" strip — counts of tickets/chats/calls in the last 90 days
//     plus a "last touch" pill (e.g. "📞 Called yesterday"). Only renders once the
//     parent's getCustomerHistory call resolves.
function TicketContextStrip({ ticket, history }) {
  if (!ticket) return null;

  // Plan / billing health
  const expiry = ticket.plan_expiry ? new Date(ticket.plan_expiry) : null;
  const daysLeft = expiry ? Math.ceil((expiry - Date.now()) / 86400000) : null;
  let planTone = 'gray', planLabel = ticket.plan_name ? `Plan: ${ticket.plan_name}` : 'No plan';
  if (ticket.plan_name && daysLeft != null) {
    if (daysLeft < 0)        { planTone = 'red';   planLabel = `${ticket.plan_name} · expired ${-daysLeft}d ago`; }
    else if (daysLeft < 15)  { planTone = 'amber'; planLabel = `${ticket.plan_name} · expires in ${daysLeft}d`; }
    else                     { planTone = 'green'; planLabel = `${ticket.plan_name} · active`; }
  }
  const planClass = ({
    green: 'bg-green-100 text-green-700 border-green-200',
    amber: 'bg-amber-100 text-amber-700 border-amber-200',
    red:   'bg-red-100 text-red-700 border-red-200',
    gray:  'bg-gray-100 text-gray-600 border-gray-200',
  })[planTone];

  // History counts + last-touch line
  const counts = history?.counts;
  const latest = history?.latest_touch;
  let latestLabel = null;
  if (latest) {
    const ago = Math.floor((Date.now() - new Date(latest.created_at).getTime()) / 86400000);
    const when = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago}d ago`;
    const verbs = { ticket: 'Raised ticket', chat: 'Chatted', call: 'Called' };
    latestLabel = `${verbs[latest.kind] || latest.kind} ${when}`;
  }

  return (
    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
      {/* Plan badge */}
      <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full border ${planClass}`}>
        {planLabel}
      </span>

      {/* History counts — only render once data is back */}
      {counts && (counts.tickets_90d || counts.chats_90d || counts.calls_90d) ? (
        <>
          {counts.tickets_90d > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-600 bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded-full">
              <Ticket className="w-2.5 h-2.5" /> {counts.tickets_90d} ticket{counts.tickets_90d === 1 ? '' : 's'} (90d)
              {counts.open_tickets > 0 && <span className="text-amber-700 font-semibold ml-0.5">· {counts.open_tickets} open</span>}
            </span>
          )}
          {counts.chats_90d > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-600 bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded-full">
              <MessageSquare className="w-2.5 h-2.5" /> {counts.chats_90d} chat{counts.chats_90d === 1 ? '' : 's'}
            </span>
          )}
          {counts.calls_90d > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] text-gray-600 bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded-full">
              <Phone className="w-2.5 h-2.5" /> {counts.calls_90d} call{counts.calls_90d === 1 ? '' : 's'}
            </span>
          )}
          {latestLabel && (
            <span className="inline-flex items-center gap-1 text-[10px] text-blue-700 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded-full">
              <Clock className="w-2.5 h-2.5" /> {latestLabel}
            </span>
          )}
        </>
      ) : history === null ? (
        <span className="text-[10px] text-gray-400">Loading history…</span>
      ) : null}
    </div>
  );
}

// ── Create Ticket Modal ───────────────────────────────────────────────────────
function CreateTicketModal({ onClose, onCreated }) {
  useEscapeKey(onClose);
  const [form, setForm]   = useState({ customer_id: '', subject: '', description: '', priority: 'normal' });
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState([]);
  const [selectedCust, setSelectedCust] = useState(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  const handleSearch = (q) => {
    setQuery(q);
    clearTimeout(timer.current);
    if (!q) { setCustomers([]); return; }
    timer.current = setTimeout(async () => {
      const res = await searchCustomers(q).catch(() => null);
      if (res) setCustomers(res.data.customers);
    }, 350);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.customer_id) return toast.error('Select a customer');
    setLoading(true);
    try {
      const res = await createAgentTicket(form);
      toast.success('Ticket created');
      onCreated(res.data.ticket);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create ticket');
    } finally { setLoading(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-800">Create Ticket</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Customer *</label>
            {selectedCust ? (
              <div className="flex items-center justify-between input py-2">
                <span className="text-sm">{selectedCust.name} <span className="text-gray-400">— {selectedCust.domain}</span></span>
                <button type="button" onClick={() => { setSelectedCust(null); setForm(f => ({ ...f, customer_id: '' })); setQuery(''); }}>
                  <X className="w-3.5 h-3.5 text-gray-400 hover:text-red-500" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <input className="input" placeholder="Search by name, email or domain..." value={query} onChange={e => handleSearch(e.target.value)} />
                {customers.length > 0 && (
                  <div className="absolute z-10 top-full left-0 right-0 bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto">
                    {customers.map(c => (
                      <button key={c.id} type="button" className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm"
                        onClick={() => { setSelectedCust(c); setForm(f => ({ ...f, customer_id: c.id })); setCustomers([]); }}>
                        <span className="font-medium">{c.name}</span>
                        <span className="text-gray-400 ml-2">{c.domain}</span>
                        {c.plan_name && <span className="ml-1"><PlanBadge plan={c.plan_name} /></span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div><label className="label">Subject *</label><input className="input" required maxLength={500} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} /></div>
          <div><label className="label">Description *</label><textarea className="input min-h-24 resize-y" required rows={4} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} spellCheck={true} autoCorrect="on" autoCapitalize="sentences" lang="en" /></div>
          <div><label className="label">Priority</label>
            <Select value={form.priority} onChange={v => setForm(f => ({ ...f, priority: v }))} options={PRIORITIES.map(p => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }))} placeholder="" />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center">
              {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Create Ticket'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ReassignModal({ ticket, onClose }) {
  useEscapeKey(onClose);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const send = (r) => {
    const finalReason = (r ?? reason).trim();
    if (!finalReason) return;
    setSaving(true);
    requestReassignment(ticket.id, { reason: finalReason })
      .then(() => { toast.success('Reassignment request sent to admin'); onClose(); })
      .catch(err => toast.error(err.response?.data?.error || 'Failed'))
      .finally(() => setSaving(false));
  };

  const QUICK_REASONS = [
    'Outside my expertise',
    'Workload too high',
    'Customer asked for different agent',
  ];

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div><h2 className="text-base font-bold text-gray-800">Request Reassignment</h2>
          <p className="text-xs text-gray-400 mt-0.5">Ticket #{ticket.id} — {ticket.subject}</p></div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <div className="space-y-2 mb-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Quick reasons</p>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_REASONS.map(r => (
              <button key={r} type="button" onClick={() => send(r)} disabled={saving}
                className="text-xs px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition-colors disabled:opacity-50">
                {r}
              </button>
            ))}
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Or custom reason</p>
            <textarea className="input w-full min-h-20 resize-y" placeholder="e.g. Issue requires senior agent..." value={reason} onChange={e => setReason(e.target.value)} rows={3} spellCheck={true} autoCorrect="on" autoCapitalize="sentences" lang="en" />
          </div>
          <p className="text-xs text-gray-400">Admin will review and reassign the ticket.</p>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving || !reason.trim()} className="btn-primary flex-1 justify-center">
              {saving ? 'Sending...' : 'Send Request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Kanban Board ─────────────────────────────────────────────────────────────
function KanbanBoard({ tickets, onSelect, unreadTickets }) {
  const cols = [
    { key: 'open',    label: 'Open',    color: 'text-blue-700 bg-blue-50' },
    { key: 'pending', label: 'Pending', color: 'text-amber-700 bg-amber-50' },
    { key: 'closed',  label: 'Closed',  color: 'text-gray-500 bg-gray-100' },
  ];
  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {cols.map(col => {
        const colTickets = tickets.filter(t => t.status === col.key);
        return (
          <div key={col.key} className="flex-shrink-0 w-72">
            <div className={clsx('flex items-center gap-2 px-3 py-2 rounded-lg mb-3', col.color)}>
              <span className="text-xs font-bold uppercase tracking-wide">{col.label}</span>
              <span className="text-xs font-semibold ml-auto">{colTickets.length}</span>
            </div>
            <div className="space-y-2 max-h-[calc(100vh-280px)] overflow-y-auto pr-0.5">
              {colTickets.map(t => (
                <div key={t.id} onClick={() => onSelect(t)}
                  className={clsx('bg-white rounded-xl border p-3 cursor-pointer transition-all overflow-hidden', PRIORITY_STRIPE[t.priority], ageClass(t.created_at, t.status), t.sla_breached && t.status !== 'closed' ? 'ring-2 ring-red-300 bg-red-50/50' : '', unreadTickets.has(t.id) ? 'border-blue-300' : 'border-gray-200 hover:border-blue-200 hover:shadow-sm')}>
                  <p className="text-xs text-gray-400 font-mono mb-0.5">#{t.id}</p>
                  <p className="text-sm font-semibold text-gray-800 line-clamp-2 mb-1.5">{t.subject}</p>
                  {t.request_type && <p className="text-xs text-blue-600 mb-1">{t.request_type}</p>}
                  {t.status === 'pending' && t.pending_reason && (
                    <p className="text-xs text-amber-600 mb-1">{t.pending_reason}</p>
                  )}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <PriorityBadge priority={t.priority} />
                    <SlaCountdown ticket={t} compact />
                  </div>
                  <p className="text-xs text-gray-400 mt-1.5">{t.customer_name} · {timeAgo(t.created_at)}</p>
                </div>
              ))}
              {colTickets.length === 0 && (
                <div className="text-center text-xs text-gray-400 py-8 border-2 border-dashed border-gray-100 rounded-xl">Empty</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Detail Panel Tabs ─────────────────────────────────────────────────────────
function RelatedTicketsPanel({ ticketId, customerId, onSelect }) {
  const [related, setRelated] = useState([]);
  const [chats, setChats] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('tickets');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      getRelatedTickets(ticketId),
      customerId ? getCustomerHistory(customerId) : Promise.resolve({ data: { chats: [] } }),
    ])
      .then(([rTickets, rHistory]) => {
        setRelated(rTickets.data.tickets);
        setChats(rHistory.data.chats || []);
        setOpen(true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ticketId, customerId]);

  return (
    <div className="border-t border-gray-100">
      <button onClick={() => open ? setOpen(false) : load()} className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors">
        <span>Customer History {(related.length + chats.length) > 0 ? `(${related.length + chats.length})` : ''}</span>
        <ChevronRight className={clsx('w-3.5 h-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="px-4 pb-3">
          <div className="flex gap-1.5 mb-2">
            <button type="button" onClick={() => setTab('tickets')} className={clsx('flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors', tab === 'tickets' ? 'bg-blue-100 text-blue-700' : 'text-gray-400 hover:text-gray-600')}>
              <Ticket className="w-3 h-3" /> Tickets {related.length > 0 && `(${related.length})`}
            </button>
            <button type="button" onClick={() => setTab('chats')} className={clsx('flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors', tab === 'chats' ? 'bg-blue-100 text-blue-700' : 'text-gray-400 hover:text-gray-600')}>
              <MessageSquare className="w-3 h-3" /> Chats {chats.length > 0 && `(${chats.length})`}
            </button>
          </div>
          {loading && <p className="text-xs text-gray-400">Loading…</p>}
          {tab === 'tickets' && !loading && (
            <div className="space-y-1.5">
              {related.length === 0 && <p className="text-xs text-gray-400">No other tickets</p>}
              {related.map(t => (
                <button key={t.id} onClick={() => onSelect(t)} className="w-full text-left flex items-center gap-2 hover:bg-gray-50 p-2 rounded-lg transition-colors">
                  <span className="text-xs text-gray-400 font-mono w-10 flex-shrink-0">#{t.id}</span>
                  <span className="text-xs text-gray-700 flex-1 truncate">{t.subject}</span>
                  <TicketStatusBadge status={t.status} />
                </button>
              ))}
            </div>
          )}
          {tab === 'chats' && !loading && (
            <div className="space-y-1.5">
              {chats.length === 0 && <p className="text-xs text-gray-400">No chat history</p>}
              {chats.map(c => (
                <div key={c.id} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50">
                  <span className="text-xs text-gray-400 font-mono w-10 flex-shrink-0">#{c.id}</span>
                  <span className="text-xs text-gray-500 flex-1">{new Date(c.created_at).toLocaleDateString('en-IN')}</span>
                  <span className={clsx('text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0', c.status === 'closed' ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-700')}>{c.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function AgentTickets() {
  const { socket } = useSocket();
  const { user: currentUser } = useAuth();

  const [tickets, setTickets]               = useState([]);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [ticketMessages, setTicketMessages] = useState([]);
  // 90-day rollup of this customer's tickets/chats/calls + their most-recent touch.
  // Cleared whenever the agent switches to a different ticket (different customer).
  const [customerHistory, setCustomerHistory] = useState(null);
  // Canned reply snippets — feed the ReplyAssistant's template-match chip.
  // These are the agent's quick-reply boilerplates with {{customer_name}} etc. tokens.
  const [cannedList, setCannedList] = useState([]);
  const [reply, setReply]                   = useState('');
  const [agentList, setAgentList]           = useState([]);
  const [showCreate, setShowCreate]         = useState(false);
  const [reassignTarget, setReassignTarget] = useState(null);
  const [mergeTarget, setMergeTarget]       = useState(null);
  // Closing a ticket requires a final message — agents can't silently close.
  const [closeTarget, setCloseTarget]       = useState(null); // ticket being closed
  const [closeMessage, setCloseMessage]     = useState('');
  const [closingTicket, setClosingTicket]   = useState(false);
  // Guards against a double-fire of the reply composer (rapid clicks / Enter +
  // button) which could send the reply twice and error on the second pass.
  const [sendingReply, setSendingReply]     = useState(false);
  // When you drill into another ticket from Customer History, remember the one
  // you were on so we can offer a "← Back to #X" return button.
  const [historyFromTicket, setHistoryFromTicket] = useState(null);
  // Layout lock — when ON, the messages pane and reply textarea become non-resizable
  // and persist their height across tickets. Stops accidental drags from re-sizing
  // panes while reading. Persisted so it survives reloads.
  const [layoutLocked, setLayoutLocked]     = useState(() => {
    try { return localStorage.getItem('agent_layout_locked') === '1'; } catch { return false; }
  });
  const toggleLayoutLock = () => {
    setLayoutLocked(v => {
      const next = !v;
      try { localStorage.setItem('agent_layout_locked', next ? '1' : '0'); } catch {}
      return next;
    });
  };
  const [loading, setLoading]               = useState(true);
  const persistedFilters = (() => {
    try { return JSON.parse(localStorage.getItem('agent_ticket_filters') || '{}'); } catch { return {}; }
  })();
  // Default filter is 'open' — agents land on actionable tickets first, not an
  // overwhelming "everything ever" list. Persisted choice still wins if the
  // agent explicitly switched to another status (closed / pending / resolved).
  const [filterStatus, setFilterStatus]     = useState(persistedFilters.status || 'open');
  const [filterPriority, setFilterPriority] = useState(persistedFilters.priority || '');
  const [filterTag, setFilterTag]           = useState(persistedFilters.tag || '');
  const [filterRequestType, setFilterRequestType] = useState(persistedFilters.requestType || '');
  const [filterGwEdition, setFilterGwEdition]     = useState(persistedFilters.gwEdition || '');
  const [search, setSearch]                 = useState('');
  const [unreadTickets, setUnreadTickets]   = useState(new Set());
  const [viewMode, setViewMode]             = useState(persistedFilters.viewMode || 'list');
  const [ticketScope, setTicketScope]       = useState(persistedFilters.scope || 'mine');
  const [activeTab, setActiveTab]           = useState('messages');
  const [viewingAgents, setViewingAgents]   = useState([]);
  const [showMarkdown, setShowMarkdown]     = useState(false);
  const [selectedIds, setSelectedIds]       = useState(new Set());
  const [bulkLoading, setBulkLoading]       = useState(false);
  const [convSearch, setConvSearch] = useState('');
  const [ticketAttachments, setTicketAttachments] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [lightboxSrc, setLightboxSrc] = useState(null);

  const bottomRef        = useRef(null);
  const selectedTicketRef = useRef(null);
  const replyRef         = useRef(null);
  const msgPaneRef       = useRef(null);
  const fileInputRef     = useRef(null);
  const ticketsRef       = useRef([]);

  useEffect(() => { selectedTicketRef.current = selectedTicket; }, [selectedTicket]);

  // Ctrl+V on the reply textarea queues a clipboard screenshot — mirrors the
  // size cap the file picker enforces. Pasted PNG/JPG always pass the
  // extension whitelist since the hook names them `screenshot-*.png/.jpg`.
  const onPasteImage = useCallback((file) => {
    if (file.size > 25 * 1024 * 1024) {
      toast.error(`${file.name} too large (max 25MB)`);
      return;
    }
    setPendingFiles(p => [...p, file]);
  }, []);
  const pasteRef = useImagePaste(onPasteImage);
  // The textarea also needs `replyRef` for the ResizeObserver — combine both.
  const setReplyRef = useCallback((node) => {
    replyRef.current = node;
    pasteRef(node);
  }, [pasteRef]);

  // Mark any unread ticket-related notifications for this ticket as read once
  // the agent has it open — the NotificationBell listens for this event.
  useEffect(() => {
    if (selectedTicket?.id == null) return;
    window.dispatchEvent(new CustomEvent('agent_notification:viewed', { detail: { ticketId: Number(selectedTicket.id) } }));
  }, [selectedTicket?.id]);

  // Persist agent's preferred reply-textarea height across sessions.
  // Saves via ResizeObserver whenever the textarea's bottom-right corner is dragged.
  useEffect(() => {
    const el = replyRef.current;
    if (!el) return;
    try {
      const saved = localStorage.getItem('agent_reply_height');
      if (saved) el.style.height = `${parseInt(saved, 10)}px`;
    } catch {}
    let t;
    const obs = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        try { localStorage.setItem('agent_reply_height', String(Math.round(el.offsetHeight))); } catch {}
      }, 300);
    });
    obs.observe(el);
    return () => { clearTimeout(t); obs.disconnect(); };
  }, [selectedTicket?.id]);

  // Persist agent's preferred messages-pane height across sessions.
  useEffect(() => {
    const el = msgPaneRef.current;
    if (!el) return;
    try {
      const saved = localStorage.getItem('agent_msgpane_height');
      if (saved) el.style.height = `${parseInt(saved, 10)}px`;
    } catch {}
    let t;
    const obs = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        try { localStorage.setItem('agent_msgpane_height', String(Math.round(el.offsetHeight))); } catch {}
      }, 300);
    });
    obs.observe(el);
    return () => { clearTimeout(t); obs.disconnect(); };
  }, [selectedTicket?.id, activeTab]);

  // j/k keyboard navigation across visible tickets (list/kanban). Ignored when typing.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'j' && e.key !== 'k') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (showCreate || reassignTarget || mergeTarget) return;
      const visible = ticketsRef.current;
      if (!visible || visible.length === 0) return;
      const curId = selectedTicket?.id;
      let idx = visible.findIndex(x => x.id === curId);
      idx = e.key === 'j' ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx - 1);
      if (idx < 0) idx = 0;
      const next = visible[idx];
      if (next && next.id !== curId) {
        e.preventDefault();
        setSelectedTicket(next);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectedTicket?.id, showCreate, reassignTarget, mergeTarget]);

  const loadTickets = useCallback(() => {
    setLoading(true);
    const params = {};
    if (filterStatus)      params.status       = filterStatus;
    if (filterRequestType) params.request_type = filterRequestType;
    if (filterGwEdition)   params.gw_edition   = filterGwEdition;
    if (ticketScope === 'all') params.view = 'all';
    Promise.all([
      getAgentTickets(params),
      getAgentList(),
    ]).then(([tix, agents]) => {
      setTickets(tix.data.tickets);
      setAgentList(agents.data.agents);
    }).catch(() => toast.error('Failed to load tickets'))
      .finally(() => setLoading(false));
  }, [filterStatus, filterRequestType, filterGwEdition, ticketScope]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  useGlobalRefresh(loadTickets);

  // Pull canned reply snippets once on mount. Feeds ReplyAssistant's match chip.
  useEffect(() => {
    getCannedResponses()
      .then(r => setCannedList(r.data.responses || r.data || []))
      .catch(() => {});
  }, []);

  // Cmd+K hints + ?openTicket=N from clickable notifications + ?new=1 from Dashboard quick-action
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    // ?new=1 → open the Create Ticket modal. Works regardless of whether tickets have loaded yet,
    // because the modal doesn't depend on the existing list — agents typing 'New Ticket' from the
    // dashboard should land in the modal immediately.
    if (searchParams.get('new') === '1') {
      setShowCreate(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
    if (tickets.length === 0) return;
    try {
      const openId = sessionStorage.getItem('cmdk_open_ticket') || searchParams.get('openTicket');
      if (openId) {
        sessionStorage.removeItem('cmdk_open_ticket');
        const t = tickets.find(x => String(x.id) === String(openId));
        if (t) setSelectedTicket(t);
        // Clean the query param so a refresh doesn't keep re-opening
        if (searchParams.get('openTicket')) {
          const next = new URLSearchParams(searchParams);
          next.delete('openTicket');
          setSearchParams(next, { replace: true });
        }
      }
      const filterCust = sessionStorage.getItem('cmdk_filter_customer');
      if (filterCust) {
        sessionStorage.removeItem('cmdk_filter_customer');
        setSearch(filterCust);
      }
    } catch {}
  }, [tickets.length, searchParams, setSearchParams]);

  useEffect(() => {
    try {
      localStorage.setItem('agent_ticket_filters', JSON.stringify({
        status: filterStatus,
        priority: filterPriority,
        tag: filterTag,
        requestType: filterRequestType,
        gwEdition: filterGwEdition,
        viewMode,
        scope: ticketScope,
      }));
    } catch {}
  }, [filterStatus, filterPriority, filterTag, filterRequestType, filterGwEdition, viewMode, ticketScope]);

  useEffect(() => {
    if (!selectedTicket) return;
    setActiveTab('messages');
    setViewingAgents([]);
    setTicketAttachments([]);
    setPendingFiles([]);
    // Clear stale history while the new customer's data is fetching — avoids briefly
    // showing the previous customer's counts.
    setCustomerHistory(null);
    const saved = localStorage.getItem(`draft_reply_${selectedTicket.id}`);
    if (saved) {
      setReply(saved);
      toast('Draft restored', { icon: '📝' });
    } else {
      setReply('');
    }
    const requestedId = selectedTicket.id;
    getAgentTicketDetail(requestedId)
      .then(res => {
        // Drop stale response if user switched tickets mid-flight
        if (selectedTicketRef.current?.id !== requestedId) return;
        setSelectedTicket(res.data.ticket);
        // Merge: preserve any messages that arrived via socket while load was in flight
        setTicketMessages(prev => {
          const fetched = res.data.messages || [];
          const ids = new Set(fetched.map(m => m.id));
          const extras = prev.filter(m => !ids.has(m.id));
          return [...fetched, ...extras];
        });
        setUnreadTickets(s => { const n = new Set(s); n.delete(requestedId); return n; });
        // Kick off customer-history fetch in parallel — powers the "Recent history" strip
        // above the ticket header.  Tied to the ticket's customer_id so opening a
        // different ticket loads fresh history.
        const customerId = res.data.ticket?.customer_id;
        if (customerId) {
          getCustomerHistory(customerId)
            .then(h => {
              if (selectedTicketRef.current?.id !== requestedId) return;
              setCustomerHistory(h.data);
            })
            .catch(() => setCustomerHistory(null));
        }
      })
      .catch(() => toast.error('Failed to load ticket'));
    getAttachments('ticket', selectedTicket.id)
      .then(res => setTicketAttachments(res.data.attachments || []))
      .catch(() => {});
  }, [selectedTicket?.id]);

  useEffect(() => {
    if (!selectedTicket?.id || !reply) return;
    const tid = selectedTicket.id;
    const t = setTimeout(() => {
      // Bail if user switched tickets before debounce fired
      if (selectedTicketRef.current?.id !== tid) return;
      try { localStorage.setItem(`draft_reply_${tid}`, reply); } catch {}
    }, 800);
    return () => clearTimeout(t);
  }, [reply, selectedTicket?.id]);

  // Collision detection + ticket socket events
  useEffect(() => {
    if (!socket || !selectedTicket) return;
    socket.emit('viewing_ticket', { ticketId: selectedTicket.id });

    const onAgentViewing = ({ ticketId, agentId, name }) => {
      if (ticketId !== selectedTicketRef.current?.id) return;
      setViewingAgents(v => v.some(a => a.agentId === agentId) ? v : [...v, { agentId, name }]);
    };
    const onLeftTicket = ({ ticketId, agentId }) => {
      if (ticketId !== selectedTicketRef.current?.id) return;
      setViewingAgents(v => v.filter(a => a.agentId !== agentId));
    };

    socket.on('agent_viewing', onAgentViewing);
    socket.on('left_ticket', onLeftTicket);

    return () => {
      socket.emit('left_ticket', { ticketId: selectedTicket.id });
      socket.off('agent_viewing', onAgentViewing);
      socket.off('left_ticket', onLeftTicket);
      setViewingAgents([]);
    };
  }, [socket, selectedTicket?.id]);

  useEffect(() => {
    if (!socket) return;
    const onAssigned = () => loadTickets();
    const onReply = ({ ticketId, newMessage }) => {
      setUnreadTickets(s => new Set([...s, ticketId]));
      if (selectedTicketRef.current?.id === ticketId && newMessage) {
        setTicketMessages(m => [...m, newMessage]);
      }
      loadTickets();
    };
    const onEscalated = ({ ticketId, subject, oldPriority, newPriority }) => {
      toast(`#${ticketId} auto-escalated: ${oldPriority} → ${newPriority}`, { icon: '⬆️' });
      loadTickets();
    };
    // When an admin saves a plan change, the open ticket's customer plan
    // flags (allow_calls / agent_can_initiate_call / chat_limit / etc.) may
    // have shifted underneath us. Re-fetch the active ticket so the Call /
    // Chat affordances re-render against fresh data — without forcing the
    // agent to navigate away and back.
    const onPlanChanged = () => {
      const open = selectedTicketRef.current;
      if (!open?.id) return;
      getAgentTicketDetail(open.id).then(res => {
        if (selectedTicketRef.current?.id !== open.id) return; // user switched tickets while in flight
        setSelectedTicket(res.data.ticket);
      }).catch(() => {});
    };

    socket.on('ticket_assigned', onAssigned);
    socket.on('ticket_customer_reply', onReply);
    socket.on('ticket_escalated', onEscalated);
    socket.on('plan_changed', onPlanChanged);
    return () => {
      socket.off('ticket_assigned', onAssigned);
      socket.off('ticket_customer_reply', onReply);
      socket.off('ticket_escalated', onEscalated);
      socket.off('plan_changed', onPlanChanged);
    };
  }, [socket, loadTickets]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [ticketMessages]);

  const allTags = [...new Set(tickets.flatMap(t => (Array.isArray(t.tags) ? t.tags : [])))];

  const displayedTickets = tickets.filter(t => {
    if (filterPriority && t.priority !== filterPriority) return false;
    if (filterTag && !(Array.isArray(t.tags) && t.tags.includes(filterTag))) return false;
    if (search && !t.subject?.toLowerCase().includes(search.toLowerCase()) && !t.customer_name?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  ticketsRef.current = displayedTickets;

  const handleTicketUpdate = async (ticketId, data) => {
    // Closing a ticket must include a final message — open the modal instead of
    // silently flipping the status. Other updates pass through unchanged.
    if (data.status === 'closed') {
      const t = tickets.find(x => x.id === ticketId) || (selectedTicket?.id === ticketId ? selectedTicket : null);
      setCloseTarget(t || { id: ticketId, subject: '' });
      setCloseMessage('');
      return;
    }
    try {
      const res = await updateTicket(ticketId, data);
      toast.success('Updated');
      if (selectedTicket?.id === ticketId) {
        setSelectedTicket(prev => ({ ...prev, ...res.data.ticket }));
      }
      loadTickets();
    } catch { toast.error('Failed to update'); }
  };

  const confirmCloseTicket = async () => {
    if (!closeTarget) return;
    const msg = closeMessage.trim();
    if (msg.length < 5) {
      toast.error('Closing statement must be at least 5 characters');
      return;
    }
    setClosingTicket(true);
    try {
      // Send the closing statement as the final agent reply, then flip status to closed.
      await replyToTicket(closeTarget.id, { message: msg });
      await updateTicket(closeTarget.id, { status: 'closed' });
      toast.success('Ticket closed');
      if (selectedTicket?.id === closeTarget.id) setSelectedTicket(null);
      setCloseTarget(null);
      setCloseMessage('');
      loadTickets();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to close ticket');
    } finally {
      setClosingTicket(false);
    }
  };

  const handleBulkAction = async (action, value) => {
    if (!selectedIds.size) return;
    setBulkLoading(true);
    try {
      await bulkUpdateAgentTickets({ ticket_ids: [...selectedIds], action, ...(value ? { value } : {}) });
      toast.success(`Updated ${selectedIds.size} ticket(s)`);
      setSelectedIds(new Set());
      if (selectedTicket && selectedIds.has(selectedTicket.id)) setSelectedTicket(null);
      loadTickets();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Bulk action failed');
    } finally {
      setBulkLoading(false);
    }
  };

  const toggleSelectTicket = (e, ticketId) => {
    e.stopPropagation();
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(ticketId) ? next.delete(ticketId) : next.add(ticketId);
      return next;
    });
  };

  const insertMarkdown = (wrap, prefix) => {
    const el = replyRef.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const text = reply;
    if (wrap) {
      const selected = text.slice(s, e) || 'text';
      const newText = text.slice(0, s) + wrap[0] + selected + wrap[1] + text.slice(e);
      setReply(newText);
    } else if (prefix) {
      const lineStart = text.lastIndexOf('\n', s - 1) + 1;
      const newText = text.slice(0, lineStart) + prefix + text.slice(lineStart);
      setReply(newText);
    }
    setTimeout(() => el.focus(), 0);
  };

  const handleReply = async (e, statusAfter) => {
    if (e?.preventDefault) e.preventDefault();
    if (sendingReply) return; // ignore a second submit while one is in flight
    if (!selectedTicket) return;
    // Closing goes through the closing-statement modal (consistent with the
    // other Close action + guarantees the customer gets a proper closing note).
    // Carry whatever's already typed into the modal so it isn't lost. Checked
    // BEFORE the empty-text guard so you can close with just the modal's note.
    if (statusAfter === 'closed') {
      setCloseMessage(reply.trim());
      setCloseTarget(selectedTicket);
      return;
    }
    if (!reply.trim() && pendingFiles.length === 0) return;
    setSendingReply(true);
    try {
      const uploadedIds = [];
      for (const file of pendingFiles) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('ref_type', 'ticket');
        fd.append('ref_id', selectedTicket.id);
        const up = await uploadAttachment(fd);
        const attId = up?.data?.attachment?.id;
        if (attId) uploadedIds.push(attId);
      }
      if (reply.trim()) {
        // Pass the just-uploaded attachment IDs so the reply notification email
        // attaches the files for the customer + CC recipients.
        const res = await replyToTicket(selectedTicket.id, { message: reply, attachmentIds: uploadedIds });
        setTicketMessages(m => [...m, res.data.message]);
      }
      if (statusAfter && statusAfter !== selectedTicket.status) {
        try {
          await updateTicket(selectedTicket.id, { status: statusAfter });
          toast.success(`Sent & marked ${statusAfter}`);
        } catch { toast.error(`Sent, but failed to change status`); }
      }
      localStorage.removeItem(`draft_reply_${selectedTicket.id}`);
      setReply('');
      setPendingFiles([]);
      getAgentTicketDetail(selectedTicket.id).then(r => setSelectedTicket(r.data.ticket)).catch(() => {});
      getAttachments('ticket', selectedTicket.id).then(r => setTicketAttachments(r.data.attachments || [])).catch(() => {});
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send reply');
    } finally {
      setSendingReply(false);
    }
  };

  // Drill into another ticket from the Customer History panel, remembering the
  // ticket you were on so a "← Back to #X" button can bring you straight back.
  const jumpToTicket = (t) => {
    if (!t) return;
    if (selectedTicket && t.id !== selectedTicket.id) setHistoryFromTicket(selectedTicket);
    setSelectedTicket(t);
  };
  // Normal (non-history) selection — clears any pending "back" breadcrumb.
  const selectTicket = (t) => { setHistoryFromTicket(null); setSelectedTicket(t); };
  const returnFromHistory = () => {
    if (!historyFromTicket) return;
    const target = historyFromTicket;
    setHistoryFromTicket(null);
    setSelectedTicket(target);
  };

  const applyMacro = async (actions) => {
    for (const action of actions) {
      if (action.type === 'reply') {
        setReply(r => r ? r + '\n' + action.value : action.value);
      } else if (action.type === 'status' && selectedTicket) {
        await handleTicketUpdate(selectedTicket.id, { status: action.value });
      } else if (action.type === 'tag' && selectedTicket) {
        const current = Array.isArray(selectedTicket.tags) ? selectedTicket.tags : [];
        if (!current.includes(action.value)) await handleTicketUpdate(selectedTicket.id, { tags: [...current, action.value] });
      }
    }
  };

  const showBulkBar = selectedIds.size > 0 && !selectedTicket;

  return (
    <Layout>
      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
          onClick={() => setLightboxSrc(null)}
          onKeyDown={e => e.key === 'Escape' && setLightboxSrc(null)}
          tabIndex={-1}
        >
          <button onClick={() => setLightboxSrc(null)} className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors">
            <X className="w-8 h-8" />
          </button>
          <img
            src={lightboxSrc}
            alt="Attachment"
            className="max-w-full max-h-[90vh] rounded-lg object-contain shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}

      {showCreate && (
        <CreateTicketModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); loadTickets(); }} />
      )}
      {reassignTarget && (
        <ReassignModal ticket={reassignTarget} onClose={() => setReassignTarget(null)} />
      )}
      {mergeTarget && (
        <MergeModal ticket={mergeTarget} onClose={() => setMergeTarget(null)} onMerged={(targetId) => { setMergeTarget(null); setSelectedTicket(null); loadTickets(); toast.success(`Redirecting to ticket #${targetId}`); }} />
      )}
      {closeTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="text-base font-semibold text-gray-800">Close Ticket #{closeTarget.id}</h3>
                <p className="text-xs text-gray-500 mt-0.5">A closing statement is required and will be sent to the customer.</p>
              </div>
              <button onClick={() => !closingTicket && setCloseTarget(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            {closeTarget.subject && (
              <p className="text-xs text-gray-500 mb-2 truncate" title={closeTarget.subject}>{closeTarget.subject}</p>
            )}
            <textarea
              autoFocus
              className="input w-full text-sm resize-y"
              style={{ minHeight: '110px', maxHeight: '240px' }}
              rows={4}
              placeholder="Thanks for reaching out. We've resolved your issue by… (this will be sent to the customer and the ticket will be closed)"
              value={closeMessage}
              onChange={e => setCloseMessage(e.target.value)}
              disabled={closingTicket}
              spellCheck={true}
              autoCorrect="on"
              autoCapitalize="sentences"
              lang="en"
            />
            <div className="flex items-center justify-end gap-2 mt-3">
              <button onClick={() => setCloseTarget(null)} disabled={closingTicket} className="btn-secondary py-2 px-3 text-sm">
                Cancel
              </button>
              <button
                onClick={confirmCloseTicket}
                disabled={closingTicket || closeMessage.trim().length < 5}
                className="btn-primary py-2 px-4 text-sm flex items-center gap-1.5 disabled:opacity-50"
              >
                <CheckCircle className="w-3.5 h-3.5" /> {closingTicket ? 'Closing…' : 'Send & Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating bulk action bar */}
      {showBulkBar && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white rounded-2xl shadow-2xl px-5 py-3 flex items-center gap-3 min-w-max">
          <span className="text-sm font-semibold">{selectedIds.size} selected</span>
          <div className="w-px h-4 bg-gray-600" />
          <button
            onClick={() => handleBulkAction('close')}
            disabled={bulkLoading}
            className="text-sm text-green-300 hover:text-green-100 transition-colors font-medium"
          >
            Close All
          </button>
          <select
            className="text-sm bg-gray-800 text-white border border-gray-600 rounded-lg px-2 py-1 cursor-pointer"
            value=""
            onChange={e => e.target.value && handleBulkAction('set_priority', e.target.value)}
            disabled={bulkLoading}
          >
            <option value="">Set Priority…</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
          </select>
          <select
            className="text-sm bg-gray-800 text-white border border-gray-600 rounded-lg px-2 py-1 cursor-pointer"
            value=""
            onChange={e => e.target.value && handleBulkAction('set_status', e.target.value)}
            disabled={bulkLoading}
          >
            <option value="">Set Status…</option>
            {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
          </select>
          <button onClick={() => setSelectedIds(new Set())} className="p-1 text-gray-400 hover:text-red-300">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-800">Tickets</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {ticketScope === 'mine'
              ? `${tickets.length} ticket${tickets.length !== 1 ? 's' : ''} assigned to you`
              : `${tickets.length} ticket${tickets.length !== 1 ? 's' : ''} total · read-only for unassigned`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden text-xs font-semibold">
            <button
              onClick={() => { setTicketScope('mine'); setSelectedTicket(null); setSelectedIds(new Set()); }}
              className={clsx('px-3 py-2 transition-colors', ticketScope === 'mine' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50')}
            >
              My Tickets
            </button>
            <button
              onClick={() => { setTicketScope('all'); setSelectedTicket(null); setSelectedIds(new Set()); }}
              className={clsx('px-3 py-2 transition-colors', ticketScope === 'all' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50')}
            >
              All Tickets
            </button>
          </div>

          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
            <button onClick={() => setViewMode('list')} className={clsx('p-2 transition-colors', viewMode === 'list' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50')} title="List view">
              <ListIcon className="w-4 h-4" />
            </button>
            <button onClick={() => setViewMode('kanban')} className={clsx('p-2 transition-colors', viewMode === 'kanban' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-50')} title="Kanban view">
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
          <button onClick={() => setShowCreate(true)} className="btn-primary text-sm flex items-center gap-1.5">
            <Plus className="w-4 h-4" /> New Ticket
          </button>
          <button onClick={loadTickets} className="hidden lg:inline-flex btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Select value={filterStatus} onChange={setFilterStatus} options={STATUSES.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} placeholder="All Status" className="w-36" />
        <Select value={filterPriority} onChange={setFilterPriority} options={PRIORITIES.map(p => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }))} placeholder="All Priority" className="w-36" />
        <Select value={filterRequestType} onChange={setFilterRequestType} options={REQUEST_TYPES.map(t => ({ value: t, label: t }))} placeholder="All Types" className="w-44" />
        <Select value={filterGwEdition} onChange={setFilterGwEdition} options={GW_EDITIONS.map(e => ({ value: e, label: e }))} placeholder="All Editions" className="w-44" />
        {allTags.length > 0 && (
          <Select value={filterTag} onChange={setFilterTag} options={allTags.map(t => ({ value: t, label: t }))} placeholder="All Tags" className="w-36" />
        )}
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input className="input pl-8 py-1.5 text-sm w-full" placeholder="Search by subject or customer..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {selectedTicket && (
          <button onClick={() => setSelectedTicket(null)} className="btn-secondary text-xs py-1.5 flex items-center gap-1.5">
            <X className="w-3.5 h-3.5" /> Back to list
          </button>
        )}
      </div>

      {loading ? (
        <SkeletonCards count={6} />
      ) : viewMode === 'kanban' && !selectedTicket ? (
        <KanbanBoard tickets={displayedTickets} onSelect={selectTicket} unreadTickets={unreadTickets} />
      ) : (
        <div className={clsx('flex gap-4', selectedTicket ? 'items-start' : '')}>
          {/* Ticket list */}
          <div className={clsx('transition-all duration-200', selectedTicket ? 'w-80 flex-shrink-0' : 'flex-1')}>
            {displayedTickets.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
                <Ticket className="w-12 h-12 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-medium">No tickets found</p>
                <p className="text-xs mt-1 opacity-70">Try changing your filters</p>
              </div>
            ) : (
              <div className={clsx(
                selectedTicket
                  ? 'space-y-2 max-h-[calc(100vh-220px)] overflow-y-auto pr-0.5'
                  : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'
              )}>
                {displayedTickets.map(t => {
                  const hasUnread = unreadTickets.has(t.id);
                  const tags = Array.isArray(t.tags) ? t.tags : [];
                  const isSelected = selectedIds.has(t.id);
                  return (
                    <div key={t.id} onClick={() => { setSelectedIds(new Set()); selectTicket(t); }}
                      className={clsx(
                        'relative bg-white rounded-xl border p-4 cursor-pointer transition-all overflow-hidden',
                        PRIORITY_STRIPE[t.priority],
                        ageClass(t.created_at, t.status),
                        t.sla_breached && t.status !== 'closed' && 'ring-2 ring-red-300 bg-red-50/40',
                        selectedTicket?.id === t.id ? 'border-blue-400 ring-1 ring-blue-200 shadow-md' :
                        isSelected ? 'border-blue-300 bg-blue-50/40 shadow-sm' :
                        hasUnread ? 'border-blue-300 shadow-sm hover:shadow-md' : 'border-gray-200 hover:border-blue-200 hover:shadow-sm'
                      )}>
                      {hasUnread && (
                        <span className="absolute top-3 right-3 flex items-center gap-1 text-xs font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" /> New reply
                        </span>
                      )}
                      {/* Bulk checkbox — only in full list view (no ticket selected) */}
                      {!selectedTicket && (
                        <div
                          onClick={e => toggleSelectTicket(e, t.id)}
                          className={clsx(
                            'absolute top-3 left-3 w-4 h-4 rounded border-2 flex items-center justify-center transition-all z-10',
                            isSelected ? 'bg-blue-600 border-blue-600' : 'border-gray-300 hover:border-blue-400 bg-white',
                            selectedIds.size === 0 && 'opacity-0 group-hover:opacity-100'
                          )}
                          title={isSelected ? 'Deselect' : 'Select for bulk action'}
                        >
                          {isSelected && <CheckCircle className="w-3 h-3 text-white" />}
                        </div>
                      )}
                      <div className={clsx('flex items-start gap-2', hasUnread ? 'pr-24' : 'pr-4', !selectedTicket && selectedIds.size > 0 ? 'pl-6' : '')}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="text-xs text-gray-400 font-mono">#{t.id}</span>
                            <PriorityBadge priority={t.priority} />
                            {t.plan_name && <PlanBadge plan={t.plan_name} />}
                          </div>
                          <p className="text-sm font-semibold text-gray-800 truncate">{t.subject}</p>
                          <p className="text-xs text-gray-500 mt-0.5 truncate">{t.customer_name} · {t.customer_domain}</p>
                        </div>
                        {!hasUnread && <TicketStatusBadge status={t.status} />}
                      </div>
                      {/* GW badges */}
                      {(t.request_type || t.gw_edition) && !selectedTicket && (
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          {t.request_type && <RequestTypeBadge type={t.request_type} />}
                          {t.gw_edition && (
                            <span className="inline-flex items-center gap-1 text-xs text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded-full">
                              <Globe className="w-2.5 h-2.5" /> {t.gw_edition}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Pending reason */}
                      {t.status === 'pending' && t.pending_reason && (
                        <div className="mt-1.5">
                          <PendingReasonBadge reason={t.pending_reason} />
                        </div>
                      )}
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        <SlaCountdown ticket={t} compact />
                        {tags.slice(0, 2).map(tag => (
                          <span key={tag} className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded-full">{tag}</span>
                        ))}
                      </div>
                      {!selectedTicket && (
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          {t.is_mine && t.status !== 'closed' && (
                            <>
                              <button onClick={e => { e.stopPropagation(); handleTicketUpdate(t.id, { status: 'closed' }); }} className="btn-secondary text-xs py-1 flex items-center gap-1">
                                <CheckCircle className="w-3.5 h-3.5" /> Close
                              </button>
                              <button onClick={e => { e.stopPropagation(); setReassignTarget(t); }} className="text-xs px-2.5 py-1 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 font-medium transition-colors">
                                Reassign
                              </button>
                            </>
                          )}
                          {!t.is_mine && (
                            <span className="text-xs text-gray-400 flex items-center gap-0.5">
                              <Eye className="w-3 h-3" /> View only
                            </span>
                          )}
                          <span className="text-xs text-gray-400 ml-auto" title={fullDate(t.created_at)}>{timeAgo(t.created_at)}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Detail panel — overflow-y-auto so user can scroll if messages + reply grow tall */}
          {selectedTicket && (
            <div className="flex-1 bg-white rounded-xl border border-gray-200 shadow-sm overflow-y-auto flex flex-col" style={{ height: 'calc(100vh - 220px)' }}>
              {/* Back breadcrumb — shown after drilling into a ticket from Customer
                  History. Sticky so it stays visible even when the panel is
                  scrolled to the bottom (where the history list lives). */}
              {historyFromTicket && historyFromTicket.id !== selectedTicket.id && (
                <button
                  onClick={returnFromHistory}
                  className="sticky top-0 z-20 flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white border-b border-blue-700 text-xs font-medium hover:bg-blue-700 transition-colors w-full shadow-sm"
                >
                  <ChevronRight className="w-3.5 h-3.5 rotate-180" />
                  Back to #{historyFromTicket.id}{historyFromTicket.subject ? ` · ${historyFromTicket.subject}` : ''}
                </button>
              )}
              {/* Read-only banner */}
              {!selectedTicket.is_mine && (
                <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-700 font-medium">
                  <Eye className="w-3.5 h-3.5 flex-shrink-0" />
                  Read-only — you are not assigned to this ticket. Only the assigned agent can reply or make changes.
                </div>
              )}

              {/* Header */}
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-xs text-gray-400 font-mono">#{selectedTicket.id}</p>
                      {viewingAgents.length > 0 && (
                        <div className="flex items-center gap-1">
                          {viewingAgents.map(a => (
                            <span key={a.agentId} title={`${a.name} is viewing`} className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded-full">
                              <Eye className="w-2.5 h-2.5" /> {a.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="text-base font-bold text-gray-800 truncate">{selectedTicket.subject}</p>
                    <p className="text-xs text-gray-500">{selectedTicket.customer_name} · {selectedTicket.customer_domain}</p>
                    <TicketContextStrip ticket={selectedTicket} history={customerHistory} onJump={jumpToTicket} />
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={toggleLayoutLock}
                      title={layoutLocked ? 'Layout locked — click to allow resizing panes' : 'Lock layout (prevents accidental resize of message / reply panes)'}
                      className={clsx('p-1.5 rounded-lg border transition-colors', layoutLocked
                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                        : 'border-gray-200 text-gray-400 hover:text-gray-600 hover:bg-gray-100')}
                    >
                      <Lock className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setSelectedTicket(null)} className="text-gray-400 hover:text-gray-600 p-1.5">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Status/Priority controls */}
                <div className="flex flex-wrap items-center gap-2">
                  {selectedTicket.is_mine ? (
                    <>
                      <Select value={selectedTicket.status} onChange={v => handleTicketUpdate(selectedTicket.id, { status: v })} options={STATUSES.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} placeholder="" className="w-28" />
                      <Select value={selectedTicket.priority} onChange={v => handleTicketUpdate(selectedTicket.id, { priority: v })} options={PRIORITIES.map(p => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }))} placeholder="" className="w-28" />
                    </>
                  ) : (
                    <>
                      <span className="text-xs px-2 py-1 bg-white border border-gray-200 rounded-lg text-gray-600 capitalize">{selectedTicket.status}</span>
                      <span className="text-xs px-2 py-1 bg-white border border-gray-200 rounded-lg text-gray-600 capitalize">{selectedTicket.priority}</span>
                    </>
                  )}
                  {selectedTicket.assigned_agent_id && (
                    <span className="text-xs text-gray-500 px-2 py-1 bg-white border border-gray-200 rounded-lg">
                      {agentList.find(a => a.id === selectedTicket.assigned_agent_id)?.name || 'Assigned'}
                    </span>
                  )}
                  {selectedTicket.is_mine && selectedTicket.status !== 'closed' && (
                    <button
                      onClick={() => window.dispatchEvent(new CustomEvent('dsp:agent-call-customer', { detail: {
                        customerId: selectedTicket.customer_id,
                        customerName: selectedTicket.customer_name,
                        ticketId: selectedTicket.id,
                        ticketSubject: selectedTicket.subject,
                      } }))}
                      title="Call customer (requires customer to be online + on a paid plan)"
                      className="text-xs px-2 py-1 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 font-medium flex items-center gap-1"
                    >
                      <Phone className="w-3 h-3" /> Call
                    </button>
                  )}
                  {selectedTicket.is_mine && selectedTicket.status !== 'closed' && (
                    <button onClick={() => setReassignTarget(selectedTicket)} className="text-xs px-2 py-1 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 font-medium">Reassign</button>
                  )}
                  {selectedTicket.is_mine && (
                    <button onClick={() => setMergeTarget(selectedTicket)} className="text-xs px-2 py-1 rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 font-medium flex items-center gap-1">
                      <GitMerge className="w-3 h-3" /> Merge
                    </button>
                  )}
                </div>

                {/* Pending reason selector */}
                {selectedTicket.is_mine && selectedTicket.status === 'pending' && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 font-medium flex-shrink-0">Pending reason:</span>
                    <select
                      className="input text-xs py-1 flex-1 max-w-xs"
                      value={selectedTicket.pending_reason || ''}
                      onChange={e => handleTicketUpdate(selectedTicket.id, { pending_reason: e.target.value || null })}
                    >
                      <option value="">Select reason…</option>
                      {PENDING_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                )}

                {/* GW info row */}
                {(selectedTicket.request_type || selectedTicket.gw_edition || selectedTicket.affected_users) && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {selectedTicket.request_type && <RequestTypeBadge type={selectedTicket.request_type} />}
                    {selectedTicket.gw_edition && (
                      <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-white border border-gray-200 px-2 py-0.5 rounded-full">
                        <Globe className="w-2.5 h-2.5 text-blue-500" /> {selectedTicket.gw_edition}
                      </span>
                    )}
                    {selectedTicket.affected_users > 0 && (
                      <span className={clsx('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium',
                        selectedTicket.affected_users >= 25 ? 'text-red-700 bg-red-50 border-red-200' :
                        selectedTicket.affected_users >= 10 ? 'text-amber-700 bg-amber-50 border-amber-200' :
                        'text-gray-600 bg-gray-50 border-gray-200'
                      )}>
                        {selectedTicket.affected_users} user{selectedTicket.affected_users !== 1 ? 's' : ''} affected
                      </span>
                    )}
                  </div>
                )}

                {/* Meta row: SLA countdown, first response, tags */}
                <div className="flex flex-wrap items-center gap-2">
                  <SlaCountdown ticket={selectedTicket} />
                  <FirstResponseBadge ticket={selectedTicket} />
                  {selectedTicket.status === 'pending' && selectedTicket.pending_reason && (
                    <PendingReasonBadge reason={selectedTicket.pending_reason} />
                  )}
                  <TagsDisplay tags={Array.isArray(selectedTicket.tags) ? selectedTicket.tags : []} />
                </div>

                {/* Tags editor */}
                {selectedTicket.is_mine && (
                  <TagsInput
                    tags={Array.isArray(selectedTicket.tags) ? selectedTicket.tags : []}
                    onChange={newTags => handleTicketUpdate(selectedTicket.id, { tags: newTags })}
                  />
                )}

              </div>

              {/* Attachments */}
              {ticketAttachments.length > 0 && (
                <div className="px-4 py-3 border-t border-gray-100 bg-gray-50/50">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Attachments ({ticketAttachments.length})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {ticketAttachments.map(att => {
                      const isImage = att.mime_type?.startsWith('image/');
                      return (
                        <div key={att.id} className={clsx('border border-gray-200 rounded-lg overflow-hidden', isImage ? 'w-24' : 'flex items-center gap-1.5 bg-white px-2.5 py-1.5')}>
                          {isImage ? (
                            <div className="relative group">
                              <img
                                src={getAttachmentDownloadUrl(att.id)}
                                alt={att.original_name}
                                className="w-24 h-16 object-cover cursor-pointer"
                                onClick={() => setLightboxSrc(getAttachmentDownloadUrl(att.id))}
                              />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5">
                                <button onClick={() => setLightboxSrc(getAttachmentDownloadUrl(att.id))} className="p-1 bg-white rounded text-gray-700 hover:text-blue-600" title="View">
                                  <Eye className="w-3 h-3" />
                                </button>
                                <a href={getAttachmentDownloadUrl(att.id)} download className="p-1 bg-white rounded text-gray-700 hover:text-blue-600" title="Download">
                                  <Download className="w-3 h-3" />
                                </a>
                                <button onClick={async () => { try { await deleteAttachment(att.id); setTicketAttachments(a => a.filter(x => x.id !== att.id)); } catch { toast.error('Failed to delete'); } }} className="p-1 bg-white rounded text-red-400 hover:text-red-600">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                              <p className="text-xs text-gray-500 truncate px-1 py-0.5 bg-white">{att.original_name}</p>
                            </div>
                          ) : (
                            <>
                              <Paperclip className="w-3 h-3 text-gray-400 flex-shrink-0" />
                              <span className="text-xs text-gray-700 truncate max-w-[120px]">{att.original_name}</span>
                              <a href={getAttachmentDownloadUrl(att.id)} download className="text-blue-500 hover:text-blue-700 ml-1">
                                <Download className="w-3 h-3" />
                              </a>
                              <button onClick={async () => { try { await deleteAttachment(att.id); setTicketAttachments(a => a.filter(x => x.id !== att.id)); } catch { toast.error('Failed to delete'); } }} className="text-red-400 hover:text-red-600 ml-0.5">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="flex border-b border-gray-100 bg-white">
                <button onClick={() => setActiveTab('messages')} className={clsx('px-4 py-2.5 text-xs font-semibold transition-colors border-b-2', activeTab === 'messages' ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700')}>
                  Messages ({ticketMessages.length})
                </button>
                <button onClick={() => setActiveTab('notes')} className={clsx('px-4 py-2.5 text-xs font-semibold transition-colors border-b-2 flex items-center gap-1.5', activeTab === 'notes' ? 'border-amber-500 text-amber-700' : 'border-transparent text-gray-500 hover:text-gray-700')}>
                  <Lock className="w-3 h-3" /> Internal Notes
                </button>
              </div>

              {activeTab === 'notes' ? (
                // Fixed height + flex-shrink-0 so the notes pane stays usable on
                // short viewports. Without this the wrapper inherits "remaining"
                // height from a parent that's already scrolling, which collapses
                // to ~50px on small screens and clips both the notes list and
                // the "Add a note" textarea. 500px matches the messages pane.
                <div className="flex-shrink-0" style={{ height: '500px', minHeight: '300px' }}>
                  <InternalNotesTab ticketId={selectedTicket.id} />
                </div>
              ) : (
                <>
                  {/* Conversation search */}
                  <div className="px-4 py-2 border-b border-gray-100 bg-white flex items-center gap-2 flex-shrink-0">
                    <Search className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    <input
                      type="text"
                      placeholder="Search within this conversation…"
                      value={convSearch}
                      onChange={e => setConvSearch(e.target.value)}
                      className="input text-xs py-1 flex-1"
                    />
                    {convSearch && (
                      <button type="button" onClick={() => setConvSearch('')} className="text-xs text-gray-400 hover:text-gray-600">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {/* Messages — corner-resize when unlocked; locked = no resize. Height is persisted. */}
                  <div
                    ref={msgPaneRef}
                    className={clsx('overflow-y-auto p-5 space-y-4 bg-gray-50/40 flex-shrink-0', layoutLocked ? 'resize-none' : 'resize-y')}
                    style={{ height: '500px', minHeight: '200px' }}
                  >
                    {selectedTicket.description && (!convSearch || selectedTicket.description.toLowerCase().includes(convSearch.toLowerCase())) && (
                      <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                          <User className="w-4 h-4 text-gray-600" />
                        </div>
                        <div className="flex flex-col items-start max-w-lg">
                          <div className="px-4 py-2.5 rounded-xl rounded-tl-none text-sm bg-white border border-gray-200 text-gray-800 whitespace-pre-wrap break-words shadow-sm">
                            {renderMarkdown(selectedTicket.description)}
                          </div>
                          <p className="text-xs text-gray-400 mt-1">{selectedTicket.customer_name} · original message</p>
                        </div>
                      </div>
                    )}
                    {ticketMessages
                      .filter(m => !convSearch || m.message?.toLowerCase().includes(convSearch.toLowerCase()))
                      .map(m => {
                      const isAgent = m.sender_role === 'agent' || m.sender_role === 'admin';
                      const isSystem = m.message?.startsWith('[');
                      if (isSystem) return (
                        <div key={m.id} className="flex justify-center">
                          <div className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-amber-50 border border-amber-200 text-xs text-amber-700 max-w-md">
                            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                            <span>{m.message}</span>
                          </div>
                        </div>
                      );
                      return (
                        <div key={m.id} className={clsx('flex gap-3', isAgent ? 'flex-row-reverse' : 'flex-row')}>
                          <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0', isAgent ? 'bg-blue-100' : 'bg-gray-200')}>
                            {isAgent ? <Headphones className="w-4 h-4 text-blue-600" /> : <User className="w-4 h-4 text-gray-600" />}
                          </div>
                          <div className={clsx('max-w-lg flex flex-col', isAgent ? 'items-end' : 'items-start')}>
                            <div className={clsx('px-4 py-2.5 rounded-xl text-sm shadow-sm whitespace-pre-wrap break-words', isAgent ? 'bg-blue-600 text-white rounded-tr-none' : 'bg-white border border-gray-200 text-gray-800 rounded-tl-none')}>
                              {renderMarkdown(m.message)}
                            </div>
                            <p className="text-xs text-gray-400 mt-1" title={fullDate(m.created_at)}>{m.sender_name} · {timeAgo(m.created_at)}</p>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={bottomRef} />
                  </div>

                  {/* Reply — only for assigned agent */}
                  {!selectedTicket.is_mine ? (
                    <div className="border-t border-gray-100 p-3 text-center text-xs text-gray-400 bg-white flex items-center justify-center gap-1.5 flex-shrink-0">
                      <Eye className="w-3.5 h-3.5" /> Read-only view
                    </div>
                  ) : selectedTicket.status !== 'closed' ? (
                    <form onSubmit={handleReply} className="border-t border-gray-100 p-3 bg-white space-y-2 flex-shrink-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <CannedPicker
                          onSelect={text => setReply(r => r ? r + ' ' + text : text)}
                          context={{
                            customer_name: selectedTicket.customer_name,
                            ticket_id: selectedTicket.id,
                            gw_edition: selectedTicket.gw_edition || '',
                            domain: selectedTicket.customer_domain || '',
                            agent_name: currentUser.name || '',
                          }}
                        />
                        <MacrosPicker onApply={applyMacro} />
                        <TemplatesPicker
                          context={{
                            customer_name: selectedTicket.customer_name,
                            ticket_id: selectedTicket.id,
                            gw_edition: selectedTicket.gw_edition || '',
                            domain: selectedTicket.customer_domain || '',
                            agent_name: currentUser.name || '',
                          }}
                          onApply={(resolvedText) => setReply(r => r ? r + '\n' + resolvedText : resolvedText)}
                        />
                        <button type="button" onClick={() => setShowMarkdown(m => !m)} className={clsx('flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors', showMarkdown ? 'bg-blue-50 text-blue-700 border-blue-200' : 'text-gray-500 border-gray-200 hover:border-gray-300')}>
                          <Bold className="w-3 h-3" /> MD
                        </button>
                        <input type="file" ref={fileInputRef} className="hidden" multiple accept="image/*,.pdf,.doc,.docx,.txt,.csv,.zip,.log,.xlsx,.xls" onChange={e => {
                          const ALLOWED = /\.(png|jpe?g|gif|webp|svg|pdf|docx?|txt|csv|zip|log|xlsx?)$/i;
                          const files = Array.from(e.target.files).filter(f => {
                            if (f.size > 25 * 1024 * 1024) { toast.error(`${f.name} too large (max 25MB)`); return false; }
                            if (!ALLOWED.test(f.name)) { toast.error(`${f.name}: file type not allowed`); return false; }
                            return true;
                          });
                          setPendingFiles(p => [...p, ...files]);
                          e.target.value = '';
                        }} />
                        <button type="button" onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border font-medium text-gray-500 border-gray-200 hover:border-gray-300 transition-colors">
                          <Paperclip className="w-3 h-3" /> Attach
                        </button>
                      </div>
                      {pendingFiles.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {pendingFiles.map((f, i) => (
                            <div key={i} className="flex items-center gap-1 bg-blue-50 border border-blue-200 rounded px-2 py-0.5 text-xs text-blue-700">
                              <Paperclip className="w-2.5 h-2.5" />
                              <span className="truncate max-w-[100px]">{f.name}</span>
                              <button type="button" onClick={() => setPendingFiles(p => p.filter((_, j) => j !== i))}><X className="w-2.5 h-2.5 hover:text-red-600" /></button>
                            </div>
                          ))}
                        </div>
                      )}
                      {showMarkdown && <MarkdownToolbar onInsert={insertMarkdown} />}
                      <ReplyAssistant
                        currentTicket={selectedTicket}
                        history={customerHistory}
                        replyText={reply}
                        templates={cannedList}
                        onUseTemplate={(t) => {
                          // Insert the canned body. Preserve existing draft by appending if
                          // the agent already started typing — feels less destructive than
                          // overwrite when they were halfway through a thought.
                          const body = t.body || t.content || '';
                          setReply(prev => (prev?.trim() && !body.startsWith(prev.trim()) ? prev + '\n\n' + body : body));
                          toast.success('Snippet inserted');
                        }}
                      />
                      <div className="flex gap-2">
                        <textarea
                          ref={setReplyRef}
                          className={clsx('input flex-1 text-sm', layoutLocked ? 'resize-none' : 'resize-y')}
                          style={{ minHeight: '90px', maxHeight: '600px' }}
                          rows={4}
                          placeholder="Type your reply…  (paste a screenshot with Ctrl+V · drag corner ↘ to resize)"
                          value={reply}
                          onChange={e => setReply(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleReply(e); } }}
                          spellCheck={true}
                          autoCorrect="on"
                          autoCapitalize="sentences"
                          lang="en"
                        />
                        <div className="flex flex-col gap-1.5 self-end">
                          <button type="submit" disabled={(!reply.trim() && pendingFiles.length === 0) || sendingReply} className="btn-primary py-2 px-4 flex items-center gap-1.5 justify-center">
                            <Send className="w-4 h-4" /> {sendingReply ? 'Sending…' : 'Send'}
                          </button>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={(ev) => handleReply(ev, 'pending')}
                              disabled={(!reply.trim() && pendingFiles.length === 0) || sendingReply}
                              title="Send reply and mark as Pending"
                              className="text-[11px] px-2 py-1 rounded-md bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 disabled:opacity-50 flex-1"
                            >
                              + Pending
                            </button>
                            <button
                              type="button"
                              onClick={(ev) => handleReply(ev, 'closed')}
                              disabled={sendingReply}
                              title="Close ticket — add a closing note for the customer"
                              className="text-[11px] px-2 py-1 rounded-md bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 disabled:opacity-50 flex-1"
                            >
                              + Close
                            </button>
                          </div>
                        </div>
                      </div>
                    </form>
                  ) : (
                    <div className="border-t border-gray-100 p-3 text-center text-xs text-gray-400 bg-white flex-shrink-0">Ticket is closed</div>
                  )}
                </>
              )}

              {/* Related tickets collapsible */}
              <div className="flex-shrink-0">
                <RelatedTicketsPanel ticketId={selectedTicket.id} customerId={selectedTicket.customer_id} onSelect={jumpToTicket} />
              </div>
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}
