const pool = require('../config/db.config');
const crypto = require('crypto');
const { sendResponse } = require('../middleware/auth.middleware');
const { generateChallanPDF } = require('../services/pdf.service');
const rateLimit = require('express-rate-limit');

// 1. Rate Limiter for PDF Generation
const pdfLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { success: false, message: 'Too many PDF requests. Please try again later.' }
});

// Helper: Log Stage Tracking with Enhanced Audit Trail
const logTracking = async (connection, materialId, stage, status, oldStatus, newStatus, actedBy, actionLocation, role) => {
    try {
        await connection.query(
            `INSERT INTO material_tracking_logs 
            (material_id, stage, status, old_status, new_status, acted_by, action_location, role) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [materialId, stage, status, oldStatus, newStatus, actedBy, actionLocation, role]
        );
    } catch (err) {
        console.error(`Tracking log failed for stage ${stage}:`, err);
    }
};

// Helper: Fetch Full Pass Data using location and user names
const fetchFullPassData = async (passId) => {
    const [passes] = await pool.query(`
        SELECT 
            p.*, 
            p.receiver_name,
            p.receiver_mobile,
            au.name as admin_name,
            au.signature_path as admin_signature_path,
            u.name as created_by_name,
            u.mobile_number as created_user_mobile,
            u.address as created_by_address,
            fl.location_name as from_location_name,
            fl.address_text as from_address,
            fl.contact_person as from_contact,
            fl.phone as from_phone,
            tl.location_name as to_location_name,
            tl.address_text as to_address_detailed,
            tl.contact_person as to_contact,
            tl.phone as to_phone,
            du.name as dispatched_by_name,
            du.signature_path as security_origin_signature_path,
            (SELECT mobile_number FROM users WHERE role = 'security' AND location_id = p.from_location_id AND status = 'active' LIMIT 1) as origin_security_mobile,
            ru.name as received_by_name,
            ru.signature_path as security_destination_signature_path,
            (SELECT mobile_number FROM users WHERE role = 'security' AND location_id = p.to_location_id AND status = 'active' LIMIT 1) as destination_security_mobile,
            mu.name as manager_name,
            mu.signature_path as manager_signature_path,
            mu.mobile_number as manager_mobile,
            mu.address as manager_address,
            rec.signature_path as receiver_signature_path,
            u.signature_path as created_by_signature_path
        FROM material_gate_passes p
        LEFT JOIN users u ON p.created_by = u.id
        LEFT JOIN locations fl ON p.from_location_id = fl.id
        LEFT JOIN locations tl ON p.to_location_id = tl.id
        LEFT JOIN users du ON p.dispatched_by = du.id
        LEFT JOIN users ru ON p.received_by = ru.id
        LEFT JOIN users mu ON p.approved_by_manager_id = mu.id
        LEFT JOIN users au ON p.approved_by_admin_id = au.id
        LEFT JOIN users rec ON p.receiver_id = rec.id
        WHERE p.id = ?
    `, [passId]);

    if (passes.length === 0) return null;
    const pass = passes[0];

    const [items] = await pool.query('SELECT * FROM material_items WHERE material_pass_id = ?', [passId]);
    pass.items = items;

    return pass;
};

// 2. PREVIEW Material Pass (No DB Insert)
const previewMaterialPass = async (req, res) => {
    const { 
        items, movement_type, pass_type, from_location_id, to_location_id, external_address,
        customer_reference, no_of_boxes, net_weight, gross_weight,
        receiver_id, receiver_name, receiver_mobile, receiver_email,
        expected_return_date
    } = req.body;

    try {
        // Fetch location names for the PDF
        const [locations] = await pool.query('SELECT id, location_name, address_text, contact_person, phone FROM locations WHERE id IN (?, ?)', 
            [from_location_id, to_location_id || 0]);
        
        // Fetch Security Contacts for the locations
        const [securities] = await pool.query(
            'SELECT mobile_number, location_id FROM users WHERE role = "security" AND status = "active" AND location_id IN (?, ?)',
            [from_location_id, to_location_id || 0]
        );

        const fromLoc = locations.find(l => l.id == from_location_id);
        const toLoc = locations.find(l => l.id == to_location_id);
        const fromSec = securities.find(s => s.location_id == from_location_id);
        const toSec = securities.find(s => s.location_id == to_location_id);

        const passData = {
            dc_number: 'DRAFT',
            created_at: new Date(),
            from_location_name: fromLoc?.location_name || '...',
            from_address: fromLoc?.address_text || '...',
            from_contact: fromLoc?.contact_person || '...',
            from_phone: fromLoc?.phone || '...',
            to_location_name: toLoc?.location_name || '...',
            to_address_detailed: toLoc?.address_text || '...',
            to_contact: toLoc?.contact_person || '...',
            external_address: external_address || '...',
            origin_security_mobile: fromSec?.mobile_number || null,
            destination_security_mobile: toSec?.mobile_number || null,
            created_by_name: req.user.name,
            created_user_mobile: req.user.mobile_number || null,
            movement_type,
            customer_reference,
            no_of_boxes: no_of_boxes || 0,
            net_weight,
            gross_weight,
            receiver_name,
            receiver_mobile,
            pass_type: pass_type || 'RGP',
            items: items.map(i => ({ ...i, unit_cost: 0, total: 0 })),
            created_by_signature_path: req.user.signature_path || null
        };

        const pdfBuffer = await generateChallanPDF(passData, true); // true = Draft Watermark
        
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="Draft_Challan.pdf"',
            'Content-Length': pdfBuffer.length
        });
        res.send(pdfBuffer);
    } catch (err) {
        console.error('Preview Error:', err);
        return sendResponse(res, 500, false, 'Failed to generate preview');
    }
};

// 3. CREATE Material Pass
const createMaterialPass = async (req, res) => {
    const { 
        items, movement_type, pass_type, from_location_id, to_location_id, external_address,
        customer_reference, no_of_boxes, net_weight, gross_weight,
        receiver_id, receiver_name, receiver_mobile, receiver_email,
        expected_return_date
    } = req.body;
    const created_by = req.user.id;

    // Safety Guard: Prevent self-movement
    if (movement_type === 'internal' && from_location_id === to_location_id) {
        return sendResponse(res, 400, false, 'From and To locations cannot be the same');
    }

    // Optional: Receiver Mobile Validation (7-15 chars, digits or +)
    if (receiver_mobile) {
        const mobileRegex = /^\+?[0-9]{7,15}$/;
        if (!mobileRegex.test(receiver_mobile)) {
            return sendResponse(res, 400, false, 'Invalid receiver mobile number format');
        }
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // DC Number Generation
        const year = new Date().getFullYear();
        const prefix = `DC${year}`;
        const [rows] = await connection.query(
            'SELECT dc_number FROM material_gate_passes WHERE dc_number LIKE ? ORDER BY id DESC LIMIT 1 FOR UPDATE',
            [`${prefix}%`]
        );

        let nextNumber = 1;
        if (rows.length > 0) {
            nextNumber = parseInt(rows[0].dc_number.replace(prefix, '')) + 1;
        }
        const dc_number = `${prefix}${nextNumber.toString().padStart(4, '0')}`;

        const [managers] = await connection.query('SELECT manager_id FROM user_managers WHERE user_id = ?', [created_by]);
        if (managers.length === 0) {
            await connection.rollback();
            connection.release();
            return sendResponse(res, 400, false, 'Action Blocked: No managers linked to your profile. Please add at least one manager in Profile Settings first.');
        }

        const [result] = await connection.query(
            `INSERT INTO material_gate_passes 
            (dc_number, created_by, movement_type, pass_type, from_location_id, to_location_id, external_address, receiver_id, receiver_name, receiver_mobile, receiver_email, customer_reference, no_of_boxes, net_weight, gross_weight, status, expected_return_date) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_MANAGER', ?)`,
            [
                dc_number, created_by, movement_type, pass_type || 'RGP', from_location_id, 
                movement_type === 'internal' ? to_location_id : null, 
                movement_type === 'external' ? external_address : null,
                receiver_id || null, 
                receiver_name?.trim() || null, 
                receiver_mobile?.trim() || null,
                receiver_email?.trim() || null,
                customer_reference || null, no_of_boxes || 0, net_weight || null, gross_weight || null,
                pass_type === 'RGP' ? (expected_return_date || null) : null
            ]
        );

        const passId = result.insertId;
        const itemValues = items.map(item => [
            passId, item.part_no, item.description, item.qty, 0, 0, item.remarks
        ]);

        await connection.query(
            'INSERT INTO material_items (material_pass_id, part_no, description, qty, unit_cost, total, remarks) VALUES ?',
            [itemValues]
        );

        // Generate PDF Access Token (Persistent)
        const pdfAccessToken = crypto.randomBytes(32).toString('hex');
        await connection.query(
            'UPDATE material_gate_passes SET pdf_access_token = ? WHERE id = ?',
            [pdfAccessToken, passId]
        );

        // --- Log Submission Stage ---
        await logTracking(connection, passId, 'SUBMISSION', 'COMPLETED', null, 'PENDING_MANAGER', created_by, from_location_id, req.user.role);

        await connection.commit();

        // --- Manager Notifications (ASYNCHRONOUS - POST COMMIT) ---
        const triggerManagerEmails = async () => {
            try {
                const [managers] = await pool.query(`
                    SELECT u.id, u.email, u.name 
                    FROM users u
                    JOIN user_managers um ON u.id = um.manager_id
                    WHERE um.user_id = ?
                `, [created_by]);

                const actionToken = crypto.randomBytes(32).toString('hex');
                const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); 

                await pool.query(
                    'UPDATE material_gate_passes SET manager_action_token = ?, manager_token_expires_at = ? WHERE id = ?',
                    [actionToken, expiresAt, passId]
                );

                if (managers.length > 0) {
                    const { sendManagerApprovalEmail } = require('../utils/mail.util');
                    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
                    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

                    for (const manager of managers) {
                        try {
                            await sendManagerApprovalEmail(manager.email, {
                                managerName: manager.name,
                                dcNumber: dc_number,
                                passType: req.body.pass_type || 'NRGP',
                                userName: req.user.name,
                                approveUrl: `${baseUrl}/api/material/manager/approve?token=${actionToken}&managerId=${manager.id}`,
                                rejectUrl: `${baseUrl}/api/material/manager/reject?token=${actionToken}&managerId=${manager.id}`,
                                pdfUrl: `${baseUrl}/api/material/manager/pdf?token=${pdfAccessToken}`,
                                loginUrl: frontendUrl
                            });
                        } catch (e) {
                        }
                    }
                }
            } catch (err) {
                console.error('Manager Notification Error:', err);
            }
        };
        
        triggerManagerEmails();

        return sendResponse(res, 201, true, 'Material Pass created successfully', { dc_number, id: passId });

    } catch (err) {
        await connection.rollback();
        console.error('Create Pass Error:', err);
        return sendResponse(res, 500, false, 'Failed to create Material Pass');
    } finally {
        connection.release();
    }
};

// 4. GET Pass PDF
const getPassPDF = async (req, res) => {
    const { id } = req.params;
    try {
        const passData = await fetchFullPassData(id);
        if (!passData) return sendResponse(res, 404, false, 'Pass not found');

        const pdfBuffer = await generateChallanPDF(passData, false);
        
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="Challan_${passData.dc_number}.pdf"`
        });
        res.send(pdfBuffer);
    } catch (err) {
        console.error('PDF Error:', err);
        return sendResponse(res, 500, false, 'Failed to generate PDF');
    }
};

// 5. UPDATE Status (Manager) - Standardized for Dashboard & Token
const updateManagerStatus = async (req, res) => {
    const id = req.body.id || req.body.passId;
    const status = req.body.status || (req.body.action === 'approve' ? 'approved' : req.body.action === 'reject' ? 'rejected' : null);
    const responseFormat = req.body.responseFormat || req.query.format || 'json';
    
    // Support either authenticated user or managerId from token/query
    const managerId = req.user ? req.user.id : (req.body.managerId || req.query.managerId || null);

    const renderHtmlResponse = (success, title, msg) => {
        return res.send(`
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 100px auto; text-align: center; padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border: 1px solid ${success ? '#e2e8f0' : '#fee2e2'};">
                <div style="font-size: 48px; margin-bottom: 20px;">${success ? '✅' : '❌'}</div>
                <h1 style="color: ${success ? '#1e293b' : '#991b1b'}; margin-bottom: 10px;">${title}</h1>
                <p style="color: #64748b; font-size: 16px; line-height: 1.6;">${msg}</p>
                <div style="margin-top: 30px;">
                    <a href="http://localhost:8000" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">Back to Portal</a>
                </div>
            </div>
        `);
    };

    if (!id || !status) {
        if (responseFormat === 'html') return renderHtmlResponse(false, 'Missing Data', 'Gate pass ID or action missing.');
        return sendResponse(res, 400, false, 'ID and Action are required');
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [id]);
        if (!pass.length) throw new Error('Pass not found');

        // Audit Lock: Block if already COMPLETED
        if (pass[0].status === 'COMPLETED') {
            throw new Error('Action Blocked: This pass is marked as COMPLETED and cannot be modified.');
        }
        
        const currentStatus = (pass[0].status || '').toUpperCase();
        if (currentStatus !== 'PENDING_MANAGER') {
            if (responseFormat === 'html') return renderHtmlResponse(true, 'Already Handled', `This request has already been ${currentStatus.replace(/_/g, ' ')}.`);
            throw new Error(`Approval blocked: Pass is already ${currentStatus}`);
        }

        const isApproved = (status || '').toLowerCase().includes('approve');
        const finalStatus = isApproved ? 'PENDING_SECURITY_ORIGIN' : 'REJECTED';
        
        const approvedByRole = req.user && req.user.role === 'admin' ? 'admin' : 'manager';
        const approvedByAdminId = approvedByRole === 'admin' ? req.user.id : null;
        const approvedByManagerId = approvedByRole === 'manager' ? managerId : null;

        const [result] = await connection.query(
            `UPDATE material_gate_passes 
             SET status = ?, 
                 approved_by_manager_id = ?, 
                 approved_by_admin_id = ?,
                 approved_by_role = ?,
                 approved_by_manager_at = NOW(),
                 manager_action_token = NULL,
                 rejected_at = ${!isApproved ? 'NOW()' : 'NULL'}
             WHERE id = ? AND status = 'PENDING_MANAGER'`,
            [finalStatus, approvedByManagerId, approvedByAdminId, approvedByRole, id]
        );

        if (result.affectedRows === 0) {
             throw new Error('Action failed: This request has already been processed or is no longer pending manager approval.');
        }

        const trackingStage = approvedByRole === 'admin' ? 'MANAGER_APPROVAL (Admin Override)' : 'MANAGER_APPROVAL';
        await logTracking(connection, id, trackingStage, isApproved ? 'COMPLETED' : 'REJECTED', currentStatus, finalStatus, req.user ? req.user.id : managerId, null, approvedByRole);

        if (isApproved) {
            // FIRE AND FORGET ASYNC NOTIFICATION (POST COMMIT)
            const triggerSecurityEmail = async () => {
                try {
                    console.log(`[DEBUG] Triggering security email for pass ${id}, location ${pass[0].from_location_id}`);
                    const [security] = await pool.query(
                        "SELECT email, name FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1",
                        [pass[0].from_location_id]
                    );
                    console.log(`[DEBUG] Found ${security.length} security users`);

                    if (security.length > 0) {
                        const { sendOriginSecurityEmail } = require('../utils/mail.util');
                        const securityToken = crypto.randomBytes(32).toString('hex');
                        const securityTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); 

                        await pool.query(
                            "UPDATE material_gate_passes SET security_action_token = ?, security_token_expires_at = ? WHERE id = ?",
                            [securityToken, securityTokenExpiry, id]
                        );

                        const fullPass = await fetchFullPassData(id);
                        const approverName = approvedByRole === 'admin' ? fullPass.admin_name : fullPass.manager_name;
                        const approverLabel = approvedByRole === 'admin' ? 'Admin' : 'Manager';
                        const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

                        if (approverName && security[0].email) {
                            console.log(`[DEBUG] Sending email to security: ${security[0].email}`);
                            await sendOriginSecurityEmail(security[0].email, {
                                securityName: security[0].name,
                                dcNumber: fullPass.dc_number,
                                passType: fullPass.pass_type,
                                origin: fullPass.from_location_name,
                                destination: fullPass.to_location_name || fullPass.external_address,
                                userName: fullPass.created_by_name,
                                managerName: approverName,
                                approverRole: approverLabel,
                                items: fullPass.items,
                                approveUrl: `${baseUrl}/api/material/security/approve?token=${securityToken}&passId=${id}`,
                                rejectUrl: `${baseUrl}/api/material/security/reject?token=${securityToken}&passId=${id}`,
                                pdfUrl: `${baseUrl}/api/material/manager/pdf?token=${fullPass.pdf_access_token}`
                            });
                            console.log(`[DEBUG] Security email sent to ${security[0].email}`);
                        }
                    }
                } catch (err) {
                    console.error('Security Notification Error:', err);
                }
            };
            
            // Fire asynchronously but ensure it has everything it needs
            triggerSecurityEmail(); 
        }

        await connection.commit();
        if (responseFormat === 'html') return renderHtmlResponse(true, 'Action Successful', `The gate pass has been successfully ${finalStatus === 'REJECTED' ? 'REJECTED' : 'APPROVED'}.`);
        return sendResponse(res, 200, true, `Pass ${finalStatus} successfully`);
    } catch (err) {
        await connection.rollback();
        console.error('Update manager status error:', err);
        if (responseFormat === 'html') return renderHtmlResponse(false, 'Action Failed', err.message || 'Update failed.');
        return sendResponse(res, 400, false, err.message || 'Update failed');
    } finally {
        connection.release();
    }
};

// 6. DISPATCH (Security) - Strict Guard (Status + Location)
const markDispatched = async (req, res) => {
    const { passId, vehicle_number } = req.body;
    const securityUser = req.user;

    try {
        await markDispatchedInternal(passId, vehicle_number || 'PORTAL_AUTH', securityUser);
        return sendResponse(res, 200, true, 'Pass cleared at Origin successfully');
    } catch (err) {
        console.error('Portal dispatch error:', err);
        return sendResponse(res, 400, false, err.message || 'Dispatch failed');
    }
};

// 7. RECEIVE (Security) - Strict Guard (Status + Location)
const markReceived = async (req, res) => {
    const { passId } = req.body;
    const securityUser = req.user;

    try {
        await markReceivedInternal(passId, securityUser);
        return sendResponse(res, 200, true, 'Pass received & completed successfully');
    } catch (err) {
        console.error('Portal receive error:', err);
        return sendResponse(res, 400, false, err.message || 'Receipt failed');
    }
};

// 7.5 REJECT (Security) - At any stage
const rejectSecurityStatus = async (req, res) => {
    const { passId, rejected_reason } = req.body;
    const securityUser = req.user;

    try {
        await rejectSecurityInternal(passId, rejected_reason || 'Rejected by Security', securityUser);
        return sendResponse(res, 200, true, 'Pass rejected by security');
    } catch (err) {
        console.error('Security rejection error:', err);
        return sendResponse(res, 400, false, err.message || 'Rejection failed');
    }
};

// 8. BUCKETED Fetch
const getPendingPasses = async (req, res) => {
    const { role, id, location_id: siteId } = req.user;
    try {
        if (role === 'security') {
            const [dispatchable] = await pool.query(`
                SELECT p.*, fl.location_name as from_name, tl.location_name as to_name 
                FROM material_gate_passes p 
                LEFT JOIN locations fl ON p.from_location_id = fl.id 
                LEFT JOIN locations tl ON p.to_location_id = tl.id 
                WHERE p.from_location_id = ? AND p.status IN ("PENDING_SECURITY_ORIGIN", "approved", "APPROVED")`, [siteId]);
            
            const [receivable] = await pool.query(`
                SELECT p.*, fl.location_name as from_name, tl.location_name as to_name 
                FROM material_gate_passes p 
                LEFT JOIN locations fl ON p.from_location_id = fl.id 
                LEFT JOIN locations tl ON p.to_location_id = tl.id 
                WHERE p.to_location_id = ? AND (p.status = "PENDING_SECURITY_DESTINATION" OR (p.status = "approved" AND p.dispatched_at IS NOT NULL AND p.received_at IS NULL))`, [siteId]);
            
            const [history] = await pool.query(`
                SELECT p.*, fl.location_name as from_name, tl.location_name as to_name 
                FROM material_gate_passes p 
                LEFT JOIN locations fl ON p.from_location_id = fl.id 
                LEFT JOIN locations tl ON p.to_location_id = tl.id 
                WHERE (p.from_location_id = ? OR p.to_location_id = ?) AND p.status IN ("COMPLETED", "REJECTED")
                ORDER BY p.updated_at DESC LIMIT 50`, [siteId, siteId]);
            
            return sendResponse(res, 200, true, 'Bucketed Fetch', { dispatchable, receivable, history });
        }

        let query = 'SELECT p.*, fl.location_name as from_name, tl.location_name as to_name';
        if (role === 'manager') {
            query = 'SELECT p.*, um.manager_id, fl.location_name as from_name, tl.location_name as to_name';
        }
        query += ' FROM material_gate_passes p LEFT JOIN locations fl ON p.from_location_id = fl.id LEFT JOIN locations tl ON p.to_location_id = tl.id';
        let params = [];

        if (role === 'user') {
            query += ' WHERE (p.created_by = ? OR (p.receiver_id = ? AND p.status = "PENDING_RECEIVER_CONFIRMATION"))';
            params = [id, id];
        } else if (role === 'manager') {
            query += ' JOIN user_managers um ON p.created_by = um.user_id WHERE p.status = "PENDING_MANAGER" AND um.manager_id = ?';
            params = [id];
        }

        query += ' ORDER BY p.created_at DESC';
        const [passes] = await pool.query(query, params);
        return sendResponse(res, 200, true, 'Passes fetched', passes);
    } catch (err) {
        return sendResponse(res, 500, false, 'Fetch error');
    }
};

const approveMaterialByToken = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('<h1>Error</h1><p>Missing security token.</p>');

    try {
        const [pass] = await pool.query(
            'SELECT id, status, manager_action_status, manager_token_expires_at FROM material_gate_passes WHERE manager_action_token = ?', 
            [token]
        );

        if (!pass.length) return res.status(404).send('<h1>Link Invalid</h1><p>This approval link is invalid or has expired.</p>');
        
        // Pass the format to updateManagerStatus
        req.body = { 
            id: pass[0].id, 
            status: 'approved', 
            managerId: req.query.managerId,
            responseFormat: 'html'
        };
        return updateManagerStatus(req, res);
    } catch (err) {
        console.error('Token approval error:', err);
        return res.status(500).send('<h1>Server Error</h1><p>Failed to process approval request.</p>');
    }
};

const rejectMaterialByToken = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('<h1>Error</h1><p>Missing security token.</p>');

    try {
        const [pass] = await pool.query(
            'SELECT id, status, manager_action_status, manager_token_expires_at FROM material_gate_passes WHERE manager_action_token = ?', 
            [token]
        );

        if (!pass.length) return res.status(404).send('<h1>Link Invalid</h1><p>This link is invalid or has expired.</p>');
        
        req.body = { 
            id: pass[0].id, 
            status: 'rejected', 
            managerId: req.query.managerId,
            responseFormat: 'html'
        };
        return updateManagerStatus(req, res);
    } catch (err) {
        console.error('Token rejection error:', err);
        return res.status(500).send('<h1>Server Error</h1><p>Failed to process rejection request.</p>');
    }
};

const approveSecurityByToken = async (req, res) => {
    const { token, passId } = req.query;
    return handleSecurityTokenAction(req, res, token, passId, 'approve');
};

const rejectSecurityByToken = async (req, res) => {
    const { token, passId } = req.query;
    return handleSecurityTokenAction(req, res, token, passId, 'reject');
};

const handleSecurityTokenAction = async (req, res, token, passId, action) => {
    // Basic audit lock check for token actions
    const [pCheck] = await pool.query('SELECT status FROM material_gate_passes WHERE id = ?', [passId]);
    if (pCheck.length > 0 && pCheck[0].status === 'COMPLETED') {
        return res.status(403).send('<h1>Action Blocked</h1><p>This pass is mark as COMPLETED and cannot be modified.</p>');
    }

    const renderHtmlResponse = (success, title, msg, extraHtml = '') => {
        return res.send(`
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 100px auto; text-align: center; padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border: 1px solid ${success ? '#e2e8f0' : '#fee2e2'};">
                <div style="font-size: 48px; margin-bottom: 20px;">${success ? '✅' : '❌'}</div>
                <h1 style="color: ${success ? '#1e293b' : '#991b1b'}; margin-bottom: 10px;">${title}</h1>
                <p style="color: #64748b; font-size: 16px; line-height: 1.6;">${msg}</p>
                ${extraHtml}
                <div style="margin-top: 30px;">
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:8000'}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">Back to Portal</a>
                </div>
            </div>
        `);
    };

    if (!token || !passId) return renderHtmlResponse(false, 'Error', 'Missing security token or pass ID.');

    try {
        const [pass] = await pool.query(
            'SELECT * FROM material_gate_passes WHERE id = ? AND security_action_token = ?', 
            [passId, token]
        );

        if (!pass.length) return renderHtmlResponse(false, 'Link Invalid', 'This link is invalid or has expired.');
        
        if (pass[0].security_token_expires_at && new Date() > new Date(pass[0].security_token_expires_at)) {
            return renderHtmlResponse(false, 'Link Expired', 'This secure link has expired for security reasons.');
        }

        const currentStatus = pass[0].status;

        if (action === 'reject') {
            // Unify with shared logic
            const [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND (location_id = ? OR location_id = ?) AND status = 'active' LIMIT 1", [pass[0].from_location_id, pass[0].to_location_id]);
            if (!security.length) throw new Error('No active security user found for rejection.');
            
            await rejectSecurityInternal(passId, 'Rejected via email link', security[0]);
            return renderHtmlResponse(true, 'Rejected', 'The material movement has been rejected by security.');
        }

        // Approve logic
        if (currentStatus === 'PENDING_SECURITY_ORIGIN') {
            const vehicleNumber = req.query.vehicle_number;
            if (!vehicleNumber) {
                // Show form to capture vehicle number
                const vehicleForm = `
                    <div style="margin-top: 25px; padding-top: 25px; border-top: 1px solid #e2e8f0;">
                        <form action="/api/material/security/approve" method="GET">
                            <input type="hidden" name="token" value="${token}" />
                            <input type="hidden" name="passId" value="${passId}" />
                            <label style="display: block; font-size: 14px; font-weight: 600; color: #1e293b; margin-bottom: 8px; text-align: left;">Vehicle Number (Required):</label>
                            <input type="text" name="vehicle_number" placeholder="e.g. KA01AB1234" required style="width: 100%; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; margin-bottom: 20px; box-sizing: border-box;" />
                            <button type="submit" style="width: 100%; background: #10b981; color: white; padding: 12px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer;">✅ Confirm Dispatch</button>
                        </form>
                    </div>
                `;
                return renderHtmlResponse(true, 'Dispatch Approval', `Please enter the vehicle number to complete the dispatch for ${pass[0].dc_number}.`, vehicleForm);
            }

            // Proceed with dispatch
            const [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [pass[0].from_location_id]);
            if (!security.length) throw new Error('No active security user found for dispatch.');
            
            await markDispatchedInternal(passId, vehicleNumber, security[0]);
            return renderHtmlResponse(true, 'Dispatched', 'Material has been successfully marked as DISPATCHED.');
        } else if (currentStatus === 'PENDING_SECURITY_DESTINATION') {
            // Receive
            const [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [pass[0].to_location_id]);
            if (!security.length) throw new Error('No active security user found for receiving.');
            req.user = security[0];
            req.body = { passId };
            
            const result = await markReceivedInternal(passId, security[0]);
            return renderHtmlResponse(true, 'Received', 'Material has been successfully marked as RECEIVED.');
        } else {
            return renderHtmlResponse(true, 'Already Handled', `This request is already in ${currentStatus.replace(/_/g, ' ')} stage.`);
        }
    } catch (err) {
        console.error('Security token action error:', err);
        return renderHtmlResponse(false, 'Action Failed', err.message || 'Operation failed.');
    }
};

// Internal helpers to avoid duplicating complex logic
const markDispatchedInternal = async (passId, vehicle_number, securityUser) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');
        
        if (pass[0].status === 'COMPLETED') throw new Error('Action Blocked: Pass already COMPLETED');

        const currentStatus = pass[0].status;
        if (currentStatus !== 'PENDING_SECURITY_ORIGIN') throw new Error('Pass is not in dispatch stage');

        // Strict Location Match
        if (parseInt(securityUser.location_id) !== parseInt(pass[0].from_location_id)) {
            throw new Error('Unauthorized: You are not at the origin location');
        }

        const nextStatus = 'PENDING_SECURITY_DESTINATION';
        const crypto = require('crypto');
        const nextToken = crypto.randomBytes(32).toString('hex');
        
        const [result] = await connection.query(
            `UPDATE material_gate_passes SET status = ?, dispatched_by = ?, security_origin_approved_at = NOW(), vehicle_number = ?, security_action_token = ?, security_token_expires_at = ADDDATE(NOW(), INTERVAL 1 DAY) 
             WHERE id = ? AND status = 'PENDING_SECURITY_ORIGIN'`,
            [nextStatus, securityUser.id, vehicle_number, nextToken, passId]
        );
        
        if (result.affectedRows === 0) throw new Error('Update failed (Security Race Condition)');

        await logTracking(connection, passId, 'ORIGIN_SECURITY', 'COMPLETED', currentStatus, nextStatus, securityUser.id, securityUser.location_id, 'security');
        
        // Notify Destination Security
        await connection.commit();

        // Notify Destination Security (ASYNC - POST COMMIT)
        const triggerDestSecurityNotify = async () => {
            try {
                if (pass[0].movement_type === 'internal' && pass[0].to_location_id) {
                    const [destSecurity] = await pool.query("SELECT email, name FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [pass[0].to_location_id]);
                    if (destSecurity.length > 0) {
                        const { sendDestinationSecurityEmail } = require('../utils/mail.util');
                        const fullPass = await fetchFullPassData(passId);
                        const approverName = fullPass.approved_by_role === 'admin' ? fullPass.admin_name : fullPass.manager_name;
                        const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
                        
                        if (approverName && destSecurity[0].email) {
                            await sendDestinationSecurityEmail(destSecurity[0].email, {
                                securityName: destSecurity[0].name,
                                dcNumber: fullPass.dc_number,
                                passType: fullPass.pass_type,
                                origin: fullPass.from_location_name,
                                destination: fullPass.to_location_name,
                                userName: fullPass.created_by_name,
                                managerName: approverName,
                                items: fullPass.items,
                                approveUrl: `${baseUrl}/api/material/security/approve?token=${nextToken}&passId=${passId}`,
                                rejectUrl: `${baseUrl}/api/material/security/reject?token=${nextToken}&passId=${passId}`,
                                pdfUrl: `${baseUrl}/api/material/manager/pdf?token=${fullPass.pdf_access_token}`
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('Dest Security Notify Async Error:', err);
            }
        };
        
        setTimeout(triggerDestSecurityNotify, 500);

        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally { connection.release(); }
};

const markReceivedInternal = async (passId, securityUser) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');

        if (pass[0].status === 'COMPLETED') throw new Error('Action Blocked: Pass already COMPLETED');

        const currentStatus = pass[0].status;
        if (currentStatus !== 'PENDING_SECURITY_DESTINATION') throw new Error('Pass is not in receiving stage');

        // Strict Location Match
        if (parseInt(securityUser.location_id) !== parseInt(pass[0].to_location_id)) {
            throw new Error('Unauthorized: You are not at the destination location');
        }

        const isNRGP = pass[0].pass_type === 'NRGP';
        const nextStatus = isNRGP ? 'PENDING_RECEIVER_CONFIRMATION' : 'COMPLETED';
        const receiverToken = isNRGP ? require('crypto').randomBytes(32).toString('hex') : null;

        const [result] = await connection.query(
            `UPDATE material_gate_passes SET status = ?, received_by = ?, security_destination_approved_at = NOW(), security_action_token = ?, receiver_action_token = ?
             WHERE id = ? AND status = 'PENDING_SECURITY_DESTINATION'`, 
            [nextStatus, securityUser.id, null, receiverToken, passId]
        );

        if (result.affectedRows === 0) throw new Error('Update failed (Security Race Condition)');

        await logTracking(connection, passId, 'DESTINATION_SECURITY', isNRGP ? 'RECEIVED_AT_DESTINATION' : 'COMPLETED', currentStatus, nextStatus, securityUser.id, securityUser.location_id, 'security');
        
        await connection.commit();

        // Notify Receiver if NRGP
        if (isNRGP && pass[0].receiver_email) {
            const triggerReceiverNotify = async () => {
                try {
                    const { sendReceiverConfirmationEmail } = require('../utils/mail.util');
                    const fullPass = await fetchFullPassData(passId);
                    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
                    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8000';
                    
                    const materialDetails = fullPass.items.map(item => 
                        `• ${item.description} (Qty: ${item.qty})`
                    ).join('<br/>');

                    await sendReceiverConfirmationEmail(pass[0].receiver_email, {
                        receiverName: fullPass.receiver_name,
                        dcNumber: fullPass.dc_number,
                        passType: fullPass.pass_type,
                        materialDetails: materialDetails,
                        confirmationUrl: `${baseUrl}/api/material/confirm-receiver?token=${receiverToken}&passId=${passId}`,
                        pdfUrl: `${baseUrl}/api/material/manager/pdf?token=${fullPass.pdf_access_token}`
                    });
                } catch (err) {
                    console.error('Receiver Notify Async Error:', err);
                }
            };
            setTimeout(triggerReceiverNotify, 500);
        }

        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally { connection.release(); }
};

// 7.1 Confirm Receiver (NRGP ONLY)
const confirmReceiverByToken = async (req, res) => {
    const { token, passId } = req.query;
    
    const renderHtmlResponse = (success, title, msg) => {
        return res.send(`
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 100px auto; text-align: center; padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border: 1px solid ${success ? '#e2e8f0' : '#fee2e2'};">
                <div style="font-size: 48px; margin-bottom: 20px;">${success ? '✅' : '❌'}</div>
                <h1 style="color: ${success ? '#1e293b' : '#991b1b'}; margin-bottom: 10px;">${title}</h1>
                <p style="color: #64748b; font-size: 16px; line-height: 1.6;">${msg}</p>
                <div style="margin-top: 30px;">
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:8000'}" style="display: inline-block; background: #10b981; color: white; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">Back to Portal</a>
                </div>
            </div>
        `);
    };

    if (!token || !passId) return renderHtmlResponse(false, 'Error', 'Missing confirmation token or pass ID.');

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [pass] = await connection.query(
            'SELECT * FROM material_gate_passes WHERE id = ? AND receiver_action_token = ? FOR UPDATE', 
            [passId, token]
        );

        if (!pass.length) return renderHtmlResponse(false, 'Link Invalid', 'This link is invalid or has already been used.');
        
        if (pass[0].status !== 'PENDING_RECEIVER_CONFIRMATION') {
            return renderHtmlResponse(false, 'Action Invalid', `This pass is currently in ${pass[0].status.replace(/_/g, ' ')} stage.`);
        }

        const nextStatus = 'COMPLETED';
        await connection.query(
            `UPDATE material_gate_passes SET status = ?, receiver_confirmed_at = NOW(), receiver_confirmed_by = ?, receiver_action_token = NULL \r\n             WHERE id = ?`,
            [nextStatus, pass[0].receiver_id || 0, passId]
        );

        await logTracking(connection, passId, 'RECEIVER_CONFIRMATION', 'COMPLETED', 'PENDING_RECEIVER_CONFIRMATION', nextStatus, pass[0].receiver_id || 0, pass[0].to_location_id, 'receiver');

        await connection.commit();
        return renderHtmlResponse(true, 'Confirmed', 'Thank you! You have successfully confirmed receipt of the materials.');
    } catch (err) {
        await connection.rollback();
        console.error('Receiver confirmation error:', err);
        return renderHtmlResponse(false, 'Confirmation Failed', err.message || 'Operation failed.');
    } finally {
        connection.release();
    }
};

const rejectSecurityInternal = async (passId, reason, securityUser) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');

        if (pass[0].status === 'COMPLETED') throw new Error('Action Blocked: Pass already COMPLETED');

        const currentStatus = pass[0].status;
        let stage = '';

        if (currentStatus === 'PENDING_SECURITY_ORIGIN') {
            if (parseInt(securityUser.location_id) !== parseInt(pass[0].from_location_id)) {
                throw new Error('Unauthorized: Rejection only possible at origin location');
            }
            stage = 'ORIGIN_SECURITY';
        } else if (currentStatus === 'PENDING_SECURITY_DESTINATION') {
            if (parseInt(securityUser.location_id) !== parseInt(pass[0].to_location_id)) {
                throw new Error('Unauthorized: Rejection only possible at destination location');
            }
            stage = 'DESTINATION_SECURITY';
        } else {
            throw new Error(`Cannot reject at current stage: ${currentStatus}`);
        }

        const [result] = await connection.query(
            `UPDATE material_gate_passes SET status = 'REJECTED', rejected_by = ?, rejected_at = NOW(), rejected_reason = ?, security_action_token = NULL 
             WHERE id = ? AND status = ?`,
            [securityUser.id, reason, passId, currentStatus]
        );

        if (result.affectedRows === 0) throw new Error('Rejection failed (Race Condition)');

        await logTracking(connection, passId, stage, 'REJECTED', currentStatus, 'REJECTED', securityUser.id, securityUser.location_id, 'security');
        await connection.commit();
        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally { connection.release(); }
};

// 11. Token-Based Action: GET PDF
const getPassPDFByToken = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send('<h1>Error</h1><p>Missing security token.</p>');

    try {
        const [pass] = await pool.query(
            'SELECT id FROM material_gate_passes WHERE pdf_access_token = ?', 
            [token]
        );

        if (!pass.length) return res.status(404).send('<h1>Not Found</h1><p>Invalid PDF access token.</p>');

        req.params = { id: pass[0].id };
        return getPassPDF(req, res);
    } catch (err) {
        console.error('Token PDF error:', err);
        return res.status(500).send('<h1>Server Error</h1>');
    }
};

// 12. GET Passes by Status (Filtered by role)
const getPassesByStatus = async (req, res) => {
    const { status: statusParam } = req.params;
    const { role, id: userId, location_id: siteId } = req.user;

    const allowedParams = ['active', 'pending', 'approved', 'rejected'];
    if (!allowedParams.includes(statusParam)) {
        return sendResponse(res, 400, false, 'Invalid status parameter');
    }

    try {
        let statusFilter = '';
        if (statusParam === 'active') statusFilter = "p.status NOT IN ('COMPLETED', 'REJECTED', 'REJECTED_BY_RECEIVER')"; 
        else if (statusParam === 'pending') statusFilter = "p.status IN ('PENDING_MANAGER', 'PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION', 'PENDING_RECEIVER_CONFIRMATION')";
        else if (statusParam === 'approved') statusFilter = "p.status = 'COMPLETED'";
        else if (statusParam === 'rejected') statusFilter = "p.status IN ('REJECTED', 'REJECTED_BY_RECEIVER')";

        let query = `
            SELECT 
                p.id, p.dc_number, p.status, p.created_at, p.dispatched_at, p.received_at, p.to_location_id,
                p.from_location_id, p.external_address, p.receiver_id,
                u.name as created_by_name,
                fl.location_name as from_name,
                tl.location_name as to_name
            FROM material_gate_passes p
            LEFT JOIN users u ON p.created_by = u.id
            LEFT JOIN locations fl ON p.from_location_id = fl.id
            LEFT JOIN locations tl ON p.to_location_id = tl.id
        `;

        let params = [];
        let whereClauses = [statusFilter];

        if (role === 'user') {
            whereClauses.push('(p.created_by = ? OR p.receiver_id = ?)');
            params.push(userId, userId);
        } else if (role === 'manager') {
            query = query.replace('SELECT', 'SELECT um.manager_id, ');
            query += ' JOIN user_managers um ON p.created_by = um.user_id ';
            whereClauses.push('um.manager_id = ?');
            params.push(userId);
        } else if (role === 'security') {
            whereClauses.push('(p.from_location_id = ? OR p.to_location_id = ?)');
            params.push(siteId, siteId);
        }

        query += ' WHERE ' + whereClauses.join(' AND ') + ' ORDER BY p.created_at DESC';

        const [passes] = await pool.query(query, params);
        
        const result = passes.map(p => {
            const rawStatus = (p.status || '').toUpperCase();
            
            // Professional Stage Mapping
            let currentStage = 'Processing';
            switch (rawStatus) {
                case 'PENDING_MANAGER':
                    currentStage = 'Waiting for Manager Approval';
                    break;
                case 'PENDING_SECURITY_ORIGIN':
                    currentStage = 'Waiting at Origin Security';
                    break;
                case 'PENDING_SECURITY_DESTINATION':
                    currentStage = 'Waiting at Destination Security';
                    break;
                case 'PENDING_RECEIVER_CONFIRMATION':
                    currentStage = 'Waiting for Receiver Confirmation';
                    break;
                case 'COMPLETED':
                    currentStage = 'Material Received & Completed';
                    break;
                case 'REJECTED':
                case 'REJECTED_BY_RECEIVER':
                    currentStage = 'Rejected';
                    break;
                default:
                    currentStage = 'Processing';
            }

            return {
                id: p.id,
                dc_number: p.dc_number,
                manager_id: p.manager_id,
                from_name: p.from_name,
                to_name: p.to_name || p.external_address,
                from_location_id: p.from_location_id,
                to_location_id: p.to_location_id,
                status: rawStatus,
                current_stage: currentStage,
                created_by: p.created_by_name,
                receiver_id: p.receiver_id,
                created_at: p.created_at
            };
        });

        return sendResponse(res, 200, true, `Passes for ${statusParam}`, result);
    } catch (err) {
        console.error('getPassesByStatus error:', err);
        return sendResponse(res, 500, false, 'Fetch error');
    }
};

// 13. GET Completed Passes (role‑based)
const getCompletedPasses = async (req, res) => {
    const { dc } = req.query; // optional exact search parameter
    const { role, id: userId, location_id: siteId } = req.user;
    try {
        let baseQuery = `
            SELECT p.id, p.dc_number, p.created_at, p.receiver_id,
                fl.location_name AS origin_name,
                tl.location_name AS destination_name,
                u.name AS submitted_by,
                p.approved_by_manager_id AS manager_id,
                p.security_destination_approved_at AS completed_at
            FROM material_gate_passes p
            LEFT JOIN users u ON p.created_by = u.id
            LEFT JOIN locations fl ON p.from_location_id = fl.id
            LEFT JOIN locations tl ON p.to_location_id = tl.id
        `;
        
        let whereClauses = ["p.status = 'COMPLETED'"];
        const params = [];
        
        // Role‑based restrictions
        if (role === 'user') {
            whereClauses.push('(p.created_by = ? OR p.receiver_id = ?)');
            params.push(userId, userId);
        } else if (role === 'manager') {
            // Use EXISTS to filter by manager's team safely without messing up JOIN order
            whereClauses.push(`EXISTS (
                SELECT 1 FROM user_managers um 
                WHERE um.user_id = p.created_by 
                AND um.manager_id = ?
            )`);
            params.push(userId);
        } else if (role === 'security') {
            whereClauses.push('(p.from_location_id = ? OR p.to_location_id = ?)');
            params.push(siteId, siteId);
        }
        
        // Exact DC Search (Case Insensitive)
        if (dc && dc.trim()) {
            whereClauses.push('LOWER(p.dc_number) = LOWER(?)');
            params.push(dc.trim());
        }

        const finalQuery = `
            ${baseQuery} 
            WHERE ${whereClauses.join(' AND ')} 
            ORDER BY p.security_destination_approved_at DESC 
            LIMIT 20
        `;
        
        const [passes] = await pool.query(finalQuery, params);
        
        const result = passes.map(p => ({
            id: p.id,
            dc_number: p.dc_number,
            manager_id: p.manager_id,
            receiver_id: p.receiver_id,
            origin: p.origin_name,
            destination: p.destination_name,
            submitted_by: p.submitted_by,
            completed_at: p.completed_at,
            created_at: p.created_at
        }));
        
        return sendResponse(res, 200, true, 'Completed passes fetched', result);
    } catch (err) {
        console.error('getCompletedPasses error:', err);
        return sendResponse(res, 500, false, 'Fetch error');
    }
};

const getPassTracking = async (req, res) => {
    const { dc } = req.query;
    const { role, id: userId, location_id: siteId } = req.user;

    if (!dc) return sendResponse(res, 400, false, 'DC Number is required');

    try {
        // Fetch basic pass info and check access
        const [passes] = await pool.query(`
            SELECT p.*, 
                   fl.location_name as from_name, 
                   tl.location_name as to_name,
                   u.name as creator_name,
                   ur.name as receiver_name
            FROM material_gate_passes p
            LEFT JOIN locations fl ON p.from_location_id = fl.id
            LEFT JOIN locations tl ON p.to_location_id = tl.id
            LEFT JOIN users u ON p.created_by = u.id
            LEFT JOIN users ur ON p.receiver_id = ur.id
            WHERE LOWER(p.dc_number) = LOWER(?)
        `, [dc.trim()]);

        if (passes.length === 0) {
            return sendResponse(res, 404, false, 'No DC Found');
        }
        const pass = passes[0];

        // Strict Role-based security check as per requirements
        let hasAccess = false;
        if (role === 'admin') {
            hasAccess = true;
        } else if (role === 'user' && (pass.created_by === userId || pass.receiver_id === userId)) {
            hasAccess = true;
        } else if (role === 'manager') {
            // Manager can see if they are the linked manager of the creator
            const [managers] = await pool.query('SELECT 1 FROM user_managers WHERE user_id = ? AND manager_id = ?', [pass.created_by, userId]);
            if (managers.length > 0) hasAccess = true;
        } else if (role === 'security') {
            // Security can see if the movement involves their site
            if (pass.from_location_id === siteId || pass.to_location_id === siteId) hasAccess = true;
        }

        if (!hasAccess) return sendResponse(res, 403, false, 'Unauthorized to track this DC');

        // Fetch tracking logs with enhanced data
        const [logs] = await pool.query(`
            SELECT l.*, u.name as actor_name, loc.location_name as loc_name
            FROM material_tracking_logs l
            LEFT JOIN users u ON l.acted_by = u.id
            LEFT JOIN locations loc ON l.action_location = loc.id
            WHERE l.material_id = ?
            ORDER BY l.acted_at ASC
        `, [pass.id]);

        return sendResponse(res, 200, true, 'Tracking data fetched', {
            dc_number: pass.dc_number,
            origin: pass.from_name,
            destination: pass.to_name || pass.external_address,
            current_status: (pass.status || '').toUpperCase(),
            pass_type: pass.pass_type,
            receiver_name: pass.receiver_name,
            receiver_confirmed_at: pass.receiver_confirmed_at,
            current_stage: (() => {
                const s = (pass.status || '').toUpperCase();
                const statusMap = {
                    'PENDING_MANAGER': 'Waiting for Manager Approval',
                    'PENDING_SECURITY_ORIGIN': 'Waiting at Dispatch Location',
                    'PENDING_SECURITY_DESTINATION': 'Waiting at Receiving Location',
                    'PENDING_RECEIVER_CONFIRMATION': 'Waiting for Receiver Confirmation',
                    'COMPLETED': 'Movement Completed',
                    'REJECTED': 'Rejected',
                    'REJECTED_BY_RECEIVER': 'Rejected by Receiver'
                };
                return statusMap[s] || 'Processing';
            })(),
            created_at: pass.created_at,
            tracking_history: logs.map(l => ({
                stage: l.stage,
                status: l.status,
                acted_by_name: l.actor_name || 'System',
                role: l.role,
                location: l.loc_name,
                acted_at: l.acted_at
            }))
        });
    } catch (err) {
        console.error('Tracking API Error:', err);
        return sendResponse(res, 500, false, 'Failed to fetch tracking data');
    }
};

// 14. GET Dashboard Stats (Optimized SINGLE query)
const getDashboardStats = async (req, res) => {
    const { role, id: userId, location_id: siteId } = req.user;

    try {
        let query = `
            SELECT 
                SUM(CASE WHEN status NOT IN ('COMPLETED', 'REJECTED', 'REJECTED_BY_RECEIVER') THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN status IN ('PENDING_MANAGER', 'PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION', 'PENDING_RECEIVER_CONFIRMATION') THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status IN ('PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION') THEN 1 ELSE 0 END) as approved,
                SUM(CASE WHEN status IN ('REJECTED', 'REJECTED_BY_RECEIVER') THEN 1 ELSE 0 END) as rejected
            FROM material_gate_passes p
        `;

        let params = [];
        if (role === 'user') {
            query += ' WHERE (p.created_by = ? OR p.receiver_id = ?)';
            params.push(userId, userId);
        } else if (role === 'manager') {
            query += ' JOIN user_managers um ON p.created_by = um.user_id WHERE um.manager_id = ?';
            params.push(userId);
        } else if (role === 'security') {
            query += ' WHERE (p.from_location_id = ? OR p.to_location_id = ?)';
            params.push(siteId, siteId);
        }

        const [results] = await pool.query(query, params);
        const stats = results[0] || { active: 0, pending: 0, approved: 0, rejected: 0 };
        
        // Ensure nulls from SUM are 0
        Object.keys(stats).forEach(key => {
            stats[key] = parseInt(stats[key]) || 0;
        });

        return sendResponse(res, 200, true, 'Dashboard Statistics', stats);
    } catch (err) {
        console.error('Dashboard Stats Error:', err);
        return sendResponse(res, 500, false, 'Failed to fetch statistics');
    }
};

// 7.2 Confirm Receiver from Portal (Authenticated)
const confirmReceiverPortal = async (req, res) => {
    const { passId } = req.body;
    const receiverUserId = req.user.id;

    if (!passId) return sendResponse(res, 400, false, 'Missing pass ID');

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [pass] = await connection.query(
            'SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', 
            [passId]
        );

        if (!pass.length) throw new Error('Pass not found');
        
        if (pass[0].status === 'COMPLETED') throw new Error('Action Blocked: Pass already COMPLETED');

        if (parseInt(pass[0].receiver_id) !== parseInt(receiverUserId)) {
            throw new Error('Unauthorized: You are not the assigned receiver');
        }

        if (pass[0].status !== 'PENDING_RECEIVER_CONFIRMATION') {
             throw new Error(`Pass is in ${pass[0].status} stage`);
        }

        const nextStatus = 'COMPLETED';
        await connection.query(
            `UPDATE material_gate_passes SET status = ?, receiver_confirmed_at = NOW(), receiver_confirmed_by = ?, receiver_action_token = NULL 
             WHERE id = ?`,
            [nextStatus, receiverUserId, passId]
        );

        await logTracking(connection, passId, 'RECEIVER_CONFIRMATION', 'COMPLETED', 'PENDING_RECEIVER_CONFIRMATION', nextStatus, receiverUserId, pass[0].to_location_id, 'receiver');

        await connection.commit();
        return sendResponse(res, 200, true, 'Receipt successfully confirmed');
    } catch (err) {
        await connection.rollback();
        return sendResponse(res, 500, false, err.message);
    } finally {
        connection.release();
    }
};

const rejectReceiverPortal = async (req, res) => {
    const { passId, rejected_reason } = req.body;
    const receiverUserId = req.user.id;

    if (!passId) return sendResponse(res, 400, false, 'Missing pass ID');

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [pass] = await connection.query(
            'SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', 
            [passId]
        );

        if (!pass.length) throw new Error('Pass not found');
        
        if (pass[0].status === 'COMPLETED') throw new Error('Action Blocked: Pass already COMPLETED');

        if (parseInt(pass[0].receiver_id) !== parseInt(receiverUserId)) {
            throw new Error('Unauthorized');
        }

        if (pass[0].status !== 'PENDING_RECEIVER_CONFIRMATION') {
            throw new Error(`Invalid stage`);
        }

        const nextStatus = 'REJECTED_BY_RECEIVER';
        await connection.query(
            `UPDATE material_gate_passes SET status = ?, rejected_at = NOW(), rejected_reason = ?, receiver_action_token = NULL WHERE id = ?`,
            [nextStatus, rejected_reason || 'Rejected by Receiver', passId]
        );

        await logTracking(connection, passId, 'RECEIVER_CONFIRMATION', 'REJECTED', 'PENDING_RECEIVER_CONFIRMATION', nextStatus, receiverUserId, pass[0].to_location_id, 'receiver');

        await connection.commit();
        return sendResponse(res, 200, true, 'Receipt rejected');
    } catch (err) {
        await connection.rollback();
        return sendResponse(res, 500, false, err.message);
    } finally {
        connection.release();
    }
};

module.exports = {
    createMaterialPass,
    previewMaterialPass,
    getPassPDF,
    updateManagerStatus,
    markDispatched,
    markReceived,
    rejectSecurityStatus,
    getPendingPasses,
    pdfLimiter,
    approveMaterialByToken,
    rejectMaterialByToken,
    getPassPDFByToken,
    approveSecurityByToken,
    rejectSecurityByToken,
    getPassesByStatus,
    getPassTracking,
    getDashboardStats,
    getCompletedPasses,
    confirmReceiverByToken,
    confirmReceiverPortal,
    rejectReceiverPortal
};
