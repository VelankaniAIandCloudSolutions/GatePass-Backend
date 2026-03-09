const express = require('express');
const router = express.Router();
const materialController = require('../controllers/material.controller');
const { protect, authorize, requireLocation } = require('../middleware/auth.middleware');

// 1. User: Create Pass
router.post('/create', protect, authorize('user'), materialController.createMaterialPass);
router.post('/preview', protect, authorize('user'), materialController.pdfLimiter, materialController.previewMaterialPass);

// 2. Manager Actions
router.post('/manager/update', protect, authorize('manager'), materialController.updateManagerStatus);

// 2.1 Token-Based Public Actions (For Email Buttons)
router.get('/manager/approve', materialController.approveMaterialByToken);
router.get('/manager/reject', materialController.rejectMaterialByToken);
router.get('/manager/pdf', materialController.pdfLimiter, materialController.getPassPDFByToken);

// Security Token Actions
router.get('/security/approve', materialController.approveSecurityByToken);
router.get('/security/reject', materialController.rejectSecurityByToken);

// 3. Security Dashboard Actions
router.post('/security/dispatch', protect, authorize('security'), requireLocation('dispatch'), materialController.markDispatched);
router.post('/security/receive', protect, authorize('security'), requireLocation('receiving'), materialController.markReceived);
router.post('/security/reject', protect, authorize('security'), materialController.rejectSecurityStatus);

router.get('/track', protect, materialController.getPassTracking);
router.get('/pending', protect, materialController.getPendingPasses);
router.get('/dashboard-stats', protect, materialController.getDashboardStats);
router.get('/status/completed', protect, materialController.getCompletedPasses);
router.get('/status/:status', protect, materialController.getPassesByStatus);
router.get('/pdf/:id', protect, materialController.pdfLimiter, materialController.getPassPDF);

module.exports = router;
