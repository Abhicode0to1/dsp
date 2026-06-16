const router = require('express').Router();
const { getDashboard, getCustomerPlans, initiateUpgrade, verifyUpgrade, logUpgradeFailure, botChat, botRaiseTicket, getAgentStatus, getCustomerSubscriptions, getCustomerInvoices, getCustomerQuotes, proxyInvoicePdf, proxyQuotePdf, initiateQuotePayment, verifyQuotePayment } = require('../controllers/customerController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);
router.use(requireRole('customer'));

router.get('/dashboard',          getDashboard);
router.get('/plans',              getCustomerPlans);
router.post('/upgrade/initiate',     initiateUpgrade);
router.post('/upgrade/verify',       verifyUpgrade);
router.post('/upgrade/log-failure',  logUpgradeFailure);
router.post('/bot',               botChat);
router.post('/bot/ticket',        botRaiseTicket);
router.get('/agent-status',       getAgentStatus);
router.get('/subscriptions',      getCustomerSubscriptions);
router.get('/invoices',           getCustomerInvoices);
router.get('/quotes',             getCustomerQuotes);
router.get('/invoices/:id/pdf',        proxyInvoicePdf);
router.get('/quotes/:id/pdf',           proxyQuotePdf);
router.post('/quotes/:id/pay/initiate', initiateQuotePayment);
router.post('/quotes/:id/pay/verify',   verifyQuotePayment);

module.exports = router;
