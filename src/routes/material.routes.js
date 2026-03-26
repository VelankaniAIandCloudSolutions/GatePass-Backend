const express = require('express');
const router = express.Router();
const materialController = require('../controllers/material.controller');
const { protect, authorize, requireLocation } = require('../middleware/auth.middleware');

// 1. User: Create Pass
router.post('/create', protect, authorize('user', 'admin'), materialController.createMaterialPass);
router.post('/preview', protect, authorize('user', 'admin'), materialController.pdfLimiter, materialController.previewMaterialPass);

// 2. Manager Actions
router.post('/manager/update', protect, authorize('manager', 'admin'), materialController.updateManagerStatus);

// 2.1 Token-Based Public Actions (For Email Buttons)
router.get('/manager/approve', materialController.approveMaterialByToken);
router.get('/manager/reject', materialController.rejectMaterialByToken);
router.get('/manager/pdf', materialController.pdfLimiter, materialController.getPassPDFByToken);

// Security Token Actions
router.get('/security/approve', materialController.approveSecurityByToken);
router.get('/security/reject', materialController.rejectSecurityByToken);

// 2.2 Receiver Actions
router.get('/confirm-receiver', materialController.confirmReceiverByToken);
router.get('/return/initiate-form', materialController.getReturnInitiationForm);
router.post('/return/initiate', materialController.initiateReturn); // Public endpoint handles token or auth
router.post('/confirm-receiver-portal', protect, materialController.confirmReceiverPortal);
router.post('/reject-receiver-portal', protect, materialController.rejectReceiverPortal);

// 2.3 RGP Return Flow Actions
router.post('/initiate-return', protect, authorize('user', 'admin'), materialController.initiateReturn);
router.post('/confirm-return-receipt', protect, authorize('user', 'admin'), materialController.confirmReturnReceipt);

// 3. Security Dashboard Actions
router.post('/security/dispatch', protect, authorize('security', 'admin'), requireLocation('dispatch'), materialController.markDispatched);
router.post('/security/receive', protect, authorize('security', 'admin'), requireLocation('receiving'), materialController.markReceived);
router.post('/security/reject', protect, authorize('security', 'admin'), materialController.rejectSecurityStatus);
// Return flow security actions
router.post('/security/return-dispatch', protect, authorize('security', 'admin'), materialController.markReturnDispatched);
router.post('/security/return-receive', protect, authorize('security', 'admin'), materialController.markReturnReceived);
// External NRGP: SG1 assigns driver and completes pass
router.post('/security/external-nrgp-complete', protect, authorize('security', 'admin'), materialController.markExternalNRGPComplete);
// External RGP Return Flow
router.post('/security/external-rgp-return-start', protect, authorize('security', 'admin'), materialController.markExternalRGPReturnStart);
router.post('/security/external-rgp-return-confirm', protect, authorize('security', 'admin'), materialController.markExternalRGPReturnConfirmed);
router.get('/confirm-external-rgp-return', materialController.confirmExternalRGPReturnByCreator);
router.post('/confirm-external-rgp-return', protect, materialController.confirmExternalRGPReturnByCreator);


router.get('/track', protect, materialController.getPassTracking);
router.get('/pending', protect, materialController.getPendingPasses);
router.get('/dashboard-stats', protect, materialController.getDashboardStats);
router.get('/history', protect, materialController.getHistoryPasses);
router.get('/status/:status', protect, materialController.getPassesByStatus);
router.get('/pdf/:id', protect, materialController.pdfLimiter, materialController.getPassPDF);

module.exports = router;
