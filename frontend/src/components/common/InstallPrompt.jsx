import { useEffect, useState } from 'react';
import { Download, X, Share } from 'lucide-react';

// Phase 4 — install-to-home-screen UX.
//
// Chromium (desktop + Android) fires `beforeinstallprompt`; we stash it and
// surface our own banner so the user installs on a deliberate tap rather than
// the browser's tucked-away menu. iOS Safari doesn't support that event, so
// for iPhone/iPad we show the manual "Share → Add to Home Screen" hint instead.
//
// The banner self-suppresses when: already installed (standalone), previously
// dismissed (localStorage), or not installable on this browser.
const DISMISS_KEY = 'dsp_install_dismissed';

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}
function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent)
    && !/crios|fxios/i.test(window.navigator.userAgent); // real Safari, not Chrome/FF on iOS
}
// Only offer "install" on phones — desktop users don't want a home-screen
// install prompt (and Chrome would otherwise fire beforeinstallprompt there).
function isMobileViewport() {
  return window.matchMedia('(max-width: 1023px)').matches;
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    if (dismissed || isStandalone() || !isMobileViewport()) return;

    const onBeforeInstall = (e) => {
      // Stop Chrome's mini-infobar; we drive the prompt from our button.
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // iOS gets no event — show the manual hint instead (Safari only).
    if (isIos()) setShowIosHint(true);

    // Once installed, hide everything.
    const onInstalled = () => { setDeferredPrompt(null); setShowIosHint(false); };
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [dismissed]);

  const dismiss = () => {
    setDismissed(true);
    setDeferredPrompt(null);
    setShowIosHint(false);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch {}
  };

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch {}
    // The event can only be used once.
    setDeferredPrompt(null);
  };

  if (dismissed) return null;
  if (!deferredPrompt && !showIosHint) return null;

  // Mobile: anchor left with right clearance (right-24) so the banner doesn't
  // sit under the bottom-right floating bot/bug buttons. Desktop: centered.
  return (
    <div className="fixed bottom-4 z-[70] left-4 right-24 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:w-[calc(100%-2rem)] max-w-sm">
      <div className="flex items-center gap-3 rounded-xl bg-white border border-gray-200 shadow-2xl px-4 py-3">
        <div className="w-9 h-9 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
          <Download className="w-4 h-4 text-indigo-600" />
        </div>
        {deferredPrompt ? (
          <>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-800">Install Anutech DSP</p>
              <p className="text-xs text-gray-500">Add it to your device for quick access.</p>
            </div>
            <button
              onClick={install}
              className="text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg transition-colors flex-shrink-0"
            >
              Install
            </button>
          </>
        ) : (
          // iOS manual hint
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-800">Install Anutech DSP</p>
            <p className="text-xs text-gray-500 inline-flex items-center gap-1 flex-wrap">
              Tap <Share className="w-3.5 h-3.5 inline text-indigo-600" /> then “Add to Home Screen”.
            </p>
          </div>
        )}
        <button
          onClick={dismiss}
          className="text-gray-400 hover:text-gray-700 transition-colors flex-shrink-0"
          aria-label="Dismiss"
          title="Not now"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
