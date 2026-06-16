import { createContext, useContext } from 'react';
import { useWebRTCCall } from '../hooks/useWebRTCCall';

// Customer-side call state — lifted to a context so navigation between
// /customer/call (full-page UI) and other customer routes doesn't unmount the
// underlying WebRTC peer connection. Before this lift, every nav clicked the
// page off the tree and killed the call mid-conversation (bug #21).
//
// Mounted in App.jsx <PersistentOverlays> ancestry so it lives for the entire
// authenticated customer session. Consumers:
//   - Full call UI at /customer/call (pages/customer/Call.jsx)
//   - Floating mini-overlay (CustomerCallOverlay) that auto-shows whenever
//     callState !== 'idle' AND the user is not on /customer/call
const CustomerCallContext = createContext(null);

export function CustomerCallProvider({ children }) {
  const call = useWebRTCCall();
  return (
    <CustomerCallContext.Provider value={call}>
      {children}
    </CustomerCallContext.Provider>
  );
}

// Hook with a soft fallback — if a component renders OUTSIDE the provider
// (e.g. when the customer isn't logged in yet), we return a no-op shape so
// the consumer doesn't crash with "cannot destructure property" errors.
export function useCustomerCall() {
  const ctx = useContext(CustomerCallContext);
  if (ctx) return ctx;
  return {
    callState: 'idle',
    agentName: '',
    transferredFrom: '',
    elapsed: 0,
    isMuted: false,
    error: '',
    localStream: null,
    remoteStream: null,
    startCall: () => {},
    endCall: () => {},
    toggleMute: () => {},
    reset: () => {},
    primeAudio: () => {},
  };
}
