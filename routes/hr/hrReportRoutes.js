const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const c = require("../../controllers/hr/hrReportController");

// Mounted under /api/v1/hr (routes/hr/hrRoutes.js already ran authenticateToken and holds the hr.* module
// ceiling), so this file names only the role gate on top of that - the same split every HR route takes.
//
// Both routes take QUERY parameters and no path parameter at all, which is deliberate: the parent router
// keys router.param("id", branchOfDocument(Staff)), so a `:id` here would try to load a report's argument
// as a Staff document - the collision already caught once on /contracts/:id and worked around by name in
// complianceRoutes.js. Having nothing to collide with is better than working around it again.
const router = express.Router();

// A period's muster per employee. hr.attendance, the same gate the muster list itself takes - a report of
// it must not be an easier door than the screen it summarises.
router.get("/reports/attendance", requirePermission("hr.attendance"), c.attendance);

// Everybody's leave balance on a day. hr.leave, matching GET /leave-requests/balance for one person.
router.get("/reports/leave-balances", requirePermission("hr.leave"), c.leaveBalances);

module.exports = router;
