import { useEffect, useRef, useState } from 'react';
import { Monitor, X, Maximize2, Minus, Loader } from 'lucide-react';
import toast from 'react-hot-toast';
import { useScreenShare } from '../../hooks/useScreenShare';
import { usePublicSettings } from '../../contexts/PublicSettingsContext';
import { useResizableWindow } from '../../hooks/useResizableWindow';

// Agent side of screen-share, mounted in the active live-chat toolbar. Renders
// the "Request screen view" button inline and a floating viewer panel while the
// customer's screen is streaming. View-only. The panel is draggable (park it
// anywhere so it doesn't cover the message box) and minimizable.
export default function AgentScreenShare({ chatId, disabled }) {
  const { settings } = usePublicSettings();
  const enabled = settings?.screen_share_enabled === true;
  const { state, error, rejectReason, remoteStream, requestScreen, stop, dismiss } = useScreenShare();
  const videoRef = useRef(null);
  const [minimized, setMinimized] = useState(false);
  const win = useResizableWindow({ storageKey: 'agent_screen_box' });

  useEffect(() => {
    if (videoRef.current && remoteStream) videoRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  // Surface terminal outcomes as toasts, then reset back to idle.
  useEffect(() => {
    if (state === 'rejected') {
      if (rejectReason === 'unsupported') toast("Customer's device can't share its screen — screen view needs a computer", { icon: '📱', duration: 6000 });
      else toast('Customer declined the screen request', { icon: '🚫' });
      dismiss();
    }
    if (state === 'no_answer') { toast('No response to the screen request', { icon: '⌛' }); dismiss(); }
    if (state === 'error' && error) { toast.error(error); dismiss(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!enabled) return null;

  const requesting = state === 'requesting';
  const connecting = state === 'connecting';
  const active     = state === 'active' && !!remoteStream;
  const busy       = requesting || connecting || active;

  const goFullscreen = () => { try { videoRef.current?.requestFullscreen?.(); } catch {} };

  return (
    <>
      <button
        onClick={() => (busy ? stop() : requestScreen(chatId))}
        disabled={disabled}
        title={busy ? 'Stop screen view' : 'Request to view customer screen'}
        className={
          'p-1.5 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ' +
          (busy ? 'bg-purple-100 text-purple-700 border-purple-300' : 'bg-purple-50 text-purple-700 hover:bg-purple-100 border-purple-200')
        }
      >
        {requesting || connecting ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Monitor className="w-3.5 h-3.5" />}
      </button>

      {(connecting || active) && (
        <div
          ref={win.ref}
          style={minimized ? { ...win.style, height: 'auto' } : win.style}
          className="fixed bottom-4 right-4 z-50 bg-gray-900 rounded-xl shadow-2xl border border-gray-700 overflow-hidden flex flex-col"
        >
          {/* Resize grips (8 edges/corners) — hidden while minimized. */}
          {!minimized && win.resizeHandleList().map(({ key, ...props }) => <div key={key} {...props} />)}

          {/* Header = drag handle. Buttons inside still click (drag skips them). */}
          <div {...win.dragHandleProps} className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700 select-none flex-shrink-0">
            <div className="flex items-center gap-2 text-white text-sm">
              <Monitor className="w-4 h-4 text-purple-300" />
              <span className="font-medium">Customer's screen</span>
              {connecting && <span className="text-xs text-gray-400">connecting…</span>}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setMinimized(m => !m)} title={minimized ? 'Expand' : 'Minimize'} className="p-1.5 rounded-lg text-gray-300 hover:bg-gray-700">
                {minimized ? <Maximize2 className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
              </button>
              {!minimized && (
                <button onClick={goFullscreen} title="Fullscreen" className="p-1.5 rounded-lg text-gray-300 hover:bg-gray-700"><Maximize2 className="w-4 h-4" /></button>
              )}
              <button onClick={stop} title="End screen view" className="p-1.5 rounded-lg text-red-300 hover:bg-red-900/40"><X className="w-4 h-4" /></button>
            </div>
          </div>

          {/* Video body — fills the resized window; hidden when minimized. */}
          <div className={'bg-black min-h-0 items-center justify-center ' + (minimized ? 'hidden' : 'flex flex-1')}>
            {connecting && !active && (
              <div className="flex flex-col items-center gap-2 text-gray-400 text-sm">
                <Loader className="w-6 h-6 animate-spin" /> Waiting for the customer's screen…
              </div>
            )}
            <video ref={videoRef} autoPlay playsInline muted className={'w-full h-full object-contain ' + (active ? '' : 'hidden')} />
          </div>
        </div>
      )}
    </>
  );
}
