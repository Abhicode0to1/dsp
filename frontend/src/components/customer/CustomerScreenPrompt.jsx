import { Monitor, ShieldCheck, X } from 'lucide-react';

// Customer-facing screen-share UI, driven by the shared screen-share state
// (from ScreenShareProvider) — mounted ONCE app-wide so it works whether the
// customer is in a live chat or on a call, on any page. On phones the request
// is auto-declined inside the hook, so `incoming` never becomes true there and
// the customer is never shown a popup for something their device can't do.
export default function CustomerScreenPrompt({ screen }) {
  const { state, agentName, isSharing, acceptShare, declineShare, stop } = screen;
  const incoming = state === 'incoming';

  return (
    <>
      {/* Consent popup (desktop customers only) */}
      {incoming && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 text-center">
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
