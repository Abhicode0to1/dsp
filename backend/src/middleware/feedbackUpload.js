const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Bug reports allow images + short video clips. Files land in a dedicated
// subfolder so they're easy to expire later (feedback isn't load-bearing).
const FEEDBACK_DIR = path.join(__dirname, '../../uploads/feedback');
if (!fs.existsSync(FEEDBACK_DIR)) fs.mkdirSync(FEEDBACK_DIR, { recursive: true });

const ALLOWED = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FEEDBACK_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

module.exports = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB headroom for short screen-rec clips
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});
