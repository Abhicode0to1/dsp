const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');

// POST /api/feedback — customer or agent submits a bug report.
// Accepts multipart/form-data: { title, description, page_url, browser_info, files[] }.
exports.submit = async (req, res) => {
  try {
    const { title, description, page_url, browser_info } = req.body;
    if (!title || !description) {
      return res.status(400).json({ error: 'Title and description are required' });
    }
    if (!['customer', 'agent', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // multer.array() exposes files as req.files; store only the public-facing
    // path the admin viewer will hit. Mime + size preserved for the admin UI.
    const files = (req.files || []).map(f => ({
      name: f.originalname,
      path: `/uploads/feedback/${path.basename(f.path)}`,
      mime: f.mimetype,
      size: f.size,
    }));

    const panel = req.user.role === 'customer' ? 'customer' : 'agent';

    const [result] = await pool.query(
      `INSERT INTO feedback_reports
       (reporter_user_id, reporter_role, panel, title, description, page_url, browser_info, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        req.user.role,
        panel,
        String(title).slice(0, 255),
        String(description).slice(0, 5000),
        page_url ? String(page_url).slice(0, 500) : null,
        browser_info ? String(browser_info).slice(0, 500) : null,
        files.length ? JSON.stringify(files) : null,
      ]
    );

    res.status(201).json({ id: result.insertId, message: 'Thanks — your report has been sent to the admin team.' });
  } catch (err) {
    console.error('[feedback submit]', err);
    // Clean up any uploaded files if the insert failed — otherwise the disk fills
    // with orphans on every retry.
    for (const f of req.files || []) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/feedback/mine — reporter views their own submissions.
exports.listMine = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, description, status, admin_notes, attachments, created_at, reviewed_at
       FROM feedback_reports
       WHERE reporter_user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json({ reports: rows });
  } catch (err) {
    console.error('[feedback listMine]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/admin/feedback — admin listing with paging + filters.
//   status      — new | reviewed | approved | rejected | fixed
//   panel       — customer | agent | admin
//   reporter_id — filter to a specific reporter
//   search      — LIKE on title / description / reporter name+email
//   from / to   — date range on created_at (YYYY-MM-DD)
//   page / limit / offset — pagination (default 50, offset wins if present)
// Always returns `counts` grouped by status from the FULL table (ignoring the
// current filter) so chip pills show all-time numbers.
exports.adminList = async (req, res) => {
  try {
    const { status, panel, reporter_id, search, from, to } = req.query;
    const where = [];
    const params = [];
    if (status && ['new', 'reviewed', 'approved', 'rejected', 'fixed'].includes(status)) {
      where.push('f.status = ?'); params.push(status);
    }
    if (panel && ['customer', 'agent', 'admin'].includes(panel)) {
      where.push('f.panel = ?'); params.push(panel);
    }
    if (reporter_id) {
      where.push('f.reporter_user_id = ?'); params.push(reporter_id);
    }
    if (from) { where.push('f.created_at >= ?'); params.push(from); }
    if (to)   { where.push('f.created_at <= ?'); params.push(String(to).length === 10 ? to + ' 23:59:59' : to); }
    if (search) {
      const q = `%${String(search).trim()}%`;
      where.push('(f.title LIKE ? OR f.description LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
      params.push(q, q, q, q);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(250, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = req.query.offset != null
      ? Math.max(0, parseInt(req.query.offset, 10) || 0)
      : (page - 1) * limit;

    const [rows] = await pool.query(
      `SELECT f.*, u.name AS reporter_name, u.email AS reporter_email,
              ru.name AS reviewer_name
       FROM feedback_reports f
       JOIN users u ON u.id = f.reporter_user_id
       LEFT JOIN users ru ON ru.id = f.reviewed_by
       ${whereSql}
       ORDER BY
         CASE f.status WHEN 'new' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'approved' THEN 2 WHEN 'fixed' THEN 3 ELSE 4 END,
         f.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ filtered_total }]] = await pool.query(
      `SELECT COUNT(*) AS filtered_total
       FROM feedback_reports f
       JOIN users u ON u.id = f.reporter_user_id
       ${whereSql}`, params
    );

    const [countRows] = await pool.query(
      `SELECT status, COUNT(*) AS n FROM feedback_reports GROUP BY status`
    );
    const counts = { new: 0, reviewed: 0, approved: 0, rejected: 0, fixed: 0, total: 0 };
    for (const r of countRows) {
      counts[r.status] = Number(r.n);
      counts.total += Number(r.n);
    }

    res.json({
      reports: rows,
      counts,
      total: Number(filtered_total) || 0,
      page, limit, offset,
    });
  } catch (err) {
    console.error('[feedback adminList]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// GET /api/admin/feedback/reporters — distinct list of users who have ever
// submitted a report. Powers the "Reporter" filter dropdown — without this,
// the admin would have to know each reporter's user_id.
exports.getReporters = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, f.reporter_role AS role, COUNT(*) AS report_count
       FROM feedback_reports f
       JOIN users u ON u.id = f.reporter_user_id
       GROUP BY u.id, u.name, u.email, f.reporter_role
       ORDER BY report_count DESC, u.name`
    );
    res.json({ reporters: rows });
  } catch (err) {
    console.error('[feedback getReporters]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// POST /api/admin/feedback/bulk — bulk status change. Body: { ids: [], status: 'fixed' }
// Useful after a release ("mark all these 8 as Fixed") so admin doesn't click
// one-by-one. Same status-whitelist as the single-row update.
exports.adminBulkUpdate = async (req, res) => {
  try {
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'Provide ids[]' });
    }
    if (!['new', 'reviewed', 'approved', 'rejected', 'fixed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const numeric = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!numeric.length) return res.status(400).json({ error: 'No valid ids' });
    const [result] = await pool.query(
      `UPDATE feedback_reports
       SET status = ?, reviewed_by = ?, reviewed_at = NOW()
       WHERE id IN (${numeric.map(() => '?').join(',')})`,
      [status, req.user.id, ...numeric]
    );
    res.json({ ok: true, updated: result.affectedRows });
  } catch (err) {
    console.error('[feedback adminBulkUpdate]', err);
    res.status(500).json({ error: 'Server error' });
  }
};

// PUT /api/admin/feedback/:id — admin updates status, edits title/description, adds notes.
// Admins commonly receive low-context bug reports ("button broken pls fix") and need to
// rewrite them into something the fix-bot (or a human) can act on without re-asking.
// We snapshot the original reporter copy into admin_notes on first edit so context isn't
// silently lost.
exports.adminUpdate = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, admin_notes, title, description } = req.body;
    if (status && !['new', 'reviewed', 'approved', 'rejected', 'fixed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const [[existing]] = await pool.query(
      'SELECT title, description, admin_notes FROM feedback_reports WHERE id = ?',
      [id]
    );
    if (!existing) return res.status(404).json({ error: 'Report not found' });

    const fields = [];
    const params = [];
    if (status) {
      fields.push('status = ?', 'reviewed_by = ?', 'reviewed_at = NOW()');
      params.push(status, req.user.id);
    }

    // If admin is rewriting the report, preserve a copy of the original in admin_notes
    // (prepended, only on the first edit) so nothing is lost.
    const titleChanged = title !== undefined && title !== existing.title;
    const descChanged = description !== undefined && description !== existing.description;
    const alreadyHasOriginal = (existing.admin_notes || '').includes('--- ORIGINAL REPORT ---');

    let nextNotes = admin_notes !== undefined ? admin_notes : existing.admin_notes;
    if ((titleChanged || descChanged) && !alreadyHasOriginal) {
      const snapshot = `--- ORIGINAL REPORT ---\nTitle: ${existing.title}\nDescription: ${existing.description}\n--- END ORIGINAL ---`;
      nextNotes = nextNotes ? `${snapshot}\n\n${nextNotes}` : snapshot;
    }
    if (titleChanged) {
      fields.push('title = ?');
      params.push(String(title).slice(0, 255));
    }
    if (descChanged) {
      fields.push('description = ?');
      params.push(String(description).slice(0, 5000));
    }
    if (admin_notes !== undefined || titleChanged || descChanged) {
      fields.push('admin_notes = ?');
      params.push(nextNotes || null);
    }

    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    await pool.query(`UPDATE feedback_reports SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ ok: true });
  } catch (err) {
    console.error('[feedback adminUpdate]', err);
    res.status(500).json({ error: 'Server error' });
  }
};
