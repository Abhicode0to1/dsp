import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import Sidebar from './Sidebar';
import ScrollToTop from './ScrollToTop';
import GlobalRefreshButton from './GlobalRefreshButton';
import CustomerNotificationBell from '../customer/NotificationBell';
import AgentNotificationBell from '../agent/NotificationBell';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import { usePublicSettings } from '../../contexts/PublicSettingsContext';
// AgentCallOverlay, OutboundCallOverlay, CommandPalette, BotWidget,
// IncomingAgentCall, FeedbackWidget — all now mounted at app-level in App.jsx
// so they survive route changes. Importing them here would just remount them
// on every navigation, killing live calls (bug #21).
import useIdle from '../../hooks/useIdle';
import { WifiOff, Menu } from 'lucide-react';

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — fallback if admin setting unavailable

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const { socket, connected, everConnected } = useSocket();
  const { settings: publicSettings } = usePublicSettings();
  const location = useLocation();

  // Mobile nav drawer (Phase 1 mobile shell). Desktop never sees this — the
  // sidebar is a normal in-flow column at lg+ and the hamburger is lg:hidden.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Auto-close the drawer whenever the route changes so a nav tap doesn't leave
  // the overlay covering the freshly-loaded page.
  useEffect(() => { setMobileNavOpen(false); }, [location.pathname]);

  // Admin-configurable idle timeout (only enforce for admin role — agents and
  // customers stay on the legacy default). Falls back to 30min if the public
  // settings haven't loaded yet.
  const idleMs = user?.role === 'admin' && publicSettings?.admin_idle_timeout_minutes
    ? Math.max(60_000, publicSettings.admin_idle_timeout_minutes * 60_000)
    : DEFAULT_IDLE_TIMEOUT_MS;

  useIdle(idleMs, () => {
    logout();
    window.location.href = '/login';
  });

  // Admin-only: join the routing pool *only* while the admin is on an agent
  // route. Regular agents auto-join on socket connect via SocketContext; admins
  // opt in by being on /agent/*. Closing the tab disconnects the socket → it
  // leaves all rooms naturally, so admins receive no rings unless their agent
  // panel is actually open. Navigating between /agent pages keeps `isAgentRoute`
  // true so we don't flap join/leave per click.
  const isAgentRoute = location.pathname.startsWith('/agent');
  useEffect(() => {
    if (!socket || user?.role !== 'admin' || !isAgentRoute) return;
    socket.emit('join_agent_room');
    return () => socket.emit('leave_agent_room');
  }, [socket, user?.role, isAgentRoute]);

  // Customer-only: in-app nudge when admin resets their monthly usage. Pairs with
  // the sendUsageResetEmail backend hook — covers customers who happen to be in
  // the panel at reset time, before the email arrives.
  useEffect(() => {
    if (user?.role !== 'customer' || !socket) return;
    const onReset = ({ callLimit, chatLimit }) => {
      const parts = [];
      if (callLimit != null) parts.push(`0/${callLimit} calls`);
      if (chatLimit != null) parts.push(`0/${chatLimit} chats`);
      const summary = parts.length ? ` — your new quota is ${parts.join(', ')}` : '';
      toast.success(`Your support usage has been reset by our team${summary}.`, { duration: 7000 });
    };
    socket.on('usage_reset', onReset);
    return () => socket.off('usage_reset', onReset);
  }, [user?.role, socket]);

  // Agent/admin notification handling for incoming chats lives in NotificationBell.jsx
  // (centralized — has the ringtone + bell-list integration + 90s sticky toast).
  // We used to have a duplicate toast here, which is why agents saw TWO notifications
  // stacked on top of each other. Removed in favor of the bell's single source of truth.
  // Tab-title flashing for backgrounded tabs is also handled there.

  return (
    <div className="flex h-dvh overflow-hidden bg-gray-50">
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      {/* Mobile drawer backdrop — tap to dismiss. Never shown at lg+. */}
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="flex-1 flex flex-col overflow-hidden">
        {everConnected && !connected && user && (
          <div className="flex items-center gap-2 bg-amber-500 text-white text-xs font-medium px-4 py-2 flex-shrink-0">
            <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Disconnected from server — attempting to reconnect...</span>
          </div>
        )}
        {/* Maintenance banner — customer-facing only. Admins / agents stay
            working during maintenance so they can finish in-flight cases. */}
        {publicSettings?.maintenance_mode && user?.role === 'customer' && (
          <div className="flex items-center gap-2 bg-amber-600 text-white text-xs font-medium px-4 py-2 flex-shrink-0">
            <span className="font-bold">⚠ Maintenance:</span>
            <span>{publicSettings.maintenance_message || "We're doing maintenance. Support will resume shortly."}</span>
          </div>
        )}
        {user?.role === 'customer' && (
          <div className="flex items-center gap-2 px-4 lg:px-6 pt-safe lg:pt-2 pb-2 border-b border-gray-100 bg-white flex-shrink-0">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 -ml-2 text-gray-600 hover:text-gray-900 rounded-lg"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="ml-auto flex items-center gap-1">
              <GlobalRefreshButton />
              <CustomerNotificationBell />
            </div>
          </div>
        )}
        {(user?.role === 'agent' || user?.role === 'admin') && (
          // Mounted at Layout level so its socket listeners + chat ringtone
          // are ALWAYS active, regardless of which agent page the user is on.
          // Previously the bell was rendered inline in only some pages (Dashboard,
          // Tickets, Chats) — agents on Calls or Performance silently missed
          // incoming-chat rings because the listener wasn't mounted.
          // Bonus: the notification list now persists across navigations
          // (component stays mounted) instead of resetting on every page change.
          <div className="flex items-center gap-2 px-4 lg:px-6 pt-safe lg:pt-2 pb-2 border-b border-gray-100 bg-white flex-shrink-0">
            <button
              onClick={() => setMobileNavOpen(true)}
              className="lg:hidden p-2 -ml-2 text-gray-600 hover:text-gray-900 rounded-lg"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="ml-auto flex items-center gap-1">
              <GlobalRefreshButton />
              <AgentNotificationBell />
            </div>
          </div>
        )}
        <main id="main-scroll" className="flex-1 overflow-y-auto">
          {/* Tighter padding on phones, original p-6 from lg up. Extra bottom
              padding on mobile so the last content clears the floating
              bot/bug-report buttons (fixed bottom-right). */}
          <div className="p-4 lg:p-6 pb-20 lg:pb-6 max-w-7xl mx-auto">
            {children}
          </div>
        </main>
        {/* Admin-configurable footer — typically a copyright / company line.
            Hidden when empty so the layout stays compact for unbranded installs. */}
        {publicSettings?.brand_footer_text && (
          <div className="px-6 py-2 border-t border-gray-100 bg-white text-[11px] text-gray-400 text-center flex-shrink-0">
            {publicSettings.brand_footer_text}
          </div>
        )}
        <ScrollToTop />
      </div>
      {/* Call overlays, BotWidget, CommandPalette, IncomingAgentCall, and
          FeedbackWidget all moved to App.jsx <PersistentOverlays /> — they
          need to live OUTSIDE the per-route Layout so they don't remount on
          navigation and drop the active call. */}
    </div>
  );
}
