const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getPublicKey, saveSubscription, removeSubscription } = require('../utils/pushUtils');

// VAPID public key is, by definition, public — the browser needs it to create
// a subscription. No auth required.
router.get('/vapid-public-key', (req, res) => {
  const key = getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push not configured on this server' });
  res.json({ publicKey: key });
});

// Subscribe / unsubscribe are tied to the logged-in user.
router.use(authenticate);

router.post('/subscribe', async (req, res) => {
  try {
    await saveSubscription(req.user.id, req.body?.subscription, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid subscription' });
  }
});

router.post('/unsubscribe', async (req, res) => {
  try {
    await removeSubscription(req.body?.endpoint);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

module.exports = router;
