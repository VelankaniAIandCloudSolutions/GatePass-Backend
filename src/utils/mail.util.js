const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_PORT == 465, // Use secure for port 465
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 5000
});

const sendMailInternal = async (options) => {
    try {
        const info = await transporter.sendMail({
            from: `"GatePass System" <${process.env.SMTP_FROM}>`,
            ...options
        });
        console.log("Email sent:", info.messageId);
        return { success: true };
    } catch (error) {
        console.warn("Internet unavailable or SMTP error. Email logged instead.");
        console.log("------------------- OFFLINE EMAIL LOG -------------------");
        console.log(`To: ${options.to}`);
        console.log(`Subject: ${options.subject}`);
        console.log("Body: (HTML content exists but suppressed for brevity)");
        console.log("---------------------------------------------------------");
        return { success: false, logged: true };
    }
};

const sendOTPEmail = async (email, otp, purpose = 'signup') => {
    const subject = purpose === 'signup' 
        ? 'Verify Your GatePass Account' 
        : 'Reset Your GatePass Password';
    
    const title = purpose === 'signup' ? 'Welcome to GatePass!' : 'Password Reset Request';
    const message = purpose === 'signup' 
        ? 'Please use the following OTP to verify your email and complete your registration.'
        : 'We received a request to reset your password. Use the following OTP to continue.';

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
            <div style="background-color: #4f46e5; padding: 24px; text-align: center; color: white;">
                <h1 style="margin: 0; font-size: 24px;">GatePass</h1>
            </div>
            <div style="padding: 32px; background-color: white;">
                <h2 style="color: #1e293b; margin-top: 0;">${title}</h2>
                <p style="color: #475569; line-height: 1.6;">${message}</p>
                <div style="background-color: #f8fafc; border: 2px dashed #cbd5e1; padding: 24px; text-align: center; margin: 32px 0; border-radius: 8px;">
                    <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #4f46e5;">${otp}</span>
                </div>
                <p style="color: #94a3b8; font-size: 12px; text-align: center;">This OTP is valid for 10 minutes. If you did not request this, please ignore this email.</p>
            </div>
            <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b;">
                &copy; 2024 GatePass Security Systems
            </div>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: subject,
        html: html
    });
};

const sendNotificationEmail = async (email, subject, message) => {
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
            <div style="background-color: #4f46e5; padding: 24px; text-align: center; color: white;">
                <h1 style="margin: 0; font-size: 24px;">GatePass</h1>
            </div>
            <div style="padding: 32px; background-color: white;">
                <h2 style="color: #1e293b; margin-top: 0;">Notification</h2>
                <p style="color: #475569; line-height: 1.6;">${message}</p>
                <div style="margin: 32px 0; text-align: center;">
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:8000'}" style="background-color: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">Login to GatePass</a>
                </div>
            </div>
            <div style="background-color: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #64748b;">
                &copy; 2024 GatePass Security Systems
            </div>
        </div>
    `;

    try {
        await sendMailInternal({
            to: email,
            subject: subject,
            html: html
        });
        return true;
    } catch (error) {
        console.error('Notification Email Error:', error);
        return false;
    }
};

const sendManagerApprovalEmail = async (email, data) => {
    const { managerName, dcNumber, userName, approveUrl, rejectUrl, pdfUrl, loginUrl } = data;
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8" />
        </head>
        <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7fa; padding: 20px; margin: 0;">
            <div style="max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); border: 1px solid #eef2f7;">
                <div style="text-align: center; margin-bottom: 30px;">
                    <div style="display: inline-block; background: #4f46e5; color: white; padding: 10px 20px; border-radius: 10px; font-weight: bold; font-size: 20px;">GatePass</div>
                </div>

                <h2 style="color: #1e293b; font-size: 22px; font-weight: 700; margin-bottom: 20px; text-align: center;">Gate Pass Approval Request</h2>

                <p style="font-size: 16px; color: #475569; line-height: 1.6;">
                    Hello <strong>${managerName}</strong>,
                </p>

                <p style="font-size: 16px; color: #475569; line-height: 1.6;">
                    A new material gate pass (<strong>${dcNumber}</strong>) has been submitted by <strong>${userName}</strong> and is awaiting your review.
                </p>

                <div style="background: #f8fafc; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin: 25px 0;">
                    <p style="margin: 0; font-size: 15px; color: #1e293b; text-align: center;"><strong>Pass Type:</strong> ${data.passType === 'RGP' ? 'RGP (Returnable Gate Pass &ndash; Material Will Return)' : 'NRGP (Non-Returnable Gate Pass &ndash; Material Will Not Return)'}</p>
                </div>

                <div style="background: #f8fafc; border-radius: 12px; padding: 25px; margin: 30px 0; border: 1px solid #e2e8f0;">
                    <p style="margin: 0 0 15px 0; font-size: 14px; font-weight: 60; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; text-align: center;">Quick Actions</p>
                    <div style="text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                        <a href="${approveUrl}" style="background-color: #10b981; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; margin: 5px; transition: background 0.2s;">✅ Approve</a>
                        <a href="${rejectUrl}" style="background-color: #ef4444; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; margin: 5px; transition: background 0.2s;">❌ Reject</a>
                        <a href="${pdfUrl}" target="_blank" style="background-color: #3b82f6; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; margin: 5px; transition: background 0.2s;">📄 View PDF (Quick Preview)</a>
                    </div>
                </div>

                <div style="text-align: center; margin-top: 20px;">
                    <a href="${loginUrl}" style="color: #4f46e5; text-decoration: none; font-size: 14px; font-weight: 600; border-bottom: 1px solid #4f46e5;">🔐 Login to Portal for Full Details</a>
                </div>

                <p style="margin-top: 40px; font-size: 13px; color: #94a3b8; text-align: center; border-top: 1px solid #f1f5f9; pt: 20px;">
                    This is an automated notification from the GatePass Security System.
                </p>
            </div>
        </body>
        </html>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Action Required: Gate Pass Approval (${dcNumber} - ${data.passType})`,
        html: html
    });
};

const sendOriginSecurityEmail = async (email, data) => {
    const { securityName, dcNumber, origin, destination, userName, managerName, items, approveUrl, rejectUrl } = data;
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: #6366f1; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass Logistics</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">Dispatch Required</h2>
            <p style="color: #475569;">Hello <strong>${securityName}</strong>,</p>
            <p style="color: #475569;">A new material movement (<strong>${dcNumber}</strong>) has been approved and requires <strong>Dispatch</strong> from your location.</p>
            
            <div style="background: #f8fafc; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #e2e8f0;">
                <p style="margin: 5px 0;"><strong>Pass Type:</strong> ${data.passType === 'RGP' ? 'RGP (Returnable Gate Pass &ndash; Material Will Return)' : 'NRGP (Non-Returnable Gate Pass &ndash; Material Will Not Return)'}</p>
                <p style="margin: 5px 0;"><strong>Origin:</strong> ${origin}</p>
                <p style="margin: 5px 0;"><strong>Destination:</strong> ${destination}</p>
                <p style="margin: 5px 0;"><strong>Submitted By:</strong> ${userName}</p>
                <p style="margin: 5px 0;"><strong>Approved By (${data.approverRole || 'Manager'}):</strong> ${managerName}</p>
            </div>

            <div style="background: #fdf2f2; border: 1px dashed #f87171; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0 0 15px 0; font-weight: 600; color: #991b1b; font-size: 14px; text-transform: uppercase;">Quick Decison (One-Click)</p>
                <div style="text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                    <a href="${approveUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">✅ Approve (Dispatch)</a>
                    <a href="${rejectUrl}" style="background-color: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">❌ Reject Movement</a>
                    <a href="${data.pdfUrl}" target="_blank" style="background-color: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">📄 View PDF</a>
                </div>
            </div>

            <div style="text-align: center; margin: 20px 0;">
                <a href="${loginUrl}" style="color: #6366f1; text-decoration: none; font-weight: 600; font-size: 14px; border-bottom: 1px solid #6366f1;">🔐 Login to Portal for Full Details</a>
            </div>
            
            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
                This is an automated notification from GatePass Security.
            </p>0
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Action Required: Dispatch Required - ${dcNumber} (${data.passType})`,
        html: html
    });
};

const sendDestinationSecurityEmail = async (email, data) => {
    const { securityName, dcNumber, origin, destination, userName, managerName, vehicleNumber, items, approveUrl, rejectUrl } = data;
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: #f59e0b; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass Logistics</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">Receiving Confirmation</h2>
            <p style="color: #475569;">Hello <strong>${securityName}</strong>,</p>
            <p style="color: #475569;">A material movement (<strong>${dcNumber}</strong>) has been dispatched and is <strong>In Transit</strong> to your location.</p>
            
            <div style="background: #fffbeb; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #fef3c7;">
                <p style="margin: 5px 0;"><strong>Pass Type:</strong> ${data.passType === 'RGP' ? 'RGP (Returnable Gate Pass &ndash; Material Will Return)' : 'NRGP (Non-Returnable Gate Pass &ndash; Material Will Not Return)'}</p>
                <p style="margin: 5px 0;"><strong>Origin:</strong> ${origin}</p>
                <p style="margin: 5px 0;"><strong>Destination:</strong> ${destination}</p>
                <p style="margin: 5px 0;"><strong>Vehicle Number:</strong> <span style="font-weight: 700; color: #1e293b; background: #fef08a; padding: 2px 6px; border-radius: 4px; border: 1px solid #facc15;">${vehicleNumber || 'N/A'}</span></p>
                <p style="margin: 5px 0;"><strong>Submitted By:</strong> ${userName}</p>
                <p style="margin: 5px 0;"><strong>Approved By:</strong> ${managerName}</p>
            </div>

            <div style="background: #fff7ed; border: 1px dashed #f59e0b; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0 0 15px 0; font-weight: 600; color: #92400e; font-size: 14px; text-transform: uppercase;">Quick Decison (One-Click)</p>
                <div style="text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                    <a href="${approveUrl}" style="background-color: #f59e0b; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">✅ Approve (Receive)</a>
                    <a href="${rejectUrl}" style="background-color: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">❌ Reject Movement</a>
                    <a href="${data.pdfUrl}" target="_blank" style="background-color: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">📄 View PDF</a>
                </div>
            </div>

            <div style="text-align: center; margin: 20px 0;">
                <a href="${loginUrl}" style="color: #f59e0b; text-decoration: none; font-weight: 600; font-size: 14px; border-bottom: 1px solid #f59e0b;">🔐 Login to Portal for Full Details</a>
            </div>

            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
                This is an automated notification from GatePass Security.
            </p>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Action Required: Receiving Confirmation - ${dcNumber} (${data.passType})`,
        html: html
    });
};

const sendReceiverConfirmationEmail = async (email, data) => {
    const { receiverName, dcNumber, materialDetails, confirmationUrl, returnFormUrl, pdfUrl, isRGP } = data;
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';
    const actionTitle = isRGP ? 'Materials Received &mdash; Verify &amp; Confirm' : 'Receipt Confirmation Required';
    const actionDescription = isRGP
        ? `Materials for Gate Pass <strong>${dcNumber}</strong> have arrived at your location. As this is an <strong>RGP (Returnable)</strong> pass, please verify the items and click <strong>Accept</strong>. You can initiate the return journey whenever you are ready.`
        : `Materials associated with Gate Pass <strong>${dcNumber}</strong> have arrived at the destination. Please confirm receipt of the following items:`;

    const acceptUrl = `${confirmationUrl}&action=approve`;
    const rejectUrl = `${confirmationUrl}&action=reject`;
    const returnUrl = returnFormUrl || loginUrl;

    const acceptBtn = `<a href="${acceptUrl}" style="background-color:#10b981;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:5px;">✅ Accept Receipt</a>`;
    const rejectBtn = `<a href="${rejectUrl}" style="background-color:#ef4444;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:5px;">❌ Reject</a>`;
    const returnBtn = isRGP ? `<a href="${returnUrl}" style="background-color:#7c3aed;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:5px;">↩ Initiate Return</a>` : '';

    const ctaButtons = `
        <div style="text-align: center; margin: 20px 0;">
            ${acceptBtn}
            ${rejectBtn}
            ${returnBtn}
        </div>
    `;

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: ${isRGP ? '#7c3aed' : '#10b981'}; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass Logistics</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">${actionTitle}</h2>
            <p style="color: #475569;">Hello <strong>${receiverName}</strong>,</p>
            <p style="color: #475569;">${actionDescription}</p>
            
            <div style="background: #f8fafc; padding: 15px 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #e2e8f0; text-align: center;">
                <p style="margin: 0; font-size: 15px; color: #1e293b;"><strong>Pass Type:</strong> ${data.passType === 'RGP' ? 'RGP (Returnable Gate Pass &ndash; Material Will Return)' : 'NRGP (Non-Returnable Gate Pass &ndash; Material Will Not Return)'}</p>
            </div>

            <div style="background: ${isRGP ? '#f5f3ff' : '#f0fdf4'}; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid ${isRGP ? '#ede9fe' : '#dcfce7'};">
                <p style="margin: 0 0 10px 0; font-weight: bold; color: ${isRGP ? '#5b21b6' : '#166534'};">Items ${isRGP ? 'Delivered' : 'Received'}:</p>
                <div style="font-size: 14px; color: ${isRGP ? '#5b21b6' : '#166534'}; line-height: 1.6;">
                    ${materialDetails}
                </div>
            </div>

            <div style="background: #f8fafc; border: 1px dashed #cbd5e1; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0 0 15px 0; font-weight: 600; color: #475569; font-size: 14px; text-transform: uppercase;">Quick Actions</p>
                <div style="text-align: center;">
                    ${ctaButtons}
                    ${pdfUrl ? `<a href="${pdfUrl}" target="_blank" style="background-color: #3b82f6; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; margin: 5px;">📄 View PDF</a>` : ''}
                </div>
            </div>

            <div style="text-align: center; margin: 20px 0;">
                <a href="${loginUrl}" style="color: #10b981; text-decoration: none; font-weight: 600; font-size: 14px; border-bottom: 1px solid #10b981;">🔐 Login to Portal for Full Details</a>
            </div>
            
            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
                This is an automated notification from GatePass Security.
            </p>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: isRGP
            ? `Action Required: Materials Received – Please Initiate Return – ${dcNumber} [RGP]`
            : `Action Required: Confirm Receipt of Materials - ${dcNumber} (${data.passType})`,
        html: html
    });
};

const sendReturnManagerEmail = async (email, data) => {
    const { managerName, dcNumber, receiverName, approveUrl, rejectUrl, pdfUrl, loginUrl, passType, origin, destination } = data;
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="UTF-8" /></head>
        <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f7fa; padding: 20px; margin: 0;">
            <div style="max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.06); border: 1px solid #eef2f7;">
                <div style="text-align: center; margin-bottom: 30px;">
                    <div style="display: inline-block; background: #7c3aed; color: white; padding: 10px 20px; border-radius: 10px; font-weight: bold; font-size: 20px;">GatePass ↩</div>
                </div>

                <h2 style="color: #1e293b; font-size: 22px; font-weight: 700; margin-bottom: 20px; text-align: center;">Return Approval Required</h2>

                <p style="font-size: 16px; color: #475569; line-height: 1.6;">
                    Hello <strong>${managerName}</strong>,
                </p>

                <p style="font-size: 16px; color: #475569; line-height: 1.6;">
                    The receiver <strong>${receiverName}</strong> has initiated a <strong>return of materials</strong> for Gate Pass <strong>${dcNumber}</strong> (${passType}).
                </p>

                <div style="background: #f8fafc; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; margin: 25px 0;">
                    <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Pass Type:</strong> RGP (Returnable)</p>
                    <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Return Route:</strong> ${destination} &rarr; ${origin}</p>
                </div>

                <div style="background: #f5f3ff; border-radius: 12px; padding: 25px; margin: 30px 0; border: 1px solid #ede9fe;">
                    <p style="margin: 0 0 15px 0; font-size: 14px; font-weight: 60; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; text-align: center;">Quick Actions</p>
                    <div style="text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                        <a href="${approveUrl}" style="background-color: #7c3aed; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; margin: 5px; transition: background 0.2s;">✅ Approve Return</a>
                        <a href="${rejectUrl}" style="background-color: #ef4444; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; margin: 5px; transition: background 0.2s;">❌ Reject</a>
                        <a href="${pdfUrl}" target="_blank" style="background-color: #3b82f6; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px; display: inline-block; margin: 5px; transition: background 0.2s;">📄 View PDF</a>
                    </div>
                </div>

                <div style="text-align: center; margin-top: 20px;">
                    <a href="${loginUrl}" style="color: #7c3aed; text-decoration: none; font-size: 14px; font-weight: 600; border-bottom: 1px solid #7c3aed;">🔐 Login to Portal for Full Details</a>
                </div>

                <p style="margin-top: 40px; font-size: 13px; color: #94a3b8; text-align: center; border-top: 1px solid #f1f5f9; pt: 20px;">
                    This is an automated notification from the GatePass Security System.
                </p>
            </div>
        </body>
        </html>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Action Required: Return Approval Required - ${dcNumber} (RGP)`,
        html: html
    });
};

const sendReturnDestinationSecurityEmail = async (email, data) => {
    const { securityName, dcNumber, origin, destination, userName, managerName, approveUrl, rejectUrl, pdfUrl, passType } = data;
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: #7c3aed; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass Return</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">Return Dispatch Required</h2>
            <p style="color: #475569;">Hello <strong>${securityName}</strong>,</p>
            <p style="color: #475569;">A return movement (<strong>${dcNumber}</strong>) has been approved and requires <strong>Dispatch</strong> from your location back to origin.</p>
            
            <div style="background: #f8fafc; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #e2e8f0;">
                <p style="margin: 5px 0;"><strong>Pass Type:</strong> RGP (Returnable)</p>
                <p style="margin: 5px 0;"><strong>Dispatch From:</strong> ${destination}</p>
                <p style="margin: 5px 0;"><strong>Return To:</strong> ${origin}</p>
                <p style="margin: 5px 0;"><strong>Approved By:</strong> ${managerName}</p>
            </div>

            <div style="background: #f5f3ff; border: 1px dashed #7c3aed; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0 0 15px 0; font-weight: 600; color: #5b21b6; font-size: 14px; text-transform: uppercase;">Quick Decison (One-Click)</p>
                <div style="text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                    <a href="${approveUrl}" style="background-color: #7c3aed; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">✅ Approve (Dispatch)</a>
                    <a href="${rejectUrl}" style="background-color: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">❌ Reject</a>
                    <a href="${pdfUrl}" target="_blank" style="background-color: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">📄 View PDF</a>
                </div>
            </div>

            <div style="text-align: center; margin: 20px 0;">
                <a href="${loginUrl}" style="color: #7c3aed; text-decoration: none; font-weight: 600; font-size: 14px; border-bottom: 1px solid #7c3aed;">🔐 Login to Portal for Full Details</a>
            </div>
            
            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
                This is an automated notification from GatePass Security.
            </p>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Action Required: Return Dispatch Required - ${dcNumber} (RGP)`,
        html: html
    });
};

const sendReturnOriginSecurityEmail = async (email, data) => {
    const { securityName, dcNumber, passType, origin, destination, vehicleNumber, items, approveUrl, rejectUrl, pdfUrl } = data;
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: #6366f1; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass Return</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">Return Receipt Required</h2>
            <p style="color: #475569;">Hello <strong>${securityName}</strong>,</p>
            <p style="color: #475569;">A return movement (<strong>${dcNumber}</strong>) has been dispatched and is <strong>Returning in Transit</strong> to your location.</p>
            
            <div style="background: #eef2ff; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #e0e7ff;">
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Pass Type:</strong> RGP (Returnable)</p>
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Return Route:</strong> ${destination} &rarr; ${origin}</p>
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Vehicle Number:</strong> <span style="font-weight: 700; color: #1e293b; background: #fef08a; padding: 2px 6px; border-radius: 4px; border: 1px solid #facc15;">${vehicleNumber || 'N/A'}</span></p>
            </div>

            <div style="background: #f8fafc; border: 1px dashed #6366f1; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0 0 15px 0; font-weight: 600; color: #4338ca; font-size: 14px; text-transform: uppercase;">Quick Action</p>
                <div style="text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                    <a href="${approveUrl}" style="background-color: #6366f1; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">✅ Approve (Receive)</a>
                    <a href="${rejectUrl}" style="background-color: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">❌ Reject</a>
                    <a href="${pdfUrl}" target="_blank" style="background-color: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">📄 View PDF</a>
                </div>
            </div>

            <div style="text-align: center; margin: 20px 0;">
                <a href="${loginUrl}" style="color: #6366f1; text-decoration: none; font-weight: 600; font-size: 14px; border-bottom: 1px solid #6366f1;">🔐 Login to Portal for Full Details</a>
            </div>

            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
                This is an automated notification from GatePass Security.
            </p>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Action Required: Return Receiving Confirmation - ${dcNumber} (RGP)`,
        html: html
    });
};

const sendReturnCompletionEmail = async (email, data) => {
    const { recipientName, dcNumber, items, confirmationUrl, pdfUrl, origin, destination } = data;
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

    const acceptUrl = `${confirmationUrl}&action=approve&confirmed=true`;
    const rejectUrl = `${confirmationUrl}&action=reject`;

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: #10b981; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass Return</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">Return Receipt Confirmation</h2>
            <p style="color: #475569;">Hello <strong>${recipientName}</strong>,</p>
            <p style="color: #475569;">Materials associated with Gate Pass <strong>${dcNumber}</strong> have returned to your location. Please confirm the final receipt to complete the workflow.</p>
            
            <div style="background: #f0fdf4; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #dcfce7;">
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Pass Type:</strong> RGP (Returnable)</p>
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Route:</strong> ${destination} &rarr; ${origin}</p>
            </div>

            <div style="background: #f8fafc; border: 1px dashed #10b981; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0 0 15px 0; font-weight: 600; color: #166534; font-size: 14px; text-transform: uppercase;">Quick Actions</p>
                <div style="text-align: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 10px;">
                    <a href="${acceptUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">✅ Confirm Final Receipt</a>
                    <a href="${rejectUrl}" style="background-color: #ef4444; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">❌ Reject</a>
                    <a href="${pdfUrl}" target="_blank" style="background-color: #3b82f6; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 5px; display: inline-block;">📄 View PDF</a>
                </div>
            </div>

            <div style="text-align: center; margin: 20px 0;">
                <a href="${loginUrl}" style="color: #10b981; text-decoration: none; font-weight: 600; font-size: 14px; border-bottom: 1px solid #10b981;">🔐 Login to Portal for Full Details</a>
            </div>

            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
                This is an automated notification from the GatePass System.
            </p>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Action Required: Return Receipt Confirmation - ${dcNumber} (RGP)`,
        html: html
    });
};

const sendRejectionEmail = async (email, data) => {
    const recipientName = data.recipientName || 'User';
    const dcNumber = data.dcNumber || 'N/A';
    const passType = data.passType || 'Gate Pass';
    const rejectedBy = data.rejectedBy || 'System';
    const rejectedRole = data.rejectedRole || 'Security';
    const rejectionReason = data.rejectionReason || 'No reason provided';
    const origin = data.origin || 'N/A';
    const destination = data.destination || 'N/A';
    const loginUrl = data.loginUrl || process.env.FRONTEND_URL || 'http://localhost:3000';
    const rejectionStage = data.rejectionStage || data.rejectedRole || 'N/A';

    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
            <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px 20px; text-align: center;">
                <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600; text-shadow: 0 2px 4px rgba(0,0,0,0.1);">Gate Pass Rejected</h1>
                <p style="color: #feca21; margin: 8px 0 0 0; font-size: 15px; opacity: 0.9;">Action Blocked</p>
            </div>
            
            <div style="padding: 40px 30px; background-color: #ffffff;">
                <p style="font-size: 16px; color: #334155; margin-top: 0;">Hi <strong>${recipientName}</strong>,</p>
                <p style="font-size: 15px; color: #475569; line-height: 1.6;">
                    The Gate Pass <strong>${dcNumber}</strong> (${passType}) has been rejected. The movement cannot proceed further.
                </p>

                <div style="background: #f8fafc; padding: 15px 25px; border-radius: 12px; margin: 20px 0; border: 1px solid #e2e8f0;">
                    <p style="margin: 0; font-size: 14px; color: #475569;"><strong>Route:</strong> ${origin} &rarr; ${destination}</p>
                </div>
                
                <div style="background-color: #fff1f2; border: 1px solid #fecaca; padding: 25px; border-radius: 12px; margin: 25px 0;">
                    <h3 style="margin: 0 0 15px 0; color: #991b1b; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 800;">Rejection Audit Trail</h3>
                    
                    <div style="margin-bottom: 15px; display: grid; grid-template-columns: 120px 1fr; gap: 10px;">
                        <p style="margin: 0; color: #64748b; font-size: 13px;"><strong>Stage:</strong></p>
                        <p style="margin: 0; color: #1e293b; font-size: 14px; font-weight: 600;">${rejectionStage || rejectedRole || 'N/A'}</p>
                    </div>

                    <div style="margin-bottom: 15px; display: grid; grid-template-columns: 120px 1fr; gap: 10px;">
                        <p style="margin: 0; color: #64748b; font-size: 13px;"><strong>Rejected By:</strong></p>
                        <p style="margin: 0; color: #1e293b; font-size: 14px; font-weight: 600;">${rejectedBy} <span style="color: #64748b; font-weight: 400; font-size: 12px;">(${rejectedRole})</span></p>
                    </div>

                    <div style="margin-bottom: 15px; display: grid; grid-template-columns: 120px 1fr; gap: 10px;">
                        <p style="margin: 0; color: #64748b; font-size: 13px;"><strong>Flow Type:</strong></p>
                        <p style="margin: 0; color: #1e293b; font-size: 14px; font-weight: 600;">${passType || 'N/A'}</p>
                    </div>

                    <div style="margin-top: 20px; padding-top: 15px; border-top: 1px dashed #fca5a5;">
                        <p style="margin: 0 0 8px 0; color: #991b1b; font-size: 13px; font-weight: 700;">REJECTION REMARK:</p>
                        <div style="background: #ffffff; padding: 15px; border-radius: 8px; border: 1px solid #fca5a5; color: #7f1d1d; font-size: 14px; line-height: 1.5; font-style: italic;">
                            "${rejectionReason || 'No reason provided'}"
                        </div>
                    </div>
                </div>

                <p style="margin-top:20px;color:#64748b;font-size:13px;">Please log in to the GatePass portal for more details or to initiate a new request if necessary.</p>
                
                <div style="margin-top: 35px; text-align: center;">
                    <a href="${loginUrl}" style="background-color: #4f46e5; color: white; padding: 14px 35px; border-radius: 10px; text-decoration: none; font-weight: bold; display: inline-block; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.2);">View in Portal</a>
                </div>
            </div>
            <div style="background-color: #f8fafc; padding: 25px; text-align: center; border-top: 1px solid #e2e8f0;">
                <p style="margin: 0; color: #94a3b8; font-size: 12px;">This is an automated message from the GatePass System. Please do not reply.</p>
            </div>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Gate Pass Rejected - ${dcNumber} (${passType})`,
        html: html
    });
};


const sendExternalNRGPCompletionEmail = async (email, data) => {
    const {
        recipientName, dcNumber, driverName, driverPhone, vehicleNumber,
        origin, externalAddress, completedAt, loginUrl
    } = data;

    const formattedDate = (() => {
        try {
            const d = new Date(completedAt);
            return d.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true
            }).replace(/\//g, '-').replace(',', '') + ' (IST)';
        } catch { return completedAt || 'N/A'; }
    })();

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: #10b981; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass ✅</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">External NRGP – Pass Completed</h2>
            <p style="color: #475569;">Hello <strong>${recipientName}</strong>,</p>
            <p style="color: #475569;">Gate Pass <strong>${dcNumber}</strong> (External NRGP) has been successfully dispatched by Origin Security and is now <strong>COMPLETED</strong>.</p>

            <div style="background: #f0fdf4; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #dcfce7;">
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Pass Type:</strong> External NRGP (Non-Returnable)</p>
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Origin:</strong> ${origin || 'N/A'}</p>
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>External Destination:</strong> ${externalAddress || 'N/A'}</p>
                <p style="margin: 5px 0; font-size: 14px; color: #475569;"><strong>Completed At:</strong> ${formattedDate}</p>
            </div>

            <div style="background: #f8fafc; padding: 20px 25px; border-radius: 12px; margin: 20px 0; border: 1px solid #e2e8f0;">
                <p style="margin: 0 0 10px 0; font-weight: 700; color: #374151; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em;">Cab Driver Details</p>
                <p style="margin: 5px 0; font-size: 15px; color: #1e293b;"><strong>Driver Name:</strong> ${driverName}</p>
                <p style="margin: 5px 0; font-size: 15px; color: #1e293b;"><strong>Driver Phone:</strong> ${driverPhone}</p>
                <p style="margin: 5px 0; font-size: 15px; color: #1e293b;"><strong>Vehicle Number:</strong> ${vehicleNumber || 'N/A'}</p>
            </div>

            <div style="text-align: center; margin-top: 30px;">
                <a href="${loginUrl}" style="background-color: #4f46e5; color: white; padding: 14px 35px; border-radius: 10px; text-decoration: none; font-weight: bold; display: inline-block;">View in Portal</a>
            </div>

            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 30px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
                This is an automated notification from the GatePass System.
            </p>
        </div>
    `;

    return await sendMailInternal({
        to: email,
        subject: `Completed: External NRGP Dispatched – ${dcNumber}`,
        html: html
    });
};

module.exports = { 
    sendOTPEmail, 
    sendNotificationEmail, 
    sendManagerApprovalEmail,
    sendOriginSecurityEmail,
    sendDestinationSecurityEmail,
    sendReceiverConfirmationEmail,
    sendReturnManagerEmail,
    sendReturnDestinationSecurityEmail,
    sendReturnOriginSecurityEmail,
    sendReturnCompletionEmail,
    sendRejectionEmail,
    sendExternalNRGPCompletionEmail
};

