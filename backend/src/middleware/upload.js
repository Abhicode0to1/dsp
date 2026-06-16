const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
  'application/zip',
];

// Audio mime types allowed only for call recordings (ref_type='call_recording')
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/x-wav'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // For call recordings, prefer a recognizable extension regardless of original_name
    const isRecording = req.body?.ref_type === 'call_recording';
    let ext = path.extname(file.originalname);
    if (isRecording && !ext) {
      ext = file.mimetype === 'audio/webm' ? '.webm'
          : file.mimetype === 'audio/ogg'  ? '.ogg'
          : '.bin';
    }
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  // 30 MB ceiling. Multer applies this PER REQUEST. Audio recordings need the
  // headroom (20-min Opus call ≈ 2 MB but allow margin); regular attachments
  // are still gated by application logic / UI to 25 MB.
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // NOTE: multer parses text fields in order, so req.body.ref_type may NOT
    // be populated yet if the client appended the file before the text fields.
    // We therefore allow audio types unconditionally here — the actual
    // permission/ref_type validation runs in attachmentController.upload(),
    // which is the security boundary that matters.
    if (AUDIO_TYPES.includes(file.mimetype)) return cb(null, true);
    if (ALLOWED_TYPES.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`File type not allowed: ${file.mimetype}`));
  },
});

module.exports = upload;
