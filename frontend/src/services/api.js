import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('dsp_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      const stillOnLogin = window.location.pathname === '/login';
      // Single-device login revocation — when the user signs in elsewhere, the
      // backend stamps every subsequent request with 401 + `code: 'session_revoked'`.
      // ONLY on that discriminator do we wipe local storage and bounce to /login.
      // Other 401s (transient network blip, an /auth/me race during a new-tab
      // boot, an endpoint the user doesn't have rights to) must NOT wipe the
      // session — localStorage is shared across tabs, so wiping here would
      // silently log them out of every tab they have open. AuthContext handles
      // a soft /auth/me failure on its own (keeps cached user, lets the user
      // continue) without involving this interceptor.
      if (err.response?.data?.code === 'session_revoked' && !stillOnLogin) {
        try { sessionStorage.setItem('dsp_session_revoked', '1'); } catch {}
        localStorage.removeItem('dsp_token');
        localStorage.removeItem('dsp_user');
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  }
);

export default api;

// ── Auth ──────────────────────────────────────────────────────────────────────
export const login           = (data) => api.post('/auth/login', data);
export const logout          = ()     => api.post('/auth/logout');
// 2FA — partial token from login is sent back to verify-login with the code
export const verifyLogin2fa  = (data) => api.post('/auth/2fa/verify-login', data);
export const get2faStatus    = ()     => api.get('/auth/2fa/status');
export const setup2faInit    = ()     => api.post('/auth/2fa/setup-init');
export const setup2faConfirm = (data) => api.post('/auth/2fa/setup-confirm', data);
export const disable2fa      = (data) => api.post('/auth/2fa/disable', data);
export const getMe           = ()     => api.get('/auth/me');
export const changePassword  = (data) => api.put('/auth/change-password', data);
export const requestChangePasswordOtp = () => api.post('/auth/change-password/request-otp');

// ── Customer ──────────────────────────────────────────────────────────────────
export const getCustomerDashboard = () => api.get('/customer/dashboard');
export const getCustomerPlans     = ()     => api.get('/customer/plans');
export const initiateUpgrade      = (data) => api.post('/customer/upgrade/initiate', data);
export const verifyUpgrade        = (data) => api.post('/customer/upgrade/verify', data);
export const customerBotChat        = (data) => api.post('/customer/bot', data);
export const botRaiseTicket         = (data) => api.post('/customer/bot/ticket', data);
export const getCustomerAgentStatus   = ()   => api.get('/customer/agent-status');
export const getCustomerSubscriptions = ()   => api.get('/customer/subscriptions');
export const getCustomerInvoices      = ()   => api.get('/customer/invoices');
export const getCustomerQuotes        = ()   => api.get('/customer/quotes');
export const downloadInvoicePdf         = (id) => api.get(`/customer/invoices/${id}/pdf`, { responseType: 'blob' });
export const downloadQuotePdf           = (id) => api.get(`/customer/quotes/${id}/pdf`,   { responseType: 'blob' });
export const initiateQuotePayment       = (id, data) => api.post(`/customer/quotes/${id}/pay/initiate`, data);
export const verifyQuotePayment         = (id, data) => api.post(`/customer/quotes/${id}/pay/verify`, data);

// ── Tickets (customer) ────────────────────────────────────────────────────────
export const getMyTickets      = (params) => api.get('/tickets', { params });
export const getTicketById     = (id)     => api.get(`/tickets/${id}`);
export const createTicket      = (data)   => api.post('/tickets', data);
export const addTicketMessage  = (id, d)  => api.post(`/tickets/${id}/messages`, d);
export const botSuggest        = (data)   => api.post('/tickets/bot-suggest', data);
export const closeTicket       = (id)     => api.put(`/tickets/${id}/close`);
export const reopenTicket      = (id)     => api.put(`/tickets/${id}/reopen`);
export const updateTicketCcEmails = (id, cc_emails) => api.put(`/tickets/${id}/cc-emails`, { cc_emails });
export const getTicketTemplates = ()      => api.get('/tickets/templates');

// ── Chat (customer) ───────────────────────────────────────────────────────────
export const initiateChat         = (data)     => api.post('/chat/initiate', data || {});
export const getActiveChat        = ()         => api.get('/chat/active');
export const getChatQueue         = ()         => api.get('/chat/queue');
export const closeChat            = (id)       => api.put(`/chat/${id}/close`);
export const rateChat             = (id, data) => api.post(`/chat/${id}/rate`, data);
export const leaveOfflineMessage  = (data)     => api.post('/chat/offline-message', data);
export const getChatHistory       = ()         => api.get('/chat/history');

// ── Calls (customer) ──────────────────────────────────────────────────────────
// initiateCall accepts either a chatId string (legacy callers — escalating from
// a chat) or an options object { chatId, category }. Backwards compatible.
export const initiateCall  = (opts) => {
  const body = typeof opts === 'string' || typeof opts === 'number'
    ? { chat_id: opts }
    : { chat_id: opts?.chatId, category: opts?.category };
  // Strip undefined keys so the backend's body parser doesn't choke.
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
  return api.post('/calls/initiate', body);
};
export const endCall       = (id)  => api.put(`/calls/${id}/end`);
export const getCallHistory = ()   => api.get('/calls/history');

// ── Agent ─────────────────────────────────────────────────────────────────────
export const getAgentDashboard    = ()          => api.get('/agent/dashboard');
export const getAgentList         = ()          => api.get('/agent/agents');
export const searchCustomers      = (q)         => api.get('/agent/customers/search', { params: { q } });
export const getAgentTickets      = (params)    => api.get('/agent/tickets', { params });
export const bulkUpdateAgentTickets = (data)    => api.post('/agent/tickets/bulk', data);
export const createAgentTicket    = (data)      => api.post('/agent/tickets/create', data);
export const getAgentTicketDetail = (id)        => api.get(`/agent/tickets/${id}`);
export const updateTicket         = (id, data)  => api.put(`/agent/tickets/${id}`, data);
export const replyToTicket            = (id, data)  => api.post(`/agent/tickets/${id}/reply`, data);
export const requestReassignment      = (id, data)  => api.post(`/agent/tickets/${id}/request-reassignment`, data);
export const mergeTicket              = (id, data)  => api.post(`/agent/tickets/${id}/merge`, data);
export const getRelatedTickets        = (id)        => api.get(`/agent/tickets/${id}/related`);
export const getInternalNotes         = (id)        => api.get(`/agent/tickets/${id}/notes`);
export const addInternalNote          = (id, data)  => api.post(`/agent/tickets/${id}/notes`, data);
export const deleteInternalNote       = (id, noteId) => api.delete(`/agent/tickets/${id}/notes/${noteId}`);
export const addTimeLog               = (id, data)  => api.post(`/agent/tickets/${id}/time-log`, data);
export const getMacros                = ()          => api.get('/agent/macros');
export const createMacro              = (data)      => api.post('/agent/macros', data);
export const deleteMacro              = (id)        => api.delete(`/agent/macros/${id}`);
export const getPendingChats      = ()          => api.get('/agent/chats/pending');
export const getMyAgentChats      = ()          => api.get('/agent/chats/mine');
export const acceptChat           = (id)        => api.put(`/agent/chats/${id}/accept`);
export const getChatMessages      = (id)        => api.get(`/agent/chats/${id}/messages`);
export const getAgentCustomerDetail  = (id)      => api.get(`/agent/customers/${id}`);
export const convertChatToTicket     = (id, data) => api.post(`/agent/chats/${id}/convert-to-ticket`, data);
export const transferAgentChat       = (id, data) => api.post(`/agent/chats/${id}/transfer`, data);
export const sendChatTranscript      = (id)        => api.post(`/agent/chats/${id}/transcript`);
export const getAgentTemplates       = ()          => api.get('/agent/templates');
export const getMyPerformance        = ()          => api.get('/agent/my-performance');
export const getCustomerHistory      = (id)        => api.get(`/agent/customers/${id}/history`);
export const getAgentMyCalls         = ()          => api.get('/agent/calls/mine');
export const saveAgentCallNotes      = (id, notes)  => api.post(`/agent/calls/${id}/notes`, { notes });
export const getChatNotes            = (id)        => api.get(`/agent/chats/${id}/notes`);
export const addChatNote             = (id, data)  => api.post(`/agent/chats/${id}/notes`, data);
export const deleteChatNote          = (id, noteId) => api.delete(`/agent/chats/${id}/notes/${noteId}`);
export const getAgentChatArchive     = (params)    => api.get('/agent/chats/archive', { params });
export const getAgentArchivedMessages = (id)       => api.get(`/agent/chats/archive/${id}/messages`);

// ── Admin ─────────────────────────────────────────────────────────────────────
export const getAdminDashboard    = ()          => api.get('/admin/dashboard');
export const getAdminCustomers    = (params)    => api.get('/admin/customers', { params });
export const getAdminCustomerById = (id)        => api.get(`/admin/customers/${id}`);
export const updateAdminCustomer  = (id, data)  => api.put(`/admin/customers/${id}`, data);
export const updateCustomerTags   = (id, tags)  => api.put(`/admin/customers/${id}/tags`, { tags });
export const getAdminPlans        = ()          => api.get('/admin/plans');
export const updateAdminPlan      = (id, data)  => api.put(`/admin/plans/${id}`, data);
export const getAdminCalls        = (params)    => api.get('/admin/calls', { params });
export const getTicketReport      = (params)    => api.get('/admin/reports/tickets', { params });
export const getRevenueReport     = (params)    => api.get('/admin/reports/revenue', { params });
export const getUsageReport       = (params)    => api.get('/admin/reports/usage', { params });

// Bulk customer import (admin uploads a parsed CSV)
export const bulkImportCustomers = (data) => api.post('/admin/customers/bulk-import', data);

// Bulk action across selected customers (reset-usage / resend-welcome / change-plan / delete)
export const bulkCustomerAction = (data) => api.post('/admin/customers/bulk-action', data);

// Admin — email templates (editable customer-facing email wording)
export const listAdminEmailTemplates   = ()             => api.get('/admin/email-templates');
export const getAdminEmailTemplate     = (key)          => api.get(`/admin/email-templates/${key}`);
export const saveAdminEmailTemplate    = (key, data)    => api.put(`/admin/email-templates/${key}`, data);
export const resetAdminEmailTemplate   = (key)          => api.delete(`/admin/email-templates/${key}`);
export const previewAdminEmailTemplate = (key, data)    => api.post(`/admin/email-templates/${key}/preview`, data);

// Admin — agents
export const getAdminAgents         = ()         => api.get('/admin/agents');
export const createAdminAgent       = (data)     => api.post('/admin/agents', data);
export const toggleAdminAgent       = (id)       => api.put(`/admin/agents/${id}/toggle`);
export const deleteAdminAgent       = (id)       => api.delete(`/admin/agents/${id}`);
export const deleteAdminCustomer    = (id)       => api.delete(`/admin/customers/${id}`);
export const changeAgentPassword    = (id, data) => api.put(`/admin/agents/${id}/password`, data);
export const updateAgentSkills      = (id, data) => api.put(`/admin/agents/${id}/skills`, data);
export const changeAgentRole        = (id, role) => api.patch(`/admin/agents/${id}/role`, { role });
export const changeCustomerPassword = (id, data) => api.put(`/admin/customers/${id}/password`, data);
export const resetCustomerUsage     = (id)       => api.post(`/admin/customers/${id}/reset-usage`);

// Admin — tickets
export const getAdminTickets       = (params)   => api.get('/admin/tickets', { params });
export const getAdminTicketDetail  = (id)       => api.get(`/admin/tickets/${id}`);
export const updateAdminTicket     = (id, data) => api.put(`/admin/tickets/${id}`, data);

// Admin — chats
export const getAdminChats         = (params)    => api.get('/admin/chats', { params });
export const assignAdminChat       = (id, data)  => api.put(`/admin/chats/${id}/assign`, data);
export const getAdminChatAnalytics = (params)    => api.get('/admin/chats/analytics', { params });
export const getAdminChatArchive   = (params)    => api.get('/admin/chats/archive', { params });
export const getArchivedMessages   = (id)        => api.get(`/admin/chats/${id}/messages`);
export const getAgentChatStatuses  = ()          => api.get('/admin/chats/agent-statuses');
export const getBlacklist          = ()          => api.get('/admin/chats/blacklist');
export const blockCustomer         = (data)      => api.post('/admin/chats/blacklist', data);
export const unblockCustomer       = (id)        => api.delete(`/admin/chats/blacklist/${id}`);
export const getCallBlacklist      = ()          => api.get('/admin/calls/blacklist');
export const blockCustomerCalls    = (data)      => api.post('/admin/calls/blacklist', data);
export const unblockCustomerCalls  = (id)        => api.delete(`/admin/calls/blacklist/${id}`);
export const redirectRingingCall   = (callId, agentId) => api.post(`/admin/calls/${callId}/redirect`, { agent_id: agentId });

// Admin — system health / audit
export const getUsageDrift      = ()        => api.get('/admin/audit/usage-drift');
export const getShortCutWatchlist = ()      => api.get('/admin/audit/short-cut-watchlist');
export const getInboundEmailLog   = (params) => api.get('/admin/inbound-email', { params });
export const attachInboundEmail   = (id, ticketId) => api.post(`/admin/inbound-email/${id}/attach`, { ticket_id: ticketId });
export const resetCustomerUsageAudit = (customerId) => api.post(`/admin/audit/reset-usage/${customerId}`);
export const runRoutingLimitsTests   = ()       => api.post('/admin/audit/run-tests', {}, { timeout: 90000 });

// Admin — bulk ops + export
export const bulkUpdateTickets  = (data)    => api.post('/admin/tickets/bulk', data);
export const exportReportCsv    = (params)  => api.get('/admin/reports/export', { params, responseType: 'blob' });
export const getReportTickets   = (params)  => api.get('/admin/reports/drill/tickets', { params });
export const getReportInvoices  = (params)  => api.get('/admin/reports/drill/invoices', { params });
export const getReportCalls     = (params)  => api.get('/admin/reports/drill/calls', { params });
export const getReportChats     = (params)  => api.get('/admin/reports/drill/chats', { params });
export const getReportCustomers = (params)  => api.get('/admin/reports/drill/customers', { params });
export const getReportAgents    = (params)  => api.get('/admin/reports/drill/agents', { params });
// Custom Reports — admin-built saved queries shown on the Custom Reports tab.
export const listCustomReports    = ()             => api.get('/admin/custom-reports');
export const createCustomReport   = (data)         => api.post('/admin/custom-reports', data);
export const updateCustomReport   = (id, data)     => api.put(`/admin/custom-reports/${id}`, data);
export const deleteCustomReport   = (id)           => api.delete(`/admin/custom-reports/${id}`);
export const getCustomReportCount = (id, params)   => api.get(`/admin/custom-reports/${id}/count`, { params });
export const getAgentPerformance    = (params) => api.get('/admin/performance', { params });
export const getAgentReviews        = (id, params) => api.get(`/admin/performance/agent/${id}/ratings`, { params });
export const getAdminTemplates      = ()       => api.get('/admin/templates');
export const createAdminTemplate    = (data)   => api.post('/admin/templates', data);
export const updateAdminTemplate    = (id, d)  => api.put(`/admin/templates/${id}`, d);
export const deleteAdminTemplate    = (id)     => api.delete(`/admin/templates/${id}`);

// Chat canned responses — admin CRUD + agent read/use
export const getAdminCannedResponses   = ()      => api.get('/admin/canned-responses');
export const createAdminCannedResponse = (data)  => api.post('/admin/canned-responses', data);
export const updateAdminCannedResponse = (id, d) => api.put(`/admin/canned-responses/${id}`, d);
export const deleteAdminCannedResponse = (id)    => api.delete(`/admin/canned-responses/${id}`);
export const getAgentCannedResponses   = ()      => api.get('/agent/canned-responses');
export const bumpCannedResponseUsage   = (id)    => api.post(`/agent/canned-responses/${id}/used`);
export const getAdminSettings     = ()       => api.get('/admin/settings');
export const updateAdminSettings  = (data)   => api.put('/admin/settings', data);
export const sendTestEmail        = (to, templateKey) => api.post('/admin/settings/test-email', { to, templateKey });
export const getPublicSettings    = ()       => api.get('/public-settings');
export const logUpgradeFailure    = (data)   => api.post('/customer/upgrade/log-failure', data);
export const getPaymentFailures   = ()       => api.get('/admin/payment-failures');
export const renewCustomerPlan    = (id, data) => api.post(`/admin/customers/${id}/renew-plan`, data);
export const recordPaymentProof   = (id, data) => api.post(`/admin/customers/${id}/record-payment-proof`, data);

// ── Web Push (PWA Phase 4) ──────────────────────────────────────────────────
export const getVapidPublicKey    = ()      => api.get('/push/vapid-public-key');
export const subscribePush        = (subscription) => api.post('/push/subscribe', { subscription });
export const unsubscribePush      = (endpoint)      => api.post('/push/unsubscribe', { endpoint });
export const getSidebarBadges     = ()       => api.get('/admin/sidebar-badges');
export const getHealthWorkers     = ()       => api.get('/admin/health/workers');
export const getHealthSlaForecast = (hours = 4) => api.get('/admin/health/sla-forecast', { params: { hours } });

// ── Billing Sync ──────────────────────────────────────────────────────────────
export const triggerBillingSync      = ()         => api.post('/admin/sync/pull');
export const testBillingConnection   = (data)     => api.post('/admin/billing/test', data);
export const lookupBillingCustomer   = (data)     => api.post('/admin/customers/lookup-billing', data);
export const bulkImportBillingCustomers = (data)  => api.post('/admin/customers/bulk-import-billing', data);
export const startCustomerOnboarding = (id, data) => api.post(`/admin/customers/${id}/start-onboarding`, data || {});
export const importBillingCustomer   = (data)     => api.post('/admin/customers/import', data);
export const createManualCustomer    = (data)     => api.post('/admin/customers/manual', data);
export const getCustomerOverrides    = (id)       => api.get(`/admin/customers/${id}/overrides`);
export const updateCustomerOverrides = (id, data) => api.put(`/admin/customers/${id}/overrides`, data);
export const getCustomerPlanHistory  = (id)       => api.get(`/admin/customers/${id}/plan-history`);
export const getPlanChangeReport     = (from, to) => api.get('/admin/reports/plan-changes', { params: { from, to } });
export const getBillingSyncs         = (filter)   => api.get('/admin/billing-syncs', { params: { filter } });
export const getBillingSyncsStats    = ()         => api.get('/admin/billing-syncs/stats');
export const retryBillingSync        = (id)       => api.post(`/admin/billing-syncs/${id}/retry`);
export const dismissBillingSync      = (id, note) => api.post(`/admin/billing-syncs/${id}/dismiss`, { note });
export const clearCustomerOverrides  = (id)       => api.delete(`/admin/customers/${id}/overrides`);

// ── Attachments ───────────────────────────────────────────────────────────────
export const uploadAttachment   = (formData) => api.post('/attachments', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
export const getAttachments     = (refType, refId) => api.get('/attachments', { params: { ref_type: refType, ref_id: refId } });
export const deleteAttachment   = (id)      => api.delete(`/attachments/${id}`);
export const getAttachmentDownloadUrl = (id) => {
  const token = localStorage.getItem('dsp_token');
  return `/api/attachments/${id}/download${token ? `?token=${encodeURIComponent(token)}` : ''}`;
};

// ── CSAT ──────────────────────────────────────────────────────────────────────
export const submitRating       = (data)    => api.post('/csat', data);
export const getRating          = (params)  => api.get('/csat', { params });
export const markGmbClicked     = (id)      => api.post(`/csat/${id}/gmb-click`);
export const getCsatStats       = ()        => api.get('/csat/stats');
export const getCsatSettings    = ()        => api.get('/csat/settings');
export const updateCsatSettings = (data)   => api.put('/csat/settings', data);

// ── Canned Responses ──────────────────────────────────────────────────────────
export const getCannedResponses  = ()        => api.get('/canned');
export const createCannedResponse = (data)  => api.post('/canned', data);
export const updateCannedResponse = (id, d) => api.put(`/canned/${id}`, d);
export const deleteCannedResponse = (id)    => api.delete(`/canned/${id}`);

// ── Audit Log ─────────────────────────────────────────────────────────────────
export const getAuditLogs    = (params) => api.get('/audit', { params });
export const getAuditActors  = ()       => api.get('/audit/actors');
export const getAuditSummary = ()       => api.get('/audit/summary');
export const exportAuditCsv  = (params) => api.get('/audit/export.csv', { params, responseType: 'blob' });

// ── Customer Notes ────────────────────────────────────────────────────────────
export const getNotes    = (customerId) => api.get(`/notes/${customerId}`);
export const addNote     = (customerId, data) => api.post(`/notes/${customerId}`, data);
export const deleteNote  = (id)         => api.delete(`/notes/${id}`);

// ── OTP / 2FA ─────────────────────────────────────────────────────────────────
export const requestOtp  = (data) => api.post('/otp/request', data);
export const verifyOtp   = (data) => api.post('/otp/verify', data);

// ── AI Knowledge Base ─────────────────────────────────────────────────────────
export const aiKbSearch  = (data) => api.post('/tickets/ai-kb-search', data);


// ── Feedback / bug reports ───────────────────────────────────────────────────
export const submitFeedback = (formData) =>
  api.post("/feedback", formData, { headers: { "Content-Type": "multipart/form-data" } });
export const listMyFeedback   = ()      => api.get("/feedback/mine");
export const adminListFeedback     = (params = {}) => api.get('/admin/feedback', { params });
export const adminUpdateFeedback   = (id, data)    => api.put(`/admin/feedback/${id}`, data);
export const adminListFeedbackReporters = ()       => api.get('/admin/feedback/reporters');
export const adminBulkUpdateFeedback    = (ids, status) => api.post('/admin/feedback/bulk', { ids, status });
