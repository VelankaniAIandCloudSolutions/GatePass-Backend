const pool = require('../config/db.config');
const bcrypt = require('bcryptjs');
const generateToken = require('../utils/generateToken');
const { sendResponse } = require('../middleware/auth.middleware');
const { generateOTP, hashOTP, verifyOTP } = require('../utils/otp.util');
const { sendOTPEmail } = require('../utils/mail.util');

// 1. LOGIN
const login = async (req, res) => {
    const { email, password } = req.body;

    try {
        const [users] = await pool.query(
            'SELECT * FROM users WHERE email = ?', 
            [email]
        );
        
        if (users.length === 0) {
            return sendResponse(res, 401, false, 'Invalid credentials');
        }

        const user = users[0];

        if (user.status !== 'active' || !user.is_verified || !user.role_locked) {
            return sendResponse(res, 403, false, 'Account not fully activated. Please complete signup process.');
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return sendResponse(res, 401, false, 'Invalid credentials');
        }

        const token = generateToken({ 
            id: user.id, 
            role: user.role, 
            location_id: user.location_id 
        });

        return sendResponse(res, 200, true, 'Login successful', {
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                location_id: user.location_id,
                avatar_path: user.avatar_path
            }
        });

    } catch (error) {
        console.error('Login Error:', error);
        return sendResponse(res, 500, false, 'Internal Server Error');
    }
};

// 2. SIGNUP STEP 1 - Initiate
const signupInitiate = async (req, res) => {
    const { name, email } = req.body;

    try {
        // Check if user exists and is active
        const [existing] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existing.length > 0 && existing[0].status === 'active') {
            return sendResponse(res, 400, false, 'Email already registered');
        }

        let userId;
        if (existing.length > 0) {
            userId = existing[0].id;
            // Update name if changed
            await pool.query('UPDATE users SET name = ? WHERE id = ?', [name, userId]);
        } else {
            const [result] = await pool.query(
                'INSERT INTO users (name, email, role, status, is_verified, password) VALUES (?, ?, "user", "pending", false, "temporary_pwd")',
                [name, email]
            );
            userId = result.insertId;
        }

        const otp = generateOTP();
        const hashedOtp = await hashOTP(otp);
        const expiresAt = new Date(Date.now() + 10 * 60000); // 10 mins

        // Store OTP
        await pool.query(
            'INSERT INTO email_otps (user_id, otp_hash, expires_at, purpose) VALUES (?, ?, ?, "signup")',
            [userId, hashedOtp, expiresAt]
        );

        // Send Email
        const sent = await sendOTPEmail(email, otp, 'signup');
        if (!sent) {
            return sendResponse(res, 500, false, 'Failed to send verification email');
        }

        return sendResponse(res, 200, true, 'OTP sent to your email');

    } catch (error) {
        console.error('Signup Initiate Error:', error);
        return sendResponse(res, 500, false, 'Failed to initiate signup');
    }
};

// 3. SIGNUP STEP 2 - Verify OTP
const signupVerify = async (req, res) => {
    const { email, otp } = req.body;

    try {
        const [users] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (users.length === 0) return sendResponse(res, 404, false, 'User not found');
        const userId = users[0].id;

        const [otps] = await pool.query(
            'SELECT * FROM email_otps WHERE user_id = ? AND purpose = "signup" AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
            [userId]
        );

        if (otps.length === 0) return sendResponse(res, 400, false, 'OTP expired or not found');

        const isValid = await verifyOTP(otp, otps[0].otp_hash);
        if (!isValid) return sendResponse(res, 400, false, 'Invalid OTP');

        // Mark as verified
        await pool.query('UPDATE users SET is_verified = true WHERE id = ?', [userId]);
        // Delete OTP
        await pool.query('DELETE FROM email_otps WHERE user_id = ? AND purpose = "signup"', [userId]);

        return sendResponse(res, 200, true, 'Email verified successfully');

    } catch (error) {
        console.error('Verify OTP Error:', error);
        return sendResponse(res, 500, false, 'Verification failed');
    }
};

// 4. SIGNUP STEP 3 - Set Password & Role (Role Selection & Locking)
const signupSetPassword = async (req, res) => {
    const { email, password, role } = req.body;

    try {
        const [users] = await pool.query('SELECT id, is_verified, role_locked FROM users WHERE email = ?', [email]);
        if (users.length === 0) return sendResponse(res, 404, false, 'User not found');
        
        const user = users[0];
        if (!user.is_verified) return sendResponse(res, 403, false, 'Email not verified');
        if (user.role_locked) return sendResponse(res, 400, false, 'Role and password already set. Please login.');

        // Validate role selection (admin can't be chosen by public)
        if (!['user', 'manager', 'security'].includes(role)) {
            return sendResponse(res, 400, false, 'Invalid role selection');
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'UPDATE users SET password = ?, role = ?, role_locked = true, status = "active" WHERE id = ?',
            [hashedPassword, role, user.id]
        );

        return sendResponse(res, 200, true, 'Account activated successfully with ' + role + ' role. You can now login.');

    } catch (error) {
        console.error('Set Password Error:', error);
        return sendResponse(res, 500, false, 'Failed to set password');
    }
};

// 5. FORGOT PASSWORD STEP 1 - Initiate
const forgotInitiate = async (req, res) => {
    const { email } = req.body;

    try {
        const [users] = await pool.query('SELECT id FROM users WHERE email = ? AND status = "active"', [email]);
        if (users.length === 0) return sendResponse(res, 404, false, 'No active account found with this email');

        const userId = users[0].id;
        const otp = generateOTP();
        const hashedOtp = await hashOTP(otp);
        const expiresAt = new Date(Date.now() + 10 * 60000);

        await pool.query(
            'INSERT INTO email_otps (user_id, otp_hash, expires_at, purpose) VALUES (?, ?, ?, "forgot")',
            [userId, hashedOtp, expiresAt]
        );

        const sent = await sendOTPEmail(email, otp, 'forgot');
        if (!sent) return sendResponse(res, 500, false, 'Failed to send OTP');

        return sendResponse(res, 200, true, 'Reset OTP sent to your email');

    } catch (error) {
        console.error('Forgot Initiate Error:', error);
        return sendResponse(res, 500, false, 'Error processing request');
    }
};

// 6. FORGOT PASSWORD STEP 2 - Confirm
const forgotConfirm = async (req, res) => {
    const { email, otp, newPassword } = req.body;

    try {
        const [users] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (users.length === 0) return sendResponse(res, 404, false, 'User not found');
        const userId = users[0].id;

        const [otps] = await pool.query(
            'SELECT * FROM email_otps WHERE user_id = ? AND purpose = "forgot" AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
            [userId]
        );

        if (otps.length === 0) return sendResponse(res, 400, false, 'OTP expired or not found');

        const isValid = await verifyOTP(otp, otps[0].otp_hash);
        if (!isValid) return sendResponse(res, 400, false, 'Invalid OTP');

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
        await pool.query('DELETE FROM email_otps WHERE user_id = ? AND purpose = "forgot"', [userId]);

        return sendResponse(res, 200, true, 'Password reset successfully');

    } catch (error) {
        console.error('Forgot Confirm Error:', error);
        return sendResponse(res, 500, false, 'Failed to reset password');
    }
};

module.exports = {
    login,
    signupInitiate,
    signupVerify,
    signupSetPassword,
    forgotInitiate,
    forgotConfirm
};
