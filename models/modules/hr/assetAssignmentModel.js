const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// What was issued to an employee - a laptop, a phone, a tool - and when it came back. Deliberately NOT
// the stock/inventory module: that tracks SALEABLE stock with cost and valuation; this tracks a thing the
// organisation already owns that is simply in somebody's hands, with no cost basis or stock movement
// implied. branchScoped like Staff (an asset is issued to a person who belongs to one branch).
const assetAssignmentSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    assetName: { type: String, required: true, trim: true, maxlength: 120 },
    assetTag: { type: String, trim: true, maxlength: 80 }, // a serial number or asset code, if the organisation keeps one
    issuedDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    condition: { type: String, trim: true, maxlength: 200 }, // noted at issue, and again at return
    returnedDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    returnCondition: { type: String, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

assetAssignmentSchema.index({ staffId: 1, returnedDate: 1 });
assetAssignmentSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("AssetAssignment", assetAssignmentSchema);
