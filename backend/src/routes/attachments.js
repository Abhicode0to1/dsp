const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');
const ctrl = require('../controllers/attachmentController');

// Wrap multer so its async errors return a JSON response instead of a generic 500.
// Without this, fileFilter rejections produce HTML errors that clients can't parse.
function uploadHandler(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error(`[Attachments POST] multer error: ${err.message} (ref_type=${req.body?.ref_type})`);
      return res.status(400).json({ error: err.message || 'Upload rejected' });
    }
    console.log(`[Attachments POST] multer OK — ref_type=${req.body?.ref_type}, file=${req.file?.originalname} (${req.file?.size} bytes, ${req.file?.mimetype})`);
    next();
  });
}

router.post('/',           authenticate, uploadHandler, ctrl.upload);
router.get('/',            authenticate, ctrl.getForRef);
router.get('/:id/download', authenticate, ctrl.download);
router.delete('/:id',      authenticate, ctrl.remove);

module.exports = router;
