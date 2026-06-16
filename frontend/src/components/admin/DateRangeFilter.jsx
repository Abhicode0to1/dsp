import { useState } from 'react';
import { Calendar } from 'lucide-react';
import clsx from 'clsx';

// Page-level date-range picker for the Reports page. Five preset buttons
// (7 / 30 / 90 days, This year, All time) plus a custom range with two
// `<input type="date">` fields. Calls `onChange({ from, to, presetId })`
// whenever the selection changes. `from` and `to` are 'YYYY-MM-DD' strings
// or `null` for the All-time preset.
//
// Persistence is owned by the parent (Reports.jsx) — this component just
// renders and emits change events. Keeps state shape simple and the parent
// can decide whether to write to localStorage.

const PRESETS = [
  { id: '7',    label: 'Last 7 days'  },
  { id: '30',   label: 'Last 30 days' },
  { id: '90',   label: 'Last 90 days' },
  { id: 'year', label: 'This year'    },
  { id: 'all',  label: 'All time'     },
];

// Resolve a preset to { from, to } (or null for 'all'). Always emits ISO date
// strings — the backend keys off those.
function resolvePreset(id) {
  if (id === 'all') return { from: null, to: null };
  const now = new Date();
  const isoDay = (d) => d.toISOString().slice(0, 10);
  if (id === 'year') {
    const jan1 = new Date(now.getFullYear(), 0, 1);
    return { from: isoDay(jan1), to: isoDay(now) };
  }
  const days = parseInt(id, 10);
  if (!isFinite(days)) return { from: null, to: null };
  const start = new Date(now);
  start.setDate(start.getDate() - days + 1);
  return { from: isoDay(start), to: isoDay(now) };
}

export default function DateRangeFilter({ value, onChange }) {
  // `value` shape: { presetId, from, to } — presetId is 'custom' when the
  // user has picked specific dates.
  const presetId = value?.presetId || '30';
  const [customFrom, setCustomFrom] = useState(value?.from || '');
  const [customTo,   setCustomTo]   = useState(value?.to   || '');

  const selectPreset = (id) => {
    const { from, to } = resolvePreset(id);
    onChange({ presetId: id, from, to });
  };

  const applyCustom = () => {
    if (!customFrom || !customTo) return;
    if (customFrom > customTo) return;
    onChange({ presetId: 'custom', from: customFrom, to: customTo });
  };

  const label = presetId === 'custom'
    ? `${value?.from || '?'} → ${value?.to || '?'}`
    : (PRESETS.find(p => p.id === presetId)?.label || 'Last 30 days');

  return (
    <div className="card p-3 flex flex-wrap items-center gap-2 mb-4">
      <div className="flex items-center gap-1.5 text-xs text-gray-500 font-medium pr-2 border-r border-gray-100">
        <Calendar className="w-3.5 h-3.5" />
        <span>Date range:</span>
        <span className="text-gray-800 font-semibold">{label}</span>
      </div>
      {PRESETS.map(p => (
        <button
          key={p.id}
          type="button"
          onClick={() => selectPreset(p.id)}
          className={clsx(
            'text-xs px-2.5 py-1 rounded-md border transition-colors',
            presetId === p.id
              ? 'bg-indigo-600 text-white border-indigo-600'
              : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300 hover:bg-gray-50'
          )}
        >
          {p.label}
        </button>
      ))}
      <div className="flex items-center gap-1.5 pl-2 border-l border-gray-100 ml-auto">
        <input
          type="date"
          value={customFrom}
          onChange={e => setCustomFrom(e.target.value)}
          className="text-xs border border-gray-200 rounded px-2 py-1"
        />
        <span className="text-xs text-gray-400">to</span>
        <input
          type="date"
          value={customTo}
          onChange={e => setCustomTo(e.target.value)}
          className="text-xs border border-gray-200 rounded px-2 py-1"
        />
        <button
          type="button"
          onClick={applyCustom}
          disabled={!customFrom || !customTo || customFrom > customTo}
          className="text-xs px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
