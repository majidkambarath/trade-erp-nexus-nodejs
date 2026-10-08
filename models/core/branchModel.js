// A branch of an organisation. The head office is the first one, made when the organisation is, with the
// code "main" - the same `branchId` every existing document already carries, so nothing is renamed. A
// document stores its branch's `code` as `branchId`.
//
// Scoped by the tenant plugin: inside an organisation you only ever see its own branches.
const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const branchSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    code: {
      type: String, required: true, lowercase: true, trim: true, minlength: 2, maxlength: 20,
      match: [/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "The code may contain only lower-case letters, digits and hyphens"],
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    isHeadOffice: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    address: {
      line1: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      country: { type: String, trim: true, uppercase: true },
    },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

branchSchema.index({ companyId: 1, code: 1 }, { unique: true });
// Exactly one head office per organisation, enforced by the database and not by hope.
branchSchema.index({ companyId: 1 }, { unique: true, partialFilterExpression: { isHeadOffice: true }, name: "one_head_office_per_organisation" });

branchSchema.plugin(tenantPlugin);

module.exports = mongoose.models.Branch || mongoose.model("Branch", branchSchema);
