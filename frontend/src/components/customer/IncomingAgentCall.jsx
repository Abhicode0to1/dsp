import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../../contexts/SocketContext';
import { Phone, PhoneOff, Mic, MicOff, Headphones, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { getIceConfig } from '../../config/webrtcConfig';
import { useDraggable } from '../../hooks/useDraggable';
import useAudioLevel from '../../hooks/useAudioLevel';
import AudioWaveBars from '../common/AudioWaveBars';

// Customer-side incoming-call modal for agent-initiated calls.
// Renders bottom-right on /customer/* pages. Handles WebRTC as the callee.
export default function IncomingAgentCall() {
  const { socket } = useSocket();
  const [state, setState] = useState('idle'); // idle | invited | connecting | active
  const [invite, setInvite] = useState(null); // { callId, agentName, ticketId, ticketSubject }
  const [elapsed, setElapsed] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  // Streams exposed for the mic-activity wave bars (Bug #29).
  const [localStream, setLocalStream]   = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const micLevel    = useAudioLevel(isMuted ? null : localStream);
  const remoteLevel = useAudioLevel(remoteStream);
  const drag = useDraggable({ storageKey: 'incoming_agent_call_pos' });

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const callIdRef = useRef(null);
  const remoteAudio = useRef(typeof Audio !== 'undefined' ? new Audio() : null);
  const ringtoneCtxRef = useRef(null);
  const ringtoneTimerRef = useRef(null);
  const timerRef = useRef(null);
  const pendingCandidates = useRef([]);
  // While we're tearing down the old pc and standing up a new one for a warm
  // transfer renegotiation, pc.onconnectionstatechange will fire 'closed' /
  // 'disconnected' on the OLD peer connection — which would normally trigger
  // our cleanup + "Call ended" toast and put us back to idle. This ref lets
  // the connection-state callback skip that branch during the transfer
  // window. Set/cleared by onTransferInitiated below.
  const isTransferringRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (ringtoneTimerRef.current) { clearInterval(ringtoneTimerRef.current); ringtoneTimerRef.current = null; }
    if (ringtoneCtxRef.current) { try { ringtoneCtxRef.current.close(); } catch {} ringtoneCtxRef.current = null; }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) { try { pcRef.current.close(); } catch {} pcRef.current = null; }
    if (remoteAudio.current) { remoteAudio.current.pause(); remoteAudio.current.srcObject = null; }
    pendingCandidates.current = [];
    callIdRef.current = null;
    setElapsed(0);
    setIsMuted(false);
    setLocalStream(null);
    setRemoteStream(null);
  }, []);

  const playRingtone = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      ringtoneCtxRef.current = ctx;
      const ring = () => {
        const now = ctx.currentTime;
        [480, 620].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          osc.connect(gain);
          gain.connect(ctx.destination);
          gain.gain.setValueAtTime(0, now + i * 0.4);
          gain.gain.linearRampToValueAtTime(0.12, now + i * 0.4 + 0.05);
          gain.gain.linearRampToValueAtTime(0, now + i * 0.4 + 0.35);
          osc.start(now + i * 0.4);
          osc.stop(now + i * 0.4 + 0.4);
        });
      };
      ring();
      ringtoneTimerRef.current = setInterval(ring, 3000);
    } catch {}
  }, []);

  // Listen for agent_call_invitation
  useEffect(() => {
    if (!socket) return;

    const onInvitation = (data) => {
      if (state !== 'idle') {
        // Already busy with another call — auto-decline
        socket.emit('agent_call_response', { callId: data.callId, accept: false });
        return;
      }
      setInvite(data);
      setState('invited');
      playRingtone();
    };

    const onCancelled = ({ callId }) => {
      if (callIdRef.current === callId || invite?.callId === callId) {
        toast('Agent cancelled the call');
        cleanup();
        setInvite(null);
        setState('idle');
      }
    };

    const onOffer = async ({ callId, offerSdp }) => {
      if (callIdRef.current !== callId) return;
      try {
        const pc = pcRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
        // Drain any ICE candidates that arrived before remote description
        for (const c of pendingCandidates.current) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
        }
        pendingCandidates.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('agent_call_answer', { callId, answerSdp: pc.localDescription });
      } catch (err) {
        console.error('agent call offer handling failed:', err);
        toast.error('Call setup failed');
        socket.emit('call_end', { callId });
        cleanup();
        setState('idle');
        setInvite(null);
      }
    };

    const onIceCandidate = async ({ callId, candidate }) => {
      if (callIdRef.current !== callId) return;
      const pc = pcRef.current;
      if (pc?.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      } else {
        pendingCandidates.current.push(candidate);
      }
    };

    const onCallEnded = ({ callId }) => {
      if (callIdRef.current === callId) {
        toast('Call ended');
        cleanup();
        setInvite(null);
        setState('idle');
      }
    };

    // Receive the new agent's WebRTC answer after we (the customer) sent a
    // re-offer for a warm transfer. Without this listener the answer was
    // emitted by the backend to the customer's room but no IncomingAgentCall
    // handler picked it up — useWebRTCCall's handler does listen for
    // `call_accepted` but bails because its own pcRef is null (the call
    // lives in THIS component, not there). The result was the customer's pc
    // stayed in 'have-local-offer' forever, the 15 s transfer-safety timeout
    // fired, and the call "failed" even though both agents thought it was
    // active. Setting the remote description here completes the handshake.
    const onCallAccepted = async ({ callId, answerSdp, agentName: name }) => {
      if (callIdRef.current !== callId) return;
      if (!pcRef.current || !answerSdp) return;
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answerSdp));
        // Drain any ICE candidates from the new agent that arrived before
        // setRemoteDescription. Without this, the connection often fails to
        // negotiate over restrictive networks (TURN-only paths) because the
        // candidates were silently dropped during the buffered window.
        for (const c of pendingCandidates.current) {
          try { await pcRef.current.addIceCandidate(new RTCIceCandidate(c)); } catch {}
        }
        pendingCandidates.current = [];
        // Update the displayed agent name (in case onTransferInitiated didn't
        // get a name in its payload).
        if (name) setInvite(i => i ? { ...i, agentName: name } : i);
      } catch (err) {
        console.error('IncomingAgentCall onCallAccepted (transfer) failed:', err);
      }
    };

    // Warm-transfer renegotiation for OUTBOUND (agent-initiated) calls.
    // When the agent who originally called us hands off to a new agent, the
    // backend tells us here. We need to:
    //   1. Update the displayed agent name immediately.
    //   2. Tear down the old peer connection (it was talking to old agent).
    //   3. Stand up a fresh peer connection with the SAME mic stream.
    //   4. Create a new offer (we become the offerer for the renegotiation
    //      regardless of original direction — WebRTC allows either side).
    //   5. Send via customer_call_reoffer. Backend forwards to the new
    //      agent as `incoming_call` (which their AgentCallOverlay handles).
    // Without this, the customer's call simply died when an outbound call
    // got transferred — pc went 'disconnected', UI showed "Call ended".
    const onTransferInitiated = async ({ callId, newAgentName }) => {
      if (callIdRef.current !== callId) return;
      try {
        isTransferringRef.current = true;
        setInvite(i => i ? { ...i, agentName: newAgentName || i.agentName } : i);
        // Brief transitional state while we re-handshake.
        setState('connecting');

        // Tear down old pc. Keep local stream alive so we don't have to
        // re-prompt the user for mic.
        if (pcRef.current) {
          try { pcRef.current.close(); } catch {}
          pcRef.current = null;
        }
        pendingCandidates.current = [];
        if (remoteAudio.current) {
          try { remoteAudio.current.pause(); } catch {}
          remoteAudio.current.srcObject = null;
        }
        // Don't kill the elapsed timer — it's still the same call, just a
        // new leg. Keep counting.

        if (!localStreamRef.current) {
          localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        setLocalStream(localStreamRef.current);

        const pc = new RTCPeerConnection(await getIceConfig());
        pcRef.current = pc;
        localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));

        pc.ontrack = (e) => {
          if (remoteAudio.current && e.streams[0]) {
            remoteAudio.current.srcObject = e.streams[0];
            remoteAudio.current.play().catch(() => {});
          }
          if (e.streams[0]) setRemoteStream(e.streams[0]);
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) socket.emit('call_ice_candidate', { callId, candidate: e.candidate });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            setState('active');
            if (!timerRef.current) {
              timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
            }
            isTransferringRef.current = false;
          } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            if (isTransferringRef.current) return;
            toast('Call ended');
            cleanup();
            setInvite(null);
            setState('idle');
          }
        };

        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        socket.emit('customer_call_reoffer', { callId, offerSdp: pc.localDescription });

        // If new agent doesn't complete the renegotiation within 15 s, give
        // up and end the call cleanly. Without this safeguard a stuck
        // transfer would leave the customer in 'connecting' indefinitely.
        setTimeout(() => {
          if (!isTransferringRef.current) return; // resolved
          isTransferringRef.current = false;
          toast.error('Transfer to new agent failed — call ended');
          cleanup();
          setInvite(null);
          setState('idle');
        }, 15000);
      } catch (err) {
        console.error('call_transfer_initiated (customer-side) failed:', err);
        isTransferringRef.current = false;
        toast.error('Transfer failed — call ended');
        cleanup();
        setInvite(null);
        setState('idle');
      }
    };

    socket.on('agent_call_invitation', onInvitation);
    socket.on('agent_call_cancelled', onCancelled);
    socket.on('agent_call_offer', onOffer);
    socket.on('call_ice_candidate', onIceCandidate);
    socket.on('call_ended', onCallEnded);
    socket.on('call_transfer_initiated', onTransferInitiated);
    socket.on('call_accepted', onCallAccepted);

    return () => {
      socket.off('agent_call_invitation', onInvitation);
      socket.off('agent_call_cancelled', onCancelled);
      socket.off('agent_call_offer', onOffer);
      socket.off('call_ice_candidate', onIceCandidate);
      socket.off('call_ended', onCallEnded);
      socket.off('call_transfer_initiated', onTransferInitiated);
      socket.off('call_accepted', onCallAccepted);
    };
  }, [socket, state, invite, cleanup, playRingtone]);

  const accept = async () => {
    if (!invite || !socket) return;

    // Stop ringtone
    if (ringtoneTimerRef.current) { clearInterval(ringtoneTimerRef.current); ringtoneTimerRef.current = null; }
    if (ringtoneCtxRef.current) { try { ringtoneCtxRef.current.close(); } catch {} ringtoneCtxRef.current = null; }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = new RTCPeerConnection(await getIceConfig());
      pcRef.current = pc;
      callIdRef.current = invite.callId;

      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.ontrack = (e) => {
        if (e.streams[0]) setRemoteStream(e.streams[0]);
        if (remoteAudio.current && e.streams[0]) {
          remoteAudio.current.srcObject = e.streams[0];
          remoteAudio.current.play().catch(() => {});
        }
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('call_ice_candidate', { callId: invite.callId, candidate: e.candidate });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setState('active');
          if (!timerRef.current) {
            timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
          }
        } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
          // Skip the "call ended" reaction while we're intentionally tearing
          // down the OLD pc to swap to a new one during a warm-transfer
          // renegotiation. Without this guard the customer's UI flips to
          // idle + shows a "Call ended" toast the moment we close the old
          // pc — even though the call is actually in the middle of moving
          // to the new agent.
          if (isTransferringRef.current) return;
          toast('Call ended');
          cleanup();
          setInvite(null);
          setState('idle');
        }
      };

      setState('connecting');
      // Tell server we accept — agent will follow with WebRTC offer
      socket.emit('agent_call_response', { callId: invite.callId, accept: true });
    } catch (err) {
      toast.error('Microphone permission required');
      socket.emit('agent_call_response', { callId: invite.callId, accept: false });
      cleanup();
      setInvite(null);
      setState('idle');
    }
  };

  const decline = () => {
    if (!invite || !socket) return;
    socket.emit('agent_call_response', { callId: invite.callId, accept: false });
    cleanup();
    setInvite(null);
    setState('idle');
  };

  const hangup = () => {
    if (callIdRef.current && socket) {
      socket.emit('call_end', { callId: callIdRef.current });
    }
    cleanup();
    setInvite(null);
    setState('idle');
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const track = localStreamRef.current.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setIsMuted(!track.enabled);
    }
  };

  if (state === 'idle' || !invite) return null;

  return (
    <div
      ref={drag.ref}
      {...drag.handleProps}
      className="fixed bottom-6 right-6 z-[60] bg-white rounded-2xl shadow-2xl border-2 border-blue-400 w-80 overflow-hidden"
      title="Drag to move"
    >
      {state === 'invited' && (
        <div className="p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <Headphones className="w-6 h-6 text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-400 font-medium">Incoming support call</p>
              <p className="text-base font-bold text-gray-800 truncate">{invite.agentName}</p>
              <p className="text-xs text-blue-600 animate-pulse">Calling you now…</p>
            </div>
          </div>
          {invite.ticketSubject && (
            <div className="mb-3 px-3 py-2 bg-blue-50 rounded-lg border border-blue-100 text-xs text-blue-700">
              <span className="font-semibold">Re: #{invite.ticketId}</span> · {invite.ticketSubject}
            </div>
          )}
          <p className="text-[10px] text-gray-400 mb-3 flex items-start gap-1">
            <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
            <span>This call may be recorded for quality and training purposes. By accepting, you consent to recording.</span>
          </p>
          <div className="flex gap-2">
            <button
              onClick={decline}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 font-semibold text-sm transition-colors"
            >
              <PhoneOff className="w-4 h-4" /> Decline
            </button>
            <button
              onClick={accept}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-green-600 text-white hover:bg-green-700 font-semibold text-sm transition-colors"
            >
              <Phone className="w-4 h-4" /> Accept
            </button>
          </div>
        </div>
      )}

      {state === 'connecting' && (
        <div className="p-5 text-center">
          <div className="w-12 h-12 mx-auto rounded-full bg-amber-100 flex items-center justify-center mb-3">
            <Phone className="w-6 h-6 text-amber-600 animate-pulse" />
          </div>
          <p className="text-sm font-semibold text-gray-800">Connecting…</p>
          <p className="text-xs text-gray-400 mt-1">{invite.agentName}</p>
        </div>
      )}

      {state === 'active' && (
        <div className="p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
              <Phone className="w-5 h-5 text-green-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-400">On call with</p>
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-gray-800 truncate">{invite.agentName}</p>
                {/* Agent's voice level — visible confirmation the line is two-way live. */}
                <AudioWaveBars level={remoteLevel} bars={4} color="bg-green-500" maxHeight={12} minHeight={2} barWidth={2} />
              </div>
            </div>
            <div className="text-xs font-mono text-gray-600 bg-gray-50 px-2 py-1 rounded">
              {Math.floor(elapsed / 60).toString().padStart(2, '0')}:{(elapsed % 60).toString().padStart(2, '0')}
            </div>
          </div>
          {/* Customer's own mic activity strip above the controls. */}
          <div className="flex items-center justify-center gap-2 mb-3">
            <AudioWaveBars level={isMuted ? 0 : micLevel} bars={6} color="bg-blue-500" maxHeight={14} minHeight={3} barWidth={2} />
            <span className="text-[10px] text-gray-400">Your mic</span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={toggleMute}
              className={clsx('flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border font-medium text-sm transition-colors', isMuted ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100')}
            >
              {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button
              onClick={hangup}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-600 text-white hover:bg-red-700 font-semibold text-sm transition-colors"
            >
              <PhoneOff className="w-4 h-4" /> End
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
