const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * One generic dated row for ANY statutory figure (D10) - gratuity's days-per-year and cap, the
 * Emiratisation fine and quota percentage, and whatever wave 4's payroll packs need (the PF ceiling, the
 * ESI threshold). Deliberately one model, not one per rule: `utils/compliance.js` `ruleOn` is the same
 * "latest row in force on a day" lookup `EmployeeContract`/`utils/hr.js` already proved for a cost rate,
 * generalised from "this employee's pay" to "this country's rule".
 *
 * WHY THIS EXISTS AT ALL: the research behind this module found every number contested across sources -
 * the UAE's own gratuity cap, India's PF ceiling, the Emiratisation fine, all given as two different
 * figures by sources that each looked authoritative. A row with an effective date means correcting one is
 * an edit, not a release; a figure this product never treats as settled is a figure an administrator can
 * fix the week it changes.
 */
const statutoryRuleSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    country: { type: String, required: true, trim: true, uppercase: true, maxlength: 2 }, // "AE", "IN"
    key: { type: String, required: true, trim: true }, // e.g. "ae.gratuity.capYears"
    value: { type: Number, required: true },
    unit: { type: String, trim: true, maxlength: 40 }, // "days", "years", "AED/month", "%" - for the screen only
    effectiveFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    effectiveTo: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    notes: { type: String, trim: true, maxlength: 500 },
    // Seeded defaults are marked, so the Setup screen can say "this is the product's own default - confirm
    // it" rather than looking identical to a figure the organisation's own accountant entered.
    isSystem: { type: Boolean, default: false },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// One row per key per start day - a second row for the same key on the same day is a double entry, the
// same reasoning EmployeeContract's own unique index already states.
statutoryRuleSchema.index({ country: 1, key: 1, effectiveFrom: 1 }, { unique: true });
statutoryRuleSchema.index({ country: 1, key: 1, effectiveFrom: -1 });

// NOT branchScoped: a statutory rule belongs to the whole organisation (its country, not its branch), the
// same reasoning the chart of accounts and tax codes are organisation-wide while documents are per branch.
statutoryRuleSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("StatutoryRule", statutoryRuleSchema);
