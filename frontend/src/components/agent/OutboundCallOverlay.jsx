import { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../../contexts/SocketContext';
import { useAuth } from '../../contexts/AuthContext';
import { Phone, PhoneOff, Mic, MicOff, User, ArrowRightLeft, X } from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { uploadAttachment, getAgentList } from '../../services/api';
import { startCallRecording, uploadCallRecording } from '../../utils/callRecorder';
import { getIceConfig } from '../../config/webrtcConfig';
import { useDraggable } from '../../hooks/useDraggable';
import useAudioLevel from '../../hooks/useAudioLevel';
import AudioWaveBars from '../common/AudioWaveBars';

// Listens for window 'dsp:agent-call-customer' CustomEvents and handles the
// agent-initiated outbound call lifecycle as a portal overlay (bottom-left).
export default function OutboundCallOverlay() {
  const { socket } = useSocket();
  const { user } = useAuth();
  const [state, setState] = useState('idle'); // idle | ringing | active | ending
  const [target, setTarget] = useState(null); // { customerId, customerName, ticketId, ticketSubject }
  const [callId, setCallId] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  // Streams exposed for the mic-activity wave bars.
  const [localStream, setLocalStream]   = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const micLevel    = useAudioLevel(isMuted ? null : localStream);
  const remoteLevel = useAudioLevel(remoteStream);
  // Transfer flow — mirrors AgentCallOverlay so outbound calls can also be
  // handed off to another online agent (e.g. agent realizes the issue needs
  // a specialist mid-call). Same socket protocol (`call_transfer`).
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferAgents, setTransferAgents] = useState([]);
  const [transferring, setTransferring] = useState(false);
  // Name of the agent we're currently asking — drives the visible "Asking X to
  // take the call…" banner on A's overlay so A can see something IS happening
  // while waiting for B to respond. Cleared on accept/reject/timeout.
  const [transferTargetName, setTransferTargetName] = useState(null);
  const drag = useDraggable({ storageKey: 'outbound_call_overlay_pos' });

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const timerRef = useRef(null);
  const remoteAudio = useRef(typeof Audio !== 'undefined' ? new Audio() : null);
  const ringbackCtxRef = useRef(null);
  const ringbackTimerRef = useRef(null);
  const pendingCandidates = useRef([]);
  const recorderRef = useRef(null);
  const callIdRef = useRef(null); // mirrors `callId` state so socket-event closures see the latest value
  const [isRecording, setIsRecording] = useState(false);

  // Keep ref in sync so handlers registered once read the latest callId
  useEffect(() => { callIdRef.current = callId; }, [callId]);

  // Finalize and upload the recording. Idempotent — multiple paths
  // (manual hangup, socket call_ended, pc state-closed) may arrive at once.
  const finalizeRecording = async (cid) => {
    // Atomic claim — read and null in the same synchronous step
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec || !cid) return;
    setIsRecording(false);
    console.log(`[OutboundCallOverlay] finalizeRecording(${cid}) — claimed recorder`);
    const savingToast = toast.loading('Saving recording…');
    try {
      const blob = await rec.stop();
      console.log(`[OutboundCallOverlay] rec.stop() returned blob:`, blob ? `${blob.size} bytes` : 'null');
      if (!blob || blob.size === 0) {
        toast.dismiss(savingToast);
        toast('No audio captured to save', { icon: '⚠️' });
        return;
      }
      const att = await uploadCallRecording({ blob, callId: cid, uploadAttachment });
      toast.dismiss(savingToast);
      if (att) {
        toast.success(`Recording saved (${Math.round(blob.size / 1024)} KB)`, { duration: 3000 });
      } else {
        // See AgentCallOverlay's finalize — recording is best-effort, silent
        // failure with a console log instead of a scary toast.
        console.warn(`[OutboundCallOverlay] call ${cid} recording upload failed silently — see network tab`);
      }
    } catch (err) {
      toast.dismiss(savingToast);
      console.error('[OutboundCallOverlay] finalize failed:', err?.message || err);
    }
  };

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (ringbackTimerRef.current) { clearInterval(ringbackTimerRef.current); ringbackTimerRef.current = null; }
    if (ringbackCtxRef.current) { try { ringbackCtxRef.current.close(); } catch {} ringbackCtxRef.current = null; }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (pcRef.current) { try { pcRef.current.close(); } catch {} pcRef.current = null; }
    if (remoteAudio.current) { remoteAudio.current.pause(); remoteAudio.current.srcObject = null; }
    pendingCandidates.current = [];
    setElapsed(0);
    setIsMuted(false);
    setLocalStream(null);
    setRemoteStream(null);
  }, []);

  const playRingback = useCallback(() => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      ringbackCtxRef.current = ctx;
      const ring = () => {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.1, now + 0.05);
        gain.gain.linearRampToValueAtTime(0, now + 1.9);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 2);
      };
      ring();
      ringbackTimerRef.current = setInterval(ring, 6000);
    } catch {}
  }, []);

  // Listen to a custom event so any agent page can trigger a call.
  useEffect(() => {
    const handler = (e) => {
      const { customerId, customerName, ticketId, ticketSubject } = e.detail || {};
      if (!customerId || !socket) return;
      if (state !== 'idle') {
        toast.error('You are already on a call');
        return;
      }
      setTarget({ customerId, customerName, ticketId, ticketSubject });
      setState('ringing');
      socket.emit('agent_call_request', { customerId, ticketId: ticketId || null });
      playRingback();
    };
    window.addEventListener('dsp:agent-call-customer', handler);
    return () => window.removeEventListener('dsp:agent-call-customer', handler);
  }, [socket, state, playRingback]);

  // Socket event handlers
  useEffect(() => {
    if (!socket) return;

    const onRinging = ({ callId: id }) => setCallId(id);

    const onError = ({ message }) => {
      toast.error(message || 'Call failed');
      cleanup();
      setState('idle');
      setTarget(null);
      setCallId(null);
    };

    const onDeclined = ({ reason }) => {
      toast(reason === 'no_answer' ? 'No answer' : 'Customer declined the call');
      cleanup();
      setState('idle');
      setTarget(null);
      setCallId(null);
    };

    const onAccepted = async ({ callId: id }) => {
      // Customer accepted — start WebRTC offer
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        setLocalStream(stream);

        const pc = new RTCPeerConnection(await getIceConfig());
        pcRef.current = pc;

        stream.getTracks().forEach(t => pc.addTrack(t, stream));

        // Start recording — agent side mixes local mic + remote audio.
        try {
          recorderRef.current = startCallRecording({ localStream: stream });
          setIsRecording(true);
          toast('🔴 Recording started', { duration: 2000, icon: '🎙' });
        } catch (err) {
          console.warn('[CallRecorder] startCallRecording threw:', err?.message || err);
          toast.error('Recording could not start');
        }

        pc.ontrack = (e) => {
          if (remoteAudio.current && e.streams[0]) {
            remoteAudio.current.srcObject = e.streams[0];
            remoteAudio.current.play().catch(() => {});
          }
          if (e.streams[0]) setRemoteStream(e.streams[0]);
          try { recorderRef.current?.attachRemote(e.streams[0]); } catch {}
        };
        pc.onicecandidate = (e) => {
          if (e.candidate) socket.emit('call_ice_candidate', { callId: id, candidate: e.candidate });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            // Stop ringback
            if (ringbackTimerRef.current) { clearInterval(ringbackTimerRef.current); ringbackTimerRef.current = null; }
            if (ringbackCtxRef.current) { try { ringbackCtxRef.current.close(); } catch {} ringbackCtxRef.current = null; }
            setState('active');
            timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
          } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
            finalizeRecording(id);
            toast('Call ended', { id: `call_ended_${id}` });
            cleanup();
            setState('idle');
            setTarget(null);
            setCallId(null);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('agent_call_offer', { callId: id, offerSdp: pc.localDescription });
      } catch (err) {
        toast.error('Microphone permission required');
        socket.emit('call_end', { callId: id });
        cleanup();
        setState('idle');
        setTarget(null);
        setCallId(null);
      }
    };

    const onAnswer = async ({ callId: id, answerSdp }) => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
        for (const c of pendingCandidates.current) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
        }
        pendingCandidates.current = [];
      } catch (err) {
        console.error('agent_call_answer error:', err);
      }
    };

    const onIceCandidate = async ({ callId: id, candidate }) => {
      const pc = pcRef.current;
      if (pc?.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      } else {
        pendingCandidates.current.push(candidate);
      }
    };

    const onCallEnded = ({ callId } = {}) => {
      // Only react if this overlay is the one tracking the call that just
      // ended. Otherwise the agent gets a duplicate "Call ended" toast
      // because AgentCallOverlay (mounted in parallel) also receives the
      // same socket event.
      if (callId != null && callIdRef.current != null && Number(callId) !== Number(callIdRef.current)) return;
      if (callIdRef.current == null) return;
      const cid = callIdRef.current;
      finalizeRecording(cid);
      toast('Call ended', { id: `call_ended_${cid}` });
      cleanup();
      setState('idle');
      setTarget(null);
      setCallId(null);
    };

    socket.on('agent_call_ringing', onRinging);
    socket.on('agent_call_error', onError);
    socket.on('agent_call_declined', onDeclined);
    socket.on('agent_call_accepted', onAccepted);
    socket.on('agent_call_answer', onAnswer);
    socket.on('call_ice_candidate', onIceCandidate);
    socket.on('call_ended', onCallEnded);

    return () => {
      socket.off('agent_call_ringing', onRinging);
      socket.off('agent_call_error', onError);
      socket.off('agent_call_declined', onDeclined);
      socket.off('agent_call_accepted', onAccepted);
      socket.off('agent_call_answer', onAnswer);
      socket.off('call_ice_candidate', onIceCandidate);
      socket.off('call_ended', onCallEnded);
    };
  }, [socket, cleanup]);

  const cancelOrHangup = () => {
    if (!socket) return;
    const cid = callId;
    if (state === 'ringing' && cid) {
      socket.emit('agent_call_cancel', { callId: cid });
      // No recording during ringing phase — nothing to upload
      try { recorderRef.current?.cancel?.(); recorderRef.current = null; } catch {}
    } else if (cid) {
      socket.emit('call_end', { callId: cid });
      // Upload whatever we have so far
      finalizeRecording(cid);
    }
    cleanup();
    setState('idle');
    setTarget(null);
    setCallId(null);
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const track = localStreamRef.current.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setIsMuted(!track.enabled);
    }
  };

  const openTransfer = async () => {
    try {
      const res = await getAgentList();
      setTransferAgents(res.data.agents || []);
    } catch {}
    setShowTransfer(true);
  };

  // Warm transfer — A's call stays live until B explicitly accepts / declines.
  // Listens for THREE backend events:
  //   - transfer_pending  : backend acknowledged the request, B is being asked.
  //                          Show a "transferring to X" status so A isn't left
  //                          wondering whether the click did anything.
  //   - call_transferred  : B accepted. Tear down A's WebRTC and end the call.
  //   - transfer_failed   : B declined OR didn't pick within 30 s. Show toast
  //                          and KEEP A on the call so they can explain to
  //                          the customer and end normally.
  // Old code only listened for call_transferred with an 8 s timeout, which
  // didn't work with the new warm-transfer backend at all (B's accept usually
  // takes longer than 8 s, and rejection/timeout produced no signal to A).
  const handleTransfer = (targetAgentId) => {
    if (!callId || !socket) return;
    setTransferring(true);
    setShowTransfer(false);
    setTransferTargetName(null); // populated by transfer_pending below
    const transferredCallId = callId;
    let resolved = false;

    const cleanupListeners = () => {
      socket.off('call_transferred', onAccepted);
      socket.off('transfer_failed',  onFailed);
      socket.off('transfer_pending', onPending);
    };
    const onPending = ({ targetAgentName }) => {
      setTransferTargetName(targetAgentName);
      toast(`Asking ${targetAgentName} to take the call…`, { icon: '📞', duration: 4000 });
    };
    const onAccepted = async () => {
      resolved = true;
      cleanupListeners();
      // See AgentCallOverlay's onAccepted: await finalize before cleanup so
      // the recording's underlying stream isn't killed mid-flush.
      try { await finalizeRecording(transferredCallId); } catch {}
      cleanup();
      setState('idle');
      setTarget(null);
      setCallId(null);
      setTransferring(false);
      setTransferTargetName(null);
      toast.success('Call transferred');
    };
    const onFailed = ({ targetAgentName, reason }) => {
      resolved = true;
      cleanupListeners();
      setTransferring(false);
      setTransferTargetName(null);
      const why = reason === 'no_answer' ? "didn't pick up" : 'declined';
      toast.error(`${targetAgentName} ${why}. You're still on the call — explain to the customer and end it when ready.`, { duration: 7000 });
    };
    socket.on('call_transferred', onAccepted);
    socket.on('transfer_failed',  onFailed);
    socket.on('transfer_pending', onPending);
    // Safety net — backend uses a 30 s timeout, give 5 s extra in case the
    // `transfer_failed` event got lost in a socket reconnect.
    setTimeout(() => {
      if (resolved) return;
      cleanupListeners();
      setTransferring(false);
      setTransferTargetName(null);
      toast.error('Transfer request expired — continuing call with you.', { duration: 6000 });
    }, 35000);

    socket.emit('call_transfer', { callId: transferredCallId, targetAgentId });
  };

  if (state === 'idle' || !target) return null;

  return (
    <div
      ref={drag.ref}
      {...drag.handleProps}
      className="fixed bottom-6 left-6 z-[60] bg-white rounded-2xl shadow-2xl border-2 border-blue-400 w-72 overflow-hidden"
      title="Drag to move"
    >
      <div className="p-4">
        <div className="flex items-center gap-3 mb-3">
          <div className={clsx('w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0', state === 'active' ? 'bg-green-100' : 'bg-blue-100')}>
            {state === 'active' ? <Phone className="w-5 h-5 text-green-600" /> : <User className="w-5 h-5 text-blue-600" />}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">
              {state === 'ringing' ? 'Ringing customer' : state === 'active' ? 'On call with' : 'Calling'}
            </p>
            <div className="flex items-center gap-2">
              <p className="text-sm font-bold text-gray-800 truncate">{target.customerName || 'Customer'}</p>
              {state === 'active' && (
                <AudioWaveBars level={remoteLevel} bars={4} color="bg-green-500" maxHeight={12} minHeight={2} barWidth={2} />
              )}
            </div>
            {target.ticketId && (
              <p className="text-[10px] text-blue-600 truncate">Re: #{target.ticketId}</p>
            )}
          </div>
          {state === 'active' && (
            <div className="flex flex-col items-end gap-1 flex-shrink-0">
              <div className="text-xs font-mono text-gray-600 bg-gray-50 px-2 py-1 rounded">
                {Math.floor(elapsed / 60).toString().padStart(2, '0')}:{(elapsed % 60).toString().padStart(2, '0')}
              </div>
              {isRecording && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  REC
                </span>
              )}
            </div>
          )}
        </div>
        {/* Visible transfer-pending banner — appears between A clicking
            Transfer and B accepting/declining. Without it the agent has no
            on-screen feedback that anything is happening; they'd just see
            the toast fade and assume the click was lost. */}
        {transferring && transferTargetName && (
          <div className="mb-3 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-center gap-1.5" data-no-drag>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            Asking <strong>{transferTargetName}</strong> to take the call…
          </div>
        )}
        {showTransfer ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-600">Transfer to:</p>
              <button onClick={() => setShowTransfer(false)} disabled={transferring}>
                <X className="w-3.5 h-3.5 text-gray-400" />
              </button>
            </div>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {(() => {
                const transferable = transferAgents.filter(
                  a => a.is_online && Number(a.id) !== Number(user?.id)
                );
                if (transferable.length === 0) {
                  return <p className="text-xs text-gray-400 text-center py-2">No other agents available</p>;
                }
                return transferable.map(a => (
                  <button
                    key={a.id}
                    disabled={transferring}
                    onClick={() => handleTransfer(a.id)}
                    className="w-full text-left px-2.5 py-1.5 text-xs bg-gray-50 hover:bg-blue-50 hover:text-blue-700 rounded-lg transition-colors truncate flex items-center gap-1.5"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                    {a.name}
                  </button>
                ));
              })()}
            </div>
          </div>
        ) : (
          <>
          {state === 'active' && (
            <div className="flex items-center justify-center gap-2 mb-2">
              <AudioWaveBars level={isMuted ? 0 : micLevel} bars={6} color="bg-blue-500" maxHeight={14} minHeight={3} barWidth={2} />
              <span className="text-[10px] text-gray-400">Your mic</span>
            </div>
          )}
          <div className="flex gap-2">
            {state === 'active' && (
              <button
                onClick={toggleMute}
                className={clsx('flex-1 flex items-center justify-center gap-1 py-2 rounded-lg border text-sm transition-colors', isMuted ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100')}
              >
                {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
            )}
            {state === 'active' && (
              <button
                onClick={openTransfer}
                title="Transfer this call to another agent"
                className="flex-1 flex items-center justify-center gap-1 py-2 rounded-lg border bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 text-sm transition-colors"
              >
                <ArrowRightLeft className="w-3.5 h-3.5" />
                Transfer
              </button>
            )}
            <button
              onClick={cancelOrHangup}
              className={clsx('flex items-center justify-center gap-1 py-2 rounded-lg font-medium text-sm transition-colors', state === 'active' ? 'flex-1 bg-red-600 text-white hover:bg-red-700' : 'flex-1 bg-red-50 text-red-700 hover:bg-red-100 border border-red-200')}
            >
              <PhoneOff className="w-3.5 h-3.5" />
              {state === 'ringing' ? 'Cancel' : 'End'}
            </button>
          </div>
          </>
        )}
        {state === 'ringing' && (
          <p className="text-[10px] text-gray-400 mt-2 text-center animate-pulse">Waiting for customer to accept…</p>
        )}
      </div>
    </div>
  );
}
