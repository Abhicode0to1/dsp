import { useEffect, useState, useRef } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, Loader } from 'lucide-react';
import { LogoFull } from '../components/common/Logo';
import { useAuth } from '../contexts/AuthContext';
import { ssoLogin } from '../services/api';

// Landing page for Phase 1 Customer Panel integration. Reached as
// /sso?token=... from the Customer Panel's "Support" nav link — the token IS
// the auth (short-lived, signed, single-use). On success we bootstrap the
// session exactly like a normal login and drop the customer straight into
// their dashboard; no password screen.
export default function SsoLanding() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();
  const { loginWithToken } = useAuth();

  const [error, setError] = useState('');
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return; // StrictMode double-invoke would burn the single-use token
    ranRef.current = true;

    if (!token) {
      setError('This sign-in link is missing its token.');
      return;
    }

    (async () => {
      try {
        const res = await ssoLogin({ token });
        loginWithToken(res.data.token, res.data.user);
        navigate(`/${res.data.user.role}`, { replace: true });
      } catch (err) {
        setError(err.response?.data?.error || 'This sign-in link is invalid or has expired.');
      }
    })();
  }, [token, loginWithToken, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-purple-50 px-4">
      <div className="w-full max-w-md">
        <div className="card p-8 shadow-xl">
          <div className="flex flex-col items-center mb-6">
            <LogoFull className="h-14 text-gray-900 mb-3" />
            <h1 className="text-xl font-bold text-gray-800">Signing you in…</h1>
          </div>

          {!error && (
            <div className="flex flex-col items-center py-8 text-gray-400">
              <Loader className="w-6 h-6 animate-spin mb-2" />
              <p className="text-xs">Verifying your sign-in link…</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-800">Couldn't sign you in automatically</p>
                <p className="text-xs text-red-700 mt-1">{error}</p>
                <p className="text-xs text-red-600 mt-2">
                  Please <Link to="/login" className="underline font-medium">log in directly</Link> instead.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
