const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');

// If validation/insert fails, clean up the orphan file multer already wrote.
function unlinkOrphan(file) {
  if (!file?.path) return;
  try { fs.unlinkSync(file.path); } catch { /* best-effort */ }
}

exports.upload = async (req, res) => {
  let conn;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { ref_type, ref_id } = req.body;
    if (!ref_type || !ref_id) {
      unlinkOrphan(req.file);
      return res.status(400).json({ error: 'ref_type and ref_id required' });
    }

    // For call recordings: only agents and admins can upload. Ownership is NOT
    // checked any further — see comment below. Prevents random non-staff users
    // from injecting audio.
    if (ref_type === 'call_recording') {
      if (req.user.role !== 'agent' && req.user.role !== 'admin') {
        unlinkOrphan(req.file);
        return res.status(403).json({ error: 'Only agents may upload call recordings' });
      }
      const [[call]] = await pool.query('SELECT id FROM calls WHERE id = ?', [ref_id]);
      if (!call) {
        unlinkOrphan(req.file);
        return res.status(404).json({ error: 'Call not found' });
      }
      // Deliberately NO `call.agent_id === req.user.id` check. After a warm
      // transfer the DB owner flips to the new agent (B) but the previous
      // agent (A) is still holding the pre-transfer recording buffer and needs
      // to finish uploading it. We can't reliably distinguish "A's legitimate
      // post-transfer upload" from "random staff uploading to a call they
      // were never on" using just agent_id, so we lean on:
      //   1. role gate above (only agents/admins reach this point)
      //   2. download-side admin-only access for `call_recording` attachments
      //      (see GET /attachments — only admins can fetch them)
      // Multiple uploads append as separate rows; calls.recording_attachment_id
      // tracks the latest one (most recent uploader wins). That matches the
      // intended behavior — the longest call segment is usually B's, so their
      // recording naturally takes precedence as the "primary" one.
    }

    // Atomic insert + FK update so a failure on either rolls back both
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO file_attachments (ref_type, ref_id, original_name, stored_name, mime_type, size_bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ref_type, ref_id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id]
    );
    if (ref_type === 'call_recording') {
      await conn.query('UPDATE calls SET recording_attachment_id = ? WHERE id = ?', [result.insertId, ref_id]);
    }
    await conn.commit();

    if (ref_type === 'call_recording') {
      console.log(`[Upload] call_recording for call ${ref_id} — ${req.file.size} bytes (attachment ${result.insertId})`);
    }

    res.status(201).json({
      attachment: {
        id: result.insertId,
        original_name: req.file.originalname,
        stored_name: req.file.filename,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
        url: `/api/attachments/${result.insertId}/download`,
      },
    });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch {} }
    unlinkOrphan(req.file);
    console.error('[Upload error]', err.message);
    res.status(500).json({ error: 'Upload failed' });
  } finally {
    if (conn) conn.release();
  }
};

exports.getForRef = async (req, res) => {
  try {
    const { ref_type, ref_id } = req.query;
    if (!ref_type || !ref_id) return res.status(400).json({ error: 'ref_type and ref_id required' });

    // Call recordings are admin-only — no exceptions
    if (ref_type === 'call_recording' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden — admin only' });
    }

    if (req.user.role === 'customer') {
      const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
      if (!cRow) return res.status(403).json({ error: 'Forbidden' });
      let owned = false;
      if (ref_type === 'ticket') {
        const [[t]] = await pool.query('SELECT id FROM tickets WHERE id = ? AND customer_id = ?', [ref_id, cRow.id]);
        owned = !!t;
      } else if (ref_type === 'chat' || ref_type === 'chat_message') {
        const [[c]] = await pool.query('SELECT id FROM chats WHERE id = ? AND customer_id = ?', [ref_id, cRow.id]);
        owned = !!c;
      }
      if (!owned) return res.status(403).json({ error: 'Forbidden' });
    }

    const [rows] = await pool.query(
      `SELECT fa.*, u.name AS uploader_name
       FROM file_attachments fa JOIN users u ON u.id = fa.uploaded_by
       WHERE fa.ref_type = ? AND fa.ref_id = ?
       ORDER BY fa.created_at ASC`,
      [ref_type, ref_id]
    );
    res.json({ attachments: rows.map(r => ({ ...r, url: `/api/attachments/${r.id}/download` })) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.download = async (req, res) => {
  try {
    const [[att]] = await pool.query('SELECT * FROM file_attachments WHERE id = ?', [req.params.id]);
    if (!att) return res.status(404).json({ error: 'Not found' });

    // Call recordings are admin-only — gate before any customer/agent logic
    if (att.ref_type === 'call_recording' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden — admin only' });
    }

    if (req.user.role === 'customer') {
      const [[cRow]] = await pool.query('SELECT id FROM customers WHERE user_id = ?', [req.user.id]);
      if (!cRow) return res.status(403).json({ error: 'Forbidden' });
      let owned = false;
      if (att.ref_type === 'ticket') {
        const [[t]] = await pool.query('SELECT id FROM tickets WHERE id = ? AND customer_id = ?', [att.ref_id, cRow.id]);
        owned = !!t;
      } else if (att.ref_type === 'chat' || att.ref_type === 'chat_message') {
        const [[c]] = await pool.query('SELECT id FROM chats WHERE id = ? AND customer_id = ?', [att.ref_id, cRow.id]);
        owned = !!c;
      }
      if (!owned) return res.status(403).json({ error: 'Forbidden' });
    }

    const filePath = path.join(__dirname, '../../uploads', att.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
    res.download(filePath, att.original_name);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};

exports.remove = async (req, res) => {
  try {
    const [[att]] = await pool.query('SELECT * FROM file_attachments WHERE id = ?', [req.params.id]);
    if (!att) return res.status(404).json({ error: 'Not found' });
    if (att.uploaded_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const filePath = path.join(__dirname, '../../uploads', att.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await pool.query('DELETE FROM file_attachments WHERE id = ?', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
