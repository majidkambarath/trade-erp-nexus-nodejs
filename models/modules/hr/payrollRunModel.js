const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * One row per period paid, organisation-wide (D14: ONE operation posting many branches' worth of entries
 * at once, the same shape a fiscal year's closing entry already uses, numbered through the series `PAY`).
 * This row's own `_id` IS the ledger entries' `voucherId` (VoucherAuditService.postingTrail's "payroll"
 * kind reads this model by that id, the same pattern production, gratuity and a closing entry already
 * use). Claimed once per period by a unique index: a second attempt at an already-posted period is refused
 * before anything is computed twice.
 */
const payrollRunSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ }, // "YYYY-MM"
    payDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    status: { type: String, enum: ["POSTED", "REVERSED"], default: "POSTED" },
    employeeCount: { type: Number, default: 0 },
    totalGross: { type: Number, required: true },
    totalEarnings: { type: Number, required: true },
    totalDeductions: { type: Number, required: true },
    totalNet: { type: Number, required: true },
    voucherNo: { type: String }, // the PAY series number
    acknowledged: [{ type: String }], // the warning codes ticked past at post time
    postedAt: { type: Date, default: Date.now },
    postedBy: { type: String },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: String, default: null },
    reverseReason: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: String },
  },
  { timestamps: true }
);

// Unlike gratuity's incremental-delta design (where a mistake is corrected by the NEXT month's figure),
// a payroll period genuinely needs to be re-runnable after a correction - an employee missed, a wrong
// rate - without the following month's payslips carrying last month's catch-up. So the unique claim is
// partial, on POSTED rows only: a reversed run frees the period for a fresh one. Equality, not $ne
// (CLAUDE.md's own measured finding: $ne is refused in a partialFilterExpression on this cluster).
payrollRunSchema.index({ period: 1 }, { unique: true, partialFilterExpression: { status: "POSTED" } });

// NOT branchScoped: one run pays every branch's employees at once (D14), per-employee detail is the
// Payslip rows below, which ARE branch scoped.
payrollRunSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("PayrollRun", payrollRunSchema);
