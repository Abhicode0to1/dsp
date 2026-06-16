import clsx from 'clsx';

const planStyles = {
  free:     'bg-gray-100 text-gray-700',
  basic:    'bg-blue-100 text-blue-700',
  moderate: 'bg-purple-100 text-purple-700',
  premium:  'bg-amber-100 text-amber-700',
};

export function PlanBadge({ plan }) {
  return (
    <span data-testid={`PlanBadge-${plan || 'free'}`} className={clsx('badge capitalize', planStyles[plan] || planStyles.free)}>
      {plan || 'free'}
    </span>
  );
}

export function StatusBadge({ isActive, expiry }) {
  // Don't gate on expiry presence — free/unlimited plans have no expiry and are still active
  const active = !!isActive;
  return (
    <span data-testid={`StatusBadge-${active ? 'active' : 'expired'}`} className={clsx('badge', active ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}>
      <span className={clsx('w-1.5 h-1.5 rounded-full mr-1.5', active ? 'bg-green-500' : 'bg-red-500')} />
      {active ? 'Active' : 'Expired'}
    </span>
  );
}

export function TicketStatusBadge({ status }) {
  const styles = {
    open:    'bg-blue-100 text-blue-700',
    pending: 'bg-yellow-100 text-yellow-700',
    closed:  'bg-gray-100 text-gray-600',
  };
  return (
    <span data-testid={`TicketStatusBadge-${status || 'open'}`} className={clsx('badge capitalize', styles[status] || styles.open)}>
      {status}
    </span>
  );
}

export function PriorityBadge({ priority }) {
  const styles = {
    low:    'bg-gray-100 text-gray-600',
    normal: 'bg-blue-100 text-blue-700',
    medium: 'bg-orange-100 text-orange-700',
    high:   'bg-red-100 text-red-700',
    urgent: 'bg-red-600 text-white',
  };
  return (
    <span data-testid={`PriorityBadge-${priority || 'normal'}`} className={clsx('badge capitalize', styles[priority] || styles.normal)}>
      {priority}
    </span>
  );
}
