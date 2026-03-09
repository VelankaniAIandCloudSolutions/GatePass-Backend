const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const { loginValidation } = require('../middleware/validator.middleware');

// 1. LOGIN
router.post('/login', loginValidation, authController.login);

// 2. SIGNUP (3 STEP)
router.post('/signup/initiate', authController.signupInitiate);
router.post('/signup/verify', authController.signupVerify);
router.post('/signup/set-password', authController.signupSetPassword);

// 3. FORGOT PASSWORD
router.post('/forgot/initiate', authController.forgotInitiate);
router.post('/forgot/confirm', authController.forgotConfirm);

module.exports = router;
