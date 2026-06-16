import { useLocation, useNavigate } from 'react-router-dom';
import { Phone, PhoneOff, Mic, MicOff, Maximize2 } from 'lucide-react';
import clsx from 'clsx';
import { useCustomerCall } from '../../contexts/CustomerCallContext';
import { useDraggable } from '../../hooks/useDraggable';

// Floating mini-card that appears whenever a customer is in a live call AND
// they've navigated AWAY from the full call page. Lets them keep talking
// while browsing tickets / knowledge base / etc.
//
// On /customer/call we hide ourselves — the full-page UI takes over and we
// don't want two competing controls for the same call.
//
// Draggable; position persists across reloads.
export default function CustomerCallMiniOverlay() {
  const { callState, agentName, elapsed, isMuted, endCall, toggleMute } = useCustomerCall();
  const location = useLocation();
  const navigate = useNavigate();
  const drag = useDraggable({ storageKey: 'customer_mini_call_pos' });

  // Show only for in-flight states, and not on the pages that already show
  // their own call controls: the dedicated call page, and the live-chat page
  // (its in-chat call banner is the control there).
  const showStates = ['ringing', 'active'];
  if (!showStates.includes(callState)) return null;
  if (location.pathname === '/customer/call') return null;
  if (location.pathname === '/customer/chat') return null;

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div
      ref={drag.ref}
      {...drag.handleProps}
      className="fixed bottom-6 right-6 z-[60] bg-white rounded-2xl shadow-2xl border-2 border-indigo-400 w-72 overflow-hidden"
      title="Drag to move"
    >
      <div className="p-4">
        <div className="flex items-center gap-3 mb-3">
          <div className={clsx('w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0',
            callState === 'active' ? 'bg-green-100' : 'bg-amber-100 animate-pulse')}>
            <Phone className={clsx('w-5 h-5', callState === 'active' ? 'text-green-600' : 'text-amber-600')} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">
              {callState === 'ringing' ? 'Ringing…' : 'On call with'}
            </p>
            <p className="text-sm font-bold text-gray-800 truncate">{agentName || 'Agent'}</p>
          </div>
          {callState === 'active' && (
            <div className="text-xs font-mono text-gray-600 bg-gray-50 px-2 py-1 rounded flex-shrink-0">
              {mm}:{ss}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          {callState === 'active' && (
            <button
              onClick={toggleMute}
              className={clsx('flex-1 flex items-center justify-center gap-1 py-2 rounded-lg border text-sm transition-colors',
                isMuted ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100')}
            >
              {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
          )}
          <button
            onClick={() => navigate('/customer/call')}
            title="Open the full call screen"
            className="flex items-center justify-center gap-1 py-2 px-3 rounded-lg border bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100 text-sm transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={endCall}
            className="flex-1 flex items-center justify-center gap-1 py-2 rounded-lg font-medium text-sm bg-red-600 text-white hover:bg-red-700"
          >
            <PhoneOff className="w-3.5 h-3.5" />
            End
          </button>
        </div>
      </div>
    </div>
  );
}
