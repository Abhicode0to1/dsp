const router = require('express').Router();
const { requestOtp, verifyOtp } = require('../controllers/otpController');

router.post('/request', requestOtp);
router.post('/verify',  verifyOtp);

module.exports = router;
