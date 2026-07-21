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
// (Tool schemas omitted for brevity but remain the same)
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
    const startTime = Date.now();
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

// ─── LOCAL RESPONSE FORMATTER ───
function formatLocalResponse(toolName, result, context = {}) {
    if (result && result.error) return `⚠️ Error: ${result.error}`;
    if (result && result.status === 'CONFIRMATION_REQUIRED') return result.message;
    if (result && result.status === 'SUCCESS') return `✅ ${result.message}`;
    
    const currency = context.currency || 'USD';
    const locale = context.locale || 'en-US';
    const curr = (amt) => formatCurrency(amt, currency, locale);

    try {
        switch(toolName) {
            // -- Employee Tools --
            case 'getEmployeeProfile':
                return `👤 **Profile**\nName: ${result.name ?? 'Not Available'}\nDept: ${result.department ?? 'Not Available'}\nBranch: ${result.assigned_branch ?? 'Not Available'}\nStatus: ${result.status ?? 'Not Available'}`;
            case 'getEmployeeAttendance':
                return `📋 **Today's Attendance:**\nStatus: ${result.today?.status ?? 'No record'}\nIn Time: ${result.today?.in_time ?? '--'}\n\n📊 **This Month:**\nPresent: ${result.monthSummary?.present ?? 0} days\nAbsent: ${result.monthSummary?.absent ?? 0} days\nLate: ${result.monthSummary?.late ?? 0} days\nTotal Hours: ${result.monthSummary?.total_hours ?? 0} hrs`;
            case 'getEmployeeSalary':
                const calc = result.calculation || {};
                return `💰 **Salary Accrual (Current Month):**\nGross Earnings: ${curr(calc.grossEarningsSoFar)}\nAdvance Deductions: ${curr(calc.advanceDeduction)}\nUIF Deduction: ${curr(calc.uifDeduction)}\n**Net Salary So Far:** ${curr(calc.netSalarySoFar)}`;
            case 'getEmployeeLeaves':
                const bal = result.balances || {};
                const hist = result.history || [];
                const histStr = hist.length === 0 ? "No records found" : hist.map(h => `- ${h.leave_type}: ${h.days ?? 0} days (${h.status ?? 'N/A'})`).join('\n');
                return `🏖️ **Leave Balance:**\nAnnual: ${bal.annual ?? 0} | Sick: ${bal.sick ?? 0} | Emergency: ${bal.emergency ?? 0} | Unpaid: ${bal.unpaid ?? 0}\n\n📜 **Recent History:**\n${histStr}`;
            case 'getEmployeeClaims':
                const claims = Array.isArray(result) ? result : [];
                if (claims.length === 0) return "No expense claims found.";
                return `🧾 **Expense Claims:**\n` + claims.map(c => `- ${c.claim_type}: ${curr(c.amount)} on ${c.expense_date ?? 'N/A'} (${c.status})`).join('\n');
            case 'getEmployeeKPIs':
                return `📈 **KPI Scores:**\nOverall: ${result.overall_score ?? 0}%\nAttendance Score: ${result.attendance_score ?? 0}%\nTask Score: ${result.task_score ?? 0}%\nRating: ${result.rating ?? 'Not Available'}`;
            case 'getBranchGeofence':
                return `📍 **Assigned Office Geofence:**\nLocation: ${result.name ?? 'Not Available'}\nAddress: ${result.address ?? 'Not Available'}\nRadius: ${result.radius ?? 0} meters`;
            case 'getCompanyHolidays':
                const hols = Array.isArray(result) ? result : [];
                if (hols.length === 0) return "No upcoming holidays found.";
                return `🎉 **Upcoming Holidays:**\n` + hols.map(h => `- **${h.holiday_name}**: ${h.holiday_date}`).join('\n');
                
            // -- Admin Tools --
            case 'getCompanyInfo':
                return `🏢 **Company Info:**\nName: ${result.company_name ?? 'Not Available'}\nOwner: ${result.owner_name ?? 'Not Available'}\nPlan: ${result.plan ?? 'Not Available'}\nStatus: ${result.status ?? 'Not Available'}`;
            case 'getEmployeeStats':
                return `👥 **Employee Statistics:**\nTotal: ${result.total ?? 0}\nActive: ${result.active ?? 0}\nOn Leave: ${result.on_leave ?? 0}`;
            case 'searchEmployees':
                const emps = Array.isArray(result) ? result : [];
                if (emps.length === 0) return "No records found.";
                return `🔍 **Search Results:**\n` + emps.map(e => `- ${e.name} (${e.custom_id ?? 'N/A'}) - ${e.department ?? 'N/A'} [${e.status}]`).join('\n');
            case 'getTodayAttendanceSummary':
                const list = result.lateAbsentList || [];
                const listStr = list.length === 0 ? "None" : list.map(e => e.name).join(', ');
                const st = result.stats || {};
                return `📊 **Today's Summary:**\nTotal: ${st.total ?? 0} | Present: ${st.present ?? 0} | Absent: ${st.absent ?? 0} | Late: ${st.late ?? 0}\n\n⚠️ **Late/Absent Employees:**\n${listStr}`;
            case 'getMonthlyAttendanceSummary':
                return `📅 **Monthly Attendance Overview:**\nTotal Records: ${result.total_records ?? 0}\nUnique Employees Logged In: ${result.unique_employees ?? 0}\nTotal Hours Logged: ${result.total_hours ?? 0} hrs`;
            case 'getPayrollOverview':
                return `💵 **Payroll Overview:**\nTotal Records: ${result.total_records ?? 0}\nPaid: ${result.paid_count ?? 0}\nPending: ${result.pending_count ?? 0}\n**Total Payout:** ${curr(result.total_payout)}`;
            case 'getPendingLeaves':
                const pleaves = Array.isArray(result) ? result : [];
                if (pleaves.length === 0) return "No pending leave requests found.";
                return `⏳ **Pending Leaves:**\n` + pleaves.map(l => `- (ID: ${l.id}) ${l.employee_name} | ${l.leave_type} | ${l.days ?? 0} days`).join('\n');
            case 'getPendingClaims':
                const pclaims = Array.isArray(result) ? result : [];
                if (pclaims.length === 0) return "No pending expense claims found.";
                return `⏳ **Pending Claims:**\n` + pclaims.map(c => `- (ID: ${c.id}) ${c.employee_name} | ${c.claim_type} | ${curr(c.amount)}`).join('\n');
            case 'getKPIScores':
                const kpis = Array.isArray(result) ? result : [];
                if (kpis.length === 0) return "No KPI records found.";
                return `🏆 **Top KPI Scores:**\n` + kpis.map(k => `- ${k.employee_name} (${k.department ?? 'N/A'}): ${k.overall_score ?? 0}% [${k.rating ?? 'N/A'}]`).join('\n');
            case 'getGeofences':
                const geos = Array.isArray(result) ? result : [];
                if (geos.length === 0) return "No geofences found.";
                return `🌐 **Office Geofences:**\n` + geos.map(g => `- ${g.name} (${g.radius ?? 0}m) - ${g.status}`).join('\n');
            case 'getCompanySettings':
                return `⚙️ **Company Settings:**\nBusiness Name: ${result.business_name ?? 'Not Available'}\nSalary Cycle: ${result.salary_cycle ?? 'Not Available'}\nCurrency: ${result.currency ?? 'Not Available'}\nTimezone: ${result.timezone ?? 'Not Available'}`;

            // -- Superadmin Tools --
            case 'getSuperAdminStats':
                return `👑 **Platform Stats:**\nTotal Companies: ${result.totalCompanies ?? 0}\nActive Companies: ${result.activeCompanies ?? 0}\nTotal Revenue: ${curr(result.totalRevenue)}\nActive Subs: ${result.activeSubscriptions ?? 0}\nPending Requests: ${result.pendingPlanRequests ?? 0}`;
            case 'getCompaniesList':
                const comps = Array.isArray(result) ? result : [];
                if (comps.length === 0) return "No records found.";
                return `🏢 **Recent Companies:**\n` + comps.map(c => `- ${c.company_name} | ${c.plan ?? 'N/A'} | ${c.status}`).join('\n');
            case 'getPlanRequests':
                const reqs = Array.isArray(result) ? result : [];
                if (reqs.length === 0) return "No pending plan requests.";
                return `🔔 **Pending Plan Requests:**\n` + reqs.map(r => `- (ID: ${r.id}) ${r.company_name} requested ${r.requested_plan}`).join('\n');
            case 'getPlansList':
                const plans = Array.isArray(result) ? result : [];
                if (plans.length === 0) return "No plans found.";
                return `📦 **Available Plans:**\n` + plans.map(p => `- ${p.name}: ${curr(p.price)} / ${p.duration}`).join('\n');

            case 'applyLeave':
            case 'submitClaim':
            case 'approveRejectLeave':
            case 'approveRejectClaim':
            case 'handlePlanRequest':
                return `✅ Action executed successfully.`;

            default:
                console.warn(`[FormatLocalResponse] Unknown tool name: ${toolName}`);
                return "I found the requested information, but I’m unable to display it correctly right now. Please try again.";
        }
    } catch (err) {
        console.error(`[FormatLocalResponse] Error formatting tool ${toolName}:`, err);
        return "I found the requested information, but I’m unable to display it correctly right now. Please try again.";
    }
}

// ─── MAIN HANDLER ───
exports.handleMessage = async (req, res) => {
    const requestStartTime = Date.now();
    try {
        const { message, context, history } = req.body;
        
        if (!message || !context) {
            return res.status(400).json({ error: 'Message and context are required' });
        }

        const { userRole, currentPage } = context;
        const normalizedRole = userRole ? userRole.toLowerCase() : 'guest';

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Gemini API key is missing.' });
        }

        const authUser = extractUser(req);
        
        // ── Fetch Company Context for Formatting ──
        let companySettings = { currency: 'USD', locale: 'en-US' };
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
            for (const call of functionCalls) {
                const { name, args } = call;
                toolsUsed.push(name);
                
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

                functionResponseParts.push({
                    functionResponse: {
                        name: name,
                        response: (typeof result === 'object' && result !== null && !Array.isArray(result)) ? result : { data: result }
                    }
                });
            }

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
        } else if (response.candidates && response.candidates[0] && response.candidates[0].content) {
            aiText = response.candidates[0].content.parts.map(p => p.text || '').join('');
        }

        const responseTime = Date.now() - requestStartTime;
        console.log(`[Total Request] Entire chatbot request handled in ${responseTime}ms`);
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
