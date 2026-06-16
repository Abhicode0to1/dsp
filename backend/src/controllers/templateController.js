const { pool } = require('../config/database');

exports.getTemplates = async (req, res) => {
  try {
    const [templates] = await pool.query(
      'SELECT * FROM ticket_templates WHERE is_active = 1 ORDER BY name ASC'
    );
    res.json({ templates });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createTemplate = async (req, res) => {
  try {
    const { name, subject_template, description_template, request_type, default_priority } = req.body;
    if (!name || !description_template)
      return res.status(400).json({ error: 'name and description_template are required' });

    const [result] = await pool.query(
      `INSERT INTO ticket_templates (name, subject_template, description_template, request_type, default_priority, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, subject_template || null, description_template,
       request_type || null, default_priority || 'normal', req.user.id]
    );
    res.status(201).json({ id: result.insertId, message: 'Template created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateTemplate = async (req, res) => {
  try {
    const { name, subject_template, description_template, request_type, default_priority, is_active } = req.body;
    const fields = [];
    const vals = [];
    if (name !== undefined)                 { fields.push('name = ?');                 vals.push(name); }
    if (subject_template !== undefined)     { fields.push('subject_template = ?');     vals.push(subject_template); }
    if (description_template !== undefined) { fields.push('description_template = ?'); vals.push(description_template); }
    if (request_type !== undefined)         { fields.push('request_type = ?');         vals.push(request_type); }
    if (default_priority !== undefined)     { fields.push('default_priority = ?');     vals.push(default_priority); }
    if (is_active !== undefined)            { fields.push('is_active = ?');            vals.push(is_active ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await pool.query(`UPDATE ticket_templates SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ message: 'Template updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.deleteTemplate = async (req, res) => {
  try {
    await pool.query('UPDATE ticket_templates SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Template deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

// ── Chat canned responses ────────────────────────────────────────────────────
// Internal-only snippets agents insert into live chats. Admin manages the
// catalog; agents see only active rows via the agent endpoint.

exports.getCannedResponses = async (req, res) => {
  try {
    const onlyActive = req.user.role === 'agent';
    const where = onlyActive ? 'WHERE is_active = 1' : '';
    const [rows] = await pool.query(
      `SELECT id, name, shortcut, category, body, usage_count, is_active, created_at, updated_at
       FROM chat_canned_responses ${where} ORDER BY category, name ASC`
    );
    res.json({ responses: rows });
  } catch (err) {
    console.error('[getCannedResponses]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.createCannedResponse = async (req, res) => {
  try {
    const { name, shortcut, category, body } = req.body;
    if (!name?.trim() || !body?.trim()) {
      return res.status(400).json({ error: 'name and body are required' });
    }
    // Shortcuts are unique. The DB has a UNIQUE constraint but we surface a
    // friendlier 400 rather than the generic ER_DUP_ENTRY.
    if (shortcut) {
      const [[dup]] = await pool.query(
        'SELECT id FROM chat_canned_responses WHERE shortcut = ? LIMIT 1',
        [shortcut.trim()]
      );
      if (dup) return res.status(400).json({ error: `Shortcut "${shortcut}" is already used by another snippet` });
    }
    const [result] = await pool.query(
      `INSERT INTO chat_canned_responses (name, shortcut, category, body, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), shortcut?.trim() || null, category?.trim() || null, body, req.user.id]
    );
    res.status(201).json({ id: result.insertId, message: 'Canned response created' });
  } catch (err) {
    console.error('[createCannedResponse]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.updateCannedResponse = async (req, res) => {
  try {
    const { name, shortcut, category, body, is_active } = req.body;
    const fields = [];
    const vals = [];
    if (name !== undefined)     { fields.push('name = ?');     vals.push(name); }
    if (shortcut !== undefined) {
      if (shortcut) {
        const [[dup]] = await pool.query(
          'SELECT id FROM chat_canned_responses WHERE shortcut = ? AND id <> ? LIMIT 1',
          [shortcut.trim(), req.params.id]
        );
        if (dup) return res.status(400).json({ error: `Shortcut "${shortcut}" is already used by another snippet` });
      }
      fields.push('shortcut = ?'); vals.push(shortcut?.trim() || null);
    }
    if (category !== undefined) { fields.push('category = ?'); vals.push(category?.trim() || null); }
    if (body !== undefined)     { fields.push('body = ?');     vals.push(body); }
    if (is_active !== undefined){ fields.push('is_active = ?');vals.push(is_active ? 1 : 0); }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await pool.query(`UPDATE chat_canned_responses SET ${fields.join(', ')} WHERE id = ?`, vals);
    res.json({ message: 'Canned response updated' });
  } catch (err) {
    console.error('[updateCannedResponse]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

exports.deleteCannedResponse = async (req, res) => {
  try {
    // Hard delete — admin explicitly asked to remove the row. usage_count
    // history is lost too, which is the expected outcome when retiring a
    // snippet. Soft delete was confusing (the row stayed visible with a
    // "DISABLED" badge and admin couldn't tell why it wasn't deleted).
    const [r] = await pool.query('DELETE FROM chat_canned_responses WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Snippet not found' });
    res.json({ message: 'Canned response deleted' });
  } catch (err) {
    console.error('[deleteCannedResponse]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// Agents call this after inserting a snippet into a chat — bumps usage_count
// so admin can see which snippets are getting real use vs. dead wood.
exports.bumpCannedResponseUsage = async (req, res) => {
  try {
    await pool.query(
      'UPDATE chat_canned_responses SET usage_count = usage_count + 1 WHERE id = ? AND is_active = 1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
};
