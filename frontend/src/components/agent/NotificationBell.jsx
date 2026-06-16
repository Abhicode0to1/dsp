import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSocket } from '../../contexts/SocketContext';
import { useAuth } from '../../contexts/AuthContext';
import { Bell, X, MessageSquare, UserCheck, Headphones, Zap, Clock, Phone, AlertTriangle, AlertCircle } from 'lucide-react';
import PushToggle from '../common/PushToggle';
import toast from 'react-hot-toast';
import clsx from 'clsx';

export default function NotificationBell() {
  const { socket } = useSocket();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  // Admins on the /admin/* panel get NO ring / no toast — they're not the ones
  // actively handling chats, and the side-by-side /agent tab is. The sidebar
  // badge counts and the bell-list entries still update so they can SEE
  // what's happening without being interrupted. Real agents on /agent (and
  // admins on /agent/*) get the full audible + toast experience.
  const isSilentForAdmin = user?.role === 'admin' && !location.pathname.startsWith('/agent');
  // Lazy initializer reads localStorage synchronously during the first render.
  // A useEffect-based load races with the useEffect-based save and clobbers
  // localStorage with [] on every mount — that's why the unread count was
  // disappearing on refresh.
  const [notifications, setNotifications] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('agent_notifications') || '[]');
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return saved.filter(n => new Date(n.time).getTime() > cutoff);
    } catch { return []; }
  });
  const [show, setShow] = useState(false);
  const ref = useRef(null);
  // Persistent ring state — used for new chat requests (rings until acknowledged/timeout)
  const ringRef = useRef(null);

  // Honor the agent's chosen availability. Sidebar persists this in localStorage and
  // mirrors changes on every set_status / agent_status_changed event. If the agent is
  // Away / Busy / On_break, suppress audible/visual nags — they explicitly said leave-me-alone.
  const isAgentAvailable = () => {
    try { return (localStorage.getItem('agent_status') || 'online') === 'online'; }
    catch { return true; }
  };
  // Chat toasts use a DETERMINISTIC id (`chat_<chatId>`) so any NotificationBell instance
  // can dismiss them — survives the unmount/remount cycle when the agent navigates
  // between pages (since each page renders its own NotificationBell).
  const chatToastId = (chatId) => `chat_${chatId}`;
  const dismissChatToast = useCallback((chatId) => {
    if (chatId == null) return;
    toast.dismiss(chatToastId(chatId));
  }, []);

  // Mark any chat_request / chat_assigned bell entries for this chatId as
  // read once the chat is no longer "available to grab" (accepted, taken,
  // cancelled, removed). Without this, accepting a chat leaves stale
  // notifications stacked in the bell — including duplicates from
  // sequential-ring re-rings.
  const clearChatNotifications = useCallback((chatId) => {
    if (chatId == null) return;
    setNotifications(ns => ns.map(n => (
      (n.chatId != null && Number(n.chatId) === Number(chatId) &&
       (n.type === 'chat_request' || n.type === 'chat_assigned'))
        ? { ...n, read: true }
        : n
    )));
  }, []);

  const playBeep = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
      osc.onended = () => ctx.close();
    } catch {}
  }, []);

  // Continuous ringtone (loops a single 3-second buffer: 1s ring + 2s silence).
  // Uses Web Audio bufferSource.loop=true so the browser handles looping —
  // more reliable than setTimeout-based patterns that can drift or be killed.
  const stopRing = useCallback(() => {
    const r = ringRef.current;
    if (!r) return;
    ringRef.current = null;
    try { clearTimeout(r.stopTimer); } catch {}
    try { r.source.stop(); } catch {}
    try { r.ctx.close(); } catch {}
  }, []);

  const startRing = useCallback(() => {
    if (ringRef.current) return; // Already ringing — don't stack
    // Silent mode for admins on /admin/* — the agent panel in the other tab
    // handles real-time alerts; admin's main panel stays quiet.
    if (isSilentForAdmin) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const sampleRate = ctx.sampleRate;
      const totalSec = 3; // one cycle: ~1s ring + 2s silence
      const buffer = ctx.createBuffer(1, sampleRate * totalSec, sampleRate);
      const data = buffer.getChannelData(0);
      const ringSec = 1;
      const fade = sampleRate * 0.04;
      for (let i = 0; i < sampleRate * ringSec; i++) {
        const t = i / sampleRate;
        const env = i < fade ? (i / fade)
                  : i > sampleRate * ringSec - fade ? Math.max(0, (sampleRate * ringSec - i) / fade)
                  : 1;
        // Two-tone ring (standard 480Hz + 620Hz, like a desk phone)
        data[i] = 0.22 * env * 0.5 * (Math.sin(2 * Math.PI * 480 * t) + Math.sin(2 * Math.PI * 620 * t));
      }
      // rest of buffer (1s..3s) stays 0 = silence

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(ctx.destination);

      const tryStart = () => {
        try { source.start(); } catch {}
      };
      if (ctx.state === 'suspended') ctx.resume().then(tryStart).catch(tryStart);
      else tryStart();

      // Safety: auto-stop after 90s in case nothing else stops us
      const stopTimer = setTimeout(() => stopRing(), 90000);
      ringRef.current = { ctx, source, stopTimer };
    } catch {}
  }, [stopRing, isSilentForAdmin]);

  const push = useCallback((n) => {
    setNotifications(prev => [
      { ...n, id: Date.now() + Math.random(), time: new Date(), read: false },
      ...prev.slice(0, 29),
    ]);
    // Away/Busy/On_break = full silence. Otherwise short beep for most events;
    // new chat requests use the continuous ring (started in the handler below).
    if (!isAgentAvailable()) return;
    if (n.type !== 'chat_request') playBeep();
  }, [playBeep]);

  useEffect(() => {
    if (!socket) return;
    const handlers = {
      ticket_assigned:       ({ ticketId, subject, customerName }) =>
        push({ type: 'ticket_assigned', title: `Ticket #${ticketId} assigned to you`, body: `${customerName}: ${subject}`, ticketId }),
      ticket_customer_reply: ({ ticketId, customerName, message }) =>
        push({ type: 'ticket_reply', title: `${customerName} replied on #${ticketId}`, body: message?.substring(0, 80), ticketId }),
      ticket_unassigned: ({ ticketId }) =>
        // Ownership changed away from us — drop any stale notifications for this ticket
        // so the bell doesn't keep showing a ticket we no longer own.
        setNotifications(prev => prev.filter(n => n.ticketId !== ticketId)),
      new_chat_request: ({ chatId, customer, broadcast }) => {
        const cat = customer?.category;
        // Dedupe broadcast events: this same chat may already have a chat_request
        // entry from the original ring (we were rung, ignored it, server parked
        // it and broadcast it back to our queue). Avoid a duplicate bell entry.
        setNotifications(prev => {
          const dup = broadcast && prev.some(n => n.type === 'chat_request' && n.chatId === chatId && !n.read);
          if (dup) return prev;
          return [
            { type: 'chat_request', title: `New chat from ${customer?.customer_name}${cat ? ` · ${cat}` : ''}`, body: customer?.domain, chatId, id: Date.now() + Math.random(), time: new Date(), read: false },
            ...prev.slice(0, 29),
          ];
        });
        // Silent broadcast = server is letting every agent see a queued chat because
        // all of them are already on an active chat, or because the original
        // ring timed out and we have no one else to escalate to. Skip ring/toast.
        if (broadcast) return;
        // If agent is Away/Busy/On_break, log it to the bell silently — no ring, no toast.
        // They can still see the queue if they switch back to Online.
        if (!isAgentAvailable() || isSilentForAdmin) return;
        // Start continuous ring — keeps ringing until acknowledged, chat is taken, or 90s timeout
        startRing();
        toast(
          (t) => (
            <div className="flex items-center gap-3">
              <Headphones className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <div className="text-sm flex-1 min-w-0">
                <div>New chat from <strong>{customer?.customer_name || 'Customer'}</strong></div>
                {cat && (
                  <div className="mt-0.5">
                    <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium capitalize">{cat}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => { toast.dismiss(t.id); navigate('/agent/chats'); }}
                className="text-xs px-2.5 py-1 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors flex-shrink-0"
              >
                Go to Chats
              </button>
            </div>
          ),
          { duration: 90000, id: chatToastId(chatId) }
        );
      },
      chat_auto_assigned:    ({ chatId, customer }) => {
        // chat_auto_assigned is emitted ONLY to the receiving agent's user room.
        // That agent now has a fresh chat to handle — alert them with the ringtone
        // and a toast so they don't miss it (especially if they're on a different tab).
        dismissChatToast(chatId);
        push({ type: 'chat_assigned', title: `Chat auto-assigned: ${customer?.customer_name || 'Customer'}`, body: 'Go to Chats to respond', chatId });
        // Honor the agent's Away/Busy/On_break preference — silent visual only.
        if (!isAgentAvailable() || isSilentForAdmin) return;
        startRing();
        toast(
          (t) => (
            <div className="flex items-center gap-3">
              <Headphones className="w-4 h-4 text-indigo-500 flex-shrink-0" />
              <span className="text-sm flex-1">
                Chat assigned to you from <strong>{customer?.customer_name || 'Customer'}</strong>
              </span>
              <button
                onClick={() => { toast.dismiss(t.id); navigate('/agent/chats'); }}
                className="text-xs px-2.5 py-1 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors flex-shrink-0"
              >
                Go to Chats
              </button>
            </div>
          ),
          { duration: 90000, id: chatToastId(chatId) }
        );
      },
      // Any agent (including this one) accepted the chat — stop ringing for
      // everyone AND mark any stacked "New chat from X" bell entries for
      // this chatId as read. Without that pass, an agent who accepted a
      // chat still sees the un-clicked notifications sitting in the bell
      // (sometimes 2+ if the ring escalated to them twice) and the unread
      // badge counts them — confusing, since they're already in the chat.
      chat_request_accepted:  ({ chatId } = {}) => {
        stopRing(); dismissChatToast(chatId);
        clearChatNotifications(chatId);
      },
      chat_cancelled:         ({ chatId } = {}) => {
        stopRing(); dismissChatToast(chatId);
        clearChatNotifications(chatId);
      },
      // Sequential-ring escalation — chat moved on to another agent. Stop ringing
      // and clear our toast so we're not staring at a stale "New chat from X" prompt.
      // We also leave a "missed chat" entry in the bell list AND show a brief
      // soft toast so agents who were heads-down on another tab realize they
      // had a chat opportunity. Was Bug #25: agent never knew they'd been rung.
      chat_request_cancelled: ({ chatId } = {}) => {
        stopRing();
        dismissChatToast(chatId);
        clearChatNotifications(chatId);
        push({ type: 'chat_missed', title: `Missed chat (rang you, now with another agent)`, body: `Chat #${chatId} — open Chats if it routes back to you`, chatId });
        if (!isSilentForAdmin) {
          toast('You just missed a chat — it moved to another agent', { icon: '⏱️', duration: 5000 });
        }
      },
      // Ring timed out and the chat couldn't be re-routed (we're the only agent
      // or everyone else is busy). Stop the ringtone + dismiss the active toast,
      // but DON'T push a "missed chat" entry — the chat is sitting in the
      // Waiting list right now and we can still accept it. Different intent
      // from chat_request_cancelled (which means it really did leave us).
      chat_request_parked: ({ chatId } = {}) => {
        stopRing();
        dismissChatToast(chatId);
        // Leave the bell's chat_request entry intact — the chat is still ours
        // to claim. Clearing it would hide a chat we could still take.
      },
      chat_taken:             ({ chatId } = {}) => {
        stopRing(); dismissChatToast(chatId);
        clearChatNotifications(chatId);
      },
      chat_removed:           ({ chatId } = {}) => {
        stopRing(); dismissChatToast(chatId);
        clearChatNotifications(chatId);
      },
      incoming_call: ({ customer }) =>
        push({
          type: 'incoming_call',
          title: `Incoming call from ${customer?.customer_name || 'Customer'}`,
          // On /agent the AgentCallOverlay handles pickup. On /admin (silent mode)
          // there's no popup — point the admin at their agent view instead.
          body: isSilentForAdmin
            ? 'Open the agent view to accept this call'
            : 'Check the popup in the bottom-right corner to accept',
        }),
      queue_sla_alert: ({ chatId, customerName, minsWaiting }) =>
        push({ type: 'sla_warning', title: `Queue Alert — ${customerName}`, body: `Waiting ${minsWaiting}m — assign to an agent`, chatId }),
      chat_transferred_to_you: ({ chatId, fromAgent, transferNote }) =>
        push({ type: 'chat_assigned', title: `Chat transferred to you from ${fromAgent}`, body: transferNote || `Chat #${chatId}`, chatId }),

      // SLA approaching — direct warning to assigned agent
      sla_warning: ({ ticketId, subject, priority, minsLeft }) => {
        push({ type: 'sla_warning', title: `SLA Warning — Ticket #${ticketId}`, body: `${minsLeft}m left to respond · ${subject}`, ticketId });
        if (isSilentForAdmin) return;
        toast(
          (t) => (
            <div
              className="flex items-start gap-3 cursor-pointer"
              title="Click to open ticket"
              onClick={() => { toast.dismiss(t.id); navigate(`/agent/tickets?openTicket=${ticketId}`); }}
            >
              <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800">SLA Warning — {minsLeft}m left</p>
                <p className="text-xs text-gray-500 truncate">#{ticketId} · {subject}</p>
              </div>
              <button onClick={(e) => { e.stopPropagation(); toast.dismiss(t.id); }} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ),
          { duration: 15000, id: `sla_warn_${ticketId}` }
        );
      },

      // Auto-escalation — slaWorker bumped this ticket's priority because its
      // SLA was missed. Important for the agent to see regardless of which
      // page they're on, since "your ticket got promoted" can shift their
      // workday queue.
      ticket_escalated: ({ ticketId, subject, newPriority, reason } = {}) => {
        push({
          type: 'ticket_escalated',
          title: `Ticket #${ticketId} escalated → ${newPriority || 'higher priority'}`,
          body: `${reason || 'SLA breach'} · ${subject || ''}`,
          ticketId,
        });
      },

      // SLA breached — direct urgent alert to assigned agent
      sla_breach_agent: ({ ticketId, subject, breachType }) => {
        push({ type: 'sla_breach', title: `SLA BREACHED — Ticket #${ticketId}`, body: `${breachType} SLA missed · ${subject}`, ticketId });
        if (isSilentForAdmin) return;
        toast(
          (t) => (
            <div
              className="flex items-start gap-3 cursor-pointer"
              title="Click to open ticket"
              onClick={() => { toast.dismiss(t.id); navigate(`/agent/tickets?openTicket=${ticketId}`); }}
            >
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-red-700">SLA BREACHED</p>
                <p className="text-xs text-gray-600">#{ticketId} · {breachType} SLA missed</p>
                <p className="text-xs text-gray-500 truncate">{subject}</p>
              </div>
              <button onClick={(e) => { e.stopPropagation(); toast.dismiss(t.id); }} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ),
          { duration: 30000, id: `sla_breach_${ticketId}` }
        );
      },
    };
    Object.entries(handlers).forEach(([ev, fn]) => socket.on(ev, fn));
    return () => Object.entries(handlers).forEach(([ev, fn]) => socket.off(ev, fn));
  }, [socket, push, startRing, stopRing, navigate, dismissChatToast, isSilentForAdmin]);

  // Stop ringing when this component unmounts (logout, full page navigation away from agent app)
  useEffect(() => () => stopRing(), [stopRing]);

  // If an admin navigates from /agent/* to /admin/* mid-ring, silence
  // immediately — they're no longer on the agent panel, no audible nag.
  useEffect(() => {
    if (isSilentForAdmin) stopRing();
  }, [isSilentForAdmin, stopRing]);

  // If the agent flips their availability to anything other than Online mid-ring,
  // silence the ring immediately — they explicitly opted out of being bothered.
  useEffect(() => {
    if (!socket) return;
    const onStatusChanged = ({ agentId, status }) => {
      // We only care about our own status changes (the agent room broadcasts all agents)
      const myId = (() => {
        try { return JSON.parse(localStorage.getItem('dsp_user') || '{}')?.id; } catch { return null; }
      })();
      if (myId == null || Number(agentId) !== Number(myId)) return;
      if (status !== 'online') stopRing();
    };
    socket.on('agent_status_changed', onStatusChanged);
    return () => socket.off('agent_status_changed', onStatusChanged);
  }, [socket, stopRing]);
  // Ringtone keeps playing until: an agent accepts the chat (chat_request_accepted),
  // it's auto-assigned (chat_auto_assigned), the customer cancels (chat_removed),
  // or the 90-second safety timeout inside startRing(). Navigating to /agent/chats or
  // opening the bell no longer silences it — the user has to actually accept the chat.

  useEffect(() => {
    const slice = notifications.slice(0, 50);
    try {
      localStorage.setItem('agent_notifications', JSON.stringify(slice));
    } catch (err) {
      // Quota likely exceeded — drop oldest half and try again
      try {
        localStorage.setItem('agent_notifications', JSON.stringify(notifications.slice(0, 25)));
      } catch {}
    }
    // Broadcast so the Sidebar (or any other UI showing per-tab badges) can
    // re-derive its counters without polling localStorage.
    window.dispatchEvent(new CustomEvent('agent_notification:changed', { detail: slice }));
  }, [notifications]);

  // Auto-mark notifications read once the agent actually opens the related ticket
  // or chat. Pages dispatch `agent_notification:viewed` on mount.
  useEffect(() => {
    const onViewed = (e) => {
      const { ticketId, chatId, type } = e.detail || {};
      setNotifications(ns => ns.map(n => {
        if (n.read) return n;
        if (ticketId != null && Number(n.ticketId) === Number(ticketId)) return { ...n, read: true };
        if (chatId   != null && Number(n.chatId)   === Number(chatId))   return { ...n, read: true };
        if (type && n.type === type) return { ...n, read: true };
        return n;
      }));
    };
    window.addEventListener('agent_notification:viewed', onViewed);
    return () => window.removeEventListener('agent_notification:viewed', onViewed);
  }, []);

  // Update browser tab title with unread count so agents notice from background tabs
  useEffect(() => {
    const base = 'Anutech Digital';
    const unread = notifications.filter(n => !n.read).length;
    document.title = unread > 0 ? `(${unread > 9 ? '9+' : unread}) ${base}` : base;
    return () => { document.title = base; };
  }, [notifications]);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setShow(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const unread = notifications.filter(n => !n.read).length;

  // Map a notification to the route + state that should open when it's clicked.
  // Returns null for notifications that have no meaningful destination (e.g. incoming_call —
  // the call overlay is already on screen).
  const targetFor = (n) => {
    switch (n.type) {
      case 'ticket_reply':
      case 'ticket_assigned':
      case 'sla_warning':
      case 'sla_breach':
        return n.ticketId ? `/agent/tickets?openTicket=${n.ticketId}` : '/agent/tickets';
      case 'chat_request':
      case 'chat_assigned':
        return '/agent/chats';
      case 'incoming_call':
      default:
        return null;
    }
  };

  const handleNotificationClick = (n) => {
    setNotifications(ns => ns.map(x => x.id === n.id ? { ...x, read: true } : x));
    const dest = targetFor(n);
    if (dest) {
      setShow(false);
      navigate(dest);
    }
  };

  const icons = {
    ticket_reply:    <MessageSquare className="w-4 h-4 text-blue-500" />,
    ticket_assigned: <UserCheck className="w-4 h-4 text-green-500" />,
    chat_request:    <Headphones className="w-4 h-4 text-amber-500" />,
    chat_assigned:   <Zap className="w-4 h-4 text-indigo-500" />,
    incoming_call:   <Phone className="w-4 h-4 text-green-600" />,
    sla_warning:     <AlertTriangle className="w-4 h-4 text-amber-500" />,
    sla_breach:      <AlertCircle className="w-4 h-4 text-red-600" />,
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setShow(v => !v)} className="relative btn-secondary p-2">
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {show && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-xl border border-gray-100 z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-gray-600" />
              <span className="text-sm font-semibold text-gray-800">Notifications</span>
              {unread > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-bold">{unread}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {notifications.length > 0 && (
                <button onClick={() => setNotifications([])} className="text-xs text-gray-400 hover:text-gray-600">Clear all</button>
              )}
              <button onClick={() => setShow(false)}><X className="w-4 h-4 text-gray-400" /></button>
            </div>
          </div>
          <PushToggle />
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {notifications.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">No notifications</div>
            ) : notifications.map(n => (
              <div
                key={n.id}
                onClick={() => handleNotificationClick(n)}
                className={clsx('group flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors relative', !n.read && 'bg-blue-50/50')}
                title={targetFor(n) ? 'Click to open' : 'Click to mark as read'}
              >
                <div className="flex-shrink-0 mt-0.5">{icons[n.type] || <Bell className="w-4 h-4 text-gray-400" />}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 leading-snug pr-5">{n.title}</p>
                  {n.body && <p className="text-xs text-gray-500 mt-0.5 truncate">{n.body}</p>}
                  <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(n.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                {!n.read && <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" />}
                {/* Dismiss this specific notification */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setNotifications(ns => ns.filter(x => x.id !== n.id));
                  }}
                  title="Dismiss this notification"
                  className="absolute top-2 right-2 p-1 rounded text-gray-300 hover:text-gray-700 hover:bg-gray-100 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
