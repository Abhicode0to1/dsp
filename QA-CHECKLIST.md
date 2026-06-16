# DSP — Pre-Production QA Checklist

Run through this on the **live app** before deploying to GCP. Mark each item ✅ / ❌.
Items in **bold** are changes made in the recent work session — re-verify these specifically (regression pass).
🖥️ = needs a real device / real inbox (can't be tested headlessly).

---

## 0. Pre-flight
- [ ] Frontend builds clean (`npm run build`) — no errors
- [ ] Backend boots clean (`npm start`) — tables migrate, no crash
- [ ] `/api/health` returns `{status:"ok"}`
- [ ] Security headers present (helmet): `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, `X-Powered-By` hidden

## 1. Auth & smoke
- [ ] Login as customer / agent / admin
- [ ] Logout
- [ ] Single-device lock: logging in admin elsewhere kicks the first session
- [ ] OTP / password reset flow
- [ ] Every page loads with **0 console errors**

## 2. Customer
- [ ] Dashboard loads (plan, usage bars, subscriptions, quotes)
- [ ] Raise a ticket (via assistant + direct)
- [ ] **Ticket reply WITH an image attachment → the CC recipient receives the image (not just text)** 🖥️
- [ ] Live chat: start → queued → agent connects → messages flow → end
- [ ] **Start a chat, then END it from the customer side before an agent accepts → the rung agent gets NO "missed chat (now with another agent)" notification** (ring just stops)
- [ ] Billing: plans list, upgrade flow, invoices/quotes tabs
- [ ] **Dashboard "Pending Payments" card is faded + non-clickable when admin `billing_extras_enabled` is OFF; clickable when ON**
- [ ] **Mobile (≤1024px): the Refresh button sits next to the 🔔 bell in the top bar; per-page refresh buttons hidden on mobile**
- [ ] **Mobile: on "Start a Live Chat", the status dot aligns to the first line of the "Outside working hours…" text (not floating mid-block)**

## 3. Agent
- [ ] Reply to a ticket (plain **Send**)
- [ ] **"+ Pending" sends reply and moves ticket to Pending (no error)**
- [ ] **"+ Close" opens the closing-statement popup (not a one-click close); closing sends the note to the customer**
- [ ] **No double-send error on rapid clicks (submit guard); button shows "Sending…"**
- [ ] **Customer History → open another of the customer's tickets → a sticky "← Back to #X" bar appears at the top and returns you**
- [ ] **The time-log "min / Log" control is gone from the reply bar**
- [ ] Internal Notes (agent-only, customer never sees)
- [ ] Accept a waiting chat; escalation to next agent still shows "now with another agent" (genuine escalation only)

## 4. Admin (your session)
- [ ] Customers list + detail
- [ ] Plans CRUD
- [ ] **Settings → toggle `billing_extras_enabled` and confirm it gates the customer Billing tabs + the Dashboard Pending Payments card**
- [ ] Audit log, Reports, System Health load
- [ ] Manual plan renewal asks for a transaction ID

## 5. Real-device / external 🖥️
- [ ] Install PWA → home-screen shows **"Anutech Support" + the new full-bleed logo (NO white square box)** — remove & re-add the old install to refresh
- [ ] Web push permission + a real push notification arrives
- [ ] A call connects + has clear two-way audio **over mobile data** (Cloudflare TURN)
- [ ] Reply-notification email lands in a real inbox (with attachment for CC)

## 6. Security spot-checks
- [ ] In production (`NODE_ENV=production`), an unknown origin is CORS-blocked; only `FRONTEND_URL` allowed
- [ ] No stack traces leak to API responses on errors (generic message only)
- [ ] `.env` not committed to git
- [ ] File upload rejects oversized / disallowed types

## 7. Pre-deploy config (fill in on the GCP server)
- [ ] `NODE_ENV=production`
- [ ] Strong, NEW `JWT_SECRET` (not the dev one)
- [ ] Prod DB created; data migrated or admin seeded
- [ ] `FRONTEND_URL=https://yourdomain.com`
- [ ] Prod SMTP creds + SPF/DKIM/DMARC on sending domain
- [ ] **NEW** VAPID keypair for push
- [ ] Cloudflare TURN keys set + backend restarted
- [ ] Razorpay live keys (if taking real payments)
- [ ] `ANTHROPIC_API_KEY` with billing cap
- [ ] DB backup cron + GCP disk snapshots scheduled
