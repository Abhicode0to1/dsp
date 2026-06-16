-- Delfos Support Panel (DSP) - Seed Data
-- Run after schema.sql
USE dsp;

-- Plans
INSERT INTO plans (name, allow_email_ticket, allow_chat, allow_calls, tickets_limit, calls_limit, priority, percentage, minimum_price) VALUES
('free',     TRUE,  FALSE, FALSE, NULL, NULL, 'low',    0.0000, 0.00),
('basic',    TRUE,  TRUE,  FALSE, 5,    NULL, 'normal', 0.0500, 3000.00),
('moderate', TRUE,  TRUE,  TRUE,  10,   5,    'medium', 0.1000, 8000.00),
('premium',  TRUE,  TRUE,  TRUE,  20,   10,   'high',   0.1500, 20000.00);

-- Users (passwords are bcrypt hash of 'Password@123')
INSERT INTO users (name, email, password, role) VALUES
-- Admin
('Admin User',       'admin@dsp.com',    '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin'),
-- Agents
('Priya Sharma',     'agent1@dsp.com',   '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'agent'),
('Rahul Mehta',      'agent2@dsp.com',   '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'agent'),
-- Customers
('Acme Corp',        'acme@client.com',  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'customer'),
('Beta Solutions',   'beta@client.com',  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'customer'),
('Gamma Tech',       'gamma@client.com', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'customer'),
('Delta Innovations','delta@client.com', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'customer'),
('Epsilon Pvt Ltd',  'eps@client.com',   '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'customer');

-- Customers detail (user_ids 4-8 are customers)
INSERT INTO customers (user_id, domain, products, plan_id, plan_expiry, invoice_subtotal) VALUES
(4, 'acme.com',    '["Google Workspace", "Cloud Hosting"]',    2, DATE_ADD(CURDATE(), INTERVAL 30 DAY),  85000.00),
(5, 'beta.io',     '["Google Workspace"]',                     3, DATE_ADD(CURDATE(), INTERVAL 45 DAY),  120000.00),
(6, 'gamma.tech',  '["Microsoft 365", "Cloud Hosting", "VPN"]',4, DATE_ADD(CURDATE(), INTERVAL 60 DAY),  200000.00),
(7, 'delta.in',    '["Google Workspace"]',                     1, DATE_ADD(CURDATE(), INTERVAL 15 DAY),  25000.00),
(8, 'epsilon.co',  '["Microsoft 365"]',                        2, DATE_SUB(CURDATE(), INTERVAL 5 DAY),   60000.00);

-- Tickets (customer_id references customers.id: 1=acme, 2=beta, 3=gamma, 4=delta, 5=epsilon)
INSERT INTO tickets (customer_id, subject, description, status, priority, assigned_agent_id) VALUES
(1, 'Cannot login to Google Workspace',   'Users in our org are getting "credentials invalid" error since this morning.', 'open',    'normal', 2),
(1, 'Email delivery failing to external', 'Emails sent to @gmail.com are bouncing with SPF failure message.',             'pending', 'normal', 2),
(2, 'DNS propagation taking too long',    'We updated NS records 48 hours ago but changes not reflected globally.',       'open',    'medium', 3),
(2, 'SSL certificate renewal',           'Our SSL cert expires in 7 days, need urgent renewal assistance.',               'pending', 'medium', 3),
(3, 'Microsoft 365 license assignment',  'New employee onboarding - need 5 additional M365 Business Premium licenses.',  'closed',  'high',   2),
(3, 'VPN connection dropping',           'Users report VPN disconnects every 30 minutes consistently.',                  'open',    'high',   3),
(4, 'Google Workspace setup',            'Just signed up, need help with initial domain verification in GWS console.',   'open',    'low',    NULL),
(1, 'Calendar sharing not working',      'Shared calendar in Google Workspace not visible to external users.',            'closed',  'normal', 2);

-- Ticket messages
INSERT INTO ticket_messages (ticket_id, sender_id, message) VALUES
(1, 4, 'We have 50 users affected. The issue started at 9 AM IST.'),
(1, 2, 'Thank you for reaching out. I am checking your Google Admin console settings now. Can you confirm if you recently changed any security settings?'),
(1, 4, 'No changes were made. This started happening suddenly.'),
(2, 4, 'Here is our SPF record: v=spf1 include:_spf.google.com ~all'),
(2, 2, 'Your SPF record looks correct. Let me check the MX records and DMARC policy on your domain.'),
(3, 5, 'We used Namecheap and updated the NS records. Global propagation check shows 60% propagated.'),
(3, 3, 'DNS propagation can take up to 72 hours. Your records are propagating correctly. I will monitor and update you.'),
(5, 6, 'Resolved - licenses have been assigned to all 5 new users successfully.'),
(5, 3, 'Confirmed from our end as well. Closing this ticket. Please re-open if you face further issues.');

-- Ticket usage (current month)
INSERT INTO ticket_usage (customer_id, month_year, count) VALUES
(1, DATE_FORMAT(CURDATE(), '%Y-%m'), 3),
(2, DATE_FORMAT(CURDATE(), '%Y-%m'), 2),
(3, DATE_FORMAT(CURDATE(), '%Y-%m'), 2),
(4, DATE_FORMAT(CURDATE(), '%Y-%m'), 1),
(5, DATE_FORMAT(CURDATE(), '%Y-%m'), 0);

-- Call usage (current month)
INSERT INTO call_usage (customer_id, month_year, count) VALUES
(2, DATE_FORMAT(CURDATE(), '%Y-%m'), 2),
(3, DATE_FORMAT(CURDATE(), '%Y-%m'), 1);

-- Chats
INSERT INTO chats (customer_id, agent_id, status, accepted_at, closed_at) VALUES
(1, 2, 'closed', DATE_SUB(NOW(), INTERVAL 2 DAY), DATE_SUB(NOW(), INTERVAL 2 DAY)),
(3, 3, 'active', NOW(), NULL),
(2, NULL, 'waiting', NULL, NULL);

-- Chat messages
INSERT INTO chat_messages (chat_id, sender_id, message) VALUES
(1, 4, 'Hi, I need help with my Google Workspace login issue'),
(1, 2, 'Hello! I can help you with that. Can you share the exact error message you are seeing?'),
(1, 4, 'It says: "This account does not exist"'),
(1, 2, 'I see - it looks like the user was accidentally suspended. Let me reactivate the account.'),
(1, 4, 'Great, it works now! Thank you!'),
(2, 6, 'Hello, my VPN keeps disconnecting every 30 minutes.'),
(2, 3, 'Hi! I am looking into your VPN configuration now. Can you share what VPN client you are using?');

-- Calls (simulated)
INSERT INTO calls (customer_id, agent_id, virtual_number, status, call_start_time, call_end_time, duration) VALUES
(2, 2, '+1-800-DSP-0001', 'ended',  DATE_SUB(NOW(), INTERVAL 3 DAY),  DATE_SUB(NOW(), INTERVAL 3 DAY),  720),
(2, 3, '+1-800-DSP-0002', 'ended',  DATE_SUB(NOW(), INTERVAL 1 DAY),  DATE_SUB(NOW(), INTERVAL 1 DAY),  480),
(3, 2, '+1-800-DSP-0003', 'ended',  DATE_SUB(NOW(), INTERVAL 5 DAY),  DATE_SUB(NOW(), INTERVAL 5 DAY),  1140);

-- Invoices
INSERT INTO invoices (customer_id, plan_id, subtotal, gst_amount, final_price, status, due_date) VALUES
(1, 2, 85000.00,  765.00,  4250.00,  'paid',    DATE_SUB(CURDATE(), INTERVAL 30 DAY)),
(2, 3, 120000.00, 1440.00, 12000.00, 'paid',    DATE_SUB(CURDATE(), INTERVAL 15 DAY)),
(3, 4, 200000.00, 5400.00, 30000.00, 'paid',    DATE_SUB(CURDATE(), INTERVAL 20 DAY)),
(4, 1, 25000.00,  0.00,    0.00,     'pending', DATE_ADD(CURDATE(), INTERVAL 15 DAY)),
(5, 2, 60000.00,  540.00,  3000.00,  'overdue', DATE_SUB(CURDATE(), INTERVAL 10 DAY));
