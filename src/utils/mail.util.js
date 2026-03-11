const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

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

    try {
        await transporter.sendMail({
            from: `"GatePass System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: subject,
            html: html
        });
        return true;
    } catch (error) {
        console.error('Email Send Error:', error);
        return false;
    }
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
        await transporter.sendMail({
            from: `"GatePass System" <${process.env.EMAIL_USER}>`,
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

    try {
        await transporter.sendMail({
            from: `"GatePass System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Action Required: Gate Pass Approval (${dcNumber} - ${data.passType})`,
            html: html
        });
        return true;
    } catch (error) {
        console.error('Approval Email Error:', error);
        return false;
    }
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

    try {
        await transporter.sendMail({
            from: `"GatePass System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Action Required: Dispatch Required - ${dcNumber} (${data.passType})`,
            html: html
        });
        return true;
    } catch (err) { console.error('Origin Sec Email Error:', err); return false; }
};

const sendDestinationSecurityEmail = async (email, data) => {
    const { securityName, dcNumber, origin, destination, userName, managerName, items, approveUrl, rejectUrl } = data;
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

    try {
        await transporter.sendMail({
            from: `"GatePass System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Action Required: Receiving Confirmation - ${dcNumber} (${data.passType})`,
            html: html
        });
        return true;
    } catch (err) { console.error('Dest Sec Email Error:', err); return false; }
};

const sendReceiverConfirmationEmail = async (email, data) => {
    const { receiverName, dcNumber, materialDetails, confirmationUrl } = data;
    const loginUrl = process.env.FRONTEND_URL || 'http://localhost:8000';

    const html = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: auto; background: #ffffff; padding: 40px; border-radius: 16px; border: 1px solid #eef2f7; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="text-align: center; margin-bottom: 30px;">
                <div style="display: inline-block; background: #10b981; color: white; padding: 8px 16px; border-radius: 8px; font-weight: bold;">GatePass Logistics</div>
            </div>
            <h2 style="color: #1e293b; text-align: center; margin-bottom: 20px;">Receipt Confirmation Required</h2>
            <p style="color: #475569;">Hello <strong>${receiverName}</strong>,</p>
            <p style="color: #475569;">Materials associated with Gate Pass <strong>${dcNumber}</strong> have arrived at the destination. Please confirm receipt of the following items:</p>
            
            <div style="background: #f8fafc; padding: 15px 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #e2e8f0; text-align: center;">
                <p style="margin: 0; font-size: 15px; color: #1e293b;"><strong>Pass Type:</strong> ${data.passType === 'RGP' ? 'RGP (Returnable Gate Pass &ndash; Material Will Return)' : 'NRGP (Non-Returnable Gate Pass &ndash; Material Will Not Return)'}</p>
            </div>

            <div style="background: #f0fdf4; padding: 25px; border-radius: 12px; margin: 25px 0; border: 1px solid #dcfce7;">
                <p style="margin: 0 0 10px 0; font-weight: bold; color: #166534;">Items Received:</p>
                <div style="font-size: 14px; color: #166534; line-height: 1.6;">
                    ${materialDetails}
                </div>
            </div>

            <div style="background: #f8fafc; border: 1px dashed #cbd5e1; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center;">
                <p style="margin: 0 0 15px 0; font-weight: 600; color: #475569; font-size: 14px; text-transform: uppercase;">Quick Actions</p>
                <div style="text-align: center;">
                    <a href="${confirmationUrl}" style="background-color: #10b981; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; margin: 5px;">✅ Confirm Receipt</a>
                    ${data.pdfUrl ? `<a href="${data.pdfUrl}" target="_blank" style="background-color: #3b82f6; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; margin: 5px;">📄 View PDF</a>` : ''}
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

    try {
        await transporter.sendMail({
            from: `"GatePass System" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: `Action Required: Confirm Receipt of Materials - ${dcNumber} (${data.passType})`,
            html: html
        });
        return true;
    } catch (err) { console.error('Receiver Confirmation Email Error:', err); return false; }
};

module.exports = { 
    sendOTPEmail, 
    sendNotificationEmail, 
    sendManagerApprovalEmail,
    sendOriginSecurityEmail,
    sendDestinationSecurityEmail,
    sendReceiverConfirmationEmail
};
