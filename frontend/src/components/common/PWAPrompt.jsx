import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import toast from 'react-hot-toast';
import { RefreshCw, X } from 'lucide-react';

// Phase 3 — PWA registration + update UX.
//
// useRegisterSW registers the service worker on mount (immediate) and exposes
// two signals:
//   • offlineReady — the shell is cached and the app can now load offline.
//   • needRefresh  — a new build was deployed; the waiting SW is ready.
//
// We deliberately DON'T auto-reload on needRefresh (registerType is 'prompt'):
// a silent reload could interrupt a live chat or call. Instead we show a small
// banner; the user reloads when it's safe. updateServiceWorker(true) activates
// the new worker and reloads the page.
export default function PWAPrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    if (offlineReady) {
      toast.success('Ready to work offline', { duration: 3000 });
      setOfflineReady(false);
    }
  }, [offlineReady, setOfflineReady]);

  if (!needRefresh) return null;

  // Mobile: anchor left with right clearance (right-24) so the banner doesn't
  // sit under the bottom-right floating bot/bug buttons. Desktop: centered.
  return (
    <div className="fixed bottom-4 z-[70] left-4 right-24 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 sm:w-[calc(100%-2rem)] max-w-sm">
      <div className="flex items-center gap-3 rounded-xl bg-gray-900 text-white shadow-2xl px-4 py-3">
        <RefreshCw className="w-4 h-4 flex-shrink-0 text-blue-300" />
        <p className="text-sm flex-1">A new version is available.</p>
        <button
          onClick={() => updateServiceWorker(true)}
          className="text-sm font-semibold bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg transition-colors"
        >
          Reload
        </button>
        <button
          onClick={() => setNeedRefresh(false)}
          className="text-gray-400 hover:text-white transition-colors"
          aria-label="Dismiss"
          title="Later"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
