import { useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  getBillingSyncs, getBillingSyncsStats,
  retryBillingSync, dismissBillingSync,
} from '../../services/api';
import {
  AlertTriangle, CheckCircle2, RefreshCw, ExternalLink, XCircle, Clock, RotateCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import useGlobalRefresh from '../../hooks/useGlobalRefresh';

// Pending Billing Syncs — embeddable panel.
// Originally a dedicated page; now rendered as a tab inside SystemHealth.
// Shows rows where verifyUpgrade's Zoho-notify call failed. Three actions:
//   • Resync to Billing App  → POST /admin/billing-syncs/:id/retry
//   • Mark as manually invoiced → POST /admin/billing-syncs/:id/dismiss
//   • View customer         → /admin/customers/:customerId
export default function BillingSyncsPanel() {
  const [items, setItems] = useState(null);
  const [stats, setStats] = useState(null);
  const [filter, setFilter] = useState('open');
  const [busyId, setBusyId] = useState(null);
  const [dismissingId, setDismissingId] = useState(null);
  const [dismissNote, setDismissNote] = useState('');

  const load = () => {
    setItems(null);
    getBillingSyncs(filter).then(r => setItems(r.data.items || [])).catch(() => toast.error('Failed to load syncs'));
    getBillingSyncsStats().then(r => setStats(r.data)).catch(() => {});
  };

  useEffect(load, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  useGlobalRefresh(load);

  const handleRetry = async (id) => {
    setBusyId(id);
    try {
      const r = await retryBillingSync(id);
      toast.success(r.data.message || 'Resynced successfully');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Retry failed');
    } finally { setBusyId(null); }
  };

  const handleDismiss = async () => {
    if (!dismissingId) return;
    setBusyId(dismissingId);
    try {
      await dismissBillingSync(dismissingId, dismissNote.trim() || undefined);
      toast.success('Marked as manually invoiced');
      setDismissingId(null);
      setDismissNote('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Dismiss failed');
    } finally { setBusyId(null); }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">
            Customer upgrades where the panel could not notify the billing app (Zoho).
            The plan is already active — only the invoice is missing.
          </p>
        </div>
        <button onClick={load} className="hidden lg:inline-flex btn-secondary items-center gap-1.5">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

        {/* Stat strip */}
        {stats && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <StatTile label="Open / waiting"     value={stats.open}      tone={stats.open ? 'amber' : 'gray'}  icon={Clock} />
            <StatTile label="Retries exhausted"  value={stats.exhausted} tone={stats.exhausted ? 'red' : 'gray'} icon={AlertTriangle} />
            <StatTile label="Auto-synced (all-time)" value={stats.synced}    tone="emerald" icon={CheckCircle2} />
            <StatTile label="Dismissed (all-time)"   value={stats.dismissed} tone="gray"    icon={XCircle} />
          </div>
        )}

        {/* Filter chips */}
        <div className="mb-3 inline-flex rounded-lg border border-gray-200 overflow-hidden bg-white">
          {[
            { id: 'open',      label: 'Open' },
            { id: 'synced',    label: 'Synced' },
            { id: 'dismissed', label: 'Dismissed' },
            { id: 'all',       label: 'All' },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 text-xs font-medium ${filter === f.id ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {items == null ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !items.length ? (
          <div className="bg-white border border-gray-200 rounded-xl p-10 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
            <p className="text-sm text-gray-500">No {filter === 'open' ? 'pending' : filter} syncs.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map(r => (
              <div key={r.id} className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-[260px]">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="text-sm font-bold text-gray-800">
                        {r.customer_name || r.customer_email}
                      </h3>
                      <span className="text-xs text-gray-500">{r.customer_email}</span>
                      <span className="text-[11px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-bold">{r.plan}</span>
                      {r.synced_at && <span className="badge bg-emerald-100 text-emerald-700 text-xs">Synced</span>}
                      {r.dismissed_at && <span className="badge bg-gray-200 text-gray-700 text-xs">Dismissed</span>}
                      {!r.synced_at && !r.dismissed_at && r.attempts >= 5 && (
                        <span className="badge bg-red-100 text-red-700 text-xs">Retries exhausted</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 flex flex-wrap gap-x-4 gap-y-1">
                      <span>Amount: <strong className="text-gray-800">₹{Number(r.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
                      <span>Payment ref: <span className="font-mono text-[11px] text-gray-700">{r.payment_ref}</span></span>
                      <span>Attempts: <strong className="text-gray-800">{r.attempts}/5</strong></span>
                      <span>Created: {new Date(r.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                      {r.last_attempt_at && (
                        <span>Last try: {new Date(r.last_attempt_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                    </div>
                    {r.last_error && (
                      <div className="mt-2 text-[11px] font-mono text-red-700 bg-red-50 border border-red-100 rounded p-2 break-all">
                        {r.last_error}
                      </div>
                    )}
                    {r.dismiss_note && (
                      <div className="mt-2 text-[11px] italic text-gray-600 bg-gray-50 border border-gray-200 rounded p-2">
                        Dismiss note: {r.dismiss_note}
                        {r.dismissed_by_name && <span className="ml-1 text-gray-400">— {r.dismissed_by_name}</span>}
                      </div>
                    )}
                  </div>

                  {!r.synced_at && !r.dismissed_at && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => handleRetry(r.id)}
                        disabled={busyId === r.id}
                        className="btn-primary text-xs inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <RotateCw className="w-3 h-3" /> {busyId === r.id ? 'Working…' : 'Resync to Billing App'}
                      </button>
                      <button
                        onClick={() => { setDismissingId(r.id); setDismissNote(''); }}
                        disabled={busyId === r.id}
                        className="btn-secondary text-xs inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <CheckCircle2 className="w-3 h-3" /> Mark manually invoiced
                      </button>
                      <RouterLink
                        to={`/admin/customers?focus=${r.customer_id}`}
                        className="btn-secondary text-xs inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <ExternalLink className="w-3 h-3" /> Customer
                      </RouterLink>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Dismiss confirmation modal */}
        {dismissingId && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
              <h2 className="text-lg font-bold text-gray-800 mb-2">Mark as manually invoiced?</h2>
              <p className="text-sm text-gray-500 mb-4">
                Use this when you've already handled the invoice externally (created it directly in Zoho, applied a credit note, granted complimentary access, etc.). The row will be removed from the open queue.
              </p>
              <label className="label">Optional note (visible in audit log)</label>
              <textarea
                value={dismissNote}
                onChange={e => setDismissNote(e.target.value)}
                placeholder="e.g. Created Zoho invoice INV-2026-0142 manually"
                className="input w-full text-sm"
                rows={3}
                maxLength={500}
              />
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => { setDismissingId(null); setDismissNote(''); }} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={handleDismiss} disabled={busyId === dismissingId} className="btn-primary">
                  {busyId === dismissingId ? 'Working…' : 'Mark Invoiced'}
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

function StatTile({ label, value, tone, icon: Icon }) {
  const tones = {
    amber:   'bg-amber-50 border-amber-200 text-amber-800',
    red:     'bg-red-50 border-red-200 text-red-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    gray:    'bg-gray-50 border-gray-200 text-gray-700',
  };
  return (
    <div className={`border rounded-lg p-3 ${tones[tone] || tones.gray}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-2xl font-bold leading-none">{value || 0}</div>
          <div className="text-[11px] mt-1 opacity-80">{label}</div>
        </div>
        {Icon && <Icon className="w-4 h-4 opacity-60" />}
      </div>
    </div>
  );
}
