const StaffService = require("../../services/staff/staffService");
const EmployeeAuthService = require("../../services/hr/employeeAuthService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");
const { uploadFields } = require("../../middleware/upload");

// HRMS's own door onto the Staff collection, gated on hr.* rather than staff.* - the old /staff/staff routes
// keep working for the legacy screen (controllers/staff/staffController.js), and this is the NEW, separately
// permissioned surface the HRMS workspace reads and writes. Both doors are counted against the same
// `employees` limit (StaffService.createStaff calls UsageService.assertEmployeeRoom itself, not the route),
// so an organisation cannot add its 51st employee through whichever door is less guarded.
const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const describe = (e) => `${e.name} (${e.designation || "employee"})`;

exports.list = catchAsync(async (req, res) => ok(res, await StaffService.getAllStaff(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await StaffService.getStaffById(req.params.id)));
exports.stats = catchAsync(async (req, res) => ok(res, await StaffService.getStaffStats()));

exports.create = catchAsync((req, res, next) => {
  uploadFields([{ name: "idProof", maxCount: 1 }, { name: "addressProof", maxCount: 1 }])(req, res, async (err) => {
    if (err) return next(err);
    try {
      const employee = await StaffService.createStaff(req.body, req.files, by(req));
      await AuditService.log({ req, action: "EMPLOYEE_CREATED", entity: "Staff", entityId: employee._id, summary: `Added ${describe(employee)}` });
      ok(res, employee, 201);
    } catch (error) {
      next(error);
    }
  });
});

exports.update = catchAsync((req, res, next) => {
  uploadFields([{ name: "idProof", maxCount: 1 }, { name: "addressProof", maxCount: 1 }])(req, res, async (err) => {
    if (err) return next(err);
    try {
      const employee = await StaffService.updateStaff(req.params.id, req.body, req.files, by(req));
      await AuditService.log({ req, action: "EMPLOYEE_UPDATED", entity: "Staff", entityId: employee._id, summary: `Updated ${describe(employee)}` });
      ok(res, employee);
    } catch (error) {
      next(error);
    }
  });
});

exports.remove = catchAsync(async (req, res) => {
  await StaffService.deleteStaff(req.params.id);
  await AuditService.log({ req, action: "EMPLOYEE_DELETED", entity: "Staff", entityId: req.params.id, summary: "Removed an employee" });
  ok(res, { deleted: true });
});

// D15: setting up or resetting the employee's OWN sign-in to the self-service portal - a door HR holds,
// never a password HR learns (setAccount hashes it the moment it is saved, the same as every account's own).
exports.portalStatus = catchAsync(async (req, res) => ok(res, await EmployeeAuthService.statusFor(req.params.id)));
exports.setPortalAccount = catchAsync(async (req, res) => {
  const row = await EmployeeAuthService.setAccount({ staffId: req.params.id, phone: req.body?.phone, password: req.body?.password }, by(req));
  await AuditService.log({ req, action: "EMPLOYEE_PORTAL_SET", entity: "EmployeeUser", entityId: row._id, summary: `Portal access set for employee ${req.params.id}` });
  ok(res, { phone: row.phone, status: row.status }, 201);
});
exports.disablePortalAccount = catchAsync(async (req, res) => {
  await EmployeeAuthService.disable(req.params.id);
  await AuditService.log({ req, action: "EMPLOYEE_PORTAL_DISABLED", entity: "EmployeeUser", entityId: req.params.id, summary: `Portal access disabled for employee ${req.params.id}` });
  ok(res, { disabled: true });
});
