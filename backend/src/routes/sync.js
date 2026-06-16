const router = require('express').Router();
const {
  receiveBillingWebhook,
} = require('../controllers/syncController');

// No JWT auth — validated by X-Webhook-Secret header inside the controller
router.post('/customer', receiveBillingWebhook);

module.exports = router;
