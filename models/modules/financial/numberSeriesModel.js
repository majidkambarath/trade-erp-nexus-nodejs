const mongoose = require("mongoose");

// One counter per {company, branch, series, fiscal year}. Allocation is a single atomic
// $inc (see services/core/numberSeriesService.js), so concurrent requests can never receive
// the same number. Numbers are never reused: a rolled-back transaction leaves a gap.
const numberSeriesSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    series: { type: String, required: true, uppercase: true, trim: true }, // PO SO PR SR RV PV JV CV EV
    fiscalYear: { type: String, required: true }, // "2026"
    prefix: { type: String, required: true, uppercase: true, match: /^[A-Z0-9]{1,5}$/ },
    numberLength: { type: Number, default: 4, min: 3, max: 10 },
    next: { type: Number, default: 0, min: 0 }, // last allocated number
  },
  { timestamps: true }
);

numberSeriesSchema.index(
  { companyId: 1, branchId: 1, series: 1, fiscalYear: 1 },
  { unique: true }
);

module.exports = mongoose.model("NumberSeries", numberSeriesSchema);
