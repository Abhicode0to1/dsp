const router = require('express').Router();
const { getTicketSummaryForCustomerPortalUser, listTicketsForCustomerPortalAdmin } = require('../integrations/customerPortalTicketSummary');

// Service-to-service auth — no customer JWT involved, this is server-to-server
// (Customer Panel backend -> DSP backend). Same pattern as the existing
// billing webhook's X-Webhook-Secret check in syncController.js.
function requireIntegrationKey(req, res, next) {
  const key = process.env.INTEGRATION_API_KEY;
  if (!key) {
    console.error('[integrations] INTEGRATION_API_KEY is not configured — refusing request');
    return res.status(503).json({ error: 'Integration not configured' });
  }
  if (req.headers['x-integration-key'] !== key) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/integrations/customer-portal/ticket-count?dmsUserId=...
// Read-only — does NOT create a DSP customer account if none exists yet.
router.get('/customer-portal/ticket-count', requireIntegrationKey, async (req, res) => {
  const dmsUserId = req.query.dmsUserId;
  if (!dmsUserId) return res.status(400).json({ error: 'Missing dmsUserId' });

  try {
    const summary = await getTicketSummaryForCustomerPortalUser(dmsUserId);
    res.json(summary);
  } catch (err) {
    console.error('[integrations] ticket-count lookup failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/integrations/customer-portal/tickets?status=open&page=1&limit=50
// Admin-facing list across ALL customers — merged into the Customer Panel's
// admin Support Tickets page alongside its own legacy tickets.
router.get('/customer-portal/tickets', requireIntegrationKey, async (req, res) => {
  const { status, page, limit } = req.query;
  try {
    const result = await listTicketsForCustomerPortalAdmin({
      status,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json(result);
  } catch (err) {
    console.error('[integrations] ticket list lookup failed:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
