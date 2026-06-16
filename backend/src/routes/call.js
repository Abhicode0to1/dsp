const router = require('express').Router();
const { initiateCall, endCall, getCallHistory } = require('../controllers/callController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);
router.use(requireRole('customer'));

router.post('/initiate', initiateCall);
router.get('/history', getCallHistory);
router.put('/:id/end', endCall);

module.exports = router;
