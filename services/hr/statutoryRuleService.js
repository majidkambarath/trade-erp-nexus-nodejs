const StatutoryRule = require("../../models/modules/hr/statutoryRuleModel");
const AppError = require("../../utils/AppError");
const compliance = require("../../utils/compliance");
const orgLocale = require("../../utils/orgLocale");
const { isCalendarDay, addDays, todayInOrg } = require("../../utils/documentExpiry");

/**
 * The dated-rule rows every later compliance figure reads (D10). ONE generic model, seeded lazily with the
 * research's own highest-consensus defaults - marked `isSystem` so the screen can say "this is our default,
 * confirm it" rather than looking like a figure the organisation's own accountant entered.
 *
 * THE RESEARCH FOUND EVERY ONE OF THESE CONTESTED. Seeded here is the reading with the widest agreement
 * across sources at the time this was built (6 Nov 2026) - not a claim that it is correct today. Before a
 * live gratuity accrual or payroll run, the organisation's own accountant (and, for Emiratisation, its own
 * reading of the current MOHRE schedule) confirms every figure below.
 */
const SEED = {
  AE: [
    ["ae.gratuity.firstBandDaysPerYear", 21, "days/year", "Federal Decree-Law No. 33 of 2021, Art. 51 - first five years"],
    ["ae.gratuity.firstBandYears", 5, "years", "the band boundary Art. 51 draws"],
    ["ae.gratuity.secondBandDaysPerYear", 30, "days/year", "Art. 51 - after five years"],
    ["ae.gratuity.capYears", 2, "years' wage", "Art. 51's stated cap"],
    ["ae.gratuity.minServiceDaysForEntitlement", 365, "days", "one year of service, below which nothing is due"],
    // Given as both AED 9,000 and AED 10,000 per source, with 2026 start dates disputed too - the LOWER
    // figure is seeded so the tracker under-warns rather than over-claims an exposure, but this is the one
    // row in the whole seed that most needs a human reading the current MOHRE schedule before it is relied on.
    ["ae.emiratisation.finePerPositionPerMonth", 9000, "AED/month", "reported as AED 9,000-10,000 by different sources - confirm the current figure with MOHRE"],
    ["ae.emiratisation.requiredPercent", 10, "%", "the skilled-role Emiratisation quota reported for 2026 - confirm the current checkpoint percentage"],
  ],
  IN: [
    ["in.gratuity.daysPerYear", 15, "days", "Payment of Gratuity Act, 1972 s.4"],
    ["in.gratuity.monthDivisor", 26, "days", "the working-days-a-month convention the Act's formula uses"],
    ["in.gratuity.minServiceYears", 5, "years", "s.4 - a cliff, not a ramp"],
    // ₹20 lakh and ₹25 lakh are both reported as the current tax-free cap - the LOWER figure is seeded for
    // the same under-warn-rather-than-over-claim reason as the Emiratisation fine above.
    ["in.gratuity.capAmount", 2000000, "INR", "reported as both ₹20 lakh and ₹25 lakh by different sources - confirm the current cap"],
  ],
};

class StatutoryRuleService {
  /** Seeds the research's defaults for a country, once - the same lazy "on first read" pattern
   * VoucherTypeService.ensureDefaults and TaxCodeService.ensureStarter already use, so an organisation that
   * never opens the Setup screen pays nothing for rows it has not asked for. */
  static async ensureDefaults(country, { session } = {}) {
    const rows = SEED[country];
    if (!rows) return 0;
    const existing = await StatutoryRule.countDocuments({ country }).session(session || null);
    if (existing > 0) return 0; // an organisation with any row of its own is left alone entirely
    const docs = rows.map(([key, value, unit, notes]) => ({
      country, key, value, unit, notes, effectiveFrom: "2022-01-01", isSystem: true, createdBy: "system",
    }));
    const r = await StatutoryRule.insertMany(docs, { session, ordered: false });
    return r.length;
  }

  /** Every row for the organisation's own country, newest first - the Setup screen's list. */
  static async list(country) {
    const c = (country || orgLocale.country()).toUpperCase();
    await this.ensureDefaults(c);
    return StatutoryRule.find({ country: c }).sort({ key: 1, effectiveFrom: -1 }).lean();
  }

  /** The value in force for one key today, or on a given day - for a caller that needs a single figure
   * rather than the whole table (EmiratisationService reads a few this way). */
  static async valueOn(key, { country, day } = {}) {
    const c = (country || orgLocale.country()).toUpperCase();
    const rows = await StatutoryRule.find({ country: c, key }).lean();
    return compliance.ruleOn(rows, key, day || todayInOrg());
  }

  /** Every rule row for a country, as the plain shape utils/compliance.js reads (no Mongoose fields leaking
   * into the pure function's input). Used by GratuityService so it reads the whole table once per run. */
  static async rowsFor(country) {
    const c = (country || orgLocale.country()).toUpperCase();
    await this.ensureDefaults(c);
    const rows = await StatutoryRule.find({ country: c }).select("key value effectiveFrom effectiveTo").lean();
    return rows.map((r) => ({ key: r.key, value: r.value, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo }));
  }

  /** A new row. The day it starts is fixed once saved, the same reason EmployeeContract's own start day is
   * (ContractService.update's own rule, mirrored here): a figure's history must read as what was true when. */
  static async create(data, by) {
    if (!data?.country || !data?.key) throw new AppError("A rule needs a country and a key", 400, "VALIDATION_ERROR");
    if (!isCalendarDay(data.effectiveFrom)) throw new AppError("Enter the day this rule takes effect", 400, "INVALID_EFFECTIVE_FROM");
    if (typeof data.value !== "number" || !Number.isFinite(data.value)) throw new AppError("Enter the figure", 400, "INVALID_VALUE");
    const country = String(data.country).toUpperCase();
    const clash = await StatutoryRule.findOne({ country, key: data.key, effectiveFrom: data.effectiveFrom });
    if (clash) throw new AppError("A rule for this key already starts on that day", 409, "RULE_EXISTS");
    // close whatever was open and started earlier - the same ContractService.create pattern
    const dayBefore = addDays(data.effectiveFrom, -1);
    await StatutoryRule.updateMany(
      { country, key: data.key, effectiveFrom: { $lt: data.effectiveFrom }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: data.effectiveFrom } }] },
      { $set: { effectiveTo: dayBefore, updatedBy: by } }
    );
    return StatutoryRule.create({
      country, key: data.key, value: data.value, unit: data.unit, notes: data.notes,
      effectiveFrom: data.effectiveFrom, effectiveTo: data.effectiveTo || null, isSystem: false, createdBy: by,
    });
  }

  static async remove(id) {
    const row = await StatutoryRule.findById(id);
    if (!row) throw new AppError("Rule not found", 404, "RULE_NOT_FOUND");
    await StatutoryRule.deleteOne({ _id: id });
    return { removed: true };
  }
}

module.exports = StatutoryRuleService;
