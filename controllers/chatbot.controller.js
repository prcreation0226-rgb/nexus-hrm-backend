const { GoogleGenAI } = require('@google/genai');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const NodeCache = require('node-cache');
const chatbotService = require('./chatbot.service');

// Initialize Cache - 5 minutes TTL
const aiCache = new NodeCache({ stdTTL: 300 });

// ─── Helper: Extract user from JWT ───
function extractUser(req) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return null;
        const token = authHeader.split(' ')[1];
        if (!token) return null;
        return jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// Map Tool names to Service handler functions
const toolHandlers = {
    getEmployeeProfile: chatbotService.getEmployeeProfile,
    getEmployeeAttendance: chatbotService.getEmployeeAttendance,
    getEmployeeSalary: chatbotService.getEmployeeSalary,
    getEmployeeLeaves: chatbotService.getEmployeeLeaves,
    applyLeave: chatbotService.applyLeave,
    getEmployeeClaims: chatbotService.getEmployeeClaims,
    submitClaim: chatbotService.submitClaim,
    getEmployeeKPIs: chatbotService.getEmployeeKPIs,
    getBranchGeofence: chatbotService.getBranchGeofence,
    getCompanyHolidays: chatbotService.getCompanyHolidays,
    getCompanyInfo: chatbotService.getCompanyInfo,
    getEmployeeStats: chatbotService.getEmployeeStats,
    searchEmployees: chatbotService.searchEmployees,
    checkSpecificEmployeeAttendance: chatbotService.checkSpecificEmployeeAttendance,
    getTodayAttendanceSummary: chatbotService.getTodayAttendanceSummary,
    getMonthlyAttendanceSummary: chatbotService.getMonthlyAttendanceSummary,
    getPayrollOverview: chatbotService.getPayrollOverview,
    getPendingLeaves: chatbotService.getPendingLeaves,
    approveRejectLeave: chatbotService.approveRejectLeave,
    getPendingClaims: chatbotService.getPendingClaims,
    approveRejectClaim: chatbotService.approveRejectClaim,
    getKPIScores: chatbotService.getKPIScores,
    getGeofences: chatbotService.getGeofences,
    getCompanySettings: chatbotService.getCompanySettings,
    getSuperAdminStats: chatbotService.getSuperAdminStats,
    getCompaniesList: chatbotService.getCompaniesList,
    getPlanRequests: chatbotService.getPlanRequests,
    handlePlanRequest: chatbotService.handlePlanRequest,
    getPlansList: chatbotService.getPlansList
};

// ─── Gemini Tool / Function Declarations ───
const employeeTools = [
    { name: 'getEmployeeProfile', description: 'Get profile details for the logged-in employee', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getEmployeeAttendance', description: 'Get attendance status for the logged-in employee', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getEmployeeSalary', description: 'Get live current month salary accrual for the logged-in employee', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getEmployeeLeaves', description: 'Get leave balances and history for the logged-in employee', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'applyLeave', description: 'Submit leave request', parameters: { type: 'OBJECT', properties: { leave_type: { type: 'STRING' }, start_date: { type: 'STRING' }, end_date: { type: 'STRING' }, days: { type: 'NUMBER' }, reason: { type: 'STRING' }, isConfirmed: { type: 'BOOLEAN' } }, required: ['leave_type', 'start_date', 'end_date', 'days'] } },
    { name: 'getEmployeeClaims', description: 'Get expense claims history', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'submitClaim', description: 'Submit expense claim', parameters: { type: 'OBJECT', properties: { claim_type: { type: 'STRING' }, amount: { type: 'NUMBER' }, expense_date: { type: 'STRING' }, description: { type: 'STRING' }, isConfirmed: { type: 'BOOLEAN' } }, required: ['claim_type', 'amount', 'expense_date'] } },
    { name: 'getEmployeeKPIs', description: 'Get KPI scores', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getBranchGeofence', description: 'Get assigned geofence', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getCompanyHolidays', description: 'Get list of holidays', parameters: { type: 'OBJECT', properties: {} } }
];

const adminTools = [
    { name: 'getCompanyInfo', description: 'Get company basic details', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getEmployeeStats', description: 'Get employee counts', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'searchEmployees', description: 'Search employees or list all employees if no query is provided', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } } } },
    { name: 'checkSpecificEmployeeAttendance', description: 'Check if a specific employee is present today', parameters: { type: 'OBJECT', properties: { employee_identifier: { type: 'STRING', description: 'The name or ID of the employee to check' } }, required: ['employee_identifier'] } },
    { name: 'getTodayAttendanceSummary', description: 'Get today\'s present/absent/late counts', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getMonthlyAttendanceSummary', description: 'Get aggregated attendance records for current month', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getPayrollOverview', description: 'Get total payroll count', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getPendingLeaves', description: 'Get list of all pending leave requests', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'approveRejectLeave', description: 'Approve or Reject leave request', parameters: { type: 'OBJECT', properties: { leave_id: { type: 'NUMBER' }, action: { type: 'STRING' }, isConfirmed: { type: 'BOOLEAN' } }, required: ['leave_id', 'action'] } },
    { name: 'getPendingClaims', description: 'Get list of pending expense claims', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'approveRejectClaim', description: 'Approve or Reject claim request', parameters: { type: 'OBJECT', properties: { claim_id: { type: 'NUMBER' }, action: { type: 'STRING' }, isConfirmed: { type: 'BOOLEAN' } }, required: ['claim_id', 'action'] } },
    { name: 'getKPIScores', description: 'Get top employee KPI scores', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getGeofences', description: 'Get office geofences', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getCompanySettings', description: 'Get company settings', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getCompanyHolidays', description: 'Get upcoming company public holidays', parameters: { type: 'OBJECT', properties: {} } }
];

const superadminTools = [
    { name: 'getSuperAdminStats', description: 'Get platform-wide overview', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getCompaniesList', description: 'Get list of recently registered tenant companies', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'getPlanRequests', description: 'Get pending plan renewal requests', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'handlePlanRequest', description: 'Accept or Reject plan request', parameters: { type: 'OBJECT', properties: { request_id: { type: 'NUMBER' }, action: { type: 'STRING' }, isConfirmed: { type: 'BOOLEAN' } }, required: ['request_id', 'action'] } },
    { name: 'getPlansList', description: 'Get available subscription plans', parameters: { type: 'OBJECT', properties: {} } }
];

async function generateContentFast(ai, params) {
    try {
        const res = await ai.models.generateContent(params);
        return res;
    } catch (err) {
        throw err;
    }
}

function formatCurrency(amount, currency = 'USD', locale = 'en-US') {
    const num = amount ?? 0;
    try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency: currency }).format(num);
    } catch(e) {
        return `${currency} ${num}`;
    }
}

// ─── LOCAL RESPONSE FORMATTER (ANTI-HALLUCINATION & INSTANT RENDERING) ───
function formatLocalResponse(toolName, result, context = {}) {
    if (!result) return "No records found for your request.";
    if (result.error) return `⚠️ ${result.error}`;
    if (result.status === 'CONFIRMATION_REQUIRED') return result.message;
    if (result.status === 'SUCCESS') return `✅ ${result.message}`;
    
    const currency = context.currency || 'USD';
    const locale = context.locale || 'en-US';
    const curr = (amt) => formatCurrency(amt, currency, locale);

    try {
        switch(toolName) {
            // -- Employee Tools --
            case 'getEmployeeProfile':
                const profLines = [
                    `👤 **Employee Profile**`,
                    `- **Name:** ${result.name ?? 'Not Available'}`,
                    `- **Custom ID:** ${result.custom_id ?? 'N/A'}`
                ];
                if (result.department && result.department !== 'General' && result.department !== 'Not Available') {
                    profLines.push(`- **Department:** ${result.department}`);
                }
                if (result.assigned_branch && result.assigned_branch !== 'Not Available' && result.assigned_branch !== 'General') {
                    profLines.push(`- **Branch:** ${result.assigned_branch}`);
                }
                profLines.push(`- **Status:** ${result.status ?? 'Active'}`);
                profLines.push(`- **Joined Date:** ${result.joined_date ? String(result.joined_date).slice(0, 10) : 'N/A'}`);
                profLines.push(`- **Shift:** ${result.shift ?? 'Standard'}`);
                return profLines.join('\n');

            case 'getEmployeeAttendance':
                const userMsgAtt = (context.userMessage || '').toLowerCase();
                const todayStatus = result.today?.status ? result.today.status.toUpperCase() : 'No clock-in record today';
                const todayIn = result.today?.in_time ?? '--';
                const todayOut = result.today?.out_time ?? '--';
                const m = result.monthSummary || {};

                // 1. Specific Check-out query ("am I checked out today?", "check out time", "nikla", "out time")
                if (/check(ed)?\s*out|out\s*time|checkout|gaya|nikla/i.test(userMsgAtt)) {
                    if (todayOut && todayOut !== '--') {
                        return `✅ Yes, you have checked out today at **${todayOut}** (Clocked in: ${todayIn}, Total: ${result.today?.total_hours ?? 0} hrs).`;
                    } else if (todayIn && todayIn !== '--') {
                        return `⏳ No, you are currently clocked in (since **${todayIn}**), but you have NOT checked out yet today (Total hours logged so far: ${result.today?.total_hours ?? 0} hrs).`;
                    } else {
                        return `❌ No, you have not clocked in or checked out today.`;
                    }
                }

                // 2. Specific Check-in / In-time query ("what time did I clock in?", "in time", "check in", "aaya")
                if (/check\s*in|in\s*time|checkin|aaya|clock\s*in|login\s*time/i.test(userMsgAtt)) {
                    if (todayIn && todayIn !== '--') {
                        return `⏱️ You clocked in today at **${todayIn}** (Status: ${todayStatus}).`;
                    } else {
                        return `❌ You have not clocked in today.`;
                    }
                }

                // 3. Today-only query ("today attendance", "aaj ki hajri")
                if (/today|aaj/i.test(userMsgAtt)) {
                    return `📋 **Today's Attendance:**\n- **Status:** ${todayStatus}\n- **In Time:** ${todayIn} | **Out Time:** ${todayOut}`;
                }

                // 4. Default: Full summary if user asked for general attendance / monthly overview
                return `📋 **Today's Attendance Status:**\n- **Status:** ${todayStatus}\n- **In Time:** ${todayIn} | **Out Time:** ${todayOut}\n\n📊 **This Month's Summary:**\n- ✅ **Present:** ${m.present ?? 0} days\n- ❌ **Absent:** ${m.absent ?? 0} days\n- ⚠️ **Late:** ${m.late ?? 0} days\n- ⏱️ **Total Hours:** ${m.total_hours ?? 0} hrs`;

            case 'getEmployeeSalary':
                const userMsgSal = (context.userMessage || '').toLowerCase();
                const calc = result.calculation || {};
                const netSal = calc.netSalarySoFar ?? 0;
                const grossEar = calc.grossEarningsSoFar ?? 0;
                const advDed = calc.advanceDeduction ?? 0;
                const uifDed = calc.uifDeduction ?? 0;

                if (/net|kitna milega|hath me|hand|payout/i.test(userMsgSal)) {
                    return `💵 Your net salary accrued so far this month is **${curr(netSal)}** (after deductions).`;
                }

                return `💰 **Salary Accrual (Current Month):**\n- **Gross Earnings:** ${curr(grossEar)}\n- **Advance Deductions:** ${curr(advDed)}\n- **Tax/UIF Deductions:** ${curr(uifDed)}\n- 💵 **Net Salary So Far:** ${curr(netSal)}`;

            case 'getEmployeeLeaves':
                const userMsgLeave = (context.userMessage || '').toLowerCase();
                const bal = result.balances || {};
                const hist = Array.isArray(result.history) ? result.history : [];

                if (/balance|remaining|left|kitni chutti|kitna leave|available/i.test(userMsgLeave)) {
                    return `🏖️ **Your Current Leave Balances:**\n- **Annual:** ${bal.annual ?? 0} days\n- **Sick:** ${bal.sick ?? 0} days\n- **Emergency:** ${bal.emergency ?? 0} days\n- **Unpaid:** ${bal.unpaid ?? 0} days`;
                }

                const histStr = hist.length === 0 ? "No recent leave records found." : hist.map(h => `- ${h.leave_type}: ${h.days ?? 0} days (${h.status ?? 'N/A'})`).join('\n');
                return `🏖️ **Leave Balance:**\n- **Annual:** ${bal.annual ?? 0} days\n- **Sick:** ${bal.sick ?? 0} days\n- **Emergency:** ${bal.emergency ?? 0} days\n- **Unpaid:** ${bal.unpaid ?? 0} days\n\n📜 **Recent Leave History:**\n${histStr}`;

            case 'getEmployeeClaims':
                const claims = Array.isArray(result) ? result : [];
                if (claims.length === 0) return "🧾 **Expense Claims:** No expense claims found.";
                return `🧾 **Expense Claims:**\n` + claims.map(c => `- **${c.claim_type}**: ${curr(c.amount)} on ${c.expense_date ? String(c.expense_date).slice(0, 10) : 'N/A'} [Status: ${c.status}]`).join('\n');

            case 'getEmployeeKPIs':
                return `📈 **KPI Scores:**\n- **Overall Score:** ${result.overall_score ?? 0}%\n- **Attendance Score:** ${result.attendance_score ?? 0}%\n- **Task Performance:** ${result.task_score ?? 0}%\n- **Rating:** ${result.rating ?? 'Not Available'}`;

            case 'getBranchGeofence':
                return `📍 **Assigned Office Geofence:**\n- **Branch Name:** ${result.name ?? 'Not Assigned'}\n- **Address:** ${result.address ?? 'Not Available'}\n- **Radius:** ${result.radius ?? 0} meters`;

            case 'getCompanyHolidays':
                const hols = Array.isArray(result) ? result : [];
                if (hols.length === 0) return "🎉 **Company Holidays:** No upcoming holidays found.";
                return `🎉 **Upcoming Company Holidays:**\n` + hols.map(h => `- **${h.holiday_name}**: ${h.holiday_date ? String(h.holiday_date).slice(0, 10) : 'N/A'}`).join('\n');
                
            // -- Admin Tools --
            case 'getCompanyInfo':
                return `🏢 **Company Information:**\n- **Company Name:** ${result.company_name ?? 'Not Available'}\n- **Owner:** ${result.owner_name ?? 'Not Available'}\n- **Plan:** ${result.plan ?? 'Not Available'}\n- **Status:** ${result.status ?? 'Active'}\n- **Employee Limit:** ${result.employee_limit ?? 'Unlimited'}`;

            case 'getEmployeeStats':
                return `👥 **Company Employee Statistics:**\n- **Total Employees:** ${result.total ?? 0}\n- **Active Employees:** ${result.active ?? 0}\n- **On Leave:** ${result.on_leave ?? 0}`;

            case 'searchEmployees':
                const emps = Array.isArray(result) ? result : [];
                if (emps.length === 0) return "🔍 **Search Results:** No matching employees found.";
                return `🔍 **Employee Search Results:**\n` + emps.map(e => {
                    const deptStr = (e.department && e.department !== 'General' && e.department !== 'Not Available') ? ` - Dept: ${e.department}` : '';
                    return `- **${e.name}** (ID: ${e.custom_id ?? 'N/A'})${deptStr} [Status: ${e.status ?? 'Active'}]`;
                }).join('\n');

            case 'checkSpecificEmployeeAttendance':
                if (result.error) return `⚠️ ${result.error}`;
                const userMsgEmpAtt = (context.userMessage || '').toLowerCase();
                const empName = result.employee_name || 'Employee';
                const statusStr = result.attendance?.status ? result.attendance.status.toUpperCase() : 'ABSENT / NOT LOGGED IN';
                const inT = result.attendance?.in_time ?? '--';
                const outT = result.attendance?.out_time ?? '--';

                if (/check(ed)?\s*out|out\s*time|checkout|gaya|nikla/i.test(userMsgEmpAtt)) {
                    if (outT && outT !== '--') {
                        return `✅ Yes, **${empName}** checked out today at **${outT}**.`;
                    } else if (inT && inT !== '--') {
                        return `⏳ No, **${empName}** is clocked in (since **${inT}**), but has NOT checked out yet today.`;
                    } else {
                        return `❌ **${empName}** has not clocked in or checked out today.`;
                    }
                }

                return `👤 **Attendance Status for ${empName}:**\n- **Today's Status:** ${statusStr}\n- **Clock In:** ${inT} | **Clock Out:** ${outT}`;

            case 'getTodayAttendanceSummary':
                const st = result.stats || {};
                const list = Array.isArray(result.lateAbsentList) ? result.lateAbsentList : [];
                const listStr = list.length === 0 ? "None (All present)" : list.map(e => e.name).join(', ');
                return `📊 **Today's Attendance Overview:**\n- **Total Employees:** ${st.total ?? 0}\n- ✅ **Present:** ${st.present ?? 0}\n- ❌ **Absent:** ${st.absent ?? 0}\n- ⚠️ **Late:** ${st.late ?? 0}\n\n⚠️ **Late/Absent Employee List:**\n${listStr}`;

            case 'getMonthlyAttendanceSummary':
                return `📅 **Monthly Attendance Overview:**\n- **Total Attendance Records:** ${result.total_records ?? 0}\n- **Unique Employees Active:** ${result.unique_employees ?? 0}\n- ⏱️ **Total Hours Logged:** ${result.total_hours ?? 0} hrs`;

            case 'getPayrollOverview':
                return `💵 **Payroll Overview:**\n- **Total Records:** ${result.total_records ?? 0}\n- ✅ **Paid Count:** ${result.paid_count ?? 0}\n- ⏳ **Pending Count:** ${result.pending_count ?? 0}\n- 💰 **Total Payout:** ${curr(result.total_payout ?? 0)}`;

            case 'getPendingLeaves':
                const pleaves = Array.isArray(result) ? result : [];
                if (pleaves.length === 0) return "⏳ **Pending Leave Requests:** No pending leave requests found.";
                return `⏳ **Pending Leave Requests:**\n` + pleaves.map(l => `- **ID ${l.id}**: ${l.employee_name} | Type: ${l.leave_type} | Duration: ${l.days ?? 0} days`).join('\n');

            case 'getPendingClaims':
                const pclaims = Array.isArray(result) ? result : [];
                if (pclaims.length === 0) return "⏳ **Pending Expense Claims:** No pending expense claims found.";
                return `⏳ **Pending Expense Claims:**\n` + pclaims.map(c => `- **ID ${c.id}**: ${c.employee_name} | Type: ${c.claim_type} | Amount: ${curr(c.amount ?? 0)}`).join('\n');

            case 'getKPIScores':
                const kpis = Array.isArray(result) ? result : [];
                if (kpis.length === 0) return "🏆 **Top KPI Scores:** No KPI records found.";
                return `🏆 **Top KPI Scores:**\n` + kpis.map(k => `- **${k.employee_name}** (${k.department ?? 'N/A'}): ${k.overall_score ?? 0}% [Rating: ${k.rating ?? 'N/A'}]`).join('\n');

            case 'getGeofences':
                const geos = Array.isArray(result) ? result : [];
                if (geos.length === 0) return "🌐 **Office Geofences:** No office geofences configured.";
                return `🌐 **Office Geofences:**\n` + geos.map(g => `- **${g.name}** (Radius: ${g.radius ?? 0}m) - Status: ${g.status}`).join('\n');

            case 'getCompanySettings':
                return `⚙️ **Company Settings:**\n- **Business Name:** ${result.business_name ?? 'Not Available'}\n- **Salary Cycle:** ${result.salary_cycle ?? 'Monthly'}\n- **Currency:** ${result.currency ?? 'USD'}\n- **Timezone:** ${result.timezone ?? 'UTC'}`;

            // -- Superadmin Tools --
            case 'getSuperAdminStats':
                return `👑 **Platform Overview:**\n- **Total Companies:** ${result.totalCompanies ?? 0}\n- **Active Subscriptions:** ${result.activeSubscriptions ?? 0}\n- **Total Revenue:** ${curr(result.totalRevenue ?? 0)}\n- ⏳ **Pending Plan Requests:** ${result.pendingPlanRequests ?? 0}`;

            case 'getCompaniesList':
                const comps = Array.isArray(result) ? result : [];
                if (comps.length === 0) return "🏢 **Registered Companies:** No tenant companies found.";
                return `🏢 **Recent Registered Companies:**\n` + comps.map(c => `- **${c.company_name}** | Plan: ${c.plan ?? 'N/A'} | Status: ${c.status ?? 'Active'}`).join('\n');

            case 'getPlanRequests':
                const reqs = Array.isArray(result) ? result : [];
                if (reqs.length === 0) return "🔔 **Pending Plan Requests:** No pending plan requests.";
                return `🔔 **Pending Plan Requests:**\n` + reqs.map(r => `- **ID ${r.id}**: Company: ${r.company_name} requested ${r.requested_plan}`).join('\n');

            case 'getPlansList':
                const plans = Array.isArray(result) ? result : [];
                if (plans.length === 0) return "📦 **Subscription Plans:** No plans available.";
                return `📦 **Available Subscription Plans:**\n` + plans.map(p => `- **${p.name}**: ${curr(p.price ?? 0)} / ${p.duration ?? 'monthly'}`).join('\n');

            case 'applyLeave':
            case 'submitClaim':
            case 'approveRejectLeave':
            case 'approveRejectClaim':
            case 'handlePlanRequest':
                return `ℹ️ **Read-Only Mode:** To perform actions (apply leaves, submit claims, approve/reject requests), please use the dedicated buttons in the HRM portal.`;

            default:
                console.warn(`[FormatLocalResponse] Tool '${toolName}' defaulted.`);
                return "I found the requested information, but no detailed template was available. Please try again.";
        }
    } catch (err) {
        console.error(`[FormatLocalResponse] Error formatting tool ${toolName}:`, err);
        return "Unable to format requested information at this time. Please try again.";
    }
}

// Export for unit tests
exports.formatLocalResponse = formatLocalResponse;

// ─── MAIN HANDLER ───
exports.handleMessage = async (req, res) => {
    const requestStartTime = Date.now();
    try {
        const { message, context, history } = req.body;
        
        if (!message || !context) {
            return res.status(400).json({ error: 'Message and context are required' });
        }

        const { userRole } = context;
        const normalizedRole = userRole ? userRole.toLowerCase() : 'guest';

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Gemini API key is missing.' });
        }

        const authUser = extractUser(req);
        
        // ── Fetch Company Context for Formatting ──
        let companySettings = { currency: 'USD', locale: 'en-US', userMessage: message };
        if (authUser && authUser.company_id) {
            try {
                const [settingsRows] = await db.execute('SELECT currency FROM settings WHERE company_id = ? LIMIT 1', [authUser.company_id]);
                if (settingsRows.length > 0 && settingsRows[0].currency) {
                    companySettings.currency = settingsRows[0].currency;
                    if (companySettings.currency === 'INR') companySettings.locale = 'en-IN';
                    if (companySettings.currency === 'EUR') companySettings.locale = 'en-GB';
                }
            } catch (err) {
                console.error("Failed to fetch company context", err.message);
            }
        }

        const isActionQuery = /apply|submit|approve|reject|confirm|yes|accept/i.test(message);
        const cacheKey = `${normalizedRole}_${authUser?.id || 'guest'}_${message.trim().toLowerCase()}`;
        
        if (!isActionQuery) {
            const cachedVal = aiCache.get(cacheKey);
            if (cachedVal) {
                return res.json({ text: cachedVal, cached: true });
            }
        }

        let systemPrompt = '';
        try {
            const path = require('path');
            if (normalizedRole === 'employee') {
                systemPrompt = require(path.join(__dirname, '../prompts/employee.prompt.js'));
            } else if (normalizedRole === 'admin' || normalizedRole === 'hr admin') {
                systemPrompt = require(path.join(__dirname, '../prompts/admin.prompt.js'));
            } else if (normalizedRole === 'superadmin' || normalizedRole.includes('master')) {
                systemPrompt = require(path.join(__dirname, '../prompts/superadmin.prompt.js'));
            } else {
                systemPrompt = 'You are a helpful assistant for Kiaan HRM.';
            }
        } catch (e) {
            systemPrompt = 'You are a helpful assistant for Kiaan HRM.';
        }

        if (/policy|rules|handbook/i.test(message) && (normalizedRole === 'employee' || normalizedRole === 'admin' || normalizedRole === 'hr admin')) {
            const policies = chatbotService.getCompanyPolicies();
            systemPrompt += `\n\nKNOWLEDGE BASE (Company Policies):\n${policies}`;
        }

        const contents = [];
        
        function appendTurn(role, text) {
            if (!text) return;
            const lastTurn = contents[contents.length - 1];
            if (lastTurn && lastTurn.role === role) {
                lastTurn.parts[0].text += `\n\n${text}`;
            } else {
                contents.push({ role: role, parts: [{ text: text }] });
            }
        }

        appendTurn('user', `[SYSTEM ARCHITECTURE & PERSONAL PERSONA/RULES]\n${systemPrompt}`);
        appendTurn('model', "Understood. I will act as the virtual assistant according to these instructions, persona rules, and tools.");

        if (Array.isArray(history)) {
            history.slice(-4).forEach(msg => {
                const role = msg.role === 'model' ? 'model' : 'user';
                appendTurn(role, msg.content);
            });
        }

        appendTurn('user', message);

        let allowedTools = [];
        if (normalizedRole === 'employee') {
            allowedTools = employeeTools;
        } else if (normalizedRole === 'admin' || normalizedRole === 'hr admin') {
            allowedTools = adminTools;
        } else if (normalizedRole === 'superadmin' || normalizedRole.includes('master')) {
            allowedTools = superadminTools;
        }

        const ai = new GoogleGenAI({ apiKey });
        const modelName = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

        // ── Gemini Call Step 1 (Intent & Tool Selection) ──
        let response = await generateContentFast(ai, {
            model: modelName,
            contents: contents,
            config: {
                tools: allowedTools.length > 0 ? [{ functionDeclarations: allowedTools }] : undefined
            }
        });

        let functionCalls = response.functionCalls || [];
        const toolsUsed = [];
        let aiText = "I'm sorry, I couldn't process that.";

        if (functionCalls.length > 0) {
            contents.push({
                role: 'model',
                parts: response.candidates[0].content.parts
            });

            const functionResponseParts = [];
            let lastToolResult = null;
            let lastToolName = null;

            for (const call of functionCalls) {
                const { name, args } = call;
                toolsUsed.push(name);
                lastToolName = name;
                
                let result;
                const dbStartTime = Date.now();
                try {
                    const handler = toolHandlers[name];
                    if (handler) {
                        result = await handler(authUser, args);
                    } else {
                        result = { error: `Tool handler '${name}' not implemented.` };
                    }
                } catch (err) {
                    result = { error: err.message };
                }
                const dbTime = Date.now() - dbStartTime;
                console.log(`[Database Query] Tool '${name}' executed in ${dbTime}ms`);
                lastToolResult = result;

                functionResponseParts.push({
                    functionResponse: {
                        name: name,
                        response: (typeof result === 'object' && result !== null && !Array.isArray(result)) ? result : { data: result }
                    }
                });
            }

            // Determine if user explicitly requested complex reasoning/analysis
            const isComplexQuery = /analyze|analysis|why|insight|explain|recommend|trend|reason/i.test(message);

            if (!isComplexQuery && functionCalls.length === 1 && lastToolName) {
                // ── FAST PATH: Local Response Formatter (1.5 - 2.5s Latency) ──
                aiText = formatLocalResponse(lastToolName, lastToolResult, companySettings);
            } else {
                // ── REASONING PATH: Gemini Step 2 Call for Analytical Queries ──
                contents.push({
                    role: 'user',
                    parts: functionResponseParts
                });

                response = await generateContentFast(ai, {
                    model: modelName,
                    contents: contents,
                    config: {
                        tools: allowedTools.length > 0 ? [{ functionDeclarations: allowedTools }] : undefined
                    }
                });

                if (response.candidates && response.candidates[0] && response.candidates[0].content) {
                    aiText = response.candidates[0].content.parts.map(p => p.text || '').join('');
                }
            }
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
            aiText = response.candidates[0].content.parts.map(p => p.text || '').join('');
        }

        const responseTime = Date.now() - requestStartTime;
        console.log(`[Total Request] Chatbot request handled in ${responseTime}ms using tools: ${toolsUsed.join(', ') || 'none'}`);
        const tokensUsed = response.usageMetadata?.totalTokenCount || 0;

        if (!isActionQuery && aiText) {
            aiCache.set(cacheKey, aiText);
        }

        try {
            await db.execute(
                `INSERT INTO ai_logs (user_id, company_id, role, prompt, response, tools_used, tokens_used, response_time_ms) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    authUser?.id || null,
                    authUser?.company_id || null,
                    normalizedRole,
                    message,
                    aiText,
                    toolsUsed.join(', ') || null,
                    tokensUsed,
                    responseTime
                ]
            );
        } catch (logErr) {
            console.error("AI Logging Failed:", logErr.message);
        }

        res.json({ text: aiText });
    } catch (err) {
        console.error("Chatbot Error:", err.message || err);
        const errMsg = err.message || '';
        if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota')) {
            return res.status(429).json({ 
                error: "AI is temporarily busy due to high usage. Please try again in a few seconds.",
                retryAfter: 30
            });
        }
        res.status(500).json({ error: "AI Engine encountered an error.", details: errMsg });
    }
};
