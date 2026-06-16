import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { requestOtp, verifyOtp } from '../services/api';
import { Eye, EyeOff, AlertCircle, Mail, KeyRound } from 'lucide-react';
import toast from 'react-hot-toast';
import { LogoFull } from '../components/common/Logo';


export default function LoginPage() {
  const { login, loginWithToken, finalize2faLogin } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState('password'); // 'password' | 'otp'
  const [step, setStep] = useState(1);           // OTP step 1=email, 2=code

  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [otpCode, setOtpCode]   = useState('');
  const [userId, setUserId]     = useState(null);
  // 2FA flow state: when the server returns requires_2fa we stash the partial
  // token here and show the 6-digit / backup-code prompt instead of the
  // normal password form.
  const [twoFaState, setTwoFaState] = useState(null); // { partial_token, must_setup }
  const [twoFaCode, setTwoFaCode]   = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // If we landed here because the backend revoked our session (logged out
  // from another tab, or admin force-logout in the future), surface a one-
  // time toast so the user understands why they were bounced. The flag is
  // set by services/api.js and SocketContext.jsx when they catch a 401 /
  // session_revoked event.
  useEffect(() => {
    try {
      if (sessionStorage.getItem('dsp_session_revoked') === '1') {
        sessionStorage.removeItem('dsp_session_revoked');
        toast.error('Your session has ended. Please sign in again.', { duration: 6000 });
      }
    } catch {}
  }, []);

  const handlePasswordLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(email.trim(), password);
      // 2FA branch: server returns a partial token instead of a session. We
      // switch the form to a 6-digit prompt without leaving this page.
      if (result?.requires_2fa) {
        setTwoFaState({ partial_token: result.partial_token, must_setup: !!result.must_setup_2fa });
        return;
      }
      toast.success(`Welcome back, ${result.name}!`);
      navigate(`/${result.role}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handle2faSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!twoFaCode.trim()) { setError('Enter your 6-digit code (or a backup code).'); return; }
    setLoading(true);
    try {
      const user = await finalize2faLogin(twoFaState.partial_token, twoFaCode.trim());
      toast.success(`Welcome back, ${user.name}!`);
      navigate(`/${user.role}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Code did not match. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const cancel2fa = () => {
    setTwoFaState(null);
    setTwoFaCode('');
    setError('');
  };

  const handleRequestOtp = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await requestOtp({ email: email.trim() });
      setUserId(res.data.userId);
      setStep(2);
      toast.success('OTP sent to your email!');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send OTP. Check your email.');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await verifyOtp({ userId, code: otpCode });
      const { token, user } = res.data;
      loginWithToken(token, user);
      toast.success(`Welcome back, ${user.name}!`);
      navigate(`/${user.role}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid or expired OTP.');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (m) => {
    setMode(m);
    setStep(1);
    setError('');
    setOtpCode('');
    setUserId(null);
  };

  // Login shell: min-h-screen (not fixed) + overflow-y-auto + vertical padding
  // so when the card (with the demo-accounts list) is taller than the window it
  // scrolls instead of butting against / clipping at the browser top.
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-indigo-950 to-gray-900 flex items-center justify-center px-4 py-10 sm:py-12 overflow-y-auto">
      <div className="w-full max-w-md">
        {/* Logo — full lockup (cloud + ANUTECH / DIGITAL) on dark background */}
        <div className="text-center mb-8">
          <LogoFull className="mx-auto h-20 text-white mb-3" />
          <p className="text-gray-400 text-sm mt-1">Centralized Customer Support Platform</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-8">
          {/* Mode toggle */}
          <div className="flex rounded-lg bg-gray-100 p-1 mb-6">
            <button
              data-testid="Login-PasswordModeTab"
              onClick={() => switchMode('password')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-sm font-medium transition-all ${mode === 'password' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <KeyRound className="w-3.5 h-3.5" /> Password
            </button>
            <button
              data-testid="Login-OtpModeTab"
              onClick={() => switchMode('otp')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-sm font-medium transition-all ${mode === 'otp' ? 'bg-white shadow text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}
            >
              <Mail className="w-3.5 h-3.5" /> Email OTP
            </button>
          </div>

          <h2 className="text-xl font-semibold text-gray-800 mb-5">
            {mode === 'otp' && step === 2 ? 'Enter OTP' : 'Sign In'}
          </h2>

          {error && (
            <div className="flex items-center gap-2 bg-red-50 text-red-700 border border-red-200 rounded-lg p-3 mb-5 text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* 2FA code prompt — shown after a successful password if the account
              has 2FA on (or the global admin-2FA requirement is on). */}
          {twoFaState && (
            <form onSubmit={handle2faSubmit} className="space-y-4">
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-sm text-indigo-800">
                <p className="font-semibold mb-1">Two-factor verification</p>
                {twoFaState.must_setup ? (
                  <p className="text-xs">Two-factor is required for admin accounts. You'll be prompted to set up your authenticator app after this sign-in — for now, type the code from any existing setup, or contact a super-admin if you've never enrolled.</p>
                ) : (
                  <p className="text-xs">Open your authenticator app (Google Authenticator, Authy, 1Password, etc.) and enter the 6-digit code. If you lost your phone, enter one of your backup codes (e.g. <code className="font-mono">AB12-CD34</code>).</p>
                )}
              </div>
              <div>
                <label className="label">Authenticator code</label>
                <input type="text" autoFocus inputMode="numeric" autoComplete="one-time-code"
                  className="input font-mono tracking-widest text-center" placeholder="123456"
                  value={twoFaCode} onChange={e => setTwoFaCode(e.target.value)} required />
              </div>
              <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5">
                {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Verify & sign in'}
              </button>
              <button type="button" onClick={cancel2fa} className="text-xs text-gray-500 hover:text-gray-700 w-full text-center">
                ← Use a different account
              </button>
            </form>
          )}

          {/* Password login */}
          {!twoFaState && mode === 'password' && (
            <form data-testid="Login-PasswordForm" onSubmit={handlePasswordLogin} className="space-y-4">
              <div>
                <label className="label">Email Address</label>
                <input data-testid="Login-EmailInput" type="email" className="input" placeholder="you@example.com"
                  value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </div>
              <div>
                <label className="label">Password</label>
                <div className="relative">
                  <input
                    data-testid="Login-PasswordInput"
                    type={showPw ? 'text' : 'password'}
                    className="input pr-10"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                  <button data-testid="Login-TogglePasswordVisibility" type="button" onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <button data-testid="Login-SubmitButton" type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5 mt-2">
                {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Sign In'}
              </button>
            </form>
          )}

          {/* OTP step 1 — request code */}
          {mode === 'otp' && step === 1 && (
            <form data-testid="Login-OtpRequestForm" onSubmit={handleRequestOtp} className="space-y-4">
              <div>
                <label className="label">Email Address</label>
                <input data-testid="Login-OtpEmailInput" type="email" className="input" placeholder="you@example.com"
                  value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
              </div>
              <button data-testid="Login-SendOtpButton" type="submit" disabled={loading} className="btn-primary w-full justify-center py-2.5 mt-2">
                {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Send OTP'}
              </button>
            </form>
          )}

          {/* OTP step 2 — enter code */}
          {mode === 'otp' && step === 2 && (
            <form data-testid="Login-OtpVerifyForm" onSubmit={handleVerifyOtp} className="space-y-4">
              <p className="text-sm text-gray-600">A 6-digit code was sent to <span className="font-medium">{email}</span>.</p>
              <div>
                <label className="label">One-Time Code</label>
                <input
                  data-testid="Login-OtpCodeInput"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  className="input text-center tracking-[0.5em] text-lg font-bold"
                  placeholder="000000"
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  required
                  autoFocus
                />
              </div>
              <button data-testid="Login-VerifyOtpButton" type="submit" disabled={loading || otpCode.length !== 6} className="btn-primary w-full justify-center py-2.5">
                {loading ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Verify & Sign In'}
              </button>
              <button data-testid="Login-OtpBackButton" type="button" onClick={() => { setStep(1); setOtpCode(''); setError(''); }}
                className="w-full text-sm text-gray-500 hover:text-gray-700 text-center">
                ← Back
              </button>
            </form>
          )}

        </div>
      </div>
    </div>
  );
}
