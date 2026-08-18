const db = require('../config/db');
const moment = require('moment-timezone');
// Calculate Euclidean distance between two descriptors
const euclideanDistance = (desc1, desc2) => {
    if (desc1.length !== desc2.length) return Infinity;
    return Math.sqrt(
        desc1.reduce((sum, val, i) => sum + Math.pow(val - desc2[i], 2), 0)
    );
};

// Calculate Haversine distance in meters
const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3; // Earth radius in meters
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * 
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// Validate employee's GPS coordinates against ALL assigned active geofences
const validateEmployeeLocation = async (employeeId, companyId, latitude, longitude) => {
    // Check if company has any active geofences configured
    const [companyGeofences] = await db.execute(
        'SELECT COUNT(*) as count FROM geofences WHERE company_id = ? AND status = "Active"',
        [companyId]
    );

    // If company hasn't configured any geofences, skip geofence validation
    if (companyGeofences[0].count === 0) {
        return { valid: true };
    }

    // Fetch all active assigned geofences for this employee
    const [assignedLocations] = await db.execute(`
        SELECT g.id, g.name, g.latitude, g.longitude, g.radius 
        FROM geofences g
        INNER JOIN employee_locations el ON el.location_id = g.id
        WHERE el.employee_id = ? AND el.company_id = ? AND g.status = 'Active'
    `, [employeeId, companyId]);

    // Strict Rule 1: If employee has no assigned active locations -> BLOCK attendance!
    if (assignedLocations.length === 0) {
        return { 
            valid: false, 
            message: 'You have no assigned work locations. Please contact your administrator.' 
        };
    }

    if (!latitude || !longitude) {
        return { valid: false, message: 'GPS coordinates are required to verify your location.' };
    }

    // Strict Rule 2: Check if employee is within radius of ANY assigned location
    let isInside = false;
    for (const loc of assignedLocations) {
        const dist = calculateDistance(latitude, longitude, parseFloat(loc.latitude), parseFloat(loc.longitude));
        if (dist <= loc.radius) {
            isInside = true;
            break;
        }
    }

    if (!isInside) {
        return { 
            valid: false, 
            message: 'You are outside your assigned work locations.' 
        };
    }

    return { valid: true };
};

const FACE_MATCH_THRESHOLD = 0.45; // Adjusted threshold for face-api.js (distance < 0.45 is a match)

// Anti-Spoofing Lockout Map: { userId: { attempts: number, lockUntil: timestamp } }
const lockoutStore = new Map();

const checkLockout = (userId) => {
    const record = lockoutStore.get(userId);
    if (record && record.lockUntil > Date.now()) {
        const minutesLeft = Math.ceil((record.lockUntil - Date.now()) / 60000);
        return { locked: true, minutesLeft };
    }
    return { locked: false };
};

const recordFailure = (userId) => {
    const record = lockoutStore.get(userId) || { attempts: 0, lockUntil: 0 };
    record.attempts += 1;
    if (record.attempts >= 3) {
        record.lockUntil = Date.now() + 15 * 60 * 1000; // 15 minutes
    }
    lockoutStore.set(userId, record);
    return record.attempts;
};

const clearLockout = (userId) => {
    lockoutStore.delete(userId);
};

const isFaceRecognitionEnabledForCompany = async (companyId) => {
    if (!companyId) return true;
    const [rows] = await db.execute('SELECT face_recognition FROM kiosk_settings WHERE company_id = ?', [companyId]);
    if (rows.length > 0 && Number(rows[0].face_recognition) === 0) {
        return false;
    }
    return true;
};

exports.registerFace = async (req, res) => {
    try {
        const { employee_id, descriptor } = req.body;
        
        if (!employee_id || !descriptor || !Array.isArray(descriptor)) {
            return res.status(400).json({ message: 'Valid employee ID and face descriptor required.' });
        }

        // Check if employee exists
        const [emp] = await db.execute('SELECT id, company_id FROM employees WHERE id = ?', [employee_id]);
        if (emp.length === 0) {
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const isEnabled = await isFaceRecognitionEnabledForCompany(emp[0].company_id);
        if (!isEnabled) {
            return res.status(403).json({ message: 'Face recognition attendance has been disabled by your company administrator.' });
        }

        const descriptorJson = JSON.stringify(descriptor);

        // --- NEW ANTI-DUPLICATE LOGIC ---
        // Fetch all existing face embeddings to prevent cross-employee duplicates
        const [embeddings] = await db.execute('SELECT employee_id, descriptor FROM face_embeddings');
        let duplicateFound = false;
        
        for (const row of embeddings) {
            // Ignore if the same employee is updating their own face
            if (row.employee_id === employee_id) continue;
            
            const storedDescriptor = typeof row.descriptor === 'string' ? JSON.parse(row.descriptor) : row.descriptor;
            const distance = euclideanDistance(descriptor, storedDescriptor);
            
            // Duplicate strict threshold: 0.45
            if (distance <= 0.45) {
                duplicateFound = true;
                break;
            }
        }
        
        if (duplicateFound) {
            return res.status(400).json({ message: 'This face is already registered with another employee.' });
        }
        // --------------------------------

        // Upsert descriptor
        await db.execute(`
            INSERT INTO face_embeddings (employee_id, descriptor) 
            VALUES (?, ?)
            ON DUPLICATE KEY UPDATE descriptor = ?, updated_at = CURRENT_TIMESTAMP
        `, [employee_id, descriptorJson, descriptorJson]);

        res.status(200).json({ message: 'Face registered successfully!' });

    } catch (error) {
        console.error('Face Registration Error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

// findBestMatch is deprecated - we now enforce 1:1 ownership checking

exports.getTodayStatus = async (req, res) => {
    try {
        // Authenticated user
        const userId = req.user.id;
        
        // Find employee id associated with this user
        const [emp] = await db.execute('SELECT id FROM employees WHERE email = (SELECT email FROM users WHERE id = ?)', [userId]);
        if (emp.length === 0) return res.json({ status: 'not_found' });

        const employeeId = emp[0].id;
        const today = moment().tz("Asia/Kolkata").format("YYYY-MM-DD");

        const [existing] = await db.execute(
            'SELECT in_time, out_time FROM attendance WHERE employee_id = ? AND date = ?',
            [employeeId, today]
        );

        if (existing.length === 0) {
            return res.json({ status: 'not_checked_in', employeeId });
        } else if (!existing[0].out_time) {
            return res.json({ status: 'checked_in', in_time: existing[0].in_time, employeeId });
        } else {
            return res.json({ status: 'checked_out', in_time: existing[0].in_time, out_time: existing[0].out_time, employeeId });
        }
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};


exports.checkIn = async (req, res) => {
    try {
        const userId = req.user.id;
        
        const lockoutStatus = checkLockout(userId);
        if (lockoutStatus.locked) {
            return res.status(429).json({ message: `Too many failed attempts. Try again in ${lockoutStatus.minutesLeft} minutes.` });
        }

        const { descriptor, livenessPassed, livenessScore, latitude, longitude, skipFace } = req.body;

        const [emp] = await db.execute('SELECT id, company_id FROM employees WHERE email = (SELECT email FROM users WHERE id = ?)', [userId]);
        if (emp.length === 0) return res.status(404).json({ message: 'Employee profile not found.' });
        
        const employeeId = emp[0].id;
        const companyId = emp[0].company_id;

        const isEnabled = await isFaceRecognitionEnabledForCompany(companyId);

        // If face recognition is disabled or skipFace is requested when disabled
        if (!isEnabled || skipFace) {
            // --- GEOFENCE VALIDATION ---
            const locCheck = await validateEmployeeLocation(employeeId, companyId, latitude, longitude);
            if (!locCheck.valid) {
                return res.status(403).json({ message: locCheck.message });
            }
            // ---------------------------

            const today = moment().tz("Asia/Kolkata").format("YYYY-MM-DD");
            const now = moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
            const { determinePunchStatus } = require('../utils/attendanceHelper');
            const status = await determinePunchStatus(companyId, now);
            
            const [existing] = await db.execute('SELECT id FROM attendance WHERE employee_id = ? AND date = ?', [employeeId, today]);

            if (existing.length === 0) {
                await db.execute(
                    'INSERT INTO attendance (employee_id, date, in_time, status, company_id) VALUES (?, ?, ?, ?, ?)',
                    [employeeId, today, now, status, companyId]
                );
                clearLockout(userId);
                return res.status(200).json({ success: true, message: 'Check-in successful.' });
            } else {
                return res.status(400).json({ success: false, message: 'Already checked in for today.' });
            }
        }

        if (!descriptor || !Array.isArray(descriptor)) return res.status(400).json({ message: 'Invalid face descriptor.' });
        if (!livenessPassed || livenessScore < 0.80) {
            recordFailure(userId);
            return res.status(403).json({ message: 'Anti-spoofing triggered. Real face not detected.' });
        }

        // --- GEOFENCE VALIDATION ---
        const locCheck = await validateEmployeeLocation(employeeId, companyId, latitude, longitude);
        if (!locCheck.valid) {
            return res.status(403).json({ message: locCheck.message });
        }
        // ---------------------------

        // Fetch ONLY the logged-in employee's face descriptor
        const [embeddings] = await db.execute('SELECT descriptor FROM face_embeddings WHERE employee_id = ?', [employeeId]);
        if (embeddings.length === 0) {
            return res.status(400).json({ success: false, message: 'No face registered for this employee.' });
        }
        
        const storedDescriptor = typeof embeddings[0].descriptor === 'string' ? JSON.parse(embeddings[0].descriptor) : embeddings[0].descriptor;
        const distance = euclideanDistance(descriptor, storedDescriptor);

        if (distance <= FACE_MATCH_THRESHOLD) {
            await db.execute('INSERT INTO face_logs (employee_id, status, confidence) VALUES (?, ?, ?)', [employeeId, 'success', distance]);

            // Asia/Kolkata specific strings for MySQL
            const today = moment().tz("Asia/Kolkata").format("YYYY-MM-DD");
            const now = moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
            
            // Validate: One check-in per day
            const [existing] = await db.execute('SELECT id FROM attendance WHERE employee_id = ? AND date = ?', [employeeId, today]);

            if (existing.length === 0) {
                await db.execute(
                    'INSERT INTO attendance (employee_id, date, in_time, status, company_id) VALUES (?, ?, ?, ?, ?)',
                    [employeeId, today, now, 'present', companyId]
                );
                clearLockout(userId);
                return res.status(200).json({ success: true, message: 'Check-in successful.' });
            } else {
                return res.status(400).json({ success: false, message: 'Already checked in for today.' });
            }
        } else {
            const attempts = recordFailure(userId);
            await db.execute('INSERT INTO unknown_attempts (confidence) VALUES (?)', [distance]);
            return res.status(400).json({ success: false, message: `Face match failed. Attempt ${attempts}/3.` });
        }
    } catch (error) {
        console.error('Check-in Error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.checkOut = async (req, res) => {
    try {
        const userId = req.user.id;

        const lockoutStatus = checkLockout(userId);
        if (lockoutStatus.locked) {
            return res.status(429).json({ message: `Too many failed attempts. Try again in ${lockoutStatus.minutesLeft} minutes.` });
        }

        const { descriptor, livenessPassed, livenessScore, latitude, longitude, skipFace } = req.body;

        const [emp] = await db.execute('SELECT id, company_id FROM employees WHERE email = (SELECT email FROM users WHERE id = ?)', [userId]);
        if (emp.length === 0) return res.status(404).json({ message: 'Employee profile not found.' });
        const empRec = emp[0];
        const employeeId = empRec.id;
        const companyId = empRec.company_id;

        const isEnabled = await isFaceRecognitionEnabledForCompany(companyId);

        if (!isEnabled || skipFace) {
            // --- GEOFENCE VALIDATION ---
            const locCheck = await validateEmployeeLocation(employeeId, companyId, latitude, longitude);
            if (!locCheck.valid) {
                return res.status(403).json({ message: locCheck.message });
            }
            // ---------------------------

            const today = moment().tz("Asia/Kolkata").format("YYYY-MM-DD");
            const now = moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
            
            const [existing] = await db.execute('SELECT id, in_time, out_time FROM attendance WHERE employee_id = ? AND date = ?', [employeeId, today]);

            if (existing.length === 0) {
                return res.status(400).json({ success: false, message: 'You have not checked in today.' });
            } else if (!existing[0].out_time) {
                const inTimeStr = existing[0].in_time; 
                const inTime = moment.tz(inTimeStr, "YYYY-MM-DD HH:mm:ss", "Asia/Kolkata");
                const outTime = moment.tz(now, "YYYY-MM-DD HH:mm:ss", "Asia/Kolkata");
                
                const diffMs = outTime.diff(inTime);
                const totalHours = (diffMs / (1000 * 60 * 60)).toFixed(2);

                await db.execute(
                    'UPDATE attendance SET out_time = ?, total_hours = ? WHERE id = ?',
                    [now, totalHours, existing[0].id]
                );
                clearLockout(userId);
                return res.status(200).json({ success: true, message: 'Check-out successful.' });
            } else {
                return res.status(400).json({ success: false, message: 'Already checked out for today.' });
            }
        }

        if (!descriptor || !Array.isArray(descriptor)) return res.status(400).json({ message: 'Invalid face descriptor.' });
        if (!livenessPassed || livenessScore < 0.80) {
            recordFailure(userId);
            return res.status(403).json({ message: 'Anti-spoofing triggered. Real face not detected.' });
        }

        // --- GEOFENCE VALIDATION ---
        const locCheck = await validateEmployeeLocation(employeeId, companyId, latitude, longitude);
        if (!locCheck.valid) {
            return res.status(403).json({ message: locCheck.message });
        }
        // ---------------------------

        // Fetch ONLY the logged-in employee's face descriptor
        const [embeddings] = await db.execute('SELECT descriptor FROM face_embeddings WHERE employee_id = ?', [employeeId]);
        if (embeddings.length === 0) {
            return res.status(400).json({ success: false, message: 'No face registered for this employee.' });
        }
        
        const storedDescriptor = typeof embeddings[0].descriptor === 'string' ? JSON.parse(embeddings[0].descriptor) : embeddings[0].descriptor;
        const distance = euclideanDistance(descriptor, storedDescriptor);

        if (distance <= FACE_MATCH_THRESHOLD) {
            await db.execute('INSERT INTO face_logs (employee_id, status, confidence) VALUES (?, ?, ?)', [employeeId, 'success', distance]);

            const today = moment().tz("Asia/Kolkata").format("YYYY-MM-DD");
            const now = moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
            
            // Validate: Must be checked in, and not yet checked out
            const [existing] = await db.execute('SELECT id, in_time, out_time FROM attendance WHERE employee_id = ? AND date = ?', [employeeId, today]);

            if (existing.length === 0) {
                return res.status(400).json({ success: false, message: 'You have not checked in today.' });
            } else if (!existing[0].out_time) {
                
                // Safe Moment.js hour calculation
                const inTimeStr = existing[0].in_time; 
                const inTime = moment.tz(inTimeStr, "YYYY-MM-DD HH:mm:ss", "Asia/Kolkata");
                const outTime = moment.tz(now, "YYYY-MM-DD HH:mm:ss", "Asia/Kolkata");
                
                const diffMs = outTime.diff(inTime);
                const totalHours = (diffMs / (1000 * 60 * 60)).toFixed(2);

                await db.execute(
                    'UPDATE attendance SET out_time = ?, total_hours = ? WHERE id = ?',
                    [now, totalHours, existing[0].id]
                );
                clearLockout(userId);
                return res.status(200).json({ success: true, message: 'Check-out successful.' });
            } else {
                return res.status(400).json({ success: false, message: 'Already checked out for today.' });
            }
        } else {
            const attempts = recordFailure(userId);
            await db.execute('INSERT INTO unknown_attempts (confidence) VALUES (?)', [distance]);
            return res.status(400).json({ success: false, message: `Face match failed. Attempt ${attempts}/3.` });
        }
    } catch (error) {
        console.error('Check-out Error:', error);
        res.status(500).json({ message: 'Internal Server Error' });
    }
};

exports.getFaceStatus = async (req, res) => {
    try {
        const { employee_id } = req.params;
        const [rows] = await db.execute('SELECT updated_at FROM face_embeddings WHERE employee_id = ?', [employee_id]);
        
        if (rows.length > 0) {
            res.json({ isRegistered: true, updatedAt: rows[0].updated_at });
        } else {
            res.json({ isRegistered: false });
        }
    } catch (error) {
        res.status(500).json({ message: 'Internal Server Error' });
    }
};
