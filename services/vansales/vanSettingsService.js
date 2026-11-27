const AppError = require("../../utils/AppError");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const Van = require("../../models/modules/vansales/vanModel");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSettings");
const { getTenant } = require("../../utils/tenant");

const fail = (message, status, code, details) => new AppError(message, status, code, details);

// The organisation's rules for its vans, and the rules in force for one van or trip. Shaped like CrmSetupService.settings /
// saveSettings: one block on CompanySettings, read through the pure normaliser, written key by key with an upsert.
class VanSettingsService {
  /** The organisation's rules with every default filled in, whatever an older document stored. */
  static async settings({ session } = {}) {
    const doc = await CompanySettings.findOne({}).select("vanSales").session(session || null).lean();
    return rules.normaliseSettings(doc?.vanSales);
  }

  /** Validate, merge over what is saved and store. Only the keys sent change. -> the new full set. */
  static async save(input) {
    const errors = rules.validateSettings(input);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const current = await this.settings();
    const next = rules.normaliseSettings({ ...current, ...input });
    if (input.expenseKinds !== undefined) await this.assertExpenseAccounts(next.expenseKinds, current.expenseKinds);
    const { companyId } = getTenant();
    await CompanySettings.updateOne(
      {},
      { $set: Object.fromEntries(Object.entries(next).map(([k, v]) => [`vanSales.${k}`, v])), $setOnInsert: { companyId } },
      { upsert: true }
    );
    return next;
  }

  /** An account newly named for a van expense must be an active expense account that takes postings (one kept as it was is left). */
  static async assertExpenseAccounts(kinds, before = []) {
    const had = new Map(before.map((k) => [k.key, k.accountId || ""]));
    const named = kinds.filter((k) => k.accountId && had.get(k.key) !== k.accountId);
    if (!named.length) return;
    const found = await LedgerAccount.find({ _id: { $in: named.map((k) => k.accountId) } }).select("accountType isActive allowDirectPosting").lean();
    const byId = new Map(found.map((a) => [String(a._id), a]));
    for (const k of named) {
      const a = byId.get(String(k.accountId));
      if (!a || a.accountType !== "expense" || a.isActive === false || a.allowDirectPosting === false) {
        throw fail(`${k.label}: choose an active expense account`, 400, "INVALID_EXPENSE_ACCOUNT", { field: "expenseKinds" });
      }
    }
  }

  /** The rules in force for one van (a Van document or its plain object): the organisation's with the van's own laid over them. */
  static async forVan(van, { session } = {}) {
    return rules.effective(await this.settings({ session }), van?.rules);
  }

  /** The rules for a trip: its van's. The rules are read live, never copied onto the trip, so a change applies at once. */
  static async forTrip(trip, { session } = {}) {
    const van = trip?.vanId ? await Van.findById(trip.vanId).select("rules").session(session || null).lean() : null;
    const org = await this.settings({ session });
    return rules.effective(org, van?.rules);
  }
}

module.exports = VanSettingsService;
