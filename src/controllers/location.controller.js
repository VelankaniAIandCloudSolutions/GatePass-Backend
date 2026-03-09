const pool = require('../config/db.config');
const { sendResponse } = require('../middleware/auth.middleware');

// Get all active locations (Public/Auth)
const getLocations = async (req, res) => {
    try {
        const query = req.user.role === 'admin' 
            ? 'SELECT * FROM locations ORDER BY location_name ASC'
            : 'SELECT * FROM locations WHERE is_active = true ORDER BY location_name ASC';
        const [locations] = await pool.query(query);
        return sendResponse(res, 200, true, 'Locations fetched successfully', locations);
    } catch (error) {
        console.error('Get Locations Error:', error);
        return sendResponse(res, 500, false, 'Failed to fetch locations');
    }
};

// Admin: Create Location
const createLocation = async (req, res) => {
    const { location_name, address_text, contact_person, phone, security_email } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO locations (location_name, address_text, contact_person, phone, security_email) VALUES (?, ?, ?, ?, ?)',
            [location_name, address_text, contact_person, phone, security_email || '']
        );
        return sendResponse(res, 201, true, 'Location created successfully', { id: result.insertId });
    } catch (error) {
        console.error('Create Location Error:', error);
        return sendResponse(res, 500, false, 'Failed to create location');
    }
};

// Admin: Update Location
const updateLocation = async (req, res) => {
    const { id } = req.params;
    const { location_name, address_text, contact_person, phone, security_email, is_active } = req.body;
    try {
        await pool.query(
            'UPDATE locations SET location_name = ?, address_text = ?, contact_person = ?, phone = ?, security_email = ?, is_active = ? WHERE id = ?',
            [location_name, address_text, contact_person, phone, security_email, is_active, id]
        );
        return sendResponse(res, 200, true, 'Location updated successfully');
    } catch (error) {
        console.error('Update Location Error:', error);
        return sendResponse(res, 500, false, 'Failed to update location');
    }
};

module.exports = {
    getLocations,
    createLocation,
    updateLocation
};
