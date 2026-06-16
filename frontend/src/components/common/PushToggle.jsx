import { useEffect, useState } from 'react';
import { BellRing, BellOff } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  isPushSupported, getPermission, getExistingSubscription, enablePush, disablePush,
} from '../../utils/push';

// Compact enable/disable row for OS push notifications, designed to sit inside
// the notification-bell dropdown. Renders nothing on browsers without push
// support (e.g. iOS Safari before "Add to Home Screen").
// Push is most useful on phones / the installed app. We hide the toggle on
// desktop browsers (wide viewport, not standalone) to keep the desktop bell
// clean — show it only when on a small viewport OR running as an installed PWA.
function shouldShowToggle() {
  if (typeof window === 'undefined') return false;
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const smallViewport = window.matchMedia('(max-width: 1023px)').matches;
  return standalone || smallViewport;
}

export default function PushToggle() {
  const [supported] = useState(() => isPushSupported());
  const [visible] = useState(() => shouldShowToggle());
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (supported && visible) {
      getExistingSubscription().then(sub => { if (alive) setEnabled(!!sub); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [supported, visible]);

  if (!supported || !visible) return null;

  const denied = getPermission() === 'denied';

  const toggle = async () => {
    setBusy(true);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
        toast.success('Push notifications turned off');
      } else {
        const r = await enablePush();
        if (r.ok) { setEnabled(true); toast.success('Push notifications on'); }
        else if (r.reason === 'denied') toast.error('Notifications are blocked in your browser settings');
        else if (r.reason === 'server-unconfigured') toast.error('Push isn’t available right now');
        else if (r.reason === 'unsupported') toast.error('This browser doesn’t support push');
        else if (r.reason === 'no-sw') toast('Open the installed app to enable notifications', { icon: 'ℹ️' });
        else toast.error('Could not enable notifications');
      }
    } finally { setBusy(false); }
  };

  return (
    <button
      onClick={toggle}
      disabled={busy || denied}
      title={denied ? 'Notifications are blocked in browser settings' : undefined}
      className="w-full flex items-center justify-between gap-2 px-4 py-2 text-xs border-b border-gray-100 hover:bg-gray-50 disabled:opacity-60 transition-colors"
    >
      <span className="flex items-center gap-1.5 text-gray-600">
        {enabled ? <BellRing className="w-3.5 h-3.5 text-indigo-600" /> : <BellOff className="w-3.5 h-3.5 text-gray-400" />}
        {denied ? 'Notifications blocked' : enabled ? 'Push notifications on' : 'Get notified when the app is closed'}
      </span>
      {!denied && (
        <span className={`font-semibold ${enabled ? 'text-gray-400' : 'text-indigo-600'}`}>
          {busy ? '…' : enabled ? 'Turn off' : 'Enable'}
        </span>
      )}
    </button>
  );
}
