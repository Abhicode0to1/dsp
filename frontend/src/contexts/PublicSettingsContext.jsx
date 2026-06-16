import { createContext, useContext, useEffect, useState } from 'react';
import { getPublicSettings } from '../services/api';

const Ctx = createContext({ settings: null, reload: () => {} });

// Provides admin-controlled public settings (maintenance flag, brand color,
// channel toggles, password rules, idle timeout, etc.) to the whole app.
// Fetches once on mount and exposes a reload() so components can pick up
// admin changes without a hard refresh.
export function PublicSettingsProvider({ children }) {
  const [settings, setSettings] = useState(null);

  const reload = async () => {
    try {
      const r = await getPublicSettings();
      setSettings(r.data || {});
      // Apply brand_color as a CSS custom property so any component can use
      // var(--brand-color) without threading the value through props.
      if (r.data?.brand_color) {
        document.documentElement.style.setProperty('--brand-color', r.data.brand_color);
      }
    } catch {
      // Fail-soft: leave defaults in place. We never want a misconfigured
      // settings endpoint to break the panel.
      setSettings({});
    }
  };

  useEffect(() => { reload(); }, []);

  return <Ctx.Provider value={{ settings, reload }}>{children}</Ctx.Provider>;
}

export function usePublicSettings() {
  return useContext(Ctx);
}
