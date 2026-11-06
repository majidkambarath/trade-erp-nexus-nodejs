const StaffService = require("../../services/staff/staffService");
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
