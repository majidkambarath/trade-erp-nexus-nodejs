const { ShiftService, HolidayService, LeaveTypeService, DepartmentService } = require("../../services/hr/timeSetupService");
const AttendanceService = require("../../services/hr/attendanceService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// Shifts.
exports.listShifts = catchAsync(async (req, res) => ok(res, await ShiftService.list()));
exports.createShift = catchAsync(async (req, res) => {
  const row = await ShiftService.create(req.body, by(req));
  await AuditService.log({ req, action: "SHIFT_CREATED", entity: "Shift", entityId: row._id, summary: row.name });
  ok(res, row, 201);
});
exports.updateShift = catchAsync(async (req, res) => {
  const row = await ShiftService.update(req.params.id, req.body, by(req));
  await AuditService.log({ req, action: "SHIFT_UPDATED", entity: "Shift", entityId: row._id, summary: row.name });
  ok(res, row);
});
exports.removeShift = catchAsync(async (req, res) => {
  await ShiftService.remove(req.params.id);
  await AuditService.log({ req, action: "SHIFT_DELETED", entity: "Shift", entityId: req.params.id, summary: "Shift removed" });
  ok(res, { removed: true });
});

// Holiday calendar.
exports.listHolidays = catchAsync(async (req, res) => ok(res, await HolidayService.list(req.query)));
exports.createHoliday = catchAsync(async (req, res) => {
  const row = await HolidayService.create(req.body, by(req));
  await AuditService.log({ req, action: "HOLIDAY_CREATED", entity: "HolidayCalendar", entityId: row._id, summary: `${row.day}: ${row.name}` });
  ok(res, row, 201);
});
exports.removeHoliday = catchAsync(async (req, res) => {
  await HolidayService.remove(req.params.id);
  await AuditService.log({ req, action: "HOLIDAY_DELETED", entity: "HolidayCalendar", entityId: req.params.id, summary: "Holiday removed" });
  ok(res, { removed: true });
});

// Leave types.
exports.listLeaveTypes = catchAsync(async (req, res) => ok(res, await LeaveTypeService.list()));
exports.createLeaveType = catchAsync(async (req, res) => {
  const row = await LeaveTypeService.create(req.body, by(req));
  await AuditService.log({ req, action: "LEAVE_TYPE_CREATED", entity: "LeaveType", entityId: row._id, summary: row.name });
  ok(res, row, 201);
});
exports.updateLeaveType = catchAsync(async (req, res) => {
  const row = await LeaveTypeService.update(req.params.id, req.body, by(req));
  await AuditService.log({ req, action: "LEAVE_TYPE_UPDATED", entity: "LeaveType", entityId: row._id, summary: row.name });
  ok(res, row);
});
exports.removeLeaveType = catchAsync(async (req, res) => {
  await LeaveTypeService.remove(req.params.id);
  await AuditService.log({ req, action: "LEAVE_TYPE_DELETED", entity: "LeaveType", entityId: req.params.id, summary: "Leave type removed" });
  ok(res, { removed: true });
});

// Departments.
exports.listDepartments = catchAsync(async (req, res) => ok(res, await DepartmentService.list()));
exports.createDepartment = catchAsync(async (req, res) => {
  const row = await DepartmentService.create(req.body, by(req));
  await AuditService.log({ req, action: "DEPARTMENT_CREATED", entity: "Department", entityId: row._id, summary: row.name });
  ok(res, row, 201);
});
exports.updateDepartment = catchAsync(async (req, res) => {
  const row = await DepartmentService.update(req.params.departmentId, req.body, by(req));
  await AuditService.log({ req, action: "DEPARTMENT_UPDATED", entity: "Department", entityId: row._id, summary: row.name });
  ok(res, row);
});
exports.removeDepartment = catchAsync(async (req, res) => {
  await DepartmentService.remove(req.params.departmentId);
  await AuditService.log({ req, action: "DEPARTMENT_DELETED", entity: "Department", entityId: req.params.departmentId, summary: "Department removed" });
  ok(res, { removed: true });
});

// Attendance (the muster). Marking a day is hr.attendance, not hr.manage - the same reason Add and Edit
// are separate permissions app-wide: someone who runs the muster need not be able to redesign shifts.
exports.markAttendance = catchAsync(async (req, res) => {
  const row = await AttendanceService.markDay(req.body, by(req));
  ok(res, row, 201);
});
exports.muster = catchAsync(async (req, res) => ok(res, await AttendanceService.muster(req.query)));
exports.forDay = catchAsync(async (req, res) => ok(res, await AttendanceService.forDay(req.params.day)));
