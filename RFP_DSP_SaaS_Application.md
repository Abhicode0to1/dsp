# REQUEST FOR PROPOSAL (RFP)
## Delfos Support Panel (DSP) — SaaS Customer Support Platform

**Document Version:** 1.0  
**Issued Date:** May 25, 2026  
**RFP Deadline:** [INSERT DATE - typically 2-3 weeks]  
**Proposal Submission:** [INSERT EMAIL/PORTAL]  
**Point of Contact:** [YOUR NAME] | [YOUR EMAIL] | [YOUR PHONE]

---

## SECTION 1: EXECUTIVE SUMMARY

### 1.1 Project Overview
We are seeking a qualified software development firm to design, develop, deploy, and maintain a production-ready **SaaS Customer Support Platform** called **Delfos Support Panel (DSP)**.

The platform will serve three user roles:
- **Customers** — Submit support tickets, initiate live chat, book calls, track billing
- **Support Agents** — Handle tickets, chats, calls; manage customer interactions
- **Administrators** — Configure plans, monitor system health, view analytics, manage team

### 1.2 Business Context
- **Target Market:** Small to mid-size SaaS companies (50-500 customers)
- **Geographic Focus:** India (Razorpay payments, GST compliance)
- **Revenue Model:** Tiered subscription plans (Free → Premium)
- **Launch Timeline:** 6-7 months from contract signing

### 1.3 Budget & Resource Expectations
- **Estimated Budget:** ₹35-45 Lakhs (~$42,000-54,000 USD)
- **Preferred Team Size:** 4-5 full-time developers
- **Location:** Onshore India preferred (for collaboration); offshore acceptable with async protocols
- **Engagement Model:** Fixed-price with milestone-based payments (preferred), or Time & Materials with weekly tracking

---

## SECTION 2: DETAILED PROJECT SCOPE

### 2.1 Platform Architecture

```
┌─────────────────┐
│  React 18 SPA   │ (Customer, Agent, Admin dashboards)
│  + Tailwind CSS │ (Responsive UI)
└────────┬────────┘
         │ REST API + Socket.io
┌────────▼────────────────────┐
│  Node.js/Express Backend    │ (80+ routes, plan gating, real-time)
│  Port: 5000                 │
└────────┬─────────────────────┘
         │
┌────────▼────────────────────┐
│  MySQL 8.0+ Database        │ (19 tables: users, customers, plans,
│  InnoDB Engine              │  tickets, chats, calls, invoices, etc.)
└─────────────────────────────┘
         │
┌────────▼─────────────────────┐
│  Third-Party Integrations   │
├─────────────────────────────┤
│ • Razorpay (payment gateway)│
│ • SendGrid / SMTP (email)   │
│ • Socket.io (real-time)     │
│ • JWT (authentication)      │
└─────────────────────────────┘
```

### 2.2 Core Features (MUST-HAVE)

#### 2.2.1 Authentication & Authorization
- [ ] User registration (sign-up flow)
- [ ] Email + password login with rate limiting (20 attempts/15min)
- [ ] JWT token-based authentication with expiry (7 days)
- [ ] Password reset via email
- [ ] Setup-password flow (admin creates agents/customers)
- [ ] Single-device enforcement (logout from other devices on new login)
- [ ] Role-based access control (customer, agent, admin)

#### 2.2.2 Customer Features
**Dashboard**
- [ ] Real-time overview: plan, status (active/expired), usage (tickets/chats/calls)
- [ ] Usage bars showing consumption vs. limits
- [ ] Quick action buttons (create ticket, start chat, book call)
- [ ] Welcome tour for first-time users

**Tickets (Email Support)**
- [ ] Create ticket with category, subject, description
- [ ] File attachments (up to 5 files, max 25MB each)
- [ ] View all tickets with status filter (open, pending, closed)
- [ ] Real-time message updates when agent replies
- [ ] CC email addresses on ticket
- [ ] Bot suggestions before ticket creation (KB matching)
- [ ] Close / reopen tickets
- [ ] Download ticket transcript

**Live Chat (Basic+ plan)**
- [ ] Initiate chat request
- [ ] Queue position display
- [ ] Agent availability check
- [ ] Real-time messaging
- [ ] Typing indicators
- [ ] File uploads in chat
- [ ] Rate chat session (CSAT 1-5 stars)
- [ ] Chat history & transcript download
- [ ] Offline message option (if agents unavailable)

**Phone Calls (Moderate+ plan)**
- [ ] Request call (virtual number, agent anonymized)
- [ ] Incoming call notification (if agent initiates)
- [ ] Call UI: mute, hold, end call
- [ ] Call history with duration
- [ ] Post-call notes (customer view)
- [ ] Call transcript

**Billing & Plans**
- [ ] View current plan + plan details
- [ ] View upcoming renewal date
- [ ] Upgrade to higher plan (Razorpay integration)
- [ ] Download invoices (PDF)
- [ ] View outstanding quotes
- [ ] Pay quote/invoice (Razorpay)
- [ ] Subscription history

**Profile & Settings**
- [ ] Edit email, phone, company name
- [ ] Change password
- [ ] 2FA setup (OTP via email)
- [ ] Download account data

#### 2.2.3 Agent Features
**Dashboard**
- [ ] Personal stats: SLA %, CSAT average, response time, chats handled, calls handled
- [ ] Assigned tickets (open/pending)
- [ ] Waiting chats (unassigned or ringing)
- [ ] Active calls

**Ticket Management**
- [ ] View assigned tickets
- [ ] Update ticket status (open → pending → closed)
- [ ] Assign ticket to self or another agent
- [ ] Reply to ticket (with file attachments)
- [ ] Add internal notes (not visible to customer)
- [ ] Time-log hours spent on ticket
- [ ] Merge tickets (consolidate duplicates)
- [ ] View related tickets for same customer

**Chat Management**
- [ ] Accept waiting chat (ring assigned to one agent at a time)
- [ ] Send message + files in chat
- [ ] Typing indicator
- [ ] Mark messages as read
- [ ] Transfer chat to another agent (30s pending offer, target must accept)
- [ ] Close chat + send farewell message
- [ ] Add internal notes on chat
- [ ] Email chat transcript to customer
- [ ] Chat archive & history

**Call Management**
- [ ] Receive incoming call ring
- [ ] Accept / decline call
- [ ] In-call UI (mute, hold, transfer, end)
- [ ] Add post-call notes
- [ ] Call history + duration

**Canned Responses (Macros)**
- [ ] Create personal macros (reusable responses)
- [ ] Use global macros (created by admin)
- [ ] Command palette (Cmd+K to insert)
- [ ] Quick replies in chat/tickets

**Performance & Feedback**
- [ ] View personal CSAT ratings
- [ ] View SLA compliance (%)
- [ ] View average response time
- [ ] Feedback/bug report submission

#### 2.2.4 Admin Features
**Dashboard**
- [ ] Total customers, MRR (monthly recurring revenue), ARR (annual)
- [ ] Ticket SLA health %
- [ ] Chat/call volume (this month)
- [ ] Agent stats (CSAT, SLA%, utilization)
- [ ] Key metrics at a glance

**Customer Management**
- [ ] List all customers with search/filter
- [ ] View customer detail (billing, history, usage)
- [ ] Update plan (tier, expiry date)
- [ ] Update invoice subtotal (for manual billing)
- [ ] Set per-customer feature overrides (e.g., allow_chat=true on Free plan)
- [ ] Reset customer usage counters (clears monthly quotas)
- [ ] Bulk customer operations
- [ ] Manual customer creation (no billing sync)
- [ ] Delete customer (with confirmation)

**Agent Management**
- [ ] List all agents
- [ ] Create new agent account (send setup-password email)
- [ ] Activate / deactivate agent
- [ ] Reset agent password
- [ ] Update agent skills (for skill-based routing)
- [ ] View agent performance (CSAT, SLA%, chats/calls handled)
- [ ] Delete agent

**Plan Configuration**
- [ ] View all plans (Free, Basic, Moderate, Premium)
- [ ] Edit plan limits (tickets_limit, calls_limit, etc.)
- [ ] Toggle features per plan (allow_chat, allow_calls)
- [ ] Edit pricing formula (percentage + minimum)
- [ ] View plan usage distribution

**Tickets, Chats, Calls**
- [ ] View ALL tickets (no role filtering)
- [ ] Bulk update tickets (status, priority, assign)
- [ ] View all chats
- [ ] Reassign chat to different agent
- [ ] View all calls
- [ ] Export reports (CSV)

**Reports & Analytics**
- [ ] Ticket analytics: SLA compliance %, avg resolution time, top issues
- [ ] Revenue report: MRR, ARR, ARPU (average revenue per user)
- [ ] Usage report: chat/call volume per plan
- [ ] Agent performance leaderboard
- [ ] Date range filtering
- [ ] Export to CSV

**System Health & Audit**
- [ ] Usage drift detection: find customers exceeding plan limits (red flag)
- [ ] Reset usage for customer (manual override)
- [ ] Audit log: view all actions (who, what, when, entity)
- [ ] Run integration tests (routing-limits.test.js via endpoint)
- [ ] Agent presence debug: see live Socket.io connections, rooms, status
- [ ] Feedback/bug reports from users (admin reviews, updates status)

**Settings**
- [ ] GMB (Google My Business) review link
- [ ] CSAT threshold for GMB prompt (if score ≤ 3, show prompt)
- [ ] SLA notification settings
- [ ] Global app configuration

**Billing Sync (Integration)**
- [ ] Import customers from external billing system (via webhook/API)
- [ ] Sync customer plan/invoice data
- [ ] Lookup customer in billing system

---

### 2.3 Core Features (NICE-TO-HAVE, Phase 2)

- [ ] Knowledge Base (KB) articles with search
- [ ] Customer satisfaction (CSAT) analytics dashboard
- [ ] Skill-based routing (assign chats/tickets based on agent skills)
- [ ] SLA tracking & breach notifications
- [ ] Multi-language support (English + Hindi)
- [ ] Mobile-responsive design (fully working on mobile)
- [ ] Dark mode toggle
- [ ] Webhook API for external integrations
- [ ] Bulk import/export (customers, tickets)
- [ ] Sentiment analysis on tickets (show positive/negative)
- [ ] AI-powered auto-reply suggestions

---

### 2.4 Technical Requirements

#### 2.4.1 Frontend Stack (MANDATORY)
- **Framework:** React 18 with Hooks
- **Build Tool:** Vite (for fast HMR)
- **Styling:** Tailwind CSS (utility-first, no custom CSS where possible)
- **State Management:** Context API (or Redux if needed)
- **HTTP Client:** Axios
- **Real-time:** Socket.io client library
- **Form Validation:** React Hook Form + Zod
- **Routing:** React Router v6+
- **Testing:** React Testing Library + Jest (if budget allows)
- **Deployment:** Vercel, Netlify, or Docker

#### 2.4.2 Backend Stack (MANDATORY)
- **Runtime:** Node.js 18+ (LTS)
- **Framework:** Express.js 4.x
- **Database:** MySQL 8.0+ with InnoDB engine
- **Real-time:** Socket.io 4.x
- **Authentication:** jsonwebtoken (JWT) + bcryptjs (password hashing)
- **Rate Limiting:** express-rate-limit
- **File Uploads:** multer (with size/type validation)
- **Validation:** Joi or Zod
- **Email:** nodemailer + SendGrid adapter (or equivalent)
- **Payments:** Razorpay Node SDK
- **Logging:** Winston or Pino
- **Error Tracking:** (optional) Sentry
- **Testing:** (optional) Jest for unit tests
- **Deployment:** Docker + AWS EC2 / DigitalOcean / Heroku

#### 2.4.3 Database (MANDATORY)
- **Engine:** MySQL 8.0+ (InnoDB)
- **Tables:** 19 tables (provided in schema.sql)
- **Indexes:** On FK columns, month_year composites, email (unique)
- **Backups:** Automated daily backups (AWS RDS or manual)
- **Replication:** (optional for high availability) Master-slave replication

#### 2.4.4 Infrastructure Requirements
- **Web Server:** Nginx or Apache (reverse proxy)
- **SSL/TLS:** Let's Encrypt (auto-renewal)
- **CDN:** (optional) CloudFront, BunnyCDN for static assets
- **Monitoring:** (optional) New Relic, DataDog, or CloudWatch
- **Uptime:** 99.5% SLA minimum
- **Scalability:** Horizontal scaling capability (stateless APIs)

#### 2.4.5 Security Requirements (MANDATORY)
- [ ] HTTPS/TLS for all traffic
- [ ] JWT tokens with secure signing (RS256 or HS256)
- [ ] Password hashing: bcrypt (min 10 rounds)
- [ ] Input validation: whitelist known-good patterns
- [ ] SQL injection prevention: parameterized queries (NOT string concatenation)
- [ ] XSS prevention: React's built-in escaping (no dangerouslySetInnerHTML)
- [ ] CSRF protection: (optional but recommended) csrf tokens on state-changing endpoints
- [ ] Rate limiting: on auth endpoints (20/15min for login, 10/60min for password change)
- [ ] Single-device enforcement: revoke old JWTs on new login
- [ ] CORS: whitelist frontend origin only
- [ ] Secrets management: Use environment variables (.env file, never commit)
- [ ] Data encryption: (optional) encrypt sensitive fields in DB (PII)
- [ ] Audit logging: Log all user actions (auth, ticket updates, customer changes)

#### 2.4.6 Compliance & Legal
- [ ] **GDPR-Ready:** Data export, deletion, consent tracking (if serving EU customers)
- [ ] **India Compliance:**
  - [ ] GST calculation & display (18% standard)
  - [ ] Razorpay integration (PCI-DSS compliant)
  - [ ] Data residency: Keep data in India (AWS Mumbai region preferred)
  - [ ] Terms of Service & Privacy Policy templates (admin can customize)
- [ ] **Email Compliance:**
  - [ ] Unsubscribe link (for marketing emails)
  - [ ] SPF / DKIM / DMARC setup (for SendGrid)
- [ ] **Accessibility (WCAG 2.1 AA):**
  - [ ] Keyboard navigation (Tab, Enter, Escape)
  - [ ] Screen reader support (semantic HTML, ARIA labels)
  - [ ] Color contrast (4.5:1 for text)
  - [ ] Focus indicators (visible outlines)

---

## SECTION 3: DELIVERABLES

### 3.1 Code & Documentation

| Deliverable | Format | Notes |
|-------------|--------|-------|
| **Frontend Source Code** | GitHub repo | React 18 + Vite, all components |
| **Backend Source Code** | GitHub repo | Node.js/Express, all controllers/routes |
| **Database Schema** | SQL file (.sql) | schema.sql + migrations |
| **API Documentation** | Swagger/OpenAPI 3.0 | All 80+ endpoints documented |
| **Architecture Diagram** | PNG/PDF | System design, data flow |
| **Deployment Guide** | Markdown (.md) | Step-by-step setup instructions |
| **Admin Manual** | PDF + video | How to manage customers, agents, plans |
| **User Guides** | PDF (3 x roles) | Customer, Agent, Admin guides |
| **Code Comments** | In-code | Well-commented complex logic |
| **Environment Template** | .env.example | All required env variables documented |

### 3.2 Testing & Quality

| Deliverable | Requirement | Notes |
|-------------|-------------|-------|
| **Unit Tests** | ≥ 70% coverage (backend) | Jest or Mocha |
| **Integration Tests** | routing-limits.test.js | 12 core tests (routing + limits) |
| **End-to-End Tests** | (Optional) Cypress/Playwright | Happy path + error scenarios |
| **Security Audit** | (Optional) OWASP Top 10 checklist | Identify & fix vulnerabilities |
| **Performance Report** | Load testing report | API latency, database query times |
| **Bug Tracking** | Zero critical bugs | Known issues listed in README |

### 3.3 Deployment & Infrastructure

| Deliverable | Details |
|-------------|---------|
| **Staging Environment** | Full replica of production (for UAT) |
| **Production Environment** | AWS / DigitalOcean / Heroku setup |
| **SSL Certificates** | HTTPS configured, auto-renewal |
| **Database Backup** | Automated daily backups (7-day retention) |
| **CI/CD Pipeline** | (Optional) GitHub Actions or Jenkins |
| **Monitoring Setup** | (Optional) Error tracking, uptime monitoring |
| **DNS Configuration** | A/AAAA records, SPF, DKIM for email |

### 3.4 Handover

| Deliverable | Timing |
|-------------|--------|
| **Source Code Access** | Day 1 (GitHub repo with admin rights) |
| **Database Access** | Day 1 (credentials in password manager) |
| **Server Access** | Day 1 (SSH keys, EC2/DigitalOcean access) |
| **Razorpay API Keys** | Day 1 (test + live keys configured) |
| **Admin Training** | Day 30 (1-2 hour session, recorded) |
| **30-day Support Window** | Included (critical bug fixes, questions) |
| **Maintenance Package** | Day 31+ (optional: ₹1-2 Lakhs/month for ongoing support) |

---

## SECTION 4: PROJECT TIMELINE & MILESTONES

### 4.1 Proposed Schedule (6.5 months)

| Week | Phase | Deliverables | Percentage |
|------|-------|--------------|-----------|
| **Week 1-2** | **Planning & Design** | Architecture, DB schema, UI mockups, API specs | 5% |
| **Week 3-10** | **Backend Development** | All 80+ API routes, auth, payment integration, Socket.io | 35% |
| **Week 4-12** | **Frontend Development** | React components, integrations, testing | 40% |
| **Week 11-14** | **Real-time Features** | Socket.io chat, calls, notifications, multi-user testing | 10% |
| **Week 15-16** | **Testing & Bug Fixes** | QA, integration tests, security audit | 5% |
| **Week 17-18** | **Deployment & Documentation** | Production setup, user guides, training materials | 3% |
| **Week 19-26** | **Buffer & UAT** | Contingency for scope creep, customer testing | 2% |

### 4.2 Milestone-Based Payment Plan

| Milestone | Criteria | Payment | Timeline |
|-----------|----------|---------|----------|
| **M1: Kickoff** | Contract signed, team onboarded, repo created | 10% | Week 1 |
| **M2: Backend MVP** | 50% of API routes working, auth complete, DB schema | 20% | Week 10 |
| **M3: Frontend MVP** | 50% of components done, REST integration | 20% | Week 12 |
| **M4: Real-time Features** | Chat, calls, notifications working (Socket.io) | 20% | Week 14 |
| **M5: Testing & Deployment** | 70% code coverage, staging/production live | 20% | Week 18 |
| **M6: UAT & Handover** | 0 critical bugs, documentation complete, training done | 10% | Week 26 |

**Total: ₹35-45 Lakhs distributed across 6 milestones**

---

## SECTION 5: TEAM REQUIREMENTS

### 5.1 Proposed Team Composition

| Role | Count | Responsibility |
|------|-------|-----------------|
| **Tech Lead / Senior Full-Stack** | 1 | Architecture, code reviews, critical APIs, Socket.io |
| **Backend Developer** | 1-2 | Routes, controllers, database queries, integrations |
| **Frontend Developer** | 1-2 | Components, styling, REST/Socket.io integration, testing |
| **QA Engineer** | 0.5 | Testing, bug reporting, UAT coordination |
| **DevOps / Infra** | 0.5 | Docker, deployment, monitoring, backups |
| **Project Manager** | 0.5 | Status reports, timeline tracking, communication |

**Total Effort:** ~4.5 full-time equivalents (FTE) over 6.5 months

### 5.2 Required Skills & Experience

**All Developers Must Have:**
- [ ] 3+ years professional software development experience
- [ ] Strong Git version control (GitHub/GitLab)
- [ ] Relational database (SQL, MySQL preferred)
- [ ] RESTful API design & development
- [ ] Communication in English (written & verbal)
- [ ] Experience with Agile/Scrum methodologies

**Backend Team Must Have:**
- [ ] 2+ years Node.js/Express experience
- [ ] Real-time applications (Socket.io or equivalent)
- [ ] MySQL/PostgreSQL database design
- [ ] Payment gateway integration (Razorpay/Stripe)
- [ ] Authentication (JWT, OAuth)
- [ ] Email integration (SendGrid, SMTP)

**Frontend Team Must Have:**
- [ ] 2+ years React experience
- [ ] Tailwind CSS (or similar CSS framework)
- [ ] REST API / WebSocket integration
- [ ] Responsive design (mobile-first)
- [ ] State management (Context API, Redux, or Zustand)
- [ ] Form handling & validation

---

## SECTION 6: QUALITY & ACCEPTANCE CRITERIA

### 6.1 Code Quality Standards

| Criterion | Standard | Measurement |
|-----------|----------|-------------|
| **Test Coverage** | ≥70% (backend), ≥50% (frontend) | Jest/Nyc coverage reports |
| **Code Style** | ESLint + Prettier (auto-format) | Zero eslint warnings |
| **Documentation** | JSDoc comments on complex functions | Code comments + README |
| **Security** | OWASP Top 10 compliant | Security audit checklist |
| **Performance** | API response time <500ms (p95) | Load test report |
| **Accessibility** | WCAG 2.1 AA | Axe DevTools scan |
| **Mobile Responsiveness** | Works on mobile (320px+) | Manual testing + screenshots |

### 6.2 Functional Acceptance Criteria

**User Stories to Test (Sample):**

```
Story 1: Customer can create a ticket
  ✅ Customer logs in
  ✅ Clicks "New Ticket" button
  ✅ Fills in category, subject, description
  ✅ Uploads attachment (optional)
  ✅ Submits ticket
  ✅ Sees bot suggestions (if applicable)
  ✅ Ticket appears in dashboard with status "open"
  ✅ Customer receives confirmation email

Story 2: Agent can accept & reply to chat
  ✅ Agent logs in, joins agent room
  ✅ Customer initiates chat
  ✅ Agent sees new_chat_request toast/ring
  ✅ Agent clicks "Accept Chat"
  ✅ Chat status changes to "active"
  ✅ Agent types message, sends
  ✅ Customer receives message in real-time
  ✅ Agent typing indicator shows to customer
  ✅ Agent can close chat with farewell message
  ✅ Chat appears in history for both parties

Story 3: Admin can upgrade customer plan
  ✅ Admin logs in
  ✅ Searches for customer
  ✅ Clicks "Update Plan"
  ✅ Selects new plan tier
  ✅ Confirms change
  ✅ Customer plan updated in DB
  ✅ Customer sees new plan on dashboard
  ✅ Customer's limits update (e.g., chat_limit)
  ✅ Audit log records the action
```

### 6.3 Non-Functional Requirements

| Requirement | Target | How Measured |
|-------------|--------|-------------|
| **Uptime** | 99.5% | Monitoring service (Uptime Robot) |
| **Response Time** | <500ms (p95) | New Relic / DataDog |
| **Concurrent Users** | ≥100 simultaneous | Load test (Apache JMeter) |
| **Data Integrity** | 0 data loss | Backup verification, transaction logs |
| **Availability (post-launch)** | Critical bugs fixed <4 hours | SLA agreement |
| **Scalability** | Horizontal scaling possible | Architecture design review |

---

## SECTION 7: TERMS & CONDITIONS

### 7.1 Engagement Model
- **Type:** Fixed-price contract with milestone-based payments
- **Duration:** 6.5 months from contract signing
- **Working Hours:** 9 AM - 6 PM IST (overlap with client team required)
- **Communication:** Daily standup (15 min), weekly status calls
- **Contingency Buffer:** 2-4 weeks included (unforeseen scope changes)

### 7.2 Payment Terms
- **Total Contract Value:** ₹35-45 Lakhs (to be finalized in contract)
- **Payment Schedule:** Milestone-based (6 payments: 10%, 20%, 20%, 20%, 20%, 10%)
- **Invoicing:** Monthly, net 15 days
- **Currency:** INR (Indian Rupees)
- **Taxes:** GST 18% applicable (included in total or separately quoted)

### 7.3 Intellectual Property (IP)
- [ ] **Code Ownership:** Client owns 100% of source code upon final payment
- [ ] **Pre-existing IP:** Developer retains rights to pre-existing libraries/frameworks
- [ ] **Third-party Licenses:** Client acknowledges open-source licenses (MIT, Apache 2.0, etc.)
- [ ] **Deliverables:** All artifacts (design, documentation, code) belong to client

### 7.4 Warranties & Liabilities
- **Warranty Period:** 30 days from deployment
  - Developer will fix critical bugs (P1) free of charge
  - Non-critical bugs (P2/P3) fixed within SLA or deferred to maintenance phase
- **Limitation of Liability:** Developer not liable for >50% of contract value
- **Indemnification:** Developer indemnifies against IP infringement claims on third-party libraries

### 7.5 Scope Management
- **Scope Definition:** Detailed in Appendix A (User Stories & Feature List)
- **Change Requests:** Any scope addition requires written change order + timeline/cost impact
- **Out of Scope:**
  - Feature enhancements beyond detailed spec
  - Custom integrations with client's internal systems (Salesforce, SAP, etc.)
  - 24/7 production support (available as paid add-on: ₹1-2 Lakhs/month)
  - Third-party API upgrades or pricing changes

### 7.6 Confidentiality & NDA
- [ ] Both parties sign **NDA** (mutual)
- [ ] Developer will not disclose client's business model, pricing, customer list, or codebase
- [ ] Client will not share developer's proprietary methodologies or team composition with competitors
- [ ] Confidentiality survives termination by 2 years

### 7.7 Termination Clause
- **Either party** can terminate for cause (material breach) with 15 days' written notice
- **Upon termination:**
  - Client pays for work completed up to termination date (prorated)
  - Developer delivers all code, documentation, and database access
  - Both parties return confidential materials
  - No penalty for early termination (client pays accrued amount only)

### 7.8 Post-Launch Support
- **Included (30 days):** Critical bug fixes, deployment questions, team training
- **Optional (Month 2+):**
  - **Tier 1 (₹1 Lakh/month):** 40 hours/month (bugfixes, minor enhancements)
  - **Tier 2 (₹2 Lakhs/month):** 80 hours/month (bugfixes, enhancements, new features)
  - **Tier 3 (₹50K/month):** On-call support (critical issues only, <4 hour response)

---

## SECTION 8: EVALUATION CRITERIA

### 8.1 How Proposals Will Be Evaluated

| Criterion | Weight | Notes |
|-----------|--------|-------|
| **Technical Approach** | 30% | Architecture, tech stack, scalability plan |
| **Team Expertise** | 25% | Years of experience, portfolio, relevant skills |
| **Timeline & Feasibility** | 20% | Realistic schedule, milestone-based delivery |
| **Cost & Value** | 15% | Competitive pricing, payment terms, hidden costs |
| **Communication & Process** | 10% | How they handle status updates, change requests, escalation |

### 8.2 Scoring Rubric

**Technical Approach (30 points max)**
- Excellent (25-30): Detailed architecture, tech stack well-justified, clear scalability plan
- Good (18-24): Solid approach, minor gaps in documentation
- Fair (12-17): Basic approach, some concerns about scalability
- Poor (<12): Unclear or unsuitable approach

**Team Expertise (25 points max)**
- Excellent (21-25): 4+ similar projects, strong references, team leads certified
- Good (16-20): 2-3 similar projects, good references
- Fair (11-15): 1-2 similar projects, some gaps in experience
- Poor (<11): No relevant experience

**Timeline & Feasibility (20 points max)**
- Excellent (17-20): Realistic 6-month plan, clear milestones, strong risk mitigation
- Good (14-16): Good plan, minor concerns about feasibility
- Fair (10-13): Plan seems tight, some risks not addressed
- Poor (<10): Unrealistic timeline or vague milestones

**Cost & Value (15 points max)**
- Excellent (13-15): ₹35-45 Lakhs, clear cost breakdown, no hidden fees
- Good (11-12): Slightly above/below range, minor cost clarifications needed
- Fair (8-10): Costs unclear, potential overruns
- Poor (<8): Extremely high/low, lacks transparency

**Communication & Process (10 points max)**
- Excellent (9-10): Weekly calls, daily standups, responsive, clear escalation process
- Good (7-8): Good communication, minor gaps
- Fair (5-6): Adequate communication, slower response
- Poor (<5): Poor communication, unclear process

**Minimum Qualifying Score: 50/100**

---

## SECTION 9: SUBMISSION REQUIREMENTS

### 9.1 What to Include in Your Proposal

1. **Executive Summary** (1-2 pages)
   - Your understanding of the project
   - Why you're qualified to deliver DSP
   - Key differentiators

2. **Technical Proposal** (5-10 pages)
   - Proposed tech stack (frontend, backend, database, infra)
   - Architecture diagram
   - Scalability & performance plan
   - Security & compliance approach

3. **Team Composition** (2-3 pages)
   - Org structure (who does what)
   - Team members' backgrounds (names, years of experience, relevant projects)
   - Team lead's bio (photo, LinkedIn profile)
   - Any subcontractors (disclose clearly)

4. **Project Plan & Timeline** (3-4 pages)
   - Week-by-week breakdown (Gantt chart preferred)
   - Milestone definitions
   - Risk assessment & mitigation
   - Communication plan (standups, reviews, reporting cadence)

5. **Cost Proposal** (1-2 pages)
   - Total contract value (fixed price)
   - Payment schedule (milestone-based or time & materials)
   - Cost breakdown (if time & materials: rates by role)
   - Any optional services (support, enhancements)
   - Assumptions & exclusions

6. **Portfolio & References** (2-3 pages)
   - 3-5 recent similar projects (SaaS, real-time, payments)
   - Screenshots / links
   - Customer references (name, email, phone)
   - Awards or certifications (optional)

7. **Q&A Responses** (as needed)
   - See Section 9.2 below

8. **Appendix**
   - Team CVs (brief, 1 page each)
   - Security & compliance checklist
   - Insurance/liability details
   - NDA (if you have your own template)

### 9.2 Standard Q&A (Address in Proposal)

1. **How will you handle scope changes after contract signing?**
2. **What is your approach to testing & QA?**
3. **How do you ensure data security & compliance?**
4. **What happens if you miss a milestone?**
5. **Do you have experience with Razorpay integration?**
6. **Can you provide 24/7 support post-launch?** (Cost?)
7. **What is your policy on knowledge transfer / documentation?**
8. **Do you have experience with Socket.io-based applications?**
9. **How do you handle timezone differences** (if offshore)?
10. **What is your approach to code reviews & version control?**

### 9.3 Submission Details

- **Format:** PDF (max 50 MB) or printed copies (5 sets)
- **Deadline:** [INSERT DATE] @ 5:00 PM IST
- **Submit to:** [YOUR EMAIL] with subject line: **"RFP Submission: Delfos Support Panel - [Company Name]"**
- **Confirmation:** You will receive email confirmation within 24 hours
- **Evaluation Timeline:**
  - Week 1: Initial review, shortlist (2-3 vendors)
  - Week 2: Presentations & Q&A (if needed)
  - Week 3: Final decision & negotiation
  - Week 4: Contract signature

### 9.4 Post-Submission Process

1. **Clarification Round (Optional)**
   - We may ask follow-up questions via email
   - You have 3 days to respond

2. **Presentations (If Shortlisted)**
   - 1-hour presentation (30 min presentation, 30 min Q&A)
   - Include: team intro, technical approach, timeline, risk management
   - Via Zoom or in-person (location: [YOUR LOCATION])

3. **Final Negotiation**
   - Finalize contract terms, payment schedule, SLA
   - Review NDA & insurance
   - Set kickoff date

4. **Contract Signature**
   - Legal review by both parties
   - Signing & payment of M1 (Kickoff, 10%)

---

## SECTION 10: APPENDIX

### Appendix A: Detailed Feature List & User Stories

**Provided separately** — See attached document: `DSP_Feature_List_&_User_Stories.xlsx`

Contains:
- 200+ user stories (Gherkin format: Given/When/Then)
- Acceptance criteria for each feature
- Priority (Must-have, Should-have, Nice-to-have)
- Estimated effort (story points)

### Appendix B: Database Schema & API Specification

**Provided separately** — See attached documents:
- `database/schema.sql` (19 tables)
- `API_Specification_OpenAPI_3.0.yaml` (80+ endpoints)
- `ER_Diagram.png` (entity-relationship diagram)

### Appendix C: Design Mockups & Wireframes

**Provided separately** — See attached Figma link:
- [Figma Project: DSP Wireframes](https://figma.com/project/dsp-wireframes)
- All user flows (customer, agent, admin)
- Mobile & desktop layouts

### Appendix D: Third-Party Integrations

| Service | Purpose | Details |
|---------|---------|---------|
| **Razorpay** | Payment gateway | Invoice/quote payments, plan upgrades |
| **SendGrid** | Email delivery | Transactional emails (password reset, confirmation) |
| **AWS S3** | File storage | Attachments (tickets, chats, calls) |
| **AWS RDS** | Managed database | MySQL 8.0 with automated backups |
| **AWS EC2** | Web server | Node.js application server |
| **Route 53** | DNS | Domain management |
| **Let's Encrypt** | SSL/TLS | HTTPS certificates |

**Note:** AWS services are recommended but not mandatory. Vendor can propose alternatives (DigitalOcean, Heroku, Google Cloud, etc.).

### Appendix E: Security & Compliance Checklist

**OWASP Top 10 Mitigation**
- [ ] A1: Injection (parameterized queries)
- [ ] A2: Broken authentication (JWT + bcrypt)
- [ ] A3: Sensitive data exposure (HTTPS, encrypted fields)
- [ ] A4: XML external entities (N/A, using JSON)
- [ ] A5: Access control (role-based middleware)
- [ ] A6: Security misconfiguration (security headers, no debug mode in prod)
- [ ] A7: Cross-site scripting (React escaping, input validation)
- [ ] A8: Insecure deserialization (no unsafe JSON.parse)
- [ ] A9: Using components with known vulnerabilities (npm audit, regular updates)
- [ ] A10: Insufficient logging (audit log + error tracking)

**India Compliance**
- [ ] GST calculation (18% tax display)
- [ ] Data residency (India, AWS Mumbai preferred)
- [ ] RBI guidelines (if handling payments)
- [ ] Consumer Protection Act (refund policy, terms)

### Appendix F: Sample Contract Terms

**Provided separately** — See attached document: `Sample_Service_Agreement.docx`

Includes:
- Master service agreement (MSA) template
- SOW (Statement of Work) template
- IP ownership clause
- Liability & indemnification
- Termination & dispute resolution

---

## SECTION 11: FREQUENTLY ASKED QUESTIONS (FAQ)

### Q1: What if we need additional features beyond the detailed spec?
**A:** Any additional features require a written change order. We will estimate effort + cost impact and update the timeline accordingly. This prevents scope creep and keeps the project on track.

### Q2: Can we hire the team part-time after launch?
**A:** Yes. We offer a post-launch support package (₹1-2 Lakhs/month for 40-80 hours/month). This is optional and can be negotiated at the end of the main project.

### Q3: What if you miss a deadline?
**A:** Missing a milestone triggers a 5% penalty per week overdue (up to 20% max). However, developers can request timeline extensions if scope changes occur (via change order). The contingency buffer (weeks 19-26) is built in for unforeseen issues.

### Q4: Who owns the source code?
**A:** The **client owns 100% of the source code** upon final payment. The developer retains rights to open-source libraries used (MIT, Apache 2.0, etc.).

### Q5: Can you integrate with our existing tools (Salesforce, SAP, etc.)?
**A:** Custom integrations with your internal systems are **out of scope** for this RFP. They can be done as Phase 2 work (separate SOW & cost).

### Q6: What about data privacy & GDPR?
**A:** The platform will be **GDPR-ready** (data export, deletion, consent tracking). However, if you serve EU customers, you may need additional compliance work (DPA, certification). This can be discussed in negotiation.

### Q7: How do you handle bugs after launch?
**A:** For 30 days post-launch, we fix **critical bugs (P1) free**. Non-critical bugs are tracked and can be fixed as part of post-launch support (paid).

### Q8: Can we change vendors mid-project?
**A:** Yes, but it will delay the timeline significantly. All code, documentation, and DB access will be handed over. We recommend choosing carefully upfront and giving teams 2-3 weeks to prove capability.

### Q9: What if the project is cancelled?
**A:** You pay for work completed up to the cancellation date (prorated). For example, if cancelled at 50% completion, you pay 50% of the total contract value. All code/docs are handed over.

### Q10: Do you hire the team permanently?
**A:** The team can be hired as full-time employees after the project (not included in this RFP). This would be negotiated separately based on performance & team's willingness.

---

## SECTION 12: NEXT STEPS

1. **Review this RFP** (2-3 days)
   - Read all sections
   - Review attached schemas, wireframes, and feature list
   - Clarify any questions (email us)

2. **Prepare Your Proposal** (10-15 days)
   - Follow submission requirements (Section 9)
   - Address all Q&A (Section 9.2)
   - Gather team bios, portfolio, references

3. **Submit Your Proposal** (by [DATE])
   - Email to [YOUR EMAIL]
   - Subject: "RFP Submission: Delfos Support Panel - [Company Name]"

4. **Await Evaluation** (1 week)
   - We review all proposals
   - Shortlist 2-3 vendors for presentations

5. **Presentation** (optional, 1-2 weeks after submission)
   - 1-hour slot via Zoom or in-person
   - Present your approach, team, timeline

6. **Final Negotiation** (1 week)
   - Finalize contract, payment terms, SLA
   - Review insurance & NDA

7. **Kickoff** (Week of [DATE])
   - Contract signed
   - M1 payment received (10%)
   - Project begins

---

## CONTACT INFORMATION

**Client Point of Contact:**
- **Name:** [YOUR NAME]
- **Title:** [YOUR TITLE]
- **Email:** [YOUR EMAIL]
- **Phone:** [YOUR PHONE]
- **Company:** [YOUR COMPANY]
- **Location:** [CITY, COUNTRY]

**For Clarifications:**
- Email: [YOUR EMAIL]
- Response time: Within 24 hours (business days only)

**Proposal Submission:**
- Email: [YOUR EMAIL]
- Subject: "RFP Submission: Delfos Support Panel - [Company Name]"

---

## APPENDIX CHECKLIST

Below are the supporting documents that should accompany this RFP:

- [ ] `DSP_Feature_List_&_User_Stories.xlsx` (200+ user stories)
- [ ] `database/schema.sql` (19 tables)
- [ ] `API_Specification_OpenAPI_3.0.yaml` (80+ endpoints)
- [ ] `ER_Diagram.png` (entity-relationship diagram)
- [ ] Figma link (Design mockups & wireframes)
- [ ] `Sample_Service_Agreement.docx` (contract template)
- [ ] `OWASP_Compliance_Checklist.xlsx` (security requirements)
- [ ] `Cost_Estimation_Worksheet.xlsx` (optional for vendor reference)

---

**END OF RFP DOCUMENT**

---

**Document History**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | May 25, 2026 | [Your Name] | Initial RFP creation |

**Signature:**

_______________________  
[Your Name]  
[Your Title]  
[Your Company]  

---

**© 2026 [Your Company Name]. All rights reserved.**

