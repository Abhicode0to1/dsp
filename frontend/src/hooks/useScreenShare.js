import { useState, useRef, useEffect, useCallback } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { getIceConfig } from '../config/webrtcConfig';

// Phase 1 screen-share: agent VIEWS the customer's screen (view-only), started
// from a live chat. Signalling mirrors the voice-call flow. One hook serves both
// roles — the server only delivers each side the events meant for it, so the
// customer branch (capture + offer) and agent branch (receive + answer) never
// collide on the same socket.
//
// State machine:
//   idle → (agent) requesting → connecting → active → ended
//   idle → (customer) incoming → active(sharing) → ended
export function useScreenShare() {
  const { socket } = useSocket();
  const [state, setState] = useState('idle'); // idle|requesting|incoming|connecting|active|ended|rejected|no_answer|error
  const [sessionId, setSessionId] = useState(null);
  const [agentName, setAgentName] = useState('');
  const [error, setError] = useState('');
  const [remoteStream, setRemoteStream] = useState(null); // agent: customer's screen
  const [isSharing, setIsSharing] = useState(false);      // customer: sharing now
  const [rejectReason, setRejectReason] = useState(null); // agent: why a request ended without sharing

  // Browsers can only capture the screen on DESKTOP. Mobile (iOS Safari, mobile
  // Chrome) has no getDisplayMedia, so the customer can't share from a phone.
  const supportsScreenShare = typeof navigator !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const sessionIdRef = useRef(null);
  const roleRef = useRef(null);            // 'agent' | 'customer'
  const pendingCandidates = useRef([]);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // ── Teardown ───────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) {
      try { pcRef.current.close(); } catch {}
      pcRef.current = null;
    }
    pendingCandidates.current = [];
    setRemoteStream(null);
    setIsSharing(false);
  }, []);

  const reset = useCallback(() => {
    cleanup();
    setSessionId(null);
    sessionIdRef.current = null;
    roleRef.current = null;
    setAgentName('');
  }, [cleanup]);

  // Build a peer connection wired for ICE trickle + (agent) remote track.
  const makePeer = useCallback(async () => {
    const cfg = await getIceConfig();
    const pc = new RTCPeerConnection(cfg);
    pc.onicecandidate = (e) => {
      if (e.candidate && sessionIdRef.current) {
        socket.emit('screen_ice_candidate', { sessionId: sessionIdRef.current, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {
      setRemoteStream(e.streams[0] || new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        // Let the server-driven screen_ended handle the UI; just log.
        console.warn('[screen] pc state', pc.connectionState);
      }
    };
    pcRef.current = pc;
    return pc;
  }, [socket]);

  const drainCandidates = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc) return;
    for (const c of pendingCandidates.current) {
      try { await pc.addIceCandidate(c); } catch {}
    }
    pendingCandidates.current = [];
  }, []);

  // ── Agent: request to view a chat customer's screen ─────────────────────────
  const requestScreen = useCallback((chatId) => {
    if (!socket) return;
    roleRef.current = 'agent';
    setError('');
    setState('requesting');
    socket.emit('screen_request', { chatId });
  }, [socket]);

  // ── Customer: accept → capture screen → send offer ──────────────────────────
  const acceptShare = useCallback(async () => {
    if (!socket || !sessionIdRef.current) return;
    const sid = sessionIdRef.current;
    // Device can't capture its screen (mobile) — tell the agent it's unsupported,
    // not a plain decline.
    if (!supportsScreenShare) {
      socket.emit('screen_reject', { sessionId: sid, reason: 'unsupported' });
      reset(); setState('idle');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      localStreamRef.current = stream;
      setIsSharing(true);
      // If the customer stops via the browser's native "Stop sharing" bar.
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        socket.emit('screen_stop', { sessionId: sid });
        cleanup();
        setState('ended');
      });

      socket.emit('screen_accept', { sessionId: sid });

      const pc = await makePeer();
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('screen_offer', { sessionId: sid, offerSdp: offer });
      setState('active');
    } catch (err) {
      // User cancelled the picker, or no permission → treat as decline.
      socket.emit('screen_reject', { sessionId: sid });
      cleanup();
      setState('idle');
      setSessionId(null);
    }
  }, [socket, makePeer, cleanup, supportsScreenShare, reset]);

  const declineShare = useCallback((reason) => {
    if (socket && sessionIdRef.current) socket.emit('screen_reject', { sessionId: sessionIdRef.current, reason });
    reset();
    setState('idle');
  }, [socket, reset]);

  // ── Either party: stop ──────────────────────────────────────────────────────
  const stop = useCallback(() => {
    if (socket && sessionIdRef.current) socket.emit('screen_stop', { sessionId: sessionIdRef.current });
    cleanup();
    setState('ended');
  }, [socket, cleanup]);

  const dismiss = useCallback(() => { reset(); setState('idle'); setError(''); }, [reset]);

  // ── Socket listeners ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onRequested = ({ sessionId: sid }) => { setSessionId(sid); sessionIdRef.current = sid; };
    const onRequest = ({ sessionId: sid, agentName: name }) => {
      // Customer got an incoming request.
      roleRef.current = 'customer';
      setSessionId(sid); sessionIdRef.current = sid;
      setAgentName(name || 'Support agent');
      setState('incoming');
    };
    const onAccepted = () => { setState('connecting'); };
    const onRejected = ({ reason } = {}) => { setRejectReason(reason || null); cleanup(); setState('rejected'); };
    const onNoAnswer = () => { cleanup(); setState('no_answer'); };

    // Agent receives the customer's offer → answer.
    const onOffer = async ({ sessionId: sid, offerSdp }) => {
      try {
        setSessionId(sid); sessionIdRef.current = sid;
        const pc = await makePeer();
        await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
        await drainCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('screen_answer', { sessionId: sid, answerSdp: answer });
        setState('active');
      } catch (err) {
        setError('Could not start the screen view.');
        setState('error');
      }
    };

    // Customer receives the agent's answer.
    const onAnswer = async ({ answerSdp }) => {
      try {
        if (pcRef.current) { await pcRef.current.setRemoteDescription(new RTCSessionDescription(answerSdp)); await drainCandidates(); }
      } catch {}
    };

    const onIce = async ({ candidate }) => {
      const c = new RTCIceCandidate(candidate);
      if (pcRef.current && pcRef.current.remoteDescription) { try { await pcRef.current.addIceCandidate(c); } catch {} }
      else pendingCandidates.current.push(c);
    };

    const onEnded = () => { cleanup(); setState('ended'); };
    const onErr = ({ message }) => { setError(message || 'Screen share error'); setState('error'); };

    socket.on('screen_requested', onRequested);
    socket.on('screen_request', onRequest);
    socket.on('screen_accepted', onAccepted);
    socket.on('screen_rejected', onRejected);
    socket.on('screen_no_answer', onNoAnswer);
    socket.on('screen_offer', onOffer);
    socket.on('screen_answer', onAnswer);
    socket.on('screen_ice_candidate', onIce);
    socket.on('screen_ended', onEnded);
    socket.on('screen_error', onErr);

    return () => {
      socket.off('screen_requested', onRequested);
      socket.off('screen_request', onRequest);
      socket.off('screen_accepted', onAccepted);
      socket.off('screen_rejected', onRejected);
      socket.off('screen_no_answer', onNoAnswer);
      socket.off('screen_offer', onOffer);
      socket.off('screen_answer', onAnswer);
      socket.off('screen_ice_candidate', onIce);
      socket.off('screen_ended', onEnded);
      socket.off('screen_error', onErr);
    };
  }, [socket, makePeer, drainCandidates, cleanup]);

  // Stop sharing / close pc if the component using the hook unmounts mid-session.
  useEffect(() => () => {
    if (sessionIdRef.current && (isSharing || roleRef.current)) {
      try { socket?.emit('screen_stop', { sessionId: sessionIdRef.current }); } catch {}
    }
    cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state, sessionId, agentName, error, remoteStream, isSharing,
    supportsScreenShare, rejectReason,
    requestScreen, acceptShare, declineShare, stop, dismiss,
  };
}
