import { Monitor, ShieldCheck, X, MonitorSmartphone } from 'lucide-react';
import { useScreenShare } from '../../hooks/useScreenShare';

// Customer side of screen-share. Mounted on the customer's live-chat page so it
// can receive an agent's request. Shows a consent popup, then (while sharing) a
// persistent banner with a Stop button. The customer is always in control.
export default function CustomerScreenShare() {
  const { state, agentName, isSharing, supportsScreenShare, acceptShare, declineShare, stop } = useScreenShare();

  const incoming = state === 'incoming';

  return (
    <>
      {/* Incoming request popup */}
      {incoming && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 text-center">
            {supportsScreenShare ? (
              <>
                <div className="w-14 h-14 mx-auto rounded-full bg-purple-100 flex items-center justify-center mb-3">
                  <Monitor className="w-7 h-7 text-purple-600" />
                </div>
                <h2 className="text-lg font-bold text-gray-800">Screen view request</h2>
                <p className="text-sm text-gray-600 mt-1">
                  <span className="font-semibold">{agentName}</span> would like to view your screen to help solve your issue.
                </p>
                <div className="mt-3 flex items-start gap-2 text-left bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-600">
                  <ShieldCheck className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                  <span>You choose exactly what to share (a tab, a window, or your whole screen). It's view-only — the agent can't control your computer — and you can stop any time.</span>
                </div>
                <div className="mt-4 flex gap-2">
                  <button onClick={() => declineShare()} className="flex-1 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50">
                    Decline
                  </button>
                  <button onClick={acceptShare} className="flex-1 py-2 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700">
                    Share my screen
                  </button>
                </div>
              </>
            ) : (
              /* Mobile / unsupported browser — screen capture isn't possible here. */
              <>
                <div className="w-14 h-14 mx-auto rounded-full bg-amber-100 flex items-center justify-center mb-3">
                  <MonitorSmartphone className="w-7 h-7 text-amber-600" />
                </div>
                <h2 className="text-lg font-bold text-gray-800">Screen sharing needs a computer</h2>
                <p className="text-sm text-gray-600 mt-1">
                  <span className="font-semibold">{agentName}</span> asked to view your screen, but phones can't share their screen from a browser.
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Please open this chat on a <strong>computer</strong> to share your screen — or send the agent a <strong>screenshot</strong> here in the chat instead.
                </p>
                <button onClick={() => declineShare('unsupported')} className="mt-4 w-full py-2 rounded-lg bg-gray-800 text-white font-medium hover:bg-gray-900">
                  Got it
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Persistent "you are sharing" banner */}
      {isSharing && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[55] flex items-center gap-3 bg-gray-900 text-white rounded-full shadow-lg pl-4 pr-2 py-2">
          <span className="flex items-center gap-2 text-sm">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            Sharing your screen{agentName ? ` with ${agentName}` : ''}
          </span>
          <button onClick={stop} className="flex items-center gap-1 text-xs font-semibold bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded-full">
            <X className="w-3.5 h-3.5" /> Stop
          </button>
        </div>
      )}
    </>
  );
}
