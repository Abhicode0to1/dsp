import { useEffect, useState, useRef, useCallback } from 'react';
import useImagePaste from '../../hooks/useImagePaste';
import { useParams, useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { TicketStatusBadge, PriorityBadge } from '../../components/common/PlanBadge';
import CsatModal from '../../components/common/CsatModal';
import { getTicketById, addTicketMessage, getAttachments, uploadAttachment, deleteAttachment, getAttachmentDownloadUrl, getCsatSettings, getRating, closeTicket, reopenTicket, updateTicketCcEmails } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { useSocket } from '../../contexts/SocketContext';
import { ArrowLeft, Send, User, Headphones, Paperclip, Download, Trash2, X, RotateCcw, Copy, Check, ZoomIn, XCircle, Mail, ArrowRightLeft } from 'lucide-react';
import { timeAgo, fullDate } from '../../utils/timeAgo';
import { renderMarkdown } from '../../utils/renderMarkdown';
import toast from 'react-hot-toast';
import clsx from 'clsx';

export default function CustomerTicketDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { socket } = useSocket();
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) return;
    window.dispatchEvent(new CustomEvent('notification:viewed', { detail: { ticketId: Number(id) } }));
  }, [id]);

  // Live update when admin reassigns this ticket to a new agent — update the
  // header agent name and drop a system-style notice into the message thread
  // so the customer knows about the handoff without waiting on the 30 s poll.
  useEffect(() => {
    if (!socket || !id) return;
    const onTransfer = ({ ticketId, newAgentName, fromAgentName }) => {
      if (Number(ticketId) !== Number(id)) return;
      setTicket(t => t ? { ...t, agent_name: newAgentName } : t);
      setMessages(prev => [...prev, {
        id: `xfer-${Date.now()}`,
        sender_role: 'system',
        sender_name: 'System',
        message: `Ticket transferred to ${newAgentName}${fromAgentName ? ` from ${fromAgentName}` : ''}.`,
        created_at: new Date().toISOString(),
      }]);
      toast.success(`Now assigned to ${newAgentName}`);
    };
    socket.on('ticket_transferred_to_customer', onTransfer);
    return () => socket.off('ticket_transferred_to_customer', onTransfer);
  }, [socket, id]);
  const [ticket, setTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [showCsat, setShowCsat] = useState(false);
  const [gmbUrl, setGmbUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState(null);
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);
  const ticketRef = useRef(null);
  const prevMsgCountRef = useRef(0);
  const ccInputRef = useRef(null);

  const [ccEmails, setCcEmails] = useState([]);
  const [ccInput,  setCcInput]  = useState('');
  const [ccError,  setCcError]  = useState('');
  const [ccDirty,  setCcDirty]  = useState(false);
  const [savingCc, setSavingCc] = useState(false);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const addCcEmail = (raw) => {
    const email = String(raw).trim().toLowerCase();
    if (!email) return;
    if (!EMAIL_RE.test(email)) { setCcError(`"${email}" is not a valid email`); return; }
    if (ccEmails.includes(email)) { setCcError('Already added'); return; }
    setCcEmails(p => [...p, email]);
    setCcInput('');
    setCcError('');
    setCcDirty(true);
  };

  const handleCcKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault(); addCcEmail(ccInput);
    }
    if (e.key === 'Backspace' && !ccInput && ccEmails.length) {
      setCcEmails(p => p.slice(0, -1));
      setCcDirty(true);
    }
  };

  const handleCcPaste = (e) => {
    e.preventDefault();
    e.clipboardData.getData('text').split(/[\s,;]+/).forEach(addCcEmail);
  };

  const removeCc = (email) => {
    setCcEmails(p => p.filter(x => x !== email));
    setCcDirty(true);
  };

  const saveCcs = async () => {
    if (ccInput.trim()) addCcEmail(ccInput);
    setSavingCc(true);
    try {
      const res = await updateTicketCcEmails(id, ccEmails.join(', '));
      setCcDirty(false);
      const notified = res.data?.notified?.length || 0;
      const failed   = res.data?.failed || [];
      if (failed.length) {
        // Show the SMTP failure cause so the customer knows (Gmail daily-limit, blocked, etc.)
        const sample = failed[0]?.error || 'Email delivery failed';
        toast.error(
          `CC list saved, but ${failed.length} notification email${failed.length === 1 ? '' : 's'} failed to send: ${sample}`,
          { duration: 8000 }
        );
      } else {
        toast.success(notified > 0
          ? `CC list saved · ${notified} notification${notified === 1 ? '' : 's'} sent`
          : 'CC list saved');
      }
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save CCs');
    } finally {
      setSavingCc(false);
    }
  };

  const load = () =>
    getTicketById(id)
      .then(res => {
        setTicket(res.data.ticket);
        ticketRef.current = res.data.ticket;
        setMessages(res.data.messages);
      })
      .catch(() => toast.error('Failed to load ticket'))
      .finally(() => setLoading(false));

  const loadAttachments = () =>
    getAttachments('ticket', id)
      .then(res => setAttachments(res.data.attachments || []))
      .catch(() => {});

  useEffect(() => {
    load();
    loadAttachments();
    getCsatSettings().then(r => setGmbUrl(r.data.gmb_review_url || '')).catch(() => {});

    const interval = setInterval(() => {
      if (ticketRef.current?.status !== 'closed') {
        getTicketById(id)
          .then(res => {
            setTicket(res.data.ticket);
            ticketRef.current = res.data.ticket;
            setMessages(res.data.messages);
          })
          .catch(() => {});
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [id]);

  // Auto-show rating prompt once when ticket first loads closed and unrated
  const ratingChecked = useRef(false);
  useEffect(() => {
    if (!ticket || ticket.status !== 'closed' || ratingChecked.current) return;
    ratingChecked.current = true;
    getRating({ ref_type: 'ticket', ref_id: id })
      .then(r => { if (!r.data.rating) setTimeout(() => setShowCsat(true), 800); })
      .catch(() => {});
  }, [ticket?.status, id]);

  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  // Close lightbox on Escape key
  useEffect(() => {
    if (!lightboxSrc) return;
    const handler = (e) => { if (e.key === 'Escape') setLightboxSrc(null); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxSrc]);

  // Sync CC chip list from server whenever the ticket loads/refreshes (unless user has unsaved edits)
  useEffect(() => {
    if (ccDirty) return;
    const parsed = ticket?.cc_emails
      ? ticket.cc_emails.split(',').map(e => e.trim()).filter(Boolean)
      : [];
    setCcEmails(parsed);
  }, [ticket?.id, ticket?.cc_emails, ccDirty]);

  const handleReply = async (e) => {
    e.preventDefault();
    if (!reply.trim() && pendingFiles.length === 0) return;

    const optimisticId = `opt_${Date.now()}`;
    const optimistic = reply.trim() ? {
      id: optimisticId,
      sender_id: user.id,
      sender_name: user.name,
      sender_role: user.role,
      message: reply.trim(),
      created_at: new Date().toISOString(),
      _optimistic: true,
    } : null;

    if (optimistic) setMessages(m => [...m, optimistic]);
    const savedReply = reply;
    const savedFiles = pendingFiles;
    setReply('');
    setPendingFiles([]);
    setSending(true);

    try {
      const uploadedIds = [];
      for (const file of pendingFiles) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('ref_type', 'ticket');
        fd.append('ref_id', id);
        const up = await uploadAttachment(fd);
        const attId = up?.data?.attachment?.id;
        if (attId) uploadedIds.push(attId);
      }
      if (savedReply.trim()) {
        // Pass the just-uploaded attachment IDs so the reply notification email
        // can attach the files for CC recipients (who have no portal login).
        const res = await addTicketMessage(id, { message: savedReply, attachmentIds: uploadedIds });
        setMessages(m => m.map(msg => msg.id === optimisticId ? res.data.message : msg));
      }
      loadAttachments();
    } catch (err) {
      if (optimistic) setMessages(m => m.filter(msg => msg.id !== optimisticId));
      setReply(savedReply);
      setPendingFiles(savedFiles);
      toast.error(err.response?.data?.error || 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  const handleClose = async () => {
    if (!window.confirm('Are you sure you want to close this ticket?')) return;
    setClosing(true);
    try {
      await closeTicket(id);
      await load();
      toast.success('Ticket closed');
      setShowCsat(true);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to close ticket');
    } finally {
      setClosing(false);
    }
  };

  const handleReopen = async () => {
    try {
      await reopenTicket(id);
      await load();
      toast.success('Ticket reopened');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reopen ticket');
    }
  };

  const handleFileSelect = (e) => {
    const MAX = 25 * 1024 * 1024;
    const files = Array.from(e.target.files).filter(f => {
      if (f.size > MAX) { toast.error(`${f.name} is too large (max 25 MB)`); return false; }
      return true;
    });
    setPendingFiles(p => [...p, ...files]);
    e.target.value = '';
  };

  // Ctrl+V on the reply box queues screenshots the same way the Attach picker does.
  const onPasteImage = useCallback((file) => {
    if (file.size > 25 * 1024 * 1024) {
      toast.error(`${file.name} is too large (max 25 MB)`);
      return;
    }
    setPendingFiles(p => [...p, file]);
  }, []);
  const pasteRef = useImagePaste(onPasteImage);

  const handleDeleteAttachment = async (attId) => {
    try {
      await deleteAttachment(attId);
      setAttachments(a => a.filter(x => x.id !== attId));
      toast.success('Attachment removed');
    } catch { toast.error('Failed to delete attachment'); }
  };

  // 24-hour reopen window check
  const canReopen = (() => {
    if (!ticket || ticket.status !== 'closed') return false;
    const closedAt = ticket.closed_at || ticket.updated_at;
    return (Date.now() - new Date(closedAt).getTime()) < 24 * 3600000;
  })();

  if (loading) return <Layout><div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" /></div></Layout>;
  if (!ticket) return null;

  return (
    <Layout>
      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors"
          >
            <XCircle className="w-8 h-8" />
          </button>
          <img
            src={lightboxSrc}
            alt="Attachment"
            className="max-w-full max-h-[90vh] rounded-lg object-contain shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}

      {showCsat && (
        <CsatModal
          refType="ticket"
          refId={Number(id)}
          gmbUrl={gmbUrl}
          onClose={() => setShowCsat(false)}
        />
      )}

      <button onClick={() => navigate('/customer/tickets')} className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-800 mb-5 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Tickets
      </button>

      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="card p-5 mb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <p className="text-xs text-gray-400 font-mono">Ticket #{ticket.id}</p>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(`#${ticket.id} — ${ticket.subject}\n${window.location.href}`);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="text-gray-400 hover:text-indigo-600 transition-colors"
                  title="Copy ticket link"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
              <h1 className="text-lg font-bold text-gray-800 break-words">{ticket.subject}</h1>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
              <PriorityBadge priority={ticket.priority} />
              <TicketStatusBadge status={ticket.status} />
              {ticket.status !== 'closed' && (
                <button
                  onClick={handleClose}
                  disabled={closing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
                >
                  {closing
                    ? <span className="w-3 h-3 border-2 border-red-400 border-t-transparent rounded-full animate-spin" />
                    : <XCircle className="w-3.5 h-3.5" />}
                  Close
                </button>
              )}
            </div>
          </div>
          <p className="text-sm text-gray-600 mt-3 leading-relaxed whitespace-pre-wrap break-words">{renderMarkdown(ticket.description)}</p>
          <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
            <span>Created {new Date(ticket.created_at).toLocaleString('en-IN')}</span>
            {ticket.agent_name && <span>Agent: {ticket.agent_name}</span>}
          </div>
        </div>

        {/* Attachments */}
        {attachments.length > 0 && (
          <div className="card p-4 mb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Attachments ({attachments.length})</p>
            <div className="flex flex-wrap gap-3">
              {attachments.map(att => {
                const isImage = att.mime_type?.startsWith('image/');
                const url = getAttachmentDownloadUrl(att.id);
                return (
                  <div key={att.id} className={clsx('border border-gray-200 rounded-xl overflow-hidden', isImage ? 'w-32' : 'flex items-center gap-2 bg-gray-50 px-3 py-1.5')}>
                    {isImage ? (
                      <div className="relative group">
                        <img
                          src={url}
                          alt={att.original_name}
                          className="w-32 h-24 object-cover cursor-pointer"
                          onClick={() => setLightboxSrc(url)}
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                          <button onClick={() => setLightboxSrc(url)} className="p-1.5 bg-white rounded-lg text-gray-700 hover:text-indigo-600" title="View">
                            <ZoomIn className="w-3.5 h-3.5" />
                          </button>
                          <a href={url} download className="p-1.5 bg-white rounded-lg text-gray-700 hover:text-indigo-600" title="Download">
                            <Download className="w-3.5 h-3.5" />
                          </a>
                          {(user.role !== 'customer' || att.uploaded_by === user.id) && (
                            <button onClick={() => handleDeleteAttachment(att.id)} className="p-1.5 bg-white rounded-lg text-red-400 hover:text-red-600">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 truncate px-2 py-1 bg-gray-50">{att.original_name}</p>
                      </div>
                    ) : (
                      <>
                        <Paperclip className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                        <span className="text-xs text-gray-700 truncate max-w-[140px]">{att.original_name}</span>
                        <a href={url} download className="text-indigo-500 hover:text-indigo-700">
                          <Download className="w-3.5 h-3.5" />
                        </a>
                        {(user.role !== 'customer' || att.uploaded_by === user.id) ? (
                          <button onClick={() => handleDeleteAttachment(att.id)} className="text-red-400 hover:text-red-600">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Messages */}
        <div className="card overflow-hidden mb-4">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">
            Conversation ({messages.length})
          </div>
          <div
            className="p-5 space-y-4 overflow-y-auto resize-y"
            style={{ height: '500px', minHeight: '250px', maxHeight: '80vh' }}
          >
            {messages.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-8">No messages yet</p>
            )}
            {messages.map(m => {
              if (m.sender_role === 'system') {
                return (
                  <div key={m.id} className="flex justify-center">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">
                      <ArrowRightLeft className="w-3 h-3 flex-shrink-0" />
                      <span>{m.message}</span>
                    </div>
                  </div>
                );
              }
              const isMine = m.sender_id === user.id;
              return (
                <div key={m.id} className={clsx('flex gap-3', isMine ? 'flex-row-reverse' : 'flex-row')}>
                  <div className={clsx('w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold', isMine ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-700')}>
                    {isMine ? <User className="w-4 h-4" /> : <Headphones className="w-4 h-4" />}
                  </div>
                  <div className={clsx('max-w-sm', isMine ? 'items-end' : 'items-start', 'flex flex-col')}>
                    <div className={clsx(
                      'px-4 py-2.5 rounded-2xl text-sm whitespace-pre-wrap break-words',
                      isMine ? 'bg-indigo-600 text-white rounded-tr-sm' : 'bg-gray-100 text-gray-800 rounded-tl-sm',
                      m._optimistic && 'opacity-60'
                    )}>
                      {renderMarkdown(m.message)}
                    </div>
                    <p className="text-xs text-gray-400 mt-1" title={fullDate(m.created_at)}>
                      {m.sender_name} · {m._optimistic ? 'Sending…' : timeAgo(m.created_at)}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* CC Recipients — customer can manage who else gets email updates */}
        {ticket.status !== 'closed' && (
          <div className="card p-4 mb-4">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5 text-gray-500" /> CC Recipients
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                  They'll get email updates on this ticket. They cannot reply via the portal.
                </p>
              </div>
              {ccDirty && (
                <button
                  type="button"
                  onClick={saveCcs}
                  disabled={savingCc}
                  className="btn-primary text-xs py-1.5 px-3 flex-shrink-0 disabled:opacity-50"
                >
                  {savingCc ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
            <div
              className={`input flex flex-wrap gap-1.5 min-h-[42px] cursor-text ${ccError ? 'border-red-400' : ''}`}
              onClick={() => ccInputRef.current?.focus()}
            >
              {ccEmails.map(email => (
                <span key={email} className="inline-flex items-center gap-1 bg-indigo-100 text-indigo-700 text-xs font-medium px-2 py-0.5 rounded-full">
                  {email}
                  <button type="button" onClick={(e) => { e.stopPropagation(); removeCc(email); }}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
              <input
                ref={ccInputRef}
                type="email"
                className="flex-1 min-w-[160px] outline-none bg-transparent text-sm"
                placeholder={ccEmails.length === 0 ? 'Add email and press Enter or comma…' : ''}
                value={ccInput}
                onChange={e => { setCcInput(e.target.value); setCcError(''); }}
                onKeyDown={handleCcKeyDown}
                onPaste={handleCcPaste}
                onBlur={() => ccInput.trim() && addCcEmail(ccInput)}
              />
            </div>
            {ccError && <p className="text-xs text-red-500 mt-1">{ccError}</p>}
          </div>
        )}

        {/* Reply */}
        {ticket.status !== 'closed' && (
          <form onSubmit={handleReply} className="card p-4">
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 rounded-lg px-2 py-1 text-xs text-indigo-700">
                    <Paperclip className="w-3 h-3" />
                    <span className="truncate max-w-[120px]">{f.name}</span>
                    <button type="button" onClick={() => setPendingFiles(p => p.filter((_, j) => j !== i))}>
                      <X className="w-3 h-3 hover:text-red-600" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              data-testid="TicketDetail-ReplyInput"
              ref={pasteRef}
              className="input resize-y w-full"
              style={{ minHeight: '90px', maxHeight: '50vh' }}
              rows={4}
              placeholder="Write your reply…  (paste a screenshot with Ctrl+V · drag the bottom-right corner to resize)"
              value={reply}
              onChange={e => setReply(e.target.value)}
            />
            <div className="flex items-center justify-between mt-3">
              <div className="flex items-center gap-2">
                <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" multiple />
                <button data-testid="TicketDetail-AttachButton" type="button" onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-indigo-600 transition-colors">
                  <Paperclip className="w-4 h-4" /> Attach
                </button>
              </div>
              <button data-testid="TicketDetail-SendReplyButton" type="submit" disabled={sending || (!reply.trim() && pendingFiles.length === 0)} className="btn-primary">
                {sending
                  ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  : <><Send className="w-4 h-4" /> Send Reply</>}
              </button>
            </div>
          </form>
        )}

        {ticket.status === 'closed' && (
          <div className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-gray-500">
                This ticket is closed.{' '}
                <button onClick={() => setShowCsat(true)} className="text-amber-600 hover:underline font-medium">Rate your experience</button>
                {' '}or{' '}
                <button onClick={() => navigate('/customer/tickets/new')} className="text-indigo-600 hover:underline font-medium">open a new ticket</button>.
              </p>
              {canReopen ? (
                <button
                  onClick={handleReopen}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Reopen Ticket
                </button>
              ) : (
                <p className="text-xs text-gray-400 italic">Reopen window expired (24h limit)</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
