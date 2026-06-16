import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../../contexts/SocketContext';
import { ArrowRightLeft } from 'lucide-react';
import toast from 'react-hot-toast';

// Listens for `chat_transfer_offer` regardless of which agent page the
// receiver is on. Without this, the modal lived inside /agent/chats and an
// agent sitting on Dashboard / Tickets / Calls / Performance would miss the
// hand-off entirely. Mirrors how AgentCallOverlay handles incoming calls at
// the app level.
export default function IncomingChatTransferOverlay() {
  const { socket } = useSocket();
  const navigate = useNavigate();
  const [offer, setOffer] = useState(null);
  // Track the deadline timestamp so the modal can show a live "Xs remaining"
  // counter that matches the backend's 30 s timeout.
  const [secondsLeft, setSecondsLeft] = useState(null);
  const ringRef = useRef(null);

  // Continuous ringtone — agents on a different tab/page may not glance at
  // the modal otherwise. Cuts as soon as they accept, decline, or the
  // backend timeout cancels the offer.
  const stopRing = () => {
    const r = ringRef.current;
    if (!r) return;
    ringRef.current = null;
    try { r.source.stop(); } catch {}
    try { r.ctx.close(); } catch {}
  };
  const startRing = () => {
    if (ringRef.current) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const sampleRate = ctx.sampleRate;
      const totalSec = 3;
      const buffer = ctx.createBuffer(1, sampleRate * totalSec, sampleRate);
      const data = buffer.getChannelData(0);
      const ringSec = 1;
      const fade = sampleRate * 0.04;
      for (let i = 0; i < sampleRate * ringSec; i++) {
        const t = i / sampleRate;
        const env = i < fade ? (i / fade)
                  : i > sampleRate * ringSec - fade ? Math.max(0, (sampleRate * ringSec - i) / fade)
                  : 1;
        data[i] = 0.20 * env * 0.5 * (Math.sin(2 * Math.PI * 480 * t) + Math.sin(2 * Math.PI * 620 * t));
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(ctx.destination);
      const tryStart = () => { try { source.start(); } catch {} };
      if (ctx.state === 'suspended') ctx.resume().then(tryStart).catch(tryStart);
      else tryStart();
      ringRef.current = { ctx, source };
    } catch {}
  };

  useEffect(() => {
    if (!socket) return;
    const onOffer = (o) => {
      setOffer(o);
      setSecondsLeft(Math.round((o.timeoutMs || 30000) / 1000));
      startRing();
    };
    const onCancelled = ({ chatId }) => {
      setOffer(prev => {
        if (prev && Number(prev.chatId) === Number(chatId)) {
          stopRing();
          toast(`Transfer offer cancelled`, { icon: 'ℹ️' });
          return null;
        }
        return prev;
      });
    };
    socket.on('chat_transfer_offer', onOffer);
    socket.on('chat_transfer_cancelled', onCancelled);
    return () => {
      socket.off('chat_transfer_offer', onOffer);
      socket.off('chat_transfer_cancelled', onCancelled);
      stopRing();
    };
  }, [socket]);

  useEffect(() => {
    if (secondsLeft == null) return;
    if (secondsLeft <= 0) return;
    const t = setTimeout(() => setSecondsLeft(s => (s == null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [secondsLeft]);

  if (!offer) return null;

  const accept = () => {
    socket?.emit('accept_chat_transfer', { chatId: offer.chatId });
    stopRing();
    setOffer(null);
    setSecondsLeft(null);
    // Navigate to /agent/chats so the receiver lands on the page that hosts
    // the message thread + composer. Chats.jsx's `chat_transfer_accepted`
    // listener registers on mount and picks up the backend's confirmation.
    navigate('/agent/chats');
  };
  const decline = () => {
    socket?.emit('reject_chat_transfer', { chatId: offer.chatId });
    stopRing();
    setOffer(null);
    setSecondsLeft(null);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-[200] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center">
            <ArrowRightLeft className="w-4 h-4 text-amber-700" />
          </div>
          <h2 className="text-base font-bold text-gray-800">Incoming chat transfer</h2>
        </div>
        <p className="text-sm text-gray-600">
          <strong>{offer.fromAgent}</strong> wants to transfer a chat with{' '}
          <strong>{offer.customer?.customer_name || 'a customer'}</strong>
          {offer.customer?.domain ? ` (${offer.customer.domain})` : ''} to you.
        </p>
        {offer.transferNote && (
          <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
            <strong>Handoff note:</strong> {offer.transferNote}
          </div>
        )}
        <p className="text-[11px] text-gray-400 mt-3">
          Auto-declines in {secondsLeft != null ? `${secondsLeft} s` : '30 s'} if you don't respond.
        </p>
        <div className="flex gap-2 mt-4">
          <button type="button" onClick={decline} className="btn-secondary flex-1 justify-center">Decline</button>
          <button type="button" onClick={accept} className="btn-primary flex-1 justify-center flex items-center gap-1.5">
            <ArrowRightLeft className="w-4 h-4" /> Accept
          </button>
        </div>
      </div>
    </div>
  );
}
