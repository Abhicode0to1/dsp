import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { customerBotChat, botRaiseTicket, getMyTickets, uploadAttachment, getCustomerDashboard, getActiveChat } from '../../services/api';
import { usePublicSettings } from '../../contexts/PublicSettingsContext';
import useImagePaste from '../../hooks/useImagePaste';
import {
  MessageCircle, X, Send, Ticket, MessageSquare, Phone,
  CreditCard, ExternalLink, ChevronRight, CheckCircle, Loader,
  Paperclip,
} from 'lucide-react';

const STORAGE_KEY = 'dsp_bot_history';
const MAX_HISTORY  = 60;

const GREETING = "Hi! I'm your support assistant. How can I help you today?";

const CATEGORIES = [
  { label: 'Billing & Payments', key: 'billing', msg: 'Tell me about my plan and billing' },
  { label: 'Google Workspace',   key: 'gws',     msg: 'I need help with Google Workspace' },
  { label: 'Domain',             key: 'domain',  msg: 'I need help with my domain' },
  { label: 'Web Hosting',        key: 'hosting', msg: 'I need help with web hosting' },
  { label: 'Microsoft 365',      key: 'm365',    msg: 'I need help with Microsoft 365' },
  { label: 'Zoho Office',        key: 'zoho',    msg: 'I need help with Zoho Office' },
];

const SUBCATEGORIES = {
  billing: [
    { label: 'Tax invoice not received',      msg: 'My payment is complete but tax invoice not received' },
    { label: 'Still getting reminders',       msg: 'Payment done but still receiving payment reminders' },
    { label: 'Share my account details',      msg: 'Please share my account details' },
    { label: 'Subscription period incorrect', msg: 'My subscription period is incorrect please correct it' },
    { label: 'Reduce bill amount',            msg: 'Please revise and reduce my bill amount' },
    { label: 'Update GST number',             msg: 'Please update my GST number' },
    { label: 'Update billing address',        msg: 'Please update my billing address' },
  ],
  domain: [
    { label: 'Domain renewal date',         msg: 'What is the renewal date of my domain' },
    { label: 'Domain renewal price',        msg: 'What is the renewal price of my domain' },
    { label: 'Domain has expired',          msg: 'My domain has expired please help me' },
    { label: 'Renew my domain',             msg: 'Please renew my domain' },
    { label: 'Domain login details',        msg: 'Please share domain login details' },
  ],
  hosting: [
    { label: 'Available hosting plans',     msg: 'What hosting plans are available' },
    { label: 'Hosting suspended',           msg: 'My hosting has been suspended' },
    { label: 'Website not working',         msg: 'My website is not working' },
    { label: 'Hosting or cPanel login',     msg: 'Need hosting cpanel login details' },
    { label: '1 GB hosting pricing',        msg: 'Please share pricing for 1 GB hosting' },
  ],
  m365: [
    { label: 'Outlook login issue',         msg: 'Account not logging into Outlook Microsoft 365' },
    { label: 'Password reset',              msg: 'Please reset my Microsoft 365 password' },
    { label: 'Emails going to spam',        msg: 'Microsoft 365 emails going to spam' },
    { label: 'Not receiving emails',        msg: 'Not receiving emails from specific email Microsoft 365' },
    { label: 'Storage full',               msg: 'Microsoft 365 account storage is full' },
    { label: 'Restore deleted emails',      msg: 'Emails deleted from inbox please restore Microsoft 365' },
  ],
  zoho: [
    { label: 'Pricing details',             msg: 'Please share Zoho Office pricing details' },
    { label: 'Add 1 license',              msg: 'Please add 1 Zoho license' },
    { label: 'Configure on mobile/iPhone', msg: 'Help configure Zoho account on iPhone mobile' },
    { label: 'Emails auto-deleting',        msg: 'Zoho emails being deleted automatically from mailbox' },
    { label: 'Create email alias',          msg: 'Please create a Zoho email alias' },
    { label: 'Outgoing emails rejected',    msg: 'Zoho outgoing emails being rejected' },
  ],
};

const PLAN_LABEL = { free: 'Free', basic: 'Basic', moderate: 'Moderate', premium: 'Premium' };
const PLAN_TIER  = { free: 0, basic: 1, moderate: 2, premium: 3 };

const TICKET_FLOWS = {
  gws_license: {
    autoSubject: 'Google Workspace License Increase Request',
    questions: [
      'How many additional licenses do you need?',
      'Any message for our team? (e.g. timeline, urgency — or type "none")',
    ],
    build: (a) => `Additional licenses needed: ${a[0]}\nMessage: ${a[1]}`,
  },
  gws_password: {
    autoSubject: 'Google Workspace Password Reset Assistance',
    questions: [
      "Which user's email address needs the password reset?",
      'Any additional message for our team? (or type "none")',
    ],
    build: (a) => `User email: ${a[0]}\nMessage: ${a[1]}`,
  },
  gws_new_user: {
    autoSubject: 'Google Workspace New User Creation Request',
    questions: [
      "What should be the new user's email address?",
      'Any additional details? (display name, role, etc. — or type "none")',
    ],
    build: (a) => `New user email: ${a[0]}\nDetails: ${a[1]}`,
  },
  gws_user_list: {
    autoSubject: 'Google Workspace Active User Report Request',
    questions: [
      'What format do you need the report in? (CSV, PDF, or in-console is fine)',
      'Any additional details or filters needed?',
    ],
    build: (a) => `Format: ${a[0]}\nDetails: ${a[1]}`,
  },
  gws_login_challenge: {
    autoSubject: 'Google Workspace Login Challenge / 2SV Assistance',
    questions: [
      'Which user or Organisational Unit (OU) is affected?',
      'What change do you need? (e.g. disable 2SV, remove login challenge)',
    ],
    build: (a) => `Affected user/OU: ${a[0]}\nRequested change: ${a[1]}`,
  },
  // Domain flows
  domain_transfer: {
    autoSubject: 'Domain Transfer Request',
    questions: ['What is your domain name?', 'Are you transferring TO us or AWAY from us?', 'Any message for our team? (or type "none")'],
    build: (a) => `Domain: ${a[0]}\nDirection: ${a[1]}\nMessage: ${a[2]}`,
  },
  domain_dns: {
    autoSubject: 'DNS Configuration Assistance',
    questions: ['What is your domain name?', 'What DNS record(s) do you need added or updated? (e.g. A record, MX, CNAME, TXT)'],
    build: (a) => `Domain: ${a[0]}\nDNS change needed: ${a[1]}`,
  },
  domain_renewal: {
    autoSubject: 'Domain Renewal Request',
    questions: ['What is your domain name?', 'How many years would you like to renew for?'],
    build: (a) => `Domain: ${a[0]}\nRenewal period: ${a[1]} year(s)`,
  },
  domain_pointing: {
    autoSubject: 'Domain Pointing / DNS Issue',
    questions: ['What is your domain name?', 'What should it point to? (e.g. IP address, hosting server, or service name)'],
    build: (a) => `Domain: ${a[0]}\nShould point to: ${a[1]}`,
  },
  domain_lock: {
    autoSubject: 'Domain Lock / Unlock Request',
    questions: ['What is your domain name?', 'Do you need it locked or unlocked?'],
    build: (a) => `Domain: ${a[0]}\nAction: ${a[1]}`,
  },
  // Web Hosting flows
  hosting_down: {
    autoSubject: 'Website Down — Hosting Issue',
    questions: ['What is your domain name or website URL?', 'What error are you seeing? (e.g. 500 error, blank page, suspended message)'],
    build: (a) => `Website: ${a[0]}\nError: ${a[1]}`,
  },
  hosting_cpanel: {
    autoSubject: 'Hosting Control Panel Access Issue',
    questions: ['What is your domain name?', 'Describe the issue (e.g. wrong password, account locked, unsure of login URL)'],
    build: (a) => `Domain: ${a[0]}\nIssue: ${a[1]}`,
  },
  hosting_email: {
    autoSubject: 'Hosting Email Setup / Issue',
    questions: ['What is your domain name?', 'What do you need help with? (e.g. create email, fix sending/receiving, Outlook setup)'],
    build: (a) => `Domain: ${a[0]}\nRequest: ${a[1]}`,
  },
  hosting_ssl: {
    autoSubject: 'SSL Certificate Issue',
    questions: ['What is your domain name?', 'Describe the SSL issue (e.g. not installed, expired, showing "Not Secure")'],
    build: (a) => `Domain: ${a[0]}\nIssue: ${a[1]}`,
  },
  hosting_storage: {
    autoSubject: 'Hosting Disk Space Issue',
    questions: ['What is your domain name?', 'How much space are you using vs your plan limit? (check cPanel → Disk Usage)'],
    build: (a) => `Domain: ${a[0]}\nDisk usage: ${a[1]}`,
  },
  // Microsoft 365 flows
  m365_license: {
    autoSubject: 'Microsoft 365 License Increase Request',
    questions: ['How many additional Microsoft 365 licenses do you need?', 'Any message for our team? (or type "none")'],
    build: (a) => `Additional licenses needed: ${a[0]}\nMessage: ${a[1]}`,
  },
  m365_password: {
    autoSubject: 'Microsoft 365 Password Reset Assistance',
    questions: ["Which user's email address needs the password reset?", 'Any additional message? (or type "none")'],
    build: (a) => `User email: ${a[0]}\nMessage: ${a[1]}`,
  },
  m365_new_user: {
    autoSubject: 'Microsoft 365 New User Creation Request',
    questions: ["What should be the new user's email address?", 'Any additional details? (display name, role — or type "none")'],
    build: (a) => `New user email: ${a[0]}\nDetails: ${a[1]}`,
  },
  m365_outlook: {
    autoSubject: 'Outlook / Microsoft 365 Email Issue',
    questions: ['Which email address is affected?', 'Describe the issue (e.g. not sending, not receiving, error message shown)'],
    build: (a) => `Affected email: ${a[0]}\nIssue: ${a[1]}`,
  },
  m365_teams: {
    autoSubject: 'Microsoft Teams / OneDrive Issue',
    questions: ['Which user or email is affected?', 'Describe the issue (e.g. Teams calls failing, OneDrive not syncing)'],
    build: (a) => `Affected user: ${a[0]}\nIssue: ${a[1]}`,
  },
  // Zoho Office flows
  zoho_license: {
    autoSubject: 'Zoho License Increase Request',
    questions: ['How many additional Zoho licenses do you need?', 'Which Zoho apps? (e.g. Zoho Mail, CRM, Workplace — or type "all")'],
    build: (a) => `Additional licenses: ${a[0]}\nApps: ${a[1]}`,
  },
  zoho_password: {
    autoSubject: 'Zoho Password Reset Assistance',
    questions: ["Which user's email address needs the password reset?", 'Any additional message? (or type "none")'],
    build: (a) => `User email: ${a[0]}\nMessage: ${a[1]}`,
  },
  zoho_new_user: {
    autoSubject: 'Zoho New User Creation Request',
    questions: ["What should be the new user's email address?", 'Any additional details? (name, role, apps needed — or type "none")'],
    build: (a) => `New user email: ${a[0]}\nDetails: ${a[1]}`,
  },
  zoho_mail: {
    autoSubject: 'Zoho Mail Issue',
    questions: ['Which email address or domain is affected?', 'Describe the issue (e.g. not receiving, MX records, DKIM problem)'],
    build: (a) => `Affected email/domain: ${a[0]}\nIssue: ${a[1]}`,
  },
  zoho_access: {
    autoSubject: 'Zoho App Access / Permission Issue',
    questions: ['Which user and which Zoho app are affected?', 'Describe the issue (e.g. cannot login, permission denied, app not visible)'],
    build: (a) => `User/App: ${a[0]}\nIssue: ${a[1]}`,
  },
  // Billing-specific flows
  billing_invoice: {
    autoSubject: 'Tax Invoice Not Received — Resend Request',
    questions: ['What was your payment date and approximate amount?', 'Do you have a payment transaction ID or reference number?'],
    build: (a) => `Payment date & amount: ${a[0]}\nTransaction ID: ${a[1]}`,
  },
  billing_reminders: {
    autoSubject: 'Payment Reminders After Payment — Stop Request',
    questions: ['What is your payment date and transaction/reference ID?', 'On which email address are you receiving reminders?'],
    build: (a) => `Payment details: ${a[0]}\nReminder email: ${a[1]}`,
  },
  billing_gst: {
    autoSubject: 'GST Number Update Request',
    questions: ['What is your correct GST number (GSTIN)?', 'What is the company name registered under this GST?'],
    build: (a) => `GST Number: ${a[0]}\nCompany name: ${a[1]}`,
  },
  billing_address: {
    autoSubject: 'Billing Address Update Request',
    questions: ['Please provide the complete new billing address:', 'City, State and PIN code?'],
    build: (a) => `New address: ${a[0]}\nCity/State/PIN: ${a[1]}`,
  },
  billing_subscription: {
    autoSubject: 'Subscription Period Correction Request',
    questions: ['What subscription period is currently showing (incorrect)?', 'What should the correct subscription period be?'],
    build: (a) => `Incorrect period shown: ${a[0]}\nExpected period: ${a[1]}`,
  },
  billing_reduce: {
    autoSubject: 'Bill Revision / Amount Reduction Request',
    questions: ['Which invoice is this for? (invoice number or date)', 'Why should the bill be revised or reduced?'],
    build: (a) => `Invoice: ${a[0]}\nReason: ${a[1]}`,
  },
  // Domain-specific flows
  domain_price_query: {
    autoSubject: 'Domain Renewal Price Enquiry',
    questions: ['What is your domain name?'],
    build: (a) => `Domain: ${a[0]}`,
  },
  domain_expired_now: {
    autoSubject: 'URGENT — Domain Expired',
    questions: ['What is your expired domain name?', 'How many days ago did it expire (if known)?'],
    build: (a) => `Expired domain: ${a[0]}\nExpired since: ${a[1]}`,
  },
  domain_login_req: {
    autoSubject: 'Domain Login / Registrar Access Request',
    questions: ['What is your domain name?', 'What access do you need? (registrar login / DNS panel / EPP auth code)'],
    build: (a) => `Domain: ${a[0]}\nAccess needed: ${a[1]}`,
  },
  // Hosting-specific flows
  hosting_plans_query: {
    autoSubject: 'Hosting Plans Enquiry',
    questions: ['What type of hosting are you looking for? (Shared / WordPress / VPS)', 'Any specific requirements? (storage, PHP version, etc.)'],
    build: (a) => `Hosting type: ${a[0]}\nRequirements: ${a[1]}`,
  },
  hosting_suspended_ticket: {
    autoSubject: 'Hosting Account Suspended — Urgent',
    questions: ['What is your domain name or cPanel username?', 'What message is showing on the website?'],
    build: (a) => `Domain/Username: ${a[0]}\nSuspension message: ${a[1]}`,
  },
  hosting_login_req: {
    autoSubject: 'Hosting / cPanel Login Details Request',
    questions: ['What is your domain name?', 'What access do you need? (cPanel / FTP / database)'],
    build: (a) => `Domain: ${a[0]}\nAccess type: ${a[1]}`,
  },
  hosting_1gb_price: {
    autoSubject: '1 GB Hosting Pricing Enquiry',
    questions: ['Is this for a new hosting account or an upgrade?', 'Any specific requirements? (or type "none")'],
    build: (a) => `New or upgrade: ${a[0]}\nRequirements: ${a[1]}`,
  },
  // M365-specific flows
  m365_outlook_login: {
    autoSubject: 'Microsoft 365 — Outlook Login Issue',
    questions: ['Which email address cannot log in to Outlook?', 'What error message are you seeing?'],
    build: (a) => `Email: ${a[0]}\nError: ${a[1]}`,
  },
  m365_pwd_reset: {
    autoSubject: 'Microsoft 365 — Password Reset Request',
    questions: ['Which email address needs the password reset?'],
    build: (a) => `Email to reset: ${a[0]}`,
  },
  m365_spam: {
    autoSubject: 'Microsoft 365 — Emails Going to Spam',
    questions: ['Which email address are outgoing emails sent from?', 'Which recipient email service receives them in spam? (Gmail / Yahoo / Outlook, etc.)'],
    build: (a) => `Sender: ${a[0]}\nRecipient service: ${a[1]}`,
  },
  m365_not_receiving: {
    autoSubject: 'Microsoft 365 — Not Receiving Emails from/to Specific ID',
    questions: ['Which Microsoft 365 email address is affected?', 'What is the specific sender or recipient email ID involved?'],
    build: (a) => `Affected email: ${a[0]}\nOther email ID: ${a[1]}`,
  },
  m365_storage: {
    autoSubject: 'Microsoft 365 — Mailbox Storage Full',
    questions: ['Which email address has a full storage/mailbox?'],
    build: (a) => `Email: ${a[0]}`,
  },
  m365_restore: {
    autoSubject: 'Microsoft 365 — Deleted Emails Restore Request',
    questions: ['Which email address had emails deleted?', 'Approximately when were they deleted?', 'Any specific senders or subjects to search for?'],
    build: (a) => `Email: ${a[0]}\nDeleted around: ${a[1]}\nSearch criteria: ${a[2]}`,
  },
  // Zoho-specific flows
  zoho_pricing_req: {
    autoSubject: 'Zoho Office — Pricing Enquiry',
    questions: ['Which Zoho products are you interested in? (Mail / CRM / Workplace / etc.)', 'How many users/licenses do you need?'],
    build: (a) => `Products: ${a[0]}\nLicenses: ${a[1]}`,
  },
  zoho_add_license: {
    autoSubject: 'Zoho Office — License Addition Request',
    questions: ['How many licenses do you want to add?', 'For which Zoho product(s)?'],
    build: (a) => `Licenses: ${a[0]}\nProducts: ${a[1]}`,
  },
  zoho_mobile_config: {
    autoSubject: 'Zoho Office — Mobile/iPhone Configuration',
    questions: ['Which email address needs to be configured?', 'What device and app? (e.g. iPhone — Zoho Mail app / native Mail)'],
    build: (a) => `Email: ${a[0]}\nDevice/App: ${a[1]}`,
  },
  zoho_auto_delete: {
    autoSubject: 'Zoho Office — Emails Auto-Deleting from Mailbox',
    questions: ['Which Zoho email address is affected?', 'Which folder are emails disappearing from, and since approximately when?'],
    build: (a) => `Email: ${a[0]}\nFolder & timeline: ${a[1]}`,
  },
  zoho_alias: {
    autoSubject: 'Zoho Office — Email Alias Creation Request',
    questions: ['What should the alias email address be?', 'Which existing user account should it point to?'],
    build: (a) => `Alias: ${a[0]}\nPoints to: ${a[1]}`,
  },
  zoho_outgoing: {
    autoSubject: 'Zoho Office — Outgoing Emails Being Rejected',
    questions: ['Which Zoho email address is experiencing rejections?', 'What rejection/bounce message are you receiving?'],
    build: (a) => `Email: ${a[0]}\nError message: ${a[1]}`,
  },
  general: {
    autoSubject: null,
    subjectIndex: 0,
    questions: [
      "What's the subject of your issue?",
      'Please describe your issue in detail:',
    ],
    build: (a) => a[1],
  },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function BotLinks({ links, onNavigate }) {
  if (!links?.length) return null;
  return (
    <div className="flex flex-col gap-1 mt-2">
      {links.map((l, i) => (
        l.internal
          ? <button key={i} onClick={() => onNavigate(l.url)} className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium">
              <ChevronRight className="w-3 h-3" />{l.label}
            </button>
          : <a key={i} href={l.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium">
              <ExternalLink className="w-3 h-3" />{l.label}
            </a>
      ))}
    </div>
  );
}

function BillingSummary({ data }) {
  if (!data) return null;
  return (
    <div className="mt-2 bg-blue-50 rounded-lg p-2.5 text-xs space-y-1 border border-blue-100">
      <div className="flex justify-between">
        <span className="text-gray-500">Plan</span>
        <span className="font-semibold text-gray-800 capitalize">{data.plan}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-500">Status</span>
        <span className={`font-semibold ${data.status === 'Active' ? 'text-green-600' : 'text-red-600'}`}>{data.status}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-500">Expiry</span>
        <span className="font-semibold text-gray-800">{data.expiry}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-500">Live Chat</span>
        <span className={data.allow_chat ? 'text-green-600 font-semibold' : 'text-gray-400'}>
          {data.allow_chat ? 'Available' : 'Not on plan'}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-500">Voice Call</span>
        <span className={data.allow_calls ? 'text-green-600 font-semibold' : 'text-gray-400'}>
          {data.allow_calls ? 'Available' : 'Not on plan'}
        </span>
      </div>
      {data.tickets_limit !== undefined && (
        <div className="flex justify-between">
          <span className="text-gray-500">Tickets (this month)</span>
          <span className={
            data.tickets_limit !== null && data.tickets_used >= data.tickets_limit
              ? 'text-red-600 font-semibold'
              : 'font-semibold text-gray-800'
          }>
            {data.tickets_used ?? 0}{data.tickets_limit !== null ? ` / ${data.tickets_limit}` : ' / Unlimited'}
          </span>
        </div>
      )}
    </div>
  );
}

function SupportOptions({ planInfo, hasActiveChat, onTicket, onChat, onCall, onBilling }) {
  const opts = [
    {
      key: 'ticket',
      icon: Ticket,
      label: 'Raise a Ticket',
      available: true,
      color: 'bg-blue-600 hover:bg-blue-700 text-white',
      onClick: onTicket,
    },
    {
      key: 'chat',
      icon: MessageSquare,
      label: 'Chat with Agent',
      available: !!(planInfo?.allow_chat && planInfo?.is_active),
      color: 'bg-green-600 hover:bg-green-700 text-white',
      reason: !planInfo?.is_active
        ? 'Your plan has expired'
        : `Requires ${PLAN_LABEL.basic} plan or above`,
      onClick: onChat,
    },
    {
      key: 'call',
      icon: Phone,
      label: 'Request a Call',
      available: !!(planInfo?.allow_calls && planInfo?.is_active) && !hasActiveChat,
      color: 'bg-blue-600 hover:bg-blue-700 text-white',
      reason: hasActiveChat
        ? 'You have an active chat session. End your chat before starting a call.'
        : !planInfo?.is_active
          ? 'Your plan has expired'
          : `Requires ${PLAN_LABEL.moderate} plan or above`,
      onClick: onCall,
    },
  ];

  return (
    <div className="flex flex-col gap-1.5 mt-2">
      {opts.map(o => {
        const Icon = o.icon;
        if (o.available) {
          return (
            <button key={o.key} onClick={o.onClick}
              className={`flex items-center gap-2 w-full text-xs font-semibold px-3 py-2 rounded-lg transition-colors ${o.color}`}>
              <Icon className="w-3.5 h-3.5 flex-shrink-0" />
              {o.label}
            </button>
          );
        }
        return (
          <div key={o.key} className="relative group">
            <button disabled
              className="flex items-center gap-2 w-full text-xs font-medium px-3 py-2 rounded-lg bg-gray-100 text-gray-400 cursor-not-allowed opacity-70">
              <Icon className="w-3.5 h-3.5 flex-shrink-0" />
              {o.label}
              <span className="ml-auto text-[10px] bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded-full">Upgrade</span>
            </button>
            {/* Tooltip */}
            <div className="absolute bottom-full left-0 mb-1.5 w-56 bg-gray-900 text-white text-[11px] rounded-xl p-3 z-50 invisible group-hover:visible shadow-xl pointer-events-none group-hover:pointer-events-auto">
              <p className="mb-2 leading-relaxed">{o.reason}</p>
              <button onClick={onBilling}
                className="flex items-center gap-1 text-blue-300 hover:text-white font-semibold transition-colors pointer-events-auto">
                <CreditCard className="w-3 h-3" /> View upgrade options →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Render text with **bold** + newlines ──────────────────────────────────────
function BotText({ text }) {
  return (
    <>
      {text.split('\n').map((line, li, lines) => {
        const parts = line.split(/(\*\*[^*]+\*\*)/g);
        return (
          <span key={li}>
            {parts.map((p, i) =>
              p.startsWith('**') && p.endsWith('**')
                ? <strong key={i}>{p.slice(2, -2)}</strong>
                : <span key={i}>{p}</span>
            )}
            {li < lines.length - 1 && <br />}
          </span>
        );
      })}
    </>
  );
}

// ── Main widget ────────────────────────────────────────────────────────────────
export default function BotWidget({ hideLauncherOnMobile = false, hideLauncher = false }) {
  const { settings: publicSettings } = usePublicSettings();
  // Admin kill switch — set a flag here; the early return at the END of this
  // component (just before the JSX) returns null when the bot is disabled.
  // Can't return early up here without violating React's rules of hooks.
  const botDisabled = publicSettings && publicSettings.bot_widget_enabled === false;

  const [open, setOpen]       = useState(false);
  const [msgs, setMsgs]       = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) { const p = JSON.parse(saved); if (Array.isArray(p) && p.length) return p; }
    } catch {}
    return [{ role: 'bot', text: GREETING, showCategories: true, ts: Date.now() }];
  });
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const [botPhase, setBotPhase]          = useState('chat');
  const [ticketContext, setTicketContext] = useState('general');
  const [ticketAnswers, setTicketAnswers] = useState([]);
  const [ticketStep, setTicketStep]       = useState(0);
  const [planInfo, setPlanInfo]           = useState(null);
  const [hasActiveChat, setHasActiveChat] = useState(false);
  const [followupDone, setFollowupDone]   = useState(false);
  // New feature state
  const [hasUnread, setHasUnread]         = useState(false);
  const [pendingFile, setPendingFile]     = useState(null); // File object
  const bottomRef  = useRef(null);
  const fileInputRef = useRef(null);
  const navigate   = useNavigate();

  // Listen for external open trigger
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('open-bot-widget', handler);
    return () => window.removeEventListener('open-bot-widget', handler);
  }, []);

  // Persist conversation history
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-MAX_HISTORY))); } catch {}
  }, [msgs]);


  // Unread ticket replies — check on mount
  useEffect(() => {
    const lastSeen = localStorage.getItem('dsp_bot_last_seen');
    if (!lastSeen) return;
    getMyTickets().then(r => {
      const tickets = Array.isArray(r.data) ? r.data : (r.data?.tickets ?? []);
      const cutoff = new Date(lastSeen);
      setHasUnread(tickets.some(t => new Date(t.updated_at) > cutoff));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, open, loading]);

  // On open: fetch plan info (once) + active session status (every open)
  useEffect(() => {
    if (!open) return;
    if (!planInfo) {
      getCustomerDashboard().then(res => {
        const p = res.data.plan;
        setPlanInfo({
          allow_chat:  !!(p.allowChat  && p.isActive),
          allow_calls: !!(p.allowCalls && p.isActive),
          is_active:   p.isActive,
        });
      }).catch(() => {});
    }
    // Always re-check active chat so buttons reflect current session state
    getActiveChat().then(res => setHasActiveChat(!!(res.data.chat))).catch(() => {});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const addMsg = (msg) => setMsgs(m => [...m, { ...msg, ts: Date.now() }]);

  // Ctrl+V paste — only honored during ticket-collection phase (same gate as
  // the Attach button). 5 MB cap matches the file picker.
  const onPasteImage = useCallback((file) => {
    if (botPhase !== 'collecting_ticket') return;
    if (file.size > 5 * 1024 * 1024) {
      addMsg({ role: 'bot', text: 'File too large — max 5 MB allowed.', links: [] });
      return;
    }
    setPendingFile(file);
  }, [botPhase]);
  const pasteRef = useImagePaste(onPasteImage);

  const goNavigate = (path) => {
    setOpen(false);
    if (path.startsWith('http')) window.open(path, '_blank');
    else navigate(path);
  };

  // ── Normal bot query ──────────────────────────────────────────────────────
  const callBot = async (text) => {
    setLoading(true);
    try {
      const res = await customerBotChat({ message: text });
      const { reply, links, billing_summary, show_followup, show_options, subtopics, action, plan_info, ticket_context: tc } = res.data;
      if (plan_info) setPlanInfo(plan_info);
      setFollowupDone(false);
      // Always sync ticket context so the next "Raise a Ticket" flow uses the right questions
      setTicketContext(tc || 'general');

      if (action === 'raise_ticket') {
        addMsg({ role: 'bot', text: reply, links: [] });
        startTicketFlow(tc || 'general');
        return;
      }

      if (action === 'chat') {
        addMsg({ role: 'bot', text: reply, links: [] });
        setPendingFile(null);
        setTimeout(() => { setOpen(false); navigate('/customer/chat?start=1'); }, 800);
        return;
      }

      if (action === 'call') {
        addMsg({ role: 'bot', text: reply, links: [] });
        setPendingFile(null);
        setTimeout(() => { setOpen(false); navigate('/customer/call?start=1'); }, 800);
        return;
      }

      addMsg({
        role: 'bot', text: reply, links: links || [],
        billing_summary: billing_summary || null,
        show_followup: !!show_followup,
        show_options: !!show_options,
        subtopics: subtopics || null,
        ticket_context: tc || null,
      });
    } catch {
      addMsg({ role: 'bot', text: "Sorry, I couldn't process that. Please try again.", links: [] });
    } finally {
      setLoading(false);
    }
  };

  // ── Send handler — behaviour depends on current phase ─────────────────────
  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    addMsg({ role: 'user', text });

    if (botPhase === 'collecting_ticket') {
      const flow = TICKET_FLOWS[ticketContext] || TICKET_FLOWS.general;
      const newAnswers = [...ticketAnswers, text];

      if (newAnswers.length < flow.questions.length) {
        setTicketAnswers(newAnswers);
        setTicketStep(newAnswers.length);
        addMsg({ role: 'bot', text: flow.questions[newAnswers.length], links: [] });
        return;
      }

      // All questions answered — submit
      setBotPhase('chat');
      setLoading(true);
      try {
        const subject = flow.autoSubject || newAnswers[flow.subjectIndex ?? 0];
        const description = flow.build(newAnswers);
        const res = await botRaiseTicket({ subject, description });
        const { ticket_id, message } = res.data;
        // Upload attachment if one was selected
        if (pendingFile && ticket_id) {
          try {
            const fd = new FormData();
            fd.append('file', pendingFile);
            fd.append('ref_type', 'ticket');
            fd.append('ref_id', String(ticket_id));
            await uploadAttachment(fd);
            addMsg({ role: 'ticket_success', ticket_id, message });
          } catch {
            addMsg({ role: 'bot', text: 'Ticket raised! Note: attachment could not be uploaded — please attach it directly from the ticket.', links: [] });
          }
        } else {
          addMsg({ role: 'ticket_success', ticket_id, message });
        }
      } catch (err) {
        addMsg({ role: 'bot', text: err.response?.data?.error || "Sorry, couldn't raise the ticket. Please try again.", links: [] });
      } finally {
        setLoading(false);
        setTicketAnswers([]);
        setTicketStep(0);
        setPendingFile(null);
      }
      return;
    }

    await callBot(text);
  };

  const sendQuery = (msg, label) => {
    if (!msg?.trim() || loading) return;
    addMsg({ role: 'user', text: label || msg });
    callBot(msg);
  };

  const handleCategory = (cat) => {
    if (loading) return;
    const subs = cat.key && SUBCATEGORIES[cat.key];
    if (subs) {
      addMsg({ role: 'user', text: cat.label });
      addMsg({ role: 'bot', text: `What specifically do you need help with for **${cat.label}**?`, showSubcategories: cat.key, links: [] });
    } else {
      addMsg({ role: 'user', text: cat.msg });
      callBot(cat.msg);
    }
  };

  const handleFollowupNo = () => {
    setFollowupDone(true);
    addMsg({ role: 'bot', text: "No worries! Here's how I can help you further:", links: [], show_options: true, ticket_context: ticketContext });
  };

  const handleFollowupYes = () => {
    setFollowupDone(true);
    addMsg({ role: 'bot', text: "Great, glad I could help! Feel free to ask anything else.", links: [] });
  };

  const startTicketFlow = (ctx) => {
    const context = ctx || ticketContext || 'general';
    const flow = TICKET_FLOWS[context] || TICKET_FLOWS.general;
    setTicketContext(context);
    setTicketAnswers([]);
    setTicketStep(0);
    setBotPhase('collecting_ticket');
    addMsg({ role: 'bot', text: flow.questions[0], links: [] });
  };

  const activeFlow = TICKET_FLOWS[ticketContext] || TICKET_FLOWS.general;
  const inputPlaceholder = botPhase === 'collecting_ticket'
    ? `Step ${ticketStep + 1}/${activeFlow.questions.length} — type your answer...`
    : 'Type your question...';

  const isLastBotIdx = msgs.reduce((acc, m, i) => m.role === 'bot' ? i : acc, -1);

  const resetConversation = () => {
    const fresh = [{ role: 'bot', text: GREETING, showCategories: true, ts: Date.now() }];
    setMsgs(fresh);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)); } catch {}
    setBotPhase('chat');
    setTicketContext('general');
    setTicketAnswers([]);
    setTicketStep(0);
    setFollowupDone(false);
    setPendingFile(null);
  };

  // Admin kill switch — see top of component.
  if (botDisabled) return null;

  return createPortal(
    <>
      {/* Floating toggle. hideLauncher fully hides it (the FloatingDock provides
          the trigger). hideLauncherOnMobile only hides on small screens. */}
      <div className={`fixed bottom-6 right-6 z-[9999] ${hideLauncher ? 'hidden' : hideLauncherOnMobile ? 'hidden lg:block' : ''}`}>
        <button
          onClick={() => {
            const opening = !open;
            setOpen(opening);
            if (opening) {
              setHasUnread(false);
              localStorage.setItem('dsp_bot_last_seen', new Date().toISOString());
            }
          }}
          className="relative w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all hover:scale-105 active:scale-95"
          title="Support Assistant"
          aria-label="Open support assistant"
        >
          {open ? <X className="w-5 h-5" /> : <MessageCircle className="w-6 h-6" />}
          {!open && hasUnread && (
            <span className="absolute top-0.5 right-0.5 w-3.5 h-3.5 bg-red-500 rounded-full border-2 border-white animate-pulse" />
          )}
        </button>
      </div>

      {/* Chat panel */}
      {open && (
        <div
          className="fixed bottom-24 inset-x-4 sm:inset-x-auto sm:right-6 z-[9999] w-auto sm:w-80 max-h-[70dvh] sm:max-h-none bg-white rounded-2xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          style={{ height: '460px' }}
        >
          {/* Header */}
          <div className="bg-blue-600 px-4 py-3 flex items-center gap-2.5 flex-shrink-0">
            <div className="w-8 h-8 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0">
              <MessageCircle className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white leading-tight">Support Assistant</p>
              <p className="text-xs text-blue-200 truncate mt-0.5">Ask me anything</p>
            </div>
            {msgs.length > 1 && (
              <button onClick={resetConversation} title="Start over"
                className="text-[10px] text-blue-200 hover:text-white border border-white/20 hover:border-white/50 rounded-full px-2 py-0.5 transition-colors flex-shrink-0">
                ↩ Start over
              </button>
            )}
            {/* Close — the launcher that used to toggle this is now hidden
                (the FloatingDock opens us), so the panel needs its own close. */}
            <button onClick={() => setOpen(false)} title="Close" aria-label="Close assistant"
              className="text-blue-200 hover:text-white transition-colors flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {msgs.map((m, i) => {
              /* ── Ticket success ── */
              if (m.role === 'ticket_success') return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[88%] bg-green-50 border border-green-200 rounded-xl p-3 text-xs text-green-800">
                    <div className="flex items-center gap-1.5 font-semibold mb-1">
                      <CheckCircle className="w-4 h-4 text-green-600" />
                      Ticket #{m.ticket_id} Raised!
                    </div>
                    <BotText text={m.message} />
                    <button onClick={() => goNavigate(`/customer/tickets/${m.ticket_id}`)}
                      className="mt-2 flex items-center gap-1 text-blue-600 hover:text-blue-800 font-semibold">
                      <ChevronRight className="w-3 h-3" /> View my tickets →
                    </button>
                  </div>
                </div>
              );

              /* ── User message ── */
              if (m.role === 'user') return (
                <div key={i} className="flex justify-end">
                  <div className="flex flex-col items-end gap-0.5">
                    <div className="max-w-[85%] px-3 py-2 rounded-xl text-sm bg-blue-600 text-white rounded-tr-sm">
                      {m.text}
                    </div>
                    {m.ts && <span className="text-[10px] text-gray-400 px-1">{new Date(m.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
                  </div>
                </div>
              );

              /* ── Bot message ── */
              return (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[88%] flex flex-col items-start gap-1.5">
                    <div className="px-3 py-2 rounded-xl text-sm bg-gray-100 text-gray-800 rounded-tl-sm leading-relaxed">
                      <BotText text={m.text} />
                    </div>
                    {m.ts && <span className="text-[10px] text-gray-400 px-1 -mt-1">{new Date(m.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}

                    {/* Billing summary card */}
                    {m.billing_summary && <BillingSummary data={m.billing_summary} />}

                    {/* Links */}
                    <BotLinks links={m.links} onNavigate={goNavigate} />

                    {/* GWS sub-topic chips */}
                    {m.subtopics && m.subtopics.length > 0 && (
                      <div className="flex flex-col gap-1 mt-1 w-full">
                        {m.subtopics.map(t => (
                          <button key={t.label} onClick={() => sendQuery(t.msg, t.label)}
                            className="text-left text-xs px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-400 transition-colors font-medium">
                            {t.label}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Sub-category chips (shown when category is clicked) */}
                    {m.showSubcategories && SUBCATEGORIES[m.showSubcategories] && (
                      <div className="flex flex-col gap-1 mt-1 w-full">
                        {SUBCATEGORIES[m.showSubcategories].map(sub => (
                          <button key={sub.label} onClick={() => sendQuery(sub.msg, sub.label)}
                            className="text-left text-xs px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-colors font-medium flex items-center gap-1.5">
                            <ChevronRight className="w-3 h-3 flex-shrink-0 text-gray-400" />
                            {sub.label}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Category chips — shown only on greeting */}
                    {m.showCategories && msgs.length === 1 && !loading && (
                      <div className="mt-1 w-full">
                        <div className="grid grid-cols-2 gap-1">
                          {CATEGORIES.map(c => (
                            <button key={c.label} onClick={() => handleCategory(c)}
                              className="text-left text-xs px-2.5 py-2 rounded-lg border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-colors leading-tight">
                              {c.label}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-gray-400 mt-1 px-1">or type your question below</p>
                      </div>
                    )}

                    {/* "Did this help?" follow-up (only on last bot message) */}
                    {m.show_followup && i === isLastBotIdx && !followupDone && (
                      <div className="flex gap-2 mt-1">
                        <button onClick={handleFollowupYes}
                          className="text-xs px-3 py-1 rounded-full bg-green-100 text-green-700 hover:bg-green-200 font-medium transition-colors">
                          ✓ Yes, thanks!
                        </button>
                        <button onClick={handleFollowupNo}
                          className="text-xs px-3 py-1 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 font-medium transition-colors">
                          ✗ Need more help
                        </button>
                      </div>
                    )}

                    {/* Support options — suppress when follow-up is shown (handleFollowupNo adds them after) */}
                    {m.show_options && !m.show_followup && (
                      <SupportOptions
                        planInfo={planInfo}
                        hasActiveChat={hasActiveChat}
                        onTicket={() => startTicketFlow(m.ticket_context || 'general')}
                        onChat={() => { setOpen(false); navigate('/customer/chat?start=1'); }}
                        onCall={() => { setOpen(false); navigate('/customer/call?start=1'); }}
                        onBilling={() => { setOpen(false); navigate('/customer/billing'); }}
                      />
                    )}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 px-4 py-2.5 rounded-xl rounded-tl-sm">
                  <Loader className="w-4 h-4 text-gray-400 animate-spin" />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Phase indicator (ticket collection) */}
          {botPhase === 'collecting_ticket' && (
            <div className="flex-shrink-0 px-3 py-1.5 bg-amber-50 border-t border-amber-200 text-xs text-amber-700 font-medium flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Ticket className="w-3 h-3" />
                Raising ticket — Step {ticketStep + 1} of {activeFlow.questions.length}
              </span>
              <button onClick={() => { setBotPhase('chat'); setTicketAnswers([]); setTicketStep(0); addMsg({ role: 'bot', text: 'Ticket cancelled. How else can I help?', links: [], show_options: true }); }}
                className="text-amber-600 hover:text-red-600 underline transition-colors">
                Cancel
              </button>
            </div>
          )}

          {/* Input */}
          <div className="border-t border-gray-100 px-3 pt-2 pb-2.5 flex-shrink-0">
            {/* Pending file indicator */}
            {pendingFile && (
              <div className="flex items-center gap-1.5 mb-1.5 px-2 py-1 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                <Paperclip className="w-3 h-3 flex-shrink-0" />
                <span className="truncate flex-1">{pendingFile.name}</span>
                <button onClick={() => setPendingFile(null)} className="flex-shrink-0 text-blue-400 hover:text-red-500 transition-colors">
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}
            <div className="flex gap-2">
              {/* Attach file (ticket collection only) */}
              {botPhase === 'collecting_ticket' && (
                <>
                  <input ref={fileInputRef} type="file" className="hidden"
                    accept="image/*,.pdf,.doc,.docx,.txt,.zip"
                    onChange={e => {
                      const f = e.target.files[0];
                      if (!f) return;
                      if (f.size > 5 * 1024 * 1024) { addMsg({ role: 'bot', text: 'File too large — max 5 MB allowed.', links: [] }); }
                      else setPendingFile(f);
                      e.target.value = '';
                    }}
                  />
                  <button onClick={() => fileInputRef.current?.click()} title="Attach file"
                    className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:text-blue-600 hover:border-blue-400 transition-colors">
                    <Paperclip className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
              <input
                ref={pasteRef}
                type="text"
                className="flex-1 text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-colors"
                placeholder={inputPlaceholder}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && send()}
                disabled={loading}
              />
              <button
                onClick={send}
                disabled={!input.trim() || loading}
                className="w-8 h-8 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg flex items-center justify-center transition-colors flex-shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}
