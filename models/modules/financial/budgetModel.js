const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A budget: an amount per income or expense account per month of one fiscal year, for the whole business or for one cost centre.
// Organisation-wide like the chart. One budget per year per cost centre: `scopeKey` is the centre's id, or "all" for the whole
// business, so the unique index holds whether or not a centre is named. Rules in utils/budgets.js, service budgetService.js.
const budgetSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    fiscalYearId: { type: mongoose.Schema.Types.ObjectId, ref: "FiscalYear", required: true },
    costCentreId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre" }, // absent = the whole business
    scopeKey: { type: String, required: true },
    notes: { type: String, trim: true, maxlength: 500 },
    lines: [
      {
        _id: false,
        accountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
        amounts: { type: mongoose.Schema.Types.Mixed, default: {} }, // { "2026-04": 1000, ... } natural side, never negative
      },
    ],
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true, minimize: false }
);

budgetSchema.index({ companyId: 1, fiscalYearId: 1, scopeKey: 1 }, { unique: true });

budgetSchema.plugin(tenantPlugin);

// every change a person makes is logged with its old and new values, and a deleted record is kept (utils/auditPlugin.js)
budgetSchema.plugin(require("../../../utils/auditPlugin"), { entity: "Budget" });
module.exports = mongoose.models.Budget || mongoose.model("Budget", budgetSchema);
