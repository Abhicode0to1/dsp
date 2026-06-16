import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import { useEffect, useState } from 'react';
import { getMyTickets, getSidebarBadges } from '../../services/api';
import {
  LayoutDashboard, Ticket, MessageSquare, Phone, Users,
  BarChart2, LogOut, Headphones, UserCog,
  ClipboardList, ChevronDown, ChevronLeft, ChevronRight, Settings, Star, LayoutTemplate, CreditCard, UserCircle,
  PhoneCall, Activity, Bug, Mail, SlidersHorizontal, ExternalLink, AlertTriangle, X,
} from 'lucide-react';
import clsx from 'clsx';
import { CloudOnly, LogoMark } from './Logo';

const navsByRole = {
  customer: [
    { to: '/customer',         icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/customer/tickets', icon: Ticket,          label: 'My Tickets' },
    { to: '/customer/chat',    icon: MessageSquare,   label: 'Live Chat' },
    { to: '/customer/call',    icon: Phone,           label: 'Call Support' },
    { to: '/customer/billing', icon: CreditCard,      label: 'Billing' },
    { to: '/customer/profile', icon: UserCircle,      label: 'My Profile' },
  ],
  agent: [
    { to: '/agent',             icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/agent/tickets',     icon: Ticket,          label: 'Tickets' },
    { to: '/agent/chats',       icon: MessageSquare,   label: 'Chats' },
    { to: '/agent/calls',       icon: PhoneCall,       label: 'Calls' },
    { to: '/agent/performance', icon: BarChart2,        label: 'Performance' },
  ],
  // Admin nav: daily-use items stay flat, lower-frequency items grouped into
  // collapsible sections. Groups use shape { group, icon, items: [...] }; flat
  // items use the same { to, icon, label } shape as other roles. Agent Console
  // intentionally NOT here — it lives as an "Open agent view ↗" button outside
  // the nav so the admin sidebar is purely management items.
  admin: [
    { to: '/admin',             icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/admin/customers',   icon: Users,           label: 'Customers' },
    { to: '/admin/agents',      icon: UserCog,         label: 'Agents' },
    { to: '/admin/tickets',     icon: Ticket,          label: 'Tickets' },
    { to: '/admin/chats',       icon: MessageSquare,   label: 'Chats' },
    { to: '/admin/calls',       icon: PhoneCall,       label: 'Calls' },
    { group: 'Insights', icon: BarChart2, items: [
      { to: '/admin/performance', icon: Star,     label: 'Performance' },
      { to: '/admin/reports',     icon: BarChart2, label: 'Reports' },
    ] },
    { group: 'Configuration', icon: SlidersHorizontal, items: [
      { to: '/admin/plans',           icon: CreditCard,     label: 'Plans' },
      { to: '/admin/templates',       icon: LayoutTemplate, label: 'Templates' },
      { to: '/admin/settings',        icon: Settings,       label: 'Settings' },
    ] },
    { group: 'System', icon: Activity, items: [
      { to: '/admin/audit',    icon: ClipboardList, label: 'Audit Log' },
      { to: '/admin/feedback', icon: Bug,           label: 'Bug Reports' },
      { to: '/admin/health',   icon: Activity,      label: 'System Health' },
    ] },
  ],
};

// Walk a nav structure and return every leaf item (with { to, icon, label }).
// Used for icons-only sidebar (groups don't fit) and for badge bookkeeping.
function flattenNav(items) {
  const out = [];
  for (const item of items) {
    if (item.group) out.push(...item.items);
    else            out.push(item);
  }
  return out;
}

const STATUS_OPTIONS = [
  { value: 'online',   label: 'Online',   dot: 'bg-green-400' },
  { value: 'busy',     label: 'Busy',     dot: 'bg-red-400' },
  { value: 'away',     label: 'Away',     dot: 'bg-amber-400' },
  { value: 'on_break', label: 'On break', dot: 'bg-purple-400' },
];

export default function Sidebar({ mobileOpen = false, onMobileClose }) {
  const { user, logout } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();
  const location = useLocation();

  // Desktop vs mobile. The collapse-to-icons feature is desktop-only; on mobile
  // the sidebar is an off-canvas drawer that always renders in its full-width
  // expanded form, so we force `collapsed` false below the lg breakpoint
  // regardless of the persisted desktop preference.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Pick the sidebar shape from the current URL, not the user's role. This is
  // what lets an admin who clicks "Open agent view" land in a new tab and see
  // the agent nav (Dashboard / Tickets / Chats / Calls / Performance) instead
  // of their own admin nav. The admin user object stays the same; only the UI
  // shifts to match the panel they're working in.
  const isAdminPanel = location.pathname.startsWith('/admin');
  const isAgentPanel = location.pathname.startsWith('/agent');

  // window.name persists across reloads inside the same tab. When admin spawns
  // the agent view, that new tab gets named 'dsp_agent_view' so subsequent
  // clicks reuse it. But there's a subtle bug: if the user closes their admin
  // tab and re-logs into the (formerly-agent-view) tab, that tab is now showing
  // the admin panel BUT still has window.name='dsp_agent_view' leftover. The
  // next "Open agent view" click then navigates THIS tab to /agent instead of
  // spawning a new one. Strip the name whenever we render an admin panel route
  // so the named-window match in window.open() doesn't accidentally target us.
  useEffect(() => {
    if (isAdminPanel && typeof window !== 'undefined' && window.name === 'dsp_agent_view') {
      window.name = '';
    }
  }, [isAdminPanel]);
  const navRole = isAdminPanel ? 'admin' : isAgentPanel ? 'agent' : user?.role;
  // Track pending chat IDs as a Set so duplicate add events don't inflate the badge
  // and "remove" events for chats we don't have are silent no-ops.
  const [pendingChatIds, setPendingChatIds] = useState(() => new Set());
  const unreadChats = pendingChatIds.size;
  const setUnreadChats = (v) => {
    // Only "clear-all" supported here — used when the agent clicks Chats in the sidebar.
    if (v === 0) setPendingChatIds(new Set());
  };
  const [openTicketCount, setOpenTicketCount] = useState(0);
  // Mirror of the bell's unread ticket-related notifications, derived from the
  // same localStorage key the CustomerNotificationBell writes to. Recomputed
  // whenever the bell dispatches `notification:changed`.
  const [unreadTicketNotif, setUnreadTicketNotif] = useState(0);
  const [unreadAgentTicketNotif, setUnreadAgentTicketNotif] = useState(0);
  // Admin sidebar badges — single round-trip every 60s while on /admin/*.
  // Shape: { new_bug_reports, open_billing_syncs, payment_failures_24h }
  const [adminBadges, setAdminBadges] = useState({ new_bug_reports: 0, open_billing_syncs: 0, payment_failures_24h: 0 });
  // Persist across Sidebar remounts (every route change) so navigating between pages
  // doesn't wipe a manually-chosen "Away" back to "Online".
  const [agentStatus, setAgentStatus] = useState(() => {
    try { return localStorage.getItem('agent_status') || 'online'; } catch { return 'online'; }
  });
  const [statusOpen, setStatusOpen] = useState(false);
  const [collapsedPref, setCollapsedPref] = useState(
    () => localStorage.getItem('sidebar_collapsed') === 'true'
  );
  // Effective collapse: only honor the persisted preference on desktop. On
  // mobile the drawer is always full-width (expanded content), never icon-only.
  const collapsed = isDesktop ? collapsedPref : false;
  // Per-group expand/collapse state. Default ALL closed so the sidebar stays
  // tidy on every fresh load — the user explicitly opted into grouping to
  // declutter, so collapsed-by-default matches the intent. Persisted per-browser
  // so opening a group once keeps it open for that admin's future sessions.
  // Key is `_v2` because the v1 default was "all open" — bumping the key
  // ensures users who upgraded see the new collapsed default instead of their
  // stale all-open state.
  const [openGroups, setOpenGroups] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebar_open_groups_v2');
      if (stored) return JSON.parse(stored);
    } catch {}
    return { Insights: false, Configuration: false, System: false };
  });
  const toggleGroup = (name) => {
    setOpenGroups(prev => {
      const next = { ...prev, [name]: !prev[name] };
      try { localStorage.setItem('sidebar_open_groups_v2', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  useEffect(() => {
    if (!socket) return;
    const addId = ({ chatId }) => {
      if (chatId == null) return;
      setPendingChatIds(prev => {
        const k = String(chatId);
        if (prev.has(k)) return prev;
        const next = new Set(prev);
        next.add(k);
        return next;
      });
    };
    const removeId = ({ chatId }) => {
      if (chatId == null) return;
      setPendingChatIds(prev => {
        const k = String(chatId);
        if (!prev.has(k)) return prev;
        const next = new Set(prev);
        next.delete(k);
        return next;
      });
    };

    socket.on('new_chat_request',       addId);
    socket.on('chat_removed',           removeId);
    socket.on('chat_request_accepted',  removeId);
    socket.on('chat_auto_assigned',     removeId);
    socket.on('chat_cancelled',         removeId);
    // Sequential-ring escalation: when our ring window expires the chat moves
    // on to the next agent. Drop the badge entry so the sidebar count matches
    // what we'd actually see if we clicked into the Chats tab.
    socket.on('chat_request_cancelled', removeId);
    return () => {
      socket.off('new_chat_request',       addId);
      socket.off('chat_removed',           removeId);
      socket.off('chat_request_accepted',  removeId);
      socket.off('chat_auto_assigned',     removeId);
      socket.off('chat_cancelled',         removeId);
      socket.off('chat_request_cancelled', removeId);
    };
  }, [socket]);

  useEffect(() => {
    if (user?.role !== 'customer') return;
    getMyTickets({ status: 'open', limit: 1 })
      .then(res => setOpenTicketCount(res.data.total || 0))
      .catch(() => {});
  }, [user?.role]);

  // Admin sidebar badges — polls /admin/sidebar-badges every 60s while admin
  // is in the panel. Soft-fails silently if the endpoint hiccups; the previous
  // counts stay until the next successful poll.
  useEffect(() => {
    if (user?.role !== 'admin' || !isAdminPanel) return;
    let cancelled = false;
    const fetchOnce = () => {
      getSidebarBadges()
        .then(r => { if (!cancelled) setAdminBadges(r.data || {}); })
        .catch(() => {});
    };
    fetchOnce();
    const id = setInterval(fetchOnce, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user?.role, isAdminPanel]);

  useEffect(() => {
    if (user?.role !== 'customer') return;
    const TICKET_TYPES = new Set(['ticket_reply', 'ticket_assigned', 'ticket_closed', 'ticket_status']);
    const recount = (list) => {
      try {
        const arr = list || JSON.parse(localStorage.getItem('customer_notifications') || '[]');
        setUnreadTicketNotif(arr.filter(n => !n.read && TICKET_TYPES.has(n.type)).length);
      } catch { setUnreadTicketNotif(0); }
    };
    recount();
    const onChange = (e) => recount(e.detail);
    const onStorage = (e) => { if (e.key === 'customer_notifications') recount(); };
    window.addEventListener('notification:changed', onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('notification:changed', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [user?.role]);

  useEffect(() => {
    if (user?.role !== 'agent' && user?.role !== 'admin') return;
    const TICKET_TYPES = new Set(['ticket_reply', 'ticket_assigned', 'sla_warning', 'sla_breach']);
    const recount = (list) => {
      try {
        const arr = list || JSON.parse(localStorage.getItem('agent_notifications') || '[]');
        setUnreadAgentTicketNotif(arr.filter(n => !n.read && TICKET_TYPES.has(n.type)).length);
      } catch { setUnreadAgentTicketNotif(0); }
    };
    recount();
    const onChange = (e) => recount(e.detail);
    const onStorage = (e) => { if (e.key === 'agent_notifications') recount(); };
    window.addEventListener('agent_notification:changed', onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('agent_notification:changed', onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [user?.role]);

  const changeStatus = (s) => {
    setAgentStatus(s);
    setStatusOpen(false);
    try { localStorage.setItem('agent_status', s); } catch {}
    socket?.emit('set_status', { status: s });
  };

  // Stay in sync with the server: when the server (or any tab) confirms a status
  // change for us, mirror it locally + persist. Survives reconnects too — the
  // backend re-emits the current status on join_agent_room.
  useEffect(() => {
    if (!socket || !user || (user.role !== 'agent' && user.role !== 'admin')) return;
    const onStatusChanged = ({ agentId, status }) => {
      if (Number(agentId) !== Number(user.id)) return;
      setAgentStatus(status);
      try { localStorage.setItem('agent_status', status); } catch {}
    };
    socket.on('agent_status_changed', onStatusChanged);
    return () => socket.off('agent_status_changed', onStatusChanged);
  }, [socket, user?.id, user?.role]);

  // Push our locally-chosen availability to the backend on every (re)connect.
  // localStorage is the source of truth for this session — if the agent picked Away
  // earlier and refreshed, the backend should know. Without this, a stale DB
  // last_status (or a missing agentStatuses entry post-restart) could make the
  // backend treat an Online agent as Away or vice-versa.
  useEffect(() => {
    if (!socket || !user || (user.role !== 'agent' && user.role !== 'admin')) return;
    const syncStatus = () => {
      let status = 'online';
      try { status = localStorage.getItem('agent_status') || 'online'; } catch {}
      socket.emit('set_status', { status });
    };
    socket.on('connect', syncStatus);
    if (socket.connected) syncStatus(); // already connected by the time we mount
    return () => socket.off('connect', syncStatus);
  }, [socket, user?.id, user?.role]);

  const toggleCollapse = () => {
    setCollapsedPref(c => {
      const next = !c;
      localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
    setStatusOpen(false);
  };

  // Renders one leaf nav link (top-level OR inside a group). Kept inside the
  // component so it can see the badge state + click-clear handlers without
  // threading them through a separate component's props.
  // Admin alerts: any non-zero signal that should surface in the System group
  // (open billing syncs OR payment failures in the last 24h). Bug Reports use
  // its own numeric badge below, not this dot.
  const adminSystemAlertCount =
    (adminBadges.open_billing_syncs || 0) + (adminBadges.payment_failures_24h || 0);

  const renderNavLink = ({ to, icon: Icon, label }, isCollapsed) => {
    const isChats        = label === 'Chats' || label === 'Live Chat';
    const isCustTickets  = label === 'My Tickets';
    const isAgentTickets = label === 'Tickets';
    const isBugReports   = label === 'Bug Reports';
    const isSystemHealth = label === 'System Health';
    const badgeCount =
        (isChats        && unreadChats > 0)              ? unreadChats
      : (isCustTickets  && unreadTicketNotif > 0)        ? unreadTicketNotif
      : (isAgentTickets && unreadAgentTicketNotif > 0)   ? unreadAgentTicketNotif
      : (isBugReports   && adminBadges.new_bug_reports > 0) ? adminBadges.new_bug_reports
      : 0;
    // System Health uses a small red dot (not a numeric badge) when any
    // health signal is non-zero — the underlying count varies (drift / syncs
    // / payment failures) so a single number wouldn't tell the whole story.
    const showHealthDot = isSystemHealth && adminSystemAlertCount > 0;
    return (
      <NavLink
        key={to + label}
        to={to}
        end={to === '/customer' || to === '/admin' || to === '/agent'}
        onClick={() => {
          if (isChats) setUnreadChats(0);
          if (isCustTickets) {
            setOpenTicketCount(0);
            setUnreadTicketNotif(0); // instant visual clear
            const ticketTypes = ['ticket_reply', 'ticket_assigned', 'ticket_closed', 'ticket_status'];
            // Defensive write — mark unread ticket notifications as read
            // directly in localStorage too. Without this, if the bell isn't
            // currently mounted (or it missed our event for any reason), the
            // badge would re-appear on the next mount.
            try {
              const arr = JSON.parse(localStorage.getItem('customer_notifications') || '[]');
              let changed = false;
              const next = arr.map(n => {
                if (!n.read && ticketTypes.includes(n.type)) { changed = true; return { ...n, read: true }; }
                return n;
              });
              if (changed) {
                localStorage.setItem('customer_notifications', JSON.stringify(next));
                window.dispatchEvent(new CustomEvent('notification:changed', { detail: next }));
              }
            } catch {}
            ticketTypes.forEach(t => {
              window.dispatchEvent(new CustomEvent('notification:viewed', { detail: { type: t } }));
            });
          }
          if (isAgentTickets) {
            setUnreadAgentTicketNotif(0); // instant visual clear
            const agentTicketTypes = ['ticket_reply', 'ticket_assigned', 'sla_warning', 'sla_breach'];
            try {
              const arr = JSON.parse(localStorage.getItem('agent_notifications') || '[]');
              let changed = false;
              const next = arr.map(n => {
                if (!n.read && agentTicketTypes.includes(n.type)) { changed = true; return { ...n, read: true }; }
                return n;
              });
              if (changed) {
                localStorage.setItem('agent_notifications', JSON.stringify(next));
                window.dispatchEvent(new CustomEvent('agent_notification:changed', { detail: next }));
              }
            } catch {}
            agentTicketTypes.forEach(t => {
              window.dispatchEvent(new CustomEvent('agent_notification:viewed', { detail: { type: t } }));
            });
          }
        }}
        title={isCollapsed ? label : undefined}
        data-testid={`Sidebar-NavLink-${label.toLowerCase().replace(/\s+/g, '-')}`}
        className={({ isActive }) =>
          clsx(
            'flex items-center rounded-lg text-sm font-medium transition-colors relative',
            isCollapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5',
            isActive
              ? 'bg-indigo-600 text-white'
              : 'text-gray-300 hover:bg-gray-800 hover:text-white'
          )
        }
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        {!isCollapsed && <span className="flex-1">{label}</span>}
        {badgeCount > 0 && (
          <span
            data-testid={`Sidebar-Badge-${label.toLowerCase().replace(/\s+/g, '-')}`}
            className={clsx(
              'min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1',
              isCollapsed && 'absolute -top-1 -right-1'
            )}
          >
            {badgeCount > 9 ? '9+' : badgeCount}
          </span>
        )}
        {showHealthDot && !badgeCount && (
          <span
            data-testid="Sidebar-Dot-system-health"
            className={clsx(
              'w-2 h-2 rounded-full bg-red-500',
              isCollapsed && 'absolute top-0.5 right-0.5'
            )}
            title="System Health — items need attention"
          />
        )}
      </NavLink>
    );
  };

  const navItems = navsByRole[navRole] || [];
  const flatNavItems = flattenNav(navItems);
  // Note: no auto-open behaviour. The admin asked for groups to stay closed
  // even when they're on a page inside one — group open/close is purely the
  // user's decision and persists across refreshes via localStorage.
  const currentStatus = STATUS_OPTIONS.find(s => s.value === agentStatus);

  return (
    <aside className={clsx(
      'bg-gray-900 text-white flex flex-col',
      // Mobile (< lg): off-canvas drawer — fixed, full-height, slides in/out.
      'fixed inset-y-0 left-0 z-50 w-60 transition-transform duration-200 pb-safe',
      mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
      // Desktop (lg+): revert to the original in-flow flex child. No transform,
      // collapse-to-w-16 preserved, original width-transition animation.
      'lg:static lg:z-auto lg:translate-x-0 lg:shadow-none lg:flex-shrink-0 lg:pb-0 lg:transition-all',
      collapsed ? 'lg:w-16' : 'lg:w-60'
    )}>
      {/* Logo + collapse toggle */}
      <div className={clsx('border-b border-gray-800 flex items-center pt-safe lg:pt-5', collapsed ? 'px-3 py-5 justify-center' : 'px-5 py-5 justify-between')}>
        <div className="flex items-center gap-2 min-w-0">
          {collapsed ? (
            // Collapsed sidebar: just the cloud icon, brand-blue fill.
            <CloudOnly className="w-7 h-5 flex-shrink-0" />
          ) : (
            // Expanded sidebar: cloud + separator + stacked "ANUTECH / DIGITAL"
            // wordmark. White text via currentColor inheritance.
            <div className="text-white min-w-0 flex items-center gap-2">
              <LogoMark className="h-9 text-white flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-extrabold text-white tracking-widest leading-tight">ANUTECH</div>
                <div className="text-xs font-extrabold text-white tracking-widest leading-tight">DIGITAL</div>
                <div className="text-[10px] text-gray-400 mt-0.5">Panel v1.0</div>
              </div>
            </div>
          )}
        </div>
        {/* Mobile: close the drawer. Desktop: collapse to icon rail. */}
        <button
          onClick={onMobileClose}
          className="lg:hidden text-gray-400 hover:text-white transition-colors flex-shrink-0 ml-2 p-1 -mr-1"
          title="Close menu"
          aria-label="Close menu"
        >
          <X className="w-5 h-5" />
        </button>
        {!collapsed && (
          <button
            onClick={toggleCollapse}
            className="hidden lg:block text-gray-500 hover:text-white transition-colors flex-shrink-0 ml-2"
            title="Collapse sidebar"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Collapsed expand button */}
      {collapsed && (
        <button
          onClick={toggleCollapse}
          className="flex items-center justify-center py-2.5 text-gray-500 hover:text-white transition-colors border-b border-gray-800"
          title="Expand sidebar"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}

      {/* User info */}
      <div className={clsx('border-b border-gray-800', collapsed ? 'px-3 py-3 flex justify-center' : 'px-4 py-4')}>
        {collapsed ? (
          <div
            className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-sm font-bold uppercase cursor-default"
            title={user?.name}
          >
            {user?.name?.[0] || '?'}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-sm font-bold uppercase flex-shrink-0">
              {user?.name?.[0] || '?'}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name}</p>
              <p className="text-xs text-gray-400 capitalize">{user?.role}</p>
            </div>
          </div>
        )}
      </div>

      {/* Agent availability status — only on agent panel. Status governs whether
          the user receives auto-routed customer work, which is meaningless on
          the admin panel (admin doesn't take customers from there). For admins
          who pop the agent panel in a new tab, the status pill follows them
          to that tab where it belongs. */}
      {isAgentPanel && (user?.role === 'agent' || user?.role === 'admin') && (
        <div className={clsx('border-b border-gray-800 relative', collapsed ? 'px-3 py-3 flex justify-center' : 'px-4 py-3')}>
          {collapsed ? (
            <button
              onClick={() => setStatusOpen(v => !v)}
              className="flex items-center justify-center"
              title={`Status: ${agentStatus}`}
            >
              <span className={clsx('w-3 h-3 rounded-full', currentStatus?.dot)} />
            </button>
          ) : (
            <button
              onClick={() => setStatusOpen(v => !v)}
              className="flex items-center gap-2 w-full text-sm text-gray-300 hover:text-white transition-colors"
            >
              <span className={clsx('w-2.5 h-2.5 rounded-full flex-shrink-0', currentStatus?.dot)} />
              <span className="flex-1 text-left capitalize">{agentStatus}</span>
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          )}
          {statusOpen && (
            <div className={clsx(
              'absolute top-full mt-1 bg-gray-800 rounded-lg overflow-hidden shadow-lg z-50 border border-gray-700',
              collapsed ? 'left-full ml-2 w-32' : 'left-3 right-3'
            )}>
              {STATUS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => changeStatus(opt.value)}
                  className={clsx('flex items-center gap-2.5 w-full px-3 py-2 text-sm transition-colors hover:bg-gray-700', agentStatus === opt.value ? 'text-white' : 'text-gray-300')}
                >
                  <span className={clsx('w-2 h-2 rounded-full flex-shrink-0', opt.dot)} />
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* "Open agent view" — admin-only, only shown on the admin panel itself
           (pointless on the agent panel — they're already there). Opens /agent
           in a sibling browser tab. While that tab is open the admin's socket
           joins the agents room and the auto-router treats them as a normal
           agent; closing it pulls them out of the routing pool.

           We use an onClick + window.open() with a fixed window name rather
           than `<a target="dsp_agent_view">` because modern browsers sever the
           named-window match when `rel="noopener"` is set on an anchor, falling
           back to `_blank`-style behaviour and opening a duplicate tab on every
           click. window.open() with an explicit name reliably reuses the
           existing window across Chrome/Firefox/Edge/Safari. The anchor's
           href is kept so right-click → "Open in new tab" still works as a
           plain new-tab spawn. */}
      {isAdminPanel && user?.role === 'admin' && (
        <a
          href="/agent"
          onClick={(e) => {
            e.preventDefault();
            // Belt-and-suspenders with the useEffect above: if THIS tab is
            // currently named 'dsp_agent_view' (e.g. it was originally spawned
            // as the agent view and the admin re-logged into it), strip the
            // name first so window.open spawns a genuinely new tab instead of
            // navigating us in place.
            if (window.name === 'dsp_agent_view') window.name = '';
            const w = window.open('/agent', 'dsp_agent_view');
            // Some browsers don't auto-focus a reused named window on second
            // click. Calling .focus() explicitly brings it to the front. May
            // be a no-op if the popup was blocked (returns null) — in that
            // case the user falls back to the native href.
            if (w) w.focus();
          }}
          title="Open agent view in a sibling tab"
          data-testid="Sidebar-OpenAgentView"
          className={clsx(
            'border-b border-gray-800 flex items-center transition-colors text-gray-400 hover:text-white hover:bg-gray-800/50',
            collapsed ? 'px-3 py-3 justify-center' : 'gap-2.5 px-4 py-2.5 text-xs font-medium'
          )}
        >
          <Headphones className="w-4 h-4 flex-shrink-0" />
          {!collapsed && (
            <>
              <span className="flex-1">Open agent view</span>
              <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
            </>
          )}
        </a>
      )}

      {/* Navigation */}
      <nav className={clsx('flex-1 py-4 space-y-1 overflow-y-auto', collapsed ? 'px-2' : 'px-3')}>
        {/* When the sidebar is icon-only, render every leaf — groups don't fit
            in a narrow rail. When expanded, render top-level items + collapsible
            group sections. */}
        {(collapsed ? flatNavItems : navItems).map((item, idx) => {
          if (item.group) {
            const isOpen = !!openGroups[item.group];
            const GroupIcon = item.icon;
            // Aggregate dot on the group LABEL when any child has signal.
            // Currently only the System group has dynamic alerts.
            const groupHasAlert =
              item.group === 'System' &&
              ((adminBadges.new_bug_reports || 0) + adminSystemAlertCount > 0);
            return (
              <div key={item.group} className="pt-2">
                <button
                  type="button"
                  onClick={() => toggleGroup(item.group)}
                  className="flex items-center w-full gap-3 px-3 py-1.5 rounded-lg text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 transition-colors"
                >
                  <GroupIcon className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="flex-1 text-left">{item.group}</span>
                  {groupHasAlert && (
                    <span
                      data-testid={`Sidebar-Group-Dot-${item.group}`}
                      className="w-2 h-2 rounded-full bg-red-500 mr-1"
                      title="Items in this group need attention"
                    />
                  )}
                  <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', isOpen ? '' : '-rotate-90')} />
                </button>
                {isOpen && (
                  <div className="mt-1 space-y-1 pl-2 border-l border-gray-800 ml-3">
                    {item.items.map(child => renderNavLink(child, false))}
                  </div>
                )}
              </div>
            );
          }
          return renderNavLink(item, collapsed, idx);
        })}
      </nav>

      {/* Logout — hidden on the admin's agent view tab. Both tabs share the
          same JWT, so clicking Sign Out here would also kill the admin tab's
          session. Admin should sign out from /admin only; closing the agent
          tab is enough to "leave agent view". Regular agents always see this
          (their tab is their only login). */}
      {!(isAgentPanel && user?.role === 'admin') && (
        <div className={clsx('border-t border-gray-800', collapsed ? 'px-2 py-3' : 'px-3 py-4')}>
          <button
            data-testid="Sidebar-SignOutButton"
            onClick={() => { logout(); navigate('/login'); }}
            title={collapsed ? 'Sign Out' : undefined}
            className={clsx(
              'flex items-center w-full rounded-lg text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white transition-colors',
              collapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5'
            )}
          >
            <LogOut className="w-4 h-4" />
            {!collapsed && 'Sign Out'}
          </button>
        </div>
      )}
    </aside>
  );
}
