const router = require('express').Router();
const {
  getAgentDashboard,
  getAgentTickets,
  updateTicket,
  replyToTicket,
  requestReassignment,
  getPendingChats,
  getMyChats,
  acceptChat,
  getChatMessages,
  getCustomerDetail,
  getAgentList,
  searchCustomers,
  createAgentTicket,
  getAgentTicketDetail,
  convertChatToTicket,
  getInternalNotes,
  addInternalNote,
  deleteInternalNote,
  addTimeLog,
  getMacros,
  createMacro,
  deleteMacro,
  mergeTicket,
  getRelatedTickets,
  bulkUpdateTickets,
  getAgentTemplates,
  getMyPerformance,
  getCustomerHistory,
  getChatNotes,
  addChatNote,
  deleteChatNote,
  getAgentChatArchive,
  getAgentArchivedMessages,
  claimTicket,
  getMyCalls,
  saveCallNotes,
} = require('../controllers/agentController');
const { transferChat, emailTranscript } = require('../controllers/chatController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);
router.use(requireRole('agent', 'admin'));

router.get('/dashboard',            getAgentDashboard);
router.get('/agents',               getAgentList);
router.get('/customers/search',     searchCustomers);

// Tickets
router.get('/tickets',              getAgentTickets);
router.post('/tickets/bulk',        bulkUpdateTickets);
router.post('/tickets/create',      createAgentTicket);
router.get('/tickets/:id',          getAgentTicketDetail);
router.put('/tickets/:id',          updateTicket);
router.post('/tickets/:id/reply',   replyToTicket);
router.post('/tickets/:id/request-reassignment', requestReassignment);
router.post('/tickets/:id/claim',   claimTicket);
router.post('/tickets/:id/merge',   mergeTicket);
router.get('/tickets/:id/related',  getRelatedTickets);

// Internal notes
router.get('/tickets/:id/notes',    getInternalNotes);
router.post('/tickets/:id/notes',   addInternalNote);
router.delete('/tickets/:id/notes/:noteId', deleteInternalNote);

// Time logs
router.post('/tickets/:id/time-log', addTimeLog);

// Macros
router.get('/macros',               getMacros);
router.post('/macros',              createMacro);
router.delete('/macros/:id',        deleteMacro);

// Templates (read-only)
router.get('/templates',            getAgentTemplates);

// Performance
router.get('/my-performance',       getMyPerformance);
router.get('/calls/mine',           getMyCalls);
router.post('/calls/:id/notes',     saveCallNotes);

// Canned chat snippets — read-only picker + usage bump. CRUD lives under
// /admin/canned-responses (templateController.js).
{
  const { getCannedResponses, bumpCannedResponseUsage } = require('../controllers/templateController');
  router.get('/canned-responses', getCannedResponses);
  router.post('/canned-responses/:id/used', bumpCannedResponseUsage);
}

// Chats
router.get('/chats/pending',        getPendingChats);
router.get('/chats/mine',           getMyChats);
router.get('/chats/archive',        getAgentChatArchive);
router.get('/chats/archive/:id/messages', getAgentArchivedMessages);
router.put('/chats/:id/accept',     acceptChat);
router.get('/chats/:id/messages',   getChatMessages);
router.get('/chats/:id/notes',      getChatNotes);
router.post('/chats/:id/notes',     addChatNote);
router.delete('/chats/:id/notes/:noteId', deleteChatNote);
router.post('/chats/:id/convert-to-ticket', convertChatToTicket);
router.post('/chats/:id/transfer',          transferChat);
router.post('/chats/:id/transcript',        emailTranscript);

router.get('/customers/:id/history', getCustomerHistory);
router.get('/customers/:id',        getCustomerDetail);

module.exports = router;
