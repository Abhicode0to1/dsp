import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { getUsageDrift, getShortCutWatchlist, resetCustomerUsageAudit, runRoutingLimitsTests, getInboundEmailLog, attachInboundEmail, getPaymentFailures, getBillingSyncsStats, getHealthWorkers, getHealthSlaForecast } from '../../services/api';
import { Activity, RefreshCw, AlertTriangle, CheckCircle2, Clock, RotateCcw, PlayCircle, XCircle, Phone, Mail, ExternalLink, CreditCard, Cpu, Timer, Bell } from 'lucide-react';
import { Link as RouterLink } from 'react-router-dom';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import BillingSyncsPanel from './BillingSyncs';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

export default function SystemHealth() {
  // Tab state from ?tab= so emails / cards can deep-link
  // ?tab=billing-syncs is used by the billing_sync_failed_admin email CTA.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = ['overview', 'billing-syncs'].includes(searchParams.get('tab'))
    ? searchParams.get('tab')
    : 'overview';
  const [tab, setTab] = useState(initialTab);
  const handleTabChange = (t) => {
    setTab(t);
    if (t === 'overview') {
      // Clean URL — don't keep ?tab=overview hanging around
      searchParams.delete('tab');
      setSearchParams(searchParams, { replace: true });
    } else {
      searchParams.set('tab', t);
      setSearchParams(searchParams, { replace: true });
    }
  };
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(null); // email currently being reset
  const [testRun, setTestRun] = useState(null);     // last test-suite run result
  const [running, setRunning] = useState(false);
  // Spam-cut abuse signal — customers who have hit the short-call forgival cap
  // this month. High counts here can indicate the customer is repeatedly cutting
  // calls under the threshold (potential abuse) or an agent is doing it to them.
  const [watchlist, setWatchlist] = useState(null);
  // Recent inbound-email ingestion audit log (what the IMAP poller did with
  // each message). Loaded on mount and refreshable.
  const [inboundLog, setInboundLog] = useState(null);
  const [inboundFilter, setInboundFilter] = useState('');
  // Phase 1 / Phase 2 — payment & billing health signals
  const [paymentFailures, setPaymentFailures] = useState(null);
  const [billingSyncStats, setBillingSyncStats] = useState(null);
  // Quick-wins batch — worker liveness + SLA forecast
  const [workers, setWorkers] = useState(null);
  const [slaForecast, setSlaForecast] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      getUsageDrift().then(res => setData(res.data)),
      getShortCutWatchlist().then(res => setWatchlist(res.data)).catch(() => {}),
      getInboundEmailLog({ limit: 50 }).then(res => setInboundLog(res.data)).catch(() => {}),
      getPaymentFailures().then(res => setPaymentFailures(res.data)).catch(() => {}),
      getBillingSyncsStats().then(res => setBillingSyncStats(res.data)).catch(() => {}),
      getHealthWorkers().then(res => setWorkers(res.data)).catch(() => {}),
      getHealthSlaForecast(4).then(res => setSlaForecast(res.data)).catch(() => {}),
    ])
      .catch(() => toast.error('Failed to load audit data'))
      .finally(() => setLoading(false));
  }, []);

  const reloadInbound = (status) => {
    setInboundFilter(status || '');
    const params = { limit: 50 };
    if (status) params.status = status;
    getInboundEmailLog(params).then(res => setInboundLog(res.data)).catch(() => {});
  };

  const handleAttachInbound = async (row) => {
    const ticketId = window.prompt(`Attach this inbound email to which ticket?\n\nFrom: ${row.from_email}\nSubject: ${row.subject || '(no subject)'}\n\nType the ticket ID:`);
    if (!ticketId) return;
    try {
      await attachInboundEmail(row.id, parseInt(ticketId, 10));
      toast.success(`Attached to ticket #${ticketId}`);
      reloadInbound(inboundFilter);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to attach');
    }
  };

  useEffect(() => { load(); }, [load]);

  useGlobalRefresh(load);

  // Look up customer_id by walking the drift rows — we don't have it client-side, so
  // we ask the backend for it via a second call. Simpler: include customer_id in the
  // drift response so we can hit the reset endpoint directly.
  const handleReset = async (drift) => {
    if (!drift.customer_id) {
      toast.error('Missing customer id in drift row');
      return;
    }
    if (!window.confirm(`Reset usage counter for ${drift.email}?\n\nAll chats/calls before now will stop counting toward this customer's limit. Old rows stay visible in their history.`)) {
      return;
    }
    setResetting(drift.email);
    try {
      await resetCustomerUsageAudit(drift.customer_id);
      toast.success(`Usage reset for ${drift.email}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to reset usage');
    } finally {
      setResetting(null);
    }
  };

  const handleRunTests = async () => {
    setRunning(true);
    setTestRun(null);
    try {
      const res = await runRoutingLimitsTests();
      setTestRun(res.data);
      if (res.data.passed) {
        toast.success(`All ${res.data.total} tests passed (${(res.data.duration_ms / 1000).toFixed(1)}s)`);
      } else {
        toast.error(`${res.data.fail_count} of ${res.data.total} tests failed — see results below`);
      }
    } catch (err) {
      toast.error('Test run failed: ' + (err.response?.data?.error || err.message));
    } finally {
      setRunning(false);
    }
  };

  const hasDrift = data && data.drift_count > 0;
  const allClean = data && data.drift_count === 0;

  return (
    <Layout>
      <div className="p-6 max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <Activity className="w-6 h-6 text-blue-600" />
              System Health
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              {tab === 'overview'
                ? 'Live signals: usage drift, payment failures, inbound mail, and routing tests.'
                : 'Billing-app sync queue: customers whose paid upgrade failed to reach Zoho.'}
            </p>
          </div>
          {tab === 'overview' && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleRunTests}
                disabled={running}
                className="btn-primary text-sm py-2 px-4 inline-flex items-center gap-1.5"
                title="Run the 11-test routing + plan-limit smoke test suite. Same as 'npm run test:routing'."
              >
                {running
                  ? <><span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Running…</>
                  : <><PlayCircle className="w-4 h-4" /> Run Tests</>}
              </button>
              <button onClick={load} disabled={loading} className="btn-secondary p-2 hidden lg:inline-flex" title="Refresh drift table">
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 mb-5 flex items-center gap-1 text-sm">
          {[
            { id: 'overview',      label: 'Overview' },
            { id: 'billing-syncs', label: 'Billing Syncs', dot: (billingSyncStats?.open > 0 || billingSyncStats?.exhausted > 0) },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => handleTabChange(t.id)}
              className={clsx(
                'px-3 py-2 -mb-px border-b-2 font-medium transition-colors inline-flex items-center gap-2',
                tab === t.id ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              {t.label}
              {t.dot && <span className="w-1.5 h-1.5 rounded-full bg-red-500" title="Items need attention" />}
            </button>
          ))}
        </div>

        {/* Billing Syncs tab — full content moved in from the old /admin/billing-syncs page */}
        {tab === 'billing-syncs' && <BillingSyncsPanel />}

        {/* Overview tab — original System Health content */}
        {tab === 'overview' && (<>

        {/* === Needs attention summary strip — single-line glance signal ===== */}
        {(() => {
          // Aggregate everything that needs admin action across all sections.
          // Number(...) coerces MySQL2 COUNT() strings — without it "0" + "0" + 0
          // string-concatenates to "00" instead of summing to 0, and the truthy
          // string skips the "All systems operational" branch below.
          const quarantinedCount = Number(inboundLog?.counts?.quarantined) || 0;
          const billingSyncsOpen = Number(billingSyncStats?.open) || 0;
          const driftCount       = Number(data?.drift_count) || 0;
          const slaForecastCount = Number(slaForecast?.count) || 0;
          const failedWorkers    = (workers?.items || []).filter(w => w.last_status === 'error' || w.is_overdue).length;
          const total = quarantinedCount + billingSyncsOpen + driftCount + slaForecastCount + failedWorkers;
          if (total === 0) {
            return (
              <div className="mb-5 p-3 rounded-xl border-2 border-emerald-200 bg-emerald-50/50 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <span className="text-sm font-medium text-emerald-800">All systems operational ✓</span>
              </div>
            );
          }
          const items = [];
          if (failedWorkers > 0)    items.push({ label: `${failedWorkers} worker${failedWorkers === 1 ? '' : 's'} unhealthy`, anchor: 'workers', tone: 'red' });
          if (slaForecastCount > 0) items.push({ label: `${slaForecastCount} ticket${slaForecastCount === 1 ? '' : 's'} approaching SLA breach`, anchor: 'sla-forecast', tone: 'red' });
          if (billingSyncsOpen > 0) items.push({ label: `${billingSyncsOpen} billing sync${billingSyncsOpen === 1 ? '' : 's'} pending`, anchor: 'billing-syncs-tab', tone: 'amber' });
          if (quarantinedCount > 0) items.push({ label: `${quarantinedCount} quarantined email${quarantinedCount === 1 ? '' : 's'}`, anchor: 'inbound-mail', tone: 'amber' });
          if (driftCount > 0)       items.push({ label: `${driftCount} customer${driftCount === 1 ? '' : 's'} over plan limit`, anchor: 'drift', tone: 'red' });
          const toneCls = { red: 'text-red-700 bg-red-50 border-red-200', amber: 'text-amber-700 bg-amber-50 border-amber-200' };
          return (
            <div className="mb-5 p-3 rounded-xl border-2 border-amber-200 bg-amber-50/40">
              <div className="flex items-center gap-2 flex-wrap">
                <Bell className="w-5 h-5 text-amber-600" />
                <span className="text-sm font-semibold text-amber-900">
                  {total} item{total === 1 ? '' : 's'} need{total === 1 ? 's' : ''} attention
                </span>
                <span className="text-amber-400 mx-1">·</span>
                {items.map(it => (
                  <a key={it.anchor} href={`#${it.anchor}`}
                     className={clsx('text-xs px-2 py-0.5 rounded-full border font-medium hover:opacity-80', toneCls[it.tone])}>
                    {it.label}
                  </a>
                ))}
              </div>
            </div>
          );
        })()}

        {/* === Quarantine banner — elevated CTA when emails are waiting === */}
        {Number(inboundLog?.counts?.quarantined) > 0 && (
          <div className="mb-5 p-4 rounded-xl border-2 border-amber-300 bg-amber-50 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-bold text-amber-900">
                {Number(inboundLog.counts.quarantined)} quarantined email{Number(inboundLog.counts.quarantined) === 1 ? ' is' : 's are'} waiting for you
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                These are inbound emails where the system matched the sender to a ticket but couldn't confirm authorisation. Use the <strong>Attach to ticket</strong> button in the Inbound Mail section below to route each one manually.
              </p>
            </div>
            <button
              onClick={() => { reloadInbound('quarantined'); document.getElementById('inbound-mail')?.scrollIntoView({ behavior: 'smooth' }); }}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-semibold hover:bg-amber-700 whitespace-nowrap"
            >
              Show me
            </button>
          </div>
        )}

        {/* === Worker liveness card === */}
        {workers && workers.items.length > 0 && (
          <div id="workers" className={clsx(
            'rounded-xl border-2 p-4 mb-5',
            workers.items.some(w => w.last_status === 'error' || w.is_overdue) ? 'border-red-200 bg-red-50/30' : 'border-gray-200 bg-white'
          )}>
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h3 className="font-semibold text-gray-700 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-blue-500" /> Background workers
              </h3>
              <span className="text-xs text-gray-500">
                {workers.items.filter(w => w.last_status === 'ok').length} of {workers.items.length} healthy
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {workers.items.map(w => {
                const tone = w.is_overdue ? 'red'
                           : w.last_status === 'error' ? 'red'
                           : w.last_status === 'skipped' ? 'gray'
                           : 'emerald';
                const tones = {
                  red:     'border-red-300 bg-red-50 text-red-800',
                  emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
                  gray:    'border-gray-200 bg-gray-50 text-gray-700',
                };
                const ago = w.seconds_since_last_run < 60
                  ? `${w.seconds_since_last_run}s ago`
                  : w.seconds_since_last_run < 3600
                    ? `${Math.floor(w.seconds_since_last_run / 60)}m ago`
                    : `${Math.floor(w.seconds_since_last_run / 3600)}h ago`;
                return (
                  <div key={w.name} className={clsx('rounded-lg border p-3', tones[tone])}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-semibold text-sm capitalize truncate" title={w.name}>{w.name.replace(/([A-Z])/g, ' $1').replace(/Worker$/i, '').trim()}</p>
                      {w.is_overdue ? <AlertTriangle className="w-4 h-4 text-red-600 flex-shrink-0" />
                       : w.last_status === 'error' ? <XCircle className="w-4 h-4 text-red-600 flex-shrink-0" />
                       : w.last_status === 'skipped' ? <Clock className="w-4 h-4 text-gray-500 flex-shrink-0" />
                       : <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />}
                    </div>
                    <p className="text-[11px] mt-1.5 opacity-80">
                      Last run: <strong>{ago}</strong>
                    </p>
                    {w.is_overdue && (
                      <p className="text-[10px] mt-1 font-medium" title={`Expected every ${w.expected_interval_seconds}s but hasn't ticked in ${w.seconds_since_last_run}s`}>
                        ⚠ Overdue (expected every {w.expected_interval_seconds < 3600 ? `${w.expected_interval_seconds / 60}m` : `${w.expected_interval_seconds / 3600}h`})
                      </p>
                    )}
                    {w.last_status === 'error' && w.last_error && (
                      <p className="text-[10px] mt-1 font-mono truncate" title={w.last_error}>{w.last_error}</p>
                    )}
                    {w.last_status === 'skipped' && w.last_error && (
                      <p className="text-[10px] mt-1 opacity-70 italic">Skipped: {w.last_error}</p>
                    )}
                    <p className="text-[10px] mt-1 opacity-50">{Number(w.run_count).toLocaleString()} runs</p>
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-2">
              A worker is "overdue" if it hasn't ticked in 2× its expected interval. Errors don't stop the worker — it just records the failure and retries on the next tick.
            </p>
          </div>
        )}

        {/* === SLA breach forecast card === */}
        {slaForecast && (
          <div id="sla-forecast" className={clsx(
            'rounded-xl border-2 p-4 mb-5',
            slaForecast.count > 0 ? 'border-red-200 bg-red-50/30' : 'border-gray-200 bg-white'
          )}>
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <h3 className="font-semibold text-gray-700 flex items-center gap-2">
                <Timer className="w-4 h-4 text-red-500" /> SLA breach forecast (next {slaForecast.window_hours}h)
              </h3>
              <span className={clsx(
                'text-xs px-2 py-0.5 rounded-full font-semibold',
                slaForecast.count === 0 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-red-100 text-red-700 border border-red-200'
              )}>
                {slaForecast.count} approaching
              </span>
            </div>
            {slaForecast.count === 0 ? (
              <p className="text-xs text-gray-400 text-center py-2">
                <CheckCircle2 className="w-4 h-4 inline mr-1 text-emerald-500" />
                No tickets approaching SLA breach in the next {slaForecast.window_hours} hours.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {slaForecast.items.map(t => {
                  const breachAt = t.next_breach_at ? new Date(t.next_breach_at) : null;
                  const minsLeft = breachAt ? Math.max(0, Math.floor((breachAt.getTime() - Date.now()) / 60_000)) : 0;
                  const timeLeft = minsLeft < 60 ? `${minsLeft}m` : `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`;
                  const isResponse = t.first_response_at == null;
                  return (
                    <RouterLink key={t.id} to={`/admin/tickets?focus=${t.id}`}
                      className="text-xs border border-red-100 rounded p-2 flex items-start justify-between gap-2 bg-white hover:bg-red-50 transition-colors block">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-800 truncate">
                          #{t.id} · {t.subject || '(no subject)'}
                          <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{t.priority}</span>
                          <span className="ml-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-50 text-red-700">{isResponse ? 'response' : 'resolve'} SLA</span>
                        </div>
                        <p className="text-[11px] text-gray-500 truncate">
                          {t.customer_name} ({t.customer_email})
                          {t.agent_name ? <> · assigned to {t.agent_name}</> : <> · <span className="text-amber-600 font-medium">unassigned</span></>}
                        </p>
                      </div>
                      <p className="text-[11px] font-semibold text-red-600 whitespace-nowrap flex-shrink-0">
                        breaches in {timeLeft}
                      </p>
                    </RouterLink>
                  );
                })}
              </div>
            )}
          </div>
        )}


        {/* Payment Failures strip — full Billing Syncs card lives in its own tab now */}
        {paymentFailures && (
          <div className="bg-white border border-gray-200 rounded-xl p-4 mb-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-gray-700 flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-blue-500" /> Payment Failures (last 7 days)
              </h3>
              <div className="flex gap-2 text-xs">
                <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100">
                  {paymentFailures.stats.succeeded} ok
                </span>
                <span className={`px-2 py-0.5 rounded border ${paymentFailures.stats.failed > 0 ? 'bg-red-50 text-red-700 border-red-100' : 'bg-gray-50 text-gray-500 border-gray-100'}`}>
                  {paymentFailures.stats.failed} failed
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-100">
                  {paymentFailures.stats.cancelled} cancelled
                </span>
              </div>
            </div>
            {paymentFailures.recent.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-3">
                <CheckCircle2 className="w-4 h-4 inline mr-1 text-emerald-500" />
                No payment failures in the last 7 days.
              </p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {paymentFailures.recent.map(r => (
                  <div key={r.id} className="text-xs border border-gray-100 rounded p-2 flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-gray-700 truncate">
                        {r.customer_name || r.customer_email}
                        <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">{r.target_plan}</span>
                        {r.status === 'cancelled' && <span className="ml-1 text-[10px] uppercase px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">cancelled</span>}
                      </div>
                      <p className="text-[11px] text-gray-500 truncate">{r.error_description || r.error_code || 'No reason recorded'}</p>
                    </div>
                    <p className="text-[10px] text-gray-400 whitespace-nowrap flex-shrink-0">
                      {new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="card p-12 flex flex-col items-center text-gray-400">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-sm">Auditing all customers…</p>
          </div>
        )}

        {/* Summary card — green when clean, amber when drift */}
        {!loading && data && (
          <div id="drift" className={`card p-6 mb-5 border-2 ${allClean ? 'border-green-200 bg-green-50/30' : 'border-amber-200 bg-amber-50/30'}`}>
            <div className="flex items-start gap-4">
              <div className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${allClean ? 'bg-green-100' : 'bg-amber-100'}`}>
                {allClean
                  ? <CheckCircle2 className="w-7 h-7 text-green-600" />
                  : <AlertTriangle className="w-7 h-7 text-amber-600" />}
              </div>
              <div className="flex-1">
                <h2 className={`text-lg font-semibold ${allClean ? 'text-green-800' : 'text-amber-800'}`}>
                  {allClean
                    ? 'All customers within limits ✓'
                    : `${data.drift_count} customer${data.drift_count === 1 ? '' : 's'} over limit`}
                </h2>
                <p className="text-sm text-gray-600 mt-1">
                  Checked <strong>{data.checked}</strong> active customer{data.checked === 1 ? '' : 's'}.
                  {' '}
                  <span className="text-gray-500">
                    <Clock className="w-3 h-3 inline-block mb-0.5" /> Last run: {new Date(data.generated_at).toLocaleString()}
                  </span>
                </p>
                {!allClean && (
                  <p className="text-xs text-gray-600 mt-2">
                    A non-zero drift means either the gate isn't holding (look for a recent change to <code>planUtils.js</code> / the initiate controllers) or a plan downgrade happened without resetting usage. Investigate immediately.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Drift table */}
        {!loading && hasDrift && (
          <div className="card p-0 overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h3 className="font-semibold text-gray-700">Customers in drift</h3>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px] lg:min-w-0">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Channel</th>
                  <th className="px-4 py-3">Usage</th>
                  <th className="px-4 py-3">Limit</th>
                  <th className="px-4 py-3">Over by</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.drifts.map((d, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-amber-50/30">
                    <td className="px-4 py-3 font-medium text-gray-800">{d.email}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium capitalize">{d.plan}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${d.channel === 'call' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                        {d.channel}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-semibold text-red-600">{d.used}</td>
                    <td className="px-4 py-3 text-gray-700">{d.limit}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">+{d.over_by}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleReset(d)}
                        disabled={resetting === d.email}
                        className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
                        title="Mark all current chats/calls as not-counted from now on. The customer's history still shows them."
                      >
                        {resetting === d.email
                          ? <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          : <><RotateCcw className="w-3.5 h-3.5" /> Reset Usage</>}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* Short-cut watchlist — customers at/past the monthly short-call forgival cap */}
        {!loading && watchlist && watchlist.watchlist.length > 0 && (
          <div className="card p-0 overflow-hidden mb-5 border-2 border-amber-200">
            <div className="p-4 border-b border-amber-100 bg-amber-50/40">
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-amber-700" />
                <h3 className="font-semibold text-amber-800">Short-call watchlist ({watchlist.watchlist.length})</h3>
              </div>
              <p className="text-xs text-amber-700/80 mt-1">
                Customers with ≥ {watchlist.cap} short calls (under {watchlist.threshold}s) this month. They've used their monthly forgivals — additional short calls now count toward their quota. High counts can indicate customer-side abuse (repeated sub-threshold dials) or an agent spam-cutting their calls. Drill into the Calls page → "Short-cut only" filter to investigate.
              </p>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px] lg:min-w-0">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Short calls this month</th>
                  <th className="px-4 py-3">Cut by</th>
                  <th className="px-4 py-3">Last short-cut</th>
                </tr>
              </thead>
              <tbody>
                {watchlist.watchlist.map((w) => {
                  const byCustomer = Number(w.short_cuts_by_customer) || 0;
                  const byAgent    = Number(w.short_cuts_by_agent) || 0;
                  const bySystem   = Number(w.short_cuts_by_system) || 0;
                  const unknown    = Number(w.short_cuts_unknown) || 0;
                  return (
                    <tr key={w.customer_id} className="border-b border-gray-50 hover:bg-amber-50/30">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">{w.customer_name}</p>
                        <p className="text-xs text-gray-400">{w.email}</p>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium capitalize">{w.plan || '—'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">{w.short_cuts_this_month}</span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                          {byCustomer > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-medium" title="Customer hung up">
                              📱 {byCustomer}
                            </span>
                          )}
                          {byAgent > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 font-medium" title="Agent hung up — possible spam-cutting">
                              🎧 {byAgent}
                            </span>
                          )}
                          {bySystem > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-50 text-gray-600 border border-gray-200 font-medium" title="Network drop / disconnect cleanup">
                              ⏱ {bySystem}
                            </span>
                          )}
                          {unknown > 0 && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200 italic" title="Pre-feature data — older calls didn't capture who cut">
                              ? {unknown}
                            </span>
                          )}
                          {byCustomer === 0 && byAgent === 0 && bySystem === 0 && unknown === 0 && (
                            <span className="text-gray-300">—</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {w.last_short_cut_at ? new Date(w.last_short_cut_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* Inbound mail audit — what the IMAP poller did with recent messages */}
        {!loading && inboundLog && (
          <div id="inbound-mail" className="card p-0 overflow-hidden mb-5">
            <div className="p-4 border-b border-gray-100">
              <div className="flex items-center gap-2 mb-1">
                <Mail className="w-4 h-4 text-blue-600" />
                <h3 className="font-semibold text-gray-700">Inbound Mail (last 30 days)</h3>
                <button onClick={() => reloadInbound(inboundFilter)} className="ml-auto p-1 text-gray-400 hover:text-gray-700" title="Refresh">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Each row is one email the IMAP poller ingested. Status tells you what happened. Quarantined / rejected rows can be force-attached to a ticket using the Attach action.
              </p>
              <div className="flex items-center gap-2 mt-3 flex-wrap">
                {[
                  { k: '',               label: 'All',         color: 'bg-gray-100 text-gray-700' },
                  { k: 'appended',       label: 'Appended',    color: 'bg-emerald-100 text-emerald-700' },
                  { k: 'reopened',       label: 'Reopened',    color: 'bg-emerald-100 text-emerald-700' },
                  { k: 'new_ticket',     label: 'New ticket',  color: 'bg-blue-100 text-blue-700' },
                  { k: 'quarantined',    label: 'Quarantined', color: 'bg-amber-100 text-amber-700' },
                  { k: 'rejected',       label: 'Rejected',    color: 'bg-red-100 text-red-700' },
                  { k: 'autoreply_loop', label: 'Auto-reply',  color: 'bg-gray-100 text-gray-600' },
                  { k: 'dmarc_fail',     label: 'DMARC fail',  color: 'bg-red-100 text-red-700' },
                  { k: 'error',          label: 'Errors',      color: 'bg-red-100 text-red-700' },
                ].map(b => {
                  const active = inboundFilter === b.k;
                  const count = b.k ? (inboundLog.counts?.[b.k] || 0) : (inboundLog.counts?.total || 0);
                  return (
                    <button key={b.k} onClick={() => reloadInbound(b.k)}
                      className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${b.color} ${active ? 'ring-2 ring-blue-400' : 'opacity-70 hover:opacity-100'}`}>
                      {b.label} <span className="ml-1 font-bold">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {inboundLog.items.length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">
                {inboundFilter ? `No ${inboundFilter} emails in the last 30 days.` : 'No inbound emails yet. The poller starts ingesting once you enable it in Settings → Inbound Email.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px] lg:min-w-0">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">From</th>
                    <th className="px-4 py-3">Subject</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Ticket</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {inboundLog.items.map(row => (
                    <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                        {new Date(row.received_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <p className="font-medium text-gray-800 truncate max-w-[200px]" title={row.from_email}>{row.from_email}</p>
                        {row.from_name && <p className="text-gray-400 truncate max-w-[200px]">{row.from_name}</p>}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <p className="text-gray-700 truncate max-w-[300px]" title={row.subject}>{row.subject || '(no subject)'}</p>
                        {row.note && <p className="text-[11px] text-gray-400 truncate max-w-[300px]" title={row.note}>{row.note}</p>}
                      </td>
                      <td className="px-4 py-3">
                        {(() => {
                          const c = {
                            appended:        'bg-emerald-50 text-emerald-700 border-emerald-200',
                            reopened:        'bg-emerald-50 text-emerald-700 border-emerald-200',
                            new_ticket:      'bg-blue-50 text-blue-700 border-blue-200',
                            quarantined:     'bg-amber-50 text-amber-700 border-amber-200',
                            rejected:        'bg-red-50 text-red-700 border-red-200',
                            autoreply_loop:  'bg-gray-50 text-gray-600 border-gray-200',
                            dmarc_fail:      'bg-red-50 text-red-700 border-red-200',
                            ignored:         'bg-gray-50 text-gray-600 border-gray-200',
                            error:           'bg-red-50 text-red-700 border-red-200',
                          }[row.status] || 'bg-gray-50 text-gray-600 border-gray-200';
                          return <span className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded-full border ${c}`}>{row.status.replace('_', ' ')}</span>;
                        })()}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {row.ticket_id ? (
                          <a href={`/admin/tickets?openTicket=${row.ticket_id}`} className="text-blue-600 hover:underline inline-flex items-center gap-1">
                            #{row.ticket_id} <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                        {row.parent_ticket_id && (
                          <span className="text-[11px] text-gray-400 block">linked to #{row.parent_ticket_id}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {(row.status === 'quarantined' || row.status === 'rejected') && (
                          <button onClick={() => handleAttachInbound(row)}
                            className="text-xs px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 font-medium">
                            Attach to ticket
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        )}

        {/* Test-suite results — shown after admin clicks "Run Tests" */}
        {testRun && (
          <div className={`card p-5 mb-5 border-2 ${testRun.passed ? 'border-green-200 bg-green-50/30' : 'border-red-200 bg-red-50/30'}`}>
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="flex items-center gap-3">
                {testRun.passed
                  ? <CheckCircle2 className="w-6 h-6 text-green-600 flex-shrink-0" />
                  : <XCircle className="w-6 h-6 text-red-600 flex-shrink-0" />}
                <div>
                  <h3 className={`font-semibold ${testRun.passed ? 'text-green-800' : 'text-red-800'}`}>
                    {testRun.passed
                      ? `All ${testRun.total} routing & limit tests passed`
                      : `${testRun.fail_count} of ${testRun.total} tests failed`}
                  </h3>
                  <p className="text-xs text-gray-600 mt-0.5">
                    Ran in {(testRun.duration_ms / 1000).toFixed(1)}s · same as <code className="px-1 bg-white border border-gray-200 rounded">npm run test:routing</code>
                  </p>
                </div>
              </div>
              <button onClick={() => setTestRun(null)} className="text-gray-400 hover:text-gray-600">
                <XCircle className="w-4 h-4" />
              </button>
            </div>

            {/* Test rows — green ticks first, red below */}
            <div className="space-y-1 text-sm">
              {testRun.fail_lines.map((line, i) => (
                <div key={`f${i}`} className="text-red-700 font-mono text-xs">{line}</div>
              ))}
              {testRun.pass_lines.map((line, i) => (
                <div key={`p${i}`} className="text-green-700 font-mono text-xs">{line}</div>
              ))}
            </div>

            {/* Expand to see raw stdout/stderr if anything failed */}
            {!testRun.passed && (testRun.stderr || testRun.stdout) && (
              <details className="mt-3">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                  Show full output
                </summary>
                <pre className="text-xs bg-gray-900 text-gray-200 p-3 rounded mt-2 overflow-auto max-h-80 whitespace-pre-wrap">
                  {testRun.stdout}{testRun.stderr ? '\n\nSTDERR:\n' + testRun.stderr : ''}
                </pre>
              </details>
            )}
          </div>
        )}

        {/* What this page checks — small help block */}
        {!loading && (
          <div className="mt-6 card p-5 bg-gray-50/40">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">What's being checked</h3>
            <ul className="text-xs text-gray-600 space-y-1.5">
              <li>• Chat usage (engaged-this-month + currently waiting/active) ≤ plan's <code>chat_limit</code></li>
              <li>• Call usage (real-connected customer-initiated calls this month) ≤ plan's <code>calls_limit</code></li>
              <li>• Free / unlimited plans (limit = NULL) are skipped — no cap to exceed</li>
            </ul>
            <p className="text-xs text-gray-500 mt-3">
              You can also run <code className="px-1 bg-white border border-gray-200 rounded">npm run test:routing</code> in the backend folder for a full 11-test routing + limit smoke test.
            </p>
          </div>
        )}
        </>)}{/* end Overview tab */}
      </div>
    </Layout>
  );
}
