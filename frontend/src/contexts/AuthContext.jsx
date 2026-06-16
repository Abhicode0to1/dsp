import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { login as apiLogin, logout as apiLogout, getMe, verifyLogin2fa } from '../services/api';


const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('dsp_token');
    const saved = localStorage.getItem('dsp_user');
    if (!token || !saved) {
      setLoading(false);
      return;
    }
    // Optimistically render from cached user so the UI doesn't flash a spinner
    // on every refresh — but verify against the server to catch expired tokens.
    try { setUser(JSON.parse(saved)); } catch {}
    getMe()
      .then((res) => {
        // Backend confirmed token is still valid. Merge any updates (e.g. name change).
        const fresh = { ...JSON.parse(saved), ...res.data };
        localStorage.setItem('dsp_user', JSON.stringify(fresh));
        setUser(fresh);
      })
      .catch((err) => {
        // Only clear the session on an explicit revocation signal from the
        // backend. A bare 401 (token expired, transient handshake hiccup, race
        // during a new-tab boot) gets the soft treatment — keep the cached
        // user so the page can render, and let the next API call surface the
        // real auth state. Without this, opening a new browser tab races the
        // /auth/me round-trip and a momentary failure wipes both tabs.
        if (err?.response?.data?.code === 'session_revoked') {
          localStorage.removeItem('dsp_token');
          localStorage.removeItem('dsp_user');
          setUser(null);
        }
        // All other errors (401 without code, network, 500): keep cached user.
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await apiLogin({ email, password });
    // 2FA path — the backend returned a partial token instead of a session.
    // Hand it back to the caller; the Login page will prompt for the code
    // and call finalize2faLogin(partial_token, code) to complete sign-in.
    if (res.data.requires_2fa) {
      return { requires_2fa: true, must_setup_2fa: !!res.data.must_setup_2fa, partial_token: res.data.partial_token };
    }
    const { token, user: userData } = res.data;
    localStorage.setItem('dsp_token', token);
    localStorage.setItem('dsp_user', JSON.stringify(userData));
    setUser(userData);
    return userData;
  }, []);

  // Step-2 of 2FA login — exchange the partial_token + 6-digit (or backup) code
  // for the real session JWT.
  const finalize2faLogin = useCallback(async (partial_token, code) => {
    const res = await verifyLogin2fa({ partial_token, code });
    const { token, user: userData } = res.data;
    localStorage.setItem('dsp_token', token);
    localStorage.setItem('dsp_user', JSON.stringify(userData));
    setUser(userData);
    return userData;
  }, []);

  const loginWithToken = useCallback((token, userData) => {
    localStorage.setItem('dsp_token', token);
    localStorage.setItem('dsp_user', JSON.stringify(userData));
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    // Fire-and-forget — the server-side logout clears active_session_jti so
    // the JWT can't be reused, but we don't block the UI on the round-trip.
    // If the network is offline / the token's already invalid, the local
    // teardown still runs and the user lands on /login.
    apiLogout().catch(() => {});
    localStorage.removeItem('dsp_token');
    localStorage.removeItem('dsp_user');
    localStorage.removeItem('dsp_bot_history');
    localStorage.removeItem('dsp_bot_last_seen');
    localStorage.removeItem('agent_status'); // per-agent availability; don't leak across users
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const res = await getMe();
      const updated = { ...user, ...res.data };
      localStorage.setItem('dsp_user', JSON.stringify(updated));
      setUser(updated);
    } catch {}
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, login, loginWithToken, finalize2faLogin, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
