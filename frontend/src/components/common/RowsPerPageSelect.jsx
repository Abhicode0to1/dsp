// Shared "Rows per page" dropdown used by every paginated list in the panel.
// One source of truth for the option set so admin/agent/customer UIs stay consistent.
//
// Usage:
//   <RowsPerPageSelect value={pageSize} onChange={setPageSize} storageKey="dsp_admin_audit_size" />
//
// Behaviour:
//   • Renders a small inline dropdown (no big button — visually quiet)
//   • Persists every change to the given localStorage `storageKey`
//   • On first mount, if a stored value exists AND differs from the parent's
//     initial value, calls onChange with the stored value so refresh restores it
//   • Reset to page 1 is the parent's responsibility (typically setPage(1)
//     inside the onChange handler) — kept out of here so this component
//     doesn't need to know about page state

import { useEffect } from 'react';

export const ROWS_PER_PAGE_OPTIONS = [25, 50, 100, 200, 250];
export const DEFAULT_ROWS_PER_PAGE = 50;

export default function RowsPerPageSelect({
  value,
  onChange,
  storageKey,
  options = ROWS_PER_PAGE_OPTIONS,
  label = 'Rows per page:',
  className = '',
}) {
  // Restore stored choice on first mount
  useEffect(() => {
    if (!storageKey) return;
    const stored = parseInt(localStorage.getItem(storageKey) || '', 10);
    if (stored && options.includes(stored) && stored !== value) {
      onChange(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (e) => {
    const next = parseInt(e.target.value, 10);
    if (!options.includes(next)) return;
    onChange(next);
    if (storageKey) {
      try { localStorage.setItem(storageKey, String(next)); } catch {}
    }
  };

  return (
    <label className={`text-xs text-gray-500 inline-flex items-center gap-1.5 ${className}`}>
      <span>{label}</span>
      <select
        value={value}
        onChange={handleChange}
        className="border border-gray-200 rounded px-1.5 py-0.5 text-xs bg-white cursor-pointer hover:border-gray-300 focus:border-indigo-400 focus:outline-none"
      >
        {options.map(n => <option key={n} value={n}>{n}</option>)}
      </select>
    </label>
  );
}

// Helper for parent pages — pull the stored value once at initial-state time
// so the first render uses the right pageSize, instead of flashing the default
// then snapping to the stored value on the second render.
export function readStoredPageSize(storageKey, fallback = DEFAULT_ROWS_PER_PAGE) {
  try {
    const stored = parseInt(localStorage.getItem(storageKey) || '', 10);
    if (stored && ROWS_PER_PAGE_OPTIONS.includes(stored)) return stored;
  } catch {}
  return fallback;
}
