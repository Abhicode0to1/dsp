const router = require('express').Router();
const {
  getMyTickets,
  getTicketById,
  addMessage,
  botSuggest,
  aiKbSearch,
  closeTicket,
  reopenTicket,
  updateCcEmails,
} = require('../controllers/ticketController');
const { getTemplates } = require('../controllers/templateController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// Templates — available to all authenticated users
router.get('/templates',     requireRole('customer', 'agent', 'admin'), getTemplates);

// Customer-only: list, bot suggest. Direct ticket creation by customers is intentionally
// blocked — they must go through the bot at POST /api/customer/bot/ticket so contextual
// questions/templates/category routing apply. Agents/admins still have their own create
// endpoints under /api/agent/tickets and /api/admin/tickets.
router.get('/',              requireRole('customer'),              getMyTickets);
router.post('/bot-suggest',  requireRole('customer'),              botSuggest);
router.post('/ai-kb-search', requireRole('customer', 'agent', 'admin'), aiKbSearch);

// Customer + Agent + Admin: view detail and reply
router.get('/:id',            requireRole('customer', 'agent', 'admin'), getTicketById);
router.post('/:id/messages',  requireRole('customer', 'agent', 'admin'), addMessage);
router.put('/:id/close',      requireRole('customer'),                   closeTicket);
router.put('/:id/reopen',     requireRole('customer'),                   reopenTicket);
router.put('/:id/cc-emails',  requireRole('customer', 'agent', 'admin'), updateCcEmails);

module.exports = router;
