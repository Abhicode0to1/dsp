const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { getLogs, getActors, getSummary, exportCsv } = require('../controllers/auditController');

router.get('/',           authenticate, requireRole('admin'), getLogs);
router.get('/actors',     authenticate, requireRole('admin'), getActors);
router.get('/summary',    authenticate, requireRole('admin'), getSummary);
router.get('/export.csv', authenticate, requireRole('admin'), exportCsv);

module.exports = router;
