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
const logTracking = async (connection, materialId, stage, status, oldStatus, newStatus, actedBy, actionLocation, role, remark = null) => {
    try {
        await connection.query(
            `INSERT INTO material_tracking_logs 
            (material_id, stage, status, old_status, new_status, acted_by, action_location, role, remark) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [materialId, stage, status, oldStatus, newStatus, actedBy, actionLocation, role, remark]
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
            p.rejected_reason,
            p.rejected_role,
            p.rejected_at,
            rec.name as receiver_user_name,
            au.name as admin_name,
            au.signature_path as admin_signature_path,
            u.name as created_by_name,
            u.email as created_by_email,
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
            mu.email as manager_email,
            mu.signature_path as manager_signature_path,
            mu.mobile_number as manager_mobile,
            mu.address as manager_address,
            rej.name as rejected_by_name,
            rec.signature_path as receiver_signature_path,
            rec.mobile_number as receiver_user_mobile,
            u.signature_path as created_by_signature_path,
            rdub.name as return_dispatched_by_name,
            rdub.signature_path as security_return_origin_signature_path,
            rrub.name as return_received_by_name,
            rrub.signature_path as security_return_destination_signature_path,
            rmu.name as return_manager_name,
            rmu.signature_path as return_manager_signature_path,
            rcu.name as return_confirmed_by_name,
            rcu.signature_path as return_confirmed_by_signature_path
        FROM material_gate_passes p
        LEFT JOIN users u ON p.created_by = u.id
        LEFT JOIN locations fl ON p.from_location_id = fl.id
        LEFT JOIN locations tl ON p.to_location_id = tl.id
        LEFT JOIN users du ON p.dispatched_by = du.id
        LEFT JOIN users ru ON p.received_by = ru.id
        LEFT JOIN users mu ON p.approved_by_manager_id = mu.id
        LEFT JOIN users au ON p.approved_by_admin_id = au.id
        LEFT JOIN users rec ON p.receiver_id = rec.id
        LEFT JOIN users rdub ON p.return_dispatched_by = rdub.id
        LEFT JOIN users rrub ON p.return_received_by = rrub.id
        LEFT JOIN users rej ON p.rejected_by = rej.id
        LEFT JOIN users apu ON p.approved_by_id = apu.id
        LEFT JOIN users rmu ON p.return_approved_by_id = rmu.id
        LEFT JOIN users rcu ON p.return_confirmed_by = rcu.id
        WHERE p.id = ?
    `, [passId]);

    if (passes.length === 0) return null;
    const pass = passes[0];

    const [items] = await pool.query('SELECT * FROM material_items WHERE material_pass_id = ?', [passId]);
    pass.items = items;

    return pass;
};

// Helper: Send Rejection Notifications to Manager & Creator
const sendRejectionNotifications = async (passId, rejectedById, role, reason, data = {}) => {
    try {
        const fullPass = await fetchFullPassData(passId);
        if (!fullPass) return;

        const { sendRejectionEmail } = require('../utils/mail.util');
        const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

        // Notify Request User (Creator)
        if (fullPass.created_by_email) {
            await sendRejectionEmail(fullPass.created_by_email, {
                recipientName: fullPass.created_by_name,
                dcNumber: fullPass.dc_number,
                passType: fullPass.pass_type,
                rejectedBy: fullPass.rejected_by_name || 'System',
                rejectedRole: role,
                rejectionReason: reason,
                rejectionStage: data.rejectionStage || role,
                origin: fullPass.from_location_name,
                destination: fullPass.to_location_name || fullPass.external_address,
                loginUrl
            });
        }

        // Notify Manager
        if (fullPass.manager_email) {
            await sendRejectionEmail(fullPass.manager_email, {
                recipientName: fullPass.manager_name,
                dcNumber: fullPass.dc_number,
                passType: fullPass.pass_type,
                rejectedBy: fullPass.rejected_by_name || 'System',
                rejectedRole: role,
                rejectionReason: reason,
                rejectionStage: data.rejectionStage || role,
                origin: fullPass.from_location_name,
                destination: fullPass.to_location_name || fullPass.external_address,
                loginUrl
            });
        }
    } catch (err) {
        console.error('sendRejectionNotifications error:', err);
    }
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

        let finalReceiverName = receiver_name;
        let finalReceiverMobile = receiver_mobile;

        // If internal receiver ID provided, fetch their details for preview accuracy
        if (receiver_id) {
            const [intRec] = await pool.query('SELECT name, mobile_number FROM users WHERE id = ?', [receiver_id]);
            if (intRec.length > 0) {
                finalReceiverName = intRec[0].name;
                finalReceiverMobile = intRec[0].mobile_number;
            }
        }

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
            receiver_name: finalReceiverName,
            receiver_mobile: finalReceiverMobile,
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
                    'INSERT INTO email_action_tokens (pass_id, token, action_type, expires_at) VALUES (?, ?, ?, ?)',
                    [passId, actionToken, 'MANAGER_APPROVAL', expiresAt]
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

const renderHtmlResponseGlobal = (success, title, msg, extraHtml = '') => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8000';
    return `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 100px auto; text-align: center; padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border: 1px solid ${success ? '#e2e8f0' : '#fee2e2'};">
            <div style="font-size: 48px; margin-bottom: 20px;">${success ? '✅' : '❌'}</div>
            <h1 style="color: ${success ? '#1e293b' : '#991b1b'}; margin-bottom: 10px;">${title}</h1>
            <p style="color: #64748b; font-size: 16px; line-height: 1.6;">${msg}</p>
            ${extraHtml}
            <div style="margin-top: 30px;">
                <a href="${frontendUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">Back to Portal</a>
            </div>
        </div>
    `;
};

const renderRejectionForm = (token, passId, action, passDetails = {}, extraParams = {}) => {
    const dcNumber = passDetails.dc_number || 'N/A';
    const materialSummary = (passDetails.items || [])
        .map(i => `${i.qty} x ${i.description}`)
        .slice(0, 3)
        .join(', ') + ((passDetails.items || []).length > 3 ? '...' : '');

    // Generate hidden inputs for any extra params (like managerId)
    const extraInputs = Object.entries(extraParams)
        .filter(([_, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`)
        .join('\n');

    const extraHtml = `
        <div style="margin-top: 30px; text-align: left; background: #fdf2f2; padding: 25px; border-radius: 16px; border: 1px solid #fecaca;">
            <div style="margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px dashed #fca5a5;">
                <p style="margin: 0 0 5px 0; font-size: 12px; color: #991b1b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Request Details</p>
                <p style="margin: 0; font-size: 15px; color: #1e293b;"><strong>DC:</strong> ${dcNumber}</p>
                <p style="margin: 5px 0 0 0; font-size: 13px; color: #475569; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${materialSummary}"><strong>Items:</strong> ${materialSummary || 'Material Movement'}</p>
            </div>
            
            <form action="" method="GET">
                <input type="hidden" name="token" value="${token}">
                <input type="hidden" name="passId" value="${passId}">
                <input type="hidden" name="id" value="${passId}">
                <input type="hidden" name="action" value="${action}">
                ${extraInputs}
                <label style="display: block; font-size: 14px; font-weight: 700; color: #1e293b; margin-bottom: 10px;">Reason for Rejection <span style="color: #ef4444;">*</span></label>
                <textarea name="rejected_reason" placeholder="Explain the reason for rejection (Required)..." required 
                    style="width: 100%; height: 110px; padding: 15px; border-radius: 12px; border: 1px solid #fca5a5; margin-bottom: 20px; font-family: inherit; font-size: 14px; resize: none; box-sizing: border-box; outline: none; focus: border-red-500;"></textarea>
                <button type="submit" style="width: 100%; background: #ef4444; color: white; border: none; padding: 16px; border-radius: 12px; cursor: pointer; font-weight: 700; font-size: 16px; transition: all 0.2s; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);">
                    Confirm Rejection
                </button>
            </form>
        </div>
    `;
    
    return renderHtmlResponseGlobal(false, 'Reject Movement', 'A mandatory rejection reason is required to process this action.', extraHtml);
};

// 5. UPDATE Status (Manager) - Standardized for Dashboard & Token
const updateManagerStatus = async (req, res) => {
    const id = req.body.id || req.body.passId || req.query.id || req.query.passId;
    const action = req.body.action || req.query.action || (req.body.status === 'approved' ? 'approve' : req.body.status === 'rejected' ? 'reject' : null);
    const status = req.body.status || req.query.status || (action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : null);
    const responseFormat = req.body.responseFormat || req.query.format || (req.query.token ? 'html' : 'json');
    
    // Support either authenticated user or managerId from token/query
    const managerId = req.user ? req.user.id : (req.body.managerId || req.query.managerId || null);

    const renderHtmlResponse = (success, title, msg, extraHtml = '') => {
        return res.send(renderHtmlResponseGlobal(success, title, msg, extraHtml));
    };

    if (!id || !status) {
        if (responseFormat === 'html') return renderHtmlResponse(false, 'Missing Data', 'Gate pass ID or action missing.');
        return sendResponse(res, 400, false, 'ID and Action are required');
    }

    const isApproved = (status || '').toLowerCase().includes('approve');
    
    // SAFE extraction of rejected_reason from ANY possible source (Body or Query)
    const reason = (
        (req.body && req.body.rejected_reason) || 
        (req.query && req.query.rejected_reason) || 
        (req.body && req.body.reason) || 
        (req.query && req.query.reason) || 
        ''
    ).trim();

    // Hardened Rejection Remark Check
    if (!isApproved && (!reason || reason.length === 0)) {
        if (responseFormat === 'html') {
            const token = req.query.token || req.body.token || '';
            const fullPass = await fetchFullPassData(id);
            // Preserving managerId in extraParams for the form submission
            return res.send(renderRejectionForm(token, id, 'reject', fullPass, { managerId }));
        }
        return sendResponse(res, 400, false, 'Rejection remark is required');
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
        // Handle both forward and return manager stages
        if (currentStatus !== 'PENDING_MANAGER' && currentStatus !== 'PENDING_RETURN_MANAGER') {
            if (responseFormat === 'html') return renderHtmlResponse(false, 'Action Blocked', 'This request has already been processed.');
            return sendResponse(res, 400, false, 'This request has already been processed.');
        }

        const isReturnFlow = currentStatus === 'PENDING_RETURN_MANAGER';

        let finalStatus;
        if (isReturnFlow) {
            finalStatus = isApproved ? 'PENDING_RETURN_SECURITY_DESTINATION' : 'REJECTED';
        } else {
            finalStatus = isApproved ? 'PENDING_SECURITY_ORIGIN' : 'REJECTED';
        }
        
        const approvedByRole = req.user && req.user.role === 'admin' ? 'admin' : 'manager';
        const approvedByAdminId = approvedByRole === 'admin' ? req.user.id : null;
        const approvedByManagerId = approvedByRole === 'manager' ? (managerId || (req.user ? req.user.id : null)) : (pass[0].approved_by_manager_id);
        
        // Unified approver details
        const approverId = req.user ? req.user.id : managerId;
        const [approverRows] = await connection.query('SELECT name FROM users WHERE id = ?', [approverId]);
        const approverName = approverRows.length > 0 ? approverRows[0].name : 'Unknown';

        const [result] = await connection.query(
            `UPDATE material_gate_passes 
             SET status = ?, 
                 manager_action_status = ?,
                 approved_by_manager_id = IF(?, approved_by_manager_id, ?), 
                 approved_by_admin_id = IF(?, approved_by_admin_id, ?),
                 approved_by_role = IF(?, approved_by_role, ?),
                 approved_by_id = IF(?, approved_by_id, ?),
                 approved_by_name = IF(?, approved_by_name, ?),
                 approved_by_manager_at = IF(?, approved_by_manager_at, COALESCE(approved_by_manager_at, NOW())),
                 return_approved_manager_at = IF(?, NOW(), return_approved_manager_at),
                 return_approved_by_role = IF(?, ?, return_approved_by_role),
                 return_approved_by_id = IF(?, ?, return_approved_by_id),
                 return_approved_by_name = IF(?, ?, return_approved_by_name),
                 manager_action_token = NULL,
                 rejected_at = ${!isApproved ? 'NOW()' : 'NULL'},
                 rejected_by = ?,
                 rejected_role = ?,
                 rejected_reason = ?
             WHERE id = ? AND status = ?`,
            [
                finalStatus, 
                isApproved ? 'APPROVED' : 'REJECTED',
                isReturnFlow, approvedByManagerId, 
                isReturnFlow, approvedByAdminId, 
                isReturnFlow, approvedByRole, 
                isReturnFlow, approverId, 
                isReturnFlow, approverName,
                isReturnFlow,
                isReturnFlow,
                isReturnFlow, approvedByRole,
                isReturnFlow, approverId,
                isReturnFlow, approverName,
                !isApproved ? approverId : null, 
                !isApproved ? approvedByRole : null, 
                !isApproved ? reason : null, 
                id, 
                currentStatus
            ]
        );

        if (result.affectedRows === 0) {
             throw new Error('Action failed: This request has already been processed or is no longer pending manager approval.');
        }

        // Universal Sync: Mark all tokens for THIS STAGE as used
        await connection.query(
            'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND (action_type = "MANAGER_APPROVAL" OR action_type = "RETURN_MANAGER_APPROVAL")', 
            [id]
        );

        const trackingStage = isReturnFlow ? 'RETURN_MANAGER_APPROVAL' : 'MANAGER_APPROVAL';
        await logTracking(connection, id, trackingStage, isApproved ? 'COMPLETED' : 'REJECTED', currentStatus, finalStatus, req.user ? req.user.id : managerId, null, approvedByRole, !isApproved ? reason : null);

        await connection.commit();

        if (isApproved) {
            const triggerSecurityEmail = async (isReturnFlowFlow = false) => {
                try {
                    const targetLocId = isReturnFlowFlow ? pass[0].to_location_id : pass[0].from_location_id;
                    console.log(`[DEBUG] Triggering security email for pass ${id}, location ${targetLocId}, isReturnFlow: ${isReturnFlowFlow}`);
                    
                    const [security] = await pool.query(
                        "SELECT email, name FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1",
                        [targetLocId]
                    );

                    if (security.length > 0) {
                        const { sendOriginSecurityEmail, sendReturnDestinationSecurityEmail } = require('../utils/mail.util');
                        const securityToken = crypto.randomBytes(32).toString('hex');
                        const securityTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); 

                        await pool.query(
                            "INSERT INTO email_action_tokens (pass_id, token, action_type, expires_at) VALUES (?, ?, 'SECURITY_APPROVAL', ?)",
                            [id, securityToken, securityTokenExpiry]
                        );

                        const fullPass = await fetchFullPassData(id);
                        const approverName = approvedByRole === 'admin' ? fullPass.admin_name : fullPass.manager_name;
                        const approverLabel = approvedByRole === 'admin' ? 'Admin' : 'Manager';
                        const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

                        if (security[0].email) {
                            const emailData = {
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
                            };

                            if (isReturnFlowFlow) {
                                await sendReturnDestinationSecurityEmail(security[0].email, emailData);
                            } else {
                                await sendOriginSecurityEmail(security[0].email, emailData);
                            }
                        }
                    }
                } catch (err) {
                    console.error('Security Notification Error:', err);
                }
            };
            
            triggerSecurityEmail(isReturnFlow); 
        } else {
            // Trigger Rejection Notifications
            const stageName = isReturnFlow ? 'Return Approval (Manager)' : 'Initial Approval (Manager)';
            setTimeout(() => {
                sendRejectionNotifications(id, req.user ? req.user.id : managerId, approvedByRole, reason, { rejectionStage: stageName });
            }, 500);
        }

        const successMsg = isReturnFlow 
            ? (isApproved ? 'Return explicitly approved by Manager' : 'Return receipt rejected by Manager')
            : (isApproved ? 'Successfully approved and forwarded to Security' : 'Successfully rejected');
        
        if (responseFormat === 'html') return renderHtmlResponse(true, isApproved ? 'Approved' : 'Rejected', successMsg);
        return sendResponse(res, 200, true, successMsg);
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

    if (!vehicle_number || !vehicle_number.trim()) {
        return sendResponse(res, 400, false, 'Vehicle number is required for dispatch');
    }

    try {
        await markDispatchedInternal(passId, vehicle_number.trim(), securityUser);
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
    const reason = typeof rejected_reason === 'string' ? rejected_reason.trim() : null;

    if (!reason || reason.length === 0) {
        return sendResponse(res, 400, false, 'Rejection reason is mandatory and cannot be empty.');
    }

    try {
        await rejectSecurityInternal(passId, reason, securityUser);
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
                WHERE ((p.from_location_id = ? OR p.to_location_id = ?) AND p.status = "COMPLETED")
                   OR (p.status = "REJECTED")
                ORDER BY p.updated_at DESC LIMIT 50`, [siteId, siteId]);
            
            return sendResponse(res, 200, true, 'Bucketed Fetch', { dispatchable, receivable, history });
        }

        let query = 'SELECT p.*, fl.location_name as from_name, tl.location_name as to_name, u.name as submitted_by_name';
        if (role === 'manager') {
            query = 'SELECT p.*, um.manager_id, fl.location_name as from_name, tl.location_name as to_name, u.name as submitted_by_name';
        }
        query += ' FROM material_gate_passes p LEFT JOIN locations fl ON p.from_location_id = fl.id LEFT JOIN locations tl ON p.to_location_id = tl.id LEFT JOIN users u ON p.created_by = u.id';
        let params = [];

        if (role === 'admin') {
            // Admin sees all pending manager approvals globally
            query += ' WHERE p.status = "PENDING_MANAGER"';
        } else if (role === 'user') {
            query += ' WHERE (p.created_by = ? OR (p.receiver_id = ? AND (p.status = "PENDING_RECEIVER_CONFIRMATION" OR p.status = "PENDING_RECEIVER")))';
            params = [id, id];
        } else if (role === 'manager') {
            query += ' JOIN user_managers um ON p.created_by = um.user_id WHERE p.status = "PENDING_MANAGER" AND um.manager_id = ?';
            params = [id];
        }

        query += ' ORDER BY p.created_at DESC';
        const [passes] = await pool.query(query, params);
        
        // Ensure submitted_by_id is mapped for the grid
        const result = passes.map(p => ({
            ...p,
            submitted_by_id: p.created_by,
            submitted_by_name: p.submitted_by_name
        }));
        
        return sendResponse(res, 200, true, 'Passes fetched', result);
    } catch (err) {
        return sendResponse(res, 500, false, 'Fetch error');
    }
};

const approveMaterialByToken = async (req, res) => {
    const { token, action } = req.query;
    if (!token) return res.send(renderHtmlResponseGlobal(false, 'Error', 'Missing security token.'));

    try {
        const [emailTokens] = await pool.query(
            'SELECT * FROM email_action_tokens WHERE token = ? AND (action_type = "MANAGER_APPROVAL" OR action_type = "RETURN_MANAGER_APPROVAL")', 
            [token]
        );

        if (!emailTokens.length) return res.send(renderHtmlResponseGlobal(false, 'Link Invalid', 'This approval link is invalid.'));
        
        const [pass] = await pool.query('SELECT id, status FROM material_gate_passes WHERE id = ?', [emailTokens[0].pass_id]);
        if (!pass.length) return res.send(renderHtmlResponseGlobal(false, 'Link Invalid', 'Pass not found.'));

        if (emailTokens[0].used) {
            const isRejected = pass[0].status === 'REJECTED' || pass[0].status === 'REJECTED_BY_RECEIVER';
            const msg = isRejected ? 'You have already rejected this request.' : 'You have already approved this request.';
            return res.send(renderHtmlResponseGlobal(false, 'Action Blocked', msg));
        }

        if (new Date() > new Date(emailTokens[0].expires_at)) {
            return res.send(renderHtmlResponseGlobal(false, 'Link Expired', 'This approval link has expired.'));
        }

        if (pass[0].status !== 'PENDING_MANAGER' && pass[0].status !== 'PENDING_RETURN_MANAGER') {
            return res.send(renderHtmlResponseGlobal(false, 'Action Blocked', 'This request has already been processed.'));
        }
        
        // Pass the format to updateManagerStatus
        req.body = { 
            id: pass[0].id, 
            status: action === 'reject' ? 'rejected' : 'approved', 
            managerId: req.query.managerId,
            responseFormat: 'html',
            token: token
        };
        return updateManagerStatus(req, res);
    } catch (err) {
        console.error('Token approval error:', err);
        return res.send(renderHtmlResponseGlobal(false, 'Server Error', 'Failed to process approval request.'));
    }
};

const rejectMaterialByToken = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.send(renderHtmlResponseGlobal(false, 'Error', 'Missing security token.'));

    try {
        const [emailTokens] = await pool.query(
            'SELECT * FROM email_action_tokens WHERE token = ? AND (action_type = "MANAGER_APPROVAL" OR action_type = "RETURN_MANAGER_APPROVAL")', 
            [token]
        );

        if (!emailTokens.length) return res.send(renderHtmlResponseGlobal(false, 'Link Invalid', 'This link is invalid.'));
        
        const [pass] = await pool.query('SELECT id, status FROM material_gate_passes WHERE id = ?', [emailTokens[0].pass_id]);
        if (!pass.length) return res.send(renderHtmlResponseGlobal(false, 'Link Invalid', 'Pass not found.'));

        if (emailTokens[0].used) {
            const isRejected = pass[0].status === 'REJECTED' || pass[0].status === 'REJECTED_BY_RECEIVER';
            const msg = isRejected ? 'You have already rejected this request.' : 'You have already approved this request.';
            return res.send(renderHtmlResponseGlobal(false, 'Action Blocked', msg));
        }

        if (new Date() > new Date(emailTokens[0].expires_at)) {
            return res.send(renderHtmlResponseGlobal(false, 'Link Expired', 'This approval link has expired.'));
        }

        if (pass[0].status !== 'PENDING_MANAGER' && pass[0].status !== 'PENDING_RETURN_MANAGER') {
            return res.send(renderHtmlResponseGlobal(false, 'Action Blocked', 'This request has already been processed.'));
        }
        
        req.body = { 
            id: pass[0].id, 
            status: 'rejected', 
            managerId: req.query.managerId,
            responseFormat: 'html',
            token: token
        };
        return updateManagerStatus(req, res);
    } catch (err) {
        console.error('Token rejection error:', err);
        return res.send(renderHtmlResponseGlobal(false, 'Server Error', 'Failed to process rejection request.'));
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
        return res.send(renderHtmlResponseGlobal(success, title, msg, extraHtml));
    };

    if (!token || !passId) return renderHtmlResponse(false, 'Error', 'Missing security token or pass ID.');

    try {
        const [emailTokens] = await pool.query(
            'SELECT * FROM email_action_tokens WHERE pass_id = ? AND token = ?',
            [passId, token]
        );

        if (emailTokens.length === 0) {
            return renderHtmlResponse(false, 'Link Invalid', 'This link is invalid.');
        }

        const eToken = emailTokens[0];
        const [passRows] = await pool.query('SELECT * FROM material_gate_passes WHERE id = ?', [passId]);
        if (!passRows.length) return renderHtmlResponse(false, 'Error', 'Pass not found.');
        const passRecord = passRows[0];

        if (eToken.used) {
            const isRejected = passRecord.status === 'REJECTED' || passRecord.status === 'REJECTED_BY_RECEIVER';
            const msg = isRejected ? 'You have already rejected this request.' : 'You have already approved this request.';
            return renderHtmlResponse(false, 'Action Blocked', msg);
        }
        if (new Date() > new Date(eToken.expires_at)) {
            return renderHtmlResponse(false, 'Link Expired', 'This approval link has expired.');
        }
        
        const emailTokenId = eToken.id;
        const currentStatus = passRecord.status;

        // Requirements: SG1 allowed only when PENDING_SECURITY_ORIGIN, SG2 only when PENDING_SECURITY_DESTINATION
        // RGP handles PENDING_RETURN_SECURITY_ORIGIN / DESTINATION
        const validStatuses = ['PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION', 'PENDING_RETURN_SECURITY_ORIGIN', 'PENDING_RETURN_SECURITY_DESTINATION'];
        if (!validStatuses.includes(currentStatus)) {
             return renderHtmlResponse(false, 'Action Blocked', 'This request has already been processed.');
        }

        const markTokenUsedAndRender = async (title, msg, extraHtml = '') => {
            await pool.query('UPDATE email_action_tokens SET used = 1 WHERE id = ?', [emailTokenId]);
            return renderHtmlResponse(true, title, msg, extraHtml);
        };

        console.log(`[Security Token Action] Pass: ${passId}, Action: ${action}, Status: ${currentStatus}`);

        if (action === 'reject') {
            console.log("[DEBUG] SG TOKEN REJECT - REQ BODY:", req.body);
            console.log("[DEBUG] SG TOKEN REJECT - REQ QUERY:", req.query);

            // SAFE extraction of rejected_reason from ANY possible source (Body or Query)
            const trimmedReason = (
                (req.body && req.body.rejected_reason) || 
                (req.query && req.query.rejected_reason) || 
                (req.body && req.body.reason) || 
                (req.query && req.query.reason) || 
                ''
            ).trim();

            if (!trimmedReason || trimmedReason.length === 0) {
                const fullPass = await fetchFullPassData(passId);
                return res.send(renderRejectionForm(token, passId, 'reject', fullPass));
            }

            let targetLocationId;
            if (currentStatus === 'PENDING_SECURITY_ORIGIN' || currentStatus === 'PENDING_RETURN_SECURITY_ORIGIN') {
                targetLocationId = passRecord.from_location_id;
            } else if (currentStatus === 'PENDING_SECURITY_DESTINATION' || currentStatus === 'PENDING_RETURN_SECURITY_DESTINATION') {
                targetLocationId = passRecord.to_location_id;
            } else {
                return renderHtmlResponse(false, 'Error', 'Cannot reject at this stage.');
            }

            let [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [targetLocationId]);
            const securityUser = security.length > 0 ? security[0] : { id: 0, name: 'System (Security Token)', role: 'security', location_id: targetLocationId };
            
            await rejectSecurityInternal(passId, trimmedReason, securityUser);
            return markTokenUsedAndRender('Rejected', 'The material movement has been rejected by security.');
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
                // Don't mark token as used yet, we just showed the form!
                return renderHtmlResponse(true, 'Dispatch Approval', `Please enter the vehicle number to complete the dispatch for ${passRecord.dc_number}.`, vehicleForm);
            }

            // Proceed with dispatch
            let [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [passRecord.from_location_id]);
            const securityUser = security.length > 0 ? security[0] : { id: 0, name: 'System (Security Token)', role: 'security', location_id: passRecord.from_location_id };
            
            await markDispatchedInternal(passId, vehicleNumber, securityUser);
            return markTokenUsedAndRender('Dispatched', 'Material has been successfully marked as DISPATCHED.');
        } else if (currentStatus === 'PENDING_SECURITY_DESTINATION') {
            // Receive
            let [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [passRecord.to_location_id]);
            const securityUser = security.length > 0 ? security[0] : { id: 0, name: 'System (Security Token)', role: 'security', location_id: passRecord.to_location_id };
            
            await markReceivedInternal(passId, securityUser);
            return markTokenUsedAndRender('Received', 'Material has been successfully marked as RECEIVED.');
        } else if (currentStatus === 'PENDING_RETURN_SECURITY_DESTINATION') {
            const returnVehicleNumber = req.query.vehicle_number;
            if (!returnVehicleNumber) {
                const vehicleForm = `
                    <div style="margin-top: 25px; padding-top: 25px; border-top: 1px solid #e2e8f0;">
                        <form action="/api/material/security/approve" method="GET">
                            <input type="hidden" name="token" value="${token}" />
                            <input type="hidden" name="passId" value="${passId}" />
                            <label style="display: block; font-size: 14px; font-weight: 600; color: #1e293b; margin-bottom: 8px; text-align: left;">Return Vehicle Number (Required):</label>
                            <input type="text" name="vehicle_number" placeholder="e.g. KA01AB1234" required style="width: 100%; padding: 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; margin-bottom: 20px; box-sizing: border-box;" />
                            <button type="submit" style="width: 100%; background: #3b82f6; color: white; padding: 12px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer;">✅ Confirm Return Dispatch</button>
                        </form>
                    </div>
                `;
                return renderHtmlResponse(true, 'Return Dispatch', `Please enter the vehicle number to initiate the return dispatch for ${passRecord.dc_number}.`, vehicleForm);
            }

            let [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [passRecord.to_location_id]);
            const securityUser = security.length > 0 ? security[0] : { id: 0, name: 'System (Security Token)', role: 'security', location_id: passRecord.to_location_id };
            
            await markReturnDispatchedInternal(passId, returnVehicleNumber, securityUser);
            return markTokenUsedAndRender('Return Dispatched', 'Returned material has been successfully marked as DISPATCHED.');
        } else if (currentStatus === 'PENDING_RETURN_SECURITY_ORIGIN') {
            // RGP Return Receive
            let [security] = await pool.query("SELECT * FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [passRecord.from_location_id]);
            const securityUser = security.length > 0 ? security[0] : { id: 0, name: 'System (Security Token)', role: 'security', location_id: passRecord.from_location_id };
            
            await markReturnReceivedInternal(passId, securityUser);
            return markTokenUsedAndRender('Return Received', 'Returned material has been successfully marked as RECEIVED.');
        } else {
            return renderHtmlResponse(true, 'Already Handled', `This request is already in ${currentStatus.replace(/_/g, ' ')} stage.`);
        }
    } catch (err) {
        console.error('[CRITICAL] Security token action crash:', err);
        // User-friendly error page instead of raw crash
        return renderHtmlResponse(false, 'Operation Failed', `
            <div style="text-align: left;">
                <p>We encountered an issue processing your request.</p>
                <ul style="font-size: 13px; color: #64748b; padding-left: 20px;">
                    <li>Ensure the link hasn't been used already.</li>
                    <li>Verify your internet connection.</li>
                    <li>If the problem persists, please log in to the portal to take action manually.</li>
                </ul>
                <p style="font-size: 11px; color: #94a3b8; margin-top: 20px; border-top: 1px dashed #e2e8f0; padding-top: 10px;">
                    Error Details: ${err.message || 'Unknown internal error'}
                </p>
            </div>
        `);
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
            `UPDATE material_gate_passes SET status = ?, dispatched_by = ?, security_origin_approved_at = NOW(), vehicle_number = ? 
             WHERE id = ? AND status = 'PENDING_SECURITY_ORIGIN'`,
            [nextStatus, securityUser.id, vehicle_number, passId]
        );
        
        if (result.affectedRows === 0) throw new Error('Update failed (Security Race Condition)');

        // Universal Sync: Mark all tokens for THIS STAGE as used
        await connection.query(
            'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND action_type = "SECURITY_APPROVAL"', 
            [passId]
        );

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); 
        await connection.query(
            'INSERT INTO email_action_tokens (pass_id, token, action_type, expires_at) VALUES (?, ?, ?, ?)',
            [passId, nextToken, 'SECURITY_APPROVAL', expiresAt]
        );

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
                                vehicleNumber: vehicle_number,
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

        const receiverToken = require('crypto').randomBytes(32).toString('hex');
        // Both NRGP and RGP go to PENDING_RECEIVER_CONFIRMATION 
        // (NRGP: receiver confirms receipt → COMPLETED; RGP: receiver initiates return → return flow)
        const nextStatus = 'PENDING_RECEIVER_CONFIRMATION';

        const [result] = await connection.query(
            `UPDATE material_gate_passes SET status = ?, received_by = ?, security_destination_approved_at = NOW()
             WHERE id = ? AND status = 'PENDING_SECURITY_DESTINATION'`, 
            [nextStatus, securityUser.id, passId]
        );

        if (result.affectedRows === 0) throw new Error('Update failed (Security Race Condition)');

        // Universal Sync: Mark all tokens for THIS STAGE as used
        await connection.query(
            'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND action_type = "SECURITY_APPROVAL"', 
            [passId]
        );

        await connection.query(
            'INSERT INTO email_action_tokens (pass_id, token, action_type, expires_at) VALUES (?, ?, ?, ADDDATE(NOW(), INTERVAL 1 DAY))',
            [passId, receiverToken, 'RECEIVER_CONFIRMATION']
        );

        await logTracking(connection, passId, 'DESTINATION_SECURITY', 'RECEIVED_AT_DESTINATION', currentStatus, nextStatus, securityUser.id, securityUser.location_id, 'security');
        
        await connection.commit();

        // Always notify receiver (both NRGP and RGP)
        const triggerReceiverNotify = async () => {
            try {
                const { sendReceiverConfirmationEmail } = require('../utils/mail.util');
                const fullPass = await fetchFullPassData(passId);
                const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

                // Get receiver email from users table (preferred) or from the stored field
                let receiverEmail = pass[0].receiver_email;
                if (!receiverEmail && pass[0].receiver_id) {
                    const [recUser] = await pool.query('SELECT email FROM users WHERE id = ?', [pass[0].receiver_id]);
                    if (recUser.length) receiverEmail = recUser[0].email;
                }

                if (!receiverEmail) {
                    console.warn('[Receiver Notify] No receiver email found for pass', passId);
                    return;
                }

                const materialDetails = fullPass.items.map(item =>
                    `• ${item.description} (Qty: ${item.qty})`
                ).join('<br/>');

                const isRGP = pass[0].pass_type === 'RGP';
                const baseReceiverUrl = `${baseUrl}/api/material/confirm-receiver?token=${receiverToken}&passId=${passId}`;
                const returnFormUrl = isRGP ? `${baseUrl}/api/material/return/initiate-form?token=${receiverToken}&passId=${passId}` : null;

                await sendReceiverConfirmationEmail(receiverEmail, {
                    receiverName: fullPass.receiver_name || 'Receiver',
                    dcNumber: fullPass.dc_number,
                    passType: fullPass.pass_type,
                    materialDetails: materialDetails,
                    confirmationUrl: baseReceiverUrl,
                    returnFormUrl: returnFormUrl,
                    pdfUrl: `${baseUrl}/api/material/manager/pdf?token=${fullPass.pdf_access_token}`,
                    isRGP
                });
            } catch (err) {
                console.error('Receiver Notify Async Error:', err);
            }
        };
        setTimeout(triggerReceiverNotify, 500);

        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally { connection.release(); }
};

// 7.1 Confirm Receiver (NRGP & RGP Final Return)
const confirmReceiverByToken = async (req, res) => {
    const { token, passId, action, reason } = req.query;
    
    const renderHtmlResponse = (success, title, msg, extraHtml = '') => {
        return res.send(renderHtmlResponseGlobal(success, title, msg, extraHtml));
    };

    if (!token || !passId) return renderHtmlResponse(false, 'Error', 'Missing confirmation token or pass ID.');

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        let isEmailActionToken = false;

        // Strict token check using only email_action_tokens
        const [emailTokens] = await connection.query(
            'SELECT * FROM email_action_tokens WHERE token = ? AND pass_id = ? FOR UPDATE',
            [token, passId]
        );

        if (emailTokens.length === 0) {
            return renderHtmlResponse(false, 'Link Invalid', 'This link is invalid.');
        }

        const tokenRecord = emailTokens[0];
        const [passes] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!passes.length) throw new Error('Pass not found');
        const pass = passes[0];

        if (tokenRecord.used) {
            const isRejected = pass.status === 'REJECTED' || pass.status === 'REJECTED_BY_RECEIVER';
            const msg = isRejected ? 'You have already rejected this request.' : 'You have already approved this request.';
            return renderHtmlResponse(false, 'Action Blocked', msg);
        }

        // Additional guard for RGP: If already accepted, don't allow duplicate acceptance (Forward Flow only)
        const isFinalReturn = tokenRecord.action_type === 'FINAL_RETURN_CONFIRMATION';
        if (pass.pass_type === 'RGP' && pass.receiver_accepted_at && action !== 'reject' && !isFinalReturn) {
            return renderHtmlResponse(false, 'Action Blocked', 'You have already accepted the items for this gate pass.');
        }

        if (new Date() > new Date(tokenRecord.expires_at)) {
            return renderHtmlResponse(false, 'Link Expired', 'This approval link has expired.');
        }
        
        // This variable is used below to figure out if it's the final return confirmation or the standard receiver confirmation
        isEmailActionToken = tokenRecord.action_type === 'FINAL_RETURN_CONFIRMATION';
        
        const expectedStatus = isEmailActionToken ? 'PENDING_RETURN_RECEIPT' : 'PENDING_RECEIVER_CONFIRMATION';
        if (pass.status !== expectedStatus) {
             return renderHtmlResponse(false, 'Action Blocked', 'This request has already been processed.');
        }

        const isConfirmClick = req.query.confirmed === 'true';

        if (isEmailActionToken && !isConfirmClick && action !== 'reject') {
            // Show confirmation button to avoid link pre-fetching marking token as used
            return renderHtmlResponse(true, 'Confirm Return Receipt', `You are about to confirm that you have received the returned materials for DC ${pass.dc_number}.`, `
                <div style="margin-top: 25px;">
                    <a href="/api/material/confirm-receiver?token=${token}&passId=${passId}&confirmed=true" 
                       style="display: inline-block; background: #10b981; color: white; padding: 12px 30px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 16px; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.2);">
                       ✅ Yes, I have received the items
                    </a>
                    <p style="margin-top: 20px; color: #64748b; font-size: 13px;">This extra step ensures secure confirmation of your materials.</p>
                </div>
            `);
        }

        if (action === 'reject') {
            // SAFE extraction of rejected_reason from ANY possible source (Body or Query)
            const trimmedReason = (
                (req.body && req.body.rejected_reason) || 
                (req.query && req.query.rejected_reason) || 
                (req.body && req.body.reason) || 
                (req.query && req.query.reason) || 
                ''
            ).trim();

            if (!trimmedReason || trimmedReason.length === 0) {
                const fullPass = await fetchFullPassData(passId);
                return res.send(renderRejectionForm(token, passId, 'reject', fullPass));
            }
            const nextStatus = 'REJECTED';
            await connection.query(
                `UPDATE material_gate_passes SET status = ?, rejected_at = NOW(), rejected_reason = ?, receiver_action_token = NULL WHERE id = ?`,
                [nextStatus, trimmedReason, passId]
            );

            // Universal Sync: Mark all tokens for THIS STAGE as used
            await connection.query(
                'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND action_type = "RECEIVER_CONFIRMATION"', 
                [passId]
            );

            await logTracking(connection, passId, 'RECEIVER_CONFIRMATION', 'REJECTED', expectedStatus, nextStatus, null, pass.to_location_id, 'receiver', trimmedReason);
            
            setTimeout(() => {
                sendRejectionNotifications(passId, null, 'Receiver', trimmedReason, { rejectionStage: 'Receipt Confirmation (Receiver)' });
            }, 500);

            await connection.commit();
            return renderHtmlResponse(true, 'Rejected', 'You have rejected the receipt of these materials.');
        }

        // Default: Accept
        let nextStatus;
        let currentLogStage;
        let prevStatus;
        let locId;
        let actorId;

        if (isEmailActionToken) {
            nextStatus = 'COMPLETED';
            currentLogStage = 'RETURN_RECEIPT';
            prevStatus = 'PENDING_RETURN_RECEIPT';
            locId = pass.from_location_id;
            actorId = pass.created_by;
            
            await connection.query(
                `UPDATE material_gate_passes SET 
                    status = ?,
                    return_confirmed_at = NOW(),
                    return_confirmed_by = ?,
                    completed_at = NOW()
                 WHERE id = ?`,
                [nextStatus, pass.created_by, passId]
            );
        } else {
            const isRGP = pass.pass_type === 'RGP';
            nextStatus = isRGP ? 'PENDING_RECEIVER_CONFIRMATION' : 'COMPLETED';
            currentLogStage = 'RECEIVER_CONFIRMATION';
            prevStatus = 'PENDING_RECEIVER_CONFIRMATION';
            locId = pass.to_location_id;
            actorId = pass.receiver_id || pass.created_by;
            
            await connection.query(
                `UPDATE material_gate_passes SET 
                    status = ?, 
                    receiver_confirmed_at = NOW(), 
                    receiver_accepted_at = ?,
                    receiver_confirmed_by = ?, 
                    receiver_action_token = NULL
                 WHERE id = ?`,
                [nextStatus, isRGP ? new Date() : null, pass.receiver_id || 0, passId]
            );
        }

        // Universal Sync: Mark all tokens for THIS STAGE as used
        // For RGP, we DO NOT mark it used at the confirmation stage because the same token is needed for return initiation.
        const isRGPInitial = !isEmailActionToken && pass.pass_type === 'RGP';
        
        if (!isRGPInitial) {
            await connection.query(
                'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND action_type = ?', 
                [passId, isEmailActionToken ? 'FINAL_RETURN_CONFIRMATION' : 'RECEIVER_CONFIRMATION']
            );
        }

        await logTracking(connection, passId, currentLogStage, 'COMPLETED', prevStatus, nextStatus, actorId, locId, 'user');

        await connection.commit();

        const successTitle = isEmailActionToken ? 'Return Confirmed' : (pass.pass_type === 'RGP' ? 'Receipt Accepted' : 'Confirmed');
        let successMsg = isEmailActionToken 
            ? 'Thank you! You have successfully confirmed the returned materials. The pass is now completely closed.'
            : (pass.pass_type === 'RGP' 
                ? 'You have accepted the items. You can now initiate the return process whenever you are ready.' 
                : 'Thank you! You have successfully confirmed receipt of the materials.');
        
        let extraHtml = '';
        if (!isEmailActionToken && pass.pass_type === 'RGP') {
            const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
            // Use the same token for the return form initiation, or generate a fresh one if needed.
            // For now, let's re-use or provide a link that validates the pass stage.
            extraHtml = `
                <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                    <p style="color: #64748b; font-size: 14px; margin-bottom: 15px;">Need to send the items back now?</p>
                    <a href="${baseUrl}/api/material/return/initiate-form?passId=${passId}&token=${token}" 
                       style="display: inline-block; background: #9333ea; color: white; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px; box-shadow: 0 4px 12px rgba(147, 51, 234, 0.2);">
                       Initiate Return Now
                    </a>
                </div>
            `;
        }
            
        return renderHtmlResponse(true, successTitle, successMsg, extraHtml);
    } catch (err) {
        await connection.rollback();
        console.error('Receiver confirmation token error:', err);
        return renderHtmlResponse(false, 'Action Failed', err.message || 'Operation failed.');
    } finally {
        connection.release();
    }
};

const rejectSecurityInternal = async (passId, rawReason, securityUser) => {
    const reason = typeof rawReason === 'string' ? rawReason.trim() : null;
    if (!reason || reason.length === 0) {
        throw new Error('Rejection reason is mandatory and cannot be empty.');
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');

        if (pass[0].status === 'COMPLETED') throw new Error('Action Blocked: Pass already COMPLETED');

        const currentStatus = pass[0].status;
        let stage = '';

        const userId = securityUser ? securityUser.id : 0;
        const locationId = securityUser ? securityUser.location_id : null;
        const userName = securityUser ? securityUser.name : 'System (Security Token)';

        if (currentStatus === 'PENDING_SECURITY_ORIGIN') {
            stage = 'ORIGIN_SECURITY';
        } else if (currentStatus === 'PENDING_SECURITY_DESTINATION') {
            stage = 'DESTINATION_SECURITY';
        } else if (currentStatus === 'PENDING_RETURN_SECURITY_DESTINATION') {
            stage = 'RETURN_SECURITY_DESTINATION';
        } else if (currentStatus === 'PENDING_RETURN_SECURITY_ORIGIN') {
            stage = 'RETURN_SECURITY_ORIGIN';
        } else {
            throw new Error(`Cannot reject at current stage: ${currentStatus}`);
        }

        const [result] = await connection.query(
            `UPDATE material_gate_passes SET status = 'REJECTED', rejected_by = ?, rejected_role = 'security', rejected_at = NOW(), rejected_reason = ?, security_action_token = NULL 
             WHERE id = ? AND status = ?`,
            [userId, reason, passId, currentStatus]
        );

        if (result.affectedRows === 0) throw new Error('Rejection failed (Race Condition)');

        // Universal Sync: Mark all tokens for THIS STAGE as used
        await connection.query(
            'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND action_type = "SECURITY_APPROVAL"', 
            [passId]
        );

        await logTracking(connection, passId, stage, 'REJECTED', currentStatus, 'REJECTED', userId, locationId, 'security', reason);
        
        setTimeout(() => {
            const displayStage = stage.replace(/_/g, ' ');
            sendRejectionNotifications(passId, userId, 'Security Guard', reason, { rejectionStage: displayStage });
        }, 500);

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

// 14. GET Dashboard Statistics
const getDashboardStats = async (req, res) => {
    const { role, id: userId, location_id: siteId } = req.user;

        let query = `
        SELECT
            SUM(CASE WHEN UPPER(p.status) IN ('PENDING_MANAGER', 'PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION', 'PENDING_RECEIVER', 'PENDING_RECEIVER_CONFIRMATION', 'PENDING_RETURN_MANAGER', 'PENDING_RETURN_SECURITY_DESTINATION', 'PENDING_RETURN_SECURITY_ORIGIN', 'PENDING_RETURN_RECEIPT') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN UPPER(p.status) = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN UPPER(p.status) IN ('REJECTED', 'REJECTED_BY_RECEIVER') THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN UPPER(p.status) NOT IN ('COMPLETED', 'REJECTED', 'REJECTED_BY_RECEIVER', 'PENDING_MANAGER', 'PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION', 'PENDING_RECEIVER', 'PENDING_RECEIVER_CONFIRMATION', 'PENDING_RETURN_MANAGER', 'PENDING_RETURN_SECURITY_DESTINATION', 'PENDING_RETURN_SECURITY_ORIGIN', 'PENDING_RETURN_RECEIPT') THEN 1 ELSE 0 END) AS active
        FROM material_gate_passes p
    `;

    let params = [];
    let whereClauses = [];

    if (role === 'admin') {
        // Admin sees all
    } else if (role === 'user') {
        whereClauses.push('(p.created_by = ? OR p.receiver_id = ?)');
        params.push(userId, userId);
    } else if (role === 'manager') {
        whereClauses.push('EXISTS (SELECT 1 FROM user_managers um WHERE um.user_id = p.created_by AND um.manager_id = ?)');
        params.push(userId);
    } else if (role === 'security') {
        whereClauses.push('(p.from_location_id = ? OR p.to_location_id = ?)');
        params.push(siteId, siteId);
    }

    if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
    }

    try {
        const [results] = await pool.query(query, params);
        const stats = results[0] || { active: 0, pending: 0, completed: 0, rejected: 0 };
        
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

// 15. GET Passes by Status (Filtered by role)
const getPassesByStatus = async (req, res) => {
    const { status: statusParam } = req.params;
    const { role, id: userId, location_id: siteId } = req.user;

    const allowedParams = ['active', 'pending', 'completed', 'approved', 'rejected'];
    if (!allowedParams.includes(statusParam)) {
        return sendResponse(res, 400, false, 'Invalid status parameter');
    }

    try {
        let query = `
            SELECT 
                p.id, p.dc_number, p.status, p.created_at, p.dispatched_at, p.received_at, p.to_location_id,
                p.from_location_id, p.external_address, p.receiver_id, p.created_by,
                p.movement_type, p.pass_type, p.receiver_accepted_at, p.return_initiated_at,
                p.rejected_at, p.rejected_reason, p.rejected_by,
                p.vehicle_number, p.return_vehicle_number,
                p.approved_by_role,
                u.name as created_by_name,
                ru.name as rejected_by_name, ru.role as rejected_by_role,
                fl.location_name as from_name,
                tl.location_name as to_name,
                (SELECT manager_id FROM user_managers WHERE user_id = p.created_by LIMIT 1) as manager_id
            FROM material_gate_passes p
            LEFT JOIN users u ON p.created_by = u.id
            LEFT JOIN users ru ON p.rejected_by = ru.id
            LEFT JOIN locations fl ON p.from_location_id = fl.id
            LEFT JOIN locations tl ON p.to_location_id = tl.id
        `;

        let params = [];
        let whereClauses = [];
        
        const s = (statusParam || '').toLowerCase();
        if (s === 'active') {
            whereClauses.push("UPPER(p.status) NOT IN ('COMPLETED', 'REJECTED', 'REJECTED_BY_RECEIVER', 'PENDING_MANAGER', 'PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION', 'PENDING_RECEIVER', 'PENDING_RECEIVER_CONFIRMATION', 'PENDING_RETURN_MANAGER', 'PENDING_RETURN_SECURITY_DESTINATION', 'PENDING_RETURN_SECURITY_ORIGIN', 'PENDING_RETURN_RECEIPT')");
        }
        else if (s === 'pending') {
            whereClauses.push("UPPER(p.status) IN ('PENDING_MANAGER', 'PENDING_SECURITY_ORIGIN', 'PENDING_SECURITY_DESTINATION', 'PENDING_RECEIVER', 'PENDING_RECEIVER_CONFIRMATION', 'PENDING_RETURN_MANAGER', 'PENDING_RETURN_SECURITY_DESTINATION', 'PENDING_RETURN_SECURITY_ORIGIN', 'PENDING_RETURN_RECEIPT')");
        }
        else if (s === 'completed' || s === 'approved') {
            whereClauses.push("UPPER(p.status) = 'COMPLETED'");
        }
        else if (s === 'rejected') {
            whereClauses.push("UPPER(p.status) IN ('REJECTED', 'REJECTED_BY_RECEIVER')");
        }
        else {
            whereClauses.push("1=1");
        }

        if (role === 'admin') {
            // Admin sees all
        } else if (role === 'user') {
            whereClauses.push('(p.created_by = ? OR p.receiver_id = ?) ');
            params.push(userId, userId);
        } else if (role === 'manager') {
            whereClauses.push('EXISTS (SELECT 1 FROM user_managers um WHERE um.user_id = p.created_by AND um.manager_id = ?)');
            params.push(userId);
        } else if (role === 'security') {
            // Security monitoring: Always site specific as per requirements
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
                case 'PENDING_RETURN_MANAGER':
                    currentStage = 'Return: Waiting for Manager Approval';
                    break;
                case 'PENDING_RETURN_SECURITY_DESTINATION':
                    currentStage = 'Return: Waiting for Destination Security Dispatch';
                    break;
                case 'PENDING_RETURN_SECURITY_ORIGIN':
                    currentStage = 'Return: Waiting for Origin Security Receipt';
                    break;
                case 'PENDING_RETURN_RECEIPT':
                    currentStage = 'Return: Waiting for Final Receipt Confirmation';
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
                receiver_id: p.receiver_id,
                created_by: p.created_by,
                submitted_by_id: p.created_by,
                from_name: p.from_name,
                to_name: p.to_name || p.external_address,
                from_location_id: p.from_location_id,
                to_location_id: p.to_location_id,
                status: rawStatus,
                current_stage: currentStage,
                pass_type: p.pass_type,
                movement_type: p.movement_type,
                created_by_name: p.created_by_name,
                submitted_by_name: p.created_by_name,
                created_at: p.created_at,
                dispatched_at: p.dispatched_at,
                received_at: p.received_at,
                receiver_accepted_at: p.receiver_accepted_at,
                return_initiated_at: p.return_initiated_at,
                rejected_at: p.rejected_at,
                rejected_reason: p.rejected_reason,
                rejected_by_name: p.rejected_by_name,
                rejected_by_role: p.rejected_by_role,
                vehicle_number: p.vehicle_number,
                return_vehicle_number: p.return_vehicle_number
            };
        });

        return sendResponse(res, 200, true, `Passes for ${statusParam}`, result);
    } catch (err) {
        console.error('getPassesByStatus error:', err);
        return sendResponse(res, 500, false, 'Fetch error');
    }
};

// 13. GET History Passes (Completed + Rejected)
const getHistoryPasses = async (req, res) => {
    const { dc } = req.query; // optional exact search parameter
    const { role, id: userId, location_id: siteId } = req.user;
    try {
        let baseQuery = `
            SELECT p.id, p.dc_number, p.created_at, p.receiver_id,
                p.movement_type, p.pass_type, p.receiver_accepted_at, p.return_initiated_at,
                fl.location_name AS from_name,
                tl.location_name AS to_name,
                u.name AS submitted_by,
                p.from_location_id,
                p.to_location_id,
                p.created_by,
                p.vehicle_number,
                p.return_vehicle_number,
                p.approved_by_role,
                p.approved_by_manager_id AS manager_id,
                COALESCE(p.return_confirmed_at, p.security_destination_approved_at, p.rejected_at) AS completed_at,
                p.status,
                p.external_address,
                p.updated_at
            FROM material_gate_passes p
            LEFT JOIN users u ON p.created_by = u.id
            LEFT JOIN locations fl ON p.from_location_id = fl.id
            LEFT JOIN locations tl ON p.to_location_id = tl.id
        `;
        
        let whereClauses = ["p.status IN ('COMPLETED', 'REJECTED')"];
        const params = [];
        
        // Role‑based restrictions
        if (role === 'admin') {
            // Admin sees everything
        } else if (role === 'user') {
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
            // Security monitoring: Strictly site specific as per requirements
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
            ORDER BY p.updated_at DESC
        `;
        
        const [passes] = await pool.query(finalQuery, params);
        
        const result = passes.map(p => ({
            id: p.id,
            dc_number: p.dc_number,
            manager_id: p.manager_id,
            receiver_id: p.receiver_id,
            from_name: p.from_name,
            to_name: p.to_name,
            from_location_id: p.from_location_id,
            to_location_id: p.to_location_id,
            created_by: p.created_by,
            submitted_by_id: p.created_by,
            submitted_by: p.submitted_by,
            submitted_by_name: p.submitted_by,
            completed_at: p.completed_at,
            created_at: p.created_at,
            movement_type: p.movement_type,
            pass_type: p.pass_type,
            vehicle_number: p.vehicle_number,
            return_vehicle_number: p.return_vehicle_number,
            status: p.status,
            external_address: p.external_address,
            updated_at: p.updated_at
        }));
        
        return sendResponse(res, 200, true, 'History passes fetched', result);
    } catch (err) {
        console.error('getHistoryPasses error:', err);
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

        // Fetch items
        const [items] = await pool.query('SELECT part_no, description, qty, remarks, is_return_extra FROM material_items WHERE material_pass_id = ?', [pass.id]);

        return sendResponse(res, 200, true, 'Tracking data fetched', {
            dc_number: pass.dc_number,
            origin: pass.from_name,
            destination: pass.to_name || pass.external_address,
            current_status: (pass.status || '').toUpperCase(),
            pass_type: pass.pass_type,
            movement_type: pass.movement_type?.toLowerCase(),
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
            return_initiated_at: pass.return_initiated_at,
            tracking_history: logs.map(l => ({
                stage: l.stage,
                status: l.status,
                acted_by_name: l.actor_name || 'System',
                role: l.role,
                location: l.loc_name,
                acted_at: l.acted_at,
                remark: l.remark
            })),
            items: items || [],
            vehicle_number: pass.vehicle_number,
            return_vehicle_number: pass.return_vehicle_number,
            approved_by_role: pass.approved_by_role,
            approved_by_name: pass.approved_by_name,
            approved_at: pass.approved_by_manager_at,
            return_approved_by_role: pass.return_approved_by_role,
            return_approved_by_name: pass.return_approved_by_name,
            return_approved_at: pass.return_approved_manager_at
        });
    } catch (err) {
        console.error('Tracking API Error:', err);
        return sendResponse(res, 500, false, 'Failed to fetch tracking data');
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

        if (pass[0].status !== 'PENDING_RECEIVER_CONFIRMATION' && pass[0].status !== 'PENDING_RECEIVER') {
             throw new Error(`Pass is in ${pass[0].status} stage`);
        }

        const isRGP = pass[0].pass_type === 'RGP';
        const nextStatus = isRGP ? (pass[0].status === 'PENDING_RECEIVER' ? 'PENDING_RECEIVER' : 'PENDING_RECEIVER_CONFIRMATION') : 'COMPLETED';

        await connection.query(
            `UPDATE material_gate_passes SET 
                status = ?, 
                receiver_confirmed_at = NOW(), 
                receiver_accepted_at = ?,
                receiver_confirmed_by = ?, 
                receiver_action_token = NULL 
             WHERE id = ?`,
            [nextStatus, isRGP ? new Date() : null, receiverUserId, passId]
        );

        // Universal Sync: Mark all tokens for THIS STAGE as used
        await connection.query(
            'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND action_type = "RECEIVER_CONFIRMATION"', 
            [passId]
        );

        await logTracking(connection, passId, 'RECEIVER_CONFIRMATION', 'COMPLETED', 'PENDING_RECEIVER_CONFIRMATION', nextStatus, receiverUserId, pass[0].to_location_id, 'receiver');

        await connection.commit();
        return sendResponse(res, 200, true, isRGP ? 'Receipt accepted. You can now initiate the return flow.' : 'Receipt successfully confirmed');
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
    const reason = typeof rejected_reason === 'string' ? rejected_reason.trim() : null;

    if (!reason || reason.length ===0) {
        return sendResponse(res, 400, false, 'Rejection reason is mandatory and cannot be empty.');
    }

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

        if (pass[0].status !== 'PENDING_RECEIVER_CONFIRMATION' && pass[0].status !== 'PENDING_RECEIVER') {
            throw new Error(`Invalid stage`);
        }

        const nextStatus = 'REJECTED';
        await connection.query(
            `UPDATE material_gate_passes SET status = ?, rejected_at = NOW(), rejected_by = ?, rejected_role = 'receiver', rejected_reason = ?, receiver_action_token = NULL WHERE id = ?`,
            [nextStatus, receiverUserId, reason, passId]
        );

        // Universal Sync: Mark all tokens for THIS STAGE as used
        await connection.query(
            'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND action_type = "RECEIVER_CONFIRMATION"', 
            [passId]
        );

        await logTracking(connection, passId, 'RECEIVER_CONFIRMATION', 'REJECTED', 'PENDING_RECEIVER_CONFIRMATION', nextStatus, receiverUserId, pass[0].to_location_id, 'receiver', reason);

        setTimeout(() => {
            sendRejectionNotifications(passId, receiverUserId, 'Receiver', reason, { rejectionStage: 'Receipt Confirmation (Receiver)' });
        }, 500);

        await connection.commit();
        return sendResponse(res, 200, true, 'Receipt rejected');
    } catch (err) {
        await connection.rollback();
        return sendResponse(res, 500, false, err.message);
    } finally {
        connection.release();
    }
};

// =============================================
// RGP RETURN WORKFLOW FUNCTIONS
// =============================================

// R1. Initiate Return (Receiver triggers return flow for RGP passes)
const initiateReturn = async (req, res) => {
    const { passId, token } = req.body;
    const receiverUser = req.user;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // If no authenticated user, must have a valid token
        if (!receiverUser && !token) {
            throw new Error('Authentication or secure token required');
        }

        if (token) {
            const [emailTokens] = await connection.query(
                'SELECT * FROM email_action_tokens WHERE pass_id = ? AND token = ? AND action_type = ? AND used = 0',
                [passId, token, 'RECEIVER_CONFIRMATION']
            );
            if (!emailTokens.length) {
                throw new Error('Invalid or used secure token');
            }
            if (new Date() > new Date(emailTokens[0].expires_at)) {
                throw new Error('Secure token has expired');
            }
        }

        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');

        if (pass[0].pass_type !== 'RGP') {
            throw new Error('Only RGP (Returnable) passes can initiate a return');
        }

        if (!pass[0].receiver_accepted_at) {
            throw new Error('Please confirm receipt before initiating return.');
        }

        if (pass[0].return_initiated_at) {
            throw new Error('Return has already been initiated.');
        }

        const currentStatus = (pass[0].status || '').toUpperCase();
        if (currentStatus !== 'PENDING_RECEIVER_CONFIRMATION' && currentStatus !== 'PENDING_RECEIVER') {
            throw new Error(`Cannot initiate return from current stage: ${currentStatus}`);
        }

        if (receiverUser && parseInt(pass[0].receiver_id) !== parseInt(receiverUser.id)) {
            throw new Error('Unauthorized: Only the designated receiver can initiate the return');
        }

        const { additional_items } = req.body;
        let additionalCount = 0;
        if (additional_items && Array.isArray(additional_items) && additional_items.length > 0) {
            if (additional_items.length > 20) {
                throw new Error('Maximum 20 additional items can be added during return.');
            }

            const validItems = [];
            for (const item of additional_items) {
                if (!item.part_no || !item.part_no.toString().trim()) {
                    throw new Error('Part Number is required for all additional items.');
                }
                if (!item.description || !item.description.toString().trim()) {
                    throw new Error('Description is required for all additional items.');
                }
                if (!item.qty || isNaN(item.qty) || parseInt(item.qty) <= 0) {
                    throw new Error('Quantity must be greater than 0 for all additional items.');
                }

                validItems.push([
                    passId, 
                    item.part_no.toString().trim(), 
                    item.description.toString().trim(), 
                    parseInt(item.qty), 
                    0, 0, 
                    item.remarks ? `${item.remarks.trim()} (Added in Return)` : 'Added in Return',
                    true
                ]);
            }

            if (validItems.length > 0) {
                await connection.query(
                    `INSERT INTO material_items 
                     (material_pass_id, part_no, description, qty, unit_cost, total, remarks, is_return_extra) 
                     VALUES ?`,
                    [validItems]
                );
                additionalCount = validItems.length;
            }
        }

        // Move to PENDING_RETURN_MANAGER -- notify manager to approve return
        const nextStatus = 'PENDING_RETURN_MANAGER';
        await connection.query(
            `UPDATE material_gate_passes 
             SET status = ?, return_initiated_at = NOW(), receiver_action_token = NULL
             WHERE id = ? AND (status = 'PENDING_RECEIVER_CONFIRMATION' OR status = 'PENDING_RECEIVER')`,
            [nextStatus, passId]
        );

        await logTracking(connection, passId, 'RETURN_INITIATION', 'COMPLETED', currentStatus, nextStatus, receiverUser ? receiverUser.id : (pass[0].receiver_id || 0), pass[0].to_location_id, 'user', `Return Initiated. All five users completed the dispatch journey. Added ${additionalCount} return items.`);
        
        // Finalize Token Usage - mark as used only after successful initiation
        if (token) {
            await connection.query(
                'UPDATE email_action_tokens SET used = 1 WHERE pass_id = ? AND token = ? AND action_type = "RECEIVER_CONFIRMATION"',
                [passId, token]
            );
        }

        await connection.commit();

        // Notify Manager for Return Approval (ASYNC)
        setTimeout(async () => {
            try {
                const { sendReturnManagerEmail } = require('../utils/mail.util');
                const fullPass = await fetchFullPassData(passId);
                const [managers] = await pool.query(`
                    SELECT u.id, u.email, u.name 
                    FROM users u
                    JOIN user_managers um ON u.id = um.manager_id
                    WHERE um.user_id = ?
                `, [fullPass.created_by]);

                if (managers.length > 0 && managers[0].email) {
                    const crypto = require('crypto');
                    const approvalToken = crypto.randomBytes(32).toString('hex');
                    const expireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

                    await pool.query(
                        'INSERT INTO email_action_tokens (pass_id, token, action_type, expires_at) VALUES (?, ?, ?, ?)',
                        [passId, approvalToken, 'RETURN_MANAGER_APPROVAL', expireAt]
                    );

                    const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
                    const approveUrl = `${baseUrl}/api/material/manager/approve?token=${approvalToken}&managerId=${managers[0].id}`;
                    const rejectUrl = `${baseUrl}/api/material/manager/reject?token=${approvalToken}&managerId=${managers[0].id}`;
                    const pdfUrl = `${baseUrl}/api/material/manager/pdf?token=${fullPass.pdf_access_token}`;
                    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

                    await sendReturnManagerEmail(managers[0].email, {
                        managerName: managers[0].name,
                        dcNumber: fullPass.dc_number,
                        receiverName: fullPass.receiver_name || 'Designated Receiver',
                        passType: fullPass.pass_type,
                        origin: fullPass.from_location_name,
                        destination: fullPass.to_location_name,
                        approveUrl,
                        rejectUrl,
                        pdfUrl,
                        loginUrl
                    });
                }
            } catch (err) {
                console.error('Return Manager Notify Error:', err);
            }
        }, 500);

        return sendResponse(res, 200, true, 'Return initiated. Manager will be notified for approval.');
    } catch (err) {
        await connection.rollback();
        console.error('initiateReturn error:', err);
        return sendResponse(res, 400, false, err.message || 'Failed to initiate return');
    } finally {
        connection.release();
    }
};

// R2. Mark Return Dispatched (SG2 - Destination Security dispatches materials back to origin)
const markReturnDispatched = async (req, res) => {
    try {
        const { passId, vehicle_number } = req.body;
        await markReturnDispatchedInternal(passId, vehicle_number, req.user);
        return sendResponse(res, 200, true, 'Materials dispatched back to origin successfully');
    } catch (err) {
        console.error('markReturnDispatched error:', err);
        return sendResponse(res, 400, false, err.message || 'Return dispatch failed');
    }
};

const markReturnDispatchedInternal = async (passId, vehicle_number, securityUser) => {
    if (!vehicle_number || !vehicle_number.trim()) {
        throw new Error('Vehicle number is required for return dispatch');
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');

        const currentStatus = (pass[0].status || '').toUpperCase();
        if (currentStatus !== 'PENDING_RETURN_SECURITY_DESTINATION') {
            throw new Error('Pass is not in return dispatch stage');
        }

        // SG2 is at the destination (to_location_id)
        if (parseInt(securityUser.location_id) !== parseInt(pass[0].to_location_id)) {
            throw new Error('Unauthorized: You are not at the return dispatch location');
        }

        const nextStatus = 'PENDING_RETURN_SECURITY_ORIGIN';
        const crypto = require('crypto');
        const nextToken = crypto.randomBytes(32).toString('hex');

        const [result] = await connection.query(
            `UPDATE material_gate_passes 
             SET status = ?, return_dispatched_by = ?, return_dispatched_at = NOW(), return_vehicle_number = ?, security_action_token = ?, security_token_expires_at = ADDDATE(NOW(), INTERVAL 1 DAY)
             WHERE id = ? AND status = 'PENDING_RETURN_SECURITY_DESTINATION'`,
            [nextStatus, securityUser.id, vehicle_number.trim(), nextToken, passId]
        );

        if (result.affectedRows === 0) throw new Error('Update failed (Race Condition)');

        await connection.query(
            `INSERT INTO email_action_tokens (pass_id, token, action_type, expires_at) 
             VALUES (?, ?, 'SECURITY_APPROVAL', ADDDATE(NOW(), INTERVAL 1 DAY))`,
            [passId, nextToken]
        );

        await logTracking(connection, passId, 'RETURN_SECURITY_DESTINATION', 'COMPLETED', currentStatus, nextStatus, securityUser.id, securityUser.location_id, 'security');
        await connection.commit();

        // Notify Origin Security (SG1) for return receipt (ASYNC)
        setTimeout(async () => {
            try {
                const { sendReturnOriginSecurityEmail } = require('../utils/mail.util');
                const fullPass = await fetchFullPassData(passId);
                const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

                const approveUrl = `${baseUrl}/api/material/security/approve?token=${nextToken}&passId=${passId}&action=approve`;
                const rejectUrl = `${baseUrl}/api/material/security/reject?token=${nextToken}&passId=${passId}&action=reject`;
                const pdfUrl = `${baseUrl}/api/material/manager/pdf?token=${fullPass.pdf_access_token}`;

                const [sg1] = await pool.query("SELECT email, name FROM users WHERE role = 'security' AND location_id = ? AND status = 'active' LIMIT 1", [pass[0].from_location_id]);
                if (sg1.length > 0 && sg1[0].email) {
                    await sendReturnOriginSecurityEmail(sg1[0].email, {
                        securityName: sg1[0].name,
                        dcNumber: fullPass.dc_number,
                        passType: fullPass.pass_type,
                        origin: fullPass.from_location_name,
                        destination: fullPass.to_location_name,
                        vehicleNumber: vehicle_number.trim(),
                        items: fullPass.items,
                        approveUrl,
                        rejectUrl,
                        pdfUrl
                    });
                }
            } catch (err) {
                console.error('Return Origin Security Notify Error:', err);
            }
        }, 500);

        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
};

const markReturnReceivedInternal = async (passId, securityUser) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');

        const currentStatus = (pass[0].status || '').toUpperCase();
        if (currentStatus !== 'PENDING_RETURN_SECURITY_ORIGIN') {
            throw new Error('Action already completed. Pass is not in return receiving stage.');
        }

        // SG1 is at the origin (from_location_id)
        if (parseInt(securityUser.location_id) !== parseInt(pass[0].from_location_id)) {
            throw new Error('Unauthorized: You are not at the origin (return receipt) location');
        }

        const nextStatus = 'PENDING_RETURN_RECEIPT';
        const crypto = require('crypto');
        const nextToken = crypto.randomBytes(32).toString('hex');

        const [result] = await connection.query(
            `UPDATE material_gate_passes 
             SET status = ?, return_received_by = ?, return_received_at = NOW(), security_action_token = NULL
             WHERE id = ? AND status = 'PENDING_RETURN_SECURITY_ORIGIN'`,
            [nextStatus, securityUser.id, passId]
        );

        if (result.affectedRows === 0) throw new Error('Update failed (Race Condition)');

        await connection.query(
            `INSERT INTO email_action_tokens (pass_id, token, action_type, expires_at) 
             VALUES (?, ?, 'FINAL_RETURN_CONFIRMATION', ADDDATE(NOW(), INTERVAL 1 DAY))`,
            [passId, nextToken]
        );

        await logTracking(connection, passId, 'RETURN_SECURITY_ORIGIN', 'COMPLETED', currentStatus, nextStatus, securityUser.id, securityUser.location_id, 'security');
        await connection.commit();

        // Notify original requester to confirm returned goods (ASYNC)
        setTimeout(async () => {
            try {
                const { sendReturnCompletionEmail } = require('../utils/mail.util');
                const fullPass = await fetchFullPassData(passId);
                const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;
                const confirmationUrl = `${baseUrl}/api/material/confirm-receiver?token=${nextToken}&passId=${passId}`;
                const pdfUrl = `${baseUrl}/api/material/manager/pdf?token=${fullPass.pdf_access_token}`;

                // Get creator's email
                const [creator] = await pool.query('SELECT email, name FROM users WHERE id = ?', [fullPass.created_by]);
                const targetEmail = creator.length ? creator[0].email : null;
                const targetName = creator.length ? creator[0].name : fullPass.created_by_name;
                if (targetEmail) {
                    await sendReturnCompletionEmail(targetEmail, {
                        recipientName: targetName,
                        dcNumber: fullPass.dc_number,
                        passType: fullPass.pass_type,
                        origin: fullPass.from_location_name,
                        destination: fullPass.to_location_name,
                        items: fullPass.items,
                        confirmationUrl,
                        pdfUrl,
                        pendingConfirmation: true // Requester must confirm receipt
                    });
                }
            } catch (err) {
                console.error('Return receipt notify error:', err);
            }
        }, 500);

        return true;
    } catch (err) {
        await connection.rollback();
        throw err;
    } finally {
        connection.release();
    }
};

// R3. Mark Return Received (SG1 - Origin Security receives the returned materials and completes the pass)
const markReturnReceived = async (req, res) => {
    const { passId } = req.body;
    const securityUser = req.user;

    try {
        await markReturnReceivedInternal(passId, securityUser);
        return sendResponse(res, 200, true, 'Return received by origin security. Awaiting original requester confirmation.');
    } catch (err) {
        console.error('markReturnReceived error:', err);
        return sendResponse(res, 400, false, err.message || 'Return receipt failed');
    }
};

// R4. Confirm Return Receipt (Original Requester confirms returned goods received → COMPLETED)
const confirmReturnReceipt = async (req, res) => {
    const { passId, action, rejected_reason } = req.body;
    const requesterUser = req.user;

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [pass] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ? FOR UPDATE', [passId]);
        if (!pass.length) throw new Error('Pass not found');

        const currentStatus = (pass[0].status || '').toUpperCase();
        if (currentStatus !== 'PENDING_RETURN_RECEIPT') {
            throw new Error('Pass is not awaiting return receipt confirmation');
        }

        if (parseInt(pass[0].created_by) !== parseInt(requesterUser.id) && requesterUser.role !== 'admin') {
            throw new Error('Unauthorized: Only the original requester can confirm return receipt');
        }

        const isReject = action === 'reject';
        // SAFE extraction of rejected_reason from ANY possible source (Body or Query)
        const reason = (
            (req.body && req.body.rejected_reason) || 
            (req.query && req.query.rejected_reason) || 
            (req.body && req.body.reason) || 
            (req.query && req.query.reason) || 
            ''
        ).trim();

        if (isReject && (!reason || reason.length === 0)) {
            return sendResponse(res, 400, false, 'Rejection reason is mandatory and cannot be empty.');
        }
        const nextStatus = isReject ? 'REJECTED' : 'COMPLETED';
        
        const [result] = await connection.query(
            `UPDATE material_gate_passes SET 
                status = ?, 
                rejected_at = ?, 
                rejected_reason = ?,
                return_confirmed_at = ?,
                return_confirmed_by = ?,
                completed_at = IF(? = 'COMPLETED', NOW(), completed_at)
             WHERE id = ? AND status = 'PENDING_RETURN_RECEIPT'`,
            [nextStatus, isReject ? new Date() : null, isReject ? reason : null, isReject ? null : new Date(), isReject ? null : requesterUser.id, nextStatus, passId]
        );

        if (result.affectedRows === 0) throw new Error('Update failed (Race Condition)');

        await logTracking(connection, passId, 'RETURN_RECEIPT', isReject ? 'REJECTED' : 'COMPLETED', currentStatus, nextStatus, requesterUser.id, pass[0].from_location_id, 'user');
        
        if (isReject) {
            setTimeout(() => {
                sendRejectionNotifications(passId, requesterUser.id, 'Originator', rejected_reason);
            }, 500);
        }

        await connection.commit();

        return sendResponse(res, 200, true, isReject ? 'Return rejected.' : 'Return confirmed. Gate pass is now COMPLETED.');
    } catch (err) {
        await connection.rollback();
        console.error('confirmReturnReceipt error:', err);
        return sendResponse(res, 400, false, err.message || 'Failed to process return receipt');
    } finally {
        connection.release();
    }
};
const getReturnInitiationForm = async (req, res) => {
    const { passId, token } = req.query;
    const renderHtmlResponse = (success, title, msg, extraHtml = '') => {
        return res.send(renderHtmlResponseGlobal(success, title, msg, extraHtml));
    };

    if (!passId || !token) {
        return renderHtmlResponse(false, 'Missing Data', 'Gate pass ID or security token missing.');
    }

    const connection = await pool.getConnection();
    try {
        // 1. Validate Token
        const [emailTokens] = await connection.query(
            'SELECT * FROM email_action_tokens WHERE pass_id = ? AND token = ? AND action_type = ?',
            [passId, token, 'RECEIVER_CONFIRMATION']
        );

        if (!emailTokens.length) {
            return renderHtmlResponse(false, 'Invalid Link', 'This return initiation link is invalid or has already been used.');
        }

        const tokenRecord = emailTokens[0];
        if (new Date() > new Date(tokenRecord.expires_at)) {
            return renderHtmlResponse(false, 'Link Expired', 'This initiation link has expired.');
        }

        // 2. Fetch Pass and Validate State
        const [passes] = await connection.query('SELECT * FROM material_gate_passes WHERE id = ?', [passId]);
        if (!passes.length) return renderHtmlResponse(false, 'Not Found', 'Gate pass record not found.');
        const pass = passes[0];

        if (pass.pass_type !== 'RGP') {
            return renderHtmlResponse(false, 'Action Blocked', 'Only RGP (Returnable) passes can initiate a return.');
        }

        if (!pass.receiver_accepted_at) {
            return renderHtmlResponse(false, 'Action Blocked', 'Please confirm receipt of materials before initiating return.');
        }

        if (pass.return_initiated_at) {
            return renderHtmlResponse(false, 'Action Blocked', 'Return has already been initiated for this gate pass.');
        }

        const currentStatus = (pass.status || '').toUpperCase();
        if (currentStatus !== 'PENDING_RECEIVER_CONFIRMATION') {
            return renderHtmlResponse(false, 'Action Blocked', 'This pass is not in a stage where return can be initiated.');
        }

        // 3. Fetch Items for Read-Only Display
        const [items] = await connection.query('SELECT part_no, description, qty FROM material_items WHERE material_pass_id = ? AND is_return_extra = 0', [passId]);

        const itemsHtml = items.map((item, idx) => `
            <tr style="background: #f8fafc;">
                <td style="padding: 10px; border: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">${idx + 1}</td>
                <td style="padding: 10px; border: 1px solid #e2e8f0; font-size: 12px; font-weight: 600;">${item.part_no || '-'}</td>
                <td style="padding: 10px; border: 1px solid #e2e8f0; font-size: 12px;">${item.description}</td>
                <td style="padding: 10px; border: 1px solid #e2e8f0; font-size: 12px; text-align: center; font-weight: 600;">${item.qty}</td>
            </tr>
        `).join('');

        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8000';
        const baseUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`;

        const formHtml = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 700px; margin: 50px auto; background: white; border-radius: 20px; box-shadow: 0 15px 35px rgba(0,0,0,0.1); border: 1px solid #e2e8f0; overflow: hidden;">
                <div style="background: #9333ea; padding: 30px; text-align: center;">
                    <div style="font-size: 40px; margin-bottom: 10px;">🔄</div>
                    <h1 style="color: white; margin: 0; font-size: 24px;">Initiate Return Flow</h1>
                    <p style="color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 13px; font-weight: 600;">DC NO: ${pass.dc_number}</p>
                </div>
                
                <div style="padding: 40px;">
                    <div style="margin-bottom: 30px;">
                        <h3 style="color: #1e293b; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 15px; border-bottom: 2px solid #f1f5f9; padding-bottom: 8px;">Original Items (Read-Only)</h3>
                        <table style="width: 100%; border-collapse: collapse; margin-bottom: 10px;">
                            <thead>
                                <tr style="background: #f1f5f9;">
                                    <th style="padding: 10px; text-align: left; font-size: 11px; text-transform: uppercase; color: #64748b; border: 1px solid #e2e8f0; width: 30px;">#</th>
                                    <th style="padding: 10px; text-align: left; font-size: 11px; text-transform: uppercase; color: #64748b; border: 1px solid #e2e8f0;">Part No</th>
                                    <th style="padding: 10px; text-align: left; font-size: 11px; text-transform: uppercase; color: #64748b; border: 1px solid #e2e8f0;">Description</th>
                                    <th style="padding: 10px; text-align: center; font-size: 11px; text-transform: uppercase; color: #64748b; border: 1px solid #e2e8f0; width: 50px;">Qty</th>
                                </tr>
                            </thead>
                            <tbody>${itemsHtml}</tbody>
                        </table>
                    </div>

                    <form id="returnForm" style="margin-top: 30px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                            <h3 style="color: #1e293b; font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; margin: 0;">Add Return Items (If Any)</h3>
                            <span style="font-size: 11px; color: #94a3b8; font-weight: 600;">LIMIT: 20 ITEMS</span>
                        </div>
                        
                        <div id="additionalItemsContainer" style="margin-bottom: 20px;">
                            <!-- Dynamic rows will be added here -->
                        </div>

                        <button type="button" id="addItemBtn" style="width: 100%; padding: 12px; background: #f8fafc; border: 2px dashed #e2e8f0; border-radius: 12px; color: #6366f1; font-weight: 700; font-size: 12px; cursor: pointer; transition: all 0.2s; margin-bottom: 30px;">
                            + ADD ANOTHER ITEM
                        </button>

                        <div style="background: #fffbeb; border: 1px solid #fef3c7; padding: 15px; border-radius: 12px; margin-bottom: 30px;">
                            <p style="margin: 0; color: #92400e; font-size: 12px; line-height: 1.5;">
                                <strong>Note:</strong> Standard items listed above will be included in the return automatically. Only add items that are being sent back in addition to the original manifest.
                            </p>
                        </div>

                        <button type="submit" id="submitBtn" style="width: 100%; padding: 16px; background: #9333ea; color: white; border: none; border-radius: 12px; font-weight: 800; font-size: 14px; cursor: pointer; box-shadow: 0 10px 15px -3px rgba(147, 51, 234, 0.3); text-transform: uppercase; letter-spacing: 0.05em;">
                            Confirm & Initiate Return
                        </button>
                    </form>
                </div>
            </div>

            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    const container = document.getElementById('additionalItemsContainer');
                    const addBtn = document.getElementById('addItemBtn');
                    const form = document.getElementById('returnForm');
                    let itemCount = 0;

                    function createItemRow() {
                        if (itemCount >= 20) {
                            alert('Maximum 20 additional items allowed.');
                            return;
                        }
                        itemCount++;
                        const div = document.createElement('div');
                        div.className = 'item-row';
                        div.style.background = '#f1f5f9';
                        div.style.padding = '15px';
                        div.style.borderRadius = '12px';
                        div.style.marginBottom = '10px';
                        div.style.position = 'relative';
                        div.innerHTML = \`
                            <div style="display: grid; grid-template-columns: 1fr 2fr 80px; gap: 10px; margin-bottom: 10px;">
                                <input name="part_no" placeholder="Part No" style="padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px;" required />
                                <input name="description" placeholder="Description" style="padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px;" required />
                                <input name="qty" type="number" value="1" min="1" style="padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px; text-align: center;" required />
                            </div>
                            <input name="remarks" placeholder="Optional Remarks" style="width: 95%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 12px;" />
                            <button type="button" class="remove-btn" style="position: absolute; right: 10px; top: 10px; background: none; border: none; color: #ef4444; font-weight: bold; cursor: pointer; font-size: 16px;">×</button>
                        \`;
                        div.querySelector('.remove-btn').onclick = function() {
                            div.remove();
                            itemCount--;
                        };
                        container.appendChild(div);
                    }

                    addBtn.onclick = createItemRow;

                    form.onsubmit = async function(e) {
                        e.preventDefault();
                        const submitBtn = document.getElementById('submitBtn');
                        submitBtn.disabled = true;
                        submitBtn.textContent = 'Processing...';
                        submitBtn.style.opacity = '0.7';

                        const items = [];
                        const rows = container.querySelectorAll('.item-row');
                        rows.forEach(row => {
                            items.push({
                                part_no: row.querySelector('[name="part_no"]').value,
                                description: row.querySelector('[name="description"]').value,
                                qty: parseInt(row.querySelector('[name="qty"]').value),
                                remarks: row.querySelector('[name="remarks"]').value
                            });
                        });

                        try {
                            const response = await fetch('${baseUrl}/api/material/return/initiate', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    passId: '${passId}',
                                    token: '${token}',
                                    additional_items: items
                                })
                            });

                            const result = await response.json();
                            if (result.success) {
                                document.body.innerHTML = \`
                                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: 100px auto; text-align: center; padding: 40px; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); border: 1px solid #e2e8f0;">
                                        <div style="font-size: 48px; margin-bottom: 20px;">✅</div>
                                        <h1 style="color: #1e293b; margin-bottom: 10px;">Return Initiated</h1>
                                        <p style="color: #64748b; font-size: 16px; line-height: 1.6;">\${result.message}</p>
                                        <div style="margin-top: 30px;">
                                            <a href="${frontendUrl}" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 14px;">Back to Portal</a>
                                        </div>
                                    </div>
                                \`;
                            } else {
                                alert('Error: ' + result.message);
                                submitBtn.disabled = false;
                                submitBtn.textContent = 'Confirm & Initiate Return';
                                submitBtn.style.opacity = '1';
                            }
                        } catch (err) {
                            alert('Network error. Please try again.');
                            submitBtn.disabled = false;
                            submitBtn.textContent = 'Confirm & Initiate Return';
                            submitBtn.style.opacity = '1';
                        }
                    };
                });
            </script>
        `;

        res.send(formHtml);

    } catch (err) {
        console.error('getReturnInitiationForm error:', err);
        return renderHtmlResponse(false, 'System Error', 'An unexpected error occurred while loading the form.');
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
    getHistoryPasses,
    confirmReceiverByToken,
    confirmReceiverPortal,
    rejectReceiverPortal,
    initiateReturn,
    markReturnDispatched,
    markReturnReceived,
    confirmReturnReceipt,
    getReturnInitiationForm
};
