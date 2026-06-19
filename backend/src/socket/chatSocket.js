const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { incrementCallUsage, incrementChatUsage } = require('../utils/planUtils');
const { sendChatAcceptedEmail, sendCallMissedEmail } = require('../utils/emailUtils');
const agentRegistry = require('../utils/agentRegistry');
const { pickAgent, getRoutingSettings, invalidateSettingsCache } = require('../utils/assignment');
const { sendPushToUser } = require('../utils/pushUtils');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Customer-facing display name. When the admin picks up a chat as overflow,
// showing "Admin User" in the customer's chat header makes them think their chat
// was escalated. Substitute a neutral label so the customer just sees "Support
// Agent" — internal agent panels still see the real name.
// Customer-facing display name. Admins are treated exactly like agents — the
// customer just sees the person's real name (the role is never exposed to
// customers anywhere). Falls back to a neutral label only when there's no name.
const customerDisplayName = (name, _role) =>
  (name && name.trim()) ? name.trim() : 'Support Agent';

// notifyCallMonitors — emits a lightweight ping to the call_monitors room so
// the admin's /admin/calls page refetches its list. Used at every meaningful
// call lifecycle transition (ring, accept, end, miss, redirect). The payload
// is intentionally bare — clients refetch from the canonical HTTP endpoint
// rather than try to patch their row from a partial socket payload.
function notifyCallMonitors(io) {
  try { io?.to('call_monitors').emit('call_list_changed'); } catch {}
}

// finalizeCallUsageIfBillable
// Used by call_end + the socket-disconnect cleanup. Increments the customer's
// monthly call_usage counter ONLY if the call lasted at least
// minBillableCallSeconds (default 30) of agent-connected time. Prevents the
// "agent picks up and immediately cuts" abuse pattern where the customer's
// quota was burned for a call that never delivered support. Also covers
// network-drop and disconnect-mid-ring edge cases by reading duration from
// the DB row (which call_end / disconnect cleanup updates).
//
// Returns { counted, duration, threshold } so the caller can include a flag
// in the call_ended payload, enabling the customer UI to surface a "this
// call was too short to count" note.
//
// Skipped for agent-initiated calls (initiated_by='agent') — those never
// count toward customer quota by design.
async function finalizeCallUsageIfBillable(callId) {
  try {
    const [[row]] = await pool.query(
      'SELECT customer_id, initiated_by, duration FROM calls WHERE id = ?',
      [callId]
    );
    if (!row) return { counted: false, duration: 0, threshold: 30 };
    const settings = await getRoutingSettings();
    const threshold = settings.minBillableCallSeconds ?? 30;
    const duration = Number(row.duration || 0);
    if (row.initiated_by === 'agent') return { counted: false, duration, threshold };
    if (duration < threshold) return { counted: false, duration, threshold };
    await incrementCallUsage(row.customer_id);
    return { counted: true, duration, threshold };
  } catch (err) {
    console.error('finalizeCallUsageIfBillable error:', err);
    return { counted: false, duration: 0, threshold: 30 };
  }
}

// chatRings: chatId → { agentId, timer, triedIds, customerData }
// Tracks which agent is currently being rung for which waiting chat. Used by
// the sequential-ring pattern so only one agent at a time gets the new_chat
// notification; after 15 seconds without accept, the ring escalates to the
// next available agent.
const chatRings = new Map();
// 60s per agent before escalating. Originally 15s, then bumped to 30s, now 60s
// because agents reported chats being yanked away before they had a chance to
// pick up — especially when they were on the Calls tab or Tickets tab and the
// new_chat_request toast was off-screen / under a different overlay. 60s is
// roughly the time it takes someone to glance over from another tab and click.
// Combined with the persistent 90s toast in NotificationBell, an agent who's
// even half-paying-attention will catch the chat before it escalates.
const CHAT_RING_TIMEOUT_MS = 60000;

// Cancel an in-flight ring for a chat (called when chat is accepted, customer
// cancels, or chat is closed). Safe to call even if no ring is active.
// `cancelEvent` controls what the rung agent is told:
//   'chat_request_cancelled' (default) → "now with another agent" (escalation)
//   'chat_cancelled'                   → silent clear (chat ended, e.g. by the
//                                        customer) — no misleading "missed" entry.
function clearChatRing(io, chatId, notifyAgent = true, cancelEvent = 'chat_request_cancelled') {
  const ring = chatRings.get(chatId);
  if (!ring) return;
  clearTimeout(ring.timer);
  chatRings.delete(chatId);
  if (notifyAgent && ring.agentId) {
    // Tell the currently-rung agent the chat is no longer theirs to accept.
    io.to(`user_${ring.agentId}`).emit(cancelEvent, { chatId });
  }
}

// Auto-assign toggle — persisted in admin_settings, hydrated on first read
let autoAssignEnabled = false;
let autoAssignHydrated = false;
async function hydrateAutoAssign() {
  if (autoAssignHydrated) return;
  try {
    const [[row]] = await pool.query("SELECT value FROM admin_settings WHERE `key` = 'auto_assign_enabled'");
    autoAssignEnabled = row?.value === '1';
  } catch {}
  autoAssignHydrated = true;
}

// In-memory call tracking: callId → { customerId, agentId, status }
const activeCalls = new Map();

// In-memory agent availability: userId → 'online' | 'busy' | 'away'
const agentStatuses = agentRegistry; // alias: now-shared registry (was `new Map()`)

// In-memory chat-transfer offers: chatId → { fromAgentId, fromAgentName,
// toAgentId, toAgentName, transferNote, timeoutId, customerId, custInfo }.
// Lives only between `notify_chat_transfer` and the receiving agent's
// accept/reject (or the 30 s timeout). Mirrors the manual-accept pattern
// used by call transfers — chats.agent_id is NOT updated until the target
// agent explicitly accepts, so an offline/distracted target can no longer
// silently steal a chat from the original agent.
const pendingChatTransfers = new Map();
const CHAT_TRANSFER_TIMEOUT_MS = 30000;

// Per-customer scheduled "close pending chats" timers (cancelled if they reconnect).
// Lets us survive page-refresh without killing the customer's queued chat — disconnect
// schedules a close in 5s, reconnect within that window cancels it.
// Key: customer user_id → timeout handle
const pendingCustomerCloseTimers = new Map();

exports.getAutoAssign = () => autoAssignEnabled;

module.exports = (io) => {
  // On startup, the in-memory `activeCalls` map is empty but the DB may still have
  // rows in 'ringing'/'active' from a previous process that died mid-call. Reap
  // anything older than an hour so it doesn't pollute the busy-agent counts.
  pool.query(
    "UPDATE calls SET status = 'failed' WHERE status IN ('ringing','active') AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)"
  ).then(([r]) => {
    if (r.affectedRows) console.log(`[startup] Reaped ${r.affectedRows} zombie call row(s)`);
  }).catch(() => {});

  // Authenticate socket connections
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const [rows] = await pool.query(
        'SELECT id, name, email, role, active_session_jti FROM users WHERE id = ? AND is_active = TRUE',
        [decoded.id]
      );
      if (!rows.length) return next(new Error('User not found'));
      // Single-device enforcement on the socket side too. Without this, a stale
      // token holder could still maintain a live socket (chat, calls, etc.)
      // even after another login revoked their session at the REST layer.
      if (decoded.jti !== rows[0].active_session_jti) {
        return next(new Error('session_revoked'));
      }
      socket.user = rows[0];
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.user.name} (${socket.user.role})`);

    // Per-user room — allows targeted notifications
    socket.join(`user_${socket.user.id}`);

    // Customer reconnected within the grace window? Cancel the scheduled "close pending chats"
    // so a page refresh doesn't kill their queued chat.
    if (socket.user.role === 'customer') {
      const pending = pendingCustomerCloseTimers.get(socket.user.id);
      if (pending) {
        clearTimeout(pending);
        pendingCustomerCloseTimers.delete(socket.user.id);
        console.log(`[Chat] Customer ${socket.user.name} reconnected — cancelled pending close`);
      }
    }

    // ── join_chat ────────────────────────────────────────────────────────────
    socket.on('join_chat', async ({ chatId }) => {
      try {
        const [chats] = await pool.query('SELECT * FROM chats WHERE id = ?', [chatId]);
        if (!chats.length) return socket.emit('error', { message: 'Chat not found' });

        if (socket.user.role === 'customer') {
          const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [socket.user.id]);
          if (!cRow || cRow.id !== chats[0].customer_id) {
            return socket.emit('error', { message: 'Forbidden' });
          }
        }

        socket.join(`chat_${chatId}`);
        socket.currentChatId = chatId;
        console.log(`${socket.user.name} joined chat_${chatId}`);

        // If already active, tell this customer socket directly (handles reconnects)
        if (chats[0].status === 'active' && chats[0].agent_id) {
          const [agentRows] = await pool.query('SELECT name, role FROM users WHERE id = ?', [chats[0].agent_id]);
          socket.emit('chat_accepted', { agentName: customerDisplayName(agentRows[0]?.name, agentRows[0]?.role), chatId });
        }

        if (chats[0].status === 'waiting') {
          const [customer] = await pool.query(
            `SELECT u.name AS customer_name, c.domain, p.name AS plan_name
             FROM customers c JOIN users u ON u.id = c.user_id
             LEFT JOIN plans p ON p.id = c.plan_id
             WHERE c.id = ?`,
            [chats[0].customer_id]
          );
          // Include the pre-chat category in the payload so agents can see what
          // topic the customer picked (used by the global notification toast +
          // future skill-based routing).
          const customerData = { ...customer[0], created_at: chats[0].created_at, category: chats[0].category };

          // Auto-assign if enabled and agents are online
          if (autoAssignEnabled) {
            const assigned = await tryAutoAssign(io, chatId, customerData, socket);
            if (assigned) {
              // Send existing messages to customer
              const [messages] = await pool.query(
                `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
                 FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
                 WHERE cm.chat_id = ? ORDER BY cm.created_at ASC`,
                [chatId]
              );
              socket.emit('chat_history', { messages });
              return;
            }
          }

          // Manual assignment — sequentially ring one agent at a time, just like
          // an incoming call. Replaces the old "broadcast to everyone" pattern
          // where every online agent saw the same chat in their queue and got
          // a duplicate toast. Now: pick the best candidate via pickAgent (skill
          // tags, least loaded, etc.), ring them for 15s, escalate to the next
          // agent if no accept, fall back to broadcasting after all are tried.
          ringNextAgentForChat(io, chatId, customerData, []).catch(err => {
            console.error('[Chat] ringNextAgentForChat failed:', err);
          });
        }

        // Send existing messages
        const [messages] = await pool.query(
          `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
           FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
           WHERE cm.chat_id = ? ORDER BY cm.created_at ASC`,
          [chatId]
        );
        socket.emit('chat_history', { messages });
      } catch (err) {
        console.error(err);
        socket.emit('error', { message: 'Failed to join chat' });
      }
    });

    // ── join_agent_room ──────────────────────────────────────────────────────
    socket.on('join_agent_room', async () => {
      if (socket.user.role === 'agent' || socket.user.role === 'admin') {
        await hydrateAutoAssign();
        socket.emit('auto_assign_status', { enabled: autoAssignEnabled });

        // Hydrate status FIRST, then join the room. If we join first there's a race
        // window where the agent is targeted by broadcasts/auto-assign before their
        // status is known — and pickAgent treats unknown status as available.
        if (!agentStatuses.has(socket.user.id)) {
          let restored = 'online';
          try {
            const [[row]] = await pool.query(
              'SELECT last_status, on_break_until FROM users WHERE id = ?',
              [socket.user.id]
            );
            if (row?.on_break_until && new Date(row.on_break_until) > new Date()) {
              restored = 'on_break';
            } else if (row?.last_status && ['online', 'busy', 'away', 'on_break'].includes(row.last_status)) {
              restored = row.last_status === 'on_break' ? 'online' : row.last_status;
            }
          } catch {}
          agentStatuses.set(socket.user.id, restored);
        }

        socket.join('agents');
        console.log(`Agent ${socket.user.name} joined agent room with status ${agentStatuses.get(socket.user.id)}`);
        io.to('agents').emit('agent_status_changed', { agentId: socket.user.id, name: socket.user.name, status: agentStatuses.get(socket.user.id) });
        io.emit('agent_availability_changed'); // notify all customers to re-check

        // If the backend just restarted (or this agent reconnected for any
        // reason), any pre-existing waiting chats have no in-memory ring
        // entry — which makes the dashboard filter fall through to
        // "visible to all" (broadcast semantics). Kick the ring back on
        // for any waiting chats so they immediately get assigned to one
        // specific agent again. Only the rung agent will see them.
        if (agentStatuses.get(socket.user.id) === 'online') {
          setImmediate(() => flushNextWaitingChat(io).catch(err => console.error('[flushNextWaitingChat]', err)));
        }
      }
    });

    // ── leave_agent_room ─────────────────────────────────────────────────────
    // Admin opts out of the routing pool when their agent panel unmounts (they
    // navigated away to /admin or closed the tab). After this, the auto-router
    // can't see them as a candidate so chats/calls stop ringing them. Regular
    // agents shouldn't call this — their session = their availability.
    socket.on('leave_agent_room', () => {
      if (socket.user.role !== 'admin') return;
      socket.leave('agents');
      console.log(`Admin ${socket.user.name} left agent room (closed agent panel)`);
      io.to('agents').emit('agent_status_changed', { agentId: socket.user.id, name: socket.user.name, status: 'offline' });
      io.emit('agent_availability_changed');
    });

    // ── join_chat_monitor_room ──────────────────────────────────────────────
    // Admin's Chat Management page subscribes to live queue updates without
    // entering the routing pool. Joining the dedicated 'chat_monitors' room
    // means they receive new_chat_request / chat_request_accepted /
    // queue_sla_alert / auto_assign_status broadcasts but the auto-router
    // doesn't see them as a candidate. Customer-side availability counts
    // people in 'agents' only, so admins on /admin/chats no longer
    // accidentally signal themselves as online to customers.
    socket.on('join_chat_monitor_room', () => {
      if (socket.user.role !== 'admin') return;
      socket.join('chat_monitors');
    });

    // ── join_call_monitor_room ──────────────────────────────────────────────
    // Same pattern as chat_monitors — admin's /admin/calls page joins this
    // room to receive live notifications when calls transition state
    // (initiated/ringing/active/ended/missed) so the page can refresh its
    // list. Joining doesn't put the admin in the routing pool — they're not
    // a call-handling candidate.
    socket.on('join_call_monitor_room', () => {
      if (socket.user.role !== 'admin') return;
      socket.join('call_monitors');
    });

    // ── send_message ─────────────────────────────────────────────────────────
    socket.on('send_message', async ({ chatId, message }) => {
      if (!message?.trim()) return;
      try {
        const [chats] = await pool.query(
          "SELECT * FROM chats WHERE id = ? AND status IN ('waiting', 'active')",
          [chatId]
        );
        if (!chats.length)
          return socket.emit('error', { message: 'Chat not found or already closed' });

        if (socket.user.role === 'customer') {
          const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [socket.user.id]);
          if (!cRow || chats[0].customer_id !== cRow.id)
            return socket.emit('error', { message: 'Forbidden' });
        }

        const [result] = await pool.query(
          'INSERT INTO chat_messages (chat_id, sender_id, message) VALUES (?, ?, ?)',
          [chatId, socket.user.id, message.trim()]
        );
        const [newMsg] = await pool.query(
          `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
           FROM chat_messages cm JOIN users u ON u.id = cm.sender_id
           WHERE cm.id = ?`,
          [result.insertId]
        );
        io.to(`chat_${chatId}`).emit('new_message', { message: newMsg[0] });
      } catch (err) {
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // ── send_file ────────────────────────────────────────────────────────────
    const ALLOWED_MIME_TYPES = new Set([
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/pdf',
      'text/plain',
      'application/zip', 'application/x-zip-compressed',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);

    socket.on('send_file', async ({ chatId, fileName, fileType, fileData, caption }) => {
      if (!fileData || !fileName || !fileType) return;
      try {
        const [chats] = await pool.query(
          "SELECT * FROM chats WHERE id = ? AND status IN ('waiting', 'active')",
          [chatId]
        );
        if (!chats.length) return socket.emit('error', { message: 'Chat not found or already closed' });

        if (socket.user.role === 'customer') {
          const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [socket.user.id]);
          if (!cRow || chats[0].customer_id !== cRow.id)
            return socket.emit('error', { message: 'Forbidden' });
        }

        if (!ALLOWED_MIME_TYPES.has(fileType)) {
          return socket.emit('error', { message: 'File type not supported' });
        }

        const base64 = fileData.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length > 25 * 1024 * 1024) {
          return socket.emit('error', { message: 'File too large (max 25 MB)' });
        }

        const ext        = path.extname(fileName) || '';
        const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buffer);

        const [attResult] = await pool.query(
          'INSERT INTO file_attachments (ref_type, ref_id, original_name, stored_name, mime_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['chat_message', chatId, fileName, storedName, fileType, buffer.length, socket.user.id]
        );
        const fileUrl = `/uploads/${storedName}`;

        const [result] = await pool.query(
          'INSERT INTO chat_messages (chat_id, sender_id, message, file_url, file_name, file_type) VALUES (?, ?, ?, ?, ?, ?)',
          [chatId, socket.user.id, caption || '', fileUrl, fileName, fileType]
        );
        const [newMsg] = await pool.query(
          `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
           FROM chat_messages cm JOIN users u ON u.id = cm.sender_id WHERE cm.id = ?`,
          [result.insertId]
        );
        io.to(`chat_${chatId}`).emit('new_message', { message: newMsg[0] });
      } catch (err) {
        console.error('send_file error:', err);
        socket.emit('error', { message: 'Failed to send file' });
      }
    });

    // ── accept_chat ──────────────────────────────────────────────────────────
    socket.on('accept_chat', async ({ chatId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      try {
        // Snapshot the ring state BEFORE we clear it so we can notify
        // previously-tried agents that the chat is no longer up for grabs.
        const ringSnapshot = chatRings.get(chatId);
        // Cancel any in-flight sequential ring for this chat — this agent is
        // claiming it now. notifyAgent=false because we send a more specific
        // signal below (chat_taken to the accepter, chat_request_cancelled
        // to anyone else who was rung).
        clearChatRing(io, chatId, false);

        // Tell the accepting agent's ENTIRE user room that the chat was taken
        // — covers all open tabs of this user (e.g., an admin who has BOTH
        // their /admin and /agent tabs open shares user_<id>). Without this,
        // the /admin tab's NotificationBell would keep ringing for up to 90s
        // (the safety timeout) because none of its stop-events ever arrived.
        // chat_taken is the right event here (vs chat_request_cancelled): the
        // bell handles it without showing a misleading "you just missed a chat"
        // toast — because the accepter didn't miss it, they took it.
        io.to(`user_${socket.user.id}`).emit('chat_taken', { chatId });

        // Other agents who got rung for this chat earlier (sequential ring
        // tried them and moved on) may also have a stale ring/toast. Tell
        // them they missed it — that's the right semantic here.
        const triedBefore = ringSnapshot
          ? new Set([
              ringSnapshot.agentId,
              ...(ringSnapshot.triedIds || []),
            ].filter(id => id && id !== socket.user.id))
          : new Set();
        for (const uid of triedBefore) {
          io.to(`user_${uid}`).emit('chat_request_cancelled', { chatId });
        }

        // Atomic claim: only the first request that finds the chat still 'waiting' wins.
        // Without this, two rapid accepts (double-click, React StrictMode, socket retry)
        // can both pass a SELECT-then-UPDATE race and emit duplicate greetings.
        // Also allow claiming if the chat was pre-reserved to THIS agent by an
        // admin (queued case) — agent_id matches the claimer.
        const [result] = await pool.query(
          `UPDATE chats SET agent_id = ?, status = 'active', accepted_at = NOW()
           WHERE id = ? AND status = 'waiting' AND (agent_id IS NULL OR agent_id = ?)`,
          [socket.user.id, chatId, socket.user.id]
        );
        if (result.affectedRows === 0) {
          // Either already claimed by another agent OR this is a duplicate event from the same agent.
          // Stay silent (no error toast for the dup case) — just don't emit the greeting again.
          console.log(`[Chat ${chatId}] accept_chat ignored — already claimed (duplicate or stale)`);
          return;
        }
        const [[chat]] = await pool.query('SELECT customer_id FROM chats WHERE id = ?', [chatId]);

        socket.join(`chat_${chatId}`);
        socket.currentChatId = chatId;

        // chat_accepted goes to BOTH customer + agent rooms. Customer needs the
        // neutralized display name; agents should see the real one.
        io.to(`chat_${chatId}`).emit('chat_accepted', { agentName: customerDisplayName(socket.user.name, socket.user.role), chatId });
        io.to('agents').to('chat_monitors').emit('chat_request_accepted', { chatId, agentName: socket.user.name });
        console.log(`Agent ${socket.user.name} accepted chat ${chatId}`);

        // Send automatic greeting message — this is the first agent message, count usage now.
        // Use the customer-facing display name in the greeting body so the customer sees a
        // consistent identity (matches the chat header).
        const greetingName = customerDisplayName(socket.user.name, socket.user.role);
        await emitAutoMessage(io, chatId, socket.user.id, greetingName,
          `Hello! I'm ${greetingName}. How can I help you today?`);

        // Increment chat usage when agent sends first message
        try { await incrementChatUsage(chat?.customer_id); } catch {}

        // Email customer that chat was accepted
        try {
          if (chat?.customer_id) {
            const [[custInfo]] = await pool.query(
              `SELECT u.email, u.name FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
              [chat.customer_id]
            );
            if (custInfo) sendChatAcceptedEmail({ to: custInfo.email, customerName: custInfo.name, agentName: socket.user.name, chatId });
          }
        } catch {}
      } catch (err) {
        socket.emit('error', { message: 'Failed to accept chat' });
      }
    });

    // ── close_chat ───────────────────────────────────────────────────────────
    socket.on('close_chat', async ({ chatId }) => {
      try {
        const isAgent = socket.user.role === 'agent' || socket.user.role === 'admin';

        if (isAgent) {
          const [[chat]] = await pool.query('SELECT agent_id FROM chats WHERE id = ?', [chatId]);
          if (!chat || (socket.user.role === 'agent' && chat.agent_id !== socket.user.id)) {
            return socket.emit('error', { message: 'Not authorized to close this chat' });
          }
          await emitAutoMessage(io, chatId, socket.user.id, socket.user.name,
            'Thank you for reaching out. If you need further assistance, feel free to contact us again. Have a great day!');
        } else {
          const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [socket.user.id]);
          if (!cRow) return socket.emit('error', { message: 'Not authorized' });
          const [[chat]] = await pool.query('SELECT id FROM chats WHERE id = ? AND customer_id = ?', [chatId, cRow.id]);
          if (!chat) return socket.emit('error', { message: 'Not authorized to close this chat' });
        }

        await pool.query(
          "UPDATE chats SET status = 'closed', closed_at = NOW() WHERE id = ?",
          [chatId]
        );
        // Cancel any in-flight sequential ring (chat closing while still waiting).
        // The chat ENDED (not escalated) — use 'chat_cancelled' so the rung agent
        // doesn't get the misleading "missed chat, now with another agent" alert.
        clearChatRing(io, chatId, true, 'chat_cancelled');
        io.to(`chat_${chatId}`).emit('chat_closed', { chatId });
        // Broadcast to all agents so any pending/queue UIs drop this chatId.
        // No-op for agents whose queue doesn't have it; safe to fire unconditionally.
        // Also notify admin chat monitors so their list updates in real time.
        io.to('agents').to('chat_monitors').emit('chat_removed', { chatId });
        console.log(`Chat ${chatId} closed by ${socket.user.name}`);

        // Agent just freed up — try to flush the oldest waiting chat to a free agent.
        // Customers don't trigger this branch (they only close their own chat).
        if (isAgent) {
          setImmediate(() => flushNextWaitingChat(io).catch(err => console.error('[flushNextWaitingChat]', err)));
        }
      } catch (err) {
        socket.emit('error', { message: 'Failed to close chat' });
      }
    });

    // ── typing ───────────────────────────────────────────────────────────────
    socket.on('typing', async ({ chatId, isTyping }) => {
      if (socket.user.role === 'customer') {
        const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [socket.user.id]);
        if (!cRow) return;
        const [[chat]] = await pool.query('SELECT id FROM chats WHERE id = ? AND customer_id = ?', [chatId, cRow.id]);
        if (!chat) return;
      }
      socket.to(`chat_${chatId}`).emit('user_typing', {
        userId: socket.user.id,
        name: socket.user.name,
        role: socket.user.role,
        isTyping,
      });
    });

    // ── mark_read (agent marks messages as read) ──────────────────────────────
    socket.on('mark_read', async ({ chatId }) => {
      try {
        if (socket.user.role === 'customer') {
          const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [socket.user.id]);
          if (!cRow) return;
          const [[chat]] = await pool.query('SELECT id FROM chats WHERE id = ? AND customer_id = ?', [chatId, cRow.id]);
          if (!chat) return;
        } else {
          const [[chat]] = await pool.query('SELECT agent_id FROM chats WHERE id = ?', [chatId]);
          if (!chat || (socket.user.role === 'agent' && chat.agent_id !== socket.user.id)) return;
        }
        await pool.query(
          'UPDATE chat_messages SET read_at = NOW() WHERE chat_id = ? AND sender_id != ? AND read_at IS NULL',
          [chatId, socket.user.id]
        );
        socket.to(`chat_${chatId}`).emit('messages_read', { chatId, by: socket.user.id });
      } catch {}
    });

    // ── notify_chat_transfer — initiate a manual-accept transfer ──────────────
    // Mirrors call_transfer: stores a pending offer, rings the target agent,
    // and only commits chats.agent_id once they explicitly accept. The customer
    // is NOT notified until the receiving agent accepts — otherwise they'd see
    // "transferred to X" while X is still deciding whether to take it.
    socket.on('notify_chat_transfer', async ({ chatId, targetAgentId, transferNote }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      try {
        const [[chat]] = await pool.query(
          "SELECT agent_id, customer_id FROM chats WHERE id = ? AND status IN ('waiting','active')",
          [chatId]
        );
        if (!chat) return socket.emit('chat_transfer_failed', { chatId, reason: 'Chat not found or already closed' });
        if (Number(chat.agent_id) !== Number(socket.user.id)) {
          return socket.emit('chat_transfer_failed', { chatId, reason: 'Not your chat' });
        }
        if (pendingChatTransfers.has(chatId)) {
          return socket.emit('chat_transfer_failed', { chatId, reason: 'Transfer already pending' });
        }
        const [[target]] = await pool.query(
          "SELECT id, name FROM users WHERE id = ? AND role IN ('agent','admin')",
          [targetAgentId]
        );
        if (!target) return socket.emit('chat_transfer_failed', { chatId, reason: 'Target agent not found' });
        if (Number(target.id) === Number(socket.user.id)) {
          return socket.emit('chat_transfer_failed', { chatId, reason: 'Cannot transfer to yourself' });
        }

        const [[custInfo]] = await pool.query(
          `SELECT u.id AS user_id, u.name AS customer_name, c.domain, p.name AS plan_name
           FROM customers c JOIN users u ON u.id = c.user_id LEFT JOIN plans p ON p.id = c.plan_id
           WHERE c.id = ?`,
          [chat.customer_id]
        );

        // Timeout: target didn't respond → roll back to the originator.
        const timeoutId = setTimeout(() => {
          if (!pendingChatTransfers.has(chatId)) return;
          pendingChatTransfers.delete(chatId);
          io.to(`user_${socket.user.id}`).emit('chat_transfer_timeout', { chatId, toAgentName: target.name });
          io.to(`user_${target.id}`).emit('chat_transfer_cancelled', { chatId });
        }, CHAT_TRANSFER_TIMEOUT_MS);

        pendingChatTransfers.set(chatId, {
          fromAgentId: socket.user.id,
          fromAgentName: socket.user.name,
          toAgentId: target.id,
          toAgentName: target.name,
          transferNote: transferNote || null,
          timeoutId,
          customerId: chat.customer_id,
          custInfo,
        });

        // Confirm to A that the offer is out.
        socket.emit('chat_transfer_pending', { chatId, toAgentName: target.name, timeoutMs: CHAT_TRANSFER_TIMEOUT_MS });
        // Ring B.
        io.to(`user_${target.id}`).emit('chat_transfer_offer', {
          chatId,
          fromAgent: socket.user.name,
          transferNote: transferNote || null,
          timeoutMs: CHAT_TRANSFER_TIMEOUT_MS,
          customer: custInfo ? {
            customer_id: chat.customer_id,
            customer_name: custInfo.customer_name,
            domain: custInfo.domain,
            plan_name: custInfo.plan_name,
          } : null,
        });
      } catch (err) {
        console.error('notify_chat_transfer error:', err);
        socket.emit('chat_transfer_failed', { chatId, reason: 'Server error' });
      }
    });

    // ── accept_chat_transfer — B takes ownership; DB commits now ─────────────
    socket.on('accept_chat_transfer', async ({ chatId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const pending = pendingChatTransfers.get(chatId);
      if (!pending) return socket.emit('chat_transfer_failed', { chatId, reason: 'Offer expired or already handled' });
      if (Number(pending.toAgentId) !== Number(socket.user.id)) return;
      try {
        clearTimeout(pending.timeoutId);
        pendingChatTransfers.delete(chatId);

        await pool.query(
          'UPDATE chats SET agent_id = ?, transfer_note = ? WHERE id = ?',
          [pending.toAgentId, pending.transferNote, chatId]
        );

        // Receiver joins the chat room so they get future new_message events.
        socket.join(`chat_${chatId}`);

        // Eject the OLD agent's sockets from the chat room — otherwise they
        // keep receiving every new_message the customer + new agent exchange,
        // which leaks the conversation into the previous agent's frozen
        // (ended) view. Iterates every device the old agent has connected so
        // a multi-tab agent is fully evicted, not just the latest socket.
        const oldAgentRoom = io.sockets.adapter.rooms.get(`user_${pending.fromAgentId}`);
        if (oldAgentRoom) {
          for (const sid of oldAgentRoom) {
            const s = io.sockets.sockets.get(sid);
            if (s) s.leave(`chat_${chatId}`);
          }
        }

        // Tell B their offer was confirmed, with enough chat metadata to
        // render the panel without an extra round-trip.
        socket.emit('chat_transfer_accepted', {
          chatId,
          fromAgent: pending.fromAgentName,
          transferNote: pending.transferNote,
          customer: pending.custInfo ? {
            customer_id: pending.customerId,
            customer_name: pending.custInfo.customer_name,
            domain: pending.custInfo.domain,
            plan_name: pending.custInfo.plan_name,
          } : null,
        });
        // Tell A the chat has left their queue.
        io.to(`user_${pending.fromAgentId}`).emit('chat_transferred_away', {
          chatId,
          toAgentName: pending.toAgentName,
        });
        // NOW notify the customer — the new agent is locked in.
        if (pending.custInfo) {
          io.to(`user_${pending.custInfo.user_id}`).emit('chat_transferred_to_customer', {
            chatId,
            newAgentName: pending.toAgentName,
            fromAgentName: pending.fromAgentName,
          });
        }
      } catch (err) {
        console.error('accept_chat_transfer error:', err);
        socket.emit('chat_transfer_failed', { chatId, reason: 'Server error during accept' });
      }
    });

    // ── reject_chat_transfer — B declines; A keeps the chat ──────────────────
    socket.on('reject_chat_transfer', async ({ chatId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const pending = pendingChatTransfers.get(chatId);
      if (!pending) return;
      if (Number(pending.toAgentId) !== Number(socket.user.id)) return;
      clearTimeout(pending.timeoutId);
      pendingChatTransfers.delete(chatId);
      io.to(`user_${pending.fromAgentId}`).emit('chat_transfer_declined', {
        chatId,
        toAgentName: pending.toAgentName,
      });
    });

    // ── cancel_chat_transfer — A withdraws the offer ─────────────────────────
    socket.on('cancel_chat_transfer', async ({ chatId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const pending = pendingChatTransfers.get(chatId);
      if (!pending) return;
      if (Number(pending.fromAgentId) !== Number(socket.user.id)) return;
      clearTimeout(pending.timeoutId);
      pendingChatTransfers.delete(chatId);
      io.to(`user_${pending.toAgentId}`).emit('chat_transfer_cancelled', { chatId });
    });

    // ── toggle_auto_assign (admin only) ──────────────────────────────────────
    socket.on('toggle_auto_assign', async ({ enabled }) => {
      if (socket.user.role !== 'admin') return;
      autoAssignEnabled = !!enabled;
      try {
        await pool.query(
          "INSERT INTO admin_settings (`key`, value) VALUES ('auto_assign_enabled', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
          [autoAssignEnabled ? '1' : '0']
        );
        invalidateSettingsCache();
      } catch {}
      io.to('agents').to('chat_monitors').emit('auto_assign_status', { enabled: autoAssignEnabled });
      console.log(`Auto-assign ${autoAssignEnabled ? 'ON' : 'OFF'} by ${socket.user.name}`);
    });

    // ── set_status (agent availability) ──────────────────────────────────────
    socket.on('set_status', async ({ status, breakMinutes }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const valid = ['online', 'busy', 'away', 'on_break'];
      if (!valid.includes(status)) return;
      agentStatuses.set(socket.user.id, status);
      // Persist status + break timer so reconnects don't reset the chosen state.
      try {
        if (status === 'on_break') {
          const mins = Math.max(1, Math.min(120, parseInt(breakMinutes) || 15));
          await pool.query(
            'UPDATE users SET on_break_until = DATE_ADD(NOW(), INTERVAL ? MINUTE), last_status = ? WHERE id = ?',
            [mins, status, socket.user.id]
          );
        } else {
          await pool.query(
            'UPDATE users SET on_break_until = NULL, last_status = ? WHERE id = ?',
            [status, socket.user.id]
          );
        }
      } catch {}
      io.to('agents').emit('agent_status_changed', { agentId: socket.user.id, name: socket.user.name, status });
      io.emit('agent_availability_changed'); // notify all customers to re-check

      // Agent flipped to online — try to flush queued chats to them (or any free agent).
      if (status === 'online') {
        setImmediate(() => flushNextWaitingChat(io).catch(err => console.error('[flushNextWaitingChat]', err)));
      }
    });

    // ── get_agent_statuses ────────────────────────────────────────────────────
    socket.on('get_agent_statuses', () => {
      const result = {};
      agentStatuses.forEach((s, id) => { result[id] = s; });
      socket.emit('agent_statuses', result);
    });

    // ── agent_call_request (agent initiates a call to a customer) ────────────
    socket.on('agent_call_request', async ({ customerId, ticketId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') {
        return socket.emit('agent_call_error', { message: 'Forbidden' });
      }
      try {
        // Look up customer + plan eligibility (re-fetched on every call to avoid stale cache)
        const [[row]] = await pool.query(
          `SELECT c.id AS customer_id, c.user_id AS customer_user_id, c.plan_expiry,
                  u.name AS customer_name, u.is_active,
                  p.allow_calls, p.agent_can_initiate_call, p.name AS plan_name,
                  COALESCE(o.allow_calls, p.allow_calls) AS effective_allow_calls
           FROM customers c
           JOIN users u ON u.id = c.user_id
           LEFT JOIN plans p ON p.id = c.plan_id
           LEFT JOIN customer_feature_overrides o ON o.customer_id = c.id
           WHERE c.id = ?`,
          [customerId]
        );
        if (!row) return socket.emit('agent_call_error', { message: 'Customer not found' });
        if (!row.is_active) return socket.emit('agent_call_error', { message: 'Customer account is inactive' });

        const planActive = !row.plan_expiry || new Date(row.plan_expiry) > new Date();
        if (!planActive) {
          return socket.emit('agent_call_error', { message: 'Customer plan has expired' });
        }
        if (!row.effective_allow_calls) {
          return socket.emit('agent_call_error', {
            message: `Customer's plan (${row.plan_name || 'free'}) does not include voice calls`,
          });
        }
        // Per-plan toggle: admin can disable agent-initiated calls without
        // affecting customer-initiated calls.
        if (row.agent_can_initiate_call === 0) {
          return socket.emit('agent_call_error', {
            message: `Agent-initiated calls are disabled for the ${row.plan_name} plan`,
          });
        }

        // Customer must be online (have at least one socket in their user room)
        const customerSockets = await io.in(`user_${row.customer_user_id}`).fetchSockets();
        if (customerSockets.length === 0) {
          return socket.emit('agent_call_error', { message: 'Customer is offline. Leave a note in the ticket instead.' });
        }

        // Agent must not be in another active/ringing call
        const agentBusy = [...activeCalls.values()].some(
          c => c.agentId === socket.user.id && (c.status === 'ringing' || c.status === 'active' || c.status === 'pending_accept')
        );
        if (agentBusy) {
          return socket.emit('agent_call_error', { message: 'You are already on a call' });
        }

        // Customer must not be in another active/ringing/pending-accept call
        // (with this agent OR any other agent). Without this guard, a second
        // agent can race-redial a customer who's already mid-call with their
        // teammate, the customer's WebRTC stack gets confused, and both calls
        // either fail silently or hijack each other's audio.
        const customerBusy = [...activeCalls.values()].some(
          c => Number(c.customerId) === Number(row.customer_user_id)
            && (c.status === 'ringing' || c.status === 'active' || c.status === 'pending_accept')
        );
        if (customerBusy) {
          return socket.emit('agent_call_error', {
            message: `${row.customer_name || 'Customer'} is on another call right now. Please wait until they're free.`,
          });
        }

        // Create the call record
        const [result] = await pool.query(
          `INSERT INTO calls (customer_id, agent_id, status, initiated_by, ticket_id)
           VALUES (?, ?, 'initiated', 'agent', ?)`,
          [row.customer_id, socket.user.id, ticketId || null]
        );
        const callId = result.insertId;

        // Auto-cancel if customer doesn't respond within 30s
        const inviteTimeoutId = setTimeout(async () => {
          const stored = activeCalls.get(callId);
          if (stored && stored.status === 'pending_accept') {
            activeCalls.delete(callId);
            await pool.query("UPDATE calls SET status = 'missed' WHERE id = ?", [callId]);
            io.to(`user_${row.customer_user_id}`).emit('agent_call_cancelled', { callId });
            io.to(`user_${socket.user.id}`).emit('agent_call_declined', { callId, reason: 'no_answer' });
          }
        }, 30000);

        activeCalls.set(callId, {
          customerId: Number(row.customer_user_id),
          agentId: socket.user.id,
          status: 'pending_accept',
          initiatedBy: 'agent',
          inviteTimeoutId,
        });

        // Optional ticket subject for context
        let ticketSubject = null;
        if (ticketId) {
          const [[t]] = await pool.query('SELECT subject FROM tickets WHERE id = ? AND customer_id = ?', [ticketId, row.customer_id]);
          ticketSubject = t?.subject || null;
        }

        io.to(`user_${row.customer_user_id}`).emit('agent_call_invitation', {
          callId,
          agentId: socket.user.id,
          agentName: socket.user.name,
          ticketId: ticketId || null,
          ticketSubject,
        });
        socket.emit('agent_call_ringing', { callId });
        console.log(`[CALL] Agent ${socket.user.name} ringing customer_user=${row.customer_user_id} (call ${callId})`);
      } catch (err) {
        console.error('agent_call_request error:', err);
        socket.emit('agent_call_error', { message: 'Failed to start call' });
      }
    });

    // ── agent_call_response (customer accepts/declines the invitation) ───────
    socket.on('agent_call_response', async ({ callId, accept }) => {
      const stored = activeCalls.get(callId);
      if (!stored) return socket.emit('agent_call_error', { message: 'Call not found' });
      if (stored.customerId !== socket.user.id) return; // wrong recipient

      if (stored.inviteTimeoutId) clearTimeout(stored.inviteTimeoutId);

      if (accept) {
        stored.status = 'ringing';
        activeCalls.set(callId, stored);
        await pool.query("UPDATE calls SET status = 'ringing' WHERE id = ?", [callId]);
        // Tell the agent to start sending WebRTC offer
        io.to(`user_${stored.agentId}`).emit('agent_call_accepted', { callId, customerUserId: socket.user.id });
        console.log(`[CALL] Customer accepted agent-initiated call ${callId}`);
      } else {
        activeCalls.delete(callId);
        await pool.query("UPDATE calls SET status = 'failed' WHERE id = ?", [callId]);
        io.to(`user_${stored.agentId}`).emit('agent_call_declined', { callId, reason: 'declined' });
        console.log(`[CALL] Customer declined agent-initiated call ${callId}`);
      }
    });

    // ── agent_call_cancel (agent cancels before customer responds) ───────────
    socket.on('agent_call_cancel', async ({ callId }) => {
      const stored = activeCalls.get(callId);
      if (!stored) return;
      if (stored.agentId !== socket.user.id) return;
      if (stored.inviteTimeoutId) clearTimeout(stored.inviteTimeoutId);
      activeCalls.delete(callId);
      await pool.query("UPDATE calls SET status = 'failed' WHERE id = ?", [callId]);
      io.to(`user_${stored.customerId}`).emit('agent_call_cancelled', { callId });
    });

    // ── agent_call_offer (agent sends WebRTC offer to customer) ──────────────
    socket.on('agent_call_offer', async ({ callId, offerSdp }) => {
      const stored = activeCalls.get(callId);
      if (!stored || stored.initiatedBy !== 'agent') return socket.emit('agent_call_error', { message: 'Call not found' });
      if (stored.agentId !== socket.user.id) return socket.emit('agent_call_error', { message: 'Not your call' });
      io.to(`user_${stored.customerId}`).emit('agent_call_offer', { callId, offerSdp });
    });

    // ── agent_call_answer (customer sends WebRTC answer back) ────────────────
    socket.on('agent_call_answer', async ({ callId, answerSdp }) => {
      const stored = activeCalls.get(callId);
      if (!stored || stored.initiatedBy !== 'agent') return;
      if (stored.customerId !== socket.user.id) return;

      stored.status = 'active';
      activeCalls.set(callId, stored);
      // Look up the agent's name so we can initialize the participants log
      // with their entry. agent-initiated calls jump straight from invitation
      // to 'active' here, so this is the equivalent of call_accept's first-
      // accept path for outbound.
      const [[agentRow]] = await pool.query('SELECT name FROM users WHERE id = ?', [stored.agentId]);
      const participants = JSON.stringify([{
        agent_id: stored.agentId,
        agent_name: agentRow?.name || 'Agent',
        joined_at: new Date().toISOString(),
      }]);
      await pool.query(
        "UPDATE calls SET status = 'active', call_start_time = NOW(), participants = ? WHERE id = ?",
        [participants, callId]
      );

      // Note: agent-initiated calls do NOT count toward customer's monthly quota
      io.to(`user_${stored.agentId}`).emit('agent_call_answer', { callId, answerSdp });
      console.log(`[CALL] Agent-initiated call ${callId} connected`);
    });

    // ── call_offer (customer sends WebRTC offer) ─────────────────────────────
    socket.on('call_offer', async ({ callId, offerSdp, chatId }) => {
      console.log(`[CALL] call_offer received — callId=${callId} chatId=${chatId || 'none'} from user=${socket.user.id} (${socket.user.name})`);
      try {
        const [[call]] = await pool.query(
          `SELECT ca.*, c.user_id AS customer_user_id
           FROM calls ca JOIN customers c ON c.id = ca.customer_id
           WHERE ca.id = ? AND ca.status IN ('initiated', 'ringing')`,
          [callId]
        );
        if (!call) {
          console.log(`[CALL] call_offer FAILED — call ${callId} not found or wrong status`);
          return socket.emit('call_error', { message: 'Call not found' });
        }
        if (Number(call.customer_user_id) !== socket.user.id) {
          console.log(`[CALL] call_offer FAILED — ownership mismatch: call.customer_user_id=${call.customer_user_id} socket.user.id=${socket.user.id}`);
          return socket.emit('call_error', { message: 'Forbidden' });
        }

        let agentId = null;

        // Chat escalation: route to the agent already on that chat
        if (chatId) {
          const [[chat]] = await pool.query(
            "SELECT agent_id FROM chats WHERE id = ? AND customer_id = ? AND status = 'active'",
            [chatId, call.customer_id]
          );
          agentId = chat?.agent_id || null;
        }

        // Agents currently on ringing/active calls OR on active chats aren't eligible.
        // Adding chat-busy to this list is the "fix #1" UX win: an agent typing in a chat
        // can't realistically pick up a voice call simultaneously, so don't even ring them.
        const callBusyIds = [...activeCalls.values()]
          .filter(c => c.status === 'ringing' || c.status === 'active' || c.status === 'pending_accept')
          .map(c => c.agentId);
        const [chatBusyRows] = await pool.query(
          "SELECT DISTINCT agent_id FROM chats WHERE status = 'active' AND agent_id IS NOT NULL"
        );
        const busyAgentIds = [...new Set([...callBusyIds, ...chatBusyRows.map(r => Number(r.agent_id))])];

        // Standalone routing via centralized helper (handles online/away/break,
        // VIP favorite agent, admin overflow on heavy load, work-hours block).
        // Pass the customer's pre-call category so pickAgent can prefer specialists
        // (technical → `technical` tag, billing → `primary_billing` then
        // `secondary_billing`, others → `other` tag, falling back to anyone if
        // no tagged agent is available).
        let pickReason = null;
        if (!agentId) {
          const { agentId: picked, reason } = await pickAgent({
            io,
            channel: 'call',
            customerId: call.customer_id,
            excludeUserIds: busyAgentIds,
            requireOnline: true,
            category: call.category || null,
          });
          agentId = picked;
          pickReason = reason;
          if (picked) console.log(`[CALL] ${callId} routed to user ${picked} via ${reason} (category=${call.category || 'none'})`);
        }

        if (!agentId) {
          // Distinguish "we're closed" / "everyone busy" / "no one online" so the customer
          // gets a useful message instead of a generic dead-end.
          const reason =
            pickReason === 'outside_work_hours' ? 'outside_work_hours'
            : busyAgentIds.length > 0          ? 'all_busy'
            :                                    'no_agents';
          console.log(`[CALL] call_offer FAILED — ${reason}`);
          await pool.query("UPDATE calls SET status = 'missed' WHERE id = ?", [callId]);
          return socket.emit('call_no_agents', { reason });
        }

        await pool.query("UPDATE calls SET agent_id = ?, status = 'ringing' WHERE id = ?", [agentId, callId]);

        // Track which agents have already declined/timed out — used for fallback
        const triedAgents = new Set([agentId]);

        const tryNextAgent = async () => {
          // Build fresh busy list (may have changed) plus the agents we already tried.
          // Re-fetch chat-busy here too: someone may have ended a chat in the 30s ring window
          // and is now available — or vice-versa.
          const stillBusy = [...activeCalls.values()]
            .filter(c => c.status === 'ringing' || c.status === 'active' || c.status === 'pending_accept')
            .map(c => c.agentId);
          const [chatBusyRows2] = await pool.query(
            "SELECT DISTINCT agent_id FROM chats WHERE status = 'active' AND agent_id IS NOT NULL"
          );
          const excluded = [...new Set([
            ...stillBusy,
            ...chatBusyRows2.map(r => Number(r.agent_id)),
            ...triedAgents,
          ])];
          const { agentId: next, reason } = await pickAgent({
            io,
            channel: 'call',
            customerId: call.customer_id,
            excludeUserIds: excluded,
            requireOnline: true,
          });
          if (!next) {
            // Truly no one left — mark missed. Dismiss the last-ringing agent's overlay
            // before we forget who that was, otherwise it stays on-screen until reload.
            const lastRinging = activeCalls.get(callId);
            if (lastRinging) {
              io.to(`user_${lastRinging.agentId}`).emit('call_cancelled', { callId });
            }
            activeCalls.delete(callId);
            await pool.query("UPDATE calls SET status = 'missed' WHERE id = ? AND status = 'ringing'", [callId]);
            socket.emit('call_rejected', { callId, reason: 'no_answer' });
            notifyCallMonitors(io);
            try {
              const [[custInfo]] = await pool.query(`SELECT u.email, u.name FROM users u WHERE u.id = ?`, [call.customer_user_id]);
              if (custInfo) sendCallMissedEmail({ to: custInfo.email, customerName: custInfo.name });
            } catch {}
            return;
          }

          // Cancel previous agent's ring + try the next one
          const prevStored = activeCalls.get(callId);
          if (prevStored) {
            io.to(`user_${prevStored.agentId}`).emit('call_cancelled', { callId });
          }
          triedAgents.add(next);
          await pool.query("UPDATE calls SET agent_id = ? WHERE id = ?", [next, callId]);

          const nextTimeoutId = setTimeout(tryNextAgent, 30000);
          activeCalls.set(callId, { customerId: Number(call.customer_user_id), agentId: next, status: 'ringing', missTimeoutId: nextTimeoutId });
          notifyCallMonitors(io);

          // Enriched payload so the agent's call overlay can show a context card
          // (plan + history counts) without an extra round-trip.
          const [[customer]] = await pool.query(
            `SELECT cu.id AS customer_id, u.name AS customer_name, cu.domain,
                    p.name AS plan_name, cu.plan_expiry
             FROM users u JOIN customers cu ON cu.user_id = u.id
             LEFT JOIN plans p ON p.id = cu.plan_id
             WHERE u.id = ?`,
            [call.customer_user_id]
          );
          io.to(`user_${next}`).emit('incoming_call', { callId, customer, offerSdp });
          console.log(`[CALL] ${callId} fallback to user ${next} via ${reason}`);
        };

        const missTimeoutId = setTimeout(async () => {
          const stored = activeCalls.get(callId);
          if (stored && stored.status === 'ringing') {
            await tryNextAgent();
          }
        }, 30000);
        activeCalls.set(callId, {
          customerId: Number(call.customer_user_id),
          agentId,
          status: 'ringing',
          missTimeoutId,
          // Stash the offer + customer info so resume_ringing_call can re-serve
          // the same incoming_call payload if the agent dismissed the overlay
          // before they actually picked up.
          offerSdp,
        });

        const [[customer]] = await pool.query(
          `SELECT cu.id AS customer_id, u.name AS customer_name, cu.domain,
                  p.name AS plan_name, cu.plan_expiry
           FROM users u JOIN customers cu ON cu.user_id = u.id
           LEFT JOIN plans p ON p.id = cu.plan_id
           WHERE u.id = ?`,
          [call.customer_user_id]
        );

        io.to(`user_${agentId}`).emit('incoming_call', {
          callId,
          customer: customer || { customer_name: socket.user.name },
          offerSdp,
        });
        sendPushToUser(agentId, {
          title: 'Incoming call',
          body: `${customer?.customer_name || socket.user.name || 'A customer'} is calling`,
          url: '/agent/calls',
          tag: `call-${callId}`,
        }).catch(() => {});
        notifyCallMonitors(io);

        console.log(`Call ${callId} ringing → agent user_${agentId}`);
      } catch (err) {
        console.error('call_offer error:', err);
        socket.emit('call_error', { message: 'Failed to initiate call' });
      }
    });

    // ── call_accept (agent accepts WebRTC call) ──────────────────────────────
    socket.on('call_accept', async ({ callId, answerSdp }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;

      const stored = activeCalls.get(callId);
      if (!stored) return socket.emit('call_error', { message: 'Call not found' });
      if (stored.agentId !== socket.user.id) return socket.emit('call_error', { message: 'This call is not assigned to you' });

      // Guard: only increment usage on the FIRST acceptance. After a transfer
      // the new agent also fires call_accept (or a duplicate click could too) —
      // we must not double-count the customer's monthly quota.
      const wasFirstAccept = stored.status !== 'active';

      if (stored.missTimeoutId) clearTimeout(stored.missTimeoutId);
      stored.status = 'active';
      activeCalls.set(callId, stored);

      // Only set call_start_time on the FIRST accept. Re-accepts (from
      // transfer renegotiation) must NOT reset it — otherwise the total
      // duration computed at call_end would only include time-since-last-
      // transfer, throwing away the time the original agent spent on the
      // call. This is the same `wasFirstAccept` flag we use to gate usage
      // increment for the same reason.
      if (wasFirstAccept) {
        // First accept on this call — initialize the participants log with
        // this agent. accept_transfer appends to it later if the call
        // changes hands.
        const participants = JSON.stringify([{
          agent_id: socket.user.id,
          agent_name: socket.user.name,
          joined_at: new Date().toISOString(),
        }]);
        await pool.query(
          "UPDATE calls SET status = 'active', call_start_time = NOW(), participants = ? WHERE id = ?",
          [participants, callId]
        );
      } else {
        await pool.query("UPDATE calls SET status = 'active' WHERE id = ?", [callId]);
      }
      notifyCallMonitors(io);

      // Usage increment moved from here to call_end / disconnect-cleanup. We
      // only count the call once we know its duration crossed the billable
      // threshold (see finalizeCallUsageIfBillable). Counting on accept was
      // exploitable: an agent could pick up + immediately cut the call to burn
      // the customer's monthly quota without delivering any support. Counting
      // on END (gated by duration) closes that hole and is also more accurate
      // for network-drop and ring-but-bail scenarios.

      io.to(`user_${stored.customerId}`).emit('call_accepted', {
        callId,
        answerSdp,
        agentName: socket.user.name,
      });
      // Also fire on the accepting agent's own socket so their Calls-tab
      // ringing banner refreshes and disappears. Without this, after a
      // transfer auto-accept the banner showing "Incoming call from X —
      // pick up or decline" stays up even though the call is already
      // active in the bottom-right overlay (the banner uses the
      // `call_accepted` socket event to know when to refresh, but only
      // the customer used to receive it).
      socket.emit('call_accepted', { callId, agentName: socket.user.name });

      console.log(`Agent ${socket.user.name} accepted call ${callId}`);
    });

    // ── call_reject (agent rejects WebRTC call) ──────────────────────────────
    socket.on('call_reject', async ({ callId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;

      const stored = activeCalls.get(callId);
      if (!stored) return;
      if (stored.agentId !== socket.user.id) return;

      if (stored.missTimeoutId) clearTimeout(stored.missTimeoutId);
      activeCalls.delete(callId);
      await pool.query("UPDATE calls SET status = 'failed' WHERE id = ?", [callId]);
      io.to(`user_${stored.customerId}`).emit('call_rejected', { callId, reason: 'declined' });
      notifyCallMonitors(io);
    });

    // ── resume_ringing_call (re-show overlay for a missed ringing call) ──────
    // Used by the Calls-tab "Accept" inline button when an agent's incoming_call
    // overlay was dismissed but the underlying call is still ringing in the
    // backend (DB status='ringing', activeCalls entry still present). Re-emits
    // the same incoming_call payload so AgentCallOverlay pops back up with the
    // stored offer — agent clicks Accept inside the overlay as usual.
    socket.on('resume_ringing_call', async ({ callId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const stored = activeCalls.get(callId);
      if (!stored) return socket.emit('call_error', { message: 'Call no longer ringing' });
      if (stored.agentId !== socket.user.id) return socket.emit('call_error', { message: 'Not your call' });
      if (stored.status !== 'ringing' && stored.status !== 'pending_accept') {
        return socket.emit('call_error', { message: 'Call is no longer ringing' });
      }

      // Re-fetch customer info — cheap and avoids stale cache.
      const [[customer]] = await pool.query(
        `SELECT cu.id AS customer_id, u.name AS customer_name, cu.domain
         FROM users u JOIN customers cu ON cu.user_id = u.id
         WHERE u.id = ?`,
        [stored.customerId]
      );

      socket.emit('incoming_call', {
        callId,
        customer: customer || { customer_name: 'Customer' },
        offerSdp: stored.offerSdp || null,
        isResumed: true,
      });
    });

    // ── call_transfer (warm transfer — A stays on the line until B responds) ─
    // Old behavior was a "blind" transfer: A hung up the moment they clicked
    // Transfer, and if B rejected or never picked, the customer was dropped
    // with no recourse. The new flow keeps A connected until B explicitly
    // accepts or declines/times-out (30 s). On reject/timeout, A simply gets
    // a toast and the call continues uninterrupted.
    socket.on('call_transfer', async ({ callId, targetAgentId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const stored = activeCalls.get(callId);
      if (!stored) return socket.emit('call_error', { message: 'Call not found' });
      if (stored.agentId !== socket.user.id) return socket.emit('call_error', { message: 'Not your call' });
      if (stored.pendingTransferToAgentId) {
        return socket.emit('call_error', { message: 'A transfer is already in progress for this call' });
      }

      try {
        const [[targetAgent]] = await pool.query(
          "SELECT id, name FROM users WHERE id = ? AND role IN ('agent', 'admin') AND is_active = TRUE",
          [targetAgentId]
        );
        if (!targetAgent) return socket.emit('call_error', { message: 'Target agent not found' });

        // Target must not already be on a call. (Customer-busy check isn't
        // needed — the customer is YOU, the one initiating the transfer.)
        const targetBusy = [...activeCalls.values()].some(
          c => c.agentId === Number(targetAgentId) &&
               (c.status === 'active' || c.status === 'ringing' || c.status === 'pending_accept')
        );
        if (targetBusy) {
          return socket.emit('call_error', { message: `${targetAgent.name} is already on a call` });
        }

        // Mark pending — A's call STAYS active. Anyone reading activeCalls will
        // see agentId still pointing at A. Only on accept_transfer do we flip.
        stored.pendingTransferToAgentId = Number(targetAgentId);
        const transferTimeoutId = setTimeout(() => {
          const s = activeCalls.get(callId);
          if (!s || s.pendingTransferToAgentId !== Number(targetAgentId)) return;
          delete s.pendingTransferToAgentId;
          delete s.transferTimeoutId;
          io.to(`user_${s.agentId}`).emit('transfer_failed', {
            callId, targetAgentName: targetAgent.name, reason: 'no_answer',
          });
          io.to(`user_${targetAgentId}`).emit('transfer_cancelled', { callId });
          console.log(`Call ${callId} transfer to ${targetAgent.name} timed out`);
        }, 30000);
        stored.transferTimeoutId = transferTimeoutId;

        const [[customer]] = await pool.query(
          `SELECT cu.id AS customer_id, u.name AS customer_name, cu.domain
           FROM users u JOIN customers cu ON cu.user_id = u.id WHERE u.id = ?`,
          [stored.customerId]
        );

        // Tell A: transfer is pending, B is being asked
        socket.emit('transfer_pending', { callId, targetAgentName: targetAgent.name });
        // Ask B: would you take this call?
        io.to(`user_${Number(targetAgentId)}`).emit('transfer_request', {
          callId,
          fromAgent: { id: socket.user.id, name: socket.user.name },
          customer: customer || { customer_name: 'Customer' },
        });
        console.log(`Call ${callId} transfer requested ${socket.user.name} → ${targetAgent.name}`);
      } catch (err) {
        console.error('call_transfer error:', err);
        socket.emit('call_error', { message: 'Transfer failed' });
      }
    });

    // ── reject_transfer (B declines A's transfer offer) ──────────────────────
    // A's call continues uninterrupted. A gets a toast so they can tell the
    // customer "the next agent couldn't take it" and end the call themselves.
    socket.on('reject_transfer', async ({ callId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const stored = activeCalls.get(callId);
      if (!stored || stored.pendingTransferToAgentId !== socket.user.id) return;
      clearTimeout(stored.transferTimeoutId);
      const rejecterName = socket.user.name;
      delete stored.pendingTransferToAgentId;
      delete stored.transferTimeoutId;
      io.to(`user_${stored.agentId}`).emit('transfer_failed', {
        callId, targetAgentName: rejecterName, reason: 'declined',
      });
      console.log(`Call ${callId} transfer to ${rejecterName} was declined`);
    });

    // ── accept_transfer (B accepts A's transfer offer) ───────────────────────
    // Warm transfer commit. After this:
    //   1. A is told to hang up (call_transferred).
    //   2. The customer is told the new agent's identity AND to renegotiate
    //      their WebRTC peer connection. The customer's useWebRTCCall hook
    //      tears down its old pc-with-A and sends a new offer via the
    //      `customer_call_reoffer` event below.
    //   3. B is told to expect that fresh offer (transfer_accepted). B's
    //      AgentCallOverlay sets a "waiting for the reoffer" flag so that
    //      when the eventual incoming_call arrives, it auto-accepts (no
    //      second manual click needed).
    // The old design preemptively emitted incoming_call to B with offerSdp=null,
    // which caused `pc.setRemoteDescription(null)` to throw on B's side and
    // silently broke every accept-path transfer.
    socket.on('accept_transfer', async ({ callId }) => {
      if (socket.user.role !== 'agent' && socket.user.role !== 'admin') return;
      const stored = activeCalls.get(callId);
      if (!stored || stored.pendingTransferToAgentId !== socket.user.id) return;
      clearTimeout(stored.transferTimeoutId);
      const oldAgentId = stored.agentId;
      stored.agentId = socket.user.id;
      stored.status = 'ringing';
      delete stored.pendingTransferToAgentId;
      delete stored.transferTimeoutId;
      // Old offer SDP no longer valid — customer will send a fresh one.
      delete stored.offerSdp;
      // Append this agent to the participants log so per-agent durations
      // are visible later. Preserves the original agent's segment because
      // we keep their entry intact and just add the new one.
      const [[prevRow]] = await pool.query('SELECT participants FROM calls WHERE id = ?', [callId]);
      let participants = [];
      try { participants = prevRow?.participants ? (Array.isArray(prevRow.participants) ? prevRow.participants : JSON.parse(prevRow.participants)) : []; } catch {}
      participants.push({
        agent_id: socket.user.id,
        agent_name: socket.user.name,
        joined_at: new Date().toISOString(),
      });
      await pool.query(
        "UPDATE calls SET agent_id = ?, status = 'ringing', participants = ? WHERE id = ?",
        [socket.user.id, JSON.stringify(participants), callId]
      );

      // A hangs up first so the customer doesn't briefly have two connected
      // peers fighting for audio.
      io.to(`user_${oldAgentId}`).emit('call_transferred', { callId, toAgentName: socket.user.name });
      // Tell B they got the call and to wait for the customer's reoffer.
      socket.emit('transfer_accepted', { callId });
      // Tell the customer who the new agent is and that they need to
      // renegotiate. Their useWebRTCCall hook handles the rest.
      io.to(`user_${stored.customerId}`).emit('call_transfer_initiated', {
        callId,
        newAgentId: socket.user.id,
        newAgentName: socket.user.name,
      });
      console.log(`Call ${callId} transfer accepted by ${socket.user.name} — waiting for customer reoffer`);
    });

    // ── customer_call_reoffer (customer's fresh SDP after a transfer) ───────
    // Forwards the customer's new offer to the now-current agent so the
    // standard incoming_call → handleAccept flow can establish a fresh peer
    // connection. Only valid while the call is in `ringing` status (post-
    // transfer); rejected otherwise to avoid bogus offers replacing an
    // active connection.
    socket.on('customer_call_reoffer', async ({ callId, offerSdp }) => {
      const stored = activeCalls.get(callId);
      if (!stored) return socket.emit('call_error', { message: 'Call not found' });
      if (stored.customerId !== socket.user.id) return socket.emit('call_error', { message: 'Not your call' });
      if (stored.status !== 'ringing') {
        return socket.emit('call_error', { message: 'Call not in transferable state' });
      }
      stored.offerSdp = offerSdp;
      const [[customer]] = await pool.query(
        `SELECT cu.id AS customer_id, u.name AS customer_name, cu.domain
         FROM users u JOIN customers cu ON cu.user_id = u.id WHERE u.id = ?`,
        [stored.customerId]
      );
      io.to(`user_${stored.agentId}`).emit('incoming_call', {
        callId,
        customer: customer || { customer_name: 'Customer' },
        offerSdp,
        isTransfer: true,
      });
      console.log(`Customer ${socket.user.id} reoffered call ${callId} to agent ${stored.agentId}`);
    });

    // ── call_ice_candidate (relay ICE between both parties) ──────────────────
    socket.on('call_ice_candidate', ({ callId, candidate }) => {
      const stored = activeCalls.get(callId);
      if (!stored) return;
      if (socket.user.id === stored.customerId) {
        io.to(`user_${stored.agentId}`).emit('call_ice_candidate', { callId, candidate });
      } else if (socket.user.id === stored.agentId) {
        io.to(`user_${stored.customerId}`).emit('call_ice_candidate', { callId, candidate });
      }
    });

    // ── call_end (either party ends the call) ────────────────────────────────
    socket.on('call_end', async ({ callId }) => {
      const stored = activeCalls.get(callId);
      if (!stored) return;
      if (socket.user.id !== stored.customerId && socket.user.id !== stored.agentId) return;

      // If there's a pending transfer to a third agent, tell them it's off
      // and clear the timeout — otherwise their UI keeps the Accept/Reject
      // prompt up for a call that no longer exists.
      if (stored.pendingTransferToAgentId) {
        clearTimeout(stored.transferTimeoutId);
        io.to(`user_${stored.pendingTransferToAgentId}`).emit('transfer_cancelled', { callId });
      }

      activeCalls.delete(callId);

      try {
        const [[dbCall]] = await pool.query(
          "SELECT TIMESTAMPDIFF(SECOND, call_start_time, NOW()) AS dur FROM calls WHERE id = ? AND call_start_time IS NOT NULL",
          [callId]
        );
        const MAX_CALL_DURATION = 60 * 60;
        const duration = Math.min(dbCall?.dur || 0, MAX_CALL_DURATION);
        // Who hung up? Compare the socket user to the stored {customerId, agentId}
        // pair so the admin Calls page can distinguish customer-cut from agent-cut
        // when triaging short-call abuse.
        const endedBy = socket.user.id === stored.customerId ? 'customer'
                      : socket.user.id === stored.agentId    ? 'agent'
                      : socket.user.role === 'admin'         ? 'admin'
                      : null;
        await pool.query(
          "UPDATE calls SET status = 'ended', call_end_time = NOW(), duration = ?, ended_by = ? WHERE id = ?",
          [duration, endedBy, callId]
        );

        // Decide whether the call was long enough to count against the
        // customer's monthly call_limit. Short calls (agent spam-cut, network
        // drop, etc.) don't count — the customer gets their quota back.
        const { counted, threshold } = await finalizeCallUsageIfBillable(callId);

        const otherId = socket.user.id === stored.customerId ? stored.agentId : stored.customerId;
        const endPayload = { callId, duration, counted, threshold };
        io.to(`user_${otherId}`).emit('call_ended', endPayload);
        // Also notify the party that DID end the call. Their overlay already
        // tore down locally, but their Calls tab needs the same signal to
        // refresh the row from 'active' → 'ended' (otherwise the just-ended
        // call keeps showing as "In progress" until manual refresh).
        socket.emit('call_ended', endPayload);
        notifyCallMonitors(io);
        console.log(`Call ${callId} ended, duration ${duration}s, counted=${counted} (threshold=${threshold}s)`);
      } catch (err) {
        console.error('call_end error:', err);
      }
    });

    // ── Collision Detection (viewing_ticket) ─────────────────────────────────
    socket.on('viewing_ticket', ({ ticketId }) => {
      if (socket.currentTicketId && socket.currentTicketId !== ticketId) {
        socket.to('agents').emit('left_ticket', { ticketId: socket.currentTicketId, agentId: socket.user.id, name: socket.user.name });
      }
      socket.currentTicketId = ticketId;
      socket.join(`ticket_${ticketId}`);
      socket.to(`ticket_${ticketId}`).emit('agent_viewing', { ticketId, agentId: socket.user.id, name: socket.user.name });
    });

    socket.on('left_ticket', ({ ticketId }) => {
      socket.leave(`ticket_${ticketId}`);
      socket.currentTicketId = null;
      socket.to(`ticket_${ticketId}`).emit('left_ticket', { ticketId, agentId: socket.user.id, name: socket.user.name });
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.user?.name}`);

      // Clean up any active/ringing calls involving this user
      let touchedCallMonitors = false;
      for (const [callId, stored] of activeCalls.entries()) {
        if (stored.customerId === socket.user.id || stored.agentId === socket.user.id) {
          if (stored.missTimeoutId) clearTimeout(stored.missTimeoutId);
          activeCalls.delete(callId);
          touchedCallMonitors = true;
          pool.query(
            "UPDATE calls SET status = 'missed' WHERE id = ? AND status IN ('initiated', 'ringing')",
            [callId]
          ).catch(() => {});
          // For calls that were 'active' when one side dropped: compute the
          // duration up to now and finalize the usage counter through the same
          // billable-threshold check used by call_end. Without this, a network
          // drop after a long real call would (a) leave duration NULL on the
          // row and (b) skip the usage increment entirely.
          (async () => {
            try {
              const [[row]] = await pool.query(
                "SELECT status, TIMESTAMPDIFF(SECOND, call_start_time, NOW()) AS dur FROM calls WHERE id = ? AND call_start_time IS NOT NULL",
                [callId]
              );
              if (row && row.status === 'active') {
                const MAX_CALL_DURATION = 60 * 60;
                const duration = Math.min(row.dur || 0, MAX_CALL_DURATION);
                // Network drop / browser closed — neither party explicitly hung
                // up, so this is recorded as system-ended (not customer/agent).
                await pool.query(
                  "UPDATE calls SET status = 'ended', call_end_time = NOW(), duration = ?, ended_by = 'system' WHERE id = ? AND status = 'active'",
                  [duration, callId]
                );
                await finalizeCallUsageIfBillable(callId);
              }
            } catch (err) {
              console.error('disconnect-cleanup call finalize error:', err);
            }
          })();
        }
      }
      if (touchedCallMonitors) notifyCallMonitors(io);

      if (socket.user.role === 'agent' || socket.user.role === 'admin') {
        agentStatuses.delete(socket.user.id);
        io.to('agents').emit('agent_status_changed', { agentId: socket.user.id, name: socket.user.name, status: 'offline' });
        io.emit('agent_availability_changed'); // notify all customers to re-check
        if (socket.currentTicketId) {
          socket.to(`ticket_${socket.currentTicketId}`).emit('left_ticket', { ticketId: socket.currentTicketId, agentId: socket.user.id, name: socket.user.name });
        }
      }

      // Customer disconnected — drop any chats still in the pending queue (no agent yet).
      // Wrapped in a 5-second grace timer so a page refresh (disconnect → reconnect within
      // ~1s) doesn't kill the customer's queued chat. If the customer reconnects within
      // the window, the connection handler clears this timer. Active chats (with agent_id)
      // are NOT closed here — those wait for an explicit close.
      if (socket.user.role === 'customer') {
        const userId = socket.user.id;
        const userName = socket.user.name;
        // Replace any existing scheduled close for this customer
        const prev = pendingCustomerCloseTimers.get(userId);
        if (prev) clearTimeout(prev);
        const timer = setTimeout(async () => {
          pendingCustomerCloseTimers.delete(userId);
          try {
            const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [userId]);
            if (!cRow) {
              console.log(`[disconnect cleanup] No customer row for user ${userId} (${userName})`);
              return;
            }
            // Queued chats use status = 'waiting' (NOT 'pending'). Active chats with agent_id
            // are left alone — agent might still want to send a closing message.
            const [rows] = await pool.query(
              "SELECT id FROM chats WHERE customer_id = ? AND status = 'waiting' AND agent_id IS NULL",
              [cRow.id]
            );
            if (rows.length === 0) {
              console.log(`[disconnect cleanup] Customer ${userName} had no waiting chats to close`);
              return;
            }
            for (const row of rows) {
              await pool.query(
                "UPDATE chats SET status = 'closed', closed_at = NOW() WHERE id = ?",
                [row.id]
              );
              io.to('agents').to('chat_monitors').emit('chat_removed', { chatId: row.id });
              console.log(`[Chat ${row.id}] Customer ${userName} stayed disconnected — closed & broadcast chat_removed`);
            }
          } catch (err) {
            console.error('[disconnect cleanup]', err.message);
          }
        }, 5000);
        pendingCustomerCloseTimers.set(userId, timer);
      }
    });
  });
};

// Exposed to HTTP controllers — returns count of agents whose socket status is 'online'
// (excludes 'away' and 'busy'; entries are removed on disconnect so offline agents aren't counted)
// Exported for the REST closeChat path so customer-side cancellations also
// stop any in-flight sequential ring (which otherwise burns the 15s timer).
module.exports.clearChatRing = clearChatRing;

// Exposed read-only so the agent-side getPendingChats endpoint can filter the
// queue down to chats currently rung at the requesting agent. Returns the
// in-memory ring entry { agentId, triedIds, customerData } or undefined.
module.exports._getChatRingForId = (chatId) => chatRings.get(Number(chatId));

// Admin-only: pull a ringing call away from its current agent and re-ring a
// chosen target agent. Used by the admin Calls page when admin wants to route
// a specific incoming call to a different agent before it auto-times-out.
// Throws on bad state (call not ringing, no offerSdp, etc.) so the HTTP route
// can return a clean 4xx.
module.exports.redirectRingingCall = async (io, callId, targetAgentId) => {
  const numericCallId = Number(callId);
  const numericTargetId = Number(targetAgentId);
  if (!numericCallId || !numericTargetId) {
    const e = new Error('callId and targetAgentId are required'); e.status = 400; throw e;
  }
  const stored = activeCalls.get(numericCallId);
  if (!stored) {
    const e = new Error('Call is not currently ringing — too late to redirect'); e.status = 409; throw e;
  }
  if (stored.status !== 'ringing') {
    const e = new Error(`Call is in '${stored.status}' state, only 'ringing' calls can be redirected`); e.status = 409; throw e;
  }
  if (!stored.offerSdp) {
    const e = new Error('Call setup data missing — cannot redirect (call may have been auto-recovered after a restart)'); e.status = 409; throw e;
  }
  if (stored.agentId === numericTargetId) {
    const e = new Error('Target agent is already the one being rung'); e.status = 400; throw e;
  }

  // Validate the target is a real agent / admin and is online (in the agents
  // room). Refusing offline targets stops admin from accidentally redirecting
  // into a dead end.
  const [[target]] = await pool.query(
    "SELECT id, name, role, is_active FROM users WHERE id = ? AND role IN ('agent','admin')",
    [numericTargetId]
  );
  if (!target || !target.is_active) {
    const e = new Error('Target agent not found or inactive'); e.status = 400; throw e;
  }

  // Cancel the current ring: clear the existing miss-timer + drop the overlay
  // on the previously-rung agent's screen.
  const previousAgentId = stored.agentId;
  if (stored.missTimeoutId) clearTimeout(stored.missTimeoutId);
  io.to(`user_${previousAgentId}`).emit('call_cancelled', { callId: numericCallId });

  // Persist the new agent assignment so reporting + recovery line up.
  await pool.query('UPDATE calls SET agent_id = ? WHERE id = ?', [numericTargetId, numericCallId]);

  // Fetch the customer context card the agent overlay expects.
  const [[callRow]] = await pool.query('SELECT customer_id FROM calls WHERE id = ?', [numericCallId]);
  const [[customer]] = await pool.query(
    `SELECT cu.id AS customer_id, u.name AS customer_name, cu.domain,
            p.name AS plan_name, cu.plan_expiry
     FROM customers cu JOIN users u ON u.id = cu.user_id
     LEFT JOIN plans p ON p.id = cu.plan_id
     WHERE cu.id = ?`,
    [callRow.customer_id]
  );

  // New 30s miss-timer for this target. Admin's manual redirect doesn't
  // escalate — if the new agent also misses, the call is marked 'missed'.
  // (Auto-escalation here would conflict with admin's explicit choice.)
  const newTimeout = setTimeout(async () => {
    try {
      const cur = activeCalls.get(numericCallId);
      if (!cur || cur.agentId !== numericTargetId || cur.status !== 'ringing') return;
      io.to(`user_${numericTargetId}`).emit('call_cancelled', { callId: numericCallId });
      activeCalls.delete(numericCallId);
      await pool.query("UPDATE calls SET status = 'missed' WHERE id = ? AND status = 'ringing'", [numericCallId]);
      notifyCallMonitors(io);
    } catch (err) { console.error('redirect miss-timer error:', err); }
  }, 30000);

  activeCalls.set(numericCallId, {
    ...stored,
    agentId: numericTargetId,
    missTimeoutId: newTimeout,
  });

  io.to(`user_${numericTargetId}`).emit('incoming_call', {
    callId: numericCallId,
    customer: customer || { customer_name: 'Customer' },
    offerSdp: stored.offerSdp,
  });
  notifyCallMonitors(io);

  console.log(`[CALL] Admin redirected call ${numericCallId}: user_${previousAgentId} → user_${numericTargetId} (${target.name})`);
  return { previous_agent_id: previousAgentId, new_agent_id: numericTargetId, new_agent_name: target.name };
};

// Also fire from the redirect helper's own miss-timer when the new agent
// doesn't pick up — the call is marked 'missed' inside that setTimeout closure
// up in redirectRingingCall above. Easiest way to plumb the io reference is
// to update that setTimeout to call notifyCallMonitors too — handled inline.

module.exports.getOnlineAgentCount = () => {
  let count = 0;
  agentStatuses.forEach(s => { if (s === 'online') count++; });
  return count;
};

// Returns the numeric agent IDs that the customer-facing endpoints should treat
// as "available now". Ground truth: an agent is online when their socket is
// actually connected to the `agents` room AND their explicit status (if known)
// isn't 'busy' / 'away' / 'on_break'.
//
// Why two signals: the in-memory agentStatuses map is volatile — every backend
// restart wipes it, and an agent who hasn't toggled status in this process
// lifetime is missing from the map entirely. Treating "missing from map" as
// offline is wrong; treating "in agents room with no recorded status" as online
// is right (the default is online, that's what the UI shows them).
module.exports.getOnlineAgentIds = (io) => {
  // Inspect Socket.IO's room membership. io.sockets.adapter.rooms returns a Map
  // of roomName -> Set<socketId>. We map socketId back to user id.
  const result = new Set();
  if (io?.sockets?.adapter?.rooms) {
    const agentSockets = io.sockets.adapter.rooms.get('agents');
    if (agentSockets) {
      for (const sid of agentSockets) {
        const sock = io.sockets.sockets.get(sid);
        const uid = sock?.user?.id;
        if (!uid) continue;
        const status = agentStatuses.get(uid);
        // Unknown status defaults to online (matches the UI default + the
        // hydrate-from-DB fallback). Only explicit non-online states exclude.
        if (status === undefined || status === 'online') result.add(Number(uid));
      }
    }
  } else {
    // Older callers that didn't pass io fall back to the in-memory map. After a
    // restart this may under-count, but it's better than nothing.
    agentStatuses.forEach((s, id) => { if (s === 'online') result.add(Number(id)); });
  }
  return [...result];
};

// ── Sequential chat ring ──────────────────────────────────────────────────────
// Rings one agent at a time for a waiting chat (manual-assign mode). Picks the
// best candidate via pickAgent — excludes anyone already tried for THIS chat
// + anyone currently busy on an active chat. If the agent doesn't accept within
// CHAT_RING_TIMEOUT_MS, the ring escalates to the next candidate.
//
// If no agents remain, falls back to broadcasting `new_chat_request` to every
// online agent so the chat doesn't disappear into a void — better to have all
// agents notice than to leave the customer waiting silently.
async function ringNextAgentForChat(io, chatId, customerData, triedIds = [], previousAgentId = null) {
  try {
    // Verify chat is still waiting — could have been cancelled or already accepted
    const [[chat]] = await pool.query("SELECT status, customer_id FROM chats WHERE id = ?", [chatId]);
    if (!chat || chat.status !== 'waiting') {
      clearChatRing(io, chatId, false);
      return;
    }

    // Exclude anyone currently in an active chat. Also exclude tried agents
    // (this chat already rang them).
    const [busyRows] = await pool.query(
      "SELECT DISTINCT agent_id FROM chats WHERE status = 'active' AND agent_id IS NOT NULL"
    );
    const exclude = [...new Set([...triedIds, ...busyRows.map(r => Number(r.agent_id))])];
    // Look up category from the chat row — drives skill-tag routing inside pickAgent
    // (technical → tag `technical`, billing → `primary_billing` then `secondary_billing`,
    // others → `other`). Falls back to "any agent" if no specialist online.
    const [[chatCat]] = await pool.query('SELECT category FROM chats WHERE id = ?', [chatId]);
    const { agentId, reason } = await pickAgent({
      io,
      channel: 'chat',
      customerId: chat.customer_id,
      requireOnline: true,
      excludeUserIds: exclude,
      category: chatCat?.category || null,
    });

    if (!agentId) {
      // pickAgent has no candidates. Two paths land here:
      //   1. Every online agent is busy on another chat (triedIds.length === 0,
      //      everyone excluded by the busy filter).
      //   2. We've already rung every available agent once and none accepted
      //      (triedIds.length > 0).
      // In both cases, park the chat silently and broadcast to the `agents` room
      // with broadcast:true. The bell skips ring/toast (the agent isn't pinged
      // a second time), but the chat shows up in their Waiting list so they can
      // pick it up manually. Re-rings happen organically when state changes —
      // an agent comes online, flips to online, or ends their current chat
      // triggers flushNextWaitingChat which re-enters this function.
      // (Old behavior auto-restarted the cycle every 2s, which ring-spammed a
      // lone agent who'd already chosen not to answer.)
      console.log(`[Chat] #${chatId} no agent available after trying ${triedIds.length} — parking (${triedIds.length === 0 ? 'all busy / no one online' : 'full cycle exhausted'})`);
      const prior = chatRings.get(chatId);
      if (prior) clearTimeout(prior.timer);
      chatRings.set(chatId, { agentId: 0, timer: null, triedIds: [], customerData });
      // If we were escalating from a timer-out, the previously-rung agent's
      // browser is still ringing (their 90s safety timeout > our 60s backend
      // timeout). Tell them to stop — but emit `chat_request_parked` instead of
      // `chat_request_cancelled` so the bell doesn't show the misleading
      // "moved to another agent" toast (the chat is in their queue, not gone).
      if (previousAgentId) {
        io.to(`user_${previousAgentId}`).emit('chat_request_parked', { chatId });
      }
      try {
        const sockets = await io.in('agents').fetchSockets();
        if (sockets.length) {
          io.to('agents').to('chat_monitors').emit('new_chat_request', {
            chatId, customer: customerData, broadcast: true,
          });
          console.log(`[Chat] #${chatId} broadcast (silent) to ${sockets.length} agent socket(s)`);
        }
      } catch (err) {
        console.error('[Chat] silent broadcast failed', err);
      }
      return; // parked — wait for an agent state change to re-ring
    }

    // Cancel any prior ring for this same chat before starting the new one.
    // Zero-out the prior agentId first so the chat is invisible to everyone
    // during the handoff (see commentary on the timer callback above).
    const prior = chatRings.get(chatId);
    if (prior) {
      clearTimeout(prior.timer);
      if (prior.agentId && prior.agentId !== agentId) {
        chatRings.set(chatId, { ...prior, agentId: 0 });
        io.to(`user_${prior.agentId}`).emit('chat_request_cancelled', { chatId });
      }
    }
    // If we're escalating from a timer-out (previousAgentId set) and the next
    // candidate is genuinely a different agent, tell the previous agent the
    // chat moved on. Skipping this emit when previousAgentId === agentId would
    // be redundant (same person being re-rung — shouldn't happen because triedIds
    // excludes them — but defensive). Skipping it when previousAgentId is null
    // means this is the first ring, no one to cancel.
    if (previousAgentId && previousAgentId !== agentId) {
      io.to(`user_${previousAgentId}`).emit('chat_request_cancelled', { chatId });
    }

    // Ring the chosen agent — direct emit to their user_${id} room, NOT broadcast.
    console.log(`[Chat] #${chatId} ringing user_${agentId} (${reason}) — tried ${triedIds.length} agents so far`);
    io.to(`user_${agentId}`).emit('new_chat_request', { chatId, customer: customerData });
    // Best-effort OS push so an agent with the app closed/backgrounded still
    // sees the incoming chat. Fire-and-forget — never blocks the ring.
    sendPushToUser(agentId, {
      title: 'New live chat',
      body: `${customerData?.name || 'A customer'} wants to chat`,
      url: '/agent/chats',
      tag: `chat-${chatId}`,
    }).catch(() => {});

    // Schedule escalation. If the agent accepts before the timer fires, they'll
    // call clearChatRing(); if not, we try the next candidate.
    const timer = setTimeout(() => {
      console.log(`[Chat] #${chatId} ring timeout for user_${agentId} — escalating`);
      // CRITICAL: zero-out the ring's agentId BEFORE notifying this agent.
      // Their client will immediately re-fetch the dashboard / pending list,
      // and the backend filter (`ring.agentId === me`) would otherwise still
      // claim the chat as theirs — picking the NEW agent inside
      // ringNextAgentForChat is async (DB query), so the ring entry is stale
      // for the entire pickAgent latency. Setting agentId=0 makes the chat
      // invisible to EVERYONE during that handoff window — no phantom rows.
      const prior = chatRings.get(chatId);
      if (prior) chatRings.set(chatId, { ...prior, agentId: 0 });
      // NOTE: we don't emit chat_request_cancelled here. The recursive
      // ringNextAgentForChat below decides whether to emit it — only if a
      // genuinely different agent gets the next ring. Otherwise (chat gets
      // parked silently in the same agent's queue) the "you missed it,
      // moved to another agent" toast would be a lie.
      ringNextAgentForChat(io, chatId, customerData, [...triedIds, agentId], agentId).catch(() => {});
    }, CHAT_RING_TIMEOUT_MS);

    chatRings.set(chatId, { agentId, timer, triedIds: [...triedIds, agentId], customerData });
  } catch (err) {
    console.error('[Chat] ringNextAgentForChat error:', err);
  }
}

// ── Auto-message helper ───────────────────────────────────────────────────────
async function emitAutoMessage(io, chatId, senderId, senderName, message) {
  try {
    const [result] = await pool.query(
      'INSERT INTO chat_messages (chat_id, sender_id, message) VALUES (?, ?, ?)',
      [chatId, senderId, message]
    );
    const [rows] = await pool.query(
      `SELECT cm.*, u.name AS sender_name, u.role AS sender_role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_id WHERE cm.id = ?`,
      [result.insertId]
    );
    if (rows.length) io.to(`chat_${chatId}`).emit('new_message', { message: rows[0] });
  } catch (err) {
    console.error('emitAutoMessage error:', err);
  }
}

// ── Queue flush — an agent just became free, try to pop the oldest waiting chat ──
// Fires after close_chat (agent ended a chat) and when an agent flips to 'online'.
// Iterates from the oldest waiting chat and assigns it to whichever agent pickAgent
// chooses (usually the newly-free agent, since they have the lowest load now).
async function flushNextWaitingChat(io) {
  try {
    const [waiting] = await pool.query(
      "SELECT id, customer_id, category FROM chats WHERE status = 'waiting' AND agent_id IS NULL ORDER BY created_at ASC LIMIT 5"
    );
    if (!waiting.length) return;

    // When auto-assign is OFF, the manual workflow is sequential ring — agents
    // must explicitly click Accept. Auto-claiming a waiting chat from inside
    // flushNextWaitingChat would bypass that, sending the chat straight to
    // active status without the agent ever consenting. Reuse ringNextAgentForChat
    // for each waiting chat instead — the agent still gets the notification
    // (potentially as part of an ongoing ring) and must accept manually.
    if (!autoAssignEnabled) {
      for (const chat of waiting) {
        // Skip chats that already have an active ring — don't double-ring.
        // BUT: a "parked" ring (agentId=0, meaning all candidates were tried
        // and we're between cycles) should be kicked back on now that a fresh
        // agent just came online or freed up. Treat parked === no ring here.
        const existing = chatRings.get(chat.id);
        if (existing && existing.agentId !== 0) continue;
        if (existing) {
          clearTimeout(existing.timer);
          chatRings.delete(chat.id);
        }
        const [[custInfo]] = await pool.query(
          `SELECT u.name AS customer_name, c.domain, p.name AS plan_name
             FROM customers c JOIN users u ON u.id = c.user_id LEFT JOIN plans p ON p.id = c.plan_id
            WHERE c.id = ?`, [chat.customer_id]
        );
        if (!custInfo) continue;
        const customerData = {
          customer_name: custInfo.customer_name,
          domain: custInfo.domain,
          plan_name: custInfo.plan_name,
          created_at: new Date().toISOString(),
          category: chat.category,
        };
        ringNextAgentForChat(io, chat.id, customerData, []).catch(err => {
          console.error('[Chat] flush-ring failed for', chat.id, err);
        });
      }
      return;
    }

    // Strict one-active-chat-per-agent — exclude anyone who already has an active chat.
    // Mirrors the Option A UI rule on the agent side.
    const [busyRows] = await pool.query(
      "SELECT DISTINCT agent_id FROM chats WHERE status = 'active' AND agent_id IS NOT NULL"
    );
    const busyIds = busyRows.map(r => Number(r.agent_id));

    for (const chat of waiting) {
      const { agentId: bestId, reason } = await pickAgent({
        io, channel: 'chat', customerId: chat.customer_id, requireOnline: true,
        excludeUserIds: busyIds,
      });
      if (!bestId) {
        console.log(`[Chat] flush stopped at #${chat.id}: ${reason}`);
        return; // no agent available — leave remaining chats in queue
      }
      // Reserve this agent so the next iteration doesn't pick them again
      busyIds.push(Number(bestId));

      const [[agent]] = await pool.query('SELECT id, name, role FROM users WHERE id = ?', [bestId]);
      if (!agent) continue;

      // Atomic claim
      const [result] = await pool.query(
        "UPDATE chats SET agent_id = ?, status = 'active', accepted_at = NOW() WHERE id = ? AND status = 'waiting' AND agent_id IS NULL",
        [bestId, chat.id]
      );
      if (result.affectedRows === 0) continue; // someone else got it

      // Look up customer info for the notification payload + customer-side socket
      const [[custInfo]] = await pool.query(
        `SELECT u.id AS user_id, u.name AS customer_name, c.domain, p.name AS plan_name
         FROM customers c JOIN users u ON u.id = c.user_id LEFT JOIN plans p ON p.id = c.plan_id
         WHERE c.id = ?`,
        [chat.customer_id]
      );
      if (!custInfo) continue;
      const customerData = {
        customer_name: custInfo.customer_name,
        domain: custInfo.domain,
        plan_name: custInfo.plan_name,
      };

      // Notify customer + receiving agent + other agents.
      // chat_request_accepted is broadcast to all agents EXCEPT the receiver — otherwise
      // the receiver would receive both events and chat_request_accepted's stopRing()
      // could race ahead of chat_auto_assigned's startRing(), silencing the new chat.
      io.to(`user_${custInfo.user_id}`).emit('chat_accepted', { agentName: customerDisplayName(agent.name, agent.role), chatId: chat.id });
      io.to(`user_${bestId}`).emit('chat_auto_assigned', { chatId: chat.id, customer: customerData, reason: 'queue_flush' });
      io.to('agents').to('chat_monitors').except(`user_${bestId}`).emit('chat_request_accepted', { chatId: chat.id, agentName: agent.name });
      console.log(`[Chat] #${chat.id} flushed from queue to ${agent.name} (reason: ${reason})`);

      // Auto-greeting
      await emitAutoMessage(io, chat.id, agent.id, agent.name,
        `Hello! I'm ${agent.name}. How can I help you today?`);

      try { await incrementChatUsage(chat.customer_id); } catch {}
    }
  } catch (err) {
    console.error('[flushNextWaitingChat]', err);
  }
}

// ── Auto-assign helper (chats) — delegates to centralized picker ─────────────
async function tryAutoAssign(io, chatId, customerData, customerSocket) {
  try {
    // Look up the customer's DB id so picker can apply VIP/favorite-agent rules
    const [[chatRow]] = await pool.query('SELECT customer_id FROM chats WHERE id = ?', [chatId]);
    // Strict one-active-chat rule: skip any agent currently on an active chat
    const [busyRows] = await pool.query(
      "SELECT DISTINCT agent_id FROM chats WHERE status = 'active' AND agent_id IS NOT NULL"
    );
    const { agentId: bestId, reason } = await pickAgent({
      io,
      channel: 'chat',
      customerId: chatRow?.customer_id || null,
      requireOnline: true, // chats need a live agent
      excludeUserIds: busyRows.map(r => Number(r.agent_id)),
    });
    if (!bestId) {
      console.log(`[Chat] auto-assign skipped for #${chatId}: ${reason}`);
      return false;
    }

    const [[agent]] = await pool.query('SELECT id, name, role FROM users WHERE id = ?', [bestId]);
    if (!agent) return false;

    // Atomic claim to avoid double-assign races
    const [result] = await pool.query(
      "UPDATE chats SET agent_id = ?, status = 'active', accepted_at = NOW() WHERE id = ? AND status = 'waiting' AND agent_id IS NULL",
      [bestId, chatId]
    );
    if (result.affectedRows === 0) {
      console.log(`[Chat] #${chatId} was already claimed before auto-assign could complete`);
      return false;
    }

    // Notify customer + agent + other agents.
    // Skip the receiver in the broadcast so its stopRing doesn't race the recipient's startRing.
    // Customer sees a neutralized name (avoids confusion when admin handles overflow);
    // agent panels see the real one.
    const customerFacingName = customerDisplayName(agent.name, agent.role);
    customerSocket.emit('chat_accepted', { agentName: customerFacingName, chatId });
    io.to(`user_${bestId}`).emit('chat_auto_assigned', { chatId, customer: customerData, reason });
    io.to('agents').to('chat_monitors').except(`user_${bestId}`).emit('chat_request_accepted', { chatId, agentName: agent.name });
    console.log(`[Chat] #${chatId} auto-assigned to ${agent.name} via ${reason}`);

    // Automatic greeting — customer-facing, so use the neutralized name.
    await emitAutoMessage(io, chatId, agent.id, customerFacingName,
      `Hello! I'm ${customerFacingName}. How can I help you today?`);

    // Fetch customer_id from the chat record and increment usage
    try {
      const [[chatRow]] = await pool.query('SELECT customer_id FROM chats WHERE id = ?', [chatId]);
      if (chatRow) await incrementChatUsage(chatRow.customer_id);
    } catch {}

    return true;
  } catch (err) {
    console.error('Auto-assign error:', err);
    return false;
  }
}
