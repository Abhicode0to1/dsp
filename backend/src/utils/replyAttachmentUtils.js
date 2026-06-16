const path = require('path');
const fs = require('fs');
const { pool } = require('../config/database');

// Total size above which we send the reply email text-only (recipients fall
// back to the in-portal attachments). Keeps us from bouncing on oversized
// payloads at the SMTP server.
const MAX_EMAIL_ATTACH_BYTES = 10 * 1024 * 1024; // 10 MB

// Build a nodemailer `attachments` array from the IDs of files uploaded with a
// ticket reply, so CC recipients (who have no portal login) actually receive
// the file — not just the text. Only files that belong to THIS ticket and
// still exist on disk are included. Returns [] (text-only) if nothing matches
// or the combined size exceeds the cap.
async function buildReplyEmailAttachments(attachmentIds, ticketId) {
  if (!Array.isArray(attachmentIds) || !attachmentIds.length) return [];
  const ids = attachmentIds.map(Number).filter(Boolean).slice(0, 20);
  if (!ids.length) return [];

  const [rows] = await pool.query(
    `SELECT id, original_name, stored_name, size_bytes FROM file_attachments
     WHERE id IN (?) AND ref_type = 'ticket' AND ref_id = ?`,
    [ids, ticketId]
  );

  const out = [];
  let total = 0;
  for (const r of rows) {
    const filePath = path.join(__dirname, '../../uploads', r.stored_name);
    if (!fs.existsSync(filePath)) continue;
    total += Number(r.size_bytes) || 0;
    out.push({ filename: r.original_name, path: filePath });
  }

  if (total > MAX_EMAIL_ATTACH_BYTES) {
    console.log(`[Email] reply attachments ${Math.round(total / 1024 / 1024)}MB exceed ${MAX_EMAIL_ATTACH_BYTES / 1024 / 1024}MB cap — sending text-only, recipients use the portal link`);
    return [];
  }
  return out;
}

module.exports = { buildReplyEmailAttachments, MAX_EMAIL_ATTACH_BYTES };
