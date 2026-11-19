const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A cost centre: a part of the business whose income and costs are reported on their own (a branch of work, a project,
// a vehicle, a department). A MASTER, organisation-wide like the chart: every branch picks from the same list, and the
// ledger rows carry the centre (LedgerEntry.costCentreId). Codes and names are unique within an organisation.
const costCentreSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 12, match: /^[A-Z0-9_-]+$/ },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre", default: null }, // one level of grouping
    notes: { type: String, trim: true, maxlength: 500 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String },
  },
  { timestamps: true }
);

costCentreSchema.index({ companyId: 1, code: 1 }, { unique: true });
costCentreSchema.index({ companyId: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

costCentreSchema.plugin(tenantPlugin);

module.exports = mongoose.models.CostCentre || mongoose.model("CostCentre", costCentreSchema);
