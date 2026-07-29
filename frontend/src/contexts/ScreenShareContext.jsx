import { createContext, useContext } from 'react';
import { useScreenShare } from '../hooks/useScreenShare';
import { useAuth } from './AuthContext';
import AgentScreenViewer from '../components/agent/AgentScreenViewer';
import CustomerScreenPrompt from '../components/customer/CustomerScreenPrompt';

// One screen-share engine for the whole app. Mounted once (in App), it runs a
// SINGLE useScreenShare instance — so there's never more than one WebRTC
// peer/socket-listener answering a request (the bug you'd get from mounting the
// widget in both the chat page and the persistent call overlay). Buttons
// anywhere (chat toolbar, call overlay) drive it via useScreenShareCtx().
const ScreenShareContext = createContext(null);

export function useScreenShareCtx() {
  return useContext(ScreenShareContext);
}

export function ScreenShareProvider({ children }) {
  const screen = useScreenShare();
  const { user } = useAuth();
  const role = user?.role;

  return (
    <ScreenShareContext.Provider value={screen}>
      {children}
      {/* Role-appropriate UI, rendered once, works on any page. */}
      {(role === 'agent' || role === 'admin') && <AgentScreenViewer screen={screen} />}
      {role === 'customer' && <CustomerScreenPrompt screen={screen} />}
    </ScreenShareContext.Provider>
  );
}
