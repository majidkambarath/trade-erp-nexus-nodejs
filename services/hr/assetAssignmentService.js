const AssetAssignment = require("../../models/modules/hr/assetAssignmentModel");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const { isCalendarDay } = require("../../utils/documentExpiry");

/**
 * What is in whose hands - a laptop, a phone, a tool - never a stock movement (see the model's own
 * header). Issue and return are the only two actions; there is no valuation, no depreciation, no write-off.
 */
class AssetAssignmentService {
  /** The organisation-wide register. Joined to the employee's NAME in one extra query, not one per row -
   * the same batch-join AttendanceService.muster already uses. */
  static async list({ staffId, status } = {}) {
    const q = {};
    if (staffId) q.staffId = staffId;
    if (status === "withEmployee") q.returnedDate = null;
    if (status === "returned") q.returnedDate = { $ne: null };
    const rows = await AssetAssignment.find(q).sort({ issuedDate: -1 }).limit(1000).lean();
    const staff = await Staff.find({ _id: { $in: [...new Set(rows.map((r) => String(r.staffId)))] } }).select("name staffId").lean();
    const byId = new Map(staff.map((s) => [String(s._id), s]));
    return rows.map((r) => ({ ...r, staffName: byId.get(String(r.staffId))?.name, staffCode: byId.get(String(r.staffId))?.staffId }));
  }

  static async forStaff(staffId) {
    return AssetAssignment.find({ staffId }).sort({ issuedDate: -1 }).lean();
  }

  static async issue(data, by) {
    if (!data?.staffId) throw new AppError("Choose the employee", 400, "STAFF_REQUIRED");
    if (!String(data?.assetName || "").trim()) throw new AppError("Name the asset", 400, "ASSET_NAME_REQUIRED");
    if (!isCalendarDay(data?.issuedDate)) throw new AppError("Enter the day this was issued", 400, "INVALID_ISSUED_DATE");
    const staff = await Staff.findById(data.staffId).select("_id branchId");
    if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    return AssetAssignment.create({
      staffId: staff._id, branchId: staff.branchId || "main",
      assetName: String(data.assetName).trim(), assetTag: data.assetTag, issuedDate: data.issuedDate,
      condition: data.condition, notes: data.notes, createdBy: by,
    });
  }

  static async markReturned(id, data, by) {
    const row = await AssetAssignment.findById(id);
    if (!row) throw new AppError("Assignment not found", 404, "ASSIGNMENT_NOT_FOUND");
    if (row.returnedDate) throw new AppError("Already marked returned", 409, "ALREADY_RETURNED");
    const returnedDate = data?.returnedDate || (await require("../../utils/documentExpiry").todayInOrg());
    if (!isCalendarDay(returnedDate)) throw new AppError("Enter a real return day", 400, "INVALID_RETURNED_DATE");
    row.returnedDate = returnedDate;
    row.returnCondition = data?.returnCondition;
    row.updatedBy = by;
    await row.save();
    return row;
  }

  static async remove(id) {
    const r = await AssetAssignment.deleteOne({ _id: id });
    if (!r.deletedCount) throw new AppError("Assignment not found", 404, "ASSIGNMENT_NOT_FOUND");
    return { removed: true };
  }
}

module.exports = AssetAssignmentService;
