import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import { PublicSettingsProvider } from './contexts/PublicSettingsContext';
import ErrorBoundary from './components/common/ErrorBoundary';
import PWAPrompt from './components/common/PWAPrompt';
import InstallPrompt from './components/common/InstallPrompt';
import FloatingDock from './components/common/FloatingDock';

// Persistent overlays — mounted OUTSIDE the per-route Layout so they survive
// navigation between pages. The WebRTC peer connection, mic stream, ringtone
// audio context, and call-elapsed timer all live in these components' state;
// re-mounting on every route change (which is what happens when each page
// independently wraps itself in <Layout> and Layout mounts the overlays) wipes
// the live call. By rendering them at app-level the call popup follows the
// user across Dashboard / Tickets / Chats / Calls / Performance / etc.
import AgentCallOverlay from './components/agent/AgentCallOverlay';
import IncomingChatTransferOverlay from './components/agent/IncomingChatTransferOverlay';
import OutboundCallOverlay from './components/agent/OutboundCallOverlay';
import CommandPalette from './components/agent/CommandPalette';
import BotWidget from './components/customer/BotWidget';
import IncomingAgentCall from './components/customer/IncomingAgentCall';
import CustomerCallMiniOverlay from './components/customer/CustomerCallMiniOverlay';
import CustomerCallModal from './components/customer/CustomerCallModal';
import FeedbackWidget from './components/common/FeedbackWidget';
import { CustomerCallProvider } from './contexts/CustomerCallContext';

import LoginPage from './pages/Login';
import CustomerDashboard from './pages/customer/Dashboard';
import CustomerTickets from './pages/customer/Tickets';
import CustomerNewTicket from './pages/customer/NewTicket';
import CustomerTicketDetail from './pages/customer/TicketDetail';
import CustomerChat from './pages/customer/Chat';
import CustomerCall from './pages/customer/Call';
import CustomerKnowledgeBase from './pages/customer/KnowledgeBase';
import CustomerBilling from './pages/customer/Billing';
import CustomerChatHistory from './pages/customer/ChatHistory';
import CustomerProfile from './pages/customer/Profile';
import SetupPassword from './pages/SetupPassword';
import AgentDashboard from './pages/agent/Dashboard';
import AgentTickets from './pages/agent/Tickets';
import AgentChats from './pages/agent/Chats';
import AgentCalls from './pages/agent/Calls';
import AgentPerformance from './pages/agent/Performance';
import AdminDashboard from './pages/admin/Dashboard';
import AdminCustomers from './pages/admin/Customers';
import AdminAgents from './pages/admin/Agents';
import AdminTickets from './pages/admin/Tickets';
import AdminChats from './pages/admin/Chats';
import AdminReports from './pages/admin/Reports';
import AdminPerformance from './pages/admin/Performance';
import AdminPlans from './pages/admin/Plans';
import AdminCalls from './pages/admin/Calls';
import AdminTemplates from './pages/admin/Templates';
import AdminAuditLog from './pages/admin/AuditLog';
import AdminSettings from './pages/admin/Settings';
import AdminSystemHealth from './pages/admin/SystemHealth';
import AdminFeedback from './pages/admin/Feedback';
// BillingSyncs.jsx is now imported as BillingSyncsPanel inside SystemHealth (merged as a tab)

// Renders the floating widgets that need to outlive route changes. Conditional
// on user role so each panel only mounts the overlays it actually uses.
//
// Admins are tricky: they're a real user with a socket room, and they can open
// the agent panel in a second tab via the "Open agent view" button. That tab
// gets the agent-style ringer (AgentCallOverlay, IncomingChatTransferOverlay,
// etc.). The MAIN admin tab (/admin/*) must NOT mount those overlays — both
// tabs share user_<adminId>, so an incoming_call broadcast would otherwise
// fire ringers in both tabs, and the ringer in the /admin tab would never
// clear because the accept/end happens against the agent-tab's call state.
// So: only mount the agent overlays when the role is 'agent' OR the admin is
// currently viewing the /agent path. The admin's /admin pages stay silent.
function PersistentOverlays() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return null;
  const onAgentPath = location.pathname.startsWith('/agent');
  const showAgentOverlays = user.role === 'agent' || (user.role === 'admin' && onAgentPath);
  return (
    <>
      {showAgentOverlays && (
        <>
          <AgentCallOverlay />
          <OutboundCallOverlay />
          <CommandPalette />
          <IncomingChatTransferOverlay />
        </>
      )}
      {user.role === 'customer' && (
        <>
          {/* Launcher hidden on MOBILE only (the dock triggers it there); on
              desktop the original floating button stays. */}
          <BotWidget hideLauncherOnMobile />
          <IncomingAgentCall />
          <CustomerCallMiniOverlay />
          {/* Full call popup over the live-chat page (the mini-overlay handles
              other pages). Both read the same shared call engine. */}
          <CustomerCallModal />
        </>
      )}
      {/* Same: bug-report launcher hidden on mobile (dock), shown on desktop. */}
      <FeedbackWidget hideLauncherOnMobile />
      {/* Edge-docked quick actions — MOBILE ONLY. Desktop keeps the original
          floating bot + bug buttons. `contents lg:hidden`: dock renders on
          mobile, removed at lg+. */}
      <div className="contents lg:hidden">
        <FloatingDock showAssistant={user.role === 'customer'} />
      </div>
      {/* Install-to-home-screen banner — only for logged-in users, self-hides
          when already installed / dismissed / not installable. */}
      <InstallPrompt />
    </>
  );
}

function RequireAuth({ children, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex h-screen items-center justify-center"><div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to={`/${user.role}`} replace /> : <LoginPage />} />
      <Route path="/setup-password/:token" element={<SetupPassword />} />

      {/* Customer */}
      <Route path="/customer" element={<RequireAuth roles={['customer']}><CustomerDashboard /></RequireAuth>} />
      <Route path="/customer/tickets" element={<RequireAuth roles={['customer']}><CustomerTickets /></RequireAuth>} />
      <Route path="/customer/tickets/new" element={<RequireAuth roles={['customer']}><CustomerNewTicket /></RequireAuth>} />
      <Route path="/customer/tickets/:id" element={<RequireAuth roles={['customer']}><CustomerTicketDetail /></RequireAuth>} />
      <Route path="/customer/chat" element={<RequireAuth roles={['customer']}><CustomerChat /></RequireAuth>} />
      <Route path="/customer/call" element={<RequireAuth roles={['customer']}><CustomerCall /></RequireAuth>} />
      <Route path="/customer/billing"         element={<RequireAuth roles={['customer']}><CustomerBilling /></RequireAuth>} />
      <Route path="/customer/profile"        element={<RequireAuth roles={['customer']}><CustomerProfile /></RequireAuth>} />
      <Route path="/customer/chat-history"   element={<RequireAuth roles={['customer']}><CustomerChatHistory /></RequireAuth>} />
      <Route path="/customer/knowledge-base" element={<RequireAuth roles={['customer']}><CustomerKnowledgeBase /></RequireAuth>} />

      {/* Agent */}
      <Route path="/agent"             element={<RequireAuth roles={['agent', 'admin']}><AgentDashboard /></RequireAuth>} />
      <Route path="/agent/tickets"     element={<RequireAuth roles={['agent', 'admin']}><AgentTickets /></RequireAuth>} />
      <Route path="/agent/chats"       element={<RequireAuth roles={['agent', 'admin']}><AgentChats /></RequireAuth>} />
      <Route path="/agent/calls"       element={<RequireAuth roles={['agent', 'admin']}><AgentCalls /></RequireAuth>} />
      <Route path="/agent/performance" element={<RequireAuth roles={['agent', 'admin']}><AgentPerformance /></RequireAuth>} />

      {/* Admin */}
      <Route path="/admin"            element={<RequireAuth roles={['admin']}><AdminDashboard /></RequireAuth>} />
      <Route path="/admin/customers"  element={<RequireAuth roles={['admin']}><AdminCustomers /></RequireAuth>} />
      <Route path="/admin/agents"     element={<RequireAuth roles={['admin']}><AdminAgents /></RequireAuth>} />
      <Route path="/admin/tickets"    element={<RequireAuth roles={['admin']}><AdminTickets /></RequireAuth>} />
      <Route path="/admin/chats"      element={<RequireAuth roles={['admin']}><AdminChats /></RequireAuth>} />
      <Route path="/admin/reports"      element={<RequireAuth roles={['admin']}><AdminReports /></RequireAuth>} />
      <Route path="/admin/performance"  element={<RequireAuth roles={['admin']}><AdminPerformance /></RequireAuth>} />
      <Route path="/admin/plans"        element={<RequireAuth roles={['admin']}><AdminPlans /></RequireAuth>} />
      <Route path="/admin/calls"        element={<RequireAuth roles={['admin']}><AdminCalls /></RequireAuth>} />
      <Route path="/admin/templates"   element={<RequireAuth roles={['admin']}><AdminTemplates /></RequireAuth>} />
      {/* Legacy URL — kept so old bookmarks / docs still work. AdminTemplates
          detects the path and opens the Email Templates tab automatically. */}
      <Route path="/admin/email-templates" element={<RequireAuth roles={['admin']}><AdminTemplates /></RequireAuth>} />
      <Route path="/admin/audit"      element={<RequireAuth roles={['admin']}><AdminAuditLog /></RequireAuth>} />
      <Route path="/admin/health"        element={<RequireAuth roles={['admin']}><AdminSystemHealth /></RequireAuth>} />
      <Route path="/admin/feedback"      element={<RequireAuth roles={['admin']}><AdminFeedback /></RequireAuth>} />
      {/* Legacy URL — old emails / bookmarks land here, redirect into the merged tab */}
      <Route path="/admin/billing-syncs" element={<Navigate to="/admin/health?tab=billing-syncs" replace />} />
      <Route path="/admin/settings"      element={<RequireAuth roles={['admin']}><AdminSettings /></RequireAuth>} />

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      {/* PWA service-worker registration + "new version" prompt. Sits above
          auth so the worker registers regardless of login state. */}
      <PWAPrompt />
      <AuthProvider>
        <PublicSettingsProvider>
        <SocketProvider>
          {/* CustomerCallProvider wraps everything for the same reason as the
              persistent overlays — its useWebRTCCall hook can't be tied to a
              page that unmounts on nav. It's a no-op for non-customers (no
              socket events match), so safe to host at the very top. */}
          <CustomerCallProvider>
            <AppRoutes />
            {/* Overlays are siblings of <Routes>, NOT nested inside any route's
                Layout, so they survive navigation. This is the fix for bug #21
                ("call popup disappears when switching tabs") — when a user
                navigates between sidebar items, React keeps these mounted
                with their WebRTC connection, ringtone state, etc. intact. */}
            <PersistentOverlays />
          </CustomerCallProvider>
        </SocketProvider>
        </PublicSettingsProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
