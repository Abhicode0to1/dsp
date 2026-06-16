import { useEffect, useRef } from 'react';

// Subscribe a page's data-reload function to the global (mobile) refresh button
// rendered in the Layout top bar next to the notification bell. That button
// dispatches a window 'app:refresh' event; whichever page is mounted reloads
// its own data via the handler passed here.
//
// Uses a ref so the listener stays stable across renders while always calling
// the latest handler — pages can pass an inline arrow without re-subscribing.
export default function useGlobalRefresh(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = () => { if (typeof ref.current === 'function') ref.current(); };
    window.addEventListener('app:refresh', fn);
    return () => window.removeEventListener('app:refresh', fn);
  }, []);
}
