# Routing + Plan-Limits Invariants

These are the rules that must hold for the support panel's two core surfaces — agent routing and customer plan enforcement — to behave correctly. Every rule has a backing test in [`tests/routing-limits.test.js`](../tests/routing-limits.test.js). If you change one of these code paths, run `npm run test:routing` before merging.

---

## Routing invariants

### R1 — Chat initiation always creates a `'waiting'` row
- Endpoint: `POST /api/chat/initiate`
- Result: row in `chats` table with `status = 'waiting'`, `agent_id = NULL`
- A customer with an existing waiting/active chat gets `200 already_exists` (no duplicate row) — there is at most **one** open chat per customer at a time.

### R2 — Agents currently on an active chat are marked busy for both chat and call routing
- `chats.status = 'active' AND agent_id IS NOT NULL` is the source of truth.
- Used by:
  - `pickAgent` in [`utils/assignment.js`](../src/utils/assignment.js) via `excludeUserIds`
  - `/api/customer/agent-status` in [`controllers/customerController.js`](../src/controllers/customerController.js) — busyCount
  - Call routing (`call_offer` handler) in [`socket/chatSocket.js`](../src/socket/chatSocket.js)
- An agent typing in a live chat should never get an incoming-call ring.

### R3 — Bot ticket creation auto-assigns to an agent
- Endpoint: `POST /api/customer/bot/ticket`
- Picks via the centralised `pickAgent({channel: 'ticket', requireOnline: false})`.
- Persists `tickets.assigned_agent_id`; emits `ticket_assigned` socket event to that agent.

### R4 — Stale call rows can't permanently mark an agent as busy
- A `calls` row stuck in `'ringing'/'active'` older than **1 hour** is a zombie (agent disconnected mid-call without clean end).
- Two guards:
  - Startup reaper in `chatSocket.js` marks any such rows as `'failed'`.
  - `getAgentStatus` filters to `created_at > NOW() - INTERVAL 1 HOUR` when computing busy agents.

### R5 — Free-plan customers can't reach chat or call APIs
- Plan with `allow_chat = 0` → `POST /api/chat/initiate` returns `403`.
- Plan with `allow_calls = 0` → `POST /api/calls/initiate` returns `403`.
- Tickets are open to all plans (no `tickets_limit` enforcement today).

### R6 — Customers can't create tickets via the manual `POST /api/tickets` route
- Route is **not registered** for the customer role — the bot endpoint at `POST /api/customer/bot/ticket` is the only customer-facing path.

---

## Plan-limit invariants

### L1 — `getChatUsage` = "engaged-this-month + currently-pending"
SQL (canonical):
```sql
(SELECT COUNT(DISTINCT ch.id) FROM chats ch
 JOIN chat_messages cm ON cm.chat_id = ch.id
 JOIN users u ON u.id = cm.sender_id
 WHERE ch.customer_id = ? AND ch.accepted_at IS NOT NULL
   AND DATE_FORMAT(ch.accepted_at, '%Y-%m') = current_month
   AND u.role = 'customer')
+
(SELECT COUNT(*) FROM chats
 WHERE customer_id = ? AND status IN ('waiting','active'))
```
A chat counts toward usage only if the customer engaged (sent at least one message). Currently-pending chats also count so a customer can't queue past the cap.

### L2 — `getCallUsage` = "real connections this month, customer-initiated"
SQL (canonical):
```sql
SELECT COUNT(*) FROM calls
WHERE customer_id = ?
  AND DATE_FORMAT(created_at, '%Y-%m') = current_month
  AND (initiated_by IS NULL OR initiated_by != 'agent')
  AND (call_start_time IS NOT NULL OR status IN ('ringing','active'))
```
Missed and failed calls never count — the customer shouldn't be punished for an agent not picking up. Agent-initiated calls never count either.

### L3 — Gate enforces `usage < limit` at every initiate
- Both `POST /api/chat/initiate` and `POST /api/calls/initiate` call their respective `getXUsage`, compare against the customer's `plan.{chat_limit, calls_limit}`, and return `403 limit_exceeded` if `used >= limit`.
- Because pending chats count, customers cannot fan-out to queue past the cap.

### L4 — Counter parity with history UI
- Customer's dashboard counter and the "● Connected" badge count in History must agree:
  - Chat: dashboard `chatsUsed` == count of history rows where `has_customer_message = true`.
  - Call: dashboard `callsUsed` == count of history rows where `counted = true`.
- Backend now emits `has_customer_message` (chat history) and `counted` (call history) flags computed with the same rule as the usage SQL.

### L5 — Usage never silently exceeds limit
- `getChatUsage` / `getCallUsage` emit a one-shot `console.warn('[usage-drift] …')` whenever they compute `usage > plan-cap`.
- The admin endpoint `GET /api/admin/audit/usage-drift` returns every customer in drift right now. **Expected output: `{ drift_count: 0 }`**. Anything else needs investigation.

---

## Running the suite

```bash
cd backend
npm run dev   # backend must be running on localhost:5000

# in another shell
npm run test:routing
```

The script exits `0` on full pass, `1` on any failure, `2` if the backend isn't reachable.

## When to add a new invariant here

Anytime you:
1. Change `getChatUsage`, `getCallUsage`, `getTicketUsage`, or the gates that read them.
2. Add a new channel that has a quota (e.g., voicemail minutes).
3. Change `pickAgent` exclusion rules.
4. Add or remove a customer-facing endpoint that creates a chat / call / ticket.

Document the rule, add a test, run the suite, ship.
