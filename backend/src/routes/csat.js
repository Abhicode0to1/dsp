const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/csatController');

router.post('/',              authenticate, requireRole('customer'),            ctrl.submitRating);
router.get('/',               authenticate,                                     ctrl.getRating);
router.post('/:id/gmb-click', authenticate, requireRole('customer'),            ctrl.markGmbClicked);
router.get('/stats',          authenticate, requireRole('agent', 'admin'),      ctrl.getCsatStats);
router.get('/settings',       authenticate,                                     ctrl.getSettings);
router.put('/settings',       authenticate, requireRole('admin'),               ctrl.updateSettings);

module.exports = router;
