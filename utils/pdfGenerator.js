const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const payslipsDir = path.join(__dirname, '..', 'uploads', 'payslips');

// Ensure the directory exists
if (!fs.existsSync(payslipsDir)) {
    fs.mkdirSync(payslipsDir, { recursive: true });
}

async function generatePayslipPDF(payroll, employee, companySettings) {
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        const monthNames = ["January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"];
        const payrollDate = new Date(payroll.cycle_start);
        const payrollMonth = `${monthNames[payrollDate.getMonth()]} ${payrollDate.getFullYear()}`;

        // Fallback logo if missing
        const logoUrl = companySettings.logo ? companySettings.logo : '';
        const logoHtml = logoUrl ? `<img src="${logoUrl}" alt="Company Logo" style="max-height: 80px;" />` : '';

        // Safe numbers
        const baseSalary = Number(payroll.base_salary || 0).toFixed(2);
        const deductions = Number(payroll.deductions || 0).toFixed(2);
        const advanceBalance = Number(employee.advance_balance || 0).toFixed(2);
        const netSalary = Number(payroll.net_salary || 0).toFixed(2);
        const salaryRate = Number(employee.salary_rate || 0).toFixed(2);

        const currencySymbolMap = {
            'INR': '₹',
            'USD': '$',
            'EUR': '€',
            'GBP': '£',
            'AED': 'AED ',
            'ZAR': 'R ',
            'SGD': 'S$'
        };
        const currSymbol = currencySymbolMap[companySettings.currency] || companySettings.currency || '$';

        const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333; line-height: 1.6; }
                .container { max-width: 800px; margin: 0 auto; padding: 40px; }
                .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #0f172a; padding-bottom: 20px; margin-bottom: 30px; }
                .company-info { text-align: right; }
                .company-name { font-size: 24px; font-weight: bold; color: #0f172a; margin: 0; }
                .payslip-title { font-size: 20px; font-weight: bold; text-transform: uppercase; letter-spacing: 2px; color: #64748b; margin-top: 10px; }
                
                .emp-details { display: flex; justify-content: space-between; background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 30px; }
                .emp-col { width: 48%; }
                .detail-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
                .label { font-weight: bold; color: #64748b; font-size: 14px; }
                .value { font-weight: 500; font-size: 14px; }

                .salary-section { margin-bottom: 30px; }
                .table { width: 100%; border-collapse: collapse; }
                .table th { background: #0f172a; color: white; padding: 12px; text-align: left; font-size: 14px; }
                .table td { padding: 12px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
                .amount { text-align: right; }

                .summary { background: #f8fafc; padding: 20px; border-radius: 8px; margin-top: 20px; }
                .net-pay { font-size: 24px; font-weight: bold; color: #10b981; text-align: right; margin-top: 10px; }
                
                .footer { margin-top: 50px; text-align: center; color: #94a3b8; font-size: 12px; border-top: 1px solid #e2e8f0; padding-top: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div>
                        ${logoHtml}
                        <div class="payslip-title">PAYSLIP</div>
                    </div>
                    <div class="company-info">
                        <h1 class="company-name">${companySettings.business_name || companySettings.company_name || 'Our Company'}</h1>
                        <p style="margin:0; font-size:14px; color:#64748b;">${payrollMonth}</p>
                    </div>
                </div>

                <div class="emp-details">
                    <div class="emp-col">
                        <div class="detail-row"><span class="label">Employee Name:</span> <span class="value">${employee.name}</span></div>
                        <div class="detail-row"><span class="label">Employee ID:</span> <span class="value">${employee.custom_id || employee.id}</span></div>
                        <div class="detail-row"><span class="label">Email:</span> <span class="value">${employee.email || 'N/A'}</span></div>
                    </div>
                    <div class="emp-col">
                        <div class="detail-row"><span class="label">Pay Period:</span> <span class="value">${new Date(payroll.cycle_start).toLocaleDateString()} - ${new Date(payroll.cycle_end).toLocaleDateString()}</span></div>
                        <div class="detail-row"><span class="label">Salary Type:</span> <span class="value" style="text-transform: capitalize;">${employee.salary_type || 'Hourly'}</span></div>
                        <div class="detail-row"><span class="label">Salary Rate:</span> <span class="value">${currSymbol}${salaryRate}</span></div>
                    </div>
                </div>

                <div class="salary-section">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Earnings</th>
                                <th class="amount">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Basic Salary / Wages</td>
                                <td class="amount">${currSymbol}${baseSalary}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div class="salary-section">
                    <table class="table">
                        <thead>
                            <tr>
                                <th style="background:#dc2626;">Deductions</th>
                                <th class="amount" style="background:#dc2626;">Amount</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Standard Deductions (Late, UIF, etc.)</td>
                                <td class="amount">${currSymbol}${deductions}</td>
                            </tr>
                            ${Number(advanceBalance) > 0 ? `
                            <tr>
                                <td>Advance Balance</td>
                                <td class="amount">${currSymbol}${advanceBalance}</td>
                            </tr>` : ''}
                        </tbody>
                    </table>
                </div>

                <div class="summary">
                    <div class="detail-row"><span class="label">Gross Earnings:</span> <span class="value">${currSymbol}${baseSalary}</span></div>
                    <div class="detail-row"><span class="label">Total Deductions:</span> <span class="value">${currSymbol}${deductions}</span></div>
                    <div class="net-pay">
                        Net Salary: ${currSymbol}${netSalary}
                    </div>
                </div>

                <div class="footer">
                    <p>This is a system generated e-payslip and does not require a signature.</p>
                    <p>Generated on ${new Date().toLocaleDateString()}</p>
                </div>
            </div>
        </body>
        </html>
        `;

        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        
        const fileName = `EMP_${employee.id}_${payrollMonth.replace(' ', '_')}.pdf`;
        const filePath = path.join(payslipsDir, fileName);

        await page.pdf({
            path: filePath,
            format: 'A4',
            printBackground: true,
            margin: { top: '20px', bottom: '20px' }
        });

        await browser.close();

        // Return relative path for saving in DB
        return `/uploads/payslips/${fileName}`;
    } catch (error) {
        console.error('Error generating PDF with Puppeteer:', error);
        throw error;
    }
}

module.exports = { generatePayslipPDF };
