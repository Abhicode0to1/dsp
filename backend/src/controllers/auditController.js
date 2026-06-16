const { pool } = require('../config/database');

// Whitelisted sort columns — protects against SQL injection from the
// frontend's sort= param.
const SORT_COLUMNS = {
  created_at: 'created_at',
  actor_name: 'actor_name',
  action:     'action',
  entity_id:  'entity_id',
};

// Sensitive actions surfaced on the KPI summary tile. Tweak this list as new
// actions are added — anything that materially affects an account's state or
// permissions belongs here.
const SENSITIVE_ACTIONS = [
  'agent.promoted_to_admin',
  'agent.demoted_to_agent',
  'password_changed',
  'plan_changed_bulk',
  'overrides_cleared',
  'overrides_updated',
];

function buildWhere({ entity_type, entity_id, actor_id, actor_role, customer_id, from, to, search, actions }) {
  let where = 'WHERE 1=1';
  const params = [];
  if (entity_type) { where += ' AND entity_type = ?'; params.push(entity_type); }
  if (entity_id)   { where += ' AND entity_id = ?';   params.push(entity_id); }
  if (actor_id)    { where += ' AND actor_id = ?';    params.push(actor_id); }
  if (actor_role && ['admin', 'agent', 'customer', 'system'].includes(String(actor_role))) {
    where += ' AND actor_role = ?'; params.push(actor_role);
  }
  if (customer_id) {
    where += ` AND (
      (entity_type = 'customer' AND entity_id = ?)
      OR (entity_type = 'user' AND entity_id = (SELECT user_id FROM customers WHERE id = ?))
    )`;
    params.push(customer_id, customer_id);
  }
  if (from) { where += ' AND created_at >= ?'; params.push(from); }
  if (to)   { where += ' AND created_at <= ?'; params.push(to.length === 10 ? to + ' 23:59:59' : to); }
  if (search) {
    const q = `%${search.trim()}%`;
    where += ' AND (actor_name LIKE ? OR action LIKE ? OR CAST(entity_id AS CHAR) LIKE ?)';
    params.push(q, q, q);
  }
  // `actions` accepts a CSV of action codes — used by the "Sensitive" KPI tile
  // to filter the table to just promotions / password changes / overrides /
  // plan-changes in one query. Empty or malformed entries are skipped, so a
  // junk value can't break the WHERE clause.
  if (actions) {
    const list = String(actions).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) {
      where += ` AND action IN (${list.map(() => '?').join(',')})`;
      params.push(...list);
    }
  }
  return { where, params };
}

exports.getLogs = async (req, res) => {
  try {
    const {
      entity_type, entity_id, actor_id, actor_role, customer_id, from, to, search, actions,
      page = 1, limit = 50,
      sort = 'created_at', order = 'desc',
    } = req.query;
    const offset = req.query.offset != null
      ? parseInt(req.query.offset, 10) || 0
      : (parseInt(page) - 1) * parseInt(limit);

    const sortCol = SORT_COLUMNS[String(sort)] || 'created_at';
    const sortDir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const { where, params } = buildWhere({ entity_type, entity_id, actor_id, actor_role, customer_id, from, to, search, actions });

    const [logs] = await pool.query(
      `SELECT * FROM audit_log ${where} ORDER BY ${sortCol} ${sortDir}, id DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM audit_log ${where}`, params
    );
    res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('[getLogs]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/audit/summary — KPI tile counts
//   today        = rows in the last 24 h
//   sensitive_7d = SENSITIVE_ACTIONS in the last 7 days
//   self_7d      = actor_role='customer' in the last 7 days
exports.getSummary = async (req, res) => {
  try {
    const sensitivePh = SENSITIVE_ACTIONS.map(() => '?').join(',');
    const [[row]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM audit_log WHERE created_at >= NOW() - INTERVAL 1 DAY)  AS today,
         (SELECT COUNT(*) FROM audit_log
            WHERE created_at >= NOW() - INTERVAL 7 DAY
              AND action IN (${sensitivePh}))                                          AS sensitive_7d,
         (SELECT COUNT(*) FROM audit_log
            WHERE created_at >= NOW() - INTERVAL 7 DAY
              AND actor_role = 'customer')                                             AS self_7d`,
      SENSITIVE_ACTIONS
    );
    res.json({
      today:        Number(row.today) || 0,
      sensitive_7d: Number(row.sensitive_7d) || 0,
      self_7d:      Number(row.self_7d) || 0,
      sensitive_actions: SENSITIVE_ACTIONS,
    });
  } catch (err) {
    console.error('[audit summary]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/audit/export.csv — streams the current filtered set as CSV.
// Respects ALL the same filters as /audit (search/date/entity/actor/etc.)
// so admin downloads exactly what they're looking at, no surprises.
exports.exportCsv = async (req, res) => {
  try {
    const { entity_type, entity_id, actor_id, actor_role, customer_id, from, to, search, actions,
            sort = 'created_at', order = 'desc' } = req.query;
    const sortCol = SORT_COLUMNS[String(sort)] || 'created_at';
    const sortDir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const { where, params } = buildWhere({ entity_type, entity_id, actor_id, actor_role, customer_id, from, to, search, actions });

    // Cap at 50k rows defensively — exports beyond that should go through
    // the DB directly rather than a web download.
    const [logs] = await pool.query(
      `SELECT id, created_at, actor_id, actor_name, actor_role, action,
              entity_type, entity_id, old_value, new_value, ip_address
       FROM audit_log ${where} ORDER BY ${sortCol} ${sortDir}, id DESC LIMIT 50000`,
      params
    );

    const csvEscape = (v) => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : String(v);
      // Quote if contains comma, quote, or newline; escape inner quotes
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const header = ['id', 'created_at', 'actor_id', 'actor_name', 'actor_role',
                    'action', 'entity_type', 'entity_id', 'old_value', 'new_value', 'ip_address'];
    const lines = [header.join(',')];
    for (const r of logs) {
      lines.push(header.map(h => {
        const v = r[h];
        if (h === 'created_at' && v) return csvEscape(new Date(v).toISOString());
        return csvEscape(v);
      }).join(','));
    }

    const now = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${now}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[audit exportCsv]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getActors = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT actor_id, actor_name, actor_role, COUNT(*) AS action_count
       FROM audit_log
       WHERE actor_id IS NOT NULL
       GROUP BY actor_id, actor_name, actor_role
       ORDER BY actor_role, actor_name`
    );
    res.json({ actors: rows });
  } catch (err) {
    console.error('[getActors]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Middleware to log actions
exports.log = (action, entityType) => async (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400 && req.user) {
      const entityId = body?.ticket?.id || body?.id || req.params?.id || null;
      pool.query(
        'INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity_type, entity_id, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [req.user.id, req.user.name, req.user.role, action, entityType, entityId, req.ip]
      ).catch(() => {});
    }
    return originalJson(body);
  };
  next();
};
