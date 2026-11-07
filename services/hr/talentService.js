const StaffChecklistItem = require("../../models/modules/hr/staffChecklistModel");
const Appraisal = require("../../models/modules/hr/appraisalModel");
const Staff = require("../../models/modules/staffModel");
const EmployeeContract = require("../../models/modules/hr/employeeContractModel");
const AppError = require("../../utils/AppError");
const talent = require("../../utils/talent");
const hr = require("../../utils/hr");

/**
 * Onboarding and exit checklists (W6, D16 as actually built - see staffChecklistModel.js's own header
 * for why this is a small dedicated model rather than CrmActivity rows), and a plain appraisal. The
 * smallest wave on purpose: no scoring algorithm, no calibration workflow, no Setup screen for the
 * checklist's own items (they are a sensible default, edited per row like any other task).
 */
class ChecklistService {
  static async start({ staffId, listType, dueAt }, by) {
    const items = talent.standardItems(listType);
    if (!items) throw new AppError("Choose onboarding or exit", 400, "INVALID_LIST_TYPE");
    const staff = await Staff.findById(staffId).select("_id name branchId");
    if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    const rows = await StaffChecklistItem.insertMany(
      items.map((subject) => ({
        staffId: staff._id, staffName: staff.name, branchId: staff.branchId || "main",
        listType, subject, dueAt: dueAt || null, ownerId: by, createdBy: by,
      }))
    );
    return rows;
  }

  static forStaff(staffId) {
    return StaffChecklistItem.find({ staffId }).sort({ listType: 1, createdAt: 1 }).lean();
  }

  static async addItem({ staffId, listType, subject, dueAt }, by) {
    if (!talent.LIST_TYPES.includes(listType)) throw new AppError("Choose onboarding or exit", 400, "INVALID_LIST_TYPE");
    if (!String(subject || "").trim()) throw new AppError("Name the item", 400, "SUBJECT_REQUIRED");
    const staff = await Staff.findById(staffId).select("_id name branchId");
    if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    return StaffChecklistItem.create({
      staffId: staff._id, staffName: staff.name, branchId: staff.branchId || "main",
      listType, subject: String(subject).trim(), dueAt: dueAt || null, ownerId: by, createdBy: by,
    });
  }

  static async markDone(id, by) {
    const row = await StaffChecklistItem.findById(id);
    if (!row) throw new AppError("Item not found", 404, "ITEM_NOT_FOUND");
    if (row.status !== "OPEN") throw new AppError("Already settled", 409, "NOT_OPEN");
    row.status = "DONE";
    row.completedAt = new Date();
    row.completedBy = by;
    await row.save();
    return row;
  }

  static async remove(id) {
    const r = await StaffChecklistItem.deleteOne({ _id: id });
    if (!r.deletedCount) throw new AppError("Item not found", 404, "ITEM_NOT_FOUND");
    return { removed: true };
  }
}

class AppraisalService {
  static async create(data, by) {
    const errors = talent.validateAppraisal(data);
    if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code, { errors, field: errors[0].field });
    const staff = await Staff.findById(data.staffId).select("_id name");
    if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    return Appraisal.create({
      staffId: staff._id, staffName: staff.name, periodLabel: String(data.periodLabel).trim(),
      reviewDate: data.reviewDate, reviewerId: by, reviewerName: data.reviewerName,
      strengths: data.strengths, improvements: data.improvements, goals: data.goals, rating: data.rating,
      createdBy: by,
    });
  }

  static forStaff(staffId) {
    return Appraisal.find({ staffId }).sort({ reviewDate: -1 }).lean();
  }

  /** The appraisal plus the pay history in force around it, read-only - "what were they paid when" is
   * context for a reviewer, never edited from here (a raise is still its own event on the employee's own
   * Contract & cost rate tab). Pay figures are stripped the same way contractService.list already strips
   * them for a reader without hr.confidential - this reuses that exact list, not a second copy of the rule. */
  static async withContext(staffId, { confidential } = {}) {
    const [appraisals, contracts] = await Promise.all([
      this.forStaff(staffId),
      confidential
        ? EmployeeContract.find({ staffId }).select("effectiveFrom effectiveTo +basicPay +allowances").sort({ effectiveFrom: -1 }).lean()
        : [],
    ]);
    const contractOn = (day) => (confidential ? hr.contractOn(contracts, day) : null);
    return appraisals.map((a) => {
      const c = contractOn(a.reviewDate);
      return {
        ...a,
        payAtReview: c && confidential ? { basicPay: c.basicPay, allowances: c.allowances } : undefined,
      };
    });
  }
}

module.exports = { ChecklistService, AppraisalService };
