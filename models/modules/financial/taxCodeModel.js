const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A tax code says HOW a line is taxed, not just at what percentage: zero-rated and exempt supplies
// are both 0% but are reported differently on the VAT return (and on an e-invoice).
const KINDS = ["standard", "zero_rated", "exempt", "out_of_scope", "reverse_charge"];

const taxCodeSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: KINDS, default: "standard" },
    ratePercent: { type: Number, required: true, min: 0, max: 100 },
    // Rate changes over time. The rate that applies is the latest entry dated on or before the
    // document date; ratePercent is the rate when no history entry applies.
    rateHistory: [{ date: { type: Date, required: true }, ratePercent: { type: Number, min: 0, max: 100 }, _id: false }],
    // E-invoicing through Wafeq: why an exempt / out-of-scope supply carries no VAT (DL8.46.1-4, VATEX-AE-OOS) and, on a reverse-charge code,
    // the goods type the buyer declares (DL8.48.8.1 ...). Absent until set.
    exemptionReasonCode: { type: String, trim: true, default: undefined },
    reverseChargeGoodsType: { type: String, trim: true, default: undefined },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

taxCodeSchema.index({ companyId: 1, name: 1 }, { unique: true });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
taxCodeSchema.plugin(tenantPlugin);

// every change a person makes is logged with its old and new values, and a deleted record is kept (utils/auditPlugin.js)
taxCodeSchema.plugin(require("../../../utils/auditPlugin"), { entity: "TaxCode" });
const TaxCode = mongoose.model("TaxCode", taxCodeSchema);
TaxCode.KINDS = KINDS;
module.exports = TaxCode;
