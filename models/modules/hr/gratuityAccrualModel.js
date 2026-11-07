const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * One row per month the gratuity accrual ran, organisation-wide (D11: ONE journal for everyone, never one
 * per employee). This row's own `_id` IS the ledger entries' `voucherId` - the same pattern a production or
 * a year's closing entry already uses (`VoucherAuditService.postingTrail`'s "gratuity" kind reads this
 * model by that id).
 *
 * Claimed once per month by a unique index on `month` (D14's "the same compare-and-set pattern
 * markVoucherNumbersHeld and the closing-entry claim already use"): a second attempt at the same month
 * finds the row already there and refuses, so the accrual can never double-post.
 */
const gratuityAccrualSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ }, // "YYYY-MM", the organisation's calendar
    // The liability as it stood the moment this ran, and the amount posted - the DIFFERENCE from last
    // month's cumulative figure, which is what makes a correction next month simply a smaller or larger
    // line rather than a double-post.
    amount: { type: Number, required: true },
    cumulativeLiability: { type: Number, required: true },
    employeeCount: { type: Number, default: 0 },
    voucherNo: { type: String }, // the GRJ series number
    postedAt: { type: Date, default: Date.now },
    postedBy: { type: String },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: String, default: null },
    reverseReason: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: String },
  },
  { timestamps: true }
);

gratuityAccrualSchema.index({ month: 1 }, { unique: true }); // claimed once per month, organisation-wide

// NOT branchScoped: this is one accrual for the whole organisation (per-employee detail lives in a report,
// never the ledger - D11), the same reasoning a fiscal year's closing entry is organisation-wide.
gratuityAccrualSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("GratuityAccrual", gratuityAccrualSchema);
