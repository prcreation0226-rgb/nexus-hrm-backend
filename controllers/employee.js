const db = require('../config/db');
const bcrypt = require('bcryptjs');

// Helper: treat 'admin', 'Master Admin', 'hr', and 'hr admin' as admin roles
const isAdmin = (role) => {
    if (!role) return false;
    const r = role.toLowerCase();
    return r === 'admin' || r === 'master admin' || r === 'hr' || r === 'hr admin';
};

// Get the next available IDs for new employee
exports.getNextIds = async (req, res) => {
    try {
        let empSql = "SELECT custom_id FROM employees WHERE custom_id REGEXP '^[0-9]+$'";
        let machineSql = "SELECT machine_id FROM employees WHERE machine_id REGEXP '^[0-9]+$'";
        let params = [];

        if (req.user && req.user.role !== 'MasterAdmin' && req.user.company_id) {
            empSql += " AND company_id = ?";
            machineSql += " AND company_id = ?";
            params.push(req.user.company_id);
        }

        empSql += " ORDER BY CAST(custom_id AS UNSIGNED) DESC LIMIT 1";
        machineSql += " ORDER BY CAST(machine_id AS UNSIGNED) DESC LIMIT 1";

        const [[lastEmp]] = await db.execute(empSql, params);
        const nextCustomId = lastEmp && lastEmp.custom_id ? (parseInt(lastEmp.custom_id) + 1) : 1001;

        const [[lastMachine]] = await db.execute(machineSql, params);
        const nextMachineId = lastMachine && lastMachine.machine_id ? (parseInt(lastMachine.machine_id) + 1) : 1001;

        res.json({ 
            nextCustomId: String(nextCustomId), 
            nextMachineId: String(nextMachineId) 
        });
    } catch (err) {
        console.error('Error in getNextIds:', err);
        res.status(500).json({ message: 'Error fetching next IDs', error: err.message });
    }
};

// Get all employees (Filtered by creator if admin)
exports.getAllEmployees = async (req, res) => {
    try {
        let query = `
            SELECT e.*, 
                   CASE WHEN fe.id IS NOT NULL THEN 1 ELSE 0 END as has_face_registered,
                   COALESCE((SELECT SUM(COALESCE(p.cpf_employee, p.uif_amount)) FROM payroll p WHERE p.employee_id = e.id AND p.status = 'paid'), 0) as total_uif_collected,
                   COALESCE((SELECT SUM(COALESCE(p.cpf_employee, p.uif_amount)) FROM payroll p WHERE p.employee_id = e.id AND p.status = 'paid'), 0) as total_cpf_employee,
                   COALESCE((SELECT SUM(COALESCE(p.cpf_employer, 0)) FROM payroll p WHERE p.employee_id = e.id AND p.status = 'paid'), 0) as total_cpf_employer,
                   COALESCE((SELECT SUM(COALESCE(p.cpf_total, COALESCE(p.cpf_employee, p.uif_amount))) FROM payroll p WHERE p.employee_id = e.id AND p.status = 'paid'), 0) as total_cpf_total
            FROM employees e
            LEFT JOIN face_embeddings fe ON e.id = fe.employee_id
            WHERE 1=1
        `;
        let params = [];

        if (req.user.role !== 'MasterAdmin') {
            query += ' AND e.company_id = ?';
            params.push(req.user.company_id);
        }

        query += ' ORDER BY e.created_at DESC';

        const [rows] = await db.execute(query, params);
        res.json(rows);
    } catch (err) {
        console.error('❌ SQL Error (getAllEmployees):', err);
        res.status(500).json({ message: 'Error fetching employees', error: err.message });
    }
};

// Add new employee / staff / admin
exports.addEmployee = async (req, res) => {
    const {
        machine_id, custom_id, name, role, department, shift, email, phone,
        salary_rate, salary_type, password, joined_date, date_of_birth,
        uif_number, advance_balance, signature, is_uif_registered
    } = req.body;

    console.log('📝 Add Employee Request. Signature received:', signature ? (signature.length + ' chars') : 'NO');

    // User who is creating this record
    const creatorId = req.user.id;

    // Use uploaded file if present
    let photo = req.body.photo;
    if (req.file) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        photo = `${protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    }

    try {
        // --- 0. Enforce Employee Limit ---
        if (req.user.company_id) {
            const [compRows] = await db.execute('SELECT employee_limit FROM companies WHERE id = ?', [req.user.company_id]);
            if (compRows.length > 0 && compRows[0].employee_limit > 0) {
                const limit = compRows[0].employee_limit;
                const [countRows] = await db.execute('SELECT COUNT(*) as count FROM employees WHERE company_id = ?', [req.user.company_id]);
                if (countRows[0].count >= limit) {
                    return res.status(403).json({ message: `Plan limit reached. Your plan allows up to ${limit} employees. Please upgrade your plan to add more.` });
                }
            }
        }

        // --- 1. Auto Generate Magic Numbers ---
        let nextEmpSql = "SELECT custom_id FROM employees WHERE custom_id REGEXP '^[0-9]+$'";
        let nextMachineSql = "SELECT machine_id FROM employees WHERE machine_id REGEXP '^[0-9]+$'";
        let idParams = [];

        if (req.user && req.user.role !== 'MasterAdmin' && req.user.company_id) {
            nextEmpSql += " AND company_id = ?";
            nextMachineSql += " AND company_id = ?";
            idParams.push(req.user.company_id);
        }

        nextEmpSql += " ORDER BY CAST(custom_id AS UNSIGNED) DESC LIMIT 1";
        nextMachineSql += " ORDER BY CAST(machine_id AS UNSIGNED) DESC LIMIT 1";

        const [[lastEmp]] = await db.execute(nextEmpSql, idParams);
        const nextCustomId = lastEmp && lastEmp.custom_id ? (parseInt(lastEmp.custom_id) + 1) : 1001;

        const [[lastMachine]] = await db.execute(nextMachineSql, idParams);
        const nextMachineId = lastMachine && lastMachine.machine_id ? (parseInt(lastMachine.machine_id) + 1) : 1001;

        const finalCustomId = (custom_id && String(custom_id).trim() !== '') ? String(custom_id).trim() : nextCustomId.toString();
        const finalMachineId = (machine_id && String(machine_id).trim() !== '') ? String(machine_id).trim() : nextMachineId.toString();

        // 1.5 Check for duplicate Employee ID
        const [dupCheck] = await db.execute('SELECT id FROM employees WHERE custom_id = ? AND company_id = ?', [finalCustomId, req.user.company_id]);
        if (dupCheck.length > 0) {
            return res.status(400).json({ message: `Employee ID ${finalCustomId} is already in use. Please use a unique ID.` });
        }

        // 2. Insert into employees table
        const formattedJoinedDate = joined_date ? joined_date.split('T')[0] : new Date().toISOString().split('T')[0];

        // Ensure role is valid — normalize if it's an admin variant
        const dbRole = isAdmin(role) ? role.toLowerCase() : 'employee';
        const dbShift = ['Morning Shift', 'Evening Shift', 'Night Shift'].includes(shift) ? shift : 'Morning Shift';
        const dbSalaryType = ['hourly', 'daily', 'monthly'].includes(salary_type) ? salary_type : 'hourly';

        const isCpfApplicable = (req.body.cpf_applicable === 'false' || req.body.cpf_applicable === false || req.body.cpf_applicable === 0 || req.body.cpf_applicable === '0') ? 0 : 1;

        const empSql = 'INSERT INTO employees (machine_id, custom_id, name, role, department, shift, email, phone, salary_rate, salary_type, joined_date, date_of_birth, photo, uif_number, advance_balance, signature, created_by, is_uif_registered, company_id, assigned_branch, cpf_applicable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
        const formattedDOB = date_of_birth ? date_of_birth.split('T')[0] : null;
        const empValues = [
            finalMachineId,
            finalCustomId,
            name || '',
            dbRole,
            department || 'General',
            dbShift,
            email || '',
            phone || '',
            parseFloat(salary_rate) || 0,
            dbSalaryType,
            formattedJoinedDate,
            formattedDOB,
            photo || null,
            uif_number || '',
            parseFloat(advance_balance) || 0,
            signature || null,
            creatorId,
            (is_uif_registered === 'true' || is_uif_registered === true || is_uif_registered === 1 || is_uif_registered === '1') ? 1 : 0,
            req.user.company_id,
            req.body.assigned_branch || null,
            isCpfApplicable
        ];

        console.log('📝 Saving Signature to DB. Length:', signature ? signature.length : 'EMPTY');

        console.log('📝 Executing SQL (Add Employee):', empSql, 'Params:', empValues);
        const [empResult] = await db.execute(empSql, empValues);

        const employeeId = empResult.insertId;
        const hashedPassword = await bcrypt.hash(password || '123456', 10);

        // 3. Create login user
        const finalRole = isAdmin(role) ? role.toLowerCase() : 'employee';
        const userSql = 'INSERT INTO users (employee_id, email, password, role, name, created_by, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
        const userValues = [employeeId, email || '', hashedPassword, finalRole, name || '', creatorId, req.user.company_id];

        console.log('📝 Executing SQL (Create User):', userSql, 'Params:', userValues);
        await db.execute(userSql, userValues);

        res.status(201).json({ message: 'Personnel added successfully', id: employeeId });
    } catch (err) {
        console.error('❌ SQL Error (addEmployee):', err);
        if (err.code === 'ER_DUP_ENTRY') {
            const field = err.message.includes('machine_id') ? 'Machine ID' : 'Email';
            return res.status(400).json({ message: `Duplicate entry: This ${field} is already assigned to another employee.` });
        }
        res.status(500).json({ message: 'Error adding personnel', error: err.message });
    }
};

// Get single employee details
exports.getEmployeeById = async (req, res) => {
    try {
        const sql = 'SELECT * FROM employees WHERE id = ?';
        console.log('📝 Executing SQL:', sql, 'Params:', [req.params.id]);
        const [rows] = await db.execute(sql, [req.params.id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Not found' });

        // Safety: If regular admin (not Master Admin), check if they own this record
        if (req.user.role !== 'MasterAdmin' && rows[0].company_id !== req.user.company_id) {
            return res.status(403).json({ message: 'Access denied to this record' });
        }

        res.json(rows[0]);
    } catch (err) {
        console.error('❌ SQL Error (getEmployeeById):', err);
        res.status(500).json({ message: 'Server error', error: err.message });
    }
};

// Update employee
exports.updateEmployee = async (req, res) => {
    const { id } = req.params;
    const data = req.body;

    console.log('📝 Incoming Employee Update Request - ID:', id);
    console.log('📝 Data Received:', JSON.stringify(data, null, 2));

    // Handle Profile Image Upload
    let photo = data.photo;
    if (req.file) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        photo = `${protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    }

    try {
        // 1. Safety Check: Verify ownership if admin
        const [existing] = await db.execute('SELECT company_id FROM employees WHERE id = ?', [id]);
        if (existing.length === 0) return res.status(404).json({ message: 'Employee not found' });

        if (req.user.role !== 'MasterAdmin' && existing[0].company_id !== req.user.company_id) {
            return res.status(403).json({ message: 'Cannot edit staff from another company' });
        }

        // 2. Build Dynamic Update for Employees Table
        const empUpdates = [];
        const empParams = [];

        const empFields = [
            'machine_id', 'custom_id', 'name', 'role', 'department', 'shift',
            'email', 'phone', 'salary_rate', 'salary_type', 'uif_number',
            'advance_balance', 'advance_installment', 'status', 'assigned_branch'
        ];

        // Handle date_of_birth separately (needs date formatting)
        if (data.date_of_birth !== undefined) {
            const dobVal = data.date_of_birth ? data.date_of_birth.split('T')[0] : null;
            empUpdates.push('`date_of_birth` = ?');
            empParams.push(dobVal);
        }

        empFields.forEach(field => {
            if (data[field] !== undefined) {
                empUpdates.push(`\`${field}\` = ?`);
                let val = data[field] === '' ? null : data[field];

                // Ensure numeric fields are numbers or null
                if (field === 'salary_rate' || field === 'advance_balance' || field === 'advance_installment') {
                    if (val === null) {
                        val = null;
                    } else {
                        const parsed = parseFloat(val);
                        val = isNaN(parsed) ? 0 : parsed;
                    }
                }

                // Map/Validate ENUM fields
                if (field === 'role') val = isAdmin(val) ? val.toLowerCase() : 'employee';
                if (field === 'shift') {
                    const validShifts = ['Morning Shift', 'Evening Shift', 'Night Shift'];
                    if (!validShifts.includes(val)) val = 'Morning Shift';
                }
                if (field === 'status') {
                    const validStatus = ['active', 'on_leave', 'terminated'];
                    if (!validStatus.includes(val)) val = 'active';
                }
                if (field === 'salary_type') {
                    const validTypes = ['hourly', 'daily', 'monthly'];
                    if (!validTypes.includes(val)) val = 'hourly';
                }

                empParams.push(val);
            }
        });

        if (photo !== undefined) { empUpdates.push('`photo` = ?'); empParams.push(photo); }
        if (data.signature !== undefined) { 
            console.log('📝 Updating Signature. Length:', data.signature ? data.signature.length : 0);
            empUpdates.push('`signature` = ?'); 
            empParams.push(data.signature); 
        }
        if (data.is_uif_registered !== undefined) {
            const isUif = data.is_uif_registered === 'true' || data.is_uif_registered === true || data.is_uif_registered === 1 || data.is_uif_registered === '1';
            empUpdates.push('`is_uif_registered` = ?');
            empParams.push(isUif ? 1 : 0);
        }
        if (data.cpf_applicable !== undefined) {
            const isCpf = !(data.cpf_applicable === 'false' || data.cpf_applicable === false || data.cpf_applicable === 0 || data.cpf_applicable === '0');
            empUpdates.push('`cpf_applicable` = ?');
            empParams.push(isCpf ? 1 : 0);
        }
        if (data.joined_date) { empUpdates.push('`joined_date` = ?'); empParams.push(data.joined_date.split('T')[0]); }

        if (empUpdates.length > 0) {
            const empQuery = `UPDATE employees SET ${empUpdates.join(', ')} WHERE id = ?`;
            empParams.push(id);
            console.log('📝 Executing SQL (Update Employee):', empQuery, 'Params:', empParams);
            await db.execute(empQuery, empParams);
        }

        // 3. Sync to Users Table (if relevant fields provided)
        const userUpdates = [];
        const userParams = [];

        if (data.email) {
            userUpdates.push('email = ?');
            userParams.push(data.email);
        }
        if (data.name) { 
            userUpdates.push('name = ?'); 
            userParams.push(data.name); 
            try {
                await db.execute('UPDATE kpis SET employee_name = ? WHERE employee_id = ?', [data.name, id]);
                await db.execute('UPDATE leaves SET employee_name = ? WHERE employee_id = ?', [data.name, id]);
                await db.execute('UPDATE claims SET employee_name = ? WHERE employee_id = ?', [data.name, id]);
            } catch (e) {
                console.warn('Failed to sync employee name to related tables:', e.message);
            }
        }
        if (photo) { userUpdates.push('photo = ?'); userParams.push(photo); }
        if (data.role) { userUpdates.push('role = ?'); userParams.push(isAdmin(data.role) ? data.role.toLowerCase() : 'employee'); }

        if (data.password && data.password.trim() !== '') {
            const hashedPassword = await bcrypt.hash(data.password, 10);
            userUpdates.push('password = ?');
            userParams.push(hashedPassword);
        }

        // Ensure a user record exists for this employee_id
        const [existingUser] = await db.execute('SELECT id FROM users WHERE employee_id = ?', [id]);
        if (existingUser.length === 0) {
            const [empData] = await db.execute('SELECT * FROM employees WHERE id = ?', [id]);
            if (empData.length > 0) {
                const emp = empData[0];
                const pwd = (data.password && data.password.trim() !== '') ? await bcrypt.hash(data.password, 10) : await bcrypt.hash('12345678', 10);
                await db.execute(
                    'INSERT INTO users (employee_id, email, password, role, name, created_by, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [id, emp.email || '', pwd, emp.role || 'employee', emp.name || '', emp.created_by, emp.company_id]
                );
            }
        } else if (userUpdates.length > 0) {
            const userQuery = `UPDATE users SET ${userUpdates.join(', ')} WHERE employee_id = ?`;
            userParams.push(id);
            console.log('📝 Executing SQL (Sync User):', userQuery, 'Params:', userParams);
            await db.execute(userQuery, userParams);
        }

        res.json({ message: 'Record updated successfully' });
    } catch (err) {
        console.error('❌ SQL Error (updateEmployee):', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Duplicate entry: Machine ID or Email already exists', error: err.message });
        }
        res.status(500).json({ message: 'Error updating record', error: err.message });
    }
};

// Delete employee
exports.deleteEmployee = async (req, res) => {
    const { id } = req.params;
    try {
        // Prevent deleting oneself
        if (req.user.employee_id && String(req.user.employee_id) === String(id)) {
            return res.status(403).json({ message: 'You cannot delete your own account.' });
        }

        // Safety: If admin, verify ownership
        const [existing] = await db.execute('SELECT company_id FROM employees WHERE id = ?', [id]);
        if (existing.length > 0 && req.user.role !== 'MasterAdmin' && existing[0].company_id !== req.user.company_id) {
            return res.status(403).json({ message: 'Cannot delete records from another company' });
        }

        const userSql = 'DELETE FROM users WHERE employee_id = ?';
        console.log('📝 Executing SQL:', userSql, 'Params:', [id]);
        await db.execute(userSql, [id]);

        const empSql = 'DELETE FROM employees WHERE id = ?';
        console.log('📝 Executing SQL:', empSql, 'Params:', [id]);
        const [result] = await db.execute(empSql, [id]);

        if (result.affectedRows === 0) return res.status(404).json({ message: 'Record not found' });
        res.json({ message: 'Record deleted successfully' });
    } catch (err) {
        console.error('❌ SQL Error (deleteEmployee):', err);
        res.status(500).json({ message: 'Error deleting record', error: err.message });
    }
};

exports.adminResetPassword = async (req, res) => {
    try {
        const employeeId = req.params.id;
        const companyId = req.user.company_id;

        // Security check: ensure the employee belongs to the admin's company
        const [empCheck] = await db.execute('SELECT id, name FROM employees WHERE id = ? AND company_id = ?', [employeeId, companyId]);
        if (empCheck.length === 0) {
            return res.status(404).json({ message: 'Employee not found or access denied' });
        }

        // Generate a random 8-character password
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#*';
        let tempPassword = 'Nx';
        for (let i = 0; i < 6; i++) {
            tempPassword += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        // Update the user's password
        const [updateResult] = await db.execute(
            'UPDATE users SET password = ? WHERE employee_id = ?',
            [hashedPassword, employeeId]
        );

        if (updateResult.affectedRows === 0) {
            // Auto-heal: User row missing for employee, create it now!
            const [fullEmp] = await db.execute('SELECT * FROM employees WHERE id = ?', [employeeId]);
            if (fullEmp.length > 0) {
                const emp = fullEmp[0];
                await db.execute(
                    'INSERT INTO users (employee_id, email, password, role, name, created_by, company_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [employeeId, emp.email || '', hashedPassword, emp.role || 'employee', emp.name || '', emp.created_by, emp.company_id]
                );
            }
        }

        res.json({ 
            message: 'Password reset successfully', 
            tempPassword: tempPassword,
            employeeName: empCheck[0].name
        });
    } catch (err) {
        console.error('❌ Error resetting password:', err);
        res.status(500).json({ message: 'Error resetting password', error: err.message });
    }
};

// --- BULK EMPLOYEE UPLOAD & TEMPLATE ---
const xlsx = require('xlsx');

// Helper: Parse any date format (YYYY-MM-DD, DD/MM/YYYY, Excel serial)
function parseExcelDate(val) {
    if (!val) return null;
    if (val instanceof Date && !isNaN(val)) {
        return val.toISOString().split('T')[0];
    }
    if (typeof val === 'number') {
        const utc_days = Math.floor(val - 25569);
        const date_info = new Date(utc_days * 86400 * 1000);
        if (!isNaN(date_info.getTime())) {
            return date_info.toISOString().split('T')[0];
        }
    }
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        return str;
    }
    const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
        const day = dmy[1].padStart(2, '0');
        const month = dmy[2].padStart(2, '0');
        const year = dmy[3];
        return `${year}-${month}-${day}`;
    }
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
        return parsed.toISOString().split('T')[0];
    }
    return null;
}

// Download Sample Template (.xlsx)
exports.downloadEmployeeTemplate = async (req, res) => {
    try {
        const wb = xlsx.utils.book_new();
        const headers = [
            'Full Name',
            'Email',
            'Phone',
            'Date of Birth',
            'Joining Date',
            'Department',
            'Designation',
            'Salary',
            'Salary Type',
            'Address',
            'Employee ID',
            'CPF Applicable'
        ];

        const sampleRows = [
            [
                'John Doe',
                'john.doe@company.com',
                '+65 9123 4567',
                '1992-06-15',
                new Date().toISOString().split('T')[0],
                'Operations',
                'Staff / Employee',
                '3200',
                'monthly',
                'Block 123 Orchard Road, #05-01',
                '',
                'Yes'
            ],
            [
                'Jane Smith',
                'jane.smith@company.com',
                '+65 9876 5432',
                '1995-11-20',
                new Date().toISOString().split('T')[0],
                'Sales',
                'Staff / Employee',
                '20',
                'hourly',
                'Block 456 Jurong West, #08-12',
                '',
                'No'
            ]
        ];

        const ws = xlsx.utils.aoa_to_sheet([headers, ...sampleRows]);

        // Auto-fit column widths
        ws['!cols'] = [
            { wch: 20 }, // Full Name
            { wch: 28 }, // Email
            { wch: 18 }, // Phone
            { wch: 16 }, // Date of Birth
            { wch: 16 }, // Joining Date
            { wch: 16 }, // Department
            { wch: 18 }, // Designation
            { wch: 12 }, // Salary
            { wch: 14 }, // Salary Type
            { wch: 32 }, // Address
            { wch: 15 }, // Employee ID
            { wch: 16 }  // CPF Applicable
        ];

        xlsx.utils.book_append_sheet(wb, ws, 'Employees_Template');

        const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', 'attachment; filename="employee_bulk_upload_template.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (err) {
        console.error('Error generating template:', err);
        res.status(500).json({ message: 'Error generating employee template', error: err.message });
    }
};

// Bulk Upload Employees (.xlsx, .xls, .csv)
exports.bulkUploadEmployees = async (req, res) => {
    try {
        let fileBuffer = null;
        if (req.file) {
            if (req.file.buffer) {
                fileBuffer = req.file.buffer;
            } else if (req.file.path) {
                const fs = require('fs');
                if (fs.existsSync(req.file.path)) {
                    fileBuffer = fs.readFileSync(req.file.path);
                    try { fs.unlinkSync(req.file.path); } catch (e) {}
                }
            }
        }

        if (!fileBuffer) {
            return res.status(400).json({ message: 'Please upload an Excel (.xlsx) or CSV (.csv) file.' });
        }

        const companyId = req.user.company_id;
        const creatorId = req.user.id;

        // Check Plan limit
        if (req.user.role !== 'MasterAdmin' && companyId) {
            const [company] = await db.execute('SELECT plan, employee_limit FROM companies WHERE id = ?', [companyId]);
            if (company.length > 0) {
                const limit = company[0].employee_limit || (company[0].plan === 'starter' ? 10 : company[0].plan === 'medium' ? 50 : 200);
                const [countRows] = await db.execute('SELECT COUNT(*) as count FROM employees WHERE company_id = ?', [companyId]);
                const currentCount = countRows[0].count;
                if (currentCount >= limit) {
                    return res.status(403).json({ 
                        message: `Plan limit reached. Your plan allows up to ${limit} employees (Current: ${currentCount}). Please upgrade your plan.` 
                    });
                }
            }
        }

        // Parse Spreadsheet Buffer
        let workbook;
        try {
            workbook = xlsx.read(fileBuffer, { type: 'buffer', cellDates: true });
        } catch (e) {
            return res.status(400).json({ message: 'Invalid file format. Please upload a valid Excel or CSV file.' });
        }

        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
            return res.status(400).json({ message: 'The uploaded workbook does not contain any sheets.' });
        }

        const sheet = workbook.Sheets[firstSheetName];
        const rawRows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });

        if (!rawRows || rawRows.length === 0) {
            return res.status(400).json({ message: 'No employee records found in the uploaded file.' });
        }

        // Fetch existing emails and custom_ids for duplicate checking
        const [existingEmps] = await db.execute(
            'SELECT email, custom_id FROM employees WHERE company_id = ?',
            [companyId]
        );
        const existingEmails = new Set(existingEmps.map(e => (e.email || '').trim().toLowerCase()).filter(Boolean));
        const existingCustomIds = new Set(existingEmps.map(e => String(e.custom_id || '').trim()).filter(Boolean));

        // Also check global users email
        const [existingUsers] = await db.execute('SELECT email FROM users');
        existingUsers.forEach(u => {
            if (u.email) existingEmails.add(u.email.trim().toLowerCase());
        });

        // Determine starting auto-increment IDs for this company
        const [[lastEmp]] = await db.execute(
            "SELECT custom_id FROM employees WHERE custom_id REGEXP '^[0-9]+$' AND company_id = ? ORDER BY CAST(custom_id AS UNSIGNED) DESC LIMIT 1",
            [companyId]
        );
        let curCustomIdNum = lastEmp && lastEmp.custom_id ? (parseInt(lastEmp.custom_id) + 1) : 1001;

        const [[lastMachine]] = await db.execute(
            "SELECT machine_id FROM employees WHERE machine_id REGEXP '^[0-9]+$' AND company_id = ? ORDER BY CAST(machine_id AS UNSIGNED) DESC LIMIT 1",
            [companyId]
        );
        let curMachineIdNum = lastMachine && lastMachine.machine_id ? (parseInt(lastMachine.machine_id) + 1) : 1001;

        const defaultPasswordHash = await bcrypt.hash('123456', 10);
        const errors = [];
        const successList = [];
        const batchEmails = new Set();
        const batchCustomIds = new Set();

        for (let i = 0; i < rawRows.length; i++) {
            const raw = rawRows[i];
            const rowNumber = i + 2; // Row 1 is header, data starts on Row 2

            // Normalize column headers
            const getVal = (...keys) => {
                for (const key of keys) {
                    const match = Object.keys(raw).find(k => k.trim().toLowerCase() === key.toLowerCase());
                    if (match && raw[match] !== undefined && raw[match] !== null) {
                        return String(raw[match]).trim();
                    }
                }
                return '';
            };

            const name = getVal('Full Name', 'Name', 'full_name', 'Employee Name', 'Employee');
            const email = getVal('Email', 'email', 'Email Address', 'Email ID');
            const phone = getVal('Phone', 'phone', 'Phone Number', 'Contact', 'Mobile');
            const rawDob = getVal('Date of Birth', 'DOB', 'Birth Date', 'date_of_birth', 'BirthDate');
            const rawJoinedDate = getVal('Joining Date', 'Join Date', 'joined_date', 'Date of Joining', 'JoiningDate');
            const department = getVal('Department', 'Dept', 'department') || 'General';
            const designation = getVal('Designation', 'Role', 'designation', 'role', 'Job Title') || 'Staff / Employee';
            const rawSalary = getVal('Salary', 'salary', 'Basic Salary', 'Salary Rate', 'rate', 'Monthly Salary');
            const salaryType = getVal('Salary Type', 'salary_type', 'SalaryType', 'Payment Type') || 'hourly';
            const address = getVal('Address', 'address', 'Residential Address');
            const customIdInput = getVal('Employee ID', 'custom_id', 'Emp ID', 'ID', 'EmployeeID');
            const rawCpf = getVal('CPF Applicable', 'CPF', 'cpf_applicable', 'CPF Eligibility', 'CPF Eligible');

            // --- Validations ---
            if (!name) {
                errors.push({ row: rowNumber, name: name || '---', email: email || '---', reason: 'Missing required field: Full Name' });
                continue;
            }

            if (!email) {
                errors.push({ row: rowNumber, name, email: '---', reason: 'Missing required field: Email' });
                continue;
            }

            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                errors.push({ row: rowNumber, name, email, reason: `Invalid email address format: "${email}"` });
                continue;
            }

            const lowerEmail = email.toLowerCase();
            if (existingEmails.has(lowerEmail)) {
                errors.push({ row: rowNumber, name, email, reason: `Email "${email}" is already registered in the system` });
                continue;
            }

            if (batchEmails.has(lowerEmail)) {
                errors.push({ row: rowNumber, name, email, reason: `Duplicate email "${email}" found multiple times in uploaded file` });
                continue;
            }

            // Date of Birth validation
            const formattedDOB = parseExcelDate(rawDob);
            if (!formattedDOB) {
                errors.push({ row: rowNumber, name, email, reason: `Invalid or missing Date of Birth "${rawDob}". Format must be YYYY-MM-DD` });
                continue;
            }

            // Joining Date
            const formattedJoinedDate = parseExcelDate(rawJoinedDate) || new Date().toISOString().split('T')[0];

            // Salary Rate
            let salaryRate = 0;
            if (rawSalary) {
                const cleanedSalary = String(rawSalary).replace(/[^0-9.]/g, '');
                salaryRate = parseFloat(cleanedSalary) || 0;
            }

            // Salary Type
            let dbSalaryType = 'hourly';
            const lowerSalType = salaryType.toLowerCase();
            if (lowerSalType.includes('month')) dbSalaryType = 'monthly';
            else if (lowerSalType.includes('day') || lowerSalType.includes('daily')) dbSalaryType = 'daily';

            // Custom ID / Machine ID resolution
            let finalCustomId = '';
            let finalMachineId = '';

            if (customIdInput) {
                finalCustomId = customIdInput;
                if (existingCustomIds.has(finalCustomId) || batchCustomIds.has(finalCustomId)) {
                    errors.push({ row: rowNumber, name, email, reason: `Employee ID "${finalCustomId}" is already assigned` });
                    continue;
                }
                finalMachineId = finalCustomId;
            } else {
                while (existingCustomIds.has(String(curCustomIdNum)) || batchCustomIds.has(String(curCustomIdNum))) {
                    curCustomIdNum++;
                }
                finalCustomId = String(curCustomIdNum);
                finalMachineId = String(curMachineIdNum);
                curCustomIdNum++;
                curMachineIdNum++;
            }

            // CPF Applicable (Defaults to 1, unless explicitly No / 0 / Exempt)
            let isCpf = 1;
            const lowerCpf = rawCpf.toLowerCase();
            if (['no', '0', 'false', 'exempt', 'not applicable', 'n'].includes(lowerCpf)) {
                isCpf = 0;
            }

            // --- Database Insertion ---
            try {
                const empSql = 'INSERT INTO employees (machine_id, custom_id, name, role, department, shift, email, phone, salary_rate, salary_type, joined_date, date_of_birth, uif_number, advance_balance, created_by, is_uif_registered, company_id, cpf_applicable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
                const empValues = [
                    finalMachineId,
                    finalCustomId,
                    name,
                    'employee',
                    department,
                    'Morning Shift',
                    email,
                    phone || '',
                    salaryRate,
                    dbSalaryType,
                    formattedJoinedDate,
                    formattedDOB,
                    address || '', // Storing address in uif_number / notes field
                    0,
                    creatorId,
                    1,
                    companyId,
                    isCpf
                ];

                const [empResult] = await db.execute(empSql, empValues);
                const newEmpId = empResult.insertId;

                // Create user login with must_change_password = 1 (Force change password on first login)
                const userSql = 'INSERT INTO users (employee_id, email, password, role, name, created_by, company_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, ?, 1)';
                await db.execute(userSql, [newEmpId, email, defaultPasswordHash, 'employee', name, creatorId, companyId]);

                // Track sets for fast duplicate prevention in subsequent rows
                batchEmails.add(lowerEmail);
                existingEmails.add(lowerEmail);
                batchCustomIds.add(finalCustomId);
                existingCustomIds.add(finalCustomId);

                successList.push({
                    id: newEmpId,
                    custom_id: finalCustomId,
                    name: name,
                    email: email
                });
            } catch (insertErr) {
                console.error(`Row ${rowNumber} insert error:`, insertErr);
                errors.push({ 
                    row: rowNumber, 
                    name, 
                    email, 
                    reason: insertErr.code === 'ER_DUP_ENTRY' ? 'Duplicate record in database' : insertErr.message 
                });
            }
        }

        res.status(200).json({
            message: `Bulk upload finished. ${successList.length} employees imported successfully.`,
            totalProcessed: rawRows.length,
            successCount: successList.length,
            failedCount: errors.length,
            errors: errors,
            imported: successList
        });
    } catch (err) {
        console.error('❌ Error in bulkUploadEmployees:', err);
        res.status(500).json({ message: 'Error processing bulk upload', error: err.message });
    }
};

