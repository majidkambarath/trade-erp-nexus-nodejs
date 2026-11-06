const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// One per employee per run - the per-employee detail the ledger deliberately does not carry (D11's
// reasoning, reused for payroll: the ledger only needs to be right in total). branchScoped to the
// employee's OWN branch, even though the run that produced it is organisation-wide.
const payslipSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    runId: { type: mongoose.Schema.Types.ObjectId, ref: "PayrollRun", required: true },
    period: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    staffName: { type: String, trim: true, maxlength: 120 },
    basicPay: { type: Number, required: true },
    grossPay: { type: Number, required: true },
    earnings: [{ _id: false, componentId: { type: mongoose.Schema.Types.ObjectId, ref: "SalaryComponent" }, name: String, amount: Number }],
    deductions: [{ _id: false, componentId: { type: mongoose.Schema.Types.ObjectId, ref: "SalaryComponent" }, name: String, amount: Number }],
    totalEarnings: { type: Number, required: true },
    totalDeductions: { type: Number, required: true },
    netPay: { type: Number, required: true },
    proratedFactor: { type: Number, default: 1 }, // < 1 for a mid-period joiner or leaver
  },
  { timestamps: true }
);

payslipSchema.index({ runId: 1, staffId: 1 }, { unique: true });
payslipSchema.index({ staffId: 1, period: 1 });
payslipSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("Payslip", payslipSchema);
