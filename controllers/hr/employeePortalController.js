// The employee's own self-service door (D15). Every handler below works on `req.employeeStaffId` ONLY -
// whatever a body or query names is overridden, never trusted, so one employee can never read or touch
// another's attendance, leave or payslip. This is the boundary that matters most on this surface.
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const EmployeeAuthService = require("../../services/hr/employeeAuthService");
const Staff = require("../../models/modules/staffModel");
const AttendanceService = require("../../services/hr/attendanceService");
const LeaveRequestService = require("../../services/hr/leaveRequestService");
const PayrollService = require("../../services/hr/payrollService");
const { LeaveTypeService } = require("../../services/hr/timeSetupService");
const rules = require("../../utils/attendance");
const { todayInOrg } = require("../../utils/documentExpiry");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const SESSION_COOKIE = "erp_employee_session";
const SESSION_PATH = "/api/v1/employee";

function cookieOptions(expires) {
  const production = process.env.NODE_ENV === "production";
  const sameSite = process.env.SESSION_COOKIE_SAMESITE || (production ? "none" : "lax");
  return { httpOnly: true, secure: production || sameSite === "none", sameSite, path: SESSION_PATH, ...(expires ? { expires } : {}) };
}

function sendSession(res, session, status = 200) {
  const { refreshToken, ...rest } = session;
  res.cookie(SESSION_COOKIE, refreshToken, cookieOptions(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)));
  ok(res, rest, status);
}

exports.login = catchAsync(async (req, res) => {
  const session = await EmployeeAuthService.login(req.body?.phone, req.body?.password, req.ip);
  sendSession(res, session);
});

exports.refresh = catchAsync(async (req, res) => {
  const session = await EmployeeAuthService.refresh(req.cookies?.[SESSION_COOKIE]);
  sendSession(res, session);
});

exports.logout = catchAsync(async (req, res) => {
  await EmployeeAuthService.logout(req.employeeUser._id);
  res.clearCookie(SESSION_COOKIE, { path: SESSION_PATH });
  ok(res, { loggedOut: true });
});

exports.changePassword = catchAsync(async (req, res) => {
  const session = await EmployeeAuthService.changePassword(req.employeeUser._id, req.body || {});
  sendSession(res, session);
});

// The profile: name, designation, department, joining date - never a cost rate or pay figure. That data
// lives behind hr.confidential for an HR person; an employee reading their own file is a different
// permission question entirely and this route answers neither by using StaffService's own door.
exports.me = catchAsync(async (req, res) => {
  const staff = await Staff.findById(req.employeeStaffId).select("name staffId designation department joiningDate contactNo email").lean();
  if (!staff) throw new AppError("Employee record not found", 404, "STAFF_NOT_FOUND");
  // mustChangePassword lives on EmployeeUser, not Staff - carried here so a page RELOAD (not just a
  // fresh login) still knows to hold the person at the change-password screen rather than forgetting
  // the moment the login response is gone.
  ok(res, { ...staff, mustChangePassword: req.employeeUser.mustChangePassword });
});

// A punch: today's own day only, real check-in/check-out only - never a manual status, and never a day
// in the past (the muster's own backdating belongs to hr.attendance, not self-service).
exports.punch = catchAsync(async (req, res) => {
  const day = todayInOrg();
  const data = { staffId: req.employeeStaffId, day, checkIn: req.body?.checkIn, checkOut: req.body?.checkOut, source: "self" };
  const errors = rules.validateAttendanceRow(data);
  if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code);
  const row = await AttendanceService.markDay(data, req.employeeStaffId);
  ok(res, row, 201);
});

exports.todayAttendance = catchAsync(async (req, res) => {
  const rows = await AttendanceService.muster({ from: todayInOrg(), to: todayInOrg(), staffId: req.employeeStaffId });
  ok(res, rows[0] || null);
});

// Just enough to fill the submit form's picker - name and accrual rate, nothing an organisation would
// treat as sensitive, and read-only.
exports.leaveTypes = catchAsync(async (req, res) => ok(res, await LeaveTypeService.list()));

exports.leaveRequests = catchAsync(async (req, res) => ok(res, await LeaveRequestService.list({ staffId: req.employeeStaffId, status: req.query.status })));

exports.leaveBalance = catchAsync(async (req, res) => ok(res, await LeaveRequestService.balance(req.employeeStaffId, req.query.leaveTypeId, { day: req.query.day })));

exports.submitLeaveRequest = catchAsync(async (req, res) => {
  const row = await LeaveRequestService.submit({ ...req.body, staffId: req.employeeStaffId }, req.employeeStaffId);
  ok(res, row, 201);
});

exports.cancelLeaveRequest = catchAsync(async (req, res) => {
  const row = await LeaveRequestService.get(req.params.id);
  if (!row || String(row.staffId) !== req.employeeStaffId) throw new AppError("Request not found", 404, "REQUEST_NOT_FOUND");
  ok(res, await LeaveRequestService.cancel(req.params.id, req.employeeStaffId));
});

exports.payslips = catchAsync(async (req, res) => ok(res, await PayrollService.payslipsForStaff(req.employeeStaffId)));
