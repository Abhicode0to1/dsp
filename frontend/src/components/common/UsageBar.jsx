import clsx from 'clsx';

export default function UsageBar({ label, used, limit, icon: Icon, color = 'indigo', onClick }) {
  const pct = limit ? Math.min((used / limit) * 100, 100) : 0;
  const isUnlimited = limit === null;

  const colorMap = {
    indigo: { bar: 'bg-indigo-500', text: 'text-indigo-600', bg: 'bg-indigo-50' },
    green:  { bar: 'bg-green-500',  text: 'text-green-600',  bg: 'bg-green-50'  },
    amber:  { bar: 'bg-amber-500',  text: 'text-amber-600',  bg: 'bg-amber-50'  },
    orange: { bar: 'bg-orange-500', text: 'text-orange-600', bg: 'bg-orange-50' },
    red:    { bar: 'bg-red-500',    text: 'text-red-600',    bg: 'bg-red-50'    },
  };

  const autoColor = pct >= 90 ? 'red' : pct >= 70 ? 'orange' : color;
  const c = colorMap[autoColor] || colorMap.indigo;

  // Tooltip explains that in-progress chats/calls also count toward the cap.
  // Without this customers complain "why did my usage jump while I'm mid-chat?".
  const tooltip = isUnlimited
    ? `${used} ${label.toLowerCase().replace(' usage', '')} used so far this billing period.`
    : `${used} of ${limit} used this billing period. In-progress sessions (currently waiting or active) also count — they're released back into your quota only if they end without ever engaging an agent.`;

  // Slugify the label for a stable testid (e.g. "Chat Usage" → "chat-usage")
  const slug = String(label || 'usage').toLowerCase().trim().replace(/\s+/g, '-');

  return (
    <div
      data-testid={`UsageBar-${slug}`}
      className={clsx('card p-4', c.bg, onClick && 'cursor-pointer hover:shadow-md transition-shadow')}
      onClick={onClick}
      title={tooltip}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          {Icon && <Icon className={clsx('w-4 h-4', c.text)} />}
          {label}
        </div>
        <span data-testid={`UsageBar-${slug}-Value`} className={clsx('text-sm font-bold', c.text)}>
          {isUnlimited ? `${used} used` : `${used} / ${limit}`}
        </span>
      </div>
      {!isUnlimited && (
        <div className="w-full bg-white rounded-full h-2 overflow-hidden">
          <div
            data-testid={`UsageBar-${slug}-Progress`}
            className={clsx('h-2 rounded-full transition-all duration-500', c.bar)}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      {!isUnlimited && (
        <p className="text-xs text-gray-500 mt-1">
          {limit - used} remaining this month
        </p>
      )}
    </div>
  );
}
