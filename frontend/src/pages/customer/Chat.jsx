import { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import { useCustomerCall } from '../../contexts/CustomerCallContext';
import useImagePaste from '../../hooks/useImagePaste';
import {
  initiateChat, initiateCall, getActiveChat, closeChat,
  rateChat, getChatHistory, getCustomerDashboard,
  getCustomerAgentStatus,
} from '../../services/api';
import {
  MessageSquare, MessageCircle, Send, X, Clock, Headphones, User, Loader,
  Phone, PhoneOff, PhoneCall, Mic, MicOff, Star, Lock,
  Paperclip, CheckCheck, Check, History, UserCircle2, RefreshCw, ArrowRightLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { renderMarkdown } from '../../utils/renderMarkdown';

function formatDuration(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function chatDuration(created, closed) {
  if (!created || !closed) return null;
  const mins = Math.round((new Date(closed) - new Date(created)) / 60000);
  if (mins < 1) return '< 1 min';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function StarRow({ count }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <Star key={s} className={`w-3.5 h-3.5 ${s <= count ? 'text-amber-400 fill-amber-400' : 'text-gray-200'}`} />
      ))}
    </div>
  );
}

// ── CSAT Modal ────────────────────────────────────────────────────────────────
function CsatModal({ chatId, onClose, onSaved }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover]   = useState(0);
  const [comment, setComment] = useState('');
  const [saving, setSaving]   = useState(false);
  const [done, setDone]       = useState(false);

  const submit = async () => {
    if (!rating) return;
    setSaving(true);
    try {
      await rateChat(chatId, { rating, comment });
      onSaved?.(rating);
      setDone(true);
    } catch { toast.error('Failed to submit rating'); }
    finally { setSaving(false); }
  };

  if (done) return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8 text-center">
        <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <Star className="w-7 h-7 text-green-600 fill-green-600" />
        </div>
        <h3 className="text-base font-bold text-gray-800 mb-1">Thank you!</h3>
        <p className="text-sm text-gray-500 mb-5">Your feedback helps us improve.</p>
        <button onClick={onClose} className="btn-primary mx-auto">Close</button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="text-center mb-5">
          <h3 className="text-base font-bold text-gray-800">How was your chat?</h3>
          <p className="text-sm text-gray-500 mt-1">Rate your support experience</p>
        </div>
        <div className="flex justify-center gap-2 mb-4">
          {[1, 2, 3, 4, 5].map(n => (
            <button
              key={n}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(n)}
              className="w-11 h-11 flex items-center justify-center"
            >
              <span className={`inline-flex transition-transform duration-150 ${(hover || rating) >= n ? 'scale-125' : 'scale-100'}`}>
                <Star className={clsx('w-8 h-8 transition-colors', (hover || rating) >= n ? 'text-amber-400 fill-amber-400' : 'text-gray-200 fill-gray-200')} />
              </span>
            </button>
          ))}
        </div>
        <textarea
          className="input w-full text-sm resize-none mb-4"
          rows={3}
          placeholder="Any additional feedback? (optional)"
          value={comment}
          onChange={e => setComment(e.target.value)}
        />
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-secondary flex-1 justify-center">Skip</button>
          <button onClick={submit} disabled={!rating || saving} className="btn-primary flex-1 justify-center">
            {saving ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}


export default function CustomerChat() {
  const { user } = useAuth();
  const { socket } = useSocket();
  const [searchParams, setSearchParams] = useSearchParams();
  const [chat, setChat]             = useState(null);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('notification:viewed', { detail: { type: 'chat_accepted' } }));
  }, []);
  const [messages, setMessages]     = useState([]);
  const [input, setInput]           = useState('');
  const [status, setStatus]         = useState('idle');
  const [agentName, setAgentName]   = useState('');
  const [typing, setTyping]         = useState(false);
  const [queuePos, setQueuePos]     = useState(null);
  const [readByAgent, setReadByAgent] = useState(false);
  const [showCsat, setShowCsat]       = useState(false);
  const [chatClosed, setChatClosed]   = useState(false);
  const [activeTab, setActiveTab]       = useState('chat');
  const [chatHistory, setChatHistory]   = useState([]);
  const [chatUsageResetAt, setChatUsageResetAt] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded]   = useState(false);
  const [historyRatingId, setHistoryRatingId] = useState(null);
  const [agentAvail, setAgentAvail]   = useState(null);
  const [allowCalls, setAllowCalls]   = useState(false);
  const [restrictReason, setRestrictReason] = useState('plan'); // 'plan' | 'expired' | 'limit' | 'blocked'
  // Soft banner shown on the active-chat view when an admin disables chat for
  // the customer's plan mid-conversation. We don't terminate the in-flight
  // chat (hostile UX) — just tell them this is their last session.
  const [planChangedNotice, setPlanChangedNotice] = useState(false);
  const [limitInfo, setLimitInfo] = useState(null); // { used, limit } when over chat limit
  // Inline quota pill — always shown (not only when over-limit) so the customer
  // sees their remaining chats before starting one.
  const [chatUsageInfo, setChatUsageInfo] = useState(null); // { used, limit } | null
  // Pre-chat category — drives skill-tag-based routing in pickAgent. Three
  // mutually-exclusive buckets matched to the admin's agent tagging vocabulary
  // (technical, primary_billing/secondary_billing, other). Persisted on the chat row.
  const [chatCategory, setChatCategory] = useState('technical');

  const bottomRef      = useRef(null);
  const isCancellingRef = useRef(false);
  const statusRef       = useRef(status);
  const [pendingAttachment, setPendingAttachment] = useState(null);
  const typingTimer = useRef(null);
  const fileRef     = useRef(null);
  const msgPaneRef  = useRef(null);

  // Ctrl+V on the composer attaches the clipboard screenshot — same gate as the
  // file picker (25 MB cap, single pending attachment).
  const onPasteImage = useCallback((file) => {
    if (!chat) return;
    if (file.size > 25 * 1024 * 1024) {
      toast.error(`${file.name} is too large (max 25 MB)`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPendingAttachment({ file, dataUrl: reader.result });
    reader.readAsDataURL(file);
  }, [chat]);
  const pasteRef = useImagePaste(onPasteImage);

  // Persist customer's preferred chat messages-pane height across sessions.
  useEffect(() => {
    const el = msgPaneRef.current;
    if (!el) return;
    try {
      const saved = localStorage.getItem('cust_chat_msgpane_height');
      if (saved) el.style.height = `${parseInt(saved, 10)}px`;
    } catch {}
    let t;
    const obs = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        try { localStorage.setItem('cust_chat_msgpane_height', String(Math.round(el.offsetHeight))); } catch {}
      }, 300);
    });
    obs.observe(el);
    return () => { clearTimeout(t); obs.disconnect(); };
  }, [chat?.id]);

  const navigate = useNavigate();

  // Shared app-wide call engine (same instance the Call page + floating
  // mini-call use). Using the shared context — not a private useWebRTCCall()
  // — means a call started here survives navigation (controls reappear on
  // return, mini-call shows while away) and is hung up cleanly on end, so it
  // counts toward the customer's limit. Previously this page held its own
  // instance that leaked the call (ghost audio, never counted) on navigation.
  const {
    callState, agentName: callAgentName, elapsed, isMuted, error: callError,
    startCall, endCall, toggleMute, reset: resetCall, primeAudio,
  } = useCustomerCall();

  // Hydrate restriction state from the customer dashboard. Used both on mount
  // and when the admin pushes a `plan_changed` event so an open chat page
  // re-evaluates its restrictions without a manual refresh.
  // `isPlanPush` = true means this is a mid-session refetch; if the customer
  // is in an active chat AND chat is now disallowed, we show the soft "your
  // plan changed — this session will end" banner instead of yanking them.
  const hydrateFromDashboard = useCallback(({ isPlanPush = false } = {}) => {
    return getCustomerDashboard()
      .then(res => {
        const { allowChat, allowCalls: planAllowCalls, isActive, chatLimit } = res.data.plan;
        const chatUsed = res.data.usage?.chatUsed ?? 0;
        const chatBlocked = !!res.data.chatBlocked;
        setAllowCalls(!!(planAllowCalls && isActive));
        setChatUsageInfo({ used: chatUsed, limit: chatLimit });
        const currentStatus = statusRef.current;
        const inLiveSession = currentStatus === 'active' || currentStatus === 'waiting';
        // Admin block trumps everything.
        if (chatBlocked) {
          if (isPlanPush && inLiveSession) { setPlanChangedNotice(true); return null; }
          setRestrictReason('blocked'); setStatus('restricted'); return null;
        }
        if (!isActive) {
          if (isPlanPush && inLiveSession) { setPlanChangedNotice(true); return null; }
          setRestrictReason('expired'); setStatus('restricted'); return null;
        }
        if (!allowChat) {
          if (isPlanPush && inLiveSession) { setPlanChangedNotice(true); return null; }
          setRestrictReason('plan'); setStatus('restricted'); return null;
        }
        if (chatLimit !== null && chatLimit !== undefined && chatUsed >= chatLimit) {
          if (isPlanPush && inLiveSession) { setPlanChangedNotice(true); return null; }
          setRestrictReason('limit');
          setLimitInfo({ used: chatUsed, limit: chatLimit });
          setStatus('restricted');
          return null;
        }
        // Chat is allowed — clear the soft banner if it was set previously
        // (admin reverted the change).
        setPlanChangedNotice(false);
        return isPlanPush ? null : getActiveChat();
      })
      .then(res => {
        if (!res) return;
        if (res.data.chat) {
          setChat(res.data.chat);
          setMessages(res.data.messages || []);
          setQueuePos(res.data.queue_position);
          setStatus(res.data.chat.status === 'waiting' ? 'waiting' : 'active');
          if (res.data.chat.status === 'active') setAgentName(res.data.chat.agent_name || '');
        } else {
          setStatus('idle');
        }
      })
      .catch(err => {
        if (err.response?.status === 403) setStatus('restricted');
        else if (!isPlanPush) setStatus('idle');
      });
  }, []);

  // Load active chat on mount — pre-check plan first to avoid showing idle then restricted flash
  useEffect(() => {
    setStatus('loading');
    hydrateFromDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live plan-change push from admin — refetch dashboard so restriction
  // banners and "Live chat unavailable" cards update immediately. In-flight
  // chats keep running (soft banner only).
  useEffect(() => {
    if (!socket) return;
    const onPlanChanged = () => hydrateFromDashboard({ isPlanPush: true });
    socket.on('plan_changed', onPlanChanged);
    return () => socket.off('plan_changed', onPlanChanged);
  }, [socket, hydrateFromDashboard]);

  // Keep statusRef in sync so socket handlers can read current status without stale closure
  useEffect(() => { statusRef.current = status; }, [status]);

  // Fetch agent availability when idle; re-fetch on socket push, on tab focus, and
  // every 12s as a fallback. Faster than the old 60s tick so a customer who opened
  // the chat page before any agent came online still sees the banner flip from
  // "No agents available" to "1 agent online" within ~12 seconds of the agent
  // connecting, even if the socket push was missed.
  const fetchAgentAvail = useCallback(() => {
    getCustomerAgentStatus().then(res => setAgentAvail(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    // Keep polling availability while idle OR waiting — a waiting customer
    // needs to know whether agents are simply busy (likely to free up soon)
    // or completely offline (likely a long wait). Without this the customer
    // saw "Connecting…" indefinitely even if the only online agent was tied
    // up on another chat the whole time.
    if (status !== 'idle' && status !== 'waiting') return;
    fetchAgentAvail();
    socket?.on('agent_availability_changed', fetchAgentAvail);
    const interval = setInterval(fetchAgentAvail, 12000);
    const onFocus = () => fetchAgentAvail();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      socket?.off('agent_availability_changed', fetchAgentAvail);
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [status, socket, fetchAgentAvail]);

  // Auto-start when bot routes here with ?start=1 — watches searchParams so it fires
  // even when the user is already on this page (same-route navigation from bot widget)
  useEffect(() => {
    if (searchParams.get('start') === '1' && status === 'idle') {
      setSearchParams({}, { replace: true });
      startChat();
    }
  }, [searchParams, status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Socket listeners
  useEffect(() => {
    if (!socket || !chat) return;
    socket.emit('join_chat', { chatId: chat.id });

    const onHistory  = ({ messages: msgs }) => {
      // Merge instead of replace so any new_message that arrived first isn't lost.
      // Dedupe by id — chat_history can race with new_message during accept.
      setMessages(prev => {
        const seen = new Set(msgs.map(m => m.id));
        const extras = prev.filter(m => !seen.has(m.id));
        return [...msgs, ...extras];
      });
    };
    const onNewMessage = ({ message }) => {
      // Dedupe by id — when an agent accepts, the greeting can arrive both via
      // chat_history (from this socket's join_chat) and via new_message (from
      // the accept_chat handler's emit), so a naive append would duplicate it.
      setMessages(m => (m.some(x => x.id === message.id) ? m : [...m, message]));
      // If agent sent this message, it's not ours — mark read
      if (message.sender_role === 'agent' || message.sender_role === 'admin') {
        socket.emit('mark_read', { chatId: chat.id });
      }
    };
    const onAccepted = ({ agentName: name }) => {
      setAgentName(name);
      setStatus('active');
      setQueuePos(null);
      // Only toast for a genuine new acceptance, not a reconnect to an already-active chat
      if (statusRef.current === 'waiting') {
        toast.success(`Agent ${name} has joined the chat`);
      }
    };
    const onClosed = () => {
      if (isCancellingRef.current) return;
      setStatus('closed');
      setChatClosed(true);
      setTimeout(() => setShowCsat(true), 800);
    };
    const onTyping = ({ role, isTyping }) => {
      if (role !== 'customer') setTyping(isTyping);
    };
    const onRead = () => setReadByAgent(true);
    const onTransferredToCustomer = ({ newAgentName, fromAgentName }) => {
      // Update header agent name + insert a system message so the customer knows the handoff happened.
      setAgentName(newAgentName);
      const systemMsg = {
        id: `xfer-${Date.now()}`,
        sender_role: 'system',
        sender_name: 'System',
        message: `You're now connected with ${newAgentName}${fromAgentName ? ` (transferred from ${fromAgentName})` : ''}.`,
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, systemMsg]);
      toast.success(`Transferred to ${newAgentName}`);
    };

    socket.on('chat_history',  onHistory);
    socket.on('new_message',   onNewMessage);
    socket.on('chat_accepted', onAccepted);
    socket.on('chat_closed',   onClosed);
    socket.on('user_typing',   onTyping);
    socket.on('messages_read', onRead);
    socket.on('chat_transferred_to_customer', onTransferredToCustomer);

    return () => {
      socket.off('chat_history',  onHistory);
      socket.off('new_message',   onNewMessage);
      socket.off('chat_accepted', onAccepted);
      socket.off('chat_closed',   onClosed);
      socket.off('user_typing',   onTyping);
      socket.off('messages_read', onRead);
      socket.off('chat_transferred_to_customer', onTransferredToCustomer);
    };
  }, [socket, chat]);

  // Queue position poll every 8s while waiting. Doubles as a stuck-state escape
  // hatch — if the customer's socket missed `chat_accepted` (brief disconnect
  // during agent acceptance), this poll detects the active state on the next tick
  // and transitions the UI. Also re-poll on tab focus so customers coming back to
  // a backgrounded tab don't see a stale "In queue" screen.
  useEffect(() => {
    if (status !== 'waiting') return;
    const refresh = async () => {
      try {
        const res = await getActiveChat();
        if (!res.data.chat) return;
        if (res.data.chat.status === 'active') {
          // Agent accepted while we weren't listening — promote to active.
          setStatus('active');
          setAgentName(res.data.chat.agent_name || '');
          setQueuePos(null);
          if (res.data.messages?.length) setMessages(res.data.messages);
        } else if (res.data.queue_position != null) {
          setQueuePos(res.data.queue_position);
        }
      } catch (err) {
        if (err.response?.status === 403) setStatus('restricted');
      }
    };
    const interval = setInterval(refresh, 8000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [status]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typing]);

  const startNewChat = () => {
    clearTimeout(typingTimer.current);
    setChat(null);
    setMessages([]);
    setInput('');
    setStatus('idle');
    setAgentName('');
    setTyping(false);
    setQueuePos(null);
    setReadByAgent(false);
    setShowCsat(false);
    setChatClosed(false);
    setPendingAttachment(null);
    setRestrictReason('plan');
    resetCall();
  };

  const startChat = async () => {
    setStatus('loading');
    try {
      const res = await initiateChat({ category: chatCategory });
      if (res.data.already_exists) {
        // Chat already open — load full state via getActiveChat to get queue position and messages
        const active = await getActiveChat();
        setChat(active.data.chat);
        setMessages(active.data.messages || []);
        setQueuePos(active.data.queue_position ?? null);
        setStatus(active.data.chat.status === 'waiting' ? 'waiting' : 'active');
        if (active.data.chat.status === 'active') setAgentName(active.data.chat.agent_name || '');
        return;
      }
      setChat(res.data.chat);
      setQueuePos(res.data.queue_position ?? null);
      setStatus(res.data.chat.status === 'waiting' ? 'waiting' : 'active');
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 403) {
        if (data?.limit_exceeded) {
          setStatus('idle');
          toast.error(data.error);
        } else {
          // Carry the backend's reason through if present so the restricted
          // screen shows the right copy. Blacklist 403s now include
          // `reason: 'blacklisted'`; older plan/expired 403s fall through.
          if (data?.reason === 'blacklisted') setRestrictReason('blocked');
          else if (data?.upgrade_required && /expired/i.test(data?.error || '')) setRestrictReason('expired');
          else if (data?.upgrade_required) setRestrictReason('plan');
          setStatus('restricted');
          toast.error(data?.error || 'Chat not available');
        }
      } else {
        setStatus('idle');
        toast.error('Failed to start chat');
      }
    }
  };

  const handleSend = useCallback((e) => {
    e?.preventDefault();
    if (!chat || status !== 'active') return;
    if (pendingAttachment) {
      socket?.emit('send_file', {
        chatId: chat.id,
        fileName: pendingAttachment.file.name,
        fileType: pendingAttachment.file.type,
        fileData: pendingAttachment.dataUrl,
        caption: input.trim(),
      });
      setPendingAttachment(null);
      setInput('');
      socket?.emit('typing', { chatId: chat.id, isTyping: false });
      return;
    }
    if (!input.trim()) return;
    socket?.emit('send_message', { chatId: chat.id, message: input.trim() });
    setInput('');
    setReadByAgent(false);
    socket?.emit('typing', { chatId: chat.id, isTyping: false });
  }, [input, chat, status, socket, pendingAttachment]);

  const handleTyping = (val) => {
    setInput(val);
    if (socket && chat) {
      socket.emit('typing', { chatId: chat.id, isTyping: true });
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => {
        socket.emit('typing', { chatId: chat.id, isTyping: false });
      }, 1500);
    }
  };

  const handleClose = async () => {
    if (!chat) return;
    // Ending the chat ends the call too — a call started here belongs to this
    // conversation. endCall() emits the hang-up (so it's counted) + tears down.
    if (['requesting', 'ringing', 'active'].includes(callState)) endCall();
    try {
      await closeChat(chat.id);
      socket?.emit('close_chat', { chatId: chat.id });
      setStatus('closed');
      setChatClosed(true);
      setTimeout(() => setShowCsat(true), 800);
    } catch { toast.error('Failed to close chat'); }
  };

  const cancelQueuedChat = async () => {
    if (!chat) return;
    try {
      isCancellingRef.current = true;
      await closeChat(chat.id);
      isCancellingRef.current = false;
      startNewChat();
    } catch {
      isCancellingRef.current = false;
      toast.error('Failed to cancel — please try again');
    }
  };

  const handleCallAgent = async () => {
    // Unlock audio NOW, inside the tap gesture — the `await` below leaves the
    // gesture, and mobile blocks audio that first plays outside one.
    primeAudio();
    try {
      const res = await initiateCall(chat.id);
      await startCall(res.data.call.id, chat.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not start call');
    }
  };

  useEffect(() => {
    if (activeTab !== 'history' || historyLoaded) return;
    setHistoryLoading(true);
    getChatHistory()
      .then(r => { setChatHistory(r.data.chats); setChatUsageResetAt(r.data.usage_reset_at || null); setHistoryLoaded(true); })
      .catch(() => toast.error('Failed to load chat history'))
      .finally(() => setHistoryLoading(false));
  }, [activeTab, historyLoaded]);

  const reloadHistory = () => {
    setHistoryLoaded(false);
    setHistoryLoading(true);
    getChatHistory()
      .then(r => { setChatHistory(r.data.chats); setChatUsageResetAt(r.data.usage_reset_at || null); setHistoryLoaded(true); })
      .catch(() => toast.error('Failed to load chat history'))
      .finally(() => setHistoryLoading(false));
  };

  // Live call now shows in the CustomerCallModal popup; the inline banner is
  // only for the brief post-call notices (ended / rejected / etc.).
  const showCallBanner  = ['ended', 'rejected', 'no_answer', 'error', 'no_agents'].includes(callState);
  const estWaitMins     = queuePos != null ? Math.max(1, queuePos * 2) : null;


  return (
    <Layout>
      {showCsat && chat && (
        <CsatModal
          chatId={chat.id}
          onClose={() => {
            // Just close the rating modal. The ended chat thread stays on screen
            // (status='closed') so the customer can re-read what was said. They
            // dismiss it explicitly via the "New Chat" button in the footer.
            setShowCsat(false);
          }}
        />
      )}

      <div className="max-w-2xl mx-auto">
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Live Chat</h1>
            <p className="text-sm text-gray-500 mt-0.5">Chat with a support agent in real time</p>
            {chatUsageInfo && chatUsageInfo.limit != null && (() => {
              const { used, limit } = chatUsageInfo;
              const remaining = Math.max(0, limit - used);
              const pct = limit > 0 ? used / limit : 0;
              const tone = pct >= 1 ? 'bg-red-50 border-red-200 text-red-700'
                         : pct >= 0.7 ? 'bg-amber-50 border-amber-200 text-amber-700'
                         : 'bg-emerald-50 border-emerald-200 text-emerald-700';
              return (
                <div className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold ${tone}`}>
                  <MessageSquare className="w-3.5 h-3.5" />
                  Chats this month: {used} / {limit} · {remaining} remaining
                </div>
              );
            })()}
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-5 border-b border-gray-200">
          <button
            onClick={() => setActiveTab('chat')}
            className={clsx('flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === 'chat' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            <MessageSquare className="w-4 h-4" /> Live Chat
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={clsx('flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === 'history' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            )}
          >
            <History className="w-4 h-4" /> This Month's Chats
            {chatHistory.length > 0 && (
              <span
                className="ml-1 bg-indigo-100 text-indigo-600 text-xs font-semibold px-1.5 py-0.5 rounded-full"
                title={`${chatHistory.filter(c => c.counted).length} of ${chatHistory.length} count toward your monthly quota`}
              >
                {chatHistory.length}
                {chatHistory.some(c => c.counted) && (
                  <span className="text-indigo-400 font-normal">
                    {' '}· {chatHistory.filter(c => c.counted).length} counted
                  </span>
                )}
              </span>
            )}
          </button>
        </div>

        {activeTab === 'chat' && <>

        {/* Restricted — copy depends on why */}
        {status === 'restricted' && (
          <div className="card p-8 text-center">
            <div className={`w-16 h-16 ${restrictReason === 'blocked' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'} border-2 rounded-full flex items-center justify-center mx-auto mb-5`}>
              <Lock className={`w-8 h-8 ${restrictReason === 'blocked' ? 'text-red-500' : 'text-amber-500'}`} />
            </div>
            <h3 className="font-semibold text-gray-800 text-lg mb-2">
              {restrictReason === 'blocked' ? 'Chat Access Restricted'
                : restrictReason === 'limit' ? 'Monthly Chat Limit Reached'
                : restrictReason === 'expired' ? 'Plan Expired'
                : 'Live Chat Unavailable'}
            </h3>
            {restrictReason === 'blocked' && (
              <p className="text-sm text-gray-500 mb-6">
                Live chat has been disabled on your account by our support team. Your tickets and call support are still available. If you believe this is a mistake, please reach out via a support ticket and we'll look into it.
              </p>
            )}
            {restrictReason === 'expired' && (
              <p className="text-sm text-gray-500 mb-6">
                Your support plan has expired. Please renew to restore live chat access.
              </p>
            )}
            {restrictReason === 'plan' && (
              <>
                <p className="text-sm text-gray-500 mb-1">
                  Live chat is available on the{' '}
                  <span className="font-semibold text-indigo-600">Basic plan</span> and above.
                </p>
                <p className="text-sm text-gray-500 mb-6">
                  Upgrade your plan to start a live conversation with our support agents.
                </p>
              </>
            )}
            {restrictReason === 'limit' && limitInfo && (
              <>
                <p className="text-sm text-gray-500 mb-1">
                  You've used <span className="font-semibold text-gray-700">{limitInfo.used}/{limitInfo.limit}</span> chat sessions this month.
                </p>
                <p className="text-sm text-gray-500 mb-6">
                  Your limit resets at the start of next month, or upgrade now for a higher allowance.
                </p>
              </>
            )}
            <div className="flex flex-col items-center gap-3">
              {restrictReason === 'blocked' ? (
                <button
                  onClick={() => navigate('/customer/tickets', { state: { openNewTicket: true } })}
                  className="btn-primary mx-auto"
                >
                  Open a Support Ticket
                </button>
              ) : (
                <button
                  onClick={() => navigate('/customer/billing', { state: { tab: 'plan' } })}
                  className="btn-primary mx-auto"
                >
                  {restrictReason === 'expired' ? 'Renew Plan' : 'View Plans & Upgrade'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Idle */}
        {status === 'idle' && (
          <div className="card p-8 text-center">
            <div className="w-14 h-14 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <MessageCircle className="w-7 h-7 text-indigo-600" />
            </div>
            <h3 className="font-semibold text-gray-700 mb-2">Start a Live Chat</h3>

            {/* Agent availability / estimated wait */}
            {agentAvail !== null && (
              <div className="flex items-start justify-center gap-1.5 mb-3">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${agentAvail.online ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                <span className={`text-xs font-medium ${agentAvail.online ? 'text-green-600' : 'text-gray-500'}`}>
                  {agentAvail.online
                    ? 'Agents available · typically under 5 min wait'
                    : !agentAvail.withinHours
                      ? `Outside working hours · ${agentAvail.workDaysLabel}, ${agentAvail.workStart % 12 || 12} ${agentAvail.workStart >= 12 ? 'PM' : 'AM'} – ${agentAvail.workEnd % 12 || 12} ${agentAvail.workEnd >= 12 ? 'PM' : 'AM'} IST`
                      : 'No agents available right now'}
                </span>
              </div>
            )}

            <p className="text-sm text-gray-500 mb-5">
              {agentAvail !== null && !agentAvail.withinHours
                ? 'You can still start a chat and the next available agent will connect during working hours.'
                : agentAvail !== null && !agentAvail.online
                  ? 'You can still start a chat and the next available agent will connect with you.'
                  : 'Connect with a support agent via the assistant or start directly.'}
            </p>
            <div className="flex flex-col items-center gap-3">
              {/* Pre-chat category — drives skill-tag-based routing. Three buckets
                  matched to the admin's tagging vocabulary: technical → agent with
                  `technical` tag, billing → agent with `primary_billing` (falls back
                  to `secondary_billing` if primary unavailable), others → agent with
                  `other` tag or any agent if no `other`-tagged agent is online. */}
              <div className="w-full max-w-xs">
                <label className="text-xs font-semibold text-gray-600 block mb-1.5 text-center">What do you need help with?</label>
                <div className="grid grid-cols-3 gap-1.5 text-xs">
                  {[
                    { value: 'technical', label: 'Technical' },
                    { value: 'billing',   label: 'Billing' },
                    { value: 'others',    label: 'Others' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setChatCategory(opt.value)}
                      className={`px-3 py-1.5 rounded-lg border font-medium transition-colors ${chatCategory === opt.value ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 flex-wrap justify-center">
                <button data-testid="CustomerChat-StartChatButton" onClick={() => status === 'idle' && startChat()} className="btn-primary">
                  <MessageSquare className="w-4 h-4" /> Start Chat
                </button>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent('open-bot-widget'))}
                  className="btn-secondary"
                >
                  <MessageCircle className="w-4 h-4" /> Open Assistant
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Loading */}
        {status === 'loading' && (
          <div className="card p-8 flex items-center justify-center gap-3 text-gray-500">
            <Loader className="w-5 h-5 animate-spin" />
            <span className="text-sm">Connecting...</span>
          </div>
        )}

        {/* Waiting */}
        {status === 'waiting' && (
          <div className="card p-8 text-center">
            <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4 relative">
              <Clock className="w-7 h-7 text-amber-600" />
              <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-400 rounded-full animate-ping" />
            </div>
            {/* Adapt the heading + body to the live availability picture so the
                customer understands WHY they're waiting:
                  - agents free now      → "Connecting you with an agent…"
                  - all agents busy     → "All our agents are with other customers…"
                  - nobody online       → "No agents are online right now"
                  - outside work hours  → mention work-hours window
                Without this the customer just saw "Connecting…" no matter
                what, even if the only agent was tied up the whole time. */}
            {(() => {
              const av = agentAvail || {};
              const allBusy = av.totalOnline > 0 && av.availableCount === 0;
              const offline = av.totalOnline === 0 || !av.online;
              const headline = queuePos > 1
                ? 'In Queue'
                : offline ? "No agents are online right now"
                : allBusy ? "All our agents are with other customers"
                : 'Connecting you with an agent…';
              return (
                <>
                  <h3 className="font-semibold text-gray-700 mb-2">{headline}</h3>
                  {/* Position only meaningful if there are people ahead. */}
                  {queuePos != null && queuePos > 1 && (
                    <div className="mb-3 space-y-1">
                      <p className="text-sm font-semibold text-amber-700">
                        {queuePos - 1} chat{queuePos - 1 === 1 ? '' : 's'} ahead of you
                      </p>
                      <p className="text-xs text-gray-500">
                        Estimated wait: ~{estWaitMins} min{estWaitMins !== 1 ? 's' : ''}
                      </p>
                    </div>
                  )}
                  {/* Live availability + queue position. Green dot + "Agent
                      online" reassures the customer that someone is in fact
                      reachable, even if currently busy. Queue position is
                      appended on the same line so it reads as one status
                      message. */}
                  {av.totalOnline != null && (
                    av.totalOnline > 0 ? (
                      <p className="text-xs font-medium text-green-600 mb-2 inline-flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                        Agent online
                        {queuePos != null && (
                          <span className="text-gray-500 font-normal">
                            {' · '}
                            {queuePos === 1
                              ? 'You are next in queue'
                              : `Your position in queue: ${queuePos}`}
                          </span>
                        )}
                      </p>
                    ) : (
                      <p className="text-xs font-medium text-gray-400 mb-2 inline-flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
                        No agents online
                        {queuePos != null && (
                          <span className="text-gray-500 font-normal">
                            {' · '}
                            {queuePos === 1
                              ? 'You are next in queue'
                              : `Your position in queue: ${queuePos}`}
                          </span>
                        )}
                      </p>
                    )
                  )}
                  <p className="text-sm text-gray-500 mb-4">
                    {offline
                      ? (av.withinHours
                          ? "We'll notify you as soon as someone signs on. You can leave this tab open."
                          : `Support hours are ${av.workStart != null ? `${av.workStart}:00 – ${av.workEnd}:00 IST` : 'limited'}${av.workDaysLabel ? ` (${av.workDaysLabel})` : ''}.`)
                      : allBusy
                        ? "Your chat is queued — we'll connect you the moment an agent finishes their current conversation."
                        : queuePos === 1
                          ? "We're notifying our agents now. This usually takes under a minute."
                          : 'A support agent will join shortly. Please wait...'}
                  </p>
                </>
              );
            })()}
            <div className="flex items-center justify-center gap-1.5 text-xs text-amber-600 mb-4">
              <span className="w-2 h-2 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-amber-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <button
              onClick={cancelQueuedChat}
              className="text-sm text-gray-500 hover:text-red-600 hover:bg-red-50 border border-gray-200 hover:border-red-200 px-4 py-1.5 rounded-lg transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Plan-changed soft banner — admin disabled chat (or limit reached /
            plan expired) mid-conversation. We let this session finish and
            block re-initiation afterwards. */}
        {planChangedNotice && (status === 'active' || status === 'waiting') && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Your plan changed — chat access updated</p>
              <p className="text-xs mt-0.5">You can finish this conversation, but you won't be able to start a new chat afterwards unless your plan is updated.</p>
            </div>
          </div>
        )}

        {/* Active / closed chat — overflow-y-auto so user can scroll when content grows tall.
            Mobile: fill most of the dynamic viewport so the conversation uses the
            whole screen. Desktop: keep the original fixed height exactly. */}
        {(status === 'active' || status === 'closed') && chat && (
          <div className={clsx(
            'card overflow-y-auto flex flex-col h-[72dvh] min-h-[460px]',
            showCallBanner ? 'lg:h-[600px]' : 'lg:h-[540px]'
          )}>
            {/* Header */}
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between bg-white flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-indigo-100 rounded-full flex items-center justify-center relative">
                  <Headphones className="w-4 h-4 text-indigo-600" />
                  {status === 'active' && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 rounded-full border-2 border-white" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">{agentName || 'Support Agent'}</p>
                  <p className="text-xs text-gray-400">{status === 'active' ? 'Online · Live' : 'Session ended'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {status === 'active' && callState === 'idle' && allowCalls && (
                  <button onClick={handleCallAgent} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 font-medium border border-green-200">
                    <Phone className="w-3.5 h-3.5" /> Call
                  </button>
                )}
                {status === 'closed' && !showCsat && (
                  <button onClick={() => setShowCsat(true)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200">
                    <Star className="w-3.5 h-3.5" /> Rate
                  </button>
                )}
                {status === 'active' && (
                  <button onClick={handleClose} className="btn-secondary text-xs py-1 px-2">
                    <X className="w-3 h-3" /> End
                  </button>
                )}
                {status === 'closed' && (
                  <button
                    onClick={startNewChat}
                    title="Close this conversation"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>

            {/* Call banner */}
            {showCallBanner && (
              <div className={clsx('flex-shrink-0 px-4 py-2.5 border-b text-sm',
                callState === 'active'    ? 'bg-green-50 border-green-200' :
                callState === 'ringing'   ? 'bg-amber-50 border-amber-200' :
                callState === 'requesting'? 'bg-blue-50 border-blue-200' :
                'bg-gray-50 border-gray-200'
              )}>
                {callState === 'requesting' && (
                  <div className="flex items-center gap-2 text-blue-700"><Loader className="w-4 h-4 animate-spin" /><span>Requesting microphone...</span></div>
                )}
                {callState === 'ringing' && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-amber-700"><PhoneCall className="w-4 h-4 animate-pulse" /><span>Calling...</span></div>
                    <button onClick={endCall} className="text-xs px-2 py-1 rounded bg-amber-200 text-amber-800 hover:bg-amber-300 font-medium">Cancel</button>
                  </div>
                )}
                {callState === 'active' && (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-green-700">
                      <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                      <span className="font-medium">On call · {formatDuration(elapsed)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button onClick={toggleMute} className={clsx('p-1.5 rounded', isMuted ? 'bg-amber-100 text-amber-700' : 'bg-green-200 text-green-800 hover:bg-green-300')}>
                        {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={endCall} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200 font-medium">
                        <PhoneOff className="w-3.5 h-3.5" /> End Call
                      </button>
                    </div>
                  </div>
                )}
                {callState === 'ended' && (
                  <div className="flex items-center justify-between text-gray-600">
                    <div className="flex items-center gap-2"><PhoneOff className="w-4 h-4 text-gray-400" /><span>Call ended — {formatDuration(elapsed)}</span></div>
                    <button onClick={resetCall} className="text-xs text-gray-500 underline">Dismiss</button>
                  </div>
                )}
                {(callState === 'rejected' || callState === 'no_answer') && (
                  <div className="flex items-center justify-between">
                    <span className="text-red-700 text-sm">{callState === 'rejected' ? 'Call declined' : 'No answer'}</span>
                    <button onClick={resetCall} className="text-xs text-gray-500 underline">Dismiss</button>
                  </div>
                )}
                {callState === 'no_agents' && (
                  <div className="flex items-center justify-between">
                    <span className="text-amber-700 text-sm">No agents available for call.</span>
                    <button onClick={resetCall} className="text-xs text-gray-500 underline">Dismiss</button>
                  </div>
                )}
                {callState === 'error' && (
                  <div className="flex items-center justify-between">
                    <span className="text-red-700 text-xs">{callError || 'Call failed'}</span>
                    <button onClick={resetCall} className="text-xs text-gray-500 underline">Dismiss</button>
                  </div>
                )}
              </div>
            )}

            {/* Messages — own corner-resize handle (drag bottom-right ↘) */}
            <div
              ref={msgPaneRef}
              className="overflow-y-auto resize-y p-4 space-y-3 flex-shrink-0"
              style={{ height: '380px', minHeight: '180px' }}
            >
              <div className="text-center text-xs text-gray-400 mb-2">Chat started</div>
              {/* Drop rows with no body AND no attachment — they render as orphan
                  timestamps if the message body somehow arrives blank (race on the
                  auto-greeting insert, transfer system rows that lost their text). */}
              {messages.filter(m => (m.message && m.message.trim()) || m.file_url || m.file_type).map((m, idx, arr) => {
                if (m.sender_role === 'system') {
                  return (
                    <div key={m.id} className="flex justify-center msg-animate">
                      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">
                        <ArrowRightLeft className="w-3 h-3 flex-shrink-0" />
                        <span>{m.message}</span>
                      </div>
                    </div>
                  );
                }
                const isMine  = m.sender_id === user.id;
                const isLast  = idx === arr.length - 1;
                const isImage = m.file_type?.startsWith('image/');
                return (
                  <div key={m.id} className={clsx('flex gap-2 msg-animate', isMine ? 'flex-row-reverse' : 'flex-row')}>
                    <div className={clsx('w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-xs', isMine ? 'bg-indigo-100' : 'bg-gray-200')}>
                      {isMine ? <User className="w-3.5 h-3.5 text-indigo-600" /> : <Headphones className="w-3.5 h-3.5 text-gray-600" />}
                    </div>
                    <div className={clsx('max-w-xs flex flex-col', isMine ? 'items-end' : 'items-start')}>
                      {m.file_url ? (
                        isImage ? (
                          <a href={m.file_url} target="_blank" rel="noreferrer">
                            <img src={m.file_url} alt={m.file_name} className="max-w-[200px] rounded-xl border border-gray-200 shadow-sm cursor-pointer hover:opacity-90 transition-opacity" />
                          </a>
                        ) : (
                          <a href={m.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-xl text-xs text-indigo-600 hover:bg-gray-200 border border-gray-200">
                            <Paperclip className="w-3.5 h-3.5" /> {m.file_name || 'Attachment'}
                          </a>
                        )
                      ) : (
                        <div className={clsx('px-3 py-2 rounded-xl text-sm whitespace-pre-wrap break-words', isMine ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-gray-100 text-gray-800 rounded-tl-none')}>
                          {renderMarkdown(m.message)}
                        </div>
                      )}
                      <div className="flex items-center gap-1 mt-0.5">
                        <p className="text-xs text-gray-400">
                          {new Date(m.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                        {isMine && isLast && (
                          readByAgent
                            ? <CheckCheck className="w-3 h-3 text-blue-500" />
                            : <Check className="w-3 h-3 text-gray-400" />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {typing && (
                <div className="flex gap-2 items-center msg-animate">
                  <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center">
                    <Headphones className="w-3.5 h-3.5 text-gray-600" />
                  </div>
                  <div className="bg-gray-100 rounded-xl rounded-tl-none px-4 py-2.5 flex gap-1">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            {status === 'active' && (
              <div className="border-t border-gray-100 p-3 flex-shrink-0 bg-white">
                {pendingAttachment && (
                  <div className="flex items-center gap-2 px-2 py-1.5 bg-indigo-50 border border-indigo-100 rounded-lg mb-2">
                    {pendingAttachment.file.type.startsWith('image/') ? (
                      <img src={pendingAttachment.dataUrl} className="w-10 h-10 object-cover rounded flex-shrink-0" alt="" />
                    ) : (
                      <div className="w-10 h-10 bg-indigo-100 rounded flex items-center justify-center flex-shrink-0">
                        <Paperclip className="w-4 h-4 text-indigo-600" />
                      </div>
                    )}
                    <span className="flex-1 text-xs text-gray-600 truncate">{pendingAttachment.file.name}</span>
                    <button type="button" onClick={() => setPendingAttachment(null)} className="text-gray-400 hover:text-red-500 flex-shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                <form data-testid="CustomerChat-ComposerForm" onSubmit={handleSend} className="flex gap-2 items-end">
                  <div className="flex-1 flex items-end gap-1 input px-2 py-1.5">
                    <textarea
                      data-testid="CustomerChat-MessageInput"
                      ref={pasteRef}
                      className="flex-1 text-sm outline-none bg-transparent resize-y min-h-[40px] lg:min-h-[28px]"
                      style={{ maxHeight: '500px' }}
                      rows={1}
                      placeholder={pendingAttachment ? 'Add a caption… (optional)' : 'Type a message…  (Enter to send, Shift+Enter for newline · paste a screenshot with Ctrl+V)'}
                      value={input}
                      onChange={e => handleTyping(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(e); } }}
                    />
                    <button data-testid="CustomerChat-AttachButton" type="button" onClick={() => fileRef.current?.click()} className={clsx('transition-colors flex-shrink-0', pendingAttachment ? 'text-indigo-600' : 'text-gray-400 hover:text-indigo-600')}>
                      <Paperclip className="w-4 h-4" />
                    </button>
                    <input ref={fileRef} type="file" accept="image/*,.pdf,.doc,.docx,.txt" className="hidden" onChange={e => {
                      const file = e.target.files?.[0];
                      if (!file || !chat) return;
                      if (file.size > 25 * 1024 * 1024) {
                        toast.error(`${file.name} is too large (max 25 MB)`);
                        e.target.value = '';
                        return;
                      }
                      const reader = new FileReader();
                      reader.onload = () => setPendingAttachment({ file, dataUrl: reader.result });
                      reader.readAsDataURL(file);
                      e.target.value = '';
                    }} />
                  </div>
                  <button data-testid="CustomerChat-SendButton" type="submit" disabled={!input.trim() && !pendingAttachment} className="btn-primary py-2 px-3 flex-shrink-0">
                    <Send className="w-4 h-4" />
                  </button>
                </form>
              </div>
            )}
            {status === 'closed' && (
              <div className="border-t border-gray-100 px-4 py-3 flex items-center justify-between flex-shrink-0 bg-white">
                <span className="text-xs text-gray-400">Chat session ended</span>
                <div className="flex items-center gap-2">
                  {!showCsat && (
                    <button onClick={() => setShowCsat(true)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 font-medium">
                      <Star className="w-3.5 h-3.5" /> Rate
                    </button>
                  )}
                  <button onClick={startNewChat} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 border border-gray-200 font-medium">
                    <X className="w-3.5 h-3.5" /> Close
                  </button>
                  <button onClick={startNewChat} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium">
                    <MessageSquare className="w-3.5 h-3.5" /> New Chat
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        </> /* end activeTab === 'chat' */}

        {/* History tab */}
        {activeTab === 'history' && (
          <>
            {historyRatingId && (
              <CsatModal
                chatId={historyRatingId}
                onClose={() => setHistoryRatingId(null)}
                onSaved={(r) => setChatHistory(prev => prev.map(c => c.id === historyRatingId ? { ...c, rating: r } : c))}
              />
            )}
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm text-gray-500">Your past support chat sessions</p>
              <button onClick={reloadHistory} className="btn-secondary p-2" title="Refresh">
                <RefreshCw className={clsx('w-4 h-4', historyLoading && 'animate-spin')} />
              </button>
            </div>

            {historyLoading ? (
              <div className="flex items-center justify-center h-48">
                <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : chatHistory.length === 0 ? (
              <div className="card p-12 flex flex-col items-center text-gray-400">
                <History className="w-10 h-10 mb-3 opacity-20" />
                <p className="text-sm font-medium">No chats this billing period</p>
                <p className="text-xs mt-1 text-center max-w-xs">Live chat sessions from this billing period will appear here. The list resets at the start of each month, alongside your plan's chat quota.</p>
              </div>
            ) : (
              <div className="space-y-3 max-w-2xl">
                {(() => {
                  // Render with a divider where usage_reset_at landed, just like the
                  // call history view. Pre-reset rows stay visible (so the customer
                  // doesn't lose their record of past chats) but are greyed out and
                  // tagged so it's clear they no longer count toward quota.
                  const rows = [];
                  let dividerInserted = false;
                  chatHistory.forEach((c, idx) => {
                    if (c.pre_reset && !dividerInserted) {
                      rows.push(
                        <div key={`divider-${c.id}`} className="flex items-center gap-3 py-2 text-xs text-amber-700">
                          <div className="flex-1 border-t border-amber-200"></div>
                          <span className="font-medium text-center">
                            Usage was reset on {chatUsageResetAt ? new Date(chatUsageResetAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'this date'} — chats below do not count toward your current quota
                          </span>
                          <div className="flex-1 border-t border-amber-200"></div>
                        </div>
                      );
                      dividerInserted = true;
                    }
                    const dur = chatDuration(c.created_at, c.closed_at);
                    const engaged = !!c.has_customer_message;     // technical: customer sent a message
                    const counted = !!c.counted;                    // quota: engaged AND post-reset
                    const preReset = !!c.pre_reset;
                    rows.push(
                    <div
                      key={c.id}
                      className={`card p-4 ${preReset ? 'opacity-60' : ''}`}
                      title={preReset ? 'This chat happened before your usage was reset — it stays in your records but does not count toward your current quota.' : undefined}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${engaged ? 'bg-green-50' : 'bg-gray-100'}`}>
                          <UserCircle2 className={`w-5 h-5 ${engaged ? 'text-green-500' : 'text-gray-400'}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          {/* Title row */}
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <p className="text-sm font-semibold text-gray-800 truncate">
                              {c.agent_name ? `Chat with ${c.agent_name}` : 'Support Chat'}
                            </p>
                            <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full font-medium ${counted ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}
                                title={counted ? 'This chat counts toward your monthly quota.' : (preReset ? 'Counted before reset — no longer counts.' : 'No customer message sent, so it did not count.')}
                              >
                                {counted ? '✓ Counts toward quota' : '○ Does not count'}
                              </span>
                              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium capitalize ${c.status === 'closed' ? 'bg-gray-100 text-gray-500' : 'bg-yellow-100 text-yellow-700'}`}>
                                {c.status}
                              </span>
                            </div>
                          </div>
                          {/* Meta row */}
                          <div className="flex items-center gap-3 text-xs text-gray-400 mb-2">
                            <span>{new Date(c.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {dur ?? '< 1 min'}
                            </span>
                          </div>
                          {/* Rating row */}
                          <div className="flex items-center justify-between">
                            {c.rating
                              ? <StarRow count={c.rating} />
                              : <span className="text-xs text-gray-400 italic">Not rated</span>
                            }
                            {c.status === 'closed' && !c.rating && (
                              <button
                                onClick={() => setHistoryRatingId(c.id)}
                                className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold"
                              >
                                Rate session →
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                    );
                  });
                  return rows;
                })()}
              </div>
            )}
          </>
        )}

      </div>
    </Layout>
  );
}
