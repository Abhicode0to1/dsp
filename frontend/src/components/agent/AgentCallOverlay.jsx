import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../../contexts/SocketContext';
import { useAuth } from '../../contexts/AuthContext';
import { getAgentList, uploadAttachment, getCustomerHistory, createAgentTicket, saveAgentCallNotes } from '../../services/api';
import {
  Phone, PhoneOff, Mic, MicOff, ArrowRightLeft, X, StickyNote, CheckCircle2, Ticket, RotateCcw,
  ChevronDown, ChevronUp, Sparkles, Clock,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import { getIceConfig } from '../../config/webrtcConfig';
import { startCallRecording, uploadCallRecording } from '../../utils/callRecorder';
import { useDraggable } from '../../hooks/useDraggable';
import useAudioLevel from '../../hooks/useAudioLevel';
import AudioWaveBars from '../common/AudioWaveBars';

function formatDuration(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function AgentCallOverlay() {
  const { socket } = useSocket();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Lifecycle: idle → ringing → active → wrapup → idle
  // 'wrapup' is the new 30-second post-call prompt asking "resolved / create ticket / callback".
  const [state, setState] = useState('idle');
  const [callInfo, setCallInfo] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  // Stream handles exposed for the mic-activity glow (useAudioLevel).
  const [localStream, setLocalStream]   = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const micLevel    = useAudioLevel(isMuted ? null : localStream);
  const remoteLevel = useAudioLevel(remoteStream);
  const [showTransfer, setShowTransfer] = useState(false);
  const [agents, setAgents] = useState([]);
  const [transferring, setTransferring] = useState(false);
  // Incoming transfer offer from another agent — { callId, fromAgent, customer }.
  // Distinct from `state==='ringing'` so an agent who's currently idle still
  // gets a proper "X wants to transfer customer Y to you" prompt without
  // colliding with the new-customer-call ringing UI.
  const [pendingTransfer, setPendingTransfer] = useState(null);

  // Once B clicks Accept on a transfer offer, we store the callId here. When
  // the customer's eventual `customer_call_reoffer` arrives as an
  // `incoming_call` (with isTransfer=true), the matching callId means we
  // should auto-run handleAccept instead of showing the standard ringing UI
  // (B already consented; a second click would be confusing). Cleared by
  // handleAccept itself or by transfer_cancelled.
  const expectingTransferRef = useRef(null);
  // Name of the agent we're asking — drives the on-screen "Asking X…" banner
  // so A has visible feedback during the wait. Cleared on resolve/timeout.
  const [transferTargetName, setTransferTargetName] = useState(null);
  // Ref-to-latest-handleAccept so onIncomingCall can call it without a stale
  // closure. Synced via the useEffect below after every render.
  const handleAcceptRef = useRef(null);

  // Drag handle for the floating call card. Position persisted across reloads.
  const drag = useDraggable({ storageKey: 'agent_call_overlay_pos' });

  // New: customer enrichment fetched when the call rings (last touch + counts)
  const [customerContext, setCustomerContext] = useState(null);

  // New: floating notepad — open during 'active', persists per callId in localStorage
  const [notepadOpen, setNotepadOpen] = useState(false);
  const [notepadText, setNotepadText] = useState('');

  // New: wrap-up modal state — { callId, durationSec, customerName, customerId, notes }
  const [wrapup, setWrapup] = useState(null);
  const [wrapupSubmitting, setWrapupSubmitting] = useState(false);

  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const callIdRef = useRef(null);
  const timerRef = useRef(null);
  const disconnectTimerRef = useRef(null); // grace timer for a 'disconnected' wobble
  const pendingCandidates = useRef([]);
  const remoteAudio = useRef(typeof Audio !== 'undefined' ? new Audio() : null);
  const ringtoneCtxRef = useRef(null);
  const ringtoneTimerRef = useRef(null);
  const recorderRef = useRef(null);
  const [isRecording, setIsRecording] = useState(false);

  // Mirror state into refs so the socket-event closures (registered once with
  // [socket] dep) always see the latest values when a call ends or is cancelled.
  const stateRef = useRef(state);
  const callInfoRef = useRef(callInfo);
  const notepadTextRef = useRef(notepadText);
  const elapsedRef = useRef(elapsed);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { callInfoRef.current = callInfo; }, [callInfo]);
  useEffect(() => { notepadTextRef.current = notepadText; }, [notepadText]);
  useEffect(() => { elapsedRef.current = elapsed; }, [elapsed]);

  // Broadcast which call (if any) this overlay is currently showing in
  // 'ringing' state. The agent's Calls page listens for these events to
  // suppress its own inline "ringing call" banner for the SAME call — the
  // popup here is the primary UI; the banner was added as a fallback and
  // having both visible at once was confusing the agents (two pairs of
  // Accept/Reject buttons for one call).
  useEffect(() => {
    if (state !== 'ringing' || !callInfo?.callId) return;
    const id = callInfo.callId;
    window.dispatchEvent(new CustomEvent('dsp:call-popup-active', { detail: { callId: id } }));
    return () => {
      window.dispatchEvent(new CustomEvent('dsp:call-popup-cleared', { detail: { callId: id } }));
    };
  }, [state, callInfo?.callId]);

  // Finalize recording and upload. Idempotent — multiple call_end paths (manual
  // hangup, socket call_ended, socket call_cancelled, transfer complete) can all
  // arrive in rapid succession; only the first one with a live recorder runs.
  const finalizeRecording = async (callId) => {
    // Atomic claim: read-and-null in the same synchronous step so a second caller
    // sees a null recorder and bails immediately.
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec || !callId) return;
    setIsRecording(false);
    console.log(`[AgentCallOverlay] finalizeRecording(${callId}) — claimed recorder`);
    const savingToast = toast.loading('Saving recording…');
    try {
      const blob = await rec.stop();
      console.log(`[AgentCallOverlay] rec.stop() returned blob:`, blob ? `${blob.size} bytes` : 'null');
      if (!blob || blob.size === 0) {
        toast.dismiss(savingToast);
        toast('No audio captured to save', { icon: '⚠️' });
        return;
      }
      const att = await uploadCallRecording({ blob, callId, uploadAttachment });
      toast.dismiss(savingToast);
      if (att) {
        toast.success(`Recording saved (${Math.round(blob.size / 1024)} KB)`, { duration: 3000 });
      } else {
        // Recording is best-effort — failure to upload (network blip,
        // post-transfer race, etc.) shouldn't put a scary toast in the
        // agent's face when the actual call worked fine. Log to console
        // for diagnostics; agent moves on.
        console.warn(`[AgentCallOverlay] call ${callId} recording upload failed silently — see network tab`);
      }
    } catch (err) {
      toast.dismiss(savingToast);
      console.error('[AgentCallOverlay] finalize failed:', err?.message || err);
    }
  };

  const cleanup = () => {
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
  };

  useEffect(() => {
    if (!socket) return;

    const onIncomingCall = ({ callId, customer, offerSdp, isTransfer }) => {
      console.log('[CALL] incoming_call received', { callId, customer, isTransfer });
      callIdRef.current = callId;
      setCallInfo({ callId, customer, offerSdp });
      setState('ringing');
      setElapsed(0);
      setIsMuted(false);
      setCustomerContext(null);
      setNotepadText(''); setNotepadOpen(false);

      // If this is the customer's reoffer for a transfer THIS agent already
      // accepted, skip the manual ringing UI and auto-run handleAccept. The
      // handleAccept function reads callInfo via React state which is set in
      // the same render tick, so we defer to next-tick via setTimeout(0).
      // pendingCandidates may already hold ICE from the customer's new pc, so
      // handleAccept's setRemoteDescription + addIceCandidate loop just works.
      if (isTransfer && expectingTransferRef.current === callId) {
        expectingTransferRef.current = null;
        toast.success('Transfer connecting…', { duration: 2500 });
        // Defer one tick so the setCallInfo above is committed before
        // handleAccept dereferences `callInfo.offerSdp`.
        setTimeout(() => { handleAcceptRef.current?.(); }, 0);
        return;
      }

      toast(`Incoming call from ${customer?.customer_name || 'Customer'}`, { icon: '📞', duration: 8000 });

      // Fetch this customer's recent history (last 3 tickets + counts + last touch) so
      // the agent sees full context before they accept. Quiet failure — call still works
      // without the enrichment, the agent just doesn't see the card.
      if (customer?.customer_id) {
        getCustomerHistory(customer.customer_id)
          .then(res => { setCustomerContext(res.data); })
          .catch(() => {});
      }
    };

    const onIceCandidate = async ({ candidate }) => {
      if (!candidate) return;
      if (pcRef.current && pcRef.current.remoteDescription) {
        try { await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
      } else {
        pendingCandidates.current.push(candidate);
      }
    };

    const onCallEnded = ({ callId } = {}) => {
      // Skip if THIS overlay isn't tracking the call that ended. Both
      // AgentCallOverlay and OutboundCallOverlay are mounted via
      // PersistentOverlays for every agent, and both subscribe to
      // `call_ended` — without the callId check they BOTH react and the
      // agent sees two "Call ended" toasts for one call.
      if (callId != null && callIdRef.current != null && Number(callId) !== Number(callIdRef.current)) return;
      if (callIdRef.current == null) return; // no call tracked here, ignore
      const endedCallId = callIdRef.current;
      finalizeRecording(endedCallId);
      // Only show wrap-up if the call was actually connected (active). For ringing-then-end
      // we just go back to idle silently — nothing to wrap up. Read from refs so the
      // closure sees the latest values, not the ones captured when listener registered.
      const wasActive = stateRef.current === 'active';
      const ci = callInfoRef.current;
      const notes = notepadTextRef.current;
      const dur  = elapsedRef.current;
      cleanup();
      // Persist the quick-notes to the call row FIRST — so they survive regardless of
      // whether the agent picks Resolved/Create-ticket/Skip in the wrap-up popup.
      // Notes show up later in the Calls tab history.
      if (wasActive && notes?.trim() && endedCallId) {
        saveAgentCallNotes(endedCallId, notes.trim()).catch(() => {});
      }
      if (wasActive && ci) {
        setState('wrapup');
        setWrapup({
          callId: endedCallId,
          customerName: ci.customer?.customer_name || 'Customer',
          customerId:   ci.customer?.customer_id || null,
          durationSec:  dur,
          notes,
        });
      } else {
        setState('idle');
        setCallInfo(null);
        setElapsed(0);
        toast('Call ended', { id: `call_ended_${endedCallId}` });
      }
    };

    const onCallCancelled = ({ callId }) => {
      if (callIdRef.current === callId) {
        finalizeRecording(callId);
        cleanup();
        setState('idle');
        setCallInfo(null);
        toast('Caller hung up');
      }
    };

    // Warm-transfer prompt from another agent. Show a separate accept/decline
    // UI without disrupting any call this agent is currently on. Plays a
    // short attention tone so B notices even if they were on another tab.
    const onTransferRequest = ({ callId, fromAgent, customer }) => {
      setPendingTransfer({ callId, fromAgent, customer });
      toast(`${fromAgent?.name || 'An agent'} wants to transfer ${customer?.customer_name || 'a customer'} to you`, { icon: '🔁', duration: 8000 });
      // Audible chime — same Web Audio API trick used for ringback elsewhere.
      // Tries-and-shrugs; some browsers block autoplay AudioContext until the
      // user has interacted with the page, which is fine (the visible prompt
      // is the primary signal anyway).
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const play = (freq, when, dur) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0, ctx.currentTime + when);
          gain.gain.linearRampToValueAtTime(0.15, ctx.currentTime + when + 0.02);
          gain.gain.linearRampToValueAtTime(0, ctx.currentTime + when + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime + when);
          osc.stop(ctx.currentTime + when + dur + 0.05);
        };
        // Two-tone chime: high → low. Roughly the standard "notification" ping.
        play(880, 0,    0.18);
        play(660, 0.22, 0.30);
        setTimeout(() => { try { ctx.close(); } catch {} }, 1200);
      } catch {}
    };
    // Transfer was cancelled (initiating agent gave up, or 30s timed out)
    const onTransferCancelled = ({ callId }) => {
      setPendingTransfer(prev => (prev && prev.callId === callId ? null : prev));
      // If WE were the ones expecting this transfer, drop the auto-accept
      // arming so a stray incoming_call later doesn't get auto-accepted.
      if (expectingTransferRef.current === callId) {
        expectingTransferRef.current = null;
      }
    };
    // Backend confirms B's accept_transfer landed. Customer is about to send
    // a fresh offer; arm onIncomingCall to auto-accept it.
    const onTransferAccepted = ({ callId }) => {
      expectingTransferRef.current = callId;
    };

    socket.on('incoming_call', onIncomingCall);
    socket.on('call_ice_candidate', onIceCandidate);
    socket.on('call_ended', onCallEnded);
    socket.on('call_cancelled', onCallCancelled);
    socket.on('transfer_request', onTransferRequest);
    socket.on('transfer_cancelled', onTransferCancelled);
    socket.on('transfer_accepted', onTransferAccepted);

    return () => {
      socket.off('incoming_call', onIncomingCall);
      socket.off('call_ice_candidate', onIceCandidate);
      socket.off('call_ended', onCallEnded);
      socket.off('call_cancelled', onCallCancelled);
      socket.off('transfer_request', onTransferRequest);
      socket.off('transfer_cancelled', onTransferCancelled);
      socket.off('transfer_accepted', onTransferAccepted);
    };
  }, [socket]);

  // Accept / reject incoming transfer offers
  const acceptTransfer = () => {
    if (!pendingTransfer || !socket) return;
    socket.emit('accept_transfer', { callId: pendingTransfer.callId });
    setPendingTransfer(null);
  };
  const rejectTransfer = () => {
    if (!pendingTransfer || !socket) return;
    socket.emit('reject_transfer', { callId: pendingTransfer.callId });
    setPendingTransfer(null);
  };

  // Play ringtone while ringing, stop when state changes
  useEffect(() => {
    if (state !== 'ringing') return;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    ringtoneCtxRef.current = ctx;
    let cancelled = false;

    function ring() {
      if (cancelled) return;
      if (ctx.state === 'suspended') { ctx.resume().then(ring); return; }

      // Two-tone ring: 480 Hz + 620 Hz for 1 s, then 2 s silence
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.22, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.95);

      [480, 620].forEach(freq => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.95);
      });

      ringtoneTimerRef.current = setTimeout(ring, 3000);
    }

    ring();

    return () => {
      cancelled = true;
      clearTimeout(ringtoneTimerRef.current);
      ctx.close().catch(() => {});
      ringtoneCtxRef.current = null;
    };
  }, [state]);

  const handleAccept = async () => {
    if (!callInfo) return;
    if (!callInfo.offerSdp) {
      // Edge case: handleAccept fired before the SDP arrived (could happen
      // if a stale incoming_call without offer ever leaks through). Bail
      // cleanly rather than throwing on setRemoteDescription(null).
      toast.error('Call setup not ready — please try again');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = new RTCPeerConnection(await getIceConfig());
      pcRef.current = pc;

      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      // Start recording the call (agent side mixes local mic + remote audio).
      // Wrapped in try/catch — recording failures must never break the call.
      try {
        recorderRef.current = startCallRecording({ localStream: stream });
        setIsRecording(true);
        toast('🔴 Recording started', { duration: 2000, icon: '🎙' });
      } catch (err) {
        console.warn('[CallRecorder] startCallRecording threw:', err?.message || err);
        toast.error('Recording could not start');
      }

      pc.ontrack = ({ streams: [remote] }) => {
        if (remoteAudio.current) {
          remoteAudio.current.srcObject = remote;
          remoteAudio.current.play().catch(() => {});
        }
        setRemoteStream(remote);
        try { recorderRef.current?.attachRemote(remote); } catch {}
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && callIdRef.current) {
          socket?.emit('call_ice_candidate', { callId: callIdRef.current, candidate });
        }
      };

      // Watchdog: end the call if the connection dies so we're not stuck on a
      // frozen "On Call". 'failed' → end now. 'disconnected' is a wobble that
      // might self-heal, so we wait a grace period; if it hasn't recovered to
      // 'connected', we end — this is what clears THIS panel when the customer
      // drops one-sidedly (their drop shows here as 'disconnected'/'failed').
      const endDueToDrop = () => {
        clearTimeout(disconnectTimerRef.current);
        console.warn('[AgentCallOverlay] peer connection lost — ending call');
        if (callIdRef.current && socket?.connected) {
          socket.emit('call_end', { callId: callIdRef.current });
        }
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

      await pc.setRemoteDescription(new RTCSessionDescription(callInfo.offerSdp));

      for (const c of pendingCandidates.current) {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      }
      pendingCandidates.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket?.emit('call_accept', { callId: callInfo.callId, answerSdp: pc.localDescription });
      setState('active');
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } catch (err) {
      console.error('[AgentCallOverlay] handleAccept failed:', err);
      // Without this emit, the customer would sit on "Connecting…" until
      // their timeout fires — give them a clean "rejected" signal so they
      // can re-dial immediately. Routes through the standard call_reject
      // handler which marks the DB row 'failed' + notifies the customer.
      if (callInfo?.callId && socket?.connected) {
        socket.emit('call_reject', { callId: callInfo.callId });
      }
      cleanup();
      setState('idle');
      toast.error('Could not start the call on this device');
    }
  };
  // Keep the ref in sync with the latest handleAccept so the auto-accept
  // path inside onIncomingCall doesn't capture a stale function.
  handleAcceptRef.current = handleAccept;

  const handleReject = () => {
    socket?.emit('call_reject', { callId: callInfo?.callId });
    cleanup();
    setState('idle');
    setCallInfo(null);
  };

  const handleEndCall = () => {
    const endedCallId = callIdRef.current;
    if (endedCallId) socket?.emit('call_end', { callId: endedCallId });
    // Fire-and-forget: stop recorder + upload after teardown
    finalizeRecording(endedCallId);
    // Snapshot state needed for the wrap-up popup BEFORE we wipe it via cleanup.
    const wasActive = stateRef.current === 'active';
    const ci   = callInfoRef.current;
    const notes = notepadTextRef.current;
    const dur  = elapsedRef.current;
    cleanup();
    // Always persist notes (so they survive every wrap-up choice).
    if (wasActive && notes?.trim() && endedCallId) {
      saveAgentCallNotes(endedCallId, notes.trim()).catch(() => {});
    }
    // Show the same wrap-up popup as when the OTHER side hung up — agent shouldn't
    // miss it just because they clicked End themselves.
    if (wasActive && ci) {
      setState('wrapup');
      setWrapup({
        callId: endedCallId,
        customerName: ci.customer?.customer_name || 'Customer',
        customerId:   ci.customer?.customer_id || null,
        durationSec:  dur,
        notes,
      });
    } else {
      setState('idle');
      setCallInfo(null);
      setElapsed(0);
    }
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const newMuted = !isMuted;
      localStreamRef.current.getAudioTracks().forEach(t => (t.enabled = !newMuted));
      setIsMuted(newMuted);
    }
  };

  const openTransfer = async () => {
    try {
      const res = await getAgentList();
      setAgents(res.data.agents || []);
    } catch {}
    setShowTransfer(true);
  };

  const handleTransfer = (targetAgentId) => {
    if (!callIdRef.current || !socket) return;
    setTransferring(true);
    setShowTransfer(false);
    setTransferTargetName(null); // backend populates via transfer_pending
    const transferredCallId = callIdRef.current;
    let resolved = false;

    // Warm transfer: A's call stays live until B explicitly responds.
    // - transfer_pending : backend acknowledged the request, B is being asked.
    // - call_transferred : B accepted — tear down A's side (existing behavior).
    // - transfer_failed  : B declined or didn't pick within 30 s — A's call
    //   stays alive, just clear the "transferring…" UI and toast the agent.
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
      // Await the recording finalize BEFORE cleanup tears down the local
      // mic stream — otherwise the MediaRecorder's underlying AudioContext
      // source loses its input while rec.stop() is still flushing, which
      // can truncate the blob (or in some browsers produce an empty one).
      // The await is cheap; the recorder finalize is mostly local CPU.
      try { await finalizeRecording(transferredCallId); } catch {}
      cleanup();
      setState('idle');
      setCallInfo(null);
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
    // server's `transfer_failed` event got lost (e.g. socket reconnect mid-flow).
    setTimeout(() => {
      if (resolved) return;
      cleanupListeners();
      setTransferring(false);
      setTransferTargetName(null);
      toast.error('Transfer request expired — continuing call with you.', { duration: 6000 });
    }, 35000);
    socket.emit('call_transfer', { callId: callIdRef.current, targetAgentId });
  };

  // ─── Helpers used by the new UI ──────────────────────────────────────────
  const planLabel = (() => {
    const c = callInfo?.customer;
    if (!c?.plan_name) return null;
    if (!c.plan_expiry) return c.plan_name;
    const days = Math.ceil((new Date(c.plan_expiry) - Date.now()) / 86400000);
    if (days < 0)   return `${c.plan_name} · expired ${-days}d ago`;
    if (days < 15)  return `${c.plan_name} · expires in ${days}d`;
    return `${c.plan_name} · active`;
  })();
  const planTone = (() => {
    const c = callInfo?.customer;
    if (!c?.plan_expiry) return 'gray';
    const days = Math.ceil((new Date(c.plan_expiry) - Date.now()) / 86400000);
    if (days < 0)  return 'red';
    if (days < 15) return 'amber';
    return 'green';
  })();
  const planToneClass = { green: 'bg-green-100 text-green-700', amber: 'bg-amber-100 text-amber-700', red: 'bg-red-100 text-red-700', gray: 'bg-gray-100 text-gray-600' }[planTone];

  // Wrap-up handlers — submit one of three outcomes from the popup.
  const handleWrapupResolved = () => {
    // Just close. Notes are already saved to the call row via the ticket creation
    // path if customer chose that; for "resolved" we keep things simple.
    setWrapup(null);
    setState('idle');
    setCallInfo(null); setElapsed(0); setNotepadText('');
    toast.success('Call closed');
  };
  const handleWrapupCreateTicket = async () => {
    if (!wrapup?.customerId) {
      toast.error('Customer info missing — cannot create ticket');
      return;
    }
    setWrapupSubmitting(true);
    try {
      const r = await createAgentTicket({
        customer_id: wrapup.customerId,
        subject: `Follow-up from call · ${wrapup.customerName}`,
        description: (wrapup.notes || '(no notes taken during call)') + `\n\n— Auto-created from call #${wrapup.callId}, duration ${formatDuration(wrapup.durationSec)}.`,
        priority: 'normal',
      });
      const tid = r.data.ticket?.id;
      toast.success(`Follow-up ticket #${tid} created`, { duration: 4000 });
      setWrapup(null);
      setState('idle');
      setCallInfo(null); setElapsed(0); setNotepadText('');
      if (tid) navigate(`/agent/tickets?openTicket=${tid}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create ticket');
    } finally {
      setWrapupSubmitting(false);
    }
  };
  const handleWrapupSkip = () => {
    setWrapup(null);
    setState('idle');
    setCallInfo(null); setElapsed(0); setNotepadText('');
  };

  // The transfer-request prompt renders independently of the main call state
  // — it can appear when the agent is idle (peer-to-peer transfer offer) or
  // when they're on another call (which is fine; the backend already blocked
  // that on the initiator's side via the "target is busy" check, so in
  // practice we'll only ever see this when truly free).
  const transferPrompt = pendingTransfer ? (
    <div className="fixed top-6 right-6 z-[70] bg-white rounded-2xl shadow-2xl border-2 border-blue-400 w-80 p-4">
      <div className="flex items-center gap-2 mb-2">
        <ArrowRightLeft className="w-4 h-4 text-blue-600" />
        <p className="text-sm font-bold text-gray-800">Incoming Transfer</p>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        <span className="font-semibold">{pendingTransfer.fromAgent?.name || 'Another agent'}</span>
        {' wants to transfer '}
        <span className="font-semibold">{pendingTransfer.customer?.customer_name || 'a customer'}</span>
        {' to you.'}
      </p>
      <p className="text-[10px] text-gray-400 mb-3">Auto-declines in 30 s if you don't respond.</p>
      <div className="flex gap-2">
        <button
          onClick={acceptTransfer}
          className="flex-1 bg-green-600 hover:bg-green-700 text-white text-sm font-semibold py-2 rounded-lg flex items-center justify-center gap-1.5"
        >
          <Phone className="w-3.5 h-3.5" /> Accept
        </button>
        <button
          onClick={rejectTransfer}
          className="flex-1 bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-sm font-semibold py-2 rounded-lg flex items-center justify-center gap-1.5"
        >
          <X className="w-3.5 h-3.5" /> Reject
        </button>
      </div>
    </div>
  ) : null;

  if (state === 'idle') return transferPrompt;

  return (
    <>
    {transferPrompt}
    <div
      ref={drag.ref}
      {...drag.handleProps}
      className="fixed bottom-6 right-6 z-50 bg-white rounded-2xl shadow-2xl border-2 border-green-400 w-72 overflow-hidden"
      title="Drag to move"
    >
      {state === 'ringing' && (
        <div className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-11 h-11 bg-green-100 rounded-full flex items-center justify-center animate-pulse flex-shrink-0">
              <Phone className="w-5 h-5 text-green-600" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-800">Incoming Call</p>
              <p className="text-xs text-gray-600 truncate font-medium">
                {callInfo?.customer?.customer_name || 'Customer'}
              </p>
              {callInfo?.customer?.domain && (
                <p className="text-xs text-gray-400 truncate">{callInfo.customer.domain}</p>
              )}
            </div>
          </div>

          {/* Pre-answer customer card: plan + recent history. So the agent picks up
              already knowing who's calling and what they last reached out about. */}
          <div className="mb-3 space-y-1.5">
            {planLabel && (
              <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full ${planToneClass}`}>
                {planLabel}
              </span>
            )}
            {customerContext?.counts && (
              <div className="flex items-center gap-1 flex-wrap">
                {customerContext.counts.tickets_90d > 0 && (
                  <span className="text-[10px] text-gray-600 bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded-full">
                    🎫 {customerContext.counts.tickets_90d} tickets {customerContext.counts.open_tickets > 0 && <strong className="text-amber-700">· {customerContext.counts.open_tickets} open</strong>}
                  </span>
                )}
                {customerContext.counts.calls_90d > 0 && (
                  <span className="text-[10px] text-gray-600 bg-gray-50 border border-gray-200 px-1.5 py-0.5 rounded-full">
                    📞 {customerContext.counts.calls_90d} calls
                  </span>
                )}
              </div>
            )}
            {customerContext?.tickets?.length > 0 && (
              <div className="mt-1 text-[10px] text-gray-500">
                <span className="font-semibold">Last ticket:</span>{' '}
                <span className="text-gray-700">{customerContext.tickets[0].subject?.slice(0, 50)}{customerContext.tickets[0].subject?.length > 50 ? '…' : ''}</span>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleReject}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <PhoneOff className="w-4 h-4" /> Decline
            </button>
            <button
              onClick={handleAccept}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Phone className="w-4 h-4" /> Accept
            </button>
          </div>
        </div>
      )}

      {state === 'active' && (
        <div className="p-4">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-sm font-semibold text-gray-800">On Call</span>
              {/* Compact wave bars next to the title — reflects the customer's
                  voice in real time so the agent can see the line is two-way. */}
              <AudioWaveBars level={remoteLevel} bars={4} color="bg-green-500" maxHeight={14} minHeight={3} barWidth={2} />
              {isRecording && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  REC
                </span>
              )}
            </div>
            <span className="text-sm font-mono font-bold text-gray-700">{formatDuration(elapsed)}</span>
          </div>
          <p className="text-xs text-gray-500 mb-3 truncate">
            {callInfo?.customer?.customer_name || 'Customer'}
          </p>

          {/* Visible transfer-pending banner — sits above the action buttons
              so the agent can see something is happening while waiting for
              the target agent's response. Without it, A only saw a toast
              that fades after 4s and then had no on-screen feedback at all. */}
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
                <button onClick={() => setShowTransfer(false)}><X className="w-3.5 h-3.5 text-gray-400" /></button>
              </div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {/* Show only OTHER agents who are currently online — transferring to
                    self is nonsense and transferring to an offline agent means the
                    call will just hit nobody. is_online is set server-side from
                    the socket.io 'agents' room membership. Previously this filter
                    looked at a.is_active (a field the API never returned), so the
                    list was always empty — hence "No other agents available" even
                    when colleagues were online. */}
                {(() => {
                  const transferable = agents.filter(a => a.is_online && Number(a.id) !== Number(user?.id));
                  if (transferable.length === 0) {
                    return <p className="text-xs text-gray-400 text-center py-2">No other agents available</p>;
                  }
                  return transferable.map(a => (
                    <button
                      key={a.id}
                      disabled={transferring}
                      onClick={() => handleTransfer(a.id)}
                      className="w-full text-left px-2.5 py-1.5 text-xs bg-gray-50 hover:bg-indigo-50 hover:text-indigo-700 rounded-lg transition-colors truncate flex items-center gap-1.5"
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
            {/* Your mic activity strip — sits above the action buttons so the
                agent can confirm their mic is actually picking up sound. */}
            <div className="flex items-center justify-center gap-2 mb-2">
              <AudioWaveBars level={isMuted ? 0 : micLevel} bars={6} color="bg-indigo-500" maxHeight={14} minHeight={3} barWidth={2} />
              <span className="text-[10px] text-gray-400">Your mic</span>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={toggleMute}
                className={clsx(
                  'flex-1 flex items-center justify-center gap-1 px-2 py-2 rounded-lg text-xs font-medium transition-colors',
                  isMuted ? 'bg-amber-100 text-amber-700 hover:bg-amber-200' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                )}
              >
                {isMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button
                onClick={openTransfer}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-2 bg-blue-100 text-blue-700 hover:bg-blue-200 rounded-lg text-xs font-medium transition-colors"
              >
                <ArrowRightLeft className="w-3.5 h-3.5" /> Transfer
              </button>
              <button
                onClick={handleEndCall}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-xs font-medium transition-colors"
              >
                <PhoneOff className="w-3.5 h-3.5" /> End
              </button>
            </div>
            </>
          )}

          {/* Floating notepad — expand/collapse. Notes flow into the wrap-up modal
              automatically as the description if the agent chooses "Create ticket". */}
          <div className="mt-3 border-t border-gray-100 pt-2">
            <button
              onClick={() => setNotepadOpen(o => !o)}
              className="w-full flex items-center justify-between text-xs text-gray-600 hover:text-gray-800 px-1"
            >
              <span className="inline-flex items-center gap-1.5 font-medium">
                <StickyNote className="w-3.5 h-3.5 text-amber-500" />
                Quick notes {notepadText ? <span className="text-amber-700">·  {notepadText.length} chars</span> : null}
              </span>
              {notepadOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {notepadOpen && (
              <textarea
                value={notepadText}
                onChange={e => setNotepadText(e.target.value)}
                placeholder="Type as you listen — these notes carry into the wrap-up ticket if needed…"
                rows={4}
                className="w-full mt-1.5 text-xs border border-amber-200 bg-amber-50/40 rounded-md p-2 resize-none focus:outline-none focus:ring-1 focus:ring-amber-300"
              />
            )}
          </div>
        </div>
      )}

      {/* Wrap-up popup — appears after call ends if call was actually connected.
          Three explicit choices; "Resolved" is the default. Auto-dismisses after 30s
          if the agent doesn't act, treated as "Resolved" silently. */}
      {state === 'wrapup' && wrapup && (
        <WrapupPanel
          wrapup={wrapup}
          submitting={wrapupSubmitting}
          onResolved={handleWrapupResolved}
          onCreateTicket={handleWrapupCreateTicket}
          onSkip={handleWrapupSkip}
        />
      )}
    </div>
    </>
  );
}

// Wrap-up panel — separate component so it can manage its own auto-dismiss timer
function WrapupPanel({ wrapup, submitting, onResolved, onCreateTicket, onSkip }) {
  const [secondsLeft, setSecondsLeft] = useState(30);
  useEffect(() => {
    const t = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { clearInterval(t); onResolved(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [onResolved]);
  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles className="w-4 h-4 text-indigo-500" />
        <span className="text-sm font-bold text-gray-800">Call wrap-up</span>
        <span className="ml-auto text-[10px] text-gray-400">Auto-close in {secondsLeft}s</span>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        <strong>{wrapup.customerName}</strong> · {Math.floor(wrapup.durationSec / 60)}m {wrapup.durationSec % 60}s
        {wrapup.notes ? ' · notes ready' : ''}
      </p>
      <div className="space-y-1.5">
        <button
          onClick={onResolved}
          disabled={submitting}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
        >
          <CheckCircle2 className="w-3.5 h-3.5" /> Resolved
        </button>
        <button
          onClick={onCreateTicket}
          disabled={submitting || !wrapup.customerId}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
        >
          {submitting
            ? <><span className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" /> Creating…</>
            : <><Ticket className="w-3.5 h-3.5" /> Create follow-up ticket</>}
        </button>
        <button
          onClick={onSkip}
          disabled={submitting}
          className="w-full px-3 py-1.5 text-[11px] text-gray-500 hover:text-gray-700"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
