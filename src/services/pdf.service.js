const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ─── Singleton Browser ────────────────────────────────────────────────────────
// Keeps one Chromium process alive across all PDF generates.
let _browser = null;
const getBrowser = async () => {
    if (_browser && _browser.isConnected()) return _browser;
    _browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    _browser.on('disconnected', () => { _browser = null; });
    return _browser;
};

/**
 * Sanitizes input to prevent HTML/PDF injection
 */
const sanitizeHTML = (str) => {
    if (!str) return '';
    return str.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

/**
 * Converts a value to words for the PDF
 */
const numberToWords = (num) => {
    const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const normalizedNum = Math.floor(Math.abs(Number(num)));
    if (normalizedNum === 0) return 'Zero Rupees only';
    if (normalizedNum.toString().length > 9) return 'overflow';
    
    let n = ('000000000' + normalizedNum).substr(-9).match(/^(\d{2})(\d{2})(\d{2})(\d{1})(\d{2})$/);
    if (!n) return ''; 
    let str = '';
    str += (n[1] != 0) ? (a[Number(n[1])] || b[n[1][0]] + ' ' + a[n[1][1]]) + 'Crore ' : '';
    str += (n[2] != 0) ? (a[Number(n[2])] || b[n[2][0]] + ' ' + a[n[2][1]]) + 'Lakh ' : '';
    str += (n[3] != 0) ? (a[Number(n[3])] || b[n[3][0]] + ' ' + a[n[3][1]]) + 'Thousand ' : '';
    str += (n[4] != 0) ? (a[Number(n[4])] || b[n[4][0]] + ' ' + a[n[4][1]]) + 'Hundred ' : '';
    str += (n[5] != 0) ? ((str != '') ? 'and ' : '') + (a[Number(n[5])] || b[n[5][0]] + ' ' + a[n[5][1]]) : '';
    return str.trim() + ' Rupees only';
};

/**
 * Generates the Delivery Challan PDF
 * @param {Object} passData - The data for the pass
 * @param {Boolean} isDraft - Whether to show the DRAFT watermark
 */
const generateChallanPDF = async (passData, isDraft = false) => {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        // Prepare and Sanitize data
        const itemCount = passData.items.length;
        const isReturnMode = !!passData.return_initiated_at || (passData.status && passData.status.toUpperCase().includes('RETURN'));
        const totalQty = passData.items.reduce((acc, item) => acc + Number(item.qty || 0), 0);
        
        // --- Dynamic Scaling Engine ---
        // We adjust the entire PDF scale based on the number of items to ensure it fits on one page.
        // This dynamically reduces font sizes, padding, and heights as item count increases.
        let baseFontSize = 10;
        let tablePadding = 8;
        let headerHeight = 85;
        let signaturePadding = 15;
        let rowHeightAdjustment = 0;

        if (itemCount > 35) {
            baseFontSize = 6.8;
            tablePadding = 3;
            headerHeight = 55;
            signaturePadding = 5;
            rowHeightAdjustment = -15;
        } else if (itemCount > 25) {
            baseFontSize = 7.5;
            tablePadding = 4;
            headerHeight = 65;
            signaturePadding = 8;
            rowHeightAdjustment = -10;
        } else if (itemCount > 15) {
            baseFontSize = 8.5;
            tablePadding = 6;
            headerHeight = 75;
            signaturePadding = 12;
            rowHeightAdjustment = -5;
        } else if (itemCount > 8) {
            baseFontSize = 9.2;
            tablePadding = 7;
            headerHeight = 80;
        } else if (itemCount <= 5) {
            baseFontSize = 11;
            tablePadding = 12;
            headerHeight = 100;
            signaturePadding = 25;
            rowHeightAdjustment = 30;
        }

        const logoPath = path.join(__dirname, '../../../frontend/src/assets/image.png');
        let logoBase64 = '';
        try {
            if (fs.existsSync(logoPath)) {
                logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });
            }
        } catch (e) {
            console.error('Logo encoding error:', e);
        }

        const loadSignature = (sigPath) => {
            if (!sigPath) return '';
            try {
                const fullPath = path.join(__dirname, '../../uploads/signatures', sigPath);
                if (fs.existsSync(fullPath)) {
                    return fs.readFileSync(fullPath, { encoding: 'base64' });
                }
            } catch (e) {
                console.error('Signature read error:', e);
            }
            return '';
        };

        const managerSigBase64 = loadSignature(passData.approved_by_role === 'admin' ? passData.admin_signature_path : passData.manager_signature_path);
        const originSigBase64 = loadSignature(passData.security_origin_signature_path);
        const destSigBase64 = loadSignature(passData.security_destination_signature_path);
        const requesterSigBase64 = loadSignature(passData.created_by_signature_path);
        
        // Receiver signature only shows up after Receiver Confirmation
        let receiverSigBase64 = '';
        const passedReceiverConfirmation = passData.receiver_confirmed_at || 
            ['COMPLETED', 'PENDING_RETURN_RECEIPT', 'PENDING_RETURN_SECURITY_ORIGIN', 'PENDING_RETURN_SECURITY_DESTINATION'].includes(passData.status);
            
        if (passedReceiverConfirmation) {
            receiverSigBase64 = loadSignature(passData.receiver_signature_path);
        }
        
        const returnOriginSigBase64 = loadSignature(passData.security_return_origin_signature_path);
        const returnDestSigBase64 = loadSignature(passData.security_return_destination_signature_path);
        const returnManagerSigBase64 = loadSignature(passData.return_manager_signature_path);
        const returnConfirmedSigBase64 = loadSignature(passData.return_confirmed_by_signature_path);

        const formatIST = (dateStr) => {
            if (!dateStr) return '';
            try {
                const date = new Date(dateStr);
                const istStr = date.toLocaleString('en-IN', { 
                    timeZone: 'Asia/Kolkata', 
                    day: '2-digit', 
                    month: '2-digit', 
                    year: 'numeric', 
                    hour: '2-digit', 
                    minute: '2-digit', 
                    hour12: true 
                });
                return istStr.replace(/\//g, '-').replace(',', '') + ' (IST)';
            } catch (e) {
                return '';
            }
        };

        const isReturnFlowActive = !!passData.return_initiated_at;

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                @font-face {
                    font-family: 'Inter';
                    src: url('file://${process.cwd()}/src/assets/fonts/Inter-Regular.ttf') format('truetype');
                    font-weight: 400;
                }
                @font-face {
                    font-family: 'Inter';
                    src: url('file://${process.cwd()}/src/assets/fonts/Inter-Bold.ttf') format('truetype');
                    font-weight: 700;
                }
                
                body { 
                    font-family: 'Inter', sans-serif; 
                    margin: 0; 
                    padding: 25px; 
                    font-size: ${baseFontSize}px; 
                    color: #0f172a; 
                    line-height: 1.3;
                    height: 100vh;
                    box-sizing: border-box;
                }
                
                .table-container { 
                    border: 1.5px solid #000; 
                    width: 100%; 
                    border-collapse: collapse; 
                    background: white;
                    display: flex;
                    flex-direction: column;
                    min-height: 97vh;
                    box-sizing: border-box;
                }
                
                th, td { 
                    border: 1px solid #000; 
                    padding: ${tablePadding}px; 
                    text-align: left; 
                    vertical-align: top; 
                }
                
                .header-top { 
                    display: flex; 
                    align-items: stretch; 
                    height: ${headerHeight}px; 
                }
                
                .logo-block { 
                    width: 18%; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center; 
                    border-right: 1.5px solid #000;
                    padding: 4px;
                }
                
                .logo-img {
                    max-width: 90%;
                    max-height: 85%;
                    object-fit: contain;
                }
                
                .title-block { 
                    width: 54%; 
                    display: flex; 
                    flex-direction: column;
                    align-items: center; 
                    justify-content: center; 
                    font-size: ${baseFontSize * 1.8}px; 
                    font-weight: 800; 
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    border-right: 1.5px solid #000; 
                    background-color: #f8fafc;
                    text-align: center;
                }
                
                .meta-block { 
                    width: 28%; 
                    display: flex;
                    flex-direction: column;
                }
                
                .meta-row { 
                    display: flex; 
                    flex: 1;
                    border-bottom: 1px solid #000; 
                    font-size: ${baseFontSize * 0.85}px;
                }
                
                .meta-row:last-child { border-bottom: none; }
                
                .meta-label { 
                    width: 45%; 
                    padding: 1px 4px; 
                    border-right: 1px solid #000; 
                    font-weight: 700; 
                    display: flex;
                    align-items: center;
                    background: #f1f5f9;
                }
                
                .meta-value { 
                    width: 55%; 
                    padding: 1px 4px; 
                    display: flex;
                    align-items: center;
                    font-weight: 600;
                }

                .sub-header { 
                    border-top: 1.5px solid #000; 
                    display: flex;
                    font-weight: 800;
                    font-size: ${baseFontSize * 1.1}px;
                }
                
                .sub-header-cell {
                    padding: 6px 12px;
                    flex: 1;
                }

                .details-row { display: flex; border-top: 1.5px solid #000; }
                .details-col { width: 50%; padding: ${tablePadding * 1.2}px; border-right: 1.5px solid #000; }
                .details-col:last-child { border-right: none; }
                
                .section-label {
                    background: #f1f5f9;
                    padding: 4px;
                    font-weight: 800;
                    text-transform: uppercase;
                    border-bottom: 1px solid #000;
                    margin: -${tablePadding * 1.2}px -${tablePadding * 1.2}px 8px -${tablePadding * 1.2}px;
                    text-align: center;
                    font-size: ${baseFontSize * 0.9}px;
                }

                .items-table { 
                    width: 100%; 
                    border-collapse: collapse; 
                    margin-top: -1px; 
                }
                
                .items-table th { 
                    background: #f8fafc; 
                    padding: ${tablePadding}px 4px;
                    font-weight: 800; 
                    text-transform: uppercase;
                    font-size: ${baseFontSize * 0.85}px;
                    text-align: center;
                }
                
                .items-table td { 
                    padding: ${Math.max(2, tablePadding + (rowHeightAdjustment / 2.5))}px 4px;
                    text-align: center; 
                    font-weight: 500;
                    font-size: ${baseFontSize * 0.95}px;
                }
                
                .items-table .desc { text-align: left; font-weight: 600; }

                .signature-section {
                    margin-top: auto;
                    border-top: 1.5px solid #000;
                }

                .signature-area { 
                    display: flex; 
                    justify-content: space-between; 
                    padding: ${signaturePadding}px; 
                }
                
                .sign-box { 
                    text-align: center; 
                    width: 32%; 
                }
                
                .sign-img { 
                    max-height: ${baseFontSize * 3.5}px; 
                    margin-bottom: 3px; 
                    mix-blend-mode: multiply;
                }
                
                .b { font-weight: 700; }
                .center { text-align: center; }
                .right { text-align: right; }

                .draft-watermark {
                    display: ${isDraft ? 'flex' : 'none'};
                    position: fixed; top: 50%; left: 50%;
                    transform: translate(-50%, -50%) rotate(-45deg);
                    font-size: 80px; font-weight: 900;
                    color: rgba(226, 232, 240, 0.3);
                    border: 8px solid rgba(226, 232, 240, 0.3);
                    padding: 10px 40px; border-radius: 20px;
                    z-index: 1000; text-transform: uppercase;
                }
                
                @page { size: A4; margin: 0; }
            </style>
        </head>
        <body>
            <div class="draft-watermark">PREVIEW ONLY</div>
            <div class="table-container">
                <div class="header-top">
                    <div class="logo-block">
                        ${logoBase64 ? `<img src="data:image/png;base64,${logoBase64}" class="logo-img" />` : 'LOGO'}
                    </div>
                    <div class="title-block">
                        ${isReturnFlowActive ? 'RETURNABLE GATE PASS &ndash; <br/><span style="font-size: 0.8em;">RETURN MOVEMENT</span>' : 'Delivery Challan'}
                    </div>
                    <div class="meta-block">
                        <div class="meta-row"><div class="meta-label">Doc No.</div><div class="meta-value">L5-VEP-IMS-WHM-08</div></div>
                        <div class="meta-row"><div class="meta-label">Rev. No.</div><div class="meta-value">1</div></div>
                        <div class="meta-row"><div class="meta-label">Rev. Date</div><div class="meta-value">29-08-2024</div></div>
                    </div>
                </div>

                <div class="sub-header">
                    <div class="sub-header-cell" style="border-right: 1.5px solid #000;">NO : <span style="font-size: 1.2em;">${sanitizeHTML(passData.dc_number || 'DRAFT')}</span></div>
                    <div class="sub-header-cell">DATE : <span style="font-size: 1.2em;">${new Date(passData.created_at || Date.now()).toLocaleDateString('en-GB')}</span></div>
                </div>

                <div class="details-row">
                    <div class="details-col">
                        <div class="section-label">Consignor Details</div>
                        <div class="b">From: ${sanitizeHTML(passData.from_location_name)}</div>
                        <div style="font-size: 0.9em; margin-top: 3px;">${sanitizeHTML(passData.from_address)}</div>
                        ${passData.origin_security_mobile ? `<div style="margin-top: 4px;"><span class="b">Contact:</span> ${sanitizeHTML(passData.origin_security_mobile)}</div>` : ''}
                    </div>
                    <div class="details-col">
                        <div class="section-label">Consignee Details</div>
                        ${passData.movement_type === 'internal' 
                             ? `<div class="b">To: ${sanitizeHTML(passData.to_location_name)}</div>
                                <div style="font-size: 0.9em; margin-top: 3px;">${sanitizeHTML(passData.to_address_detailed)}</div>`
                             : `
                                <div class="b">To: ${sanitizeHTML(passData.receiver_name || '-')}</div>
                                <div style="font-size: 0.9em; margin-top: 3px;">${sanitizeHTML(passData.external_address)}</div>
                                ${passData.receiver_phone ? `<div style="font-size: 0.8em; margin-top: 2px;"><span class="b">Phone:</span> ${sanitizeHTML(passData.receiver_phone)}</div>` : ''}
                                ${passData.receiver_email ? `<div style="font-size: 0.8em; margin-top: 2px;"><span class="b">Email:</span> ${sanitizeHTML(passData.receiver_email)}</div>` : ''}
                               `
                         }
                         ${passData.destination_security_mobile ? `<div style="margin-top: 4px;"><span class="b">Contact:</span> ${sanitizeHTML(passData.destination_security_mobile)}</div>` : ''}
                    </div>
                </div>

                <div style="border-top: 1px solid #000; padding: 2px 10px; display: flex; font-size: 0.9em;">
                    <div style="width: 20%;" class="b">Customer Ref:</div><div style="width: 30%;">${sanitizeHTML(passData.customer_reference) || '-'}</div>
                    <div style="width: 20%;" class="b">Vehicle No:</div><div style="width: 30%;">${sanitizeHTML(passData.vehicle_number) || '-'}</div>
                </div>

                <table class="items-table" style="border-top: 1px solid #000;">
                    <thead>
                        <tr>
                            <th style="width: 30px; border-left: none;">SL</th>
                            <th style="width: 120px;">PART NO.</th>
                            <th>DESCRIPTION</th>
                            <th style="width: 60px;">QTY</th>
                            <th style="width: 120px; border-right: none;">REMARKS</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${passData.items.map((item, i) => `
                            <tr ${item.is_return_extra ? 'style="background-color: #fffbeb;"' : ''}>
                                <td style="border-left: none;">${i + 1}</td>
                                <td class="b">${sanitizeHTML(item.part_no) || 'NA'}</td>
                                <td class="desc">
                                    ${sanitizeHTML(item.description)}
                                    ${item.is_return_extra ? '<div style="font-size: 0.75em; color: #b45309; font-weight: bold; margin-top: 1px;">* Added in Return</div>' : ''}
                                </td>
                                <td class="b">${item.qty}</td>
                                <td style="border-right: none;">${sanitizeHTML(item.remarks) || '-'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                    <tfoot>
                        <tr style="background: #f1f5f9; font-weight: 800;">
                            <td colspan="3" class="right" style="border-left: none;">TOTAL QTY</td>
                            <td class="center" style="background: #fff;">${totalQty}</td>
                            <td style="border-right: none;"></td>
                        </tr>
                    </tfoot>
                </table>

                    <div class="signature-section">
                        ${isReturnFlowActive ? `
                            <div style="padding: 6px; border-bottom: 1px solid #000; text-align: center; background: #f8fafc; font-weight: 800; font-size: ${baseFontSize * 0.9}px; color: #1e293b;">
                                ${passData.movement_type === 'external' ? 'Forward Journey Completed' : 'Forward journey completed. All 5 users have signed.'}
                            </div>
                        ` : ''}
                        <div style="padding: 10px; font-size: 0.85em;">
                            <span class="b">Remark:</span> ${passData.pass_type} basis. Not for sale. Value for insurance only.
                            ${isReturnFlowActive ? `
                                <div style="display: flex; margin-top: 8px; border-top: 1px solid #000; padding-top: 8px;">
                                    <div style="flex: 1;">
                                        <div class="b" style="text-transform: uppercase;">
                                            ${passData.movement_type === 'external' ? `RETURN INITIATOR (SG1 ORIGIN): ${sanitizeHTML(passData.from_location_name)} SECURITY` : 'RETURN INITIATOR (RECEIVER):'} 
                                            ${sanitizeHTML(passData.movement_type === 'external' ? (passData.return_dispatched_by_name || '-') : (passData.receiver_user_name || passData.receiver_name || '-'))}
                                        </div>
                                        <div style="font-size: 0.9em; margin-top: 2px;">Phone: ${sanitizeHTML(passData.movement_type === 'external' ? (passData.origin_security_mobile || '-') : (passData.receiver_user_mobile || passData.receiver_mobile || passData.receiver_phone || '-'))}</div>
                                        ${(passData.movement_type === 'external' ? returnOriginSigBase64 : receiverSigBase64) ? `<img src="data:image/png;base64,${passData.movement_type === 'external' ? returnOriginSigBase64 : receiverSigBase64}" class="sign-img" style="height: 25px; margin-top: 5px;" /><br/><div style="font-size: 0.65em;">${formatIST(passData.return_initiated_at)}</div>` : '<div style="height: 30px;"></div>'}
                                    </div>
                                    <div style="flex: 1; text-align: right;">
                                        <div class="b" style="text-transform: uppercase;">FINAL RECEIVER: ${sanitizeHTML(passData.return_confirmed_by_name || '-')}</div>
                                        <div style="font-size: 0.9em; margin-top: 2px;">Phone: ${sanitizeHTML(passData.created_user_mobile) || '-'}</div>
                                        ${returnConfirmedSigBase64 ? `<img src="data:image/png;base64,${returnConfirmedSigBase64}" class="sign-img" style="height: 25px; margin-top: 5px;" /><br/><div style="font-size: 0.65em;">${formatIST(passData.return_confirmed_at)}</div>` : '<div style="height: 30px;"></div>'}
                                    </div>
                                </div>
                            ` : `
                            <div style="display: flex; margin-top: 8px; border-top: 1px solid #000; padding-top: 8px;">
                                <div style="flex: 1;">
                                    <div class="b" style="text-transform: uppercase;">REQUESTER: ${sanitizeHTML(passData.created_by_name)}</div>
                                    <div style="font-size: 0.9em; margin-top: 2px;">Phone: ${sanitizeHTML(passData.created_user_mobile) || '-'}</div>
                                    ${requesterSigBase64 ? `<img src="data:image/png;base64,${requesterSigBase64}" class="sign-img" style="height: 25px; margin-top: 5px;" /><br/><div style="font-size: 0.65em;">${formatIST(passData.created_at)}</div>` : '<div style="height: 30px;"></div>'}
                                </div>
                                <div style="flex: 1; text-align: right;">
                                    <div class="b" style="text-transform: uppercase;">RECEIVER: ${sanitizeHTML(passData.receiver_user_name || passData.receiver_name || '-')}</div>
                                    <div style="font-size: 0.9em; margin-top: 2px;">Phone: ${sanitizeHTML(passData.receiver_user_mobile || passData.receiver_mobile || passData.receiver_phone || '-')}</div>
                                    ${receiverSigBase64 ? `<img src="data:image/png;base64,${receiverSigBase64}" class="sign-img" style="height: 25px; margin-top: 5px;" /><br/><div style="font-size: 0.65em;">${formatIST(passData.receiver_confirmed_at)}</div>` : '<div style="height: 30px;"></div>'}
                                </div>
                            </div>
                        `}
                    </div>

                    <div class="signature-area">
                        ${isReturnFlowActive ? `
                            ${passData.movement_type === 'external' && passData.pass_type === 'RGP' ? `
                                <div class="sign-box">
                                    <div class="b uppercase" style="font-size: 0.8em;">SG1 (Return Gate)</div>
                                    <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.return_dispatched_by_name) || '-'}</div>
                                    ${returnOriginSigBase64 ? `<img src="data:image/png;base64,${returnOriginSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                    <div style="font-size: 0.65em;">${formatIST(passData.return_dispatched_at || passData.return_initiated_at)}</div>
                                    ${passData.return_vehicle_number ? `
                                        <div style="margin-top: 4px; border-top: 0.5px solid #cbd5e1; padding-top: 2px; font-size: 0.7em; font-weight: 700;">
                                            Ret. Vehicle: ${sanitizeHTML(passData.return_vehicle_number)}
                                        </div>
                                    ` : ''}
                                    ${passData.return_driver_name ? `
                                        <div style="margin-top: 2px; font-size: 0.7em;">
                                            Ret. Driver: ${sanitizeHTML(passData.return_driver_name)} ${passData.return_driver_phone ? `(${sanitizeHTML(passData.return_driver_phone)})` : ''}
                                        </div>
                                    ` : ''}
                                </div>
                                <div class="sign-box">
                                    <div class="b uppercase" style="font-size: 0.8em;">Final Receiver (Creator)</div>
                                    <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.return_confirmed_by_name || passData.created_by_name) || '-'}</div>
                                    ${returnConfirmedSigBase64 ? `<img src="data:image/png;base64,${returnConfirmedSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                    <div style="font-size: 0.65em;">${formatIST(passData.return_confirmed_at)}</div>
                                </div>
                                <div class="sign-box" style="border: none; background: transparent;"></div>
                            ` : `
                                <div class="sign-box">
                                    <div class="b uppercase" style="font-size: 0.8em;">Manager</div>
                                    <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.return_manager_name) || '-'}</div>
                                    ${returnManagerSigBase64 ? `<img src="data:image/png;base64,${returnManagerSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                    <div style="font-size: 0.65em;">${formatIST(passData.return_approved_manager_at)}</div>
                                </div>
                                <div class="sign-box">
                                    <div class="b uppercase" style="font-size: 0.8em;">SG1 Origin</div>
                                    <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.return_dispatched_by_name) || '-'}</div>
                                    ${returnOriginSigBase64 ? `<img src="data:image/png;base64,${returnOriginSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                    <div style="font-size: 0.65em;">${formatIST(passData.return_dispatched_at)}</div>
                                </div>
                                <div class="sign-box">
                                    <div class="b uppercase" style="font-size: 0.8em;">SG2 Destination</div>
                                    <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.return_received_by_name) || '-'}</div>
                                    ${returnDestSigBase64 ? `<img src="data:image/png;base64,${returnDestSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                    <div style="font-size: 0.65em;">${formatIST(passData.return_received_at)}</div>
                                </div>
                            `}
                        ` : `
                            <div class="sign-box">
                                <div class="b uppercase" style="font-size: 0.8em;">Auth. Signatory</div>
                                <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.approved_by_role === 'admin' ? passData.admin_name : passData.manager_name) || '-'}</div>
                                ${managerSigBase64 ? `<img src="data:image/png;base64,${managerSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                <div style="font-size: 0.65em;">${formatIST(passData.approved_by_manager_at)}</div>
                            </div>
                            <div class="sign-box">
                                <div class="b uppercase" style="font-size: 0.8em;">Origin Security</div>
                                <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.dispatched_by_name) || '-'}</div>
                                ${originSigBase64 ? `<img src="data:image/png;base64,${originSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                <div style="font-size: 0.65em;">${formatIST(passData.security_origin_approved_at)}</div>
                            </div>
                            ${passData.movement_type === 'external' && ['NRGP', 'RGP'].includes(passData.pass_type) ? `
                            <div class="sign-box">
                                <div class="b uppercase" style="font-size: 0.8em;">Cab Driver Details</div>
                                ${passData.driver_name ? `<div style="font-size: 0.75em; margin-bottom: 2px; font-weight: 700;">${sanitizeHTML(passData.driver_name)}</div>` : '<div style="font-size: 0.7em; margin-bottom: 2px; color: #94a3b8;">-</div>'}
                                ${passData.driver_phone ? `<div style="font-size: 0.7em; color: #1e293b; margin-bottom: 2px;">Phone: ${sanitizeHTML(passData.driver_phone)}</div>` : ''}
                                ${passData.vehicle_number ? `<div style="font-size: 0.7em; color: #1e293b; margin-bottom: 4px;">Vehicle: ${sanitizeHTML(passData.vehicle_number)}</div>` : ''}
                                <div style="border-bottom: 1.5px solid #374151; margin: 8px 4px 4px 4px;"></div>
                                <div style="font-size: 0.6em; color: #64748b; margin-top: 3px;">Driver Signature (Physical)</div>
                            </div>
                            ` : `
                            <div class="sign-box">
                                <div class="b uppercase" style="font-size: 0.8em;">Destination Security</div>
                                <div style="font-size: 0.7em; margin-bottom: 2px;">${sanitizeHTML(passData.received_by_name) || '-'}</div>
                                ${destSigBase64 ? `<img src="data:image/png;base64,${destSigBase64}" class="sign-img" />` : '<div style="height: 25px;"></div>'}
                                <div style="font-size: 0.65em;">${formatIST(passData.security_destination_approved_at)}</div>
                            </div>
                            `}
                        `}

                    </div>
                </div>
            </div>
        </body>
        </html>
        `;

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' }
        });

        return pdfBuffer;
    } finally {
        await page.close();
    }
};

module.exports = { generateChallanPDF, sanitizeHTML };
