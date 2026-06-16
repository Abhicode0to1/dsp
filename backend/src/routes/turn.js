const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { getIceServers } = require('../utils/turnUtils');

// Returns ICE servers (Cloudflare TURN in prod, free fallback otherwise) for
// the client to build its RTCPeerConnection. Authenticated — only logged-in
// users place calls.
router.get('/credentials', authenticate, async (req, res) => {
  try {
    const iceServers = await getIceServers();
    res.json({ iceServers });
  } catch {
    res.status(500).json({ error: 'Failed to get TURN credentials' });
  }
});

module.exports = router;
