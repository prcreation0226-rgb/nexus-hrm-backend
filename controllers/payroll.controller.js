const db = require('../config/db');
const { generatePayslipPDF } = require('../utils/pdfGenerator');
const fs = require('fs');
const path = require('path');
const { decrypt } = require('../utils/cryptoUtils');
const whatsappService = require('../services/whatsapp.service');

// --- CPF Rate Helper ---
// Ordinary Wage Ceiling: S$8,000/month
const CPF_OW_CEILING = 8000;

function getCpfRates(dateOfBirth) {
    if (!dateOfBirth) return null; // DOB missing — cannot compute CPF
    const today = new Date();
    const dob = new Date(dateOfBirth);
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;

    if (age <= 55) return { employee: 0.20, employer: 0.17, total: 0.37, age };
    if (age <= 60) return { employee: 0.18, employer: 0.16, total: 0.34, age };
    if (age <= 65) return { employee: 0.125, employer: 0.125, total: 0.25, age };
    if (age <= 70) return { employee: 0.075, employer: 0.09, total: 0.165, age };
    return { employee: 0.05, employer: 0.075, total: 0.125, age };
}

exports.getPayroll = async (req, res) => {
    try {
        const companyId = req.user.company_id;
        
        let query = `
            SELECT p.*, e.name, e.custom_id as custom_employee_id, e.photo, e.salary_rate
            FROM payroll p
            JOIN employees e ON p.employee_id = e.id
        `;
        let params = [];
        
        if (req.user.role !== 'MasterAdmin') {
            query += ' WHERE e.company_id = ? ';
            params.push(companyId);
        }

        if (req.user.role === 'employee') {
            query += ' AND e.id = ? ';
            params.push(req.user.employee_id);
        }

        query += ' ORDER BY p.id DESC';

        const [rows] = await db.execute(query, params);
        
        // Map db fields to UI expected fields
        const formatted = rows.map(r => ({
            ...r,
            employee_id: r.custom_employee_id || r.employee_id
        }));
        res.json(formatted);
    } catch (err) {
        console.error('Error fetching payroll:', err);
        res.status(500).json({ error: err.message });
    }
};

exports.generatePayroll = async (req, res) => {
    try {
        const { startDate, endDate } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ message: 'Start date and end date are required' });
        }

        const companyId = req.user.company_id;

        // Fetch settings for this specific company
        let [settingsRows] = await db.execute('SELECT * FROM settings WHERE company_id = ?', [companyId]);
        let settings = settingsRows[0];
        
        if (!settings) {
            // Fallback to default if no settings configured yet
            [settingsRows] = await db.execute('SELECT * FROM settings WHERE id = 1');
            settings = settingsRows[0] || {};
        }

        const lateDeductionAmount = parseFloat(settings.late_deduction_amount || 0);
        const isLateDeductionActive = settings.late_deduction === 1;

        // Fetch employees specifically for this company
        let empQuery = 'SELECT * FROM employees WHERE status = "active"';
        let empParams = [];
        if (req.user.role !== 'MasterAdmin') {
            empQuery += ' AND company_id = ?';
            empParams.push(companyId);
        }
        const [employees] = await db.execute(empQuery, empParams);

        let generated = 0;
        let skipped = 0;

        for (let emp of employees) {
            // Get attendance stats
            const [attRows] = await db.execute(`
                SELECT 
                    SUM(total_hours) as th,
                    COUNT(CASE WHEN status = 'late' THEN 1 END) as late_count
                FROM attendance 
                WHERE employee_id = ? AND date BETWEEN ? AND ?
            `, [emp.id, startDate, endDate]);

            const stats = attRows[0];
            const totalHours = parseFloat(stats.th || 0);
            let lateCount = stats.late_count || 0;

            if (lateCount > 0) {
                // Check if any of these 'late' days have an approved half_day leave
                const [halfDayLeaves] = await db.execute(`
                    SELECT COUNT(DISTINCT a.date) as protected_lates
                    FROM attendance a
                    JOIN leaves l ON l.employee_id = a.employee_id 
                                 AND a.date >= l.start_date 
                                 AND a.date <= l.end_date
                    WHERE a.employee_id = ? 
                      AND a.date BETWEEN ? AND ?
                      AND a.status = 'late'
                      AND l.status = 'Approved'
                      AND l.half_day = 1
                `, [emp.id, startDate, endDate]);
                
                const protectedLates = halfDayLeaves[0].protected_lates || 0;
                lateCount = Math.max(0, lateCount - protectedLates);
            }

            const salaryRate = parseFloat(emp.salary_rate || 0);
            
            // Calculate base salary
            let baseSalary = 0;
            if (emp.salary_type === 'hourly') {
                baseSalary = totalHours * salaryRate;
            } else if (emp.salary_type === 'monthly') {
                const [dayRows] = await db.execute(`
                    SELECT COUNT(*) as days FROM attendance 
                    WHERE employee_id = ? AND date BETWEEN ? AND ? AND status IN ('present', 'late')
                `, [emp.id, startDate, endDate]);
                baseSalary = (dayRows[0].days || 0) * (salaryRate / 30);
            } else {
                // Daily
                const [dayRows] = await db.execute(`
                    SELECT COUNT(*) as days FROM attendance 
                    WHERE employee_id = ? AND date BETWEEN ? AND ? AND status IN ('present', 'late')
                `, [emp.id, startDate, endDate]);
                baseSalary = (dayRows[0].days || 0) * salaryRate;
            }

            let deductions = 0;
            if (isLateDeductionActive && lateDeductionAmount > 0) {
                deductions = lateCount * lateDeductionAmount;
            }

            // CPF Calculation (replaces UIF 1%)
            console.log(`Calculating for emp ${emp.id}: baseSalary=${baseSalary}, cpf_applicable=${emp.cpf_applicable}`);
            const isCpfApplicable = !(emp.cpf_applicable === 0 || emp.cpf_applicable === '0' || emp.cpf_applicable === false);
            let cpfEmployee = 0, cpfEmployer = 0, cpfTotal = 0;
            if (isCpfApplicable) {
                const cpfRates = getCpfRates(emp.date_of_birth);
                if (cpfRates && baseSalary > 750) {
                    const cpfBase = Math.min(baseSalary, CPF_OW_CEILING);
                    cpfEmployee = Math.round(cpfBase * cpfRates.employee * 100) / 100;
                    cpfEmployer = Math.round(cpfBase * cpfRates.employer * 100) / 100;
                    cpfTotal = Math.round(cpfBase * cpfRates.total * 100) / 100;
                }
            }
            // Employee CPF is a deduction from salary (like old UIF)
            deductions += cpfEmployee;

            let advanceDeduction = 0;
            const advanceBalance = parseFloat(emp.advance_balance || 0);
            const advanceInstallment = emp.advance_installment !== null ? parseFloat(emp.advance_installment) : null;
            
            let provisionalNet = baseSalary - deductions;

            if (advanceBalance > 0 && provisionalNet > 0) {
                // Deduct as much as possible, up to the remaining advance balance
                let maxPossible = Math.min(advanceBalance, provisionalNet);
                if (advanceInstallment !== null && advanceInstallment > 0) {
                    advanceDeduction = Math.min(advanceInstallment, maxPossible);
                } else {
                    advanceDeduction = maxPossible;
                }
            }

            deductions += advanceDeduction;
            const netSalary = Math.max(0, baseSalary - deductions);

            // Check if a PAID record already exists for this cycle to prevent duplicate entry error
            const [paidCheck] = await db.execute(
                'SELECT id FROM payroll WHERE employee_id = ? AND cycle_start = ? AND cycle_end = ? AND status = "paid" AND company_id = ?',
                [emp.id, startDate, endDate, companyId]
            );

            if (paidCheck.length > 0) {
                // Skip this employee as they are already paid for this cycle
                skipped++;
                continue;
            }

            // Delete any existing PENDING payroll for this employee (prevents duplicates)
            await db.execute(
                'DELETE FROM payroll WHERE employee_id = ? AND cycle_start = ? AND cycle_end = ? AND status = "pending" AND company_id = ?',
                [emp.id, startDate, endDate, companyId]
            );

            const [insertResult] = await db.execute(`
                INSERT INTO payroll (
                    company_id, employee_id, cycle_start, cycle_end, 
                    total_hours, base_salary, deductions, uif_amount, cpf_employee, cpf_employer, cpf_total, advance_deduction, net_salary, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
            `, [
                companyId, emp.id, startDate, endDate, 
                totalHours, baseSalary, deductions, cpfEmployee, cpfEmployee, cpfEmployer, cpfTotal, advanceDeduction, netSalary
            ]);
            
            const payrollId = insertResult.insertId;

            // Generate PDF Resiliently
            try {
                const payrollData = {
                    id: payrollId,
                    cycle_start: startDate,
                    cycle_end: endDate,
                    base_salary: baseSalary,
                    deductions: deductions,
                    net_salary: netSalary
                };
                
                const pdfPath = await generatePayslipPDF(payrollData, emp, settings);
                
                await db.execute('UPDATE payroll SET pdf_path = ? WHERE id = ?', [pdfPath, payrollId]);
            } catch (pdfError) {
                console.error(`Failed to generate PDF for employee ${emp.id}:`, pdfError);
                // We don't throw here, payroll computation is still successful
            }

            generated++;
        }

        res.json({ 
            success: true, 
            message: `Payroll cycle generated successfully. ${generated} processed, ${skipped} already existed.`,
            generated,
            skipped
        });
    } catch (err) {
        console.error('Error generating payroll:', err);
        res.status(500).json({ error: err.message });
    }
};

exports.updateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        if (status === 'paid') {
            const [payrollRows] = await db.execute('SELECT employee_id, advance_deduction, status FROM payroll WHERE id = ?', [id]);
            if (payrollRows.length > 0 && payrollRows[0].status !== 'paid') {
                const advanceDed = parseFloat(payrollRows[0].advance_deduction || 0);
                if (advanceDed > 0) {
                    await db.execute('UPDATE employees SET advance_balance = GREATEST(0, advance_balance - ?) WHERE id = ?', [advanceDed, payrollRows[0].employee_id]);
                }
            }
        }
        
        await db.execute('UPDATE payroll SET status = ? WHERE id = ?', [status, id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating payroll status:', err);
        res.status(500).json({ error: err.message });
    }
};

exports.deletePayroll = async (req, res) => {
    try {
        const { id } = req.params;
        const [existing] = await db.execute('SELECT company_id FROM payroll WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ error: 'Payroll record not found' });
        
        if (req.user.role !== 'MasterAdmin' && existing[0].company_id !== req.user.company_id) {
            return res.status(403).json({ error: 'Unauthorized to delete this record' });
        }

        await db.execute('DELETE FROM payroll WHERE id = ?', [id]);
        res.json({ success: true, message: 'Payroll record deleted' });
    } catch (err) {
        console.error('Error deleting payroll record:', err);
        res.status(500).json({ error: err.message });
    }
};

exports.generateSinglePdf = async (req, res) => {
    try {
        const { id } = req.params;
        const [payrollRows] = await db.execute('SELECT * FROM payroll WHERE id = ?', [id]);
        if (payrollRows.length === 0) return res.status(404).json({ error: 'Payroll record not found' });
        
        const payrollData = payrollRows[0];

        if (req.user.role !== 'MasterAdmin' && req.user.company_id !== payrollData.company_id) {
            return res.status(403).json({ error: 'Unauthorized to access this record' });
        }
        if (req.user.role === 'employee' && req.user.employee_id !== payrollData.employee_id) {
            return res.status(403).json({ error: 'Unauthorized to access this record' });
        }

        const [empRows] = await db.execute('SELECT * FROM employees WHERE id = ?', [payrollData.employee_id]);
        if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
        
        const emp = empRows[0];
        let [settingsRows] = await db.execute('SELECT * FROM settings WHERE company_id = ?', [payrollData.company_id]);
        let settings = settingsRows[0];
        if (!settings) {
            [settingsRows] = await db.execute('SELECT * FROM settings WHERE id = 1');
            settings = settingsRows[0] || {};
        }

        const pdfPath = await generatePayslipPDF(payrollData, emp, settings);
        await db.execute('UPDATE payroll SET pdf_path = ? WHERE id = ?', [pdfPath, id]);

        res.json({ success: true, pdf_path: pdfPath });
    } catch (err) {
        console.error('Error generating single PDF:', err);
        res.status(500).json({ error: err.message });
    }
};

exports.getLiveAccrual = async (req, res) => {
    try {
        const employeeId = req.user.employee_id;
        if (!employeeId) return res.status(400).json({ error: 'Employee ID missing' });

        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const startDate = `${year}-${month}-01`;
        const endDate = `${year}-${month}-${String(now.getDate()).padStart(2, '0')}`;

        // Get Employee Details (include date_of_birth and cpf_applicable for CPF)
        const [empRows] = await db.execute('SELECT salary_rate, salary_type, advance_balance, date_of_birth, cpf_applicable FROM employees WHERE id = ?', [employeeId]);
        if (empRows.length === 0) return res.json({ liveEarnings: 0, startDate, endDate, totalHours: 0 });
        const emp = empRows[0];
        const salaryRate = parseFloat(emp.salary_rate || 0);
        const isCpfApplicable = !(emp.cpf_applicable === 0 || emp.cpf_applicable === '0' || emp.cpf_applicable === false);

        // Get Attendance Stats
        const [attRows] = await db.execute(`
            SELECT SUM(total_hours) as th
            FROM attendance 
            WHERE employee_id = ? AND date BETWEEN ? AND ?
        `, [employeeId, startDate, endDate]);

        const totalHours = parseFloat(attRows[0].th || 0);
        let liveEarnings = 0;

        if (emp.salary_type === 'hourly') {
            liveEarnings = totalHours * salaryRate;
        } else {
            const [dayRows] = await db.execute(`
                SELECT COUNT(*) as days FROM attendance 
                WHERE employee_id = ? AND date BETWEEN ? AND ? AND status IN ('present', 'late')
            `, [employeeId, startDate, endDate]);
            liveEarnings = (dayRows[0].days || 0) * salaryRate;
        }

        // CPF calculation (replaces flat UIF 1%)
        let cpfRates = null;
        let cpfEmployee = 0, cpfEmployer = 0, cpfTotal = 0;
        if (isCpfApplicable) {
            cpfRates = getCpfRates(emp.date_of_birth);
            if (cpfRates && liveEarnings > 750) {
                const cpfBase = Math.min(liveEarnings, CPF_OW_CEILING);
                cpfEmployee = Math.round(cpfBase * cpfRates.employee * 100) / 100;
                cpfEmployer = Math.round(cpfBase * cpfRates.employer * 100) / 100;
                cpfTotal = Math.round(cpfBase * cpfRates.total * 100) / 100;
            }
        }
        const advanceDeduction = parseFloat(emp.advance_balance || 0);
        const netSalary = Math.max(0, liveEarnings - cpfEmployee - advanceDeduction);

        res.json({
            startDate,
            endDate,
            grossEarnings: liveEarnings,
            totalHours,
            salaryRate,
            salaryType: emp.salary_type,
            cpfApplicable: isCpfApplicable,
            cpfEmployee,
            cpfEmployer,
            cpfTotal,
            cpfAge: cpfRates ? cpfRates.age : null,
            cpfMissing: isCpfApplicable ? !cpfRates : false,
            advanceDeduction,
            netSalary
        });
    } catch (err) {
        console.error('Error fetching live accrual:', err);
        res.status(500).json({ error: err.message });
    }
};

exports.sendWhatsAppPayslip = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user.company_id;

        // Fetch payroll record
        const [payrollRows] = await db.execute('SELECT * FROM payroll WHERE id = ?', [id]);
        if (payrollRows.length === 0) return res.status(404).json({ error: 'Payroll record not found' });
        const payroll = payrollRows[0];

        if (req.user.role !== 'MasterAdmin' && payroll.company_id !== companyId) {
            return res.status(403).json({ error: 'Unauthorized to access this record' });
        }

        // Fetch employee
        const [empRows] = await db.execute('SELECT * FROM employees WHERE id = ?', [payroll.employee_id]);
        if (empRows.length === 0) return res.status(404).json({ error: 'Employee not found' });
        const employee = empRows[0];

        if (!employee.phone || employee.phone.trim() === '') {
            await db.execute(
                'INSERT INTO whatsapp_logs (company_id, payroll_id, employee_id, employee_name, phone, pdf_path, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [payroll.company_id, payroll.id, employee.id, employee.name, null, payroll.pdf_path, 'failed', 'Employee WhatsApp number is not available.']
            );
            return res.status(400).json({ error: 'Employee WhatsApp number is not available.' });
        }

        // Fetch company WhatsApp settings
        const [settingsRows] = await db.execute('SELECT * FROM company_whatsapp_settings WHERE company_id = ?', [payroll.company_id]);
        if (settingsRows.length === 0 || !settingsRows[0].is_enabled) {
            return res.status(400).json({ error: 'WhatsApp integration is not configured or disabled.' });
        }
        const waSettings = settingsRows[0];
        const plainToken = decrypt(waSettings.access_token);

        // Fetch company settings for PDF generation
        let [compSettingsRows] = await db.execute('SELECT * FROM settings WHERE company_id = ?', [payroll.company_id]);
        let compSettings = compSettingsRows[0] || {};

        // Generate PDF if not exists
        let pdfPath = payroll.pdf_path;
        if (!pdfPath || !fs.existsSync(path.join(__dirname, '..', pdfPath))) {
            pdfPath = await generatePayslipPDF(payroll, employee, compSettings);
            await db.execute('UPDATE payroll SET pdf_path = ? WHERE id = ?', [pdfPath, id]);
        }

        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];
        const payrollDate = new Date(payroll.cycle_start);
        const monthYear = `${monthNames[payrollDate.getMonth()]} ${payrollDate.getFullYear()}`;

        const serverBase = `${req.protocol}://${req.get('host')}`;
        const fullPdfUrl = `${serverBase}${pdfPath.startsWith('/') ? '' : '/'}${pdfPath}`;

        const sendRes = await whatsappService.sendWhatsAppDocument({
            phoneNumberId: waSettings.phone_number_id,
            accessToken: plainToken,
            toPhone: employee.phone,
            defaultCountryCode: waSettings.default_country_code || '+65',
            documentUrl: fullPdfUrl,
            fileName: `Payslip_${employee.name.replace(/\s+/g, '_')}_${monthYear.replace(/\s+/g, '_')}.pdf`,
            templateName: waSettings.template_name,
            templateParams: {
                employeeName: employee.name,
                monthYear: monthYear
            }
        });

        // Log success
        await db.execute(
            'INSERT INTO whatsapp_logs (company_id, payroll_id, employee_id, employee_name, phone, pdf_path, message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [payroll.company_id, payroll.id, employee.id, employee.name, employee.phone, pdfPath, sendRes.messageId, 'sent']
        );

        res.json({ success: true, message: `Payslip sent via WhatsApp to ${employee.name} (${employee.phone})` });
    } catch (err) {
        console.error('Error sending WhatsApp payslip:', err);
        // Log failure
        try {
            if (req.params.id) {
                const [p] = await db.execute('SELECT p.*, e.name, e.phone FROM payroll p JOIN employees e ON p.employee_id = e.id WHERE p.id = ?', [req.params.id]);
                if (p.length > 0) {
                    await db.execute(
                        'INSERT INTO whatsapp_logs (company_id, payroll_id, employee_id, employee_name, phone, pdf_path, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [p[0].company_id, p[0].id, p[0].employee_id, p[0].name, p[0].phone, p[0].pdf_path, 'failed', err.message]
                    );
                }
            }
        } catch (logErr) {}

        res.status(500).json({ error: err.message || 'Unable to send WhatsApp payslip. Please try again.' });
    }
};

exports.sendBulkWhatsApp = async (req, res) => {
    try {
        const { payrollIds } = req.body;
        const companyId = req.user.company_id;

        if (!Array.isArray(payrollIds) || payrollIds.length === 0) {
            return res.status(400).json({ error: 'No payroll records provided.' });
        }

        // Fetch company WhatsApp settings
        const [settingsRows] = await db.execute('SELECT * FROM company_whatsapp_settings WHERE company_id = ?', [companyId]);
        if (settingsRows.length === 0 || !settingsRows[0].is_enabled) {
            return res.status(400).json({ error: 'WhatsApp integration is not configured or disabled.' });
        }
        const waSettings = settingsRows[0];
        const plainToken = decrypt(waSettings.access_token);

        let [compSettingsRows] = await db.execute('SELECT * FROM settings WHERE company_id = ?', [companyId]);
        let compSettings = compSettingsRows[0] || {};

        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];

        const serverBase = `${req.protocol}://${req.get('host')}`;

        // Fetch all target payrolls with employees
        const placeholders = payrollIds.map(() => '?').join(',');
        const [payrolls] = await db.execute(`
            SELECT p.*, e.name as employee_name, e.phone as employee_phone, e.email as employee_email
            FROM payroll p
            JOIN employees e ON p.employee_id = e.id
            WHERE p.id IN (${placeholders}) ${req.user.role !== 'MasterAdmin' ? 'AND p.company_id = ?' : ''}
        `, req.user.role !== 'MasterAdmin' ? [...payrollIds, companyId] : payrollIds);

        let sent = 0;
        let failed = 0;
        const errors = [];

        // Safe batch sending with rate-limit protection (chunks of 5, 300ms delay)
        await whatsappService.sendBatchWithRateLimit(payrolls, async (item) => {
            try {
                if (!item.employee_phone || item.employee_phone.trim() === '') {
                    throw new Error('Employee WhatsApp number is not available.');
                }

                // Generate PDF if needed
                let pdfPath = item.pdf_path;
                if (!pdfPath || !fs.existsSync(path.join(__dirname, '..', pdfPath))) {
                    const [empFull] = await db.execute('SELECT * FROM employees WHERE id = ?', [item.employee_id]);
                    pdfPath = await generatePayslipPDF(item, empFull[0], compSettings);
                    await db.execute('UPDATE payroll SET pdf_path = ? WHERE id = ?', [pdfPath, item.id]);
                }

                const payrollDate = new Date(item.cycle_start);
                const monthYear = `${monthNames[payrollDate.getMonth()]} ${payrollDate.getFullYear()}`;
                const fullPdfUrl = `${serverBase}${pdfPath.startsWith('/') ? '' : '/'}${pdfPath}`;

                const sendRes = await whatsappService.sendWhatsAppDocument({
                    phoneNumberId: waSettings.phone_number_id,
                    accessToken: plainToken,
                    toPhone: item.employee_phone,
                    defaultCountryCode: waSettings.default_country_code || '+65',
                    documentUrl: fullPdfUrl,
                    fileName: `Payslip_${item.employee_name.replace(/\s+/g, '_')}_${monthYear.replace(/\s+/g, '_')}.pdf`,
                    templateName: waSettings.template_name,
                    templateParams: {
                        employeeName: item.employee_name,
                        monthYear: monthYear
                    }
                });

                await db.execute(
                    'INSERT INTO whatsapp_logs (company_id, payroll_id, employee_id, employee_name, phone, pdf_path, message_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [item.company_id, item.id, item.employee_id, item.employee_name, item.employee_phone, pdfPath, sendRes.messageId, 'sent']
                );
                sent++;
            } catch (err) {
                failed++;
                errors.push({ employee: item.employee_name, reason: err.message });
                await db.execute(
                    'INSERT INTO whatsapp_logs (company_id, payroll_id, employee_id, employee_name, phone, pdf_path, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [item.company_id, item.id, item.employee_id, item.employee_name, item.employee_phone || null, item.pdf_path || null, 'failed', err.message]
                );
            }
        }, { concurrency: 5, delayMs: 300 });

        res.json({
            success: true,
            sent,
            failed,
            total: payrolls.length,
            errors,
            message: `Processed ${payrolls.length} payslips: ${sent} sent successfully, ${failed} failed.`
        });
    } catch (err) {
        console.error('Error in bulk WhatsApp sending:', err);
        res.status(500).json({ error: err.message });
    }
};
