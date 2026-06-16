const { pool } = require('../config/database');
const registry = require('./agentRegistry');

// ── Settings cache (re-read every 60s — admin changes propagate quickly) ─────
let settingsCache = null;
let settingsCacheAt = 0;
const SETTINGS_TTL = 60 * 1000;

async function getRoutingSettings() {
  if (settingsCache && (Date.now() - settingsCacheAt) < SETTINGS_TTL) return settingsCache;
  const [rows] = await pool.query(
    `SELECT \`key\`, value FROM admin_settings WHERE \`key\` IN
     ('auto_assign_enabled','assignment_mode','heavy_load_threshold',
      'heavy_load_chat_threshold','heavy_load_call_threshold',
      'block_outside_work_hours','work_hours_start','work_hours_end','work_hours_days',
      'min_billable_call_seconds','max_short_cut_forgivals_per_month')`
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  settingsCache = {
    autoAssignEnabled: map.auto_assign_enabled === '1',
    mode: map.assignment_mode || 'least_loaded',
    // Combined ticket+chat workload threshold — used for ticket routing only.
    heavyLoadThreshold: parseInt(map.heavy_load_threshold || '8', 10),
    // Per-channel thresholds — apply to every agent in the pool (admins
    // included, since opening agent view puts them in the pool).
    heavyLoadChatThreshold: parseInt(map.heavy_load_chat_threshold || '3', 10),
    heavyLoadCallThreshold: parseInt(map.heavy_load_call_threshold || '1', 10),
    blockOutsideHours: map.block_outside_work_hours === '1',
    workHoursStart: parseInt(map.work_hours_start || '10', 10),
    workHoursEnd: parseInt(map.work_hours_end || '18', 10),
    workHoursDays: (map.work_hours_days || '1,2,3,4,5,6').split(',').map(d => parseInt(d, 10)),
    // Calls shorter than this many seconds of agent-connected time don't count
    // toward the customer's monthly call_limit — prevents agent spam-cuts from
    // burning the customer's quota. Default 30s (telecom industry standard).
    // Set to 0 to count every accepted call regardless of duration.
    minBillableCallSeconds: parseInt(map.min_billable_call_seconds || '30', 10),
    // Cap on how many short calls a single customer can have forgiven per month.
    // After this many short-cuts, additional short calls START counting toward
    // their call_limit. Closes the abuse vector where a customer could spam
    // sub-threshold calls to skip the quota indefinitely. Default 3.
    // Set to 0 to forgive nothing (every short call counts). Very large number
    // (e.g. 999) effectively disables the cap.
    maxShortCutForgivalsPerMonth: parseInt(map.max_short_cut_forgivals_per_month || '3', 10),
  };
  settingsCacheAt = Date.now();
  return settingsCache;
}

function invalidateSettingsCache() { settingsCache = null; }

function isInWorkHours(settings) {
  const now = new Date();
  // Convert to IST (server may be in UTC). +5:30 offset.
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const dow = ist.getUTCDay();
  const hour = ist.getUTCHours();
  if (!settings.workHoursDays.includes(dow)) return false;
  return hour >= settings.workHoursStart && hour < settings.workHoursEnd;
}

// ── Workload calculation ─────────────────────────────────────────────────────
// channel='chat'  → only count active chats (used for chat auto-assign)
// channel='call'  → only count in-flight calls (used for call auto-assign)
// channel=other   → combined tickets + active chats (used for ticket auto-assign)
async function getWorkload(userIds, channel = null) {
  if (!userIds.length) return {};
  const ph = userIds.map(() => '?').join(',');
  let sql;
  if (channel === 'chat') {
    sql = `SELECT u.id,
             (SELECT COUNT(*) FROM chats c WHERE c.agent_id = u.id AND c.status = 'active') AS workload
           FROM users u WHERE u.id IN (${ph})`;
  } else if (channel === 'call') {
    sql = `SELECT u.id,
             (SELECT COUNT(*) FROM calls c WHERE c.agent_id = u.id AND c.status IN ('initiated','ringing','active')) AS workload
           FROM users u WHERE u.id IN (${ph})`;
  } else {
    sql = `SELECT u.id,
             ((SELECT COUNT(*) FROM tickets t WHERE t.assigned_agent_id = u.id AND t.status NOT IN ('closed','resolved'))
              + (SELECT COUNT(*) FROM chats c WHERE c.agent_id = u.id AND c.status = 'active')) AS workload
           FROM users u WHERE u.id IN (${ph})`;
  }
  const [rows] = await pool.query(sql, userIds);
  const out = {};
  rows.forEach(r => { out[r.id] = Number(r.workload); });
  return out;
}

// ── Main picker ──────────────────────────────────────────────────────────────
// Returns { agentId, reason } or { agentId: null, reason: '...' }
// options: {
//   io                  - socket.io server (to fetch agents room sockets)
//   channel             - 'ticket' | 'chat' | 'call' (for logging)
//   customerId          - DB customer id (optional — used for favoriteAgent + VIP)
//   priority            - ticket priority (optional — biases toward lighter agents)
//   skillTagsRequired   - array of required skill tags (optional — filters candidates)
//   excludeUserIds      - users to skip (e.g., busy on a call)
//   requireOnline       - default true; chat/call need online, ticket-on-creation is more forgiving
// }
// Maps the customer's pre-chat/pre-call category to an ordered list of agent
// skill_tags. The first tag in the list is the preferred specialist; later
// tags are fallbacks (used when no agent with the primary tag is available).
//   technical → agents tagged 'technical'
//   billing   → agents tagged 'primary_billing' first, then 'secondary_billing'
//   others    → agents tagged 'other'
// Falls through (no tag filter) for unknown categories or when no tagged agent
// is online, so customers are never stuck waiting on a specialist who's offline.
function categoryToTagPriority(category) {
  switch (category) {
    case 'technical': return ['technical'];
    case 'billing':   return ['primary_billing', 'secondary_billing'];
    case 'others':    return ['other'];
    default: return [];
  }
}

async function pickAgent({ io, channel, customerId = null, priority = null, skillTagsRequired = [], excludeUserIds = [], requireOnline = true, category = null }) {
  const settings = await getRoutingSettings();

  // Hard block outside work hours if configured
  if (settings.blockOutsideHours && !isInWorkHours(settings)) {
    return { agentId: null, reason: 'outside_work_hours' };
  }

  // VIP routing: if customer has a favorite agent and they're online, use them
  if (customerId) {
    const [[cust]] = await pool.query(
      'SELECT is_vip, favorite_agent_id FROM customers WHERE id = ?',
      [customerId]
    );
    if (cust?.favorite_agent_id) {
      const favStatus = registry.getStatus(cust.favorite_agent_id);
      if (favStatus === 'online' && !excludeUserIds.includes(Number(cust.favorite_agent_id))) {
        return { agentId: Number(cust.favorite_agent_id), reason: 'favorite_agent' };
      }
    }
  }

  // Build candidate pool from sockets in the 'agents' room
  let candidates = [];
  try {
    const sockets = await io.in('agents').fetchSockets();
    const seen = new Set();
    sockets.forEach(s => {
      const u = s.user;
      if (!u || seen.has(u.id) || excludeUserIds.includes(u.id)) return;
      seen.add(u.id);
      candidates.push({ id: Number(u.id), name: u.name, role: u.role });
    });
  } catch { /* io may be undefined in tests */ }

  // Fallback if no socket info available: query DB for active agents (best-effort, for tickets)
  if (!candidates.length && !requireOnline) {
    const [rows] = await pool.query(
      "SELECT id, name, role FROM users WHERE role IN ('agent','admin') AND is_active = TRUE"
    );
    candidates = rows.filter(r => !excludeUserIds.includes(r.id));
  }

  if (!candidates.length) return { agentId: null, reason: 'no_candidates' };

  // Filter by online status (skip 'away', 'busy', 'on_break')
  if (requireOnline) {
    candidates = candidates.filter(c => {
      const s = registry.getStatus(c.id);
      return s === 'online' || s === undefined; // undefined = no socket status known but socket is in room
    });
  }

  // Check break expiry (if on_break_until passed, clear and treat as online)
  if (candidates.length) {
    const ids = candidates.map(c => c.id);
    const [breakRows] = await pool.query(
      `SELECT id, on_break_until FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const now = new Date();
    for (const r of breakRows) {
      if (r.on_break_until && new Date(r.on_break_until) > now) {
        candidates = candidates.filter(c => c.id !== r.id);
      } else if (r.on_break_until) {
        // expired — clear it
        pool.query('UPDATE users SET on_break_until = NULL WHERE id = ?', [r.id]).catch(() => {});
      }
    }
  }

  if (!candidates.length) return { agentId: null, reason: 'no_online_candidates' };

  // Category-driven tag-priority filter. Try each tag in order — first one that
  // has any matching online agents wins. If NONE of the tags has a candidate,
  // we fall through to "any agent" so the customer isn't stranded (better to
  // route to a generalist than to time out).
  const tagPriority = categoryToTagPriority(category);
  let categoryMatch = null; // e.g. 'technical', 'primary_billing', 'secondary_billing', 'other'
  if (tagPriority.length) {
    const ids = candidates.map(c => c.id);
    const [skillRows] = await pool.query(
      `SELECT id, skill_tags FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const tagsByAgent = new Map();
    for (const r of skillRows) {
      let tags = [];
      try { tags = typeof r.skill_tags === 'string' ? JSON.parse(r.skill_tags) : (r.skill_tags || []); } catch { tags = []; }
      tagsByAgent.set(Number(r.id), tags);
    }
    for (const tag of tagPriority) {
      const subset = candidates.filter(c => (tagsByAgent.get(Number(c.id)) || []).includes(tag));
      if (subset.length) { candidates = subset; categoryMatch = tag; break; }
    }
  }

  // Filter by skill tags if specified
  if (skillTagsRequired.length) {
    const ids = candidates.map(c => c.id);
    const [skillRows] = await pool.query(
      `SELECT id, skill_tags FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const matching = new Set();
    for (const r of skillRows) {
      let tags = [];
      try { tags = typeof r.skill_tags === 'string' ? JSON.parse(r.skill_tags) : (r.skill_tags || []); } catch { tags = []; }
      if (skillTagsRequired.every(req => tags.includes(req))) matching.add(r.id);
    }
    const skilled = candidates.filter(c => matching.has(c.id));
    if (skilled.length) candidates = skilled;
    // If no one has the skill, fall through — we'd rather assign than drop
  }

  // Anyone in the agents room is eligible for any channel. Admins join the
  // room only while they have agent view open — that opt-in IS the consent to
  // be treated as an agent, so we don't add any further role-based filtering
  // here. Tickets, chats, and calls all route equally.
  const eligible = candidates;

  // Channel-specific threshold + workload. Chat uses active-chat count, call
  // uses active-call count, ticket uses the legacy combined ticket+chat count.
  let threshold;
  if (channel === 'chat')      threshold = settings.heavyLoadChatThreshold;
  else if (channel === 'call') threshold = settings.heavyLoadCallThreshold;
  else                         threshold = settings.heavyLoadThreshold;

  const workload = await getWorkload(eligible.map(c => c.id), channel);

  // Tier 1: candidates under the channel threshold
  const available = eligible.filter(c => (workload[c.id] || 0) < threshold);
  let pool_ = available;
  let reason = 'agent_available';

  // Final fallback: someone over threshold (rather than silently drop the
  // contact). For tickets, "all agents overloaded" still means agent-only —
  // admins were never in `eligible` so they stay excluded.
  if (!pool_.length && eligible.length) {
    pool_ = eligible;
    reason = 'all_agents_overloaded';
  }

  if (!pool_.length) return { agentId: null, reason: 'pool_empty' };

  // Pick: round-robin vs least-loaded
  let pickedId;
  if (settings.mode === 'round_robin') {
    // Fetch last_assigned_at, pick the one least-recently-assigned
    const ids = pool_.map(c => c.id);
    const [rows] = await pool.query(
      `SELECT id, last_assigned_at FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const lastMap = Object.fromEntries(rows.map(r => [r.id, r.last_assigned_at ? new Date(r.last_assigned_at).getTime() : 0]));
    pool_.sort((a, b) => (lastMap[a.id] || 0) - (lastMap[b.id] || 0));
    pickedId = pool_[0].id;
  } else {
    // Least-loaded; ties broken by lowest last_assigned_at to avoid clustering
    const ids = pool_.map(c => c.id);
    const [rows] = await pool.query(
      `SELECT id, last_assigned_at FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const lastMap = Object.fromEntries(rows.map(r => [r.id, r.last_assigned_at ? new Date(r.last_assigned_at).getTime() : 0]));
    pool_.sort((a, b) => {
      const la = workload[a.id] || 0;
      const lb = workload[b.id] || 0;
      if (la !== lb) return la - lb;
      return (lastMap[a.id] || 0) - (lastMap[b.id] || 0);
    });
    pickedId = pool_[0].id;
  }

  // Update last_assigned_at for round-robin fairness (fire-and-forget)
  pool.query('UPDATE users SET last_assigned_at = NOW() WHERE id = ?', [pickedId]).catch(() => {});

  // Suffix the routing reason with the matched specialty tag (if any) so the
  // backend logs make the path obvious — `agent_available[primary_billing]` etc.
  const finalReason = categoryMatch ? `${reason}[${categoryMatch}]` : reason;
  return { agentId: pickedId, reason: finalReason, channel };
}

module.exports = { pickAgent, getRoutingSettings, invalidateSettingsCache, isInWorkHours };
