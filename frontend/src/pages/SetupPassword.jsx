import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { Lock, AlertTriangle, Loader, CheckCircle2 } from 'lucide-react';
import { LogoFull } from '../components/common/Logo';
import { useAuth } from '../contexts/AuthContext';

// Landing page reached from the "Set my password" link in the welcome email.
// The :token URL param IS the auth — there's no other gate. On success the
// backend auto-logs the user in and we redirect to /customer.
export default function SetupPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { loginWithToken } = useAuth();

  const [checking, setChecking]   = useState(true);
  const [tokenUser, setTokenUser] = useState(null);
  const [tokenError, setTokenError] = useState('');

  const [pwd, setPwd] = useState('');
  const [pwd2, setPwd2] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // Validate the token as soon as the page loads. If invalid/expired, show a clear
  // explanation instead of a confusing form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(`/api/auth/setup-password/${token}`);
        if (!cancelled) setTokenUser(r.data.user);
      } catch (err) {
        if (!cancelled) setTokenError(err.response?.data?.error || 'This setup link is invalid or has expired.');
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitError('');
    if (pwd.length < 8) { setSubmitError('Password must be at least 8 characters'); return; }
    if (pwd !== pwd2)   { setSubmitError('Passwords don\'t match'); return; }
    setSubmitting(true);
    try {
      const r = await axios.post('/api/auth/setup-password', { token, new_password: pwd });
      // Mirror the login flow's session bootstrapping so the user lands fully logged in.
      loginWithToken(r.data.token, r.data.user);
      navigate('/customer', { replace: true });
    } catch (err) {
      setSubmitError(err.response?.data?.error || 'Failed to set password');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-purple-50 px-4">
      <div className="w-full max-w-md">
        <div className="card p-8 shadow-xl">
          {/* Header */}
          <div className="flex flex-col items-center mb-6">
            <LogoFull className="h-14 text-gray-900 mb-3" />
            <h1 className="text-xl font-bold text-gray-800">Set your password</h1>
            <p className="text-sm text-gray-500 mt-1 text-center">
              Welcome to the Anutech Digital support portal. Pick a password to finish setting up your account.
            </p>
          </div>

          {/* Three states: checking / invalid token / form */}
          {checking && (
            <div className="flex flex-col items-center py-8 text-gray-400">
              <Loader className="w-6 h-6 animate-spin mb-2" />
              <p className="text-xs">Verifying your invitation…</p>
            </div>
          )}

          {!checking && tokenError && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800">Invitation link not valid</p>
                <p className="text-xs text-red-700 mt-1">{tokenError}</p>
                <p className="text-xs text-red-600 mt-2">
                  Please contact your account manager and ask them to send you a fresh link.
                </p>
              </div>
            </div>
          )}

          {!checking && tokenUser && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm">
                <p className="text-gray-600 text-xs">Setting up account for</p>
                <p className="font-semibold text-gray-800">{tokenUser.name}</p>
                <p className="text-xs text-gray-500 font-mono">{tokenUser.email}</p>
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-700 mb-1 block">New password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="password" value={pwd} onChange={e => setPwd(e.target.value)}
                    placeholder="At least 8 characters" autoFocus
                    className="input pl-9 w-full" required minLength={8}
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-700 mb-1 block">Confirm password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    type="password" value={pwd2} onChange={e => setPwd2(e.target.value)}
                    placeholder="Re-enter your password"
                    className="input pl-9 w-full" required minLength={8}
                  />
                </div>
              </div>

              {submitError && (
                <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">{submitError}</div>
              )}

              <button type="submit" disabled={submitting} className="btn-primary w-full py-2.5 inline-flex items-center justify-center gap-2">
                {submitting
                  ? <><Loader className="w-4 h-4 animate-spin" /> Setting password…</>
                  : <><CheckCircle2 className="w-4 h-4" /> Set Password &amp; Log In</>}
              </button>

              <p className="text-xs text-gray-400 text-center">
                After setting your password you'll be taken straight to your dashboard.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
