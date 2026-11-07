// The employee self-service portal (D15): its own identity, its own middleware (employeeAuth.js), no
// organisation permission key applies - exempt in utils/__tests__/routeGuard.test.js OTHER_IDENTITY, the
// same reasoning the developer console's router already has. Mounted at /api/v1/employee, separate from
// /api/v1/hr (an Admin's own permissioned door) on purpose: this is never reached with an Admin's token,
// and an Admin's routes are never reached with an employee's.
const express = require("express");
const { authenticateEmployee } = require("../../middleware/employeeAuth");
const p = require("../../controllers/hr/employeePortalController");

const router = express.Router();

router.post("/login", p.login);
router.post("/refresh-token", p.refresh);

router.use(authenticateEmployee);
router.post("/logout", p.logout);
router.put("/change-password", p.changePassword);
router.get("/me", p.me);
router.post("/punch", p.punch);
router.get("/attendance/today", p.todayAttendance);
router.get("/leave-types", p.leaveTypes);
router.get("/leave-requests", p.leaveRequests);
router.get("/leave-requests/balance", p.leaveBalance);
router.post("/leave-requests", p.submitLeaveRequest);
router.post("/leave-requests/:id/cancel", p.cancelLeaveRequest);
router.get("/payslips", p.payslips);

module.exports = router;
