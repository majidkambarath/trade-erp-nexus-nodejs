const mongoose = require("mongoose");
const SalaryComponent = require("../../models/modules/hr/salaryComponentModel");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/payroll");
const orgLocale = require("../../utils/orgLocale");

/** A component's own account override, checked the same way ledgerVoucherService.js's own
 * postableAccounts does (it exists, is active, accepts a direct posting) - BEFORE the component is ever
 * saved. Without this, a stale or bogus accountId would only surface when a payroll run silently dropped
 * one leg of its posting and left the ledger unbalanced (the gap postAccounts() in payrollService.js now
 * refuses outright, but it is cheaper and clearer to refuse here, when the component is first chosen). */
async function assertAccount(accountId) {
  if (!accountId) return;
  if (!mongoose.isValidObjectId(accountId)) throw new AppError("Choose a valid account", 400, "INVALID_ACCOUNT");
  const a = await LedgerAccount.findById(accountId).select("accountName isActive allowDirectPosting");
  if (!a) throw new AppError("Account not found", 404, "ACCOUNT_NOT_FOUND");
  if (!a.isActive) throw new AppError(`${a.accountName} is inactive`, 400, "ACCOUNT_INACTIVE");
  if (a.allowDirectPosting === false) throw new AppError(`Direct posting is not allowed to ${a.accountName}`, 400, "DIRECT_POSTING_NOT_ALLOWED");
}

// Starter components for IN (PF, ESI, professional tax), seeded lazily on first read - the same
// "on first READ" pattern VoucherTypeService.ensureDefaults and StatutoryRuleService.ensureDefaults
// already use, so an organisation that never opens Payroll pays nothing for rows it never asked for.
// Each names the StatutoryRule key its FIGURE comes from (services/hr/statutoryRuleService.js SEED.IN),
// so a client corrects the rate in Setup without touching the component. AE gets no starter components:
// there is no mandatory federal payroll deduction to seed (GPSSA pension for UAE nationals is NOT built -
// see the module's own CLAUDE.md notes). TDS is deliberately absent from this list too.
const STARTERS = {
  IN: [
    { name: "PF", kind: "deduction", computation: "percentOfBasic", rate: 12, capBase: 15000, statutoryKey: "in.pf.employeeRate", capBaseKey: "in.pf.wageCeiling" },
    { name: "ESI", kind: "deduction", computation: "percentOfGross", rate: 0.75, eligibleUpTo: 21000, statutoryKey: "in.esi.employeeRate", eligibleUpToKey: "in.esi.wageThreshold" },
    { name: "Professional Tax", kind: "deduction", computation: "fixed", rate: 200, statutoryKey: "in.pt.monthlyAmount" },
  ],
};

/**
 * What the organisation pays and deducts beyond basic pay - PF, ESI, professional tax, an overtime
 * allowance... Applied uniformly to every employee paid in a run (utils/payroll.js's own header: a
 * generic shape, never a hardcoded tax law). Organisation-wide, like LeaveType.
 */
class SalaryComponentService {
  static async ensureDefaults(country) {
    const starters = STARTERS[country];
    if (!starters) return 0;
    const existing = await SalaryComponent.countDocuments({ country });
    if (existing > 0) return 0; // an organisation with any component of its own, for this country, is left alone
    try {
      const r = await SalaryComponent.insertMany(
        starters.map((s) => ({ ...s, country, isSystem: true, createdBy: "system" })),
        { ordered: false }
      );
      return r.length;
    } catch (err) {
      if (err?.code === 11000 || err?.code === 11001) return 0; // a concurrent first read won the race
      throw err;
    }
  }

  /** Every component, newest first. */
  static async list() {
    await this.ensureDefaults(orgLocale.country());
    return SalaryComponent.find().sort({ kind: 1, name: 1 }).lean();
  }

  /** Active components that apply in THIS organisation's country (or name no country at all). What a
   * payroll run actually reads. */
  static async forCountry(country) {
    const c = (country || orgLocale.country()).toUpperCase();
    await this.ensureDefaults(c);
    const rows = await SalaryComponent.find({ isActive: true, $or: [{ country: null }, { country: c }] }).lean();
    return rows;
  }

  static async create(data, by) {
    const errors = rules.validateComponent(data);
    if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code, { errors, field: errors[0].field });
    await assertAccount(data.accountId);
    return SalaryComponent.create({
      name: String(data.name).trim(), kind: data.kind, computation: data.computation,
      rate: data.rate === "" || data.rate === undefined ? null : Number(data.rate),
      capBase: data.capBase === "" || data.capBase === undefined ? null : Number(data.capBase),
      eligibleUpTo: data.eligibleUpTo === "" || data.eligibleUpTo === undefined ? null : Number(data.eligibleUpTo),
      statutoryKey: data.statutoryKey || null, capBaseKey: data.capBaseKey || null, eligibleUpToKey: data.eligibleUpToKey || null,
      accountId: data.accountId || null, country: data.country ? String(data.country).toUpperCase() : null,
      createdBy: by,
    });
  }

  static async update(id, data, by) {
    const merged = { ...(await SalaryComponent.findById(id).lean()), ...data };
    const errors = rules.validateComponent(merged);
    if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code, { errors, field: errors[0].field });
    if ("accountId" in data) await assertAccount(data.accountId);
    const set = { updatedBy: by };
    for (const f of ["name", "kind", "computation", "rate", "capBase", "eligibleUpTo", "statutoryKey", "capBaseKey", "eligibleUpToKey", "accountId", "country", "isActive"]) {
      if (f in data) set[f] = data[f] === "" ? null : data[f];
    }
    const row = await SalaryComponent.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true });
    if (!row) throw new AppError("Component not found", 404, "COMPONENT_NOT_FOUND");
    return row;
  }

  static async remove(id) {
    const r = await SalaryComponent.deleteOne({ _id: id });
    if (!r.deletedCount) throw new AppError("Component not found", 404, "COMPONENT_NOT_FOUND");
    return { removed: true };
  }
}

module.exports = SalaryComponentService;
module.exports.assertAccount = assertAccount;
