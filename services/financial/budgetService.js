const mongoose = require("mongoose");
const Budget = require("../../models/modules/financial/budgetModel");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const CostCentre = require("../../models/modules/financial/costCentreModel");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const LedgerReportsService = require("../reports/ledgerReportsService");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const tz = require("../../utils/tz");
const orgLocale = require("../../utils/orgLocale");
const { monthsOf } = require("../../utils/periodClose");
const { todayInOrg } = require("../../utils/documentExpiry");
const { naturalBalance, categoryOf } = require("../../utils/accounting");
const { CLOSING_VOUCHER_TYPE } = require("../../utils/yearEnd");
const rules = require("../../utils/budgets");

// Budgets per account per month of a fiscal year, for the whole business or one cost centre, and how the ledger compares.
const NOT_TRADING = ["opening", "opening_stock", CLOSING_VOUCHER_TYPE]; // brought forward and the year-end entry are not a month's income or cost
const oid = (v) => new mongoose.Types.ObjectId(String(v));

class BudgetService {
  // the year as days in the organisation's zone, and its months
  static async yearOf(id) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Choose a fiscal year", 400, "INVALID_BUDGET");
    const y = await FiscalYear.findById(id).lean();
    if (!y) throw new AppError("That fiscal year does not exist", 400, "INVALID_BUDGET");
    const zone = orgLocale.timezone();
    const startDay = tz.dayOf(y.startDate, zone);
    const endDay = tz.dayOf(y.endDate, zone);
    return { ...y, startDay, endDay, months: monthsOf(startDay, endDay) };
  }

  // Map(id -> { category, accountName, accountCode }) for the given accounts, or every income and expense account
  static async accountsMap(ids) {
    const filter = ids ? { _id: { $in: ids.filter((i) => mongoose.isValidObjectId(i)).map(oid) } } : {};
    const accounts = await LedgerAccount.find(filter).select("accountName accountCode accountType groupId").lean();
    const groups = await AccountGroup.find({ _id: { $in: accounts.map((a) => a.groupId).filter(Boolean) } }).select("category").lean();
    const cat = new Map(groups.map((g) => [String(g._id), g.category]));
    return new Map(accounts.map((a) => [String(a._id), { accountName: a.accountName, accountCode: a.accountCode, category: cat.get(String(a.groupId)) || categoryOf(a.accountType) }]));
  }

  static async centreOf(costCentreId) {
    if (costCentreId === undefined || costCentreId === null || costCentreId === "" || costCentreId === "all") return null;
    if (!mongoose.isValidObjectId(costCentreId)) throw new AppError("That cost centre does not exist", 400, "INVALID_COST_CENTRE");
    const c = await CostCentre.findById(costCentreId).lean();
    if (!c) throw new AppError("That cost centre does not exist", 400, "INVALID_COST_CENTRE");
    return c;
  }

  static present(b, { years = new Map(), centres = new Map() } = {}) {
    const total = (cat, accounts) => rules.round2(b.lines.filter((l) => accounts.get(String(l.accountId))?.category === cat).reduce((t, l) => t + rules.lineTotal(l.amounts), 0));
    return (accounts) => ({
      ...b,
      year: years.get(String(b.fiscalYearId)) || null,
      costCentre: b.costCentreId ? centres.get(String(b.costCentreId)) || null : null,
      totals: { income: total("INCOME", accounts), expense: total("EXPENSE", accounts) },
    });
  }

  static async list() {
    const rows = await Budget.find({}).sort({ createdAt: -1 }).lean();
    const [years, centres, accounts] = await Promise.all([
      FiscalYear.find({ _id: { $in: rows.map((r) => r.fiscalYearId) } }).select("code startDate endDate status").lean(),
      CostCentre.find({ _id: { $in: rows.map((r) => r.costCentreId).filter(Boolean) } }).select("code name isActive").lean(),
      this.accountsMap(rows.flatMap((r) => r.lines.map((l) => String(l.accountId)))),
    ]);
    const ctx = { years: new Map(years.map((y) => [String(y._id), y])), centres: new Map(centres.map((c) => [String(c._id), c])) };
    return rows.map((r) => this.present(r, ctx)(accounts));
  }

  static async get(id) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Budget not found", 404, "BUDGET_NOT_FOUND");
    const b = await Budget.findById(id).lean();
    if (!b) throw new AppError("Budget not found", 404, "BUDGET_NOT_FOUND");
    const [year, centre, accounts] = await Promise.all([
      FiscalYear.findById(b.fiscalYearId).select("code startDate endDate status").lean(),
      b.costCentreId ? CostCentre.findById(b.costCentreId).select("code name isActive").lean() : null,
      this.accountsMap(b.lines.map((l) => String(l.accountId))),
    ]);
    const shaped = this.present(b, { years: new Map(year ? [[String(year._id), year]] : []), centres: new Map(centre ? [[String(centre._id), centre]] : []) })(accounts);
    return { ...shaped, lines: shaped.lines.map((l) => ({ ...l, ...(accounts.get(String(l.accountId)) || {}) })) };
  }

  static async clean(data, existing) {
    const year = await this.yearOf(data.fiscalYearId ?? existing?.fiscalYearId);
    const centre = await this.centreOf(data.costCentreId !== undefined ? data.costCentreId : existing?.costCentreId);
    const name = String(data.name ?? existing?.name ?? "").trim() || `Budget ${year.code}${centre ? ` - ${centre.name}` : ""}`;
    if (name.length > 100) throw new AppError("The name is at most 100 characters", 400, "INVALID_BUDGET");
    const rawLines = data.lines ?? existing?.lines ?? [];
    const accounts = await this.accountsMap(rawLines.map((l) => String(l?.accountId?._id || l?.accountId || "")));
    let lines;
    try {
      ({ lines } = rules.validateLines(rawLines, year.months, accounts));
    } catch (err) {
      if (err.code === "INVALID_BUDGET") throw new AppError(err.message, 400, "INVALID_BUDGET", { line: err.line });
      throw err;
    }
    return {
      name, fiscalYearId: year._id, ...(centre ? { costCentreId: centre._id } : {}), scopeKey: centre ? String(centre._id) : "all",
      notes: String(data.notes ?? existing?.notes ?? "").slice(0, 500), lines: lines.map((l) => ({ accountId: oid(l.accountId), amounts: l.amounts })),
    };
  }

  static async create(data, req) {
    const { companyId, branchId } = getTenant(req);
    const doc = await this.clean(data);
    try {
      const made = await Budget.create({ ...doc, companyId, branchId, createdBy: req?.admin?.id });
      return this.get(made._id);
    } catch (err) {
      if (err.code === 11000) throw new AppError("There is already a budget for this year and cost centre. Open it to change it.", 409, "BUDGET_EXISTS");
      throw err;
    }
  }

  static async update(id, data, req) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Budget not found", 404, "BUDGET_NOT_FOUND");
    const b = await Budget.findById(id);
    if (!b) throw new AppError("Budget not found", 404, "BUDGET_NOT_FOUND");
    const doc = await this.clean(data, b.toObject());
    b.set({ ...doc, updatedBy: req?.admin?.id });
    if (!doc.costCentreId) b.set("costCentreId", undefined);
    b.markModified("lines");
    try {
      await b.save();
    } catch (err) {
      if (err.code === 11000) throw new AppError("There is already a budget for this year and cost centre.", 409, "BUDGET_EXISTS");
      throw err;
    }
    return this.get(b._id);
  }

  static async remove(id) {
    const b = await this.get(id);
    await Budget.deleteOne({ _id: b._id });
    return b;
  }

  /**
   * What the ledger says, per account per month: Map(accountId -> Map("YYYY-MM" -> natural amount)), months in the organisation's zone.
   * Reversed rows, balances brought forward and the year-end closing entry are left out, as the profit and loss leaves them out.
   */
  static async actuals({ startDay, endDay, costCentre, accounts }) {
    const zone = orgLocale.timezone();
    const match = {
      isReversed: { $ne: true },
      voucherType: { $nin: NOT_TRADING },
      date: { $gte: LedgerReportsService.dayStart(startDay), $lte: LedgerReportsService.dayEnd(endDay) },
      ...LedgerReportsService.centreMatch(costCentre),
    };
    const rows = await LedgerEntry.aggregate([
      { $match: match },
      { $group: { _id: { a: "$accountId", m: { $dateToString: { format: "%Y-%m", date: "$date", timezone: zone } } }, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } },
    ]);
    const map = accounts || (await this.accountsMap(rows.map((r) => String(r._id.a))));
    const out = new Map();
    for (const r of rows) {
      const id = String(r._id.a);
      const acc = map.get(id);
      if (!acc || !rules.BUDGETABLE.has(acc.category)) continue;
      if (!out.has(id)) out.set(id, new Map());
      out.get(id).set(r._id.m, rules.round2(naturalBalance(acc.category, r.d, r.c)));
    }
    return out;
  }

  // Budget against actual for months of the budget's year: `from` / `to` are "YYYY-MM" (default: the year to this month).
  static async report(id, { from, to } = {}) {
    const b = await Budget.findById(mongoose.isValidObjectId(id) ? id : null).lean();
    if (!b) throw new AppError("Budget not found", 404, "BUDGET_NOT_FOUND");
    const year = await this.yearOf(b.fiscalYearId);
    const thisMonth = todayInOrg().slice(0, 7);
    const lastKey = year.months[year.months.length - 1]?.key;
    const want = (v) => (v && /^\d{4}-\d{2}$/.test(v) ? v : null);
    const first = want(from) || year.months[0]?.key;
    const last = want(to) || (thisMonth < lastKey ? (thisMonth >= first ? thisMonth : lastKey) : lastKey);
    if (first > last) throw new AppError("from must not be after to", 400, "INVALID_RANGE");
    const months = year.months.filter((m) => m.key >= first && m.key <= last);
    if (!months.length) throw new AppError("Choose months inside the budget's year", 400, "INVALID_RANGE");
    const allAccounts = await this.accountsMap();
    const actual = await this.actuals({ startDay: months[0].startDay, endDay: months[months.length - 1].endDay, costCentre: b.costCentreId ? String(b.costCentreId) : undefined, accounts: allAccounts });
    const result = rules.compare(b.lines.map((l) => ({ accountId: String(l.accountId), amounts: l.amounts })), actual, months, allAccounts);
    const centre = b.costCentreId ? await CostCentre.findById(b.costCentreId).select("code name").lean() : null;
    return { budget: { _id: b._id, name: b.name, year: { code: year.code, startDay: year.startDay, endDay: year.endDay }, costCentre: centre }, from: first, to: last, months: months.map((m) => m.key), ...result };
  }

  // Last fiscal year's actuals, moved onto this year's months: a starting point for a new budget. Lines with nothing are left out.
  static async suggest({ fiscalYearId, costCentreId } = {}) {
    const year = await this.yearOf(fiscalYearId);
    const prev = await FiscalYear.findOne({ endDate: { $lt: new Date(`${year.startDay}T23:59:59.999Z`) } }).sort({ endDate: -1 }).lean();
    if (!prev) return { from: null, lines: [] };
    const before = await this.yearOf(prev._id);
    const centre = await this.centreOf(costCentreId);
    const accounts = await this.accountsMap();
    const actual = await this.actuals({ startDay: before.startDay, endDay: before.endDay, costCentre: centre ? String(centre._id) : undefined, accounts });
    const shift = rules.shiftMonths(before.months.map((m) => m.key), year.months.map((m) => m.key));
    const lines = [];
    for (const [accountId, byMonth] of actual) {
      const amounts = {};
      for (const [m, v] of byMonth) if (shift.has(m) && v > 0) amounts[shift.get(m)] = v;
      if (Object.keys(amounts).length) lines.push({ accountId, ...accounts.get(accountId), amounts });
    }
    lines.sort((a, b) => a.category.localeCompare(b.category) || String(a.accountCode).localeCompare(String(b.accountCode)));
    return { from: before.code, lines };
  }
}

module.exports = BudgetService;
