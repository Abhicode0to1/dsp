const { pool } = require('../config/database');
const { sendRatingRequestEmail } = require('../utils/emailUtils');

exports.submitRating = async (req, res) => {
  try {
    const { ref_type, ref_id, score, comment } = req.body;
    if (!ref_type || !ref_id || !score) return res.status(400).json({ error: 'ref_type, ref_id, score required' });
    if (score < 1 || score > 5) return res.status(400).json({ error: 'Score must be 1-5' });

    const [[cust]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
    if (!cust) return res.status(403).json({ error: 'Customer only' });

    // Find agent for this ref — and verify customer owns it
    let agentId = null;
    if (ref_type === 'ticket') {
      const [[t]] = await pool.query('SELECT assigned_agent_id FROM tickets WHERE id = ? AND customer_id = ?', [ref_id, cust.id]);
      if (!t) return res.status(403).json({ error: 'Forbidden' });
      agentId = t.assigned_agent_id || null;
    } else if (ref_type === 'call') {
      const [[c]] = await pool.query('SELECT agent_id FROM calls WHERE id = ? AND customer_id = ?', [ref_id, cust.id]);
      if (!c) return res.status(403).json({ error: 'Forbidden' });
      agentId = c.agent_id || null;
    }

    const [result] = await pool.query(
      `INSERT INTO ratings (ref_type, ref_id, customer_id, agent_id, score, comment)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE score = VALUES(score), comment = VALUES(comment)`,
      [ref_type, ref_id, cust.id, agentId, score, comment || null]
    );

    res.status(201).json({ message: 'Rating submitted', id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getRating = async (req, res) => {
  try {
    const { ref_type, ref_id } = req.query;

    if (req.user.role === 'customer') {
      const [[cust]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
      if (!cust) return res.status(403).json({ error: 'Forbidden' });
      let owned = false;
      if (ref_type === 'ticket') {
        const [[t]] = await pool.query('SELECT id FROM tickets WHERE id = ? AND customer_id = ?', [ref_id, cust.id]);
        owned = !!t;
      } else if (ref_type === 'call') {
        const [[c]] = await pool.query('SELECT id FROM calls WHERE id = ? AND customer_id = ?', [ref_id, cust.id]);
        owned = !!c;
      }
      if (!owned) return res.status(403).json({ error: 'Forbidden' });
    }

    const [[rating]] = await pool.query(
      'SELECT * FROM ratings WHERE ref_type = ? AND ref_id = ?', [ref_type, ref_id]
    );
    res.json({ rating: rating || null });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getCsatStats = async (req, res) => {
  try {
    const [[overall]] = await pool.query(`
      SELECT
        ROUND(AVG(score), 2) AS avg_score,
        COUNT(*) AS total_ratings,
        SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) AS positive,
        SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END) AS negative
      FROM ratings
    `);

    const [byAgent] = await pool.query(`
      SELECT u.name AS agent_name, ROUND(AVG(r.score), 2) AS avg_score, COUNT(*) AS count
      FROM ratings r
      JOIN users u ON u.id = r.agent_id
      WHERE r.agent_id IS NOT NULL
      GROUP BY r.agent_id, u.name
      ORDER BY avg_score DESC
    `);

    const [distribution] = await pool.query(`
      SELECT score, COUNT(*) AS count FROM ratings GROUP BY score ORDER BY score
    `);

    res.json({ overall, byAgent, distribution });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getAgentPerformance = async (req, res) => {
  try {
    const days = req.query.days && req.query.days !== 'all' ? parseInt(req.query.days) : null;
    // Bare `created_at` is ambiguous — every table in these joins (chat_ratings,
    // ratings, users) has its own. Use a placeholder that each call site swaps
    // for the right alias before injecting into the WHERE.
    const dateClauseFor = (alias) =>
      days ? `AND ${alias}.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)` : '';

    const [chatRows] = await pool.query(`
      SELECT cr.agent_id, u.name AS agent_name,
             ROUND(AVG(cr.rating), 2) AS avg_chat_rating,
             COUNT(*) AS total_chat_ratings,
             SUM(cr.rating = 1) AS c1, SUM(cr.rating = 2) AS c2,
             SUM(cr.rating = 3) AS c3, SUM(cr.rating = 4) AS c4,
             SUM(cr.rating = 5) AS c5
      FROM chat_ratings cr
      JOIN users u ON u.id = cr.agent_id
      WHERE cr.agent_id IS NOT NULL ${dateClauseFor('cr')}
      GROUP BY cr.agent_id, u.name
    `);

    const [ticketRows] = await pool.query(`
      SELECT r.agent_id, u.name AS agent_name,
             ROUND(AVG(r.score), 2) AS avg_ticket_rating,
             COUNT(*) AS total_ticket_ratings,
             SUM(r.score = 1) AS c1, SUM(r.score = 2) AS c2,
             SUM(r.score = 3) AS c3, SUM(r.score = 4) AS c4,
             SUM(r.score = 5) AS c5
      FROM ratings r
      JOIN users u ON u.id = r.agent_id
      WHERE r.agent_id IS NOT NULL AND r.ref_type = 'ticket' ${dateClauseFor('r')}
      GROUP BY r.agent_id, u.name
    `);

    // Merge by agent_id
    const map = {};
    chatRows.forEach(a => {
      map[a.agent_id] = { agent_id: a.agent_id, agent_name: a.agent_name,
        avg_chat_rating: a.avg_chat_rating, total_chat_ratings: Number(a.total_chat_ratings),
        avg_ticket_rating: null, total_ticket_ratings: 0,
        dist: { 1: Number(a.c1), 2: Number(a.c2), 3: Number(a.c3), 4: Number(a.c4), 5: Number(a.c5) } };
    });
    ticketRows.forEach(a => {
      if (!map[a.agent_id]) {
        map[a.agent_id] = { agent_id: a.agent_id, agent_name: a.agent_name,
          avg_chat_rating: null, total_chat_ratings: 0, dist: { 1:0, 2:0, 3:0, 4:0, 5:0 } };
      }
      map[a.agent_id].avg_ticket_rating = a.avg_ticket_rating;
      map[a.agent_id].total_ticket_ratings = Number(a.total_ticket_ratings);
      map[a.agent_id].dist[1] += Number(a.c1);
      map[a.agent_id].dist[2] += Number(a.c2);
      map[a.agent_id].dist[3] += Number(a.c3);
      map[a.agent_id].dist[4] += Number(a.c4);
      map[a.agent_id].dist[5] += Number(a.c5);
    });

    const agents = Object.values(map).map(a => {
      const total = a.total_chat_ratings + a.total_ticket_ratings;
      const weightedSum = (a.avg_chat_rating || 0) * a.total_chat_ratings +
                          (a.avg_ticket_rating || 0) * a.total_ticket_ratings;
      const combined_avg = total > 0 ? Math.round((weightedSum / total) * 100) / 100 : null;
      const positive = (a.dist[4] || 0) + (a.dist[5] || 0);
      return { ...a, total_ratings: total, combined_avg, positive };
    }).sort((a, b) => (b.combined_avg || 0) - (a.combined_avg || 0));

    // Overall summary
    const totalRatings = agents.reduce((s, a) => s + a.total_ratings, 0);
    const totalPositive = agents.reduce((s, a) => s + a.positive, 0);
    const allAvg = totalRatings > 0
      ? Math.round(agents.reduce((s, a) => s + (a.combined_avg || 0) * a.total_ratings, 0) / totalRatings * 100) / 100
      : null;

    // Recent low ratings (1–2 stars)
    const [recentLow] = await pool.query(`
      (SELECT 'chat' AS type, cr.chat_id AS ref_id, cr.rating AS score, cr.comment,
              u.name AS agent_name, cr.created_at
       FROM chat_ratings cr LEFT JOIN users u ON u.id = cr.agent_id
       WHERE cr.rating <= 2 ${dateClauseFor('cr')})
      UNION ALL
      (SELECT 'ticket' AS type, r.ref_id, r.score, r.comment,
              u.name AS agent_name, r.created_at
       FROM ratings r LEFT JOIN users u ON u.id = r.agent_id
       WHERE r.score <= 2 AND r.ref_type = 'ticket' ${dateClauseFor('r')})
      ORDER BY created_at DESC LIMIT 15
    `);

    res.json({ agents, summary: { avg_score: allAvg, total_ratings: totalRatings, positive: totalPositive }, recentLow });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /admin/performance/agent/:id/ratings?days=N
// Returns every individual rating (chat + ticket) the agent has received, with
// star score, customer comment, customer name, ref id, and timestamp. Used by
// the click-into-agent drawer on the Performance page so admins can read what
// customers actually wrote — both praise and complaints — not just the totals.
exports.getAgentReviews = async (req, res) => {
  try {
    const agentId = Number(req.params.id);
    if (!agentId) return res.status(400).json({ error: 'Agent id required' });

    const days = req.query.days && req.query.days !== 'all' ? parseInt(req.query.days) : null;
    // Same alias-qualified date clause pattern as getAgentPerformance — bare
    // `created_at` is ambiguous when joining users, ratings, customers etc.
    const dateClauseFor = (alias) =>
      days ? `AND ${alias}.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)` : '';

    // UNION ALL of both rating tables. Each row gets a `type` discriminator
    // ('chat' | 'ticket') and a `ref_id` pointing back at the original chat or
    // ticket for further drill-down. Customer name path differs by source:
    //   chat_ratings  → chats → customers → users
    //   ratings       → customers → users (customer_id is on the row)
    // ORDER + LIMIT applies to the union as a whole.
    const [reviews] = await pool.query(`
      (SELECT 'chat' AS type,
              cr.chat_id AS ref_id,
              cr.rating AS score,
              cr.comment,
              cr.created_at,
              cu.name AS customer_name
       FROM chat_ratings cr
       LEFT JOIN chats ch    ON ch.id = cr.chat_id
       LEFT JOIN customers c ON c.id = ch.customer_id
       LEFT JOIN users cu    ON cu.id = c.user_id
       WHERE cr.agent_id = ? ${dateClauseFor('cr')})
      UNION ALL
      (SELECT 'ticket' AS type,
              r.ref_id,
              r.score,
              r.comment,
              r.created_at,
              cu.name AS customer_name
       FROM ratings r
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN users cu    ON cu.id = c.user_id
       WHERE r.agent_id = ? AND r.ref_type = 'ticket' ${dateClauseFor('r')})
      ORDER BY created_at DESC
      LIMIT 200
    `, [agentId, agentId]);

    // Light summary so the drawer can show "9 reviews · avg 4.4 · 7 positive"
    // without the frontend having to re-derive it from the list.
    const total = reviews.length;
    const avg = total > 0
      ? Math.round((reviews.reduce((s, r) => s + Number(r.score), 0) / total) * 100) / 100
      : null;
    const positive = reviews.filter(r => Number(r.score) >= 4).length;
    const negative = reviews.filter(r => Number(r.score) <= 2).length;
    const withComment = reviews.filter(r => r.comment && r.comment.trim().length > 0).length;

    res.json({
      reviews,
      summary: { total, avg, positive, negative, with_comment: withComment },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.markGmbClicked = async (req, res) => {
  try {
    if (req.user.role === 'customer') {
      const [[cust]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
      if (!cust) return res.status(403).json({ error: 'Forbidden' });
      const [[rating]] = await pool.query('SELECT id FROM ratings WHERE id = ? AND customer_id = ?', [req.params.id, cust.id]);
      if (!rating) return res.status(403).json({ error: 'Forbidden' });
    }
    await pool.query('UPDATE ratings SET gmb_clicked = TRUE WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.getSettings = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('gmb_review_url', 'csat_prompt_threshold')");
    const settings = Object.fromEntries(rows.map(r => [r.setting_key, r.setting_value]));
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { gmb_review_url, csat_prompt_threshold } = req.body;
    if (gmb_review_url !== undefined) {
      await pool.query("INSERT INTO app_settings (setting_key, setting_value) VALUES ('gmb_review_url', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [gmb_review_url, gmb_review_url]);
    }
    if (csat_prompt_threshold !== undefined) {
      await pool.query("INSERT INTO app_settings (setting_key, setting_value) VALUES ('csat_prompt_threshold', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [String(csat_prompt_threshold), String(csat_prompt_threshold)]);
    }
    res.json({ message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
