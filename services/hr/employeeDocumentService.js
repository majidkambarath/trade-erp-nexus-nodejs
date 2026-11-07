const EmployeeDocument = require("../../models/modules/hr/employeeDocumentModel");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const { isCalendarDay } = require("../../utils/documentExpiry");

/**
 * An employee's own KYC register (labour card, visa, passport...) - what W1's expiry-blocks-assignment
 * check (services/hr/labourCostService.js expiredDocumentsFor) already reads, and what the organisation's
 * combined expiry report (services/masters/documentExpiryService.js) now reads as a third kind beside
 * customer and vendor documents.
 *
 * Not built: uploading the file itself through this screen - a record is created without one, or linked
 * to an attachment made elsewhere (AttachmentService's own door). The register's job is the DATE, which is
 * what blocks work assignment and what the expiry report reads; the paper copy is secondary to that.
 */
class EmployeeDocumentService {
  static async forStaff(staffId) {
    return EmployeeDocument.find({ staffId }).sort({ expiryDate: 1 }).lean();
  }

  static async create(data, by) {
    if (!data?.staffId) throw new AppError("Choose the employee", 400, "STAFF_REQUIRED");
    if (!String(data?.name || "").trim()) throw new AppError("Name the document", 400, "NAME_REQUIRED");
    if (data.expiryDate && !isCalendarDay(data.expiryDate)) throw new AppError("Enter a real expiry day", 400, "INVALID_EXPIRY");
    const staff = await Staff.findById(data.staffId).select("_id");
    if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    return EmployeeDocument.create({
      staffId: staff._id, documentTypeId: data.documentTypeId || null,
      name: String(data.name).trim(), number: data.number, expiryDate: data.expiryDate || null,
      notes: data.notes, createdBy: by,
    });
  }

  static async update(id, data, by) {
    const set = { updatedBy: by };
    if ("name" in data) { if (!String(data.name || "").trim()) throw new AppError("Name the document", 400, "NAME_REQUIRED"); set.name = String(data.name).trim(); }
    if ("number" in data) set.number = data.number;
    if ("notes" in data) set.notes = data.notes;
    if ("expiryDate" in data) {
      if (data.expiryDate && !isCalendarDay(data.expiryDate)) throw new AppError("Enter a real expiry day", 400, "INVALID_EXPIRY");
      set.expiryDate = data.expiryDate || null;
    }
    const row = await EmployeeDocument.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true });
    if (!row) throw new AppError("Document not found", 404, "DOCUMENT_NOT_FOUND");
    return row;
  }

  static async remove(id) {
    const r = await EmployeeDocument.deleteOne({ _id: id });
    if (!r.deletedCount) throw new AppError("Document not found", 404, "DOCUMENT_NOT_FOUND");
    return { removed: true };
  }
}

module.exports = EmployeeDocumentService;
