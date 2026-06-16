import { useLocation } from 'react-router-dom';
import { Phone, PhoneOff, Mic, MicOff, Loader } from 'lucide-react';
import clsx from 'clsx';
import { useCustomerCall } from '../../contexts/CustomerCallContext';

// Full call popup for the live-chat page — reuses the shared call engine (the
// same one the Call tab uses) and presents its controls as a centered overlay
// instead of a small inline banner. Only shown on /customer/chat for the live
// states; on other pages the floating mini-call takes over, and the Call page
// shows its own full-page UI.
export default function CustomerCallModal() {
  const { callState, agentName, elapsed, isMuted, endCall, toggleMute, error } = useCustomerCall();
  const location = useLocation();

  if (location.pathname !== '/customer/chat') return null;
  const liveStates = ['requesting', 'ringing', 'active'];
  if (!liveStates.includes(callState)) return null;

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const statusLabel =
    callState === 'active' ? 'On call'
    : callState === 'ringing' ? 'Calling…'
    : 'Connecting…';

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center">
        <div className={clsx(
          'w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4',
          callState === 'active' ? 'bg-green-100' : 'bg-amber-100 animate-pulse'
        )}>
          <Phone className={clsx('w-9 h-9', callState === 'active' ? 'text-green-600' : 'text-amber-600')} />
        </div>

        <p className="text-xs uppercase tracking-wide text-gray-400 font-semibold">{statusLabel}</p>
        <h3 className="text-lg font-bold text-gray-800 mt-0.5">{agentName || 'Support Agent'}</h3>
        {callState === 'active' && (
          <p className="text-2xl font-mono text-gray-700 mt-2">{mm}:{ss}</p>
        )}
        {callState === 'requesting' && (
          <p className="text-sm text-gray-500 mt-2 inline-flex items-center gap-1.5">
            <Loader className="w-4 h-4 animate-spin" /> Requesting microphone…
          </p>
        )}
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}

        <div className="flex items-center justify-center gap-4 mt-6">
          {callState === 'active' && (
            <button
              onClick={toggleMute}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
              className={clsx(
                'w-14 h-14 rounded-full flex items-center justify-center border-2 transition-colors',
                isMuted ? 'bg-amber-50 border-amber-300 text-amber-700' : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'
              )}
            >
              {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </button>
          )}
          <button
            onClick={endCall}
            aria-label={callState === 'active' ? 'End call' : 'Cancel call'}
            className="w-14 h-14 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center shadow-lg"
          >
            <PhoneOff className="w-6 h-6" />
          </button>
        </div>
      </div>
    </div>
  );
}
