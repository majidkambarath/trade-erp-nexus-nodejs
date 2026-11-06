const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const t = require("../../controllers/hr/timeController");

// Mounted under /api/v1/hr (routes/hr/hrRoutes.js already runs authenticateToken and holds the hr.* module
// ceiling), so this file names only the role gate on top of that.
const router = express.Router();

// Shifts, the holiday calendar, leave types: organisation-wide setup, read hr.view, write hr.manage - the
// same split Accounting setup's own masters use. Each takes its OWN param name, not :id - the parent
// router (routes/hr/hrRoutes.js) keys router.param("id", ...) to branchOfDocument(Staff), and none of
// these three masters is a Staff document or even branchScoped (the exact collision already caught once
// on /contracts/:id and repeated for statutory-rules/:ruleId and gratuity/:accrualId).
const asId = (req, res, next, param) => { req.params.id = req.params[param]; next(); };

router.get("/shifts", requirePermission("hr.view"), t.listShifts);
router.post("/shifts", requirePermission("hr.manage"), t.createShift);
router.put("/shifts/:shiftId", requirePermission("hr.manage"), (req, res, next) => asId(req, res, next, "shiftId"), t.updateShift);
router.delete("/shifts/:shiftId", requirePermission("hr.manage"), (req, res, next) => asId(req, res, next, "shiftId"), t.removeShift);

router.get("/holidays", requirePermission("hr.view"), t.listHolidays);
router.post("/holidays", requirePermission("hr.manage"), t.createHoliday);
router.delete("/holidays/:holidayId", requirePermission("hr.manage"), (req, res, next) => asId(req, res, next, "holidayId"), t.removeHoliday);

router.get("/leave-types", requirePermission("hr.view"), t.listLeaveTypes);
router.post("/leave-types", requirePermission("hr.manage"), t.createLeaveType);
router.put("/leave-types/:leaveTypeId", requirePermission("hr.manage"), (req, res, next) => asId(req, res, next, "leaveTypeId"), t.updateLeaveType);
router.delete("/leave-types/:leaveTypeId", requirePermission("hr.manage"), (req, res, next) => asId(req, res, next, "leaveTypeId"), t.removeLeaveType);

// The muster: marking a day is its own action (hr.attendance), separate from hr.manage (D2 - "only declare
// what is enforced"; a muster clerk need not be able to redesign shifts or add holidays).
router.post("/attendance", requirePermission("hr.attendance"), t.markAttendance);
router.get("/attendance", requirePermission("hr.attendance"), t.muster);
router.get("/attendance/:day", requirePermission("hr.attendance"), t.forDay);

module.exports = router;
