import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { getMyTickets } from '../../services/api';
import {
  X, ChevronRight, ChevronLeft, Sparkles, Ticket, MessageSquare, Phone, BookOpen, CheckCircle2,
} from 'lucide-react';

// First-login walkthrough. Fires the very first time a customer lands on /customer
// after using the setup link. Dismissible; remembered in localStorage so it never
// shows twice on the same device even before `users.first_login_at` propagates.
// Skipped silently if `user.is_first_login` is false.
const LS_KEY = 'dsp_tour_seen';

export default function WelcomeTour() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const shouldShow = !!user?.is_first_login && !localStorage.getItem(LS_KEY);
  const [open, setOpen] = useState(shouldShow);
  const [step, setStep] = useState(0);
  const [onboardingTicket, setOnboardingTicket] = useState(null);

  // Pull the customer's open onboarding ticket so step 2 can reference it by ID.
  // Identified by the auto-created subject prefix "Onboarding — set up support for".
  useEffect(() => {
    if (!open) return;
    getMyTickets().then(res => {
      const tickets = res.data.tickets || res.data || [];
      const t = tickets.find(x => /^Onboarding —/i.test(x.subject || ''));
      if (t) setOnboardingTicket(t);
    }).catch(() => {});
  }, [open]);

  if (!open) return null;

  const close = () => {
    localStorage.setItem(LS_KEY, '1');
    setOpen(false);
  };

  // Build steps adaptively — the "onboarding ticket" step is only included when an
  // onboarding ticket actually exists. Existing customers being imported don't see it.
  const allSteps = [
    {
      icon: Sparkles, color: 'indigo',
      title: `Welcome to Anutech Digital, ${user?.name?.split(' ')[0] || 'there'}!`,
      body: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            Your account is ready. Let's take 30 seconds to show you around — you can skip any time.
          </p>
          {onboardingTicket && (
            <div className="mt-4 bg-blue-50 border border-blue-100 rounded-lg p-3">
              <p className="text-xs text-blue-700 font-semibold uppercase tracking-wider">Already in progress</p>
              <p className="text-sm font-semibold text-gray-800 mt-1">Onboarding ticket #{onboardingTicket.id}</p>
              <p className="text-xs text-gray-600 mt-0.5">
                {onboardingTicket.agent_name
                  ? <>Assigned to <strong>{onboardingTicket.agent_name}</strong>. They'll reach out shortly.</>
                  : <>An agent will pick this up shortly.</>}
              </p>
            </div>
          )}
        </>
      ),
    },
    onboardingTicket && {
      icon: Ticket, color: 'green',
      title: 'Your onboarding ticket',
      body: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            We've pre-opened an onboarding ticket with a short checklist — which email service (Google Workspace / Microsoft 365 / Zoho), your domain, number of users, and so on.
          </p>
          <p className="text-sm text-gray-600 leading-relaxed mt-2">
            Reply on the ticket with answers and our agent will take it from there. You can also start a chat or call any time if you'd rather talk live.
          </p>
          <button
            onClick={() => { close(); navigate(`/customer/tickets/${onboardingTicket.id}`); }}
            className="btn-primary text-sm mt-4 inline-flex items-center gap-1.5"
          >
            Open ticket #{onboardingTicket.id} <ChevronRight className="w-4 h-4" />
          </button>
        </>
      ),
    },
    {
      icon: MessageSquare, color: 'blue',
      title: 'Three ways to reach us',
      body: (
        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 bg-blue-50 rounded-lg">
            <Ticket className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-gray-800">Raise a Ticket</p>
              <p className="text-xs text-gray-600">For anything that's not urgent — DNS, email setup, follow-ups.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-green-50 rounded-lg">
            <MessageSquare className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-gray-800">Live Chat</p>
              <p className="text-xs text-gray-600">Real-time help during working hours. Average wait: under 5 min.</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg">
            <Phone className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-gray-800">Voice Call</p>
              <p className="text-xs text-gray-600">For complex issues that need screen-sharing or step-by-step walkthrough.</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      icon: BookOpen, color: 'purple',
      title: 'Track your usage anytime',
      body: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            Your dashboard shows how many chats / calls you have left on your plan this month. Once a session connects with an agent, it counts toward your limit — missed calls don't.
          </p>
          <p className="text-sm text-gray-600 leading-relaxed mt-2">
            <strong>Tip:</strong> the Support Assistant (bottom-right floating button) is the fastest way to raise a ticket — it guides you through the questions step by step.
          </p>
        </>
      ),
    },
    {
      icon: CheckCircle2, color: 'green',
      title: 'You\'re all set!',
      body: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            {onboardingTicket
              ? "Look out for an email from your assigned agent — they'll be in touch shortly to start the email setup. In the meantime, feel free to explore the dashboard."
              : "Feel free to explore. If you need anything, raise a ticket, start a chat, or call us — links are in the sidebar."}
          </p>
          <p className="text-sm text-gray-400 mt-2 italic">You can re-open this tour any time from your profile.</p>
        </>
      ),
    },
  ].filter(Boolean);
  const steps = allSteps;

  const current = steps[step];
  const Icon = current.icon;
  const last = step === steps.length - 1;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className={`p-5 bg-gradient-to-br from-${current.color}-50 to-white border-b border-gray-100 flex items-center justify-between`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-full bg-${current.color}-100 flex items-center justify-center`}>
              <Icon className={`w-5 h-5 text-${current.color}-600`} />
            </div>
            <div>
              <p className="text-xs text-gray-400">Step {step + 1} of {steps.length}</p>
              <h2 className="text-lg font-bold text-gray-800">{current.title}</h2>
            </div>
          </div>
          <button onClick={close} className="text-gray-400 hover:text-gray-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">{current.body}</div>

        {/* Footer / progress dots */}
        <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
          <button
            onClick={() => setStep(s => Math.max(0, s - 1))}
            disabled={step === 0}
            className="text-sm text-gray-600 hover:text-gray-800 disabled:opacity-30 inline-flex items-center gap-1"
          >
            <ChevronLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex items-center gap-1.5">
            {steps.map((_, i) => (
              <span
                key={i}
                className={`w-1.5 h-1.5 rounded-full transition-all ${i === step ? 'bg-blue-600 w-4' : 'bg-gray-300'}`}
              />
            ))}
          </div>
          {last
            ? <button onClick={close} className="btn-primary text-sm py-1.5 px-4">Get started →</button>
            : <button onClick={() => setStep(s => s + 1)} className="btn-primary text-sm py-1.5 px-4 inline-flex items-center gap-1">
                Next <ChevronRight className="w-4 h-4" />
              </button>}
        </div>
      </div>
    </div>
  );
}
