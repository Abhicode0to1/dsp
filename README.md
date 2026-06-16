# Delfos Support Panel (DSP)

A production-ready SaaS Customer Support Platform with ticket management, live chat, and virtual call support — all plan-gated and usage-tracked.

---

## Tech Stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| Frontend    | React 18 + Vite + Tailwind CSS      |
| Backend     | Node.js + Express                   |
| Database    | MySQL                               |
| Real-time   | Socket.io                           |
| Auth        | JWT (jsonwebtoken + bcryptjs)       |

---

## Project Structure

```
dsp/
├── database/
│   ├── schema.sql        # All table definitions
│   └── seed.sql          # Demo data (5 customers, 2 agents, 1 admin)
├── backend/
│   ├── src/
│   │   ├── config/       # DB pool, JWT helpers
│   │   ├── controllers/  # auth, customer, ticket, chat, call, agent, admin
│   │   ├── middleware/   # authenticate, requireRole
│   │   ├── routes/       # Express routers
│   │   ├── socket/       # Socket.io chat handler
│   │   ├── utils/        # planUtils, botUtils
│   │   ├── app.js        # Express app
│   │   └── server.js     # HTTP + Socket.io server
│   ├── .env.example
│   └── package.json
└── frontend/
    ├── src/
    │   ├── contexts/     # AuthContext, SocketContext
    │   ├── pages/
    │   │   ├── customer/ # Dashboard, Tickets, NewTicket, TicketDetail, Chat, Call
    │   │   ├── agent/    # Dashboard (tickets + chats)
    │   │   └── admin/    # Dashboard, Customers, Reports
    │   ├── components/   # Layout, Sidebar, PlanBadge, UsageBar
    │   ├── services/     # api.js (all Axios calls)
    │   └── utils/        # planUtils.js (pricing formula)
    ├── .env.example
    └── package.json
```

---

## Prerequisites

- Node.js 18+
- MySQL 8.0+
- npm or yarn

---

## Setup Instructions

### 1. Database

```bash
mysql -u root -p < database/schema.sql
mysql -u root -p < database/seed.sql
```

### 2. Backend

```bash
cd backend
cp .env.example .env
```

Edit `.env`:
```
PORT=5000
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=dsp
JWT_SECRET=change_this_to_a_long_random_string
JWT_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:5173
```

```bash
npm install
npm run dev
```

Backend runs on: `http://localhost:5000`

### 3. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Frontend runs on: `http://localhost:5173`

---

## Demo Accounts

All accounts use password: **`Password@123`**

| Role     | Email               | Plan     | Notes                        |
|----------|---------------------|----------|------------------------------|
| Admin    | admin@dsp.com       | —        | Full admin access            |
| Agent    | agent1@dsp.com      | —        | Priya Sharma                 |
| Agent    | agent2@dsp.com      | —        | Rahul Mehta                  |
| Customer | acme@client.com     | Basic    | 3 tickets used, active plan  |
| Customer | beta@client.com     | Moderate | 2 tickets + 2 calls used     |
| Customer | gamma@client.com    | Premium  | High priority, all features  |
| Customer | delta@client.com    | Free     | No chat/call access          |
| Customer | eps@client.com      | Basic    | **Expired plan**             |

---

## Support Plans

| Plan     | Tickets/mo | Calls/mo | Chat | Priority | Price Formula                          |
|----------|-----------|----------|------|----------|----------------------------------------|
| Free     | Unlimited | —        | No   | Low      | Free                                   |
| Basic    | 5         | —        | Yes  | Normal   | max(subtotal × 5%, ₹3,000)            |
| Moderate | 10        | 5        | Yes  | Medium   | max(subtotal × 10%, ₹8,000)           |
| Premium  | 20        | 10       | Yes  | High     | max(subtotal × 15%, ₹20,000)          |

---

## API Reference

### Auth
| Method | Endpoint       | Description        |
|--------|----------------|--------------------|
| POST   | /api/auth/login| Login → JWT token  |
| GET    | /api/auth/me   | Get current user   |

### Customer (requires JWT + role: customer)
| Method | Endpoint               | Description            |
|--------|------------------------|------------------------|
| GET    | /api/customer/dashboard| Full dashboard data    |

### Tickets (requires JWT + role: customer)
| Method | Endpoint                    | Description               |
|--------|-----------------------------|---------------------------|
| GET    | /api/tickets                | List my tickets           |
| POST   | /api/tickets                | Create ticket (limit check)|
| GET    | /api/tickets/:id            | Ticket + messages         |
| POST   | /api/tickets/:id/messages   | Add reply                 |
| POST   | /api/tickets/bot-suggest    | KB suggestions            |

### Chat (requires JWT + role: customer)
| Method | Endpoint           | Description          |
|--------|--------------------|----------------------|
| POST   | /api/chat/initiate | Start chat session   |
| GET    | /api/chat/active   | Get active chat      |
| PUT    | /api/chat/:id/close| Close chat           |

### Calls (requires JWT + role: customer)
| Method | Endpoint           | Description               |
|--------|--------------------|---------------------------|
| POST   | /api/calls/initiate| Initiate call (quota check)|
| PUT    | /api/calls/:id/end | End call + track duration  |
| GET    | /api/calls/history | Call history               |

### Agent (requires JWT + role: agent/admin)
| Method | Endpoint                     | Description          |
|--------|------------------------------|----------------------|
| GET    | /api/agent/dashboard         | Stats                |
| GET    | /api/agent/tickets           | Open/unassigned      |
| PUT    | /api/agent/tickets/:id       | Update status/assign |
| POST   | /api/agent/tickets/:id/reply | Reply to ticket      |
| GET    | /api/agent/chats/pending     | Waiting chats        |
| PUT    | /api/agent/chats/:id/accept  | Accept chat          |

### Admin (requires JWT + role: admin)
| Method | Endpoint                    | Description          |
|--------|-----------------------------|----------------------|
| GET    | /api/admin/dashboard        | Overview stats       |
| GET    | /api/admin/customers        | List customers       |
| PUT    | /api/admin/customers/:id    | Update plan/invoice  |
| GET    | /api/admin/plans            | Plan configurations  |
| GET    | /api/admin/reports/tickets  | Ticket analytics     |
| GET    | /api/admin/reports/revenue  | Revenue analytics    |
| GET    | /api/admin/reports/usage    | Usage analytics      |

---

## Socket.io Events

### Client → Server
| Event          | Payload                    | Description              |
|----------------|----------------------------|--------------------------|
| `join_chat`    | `{ chatId }`               | Join a chat room         |
| `join_agent_room` | —                       | Agent joins monitor room |
| `send_message` | `{ chatId, message }`      | Send chat message        |
| `accept_chat`  | `{ chatId }`               | Agent accepts chat       |
| `close_chat`   | `{ chatId }`               | Close chat session       |
| `typing`       | `{ chatId, isTyping }`     | Typing indicator         |

### Server → Client
| Event                  | Description                       |
|------------------------|-----------------------------------|
| `chat_history`         | Past messages when joining        |
| `new_message`          | Real-time message broadcast       |
| `chat_accepted`        | Agent accepted customer's chat    |
| `chat_closed`          | Chat session ended                |
| `user_typing`          | Typing indicator                  |
| `new_chat_request`     | New customer waiting (to agents)  |
| `chat_request_accepted`| Notify agents chat was taken      |

---

## Key Business Rules

1. **Free plan** — email tickets only; no live chat, no calls
2. **Chat** requires Basic plan or higher + active plan
3. **Calls** require Moderate plan or higher + active plan
4. **Ticket limits** are enforced monthly and reset each month
5. **Call limits** are enforced monthly; overage shows extra-charge message
6. **Expired plans** block all live support (chat + calls)
7. **Call privacy** — agent phone numbers are never exposed; virtual numbers mask both parties
8. **Max call duration** — 20 minutes enforced server-side
9. **Bot suggestions** — keyword-based KB matches shown before ticket creation

---

## Running in Production

1. Build the frontend: `cd frontend && npm run build`
2. Serve the `dist/` folder with Nginx or serve the static files from Express
3. Use PM2 for the Node.js backend: `pm2 start src/server.js --name dsp-api`
4. Set `NODE_ENV=production` in backend `.env`
5. Use a strong `JWT_SECRET` (at least 64 random characters)
