const express = require('express');
const router = express.Router();
const { getLocations, createLocation, updateLocation } = require('../controllers/location.controller');
const { protect, authorize } = require('../middleware/auth.middleware');

// Publicly available to authenticated users (for dropdowns)
router.get('/', protect, getLocations);

// Admin only routes
router.post('/', protect, authorize('admin'), createLocation);
router.put('/:id', protect, authorize('admin'), updateLocation);

module.exports = router;
