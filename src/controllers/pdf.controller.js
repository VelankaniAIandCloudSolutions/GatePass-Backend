const pool = require('../config/db.config');
const { sendResponse } = require('../middleware/auth.middleware');
const puppeteer = require('puppeteer');

// ─── Singleton Browser ────────────────────────────────────────────────────────
// Reuse one Chromium instance across all PDF requests instead of launching
// a new browser on every call (saves 1.5–3s per request).
let browserInstance = null;

const getBrowser = async () => {
    if (browserInstance && browserInstance.isConnected()) {
        return browserInstance;
    }
    browserInstance = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ]
    });
    // Clean up if the browser crashes or closes unexpectedly
    browserInstance.on('disconnected', () => {
        browserInstance = null;
    });
    return browserInstance;
};

const generatePassPDF = async (req, res) => {
    const { id } = req.params;

    try {
        // 1. Fetch Pass Header
        const [passes] = await pool.query(`
            SELECT p.*, u.name as creator_name 
            FROM material_gate_passes p
            JOIN users u ON p.created_by = u.id
            WHERE p.id = ?
        `, [id]);

        if (passes.length === 0) return sendResponse(res, 404, false, 'Pass not found');
        const pass = passes[0];

        // 2. Fetch Items
        const [items] = await pool.query('SELECT * FROM material_items WHERE material_pass_id = ?', [id]);

        // 3. Generate HTML Content
        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; padding: 40px; color: #333; }
                    .header { text-align: center; border-bottom: 2px solid #444; padding-bottom: 20px; margin-bottom: 30px; }
                    .dc-number { font-size: 24px; font-weight: bold; color: #4f46e5; }
                    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
                    .info-box { border: 1px solid #ddd; padding: 15px; border-radius: 8px; }
                    .info-label { font-size: 10px; text-transform: uppercase; color: #666; font-weight: bold; }
                    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                    th { background-color: #f8fafc; border: 1px solid #ddd; padding: 12px; text-align: left; font-size: 12px; }
                    td { border: 1px solid #ddd; padding: 10px; font-size: 12px; }
                    .footer { margin-top: 50px; display: grid; grid-template-columns: 1fr 1fr; text-align: center; }
                    .signature-line { border-top: 1px solid #333; width: 150px; margin: 40px auto 10px; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>MATERIAL GATE PASS</h1>
                    <div class="dc-number">${pass.dc_number}</div>
                </div>

                <div class="info-grid">
                    <div class="info-box">
                        <div class="info-label">Created By</div>
                        <div>${pass.creator_name}</div>
                        <div class="info-label" style="margin-top: 10px;">Created At</div>
                        <div>${new Date(pass.created_at).toLocaleString()}</div>
                    </div>
                    <div class="info-box">
                        <div class="info-label">Status</div>
                        <div style="text-transform: uppercase; font-weight: bold;">${pass.status.replace(/_/g, ' ')}</div>
                    </div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Part No</th>
                            <th>Description</th>
                            <th>Qty</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map(item => `
                            <tr>
                                <td>${item.part_no}</td>
                                <td>${item.description}</td>
                                <td>${item.qty}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="footer">
                    <div>
                        <div class="signature-line"></div>
                        <div class="info-label">Manager Signature</div>
                    </div>
                    <div>
                        <div class="signature-line"></div>
                        <div class="info-label">Security (Dispatch)</div>
                    </div>
                </div>
            </body>
            </html>
        `;

        // 4. Generate PDF using shared browser instance
        const browser = await getBrowser();
        const page = await browser.newPage();
        try {
            await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: { top: '0', right: '0', bottom: '0', left: '0' }
            });
            // 5. Send PDF
            res.contentType('application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename=${pass.dc_number}.pdf`);
            res.send(pdfBuffer);
        } finally {
            await page.close(); // Only close the tab, not the whole browser
        }

    } catch (err) {
        console.error('PDF Gen Error:', err);
        return sendResponse(res, 500, false, 'Failed to generate PDF');
    }
};

module.exports = { generatePassPDF };
