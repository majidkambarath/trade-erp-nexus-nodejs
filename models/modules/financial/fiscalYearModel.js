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
