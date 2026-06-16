const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/cannedController');

router.use(authenticate, requireRole('agent', 'admin'));
router.get('/',      ctrl.list);
router.post('/',     ctrl.create);
router.put('/:id',   ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
