const mongoose = require("mongoose");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const AccountConfigService = require("../financial/accountConfigService");
const AccountGroupService = require("../financial/accountGroupService");
const AgeingService = require("../financial/ageingService");
const AppError = require("../../utils/AppError");
const { naturalBalance, categoryOf, round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");
const { CLOSING_VOUCHER_TYPE } = require("../../utils/yearEnd");

// Reports read straight from the general ledger, so they cannot disagree with the Trial Balance:
// General ledger, Profit and loss (with gross profit), Day book, Cash and bank book, Cash flow and
// Party balances. A reversed entry never counts. Amounts are signed "net = debit - credit" unless a
// field says otherwise; the screens show them as Dr / Cr.
//
// Dates are calendar days in the organisation's own time zone (utils/orgLocale.js): `from` starts at 00:00 and `to`
// ends at 23:59:59.999 of that day there, the same days people see on screen.
const orgLocale = require("../../utils/orgLocale");
const tz = require("../../utils/tz");

const CATEGORY_ORDER = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
// What a company had when it began keeping books here (utils/openingBalance*, a chart account created with a balance): balances
// brought forward, not activity of the period they are dated in. Dated the go-live day they would otherwise be the first
// period's "movement" - opening cash read 0 and the whole opening position showed up as cash flows and as capital introduced.
const OPENING_TYPES = ["opening", "opening_stock"];
const ymd = /^\d{4}-\d{2}-\d{2}$/;

function bound(value, edge) {
  if (!value) return null;
  const text = String(value);
  const day = text.slice(0, 10);
  if (ymd.test(day)) {
    const [y, m, dd] = day.split("-").map(Number);
    const real = new Date(Date.UTC(y, m - 1, dd));
    if (real.getUTCFullYear() !== y || real.getUTCMonth() !== m - 1 || real.getUTCDate() !== dd) throw new AppError(`"${value}" is not a date`, 400, "INVALID_DATE");
  }
  const d = ymd.test(day) ? (edge === "end" ? orgLocale.endOfDay(day) : orgLocale.dayStart(day)) : new Date(text);
  if (Number.isNaN(d.getTime())) throw new AppError(`"${value}" is not a date`, 400, "INVALID_DATE");
  return d;
}
const dayStart = (v) => bound(v, "start");
const dayEnd = (v) => bound(v, "end");

const VOUCHER_LABEL = {
  receipt: "Receipt", payment: "Payment", journal: "Journal", contra: "Contra", expense: "Expense",
  debit_note: "Debit note", credit_note: "Credit note",
  opening: "Opening balance", opening_stock: "Opening stock", stock_writeoff: "Stock write-off", closing: "Year-end closing",
  sales_order: "Sales invoice", sales_return: "Sales return", purchase_order: "Purchase invoice", purchase_return: "Purchase return",
};
const CASH_FLOW_LABEL = {
  receipt: "Received from customers", payment: "Paid to vendors", expense: "Expenses paid", contra: "Moved between cash and bank",
  journal: "Journal entries", sales_order: "Sales settled at once", purchase_order: "Purchases settled at once",
  sales_return: "Sales returns refunded", purchase_return: "Purchase returns refunded", debit_note: "Debit notes", credit_note: "Credit notes",
  opening: "Opening balances", cheque_clearance: "Cheques cleared",
};
// The order voucher kinds read in on a screen: trade documents, then money, then books, then the rest.
const TYPE_ORDER = [
  "sales_order", "sales_return", "purchase_order", "purchase_return", "receipt", "payment", "expense", "journal", "contra",
  "debit_note", "credit_note", "cheque_clearance", "stock_adjustment", "stock_writeoff", "opening", "opening_stock", "closing",
];
const typeRank = (t) => {
  const i = TYPE_ORDER.indexOf(t);
  return i < 0 ? TYPE_ORDER.length : i;
};
const titleCase = (s) => String(s || "other").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

class LedgerReportsService {
  static VOUCHER_LABEL = VOUCHER_LABEL;
  static dayStart = dayStart;
  static dayEnd = dayEnd;

  // Per account: debits and credits before `from` (opening) and from `from` to `to` (period),
  // with the account's group and category.
  //
  // A year-end closing entry (voucherType "closing", utils/yearEnd.js) is a posting but not activity. One dated BEFORE
  // `from` is part of the balance brought forward - that is how a closed year's profit reaches Retained Earnings and how
  // income and expense start the next year at zero. One dated INSIDE the period is left out of its movement, so the
  // year that was closed still shows the profit it earned. `includeClosing` counts them as the postings they are (the
  // post-closing trial balance).
  static async accountMovements({ from, to, accountIds, includeClosing = false } = {}) {
    const start = dayStart(from);
    const end = dayEnd(to);
    if (start && end && start > end) throw new AppError("from must not be after to", 400, "INVALID_RANGE");
    const match = { isReversed: { $ne: true } };
    if (end) match.date = { $lte: end };
    if (accountIds) match.accountId = { $in: accountIds.map((id) => new mongoose.Types.ObjectId(String(id))) };
    const isOpening = { $in: ["$voucherType", OPENING_TYPES] };
    const before = (f) => (start ? { $cond: [{ $or: [{ $lt: ["$date", start] }, isOpening] }, f, 0] } : 0);
    const notClosing = { $ne: ["$voucherType", CLOSING_VOUCHER_TYPE] };
    const notOpening = { $not: [isOpening] };
    const inPeriod = start
      ? (includeClosing ? { $and: [{ $gte: ["$date", start] }, notOpening] } : { $and: [{ $gte: ["$date", start] }, notClosing, notOpening] })
      : (includeClosing ? null : notClosing);
    const within = (f) => (inPeriod ? { $cond: [inPeriod, f, 0] } : f);

    const rows = await LedgerEntry.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$accountId",
          accountName: { $first: "$accountName" },
          accountCode: { $first: "$accountCode" },
          openingDebit: { $sum: before("$debitAmount") },
          openingCredit: { $sum: before("$creditAmount") },
          periodDebit: { $sum: within("$debitAmount") },
          periodCredit: { $sum: within("$creditAmount") },
        },
      },
      { $lookup: { from: "ledgeraccounts", localField: "_id", foreignField: "_id", as: "acc", pipeline: [{ $project: { accountType: 1, groupId: 1, accountName: 1, accountCode: 1, bank: 1 } }] } },
      { $lookup: { from: "accountgroups", localField: "acc.groupId", foreignField: "_id", as: "grp", pipeline: [{ $project: { category: 1, name: 1, parentGroup: 1 } }] } },
    ]);
    return rows.map((r) => ({
      accountId: r._id,
      accountCode: r.acc?.[0]?.accountCode || r.accountCode,
      accountName: r.acc?.[0]?.accountName || r.accountName,
      groupId: r.acc?.[0]?.groupId || null,
      groupName: r.grp?.[0]?.name || "Ungrouped",
      category: r.grp?.[0]?.category || categoryOf(r.acc?.[0]?.accountType),
      bank: r.acc?.[0]?.bank || null,
      openingDebit: r.openingDebit, openingCredit: r.openingCredit, periodDebit: r.periodDebit, periodCredit: r.periodCredit,
    }));
  }

  // Every group id under the groups the given config keys point at (an unmapped key is skipped).
  static async groupSet(keys) {
    const { companyId } = getTenant();
    const ids = new Set();
    for (const key of keys) {
      let root;
      try {
        root = await AccountConfigService.resolveGroup(key);
      } catch (err) {
        if (err.code === "ACCOUNT_NOT_CONFIGURED") continue;
        throw err;
      }
      for (const id of await AccountGroupService.collectDescendantIds(root, companyId)) ids.add(id);
    }
    return ids;
  }

  // ---------------------------------------------------------------- General ledger

  // Every account with its opening balance, the period's debits and credits, and the closing
  // balance, filed by group. Zero accounts are left out.
  static async generalLedger({ from, to, category, includeZero = false, includeClosing = false } = {}) {
    const rows = await this.accountMovements({ from, to, includeClosing });
    const groups = new Map();
    for (const r of rows) {
      if (category && r.category !== category) continue;
      const opening = round2(r.openingDebit - r.openingCredit);
      const debit = round2(r.periodDebit);
      const credit = round2(r.periodCredit);
      const closing = round2(opening + debit - credit);
      if (!includeZero && !opening && !debit && !credit && !closing) continue;
      const key = String(r.groupId || "none");
      if (!groups.has(key)) groups.set(key, { groupId: r.groupId, name: r.groupName, category: r.category, accounts: [], totals: { opening: 0, debit: 0, credit: 0, closing: 0 } });
      const g = groups.get(key);
      g.accounts.push({ accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, opening, debit, credit, closing });
      for (const [k, v] of Object.entries({ opening, debit, credit, closing })) g.totals[k] = round2(g.totals[k] + v);
    }
    const list = [...groups.values()]
      .map((g) => ({ ...g, accounts: g.accounts.sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode))) }))
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name));
    const totals = { opening: 0, debit: 0, credit: 0, closing: 0 };
    for (const g of list) for (const k of Object.keys(totals)) totals[k] = round2(totals[k] + g.totals[k]);
    return { from: from || null, to: to || null, groups: list, totals };
  }

  // ---------------------------------------------------------------- Profit and loss

  // Revenue less direct costs is the gross profit; other income less operating expenses takes it to
  // the net profit. "Direct" is whatever sits under the sales / purchase / direct income and expense
  // groups of the posting configuration.
  static async profitAndLoss({ from, to } = {}) {
    const rows = await this.accountMovements({ from, to });
    const [directIncome, directCost] = await Promise.all([
      this.groupSet(["sales-income-group", "direct-income-group"]),
      this.groupSet(["purchase-expense-group", "direct-expense-group"]),
    ]);

    const section = (predicate, category) => {
      const byGroup = new Map();
      for (const r of rows.filter((x) => x.category === category && predicate(x))) {
        const amount = round2(naturalBalance(category, r.periodDebit, r.periodCredit));
        if (Math.abs(amount) < 0.005) continue;
        const key = String(r.groupId || "none");
        if (!byGroup.has(key)) byGroup.set(key, { groupId: r.groupId, name: r.groupName, accounts: [], total: 0 });
        const g = byGroup.get(key);
        g.accounts.push({ accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, amount });
        g.total = round2(g.total + amount);
      }
      const groups = [...byGroup.values()].map((g) => ({ ...g, accounts: g.accounts.sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode))) })).sort((a, b) => a.name.localeCompare(b.name));
      return { groups, total: round2(groups.reduce((t, g) => t + g.total, 0)) };
    };
    const isDirectIncome = (r) => directIncome.has(String(r.groupId));
    const isDirectCost = (r) => directCost.has(String(r.groupId));

    // Sales discounts (line and header discounts at invoicing, rebates by credit note) are posted to an expense account so the
    // discount stays visible in the books. The transaction price is net of them (IFRS 15.47, IAS 1.82(a)): they reduce revenue,
    // and gross profit and the margin are measured on what the customer was actually charged. Net profit does not move.
    let discountId = null;
    try {
      discountId = String(await AccountConfigService.resolveAccount("discount-sales"));
    } catch (err) {
      if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    }
    const isDiscount = (r) => discountId && String(r.accountId) === discountId;

    const revenue = section(isDirectIncome, "INCOME");
    const discounts = section(isDiscount, "EXPENSE");
    if (discounts.total) {
      const lines = discounts.groups.flatMap((g) => g.accounts).map((a) => ({ ...a, amount: round2(-a.amount) }));
      revenue.groups.push({ groupId: "sales-discounts", name: "Less: sales discounts and rebates", synthetic: true, accounts: lines, total: round2(-discounts.total) });
      revenue.total = round2(revenue.total - discounts.total);
    }
    const directCosts = section((r) => isDirectCost(r) && !isDiscount(r), "EXPENSE");
    const otherIncome = section((r) => !isDirectIncome(r), "INCOME");
    const operatingExpenses = section((r) => !isDirectCost(r) && !isDiscount(r), "EXPENSE");
    const grossProfit = round2(revenue.total - directCosts.total);
    return {
      from: from || null, to: to || null,
      revenue, directCosts, grossProfit,
      grossMargin: revenue.total ? round2((grossProfit / revenue.total) * 100) : null,
      otherIncome, operatingExpenses,
      netProfit: round2(grossProfit + otherIncome.total - operatingExpenses.total),
    };
  }

  // ---------------------------------------------------------------- Day book and vouchers

  // The cost of goods sold and stock accounts, as ObjectIds (an unmapped key is skipped).
  static async costLegAccountIds() {
    const ids = [];
    for (const key of ["cogs", "inventory-asset"]) {
      try {
        ids.push(new mongoose.Types.ObjectId(String(await AccountConfigService.resolveAccount(key))));
      } catch (err) {
        if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
      }
    }
    return ids;
  }

  // The part of "one row per voucher" that the day book and the daily summary share, so the two cannot disagree about
  // what a voucher is worth. `fields` goes in the $group (by voucherId), `after` in the $addFields that follows.
  //
  // A cheque that clears posts again under the same voucher (voucherType "cheque_clearance": Dr bank, Cr cheques in
  // hand). That moves the money, it is not a second receipt: counting it would show a cleared 300 cheque as a 600
  // receipt. The voucher's amount and type are those of its own posting; a period holding only the clearing shows it
  // as a "Cheque clearance" of the cheque's amount. A sale's amount is the invoice: its cost-of-goods and stock legs
  // are left out.
  static voucherRow(costIds) {
    const isClearing = { $eq: ["$voucherType", "cheque_clearance"] };
    return {
      fields: {
        voucherType: { $max: { $cond: [isClearing, null, "$voucherType"] } },
        debitAll: { $sum: "$debitAmount" },
        amount: {
          $sum: {
            $cond: [
              { $or: [isClearing, ...(costIds.length ? [{ $and: [{ $in: ["$voucherType", ["sales_order", "sales_return"]] }, { $in: ["$accountId", costIds] }] }] : [])] },
              0,
              "$debitAmount",
            ],
          },
        },
        clearing: { $sum: { $cond: [isClearing, "$debitAmount", 0] } },
        credit: { $sum: "$creditAmount" },
      },
      after: { voucherType: { $ifNull: ["$voucherType", "cheque_clearance"] }, amount: { $cond: [{ $gt: ["$amount", 0] }, "$amount", "$clearing"] } },
    };
  }

  // One line per voucher (an invoice, a receipt, a journal...) in date order, with what moved and
  // who it concerned. `includeLines` adds each voucher's debit and credit lines (the journals register).
  static async dayBook({ from, to, type, search, page = 1, limit = 50, includeLines = false } = {}) {
    const start = dayStart(from);
    const end = dayEnd(to);
    const match = { isReversed: { $ne: true } };
    if (start || end) match.date = { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) };
    if (type) match.voucherType = type;

    const costIds = await this.costLegAccountIds();
    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = (Math.max(Number(page) || 1, 1) - 1) * size;
    const row = this.voucherRow(costIds);
    const group = {
      _id: "$voucherId",
      date: { $min: "$date" },
      voucherNo: { $first: "$voucherNo" },
      ...row.fields,
      narration: { $max: "$narration" },
      accounts: { $addToSet: "$accountName" },
      lineCount: { $sum: 1 },
      ...(includeLines ? { lines: { $push: { accountId: "$accountId", accountCode: "$accountCode", accountName: "$accountName", debit: "$debitAmount", credit: "$creditAmount", narration: "$narration" } } } : {}),
    };
    const pipeline = [
      { $match: match },
      { $group: group },
      { $addFields: row.after },
    ];
    const needle = String(search || "").trim();
    if (needle) {
      const rx = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      pipeline.push({ $match: { $or: [{ voucherNo: rx }, { narration: rx }, { accounts: rx }] } });
    }
    pipeline.push({
      $facet: {
        rows: [{ $sort: { date: -1, voucherNo: -1 } }, { $skip: skip }, { $limit: size }],
        count: [{ $count: "n" }],
        byType: [{ $group: { _id: "$voucherType", amount: { $sum: "$amount" }, count: { $sum: 1 } } }],
      },
    });
    const [res] = await LedgerEntry.aggregate(pipeline);
    const partyOf = (accounts) => {
      const hit = accounts.find((a) => /^(Customer|Vendor)( Advance)? - |^Advance to Vendor - /.test(a));
      return hit ? hit.replace(/^(Customer|Vendor)( Advance)? - |^Advance to Vendor - /, "") : "";
    };
    return {
      from: from || null, to: to || null, page: Number(page) || 1, limit: size,
      total: res.count[0]?.n || 0,
      rows: res.rows.map((r) => ({
        voucherId: r._id, date: r.date, voucherNo: r.voucherNo, voucherType: r.voucherType,
        typeLabel: VOUCHER_LABEL[r.voucherType] || titleCase(r.voucherType),
        party: partyOf(r.accounts), narration: r.narration || "", amount: round2(r.amount),
        balanced: Math.abs(r.debitAll - r.credit) < 0.01, lineCount: r.lineCount,
        ...(includeLines ? { lines: r.lines.map((l) => ({ ...l, debit: round2(l.debit), credit: round2(l.credit) })).sort((a, b) => (b.debit > 0) - (a.debit > 0)) } : {}),
      })),
      byType: res.byType
        .map((t) => ({ voucherType: t._id, label: VOUCHER_LABEL[t._id] || titleCase(t._id), amount: round2(t.amount), count: t.count }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  // The balanced debit and credit lines one voucher posted.
  static async voucherImpact(voucherId) {
    if (!mongoose.isValidObjectId(voucherId)) throw new AppError("Invalid voucher", 400);
    const lines = await LedgerEntry.find({ voucherId, isReversed: { $ne: true } }).sort({ debitAmount: -1, createdAt: 1 }).lean();
    if (!lines.length) throw new AppError("Nothing was posted for this voucher", 404, "NOT_POSTED");
    const debit = round2(lines.reduce((t, l) => t + l.debitAmount, 0));
    const credit = round2(lines.reduce((t, l) => t + l.creditAmount, 0));
    return {
      voucherId, voucherNo: lines[0].voucherNo, voucherType: lines[0].voucherType, typeLabel: VOUCHER_LABEL[lines[0].voucherType] || titleCase(lines[0].voucherType),
      date: lines[0].date,
      lines: lines.map((l) => ({ accountId: l.accountId, accountCode: l.accountCode, accountName: l.accountName, debit: round2(l.debitAmount), credit: round2(l.creditAmount), narration: l.narration || "" })),
      totals: { debit, credit }, balanced: Math.abs(debit - credit) < 0.01,
    };
  }

  // ---------------------------------------------------------------- Cash and bank

  static async cashBankAccounts(kind) {
    const wanted = kind === "cash" ? ["cash-account-group"] : kind === "bank" ? ["bank-account-group"] : ["cash-account-group", "bank-account-group"];
    const cash = await this.groupSet(["cash-account-group"]);
    const ids = await this.groupSet(wanted);
    const found = await LedgerAccount.find({ groupId: { $in: [...ids] } }).select("accountCode accountName groupId bank isActive").sort({ accountCode: 1 }).lean();
    // An account switched off later still holds what it held: leaving it out made every past period's cash book, cash flow and
    // statement of financial position stop agreeing with the ledger. A switched-off account with no entries is not listed.
    const off = found.filter((a) => a.isActive === false).map((a) => a._id);
    const used = off.length ? new Set((await LedgerEntry.distinct("accountId", { accountId: { $in: off }, isReversed: { $ne: true } })).map(String)) : new Set();
    const accounts = found.filter((a) => a.isActive !== false || used.has(String(a._id)));
    return accounts.map((a) => ({ ...a, kind: cash.has(String(a.groupId)) ? "cash" : "bank" }));
  }

  // Each cash and bank account: opening, money in (debits), money out (credits), closing.
  static async cashBook({ from, to, kind } = {}) {
    const accounts = await this.cashBankAccounts(kind);
    const movements = new Map((await this.accountMovements({ from, to, accountIds: accounts.map((a) => a._id) })).map((m) => [String(m.accountId), m]));
    const rows = accounts.map((a) => {
      const m = movements.get(String(a._id));
      const opening = round2((m?.openingDebit || 0) - (m?.openingCredit || 0));
      const receipts = round2(m?.periodDebit || 0);
      const payments = round2(m?.periodCredit || 0);
      return { accountId: a._id, accountCode: a.accountCode, accountName: a.accountName, kind: a.kind, bankId: a.bank?.bankId || null, accountNumber: a.bank?.accountNumber || "", opening, receipts, payments, closing: round2(opening + receipts - payments) };
    });
    const total = (list) => ({
      opening: round2(list.reduce((t, r) => t + r.opening, 0)), receipts: round2(list.reduce((t, r) => t + r.receipts, 0)),
      payments: round2(list.reduce((t, r) => t + r.payments, 0)), closing: round2(list.reduce((t, r) => t + r.closing, 0)),
    });
    return { from: from || null, to: to || null, rows, totals: { cash: total(rows.filter((r) => r.kind === "cash")), bank: total(rows.filter((r) => r.kind === "bank")), all: total(rows) } };
  }

  // Where cash and bank money came from and went to, by kind of voucher. A voucher counts by its
  // net effect on cash and bank together, so a move from cash to bank is neither in nor out.
  static async cashFlow({ from, to } = {}) {
    const accounts = await this.cashBankAccounts();
    const ids = accounts.map((a) => a._id);
    const start = dayStart(from);
    const end = dayEnd(to);
    if (start && end && start > end) throw new AppError("from must not be after to", 400, "INVALID_RANGE");
    const base = { accountId: { $in: ids }, isReversed: { $ne: true } };

    const sumNet = async (extra) => {
      const [r] = await LedgerEntry.aggregate([{ $match: { ...base, ...extra } }, { $group: { _id: null, net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } }]);
      return round2(r?.net || 0);
    };
    // opening-balance vouchers are balances brought forward whatever day they are dated, and not money that moved in the period
    const opening = start
      ? await sumNet({ $or: [{ date: { $lt: start } }, { voucherType: { $in: OPENING_TYPES }, ...(end ? { date: { $lte: end } } : {}) }] })
      : 0;
    const closingPerLedger = await sumNet(end ? { date: { $lte: end } } : {});

    const dateMatch = start || end ? { date: { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) } } : {};
    const perVoucher = await LedgerEntry.aggregate([
      { $match: { ...base, ...dateMatch, ...(start ? { voucherType: { $nin: OPENING_TYPES } } : {}) } },
      { $group: { _id: "$voucherId", type: { $first: "$voucherType" }, net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
      { $group: { _id: "$type", inflow: { $sum: { $cond: [{ $gt: ["$net", 0] }, "$net", 0] } }, outflow: { $sum: { $cond: [{ $lt: ["$net", 0] }, { $multiply: ["$net", -1] }, 0] } }, count: { $sum: 1 } } },
    ]);
    const lines = perVoucher
      .map((t) => ({ voucherType: t._id, label: CASH_FLOW_LABEL[t._id] || titleCase(t._id), inflow: round2(t.inflow), outflow: round2(t.outflow), net: round2(t.inflow - t.outflow), count: t.count }))
      .filter((l) => l.inflow || l.outflow)
      .sort((a, b) => b.inflow - b.outflow - (a.inflow - a.outflow));
    const totalIn = round2(lines.reduce((t, l) => t + l.inflow, 0));
    const totalOut = round2(lines.reduce((t, l) => t + l.outflow, 0));
    const closing = round2(opening + totalIn - totalOut);
    return { from: from || null, to: to || null, accounts: accounts.length, opening, lines, totalIn, totalOut, net: round2(totalIn - totalOut), closing, closingPerLedger, reconciles: Math.abs(closing - closingPerLedger) < 0.01 };
  }

  // ---------------------------------------------------------------- Daily voucher summary

  // The day book by day: for each day, how many vouchers of each kind were posted and what they came to, and how many
  // of them did not balance. A voucher is worth what the day book says it is (voucherRow), and falls on the day of its
  // first posting in the organisation's own calendar, so a day's figures are the day book's for that day.
  static async dailySummary({ from, to } = {}) {
    const start = dayStart(from);
    const end = dayEnd(to);
    const match = { isReversed: { $ne: true } };
    if (start || end) match.date = { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) };
    const row = this.voucherRow(await this.costLegAccountIds());
    const found = await LedgerEntry.aggregate([
      { $match: match },
      { $group: { _id: "$voucherId", date: { $min: "$date" }, ...row.fields } },
      { $addFields: row.after },
      {
        $group: {
          _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: orgLocale.timezone() } }, type: "$voucherType" },
          count: { $sum: 1 },
          amount: { $sum: "$amount" },
          unbalanced: { $sum: { $cond: [{ $gte: [{ $abs: { $subtract: ["$debitAll", "$credit"] } }, 0.01] }, 1, 0] } },
        },
      },
    ]);

    const days = new Map();
    const totals = { count: 0, unbalanced: 0, byType: {} };
    const types = new Set();
    for (const r of found) {
      const type = r._id.type;
      types.add(type);
      const day = days.get(r._id.day) || { day: r._id.day, count: 0, unbalanced: 0, byType: {} };
      day.byType[type] = { count: r.count, amount: round2(r.amount) };
      day.count += r.count;
      day.unbalanced += r.unbalanced;
      days.set(r._id.day, day);
      const t = totals.byType[type] || { count: 0, amount: 0 };
      totals.byType[type] = { count: t.count + r.count, amount: round2(t.amount + r.amount) };
      totals.count += r.count;
      totals.unbalanced += r.unbalanced;
    }
    const label = (t) => VOUCHER_LABEL[t] || titleCase(t);
    return {
      from: from || null, to: to || null,
      types: [...types].sort((a, b) => typeRank(a) - typeRank(b) || label(a).localeCompare(label(b))).map((t) => ({ voucherType: t, label: label(t) })),
      days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
      totals,
    };
  }

  // ---------------------------------------------------------------- Day end: cash and bank

  // The cash and bank position for ONE day, as the cashier closes it: each account's opening, what came in, what went
  // out and what it holds at the end of the day, where the money came from and went to, and whether the day agrees
  // with the ledger. Built from the cash book and the cash flow, so it cannot disagree with either.
  // (Named dayEndSummary because LedgerReportsService.dayEnd is already the end-of-day DATE helper others call.)
  static async dayEndSummary({ date } = {}) {
    const day = date ? String(date).slice(0, 10) : orgLocale.today();
    const start = dayStart(day); // refuses what is not a date
    const end = dayEnd(day);
    const [book, flow] = await Promise.all([this.cashBook({ from: day, to: day }), this.cashFlow({ from: day, to: day })]);
    const ids = book.rows.map((r) => r.accountId);
    const touched = ids.length
      ? await LedgerEntry.aggregate([
          { $match: { accountId: { $in: ids }, isReversed: { $ne: true }, date: { $gte: start, $lte: end } } },
          { $group: { _id: "$accountId", vouchers: { $addToSet: "$voucherId" } } },
        ])
      : [];
    const vouchersOf = new Map(touched.map((t) => [String(t._id), t.vouchers.length]));
    const all = book.totals.all;
    const moved = round2(all.receipts - flow.totalIn);
    return {
      date: day,
      accounts: book.rows.map((r) => ({ ...r, vouchers: vouchersOf.get(String(r.accountId)) || 0 })),
      totals: book.totals,
      // where the money came from and went to, by kind of voucher (a move between two accounts of your own is in neither)
      sources: flow.lines, moneyIn: flow.totalIn, moneyOut: flow.totalOut,
      movedBetweenAccounts: Math.abs(moved) < 0.005 ? 0 : moved,
      hadActivity: all.receipts !== 0 || all.payments !== 0,
      closingPerLedger: flow.closingPerLedger,
      reconciles: flow.reconciles && Math.abs(all.closing - flow.closingPerLedger) < 0.01 && Math.abs(all.opening - flow.opening) < 0.01,
    };
  }

  // The day-end position of cash and of bank for each day that had a movement in a range: what came in, what went out,
  // and what was held at the end of the day. Only days with a movement are listed; the balance on any other day is the
  // balance of the day before it.
  static async dayEndRegister({ from, to } = {}) {
    const endDay = to ? String(to).slice(0, 10) : orgLocale.today();
    const startDay = from ? String(from).slice(0, 10) : tz.addDays(endDay, -13);
    const start = dayStart(startDay);
    const end = dayEnd(endDay);
    if (start > end) throw new AppError("from must not be after to", 400, "INVALID_RANGE");

    const accounts = await this.cashBankAccounts();
    const kindOf = new Map(accounts.map((a) => [String(a._id), a.kind]));
    const ids = accounts.map((a) => a._id);
    const dayOf = { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: orgLocale.timezone() } };
    const rows = ids.length
      ? await LedgerEntry.aggregate([
          { $match: { accountId: { $in: ids }, isReversed: { $ne: true }, date: { $lte: end } } },
          { $group: { _id: { day: { $cond: [{ $lt: ["$date", start] }, "before", dayOf] }, accountId: "$accountId" }, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
        ])
      : [];

    const opening = { cash: 0, bank: 0 };
    const byDay = new Map();
    for (const r of rows) {
      const kind = kindOf.get(String(r._id.accountId));
      if (!kind) continue;
      if (r._id.day === "before") {
        opening[kind] = round2(opening[kind] + r.debit - r.credit);
        continue;
      }
      const d = byDay.get(r._id.day) || { day: r._id.day, cash: { in: 0, out: 0 }, bank: { in: 0, out: 0 } };
      d[kind].in = round2(d[kind].in + r.debit);
      d[kind].out = round2(d[kind].out + r.credit);
      byDay.set(r._id.day, d);
    }
    let cash = opening.cash;
    let bank = opening.bank;
    const days = [...byDay.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((d) => {
        cash = round2(cash + d.cash.in - d.cash.out);
        bank = round2(bank + d.bank.in - d.bank.out);
        return { day: d.day, cash: { ...d.cash, closing: cash }, bank: { ...d.bank, closing: bank }, closing: round2(cash + bank) };
      });
    return {
      from: startDay, to: endDay,
      opening: { ...opening, all: round2(opening.cash + opening.bank) },
      days,
      closing: { cash, bank, all: round2(cash + bank) },
    };
  }

  // ---------------------------------------------------------------- Party balances

  // What each customer owes (or each vendor is owed) on a date, read from the party accounts of
  // the ledger. Customers also carry their credit limit, how much of it is used, and what is overdue.
  // What the party accounts hold at the end of the day, against what the open invoices add up to. `unapplied` is the difference:
  // returns, credit notes and balances on account that have not been set against an invoice (negative when they exceed the debits).
  static async ageingReconciliation({ type = "receivable", asOf, ageingTotal = 0 } = {}) {
    const customer = type === "receivable";
    const accounts = await LedgerAccount.find({ accountName: customer ? /^Customer - / : /^Vendor - / }).select("_id").lean();
    const end = asOf ? new Date(asOf) : new Date();
    const [row] = await LedgerEntry.aggregate([
      { $match: { accountId: { $in: accounts.map((a) => a._id) }, isReversed: { $ne: true }, date: { $lte: end } } },
      { $group: { _id: null, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
    ]);
    const ledger = round2(customer ? (row?.debit || 0) - (row?.credit || 0) : (row?.credit || 0) - (row?.debit || 0));
    return { ledger, ageing: round2(ageingTotal), unapplied: round2(ledger - ageingTotal) };
  }

  static async partyBalances({ type = "customer", asOn, includeZero = false } = {}) {
    if (!["customer", "vendor"].includes(type)) throw new AppError("type must be customer or vendor", 400);
    const customer = type === "customer";
    const rx = customer ? /^Customer( Advance)? - / : /^(Vendor|Advance to Vendor) - /;
    const accounts = await LedgerAccount.find({ accountName: rx }).select("accountName").lean();
    const nameOf = new Map(accounts.map((a) => [String(a._id), a.accountName.replace(rx, "")]));
    const end = dayEnd(asOn || orgLocale.today());
    const sums = await LedgerEntry.aggregate([
      { $match: { accountId: { $in: accounts.map((a) => a._id) }, isReversed: { $ne: true }, date: { $lte: end } } },
      { $group: { _id: "$accountId", debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
    ]);
    const byName = new Map();
    // what the party has paid us (or we them) in advance: the balance of their advance accounts, kept apart from the invoiced balance
    const advanceIds = new Set(accounts.filter((a) => /^(Customer Advance|Advance to Vendor) - /.test(a.accountName)).map((a) => String(a._id)));
    const heldFor = new Map();
    for (const s of sums) {
      const name = nameOf.get(String(s._id));
      const amount = customer ? s.debit - s.credit : s.credit - s.debit;
      byName.set(name, round2((byName.get(name) || 0) + amount));
      if (advanceIds.has(String(s._id))) heldFor.set(name, round2((heldFor.get(name) || 0) - amount)); // positive = held in the party's favour
    }

    const Party = customer ? Customer : Vendor;
    const nameField = customer ? "customerName" : "vendorName";
    const parties = await Party.find({ [nameField]: { $in: [...byName.keys()] } }).select(`${nameField} ${customer ? "customerId creditLimit" : "vendorId"} paymentTerms`).lean();
    const partyByName = new Map(parties.map((p) => [p[nameField], p]));
    const ageing = await AgeingService.report({ type: customer ? "receivable" : "payable", asOf: end });
    const overdueOf = new Map(ageing.rows.map((r) => [r.partyName, round2(r.total - r.buckets.current)]));

    let rows = [...byName.entries()].map(([name, balance]) => {
      const p = partyByName.get(name);
      const limit = customer ? Number(p?.creditLimit) || 0 : 0;
      const used = customer && limit > 0 ? round2((Math.max(balance, 0) / limit) * 100) : null;
      return {
        partyId: p?._id || null, partyCode: p?.[customer ? "customerId" : "vendorId"] || "", partyName: name,
        paymentTerms: p?.paymentTerms || "", balance, onAccount: heldFor.get(name) || 0,
        ...(customer ? { creditLimit: limit, available: limit > 0 ? round2(limit - balance) : null, utilisation: used, status: limit <= 0 ? "no-limit" : balance > limit ? "over" : used >= 80 ? "near" : "ok" } : {}),
        overdue: overdueOf.get(name) || 0,
      };
    });
    if (!includeZero) rows = rows.filter((r) => Math.abs(r.balance) >= 0.005);
    rows.sort((a, b) => b.balance - a.balance);
    return {
      type, asOn: asOn || null, rows,
      totals: {
        owed: round2(rows.filter((r) => r.balance > 0).reduce((t, r) => t + r.balance, 0)),
        advances: round2(rows.filter((r) => r.balance < 0).reduce((t, r) => t - r.balance, 0)),
        net: round2(rows.reduce((t, r) => t + r.balance, 0)),
        // advances proper (the party's advance accounts), unlike `advances` above, which is any account whose net is on the other side
        onAccount: round2(rows.reduce((t, r) => t + Math.max(r.onAccount, 0), 0)),
        overdue: round2(rows.reduce((t, r) => t + r.overdue, 0)),
        ...(customer ? { overLimit: rows.filter((r) => r.status === "over").length, nearLimit: rows.filter((r) => r.status === "near").length } : {}),
      },
    };
  }
}

module.exports = LedgerReportsService;
