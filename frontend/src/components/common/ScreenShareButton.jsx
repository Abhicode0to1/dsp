import clsx from 'clsx';
import { Monitor, Loader } from 'lucide-react';
import { useScreenShareCtx } from '../../contexts/ScreenShareContext';
import { usePublicSettings } from '../../contexts/PublicSettingsContext';

// "Request screen view" button for the agent. Placed in the live-chat toolbar
// and the voice-call overlay. Pass either chatId or callId (the context sends
// the matching request). Shown only when:
//   - the admin has enabled screen sharing (public setting), AND
//   - the agent is on a DESKTOP (a phone can't usefully drive/view this).
// The single shared engine (ScreenShareProvider) renders the actual viewer.
function isDesktop() {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(min-width: 1024px) and (pointer: fine)').matches;
}

export default function ScreenShareButton({ chatId, callId, disabled, className, showLabel }) {
  const { settings } = usePublicSettings();
  const ctx = useScreenShareCtx();

  if (!settings?.screen_share_enabled) return null;
  if (!ctx) return null;
  if (!isDesktop()) return null;

  const { state, remoteStream, requestScreen, stop } = ctx;
  const requesting = state === 'requesting' || state === 'connecting';
  const active     = state === 'active' && !!remoteStream;
  const busy       = requesting || active;
  const target     = callId ? { callId } : { chatId };

  return (
    <button
      onClick={() => (busy ? stop() : requestScreen(target))}
      disabled={disabled}
      title={busy ? 'Stop screen view' : 'Request to view customer screen'}
      className={clsx(
        className || 'p-1.5 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        !className && (busy
          ? 'bg-purple-100 text-purple-700 border-purple-300'
          : 'bg-purple-50 text-purple-700 hover:bg-purple-100 border-purple-200')
      )}
    >
      {requesting ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Monitor className="w-3.5 h-3.5" />}
      {showLabel && <span className="ml-1.5 text-xs font-medium">{busy ? 'Stop screen' : 'Screen'}</span>}
    </button>
  );
}
