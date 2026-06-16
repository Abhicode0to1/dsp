export function SkeletonLine({ className = '' }) {
  return <div className={`skeleton-shimmer rounded ${className}`} />;
}

export function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="flex items-center gap-2 mb-3">
        <SkeletonLine className="h-3 w-12" />
        <SkeletonLine className="h-4 w-14 rounded-full" />
      </div>
      <SkeletonLine className="h-4 w-4/5 mb-2" />
      <SkeletonLine className="h-3 w-1/2 mb-4" />
      <div className="flex gap-2">
        <SkeletonLine className="h-6 w-14 rounded-lg" />
        <SkeletonLine className="h-6 w-20 rounded-lg" />
      </div>
    </div>
  );
}

export function SkeletonTableRows({ rows = 5, cols = 6 }) {
  const widths = ['w-10', 'w-48', 'w-16', 'w-14', 'w-24', 'w-20'];
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td className="px-4 py-3 w-1" />
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <SkeletonLine className={`h-3 ${widths[j] || 'w-20'}`} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function SkeletonCards({ count = 6 }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {Array.from({ length: count }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}
