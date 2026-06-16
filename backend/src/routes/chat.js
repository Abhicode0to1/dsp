const router = require('express').Router();
const {
  initiateChat,
  getActiveChat,
  closeChat,
  getChatHistory,
  rateChat,
  leaveOfflineMessage,
  getQueueInfo,
} = require('../controllers/chatController');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);
router.use(requireRole('customer'));

router.post('/initiate',          initiateChat);
router.get('/active',             getActiveChat);
router.get('/queue',              getQueueInfo);
router.get('/history',            getChatHistory);
router.put('/:id/close',          closeChat);
router.post('/:id/rate',          rateChat);
router.post('/offline-message',   leaveOfflineMessage);

module.exports = router;
