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
        const totalQty = passData.items.reduce((acc, item) => acc + Number(item.qty || 0), 0);
        const totalValue = passData.items.reduce((acc, item) => acc + Number(item.total || 0), 0);
        const totalWords = sanitizeHTML(numberToWords(totalValue));
        
        const logoPath = path.join(__dirname, '../../../frontend/src/assets/image.png');
        let logoBase64 = '';
        try {
            if (fs.existsSync(logoPath)) {
                logoBase64 = fs.readFileSync(logoPath, { encoding: 'base64' });
            }
        } catch (e) {
            console.error('Logo encoding error:', e);
        }

        // Prepare signatures base64
        let managerSigBase64 = '';
        let originSigBase64 = '';
        let destSigBase64 = '';

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

        managerSigBase64 = loadSignature(passData.manager_signature_path);
        originSigBase64 = loadSignature(passData.security_origin_signature_path);
        destSigBase64 = loadSignature(passData.security_destination_signature_path);
        const adminSigBase64 = loadSignature(passData.admin_signature_path);
        const requesterSigBase64 = loadSignature(passData.created_by_signature_path);
        const receiverSigBase64 = loadSignature(passData.receiver_signature_path);

        // Format helper: DD-MM-YYYY hh:mm AM/PM (IST)
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

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
                
                body { 
                    font-family: 'Inter', -apple-system, sans-serif; 
                    margin: 0; 
                    padding: 30px; 
                    font-size: 10px; 
                    color: #0f172a; 
                    line-height: 1.4;
                }
                
                .table-container { 
                    border: 2px solid #000; 
                    width: 100%; 
                    border-collapse: collapse; 
                    background: white;
                }
                
                th, td { 
                    border: 1px solid #000; 
                    padding: 8px; 
                    text-align: left; 
                    vertical-align: top; 
                }
                
                /* Header Section */
                .header-top { 
                    display: flex; 
                    align-items: stretch; 
                    height: 85px; 
                }
                
                .logo-block { 
                    width: 18%; 
                    display: flex; 
                    align-items: center; 
                    justify-content: center; 
                    border-right: 2px solid #000;
                    padding: 4px;
                }
                
                .logo-img {
                    max-width: 100%;
                    max-height: 90%;
                    object-fit: contain;
                    transform: scale(1.15);
                }
                
                .title-block { 
                    width: 54%; 
                    display: flex; 
                    flex-direction: column;
                    align-items: center; 
                    justify-content: center; 
                    font-size: 20px; 
                    font-weight: 800; 
                    text-transform: uppercase;
                    letter-spacing: 1px;
                    border-right: 2px solid #000; 
                    background-color: #f8fafc;
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
                    font-size: 8px; /* Slightly smaller for more text room */
                }
                
                .meta-row:last-child { border-bottom: none; }
                
                .meta-label { 
                    width: 40%; 
                    padding: 2px 6px; 
                    border-right: 1px solid #000; 
                    font-weight: 700; 
                    display: flex;
                    align-items: center;
                    background: #f1f5f9;
                }
                
                .meta-value { 
                    width: 60%; 
                    padding: 2px 6px; 
                    display: flex;
                    align-items: center;
                    font-weight: 600;
                    word-break: break-all;
                }

                .sub-header { 
                    border-top: 2px solid #000; 
                    padding: 0; 
                    display: flex;
                    font-weight: 700;
                    font-size: 11px;
                }
                
                .sub-header-cell {
                    padding: 10px 15px;
                    flex: 1;
                }

                .details-row { display: flex; border-top: 2px solid #000; }
                .details-col { width: 50%; padding: 12px; border-right: 2px solid #000; }
                .details-col:last-child { border-right: none; }
                
                .section-label {
                    background: #f1f5f9;
                    padding: 6px 12px;
                    font-weight: 800;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    border-bottom: 1px solid #000;
                    margin: -12px -12px 10px -12px;
                    text-align: center;
                }

                .items-table { 
                    width: 100%; 
                    border-collapse: collapse; 
                    margin-top: -1px; 
                }
                
                .items-table th { 
                    background: #f8fafc; 
                    padding: 10px 6px;
                    font-weight: 800; 
                    text-transform: uppercase;
                    font-size: 9px;
                    text-align: center;
                }
                
                .items-table td { 
                    padding: 10px 6px;
                    text-align: center; 
                    font-weight: 500;
                }
                
                .items-table .desc { text-align: left; font-weight: 600; }

                .footer-strip { 
                    padding: 12px; 
                    font-weight: 800; 
                    border-top: 2px solid #000; 
                    background: #f8fafc;
                    font-size: 11px;
                }
                
                .terms { 
                    padding: 15px; 
                    border-top: 2px solid #000; 
                }
                
                .signature-area { 
                    display: flex; 
                    justify-content: space-between; 
                    padding: 15px; 
                    margin-top: 20px; 
                }
                
                .sign-box { 
                    text-align: center; 
                    width: 30%; 
                }
                
                .sign-img { 
                    max-height: 55px; 
                    margin-bottom: 4px; 
                    mix-blend-mode: multiply;
                }

                .small-sign-img {
                    max-height: 35px;
                    margin-top: 8px;
                    mix-blend-mode: multiply;
                }
                
                .b { font-weight: 700; }
                .center { text-align: center; }
                .right { text-align: right; }

                /* Draft Watermark */
                .draft-watermark {
                    display: ${isDraft ? 'flex' : 'none'};
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) rotate(-45deg);
                    font-size: 120px;
                    font-weight: 900;
                    color: rgba(224, 242, 254, 0.4);
                    border: 15px solid rgba(224, 242, 254, 0.4);
                    padding: 20px 60px;
                    border-radius: 40px;
                    white-space: nowrap;
                    pointer-events: none;
                    z-index: 1000;
                    text-transform: uppercase;
                }
            </style>
        </head>
        <body>
            <div class="draft-watermark">FOR PREVIEW</div>
            <div class="table-container">
                <!-- Top Header -->
                <div class="header-top">
                    <div class="logo-block">
                        ${logoBase64 ? `<img src="data:image/png;base64,${logoBase64}" class="logo-img" />` : 'LOGO'}
                    </div>
                    <div class="title-block">Delivery Challan</div>
                    <div class="meta-block">
                        <div class="meta-row">
                            <div class="meta-label">Doc No.:</div>
                            <div class="meta-value">L5-VEP-IMS-WHM-08</div>
                        </div>
                        <div class="meta-row">
                            <div class="meta-label">Rev. No.</div>
                            <div class="meta-value">1</div>
                        </div>
                        <div class="meta-row">
                            <div class="meta-label">Rev. Date</div>
                            <div class="meta-value">29-08-2024</div>
                        </div>
                    </div>
                </div>

                <!-- DC Number and Date -->
                <div class="sub-header">
                    <div class="sub-header-cell" style="border-right: 2px solid #000;">
                        DELIVERY CHALLAN NO : <span style="font-size: 14px;">${sanitizeHTML(passData.dc_number || 'DRAFT')}</span>
                    </div>
                    <div class="sub-header-cell">
                        DATE : <span style="font-size: 14px;">${new Date(passData.created_at || Date.now()).toLocaleDateString('en-GB')}</span>
                    </div>
                </div>

                <!-- Consignor / Consignee -->
                <div class="details-row">
                    <div class="details-col">
                        <div class="section-label">Consignor Details</div>
                        <div style="margin-bottom: 4px;"><span class="b">From:</span> ${sanitizeHTML(passData.from_location_name)}</div>
                        <div style="white-space: pre-line; color: #475569; font-weight: 500;">${sanitizeHTML(passData.from_address)}</div>
                        
                        <!-- Single Security Contact line -->
                        ${passData.origin_security_mobile ? `<div style="margin-top: 6px;"><span class="b">Contact:</span> ${sanitizeHTML(passData.origin_security_mobile)}</div>` : ''}
                    </div>
                    <div class="details-col">
                        <div class="section-label">Consignee Details</div>
                        ${passData.movement_type === 'internal' 
                             ? `<div style="margin-bottom: 4px;"><span class="b">To:</span> ${sanitizeHTML(passData.to_location_name)}</div>
                                <div style="white-space: pre-line; color: #475569; font-weight: 500;">${sanitizeHTML(passData.to_address_detailed)}</div>`
                             : `<div style="white-space: pre-line; color: #475569; font-weight: 500;">${sanitizeHTML(passData.external_address)}</div>`
                         }
                         
                         <!-- Single Security Contact line -->
                         ${passData.destination_security_mobile ? `<div style="margin-top: 6px;"><span class="b">Contact:</span> ${sanitizeHTML(passData.destination_security_mobile)}</div>` : ''}
                    </div>
                </div>

                <!-- Logistics Info -->
                <div style="border-top: 1px solid #000; display: flex;">
                    <div style="width: 25%; padding: 4px; border-right: 1px solid #000;" class="b">Customer Reference :</div>
                    <div style="width: 75%; padding: 4px;">${sanitizeHTML(passData.customer_reference) || '-'}</div>
                </div>
                <div style="border-top: 1px solid #000; display: flex;">
                    <div style="width: 25%; padding: 4px; border-right: 1px solid #000;" class="b">No of Boxes :</div>
                    <div style="width: 75%; padding: 4px;">${sanitizeHTML(passData.no_of_boxes) ?? '0'}</div>
                </div>
                <div style="border-top: 1px solid #000; display: flex;">
                    <div style="width: 25%; padding: 4px; border-right: 1px solid #000;" class="b">Net Weight (KG) :</div>
                    <div style="width: 75%; padding: 4px;">${sanitizeHTML(passData.net_weight) || '-'}</div>
                </div>
                <div style="border-top: 1px solid #000; display: flex;">
                    <div style="width: 25%; padding: 4px; border-right: 1px solid #000;" class="b">Gross Weight (KG) :</div>
                    <div style="width: 75%; padding: 4px;">${sanitizeHTML(passData.gross_weight) || '-'}</div>
                </div>
                <div style="border-top: 1px solid #000; display: flex;">
                    <div style="width: 25%; padding: 4px; border-right: 1px solid #000;" class="b">Vehicle Number :</div>
                    <div style="width: 75%; padding: 4px;">${sanitizeHTML(passData.vehicle_number) || '-'}</div>
                </div>

                <!-- Items Table -->
                <table class="items-table" style="border-top: 1px solid #000;">
                    <thead>
                        <tr>
                            <th style="width: 40px; border-left: none;">SL. NO.</th>
                            <th style="width: 150px;">PART NO.</th>
                            <th>DESCRIPTION</th>
                            <th style="width: 80px;">QTY</th>
                            <th style="width: 150px; border-right: none;">REMARKS</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${passData.items.map((item, i) => `
                            <tr>
                                <td style="border-left: none;">${i + 1}</td>
                                <td class="b" style="color: #475569;">${sanitizeHTML(item.part_no) || 'NA'}</td>
                                <td class="desc">${sanitizeHTML(item.description)}</td>
                                <td class="b" style="font-size: 11px;">${item.qty}</td>
                                <td style="border-right: none; font-size: 9px; color: #64748b;">${sanitizeHTML(item.remarks) || '-'}</td>
                            </tr>
                        `).join('')}
                        <!-- Spacer row if few items -->
                        ${passData.items.length < 5 ? `
                            <tr style="height: ${150 - (passData.items.length * 35)}px;">
                                <td style="border-left: none;"></td><td></td><td></td><td></td><td style="border-right: none;"></td>
                            </tr>
                        ` : ''}
                    </tbody>
                    <tfoot>
                        <tr style="background: #f1f5f9; font-weight: 800; font-size: 11px;">
                            <td colspan="3" class="right" style="border-left: none; padding-right: 20px;">TOTAL QUANTITY</td>
                            <td class="center" style="background: #fff; border-top: 2px solid #000;">${totalQty}</td>
                            <td style="border-right: none; background: #f8fafc;"></td>
                        </tr>
                    </tfoot>
                </table>


                <div class="terms">
                    <div class="center b" style="text-decoration: underline; margin-bottom: 10px;">TO WHOM SO EVER IT MAY CONCERN</div>
                    <div>This is to certify that the package(s) as per the detailed list above are being shipped to the address mentioned above</div>
                    <div style="margin-top: 10px;">It is Not for Sale. The Value of the unit/s is mentioned for Insurance Purpose Only</div>
                    
                    <div style="display: flex; margin-top: 15px;">
                        <div style="flex: 1;"><span class="b">Remark:</span> ${passData.pass_type === 'RGP' ? 'RGP(Returnable basis)' : 'NRGP(Non-Returnable basis)'}</div>
                        <div style="flex: 1;"><span class="b">E-Way Bill NO :</span> -</div>
                    </div>
                    <div style="display: flex; margin-top: 8px;">
                        <div style="flex: 1;"><span class="b">Date :</span> ${new Date(passData.created_at || Date.now()).toLocaleDateString('en-GB')}</div>
                        <div style="flex: 1;"><span class="b">Vehicle# :</span> ${sanitizeHTML(passData.vehicle_number) || '-'}</div>
                    </div>

                    <!-- Side-by-Side: Requested By and Sent To -->
                    <div style="display: flex; justify-content: space-between; margin-top: 15px; border-top: 1.5px solid #000; padding-top: 8px;">
                        <!-- Requested By Section -->
                        <div style="width: 48%;">
                            <div class="b" style="text-transform: uppercase; font-size: 11px;">REQUESTED BY: ${sanitizeHTML(passData.created_by_name)}</div>
                            ${passData.created_user_mobile ? `<div style="font-size: 10px; color: #000; margin-top: 2px;"><span class="b">Contact:</span> ${passData.created_user_mobile}</div>` : ''}
                            ${requesterSigBase64 ? `<img src="data:image/png;base64,${requesterSigBase64}" style="width: 55px; height: auto; margin-top: 4px; mix-blend-mode: multiply;" />` : ''}
                        </div>

                        <!-- Sent To Section (Only if name exists) -->
                        ${passData.receiver_name ? `
                        <div style="width: 48%; text-align: right;">
                            <div class="b" style="text-transform: uppercase; font-size: 11px;">SENT TO: ${sanitizeHTML(passData.receiver_name)}</div>
                            ${passData.receiver_mobile ? `<div style="font-size: 10px; color: #000; margin-top: 2px;"><span class="b">Contact:</span> ${passData.receiver_mobile}</div>` : ''}
                            ${(passData.status === 'COMPLETED' && receiverSigBase64) ? `<img src="data:image/png;base64,${receiverSigBase64}" style="width: 55px; height: auto; margin-top: 4px; mix-blend-mode: multiply;" />` : ''}
                        </div>
                        ` : ''}
                    </div>
                </div>

                <div class="signature-area" style="display: flex; justify-content: space-between; margin-top: 40px; text-align: center; padding-top: 0;">
                    <!-- Origin Security Column -->
                    <div style="width: 30%;">
                        <div class="b" style="text-transform: uppercase; font-size: 10px; margin-bottom: 5px;">Origin Security</div>
                        ${passData.security_origin_approved_at ? `
                            <div style="font-size: 8px; color: #475569; margin-bottom: 5px;">
                                Approved On: ${formatIST(passData.security_origin_approved_at)}
                            </div>
                            ${originSigBase64 ? `<img src="data:image/png;base64,${originSigBase64}" style="height: 35px; mix-blend-mode: multiply;" />` : ''}
                        ` : '<div style="height: 40px;"></div>'}
                    </div>

                    <!-- Destination Security Column -->
                    <div style="width: 30%;">
                        <div class="b" style="text-transform: uppercase; font-size: 10px; margin-bottom: 5px;">Destination Security</div>
                        ${passData.security_destination_approved_at ? `
                            <div style="font-size: 8px; color: #475569; margin-bottom: 5px;">
                                Approved On: ${formatIST(passData.security_destination_approved_at)}
                            </div>
                            ${destSigBase64 ? `<img src="data:image/png;base64,${destSigBase64}" style="height: 35px; mix-blend-mode: multiply;" />` : ''}
                        ` : '<div style="height: 40px;"></div>'}
                    </div>

                    <!-- Manager Column -->
                    <div style="width: 30%;">
                        <div class="b" style="text-transform: uppercase; font-size: 10px; margin-bottom: 5px;">
                            ${passData.approved_by_role === 'admin' ? 'Admin (Approved On Behalf)' : 'Manager'}
                        </div>
                        ${passData.approved_by_manager_at ? `
                            <div style="font-size: 8px; color: #475569; margin-bottom: 5px;">
                                Approved On: ${formatIST(passData.approved_by_manager_at)}
                            </div>
                            ${passData.approved_by_role === 'admin' 
                                ? (adminSigBase64 ? `<img src="data:image/png;base64,${adminSigBase64}" style="height: 55px; mix-blend-mode: multiply;" />` : '')
                                : (managerSigBase64 ? `<img src="data:image/png;base64,${managerSigBase64}" style="height: 55px; mix-blend-mode: multiply;" />` : '')
                            }
                        ` : '<div style="height: 60px;"></div>'}
                        <div style="font-size: 8px; font-weight: 600; color: #64748b; margin-top: 5px;">AUTHORIZED SIGNATORY</div>
                    </div>
                </div>
            </div>
        </body>
        </html>
        `;

        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '30px', bottom: '30px', left: '30px', right: '30px' }
        });

        return pdfBuffer;
    } finally {
        await page.close(); // Only close the tab, not the whole browser
    }
};

module.exports = {
    generateChallanPDF,
    sanitizeHTML
};
