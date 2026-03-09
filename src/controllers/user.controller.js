const pool = require('../config/db.config');
const { sendResponse } = require('../middleware/auth.middleware');
const fs = require('fs');
const path = require('path');

const uploadSignature = async (req, res) => {
    if (!req.file) {
        return sendResponse(res, 400, false, 'No file uploaded');
    }

    const userId = req.user.id;
    const signaturePath = req.file.filename;

    try {
        await pool.query('UPDATE users SET signature_path = ? WHERE id = ?', [signaturePath, userId]);
        return sendResponse(res, 200, true, 'Signature uploaded successfully', { signature_path: signaturePath });
    } catch (err) {
        console.error('Signature upload error:', err);
        return sendResponse(res, 500, false, 'Failed to save signature');
    }
};

const uploadAvatar = async (req, res) => {
    const { image } = req.body; // Expecting base64 data URL
    if (!image) return sendResponse(res, 400, false, 'No image data provided');

    const userId = req.user.id;
    
    try {
        // Parse base64 and validate image types
        const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            return sendResponse(res, 400, false, 'Invalid image format');
        }

        const mimeType = matches[1];
        const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];
        if (!allowedMimeTypes.includes(mimeType)) {
            return sendResponse(res, 400, false, 'Only JPG, JPEG and PNG are allowed');
        }

        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `avatar-${userId}-${Date.now()}.jpg`;
        const filePath = path.join(__dirname, '../../uploads/avatars', filename);

        // Write to file
        fs.writeFileSync(filePath, buffer);

        // Save relative path in DB
        const relativePath = `uploads/avatars/${filename}`;
        await pool.query('UPDATE users SET avatar_path = ? WHERE id = ?', [relativePath, userId]);

        return sendResponse(res, 200, true, 'Profile photo updated successfully', { avatar_path: relativePath });
    } catch (err) {
        console.error('Avatar upload error:', err);
        return sendResponse(res, 500, false, 'Failed to save profile photo');
    }
};

const removeAvatar = async (req, res) => {
    const userId = req.user.id;
    try {
        await pool.query('UPDATE users SET avatar_path = NULL WHERE id = ?', [userId]);
        return sendResponse(res, 200, true, 'Profile photo removed');
    } catch (err) {
        return sendResponse(res, 500, false, 'Failed to remove photo');
    }
};

const updateProfile = async (req, res) => {
    const { name, mobile_number, address } = req.body;
    const userId = req.user.id;

    if (!name || name.trim().length < 2) {
        return sendResponse(res, 400, false, 'Valid name is required');
    }

    // Validate mobile number if provided
    if (mobile_number && mobile_number.trim()) {
        const mobileRegex = /^\+?[0-9]{7,15}$/;
        if (!mobileRegex.test(mobile_number.trim().replace(/\s/g, ''))) {
            return sendResponse(res, 400, false, 'Invalid mobile number format');
        }
    }

    try {
        await pool.query(
            'UPDATE users SET name = ?, mobile_number = ?, address = ? WHERE id = ?',
            [name.trim(), mobile_number?.trim() || null, address?.trim() || null, userId]
        );
        return sendResponse(res, 200, true, 'Profile updated successfully');
    } catch (err) {
        console.error('Profile update error:', err);
        return sendResponse(res, 500, false, 'Failed to update profile');
    }
};

const getProfile = async (req, res) => {
    const userId = req.user.id;
    try {
        const [users] = await pool.query(
            'SELECT id, name, email, mobile_number, address, role, signature_path, avatar_path FROM users WHERE id = ?',
            [userId]
        );
        if (users.length === 0) return sendResponse(res, 404, false, 'User not found');
        
        const user = users[0];
        
        // Fetch linked managers
        const [managers] = await pool.query(`
            SELECT u.id, u.name, u.email 
            FROM users u
            JOIN user_managers um ON u.id = um.manager_id
            WHERE um.user_id = ?
        `, [userId]);
        
        user.managers = managers;
        return sendResponse(res, 200, true, 'Profile fetched', user);
    } catch (err) {
        return sendResponse(res, 500, false, 'Fetch error');
    }
};

const getAvailableManagers = async (req, res) => {
    try {
        const [managers] = await pool.query('SELECT id, name, email FROM users WHERE role IN ("manager", "admin") AND status = "active"');
        return sendResponse(res, 200, true, 'Managers fetched', managers);
    } catch (err) {
        return sendResponse(res, 500, false, 'Fetch error');
    }
};

const updateManagers = async (req, res) => {
    const { managerIds } = req.body; // Array of IDs
    const userId = req.user.id;

    if (!Array.isArray(managerIds)) {
        return sendResponse(res, 400, false, 'Invalid manager list');
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // 1. Clear existing
        await connection.query('DELETE FROM user_managers WHERE user_id = ?', [userId]);

        // 2. Insert new if any
        if (managerIds.length > 0) {
            const values = managerIds.map(mId => [userId, mId]);
            await connection.query('INSERT INTO user_managers (user_id, manager_id) VALUES ?', [values]);
        }

        await connection.commit();
        return sendResponse(res, 200, true, 'Managers updated successfully');
    } catch (err) {
        await connection.rollback();
        console.error('Update managers error:', err);
        return sendResponse(res, 500, false, 'Failed to update managers');
    } finally {
        connection.release();
    }
};

const updateSecurityEmail = async (req, res) => {
    const { email, location_id } = req.body;
    const { role, id: userId, location_id: userLocId } = req.user;

    // 1. Role Guard
    if (role !== 'security' && role !== 'admin') {
        return sendResponse(res, 403, false, 'Only security users or admins can update security emails');
    }

    // 2. Ownership Guard (Security users can only update their own site)
    if (role === 'security' && location_id != userLocId) {
        return sendResponse(res, 403, false, 'You can only update the security email for your assigned location');
    }

    try {
        // 2.5 Sole Active Security User Check
        if (role === 'security') {
            const [others] = await pool.query(
                'SELECT id FROM users WHERE role = "security" AND location_id = ? AND status = "active" AND id != ?',
                [location_id, userId]
            );
            if (others.length > 0) {
                return sendResponse(res, 400, false, 'Assignment Blocked: Multiple active security users exist for this location. Please deactivate others before syncing official email.');
            }
        }

        // 3. Update User Email (Login Email)
        await pool.query('UPDATE users SET email = ? WHERE id = ?', [email, userId]);

        // 4. Sync with Location Security Email
        await pool.query('UPDATE locations SET security_email = ? WHERE id = ?', [email, location_id]);

        return sendResponse(res, 200, true, 'Security email updated and synced successfully');
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return sendResponse(res, 400, false, 'Email is already in use by another user');
        }
        console.error('Security email update error:', err);
        return sendResponse(res, 500, false, 'Failed to update security email');
    }
};

const getAllUsers = async (req, res) => {
    // Admin only guard
    if (req.user.role !== 'admin') {
        return sendResponse(res, 403, false, 'Access denied');
    }

    try {
        const [users] = await pool.query(
            'SELECT id, name, email, mobile_number, role, status, created_at FROM users ORDER BY role, name'
        );
        return sendResponse(res, 200, true, 'Users fetched', users);
    } catch (err) {
        console.error('Fetch all users error:', err);
        return sendResponse(res, 500, false, 'Failed to fetch users');
    }
};

const adminUpdateUserMobile = async (req, res) => {
    const { id } = req.params;
    const { mobile_number } = req.body;
    const { role: adminRole } = req.user;

    // 1. Admin Guard
    if (adminRole !== 'admin') {
        return sendResponse(res, 403, false, 'Only admins can perform this action');
    }

    // 2. Mobile Validation
    if (mobile_number && mobile_number.trim()) {
        const mobileRegex = /^\+?[0-9]{7,15}$/;
        if (!mobileRegex.test(mobile_number.trim().replace(/\s/g, ''))) {
            return sendResponse(res, 400, false, 'Invalid mobile number format');
        }
    }

    try {
        // 3. User Existence Check
        const [rows] = await pool.query('SELECT role FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return sendResponse(res, 404, false, 'User not found');
        
        // Removed restriction: Admin can now update mobile for any user role

        // 4. Update
        await pool.query(
            'UPDATE users SET mobile_number = ? WHERE id = ?',
            [mobile_number?.trim() || null, id]
        );

        return sendResponse(res, 200, true, 'User mobile updated successfully');
    } catch (err) {
        console.error('Admin user update error:', err);
        return sendResponse(res, 500, false, 'Failed to update user mobile');
    }
};

module.exports = {
    uploadSignature,
    getProfile,
    uploadAvatar,
    removeAvatar,
    updateProfile,
    getAvailableManagers,
    updateManagers,
    updateSecurityEmail,
    getAllUsers,
    adminUpdateUserMobile
};
