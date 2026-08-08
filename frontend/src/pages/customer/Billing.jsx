import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { PlanBadge } from '../../components/common/PlanBadge';
import {
  getCustomerPlans, initiateUpgrade, verifyUpgrade, logUpgradeFailure,
  getCustomerSubscriptions, getCustomerInvoices, getCustomerQuotes,
  downloadInvoicePdf, downloadQuotePdf,
  initiateQuotePayment, verifyQuotePayment,
} from '../../services/api';
import {
  Check, X, Zap, MessageSquare, Phone, Clock, CreditCard,
  RefreshCw, AlertTriangle, Package, FileText, Receipt, CalendarClock,
  Download, Loader, AlertCircle, Eye, IndianRupee,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

const PLAN_TIER = { free: 0, basic: 1, moderate: 2, premium: 3 };

const RESPONSE_LABEL = {
  free:     '24–48 hrs response',
  basic:    'Within 24 hrs',
  moderate: '8–10 hrs response',
  premium:  'Within 2 hrs',
};

const PLAN_COLOR = {
  free:     { header: 'bg-gray-100 text-gray-600',    btn: '', border: 'border-gray-200' },
  basic:    { header: 'bg-blue-50 text-blue-700',     btn: 'bg-blue-600 hover:bg-blue-700', border: 'border-blue-200' },
  moderate: { header: 'bg-blue-50 text-blue-700', btn: 'bg-blue-600 hover:bg-blue-700', border: 'border-blue-300' },
  premium:  { header: 'bg-purple-50 text-purple-700', btn: 'bg-purple-600 hover:bg-purple-700', border: 'border-purple-300' },
};

function formatPrice(plan) {
  if (plan.name === 'free') return 'Free';
  return `₹${Math.round(plan.price).toLocaleString('en-IN')}/yr`;
}

function FeatureRow({ icon: Icon, iconClass, children }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-gray-700">
      <Icon className={`w-4 h-4 flex-shrink-0 ${iconClass}`} />
      <span>{children}</span>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label, comingSoon = false }) {
  // When comingSoon is true the tab is visually faded, intercepts clicks to
  // show a toast, and has a hover title — the underlying onClick is never
  // called, so navigating to ?tab=... directly is also a no-op for these tabs.
  const handleClick = comingSoon
    ? () => toast('Coming soon — billing integrations are in progress', { icon: '🛠️' })
    : onClick;
  return (
    <button
      onClick={handleClick}
      title={comingSoon ? 'Coming soon — billing integrations are in progress' : undefined}
      aria-disabled={comingSoon}
      className={clsx(
        'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors',
        comingSoon
          ? 'opacity-50 text-gray-500 cursor-not-allowed hover:text-gray-500'
          : active
            ? 'bg-white text-blue-600 shadow-sm'
            : 'text-gray-500 hover:text-gray-700'
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
      {comingSoon && <span className="text-[9px] uppercase tracking-wider font-bold bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded ml-0.5">Soon</span>}
    </button>
  );
}

function TabSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <div className="w-7 h-7 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function TabError() {
  return (
    <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
      <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      Unable to load data. Please contact your account manager.
    </div>
  );
}

function EmptyState({ icon: Icon, message }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-2">
      <Icon className="w-10 h-10 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtAmount(val) {
  if (val == null) return '—';
  return `₹${Number(val).toLocaleString('en-IN')}`;
}

function renewalColor(dateStr) {
  if (!dateStr) return 'text-gray-700';
  const diff = (new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24);
  if (diff < 0)  return 'text-red-600 font-semibold';
  if (diff < 30) return 'text-amber-600 font-semibold';
  return 'text-gray-700';
}

const STATUS_BADGE = {
  active:    'bg-green-100 text-green-700',
  inactive:  'bg-gray-100 text-gray-500',
  cancelled: 'bg-red-100 text-red-600',
  paid:      'bg-green-100 text-green-700',
  payment:   'bg-green-100 text-green-700',
  pending:   'bg-amber-100 text-amber-700',
  sent:      'bg-blue-100 text-blue-700',
  expired:   'bg-red-100 text-red-600',
  overdue:   'bg-red-100 text-red-600',
};

function StatusBadge({ status }) {
  const s = (status || 'pending').toLowerCase();
  return (
    <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded-full capitalize', STATUS_BADGE[s] || 'bg-gray-100 text-gray-500')}>
      {s}
    </span>
  );
}

// ── Subscriptions Tab ─────────────────────────────────────────────────────────
function SubscriptionsTab() {
  const [subs, setSubs] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    getCustomerSubscriptions()
      .then(r => setSubs(r.data.subscriptions || []))
      .catch(() => setError(true));
  }, []);

  if (!subs && !error) return <TabSpinner />;
  if (error) return <TabError />;
  if (subs.length === 0) return <EmptyState icon={Package} message="No active subscriptions found" />;

  return (
    <div className="card overflow-hidden">
      <div className="divide-y divide-gray-100">
        {subs.map((s, i) => {
          const renewalField = s.renewal_date || s.commitment_end || s.next_billing_date || s.expiry_date || s.end_date;
          return (
            <div key={s.id ?? i} className="flex items-center justify-between px-5 py-4 gap-4 flex-wrap">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Package className="w-4 h-4 text-blue-500" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-gray-800 text-sm truncate">{s.name || s.sku_name || s.product_name || 'Service'}</p>
                  {(s.seats ?? s.quantity) != null && (
                    <p className="text-xs text-gray-400">{s.seats ?? s.quantity} seat{(s.seats ?? s.quantity) !== 1 ? 's' : ''}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-6 text-xs text-gray-500 flex-wrap">
                {(s.start_date || s.commitment_start || s.created_at) && (
                  <div>
                    <p className="text-gray-400">Start</p>
                    <p className="text-gray-600">{fmtDate(s.start_date || s.commitment_start || s.created_at)}</p>
                  </div>
                )}
                {renewalField && (
                  <div>
                    <p className="text-gray-400">Renewal</p>
                    <p className={renewalColor(renewalField)}>{fmtDate(renewalField)}</p>
                  </div>
                )}
                <StatusBadge status={s.status} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Invoice PDF Viewer Modal ──────────────────────────────────────────────────
function InvoicePdfModal({ inv, onClose }) {
  const [pdfUrl, setPdfUrl]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);

  useEffect(() => {
    let objectUrl = null;
    downloadInvoicePdf(inv.id)
      .then(res => {
        const blob = new Blob([res.data], { type: 'application/pdf' });
        objectUrl  = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [inv.id]);

  const handleDownload = () => {
    if (!pdfUrl) return;
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = `invoice-${inv.invoice_number || inv.doc_number || inv.number || inv.id}.pdf`;
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      {/* Top bar. paddingTop uses calc so it equals py-3 (0.75rem) on desktop
          where the safe-area inset is 0, and only grows under a phone notch. */}
      <div
        className="flex items-center justify-between gap-2 px-5 py-3 bg-white border-b border-gray-200 flex-shrink-0 flex-wrap"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Receipt className="w-4 h-4 text-green-600 flex-shrink-0" />
          <span className="font-semibold text-gray-800 text-sm truncate">
            {inv.invoice_number || inv.doc_number || inv.number || `INV-${inv.id}`}
          </span>
          <span className="text-gray-400 text-xs ml-1">{fmtDate(inv.invoice_date || inv.due_date || inv.date || inv.created_at)}</span>
          <span className="ml-1"><StatusBadge status={inv.status || 'paid'} /></span>
        </div>
        <div className="flex items-center gap-2">
          {pdfUrl && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 bg-gray-100 px-3 py-1.5 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <X className="w-3.5 h-3.5" /> Close
          </button>
        </div>
      </div>
      {/* PDF area */}
      <div className="flex-1 overflow-hidden bg-gray-700 flex items-center justify-center">
        {loading && (
          <div className="flex flex-col items-center gap-3 text-white">
            <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin" />
            <p className="text-sm">Loading invoice…</p>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center gap-3 text-white text-center px-6">
            <AlertCircle className="w-10 h-10 text-amber-400" />
            <p className="font-semibold">PDF not available yet</p>
            <p className="text-sm text-gray-300">Please try again later or contact your account manager.</p>
            <button onClick={onClose} className="mt-2 bg-white text-gray-800 px-4 py-2 rounded-lg text-sm font-medium">Close</button>
          </div>
        )}
        {pdfUrl && (
          <iframe
            src={pdfUrl}
            className="w-full h-full border-0"
            title={`Invoice ${inv.invoice_number || inv.id}`}
          />
        )}
      </div>
    </div>
  );
}

// ── Quote PDF Viewer Modal ────────────────────────────────────────────────────
function QuotePdfModal({ quote, onClose, onPay, paying }) {
  const [pdfUrl, setPdfUrl]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const isPending = ['pending', 'sent', 'draft'].includes((quote.status || 'pending').toLowerCase());

  useEffect(() => {
    let objectUrl = null;
    downloadQuotePdf(quote.id)
      .then(res => {
        const blob = new Blob([res.data], { type: 'application/pdf' });
        objectUrl  = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [quote.id]);

  const handleDownload = () => {
    if (!pdfUrl) return;
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = `quotation-${quote.quote_number || quote.doc_number || quote.number || quote.id}.pdf`;
    a.click();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      {/* Top bar. paddingTop calc keeps desktop at py-3 and adds notch inset. */}
      <div
        className="flex items-center justify-between gap-2 px-5 py-3 bg-white border-b border-gray-200 flex-shrink-0 flex-wrap"
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-amber-600 flex-shrink-0" />
          <span className="font-semibold text-gray-800 text-sm truncate">
            {quote.quote_number || quote.doc_number || quote.number || `QT-${quote.id}`}
          </span>
          <span className="text-gray-400 text-xs ml-1">{fmtDate(quote.quote_date || quote.valid_until || quote.date || quote.created_at)}</span>
          <span className="ml-1"><StatusBadge status={quote.status || 'pending'} /></span>
        </div>
        <div className="flex items-center gap-2">
          {pdfUrl && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 bg-gray-100 px-3 py-1.5 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </button>
          )}
          {isPending && (
            <button
              onClick={() => { onClose(); onPay(quote); }}
              disabled={!!paying}
              className="flex items-center gap-1.5 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
            >
              {paying ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <IndianRupee className="w-3.5 h-3.5" />}
              {paying ? 'Processing…' : 'Pay Now'}
            </button>
          )}
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 bg-gray-100 px-3 py-1.5 rounded-lg hover:bg-gray-200 transition-colors"
          >
            <X className="w-3.5 h-3.5" /> Close
          </button>
        </div>
      </div>
      {/* PDF area */}
      <div className="flex-1 overflow-hidden bg-gray-700 flex items-center justify-center">
        {loading && (
          <div className="flex flex-col items-center gap-3 text-white">
            <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin" />
            <p className="text-sm">Loading quotation…</p>
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center gap-3 text-white text-center px-6">
            <AlertCircle className="w-10 h-10 text-amber-400" />
            <p className="font-semibold">PDF not available yet</p>
            <p className="text-sm text-gray-300">Please try again later or contact your account manager.</p>
            {isPending && (
              <button
                onClick={() => { onClose(); onPay(quote); }}
                disabled={!!paying}
                className="mt-2 bg-green-600 hover:bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-semibold flex items-center gap-2"
              >
                <IndianRupee className="w-4 h-4" /> Pay Now
              </button>
            )}
            <button onClick={onClose} className="mt-1 bg-white text-gray-800 px-4 py-2 rounded-lg text-sm font-medium">Close</button>
          </div>
        )}
        {pdfUrl && (
          <iframe
            src={pdfUrl}
            className="w-full h-full border-0"
            title={`Quotation ${quote.quote_number || quote.id}`}
          />
        )}
      </div>
    </div>
  );
}

// ── Paid Invoices Tab ─────────────────────────────────────────────────────────
function InvoicesTab() {
  const [invoices, setInvoices] = useState(null);
  const [error, setError]       = useState(false);
  const [viewInv, setViewInv]   = useState(null);

  useEffect(() => {
    getCustomerInvoices()
      .then(r => setInvoices(r.data.invoices || []))
      .catch(() => setError(true));
  }, []);

  if (!invoices && !error) return <TabSpinner />;
  if (error) return <TabError />;
  if (invoices.length === 0) return <EmptyState icon={Receipt} message="No paid invoices yet" />;

  return (
    <>
      {viewInv && <InvoicePdfModal inv={viewInv} onClose={() => setViewInv(null)} />}
      <div className="card overflow-hidden">
        <div className="divide-y divide-gray-100">
          {invoices.map((inv, i) => (
            <div key={inv.id ?? i} className="flex items-center justify-between px-5 py-4 gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Receipt className="w-4 h-4 text-green-600" />
                </div>
                <div>
                  <p className="font-semibold text-gray-800 text-sm">
                    {inv.invoice_number || inv.doc_number || inv.number || `INV-${inv.id}`}
                  </p>
                  <p className="text-xs text-gray-400">{fmtDate(inv.invoice_date || inv.due_date || inv.date || inv.created_at)}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-sm flex-wrap">
                <p className="font-semibold text-gray-800">{fmtAmount(inv.total || inv.final_price || inv.amount)}</p>
                <StatusBadge status={inv.status || 'paid'} />
                <button
                  onClick={() => setViewInv(inv)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 bg-blue-50 border border-blue-200 px-3 py-1.5 rounded-lg transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" /> View / Download
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Pending Payments Tab ──────────────────────────────────────────────────────
function QuotesTab({ onPay, paying }) {
  const [quotes, setQuotes] = useState(null);
  const [error, setError]   = useState(false);
  const [viewQuote, setViewQuote] = useState(null);

  useEffect(() => {
    getCustomerQuotes()
      .then(r => setQuotes(r.data.quotes || []))
      .catch(() => setError(true));
  }, []);

  if (!quotes && !error) return <TabSpinner />;
  if (error) return <TabError />;
  if (quotes.length === 0) return <EmptyState icon={FileText} message="No pending payments" />;

  return (
    <>
      {viewQuote && (
        <QuotePdfModal
          quote={viewQuote}
          onClose={() => setViewQuote(null)}
          onPay={(q) => { setViewQuote(null); onPay(q); }}
          paying={paying}
        />
      )}
      <div className="card overflow-hidden">
        <div className="divide-y divide-gray-100">
          {quotes.map((q, i) => {
            const isPending = ['pending', 'sent', 'draft'].includes((q.status || 'pending').toLowerCase());
            return (
              <div key={q.id ?? i} className="flex items-center justify-between px-5 py-4 gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 bg-amber-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FileText className="w-4 h-4 text-amber-600" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-800 text-sm">
                      {q.quote_number || q.doc_number || q.number || `QT-${q.id}`}
                    </p>
                    <p className="text-xs text-gray-400">{fmtDate(q.quote_date || q.valid_until || q.date || q.created_at)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm flex-wrap">
                  <div className="text-right">
                    <p className="font-semibold text-gray-800">{fmtAmount(q.total || q.amount)}</p>
                  </div>
                  <StatusBadge status={q.status || 'pending'} />
                  <button
                    onClick={() => setViewQuote(q)}
                    className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 hover:text-amber-800 bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <Eye className="w-3.5 h-3.5" /> View / Download
                  </button>
                  {isPending && (
                    <button
                      onClick={() => onPay(q)}
                      disabled={!!paying}
                      className="flex items-center gap-1.5 text-xs font-semibold text-white bg-green-600 hover:bg-green-700 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {paying === q.id ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <IndianRupee className="w-3.5 h-3.5" />}
                      {paying === q.id ? 'Processing…' : 'Pay Now'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
const BILLING_TAB_KEY = 'dsp_billing_tab';

export default function CustomerBilling() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [paying, setPaying]           = useState(null);
  const [payingQuote, setPayingQuote] = useState(null);
  // Tracks a failed payment so we can show a "Try again" dialog without
  // forcing the customer to click the plan card again from scratch.
  // Shape: { plan, orderId, errorCode, errorDescription, rzp }
  const [failedPayment, setFailedPayment] = useState(null);
  const navigate  = useNavigate();
  const location  = useLocation();
  // Persist active tab: location.state (deep-link) > localStorage > default 'plan'
  const [tab, setTab] = useState(
    location.state?.tab || localStorage.getItem(BILLING_TAB_KEY) || 'plan'
  );

  // Sync tab selection to localStorage so it survives refresh
  const handleSetTab = (t) => { setTab(t); localStorage.setItem(BILLING_TAB_KEY, t); };

  const loadPlans = () =>
    getCustomerPlans()
      .then(r => setData(r.data))
      .catch(() => toast.error('Failed to load billing info'))
      .finally(() => setLoading(false));

  useGlobalRefresh(() => { setLoading(true); loadPlans(); });

  useEffect(() => {
    if (!document.getElementById('rzp-script')) {
      const s = document.createElement('script');
      s.id  = 'rzp-script';
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      document.body.appendChild(s);
    }
    loadPlans();
  }, []);

  // Auto-refresh when admin edits the customer's plan or overrides. The
  // window events are dispatched by NotificationBell (which is in Layout, so
  // always mounted) when the corresponding socket event arrives — keeps the
  // Billing page in sync without adding a duplicate socket listener here.
  useEffect(() => {
    const refresh = () => loadPlans();
    window.addEventListener('plan:changed', refresh);
    window.addEventListener('overrides:changed', refresh);
    return () => {
      window.removeEventListener('plan:changed', refresh);
      window.removeEventListener('overrides:changed', refresh);
    };
  }, []);

  // When the admin's billing_extras_enabled flag is OFF, a deep-link or stored
  // localStorage value of 'subscriptions' / 'invoices' / 'quotes' would land
  // the customer on a faded-stub tab body. Force them back to 'plan' as soon
  // as we know the flag.
  useEffect(() => {
    if (!data) return;
    if (data.billing_extras_enabled) return;
    if (['subscriptions', 'invoices', 'quotes'].includes(tab)) handleSetTab('plan');
  }, [data]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Opens the Razorpay popup for either a fresh order (when order=null) or an
  // existing order (used by Try-Again to skip /upgrade/initiate). Centralises
  // the success handler + the payment.failed listener so retry behaviour is
  // identical to the first attempt.
  const openRazorpay = (targetPlan, order) => {
    if (!window.Razorpay) {
      toast.error('Payment system not loaded. Please refresh and try again.');
      setPaying(null);
      return null;
    }
    const rzp = new window.Razorpay({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency,
      order_id: order.order_id,
      name: 'Anu Tech Digital Pvt Ltd',
      description: `Upgrade to ${order.plan.charAt(0).toUpperCase() + order.plan.slice(1)} plan`,
      handler: async (response) => {
        try {
          const vRes = await verifyUpgrade({
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id:   response.razorpay_order_id,
            razorpay_signature:  response.razorpay_signature,
            plan:   targetPlan,
            amount: order.amount / 100,
          });
          toast.success(vRes.data.message || 'Payment verified! Your plan has been upgraded.');
          setFailedPayment(null);
          handleSetTab('plan');
          setLoading(true);
          loadPlans();
        } catch (err) {
          toast.error(err.response?.data?.error || 'Payment verification failed. Contact support.');
        } finally {
          setPaying(null);
        }
      },
      modal: {
        ondismiss: () => {
          setPaying(null);
          // Log the cancel so admin can see drop-off rate
          logUpgradeFailure({
            order_id: order.order_id,
            cancelled: true,
            error_code: 'USER_CANCELLED',
            error_description: 'Customer closed the payment popup without paying.',
          }).catch(() => {});
        },
      },
      theme: { color: '#4F46E5' },
    });
    // Razorpay fires this when bank/UPI/card declines — gives the real reason.
    rzp.on('payment.failed', (resp) => {
      const errCode = resp?.error?.code || 'PAYMENT_FAILED';
      const errDesc = resp?.error?.description || resp?.error?.reason || 'Payment did not go through.';
      logUpgradeFailure({
        order_id: order.order_id,
        error_code: errCode,
        error_description: errDesc,
      }).catch(() => {});
      setPaying(null);
      setFailedPayment({
        plan: targetPlan,
        order,            // keep the order so Try Again can reuse it
        errorCode: errCode,
        errorDescription: errDesc,
      });
    });
    return rzp;
  };

  const handleUpgrade = async (targetPlan) => {
    if (paying) return;
    setPaying(targetPlan);
    setFailedPayment(null);
    try {
      const res = await initiateUpgrade({ plan: targetPlan });
      const order = res.data;
      const rzp = openRazorpay(targetPlan, order);
      if (rzp) rzp.open();
    } catch (err) {
      // Soft-lock 429 surfaces a specific message; everything else stays generic
      toast.error(err.response?.data?.error || 'Failed to initiate payment');
      setPaying(null);
    }
  };

  // Re-opens the same Razorpay order with a fresh popup — no need to hit
  // /upgrade/initiate again so we don't bloat the payment_attempts table or
  // create orphan orders in Razorpay.
  const handleRetryPayment = () => {
    if (!failedPayment) return;
    const { plan, order } = failedPayment;
    setPaying(plan);
    setFailedPayment(null);
    const rzp = openRazorpay(plan, order);
    if (rzp) rzp.open();
  };

  const handleQuotePay = async (quote) => {
    if (payingQuote) return;
    setPayingQuote(quote.id);
    const amount = quote.total || quote.amount;
    try {
      const res   = await initiateQuotePayment(quote.id, { amount, quote_number: quote.quote_number || quote.number });
      const order = res.data;

      if (!window.Razorpay) {
        toast.error('Payment system not loaded. Please refresh and try again.');
        setPayingQuote(null);
        return;
      }

      const rzp = new window.Razorpay({
        key:      order.key_id,
        amount:   order.amount,
        currency: order.currency,
        order_id: order.order_id,
        name:     'Anu Tech Digital Pvt Ltd',
        description: `Payment for ${quote.quote_number || quote.number || `QT-${quote.id}`}`,
        handler: async (response) => {
          try {
            await verifyQuotePayment(quote.id, {
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_signature:  response.razorpay_signature,
            });
            toast.success('Payment successful! Your invoice will appear in Paid Invoices shortly.');
            handleSetTab('invoices');
          } catch (err) {
            toast.error(err.response?.data?.error || 'Payment verification failed. Contact support.');
          } finally {
            setPayingQuote(null);
          }
        },
        modal: { ondismiss: () => { setPayingQuote(null); toast('Payment cancelled', { icon: '✕' }); } },
        theme: { color: '#16a34a' },
      });
      rzp.open();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to initiate payment');
      setPayingQuote(null);
    }
  };

  if (loading) return (
    <Layout>
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    </Layout>
  );

  if (!data) return (
    <Layout>
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400">
        <p className="text-sm font-medium text-gray-600">Failed to load billing info</p>
        <button onClick={() => window.location.reload()} className="text-xs text-blue-600 hover:text-blue-800 font-semibold underline">Retry</button>
      </div>
    </Layout>
  );

  const currentTier = PLAN_TIER[data.current_plan_name] ?? 0;
  const expiryStr   = data.expiry
    ? new Date(data.expiry).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <Layout>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Billing & Subscription</h1>
          <p className="text-sm text-gray-500 mt-0.5">Manage your support plan and view billing details</p>
        </div>
        {tab === 'plan' && (
          <button
            onClick={() => { setLoading(true); getCustomerPlans().then(r => setData(r.data)).catch(() => toast.error('Failed to refresh')).finally(() => setLoading(false)); }}
            className="hidden lg:inline-flex btn-secondary p-2"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Tabs. The extra three (Subscriptions / Paid Invoices / Pending Payments)
          are gated by the admin's billing_extras_enabled flag — when off they
          render as faded "Coming soon" stubs. */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-xl w-fit flex-wrap">
        <TabButton active={tab === 'plan'}          onClick={() => handleSetTab('plan')}          icon={CreditCard}    label="Support Plan" />
        <TabButton active={tab === 'subscriptions'} onClick={() => handleSetTab('subscriptions')} icon={Package}       label="Subscriptions"    comingSoon={!data?.billing_extras_enabled} />
        <TabButton active={tab === 'invoices'}      onClick={() => handleSetTab('invoices')}      icon={Receipt}       label="Paid Invoices"     comingSoon={!data?.billing_extras_enabled} />
        <TabButton active={tab === 'quotes'}        onClick={() => handleSetTab('quotes')}        icon={FileText}      label="Pending Payments"  comingSoon={!data?.billing_extras_enabled} />
      </div>

      {/* ── Support Plan Tab ── */}
      {tab === 'plan' && (
        <>
          <div className="card p-5 mb-6 max-w-lg">
            <div className="flex items-center gap-2 mb-3">
              <CreditCard className="w-4 h-4 text-gray-400" />
              <h2 className="text-sm font-bold text-gray-700">Current Plan</h2>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <PlanBadge plan={data.current_plan_name} />
              {expiryStr && (
                <span className="text-sm text-gray-500">Expires <strong className={data.is_active ? 'text-gray-800' : 'text-red-600'}>{expiryStr}</strong></span>
              )}
              <span className={clsx(
                'text-xs font-semibold px-2 py-0.5 rounded-full',
                data.is_active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              )}>
                {data.is_active ? 'Active' : 'Expired'}
              </span>
            </div>
            {!data.is_active && (
              <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>Your plan has expired. Upgrade below to restore access to chat, calls, and more.</span>
              </div>
            )}
            {/* Admin disabled (retired) the customer's plan. Their entitlements
                still apply — but the plan no longer appears in Available Plans,
                so without this banner they'd be confused about their status. */}
            {data.current_plan_retired && (
              <div className="mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Your current plan has been retired</p>
                  <p className="text-xs mt-0.5">You can keep using your current chat, call, and ticket limits, but the {data.current_plan_name} plan is no longer being offered. Please contact your account manager or pick one of the available plans below when you're ready to switch.</p>
                </div>
              </div>
            )}
          </div>

          <h2 className="text-sm font-bold text-gray-700 mb-3">Available Plans</h2>
          {/* Phase 4 — renewal window banner. Visible when the customer is
              within the last N days of their current plan; opens up renewal
              + downgrade options on every plan card below. */}
          {data.is_renewal_window && (
            <div className="mb-4 p-4 rounded-xl border-2 border-amber-200 bg-amber-50">
              <div className="flex items-start gap-3">
                <CalendarClock className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-bold text-amber-900">
                    Your <span className="capitalize">{data.current_plan_name}</span> plan expires in {data.days_until_expiry} day{data.days_until_expiry === 1 ? '' : 's'}.
                  </p>
                  <p className="text-xs text-amber-800 mt-1">
                    You can now <strong>renew</strong> at the same plan, <strong>downgrade</strong> to a cheaper plan, or <strong>upgrade</strong> to a higher one.
                    If you don't act before expiry, your plan will automatically lapse to <strong>Free</strong>.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {(data.plans || []).map(plan => {
              const tier       = PLAN_TIER[plan.name] ?? 0;
              const meta       = PLAN_COLOR[plan.name] || PLAN_COLOR.free;
              const isCurrent  = plan.id === data.current_plan_id;
              const canUpgrade = tier > currentTier;
              const isLower    = tier < currentTier;
              // Inside the renewal window every paid plan is buyable —
              // upgrade, same-plan renew, or downgrade all flow through the
              // same Razorpay path.
              const canRenewSamePlan = data.is_renewal_window && isCurrent && plan.name !== 'free';
              const canDowngrade     = data.is_renewal_window && isLower && plan.name !== 'free';

              return (
                <div
                  key={plan.id}
                  className={clsx(
                    'card flex flex-col border-2 overflow-hidden',
                    isCurrent ? 'border-blue-400 shadow-md' : 'border-transparent'
                  )}
                >
                  <div className={clsx('px-5 pt-5 pb-4', meta.header)}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-base capitalize">{plan.name}</span>
                      {isCurrent && (
                        <span className="text-xs font-semibold bg-white bg-opacity-60 px-2 py-0.5 rounded-full">Current</span>
                      )}
                    </div>
                    <div className="text-2xl font-extrabold">{formatPrice(plan)}</div>
                  </div>

                  <div className="px-5 py-4 flex-1 space-y-2">
                    <FeatureRow
                      icon={plan.allow_chat ? MessageSquare : X}
                      iconClass={plan.allow_chat ? 'text-green-500' : 'text-gray-300'}
                    >
                      {plan.allow_chat
                        ? (plan.chat_limit ? `${plan.chat_limit} Chat/mo` : 'Unlimited Chat')
                        : 'Live Chat'}
                    </FeatureRow>
                    <FeatureRow
                      icon={plan.allow_calls ? Phone : X}
                      iconClass={plan.allow_calls ? 'text-green-500' : 'text-gray-300'}
                    >
                      {plan.allow_calls
                        ? (plan.calls_limit ? `${plan.calls_limit} Calls/mo` : 'Unlimited Calls')
                        : 'Phone Support'}
                    </FeatureRow>
                    <FeatureRow icon={Check} iconClass="text-green-500">
                      {plan.tickets_limit ? `${plan.tickets_limit} tickets/mo` : 'Unlimited tickets'}
                    </FeatureRow>
                    <FeatureRow icon={Zap} iconClass="text-amber-500">
                      <span className="capitalize">{plan.priority || 'low'} priority</span>
                    </FeatureRow>
                    <FeatureRow icon={Clock} iconClass="text-blue-400">
                      {RESPONSE_LABEL[plan.name] || `${plan.sla_response_hours}h response`}
                    </FeatureRow>
                  </div>

                  <div className="px-5 pb-5">
                    {canRenewSamePlan ? (
                      <button
                        onClick={() => handleUpgrade(plan.name)}
                        disabled={!!paying}
                        className={clsx(
                          'w-full py-2 rounded-lg text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2',
                          meta.btn,
                          paying && 'opacity-60 cursor-not-allowed'
                        )}
                      >
                        {paying === plan.name ? (
                          <>
                            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            Processing…
                          </>
                        ) : (
                          'Renew →'
                        )}
                      </button>
                    ) : isCurrent ? (
                      <div className="w-full py-2 text-center text-sm font-semibold text-blue-600 bg-blue-50 rounded-lg border border-blue-200">
                        Current Plan
                      </div>
                    ) : (canUpgrade || canDowngrade) ? (
                      <button
                        onClick={() => handleUpgrade(plan.name)}
                        disabled={!!paying}
                        className={clsx(
                          'w-full py-2 rounded-lg text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2',
                          meta.btn,
                          paying && 'opacity-60 cursor-not-allowed'
                        )}
                      >
                        {paying === plan.name ? (
                          <>
                            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            Processing…
                          </>
                        ) : (
                          canDowngrade ? 'Downgrade →' : 'Upgrade →'
                        )}
                      </button>
                    ) : (
                      <div className="w-full py-2 text-center text-xs text-gray-400 bg-gray-50 rounded-lg">
                        {isLower
                          ? 'Downgrade opens in the last 30 days of your plan'
                          : '—'}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-gray-400 max-w-lg">
            Plans are billed annually. Live Chat and Phone Support limits reset every month. After a successful payment, your plan will be activated within a few minutes. For billing queries, contact your account manager.
          </p>
        </>
      )}

      {/* ── Subscriptions Tab ── */}
      {tab === 'subscriptions' && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <CalendarClock className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-bold text-gray-700">Active Subscriptions</h2>
            <span className="text-xs text-gray-400">— renewal dates from your billing account</span>
          </div>
          <SubscriptionsTab />
        </>
      )}

      {/* ── Paid Invoices Tab ── */}
      {tab === 'invoices' && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <Receipt className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-bold text-gray-700">Paid Invoices</h2>
          </div>
          <InvoicesTab />
        </>
      )}

      {/* ── Pending Payments Tab ── */}
      {tab === 'quotes' && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <FileText className="w-4 h-4 text-gray-400" />
            <h2 className="text-sm font-bold text-gray-700">Pending Payments</h2>
          </div>
          <QuotesTab onPay={handleQuotePay} paying={payingQuote} />
        </>
      )}

      {/* Failed-payment retry dialog — appears when Razorpay's payment.failed
          event fires. Shows the real reason from the gateway + a Try Again
          button that re-opens the same order (no fresh /upgrade/initiate). */}
      {failedPayment && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
              <h2 className="text-lg font-bold text-gray-800">Payment didn't go through</h2>
            </div>
            <p className="text-sm text-gray-600 mb-2">
              Your <strong className="capitalize">{failedPayment.plan}</strong> upgrade payment was not completed.
            </p>
            <div className="bg-red-50 border border-red-100 rounded-lg p-3 mb-4">
              <p className="text-xs text-red-700 font-medium">
                Reason from the payment gateway:
              </p>
              <p className="text-sm text-red-800 mt-1">
                {failedPayment.errorDescription}
              </p>
              <p className="text-[10px] text-red-500 mt-1.5 font-mono">
                Code: {failedPayment.errorCode}
              </p>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              You can try again with the same or a different payment method (UPI, card, netbanking).
              No money has been charged.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setFailedPayment(null)}
                className="btn-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleRetryPayment}
                className="btn-primary inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Try Again
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
