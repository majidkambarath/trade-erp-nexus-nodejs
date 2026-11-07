// The employee self-service portal (D15): its own identity, its own middleware (employeeAuth.js), no
// organisation permission key applies - exempt in utils/__tests__/routeGuard.test.js OTHER_IDENTITY, the
// same reasoning the developer console's router already has. Mounted at /api/v1/employee, separate from
// /api/v1/hr (an Admin's own permissioned door) on purpose: this is never reached with an Admin's token,
// and an Admin's routes are never reached with an employee's.
const express = require("express");
const { authenticateEmployee } = require("../../middleware/employeeAuth");
const { loginThrottle } = require("../../middleware/loginThrottle");
const p = require("../../controllers/hr/employeePortalController");

const router = express.Router();

// Per-ADDRESS, in front of the per-account lockout EmployeeUser.reserveAttempt already provides. Both are
// needed and neither covers the other: the account lock stops a thousand guesses at ONE phone number, this
// stops one address walking through a thousand phone numbers, each with its own fresh five-try budget.
//
// FAILURES ONLY (loginThrottle, not the flat rateLimit the developer console uses), and that distinction
// matters more here than anywhere else in the product: a portal is signed into from a shared tablet at the
// factory gate, so a limit that counted SUCCESSFUL sign-ins would refuse the eleventh worker of the morning.
// Its own buckets, so a script hammering the admin door can never lock the workforce out of theirs.
const EMPLOYEE_LOGIN_FAILURES = Number(process.env.EMPLOYEE_LOGIN_LIMIT) || 20;
const portalLoginThrottle = loginThrottle({ max: EMPLOYEE_LOGIN_FAILURES, what: "sign-in attempts" });
// A failed renewal is the other way to probe this door - a refresh token is guessed here, not a password.
// Higher, and failures-only too, because every page load renews (the access token is held in memory).
const portalRefreshThrottle = loginThrottle({ max: Number(process.env.EMPLOYEE_REFRESH_LIMIT) || 100, what: "session renewals" });

router.post("/login", portalLoginThrottle, p.login);
router.post("/refresh-token", portalRefreshThrottle, p.refresh);

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
