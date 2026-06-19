import { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);

  useEffect(() => {
    if (!user) {
      setSocket(prev => {
        if (prev) prev.disconnect();
        return null;
      });
      setConnected(false);
      return;
    }

    const token = localStorage.getItem('dsp_token');
    const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
    const newSocket = io(backendUrl, {
      auth: { token },
      // WebSocket-only (Cloudflare WebSockets is enabled). Dropping the
      // poll-then-upgrade dance eliminates the reconnect storm we saw through
      // the CDN — a clean WS path stays up instead of thrashing transports.
      transports: ['websocket'],
    });

    newSocket.on('connect', () => {
      setConnected(true);
      setEverConnected(true);
      // Only regular agents auto-join the routing pool on connect. Admins
      // explicitly opt in by mounting the /agent panel (see AgentRouteJoin),
      // so the admin panel itself doesn't put them in the rotation.
      if (user.role === 'agent') {
        newSocket.emit('join_agent_room');
      }
    });

    newSocket.on('disconnect', () => setConnected(false));

    newSocket.on('connect_error', (err) => {
      console.warn('Socket connection error:', err.message);
      // Backend rejects the handshake with this exact message when the JWT's
      // jti no longer matches the user's active_session_jti — i.e. the user
      // logged in from another device. Bail out to /login so the stale tab
      // doesn't keep reconnect-looping uselessly.
      if (err.message === 'session_revoked') {
        try { sessionStorage.setItem('dsp_session_revoked', '1'); } catch {}
        localStorage.removeItem('dsp_token');
        localStorage.removeItem('dsp_user');
        if (window.location.pathname !== '/login') window.location.href = '/login';
      }
    });

    // Direct event from the backend's rotateSession helper — fires the moment
    // a new login is recorded, before any API request would have surfaced the
    // 401. Gives the old device near-instant feedback instead of waiting for
    // their next poll.
    newSocket.on('session_revoked', () => {
      try { sessionStorage.setItem('dsp_session_revoked', '1'); } catch {}
      localStorage.removeItem('dsp_token');
      localStorage.removeItem('dsp_user');
      if (window.location.pathname !== '/login') window.location.href = '/login';
    });

    setSocket(newSocket);
    // Test/diagnostic hook: load-test specs and devtool snippets look up the
    // live socket via window.__appSocket so they can instrument emits/events.
    // No-op for production users — the variable is just a reference, not a UI.
    if (typeof window !== 'undefined') window.__appSocket = newSocket;

    return () => {
      newSocket.disconnect();
      if (typeof window !== 'undefined' && window.__appSocket === newSocket) {
        delete window.__appSocket;
      }
      setSocket(null);
      setConnected(false);
    };
  }, [user?.id, user?.role]);

  return (
    <SocketContext.Provider value={{ socket, connected, everConnected }}>
      {children}
    </SocketContext.Provider>
  );
}

export const useSocket = () => useContext(SocketContext);
