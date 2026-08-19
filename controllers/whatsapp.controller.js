const db = require('../config/db');
const { encrypt, decrypt } = require('../utils/cryptoUtils');
const whatsappService = require('../services/whatsapp.service');
const { generatePayslipPDF } = require('../utils/pdfGenerator');

/**
 * Get WhatsApp settings for the authenticated company
 */
exports.getSettings = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const [rows] = await db.execute(
            'SELECT * FROM company_whatsapp_settings WHERE company_id = ?',
            [companyId]
        );

        if (rows.length === 0) {
            return res.json({
                whatsapp_business_account_id: '',
                phone_number_id: '',
                access_token: '',
                template_name: 'payslip_delivery',
                default_country_code: '+65',
                is_enabled: 1
            });
        }

        const settings = rows[0];
        // Mask access token for security
        settings.access_token = settings.access_token ? '********' : '';
        settings.default_country_code = settings.default_country_code || '+65';
        res.json(settings);
    } catch (err) {
        console.error('Error getting WhatsApp settings:', err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * Save / Update WhatsApp settings for the company
 */
exports.saveSettings = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const {
            whatsapp_business_account_id,
            phone_number_id,
            access_token,
            template_name = 'payslip_delivery',
            default_country_code = '+65',
            is_enabled = 1
        } = req.body;

        if (!phone_number_id) {
            return res.status(400).json({ error: 'Phone Number ID is required.' });
        }

        const [existing] = await db.execute(
            'SELECT * FROM company_whatsapp_settings WHERE company_id = ?',
            [companyId]
        );

        let encryptedToken;
        if (access_token && access_token !== '********') {
            encryptedToken = encrypt(access_token);
        } else if (existing.length > 0) {
            encryptedToken = existing[0].access_token;
        } else {
            return res.status(400).json({ error: 'Access Token is required for new setup.' });
        }

        const finalEnabled = is_enabled ? 1 : 0;
        const finalTemplate = (template_name || 'payslip_delivery').trim();
        const finalWabaId = (whatsapp_business_account_id || '').trim();
        const finalPhoneId = phone_number_id.trim();
        const finalCountryCode = (default_country_code || '+65').trim();

        if (existing.length > 0) {
            await db.execute(
                `UPDATE company_whatsapp_settings 
                 SET whatsapp_business_account_id = ?, phone_number_id = ?, access_token = ?, template_name = ?, default_country_code = ?, is_enabled = ?, updated_at = NOW()
                 WHERE company_id = ?`,
                [finalWabaId, finalPhoneId, encryptedToken, finalTemplate, finalCountryCode, finalEnabled, companyId]
            );
        } else {
            await db.execute(
                `INSERT INTO company_whatsapp_settings 
                 (company_id, whatsapp_business_account_id, phone_number_id, access_token, template_name, default_country_code, is_enabled)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [companyId, finalWabaId, finalPhoneId, encryptedToken, finalTemplate, finalCountryCode, finalEnabled]
            );
        }

        res.json({ success: true, message: 'WhatsApp settings saved successfully.' });
    } catch (err) {
        console.error('Error saving WhatsApp settings:', err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * Test WhatsApp Connection
 */
exports.testConnection = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const { testPhone } = req.body;

        const [rows] = await db.execute(
            'SELECT * FROM company_whatsapp_settings WHERE company_id = ?',
            [companyId]
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'Please save WhatsApp settings first before testing.' });
        }

        const settings = rows[0];
        if (!settings.is_enabled) {
            return res.status(400).json({ error: 'WhatsApp integration is currently disabled.' });
        }

        const plainToken = decrypt(settings.access_token);
        const result = await whatsappService.testWhatsAppConnection({
            phoneNumberId: settings.phone_number_id,
            accessToken: plainToken,
            testPhone: testPhone || null
        });

        res.json(result);
    } catch (err) {
        console.error('Test WhatsApp failed:', err);
        res.status(400).json({ error: err.message });
    }
};

/**
 * Get WhatsApp Delivery Logs for Company
 */
exports.getLogs = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const [rows] = await db.execute(`
            SELECT wl.*, p.cycle_start, p.cycle_end
            FROM whatsapp_logs wl
            LEFT JOIN payroll p ON wl.payroll_id = p.id
            WHERE wl.company_id = ?
            ORDER BY wl.id DESC
            LIMIT 150
        `, [companyId]);

        res.json(rows);
    } catch (err) {
        console.error('Error fetching WhatsApp logs:', err);
        res.status(500).json({ error: err.message });
    }
};

/**
 * Retry Failed WhatsApp Logs
 */
exports.retryLogs = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        const { logIds } = req.body;

        if (!Array.isArray(logIds) || logIds.length === 0) {
            return res.status(400).json({ error: 'No logs selected for retry.' });
        }

        // Fetch settings
        const [settingsRows] = await db.execute(
            'SELECT * FROM company_whatsapp_settings WHERE company_id = ?',
            [companyId]
        );
        if (settingsRows.length === 0 || !settingsRows[0].is_enabled) {
            return res.status(400).json({ error: 'WhatsApp integration is not configured or disabled.' });
        }

        const settings = settingsRows[0];
        const accessToken = decrypt(settings.access_token);

        let retried = 0;
        let failed = 0;

        for (const logId of logIds) {
            const [logs] = await db.execute(
                'SELECT * FROM whatsapp_logs WHERE id = ? AND company_id = ?',
                [logId, companyId]
            );
            if (logs.length === 0) continue;
            const log = logs[0];

            try {
                // Ensure PDF exists
                let pdfUrl = log.pdf_path;
                const serverBase = `${req.protocol}://${req.get('host')}`;
                const fullDocUrl = pdfUrl.startsWith('http') ? pdfUrl : `${serverBase}${pdfUrl.startsWith('/') ? '' : '/'}${pdfUrl}`;

                const result = await whatsappService.sendWhatsAppDocument({
                    phoneNumberId: settings.phone_number_id,
                    accessToken,
                    toPhone: log.phone,
                    documentUrl: fullDocUrl,
                    fileName: `Payslip_${log.employee_name.replace(/\s+/g, '_')}.pdf`,
                    templateName: settings.template_name,
                    templateParams: {
                        employeeName: log.employee_name,
                        monthYear: 'Recent Period'
                    }
                });

                await db.execute(
                    'UPDATE whatsapp_logs SET status = "sent", message_id = ?, error_message = NULL, created_at = NOW() WHERE id = ?',
                    [result.messageId, log.id]
                );
                retried++;
            } catch (retryErr) {
                await db.execute(
                    'UPDATE whatsapp_logs SET status = "failed", error_message = ?, created_at = NOW() WHERE id = ?',
                    [retryErr.message, log.id]
                );
                failed++;
            }
        }

        res.json({ success: true, retried, failed, message: `Retried ${retried} successfully, ${failed} failed.` });
    } catch (err) {
        console.error('Error retrying WhatsApp logs:', err);
        res.status(500).json({ error: err.message });
    }
};
