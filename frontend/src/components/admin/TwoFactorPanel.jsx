import { useEffect, useState } from 'react';
import { get2faStatus, setup2faInit, setup2faConfirm, disable2fa } from '../../services/api';
import { Shield, ShieldCheck, ShieldOff, Copy, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';

// Self-service 2FA enrolment + disable for the signed-in user. Rendered
// inside admin Settings → Security card, but role-agnostic — you could drop
// it on any authenticated page.
//
// Flow:
//   - Status loads on mount: enabled? globally required?
//   - "Enable 2FA" → setupInit returns secret + otpauth URI + setup_token
//   - User scans the QR (rendered via api.qrserver.com — public free QR
//     generator, no install needed) and types the 6-digit code
//   - setupConfirm with code returns one-time backup codes
//   - User saves codes, panel switches to "enabled" state
//   - "Disable 2FA" requires a current code (or backup) — blocked when
//     globally required and user is admin
export default function TwoFactorPanel() {
  const [status, setStatus]     = useState(null);
  const [loading, setLoading]   = useState(true);
  // Setup state: null = idle, { secret, uri, setup_token } once init returns
  const [setupState, setSetupState] = useState(null);
  const [setupCode, setSetupCode]   = useState('');
  const [setupBusy, setSetupBusy]   = useState(false);
  // After enrolment, show backup codes EXACTLY ONCE.
  const [backupCodes, setBackupCodes] = useState(null);
  // Disable flow
  const [disableCode, setDisableCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableBusy, setDisableBusy] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const load = () => {
    setLoading(true);
    get2faStatus()
      .then(r => setStatus(r.data))
      .catch(() => setStatus({ enabled: false, globally_required: false, must_setup: false }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const startSetup = async () => {
    setSetupBusy(true);
    try {
      const r = await setup2faInit();
      setSetupState(r.data);
      setSetupCode('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not start setup');
    } finally { setSetupBusy(false); }
  };

  const cancelSetup = () => {
    setSetupState(null);
    setSetupCode('');
  };

  const confirmSetup = async () => {
    if (!setupCode.trim()) { toast.error('Enter the 6-digit code from your authenticator'); return; }
    setSetupBusy(true);
    try {
      const r = await setup2faConfirm({ setup_token: setupState.setup_token, code: setupCode.trim() });
      setBackupCodes(r.data.backup_codes || []);
      setSetupState(null);
      setSetupCode('');
      load();
      toast.success('Two-factor enabled — save your backup codes below');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not verify code');
    } finally { setSetupBusy(false); }
  };

  const doDisable = async () => {
    if (!disableCode.trim()) { toast.error('Enter your current 2FA code to disable'); return; }
    setDisableBusy(true);
    try {
      await disable2fa({ code: disableCode.trim() });
      toast.success('Two-factor disabled');
      setDisableCode('');
      setDisableOpen(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not disable 2FA');
    } finally { setDisableBusy(false); }
  };

  const copySecret = () => {
    if (!setupState?.secret) return;
    navigator.clipboard.writeText(setupState.secret).then(() => {
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    });
  };

  if (loading) {
    return <p className="text-xs text-gray-400">Loading 2FA status…</p>;
  }

  // After enrolment — show backup codes one time
  if (backupCodes) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
        <div className="flex items-start gap-2 mb-3">
          <ShieldCheck className="w-5 h-5 text-amber-700 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-bold text-amber-800">Save these backup codes</h3>
            <p className="text-[11px] text-amber-700 mt-0.5">Each code works once. If you lose your phone, use one to sign in instead of a 6-digit code. They are shown EXACTLY ONCE — copy them somewhere safe now.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-white rounded p-3 border border-amber-100">
          {backupCodes.map(c => <div key={c}>{c}</div>)}
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(backupCodes.join('\n')).then(() => toast.success('Backup codes copied'));
          }}
          className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 font-medium inline-flex items-center gap-1.5"
        >
          <Copy className="w-3 h-3" /> Copy all codes
        </button>
        <button onClick={() => setBackupCodes(null)} className="ml-2 mt-3 text-xs px-3 py-1.5 rounded-lg bg-white hover:bg-gray-50 text-gray-700 font-medium border border-gray-200">
          I've saved them
        </button>
      </div>
    );
  }

  // Setup flow active
  if (setupState) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(setupState.otpauth_uri)}`;
    return (
      <div className="bg-indigo-50/40 border border-indigo-200 rounded-lg p-4">
        <h3 className="text-sm font-bold text-gray-800 mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4 text-indigo-600" /> Set up two-factor authentication
        </h3>
        <ol className="text-xs text-gray-700 space-y-2 mb-4 list-decimal ml-5">
          <li>Install an authenticator app on your phone (Google Authenticator, Authy, 1Password, Microsoft Authenticator — any will work).</li>
          <li>Scan the QR code below, or manually enter the secret if scanning isn't possible.</li>
          <li>Type the 6-digit code your app shows and click Verify.</li>
        </ol>
        <div className="flex flex-col sm:flex-row items-center gap-4 bg-white rounded-lg p-4 border border-gray-200">
          <img src={qrUrl} alt="2FA QR code" width={180} height={180} className="border border-gray-100 rounded" />
          <div className="flex-1 w-full text-sm">
            <p className="text-xs text-gray-500 mb-1">Can't scan? Type this secret into your app:</p>
            <div className="flex items-center gap-2 mb-3">
              <code className="font-mono text-xs bg-gray-100 px-2 py-1 rounded break-all flex-1">{setupState.secret}</code>
              <button onClick={copySecret} className="text-gray-500 hover:text-indigo-600" title="Copy secret">
                {copiedSecret ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
            <label className="label">6-digit code from app</label>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="123456"
              value={setupCode} onChange={e => setSetupCode(e.target.value)}
              className="input font-mono tracking-widest text-center"
            />
            <div className="flex gap-2 mt-3">
              <button onClick={cancelSetup} className="btn-secondary flex-1">Cancel</button>
              <button onClick={confirmSetup} disabled={setupBusy} className="btn-primary flex-1">
                {setupBusy ? '…' : 'Verify & Enable'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Enabled — show disable option
  if (status?.enabled) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-5 h-5 text-emerald-700" />
          <h3 className="text-sm font-bold text-emerald-800">Two-factor authentication is enabled</h3>
        </div>
        <p className="text-[11px] text-emerald-700 mb-3">
          Your account requires a 6-digit code at sign-in. If you lose your phone, use one of the backup codes you saved during setup.
        </p>
        {!disableOpen ? (
          <button onClick={() => setDisableOpen(true)} className="text-xs px-3 py-1.5 rounded-lg bg-white hover:bg-gray-50 text-red-700 font-medium border border-red-200 inline-flex items-center gap-1.5">
            <ShieldOff className="w-3 h-3" /> Disable 2FA
          </button>
        ) : (
          <div className="bg-white rounded p-3 border border-gray-200">
            <p className="text-xs text-gray-700 mb-2">Enter your current 6-digit code (or a backup code) to confirm:</p>
            <div className="flex gap-2">
              <input type="text" inputMode="numeric" placeholder="123456"
                value={disableCode} onChange={e => setDisableCode(e.target.value)}
                className="input font-mono text-sm flex-1" />
              <button onClick={doDisable} disabled={disableBusy} className="text-xs px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium whitespace-nowrap">
                {disableBusy ? '…' : 'Disable'}
              </button>
              <button onClick={() => { setDisableOpen(false); setDisableCode(''); }} className="text-gray-400 hover:text-gray-700">
                <X className="w-4 h-4" />
              </button>
            </div>
            {status?.globally_required && (
              <p className="text-[11px] text-amber-700 mt-2">⚠ 2FA is required globally for admins — disabling here will fail unless another admin first turns the requirement off in Settings.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  // Not enabled
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <ShieldOff className="w-5 h-5 text-gray-500" />
        <h3 className="text-sm font-bold text-gray-800">Two-factor authentication is OFF</h3>
      </div>
      <p className="text-[11px] text-gray-600 mb-3">
        Adds a second step at sign-in: after your password, you'll type a 6-digit code from an authenticator app. Recommended for admin accounts.
        {status?.must_setup && <span className="block mt-1 text-amber-700 font-medium">⚠ 2FA is required for admins on this install — you'll be blocked from signing in next time until you enrol.</span>}
      </p>
      <button onClick={startSetup} disabled={setupBusy} className="btn-primary text-sm inline-flex items-center gap-1.5">
        <Shield className="w-4 h-4" /> {setupBusy ? '…' : 'Enable 2FA'}
      </button>
    </div>
  );
}
