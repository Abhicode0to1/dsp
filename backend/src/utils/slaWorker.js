const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { sendSlaBreachEmail, sendMail } = require('./emailUtils');
const { pickAgent } = require('./assignment');
const agentRegistry = require('./agentRegistry');
const { getIntSetting, getSetting } = require('./settings');
const { heartbeat } = require('./heartbeat');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// In-memory queue of breached tickets waiting to be included in the next
// daily digest. The per-tick worker (every 15 min) used to send one email
// per breach × per admin — 50 phantom tickets × 3 admins = 150 emails in a
// burst. Now breaches are collected here and a single 9am digest goes out.
//
// Persistence trade-off: this is in-memory only. If the backend restarts
// before 9am, the queue is lost — but the underlying tickets are still
// flagged `sla_breached=TRUE` in the DB and the in-app sla_breach socket
// event has already fired, so admins haven't lost visibility, just the
// summary email. Acceptable for now. Promote to a DB column if you ever
// need restart-safe digesting.
const breachDigestQueue = [];

// Run auto-close daily at midnight
function startAutoCloseWorker() {
  cron.schedule('0 0 * * *', async () => {
    try {
      const [[setting]] = await pool.query(
        "SELECT value FROM admin_settings WHERE `key` = 'auto_close_days'"
      );
      const days = parseInt(setting?.value || '14');
      if (!days || days < 1) return;

      const [stale] = await pool.query(
        `SELECT id, subject FROM tickets
         WHERE status IN ('open','pending')
           AND updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)
           AND merged_into IS NULL`,
        [days]
      );

      if (!stale.length) return;

      const ids = stale.map(t => t.id);
      const ph = ids.map(() => '?').join(',');
      await pool.query(
        `UPDATE tickets SET status = 'closed', closed_at = COALESCE(closed_at, NOW()), updated_at = NOW() WHERE id IN (${ph})`,
        ids
      );

      for (const t of stale) {
        await pool.query(
          'INSERT INTO ticket_messages (ticket_id, sender_id, message) VALUES (?, ?, ?)',
          [t.id, 1, `[Auto-closed] Ticket closed automatically after ${days} days of inactivity`]
        );
      }

      console.log(`[Auto-close] Closed ${stale.length} stale ticket(s)`);
    } catch (err) {
      console.error('[Auto-close Worker error]', err.message);
    }
  });
}

// Run every 15 minutes
function startSlaWorker(io) {
  startAutoCloseWorker();

  cron.schedule('*/15 * * * *', async () => {
    try {
      // Set SLA deadlines on new tickets that don't have them yet
      await pool.query(`
        UPDATE tickets t
        JOIN sla_configs s ON s.priority = t.priority
        SET
          t.sla_response_due = DATE_ADD(t.created_at, INTERVAL s.response_hours HOUR),
          t.sla_resolve_due  = DATE_ADD(t.created_at, INTERVAL s.resolve_hours HOUR)
        WHERE t.sla_response_due IS NULL AND t.status != 'closed'
      `);

      // ── SLA Approaching Warning ────────────────────────────────────────────
      // Warn assigned agent when the time elapsed crosses `ticket_warning_pct`
      // of the response-SLA window (default 80%). Hardcoded to "1 hour before
      // breach" before this was configurable — admin couldn't tune sensitivity.
      const warnPct = await getIntSetting('ticket_warning_pct', 80);
      const [approaching] = await pool.query(`
        SELECT t.id, t.subject, t.priority, t.assigned_agent_id,
               t.sla_response_due
        FROM tickets t
        WHERE t.status != 'closed'
          AND t.sla_breached = FALSE
          AND t.first_response_at IS NULL
          AND t.sla_response_due IS NOT NULL
          AND t.sla_response_due > NOW()
          AND t.assigned_agent_id IS NOT NULL
          AND TIMESTAMPDIFF(SECOND, t.created_at, NOW())
              >= TIMESTAMPDIFF(SECOND, t.created_at, t.sla_response_due) * ? / 100
      `, [warnPct]);

      for (const ticket of approaching) {
        const minsLeft = Math.max(0, Math.floor(
          (new Date(ticket.sla_response_due) - new Date()) / 60000
        ));
        if (io) {
          io.to(`user_${ticket.assigned_agent_id}`).emit('sla_warning', {
            ticketId: ticket.id,
            subject: ticket.subject,
            priority: ticket.priority,
            minsLeft,
          });
        }
        console.log(`[SLA] Warning sent for ticket #${ticket.id} — ${minsLeft}m left`);
      }

      // ── SLA Breach Detection ───────────────────────────────────────────────
      const [breached] = await pool.query(`
        SELECT t.id, t.subject, t.priority, t.status,
               t.sla_response_due, t.sla_resolve_due, t.first_response_at,
               t.assigned_agent_id,
               u.name AS customer_name
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        JOIN users u ON u.id = c.user_id
        WHERE t.status != 'closed'
          AND t.sla_breached = FALSE
          AND (
            (t.first_response_at IS NULL AND t.sla_response_due < NOW())
            OR (t.sla_resolve_due < NOW())
          )
      `);

      if (!breached.length) return;

      // 'escalate' bumps the ticket priority, 'notify_admin' emails admins
      // (daily digest), 'both' does both, 'none' marks breached + emits the
      // socket event but takes no other action. Default is 'notify_admin'.
      const breachAction = (await getSetting('ticket_breach_action', 'notify_admin')).toString();

      const [admins] = await pool.query(
        "SELECT email FROM users WHERE role = 'admin' AND is_active = TRUE"
      );
      const adminEmails = admins.map(a => a.email);
      const PRIORITY_UP = { low: 'normal', normal: 'medium', medium: 'high', high: 'urgent' };

      for (const ticket of breached) {
        const breachType = ticket.first_response_at === null && new Date(ticket.sla_response_due) < new Date()
          ? 'Response' : 'Resolution';

        await pool.query('UPDATE tickets SET sla_breached = TRUE WHERE id = ?', [ticket.id]);

        // Auto-escalate by priority bump if configured. The next-tier priority
        // also picks up a tighter SLA from sla_configs, but we leave the
        // existing sla_response_due in place — the breach already happened,
        // pulling the deadline forward would just cause cascading breaches.
        if (breachAction === 'escalate' || breachAction === 'both') {
          const newPri = PRIORITY_UP[ticket.priority];
          if (newPri) {
            await pool.query('UPDATE tickets SET priority = ? WHERE id = ?', [newPri, ticket.id]);
            if (io && ticket.assigned_agent_id) {
              io.to(`user_${ticket.assigned_agent_id}`).emit('ticket_escalated', {
                ticketId: ticket.id, subject: ticket.subject,
                newPriority: newPri, reason: `${breachType} SLA breach`,
              });
            }
          }
        }

        // Daily-digest email queue — only when action includes admin notify.
        if (breachAction === 'notify_admin' || breachAction === 'both') {
          breachDigestQueue.push({
            ticketId: ticket.id,
            subject: ticket.subject,
            customerName: ticket.customer_name,
            priority: ticket.priority,
            breachType,
            breachedAt: new Date().toISOString(),
            adminEmails,
          });
        }

        if (io) {
          // Broadcast to all agents room (admin dashboards, etc.)
          io.to('agents').emit('sla_breach', {
            ticketId: ticket.id,
            subject: ticket.subject,
            priority: ticket.priority,
            breachType,
          });

          // Direct urgent alert to the assigned agent only
          if (ticket.assigned_agent_id) {
            io.to(`user_${ticket.assigned_agent_id}`).emit('sla_breach_agent', {
              ticketId: ticket.id,
              subject: ticket.subject,
              priority: ticket.priority,
              breachType,
            });
          }
        }

        console.log(`[SLA] Ticket #${ticket.id} breached ${breachType} SLA`);
      }
      await heartbeat('slaWorker', { status: 'ok', intervalSeconds: 15 * 60 });
    } catch (err) {
      console.error('[SLA Worker error]', err.message);
      await heartbeat('slaWorker', { status: 'error', error: err.message, intervalSeconds: 15 * 60 });
    }
  });

  // ── Queue SLA: warn admin when customers wait too long ────────────────────
  cron.schedule('*/5 * * * *', async () => {
    try {
      const [[setting]] = await pool.query(
        "SELECT value FROM admin_settings WHERE `key` = 'queue_sla_minutes'"
      );
      const maxWait = parseInt(setting?.value || '5');

      const [stale] = await pool.query(`
        SELECT ch.id, ch.created_at, u.name AS customer_name
        FROM chats ch
        JOIN customers c ON c.id = ch.customer_id
        JOIN users u ON u.id = c.user_id
        WHERE ch.status = 'waiting'
          AND ch.queue_warned = 0
          AND TIMESTAMPDIFF(MINUTE, ch.created_at, NOW()) >= ?
      `, [maxWait]);

      for (const chat of stale) {
        const minsWaiting = Math.floor((Date.now() - new Date(chat.created_at)) / 60000);
        if (io) {
          // Mirror to chat_monitors so admins watching the queue see SLA alerts too.
          io.to('agents').to('chat_monitors').emit('queue_sla_alert', {
            chatId: chat.id,
            customerName: chat.customer_name,
            minsWaiting,
          });
        }
        await pool.query('UPDATE chats SET queue_warned = 1 WHERE id = ?', [chat.id]);
        console.log(`[Queue SLA] Chat #${chat.id} waiting ${minsWaiting}m — alert sent`);
      }
    } catch (err) {
      console.error('[Queue SLA error]', err.message);
    }
  });

  // ── Auto-Escalation: bump priority on stale unanswered tickets ───────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const PRIORITY_UP = { low: 'normal', normal: 'medium', medium: 'high', high: 'urgent' };

      // Tickets where customer sent last message and agent hasn't replied in 24h
      const [stale] = await pool.query(`
        SELECT t.id, t.priority, t.subject, t.assigned_agent_id,
               u.name AS customer_name
        FROM tickets t
        JOIN customers c ON c.id = t.customer_id
        JOIN users u ON u.id = c.user_id
        WHERE t.status IN ('open','pending')
          AND t.priority != 'urgent'
          AND t.merged_into IS NULL
          AND t.updated_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)
          AND (
            SELECT sender_role FROM (
              SELECT tm.sender_id,
                     CASE WHEN usr.role IN ('agent','admin') THEN 'agent' ELSE 'customer' END AS sender_role
              FROM ticket_messages tm
              JOIN users usr ON usr.id = tm.sender_id
              WHERE tm.ticket_id = t.id
              ORDER BY tm.created_at DESC LIMIT 1
            ) AS last_msg
          ) = 'customer'
      `);

      for (const ticket of stale) {
        const newPriority = PRIORITY_UP[ticket.priority] || 'urgent';
        await pool.query(
          'UPDATE tickets SET priority = ?, updated_at = NOW() WHERE id = ?',
          [newPriority, ticket.id]
        );
        await pool.query(
          'INSERT INTO ticket_internal_notes (ticket_id, agent_id, note) VALUES (?, 1, ?)',
          [ticket.id, `[Auto-escalated] Priority raised from ${ticket.priority} to ${newPriority} — no agent reply in 24h`]
        );
        if (io && ticket.assigned_agent_id) {
          io.to(`user_${ticket.assigned_agent_id}`).emit('ticket_escalated', {
            ticketId: ticket.id,
            subject: ticket.subject,
            oldPriority: ticket.priority,
            newPriority,
          });
        }
        console.log(`[Auto-escalate] Ticket #${ticket.id}: ${ticket.priority} → ${newPriority}`);
      }
    } catch (err) {
      console.error('[Auto-escalation error]', err.message);
    }
  });

  // ── Watchdog: reassign tickets where the assigned agent has been offline >24h ──
  // Runs every 4 hours. Prevents tickets from getting stuck on agents who don't
  // log in. Skips closed/resolved and the urgent-but-fresh tickets.
  cron.schedule('15 */4 * * *', async () => {
    try {
      const [stuck] = await pool.query(`
        SELECT t.id, t.subject, t.priority, t.assigned_agent_id, t.customer_id,
               u.name AS agent_name
        FROM tickets t
        JOIN users u ON u.id = t.assigned_agent_id
        WHERE t.status IN ('open','pending')
          AND t.merged_into IS NULL
          AND t.assigned_agent_id IS NOT NULL
          AND t.updated_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `);

      let reassigned = 0;
      for (const t of stuck) {
        // Skip if agent is currently online — they may just be slow
        if (agentRegistry.getStatus(t.assigned_agent_id) === 'online') continue;

        // Try to find a fresh agent (excluding the stuck one)
        const { agentId, reason } = await pickAgent({
          io,
          channel: 'ticket',
          customerId: t.customer_id,
          priority: t.priority,
          excludeUserIds: [t.assigned_agent_id],
          requireOnline: false,
        });
        if (!agentId || agentId === t.assigned_agent_id) continue;

        await pool.query('UPDATE tickets SET assigned_agent_id = ?, updated_at = NOW() WHERE id = ?', [agentId, t.id]);
        await pool.query(
          'INSERT INTO ticket_internal_notes (ticket_id, agent_id, note) VALUES (?, 1, ?)',
          [t.id, `[Watchdog] Reassigned from ${t.agent_name} (offline >24h) to another agent via ${reason}`]
        );
        if (io) {
          io.to(`user_${agentId}`).emit('ticket_assigned', {
            ticketId: t.id, subject: t.subject, customerName: 'Watchdog reassignment',
            reason: 'watchdog',
          });
        }
        reassigned++;
      }
      if (reassigned > 0) console.log(`[Watchdog] Reassigned ${reassigned} stuck ticket(s)`);
    } catch (err) {
      console.error('[Watchdog error]', err.message);
    }
  });

  // ── Call recording cleanup — delete recordings older than 30 days ────────
  // Runs daily at 02:30 (server local time). Deletes file from disk, file_attachments
  // row, and clears the FK on calls so the admin UI shows "—" for the recording.
  cron.schedule('30 2 * * *', async () => {
    try {
      const [stale] = await pool.query(`
        SELECT fa.id, fa.stored_name FROM file_attachments fa
        WHERE fa.ref_type = 'call_recording'
          AND fa.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
      `);
      if (!stale.length) return;

      // Only delete DB rows for files we successfully removed from disk.
      // Keeps orphans recoverable; cron will retry them tomorrow.
      const successfulIds = [];
      let deletedFiles = 0;
      for (const att of stale) {
        const p = path.join(UPLOAD_DIR, att.stored_name);
        try {
          if (fs.existsSync(p)) {
            fs.unlinkSync(p);
            deletedFiles++;
          }
          // If file doesn't exist on disk, treat as already-deleted and clean the row too
          successfulIds.push(att.id);
        } catch (err) {
          console.error('[Recording cleanup] file delete failed (keeping DB row for retry):', att.stored_name, err.message);
        }
      }

      if (successfulIds.length) {
        const ph = successfulIds.map(() => '?').join(',');
        await pool.query(
          `UPDATE calls SET recording_attachment_id = NULL WHERE recording_attachment_id IN (${ph})`,
          successfulIds
        );
        await pool.query(`DELETE FROM file_attachments WHERE id IN (${ph})`, successfulIds);
      }
      console.log(`[Recording cleanup] Removed ${successfulIds.length}/${stale.length} recording row(s), ${deletedFiles} file(s) from disk`);
    } catch (err) {
      console.error('[Recording cleanup error]', err.message);
    }
  });

  // ── Audit log auto-prune (daily at 03:00 local) ─────────────────────────
  // Drops audit_log rows older than `audit_retention_days` (admin setting,
  // default 180). Without this the table grows forever — even a small panel
  // can reach a million rows over a year. Admin can raise the retention if
  // they need a longer compliance window.
  cron.schedule('0 3 * * *', async () => {
    try {
      const days = await getIntSetting('audit_retention_days', 180);
      if (!days || days < 1) return;
      const [r] = await pool.query(
        'DELETE FROM audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
        [days]
      );
      if (r.affectedRows > 0) {
        console.log(`[Audit prune] Deleted ${r.affectedRows} audit_log rows older than ${days} days`);
      }
    } catch (err) {
      console.error('[Audit prune error]', err.message);
    }
  });

  // ── SLA breach digest (daily at 09:00 local) ────────────────────────────
  // Replaces the old per-breach-per-admin email blast that could fire 100+
  // emails in a single worker tick during a backlog. Sends ONE summary per
  // admin per day. If the queue is empty (no breaches today) we don't send
  // anything — admins only hear from us when there's real news.
  cron.schedule('0 9 * * *', async () => {
    try {
      if (!breachDigestQueue.length) return;
      const drained = breachDigestQueue.splice(0, breachDigestQueue.length);

      // Group recipients across all queued breaches. An admin only gets the
      // digest if they were active when the breach was queued (captured in
      // adminEmails at breach time).
      const recipients = new Set();
      for (const b of drained) for (const e of b.adminEmails || []) recipients.add(e);

      if (!recipients.size) return;

      const sorted = drained.sort((a, b) => (a.priority === 'urgent' ? -1 : 1));
      const link = `${process.env.FRONTEND_URL}/admin/tickets`;
      const rows = sorted.map(b => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9"><strong>#${b.ticketId}</strong></td>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${b.subject || ''}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${b.customerName || ''}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;text-transform:capitalize">${b.priority || ''}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#b91c1c">${b.breachType} SLA</td>
        </tr>`).join('');

      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f6fb;padding:32px 0">
          <div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
            <div style="background:#dc2626;padding:20px 28px;color:#fff;font-size:18px;font-weight:700">
              ⚠ SLA Breach Digest — ${drained.length} ticket(s)
            </div>
            <div style="padding:24px 28px;color:#374151;font-size:13px;line-height:1.6">
              <p>The following tickets breached their SLA since the last digest:</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:12px">
                <thead>
                  <tr style="background:#f8fafc;text-align:left">
                    <th style="padding:8px;border-bottom:1px solid #e5e7eb">ID</th>
                    <th style="padding:8px;border-bottom:1px solid #e5e7eb">Subject</th>
                    <th style="padding:8px;border-bottom:1px solid #e5e7eb">Customer</th>
                    <th style="padding:8px;border-bottom:1px solid #e5e7eb">Priority</th>
                    <th style="padding:8px;border-bottom:1px solid #e5e7eb">Breach</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
              <p style="text-align:center;margin-top:24px">
                <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600">Open Admin Tickets →</a>
              </p>
              <p style="font-size:11px;color:#9ca3af;margin-top:20px">
                You're receiving this because you have an admin account on the support panel.
                Real-time alerts still appear in the dashboard — this digest is just for archival.
              </p>
            </div>
          </div>
        </div>`;

      for (const to of recipients) {
        await sendMail({
          to,
          subject: `[SLA Digest] ${drained.length} ticket(s) breached SLA`,
          html,
        });
      }
      console.log(`[SLA Digest] sent to ${recipients.size} admin(s) covering ${drained.length} breached ticket(s)`);
    } catch (err) {
      console.error('[SLA Digest error]', err.message);
    }
  });

  console.log('[SLA Worker] Started (runs every 15 min; watchdog every 4h; recording cleanup daily 02:30; breach digest daily 09:00)');
}

module.exports = { startSlaWorker };
