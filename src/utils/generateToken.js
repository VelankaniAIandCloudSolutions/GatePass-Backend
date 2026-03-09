const jwt = require('jsonwebtoken');
require('dotenv').config();

const generateToken = (payload) => {
    return jwt.sign(
        { 
            id: payload.id, 
            role: payload.role, 
            location_id: payload.location_id 
        }, 
        process.env.JWT_SECRET, 
        { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
};

module.exports = generateToken;
