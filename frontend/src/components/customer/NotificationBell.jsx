import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../../contexts/SocketContext';
import { Bell, X, MessageSquare, UserCheck, CheckCircle, RotateCcw, Headphones, Clock, Zap } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import PushToggle from '../common/PushToggle';

const STORE_KEY = 'customer_notifications';

export default function CustomerNotificationBell() {
  const { socket } = useSocket();
  const navigate = useNavigate();
  // Lazy initializer reads localStorage synchronously during the first render,
  // so the initial state IS the persisted list. Critical: a useEffect-based load
  // races with the useEffect-based save and clobbers localStorage with [] on
  // every mount before the saved value is restored.
  const [notifications, setNotifications] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return saved.filter(n => new Date(n.time).getTime() > cutoff);
    } catch { return []; }
  });
  const [show, setShow] = useState(false);
  const ref = useRef(null);

  // Throttled beep — under a burst (10 socket events in 500ms), one beep is
  // plenty. Creating 10 AudioContexts blocks the main thread for ~80ms each.
  const lastBeepRef = useRef(0);
  const playBeep = useCallback(() => {
    const now = Date.now();
    if (now - lastBeepRef.current < 250) return;
    lastBeepRef.current = now;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      gain.connect(ctx.destination);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 740;
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch {}
  }, []);

  // Batch incoming notifications. Socket events arrive on separate event-loop
  // ticks, so React 18 can't auto-batch the resulting setStates. We collect
  // pending entries in a ref and drain them with one setState per microtask —
  // a flood of 10 events in a burst becomes 1 render + 1 persist + 1 dispatch.
  const pendingRef = useRef([]);
  const flushScheduledRef = useRef(false);
  const push = useCallback((n) => {
    pendingRef.current.push({
      ...n,
      id: Date.now() + Math.random(),
      time: new Date().toISOString(),
      read: false,
    });
    playBeep();
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    queueMicrotask(() => {
      flushScheduledRef.current = false;
      const additions = pendingRef.current;
      pendingRef.current = [];
      if (!additions.length) return;
      setNotifications(prev => [...additions.reverse(), ...prev].slice(0, 30));
    });
  }, [playBeep]);

  // Debounced persistence + sidebar broadcast — was firing per-render which
  // meant 10 socket events = 10 synchronous localStorage writes + 10
  // CustomEvent dispatches (each of which the Sidebar re-derives from).
  const persistTimerRef = useRef(null);
  useEffect(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      const slice = notifications.slice(0, 50);
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(slice));
      } catch {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(notifications.slice(0, 25))); } catch {}
      }
      window.dispatchEvent(new CustomEvent('notification:changed', { detail: slice }));
    }, 150);
    return () => clearTimeout(persistTimerRef.current);
  }, [notifications]);

  useEffect(() => {
    if (!socket) return;
    const handlers = {
      ticket_agent_reply: ({ ticketId, subject, agentName, message }) => {
        push({
          type: 'ticket_reply',
          title: `${agentName || 'Support'} replied on #${ticketId}`,
          body: (message || '').toString().substring(0, 80),
          ticketId,
        });
      },
      ticket_assigned_to_customer: ({ ticketId, subject, agentName }) => {
        push({
          type: 'ticket_assigned',
          title: `${agentName || 'An agent'} picked up your ticket`,
          body: `#${ticketId} · ${subject || ''}`,
          ticketId,
        });
      },
      ticket_transferred_to_customer: ({ ticketId, subject, newAgentName, fromAgentName }) => {
        push({
          type: 'ticket_assigned',
          title: `Ticket #${ticketId} transferred to ${newAgentName || 'a new agent'}`,
          body: `${fromAgentName ? `From ${fromAgentName} · ` : ''}${subject || ''}`,
          ticketId,
        });
      },
      ticket_status_change: ({ ticketId, subject, newStatus, agentName }) => {
        const verb = newStatus === 'closed' ? 'closed' : newStatus === 'open' ? 'reopened' : `marked ${newStatus}`;
        push({
          type: newStatus === 'closed' ? 'ticket_closed' : 'ticket_status',
          title: `Ticket #${ticketId} ${verb}`,
          body: `${subject || ''}${agentName ? ` · by ${agentName}` : ''}`,
          ticketId,
        });
      },
      chat_accepted: ({ chatId, agentName }) => {
        push({
          type: 'chat_accepted',
          title: `${agentName || 'An agent'} joined your chat`,
          body: 'Open Live Chat to continue the conversation',
          chatId,
        });
      },
      usage_reset: ({ callLimit, chatLimit }) => {
        const parts = [];
        if (callLimit != null) parts.push(`0/${callLimit} calls`);
        if (chatLimit != null) parts.push(`0/${chatLimit} chats`);
        push({
          type: 'usage_reset',
          title: 'Your monthly usage has been reset',
          body: parts.length ? `New quota: ${parts.join(', ')}` : 'Counters back to 0 for this month',
        });
      },
      // Admin saved or cleared support-access overrides for this customer —
      // bell entry + a window event the Dashboard listens to so its usage
      // panel re-fetches and shows the new caps immediately.
      overrides_changed: ({ action, actor_name }) => {
        const cleared = action === 'overrides_cleared';
        push({
          type: 'overrides_changed',
          title: cleared ? 'Your support limits are back to plan defaults' : 'Your support limits have been updated',
          body: `${actor_name || 'An admin'} ${cleared ? 'removed your custom limits — you now use the plan default caps.' : 'changed the chat / call / ticket caps on your account. Refresh your dashboard to see the new quotas.'}`,
        });
        window.dispatchEvent(new CustomEvent('overrides:changed'));
      },
      // Admin edited the customer's plan (limits, allow_chat/calls, SLA, etc).
      // Until this was added the customer only learned about it via the soft
      // banners on the Chat / Call pages — if they were on Dashboard, Tickets,
      // Billing, or Profile they got nothing. Now: bell entry shows globally
      // regardless of which page is open, plus a window event so other open
      // pages (Dashboard, Billing) can refetch their plan-derived data.
      plan_changed: ({ planName } = {}) => {
        push({
          type: 'plan_changed',
          title: 'Your support plan was updated',
          body: planName
            ? `Plan rules for ${planName} have changed — your limits and features may have shifted.`
            : 'Your plan limits or features may have shifted. Refresh your dashboard to see the latest.',
        });
        window.dispatchEvent(new CustomEvent('plan:changed'));
      },
    };
    Object.entries(handlers).forEach(([ev, fn]) => socket.on(ev, fn));
    return () => Object.entries(handlers).forEach(([ev, fn]) => socket.off(ev, fn));
  }, [socket, push]);

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

  // Auto-mark notifications as read once the customer actually opens the related
  // ticket or chat. Pages dispatch a `notification:viewed` window event on mount
  // so the bell can clear its unread state without manual interaction.
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
    window.addEventListener('notification:viewed', onViewed);
    return () => window.removeEventListener('notification:viewed', onViewed);
  }, []);

  const unread = notifications.filter(n => !n.read).length;

  const targetFor = (n) => {
    switch (n.type) {
      case 'ticket_reply':
      case 'ticket_assigned':
      case 'ticket_closed':
      case 'ticket_status':
        return n.ticketId ? `/customer/tickets/${n.ticketId}` : '/customer/tickets';
      case 'chat_accepted':
        return '/customer/chat';
      default:
        return null;
    }
  };

  const onClickNotification = (n) => {
    setNotifications(ns => ns.map(x => x.id === n.id ? { ...x, read: true } : x));
    const dest = targetFor(n);
    if (dest) {
      setShow(false);
      navigate(dest);
    }
  };

  const markAllRead = () => setNotifications(ns => ns.map(n => ({ ...n, read: true })));

  const icons = {
    ticket_reply:    <MessageSquare className="w-4 h-4 text-blue-500" />,
    ticket_assigned: <UserCheck className="w-4 h-4 text-green-600" />,
    ticket_closed:   <CheckCircle className="w-4 h-4 text-gray-500" />,
    ticket_status:   <RotateCcw className="w-4 h-4 text-amber-500" />,
    chat_accepted:   <Headphones className="w-4 h-4 text-blue-500" />,
    usage_reset:        <Zap className="w-4 h-4 text-emerald-500" />,
    overrides_changed:  <Zap className="w-4 h-4 text-amber-500" />,
  };

  return (
    <div className="relative" ref={ref} data-testid="CustomerNotificationBell">
      <button
        data-testid="CustomerNotificationBell-Toggle"
        onClick={() => setShow(v => !v)}
        className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
        title="Notifications"
      >
        <Bell className="w-5 h-5 text-gray-600" />
        {unread > 0 && (
          <span data-testid="CustomerNotificationBell-UnreadBadge" className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
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
              {unread > 0 && (
                <button data-testid="CustomerNotificationBell-MarkAllRead" onClick={markAllRead} className="text-xs text-gray-500 hover:text-gray-800">Mark all read</button>
              )}
              {notifications.length > 0 && (
                <button data-testid="CustomerNotificationBell-ClearAll" onClick={() => setNotifications([])} className="text-xs text-gray-400 hover:text-gray-600">Clear all</button>
              )}
              <button data-testid="CustomerNotificationBell-Close" onClick={() => setShow(false)}><X className="w-4 h-4 text-gray-400" /></button>
            </div>
          </div>
          <PushToggle />
          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {notifications.length === 0 ? (
              <div className="py-8 text-center text-sm text-gray-400">No notifications yet</div>
            ) : notifications.map(n => (
              <div
                key={n.id}
                onClick={() => onClickNotification(n)}
                className={clsx('group flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors relative', !n.read && 'bg-blue-50/50')}
                title={targetFor(n) ? 'Click to open' : 'Click to mark as read'}
              >
                <div className="flex-shrink-0 mt-0.5">{icons[n.type] || <Bell className="w-4 h-4 text-gray-400" />}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 leading-snug pr-5">{n.title}</p>
                  {n.body && <p className="text-xs text-gray-500 mt-0.5 truncate">{n.body}</p>}
                  <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(n.time).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
                  </p>
                </div>
                {!n.read && <span className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 mt-1.5" />}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setNotifications(ns => ns.filter(x => x.id !== n.id));
                  }}
                  title="Dismiss"
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
