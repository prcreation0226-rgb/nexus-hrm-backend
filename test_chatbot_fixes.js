const db = require('./config/db');
const chatbotController = require('./controllers/chatbot.controller');
const chatbotService = require('./controllers/chatbot.service');

// A mock res object
const mockRes = () => {
    const res = {};
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (data) => { res.data = data; return res; };
    return res;
};

async function runTests() {
    console.log("=== RUNNING CHATBOT TESTS ===\n");
    let passed = 0;
    let failed = 0;

    const assert = (condition, msg) => {
        if (condition) {
            console.log(`✅ PASS: ${msg}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${msg}`);
            failed++;
        }
    };

    // 1. Zero/Null Values Formatting Test
    // For this, we'll extract the formatLocalResponse logic to test it directly.
    const ctrlSource = require('fs').readFileSync('./controllers/chatbot.controller.js', 'utf8');
    const formatFnStr = ctrlSource.match(/function formatLocalResponse[\s\S]*?\n\}/)[0];
    const formatCurrencyStr = ctrlSource.match(/function formatCurrency[\s\S]*?\n\}/)[0];
    eval(formatCurrencyStr + '\n' + formatFnStr); // creates formatLocalResponse globally in this scope

    console.log("--- Formatting Tests ---");
    let res1 = formatLocalResponse('getEmployeeAttendance', { monthSummary: { present: null, absent: null, late: 0, total_hours: null } }, {});
    assert(res1.includes("Present: 0 days"), "Null numeric converts to 0");
    assert(res1.includes("Total Hours: 0 hrs"), "Null total_hours converts to 0");

    let res2 = formatLocalResponse('getPayrollOverview', { total_records: null, total_payout: null }, { currency: 'INR' });
    assert(res2.includes("Total Payout:"), "Handles null payout gracefully");
    assert(!res2.includes("Not Available"), "Numeric fields do not say 'Not Available'");

    let res3 = formatLocalResponse('getEmployeeLeaves', { balances: null, history: [] }, {});
    assert(res3.includes("Annual: 0"), "Null object property ?? 0 works");
    assert(res3.includes("No records found"), "Empty array renders as 'No records found'");

    let res4 = formatLocalResponse('unknownToolThatDoesNotExist', {}, {});
    assert(res4 === "I found the requested information, but I’m unable to display it correctly right now. Please try again.", "Unknown tool triggers safe fallback instead of raw JSON");

    console.log("\n--- Isolation Tests ---");
    // We will verify the SQL queries structure using regex or direct logic since we already fixed them.
    const serviceSource = require('fs').readFileSync('./controllers/chatbot.service.js', 'utf8');
    assert(serviceSource.includes("WHERE employee_id = ? AND company_id = ?"), "Employee isolation strictly uses employee_id AND company_id");
    assert(serviceSource.match(/getEmployeeAttendance[\s\S]*?enforceRole\(user, \['employee'\]\)/), "Employee attendance enforces 'employee' role");
    assert(serviceSource.match(/getCompanyInfo[\s\S]*?enforceRole\(user, \['admin', 'hr admin'\]\)/), "Admin tools enforce 'admin' role");

    console.log("\n--- SQL Coalesce Tests ---");
    assert(serviceSource.includes("COALESCE(SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END), 0)"), "COALESCE applied to SUM");
    assert(!serviceSource.includes("COALESCE(COUNT(*)"), "COUNT does not use redundant COALESCE");

    console.log(`\nTests Completed: ${passed} Passed, ${failed} Failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests();
