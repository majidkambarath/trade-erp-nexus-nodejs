const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// Organisation-wide, like LeaveType/Shift - a component is a RULE the organisation defines (PF, ESI,
// professional tax, an overtime allowance...), applied uniformly to every employee paid in a run. Not
// per-employee yet (utils/payroll.js's own header explains why: a generic percent-of-basic/gross shape,
// never a hardcoded tax law).
const salaryComponentSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ["earning", "deduction"], required: true },
    computation: { type: String, enum: ["fixed", "percentOfBasic", "percentOfGross"], required: true },
    // The component's own stored default. Ignored at run time when `statutoryKey` names a dated
    // StatutoryRule row that is actually in force - the rule always wins (utils/payroll.js componentAmount).
    rate: { type: Number, default: null },
    capBase: { type: Number, default: null }, // PF-shaped: the base is capped at this before the % applies
    eligibleUpTo: { type: Number, default: null }, // ESI-shaped: the component does not apply AT ALL above this
    // Each of the three figures above can independently be a DATED StatutoryRule row instead of a stored
    // constant - a wage ceiling is exactly as contested across sources as a rate is (utils/payroll.js's own
    // header). Any key left empty keeps the component's own stored figure.
    statutoryKey: { type: String, trim: true, default: null }, // overrides `rate`
    capBaseKey: { type: String, trim: true, default: null }, // overrides `capBase`
    eligibleUpToKey: { type: String, trim: true, default: null }, // overrides `eligibleUpTo`
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", default: null }, // override; else the posting map's own key
    country: { type: String, trim: true, uppercase: true, default: null }, // optional - only offered in an organisation of this country
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false }, // a seeded starter (StatutoryRule's own "confirm it" pattern)
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Two components of the same name in the same country scope would double-apply with no way to tell them
// apart on a payslip - and it is the real guarantee against the lazy seed's own concurrent-first-read
// race (two requests both seeing none yet and both inserting the starters), the same reasoning
// StatutoryRule's own unique index exists for.
salaryComponentSchema.index({ country: 1, name: 1 }, { unique: true });
salaryComponentSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("SalaryComponent", salaryComponentSchema);
