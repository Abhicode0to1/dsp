# DSP (Delfos Support Panel) — Comprehensive Code Inventories

**Generated:** 2026-05-25  
**Version:** Full codebase analysis

---

## 1. ROUTE INVENTORY

Complete inventory of all Express routes with metadata: path, HTTP method, middleware, required role, plan tier gating, what data is read/written, side effects.

### 1.1 Authentication Routes (`/api/auth/*`)

| Endpoint | Method | Middleware | Required Role | Plan Gate | Reads | Writes | Side Effects |
|----------|--------|------------|---------------|-----------|-------|--------|--------------|
| `/login` | POST | `loginLimiter` (20/15min) | — | — | `users.password` | `active_session_jti` | Sets JWT token, rate-limited |
| `/logout` | POST | `authenticate` | — | — | — | Clears session | Revokes JWT |
| `/me` | GET | `authenticate` | — | — | `users.{id,name,email,role,active_session_jti}` | — | Token validation (fires on every page load) |
| `/change-password` | PUT | `authenticate, passwordChangeLimiter` (10/60min) | — | — | `users.password` | `users.password` | Bcrypt hash, rate-limited |
| `/setup-password/:token` | GET | `setupLimiter` (30/15min) | — | — | `setup_tokens` | — | Validates token existence |
| `/setup-password` | POST | `setupLimiter` (30/15min) | — | — | `setup_tokens` | `users.password` | Consumes token, bcrypt hash |

**Notes:**
- Rate limits prevent brute-force on login/password endpoints
- `/me` NOT rate-limited to avoid locking out normal browsing (fires on every page load + socket reconnect)
- Setup-password is token-based public auth; token IS the authentication

---

### 1.2 Ticket Routes (`/api/tickets/*`)

| Endpoint | Method | Required Role | Plan Gate | Reads | Writes | Side Effects |
|----------|--------|---------------|-----------|-------|--------|--------------|
| `/` | GET | `customer` | — | `tickets, ticket_messages, users` | — | Lists customer's tickets only |
| `/templates` | GET | `customer\|agent\|admin` | — | `templates` | — | Read-only; shared across roles |
| `/:id` | GET | `customer\|agent\|admin` | — | `tickets, ticket_messages, users, files` | — | Full ticket + messages + attachments |
| `/:id/messages` | POST | `customer\|agent\|admin` | — | `tickets` | `ticket_messages, files` | Adds message, increments FIRST_RESPONSE_AT if agent |
| `/:id/close` | PUT | `customer` | — | `tickets` | `tickets.status='closed'` | Closes ticket |
| `/:id/reopen` | PUT | `customer` | — | `tickets` | `tickets.status='open'` | Reopens closed ticket |
| `/:id/cc-emails` | PUT | `customer\|agent\|admin` | — | `tickets` | `tickets.cc_emails` | Updates CC list |
| `/bot-suggest` | POST | `customer` | **Free** | KB posts | — | Keyword-match suggestions before create |
| `/ai-kb-search` | POST | `customer\|agent\|admin` | — | KB posts | — | Semantic search |

**Notes:**
- Direct customer ticket creation blocked at REST layer; must route through `/api/customer/bot/ticket` so contextual routing applies
- Bot-suggest gated to Basic+ in code (free plan blocks)
- SLA tracking columns: `sla_response_due`, `sla_resolve_due`, `sla_breached`, `first_response_at`

---

### 1.3 Customer Routes (`/api/customer/*`)

| Endpoint | Method | Plan Gate | Reads | Writes | Side Effects |
|----------|--------|-----------|-------|--------|--------------|
| `/dashboard` | GET | — | `customers, plans, tickets, chats, calls, usage, invoices` | — | Aggregates full dashboard (usage counters, plan info, etc.) |
| `/plans` | GET | — | `plans` | — | Lists all available plans |
| `/upgrade/initiate` | POST | **Any→Premium** | `customers, invoices, plans` | `payment_intents` | Razorpay initiation; fire-and-forget email |
| `/upgrade/verify` | POST | — | `invoices, payment_intents` | `customers.plan_id, plan_expiry` | Verifies Razorpay order; promotes plan on success |
| `/bot` | POST | — | — | `chat_messages` (indirect) | Chains to bot chat endpoint |
| `/bot/ticket` | POST | **Free** | KB, categories | `tickets, ticket_messages` | Creates ticket via bot flow with category routing |
| `/agent-status` | GET | — | `chats (active)` | — | Counts busy agents (filters in live chats) |
| `/subscriptions` | GET | — | `invoices (status=paid)` | — | Lists active paid subscriptions |
| `/invoices` | GET | — | `invoices` | — | All invoices (paginated) |
| `/quotes` | GET | — | `invoices (status=quote)` | — | Unpaid quote invoices |
| `/invoices/:id/pdf` | GET | — | `invoices` | — | Proxy PDF from external billing system |
| `/quotes/:id/pdf` | GET | — | `invoices` | — | Proxy PDF from external billing system |
| `/quotes/:id/pay/initiate` | POST | — | `invoices` | `payment_intents` | Razorpay initiation for quote payment |
| `/quotes/:id/pay/verify` | POST | — | `invoices, payment_intents` | `invoices.status='paid'` | Verifies payment; marks quote paid |

**Notes:**
- `/bot/ticket` gated to plan-allow-email-ticket check (free plan has unlimited free tickets; no chat/call)
- Plan upgrade/quote payment handled via Razorpay webhook

---

### 1.4 Chat Routes (`/api/chat/*`)

| Endpoint | Method | Plan Gate | Reads | Writes | Side Effects |
|----------|--------|-----------|-------|--------|--------------|
| `/initiate` | POST | **Basic+** | `customers, plans, chats` | `chats` (status=waiting) | Emits Socket.io `new_chat_request` to agents |
| `/active` | GET | **Basic+** | `chats (waiting/active)` | — | Returns current active/waiting chat |
| `/queue` | GET | **Basic+** | `chats, users (agents)` | — | Returns queue position + wait time estimate |
| `/history` | GET | **Basic+** | `chat_messages, chats` | — | Full message history (paginated) |
| `/:id/close` | PUT | **Basic+** | `chats` | `chats.status='closed'` | Emits Socket.io `chat_closed` |
| `/:id/rate` | POST | **Basic+** | `chats, ratings` | `ratings` | CSAT submission (1-5 score) |
| `/offline-message` | POST | **Basic+** | `customers` | `offline_messages` | Stored for offline agents to see |

**Notes:**
- All chat endpoints check `plans.allow_chat = true` + active plan
- Rating triggers GMB link popup if score ≤ 3 (configured in admin settings)
- Increment chat usage happens in Socket.io on agent accept, not here

---

### 1.5 Call Routes (`/api/calls/*`)

| Endpoint | Method | Plan Gate | Reads | Writes | Side Effects |
|----------|--------|-----------|-------|--------|--------------|
| `/initiate` | POST | **Moderate+** | `customers, plans, calls, users` | `calls` (status=initiated) | Emits Socket.io `call_offer` to best-available agent |
| `/history` | GET | **Moderate+** | `calls, users` | — | Call history (paginated) |
| `/:id/end` | PUT | **Moderate+** | `calls` | `calls.{status='ended', call_end_time, duration}` | Tracks call duration; increments usage |

**Notes:**
- Initiate checks `plans.allow_calls = true` + active plan + calls_limit not exceeded
- Call limit check: `getCallUsage(customerId)` counts connected customer-initiated calls this month
- Virtual number masking: both parties anonymized via virtual numbers (never expose real agent phone)
- Max duration: 20 minutes enforced server-side

---

### 1.6 Agent Routes (`/api/agent/*`)

| Endpoint | Method | Reads | Writes | Side Effects |
|----------|--------|-------|--------|--------------|
| `/dashboard` | GET | `tickets (assigned), chats (active), calls, users` | — | Agent stats (SLA health, active chats, call count) |
| `/agents` | GET | `users (role=agent\|admin)` | — | List all available agents (for assignment) |
| `/customers/search` | GET | `customers, users` | — | Search customers by email/domain |
| `/tickets` | GET | `tickets (status=open\|pending, assigned_agent=me)` | — | Agent's ticket queue |
| `/tickets/bulk` | POST | `tickets` | `tickets.{status, assigned_agent_id}` | Bulk update statuses |
| `/tickets/create` | POST | — | `tickets, ticket_messages` | Creates ticket on behalf of customer (escalation) |
| `/tickets/:id` | GET | `tickets, ticket_messages, files, users, sla_configs` | — | Full ticket + SLA info |
| `/tickets/:id` | PUT | `tickets` | `tickets.{status, priority, assigned_agent_id}` | Update ticket metadata |
| `/tickets/:id/reply` | POST | `tickets` | `ticket_messages` | Agent reply; updates FIRST_RESPONSE_AT if first |
| `/tickets/:id/claim` | POST | `tickets` | `tickets.assigned_agent_id` | Claims unassigned ticket |
| `/tickets/:id/merge` | POST | `tickets` | `tickets (source deleted)` | Merges two tickets (one becomes source of truth) |
| `/tickets/:id/notes` | GET/POST/DELETE | `customer_notes` | — | Internal agent notes (not visible to customer) |
| `/tickets/:id/time-log` | POST | `tickets` | `time_logs` | Tracks hours spent on ticket |
| `/macros` | GET | `canned_responses (is_global\|created_by=me)` | — | Agent's macro templates |
| `/macros` | POST | — | `canned_responses` | Creates macro (agent-scoped) |
| `/macros/:id` | DELETE | `canned_responses` | — | Deletes macro |
| `/templates` | GET | — | `templates` | Read-only ticket templates |
| `/my-performance` | GET | `tickets, chats, calls, ratings` | — | Agent's personal stats (CSAT, SLA%, response time) |
| `/calls/mine` | GET | `calls (agent_id=me)` | — | Agent's call history |
| `/calls/:id/notes` | POST | `calls` | `call_notes` | Adds notes to a call (post-call) |
| `/chats/pending` | GET | `chats (status=waiting)` | — | Unassigned waiting chats (Socket.io may ring specific agent) |
| `/chats/mine` | GET | `chats (agent_id=me)` | — | Agent's active/recently-closed chats |
| `/chats/:id/accept` | PUT | `chats` | `chats.{agent_id, status='active', accepted_at}` | Accepts chat; managed via Socket.io mainly |
| `/chats/:id/messages` | GET | `chat_messages, files` | — | Chat message history |
| `/chats/:id/notes` | GET/POST/DELETE | `chat_notes` | — | Internal notes on chat (not visible to customer) |
| `/chats/:id/convert-to-ticket` | POST | `chats` | `tickets, ticket_messages` | Escalates chat to ticket |
| `/chats/:id/transfer` | POST | `chats` | `chats.{agent_id, transfer_note}` | Transfers chat to another agent (handled via Socket.io offer/accept) |
| `/chats/:id/transcript` | POST | `chats, chat_messages` | — | Emails chat transcript to customer |
| `/customers/:id` | GET | `customers, users, invoices, tickets` | — | Full customer detail (billing, history, etc.) |
| `/customers/:id/history` | GET | `tickets, chats, calls (for customer)` | — | Timeline of all interactions with customer |

**Notes:**
- All `/api/agent/*` require `role = agent OR admin`
- Ticket reply auto-updates `first_response_at` if NULL and sender is agent
- Chat transfer: uses Socket.io pending offer pattern (30s timeout) before DB commit
- Chat notes, ticket notes NOT visible to customer (internal only)

---

### 1.7 Admin Routes (`/api/admin/*`)

| Endpoint | Method | Key Reads | Key Writes | Side Effects |
|----------|--------|-----------|------------|--------------|
| `/dashboard` | GET | `customers, invoices, tickets, chats, calls` | — | Overview: total revenue, ticket SLA%, chat/call volume |
| `/customers` | GET | `customers, users, plans, invoices` | — | List all customers (paginated, searchable) |
| `/customers/:id` | GET | `customers, users, invoices, tickets` | — | Full customer detail |
| `/customers/:id` | PUT | `customers` | `customers.{plan_id, invoice_subtotal, domain, products}` | Updates plan/billing info |
| `/customers/:id/password` | PUT | `customers` | `users.password` | Reset customer password |
| `/customers/:id/reset-usage` | POST | `customers, calls, chats` | `customers.usage_reset_at = NOW()` | Resets monthly usage counters; emits Socket.io `usage_reset` |
| `/customers/lookup-billing` | POST | External billing API | — | Looks up customer in external billing system |
| `/customers/import` | POST | External billing API | `customers, users, invoices` | Imports customer from billing system |
| `/customers/manual` | POST | — | `users, customers` | Manually creates customer (no billing sync) |
| `/customers/:id/overrides` | GET/PUT/DELETE | `customer_feature_overrides` | — | Per-customer feature exceptions (e.g., allow_chat=true on Free plan) |
| `/plans` | GET | `plans` | — | All plan configurations |
| `/plans/:id` | PUT | `plans` | `plans.{name, allow_chat, allow_calls, tickets_limit, calls_limit, percentage, minimum_price}` | Updates plan tier limits |
| `/agents` | GET | `users (role=agent)` | — | List all agents |
| `/agents` | POST | — | `users` | Creates new agent account |
| `/agents/:id/toggle` | PUT | `users` | `users.is_active` | Deactivates/reactivates agent |
| `/agents/:id/password` | PUT | `users` | `users.password` | Reset agent password |
| `/agents/:id/skills` | PUT | `users` | `agent_skills` | Updates agent skill tags (for routing) |
| `/agents/:id` | DELETE | `users` | — | Hard-deletes agent (cascade) |
| `/tickets` | GET | `tickets, users, customers` | — | All tickets (admin view; no role filtering) |
| `/tickets/:id` | GET | `tickets, ticket_messages, files, users` | — | Full ticket detail |
| `/tickets/:id` | PUT | `tickets` | `tickets.{status, priority, assigned_agent_id, cc_emails}` | Update any ticket |
| `/tickets/bulk` | POST | `tickets` | `tickets (batch update)` | Bulk ticket updates |
| `/chats` | GET | `chats, users, customers` | — | All chats (admin view) |
| `/chats/analytics` | GET | `chats, chat_messages, users` | — | Chat metrics (avg wait, resolution rate, etc.) |
| `/chats/archive` | GET | `chats (status=closed)` | — | Closed chats (paginated) |
| `/chats/:id/assign` | PUT | `chats` | `chats.agent_id` | Reassigns chat to different agent |
| `/chats/blacklist` | GET | `chat_blacklist` | — | Blocked customers (spam prevention) |
| `/chats/blacklist` | POST | — | `chat_blacklist` | Blocks customer from initiating chats |
| `/chats/blacklist/:id` | DELETE | — | Removes customer from blacklist |
| `/calls` | GET | `calls, users, customers` | — | All calls (admin view) |
| `/reports/tickets` | GET | `tickets, users, customers` | — | Ticket analytics (SLA%, resolution time, top issues) |
| `/reports/revenue` | GET | `invoices, customers, plans` | — | Revenue report (MRR, ARR, ARPU) |
| `/reports/usage` | GET | `chats, calls, tickets (usage tables)` | — | Usage analytics (chat/call volume per plan) |
| `/reports/export` | GET | — | — | Exports report as CSV file (download) |
| `/templates` | GET | `templates` | — | All ticket templates |
| `/templates` | POST | — | `templates` | Creates global template |
| `/templates/:id` | PUT/DELETE | `templates` | — | Updates/deletes template |
| `/settings` | GET | `app_settings` | — | Admin settings (GMB link, CSAT threshold, etc.) |
| `/settings` | PUT | `app_settings` | — | Updates app-wide settings |
| `/audit/usage-drift` | GET | `customers, plans, chats, calls` | — | Read-only: finds customers whose usage > plan limit (drift detection) |
| `/audit/run-tests` | POST | — | — | Spawns child process running routing-limits.test.js (60s timeout, single-flight) |
| `/audit/reset-usage/:customerId` | POST | `customers, calls, chats` | `customers.usage_reset_at = NOW()` | Resets usage; emails customer + Socket.io notification |
| `/debug/agent-presence` | GET | Socket.io runtime state | — | Read-only: dumps all connected sockets, agents room membership, status map |
| `/feedback` | GET | `feedback_submissions` | — | All bug reports submitted by customers/agents |
| `/feedback/:id` | PUT | `feedback_submissions` | `feedback_submissions.{status, resolution_notes}` | Admin reviews/closes feedback |
| `/performance` | GET | `tickets, chats, calls, ratings (by agent)` | — | Agent performance metrics (CSAT, SLA%, response time) |

**Special Admin Endpoints:**

- **Usage Drift**: `/audit/usage-drift` detects when a customer's live chat/call count exceeds their plan limit (red flag for policy breach or counter bug).
- **Reset Usage**: `/audit/reset-usage/:customerId` sets `customers.usage_reset_at = NOW()`, which causes `getChatUsage()` and `getCallUsage()` to ignore historical activity and only count going forward.
- **Run Tests**: `/audit/run-tests` spawns the routing-limits.test.js suite as a child process (60s timeout), returns pass/fail summary. Single-flight to avoid DB conflicts.
- **Agent Presence Debug**: `/debug/agent-presence` returns real-time Socket.io sockets, agent room membership, and in-memory status map (useful for "why are no agents available?" troubleshooting).

**Notes:**
- All `/api/admin/*` require `role = admin`
- Customer password reset generates a one-time setup token (emailed separately)
- Agent creation: password must be set via setup-password flow or direct admin reset
- Feedback widget: customers/agents submit bug reports with optional screenshots; admin can update status/notes

---

### 1.8 Utility Routes

| Endpoint | Method | Path Prefix | Purpose | Reads | Writes |
|----------|--------|-------------|---------|-------|--------|
| `/attachments` | POST | `/api` | File upload (ticket/chat) | `file_attachments` | — |
| `/attachments/:id/download` | GET | `/api` | Download file | `file_attachments` | — |
| `/attachments/:id` | DELETE | `/api` | Delete file | `file_attachments` | — |
| `/canned` | GET/POST/PUT/DELETE | `/api` | Canned responses (agent macros) | `canned_responses` | — |
| `/csat` | POST | `/api` | Submit CSAT rating | `ratings` | — |
| `/csat` | GET | `/api` | Get user's rating | `ratings` | — |
| `/csat/:id/gmb-click` | POST | `/api` | Mark GMB review link clicked | `ratings` | `ratings.gmb_clicked` |
| `/csat/stats` | GET | `/api` | CSAT stats (agent/admin view) | `ratings, users, tickets, calls` | — |
| `/csat/settings` | GET/PUT | `/api` | CSAT thresholds (admin only) | `app_settings` | — |
| `/audit` | GET | `/api` | Audit log (admin only) | `audit_log` | — |
| `/notes/:customerId` | GET/POST/DELETE | `/api` | Customer notes (agent/admin only) | `customer_notes` | — |
| `/otp/request` | POST | `/api` | Request 2FA code | `otp_codes` | — |
| `/otp/verify` | POST | `/api` | Verify 2FA code | `otp_codes` | `otp_codes.used` |
| `/sync/customer` | POST | `/api` | Webhook: billing system sync (auth by X-Webhook-Secret header) | — | `customers, invoices` |
| `/feedback` | POST | `/api` | Submit bug report (customer/agent) | `feedback_submissions` | — |
| `/feedback/mine` | GET | `/api` | List user's submitted feedback | `feedback_submissions` | — |

---

## 2. COMPONENT INVENTORY

Inventory of key React components: props, state, interactive elements, data-testid coverage.

### 2.1 Layout & Shell Components

#### `Layout.jsx`
- **Props**: `{ children }`
- **State**: None (pure wrapper)
- **Renders**: Sidebar, main content, notifications
- **Interactive**: Sidebar navigation, profile menu
- **Tests**: No data-testid found

#### `Sidebar.jsx`
- **Props**: None
- **State**: `expanded` (boolean), `mobile` (boolean)
- **Key Interactives**:
  - Role-based menu (Customer/Agent/Admin)
  - Collapsible on mobile
  - Active route highlighting
- **Tests**: No data-testid found

#### `Login.jsx`
- **Props**: None
- **State**: `email`, `password`, `error`, `loading`
- **Key Interactives**: Email/password inputs, submit button
- **Flow**: POST /api/auth/login → redirects to dashboard
- **Tests**: No data-testid found

#### `SetupPassword.jsx`
- **Props**: `{ token }`
- **State**: `password`, `confirmPassword`, `loading`, `error`
- **Key Interactives**: Password input, setup button
- **Flow**: POST /api/auth/setup-password with token
- **Tests**: No data-testid found

### 2.2 Common Components

#### `PlanBadge.jsx` (Reusable)
- **Props**: `{ plan }` (free|basic|moderate|premium)
- **State**: None
- **Renders**: Color-coded badge
- **Colors**:
  - free: gray
  - basic: blue
  - moderate: purple
  - premium: amber
- **Tests**: No data-testid

#### `StatusBadge.jsx` (Reusable)
- **Props**: `{ isActive, expiry }`
- **State**: None
- **Renders**: Active (green) / Expired (red) badge
- **Tests**: No data-testid

#### `TicketStatusBadge.jsx` (Reusable)
- **Props**: `{ status }` (open|pending|closed)
- **State**: None
- **Colors**: open (blue), pending (yellow), closed (gray)
- **Tests**: No data-testid

#### `PriorityBadge.jsx` (Reusable)
- **Props**: `{ priority }` (low|normal|medium|high)
- **State**: None
- **Colors**: low (gray), normal (blue), medium (orange), high (red)
- **Tests**: No data-testid

#### `UsageBar.jsx` (Reusable)
- **Props**: `{ used, limit, label }`
- **State**: None
- **Renders**: Progress bar with percentage
- **Behavior**: Shows "Unlimited" if limit is null
- **Tests**: No data-testid

#### `PlanGate.jsx` (Not found but conceptual)
- **Would Props**: `{ requiredPlan, children, fallback }`
- **Would Logic**: Check customer plan tier; render children if allowed, fallback otherwise
- **Actual Implementation**: Checks happen in controller/route layer, not component

#### `ErrorBoundary.jsx`
- **Props**: `{ children }`
- **State**: `hasError`, `error`
- **Behavior**: Catches React errors, displays fallback UI, logs to console
- **Tests**: No data-testid

#### `Skeleton.jsx` (Loading)
- **Props**: `{ width, height, circle }`
- **State**: None
- **Renders**: Shimmer animation placeholder
- **Tests**: No data-testid

#### `FeedbackWidget.jsx`
- **Props**: None
- **State**: `open`, `title`, `description`, `files`
- **Interactive**: Form with file uploads (max 5 files)
- **Flow**: POST /api/feedback with multipart form
- **Tests**: No data-testid

### 2.3 Customer Components

#### `Dashboard.jsx` (Customer)
- **Props**: None
- **State**: `dashboard` (loaded from GET /api/customer/dashboard)
- **Renders**:
  - PlanBadge (current plan)
  - StatusBadge (plan active/expired)
  - UsageBar (tickets, chats, calls)
  - Welcome tour (first-time users)
  - Quick action buttons
- **Data Fields**:
  - `planName`, `planExpiry`, `isActive`
  - `ticketsUsed`, `ticketsLimit`
  - `chatsUsed`, `chatsLimit`
  - `callsUsed`, `callsLimit`
- **Tests**: No data-testid

#### `Tickets.jsx` (Customer)
- **Props**: None
- **State**: `tickets`, `filter` (status), `search`
- **Interactive**: List of tickets (click to detail), create button, filters
- **Reads**: GET /api/tickets
- **Tests**: No data-testid

#### `TicketDetail.jsx`
- **Props**: `{ ticketId }`
- **State**: `ticket`, `messages`, `replyText`, `attachments`, `loading`
- **Interactive**:
  - Message composer (multiline)
  - File upload (attachments)
  - Close/reopen buttons
  - CC email editor
- **Reads**: GET /api/tickets/:id, GET /api/attachments?ref_type=ticket
- **Writes**: POST /api/tickets/:id/messages, PUT /api/tickets/:id/close
- **Side Effects**: Socket.io listen for real-time message updates (if agent replies)
- **Tests**: No data-testid

#### `NewTicket.jsx`
- **Props**: None
- **State**: `category`, `subject`, `description`, `attachments`, `suggestions`
- **Interactive**:
  - Category selector (dropdown)
  - Subject/description inputs
  - File uploads
  - Bot suggestions (show KB matches before submit)
- **Flow**:
  1. User types → POST /api/tickets/bot-suggest (keyword search)
  2. Show matches (if found, user can click to view)
  3. If user submits → POST /api/customer/bot/ticket
- **Tests**: No data-testid

#### `Chat.jsx`
- **Props**: None
- **State**: `chatId`, `messages`, `messageText`, `loading`, `agentName`
- **Interactive**:
  - Message composer (multiline)
  - File upload
  - Typing indicator
  - Close chat button
- **Reads**: Socket.io `chat_history`, `new_message`, `chat_accepted`, `user_typing`
- **Writes**: Socket.io `join_chat`, `send_message`, `send_file`, `typing`, `close_chat`
- **Tests**: No data-testid

#### `Call.jsx`
- **Props**: None
- **State**: `callId`, `status`, `duration`, `agentName`, `agentPhone`, `customerPhone`
- **Interactive**: Call UI (in progress / ended), notes input (post-call)
- **Reads**: Socket.io call status updates
- **Writes**: Socket.io call events
- **Tests**: No data-testid

#### `Profile.jsx`
- **Props**: None
- **State**: `profile`, `formData`
- **Interactive**: Edit email, phone, company; change password
- **Reads**: GET /api/auth/me
- **Writes**: PUT /api/customer/profile
- **Tests**: No data-testid

#### `Billing.jsx`
- **Props**: None
- **State**: `invoices`, `subscriptions`, `currentPlan`
- **Reads**: GET /api/customer/subscriptions, GET /api/customer/invoices
- **Interactive**:
  - Download invoice PDF (GET /api/customer/invoices/:id/pdf)
  - Upgrade plan (POST /api/customer/upgrade/initiate → Razorpay)
  - View quote (GET /api/customer/quotes/:id/pdf)
  - Pay quote (POST /api/customer/quotes/:id/pay/initiate)
- **Tests**: No data-testid

#### `ChatHistory.jsx`
- **Props**: None
- **State**: `chats`, `pagination`
- **Interactive**: List closed chats, click to view transcript
- **Reads**: GET /api/chat/history (paginated)
- **Tests**: No data-testid

#### `KnowledgeBase.jsx`
- **Props**: None
- **State**: `articles`, `searchText`, `selectedCategory`
- **Interactive**: Search/filter articles, click to expand
- **Reads**: GET /api/kb/articles (or internal KB posts)
- **Tests**: No data-testid

#### `WelcomeTour.jsx`
- **Props**: `{ onComplete }`
- **State**: `step`
- **Behavior**: Multi-step onboarding tour (first-time customer)
- **Tests**: No data-testid

#### `CustomerCallMiniOverlay.jsx`
- **Props**: None
- **State**: `incomingCall` (from CustomerCallContext)
- **Renders**: Floating overlay when agent initiates call to customer
- **Interactive**: Answer / Decline buttons
- **Tests**: No data-testid

#### `IncomingAgentCall.jsx`
- **Props**: None
- **State**: `call`, `ringing`, `duration`
- **Interactive**: Answer/decline, hang up
- **Tests**: No data-testid

#### `BotWidget.jsx`
- **Props**: None
- **State**: `messages`, `input`, `suggestions`
- **Interactive**: Chat-like input, suggestions (quick replies)
- **Flow**: Customer can ask pre-ticket questions; bot responds from KB
- **Tests**: No data-testid

#### `NotificationBell.jsx` (Customer)
- **Props**: None
- **State**: `unreadCount`, `notifications`
- **Reads**: Socket.io for incoming chat requests, call offers
- **Interactive**: Bell icon with badge; click to open notification drawer
- **Tests**: No data-testid

### 2.4 Agent Components

#### `Dashboard.jsx` (Agent)
- **Props**: None
- **State**: `stats`
- **Reads**: GET /api/agent/dashboard
- **Renders**:
  - My stats: SLA%, CSAT, response time
  - Active tickets (assigned)
  - Waiting chats (unassigned)
  - Current calls (if any)
- **Tests**: No data-testid

#### `Tickets.jsx` (Agent)
- **Props**: None
- **State**: `tickets`, `filters` (status, assigned, priority)
- **Interactive**: List, claim, update status, bulk actions
- **Reads**: GET /api/agent/tickets
- **Writes**: POST /api/agent/tickets/:id/claim, PUT /api/agent/tickets/:id
- **Tests**: No data-testid

#### `Chats.jsx` (Agent)
- **Props**: None
- **State**: `pendingChats`, `myChats`, `acceptingChatId`
- **Reads**: GET /api/agent/chats/pending, GET /api/agent/chats/mine
- **Interactive**:
  - Pending chats list (accept button)
  - My active chats (click to open)
- **Socket.io**: Listen for `new_chat_request` (ring/toast)
- **Tests**: No data-testid

#### `Calls.jsx` (Agent)
- **Props**: None
- **State**: `calls`
- **Reads**: GET /api/agent/calls/mine
- **Interactive**: List recent calls, add post-call notes
- **Writes**: POST /api/agent/calls/:id/notes
- **Tests**: No data-testid

#### `Performance.jsx` (Agent)
- **Props**: None
- **State**: `performance` (personal stats)
- **Reads**: GET /api/agent/my-performance
- **Renders**:
  - CSAT average
  - SLA compliance %
  - Avg response time
  - Chats handled
  - Calls handled
- **Tests**: No data-testid

#### `AgentCallOverlay.jsx`
- **Props**: None
- **State**: `activeCall` (from CustomerCallContext)
- **Interactive**: In-call UI (mute, hold, transfer, end call)
- **Tests**: No data-testid

#### `OutboundCallOverlay.jsx`
- **Props**: None
- **State**: `ringing`, `duration`, `callTarget`
- **Interactive**: Initiate call, cancel ringing, hang up
- **Tests**: No data-testid

#### `IncomingChatTransferOverlay.jsx`
- **Props**: None
- **State**: `pendingTransfers`
- **Interactive**: Accept/decline incoming chat transfer
- **Reads**: Socket.io `chat_transfer_offer`
- **Writes**: Socket.io `accept_chat_transfer` / `reject_chat_transfer`
- **Tests**: No data-testid

#### `NotificationBell.jsx` (Agent)
- **Props**: None
- **State**: `unreadCount`, `toasts`
- **Reads**: Socket.io `new_chat_request`, `call_offer`, `chat_transfer_offer`, etc.
- **Interactive**: Bell icon; clicks open drawer; 90s toast for new chats
- **Tests**: No data-testid

#### `CommandPalette.jsx`
- **Props**: None
- **State**: `open`, `query`, `results` (macros, quick actions)
- **Interactive**: Cmd+K to open, type to search, arrow keys to navigate
- **Flow**: Agent can insert canned response, create ticket, transfer chat, etc.
- **Tests**: No data-testid

### 2.5 Admin Components

#### `Dashboard.jsx` (Admin)
- **Props**: None
- **State**: `overview`
- **Reads**: GET /api/admin/dashboard
- **Renders**:
  - Total customers, revenue (MRR/ARR)
  - Ticket SLA health %
  - Chat/call volume (this month)
  - Agent stats
- **Tests**: No data-testid

#### `Customers.jsx`
- **Props**: None
- **State**: `customers`, `search`, `pagination`
- **Interactive**: Search, filter by plan, click to detail, bulk actions
- **Reads**: GET /api/admin/customers
- **Tests**: No data-testid

#### `Agents.jsx`
- **Props**: None
- **State**: `agents`, `createFormOpen`
- **Interactive**: List agents, create, toggle active, delete, update skills
- **Reads**: GET /api/admin/agents
- **Writes**: POST /api/admin/agents, PUT /api/admin/agents/:id/toggle, DELETE /api/admin/agents/:id
- **Tests**: No data-testid

#### `Plans.jsx`
- **Props**: None
- **State**: `plans`
- **Interactive**: Edit plan limits, pricing formula
- **Reads**: GET /api/admin/plans
- **Writes**: PUT /api/admin/plans/:id
- **Tests**: No data-testid

#### `Reports.jsx`
- **Props**: None
- **State**: `reportType`, `data`, `dateRange`
- **Interactive**:
  - Date range picker
  - Report type selector (tickets, revenue, usage)
  - Export CSV button
- **Reads**: GET /api/admin/reports/{tickets|revenue|usage}, GET /api/admin/reports/export
- **Tests**: No data-testid

#### `AuditLog.jsx`
- **Props**: None
- **State**: `logs`, `filters` (actor, action, entity)
- **Interactive**: Filter, paginate, view detail
- **Reads**: GET /api/audit
- **Tests**: No data-testid

#### `Chats.jsx` (Admin)
- **Props**: None
- **State**: `chats`, `filters`
- **Interactive**: View all chats, reassign, blacklist customers
- **Reads**: GET /api/admin/chats
- **Writes**: PUT /api/admin/chats/:id/assign, POST /api/admin/chats/blacklist
- **Tests**: No data-testid

#### `Tickets.jsx` (Admin)
- **Props**: None
- **State**: `tickets`, `filters` (status, priority, agent)
- **Interactive**: List all tickets, bulk update, reassign
- **Reads**: GET /api/admin/tickets
- **Writes**: POST /api/admin/tickets/bulk
- **Tests**: No data-testid

#### `Calls.jsx` (Admin)
- **Props**: None
- **State**: `calls`
- **Interactive**: View all calls, download transcript
- **Reads**: GET /api/admin/calls
- **Tests**: No data-testid

#### `Feedback.jsx`
- **Props**: None
- **State**: `feedbackList`, `selectedFeedback`
- **Interactive**: Review bug reports, update status, add resolution notes
- **Reads**: GET /api/admin/feedback
- **Writes**: PUT /api/admin/feedback/:id
- **Tests**: No data-testid

#### `Templates.jsx`
- **Props**: None
- **State**: `templates`
- **Interactive**: Create, edit, delete ticket templates
- **Reads**: GET /api/admin/templates
- **Writes**: POST/PUT/DELETE /api/admin/templates
- **Tests**: No data-testid

#### `Settings.jsx`
- **Props**: None
- **State**: `settings` (GMB link, CSAT threshold, etc.)
- **Interactive**: Edit global app settings
- **Reads**: GET /api/admin/settings
- **Writes**: PUT /api/admin/settings
- **Tests**: No data-testid

#### `Performance.jsx` (Admin)
- **Props**: None
- **State**: `agentStats`
- **Interactive**: View all agents' CSAT, SLA%, response time (ranked)
- **Reads**: GET /api/admin/performance
- **Tests**: No data-testid

#### `SystemHealth.jsx`
- **Props**: None
- **State**: `health` (usage drift, test results, socket connections)
- **Interactive**:
  - View usage drift (customers exceeding plan limits)
  - Run tests button (spawns routing-limits.test.js)
  - View agent presence debug (Socket.io sockets, rooms)
  - Reset customer usage (POST /api/admin/audit/reset-usage/:customerId)
- **Reads**: GET /api/admin/audit/usage-drift, GET /api/admin/debug/agent-presence
- **Writes**: POST /api/admin/audit/run-tests, POST /api/admin/audit/reset-usage/:id
- **Tests**: No data-testid

### 2.6 Context Providers

#### `AuthContext.jsx`
- **State**:
  - `user` (id, name, email, role)
  - `token` (JWT)
  - `loading`
  - `error`
- **Methods**:
  - `login(email, password)` → POST /api/auth/login
  - `logout()` → POST /api/auth/logout
  - `changePassword(oldPassword, newPassword)`
- **Usage**: Wrap app root; `useAuth()` hook in components

#### `SocketContext.jsx`
- **State**:
  - `socket` (Socket.io instance)
  - `connected` (boolean)
  - `isTyping` (per-chat)
  - `unreadMessages` (count)
- **Methods**:
  - `emit(event, data)`
  - `on(event, handler)` → register listener
  - `off(event, handler)` → unregister
- **Auto-reconnect**: Yes, with exponential backoff

#### `CustomerCallContext.jsx`
- **State**:
  - `incomingCall` (if agent initiated)
  - `activeCall` (during call)
  - `callHistory`
- **Methods**:
  - `acceptCall()` → Socket.io `accept_call`
  - `declineCall()` → Socket.io `decline_call`
  - `hangUp()` → Socket.io `end_call`

---

## 3. EXISTING TEST INVENTORY

**Current state:** Minimal test coverage.

### 3.1 Test Files

| File | Type | Test Count | Coverage |
|------|------|-----------|----------|
| `backend/tests/routing-limits.test.js` | Integration | 6 routing tests + 6 limit tests | High (routing + plan limits) |
| (No frontend tests found) | — | 0 | 0% |

### 3.2 Test Suite: `routing-limits.test.js`

**Purpose**: Verify invariants for routing and plan limits (critical product areas).

**Tests** (12 total):

**ROUTING (R1–R5)**
- **R1**: Customer chat initiate creates 'waiting' row + gets queue position
- **R2**: Chat-busy agents counted as busy on GET /api/customer/agent-status
- **R3**: Bot-ticket endpoint auto-assigns ticket to agent (skill-based routing)
- **R4**: Call router (call_offer) excludes chat-busy agents from ring pool
- **R5**: Free-plan customer can't access GET /api/chat or GET /api/calls

**LIMITS (L1–L6)**
- **L1**: `getChatUsage()` counts (engaged-this-month) + (currently waiting/active)
- **L2**: `getCallUsage()` counts only real-connected customer-initiated calls
- **L3**: Customer at chat limit gets 403 limit_exceeded on initiate
- **L4**: Customer at call limit gets 403 on call initiate
- **L5**: Counter parity — dashboard.chatsUsed == count of rows with customer message; callsUsed == connected count
- **L6**: Missed/failed calls don't increment call counter

**Infrastructure**
- Uses `node http` module (no axios/fetch deps)
- Rates-limited test harness (`test()`, `assert()`, `assertEqual()`)
- Runs against live backend (expects `http://localhost:5000`)
- Exit code 0 (all pass) or 1 (any fail)
- Command: `npm run test:routing`

### 3.3 Coverage Gaps

| Feature | Coverage |
|---------|----------|
| **Route layer** | ✅ High (routing-limits tests core flows) |
| **Plan gates** | ✅ High (limits tests core checks) |
| **Component rendering** | ❌ None (no React testing library) |
| **Socket.io events** | ⚠️ Minimal (ad-hoc Socket.io tests needed) |
| **Email/webhooks** | ❌ None (async fire-and-forget; hard to test) |
| **Error handling** | ⚠️ Partial (edge cases not covered) |
| **Concurrent requests** | ⚠️ Partial (race conditions untested) |
| **Authentication/JWT** | ❌ None (tested indirectly in routing tests) |

### 3.4 Test Framework

- **Backend**: Custom lightweight harness (no Jest/Mocha)
- **Frontend**: None
- **CI/CD**: None visible (no GitHub Actions / scripts folder)

---

## 4. DATABASE SCHEMA SUMMARY

### 4.1 Core Tables (schema.sql)

| Table | Purpose | Key Columns | Relationships |
|-------|---------|-------------|---------------|
| `users` | All user accounts (customer, agent, admin) | `id`, `email`, `password`, `role`, `is_active`, `created_at` | — |
| `customers` | Customer-specific metadata (1:1 extension of users) | `id`, `user_id` (FK), `plan_id` (FK), `plan_expiry`, `invoice_subtotal`, `domain`, `products` (JSON) | users.id, plans.id |
| `plans` | Support tier definitions (free, basic, moderate, premium) | `id`, `name`, `allow_email_ticket`, `allow_chat`, `allow_calls`, `tickets_limit`, `calls_limit`, `priority`, `percentage`, `minimum_price` | — |
| `tickets` | Support tickets | `id`, `customer_id` (FK), `subject`, `description`, `status` (open/pending/closed), `priority`, `assigned_agent_id` (FK), `cc_emails`, `created_at`, `updated_at` | customers.id, users.id |
| `ticket_messages` | Ticket replies | `id`, `ticket_id` (FK), `sender_id` (FK), `message`, `created_at` | tickets.id, users.id |
| `ticket_usage` | Monthly ticket counter | `id`, `customer_id` (FK), `month_year` (YYYY-MM), `count`, **UNIQUE(customer_id, month_year)** | customers.id |
| `chats` | Chat sessions | `id`, `customer_id` (FK), `agent_id` (FK nullable), `status` (waiting/active/closed), `created_at`, `accepted_at`, `closed_at` | customers.id, users.id |
| `chat_messages` | Chat message history | `id`, `chat_id` (FK), `sender_id` (FK), `message`, `created_at` | chats.id, users.id |
| `call_usage` | Monthly call counter | `id`, `customer_id` (FK), `month_year` (YYYY-MM), `count`, **UNIQUE(customer_id, month_year)** | customers.id |
| `calls` | VoIP call records (simulated) | `id`, `customer_id` (FK), `agent_id` (FK nullable), `virtual_number`, `status` (initiated/ringing/active/ended/failed/missed), `call_start_time`, `call_end_time`, `duration`, `created_at` | customers.id, users.id |
| `invoices` | Billing records | `id`, `customer_id` (FK), `plan_id` (FK), `subtotal`, `gst_rate`, `gst_amount`, `final_price`, `status` (pending/paid/overdue), `due_date`, `created_at` | customers.id, plans.id |

### 4.2 Feature Tables (migrations/001_features.sql)

| Table | Purpose | Key Columns | Relationships |
|-------|---------|-------------|---------------|
| `file_attachments` | File uploads (ticket/chat) | `id`, `ref_type` (ticket/ticket_message/chat_message), `ref_id`, `original_name`, `stored_name`, `mime_type`, `size_bytes`, `uploaded_by` (FK), `created_at` | users.id |
| `ratings` | CSAT feedback | `id`, `ref_type` (ticket/call), `ref_id`, `customer_id` (FK), `agent_id` (FK nullable), `score` (1-5), `comment`, `gmb_clicked`, `created_at`, **UNIQUE(ref_type, ref_id)** | customers.id, users.id |
| `canned_responses` | Agent macros | `id`, `created_by` (FK), `title`, `body`, `is_global`, `created_at`, `updated_at` | users.id |
| `audit_log` | Action trail | `id`, `actor_id` (FK), `actor_name`, `actor_role`, `action`, `entity_type`, `entity_id`, `old_value`, `new_value`, `ip_address`, `created_at` | users.id |
| `customer_notes` | Internal notes on customer (agent/admin only) | `id`, `customer_id` (FK), `author_id` (FK), `note`, `created_at`, `updated_at` | customers.id, users.id |
| `sla_configs` | SLA rule per priority | `id`, `priority` (low/normal/medium/high), `response_hours`, `resolve_hours`, `created_at`, `updated_at`, **UNIQUE(priority)** | — |
| `otp_codes` | 2FA codes | `id`, `user_id` (FK), `code` (6 digits), `expires_at`, `used`, `created_at` | users.id |
| `app_settings` | Global config (GMB link, CSAT threshold, SLA notifications) | `id`, `setting_key`, `setting_value`, **UNIQUE(setting_key)** | — |

### 4.3 Logical Relationships

```
users (many)
  ├── customers (1:1 extension where role='customer')
  │    ├── plans (1:N)
  │    ├── tickets (1:N)
  │    ├── chats (1:N)
  │    ├── calls (1:N)
  │    ├── invoices (1:N)
  │    └── customer_notes (1:N authored by agents/admins)
  │
  ├── tickets (assigned_agent_id)
  │    ├── ticket_messages (1:N)
  │    └── file_attachments (1:N via ref_type='ticket')
  │
  ├── chats (agent_id)
  │    ├── chat_messages (1:N)
  │    └── file_attachments (1:N via ref_type='chat_message')
  │
  ├── calls (agent_id)
  │    └── ratings (1:1 per call via ref_type='call')
  │
  └── canned_responses (created_by)
```

### 4.4 Tenant Isolation

**No explicit tenant isolation** — schema assumes single-tenant SaaS (one customer = one end-user organization; agent/admin are internal).

- **Customer isolation**: `customers.user_id` + `customers.id` FK ensures each customer sees only their own tickets/chats/calls
- **Agent/Admin access**: No scoping; agents see all customers' tickets, chats, calls assigned to them or globally visible
- **Audit trail**: All actions logged in `audit_log` with `actor_id`, `entity_type`, `entity_id` for compliance

### 4.5 Column Additions for Features (001_features.sql)

```sql
ALTER TABLE tickets ADD COLUMN sla_response_due TIMESTAMP DEFAULT NULL;
ALTER TABLE tickets ADD COLUMN sla_resolve_due TIMESTAMP DEFAULT NULL;
ALTER TABLE tickets ADD COLUMN sla_breached BOOLEAN DEFAULT FALSE;
ALTER TABLE tickets ADD COLUMN first_response_at TIMESTAMP DEFAULT NULL;
ALTER TABLE chats ADD COLUMN category VARCHAR(255); -- pre-chat category selected by customer
ALTER TABLE chats ADD COLUMN transfer_note TEXT; -- note on why chat was transferred
ALTER TABLE calls ADD COLUMN initiated_by VARCHAR(50); -- 'customer' or 'agent' (null = ambiguous)
ALTER TABLE users ADD COLUMN on_break_until TIMESTAMP; -- agent on-break timer
ALTER TABLE users ADD COLUMN last_status ENUM('online','busy','away','on_break'); -- persisted agent status
ALTER TABLE users ADD COLUMN active_session_jti VARCHAR(255); -- revocation key for JWT
ALTER TABLE customers ADD COLUMN usage_reset_at TIMESTAMP; -- resets chat/call usage counters
-- etc.
```

---

## 5. PLAN GATE MAP

Complete mapping of where plan tier checks occur in code.

### 5.1 Feature Gating by Plan

| Feature | Free | Basic | Moderate | Premium | Implementation |
|---------|------|-------|----------|---------|-----------------|
| **Email Tickets** | ✅ Unlimited | ✅ 5/mo | ✅ 10/mo | ✅ 20/mo | Route: `/api/customer/bot/ticket` checks `plans.allow_email_ticket` |
| **Live Chat** | ❌ | ✅ | ✅ | ✅ | Route: `/api/chat/initiate` checks `plans.allow_chat` + active plan |
| **Phone Calls** | ❌ | ❌ | ✅ 5/mo | ✅ 10/mo | Route: `/api/calls/initiate` checks `plans.allow_calls` + limit |
| **Ticket Priority** | low | normal | medium | high | Field: `plans.priority` affects SLA response/resolve hours |
| **SLA Response Time** | — | 24h | 12h | 4h | Table: `sla_configs` keyed by `priority` |
| **SLA Resolve Time** | — | 72h | 48h | 24h | Table: `sla_configs` |

### 5.2 Plan Check Locations (Code Paths)

#### **Chat Access Gate**
```
POST /api/chat/initiate
  → chatController.initiateChat()
    → planUtils.getCustomerWithPlan(userId)
      → checks: allow_chat = true (from plans table, or override)
      → checks: isPlanActive(customer) = plan_expiry >= NOW()
      → if !allow_chat → return 403 'chat_not_available'
      → if !isPlanActive → return 403 'plan_expired'
      → else → create chat, emit Socket.io new_chat_request
```

#### **Call Access Gate**
```
POST /api/calls/initiate
  → callController.initiateCall()
    → planUtils.getCustomerWithPlan(userId)
      → checks: allow_calls = true
      → checks: isPlanActive(customer)
      → checks: getCallUsage(customerId) < plans.calls_limit
      → if !allow_calls → return 403 'calls_not_available'
      → if !isPlanActive → return 403 'plan_expired'
      → if usage >= limit → return 403 'limit_exceeded'
      → else → create call, emit Socket.io call_offer
```

#### **Ticket Creation Gate**
```
POST /api/customer/bot/ticket
  → customerController.botRaiseTicket()
    → planUtils.getCustomerWithPlan(userId)
      → checks: allow_email_ticket = true
      → checks: getTicketUsage(customerId) < plans.tickets_limit (if limit exists)
      → if !allow_email_ticket → return 403 'tickets_not_available'
      → if usage >= limit → return 403 'limit_exceeded'
      → else → create ticket, auto-assign agent, return ticket
```

#### **Usage Tracking Gates**

**Chat Usage** — increments when:
1. Agent accepts chat (Socket.io `accept_chat`)
   - Function: `incrementChatUsage(customerId)` in chatSocket.js
2. Dashboard queries count via `getChatUsage()`:
   - Counts distinct chats where:
     - `chats.customer_id = ?`
     - `chats.accepted_at IS NOT NULL` (agent actually accepted, not just initiated)
     - `chats.accepted_at` in current month
     - Has at least one customer message (user.role = 'customer')
     - Not before `customers.usage_reset_at` (if admin reset)

**Call Usage** — increments when:
1. Agent accepts call (Socket.io event, triggers `incrementCallUsage()`)
2. Dashboard queries count via `getCallUsage()`:
   - Counts calls where:
     - `calls.customer_id = ?`
     - `calls.initiated_by IS NULL OR initiated_by != 'agent'` (customer-initiated only)
     - `calls.call_start_time IS NOT NULL` (agent picked up) OR `status IN ('ringing','active')`
     - `DATE_FORMAT(created_at, '%Y-%m') = current_month`
     - Not before `customers.usage_reset_at`
   - **Missed/failed calls** do NOT count (no call_start_time = agent never picked up)

**Ticket Usage** — increments when:
1. Customer creates ticket via bot flow (POST /api/customer/bot/ticket)
   - Function: `incrementTicketUsage(customerId)` 
2. Dashboard queries count via `getTicketUsage()`:
   - Reads from `ticket_usage` table (keyed by customer_id + month_year)
   - No reset logic yet (historical for reference)

### 5.3 Plan Override Mechanism

**Feature**: Per-customer overrides (stored in `customer_feature_overrides` table).

```sql
CREATE TABLE customer_feature_overrides (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL UNIQUE,
  allow_chat BOOLEAN,
  allow_calls BOOLEAN,
  tickets_limit INT,
  calls_limit INT,
  override_reason VARCHAR(255),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
```

**Code**:
```javascript
// planUtils.js: getCustomerWithPlan()
const r = rows[0];  // customer + plan row
if (r.ov_chat !== null) r.allow_chat = r.ov_chat;  // override trumps plan
if (r.ov_calls !== null) r.allow_calls = r.ov_calls;
if (r.ov_tickets !== null) r.tickets_limit = r.ov_tickets;
// ... use r.allow_chat, r.allow_calls, r.tickets_limit for gate checks
```

**Usage**: Admin can set overrides via:
```
GET  /api/admin/customers/:id/overrides → fetch overrides
PUT  /api/admin/customers/:id/overrides → upsert overrides
DELETE /api/admin/customers/:id/overrides → delete overrides
```

### 5.4 Pricing Calculation (No gate, but plan-aware)

```javascript
// planUtils.js
function calculateFinalPrice(planName, invoiceSubtotal) {
  const config = {
    basic:    { percentage: 0.05, minimum: 3000 },     // max(5%, ₹3,000)
    moderate: { percentage: 0.10, minimum: 8000 },     // max(10%, ₹8,000)
    premium:  { percentage: 0.15, minimum: 20000 },    // max(15%, ₹20,000)
  };
  return Math.max(invoiceSubtotal * pct, minimum);
}
```

Used in invoice generation (admin creates invoice for plan upgrade).

---

## 6. SOCKET.IO EVENT CATALOG

Complete map of Socket.io events: direction, emitter, listener, roles, rooms, payloads.

### 6.1 Client → Server Events

#### **Chat Events**

| Event | Emitted By | Payload | Handler | Rooms Affected | Notes |
|-------|-----------|---------|---------|----------------|-------|
| `join_chat` | Customer, Agent, Admin | `{ chatId }` | chatSocket.js | `chat_{chatId}` | Fetches chat history, checks permissions |
| `send_message` | Customer, Agent, Admin | `{ chatId, message }` | chatSocket.js | `chat_{chatId}` | Broadcasts `new_message` to room |
| `send_file` | Customer, Agent, Admin | `{ chatId, fileName, fileType, fileData, caption }` | chatSocket.js | `chat_{chatId}` | Stores in `file_attachments`, broadcasts `new_message` |
| `typing` | Customer, Agent, Admin | `{ chatId, isTyping }` | chatSocket.js | `chat_{chatId}` | Broadcasts `user_typing` (no storage) |
| `mark_read` | Customer, Agent, Admin | `{ chatId }` | chatSocket.js | `chat_{chatId}` | Updates `read_at` on messages; emits `messages_read` |
| `accept_chat` | Agent, Admin | `{ chatId }` | chatSocket.js | `chat_{chatId}`, `agents` | Atomic claim; increments chat usage |
| `close_chat` | Customer, Agent, Admin | `{ chatId }` | chatSocket.js | `chat_{chatId}`, `agents` | Closes chat; cancels ring if waiting |
| `notify_chat_transfer` | Agent, Admin | `{ chatId, targetAgentId, transferNote }` | chatSocket.js | `user_{targetAgentId}` | Creates pending transfer offer (30s timeout) |
| `accept_chat_transfer` | Agent, Admin | `{ chatId }` | chatSocket.js | `chat_{chatId}` | Commits transfer; ejcts old agent from room |
| `reject_chat_transfer` | Agent, Admin | `{ chatId }` | chatSocket.js | `user_{fromAgentId}` | Declines transfer; rolls back to originator |

#### **Agent Room Events**

| Event | Emitted By | Payload | Handler | Rooms Affected | Notes |
|-------|-----------|---------|---------|----------------|-------|
| `join_agent_room` | Agent, Admin | — | chatSocket.js | `agents` | Hydrates status, broadcasts `agent_status_changed` |
| `agent_status_changed` | Agent (on join) | `{ agentId, name, status }` | Socket.io auto | `agents` | All agents see status change (online/busy/away/on_break) |

#### **Call Events** (Simulated VoIP)

| Event | Emitted By | Payload | Handler | Notes |
|-------|-----------|---------|---------|-------|
| `initiate_call` | Customer (via REST) | — | Socket.io `call_offer` | Agent's ring via `/api/calls/initiate` |
| `accept_call` | Agent | `{ callId }` | chatSocket.js | Updates call status='active', starts timer |
| `end_call` | Agent, Customer | `{ callId }` | chatSocket.js | Ends call, records duration, increments usage |
| `decline_call` | Agent | `{ callId }` | chatSocket.js | Declines ring; escalates to next agent |

---

### 6.2 Server → Client Events

#### **Chat Events (Broadcast)**

| Event | Emitted To | Payload | Trigger | Notes |
|-------|-----------|---------|---------|-------|
| `chat_history` | Customer (direct) | `{ messages: [...] }` | join_chat | Sends past messages when joining |
| `new_message` | `chat_{chatId}` | `{ message: { id, sender_id, sender_name, sender_role, message, created_at } }` | send_message, accept_chat (greeting) | Real-time message broadcast |
| `user_typing` | `chat_{chatId}` | `{ userId, name, role, isTyping }` | typing event | Typing indicator |
| `messages_read` | `chat_{chatId}` | `{ chatId, by: userId }` | mark_read | Notifies unread messages were read |
| `chat_accepted` | `chat_{chatId}` | `{ agentName (neutralized), chatId }` | accept_chat | Notifies customer/agents chat is now active |
| `chat_closed` | `chat_{chatId}` | `{ chatId }` | close_chat | Notifies both parties chat is closed |
| `chat_removed` | `agents` | `{ chatId }` | close_chat | Tells agents to remove from queue |
| `new_chat_request` | `agents` (or `user_{agentId}` if rung) | `{ chatId, customer: {...}, category, ... }` | join_chat (waiting) | Agent sees new chat in queue (or gets rung if sequential assign) |
| `chat_request_cancelled` | `user_{agentId}` | `{ chatId }` | clearChatRing | Tells rung agent chat no longer theirs |
| `chat_request_accepted` | `agents` | `{ chatId, agentName }` | accept_chat | Notifies all agents chat was claimed |
| `chat_transfer_offer` | `user_{targetAgentId}` | `{ chatId, fromAgent, transferNote, timeoutMs, customer: {...} }` | notify_chat_transfer | Offers transfer to target agent (30s timer) |
| `chat_transfer_pending` | `user_{fromAgentId}` | `{ chatId, toAgentName, timeoutMs }` | notify_chat_transfer | Confirms offer sent to target |
| `chat_transfer_accepted` | `user_{toAgentId}`, `chat_{chatId}` | `{ chatId, fromAgent, transferNote, customer: {...} }` | accept_chat_transfer | Confirms transfer success; updates agent in chat |
| `chat_transfer_timeout` | `user_{fromAgentId}` | `{ chatId, toAgentName }` | 30s timeout | Offer expired; rolled back to originator |
| `chat_transfer_cancelled` | `user_{targetAgentId}` | `{ chatId }` | reject_chat_transfer, timeout | Offer cancelled |
| `chat_transfer_failed` | `user_{fromAgentId}` | `{ chatId, reason }` | Various validation errors | Transfer failed for a reason |

#### **Agent Status Events**

| Event | Emitted To | Payload | Trigger | Notes |
|-------|-----------|---------|---------|-------|
| `agent_status_changed` | `agents` | `{ agentId, name, status }` | join_agent_room, status change | Notifies all agents of one agent's status change |
| `agent_availability_changed` | All connected sockets | — | join_agent_room | Tells customers to re-check agent availability |
| `auto_assign_status` | Agent (direct) | `{ enabled: boolean }` | join_agent_room | Tells agent if auto-assign is on |

#### **Call Events**

| Event | Emitted To | Payload | Trigger | Notes |
|-------|-----------|---------|---------|-------|
| `call_offer` | `user_{agentId}` | `{ callId, customerId, customer: {...}, timeoutMs }` | /api/calls/initiate | Agent gets rung (similar to chat transfer offer) |
| `call_accepted` | Customer, Agent | `{ callId, agentName }` | Agent accepts (via REST) | Notifies customer agent answered |
| `call_ended` | Customer, Agent | `{ callId, duration }` | /api/calls/:id/end | Notifies both parties call ended |
| `incoming_call` | Customer | `{ callId, agentName }` | Agent initiates outbound (REST) | Customer sees incoming call UI |

#### **Usage Events**

| Event | Emitted To | Payload | Trigger | Notes |
|-------|-----------|---------|---------|-------|
| `usage_reset` | `user_{customerId}` | `{ reset_at, callLimit, chatLimit }` | POST /api/admin/audit/reset-usage | Notifies customer usage was reset |

#### **Error Events**

| Event | Emitted To | Payload | Trigger | Notes |
|-------|-----------|---------|---------|-------|
| `error` | Sender (direct) | `{ message }` | Any validation failure | Generic error response |

---

### 6.3 Rooms & Namespaces

| Room | Members | Purpose | Lifecycle |
|------|---------|---------|-----------|
| `user_{userId}` | User's sockets (multi-device) | Targeted notifications (messages, calls, status) | Auto-join on connect; leave on disconnect |
| `chat_{chatId}` | Sockets in this chat (customer + agents) | Chat message broadcast; transfer offers | Created on join_chat; destroyed on close_chat |
| `agents` | All agent+admin sockets | Broadcast to agents (new chats, transfers, status changes) | Auto-join on join_agent_room; leave on disconnect |
| Default namespace | All connected sockets | Broadcast to all (agent availability changes) | Auto-join on connect |

---

### 6.4 Authentication & Middleware

```javascript
// chatSocket.js: io.use() middleware
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  const decoded = jwt.verify(token, JWT_SECRET);
  const user = await pool.query('SELECT * FROM users WHERE id = ? AND is_active');
  
  // Single-device enforcement: token.jti must match users.active_session_jti
  if (decoded.jti !== user.active_session_jti) {
    return next(new Error('session_revoked'));
  }
  
  socket.user = user;
  next();
});
```

- **JWT**: Must be passed in `socket.handshake.auth.token`
- **Session Revocation**: If another login happens, old socket's token is invalidated (jti mismatch)

---

### 6.5 Concurrency & Race Prevention

#### **Chat Accept Race**
```javascript
// Two agents rapid-click accept on same chat:
const [result] = await pool.query(
  "UPDATE chats SET agent_id=?, status='active' WHERE id=? AND status='waiting' AND agent_id IS NULL",
  [socket.user.id, chatId]
);
// Only first to UPDATE wins (affectedRows=1); second gets 0 and bails silently.
if (result.affectedRows === 0) return;  // Already claimed
```

#### **Chat Transfer Offer**
```javascript
// Stored in-memory: pendingChatTransfers.set(chatId, {...})
// Timeout: 30s auto-rollback if target doesn't accept
// DB commit: only happens on explicit accept_chat_transfer
```

#### **Zombie Reap**
```javascript
// On startup:
pool.query("UPDATE calls SET status='failed' WHERE status IN ('ringing','active') AND created_at < NOW()-INTERVAL 1 HOUR");
// Cleans up stale calls from crashes.
```

---

### 6.6 Subscription / Messaging Example

**Customer joins chat**:
```javascript
socket.emit('join_chat', { chatId: 5 });
// → Backend: join room chat_5, fetch history
socket.on('chat_history', ({ messages }) => { ... });  // Receive history
socket.on('new_message', ({ message }) => { ... });     // Listen for future messages
```

**Customer sends message**:
```javascript
socket.emit('send_message', { chatId: 5, message: 'Hello' });
// → Backend: insert into chat_messages, broadcast to chat_5 room
socket.on('new_message', ({ message }) => { ... });  // Receives own message back
```

**Agent accepts chat**:
```javascript
socket.emit('accept_chat', { chatId: 5 });
// → Backend: atomic UPDATE, increment usage, emit greeting, broadcast acceptance
socket.on('chat_accepted', ({ agentName }) => { ... });  // Customer sees agent accepted
```

---

## Summary

**DSP is a well-structured SaaS support panel** with clear separation between customer/agent/admin roles, comprehensive plan gating at the route layer, real-time Socket.io chat/calls, and basic usage-tracking counters. Test coverage is minimal but critical routing + limits tests exist. No component tests, no Socket.io integration tests, and no E2E tests. Schema is normalized with proper FK constraints and audit logging.

**Key Strengths**:
- Plan gate checks are centralized (planUtils.js)
- Real-time Socket.io handles chat/calls well
- Rate limiting on auth endpoints
- Audit log trails
- Admin System Health panel for drift detection

**Key Gaps**:
- No component-level tests (React Testing Library)
- No E2E tests (Cypress/Playwright)
- Socket.io events untested (besides ad-hoc manual tests)
- Email/webhook delivery untested (fire-and-forget)
- No explicit multi-tenant isolation (single-tenant by design)

---

**End of Inventory**
