const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// One counter per {company, branch, series, label}. Allocation is a single atomic $inc (see
// services/core/numberSeriesService.js), so concurrent requests can never receive the same number.
//
// `fiscalYear` holds the LABEL - the middle segment the number prints - and that is deliberately the
// counter's identity, not a key beside it: "same label, same counter" then holds by construction, so two
// documents can never be handed one number. For a series that restarts yearly the label is the fiscal
// year's code (the calendar year before any year is configured); for one that never restarts it is the
// sentinel "ALL" and no year is printed. See utils/voucherTypes.js labelOf.
//
// Whether a deleted number may be given out again is the voucher type's choice, and the record of what
// was issued, released or retired is models/modules/financial/issuedNumberModel.js - not this row.
const numberSeriesSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    series: { type: String, required: true, uppercase: true, trim: true }, // PO SO PR SR RV PV JV CV EV
    fiscalYear: { type: String, required: true }, // the printed label: "2026", or "ALL" when continuous
    // A branch's prefix carries its code in front ("SHJ-SO"), so this is never the 1-5 plain characters
    // it was first declared as. That mismatch has been live all along and only passed unnoticed because
    // findOneAndUpdate does not run validators; the first .save() or runValidators on a branch row would
    // have thrown. Widened to what prefixFor and a configured prefix can actually produce.
    prefix: { type: String, required: true, uppercase: true, match: /^[A-Z0-9][A-Z0-9/-]{0,31}$/ },
    numberLength: { type: Number, default: 4, min: 3, max: 10 },
    next: { type: Number, default: 0, min: 0 }, // last allocated number
  },
  { timestamps: true }
);

numberSeriesSchema.index(
  { companyId: 1, branchId: 1, series: 1, fiscalYear: 1 },
  { unique: true }
);

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
numberSeriesSchema.plugin(tenantPlugin);

module.exports = mongoose.model("NumberSeries", numberSeriesSchema);
