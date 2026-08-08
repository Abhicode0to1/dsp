import { useState, useEffect, useRef } from 'react';
import { MessageCircle, Bug, ChevronLeft } from 'lucide-react';
import clsx from 'clsx';

// Edge-docked quick actions (MOBILE only — desktop keeps the original floating
// bot + bug buttons). A slim tab sits on the right edge, vertically centred so
// it's clear of any bottom composer.
//
// Behaviour (per user request): the actions START expanded (both buttons
// visible) and stay until the user does something:
//   • tap a button   → that widget opens (and the dock collapses)
//   • tap the tab     → toggles the dock
//   • anything else   → (tap elsewhere on the page, or scroll) the dock
//                       collapses to the tab, WITHOUT swallowing that action —
//                       the tap/scroll still does whatever it was going to do.
// The tab is always there to re-open it.
export default function FloatingDock({ showAssistant = false }) {
  const [open, setOpen] = useState(true); // start expanded
  const dockRef = useRef(null);

  const openBot = () => { window.dispatchEvent(new CustomEvent('open-bot-widget')); setOpen(false); };
  const openBug = () => { window.dispatchEvent(new CustomEvent('open-feedback-widget')); setOpen(false); };

  // While expanded, collapse on any interaction that ISN'T on the dock. We
  // listen at the document level WITHOUT calling preventDefault, so the user's
  // actual tap/scroll still reaches its target — we just dock the buttons.
  useEffect(() => {
    if (!open) return;
    const collapseIfOutside = (e) => {
      if (dockRef.current && !dockRef.current.contains(e.target)) setOpen(false);
    };
    const collapse = () => setOpen(false);
    // pointerdown fires before click, so the page's own click still lands.
    document.addEventListener('pointerdown', collapseIfOutside, true);
    document.addEventListener('scroll', collapse, true); // capture: catches inner scroll containers too
    return () => {
      document.removeEventListener('pointerdown', collapseIfOutside, true);
      document.removeEventListener('scroll', collapse, true);
    };
  }, [open]);

  return (
    <div ref={dockRef} className="fixed right-0 top-1/2 -translate-y-1/2 z-[55] flex items-center">
      {/* Slide-out actions. Collapsed → max-w-0 + clipped (no phantom space,
          not clickable); expanded → revealed. */}
      <div
        className={clsx(
          'flex flex-col gap-2 overflow-hidden transition-all duration-200 ease-out',
          open ? 'max-w-[64px] opacity-100 mr-1.5' : 'max-w-0 opacity-0 pointer-events-none'
        )}
      >
        {showAssistant && (
          <button
            onClick={openBot}
            title="Support assistant"
            aria-label="Open support assistant"
            className="w-12 h-12 rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-lg flex items-center justify-center transition-colors flex-shrink-0"
          >
            <MessageCircle className="w-5 h-5" />
          </button>
        )}
        <button
          onClick={openBug}
          title="Report a bug or share feedback"
          aria-label="Report a bug or share feedback"
          className="w-12 h-12 rounded-full bg-amber-500 hover:bg-amber-600 text-white shadow-lg flex items-center justify-center transition-colors flex-shrink-0"
        >
          <Bug className="w-5 h-5" />
        </button>
      </div>

      {/* Peek tab — always visible, hugging the right edge. */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'Hide quick actions' : 'Show quick actions'}
        title={open ? 'Hide quick actions' : 'Quick actions'}
        className="bg-gray-900/90 hover:bg-gray-900 text-white shadow-lg rounded-l-xl py-4 px-1.5 flex items-center transition-colors"
      >
        <ChevronLeft className={clsx('w-4 h-4 transition-transform duration-200', open && 'rotate-180')} />
      </button>
    </div>
  );
}
