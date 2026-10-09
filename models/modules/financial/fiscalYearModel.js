const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

const fiscalYearSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    code: { type: String, required: true, uppercase: true, trim: true, maxlength: 20 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // closed = nothing may be created, edited, deleted or reversed inside the period.
    status: { type: String, enum: ["open", "closed"], default: "open" },
    closedAt: { type: Date },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    // What closing the year did (services/financial/yearEndService.js). Absent on a year that is open, and on one closed
    // before year-end closing existed, which was only a lock: it moved no profit to equity.
    closing: {
      type: new mongoose.Schema(
        {
          voucherId: { type: mongoose.Schema.Types.ObjectId }, // the id its ledger entries carry (new at each closing, so a year closed twice reverses only the live entries)
          voucherNo: { type: String }, // the closing entry; absent when there was nothing to close or posting was off
          date: { type: Date },
          income: { type: Number },
          expenses: { type: Number },
          profit: { type: Number }, // income less expenses, a loss is negative
          accounts: { type: Number }, // how many income and expense accounts were taken to zero
          retainedAccountId: { type: mongoose.Schema.Types.ObjectId },
          retainedAccountName: { type: String },
          posted: { type: Boolean, default: false }, // false: the year was only locked (posting off, or nothing to close)
          nextYear: { type: String }, // the code of the year that follows
          nextYearCreated: { type: Boolean, default: false },
          acknowledged: [{ type: String }], // the warnings the person accepted
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

fiscalYearSchema.index({ companyId: 1, code: 1 }, { unique: true });
fiscalYearSchema.index({ companyId: 1, startDate: 1, endDate: 1 });

fiscalYearSchema.pre("validate", function (next) {
  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    return next(new Error("Fiscal year end date must be after its start date"));
  }
  next();
});

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
fiscalYearSchema.plugin(tenantPlugin);

module.exports = mongoose.model("FiscalYear", fiscalYearSchema);
