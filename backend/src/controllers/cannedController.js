const { pool } = require('../config/database');

exports.list = async (req, res) => {
  try {
    // Legacy personal/global snippets, owned per-agent
    const [legacy] = await pool.query(
      `SELECT cr.id, cr.title, cr.body, cr.is_global, cr.created_by, u.name AS author_name,
              NULL AS category, NULL AS shortcut, 0 AS usage_count,
              CASE WHEN cr.is_global = TRUE THEN 'global' ELSE 'personal' END AS kind
       FROM canned_responses cr JOIN users u ON u.id = cr.created_by
       WHERE cr.is_global = TRUE OR cr.created_by = ?
       ORDER BY cr.title ASC`,
      [req.user.id]
    );
    // Admin-curated team snippets (chat_canned_responses, with shortcut/category/usage_count)
    const [team] = await pool.query(
      `SELECT ccr.id, ccr.name AS title, ccr.body, TRUE AS is_global, ccr.created_by,
              COALESCE(u.name, 'Admin') AS author_name,
              ccr.category, ccr.shortcut, ccr.usage_count,
              'team' AS kind
       FROM chat_canned_responses ccr LEFT JOIN users u ON u.id = ccr.created_by
       WHERE ccr.is_active = 1
       ORDER BY ccr.name ASC`
    );
    // Merged for the existing CannedPicker UI. `kind` tells the frontend which
    // bucket each row came from so it can call the right endpoint for actions
    // (delete /canned/:id only works for legacy rows; team rows are managed by
    // admin under Templates → Chat Snippets).
    res.json({ responses: [...team, ...legacy] });
  } catch (err) {
    console.error('[canned list]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const { title, body, is_global = false } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
    const global = is_global && req.user.role === 'admin';
    const [result] = await pool.query(
      'INSERT INTO canned_responses (created_by, title, body, is_global) VALUES (?, ?, ?, ?)',
      [req.user.id, title, body, global]
    );
    res.status(201).json({ id: result.insertId, message: 'Created' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const { title, body, is_global } = req.body;
    const [[cr]] = await pool.query('SELECT * FROM canned_responses WHERE id = ?', [req.params.id]);
    if (!cr) return res.status(404).json({ error: 'Not found' });
    if (cr.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    await pool.query(
      'UPDATE canned_responses SET title = ?, body = ?, is_global = ? WHERE id = ?',
      [title ?? cr.title, body ?? cr.body, is_global !== undefined ? is_global : cr.is_global, req.params.id]
    );
    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.remove = async (req, res) => {
  try {
    const [[cr]] = await pool.query('SELECT * FROM canned_responses WHERE id = ?', [req.params.id]);
    if (!cr) return res.status(404).json({ error: 'Not found' });
    if (cr.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM canned_responses WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
