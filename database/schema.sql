-- Delfos Support Panel (DSP) - Database Schema
-- Run this first, then seed.sql

CREATE DATABASE IF NOT EXISTS dsp;
USE dsp;

-- Users (all roles share this table)
CREATE TABLE IF NOT EXISTS users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role ENUM('customer', 'agent', 'admin') NOT NULL DEFAULT 'customer',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Support Plans configuration
CREATE TABLE IF NOT EXISTS plans (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name ENUM('free', 'basic', 'moderate', 'premium') NOT NULL,
  allow_email_ticket BOOLEAN DEFAULT TRUE,
  allow_chat BOOLEAN DEFAULT FALSE,
  allow_calls BOOLEAN DEFAULT FALSE,
  tickets_limit INT DEFAULT NULL,
  calls_limit INT DEFAULT NULL,
  priority ENUM('low', 'normal', 'medium', 'high') DEFAULT 'low',
  percentage DECIMAL(5,4) DEFAULT 0,
  minimum_price DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Customers (one-to-one extension of users where role='customer')
CREATE TABLE IF NOT EXISTS customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL UNIQUE,
  domain VARCHAR(255),
  products JSON,
  plan_id INT,
  plan_expiry DATE,
  invoice_subtotal DECIMAL(12,2) DEFAULT 0.00,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  subject VARCHAR(500) NOT NULL,
  description TEXT NOT NULL,
  status ENUM('open', 'pending', 'closed') DEFAULT 'open',
  priority ENUM('low', 'normal', 'medium', 'high') DEFAULT 'low',
  assigned_agent_id INT DEFAULT NULL,
  cc_emails TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (assigned_agent_id) REFERENCES users(id)
);

-- Ticket reply messages
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INT PRIMARY KEY AUTO_INCREMENT,
  ticket_id INT NOT NULL,
  sender_id INT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

-- Monthly ticket usage tracking
CREATE TABLE IF NOT EXISTS ticket_usage (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  month_year VARCHAR(7) NOT NULL,
  count INT DEFAULT 0,
  UNIQUE KEY uq_customer_month_ticket (customer_id, month_year),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Monthly call usage tracking
CREATE TABLE IF NOT EXISTS call_usage (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  month_year VARCHAR(7) NOT NULL,
  count INT DEFAULT 0,
  UNIQUE KEY uq_customer_month_call (customer_id, month_year),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

-- Chat sessions
CREATE TABLE IF NOT EXISTS chats (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  agent_id INT DEFAULT NULL,
  status ENUM('waiting', 'active', 'closed') DEFAULT 'waiting',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP DEFAULT NULL,
  closed_at TIMESTAMP DEFAULT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (agent_id) REFERENCES users(id)
);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id INT PRIMARY KEY AUTO_INCREMENT,
  chat_id INT NOT NULL,
  sender_id INT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id)
);

-- Calls (simulated VoIP)
CREATE TABLE IF NOT EXISTS calls (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  agent_id INT DEFAULT NULL,
  virtual_number VARCHAR(20),
  status ENUM('initiated', 'ringing', 'active', 'ended', 'failed', 'missed') DEFAULT 'initiated',
  call_start_time TIMESTAMP DEFAULT NULL,
  call_end_time TIMESTAMP DEFAULT NULL,
  duration INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (agent_id) REFERENCES users(id)
);

-- Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  customer_id INT NOT NULL,
  plan_id INT NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL,
  gst_rate DECIMAL(5,2) DEFAULT 18.00,
  gst_amount DECIMAL(12,2),
  final_price DECIMAL(12,2) NOT NULL,
  status ENUM('pending', 'paid', 'overdue') DEFAULT 'pending',
  due_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);
