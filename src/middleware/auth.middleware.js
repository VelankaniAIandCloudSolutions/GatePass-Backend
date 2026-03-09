const jwt = require('jsonwebtoken');
require('dotenv').config();

// Standard response format helper
const sendResponse = (res, statusCode, success, message, data = null) => {
    return res.status(statusCode).json({
        success,
        message,
        data
    });
};

const pool = require('../config/db.config'); // Moved pool import up to be available for protect

const protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
        return sendResponse(res, 401, false, 'Not authorized to access this route');
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Fetch full user from DB - NEVER trust token data alone for security
        const [users] = await pool.query(
            'SELECT id, name, email, role, status, is_verified, location_id, mobile_number, address FROM users WHERE id = ?',
            [decoded.id]
        );

        if (users.length === 0) {
            return sendResponse(res, 404, false, 'User not found');
        }

        const user = users[0];

        // Strict Status Check
        if (user.status !== 'active') {
            return sendResponse(res, 403, false, 'Your account is pending or suspended');
        }

        if (!user.is_verified) {
            return sendResponse(res, 403, false, 'Please verify your email first');
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Auth Error:', error);
        return sendResponse(res, 401, false, 'Token is invalid or expired');
    }
};

const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return sendResponse(res, 401, false, 'Authentication Required');
        }

        const allowedRoles = Array.isArray(roles) ? roles : [roles];

        if (!allowedRoles.includes(req.user.role)) {
            return sendResponse(res, 403, false, 'Access Forbidden: Insufficient Permissions');
        }
        next();
    };
};

// Check if user has specific location (for security dispatch/receiving gates)
const requireLocation = (type = 'any') => {
    return async (req, res, next) => {
        if (!req.user) {
            return sendResponse(res, 401, false, 'Authentication Required');
        }

        // Only enforce for security role
        if (req.user.role !== 'security' && req.user.role !== 'admin') {
            return next();
        }

        try {
            const [users] = await pool.query('SELECT location_id FROM users WHERE id = ?', [req.user.id]);
            if (users.length === 0) return sendResponse(res, 404, false, 'User not found');
            
            const userLocationId = users[0].location_id;
            
            if (req.user.role === 'security' && !userLocationId) {
                return sendResponse(res, 403, false, 'Security personnel must be assigned to a location');
            }

            req.user.location_id = userLocationId;
            next();
        } catch (error) {
            console.error('Location Check Error:', error);
            return sendResponse(res, 500, false, 'Internal Server Error during location check');
        }
    };
};

module.exports = {
    protect,
    authorize: requireRole,
    requireLocation,
    sendResponse
};
