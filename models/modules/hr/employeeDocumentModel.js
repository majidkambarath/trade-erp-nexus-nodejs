const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// An employee's own KYC: a labour card, a visa, a passport, a driving permit - whatever an organisation
// tracks the expiry of. A SEPARATE collection, not an embedded array on Staff (services/hr/
// labourCostService.js's expiredDocumentsFor already reads it this way since wave 1 - `mongoose.models.
// EmployeeDocument`, keyed by `staffId` - so this model follows that existing contract rather than the
// embedded-array shape Customer/Vendor documents use; services/masters/documentExpiryService.js is
// extended to read this collection as a third kind alongside customer/vendor, not to force it into their
// shape).
const employeeDocumentSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    documentTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "DocumentType", default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    number: { type: String, trim: true, maxlength: 80 },
    expiryDate: { type: Date, default: null },
    attachmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Attachment", default: null },
    notes: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

employeeDocumentSchema.index({ staffId: 1 });
employeeDocumentSchema.index({ expiryDate: 1 });
employeeDocumentSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("EmployeeDocument", employeeDocumentSchema);
