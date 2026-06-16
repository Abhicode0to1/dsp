import { useState, useRef, useEffect, useCallback } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { ICE_CONFIG, getIceConfig } from '../config/webrtcConfig';

export function useWebRTCCall() {
  const { socket } = useSocket();
  const [callState, setCallState] = useState('idle'); // idle|requesting|ringing|active|ended|rejected|no_answer|no_agents|error
  const [callId, setCallId] = useState(null);
  const [agentName, setAgentName] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState('');
  // Most recent transfer source — set when an agent hands the call off to a
  // colleague, so the customer UI can render a "Transferred from <X>" notice.
  // Cleared on reset() when the call ends.
  const [transferredFrom, setTransferredFrom] = useState('');
  // When the backend ends the call it tells us whether the duration crossed
  // the billable threshold. If `counted === false`, the call_used counter did
  // NOT tick — surfacing this on the customer's Call page removes the "wait,
  // I just lost a call for nothing" frustration when an agent cut the line.
  const [endedMeta, setEndedMeta] = useState({ counted: true, duration: 0, threshold: 30 });
  // Stream handles exposed so call UIs can read mic activity off them
  // (useAudioLevel). They mirror the refs we already keep for plumbing.
  const [localStream, setLocalStream]   = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);

  // Mirror agentName into a ref so `onTransferInitiated` (defined inside the
  // socket-listener effect closure) can read the latest value without
  // re-binding the listener on every name change.
  useEffect(() => { agentNameRef.current = agentName; }, [agentName]);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const callIdRef = useRef(null);
  const agentNameRef = useRef('');
  const timerRef = useRef(null);
  const disconnectTimerRef = useRef(null); // grace timer for a 'disconnected' wobble
  const pendingCandidates = useRef([]);
  const remoteAudio = useRef(typeof Audio !== 'undefined' ? new Audio() : null);
  const ringbackCtxRef = useRef(null);
  const ringbackTimerRef = useRef(null);

  // Make the remote-audio element reliable on mobile: a real, DOM-attached,
  // playsinline, autoplay element. A detached `new Audio()` whose first play()
  // happens outside a user gesture (when the agent's stream arrives) gets
  // blocked by mobile autoplay policy — which silenced the agent's voice.
  useEffect(() => {
    const a = remoteAudio.current;
    if (!a) return;
    a.autoplay = true;
    a.setAttribute('playsinline', '');
    a.style.display = 'none';
    document.body.appendChild(a);
    return () => { try { a.pause(); a.srcObject = null; a.remove(); } catch {} };
  }, []);

  // Unlock audio playback within a user gesture (the "Call" tap). Playing the
  // (empty) element now means the later srcObject playback is allowed on mobile.
  const primeAudio = useCallback(() => {
    const a = remoteAudio.current;
    if (!a) return;
    try { const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch {}
  }, []);

  // Ringback tone for customer while waiting for agent to answer
  useEffect(() => {
    if (callState !== 'ringing') return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    ringbackCtxRef.current = ctx;
    let cancelled = false;

    function ringback() {
      if (cancelled) return;
      if (ctx.state === 'suspended') { ctx.resume().then(ringback); return; }

      // Standard ringback: 440 Hz for 2 s, then 4 s silence
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.9);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440;
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 1.9);

      ringbackTimerRef.current = setTimeout(ringback, 4000);
    }

    ringback();

    return () => {
      cancelled = true;
      clearTimeout(ringbackTimerRef.current);
      ctx.close().catch(() => {});
      ringbackCtxRef.current = null;
    };
  }, [callState]);

  const cleanup = useCallback(() => {
    clearInterval(timerRef.current);
    clearTimeout(disconnectTimerRef.current);
    disconnectTimerRef.current = null;
    if (pcRef.current) { pcRef.current.close(); pcRef.current = null; }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (remoteAudio.current) remoteAudio.current.srcObject = null;
    pendingCandidates.current = [];
    callIdRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
  }, []);

  useEffect(() => {
    if (!socket) return;

    const onAccepted = async ({ answerSdp, agentName: name }) => {
      if (!pcRef.current) return;
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(answerSdp));
        for (const c of pendingCandidates.current) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(c));
        }
        pendingCandidates.current = [];
        setAgentName(name);
        setCallState('active');
        timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
      } catch (err) {
        console.error('call_accepted error:', err);
        // CRITICAL: tell the backend the call failed on our end so the agent's
        // overlay can tear down. Without this, the agent's UI thinks the call
        // is active (their setRemoteDescription succeeded) and shows a running
        // timer indefinitely while the customer sees "Call Failed".
        if (callIdRef.current && socket?.connected) {
          socket.emit('call_end', { callId: callIdRef.current });
        }
        cleanup();
        setCallState('error');
        setError('Failed to establish call connection.');
      }
    };

    const onRejected = ({ reason }) => {
      cleanup();
      setCallState(reason === 'timeout' ? 'no_answer' : 'rejected');
    };

    const onNoAgents = (payload) => {
      cleanup();
      // Backend now emits a reason: 'outside_work_hours' | 'all_busy' | 'no_agents'.
      // Pre-existing callers that didn't pass a reason still work (defaults to 'no_agents').
      setError(payload?.reason || 'no_agents');
      setCallState('no_agents');
    };

    const onIceCandidate = async ({ candidate }) => {
      if (!candidate) return;
      if (pcRef.current && pcRef.current.remoteDescription) {
        try { await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      } else {
        pendingCandidates.current.push(candidate);
      }
    };

    // Only react to call_ended events that match OUR call. Without the
    // callId check, an agent-initiated call (which the customer handles in
    // IncomingAgentCall, not this hook) ending would flip THIS hook's
    // callState to 'ended' too — making the /customer/call page show a
    // bogus "Call Ended · Duration: 00:00" even though the customer never
    // used this code path. The customer-initiated call's `callIdRef` is
    // populated by startCall; for agent-initiated calls it stays null and
    // the payload's callId obviously won't match it.
    const onEnded = ({ callId, counted, duration, threshold } = {}) => {
      if (callId != null && callIdRef.current != null && Number(callId) !== Number(callIdRef.current)) return;
      if (callIdRef.current == null) return; // no call here — ignore stray signals
      // Stash the billable-threshold metadata so the page can show the
      // "this call was too short to count" reassurance when applicable.
      setEndedMeta({
        counted: counted !== false,
        duration: Number(duration || 0),
        threshold: Number(threshold || 30),
      });
      cleanup();
      setCallState('ended');
    };

    const onCallError = ({ message }) => {
      cleanup();
      setCallState('error');
      setError(message || 'Call error');
    };

    // Warm transfer renegotiation. The previous agent has been swapped out and
    // we now need to re-handshake with the new agent. The local microphone
    // stream is intact — we keep that and just rebuild the peer connection
    // around it. Sequence:
    //   1. Update displayed agent name (instant feedback for the customer).
    //   2. Tear down the old RTCPeerConnection (which was talking to old agent).
    //      Local stream tracks are KEPT — closing pc detaches them but doesn't
    //      stop them. We re-add them to the new pc below.
    //   3. Create a fresh RTCPeerConnection with the same ICE config.
    //   4. Attach the existing audio tracks.
    //   5. Set up ontrack (remote audio) + onicecandidate (forwarding) the
    //      same way startCall does.
    //   6. createOffer / setLocalDescription / emit customer_call_reoffer.
    //      Backend forwards to the new agent as incoming_call (with the fresh
    //      SDP this time, unlike the broken null-SDP flow we used to do).
    const onTransferInitiated = async ({ callId, newAgentName }) => {
      if (callIdRef.current !== callId) return;
      try {
        // Capture the previous agent's name BEFORE we overwrite it — that's
        // what the customer-side banner shows ("Transferred from <previous>").
        setTransferredFrom(prevName => agentNameRef.current || prevName);
        setAgentName(newAgentName || 'New agent');
        // Tear down old pc; keep local stream alive.
        if (pcRef.current) {
          try { pcRef.current.close(); } catch {}
          pcRef.current = null;
        }
        // Stop the active 1s elapsed-counter interval. onAccepted starts a
        // fresh one when the new connection is up — if we don't clear here,
        // BOTH intervals run in parallel for the rest of the call, the
        // timer ticks 2/sec, AND cleanup() can only clear timerRef.current
        // (the newest) so the older one keeps incrementing even after the
        // call ends. That's the "duration still running after Call Ended"
        // symptom in the customer panel screenshot.
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        pendingCandidates.current = [];
        if (remoteAudio.current) remoteAudio.current.srcObject = null;
        // While we renegotiate, briefly show a transitional state so the UI
        // can render "Reconnecting…" if desired. We reuse 'ringing' because
        // the audio path is genuinely down during this window.
        setCallState('ringing');

        if (!localStreamRef.current) {
          // Mic stream went away somehow (shouldn't happen mid-call, but
          // defensively re-prompt). If even this fails the catch block
          // surfaces an error toast.
          localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        }
        setLocalStream(localStreamRef.current);

        const pc = new RTCPeerConnection(await getIceConfig());
        pcRef.current = pc;
        localStreamRef.current.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));

        pc.ontrack = ({ streams: [remote] }) => {
          if (remoteAudio.current) {
            remoteAudio.current.srcObject = remote;
            remoteAudio.current.play().catch(() => {});
          }
          setRemoteStream(remote);
        };
        pc.onicecandidate = ({ candidate }) => {
          if (candidate && callIdRef.current) {
            socket?.emit('call_ice_candidate', { callId: callIdRef.current, candidate });
          }
        };

        const offer = await pc.createOffer({ offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        socket.emit('customer_call_reoffer', { callId, offerSdp: pc.localDescription });
      } catch (err) {
        console.error('call_transfer_initiated error:', err);
        cleanup();
        setCallState('error');
        setError('Transfer failed mid-handover. Please call again.');
      }
    };

    socket.on('call_accepted', onAccepted);
    socket.on('call_rejected', onRejected);
    socket.on('call_no_agents', onNoAgents);
    socket.on('call_ice_candidate', onIceCandidate);
    socket.on('call_ended', onEnded);
    socket.on('call_error', onCallError);
    socket.on('call_transfer_initiated', onTransferInitiated);

    return () => {
      socket.off('call_accepted', onAccepted);
      socket.off('call_rejected', onRejected);
      socket.off('call_no_agents', onNoAgents);
      socket.off('call_ice_candidate', onIceCandidate);
      socket.off('call_ended', onEnded);
      socket.off('call_error', onCallError);
      socket.off('call_transfer_initiated', onTransferInitiated);
    };
  }, [socket, cleanup]);

  const startCall = useCallback(async (id, chatId) => {
    if (!socket || !socket.connected) {
      setCallState('error');
      setError('Not connected to server. Please refresh and try again.');
      return;
    }

    setError('');
    setCallId(id);
    callIdRef.current = id;
    setCallState('requesting');
    setElapsed(0);
    setIsMuted(false);
    pendingCandidates.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = new RTCPeerConnection(await getIceConfig());
      pcRef.current = pc;

      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.ontrack = ({ streams: [remote] }) => {
        if (remoteAudio.current) {
          remoteAudio.current.srcObject = remote;
          remoteAudio.current.play().catch(() => {});
        }
        setRemoteStream(remote);
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && callIdRef.current) {
          socket?.emit('call_ice_candidate', { callId: callIdRef.current, candidate });
        }
      };

      // Watchdog: if the peer connection dies, end the call so neither side is
      // left showing a frozen "On call". 'failed' is terminal → end now.
      // 'disconnected' is a wobble that MIGHT self-heal (brief WiFi blip), so
      // we wait a grace period; if it hasn't recovered to 'connected' by then,
      // we treat it as a real drop and end — this is what stops the OTHER party
      // (e.g. the agent) from being stuck "connected" after a one-sided drop.
      const endDueToDrop = () => {
        clearTimeout(disconnectTimerRef.current);
        console.warn('[useWebRTCCall] peer connection lost — ending call');
        if (callIdRef.current && socket?.connected) {
          socket.emit('call_end', { callId: callIdRef.current });
        }
        cleanup();
        setCallState('error');
        setError('Call dropped — connection lost. Please call again.');
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        } else if (st === 'failed') {
          endDueToDrop();
        } else if (st === 'disconnected') {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = setTimeout(() => {
            if (pcRef.current && pcRef.current.connectionState !== 'connected') endDueToDrop();
          }, 8000);
        }
      };

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      // chatId routes to the specific agent already on that chat
      console.log('[CALL] emitting call_offer', { callId: id, chatId });
      socket.emit('call_offer', { callId: id, offerSdp: pc.localDescription, chatId });
      setCallState('ringing');
    } catch (err) {
      cleanup();
      setCallState('error');
      setError(
        err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow microphone access to make calls.'
          : 'Could not access microphone. Please check your device settings.'
      );
    }
  }, [socket, cleanup]);

  const endCall = useCallback(() => {
    if (callIdRef.current) socket?.emit('call_end', { callId: callIdRef.current });
    cleanup();
    setCallState('ended');
  }, [socket, cleanup]);

  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      const newMuted = !isMuted;
      localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = !newMuted));
      setIsMuted(newMuted);
    }
  }, [isMuted]);

  const reset = useCallback(() => {
    // End any active call before resetting — covers the case where reset is called
    // from Chat.jsx's startNewChat() while a call is still in progress
    if (callIdRef.current) socket?.emit('call_end', { callId: callIdRef.current });
    cleanup();
    setCallState('idle');
    setCallId(null);
    setAgentName('');
    setElapsed(0);
    setIsMuted(false);
    setError('');
    setTransferredFrom('');
  }, [socket, cleanup]);

  return { callState, callId, agentName, transferredFrom, elapsed, isMuted, error, endedMeta, localStream, remoteStream, startCall, endCall, toggleMute, reset, primeAudio };
}
