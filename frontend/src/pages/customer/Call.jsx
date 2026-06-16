import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Layout from '../../components/common/Layout';
import { useCustomerCall } from '../../contexts/CustomerCallContext';
import useAudioLevel from '../../hooks/useAudioLevel';
import AudioWaveBars from '../../components/common/AudioWaveBars';
import { useSocket } from '../../contexts/SocketContext';
import { initiateCall, getCallHistory, getCustomerDashboard, getCustomerAgentStatus, getActiveChat } from '../../services/api';
import {
  Phone, PhoneOff, PhoneCall, Mic, MicOff,
  Clock, Lock, AlertTriangle, History, Loader, Users, MessageCircle, ArrowRightLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import clsx from 'clsx';

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function CustomerCall() {
  // Read from the global customer-call context — the WebRTC peer connection
  // lives at app level so it survives navigation between customer pages
  // (bug #21). Same shape as the old useWebRTCCall hook; no other change.
  const { callState, agentName, transferredFrom, elapsed, isMuted, error, endedMeta, localStream, remoteStream, startCall, endCall, toggleMute, reset } = useCustomerCall();
  const micLevel    = useAudioLevel(isMuted ? null : localStream);
  const remoteLevel = useAudioLevel(remoteStream);
  const { socket } = useSocket();
  const [history, setHistory] = useState([]);
  const [usageResetAt, setUsageResetAt] = useState(null);
  // The billable threshold (seconds). Drives the "short call" tooltip wording
  // so it matches whatever admin currently has set in Settings → Call Billing.
  const [billableThreshold, setBillableThreshold] = useState(30);
  const [loading, setLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [isRestricted, setIsRestricted] = useState(false);
  // Admin-applied call blacklist — separate state so we can show a truthful
  // "Call Access Restricted" screen instead of the plan-upgrade CTA below.
  const [isBlocked, setIsBlocked] = useState(false);
  // Inline quota pill — shows "Calls this month: X / Y" below the subtitle so
  // the customer knows where they stand BEFORE starting a call.
  const [callsUsageInfo, setCallsUsageInfo] = useState(null); // { used, limit } | null
  const [hasActiveChat, setHasActiveChat] = useState(false);
  const [agentOnline, setAgentOnline] = useState(null);
  const [activeTab, setActiveTab] = useState('call');
  // Pre-call category — same vocabulary as live chat (technical / billing / others)
  // so the routing engine can use the same skill-tag mapping. Persisted on the
  // calls row via /api/call/initiate.
  const [callCategory, setCallCategory] = useState('technical');
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Soft banner shown when admin disables calls mid-call — we don't terminate
  // the in-flight call, just notify that future calls will be blocked.
  const [planChangedNotice, setPlanChangedNotice] = useState(false);

  // Refetch dashboard and re-evaluate restrictions. Called on mount and on
  // every admin-pushed `plan_changed` event so the page always reflects the
  // live plan rules. `isPlanPush` toggles soft-banner behaviour: if the user
  // is mid-call when admin disables calls, we just show a banner — we don't
  // forcibly drop their call.
  const hydratePlan = (isPlanPush = false) => {
    return getCustomerDashboard()
      .then(res => {
        const { allowCalls, isActive, callsLimit } = res.data.plan;
        const callsUsed = res.data.usage?.callsUsed ?? 0;
        setCallsUsageInfo({ used: callsUsed, limit: callsLimit });
        const isInCall = callState === 'ringing' || callState === 'active' || callState === 'requesting';
        if (res.data.callBlocked) {
          if (isPlanPush && isInCall) { setPlanChangedNotice(true); return; }
          setIsBlocked(true); return;
        }
        if (!isActive) {
          if (isPlanPush && isInCall) { setPlanChangedNotice(true); return; }
          setIsRestricted(true);
          setPlanError('Your support plan has expired. Renew to access call support.');
          return;
        }
        if (!allowCalls) {
          if (isPlanPush && isInCall) { setPlanChangedNotice(true); return; }
          setIsRestricted(true);
          setPlanError('Voice call support is not included in your current plan. Upgrade to make calls.');
          return;
        }
        if (callsLimit !== null && callsLimit !== undefined && callsUsed >= callsLimit) {
          if (isPlanPush && isInCall) { setPlanChangedNotice(true); return; }
          setIsRestricted(true);
          setPlanError(`Monthly call limit (${callsLimit}) reached. Upgrade your plan to make more calls this month.`);
          return;
        }
        // Plan now allows calls — clear any previous restricted/blocked state
        // (admin reverted a change).
        if (isPlanPush) {
          setIsBlocked(false);
          setIsRestricted(false);
          setPlanError('');
          setPlanChangedNotice(false);
        }
      })
      .catch(() => {});
  };

  // Pre-check plan permissions AND usage on page load — block button proactively
  // instead of waiting for the user to click and get a 403 back.
  useEffect(() => {
    hydratePlan();

    // Check for active chat session — show redirect card instead of plan-restriction screen
    getActiveChat()
      .then(res => { if (res.data.chat) setHasActiveChat(true); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live plan-change push from admin — refetch + re-evaluate. Won't drop an
  // in-flight call; the soft banner takes care of warning the customer.
  useEffect(() => {
    if (!socket) return;
    const onPlanChanged = () => hydratePlan(true);
    socket.on('plan_changed', onPlanChanged);
    return () => socket.off('plan_changed', onPlanChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => {
    getCallHistory().then(res => {
      setHistory(res.data.calls);
      setUsageResetAt(res.data.usage_reset_at || null);
      if (res.data.min_billable_call_seconds != null) setBillableThreshold(res.data.min_billable_call_seconds);
    }).catch(() => toast.error('Failed to load call history'));
  }, []);

  // Fetch agent availability; re-fetch on socket push or every 60s as fallback
  useEffect(() => {
    const fetch = () => getCustomerAgentStatus().then(res => setAgentOnline(res.data)).catch(() => {});
    fetch();
    socket?.on('agent_availability_changed', fetch);
    const interval = setInterval(fetch, 60000);
    return () => {
      socket?.off('agent_availability_changed', fetch);
      clearInterval(interval);
    };
  }, [socket]);

  // Refresh call history whenever a call reaches a terminal state
  useEffect(() => {
    if (['ended', 'rejected', 'no_answer', 'error'].includes(callState)) {
      getCallHistory()
        .then(res => {
          setHistory(res.data.calls);
          setUsageResetAt(res.data.usage_reset_at || null);
          if (res.data.min_billable_call_seconds != null) setBillableThreshold(res.data.min_billable_call_seconds);
        })
        .catch(() => {});
    }
  }, [callState]);

  const handleStart = async () => {
    setPlanError('');
    setIsRestricted(false);
    setLoading(true);
    try {
      const res = await initiateCall({ category: callCategory });
      const callId = res.data.call.id;
      await startCall(callId);
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 409) {
        setPlanError(data?.error || 'Please end your active chat session first.');
      } else if (err.response?.status === 403) {
        if (data?.reason === 'blacklisted') {
          setIsBlocked(true);
        } else if (data?.limit_exceeded) {
          setPlanError(`${data.error}. ${data.extra_charge_message}`);
        } else {
          setIsRestricted(true);
          setPlanError(data?.error || 'Call support not available on your plan');
        }
      } else {
        toast.error('Failed to initiate call. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEnd = () => {
    endCall();
    toast.success('Call ended');
  };

  const handleReset = () => {
    reset();
    setPlanError('');
    setIsRestricted(false);
    setHasActiveChat(false);
  };

  // Auto-start when bot routes here with ?start=1 — watches searchParams so it fires
  // even when the user is already on this page (same-route navigation from bot widget)
  useEffect(() => {
    if (searchParams.get('start') === '1' && callState === 'idle') {
      setSearchParams({}, { replace: true });
      handleStart();
    }
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCallActive = callState === 'ringing' || callState === 'active' || callState === 'requesting';

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <div className="mb-5">
          <h1 className="text-2xl font-bold text-gray-800">Call Support</h1>
          <p className="text-sm text-gray-500 mt-0.5">Live voice call with a support agent via your browser</p>
          {!isBlocked && callsUsageInfo && callsUsageInfo.limit != null && (() => {
            const { used, limit } = callsUsageInfo;
            const remaining = Math.max(0, limit - used);
            const pct = limit > 0 ? used / limit : 0;
            const tone = pct >= 1 ? 'bg-red-50 border-red-200 text-red-700'
                       : pct >= 0.7 ? 'bg-amber-50 border-amber-200 text-amber-700'
                       : 'bg-emerald-50 border-emerald-200 text-emerald-700';
            return (
              <div className={`mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold ${tone}`}>
                <Phone className="w-3.5 h-3.5" />
                Calls this month: {used} / {limit} · {remaining} remaining
              </div>
            );
          })()}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-xl w-fit">
          <button
            onClick={() => setActiveTab('call')}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors',
              activeTab === 'call' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            )}
          >
            <Phone className="w-3.5 h-3.5" /> Call
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={clsx(
              'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium transition-colors',
              activeTab === 'history' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            )}
          >
            <History className="w-3.5 h-3.5" /> This Month's Calls
            {history.length > 0 && (
              <span
                className="ml-1 bg-indigo-100 text-indigo-600 text-xs font-semibold px-1.5 py-0.5 rounded-full"
                title={`${history.filter(c => c.counted).length} of ${history.length} count toward your monthly quota`}
              >
                {history.length}
                {history.some(c => c.counted) && (
                  <span className="text-indigo-400 font-normal">
                    {' '}· {history.filter(c => c.counted).length} counted
                  </span>
                )}
              </span>
            )}
          </button>
        </div>

        {activeTab === 'call' && isBlocked && (
          /* Admin-applied block — short-circuits the rest of the call UI so the
             customer doesn't see the Start Call button + browser-mic info while
             blocked. Only the restricted card + ticket CTA render. */
          <div className="card p-8 text-center mb-4">
            <div className="w-16 h-16 bg-red-50 border-2 border-red-200 rounded-full flex items-center justify-center mx-auto mb-5">
              <Lock className="w-8 h-8 text-red-500" />
            </div>
            <h3 className="font-semibold text-gray-800 text-lg mb-2">Call Access Restricted</h3>
            <p className="text-sm text-gray-500 mb-6 max-w-md mx-auto">
              Voice calls have been disabled on your account by our support team. Your tickets and live chat are still available. If you believe this is a mistake, please open a support ticket and we'll look into it.
            </p>
            <button
              onClick={() => navigate('/customer/tickets', { state: { openNewTicket: true } })}
              className="btn-primary mx-auto"
            >
              Open a Support Ticket
            </button>
          </div>
        )}

        {activeTab === 'call' && !isBlocked && (<>
        {/* Privacy notice */}
        <div className="flex items-start gap-3 bg-indigo-50 border border-indigo-200 rounded-xl p-4 mb-5">
          <Lock className="w-5 h-5 text-indigo-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-indigo-700">Browser-based Voice Call</p>
            <p className="text-sm text-indigo-600 mt-0.5">
              Your microphone will be requested when you start a call. If the call drops for any reason, our agent will call you back.
            </p>
          </div>
        </div>

        {/* Active chat session — redirect to Live Chat */}
        {hasActiveChat && !isRestricted && (
          <div className="card p-8 text-center mb-4">
            <div className="w-16 h-16 bg-indigo-50 border-2 border-indigo-200 rounded-full flex items-center justify-center mx-auto mb-5">
              <MessageCircle className="w-8 h-8 text-indigo-500" />
            </div>
            <h3 className="font-semibold text-gray-800 text-lg mb-2">Chat Session Active</h3>
            <p className="text-sm text-gray-500 mb-1">
              You already have an active live chat session with a support agent.
            </p>
            <p className="text-sm text-gray-500 mb-6">
              To start a voice call, use the <span className="font-semibold text-indigo-600">Call</span> button inside your live chat.
            </p>
            <button
              onClick={() => navigate('/customer/chat')}
              className="btn-primary mx-auto"
            >
              Go to Live Chat
            </button>
          </div>
        )}

        {/* Plan-changed soft banner — admin disabled calls mid-call. We let
            this call finish and block re-initiation afterwards. */}
        {planChangedNotice && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Your plan changed — call access updated</p>
              <p className="text-xs mt-0.5">You can finish this call, but you won't be able to start a new one afterwards unless your plan is updated.</p>
            </div>
          </div>
        )}

        {/* Plan restricted — upgrade CTA. Heading + body adapt to which restriction triggered. */}
        {!isBlocked && isRestricted && (() => {
          const isLimitReached = /limit/i.test(planError);
          const isExpired = /expired/i.test(planError);
          return (
            <div className="card p-8 text-center mb-4">
              <div className="w-16 h-16 bg-amber-50 border-2 border-amber-200 rounded-full flex items-center justify-center mx-auto mb-5">
                <Lock className="w-8 h-8 text-amber-500" />
              </div>
              <h3 className="font-semibold text-gray-800 text-lg mb-2">
                {isLimitReached ? 'Monthly Call Limit Reached' : isExpired ? 'Plan Expired' : 'Call Support Unavailable'}
              </h3>
              <p className="text-sm text-gray-500 mb-2 max-w-md mx-auto">
                {planError ||
                  <>Voice call support requires the <span className="font-semibold text-indigo-600">Moderate plan</span> or higher.</>}
              </p>
              <p className="text-xs text-gray-400 mb-6">
                {isLimitReached
                  ? 'Your limit resets at the start of next month, or upgrade now for a higher allowance.'
                  : 'Upgrade your plan to connect directly with our agents via live voice call.'}
              </p>
              <button
                onClick={() => navigate('/customer/billing', { state: { tab: 'plan' } })}
                className="btn-primary mx-auto"
              >
                View Plans &amp; Upgrade
              </button>
            </div>
          );
        })()}

        {/* Plan / mic errors */}
        {(planError && !isRestricted && !hasActiveChat) && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            {planError}
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {/* Call widget */}
        {!isRestricted && !hasActiveChat && (
          <div className="card p-8 text-center mb-5">

            {/* Idle */}
            {callState === 'idle' && (
              <>
                <div className="w-20 h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-5">
                  <Phone className="w-10 h-10 text-indigo-600" />
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">Request a Support Call</h3>

                {/* Agent availability — no counts shown to the customer, just
                    a binary on/off-style status: available / all busy /
                    closed-or-offline. Matches the live-chat panel's simplified
                    "Agent online" line. */}
                {agentOnline !== null && (() => {
                  const { online, withinHours, availableCount, busyCount, totalOnline, workDaysLabel, workStart, workEnd } = agentOnline;
                  const free = availableCount ?? 0;
                  const busy = busyCount ?? 0;
                  const allBusy = withinHours && totalOnline > 0 && free === 0 && busy > 0;
                  const fmtHr = (h) => `${h % 12 || 12} ${h >= 12 ? 'PM' : 'AM'}`;
                  let dotColor, txtColor, label;
                  if (!withinHours) {
                    dotColor = 'bg-gray-400'; txtColor = 'text-gray-500';
                    label = `Outside working hours · ${workDaysLabel}, ${fmtHr(workStart)} – ${fmtHr(workEnd)} IST`;
                  } else if (free > 0) {
                    dotColor = 'bg-green-500 animate-pulse'; txtColor = 'text-green-600';
                    label = 'Agent available';
                  } else if (allBusy) {
                    dotColor = 'bg-amber-500'; txtColor = 'text-amber-600';
                    label = 'All agents busy — usually free in a few minutes';
                  } else if (totalOnline === 0) {
                    dotColor = 'bg-gray-400'; txtColor = 'text-gray-500';
                    label = 'No agents online right now';
                  } else {
                    dotColor = 'bg-gray-400'; txtColor = 'text-gray-500';
                    label = online ? 'Agent available' : 'No agents online right now';
                  }
                  return (
                    <div className="flex items-center justify-center gap-1.5 mb-3">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
                      <span className={`text-xs font-medium ${txtColor}`}>{label}</span>
                    </div>
                  );
                })()}

                <p className="text-sm text-gray-500 mb-6">
                  {agentOnline !== null && !agentOnline.withinHours
                    ? 'We\'re closed right now. You can still try a call (it\'ll go to whoever is on shift), or open a ticket and we\'ll respond first thing.'
                    : agentOnline !== null && agentOnline.availableCount === 0 && agentOnline.busyCount > 0
                      ? 'Every agent is currently on another chat or call. You can wait on this line — it will ring through as soon as someone\'s free — or switch to chat / ticket below.'
                      : agentOnline !== null && agentOnline.totalOnline === 0
                        ? 'Agents are currently offline. You can still request a call and the next available agent will connect with you.'
                        : 'Start a voice call directly or use the Support Assistant for a guided experience.'}
                </p>
                {/* Pre-call category — same three buckets as live chat. Routes
                    the call to the right specialist (technical agent, billing
                    primary/secondary, or anyone for misc). */}
                <div className="w-full max-w-xs mx-auto mb-4">
                  <label className="text-xs font-semibold text-gray-600 block mb-1.5 text-center">What's your call about?</label>
                  <div className="grid grid-cols-3 gap-1.5 text-xs">
                    {[
                      { value: 'technical', label: 'Technical' },
                      { value: 'billing',   label: 'Billing' },
                      { value: 'others',    label: 'Others' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setCallCategory(opt.value)}
                        className={`px-3 py-1.5 rounded-lg border font-medium transition-colors ${callCategory === opt.value ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300'}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-3 justify-center flex-wrap">
                  <button
                    data-testid="CustomerCall-StartCallButton"
                    onClick={handleStart}
                    disabled={loading}
                    className="btn-primary px-8 py-3"
                  >
                    {loading
                      ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      : <><Phone className="w-5 h-5" /> Start Call</>}
                  </button>
                  <button
                    onClick={() => window.dispatchEvent(new CustomEvent('open-bot-widget'))}
                    className="btn-secondary px-6 py-3"
                  >
                    <MessageCircle className="w-4 h-4" /> Open Assistant
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-4 max-w-md mx-auto">
                  Calls may be recorded for quality and training purposes. Starting a call indicates your consent.
                </p>
              </>
            )}

            {/* Requesting mic */}
            {callState === 'requesting' && (
              <>
                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-5">
                  <Loader className="w-10 h-10 text-blue-600 animate-spin" />
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">Requesting Microphone</h3>
                <p className="text-sm text-gray-500">Please allow microphone access when prompted.</p>
              </>
            )}

            {/* Ringing / waiting for agent */}
            {callState === 'ringing' && (
              <>
                <div className="relative w-20 h-20 mx-auto mb-5">
                  <div className="absolute inset-0 bg-amber-200 rounded-full animate-ping opacity-50" />
                  <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center">
                    <PhoneCall className="w-10 h-10 text-amber-600" />
                  </div>
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">Ringing...</h3>
                <p className="text-sm text-gray-500 mb-6">Waiting for an agent to pick up. This may take up to 30 seconds.</p>
                <button onClick={handleEnd} className="btn-secondary mx-auto px-6 py-2 flex items-center gap-2">
                  <PhoneOff className="w-4 h-4" /> Cancel
                </button>
              </>
            )}

            {/* Active call */}
            {callState === 'active' && (
              <>
                {/* Agent avatar + wave bars on either side driven by the
                    agent's mic level (remoteLevel). Customer's own mic level
                    is shown by a separate wave below the controls. */}
                <div className="flex items-center justify-center gap-3 mb-5">
                  <AudioWaveBars level={remoteLevel} bars={4} color="bg-green-500" maxHeight={28} />
                  <div className="relative w-20 h-20">
                    <div className="absolute inset-0 bg-green-200 rounded-full animate-ping opacity-40" />
                    <div className="relative w-20 h-20 bg-green-100 rounded-full flex items-center justify-center">
                      <PhoneCall className="w-10 h-10 text-green-600" />
                    </div>
                  </div>
                  <AudioWaveBars level={remoteLevel} bars={4} color="bg-green-500" maxHeight={28} />
                </div>
                <p className="text-sm text-gray-500 mb-1">Connected with</p>
                <p className="font-bold text-gray-800 text-lg mb-1">{agentName || 'Support Agent'}</p>
                {transferredFrom && (
                  <div className="inline-flex items-center gap-1.5 mb-3 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">
                    <ArrowRightLeft className="w-3 h-3" />
                    Transferred from {transferredFrom}
                  </div>
                )}
                {!transferredFrom && <div className="mb-4" />}

                <div className="text-3xl font-mono font-bold text-gray-800 mb-1">{formatDuration(elapsed)}</div>
                <p className="text-xs text-gray-400 mb-6">Call duration</p>

                {/* Your own mic activity — wave bars next to the Mute button.
                    Bars stay flat (level=0) while muted because the analyser
                    receives no stream then. */}
                <div className="flex items-center justify-center gap-3 mb-4">
                  <AudioWaveBars level={isMuted ? 0 : micLevel} bars={6} color="bg-indigo-500" maxHeight={20} />
                  <span className="text-xs text-gray-400">Your mic</span>
                </div>

                <div className="flex gap-3 justify-center">
                  <button
                    data-testid="CustomerCall-MuteButton"
                    onClick={toggleMute}
                    className={clsx(
                      'flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors',
                      isMuted
                        ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    )}
                  >
                    {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    {isMuted ? 'Unmute' : 'Mute'}
                  </button>
                  <button data-testid="CustomerCall-EndCallButton" onClick={handleEnd} className="btn-danger flex items-center gap-2 px-5 py-2.5">
                    <PhoneOff className="w-4 h-4" /> End Call
                  </button>
                </div>
              </>
            )}

            {/* No agents */}
            {callState === 'no_agents' && (() => {
              // `error` is set to the backend's `reason`: 'outside_work_hours' | 'all_busy' | 'no_agents'
              const reason = error || 'no_agents';
              const closed   = reason === 'outside_work_hours';
              const allBusy  = reason === 'all_busy';
              const hrs = agentOnline
                ? `${agentOnline.workDaysLabel}, ${agentOnline.workStart % 12 || 12} ${agentOnline.workStart >= 12 ? 'PM' : 'AM'} – ${agentOnline.workEnd % 12 || 12} ${agentOnline.workEnd >= 12 ? 'PM' : 'AM'} IST`
                : '';
              return (
                <>
                  <div className={clsx('w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-5',
                    closed ? 'bg-blue-50' : allBusy ? 'bg-amber-50' : 'bg-gray-100')}>
                    {closed ? <Clock className="w-10 h-10 text-blue-500" /> : <Users className={clsx('w-10 h-10', allBusy ? 'text-amber-500' : 'text-gray-400')} />}
                  </div>
                  <h3 className="font-semibold text-gray-700 mb-2">
                    {closed ? 'We\'re currently closed' : allBusy ? 'All agents are on other calls/chats' : 'No agents available'}
                  </h3>
                  <p className="text-sm text-gray-500 mb-6 max-w-md mx-auto">
                    {closed
                      ? <>Support hours are <strong>{hrs}</strong>. Open a ticket now and we'll respond first thing when we're back.</>
                      : allBusy
                        ? "Every agent is mid-conversation. Try a live chat — you'll be queued and picked up as soon as someone frees up."
                        : "No agents online right now. Reach us via ticket and we'll respond as soon as possible."}
                  </p>
                  <div className="flex gap-3 justify-center flex-wrap">
                    <button onClick={handleReset} className="btn-secondary px-6 py-2.5">Try Again</button>
                    {!closed && (
                      <button onClick={() => navigate('/customer/chat')} className="btn-primary px-6 py-2.5">
                        <MessageCircle className="w-4 h-4" /> Start Chat
                      </button>
                    )}
                    <button onClick={() => window.dispatchEvent(new CustomEvent('open-bot-widget'))} className={clsx('px-6 py-2.5', closed ? 'btn-primary' : 'btn-secondary')}>
                      Open a Ticket
                    </button>
                  </div>
                </>
              );
            })()}

            {/* No answer / timeout */}
            {callState === 'no_answer' && (
              <>
                <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-5">
                  <Clock className="w-10 h-10 text-amber-500" />
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">No Answer</h3>
                <p className="text-sm text-gray-500 mb-6">The agent didn't pick up. Please try again or use Live Chat instead.</p>
                <button onClick={handleReset} className="btn-primary mx-auto">Try Again</button>
              </>
            )}

            {/* Rejected */}
            {callState === 'rejected' && (
              <>
                <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-5">
                  <PhoneOff className="w-10 h-10 text-red-400" />
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">Call Declined</h3>
                <p className="text-sm text-gray-500 mb-6">The agent is currently unavailable. Please try again shortly.</p>
                <button onClick={handleReset} className="btn-primary mx-auto">Try Again</button>
              </>
            )}

            {/* Ended */}
            {callState === 'ended' && (
              <>
                <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-5">
                  <PhoneOff className="w-10 h-10 text-gray-400" />
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">Call Ended</h3>
                <p className="text-sm text-gray-500 mb-2">Duration: {formatDuration(elapsed)}</p>
                {endedMeta?.counted === false ? (
                  <div className="mx-auto max-w-xs bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-800 mb-5">
                    This call was too short to count toward your monthly call limit.
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 mb-6">Thank you for contacting support.</p>
                )}
                <button onClick={handleReset} className="btn-primary mx-auto">
                  <Phone className="w-4 h-4" /> New Call
                </button>
              </>
            )}

            {/* Mic / connection error */}
            {callState === 'error' && (
              <>
                <div className="w-20 h-20 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-5">
                  <AlertTriangle className="w-10 h-10 text-red-400" />
                </div>
                <h3 className="font-semibold text-gray-700 mb-2">Call Failed</h3>
                <p className="text-sm text-gray-500 mb-6">{error || 'Something went wrong. Please try again.'}</p>
                <button onClick={handleReset} className="btn-primary mx-auto">Try Again</button>
              </>
            )}
          </div>
        )}

        </>)}

        {/* Call History tab */}
        {activeTab === 'history' && (
          <>
            {history.length === 0 ? (
              <div className="card p-12 flex flex-col items-center text-gray-400">
                <History className="w-10 h-10 mb-3 opacity-20" />
                <p className="text-sm font-medium">No calls this billing period</p>
                <p className="text-xs mt-1 text-center max-w-xs">Voice calls from this billing period will appear here. The list resets at the start of each month, alongside your plan's call quota.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Quick explainer for calls flagged "Does not count" — calls
                    can skip the quota for a few reasons (short call, agent-
                    initiated, missed, pre-reset). Hover the pill on any row
                    to see the specific reason. */}
                {history.some(c => !c.counted) && (
                  <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                    <strong className="text-gray-700">Why do some calls show "Does not count"?</strong>
                    {' '}Calls under {billableThreshold}s, agent-initiated calls, missed calls, and pre-reset calls don't count toward your monthly quota. Hover any pill to see the specific reason for that call.
                  </div>
                )}
                {/* Render rows, injecting a one-line divider when we cross the
                    usage_reset_at boundary. List is sorted newest-first, so
                    the divider appears between the last post-reset row and
                    the first pre-reset row. */}
                {(() => {
                  const rows = [];
                  let dividerInserted = false;
                  history.forEach((c, idx) => {
                    if (c.pre_reset && !dividerInserted) {
                      rows.push(
                        <div key={`divider-${c.id}`} className="flex items-center gap-3 py-2 text-xs text-amber-700">
                          <div className="flex-1 border-t border-amber-200"></div>
                          <span className="font-medium text-center">
                            Usage was reset on {usageResetAt ? new Date(usageResetAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'this date'} — calls below do not count toward your current quota
                          </span>
                          <div className="flex-1 border-t border-amber-200"></div>
                        </div>
                      );
                      dividerInserted = true;
                    }
                    const counted = !!c.counted;
                    const preReset = !!c.pre_reset;
                    // "Connected" purely reflects technical connection state — even pre-reset
                    // calls can have connected; we just don't count them toward quota anymore.
                    const technicallyConnected = !!c.agent_name && !!c.call_start_time && c.status === 'ended';
                    const statusLabel = {
                      ended:     'Ended',
                      rejected:  'Declined',
                      no_answer: 'No Answer',
                      no_agents: 'No Agents',
                      missed:    'Missed',
                    }[c.status] ?? c.status;
                    const isOutbound = c.initiated_by === 'agent';

                    rows.push(
                      <div
                        key={c.id}
                        className={`card p-4 ${preReset ? 'opacity-60' : ''}`}
                        title={preReset ? 'This call happened before your usage was reset — it stays in your records but does not count toward your current quota.' : undefined}
                      >
                      <div className="flex items-start gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${technicallyConnected ? 'bg-green-50' : 'bg-red-50'}`}>
                          {technicallyConnected
                            ? <Phone className="w-5 h-5 text-green-500" />
                            : <PhoneOff className="w-5 h-5 text-red-400" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          {/* Title row — wraps on narrow screens so the status
                              pills drop to their own line instead of forcing the
                              card (and the page) to overflow horizontally. */}
                          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                            <p className="text-sm font-semibold text-gray-800 min-w-0 break-words">
                              {c.agent_name ? `Call with ${c.agent_name}` : 'Support Call'}
                            </p>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full font-medium ${isOutbound ? 'bg-purple-50 text-purple-700' : 'bg-blue-50 text-blue-700'}`}
                                title={isOutbound ? 'Our agent placed this call to you. It does not count toward your monthly call limit.' : 'You initiated this call from the customer panel.'}
                              >
                                {isOutbound ? '↙ Agent called you' : '↗ You called'}
                              </span>
                              <span
                                className={`text-xs px-2 py-0.5 rounded-full font-medium ${counted ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}
                                title={
                                  counted
                                    ? (c.short_call_past_cap
                                        ? `Short call (under ${billableThreshold}s), but you've already used your monthly allowance of short-call forgivals — this one counts toward your quota.`
                                        : 'This call counts toward your monthly quota.')
                                    : ({
                                        pre_reset:        'Happened before your usage was reset — no longer counts.',
                                        agent_initiated:  'Agent-initiated calls never count toward your quota.',
                                        short_call:       `Call ended in under ${billableThreshold}s — too short to count. We don’t charge your quota for calls that didn’t deliver support.`,
                                        missed:           'Missed before any agent picked up — doesn’t count.',
                                        no_answer:        'No agent answered in time — doesn’t count.',
                                        no_agents:        'No agents were available — doesn’t count.',
                                        not_connected:    'Call didn’t connect — doesn’t count.',
                                        other:            'Didn’t count toward your quota.',
                                      }[c.not_counted_reason] || 'Didn’t count toward your quota.')
                                }
                              >
                                {counted ? '✓ Counts toward quota' : '○ Does not count'}
                              </span>
                              {c.short_call_forgiven && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider bg-amber-100 text-amber-800"
                                  title={`Under the ${billableThreshold}s billable threshold — forgiven.`}
                                >
                                  Short call
                                </span>
                              )}
                              {c.short_call_past_cap && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider bg-amber-100 text-amber-800"
                                  title={`Under ${billableThreshold}s, but monthly short-call allowance was already used — this one counts.`}
                                >
                                  Short · past cap
                                </span>
                              )}
                              <span className="text-xs px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-500">
                                {statusLabel}
                              </span>
                            </div>
                          </div>
                          {/* Meta row */}
                          <div className="flex items-center gap-3 text-xs text-gray-400">
                            <span>{new Date(c.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {c.duration ? formatDuration(c.duration) : '< 1 min'}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                    );
                  });
                  return rows;
                })()}
              </div>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}
