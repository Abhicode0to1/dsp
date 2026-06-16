// Filter + column specs the Custom Report builder uses to render its form
// and that get persisted in `custom_reports.filters` + `custom_reports.columns`.
//
// Filter types recognised by the builder:
//   select        — fixed-option dropdown (single value sent under filter.key)
//   text / number — free input
//   compound      — single dropdown whose options each map to a SET of backend
//                   params. Lets us collapse e.g. plan / plan_group / no_plan
//                   into one widget the admin actually understands.
//   customer-picker — dropdown of customer names, fed by /admin/customers
//   agent-picker    — dropdown of agent names, fed by /admin/agents.
//                     Includes "Unassigned" → sends no_agent=true.
//
// The builder serialises the form's combined-params object directly — saved
// reports' `filters` field stores exactly what the backend drill endpoints
// already accept, no transformation on read.

export const RESOURCE_LABELS = {
  tickets:   'Tickets',
  invoices:  'Invoices',
  calls:     'Calls',
  chats:     'Chats',
  customers: 'Customers',
  agents:    'Agents',
};

// Compound dropdown options for Plan. Each option carries the EXACT params it
// should send to the backend. Empty `params` means "no filter" (the "— any —"
// default). Shared across resources that filter by customer-plan (Tickets,
// Customers — invoices use a simpler plain `plan` since every invoice has a
// plan_id FK).
const PLAN_COMPOUND_OPTIONS = [
  { value: '',          label: '— any —',                              params: {} },
  { value: 'free',      label: 'Free',                                 params: { plan: 'free' } },
  { value: 'basic',     label: 'Basic',                                params: { plan: 'basic' } },
  { value: 'moderate',  label: 'Moderate',                             params: { plan: 'moderate' } },
  { value: 'premium',   label: 'Premium',                              params: { plan: 'premium' } },
  { value: 'paid',      label: 'Paid (basic + moderate + premium)',    params: { plan_group: 'paid' } },
  { value: 'noplan',    label: 'Customers with no plan',               params: { no_plan: 'true' } },
];

// Same idea but without the "no plan" bucket — for tickets, "no plan" is a
// meaningful filter; for invoices it's always meaningless.
const PLAN_SIMPLE_OPTIONS = [
  { value: '',          label: '— any —',                              params: {} },
  { value: 'free',      label: 'Free',                                 params: { plan: 'free' } },
  { value: 'basic',     label: 'Basic',                                params: { plan: 'basic' } },
  { value: 'moderate',  label: 'Moderate',                             params: { plan: 'moderate' } },
  { value: 'premium',   label: 'Premium',                              params: { plan: 'premium' } },
];

export const FILTER_SPEC = {
  tickets: [
    { key: 'status',       label: 'Status',       type: 'select', options: ['open', 'pending', 'closed'] },
    { key: 'priority',     label: 'Priority',     type: 'select', options: ['low', 'normal', 'medium', 'high', 'urgent'] },
    { key: 'plan_pick',    label: 'Plan',         type: 'compound', options: PLAN_COMPOUND_OPTIONS },
    { key: 'agent_pick',   label: 'Agent',        type: 'agent-picker' },
    { key: 'customer_pick',label: 'Customer',     type: 'customer-picker' },
    { key: 'request_type', label: 'Request type', type: 'text' },
    { key: 'sla_met',      label: 'SLA met',      type: 'select', options: ['true', 'false'] },
  ],
  invoices: [
    { key: 'status',     label: 'Status', type: 'select', options: ['paid', 'pending', 'overdue'] },
    { key: 'plan_pick',  label: 'Plan',   type: 'compound', options: PLAN_SIMPLE_OPTIONS },
  ],
  calls: [
    { key: 'status',       label: 'Status',   type: 'select', options: ['initiated', 'ringing', 'active', 'ended', 'failed', 'missed'] },
    { key: 'agent_pick',   label: 'Agent',    type: 'agent-picker' },
    { key: 'customer_pick',label: 'Customer', type: 'customer-picker' },
  ],
  chats: [
    { key: 'status',       label: 'Status',   type: 'select', options: ['waiting', 'active', 'closed', 'ended'] },
    { key: 'agent_pick',   label: 'Agent',    type: 'agent-picker' },
    { key: 'customer_pick',label: 'Customer', type: 'customer-picker' },
  ],
  customers: [
    { key: 'plan_pick',   label: 'Plan', type: 'compound', options: PLAN_COMPOUND_OPTIONS },
  ],
  agents: [
    { key: 'role',      label: 'Role',       type: 'select', options: ['agent', 'admin'] },
    { key: 'status',    label: 'Status',     type: 'select', options: ['active', 'inactive'] },
    { key: 'skill_tag', label: 'Skill tag',  type: 'text', placeholder: 'e.g. technical · primary_billing' },
  ],
};

// Column spec — keys must match the response shape of the corresponding
// drill endpoint. Default-on columns are the most commonly useful ones for
// each resource; the admin can include any subset.
export const COLUMN_SPEC = {
  tickets: [
    { key: 'id',             label: 'ID',         defaultOn: true  },
    { key: 'subject',        label: 'Subject',    defaultOn: true  },
    { key: 'customer_name',  label: 'Customer',   defaultOn: true  },
    { key: 'customer_email', label: 'Email',      defaultOn: false },
    { key: 'domain',         label: 'Domain',     defaultOn: false },
    { key: 'plan_name',      label: 'Plan',       defaultOn: false },
    { key: 'agent_name',     label: 'Agent',      defaultOn: true  },
    { key: 'status',         label: 'Status',     defaultOn: true  },
    { key: 'priority',       label: 'Priority',   defaultOn: true  },
    { key: 'request_type',   label: 'Type',       defaultOn: false },
    { key: 'created_at',     label: 'Created',    defaultOn: true  },
    { key: 'closed_at',      label: 'Closed',     defaultOn: false },
    { key: 'sla_resolve_due',label: 'SLA due',    defaultOn: false },
  ],
  invoices: [
    { key: 'id',            label: 'ID',         defaultOn: true  },
    { key: 'customer_name', label: 'Customer',   defaultOn: true  },
    { key: 'domain',        label: 'Domain',     defaultOn: false },
    { key: 'plan_name',     label: 'Plan',       defaultOn: true  },
    { key: 'final_price',   label: 'Amount',     defaultOn: true,  align: 'right' },
    { key: 'subtotal',      label: 'Subtotal',   defaultOn: false, align: 'right' },
    { key: 'gst_amount',    label: 'GST',        defaultOn: false, align: 'right' },
    { key: 'status',        label: 'Status',     defaultOn: true  },
    { key: 'created_at',    label: 'Created',    defaultOn: true  },
    { key: 'due_date',      label: 'Due',        defaultOn: false },
  ],
  calls: [
    { key: 'id',             label: 'ID',           defaultOn: true  },
    { key: 'customer_name',  label: 'Customer',     defaultOn: true  },
    { key: 'agent_name',     label: 'Agent',        defaultOn: true  },
    { key: 'status',         label: 'Status',       defaultOn: true  },
    { key: 'duration',       label: 'Duration',     defaultOn: true,  align: 'right' },
    { key: 'initiated_by',   label: 'Started by',   defaultOn: false },
    { key: 'created_at',     label: 'Created',      defaultOn: true  },
    { key: 'call_start_time',label: 'Started at',   defaultOn: false },
    { key: 'call_end_time',  label: 'Ended at',     defaultOn: false },
    { key: 'virtual_number', label: 'Virtual #',    defaultOn: false },
  ],
  chats: [
    { key: 'id',            label: 'ID',         defaultOn: true  },
    { key: 'customer_name', label: 'Customer',   defaultOn: true  },
    { key: 'agent_name',    label: 'Agent',      defaultOn: true  },
    { key: 'status',        label: 'Status',     defaultOn: true  },
    { key: 'category',      label: 'Category',   defaultOn: false },
    { key: 'department',    label: 'Department', defaultOn: false },
    { key: 'created_at',    label: 'Created',    defaultOn: true  },
    { key: 'accepted_at',   label: 'Accepted',   defaultOn: false },
    { key: 'closed_at',     label: 'Closed',     defaultOn: false },
  ],
  customers: [
    { key: 'id',            label: 'ID',          defaultOn: true  },
    { key: 'customer_name', label: 'Name',        defaultOn: true  },
    { key: 'email',         label: 'Email',       defaultOn: true  },
    { key: 'domain',        label: 'Domain',      defaultOn: true  },
    { key: 'plan_name',     label: 'Plan',        defaultOn: true  },
    { key: 'created_at',    label: 'Joined',      defaultOn: true  },
    { key: 'plan_expiry',   label: 'Plan expiry', defaultOn: false },
  ],
  agents: [
    { key: 'id',                label: 'ID',                defaultOn: false },
    { key: 'name',              label: 'Name',              defaultOn: true  },
    { key: 'email',             label: 'Email',             defaultOn: false },
    { key: 'role',              label: 'Role',              defaultOn: true  },
    { key: 'status_label',      label: 'Status',            defaultOn: true  },
    { key: 'skill_tags',        label: 'Skill tags',        defaultOn: false },
    { key: 'tickets_resolved',  label: 'Tickets resolved',  defaultOn: true,  align: 'right' },
    { key: 'chats_handled',     label: 'Chats handled',     defaultOn: true,  align: 'right' },
    { key: 'calls_answered',    label: 'Calls answered',    defaultOn: true,  align: 'right' },
    { key: 'avg_csat',          label: 'Avg CSAT',          defaultOn: true,  align: 'right' },
  ],
};

// All the param-keys a given filter type can write to / read from. Used by
// the builder to know which keys to clear when a widget value changes (so
// we don't leak stale params from previously-set filters).
export function paramKeysFor(filter) {
  if (filter.type === 'compound') {
    const keys = new Set();
    for (const opt of filter.options) Object.keys(opt.params).forEach(k => keys.add(k));
    return [...keys];
  }
  if (filter.type === 'agent-picker')    return ['agent_id', 'no_agent'];
  if (filter.type === 'customer-picker') return ['customer_id'];
  return [filter.key];
}

// Inverse: given the current backend-params blob, what value should the
// compound / picker dropdown be showing? Used when editing an existing
// saved report (its filters field IS the backend params blob).
export function widgetValueFromParams(filter, params) {
  if (filter.type === 'compound') {
    // Pick the option whose params subset matches.
    for (const opt of filter.options) {
      const keys = Object.keys(opt.params);
      if (keys.length === 0) continue;
      if (keys.every(k => params[k] === opt.params[k])) return opt.value;
    }
    return '';
  }
  if (filter.type === 'agent-picker') {
    if (params.no_agent === 'true') return '__unassigned__';
    return params.agent_id ?? '';
  }
  if (filter.type === 'customer-picker') {
    return params.customer_id ?? '';
  }
  return params[filter.key] ?? '';
}

// Inverse-direction helper: given the current builder state for one widget,
// patch the params object accordingly. Always clears the widget's owned
// keys first so old values don't linger when the admin switches options.
export function applyWidgetValue(filter, params, value) {
  const next = { ...params };
  for (const k of paramKeysFor(filter)) delete next[k];
  if (filter.type === 'compound') {
    const opt = filter.options.find(o => o.value === value);
    if (opt) Object.assign(next, opt.params);
    return next;
  }
  if (filter.type === 'agent-picker') {
    if (value === '__unassigned__') next.no_agent = 'true';
    else if (value !== '' && value != null) next.agent_id = value;
    return next;
  }
  if (filter.type === 'customer-picker') {
    if (value !== '' && value != null) next.customer_id = value;
    return next;
  }
  if (value !== '' && value != null) next[filter.key] = value;
  return next;
}

// Cell formatter applied to every column generically — same rules the
// DrillDownModal uses so saved reports render identically to ad-hoc drills.
export function formatCustomCell(value, columnKey) {
  if (value == null) return '—';
  if (/_at$|_due$|_date$|_time$/.test(columnKey)) {
    try { return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return String(value); }
  }
  if (columnKey === 'final_price' || columnKey === 'subtotal' || columnKey === 'gst_amount') {
    return `₹${Number(value).toLocaleString('en-IN')}`;
  }
  if (columnKey === 'duration' && Number.isFinite(value)) {
    return `${Math.floor(value / 60)}m ${value % 60}s`;
  }
  if (typeof value === 'string' && /^(status|priority|plan_name|category|initiated_by|role)$/.test(columnKey)) {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  if (columnKey === 'avg_csat' && value != null) {
    return `${value}★`;
  }
  return String(value);
}
