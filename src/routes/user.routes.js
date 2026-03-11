const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const userController = require('../controllers/user.controller');
const { protect } = require('../middleware/auth.middleware');

// 1. Storage Config with Filename Sanitization
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/signatures');
    },
    filename: (req, file, cb) => {
        // Sanitize filename: remove spaces and non-alphanumeric chars
        const safeName = file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
        cb(null, `sig-${req.user.id}-${Date.now()}-${safeName}`);
    }
});

// 2. Hardened Multer Config (Size + MIME)
const upload = multer({ 
    storage,
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB Limit
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png'];
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPG, JPEG and PNG are allowed.'), false);
        }
    }
});

router.get('/profile', protect, userController.getProfile);
router.put('/profile', protect, userController.updateProfile);
router.post('/upload-avatar', protect, userController.uploadAvatar);
router.delete('/avatar', protect, userController.removeAvatar);
router.get('/available-managers', protect, userController.getAvailableManagers);
router.put('/managers', protect, userController.updateManagers);
router.put('/security-email', protect, userController.updateSecurityEmail);
router.get('/search', protect, userController.searchUsers);

// Admin Routes
router.get('/admin/users', protect, userController.getAllUsers);
router.put('/admin/user/:id/mobile', protect, userController.adminUpdateUserMobile);

// 3. Upload Route with Error Handling for Multer
router.post('/upload-signature', protect, (req, res) => {
    upload.single('signature')(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: 'File too large. Max limit is 2MB.' });
            }
            return res.status(400).json({ success: false, message: err.message });
        } else if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        userController.uploadSignature(req, res);
    });
});

module.exports = router;
