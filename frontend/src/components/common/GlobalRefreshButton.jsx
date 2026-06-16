import { useState, useRef } from 'react';
import { RefreshCw } from 'lucide-react';

// Mobile-only refresh button shown in the Layout top bar next to the bell.
// Dispatches 'app:refresh' so the currently-mounted page reloads its own data
// (pages subscribe via the useGlobalRefresh hook). Lives here so each page's
// own header refresh button can be hidden on mobile, giving primary actions
// (e.g. "Raise a Ticket") their space back. Desktop keeps the per-page button.
export default function GlobalRefreshButton() {
  const [spinning, setSpinning] = useState(false);
  const timerRef = useRef(null);

  const onClick = () => {
    window.dispatchEvent(new CustomEvent('app:refresh'));
    setSpinning(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSpinning(false), 600);
  };

  return (
    <button
      onClick={onClick}
      aria-label="Refresh"
      title="Refresh"
      className="lg:hidden p-2 text-gray-600 hover:text-gray-900 rounded-lg"
    >
      <RefreshCw className={`w-5 h-5 ${spinning ? 'animate-spin' : ''}`} />
    </button>
  );
}
