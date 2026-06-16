const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/feedbackUpload');
const ctrl = require('../controllers/feedbackController');

router.use(authenticate);

// Submit a bug report. Wrap multer so its async errors return a JSON response
// instead of bubbling out as a 500 — the frontend wants a structured error.
router.post('/', (req, res, next) => {
  upload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, ctrl.submit);

router.get('/mine', ctrl.listMine);

module.exports = router;
