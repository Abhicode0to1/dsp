import { useState } from 'react';
import Layout from '../../components/common/Layout';
import { useAuth } from '../../contexts/AuthContext';
import { changePassword, requestChangePasswordOtp } from '../../services/api';
import { KeyRound, Eye, EyeOff, Check, Mail } from 'lucide-react';
import toast from 'react-hot-toast';

export default function CustomerProfile() {
  const { user } = useAuth();

  // 'password' = prove identity with current password; 'otp' = prove by control
  // of the registered email (for customers who only ever log in via OTP and
  // therefore don't know the password on their record).
  const [mode, setMode] = useState('password');
  const [current, setCurrent]   = useState('');
  const [otpCode, setOtpCode]   = useState('');
  const [otpSent, setOtpSent]   = useState(false);
  const [requestingOtp, setRequestingOtp] = useState(false);
  const [next, setNext]         = useState('');
  const [confirm, setConfirm]   = useState('');
  const [saving, setSaving]     = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext]       = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const switchMode = (newMode) => {
    setMode(newMode);
    setCurrent('');
    setOtpCode('');
    setOtpSent(false);
  };

  const handleRequestOtp = async () => {
    setRequestingOtp(true);
    try {
      await requestChangePasswordOtp();
      setOtpSent(true);
      toast.success(`OTP sent to ${user?.email}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to send OTP');
    } finally {
      setRequestingOtp(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (next.length < 8) { toast.error('New password must be at least 8 characters'); return; }
    if (next !== confirm) { toast.error('New passwords do not match'); return; }
    setSaving(true);
    try {
      const payload = mode === 'otp'
        ? { otp_code: otpCode.trim(), new_password: next }
        : { current_password: current, new_password: next };
      await changePassword(payload);
      toast.success('Password updated successfully');
      setCurrent(''); setOtpCode(''); setOtpSent(false); setNext(''); setConfirm('');
      setMode('password');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update password');
    } finally {
      setSaving(false);
    }
  };

  const strength = (() => {
    if (!next) return 0;
    let s = 0;
    if (next.length >= 8)  s++;
    if (next.length >= 12) s++;
    if (/[A-Z]/.test(next) && /[a-z]/.test(next)) s++;
    if (/[0-9]/.test(next)) s++;
    if (/[^A-Za-z0-9]/.test(next)) s++;
    return s;
  })();

  const strengthLabel = ['', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'][strength];
  const strengthColor = ['', 'bg-red-400', 'bg-orange-400', 'bg-yellow-400', 'bg-green-400', 'bg-green-500'][strength];

  return (
    <Layout>
      <div className="max-w-lg mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-800">My Profile</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your account settings</p>
        </div>

        {/* Account info */}
        <div className="card p-5 mb-5">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xl font-bold flex-shrink-0">
              {user?.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div>
              <p className="text-base font-semibold text-gray-800">{user?.name}</p>
              <p className="text-sm text-gray-500">{user?.email}</p>
              <span className="inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 capitalize">{user?.role}</span>
            </div>
          </div>
        </div>

        {/* Change password */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-5">
            <KeyRound className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-semibold text-gray-700">Change Password</h2>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Verification: current password OR email OTP. We default to
                password because that's the path most users want; the OTP
                option is a fallback for accounts that only ever sign in via
                OTP and therefore have no password to remember. */}
            {mode === 'password' ? (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="label !mb-0">Current Password</label>
                  <button
                    type="button"
                    onClick={() => switchMode('otp')}
                    className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
                  >
                    Don't know it? Verify via email OTP
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showCurrent ? 'text' : 'password'}
                    className="input pr-10"
                    placeholder="Enter current password"
                    value={current}
                    onChange={e => setCurrent(e.target.value)}
                    required
                  />
                  <button type="button" onClick={() => setShowCurrent(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="label !mb-0">Email OTP Verification</label>
                  <button
                    type="button"
                    onClick={() => switchMode('password')}
                    className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline"
                  >
                    Use current password instead
                  </button>
                </div>
                <p className="text-xs text-gray-500 mb-2">
                  We'll send a 6-digit code to <strong>{user?.email}</strong>. Enter it below to authorise the password change.
                </p>
                {!otpSent ? (
                  <button
                    type="button"
                    onClick={handleRequestOtp}
                    disabled={requestingOtp}
                    className="btn-secondary w-full justify-center"
                  >
                    {requestingOtp
                      ? <span className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                      : <><Mail className="w-4 h-4" /> Send OTP to my email</>}
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      className="input tracking-[0.4em] text-center font-mono text-lg"
                      placeholder="123456"
                      value={otpCode}
                      onChange={e => setOtpCode(e.target.value.replace(/\D/g, ''))}
                      required
                    />
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-green-600 flex items-center gap-1">
                        <Check className="w-3 h-3" /> OTP sent · expires in 10 minutes
                      </span>
                      <button
                        type="button"
                        onClick={handleRequestOtp}
                        disabled={requestingOtp}
                        className="text-indigo-600 hover:underline disabled:opacity-50"
                      >
                        {requestingOtp ? 'Sending…' : 'Resend'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* New password */}
            <div>
              <label className="label">New Password</label>
              <div className="relative">
                <input
                  type={showNext ? 'text' : 'password'}
                  className="input pr-10"
                  placeholder="At least 8 characters"
                  value={next}
                  onChange={e => setNext(e.target.value)}
                  required
                />
                <button type="button" onClick={() => setShowNext(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showNext ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {next && (
                <div className="mt-2 space-y-1">
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map(i => (
                      <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= strength ? strengthColor : 'bg-gray-200'}`} />
                    ))}
                  </div>
                  <p className={`text-xs font-medium ${strength <= 1 ? 'text-red-500' : strength <= 2 ? 'text-orange-500' : strength <= 3 ? 'text-yellow-600' : 'text-green-600'}`}>
                    {strengthLabel}
                  </p>
                </div>
              )}
            </div>

            {/* Confirm password */}
            <div>
              <label className="label">Confirm New Password</label>
              <div className="relative">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  className={`input pr-10 ${confirm && next !== confirm ? 'border-red-300 focus:ring-red-300' : ''}`}
                  placeholder="Repeat new password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                />
                <button type="button" onClick={() => setShowConfirm(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {confirm && next !== confirm && (
                <p className="text-xs text-red-500 mt-1">Passwords do not match</p>
              )}
              {confirm && next === confirm && confirm.length > 0 && (
                <p className="text-xs text-green-600 mt-1 flex items-center gap-1">
                  <Check className="w-3 h-3" /> Passwords match
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={
                saving ||
                !next || !confirm || next !== confirm ||
                (mode === 'password' ? !current : otpCode.length !== 6)
              }
              className="btn-primary w-full justify-center"
            >
              {saving
                ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : 'Update Password'}
            </button>
          </form>
        </div>
      </div>
    </Layout>
  );
}
