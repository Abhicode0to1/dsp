const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/notesController');

router.use(authenticate, requireRole('agent', 'admin'));
router.get('/:customerId',       ctrl.getNotes);
router.post('/:customerId',      ctrl.addNote);
router.delete('/:id',            ctrl.deleteNote);

module.exports = router;
