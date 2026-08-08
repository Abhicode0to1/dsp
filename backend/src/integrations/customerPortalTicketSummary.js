/**
 * Phase 2 integration: Customer Panel (domain-management-system) -> Support
 * Panel ticket-count lookup.
 *
 * Read-only, server-to-server (no browser/customer involved) — powers the
 * "Active Tickets" card on the Customer Panel dashboard. Deliberately does
 * NOT reuse the Phase 1 SSO/upsert path: that path auto-creates a DSP
 * customer account, which would fire on every dashboard page view for every
 * Customer Panel user, not just people who've actually used Support. This
 * just looks up whether a linked DSP customer already exists and, if so,
 * counts their non-closed tickets — no account is ever created here.
 */

const { pool } = require('../config/database');

/**
 * @param {string} dmsUserId - the Customer Panel's user id (matches
 *   customers.billing_customer_id, set by the Phase 1 SSO upsert)
 * @returns {Promise<{ hasAccount: boolean, openTickets: number }>}
 */
async function getTicketSummaryForCustomerPortalUser(dmsUserId) {
  const [[customer]] = await pool.query(
    'SELECT id FROM customers WHERE billing_customer_id = ?',
    [dmsUserId]
  );
  if (!customer) {
    return { hasAccount: false, openTickets: 0 };
  }

  const [[{ openTickets }]] = await pool.query(
    "SELECT COUNT(*) AS openTickets FROM tickets WHERE customer_id = ? AND status IN ('open', 'pending')",
    [customer.id]
  );

  return { hasAccount: true, openTickets };
}

/**
 * Admin-facing (not scoped to one customer) — powers the Customer Panel's
 * admin Support Tickets page, merged alongside its own legacy Mongo-backed
 * tickets. Speaks DSP's own native status vocabulary ('open' | 'pending' |
 * 'closed'); the caller maps its own tab labels onto that, DSP doesn't need
 * to know about the Customer Panel's UI concepts.
 *
 * @param {{ status?: 'open'|'pending'|'closed', page?: number, limit?: number }} opts
 * @returns {Promise<{ tickets: object[], total: number }>}
 */
async function listTicketsForCustomerPortalAdmin({ status, page = 1, limit = 50 } = {}) {
  const validStatuses = ['open', 'pending', 'closed'];
  const where = status && validStatuses.includes(status) ? 'WHERE t.status = ?' : '';
  const params = where ? [status] : [];
  const offset = (Math.max(1, page) - 1) * limit;

  const [tickets] = await pool.query(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
            u.name AS customer_name, u.email AS customer_email,
            (SELECT COUNT(*) FROM ticket_messages tm WHERE tm.ticket_id = t.id) AS message_count
     FROM tickets t
     JOIN customers c ON c.id = t.customer_id
     JOIN users u ON u.id = c.user_id
     ${where}
     ORDER BY t.updated_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM tickets t ${where}`,
    params
  );

  return { tickets, total };
}

module.exports = { getTicketSummaryForCustomerPortalUser, listTicketsForCustomerPortalAdmin };
