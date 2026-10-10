const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const LedgerReports = require("./ledgerReportsService");
const AccountConfigService = require("../financial/accountConfigService");
const AgeingService = require("../financial/ageingService");
const AppError = require("../../utils/AppError");
const { naturalBalance, round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");
const currencyCatalog = require("../../utils/currencyCatalog");
const orgLocale = require("../../utils/orgLocale");

// IFRS statements read straight from the general ledger, so they cannot disagree with the Trial
// Balance, the Balance Sheet or the Profit and loss screens:
//   financialPosition   Statement of financial position (IAS 1)
//   profitOrLoss        Statement of profit or loss and other comprehensive income, by function
//   changesInEquity     Statement of changes in equity
//   cashFlows           Statement of cash flows (IAS 7, indirect method)
//   notes               Basic notes with note tables taken from the ledger
// Each takes `compare` = prior-year | prior-period | none (default prior-year) and returns the
// comparative column next to the current one. Dates are the organisation's calendar days (see
// ledgerReportsService); a period runs from the start of `from` to the end of `to`.
//
// CLASSIFICATION RULES (also shown as the footnote on the screen)
//   Non-current: an asset or liability is NON-CURRENT when its group, or any group above it in
//     the tree, has a name matching NON_CURRENT_RX; everything else is CURRENT. Every account
//     lands on exactly one side; nothing is left unclassified.
//   Profit or loss by function: revenue and cost of sales follow ledgerReportsService.profitAndLoss
//     (direct income / direct expense groups). Of the remaining expenses, accounts or groups named
//     like TAX_RX are income tax, DEPRECIATION_RX depreciation and amortisation, FINANCE_RX finance
//     costs; the rest are operating expenses.
//   Profit is shown inside equity until a year is closed: profit before `from` as "Accumulated profit
//     brought forward" (a year that WAS closed has its profit in Retained Earnings by its year-end
//     closing entry, so only years never closed appear here) and profit from `from` to `asAt` as
//     "Profit for the period". `from` defaults to the start of the fiscal year the date falls in.
//   An account with a balance on the opposite side of its group (an asset in credit, say) is shown
//     as a negative on its own side; nothing is reclassified between assets and liabilities.

const currency = () => orgLocale.baseCurrency(); // the books are kept in the organisation's base currency
const currencyName = () => currencyCatalog.SUPPORTED[currency()]?.name || currency(); // "UAE Dirham", "Pound Sterling"
const NON_CURRENT_RX = /fixed|non.?current|property|plant|equipment|intangible|long.?term/i;
const FINANCE_RX = /interest|finance|bank charges/i;
const DEPRECIATION_RX = /depreciation|amortis|amortiz/i;
const TAX_RX = /income tax|corporate tax/i;
const INVENTORY_RX = /inventor|stock/i;
const RECEIVABLE_RX = /receivable|debtor/i;
const PAYABLE_RX = /payable|creditor/i;
const FINANCING_RX = /loan|borrowing|debenture|finance lease|mortgage/i;
const DISPOSAL_RX = /disposal/i;
const RETAINED_RX = /retained|accumulated|earnings|profit/i;
const SHARE_CAPITAL_RX = /capital|share/i;

const COMPARE_MODES = ["prior-year", "prior-period", "none"];
const EQUITY_COLUMNS = [
  { key: "share_capital", label: "Share capital" },
  { key: "retained_earnings", label: "Retained earnings" },
  { key: "other_equity", label: "Other equity and reserves" },
];

// -0 would print as "-0.00" and fail strict equality, so zero is always +0.
const r2 = (n) => round2(n) + 0;
const sum = (list) => r2(list.reduce((t, n) => t + n, 0));
const nat = (category, net) => r2(naturalBalance(category, net, 0));
const isPnl = (r) => r.category === "INCOME" || r.category === "EXPENSE";
const matches = (rx, ...texts) => texts.some((t) => rx.test(String(t || "")));

// ------------------------------------------------------------------ calendar days (YYYY-MM-DD)
// Plain string arithmetic on calendar days: no time zones, so a day never shifts.

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const pad2 = (n) => String(n).padStart(2, "0");
const parseDay = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
};
const dayString = (y, m, d) => `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
const utcOf = (s) => {
  const { y, m, d } = parseDay(s);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

const addDays = (s, n) => fromUtc(utcOf(s) + n * DAY_MS);
const dayDiff = (a, b) => Math.round((utcOf(b) - utcOf(a)) / DAY_MS);
const endOfMonth = (s) => {
  const { y, m } = parseDay(s);
  return dayString(y, m, daysInMonth(y, m));
};
const isMonthEnd = (s) => s === endOfMonth(s);
const isMonthStart = (s) => s.endsWith("-01");
// Same day n months on; a day that does not exist there (31 Apr, 29 Feb) becomes the last day.
const addMonths = (s, n) => {
  const { y, m, d } = parseDay(s);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12);
  const nm = (t % 12) + 1;
  return dayString(ny, nm, Math.min(d, daysInMonth(ny, nm)));
};
const orgToday = () => orgLocale.today();

// A valid calendar day, or null when none was given.
function toDay(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).slice(0, 10);
  if (!YMD.test(text) || fromUtc(utcOf(text)) !== text) throw new AppError(`"${value}" is not a date`, 400, "INVALID_DATE");
  return text;
}

function compareMode(value) {
  if (value === undefined || value === null || value === "") return "prior-year";
  const mode = String(value).toLowerCase();
  if (!COMPARE_MODES.includes(mode)) throw new AppError("compare must be prior-year, prior-period or none", 400, "INVALID_COMPARE");
  return mode;
}

// First day of the fiscal year that contains `day`, for a year starting in `startMonth` (1-12).
function fiscalYearStart(day, startMonth = 1) {
  const { y, m } = parseDay(day);
  return dayString(m >= startMonth ? y : y - 1, startMonth, 1);
}

// The period a comparative column covers.
//   prior-year    the same days one year earlier (the last day of a month stays the last day)
//   prior-period  the period of the same length just before: whole months move back by that many
//                 months (October -> September), anything else by the number of days
function comparativeRange(from, to, mode) {
  if (mode === "none") return null;
  if (mode === "prior-year") {
    return { from: addMonths(from, -12), to: isMonthEnd(to) ? endOfMonth(addMonths(to, -12)) : addMonths(to, -12) };
  }
  if (isMonthStart(from) && isMonthEnd(to)) {
    const a = parseDay(from);
    const b = parseDay(to);
    const months = (b.y - a.y) * 12 + (b.m - a.m) + 1;
    return { from: addMonths(from, -months), to: endOfMonth(addMonths(to, -months)) };
  }
  const length = dayDiff(from, to) + 1;
  const end = addDays(from, -1);
  return { from: addDays(end, -(length - 1)), to: end };
}

// ------------------------------------------------------------------ account classification

// Which block of the cash flow statement an account's movement belongs to. Every account lands
// in one; `unclassified` is only for money that is neither cash nor explained by a rule (such as
// an inactive cash or bank account), which the statement shows as "Other".
function cashFlowBucket(row, { cashGroupIds = new Set() } = {}) {
  if (row.isCash) return "cash";
  if (isPnl(row)) return "pnl";
  if (cashGroupIds.has(String(row.groupId))) return "unclassified"; // a cash or bank account that is switched off
  const text = [row.accountName, ...row.path];
  if (row.category === "ASSET") {
    if (row.nonCurrent) return "nonCurrentAssets";
    if (matches(INVENTORY_RX, ...text)) return "inventory";
    if (matches(RECEIVABLE_RX, ...text)) return "receivables";
    return "otherCurrentAssets";
  }
  if (row.category === "LIABILITY") {
    if (!row.nonCurrent && matches(TAX_RX, ...text)) return "taxPayable";
    if (!row.nonCurrent && matches(/interest/i, ...text)) return "interestPayable";
    if (row.nonCurrent || matches(FINANCING_RX, ...text)) return "borrowings";
    if (matches(PAYABLE_RX, ...text)) return "payables";
    return "otherCurrentLiabilities";
  }
  if (row.category === "EQUITY") return "equity";
  return "unclassified";
}

// Equity accounts are columns of the statement of changes in equity.
function equityColumn(row) {
  const text = [row.accountName, ...row.path];
  if (matches(RETAINED_RX, ...text)) return "retained_earnings";
  if (matches(SHARE_CAPITAL_RX, ...text)) return "share_capital";
  return "other_equity";
}

// Lower sorts first inside a section: stock, then receivables, then the rest, cash last (IAS 1).
function presentationRank(row) {
  const text = [row.accountName, ...row.path];
  if (row.category === "ASSET") {
    if (row.isCash) return 9;
    if (matches(INVENTORY_RX, ...text)) return 1;
    if (matches(RECEIVABLE_RX, ...text)) return 2;
    return 5;
  }
  if (row.category === "LIABILITY") return matches(PAYABLE_RX, ...text) ? 1 : 5;
  if (row.category === "EQUITY") return { share_capital: 1, retained_earnings: 2, other_equity: 3 }[equityColumn(row)];
  return 5;
}

function positionSection(row) {
  if (row.category === "ASSET") return row.nonCurrent ? "nonCurrentAssets" : "currentAssets";
  if (row.category === "LIABILITY") return row.nonCurrent ? "nonCurrentLiabilities" : "currentLiabilities";
  if (row.category === "EQUITY") return "equity";
  return null;
}

// ------------------------------------------------------------------ comparative columns

const pair = (current, previous, hasPrevious) => ({ amount: r2(current), comparative: hasPrevious ? r2(previous || 0) : null });

// Lists of { accountId, ..., amount } for two periods joined on the account.
function joinAccounts(current, previous, hasPrevious) {
  const byId = new Map();
  for (const a of current) byId.set(a.accountId, { ...a, comparative: hasPrevious ? 0 : null });
  if (hasPrevious) {
    for (const a of previous) {
      const hit = byId.get(a.accountId);
      if (hit) hit.comparative = a.amount;
      else byId.set(a.accountId, { ...a, amount: 0, comparative: a.amount });
    }
  }
  return [...byId.values()]
    .filter((a) => Math.abs(a.amount) >= 0.005 || Math.abs(a.comparative || 0) >= 0.005)
    .sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)))
    .map(({ accountId, accountCode, accountName, amount, comparative }) => ({ accountId, accountCode, accountName, amount, comparative }));
}

// A group of account lines with its totals.
const linesBlock = (accounts, hasPrevious) => ({
  accounts,
  amount: sum(accounts.map((a) => a.amount)),
  comparative: hasPrevious ? sum(accounts.map((a) => a.comparative || 0)) : null,
});

// ------------------------------------------------------------------ the service

class IfrsReportsService {
  static get CURRENCY() { return currency(); }
  static COMPARE_MODES = COMPARE_MODES;
  static EQUITY_COLUMNS = EQUITY_COLUMNS;
  // Pure helpers, exported so the rules can be tested without a database.
  static helpers = {
    NON_CURRENT_RX, FINANCE_RX, DEPRECIATION_RX, TAX_RX,
    toDay, compareMode, comparativeRange, fiscalYearStart, addDays, addMonths, endOfMonth, dayDiff,
    cashFlowBucket, equityColumn,
  };

  // ---------------------------------------------------------------- shared loading

  // What every statement needs once: the company, the group tree, the cash accounts.
  static async context() {
    const settings = await AccountConfigService.getSettings();
    const profile = settings.profile || {};
    const { companyId } = getTenant();
    const groups = await AccountGroup.find({ companyId }).select("name parentGroup").lean();
    // the company's own fiscal years, as calendar days: a statement opens at the start of the real year, not a guess from a month
    const years = (await FiscalYear.find({}).select("startDate endDate").lean()).map((y) => ({ start: orgLocale.dayOf(y.startDate), end: orgLocale.dayOf(y.endDate) }));
    const byId = new Map(groups.map((g) => [String(g._id), g]));
    const paths = new Map();
    // group names from the top of the tree down to the group itself
    const pathNames = (id) => {
      if (!id) return [];
      const key = String(id);
      if (paths.has(key)) return paths.get(key);
      const names = [];
      const seen = new Set();
      let g = byId.get(key);
      while (g && !seen.has(String(g._id))) {
        seen.add(String(g._id));
        names.unshift(g.name);
        g = g.parentGroup ? byId.get(String(g.parentGroup)) : null;
      }
      paths.set(key, names);
      return names;
    };
    const [cash, cashGroupIds, receivableGroups, payableGroups, inventoryGroups] = await Promise.all([
      LedgerReports.cashBankAccounts(),
      LedgerReports.groupSet(["cash-account-group", "bank-account-group"]),
      LedgerReports.groupSet(["account-receivable-group"]),
      LedgerReports.groupSet(["account-payable-group"]),
      LedgerReports.groupSet(["inventory-asset-group"]),
    ]);
    return {
      entity: {
        name: profile.legalName || "",
        trn: profile.trn || "",
        address: [profile.addressLine1, profile.city, profile.emirate].filter(Boolean).join(", "),
        vatRegistered: profile.vatRegistered !== false,
      },
      fiscalYearStartMonth: settings.fiscalYearStartMonth || 1,
      years,
      pathNames,
      cash,
      cashIds: new Set(cash.map((a) => String(a._id))),
      cashGroupIds,
      receivableGroups, payableGroups, inventoryGroups,
    };
  }

  // The dates a request asks for. `asAt` (or `to`) defaults to today in the organisation's zone, `from` to the
  // start of the fiscal year that date falls in (the company's own year when it has one, else the settings month).
  static period(ctx, query = {}) {
    const to = toDay(query.asAt) || toDay(query.to) || orgToday();
    const own = (ctx.years || []).find((y) => y.start <= to && to <= y.end);
    const from = toDay(query.from) || own?.start || fiscalYearStart(to, ctx.fiscalYearStartMonth);
    if (from > to) throw new AppError("from must not be after to", 400, "INVALID_RANGE");
    const mode = compareMode(query.compare);
    return { from, to, mode, comparative: comparativeRange(from, to, mode) };
  }

  // Every account that moved up to `to`, with its balance before `from`, its movement from `from`
  // to `to` and the balance at `to` (all debit minus credit), and where it sits in the group tree.
  static async loadRows(ctx, from, to) {
    const rows = await LedgerReports.accountMovements({ from, to });
    return rows.map((r) => {
      const path = ctx.pathNames(r.groupId);
      const accountId = String(r.accountId);
      const openingNet = r2(r.openingDebit - r.openingCredit);
      const periodNet = r2(r.periodDebit - r.periodCredit);
      return {
        accountId, accountCode: r.accountCode, accountName: r.accountName,
        groupId: r.groupId ? String(r.groupId) : null, groupName: r.groupName, category: r.category,
        path, nonCurrent: path.some((n) => NON_CURRENT_RX.test(n)), isCash: ctx.cashIds.has(accountId),
        openingNet, periodNet, closingNet: r2(openingNet + periodNet),
      };
    });
  }

  static head(ctx, statement, title) {
    return { statement, title, entity: ctx.entity, currency: currency() };
  }

  // ---------------------------------------------------------------- 1. Financial position

  // The balances at the end of a period: each account on its side, and the profit that sits in equity.
  static positionItems(rows) {
    const items = [];
    let broughtForward = 0;
    let forPeriod = 0;
    for (const r of rows) {
      if (isPnl(r)) {
        broughtForward -= r.openingNet;
        forPeriod -= r.periodNet;
        continue;
      }
      const section = positionSection(r);
      if (!section) continue;
      items.push({
        section, accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName,
        groupId: r.groupId, groupName: r.groupName, rank: presentationRank(r), amount: nat(r.category, r.closingNet),
      });
    }
    return { items, profitBroughtForward: r2(broughtForward), profitForPeriod: r2(forPeriod) };
  }

  static async financialPosition(query = {}) {
    const ctx = await this.context();
    const { from, to, mode, comparative } = this.period(ctx, query);
    const hasPrevious = Boolean(comparative);
    const cur = this.positionItems(await this.loadRows(ctx, from, to));
    const prev = hasPrevious ? this.positionItems(await this.loadRows(ctx, comparative.from, comparative.to)) : null;

    // join the two columns on the account, then file by section and group
    const entries = new Map();
    const put = (item, field) => {
      const key = `${item.section}|${item.accountId}`;
      if (!entries.has(key)) entries.set(key, { ...item, amount: 0, comparative: hasPrevious ? 0 : null });
      entries.get(key)[field] = item.amount;
    };
    cur.items.forEach((i) => put(i, "amount"));
    prev?.items.forEach((i) => put(i, "comparative"));

    const SECTIONS = {
      nonCurrentAssets: "Non-current assets", currentAssets: "Current assets", equity: "Equity",
      nonCurrentLiabilities: "Non-current liabilities", currentLiabilities: "Current liabilities",
    };
    const build = (key, extraGroups = []) => {
      const byGroup = new Map();
      for (const e of entries.values()) {
        if (e.section !== key) continue;
        if (Math.abs(e.amount) < 0.005 && Math.abs(e.comparative || 0) < 0.005) continue;
        const gk = String(e.groupId || "none");
        if (!byGroup.has(gk)) byGroup.set(gk, { groupId: e.groupId, name: e.groupName, rank: e.rank, accounts: [] });
        const g = byGroup.get(gk);
        g.rank = Math.min(g.rank, e.rank);
        g.accounts.push({ accountId: e.accountId, accountCode: e.accountCode, accountName: e.accountName, amount: e.amount, comparative: e.comparative });
      }
      const groups = [...byGroup.values()]
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
        .map(({ rank, accounts, ...g }) => {
          const list = accounts.sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
          return { ...g, ...linesBlock(list, hasPrevious) };
        });
      const all = [...groups, ...extraGroups];
      return {
        label: SECTIONS[key], groups: all,
        amount: sum(all.map((g) => g.amount)),
        comparative: hasPrevious ? sum(all.map((g) => g.comparative)) : null,
      };
    };

    // profit is not closed to equity, so it is shown inside it
    const profitGroup = (name, current, previous, always) => {
      if (!always && Math.abs(current) < 0.005 && Math.abs(previous || 0) < 0.005) return [];
      const line = { accountId: null, accountCode: "", accountName: name, amount: r2(current), comparative: hasPrevious ? r2(previous || 0) : null };
      return [{ groupId: null, name, synthetic: true, accounts: [line], amount: line.amount, comparative: line.comparative }];
    };
    const equity = build("equity", [
      ...profitGroup("Accumulated profit brought forward", cur.profitBroughtForward, prev?.profitBroughtForward, false),
      ...profitGroup("Profit for the period", cur.profitForPeriod, prev?.profitForPeriod, true),
    ]);
    const nonCurrentAssets = build("nonCurrentAssets");
    const currentAssets = build("currentAssets");
    const nonCurrentLiabilities = build("nonCurrentLiabilities");
    const currentLiabilities = build("currentLiabilities");

    const sumOf = (...parts) => ({ amount: sum(parts.map((p) => p.amount)), comparative: hasPrevious ? sum(parts.map((p) => p.comparative)) : null });
    const assets = { nonCurrent: nonCurrentAssets, current: currentAssets, ...sumOf(nonCurrentAssets, currentAssets) };
    const liabilities = sumOf(nonCurrentLiabilities, currentLiabilities);
    const equityAndLiabilities = { equity, nonCurrentLiabilities, currentLiabilities, liabilities, ...sumOf(equity, nonCurrentLiabilities, currentLiabilities) };

    const difference = r2(assets.amount - equityAndLiabilities.amount);
    const comparativeDifference = hasPrevious ? r2(assets.comparative - equityAndLiabilities.comparative) : null;
    return {
      ...this.head(ctx, "financial-position", "Statement of financial position"),
      asAt: to, from, compare: mode, comparative: hasPrevious ? { asAt: comparative.to, from: comparative.from } : null,
      assets, equityAndLiabilities,
      isBalanced: Math.abs(difference) < 0.01, difference,
      comparativeIsBalanced: hasPrevious ? Math.abs(comparativeDifference) < 0.01 : null, comparativeDifference,
    };
  }

  // ---------------------------------------------------------------- 2. Profit or loss

  // One period's profit or loss, by function. Revenue, cost of sales and gross profit are the
  // existing profit and loss (ledgerReportsService.profitAndLoss); the expenses it calls
  // "operating" are split further by what the account or its group is called.
  static async profitFigures(from, to) {
    const pl = await LedgerReports.profitAndLoss({ from, to });
    const lines = (section) =>
      section.groups.flatMap((g) =>
        g.accounts.map((a) => ({ accountId: String(a.accountId), accountCode: a.accountCode, accountName: a.accountName, groupName: g.name, amount: a.amount })));
    const revenue = lines(pl.revenue);
    const costOfSales = lines(pl.directCosts);
    const otherIncome = lines(pl.otherIncome);
    const operating = [];
    const depreciation = [];
    const financeCosts = [];
    const incomeTax = [];
    for (const a of lines(pl.operatingExpenses)) {
      if (matches(TAX_RX, a.accountName, a.groupName)) incomeTax.push(a);
      else if (matches(DEPRECIATION_RX, a.accountName, a.groupName)) depreciation.push(a);
      else if (matches(FINANCE_RX, a.accountName, a.groupName)) financeCosts.push(a);
      else operating.push(a);
    }
    const total = (list) => sum(list.map((a) => a.amount));
    const grossProfit = r2(total(revenue) - total(costOfSales));
    const operatingProfit = r2(grossProfit + total(otherIncome) - total(operating) - total(depreciation));
    const profitBeforeTax = r2(operatingProfit - total(financeCosts));
    const profitForPeriod = r2(profitBeforeTax - total(incomeTax));
    return {
      revenue, costOfSales, otherIncome, operating, depreciation, financeCosts, incomeTax,
      grossProfit, operatingProfit, profitBeforeTax, profitForPeriod,
      // what the cash flow statement adds back: depreciation anywhere in the expenses, and gains
      // and losses on disposal (a loss is positive)
      depreciationTotal: r2(total(depreciation) + total(costOfSales.filter((a) => matches(DEPRECIATION_RX, a.accountName, a.groupName)))),
      financeTotal: total(financeCosts), taxTotal: total(incomeTax),
      disposalNet: r2(total(operating.filter((a) => matches(DISPOSAL_RX, a.accountName))) - total(otherIncome.filter((a) => matches(DISPOSAL_RX, a.accountName)))),
      netProfitPerLedger: pl.netProfit,
    };
  }

  static async profitOrLoss(query = {}) {
    const ctx = await this.context();
    const { from, to, mode, comparative } = this.period(ctx, query);
    const hasPrevious = Boolean(comparative);
    const cur = await this.profitFigures(from, to);
    const prev = hasPrevious ? await this.profitFigures(comparative.from, comparative.to) : null;
    const block = (key) => linesBlock(joinAccounts(cur[key], prev?.[key] || [], hasPrevious), hasPrevious);
    const value = (key) => pair(cur[key], prev?.[key], hasPrevious);
    return {
      ...this.head(ctx, "profit-or-loss", "Statement of profit or loss and other comprehensive income"),
      from, to, compare: mode, comparative: hasPrevious ? comparative : null,
      basis: "by function",
      revenue: block("revenue"),
      costOfSales: block("costOfSales"),
      grossProfit: value("grossProfit"),
      otherIncome: block("otherIncome"),
      operatingExpenses: block("operating"),
      depreciationAndAmortisation: block("depreciation"),
      operatingProfit: value("operatingProfit"),
      financeCosts: block("financeCosts"),
      profitBeforeTax: value("profitBeforeTax"),
      incomeTaxExpense: block("incomeTax"),
      profitForPeriod: value("profitForPeriod"),
      otherComprehensiveIncome: pair(0, 0, hasPrevious),
      totalComprehensiveIncome: value("profitForPeriod"),
    };
  }

  // ---------------------------------------------------------------- 3. Changes in equity

  // The movements of one period in each equity column. Closing equity is checked against the
  // equity of the statement of financial position built from the same rows.
  static equityBlock(rows, from, to) {
    const zero = () => ({ share_capital: 0, retained_earnings: 0, other_equity: 0 });
    const opening = zero();
    const introduced = zero();
    const reduced = zero();
    const profit = zero();
    const pnl = rows.filter(isPnl);
    const openingProfit = r2(-sum(pnl.map((r) => r.openingNet)));
    profit.retained_earnings = r2(-sum(pnl.map((r) => r.periodNet)));
    for (const r of rows.filter((x) => x.category === "EQUITY")) {
      const col = equityColumn(r);
      opening[col] += nat("EQUITY", r.openingNet);
      const movement = nat("EQUITY", r.periodNet);
      if (movement > 0) introduced[col] += movement;
      else reduced[col] += movement;
    }
    opening.retained_earnings += openingProfit; // profit of earlier periods is not closed to equity
    const keys = EQUITY_COLUMNS.map((c) => c.key);
    const row = (key, label, kind, values) => {
      const v = Object.fromEntries(keys.map((k) => [k, r2(values[k])]));
      return { key, label, kind, values: { ...v, total: sum(keys.map((k) => v[k])) } };
    };
    const oci = zero();
    const comprehensive = Object.fromEntries(keys.map((k) => [k, profit[k] + oci[k]]));
    const closing = Object.fromEntries(keys.map((k) => [k, opening[k] + comprehensive[k] + introduced[k] + reduced[k]]));
    const closingRow = row("closing", "Balance at end of period", "balance", closing);

    const perPosition = this.positionItems(rows);
    const equityPerPosition = r2(
      sum(perPosition.items.filter((i) => i.section === "equity").map((i) => i.amount)) + perPosition.profitBroughtForward + perPosition.profitForPeriod
    );
    const difference = r2(closingRow.values.total - equityPerPosition);
    return {
      from, to,
      rows: [
        row("opening", "Balance at start of period", "balance", opening),
        row("profit", "Profit for the period", "movement", profit),
        row("oci", "Other comprehensive income", "movement", oci),
        row("comprehensive", "Total comprehensive income for the period", "subtotal", comprehensive),
        row("introduced", "Capital introduced and other increases", "movement", introduced),
        row("reduced", "Drawings, dividends and other decreases", "movement", reduced),
        closingRow,
      ],
      equityPerPosition, difference, reconciles: Math.abs(difference) < 0.01,
    };
  }

  static async changesInEquity(query = {}) {
    const ctx = await this.context();
    const { from, to, mode, comparative } = this.period(ctx, query);
    const current = this.equityBlock(await this.loadRows(ctx, from, to), from, to);
    const previous = comparative ? this.equityBlock(await this.loadRows(ctx, comparative.from, comparative.to), comparative.from, comparative.to) : null;
    return {
      ...this.head(ctx, "changes-in-equity", "Statement of changes in equity"),
      from, to, compare: mode, columns: [...EQUITY_COLUMNS, { key: "total", label: "Total equity" }],
      current, comparative: previous,
      reconciles: current.reconciles && (previous ? previous.reconciles : true),
    };
  }

  // ---------------------------------------------------------------- 4. Cash flows

  // One period's cash flow figures, every one signed as cash (money in positive, money out
  // negative). A non-cash account's effect on cash is the opposite of its movement
  // (debit minus credit): stock rising uses cash, a payable rising keeps it.
  static async cashFlowFigures(ctx, from, to) {
    const [rows, pl, ledgerCash] = await Promise.all([
      this.loadRows(ctx, from, to),
      this.profitFigures(from, to),
      LedgerReports.cashFlow({ from, to }),
    ]);
    const effect = {};
    for (const r of rows) {
      const bucket = cashFlowBucket(r, ctx);
      effect[bucket] = (effect[bucket] || 0) - r.periodNet;
    }
    const e = (bucket) => r2(effect[bucket] || 0);

    const profitBeforeTax = pl.profitBeforeTax;
    const depreciation = pl.depreciationTotal;
    const financeCosts = pl.financeTotal;
    const disposal = pl.disposalNet;
    const adjustments = sum([depreciation, financeCosts, disposal]);

    const inventory = e("inventory");
    const receivables = e("receivables");
    const payables = e("payables");
    const otherCurrentAssets = e("otherCurrentAssets");
    const otherCurrentLiabilities = e("otherCurrentLiabilities");
    const beforeWorkingCapital = sum([profitBeforeTax, adjustments]);
    const workingCapital = sum([inventory, receivables, payables, otherCurrentAssets, otherCurrentLiabilities]);
    const cashGenerated = sum([beforeWorkingCapital, workingCapital]);

    // finance costs and tax were expensed; what was paid is that, less what is still owed
    const interestPaid = r2(-financeCosts + e("interestPayable"));
    const incomeTaxPaid = r2(-pl.taxTotal + e("taxPayable"));
    const operating = sum([cashGenerated, interestPaid, incomeTaxPaid]);

    // the change in non-current assets already includes depreciation and the book value of
    // disposals, neither of which is a payment
    const nonCurrentAssets = r2(e("nonCurrentAssets") - depreciation - disposal);
    const investing = nonCurrentAssets;

    const borrowings = e("borrowings");
    const equity = e("equity");
    const financing = sum([borrowings, equity]);
    const other = e("unclassified");

    const netIncrease = sum([operating, investing, financing, other]);
    const openingCash = r2(ledgerCash.opening);
    const closingCash = r2(openingCash + netIncrease);
    const closingPerLedger = r2(ledgerCash.closingPerLedger);
    const difference = r2(closingCash - closingPerLedger);
    return {
      profitBeforeTax, depreciation, financeCosts, disposal, adjustments, beforeWorkingCapital,
      inventory, receivables, payables, otherCurrentAssets, otherCurrentLiabilities, workingCapital,
      cashGenerated, interestPaid, incomeTaxPaid, operating,
      nonCurrentAssets, investing, borrowings, equity, financing, other,
      netIncrease, openingCash, closingCash, closingPerLedger, difference, reconciles: Math.abs(difference) < 0.01,
      cashAccounts: ledgerCash.accounts,
    };
  }

  static async cashFlows(query = {}) {
    const ctx = await this.context();
    const { from, to, mode, comparative } = this.period(ctx, query);
    const hasPrevious = Boolean(comparative);
    const cur = await this.cashFlowFigures(ctx, from, to);
    const prev = hasPrevious ? await this.cashFlowFigures(ctx, comparative.from, comparative.to) : null;
    const v = (key) => pair(cur[key], prev?.[key], hasPrevious);
    const line = (key, label, extra = {}) => ({ key, label, ...v(key), ...extra });

    return {
      ...this.head(ctx, "cash-flows", "Statement of cash flows"),
      method: "indirect",
      from, to, compare: mode, comparative: hasPrevious ? comparative : null,
      operating: {
        label: "Cash flows from operating activities",
        profitBeforeTax: line("profitBeforeTax", "Profit before tax"),
        adjustments: {
          label: "Adjustments for",
          lines: [
            line("depreciation", "Depreciation and amortisation"),
            line("financeCosts", "Finance costs"),
            line("disposal", "Loss / (gain) on disposal of non-current assets", { optional: true }),
          ],
          ...v("adjustments"),
        },
        beforeWorkingCapital: line("beforeWorkingCapital", "Operating cash flow before working capital changes"),
        workingCapital: {
          label: "Changes in working capital",
          lines: [
            line("inventory", "(Increase) / decrease in inventories"),
            line("receivables", "(Increase) / decrease in trade and other receivables"),
            line("payables", "Increase / (decrease) in trade and other payables"),
            line("otherCurrentAssets", "(Increase) / decrease in other current assets", { optional: true }),
            line("otherCurrentLiabilities", "Increase / (decrease) in other current liabilities", { optional: true }),
          ],
          ...v("workingCapital"),
        },
        cashGenerated: line("cashGenerated", "Cash generated from operations"),
        interestPaid: line("interestPaid", "Interest paid"),
        incomeTaxPaid: line("incomeTaxPaid", "Income tax paid"),
        net: line("operating", "Net cash from / (used in) operating activities"),
      },
      investing: {
        label: "Cash flows from investing activities",
        lines: [line("nonCurrentAssets", "Net (purchase) / disposal of non-current assets")],
        net: line("investing", "Net cash from / (used in) investing activities"),
      },
      financing: {
        label: "Cash flows from financing activities",
        lines: [
          line("borrowings", "Proceeds from / (repayment of) borrowings and long-term liabilities"),
          line("equity", "Capital introduced / (drawings and dividends)"),
        ],
        net: line("financing", "Net cash from / (used in) financing activities"),
      },
      other: line("other", "Other movements (not classified above)", { optional: true }),
      netIncrease: line("netIncrease", "Net increase / (decrease) in cash and cash equivalents"),
      openingCash: line("openingCash", "Cash and cash equivalents at start of period"),
      closingCash: line("closingCash", "Cash and cash equivalents at end of period"),
      closingPerLedger: line("closingPerLedger", "Cash and bank balance per general ledger"),
      cashAccounts: cur.cashAccounts,
      reconciles: cur.reconciles, difference: cur.difference,
      comparativeReconciles: hasPrevious ? prev.reconciles : null,
      comparativeDifference: hasPrevious ? prev.difference : null,
    };
  }

  // ---------------------------------------------------------------- 5. Notes

  // Balances at the end of a day, from the ledger, for the note tables.
  static noteFigures(ctx, rows) {
    const asset = (r) => nat("ASSET", r.closingNet);
    const liability = (r) => nat("LIABILITY", r.closingNet);
    const inGroup = (set) => rows.filter((r) => r.groupId && set.has(r.groupId));
    const receivables = inGroup(ctx.receivableGroups);
    const payables = inGroup(ctx.payableGroups);
    const byId = new Map(rows.map((r) => [r.accountId, r]));
    const cashRows = ctx.cash.map((a) => {
      const r = byId.get(String(a._id));
      return { accountId: String(a._id), accountCode: a.accountCode, accountName: a.accountName, kind: a.kind, net: r ? r.closingNet : 0 };
    });
    return {
      tradeReceivables: sum(receivables.filter((r) => /^Customer - /.test(r.accountName)).map(asset)),
      otherReceivables: sum(receivables.filter((r) => !/^Customer - /.test(r.accountName)).map(asset)),
      inventory: sum(inGroup(ctx.inventoryGroups).map(asset)),
      inventoryAccounts: inGroup(ctx.inventoryGroups).map((r) => ({ accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, amount: asset(r) })),
      cashRows,
      tradePayables: sum(payables.filter((r) => /^Vendor - /.test(r.accountName)).map(liability)),
      otherPayables: sum(payables.filter((r) => !/^Vendor - /.test(r.accountName)).map(liability)),
      byId,
    };
  }

  static async vatFigures(byId) {
    try {
      const [out, inp] = await Promise.all([AccountConfigService.resolveAccount("vat-sales"), AccountConfigService.resolveAccount("vat-purchase")]);
      const output = byId.get(String(out));
      const input = byId.get(String(inp));
      // VAT the company assesses on its reverse-charge purchases is a liability of its own account (the matching input is in Input VAT
      // above), so it is a third line: left out, the net would count the input and not the liability that offsets it.
      let reverseCharge = 0;
      try {
        const rcm = byId.get(String(await AccountConfigService.resolveAccount("rcm-purchase")));
        reverseCharge = rcm ? nat("LIABILITY", rcm.closingNet) : 0;
      } catch (err) {
        if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
      }
      return { output: output ? nat("LIABILITY", output.closingNet) : 0, input: input ? nat("ASSET", input.closingNet) : 0, reverseCharge };
    } catch (err) {
      if (err.code === "ACCOUNT_NOT_CONFIGURED") return null;
      throw err;
    }
  }

  static async notes(query = {}) {
    const ctx = await this.context();
    const { from, to, mode, comparative } = this.period(ctx, query);
    const hasPrevious = Boolean(comparative);
    const snapshot = async (day) => {
      const f = this.noteFigures(ctx, await this.loadRows(ctx, undefined, day));
      f.vat = await this.vatFigures(f.byId);
      return f;
    };
    const cur = await snapshot(to);
    const prev = hasPrevious ? await snapshot(comparative.to) : null;
    const p = (key) => pair(cur[key], prev?.[key], hasPrevious);

    // open invoices by age, as at the date (the invoices' outstanding amounts as they stand)
    const ageingOf = async (type, ledgerTotal) => {
      const report = await AgeingService.report({ type, asOf: LedgerReports.dayEnd(to) });
      return {
        basis: "Open invoices dated up to the date, aged from their due date; amounts outstanding as they stand now.",
        buckets: report.buckets.map((b) => ({ key: b.key, label: b.label, amount: r2(report.totals[b.key]) })),
        total: r2(report.totals.total), overdue: r2(report.overdue),
        // receipts, payments and credit notes not yet set against an invoice
        notSetAgainstInvoices: r2(ledgerTotal - report.totals.total),
      };
    };
    const [receivableAgeing, payableAgeing] = await Promise.all([ageingOf("receivable", cur.tradeReceivables), ageingOf("payable", cur.tradePayables)]);

    const cashAccounts = cur.cashRows
      .map((c) => ({ ...c, comparativeNet: hasPrevious ? r2(prev.cashRows.find((x) => x.accountId === c.accountId)?.net || 0) : null }))
      .filter((c) => Math.abs(c.net) >= 0.005 || Math.abs(c.comparativeNet || 0) >= 0.005);
    const cashTotal = pair(sum(cur.cashRows.map((c) => c.net)), prev ? sum(prev.cashRows.map((c) => c.net)) : 0, hasPrevious);

    const inventoryAccounts = joinAccounts(cur.inventoryAccounts, prev?.inventoryAccounts || [], hasPrevious);
    const net = (f) => (f.vat ? r2(f.vat.output + (f.vat.reverseCharge || 0) - f.vat.input) : 0);
    const name = ctx.entity.name || "The Company";
    return {
      ...this.head(ctx, "notes", "Notes to the financial statements"),
      asAt: to, from, compare: mode, comparative: hasPrevious ? { asAt: comparative.to, from: comparative.from } : null,
      disclaimer: "Basic notes generated from the general ledger. They are not a complete set of IFRS disclosures and should be reviewed with your accountant.",
      policies: [
        { key: "entity", title: "Reporting entity", text: `${name}${ctx.entity.trn ? ` (TRN ${ctx.entity.trn})` : ""} trades in food products in the United Arab Emirates. These notes accompany the statements for the period ended ${to}.` },
        { key: "basis", title: "Basis of preparation", text: `The statements are prepared in accordance with International Financial Reporting Standards (IFRS) on the historical cost basis, from the company's general ledger. The functional and presentation currency is the ${currencyName()} (${currency()}). Amounts are rounded to two decimal places.` },
        { key: "inventory", title: "Inventories", text: "Inventories are stated at the lower of cost and net realisable value. Cost is the weighted average cost, recalculated on each purchase; a sale takes stock out at the current average and does not change it." },
        { key: "revenue", title: "Revenue recognition", text: "Revenue from the sale of goods is recognised at the point in time control passes to the customer, when the goods are dispatched and invoiced. It is measured at the transaction price net of VAT, discounts and returns (IFRS 15)." },
        { key: "vat", title: "Value added tax", text: "Revenue, expenses and assets are recognised net of VAT. Output VAT charged on sales is a liability to the Federal Tax Authority and input VAT on purchases is recoverable from it; the net is settled with the authority. VAT the company assesses on purchases made under the reverse charge is recorded as a liability to the authority and, where recoverable, as input VAT at the same time." },
        { key: "classification", title: "Current and non-current classification", text: "An asset or liability is non-current when its account group, or any group above it, is named as fixed, non-current, property, plant, equipment, intangible or long-term. All other assets and liabilities are current." },
      ],
      tables: {
        tradeReceivables: {
          title: "Trade and other receivables",
          rows: [
            { key: "trade", label: "Trade receivables (customers)", ...p("tradeReceivables") },
            { key: "other", label: "Advances to vendors and other receivables", ...p("otherReceivables"), optional: true },
          ],
          total: pair(cur.tradeReceivables + cur.otherReceivables, prev ? prev.tradeReceivables + prev.otherReceivables : 0, hasPrevious),
          ageing: receivableAgeing,
        },
        inventory: {
          title: "Inventories",
          accounts: inventoryAccounts,
          total: p("inventory"),
          basis: "Weighted average cost",
        },
        cash: {
          title: "Cash and cash equivalents",
          accounts: cashAccounts.map((c) => ({ accountId: c.accountId, accountCode: c.accountCode, accountName: c.accountName, kind: c.kind, net: c.net, comparativeNet: c.comparativeNet })),
          total: { ...cashTotal, net: cashTotal.amount, comparativeNet: cashTotal.comparative },
        },
        tradePayables: {
          title: "Trade and other payables",
          rows: [
            { key: "trade", label: "Trade payables (vendors)", ...p("tradePayables") },
            { key: "other", label: "Advances from customers and other payables", ...p("otherPayables"), optional: true },
          ],
          total: pair(cur.tradePayables + cur.otherPayables, prev ? prev.tradePayables + prev.otherPayables : 0, hasPrevious),
          ageing: payableAgeing,
        },
        vat: cur.vat
          ? {
              title: "Value added tax",
              rows: [
                { key: "output", label: "Output VAT payable", ...pair(cur.vat.output, prev?.vat?.output, hasPrevious) },
                // shown only when there is some: a company that never bought under the reverse charge sees the two lines it always did
                ...(cur.vat.reverseCharge || prev?.vat?.reverseCharge
                  ? [{ key: "reverseCharge", label: "Reverse-charge VAT payable (self-assessed)", ...pair(cur.vat.reverseCharge, prev?.vat?.reverseCharge, hasPrevious) }]
                  : []),
                { key: "input", label: "Input VAT recoverable", ...pair(cur.vat.input, prev?.vat?.input, hasPrevious) },
              ],
              net: pair(net(cur), prev ? net(prev) : 0, hasPrevious),
            }
          : null,
      },
    };
  }
}

module.exports = IfrsReportsService;
