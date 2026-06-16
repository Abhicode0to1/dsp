import { useEffect, useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import RowsPerPageSelect, { readStoredPageSize } from '../../components/common/RowsPerPageSelect';
import { PlanBadge } from '../../components/common/PlanBadge';
import { useSocket } from '../../contexts/SocketContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  getPendingChats, getMyAgentChats, convertChatToTicket,
  transferAgentChat, getAgentList, getAgentCustomerDetail,
  sendChatTranscript, getChatNotes, addChatNote, deleteChatNote,
  getAgentChatArchive, getAgentArchivedMessages,
} from '../../services/api';
import { timeAgo } from '../../utils/timeAgo';
import { renderMarkdown } from '../../utils/renderMarkdown';
import {
  MessageSquare, Headphones, RefreshCw, Send, User, X, Zap, Ticket,
  ArrowRightLeft, Clock, AlertTriangle, TrendingUp, TrendingDown,
  Minus, Star, CheckCheck, Check, Mail, Paperclip, Lock, Archive, Search, Phone,
} from 'lucide-react';
import CannedPicker from '../../components/common/CannedPicker';
import useImagePaste from '../../hooks/useImagePaste';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';
import toast from 'react-hot-toast';
import clsx from 'clsx';

// Lightweight tooltip — shows label below the wrapped element on hover.
// Children should be a single focusable element (button, link, etc).
function Tip({ label, children }) {
  return (
    <span className="relative group inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-2 py-0.5 rounded-md bg-gray-900 text-white text-[11px] font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 shadow-md"
      >
        {label}
      </span>
    </span>
  );
}

// ── Sentiment detector (simple keyword scoring) ───────────────────────────────
function detectSentiment(messages) {
  const text = messages.map(m => m.message || '').join(' ').toLowerCase();
  const pos = ['thank', 'great', 'perfect', 'awesome', 'excellent', 'love', 'happy', 'good', 'resolved'];
  const neg = ['terrible', 'awful', 'worst', 'angry', 'frustrated', 'useless', 'horrible', 'hate', 'bad', 'slow', 'broken', 'bug', 'error', 'problem'];
  let score = 0;
  pos.forEach(w => { if (text.includes(w)) score++; });
  neg.forEach(w => { if (text.includes(w)) score--; });
  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}

function SentimentBadge({ sentiment }) {
  if (!sentiment) return null;
  const cfg = {
    positive: { icon: <TrendingUp className="w-3 h-3" />,   cls: 'bg-green-50 text-green-700 border-green-200' },
    neutral:  { icon: <Minus className="w-3 h-3" />,         cls: 'bg-gray-50 text-gray-600 border-gray-200' },
    negative: { icon: <TrendingDown className="w-3 h-3" />,  cls: 'bg-red-50 text-red-700 border-red-200' },
  };
  const { icon, cls } = cfg[sentiment] || cfg.neutral;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${cls}`}>
      {icon} {sentiment}
    </span>
  );
}

// ── Chat activity timer ────────────────────────────────────────────────────────
// Shows how long the customer has been waiting since their last message.
// If agent sent the last message, shows total chat duration instead.
function ChatActivityTimer({ acceptedAt, messages }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (!acceptedAt) return null;

  const lastCustomerMsg = [...messages].reverse().find(m => m.sender_role === 'customer');
  const lastAgentMsg    = [...messages].reverse().find(m => m.sender_role === 'agent' || m.sender_role === 'admin');

  // Customer is waiting if their last message is more recent than the agent's last message
  const customerWaiting = lastCustomerMsg && (
    !lastAgentMsg || new Date(lastCustomerMsg.created_at) > new Date(lastAgentMsg.created_at)
  );

  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  };

  if (customerWaiting) {
    const waitMs = Date.now() - new Date(lastCustomerMsg.created_at).getTime();
    const urgent = waitMs > 3 * 60 * 1000;
    const cls = urgent ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200';
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border ${cls}`}>
        <AlertTriangle className="w-3 h-3" /> Customer waiting {fmt(waitMs)}
      </span>
    );
  }

  // Agent has last word — show chat duration
  const durationMs = Date.now() - new Date(acceptedAt).getTime();
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">
      <Clock className="w-3 h-3" /> {fmt(durationMs)}
    </span>
  );
}

// ── Customer context sidebar ──────────────────────────────────────────────────
function CustomerContext({ customerId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!customerId) return;
    getAgentCustomerDetail(customerId).then(r => setData(r.data)).catch(() => {});
  }, [customerId]);
  if (!data) return <div className="text-xs text-gray-400 p-3 text-center">Loading context…</div>;
  const { customer, tickets } = data;
  return (
    <div className="p-3 space-y-3 text-xs">
      <div className="space-y-1">
        <p className="font-semibold text-gray-700 text-sm">{customer.name}</p>
        <p className="text-gray-500">{customer.email}</p>
        <p className="text-gray-500">{customer.domain}</p>
        {customer.plan_name && <div className="mt-1"><PlanBadge plan={customer.plan_name} /></div>}
      </div>
      <div className="border-t border-gray-100 pt-2">
        <p className="font-semibold text-gray-600 mb-1.5">Recent Tickets</p>
        {tickets?.length === 0 && <p className="text-gray-400">No tickets</p>}
        {tickets?.slice(0, 4).map(t => (
          <div key={t.id} className="flex items-start gap-1.5 py-1 border-b border-gray-50 last:border-0">
            <span className="text-gray-400 font-mono w-8">#{t.id}</span>
            <span className="flex-1 text-gray-700 truncate">{t.subject}</span>
            <span className={clsx('flex-shrink-0 px-1.5 py-0.5 rounded-full font-medium', t.status === 'closed' ? 'bg-gray-100 text-gray-500' : 'bg-blue-50 text-blue-700')}>
              {t.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Transfer Chat Modal ───────────────────────────────────────────────────────
function TransferModal({ chat, agents, currentAgentId, socket, onClose, onOfferSent }) {
  const [targetId, setTargetId]  = useState('');
  const [note, setNote]          = useState('');
  const [saving, setSaving]      = useState(false);

  // Only show agents who are currently online AND aren't me — anyone else
  // either won't see the incoming chat ping or is the agent doing the
  // transfer in the first place.
  const eligible = agents.filter(a => a.is_online && Number(a.id) !== Number(currentAgentId));

  const submit = async (e) => {
    e.preventDefault();
    if (!targetId) return;
    setSaving(true);
    // Manual-accept flow: emit the offer over the socket and close the modal.
    // The receiving agent must explicitly accept; the parent listens for
    // chat_transfer_accepted / declined / timeout to react.
    const target = eligible.find(a => Number(a.id) === Number(targetId));
    socket?.emit('notify_chat_transfer', { chatId: chat.id, targetAgentId: parseInt(targetId), transferNote: note });
    onOfferSent({ chatId: chat.id, toAgentName: target?.name || 'agent' });
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-bold text-gray-800">Transfer Chat</h2>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Transfer to Agent *
              <span className="ml-1.5 text-xs font-normal text-gray-400">(online only)</span>
            </label>
            {eligible.length === 0 ? (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                No other agents are online right now. Try again once a colleague comes online.
              </div>
            ) : (
              <select className="input w-full text-sm" value={targetId} onChange={e => setTargetId(e.target.value)} required>
                <option value="">Select agent…</option>
                {eligible.map(a => (
                  <option key={a.id} value={a.id}>● {a.name}</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Handoff Note (optional)</label>
            <textarea
              className="input w-full text-sm resize-y"
              style={{ minHeight: '72px', maxHeight: '30vh' }}
              rows={3}
              placeholder="Context for the receiving agent…"
              value={note}
              onChange={e => setNote(e.target.value)}
              spellCheck={true}
              autoCorrect="on"
              autoCapitalize="sentences"
              lang="en"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving || !targetId || eligible.length === 0} className="btn-primary flex-1 justify-center flex items-center gap-1.5">
              <ArrowRightLeft className="w-4 h-4" /> {saving ? 'Sending offer…' : 'Send Transfer Offer'}
            </button>
          </div>
          {eligible.length > 0 && (
            <p className="text-[11px] text-gray-400 -mt-1">
              The other agent has to accept the offer before this chat moves to them.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

function ConvertToTicketModal({ chat, onClose, onConverted }) {
  const [subject, setSubject] = useState(`Chat with ${chat.customer_name || 'Customer'}`);
  const [notes, setNotes]     = useState('');
  const [saving, setSaving]   = useState(false);
  // `chat.status === 'closed'` means this convert was triggered from the Archive
  // tab on a chat that's already ended — we copy slightly different language so
  // the agent doesn't expect the customer to be on the other end live.
  const isLive = chat.status !== 'closed';

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await convertChatToTicket(chat.id, { subject, description: notes });
      toast.success(`Ticket #${res.data.ticket.id} created`);
      onConverted(res.data.ticket);
    } catch (err) {
      // Server replies 409 with `existing_ticket_id` if a duplicate convert is
      // attempted (e.g. the agent double-clicks, or Archive convert is fired
      // for a chat that's already been escalated). Surface a useful toast.
      const existing = err.response?.data?.existing_ticket_id;
      if (existing) {
        toast.error(`Already converted to Ticket #${existing}`);
      } else {
        toast.error(err.response?.data?.error || 'Failed to create ticket');
      }
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-bold text-gray-800">Convert Chat to Ticket</h2>
            <p className="text-xs text-gray-400 mt-0.5">Full chat transcript will be attached automatically</p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Ticket Subject *</label>
            <input className="input w-full" value={subject} onChange={e => setSubject(e.target.value)} required />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
            <textarea className="input w-full min-h-20 resize-y" rows={3} placeholder="Describe the issue..." value={notes} onChange={e => setNotes(e.target.value)} spellCheck={true} autoCorrect="on" autoCapitalize="sentences" lang="en" />
          </div>
          <div className="flex items-start gap-2 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2.5">
            <Ticket className="w-4 h-4 text-indigo-600 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-indigo-700 space-y-1">
              <p>The ticket will be assigned to you with the full chat history.</p>
              {isLive ? (
                <p><strong>The live chat stays open</strong> — we'll draft a message in the chat input so you can let the customer know about the ticket before ending the chat.</p>
              ) : (
                <p>This chat is already closed. The ticket gives you a way to follow up — the customer will receive ticket emails as usual.</p>
              )}
            </div>
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 justify-center">Cancel</button>
            <button type="submit" disabled={saving || !subject.trim()} className="btn-primary flex-1 justify-center flex items-center gap-1.5">
              {saving ? 'Creating...' : <><Ticket className="w-4 h-4" /> Create Ticket</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Chat Notes Panel ──────────────────────────────────────────────────────────
function ChatNotesPanel({ chatId, currentUser, onClose }) {
  const [notes, setNotes] = useState([]);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const chatIdRef = useRef(chatId);

  useEffect(() => { chatIdRef.current = chatId; }, [chatId]);

  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    setNotes([]);
    getChatNotes(chatId).then(r => {
      if (!cancelled && chatIdRef.current === chatId) setNotes(r.data.notes);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [chatId]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setSaving(true);
    const myChatId = chatId;
    try {
      const r = await addChatNote(myChatId, { note: input.trim() });
      // Only append if still on same chat
      if (chatIdRef.current === myChatId) {
        setNotes(n => [...n, r.data.note]);
        setInput('');
      }
    } catch { toast.error('Failed to add note'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (noteId) => {
    try {
      await deleteChatNote(chatId, noteId);
      setNotes(n => n.filter(x => x.id !== noteId));
    } catch { toast.error('Failed to delete note'); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-100 bg-white flex items-center justify-between flex-shrink-0">
        <span className="text-xs font-semibold text-gray-600 flex items-center gap-1.5">
          <Lock className="w-3 h-3" /> Chat Notes
          {notes.length > 0 && <span className="bg-amber-100 text-amber-700 text-[10px] rounded-full px-1.5 py-0.5 font-bold">{notes.length}</span>}
        </span>
        <button onClick={onClose}><X className="w-3.5 h-3.5 text-gray-400" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {notes.length === 0 && <p className="text-xs text-gray-400 py-2 text-center">No notes yet</p>}
        {notes.map(n => (
          <div key={n.id} className="bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-gray-700 relative group">
            <p className="pr-5 leading-relaxed">{n.note}</p>
            <p className="text-[10px] text-gray-400 mt-1">{n.agent_name}</p>
            {(n.agent_id === currentUser?.id || currentUser?.role === 'admin') && (
              <button
                onClick={() => handleDelete(n.id)}
                className="absolute top-1.5 right-1.5 hidden group-hover:flex text-red-400 hover:text-red-600"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={handleAdd} className="p-2 border-t border-gray-100 bg-white flex gap-1.5 flex-shrink-0">
        <textarea
          className="input flex-1 text-xs resize-y"
          style={{ minHeight: '48px', maxHeight: '30vh' }}
          rows={2}
          placeholder="Private note…"
          value={input}
          onChange={e => setInput(e.target.value)}
          spellCheck={true}
          autoCorrect="on"
          autoCapitalize="sentences"
          lang="en"
        />
        <button type="submit" disabled={saving || !input.trim()} className="btn-primary px-2.5 flex items-center self-end">
          <Lock className="w-3 h-3" />
        </button>
      </form>
    </div>
  );
}

// ── Archive Transcript Modal ──────────────────────────────────────────────────
function TranscriptModal({ chatId, customerName, customerEmail, onClose }) {
  const [messages, setMessages] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    getAgentArchivedMessages(chatId)
      .then(r => setMessages(r.data.messages))
      .catch(() => setMessages([]));
  }, [chatId]);

  const handleEmail = async () => {
    setSending(true);
    try {
      const r = await sendChatTranscript(chatId);
      toast.success(r.data.message || 'Transcript emailed');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to email transcript');
    } finally { setSending(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0">
          <div>
            <h2 className="text-base font-bold text-gray-800">Chat #{chatId}</h2>
            <p className="text-xs text-gray-400 mt-0.5">{customerName} · {customerEmail}</p>
          </div>
          <button onClick={onClose}><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-gray-50/40">
          {messages === null && <p className="text-sm text-gray-400 text-center py-8">Loading transcript…</p>}
          {messages?.length === 0 && <p className="text-sm text-gray-400 text-center py-8">No messages in this chat.</p>}
          {messages?.map(m => {
            const isAgent = m.sender_role === 'agent' || m.sender_role === 'admin';
            return (
              <div key={m.id} className={clsx('flex gap-3', isAgent ? 'flex-row-reverse' : 'flex-row')}>
                <div className={clsx('flex flex-col max-w-md', isAgent ? 'items-end' : 'items-start')}>
                  <div className={clsx('px-4 py-2.5 rounded-xl text-sm whitespace-pre-wrap break-words', isAgent ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white border border-gray-200 text-gray-800 rounded-tl-none')}>
                    {renderMarkdown(m.message)}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">{m.sender_name} · {new Date(m.created_at).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })}</p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3 flex-shrink-0 bg-white">
          <p className="text-xs text-gray-400">{messages?.length || 0} message(s)</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary text-sm">Close</button>
            <button onClick={handleEmail} disabled={sending || !messages?.length} className="btn-primary text-sm flex items-center gap-1.5">
              <Mail className="w-4 h-4" /> {sending ? 'Sending…' : 'Email to customer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Chat Archive View ─────────────────────────────────────────────────────────
// `onConvert(chat)` — opens the parent's ConvertToTicketModal pre-populated with
// the closed chat. Agents need this when the customer closed before they had a
// chance to escalate; without it the chat is locked in read-only mode forever.
function ChatArchiveView({ onConvert }) {
  const [chats, setChats] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [rangeDays, setRangeDays] = useState(30);
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState(null);
  const [limit, setLimit] = useState(() => readStoredPageSize('dsp_agent_chats_archive_page_size'));

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit };
    if (q.trim()) params.q = q.trim();
    if (rangeDays !== 'all') {
      const from = new Date(Date.now() - rangeDays * 24 * 3600 * 1000);
      params.from = from.toISOString().slice(0, 19).replace('T', ' ');
    }
    getAgentChatArchive(params)
      .then(r => { setChats(r.data.chats); setTotal(r.data.total); })
      .catch(() => toast.error('Failed to load archive'))
      .finally(() => setLoading(false));
  }, [page, limit, q, rangeDays]);

  useEffect(() => { load(); }, [load]);

  // Reset page when search/range changes
  useEffect(() => { setPage(1); }, [q, rangeDays]);

  const handleQuickEmail = async (chatId) => {
    try {
      const r = await sendChatTranscript(chatId);
      toast.success(r.data.message || 'Transcript emailed');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to email');
    }
  };

  const formatDuration = (secs) => {
    if (!secs || secs < 0) return '—';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      {viewing && (
        <TranscriptModal
          chatId={viewing.id}
          customerName={viewing.customer_name}
          customerEmail={viewing.customer_email}
          onClose={() => setViewing(null)}
        />
      )}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search by customer name or email…"
              className="input text-sm w-full pl-9"
            />
          </div>
          <select value={rangeDays} onChange={e => setRangeDays(e.target.value === 'all' ? 'all' : parseInt(e.target.value))} className="input text-sm">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 1 year</option>
            <option value="all">All time</option>
          </select>
          <button onClick={load} className="btn-secondary text-sm flex items-center gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-gray-400">Loading…</div>
        ) : chats.length === 0 ? (
          <div className="py-12 text-center">
            <Archive className="w-10 h-10 mx-auto text-gray-300 mb-2" />
            <p className="text-sm text-gray-500">No past chats found.</p>
            <p className="text-xs text-gray-400 mt-1">Try widening the date range.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/60 border-b border-gray-100">
                <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Duration</th>
                  <th className="px-4 py-2.5 text-center">Msgs</th>
                  <th className="px-4 py-2.5 text-center">Rating</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {chats.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{c.customer_name}</p>
                      <p className="text-xs text-gray-400">{c.customer_email}{c.customer_domain ? ` · ${c.customer_domain}` : ''}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {new Date(c.closed_at || c.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">{formatDuration(c.duration_secs)}</td>
                    <td className="px-4 py-3 text-center text-xs text-gray-600">{c.message_count}</td>
                    <td className="px-4 py-3 text-center">
                      {c.rating ? (
                        <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-amber-600">
                          {c.rating} <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => setViewing(c)}
                        className="text-xs px-2.5 py-1 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 font-medium mr-1.5"
                      >
                        View
                      </button>
                      {/* Convert vs. View-Ticket: if a ticket has already been
                          created from this chat we link to it instead of
                          offering a duplicate Convert. existing_ticket_id is
                          populated by the backend via tickets.source_chat_id. */}
                      {c.existing_ticket_id ? (
                        <Link
                          to={`/agent/tickets?openTicket=${c.existing_ticket_id}`}
                          title="Open the ticket created from this chat"
                          className="text-xs px-2.5 py-1 rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 border border-violet-200 font-medium inline-flex items-center gap-1 mr-1.5"
                        >
                          <Ticket className="w-3 h-3" /> #{c.existing_ticket_id}
                        </Link>
                      ) : (
                        <button
                          onClick={() => onConvert({ id: c.id, customer_name: c.customer_name, status: 'closed' })}
                          title="Create a follow-up ticket from this chat"
                          className="text-xs px-2.5 py-1 rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 border border-violet-200 font-medium inline-flex items-center gap-1 mr-1.5"
                        >
                          <Ticket className="w-3 h-3" /> Convert
                        </button>
                      )}
                      <button
                        onClick={() => handleQuickEmail(c.id)}
                        title={`Email transcript to ${c.customer_email}`}
                        className="text-xs px-2.5 py-1 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 font-medium inline-flex items-center gap-1"
                      >
                        <Mail className="w-3 h-3" /> Email
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {chats.length > 0 && (
          <div className="px-4 py-2.5 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500 flex-wrap gap-2">
            <span>{total} total · page {page} of {pages}</span>
            <div className="flex items-center gap-4">
              <RowsPerPageSelect
                value={limit}
                onChange={(n) => { setLimit(n); setPage(1); }}
                storageKey="dsp_agent_chats_archive_page_size"
              />
              {pages > 1 && (
                <div className="flex gap-1.5">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="btn-secondary text-xs py-1 px-2 disabled:opacity-40">Prev</button>
                  <button onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page === pages} className="btn-secondary text-xs py-1 px-2 disabled:opacity-40">Next</button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AgentChats() {
  const { socket }    = useSocket();
  const { user }      = useAuth();

  const [pendingChats, setPendingChats]   = useState([]);
  const [activeChat, setActiveChat]       = useState(null);
  // When the chat ends (by either side, by transfer, or by conversion) we
  // freeze the conversation in place instead of wiping it. The agent still
  // sees the transcript, the composer is replaced with a "Chat ended" banner,
  // and the view only clears when they dismiss it manually or accept the
  // next chat. Mirrors the customer-side "closed" state.
  const [activeChatEnded, setActiveChatEnded] = useState(false);
  const [chatMessages, setChatMessages]   = useState([]);
  const [chatInput, setChatInput]         = useState('');
  const [autoAssign, setAutoAssign]       = useState(false);
  const [loading, setLoading]             = useState(true);
  const [convertTarget, setConvertTarget] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [agentList, setAgentList]         = useState([]);
  // Incoming chat-transfer offers are handled by the global
  // IncomingChatTransferOverlay (mounted in App.jsx PersistentOverlays) so
  // the prompt fires regardless of which agent page the receiver is on.
  const [typing, setTyping]               = useState(false);
  const [readByCustomer, setReadByCustomer] = useState(false);
  const [queueAlerts, setQueueAlerts]     = useState([]);
  const [showContext, setShowContext]           = useState(false);
  const [showNotes, setShowNotes]               = useState(false);
  const [activeChatAcceptedAt, setActiveChatAcceptedAt] = useState(null);
  const [chatView, setChatView] = useState('live'); // 'live' | 'archive'
  const [sendingTranscript, setSendingTranscript] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState(null); // { file, dataUrl }

  const bottomRef     = useRef(null);
  const typingTimer   = useRef(null);
  const activeChatRef = useRef(null);
  const msgScrollRef  = useRef(null);
  const fileRef       = useRef(null);

  // Ctrl+V on the chat textarea attaches a clipboard screenshot. Same 25 MB
  // cap the backend enforces in send_file. Single-pending pattern mirrors
  // the customer-side chat composer.
  const onPasteImage = useCallback((file) => {
    if (!activeChat) return;
    if (file.size > 25 * 1024 * 1024) {
      toast.error(`${file.name} is too large (max 25 MB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPendingAttachment({ file, dataUrl: reader.result });
    reader.readAsDataURL(file);
  }, [activeChat]);
  const pasteRef = useImagePaste(onPasteImage);
  const [atBottom, setAtBottom] = useState(true);
  const [pendingScrollHint, setPendingScrollHint] = useState(false);

  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);

  // Mark chat-related notifications as read once the agent has a chat open / on
  // mount of the Chats page in general — the NotificationBell listens for this.
  useEffect(() => {
    const types = ['chat_request', 'chat_assigned', 'chat_missed'];
    types.forEach(t => {
      window.dispatchEvent(new CustomEvent('agent_notification:viewed', { detail: { type: t } }));
    });
    if (activeChat?.id != null) {
      window.dispatchEvent(new CustomEvent('agent_notification:viewed', { detail: { chatId: Number(activeChat.id) } }));
    }
  }, [activeChat?.id]);

  const loadChats = useCallback(() => {
    setLoading(true);
    // Fetch pending queue AND any chat already auto-assigned to this agent (active).
    // The latter handles the case where a chat was auto-assigned while the agent was
    // on a different page — Chats.jsx wasn't mounted to catch chat_auto_assigned,
    // so we need to recover state from the API on mount.
    Promise.all([
      getPendingChats().catch(() => ({ data: { chats: [] } })),
      getMyAgentChats().catch(() => ({ data: { chats: [] } })),
    ])
      .then(([pendingRes, mineRes]) => {
        setPendingChats(pendingRes.data.chats || []);
        const myActive = (mineRes.data.chats || []).find(c => c.status === 'active');
        // Only auto-set if we don't already have an activeChat locally (avoid stomping
        // on something the agent just accepted in this session).
        setActiveChat(prev => {
          if (prev) return prev;
          if (!myActive) return null;
          setActiveChatAcceptedAt(myActive.accepted_at || new Date().toISOString());
          return myActive;
        });
      })
      .catch(() => toast.error('Failed to load chats'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadChats();
    getAgentList().then(r => setAgentList(r.data.agents || [])).catch(() => {});
  }, [loadChats]);

  useGlobalRefresh(loadChats);

  // Refresh the agent list each time the transfer modal opens — `is_online`
  // can flip in the seconds between mount and the agent clicking Transfer,
  // and a stale dropdown leads to transfers landing on someone who's no
  // longer there to accept.
  useEffect(() => {
    if (!transferTarget) return;
    getAgentList().then(r => setAgentList(r.data.agents || [])).catch(() => {});
  }, [transferTarget]);

  // Active chat socket
  useEffect(() => {
    if (!socket || !activeChat) return;
    socket.emit('join_chat', { chatId: activeChat.id });
    socket.emit('mark_read', { chatId: activeChat.id });

    const onMsg     = ({ message }) => {
      // Dedupe by id — when an agent accepts a chat, both `accept_chat` (which
      // inserts the greeting and emits new_message into chat_${chatId}) and
      // `join_chat` (which emits chat_history with all existing messages) fire
      // in parallel. Depending on which response lands at the socket first, the
      // greeting can arrive both as a new_message AND inside chat_history — and
      // a naive append would render it twice.
      setChatMessages(m => (m.some(x => x.id === message.id) ? m : [...m, message]));
      socket.emit('mark_read', { chatId: activeChat.id });
    };
    const onHistory = ({ messages: msgs }) => {
      // Merge instead of replace — if a new_message landed before chat_history
      // (the inverse race), the greeting is in `prev` but also inside msgs;
      // dedupe via id so we don't double-render and don't lose anything.
      setChatMessages(prev => {
        const seen = new Set(msgs.map(m => m.id));
        const extras = prev.filter(m => !seen.has(m.id));
        return [...msgs, ...extras];
      });
    };
    const onClosed  = ({ chatId } = {}) => {
      // Deterministic toast id so the duplicate chat_closed / chat_removed pair
      // (the backend fires both — chat_closed to the chat room and chat_removed
      // to the agents room) collapses into a single visible toast. Use the
      // chatId from the event payload first; the activeChat?.id closure
      // fallback breaks when the activeChat state was already null because
      // chat_removed arrived a tick earlier — which used to mismatch the ids
      // and stack two toasts. Now both handlers key off the same chatId.
      const id = chatId || activeChat?.id;
      toast('Chat ended', { id: `chat_ended_${id}` });
      setActiveChatEnded(true);
    };
    const onTyping  = ({ isTyping }) => setTyping(isTyping);
    const onRead    = () => setReadByCustomer(true);
    const onTransfer = ({ chatId } = {}) => {
      toast('Chat was transferred away', { id: `chat_xferaway_${chatId || activeChat?.id}` });
      setActiveChatEnded(true);
    };

    socket.on('new_message',        onMsg);
    socket.on('chat_history',       onHistory);
    socket.on('chat_closed',        onClosed);
    socket.on('user_typing',        onTyping);
    socket.on('messages_read',      onRead);
    socket.on('chat_transfer_notice', onTransfer);

    return () => {
      socket.off('new_message',        onMsg);
      socket.off('chat_history',       onHistory);
      socket.off('chat_closed',        onClosed);
      socket.off('user_typing',        onTyping);
      socket.off('messages_read',      onRead);
      socket.off('chat_transfer_notice', onTransfer);
      // Clear any pending typing-stopped emit so it doesn't fire post-unmount
      if (typingTimer.current) {
        clearTimeout(typingTimer.current);
        typingTimer.current = null;
      }
    };
  }, [socket, activeChat]);

  // Global events
  useEffect(() => {
    if (!socket) return;
    const onRequest   = ({ chatId, customer }) => {
      setPendingChats(p => [...p.filter(c => c.id !== chatId), {
        id: chatId, customer_name: customer.customer_name,
        domain: customer.domain, plan_name: customer.plan_name,
        created_at: new Date().toISOString(),
      }]);
    };
    const onAccepted  = ({ chatId }) => setPendingChats(p => p.filter(c => c.id !== chatId));
    const onAutoAssign = ({ chatId, customer }) => {
      setAutoAssign(true);
      setActiveChat({ id: chatId, ...customer });
      setActiveChatAcceptedAt(new Date().toISOString());
      setPendingChats(p => p.filter(c => c.id !== chatId));
      toast.success('Chat auto-assigned to you');
    };
    const onStatus = ({ enabled }) => setAutoAssign(enabled);

    // Offer/cancelled live in the global IncomingChatTransferOverlay so the
    // prompt fires regardless of which page the receiver is on. This page
    // only handles what happens AFTER the receiver has accepted the offer.
    const onTransferAccepted = ({ chatId, fromAgent, transferNote, customer }) => {
      // Backend confirmed our accept — load the chat into the active slot.
      toast.success(`Chat accepted from ${fromAgent}`);
      if (transferNote) toast(`Note: ${transferNote}`, { duration: 8000 });
      if (customer) {
        setActiveChat({
          id: chatId,
          customer_id: customer.customer_id,
          customer_name: customer.customer_name,
          domain: customer.domain,
          plan_name: customer.plan_name,
          transfer_note: transferNote || null,
        });
        setActiveChatEnded(false);
        setActiveChatAcceptedAt(new Date().toISOString());
        setChatMessages([]); // history arrives via chat_history when we join
      }
      loadChats();
    };
    // Initiator-side outcomes — we're the sender (agent A).
    const onTransferPending = ({ toAgentName }) => {
      toast(`Waiting for ${toAgentName} to accept the chat… (30 s)`, { id: 'chat-xfer-pending', icon: '⏳', duration: 30000 });
    };
    const onTransferDeclined = ({ chatId, toAgentName } = {}) => {
      toast.dismiss('chat-xfer-pending');
      toast.error(`${toAgentName} declined the chat transfer`, { id: `chat_xfer_declined_${chatId || ''}` });
    };
    const onTransferTimeout = ({ chatId, toAgentName } = {}) => {
      toast.dismiss('chat-xfer-pending');
      toast.error(`${toAgentName} didn't respond — chat is still yours`, { id: `chat_xfer_timeout_${chatId || ''}` });
    };
    const onTransferFailed = ({ chatId, reason } = {}) => {
      toast.dismiss('chat-xfer-pending');
      toast.error(reason || 'Transfer failed', { id: `chat_xfer_failed_${chatId || ''}` });
    };
    const onTransferredAway = ({ chatId } = {}) => {
      // Receiver accepted our offer — freeze our copy of the chat as ended
      // (same UX as a normal end) so we can review the transcript.
      toast.dismiss('chat-xfer-pending');
      toast.success('Chat transferred', { id: `chat_xfer_done_${chatId || activeChat?.id || ''}` });
      setActiveChatEnded(true);
    };
    const onQueueAlert = ({ chatId, customerName, minsWaiting }) => {
      setQueueAlerts(a => [...a.filter(x => x.chatId !== chatId), { chatId, customerName, minsWaiting }]);
      toast(`⏱ ${customerName} has been waiting ${minsWaiting}m`, { duration: 10000 });
    };

    // Customer cancelled (or chat was closed for any reason) — drop it from the queue.
    // Also fully tear down the active chat panel if the closed chat was the one open.
    // This is the agent-side fallback for chat_closed: if the agent's socket was
    // reconnected mid-chat, they may not be in the chat_<id> room anymore, so the
    // direct `chat_closed` won't reach them. The `chat_removed` event is broadcast
    // to the full agents room, so it reliably fires.
    // Use String() coercion in the filter so a number vs string id mismatch can't leave
    // a ghost card on screen, and re-fetch from API as a guaranteed-fresh fallback.
    const onChatRemoved = ({ chatId }) => {
      console.log('[Chats] chat_removed received for chatId =', chatId);
      const key = String(chatId);
      setPendingChats(p => p.filter(c => String(c.id) !== key));
      setQueueAlerts(a => a.filter(x => String(x.chatId) !== key));
      // If the active chat is the one being removed, freeze it instead of
      // wiping. The transcript stays on screen until the agent dismisses
      // it or accepts a new chat.
      setActiveChat(prev => {
        if (prev && String(prev.id) === key) {
          // Same deterministic id as onClosed — react-hot-toast dedupes by id,
          // so this is a no-op when onClosed already ran for the same chat.
          toast('Chat ended', { id: `chat_ended_${key}` });
          setActiveChatEnded(true);
        }
        return prev;
      });
      // Belt-and-braces: re-fetch the queue from API in case any local state drifted
      loadChats();
    };

    // Sequential ring escalation — chat_request_cancelled fires when this agent's
    // 15s ring window expired (chat is now being offered to someone else) OR the
    // customer cancelled while we were being rung. Drop the chat from our queue
    // so we don't see a phantom "Accept" button for a chat that's no longer ours.
    const onRequestCancelled = ({ chatId }) => {
      const key = String(chatId);
      setPendingChats(p => p.filter(c => String(c.id) !== key));
      setQueueAlerts(a => a.filter(x => String(x.chatId) !== key));
    };

    socket.on('new_chat_request',       onRequest);
    socket.on('chat_request_cancelled', onRequestCancelled);
    socket.on('chat_request_accepted',  onAccepted);
    socket.on('chat_auto_assigned',     onAutoAssign);
    socket.on('auto_assign_status',     onStatus);
    socket.on('chat_transfer_accepted',  onTransferAccepted);
    socket.on('chat_transfer_pending',   onTransferPending);
    socket.on('chat_transfer_declined',  onTransferDeclined);
    socket.on('chat_transfer_timeout',   onTransferTimeout);
    socket.on('chat_transfer_failed',    onTransferFailed);
    socket.on('chat_transferred_away',   onTransferredAway);
    socket.on('queue_sla_alert',        onQueueAlert);
    socket.on('chat_removed',           onChatRemoved);
    return () => {
      socket.off('new_chat_request',       onRequest);
      socket.off('chat_request_cancelled', onRequestCancelled);
      socket.off('chat_request_accepted',  onAccepted);
      socket.off('chat_auto_assigned',     onAutoAssign);
      socket.off('auto_assign_status',     onStatus);
      socket.off('chat_transfer_accepted',  onTransferAccepted);
      socket.off('chat_transfer_pending',   onTransferPending);
      socket.off('chat_transfer_declined',  onTransferDeclined);
      socket.off('chat_transfer_timeout',   onTransferTimeout);
      socket.off('chat_transfer_failed',    onTransferFailed);
      socket.off('chat_transferred_away',   onTransferredAway);
      socket.off('queue_sla_alert',        onQueueAlert);
      socket.off('chat_removed',           onChatRemoved);
    };
  }, [socket, loadChats]);

  // Smart auto-scroll: only follow new messages when user is already near the bottom.
  // Otherwise surface a "↓ New message" pill so they can jump down on demand.
  useEffect(() => {
    if (atBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setPendingScrollHint(false);
    } else if (chatMessages.length > 0) {
      setPendingScrollHint(true);
    }
  }, [chatMessages, typing]);

  // Reset to bottom when switching to a different chat
  useEffect(() => {
    setAtBottom(true);
    setPendingScrollHint(false);
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'auto' }));
  }, [activeChat?.id]);

  const handleMsgScroll = (e) => {
    const el = e.currentTarget;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const near = distFromBottom < 100;
    setAtBottom(near);
    if (near) setPendingScrollHint(false);
  };

  const jumpToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setPendingScrollHint(false);
  };

  const sentiment = chatMessages.length > 3 ? detectSentiment(chatMessages) : null;

  const acceptingRef = useRef(new Set()); // chat IDs currently being accepted — prevents double-emit
  const handleAcceptChat = (chatId) => {
    // A frozen (ended) chat shouldn't block accepting a new one — the new
    // chat just replaces the frozen transcript on screen.
    if (activeChat && !activeChatEnded) {
      toast.error('End your current chat before accepting another', { id: 'already-in-chat' });
      return;
    }
    if (acceptingRef.current.has(chatId)) return;
    acceptingRef.current.add(chatId);
    socket?.emit('accept_chat', { chatId });
    const chat = pendingChats.find(c => c.id === chatId);
    setActiveChat(chat || { id: chatId });
    setActiveChatEnded(false);  // new chat takes over — clear any frozen transcript
    setActiveChatAcceptedAt(new Date().toISOString());
    setChatMessages([]);
    setPendingChats(p => p.filter(c => c.id !== chatId));
    setReadByCustomer(false);
    toast.success('Chat accepted');
    // Clear after a short delay — by then the socket roundtrip is done
    setTimeout(() => acceptingRef.current.delete(chatId), 2000);
  };

  const sendChatMsg = (e) => {
    e?.preventDefault();
    if (!activeChat) return;
    if (pendingAttachment) {
      socket?.emit('send_file', {
        chatId: activeChat.id,
        fileName: pendingAttachment.file.name,
        fileType: pendingAttachment.file.type,
        fileData: pendingAttachment.dataUrl,
        caption: chatInput.trim(),
      });
      setPendingAttachment(null);
      setChatInput('');
      setReadByCustomer(false);
      clearTimeout(typingTimer.current);
      socket?.emit('typing', { chatId: activeChat.id, isTyping: false });
      return;
    }
    if (!chatInput.trim()) return;
    socket?.emit('send_message', { chatId: activeChat.id, message: chatInput.trim() });
    setChatInput('');
    setReadByCustomer(false);
    clearTimeout(typingTimer.current);
    socket?.emit('typing', { chatId: activeChat.id, isTyping: false });
  };

  const handleTyping = (val) => {
    setChatInput(val);
    if (socket && activeChat) {
      socket.emit('typing', { chatId: activeChat.id, isTyping: true });
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        socket.emit('typing', { chatId: activeChat.id, isTyping: false });
      }, 1500);
    }
  };

  const endChat = () => {
    socket?.emit('close_chat', { chatId: activeChat.id });
    setActiveChatEnded(true);
  };

  // Explicit dismissal — clears the frozen transcript so the agent goes back
  // to the queue. Triggered by the Dismiss button in the ended-state banner
  // or implicitly when accepting the next chat.
  const dismissEndedChat = () => {
    setActiveChat(null);
    setChatMessages([]);
    setActiveChatAcceptedAt(null);
    setActiveChatEnded(false);
  };

  const handleSendTranscript = async () => {
    if (!activeChat) return;
    setSendingTranscript(true);
    try {
      const res = await sendChatTranscript(activeChat.id);
      toast.success(res.data.message);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send transcript');
    } finally { setSendingTranscript(false); }
  };

  return (
    <Layout>
      {convertTarget && (
        <ConvertToTicketModal
          chat={convertTarget}
          onClose={() => setConvertTarget(null)}
          onConverted={(ticket) => {
            setConvertTarget(null);
            // Pre-fill the chat input ONLY when the chat is still live and the
            // converted chat is the one currently open. Agent edits + sends in
            // their own words; we just save the typing. Skipped for Archive
            // conversions (no input box to fill) and for conversions on a chat
            // that's no longer the active one in this tab.
            if (activeChat && Number(activeChat.id) === Number(convertTarget.id) && convertTarget.status !== 'closed') {
              setChatInput(
                `I've created Ticket #${ticket.id} to follow up on this. ` +
                `You'll receive email updates and can reply directly from your portal. ` +
                `Is there anything else I can help you with right now?`
              );
            }
          }}
        />
      )}
      {transferTarget && (
        <TransferModal
          chat={transferTarget}
          agents={agentList}
          currentAgentId={user?.id}
          socket={socket}
          onClose={() => setTransferTarget(null)}
          onOfferSent={() => {
            // Just close the modal. The chat stays active on this side until
            // the receiving agent accepts (chat_transferred_away) or declines
            // (chat_transfer_declined). Outcome handlers above show the
            // appropriate toast / state change.
            setTransferTarget(null);
          }}
        />
      )}

      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Chats</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {chatView === 'live'
              ? `${pendingChats.length} waiting · ${activeChat ? '1 active' : 'no active chat'}`
              : 'Past chat history'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadChats} className="hidden lg:inline-flex btn-secondary p-2"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {/* Live / Archive tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-200">
        <button
          type="button"
          onClick={() => setChatView('live')}
          className={clsx(
            'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
            chatView === 'live' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          <MessageSquare className="w-4 h-4" /> Live
          {pendingChats.length > 0 && <span className="text-[10px] bg-amber-100 text-amber-700 rounded-full px-1.5 font-bold">{pendingChats.length}</span>}
        </button>
        <button
          type="button"
          onClick={() => setChatView('archive')}
          className={clsx(
            'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
            chatView === 'archive' ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          <Archive className="w-4 h-4" /> Archive
        </button>
      </div>

      {chatView === 'archive' ? <ChatArchiveView onConvert={(chat) => setConvertTarget(chat)} /> : (
      <>

      {/* Queue SLA alerts */}
      {queueAlerts.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {queueAlerts.map(a => (
            <div key={a.chatId} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1"><strong>{a.customerName}</strong> has been waiting <strong>{a.minsWaiting} min</strong> — please accept or assign</span>
              <button onClick={() => setQueueAlerts(q => q.filter(x => x.chatId !== a.chatId))} className="text-amber-600 hover:text-amber-800">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className={clsx('flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border mb-5',
        autoAssign ? 'bg-green-50 text-green-700 border-green-200' : 'bg-gray-50 text-gray-500 border-gray-200'
      )}>
        <Zap className="w-4 h-4" />
        Auto-assign {autoAssign ? 'ON — new chats assigned to you automatically' : 'OFF — accept chats manually'}
      </div>

      <div className="flex flex-col lg:flex-row gap-5">
        {/* Pending list. Filter-at-render strips any chat that is the agent's
            currently-active one — a race we used to lose: the chat stayed in
            `pendingChats` for a tick after accept while chat_request_accepted
            travelled the socket, briefly showing the agent BOTH an Accept
            button AND the live chat for the same conversation. */}
        <div className="w-full lg:w-72 lg:flex-shrink-0 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Waiting ({pendingChats.filter(c => !(activeChat && Number(c.id) === Number(activeChat.id))).length})</h3>
          {loading ? (
            <div className="space-y-3">
              {[1,2,3].map(i => (
                <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 space-y-2">
                  <div className="skeleton-shimmer h-3 w-3/4 rounded" />
                  <div className="skeleton-shimmer h-3 w-1/2 rounded" />
                </div>
              ))}
            </div>
          ) : pendingChats.filter(c => !(activeChat && Number(c.id) === Number(activeChat.id))).length === 0 ? (
            <div className="bg-white rounded-xl border border-dashed border-gray-200 p-8 text-center text-gray-400">
              <MessageSquare className="w-10 h-10 mx-auto mb-2 opacity-20" />
              <p className="text-sm">No pending chats</p>
            </div>
          ) : [...pendingChats.filter(c => !(activeChat && Number(c.id) === Number(activeChat.id)))]
            // Oldest-first so the queue position number visually matches FIFO order.
            // Agents asked which chat is "next" — the #1 chip + sort makes it obvious.
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
            .map((c, idx, arr) => {
            const isAlert = queueAlerts.some(a => a.chatId === c.id);
            const isNext = idx === 0;
            return (
              <div key={c.id} className={clsx('bg-white rounded-xl border shadow-sm p-4', isAlert ? 'border-amber-300 bg-amber-50/50' : isNext && arr.length > 1 ? 'border-indigo-300 ring-1 ring-indigo-100' : 'border-gray-200')}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center text-sm font-bold text-amber-700 flex-shrink-0 relative">
                    {c.customer_name?.[0]?.toUpperCase() || '?'}
                    {/* Queue position chip — only show when more than one is waiting */}
                    {arr.length > 1 && (
                      <span className={clsx('absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center border-2 border-white', isNext ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700')}>
                        {idx + 1}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-800 truncate">{c.customer_name}</p>
                    <p className="text-xs text-gray-500 truncate">{c.domain}</p>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {c.plan_name && <PlanBadge plan={c.plan_name} />}
                      {/* Category chip — what topic the customer picked before starting.
                          Lets the agent skim the queue and pick chats that match their skill. */}
                      {c.category && (
                        <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 border border-violet-200">
                          {c.category}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">
                    {arr.length > 1 && isNext ? <span className="font-semibold text-indigo-600">Next · </span> : null}
                    Waiting {timeAgo(c.created_at)}
                  </span>
                  <button
                    onClick={() => handleAcceptChat(c.id)}
                    disabled={!!activeChat && !activeChatEnded}
                    title={activeChat && !activeChatEnded ? 'End your current chat before accepting another' : 'Accept this chat'}
                    className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-green-600"
                  >
                    Accept
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Active chat panel */}
        {activeChat ? (
          <div className="flex-1 flex gap-0 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" style={{ height: 'calc(100vh - 260px)' }}>
            {/* Chat area — overflow-y-auto so user can scroll when messages + input grow tall */}
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              {/* Header */}
              <div className="px-4 pt-3 pb-2 border-b border-gray-100 bg-gray-50 flex-shrink-0">
                {/* Row 1: avatar + name + live */}
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                    <MessageSquare className="w-4 h-4 text-green-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-gray-800 truncate">{activeChat.customer_name || 'Customer'}</p>
                      <SentimentBadge sentiment={sentiment} />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className={clsx('w-1.5 h-1.5 rounded-full', activeChatEnded ? 'bg-gray-400' : 'bg-green-500 animate-pulse')} />
                      <p className="text-xs text-gray-400">{activeChat.domain || ''} · {activeChatEnded ? 'Ended' : 'Live'}</p>
                    </div>
                  </div>
                </div>
                {/* Row 2: SLA timer + action buttons. While the chat is frozen
                    (transferred-away / ended) most of these aren't actionable —
                    the agent only needs Dismiss. We hide everything else to
                    avoid suggesting they still own the conversation. */}
                <div className="flex items-center justify-between mt-2 gap-2">
                  <div className="flex-shrink-0">
                    {activeChatAcceptedAt && !activeChatEnded && (
                      <ChatActivityTimer
                        acceptedAt={activeChatAcceptedAt}
                        messages={chatMessages}
                      />
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!activeChatEnded && (
                    <>
                    <Tip label="Customer Context">
                      <button
                        onClick={() => setShowContext(v => !v)}
                        className={clsx('p-1.5 rounded-lg border transition-colors', showContext ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'border-gray-200 text-gray-500 hover:bg-gray-100')}
                      >
                        <User className="w-3.5 h-3.5" />
                      </button>
                    </Tip>
                    <Tip label="Chat Notes">
                      <button
                        onClick={() => setShowNotes(v => !v)}
                        className={clsx('p-1.5 rounded-lg border transition-colors', showNotes ? 'bg-amber-50 text-amber-700 border-amber-200' : 'border-gray-200 text-gray-500 hover:bg-gray-100')}
                      >
                        <Lock className="w-3.5 h-3.5" />
                      </button>
                    </Tip>
                    <Tip label="Call customer">
                      <button
                        onClick={() => window.dispatchEvent(new CustomEvent('dsp:agent-call-customer', { detail: {
                          customerId: activeChat.customer_id,
                          customerName: activeChat.customer_name,
                        } }))}
                        className="p-1.5 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 border border-green-200"
                      >
                        <Phone className="w-3.5 h-3.5" />
                      </button>
                    </Tip>
                    <Tip label="Convert to Ticket">
                      <button onClick={() => setConvertTarget(activeChat)} className="p-1.5 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200">
                        <Ticket className="w-3.5 h-3.5" />
                      </button>
                    </Tip>
                    <Tip label="Transfer Chat">
                      <button onClick={() => setTransferTarget(activeChat)} disabled={activeChatEnded} className="p-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 disabled:opacity-40 disabled:cursor-not-allowed">
                        <ArrowRightLeft className="w-3.5 h-3.5" />
                      </button>
                    </Tip>
                    <Tip label="Send Transcript to Customer">
                      <button onClick={handleSendTranscript} disabled={sendingTranscript} className="p-1.5 rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 border border-gray-200 disabled:opacity-50">
                        <Mail className="w-3.5 h-3.5" />
                      </button>
                    </Tip>
                    </>
                    )}
                    {activeChatEnded ? (
                      <Tip label="Dismiss this view">
                        <button onClick={dismissEndedChat} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 font-medium border border-gray-200">
                          <X className="w-3.5 h-3.5" /> Dismiss
                        </button>
                      </Tip>
                    ) : (
                      <Tip label="End Chat">
                        <button onClick={endChat} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 font-medium border border-red-200">
                          <X className="w-3.5 h-3.5" /> End
                        </button>
                      </Tip>
                    )}
                  </div>
                </div>
              </div>

              {/* Transfer note banner */}
              {activeChat.transfer_note && (
                <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 flex items-start gap-2">
                  <ArrowRightLeft className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span><strong>Handoff note:</strong> {activeChat.transfer_note}</span>
                </div>
              )}

              {/* Messages — auto-fills remaining space, shrinks when reply grows */}
              <div
                ref={msgScrollRef}
                onScroll={handleMsgScroll}
                className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4 bg-gray-50/40 relative"
              >
                {pendingScrollHint && (
                  <button
                    onClick={jumpToBottom}
                    className="sticky top-2 left-1/2 -translate-x-1/2 z-10 mx-auto block text-xs px-3 py-1.5 rounded-full bg-indigo-600 text-white shadow-md hover:bg-indigo-700 transition-colors animate-pulse"
                  >
                    ↓ New message
                  </button>
                )}
                {chatMessages.length === 0 && (
                  <div className="text-center text-gray-400 py-8">
                    <MessageSquare className="w-10 h-10 mx-auto mb-2 opacity-20" />
                    <p className="text-sm">No messages yet. Say hello!</p>
                  </div>
                )}
                {chatMessages.map((m, idx) => {
                  const isAgent = m.sender_role === 'agent' || m.sender_role === 'admin';
                  const isMe    = m.sender_id === user?.id;
                  const isLast  = idx === chatMessages.length - 1;
                  return (
                    <div key={m.id} className={clsx('flex gap-3', isAgent ? 'flex-row-reverse' : 'flex-row')}>
                      <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0', isAgent ? 'bg-indigo-100' : 'bg-gray-200')}>
                        {isAgent ? <Headphones className="w-4 h-4 text-indigo-600" /> : <User className="w-4 h-4 text-gray-600" />}
                      </div>
                      <div className={clsx('max-w-lg flex flex-col', isAgent ? 'items-end' : 'items-start')}>
                        <div className={clsx('px-4 py-2.5 rounded-xl text-sm shadow-sm', isAgent ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white border border-gray-200 text-gray-800 rounded-tl-none')}>
                          {m.file_url ? (
                            m.file_type?.startsWith('image/') ? (
                              <div>
                                <a href={m.file_url} target="_blank" rel="noreferrer">
                                  <img src={m.file_url} alt={m.file_name} className="max-w-[200px] rounded-lg mb-1 cursor-pointer hover:opacity-90 transition-opacity" />
                                </a>
                                {m.message && <p className="whitespace-pre-wrap break-words">{renderMarkdown(m.message)}</p>}
                              </div>
                            ) : (
                              <a href={m.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 underline underline-offset-2">
                                <Paperclip className="w-3.5 h-3.5 flex-shrink-0" />
                                <span>{m.file_name || 'Attachment'}</span>
                                {m.message && <span className="opacity-70">— {m.message}</span>}
                              </a>
                            )
                          ) : renderMarkdown(m.message)}
                        </div>
                        <div className="flex items-center gap-1 mt-1">
                          <p className="text-xs text-gray-400">{m.sender_name} · {timeAgo(m.created_at)}</p>
                          {isMe && isLast && (
                            readByCustomer
                              ? <CheckCheck className="w-3 h-3 text-blue-500" />
                              : <Check className="w-3 h-3 text-gray-400" />
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {typing && (
                  <div className="flex gap-3 items-center">
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                      <User className="w-4 h-4 text-gray-600" />
                    </div>
                    <div className="bg-white border border-gray-200 rounded-xl rounded-tl-none px-4 py-2.5 flex gap-1 shadow-sm">
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input — or ended banner when the chat is frozen */}
              {activeChatEnded ? (
                <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between flex-shrink-0 bg-gray-50">
                  <span className="text-xs text-gray-500 flex items-center gap-1.5">
                    <X className="w-3.5 h-3.5" /> Chat ended — transcript above for reference
                  </span>
                  <button
                    onClick={dismissEndedChat}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium"
                  >
                    Dismiss
                  </button>
                </div>
              ) : (
              <div className="border-t border-gray-100 p-3 bg-white flex-shrink-0 space-y-2">
                <div className="flex items-center gap-2">
                  <CannedPicker onSelect={text => setChatInput(v => v ? v + ' ' + text : text)} />
                </div>
                {pendingAttachment && (
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-50 border border-indigo-100 rounded-lg text-xs">
                    {pendingAttachment.file.type?.startsWith('image/') ? (
                      <img src={pendingAttachment.dataUrl} alt="" className="w-8 h-8 object-cover rounded flex-shrink-0" />
                    ) : (
                      <Paperclip className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                    )}
                    <span className="truncate flex-1 text-indigo-700 font-medium">{pendingAttachment.file.name}</span>
                    <button type="button" onClick={() => setPendingAttachment(null)} className="text-gray-400 hover:text-red-500 flex-shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <form onSubmit={sendChatMsg} className="flex gap-2">
                  <div className="flex-1 flex items-end gap-1 input px-2 py-1.5">
                    <textarea
                      ref={pasteRef}
                      className="flex-1 text-sm outline-none bg-transparent resize-y"
                      style={{ minHeight: '28px', maxHeight: '500px' }}
                      rows={1}
                      placeholder={pendingAttachment ? 'Add a caption… (optional)' : 'Type your message…  (Enter to send, Shift+Enter for newline · paste a screenshot with Ctrl+V)'}
                      value={chatInput}
                      onChange={e => handleTyping(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMsg(e); } }}
                      spellCheck={true}
                      autoCorrect="on"
                      autoCapitalize="sentences"
                      lang="en"
                    />
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      title="Attach a file"
                      className={clsx('transition-colors flex-shrink-0', pendingAttachment ? 'text-indigo-600' : 'text-gray-400 hover:text-indigo-600')}
                    >
                      <Paperclip className="w-4 h-4" />
                    </button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*,.pdf,.doc,.docx,.txt,.zip"
                      className="hidden"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (!file || !activeChat) return;
                        if (file.size > 25 * 1024 * 1024) {
                          toast.error(`${file.name} is too large (max 25 MB)`);
                          e.target.value = '';
                          return;
                        }
                        const reader = new FileReader();
                        reader.onload = () => setPendingAttachment({ file, dataUrl: reader.result });
                        reader.readAsDataURL(file);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <button type="submit" disabled={!chatInput.trim() && !pendingAttachment} className="btn-primary py-2 px-4 flex items-center gap-1.5">
                    <Send className="w-4 h-4" /> Send
                  </button>
                </form>
              </div>
              )}
            </div>

            {/* Right sidebar: Customer Info + Chat Notes */}
            {(showContext || showNotes) && (
              <div className="w-56 border-l border-gray-100 bg-gray-50/60 flex flex-col flex-shrink-0 overflow-hidden">
                {showContext && (
                  <div className={clsx('flex flex-col', showNotes ? 'max-h-64 border-b border-gray-100' : 'flex-1')}>
                    <div className="px-3 py-2 border-b border-gray-100 bg-white flex items-center justify-between flex-shrink-0">
                      <span className="text-xs font-semibold text-gray-600">Customer Info</span>
                      <button onClick={() => setShowContext(false)}><X className="w-3.5 h-3.5 text-gray-400" /></button>
                    </div>
                    <div className="overflow-y-auto flex-1">
                      <CustomerContext customerId={activeChat.customer_id} />
                    </div>
                  </div>
                )}
                {showNotes && (
                  <div className="flex-1 flex flex-col min-h-0">
                    <ChatNotesPanel chatId={activeChat.id} currentUser={user} onClose={() => setShowNotes(false)} />
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="hidden lg:flex flex-1 bg-white rounded-xl border border-dashed border-gray-200 flex-col items-center justify-center text-gray-400" style={{ height: 'calc(100vh - 260px)' }}>
            <Headphones className="w-14 h-14 mb-3 opacity-15" />
            <p className="text-sm font-medium">No active chat</p>
            <p className="text-xs mt-1 opacity-60">Accept a chat from the list on the left</p>
          </div>
        )}
      </div>
      </>
      )}
    </Layout>
  );
}
