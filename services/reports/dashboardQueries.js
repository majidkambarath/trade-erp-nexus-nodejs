const Transaction = require("../../models/modules/transactionModel");
const { Voucher, LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountGroup = require("../../models/modules/financial/accountGroupModel");
const AccountConfigService = require("../financial/accountConfigService");
const LedgerReports = require("./ledgerReportsService");
const { naturalBalance, categoryOf, round2 } = require("../../utils/accounting");
const orgLocale = require("../../utils/orgLocale");
const { CLOSING_VOUCHER_TYPE } = require("../../utils/yearEnd");

// The aggregations behind the home dashboard that no report offers by month, week or hour. Each is
// ONE pass over its collection (grouped by Dubai month / day), so a 8-month chart costs one query
// and not eight reports. Wherever a report already defines a figure, the same definition is used
// here (the same groups, the same approved statuses, the same VAT-exclusive line value), and the
// tests check these series against that report month by month.

// Grouping by day and month happens in the organisation's own zone, read each time a pipeline is built.
const tzName = () => orgLocale.timezone();
// Approval is a status of its own; PAID / PARTIAL are what documents approved by older versions may still carry.
const APPROVED = ["APPROVED", "PAID", "PARTIAL"];

const monthKey = (field) => ({ $dateToString: { format: "%Y-%m", date: field, timezone: tzName() } });
const dayKey = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: tzName() } });
// A document line's value before VAT, after its discount (what the stock reports call net)
const LINE_NET = { $subtract: ["$items.lineTotal", { $ifNull: ["$items.vatAmount", 0] }] };

// ---------------------------------------------------------------- dates (the organisation's calendar days as "YYYY-MM-DD")

const pad = (n) => String(n).padStart(2, "0");
const utc = (ymd) => new Date(`${ymd}T00:00:00Z`);
const ymdOf = (date) => date.toISOString().slice(0, 10);
const addDays = (ymd, n) => ymdOf(new Date(utc(ymd).getTime() + n * 86400000));
const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / 86400000);
const lastDayOf = (month) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};
function shiftMonth(month, delta) {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
// `count` months ending with `lastMonth`, oldest first
const monthRange = (lastMonth, count) => Array.from({ length: count }, (_, i) => shiftMonth(lastMonth, i - (count - 1)));
// Monday of the week a day falls in
const weekStart = (ymd) => addDays(ymd, -((utc(ymd).getUTCDay() + 6) % 7));
const quarterStart = (ymd) => `${ymd.slice(0, 4)}-${pad(Math.floor((Number(ymd.slice(5, 7)) - 1) / 3) * 3 + 1)}-01`;

const range = (from, to) => ({ $gte: LedgerReports.dayStart(from), $lte: LedgerReports.dayEnd(to) });

// ---------------------------------------------------------------- the ledger by month

// Per account: its group and the category the profit and loss files it under.
async function accountClasses(ids) {
  const accounts = await LedgerAccount.find({ _id: { $in: ids } }).select("groupId accountType").lean();
  const groups = await AccountGroup.find({ _id: { $in: [...new Set(accounts.map((a) => a.groupId).filter(Boolean))] } }).select("category").lean();
  const category = new Map(groups.map((g) => [String(g._id), g.category]));
  return new Map(accounts.map((a) => [String(a._id), { groupId: a.groupId ? String(a.groupId) : null, category: category.get(String(a.groupId)) || categoryOf(a.accountType) }]));
}

// Revenue, direct costs, gross profit and net profit for each month - the profit and loss's own
// definitions (direct income / direct cost groups of the posting map), one query for all months.
async function monthlyProfit(months, lastDay) {
  const [rows, directIncome, directCost] = await Promise.all([
    // the year-end closing entry takes a year's income and expense to equity: it is not December's trading
    LedgerEntry.aggregate([
      { $match: { isReversed: { $ne: true }, voucherType: { $ne: CLOSING_VOUCHER_TYPE }, date: range(`${months[0]}-01`, lastDay) } },
      { $group: { _id: { month: monthKey("$date"), accountId: "$accountId" }, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
    ]),
    LedgerReports.groupSet(["sales-income-group", "direct-income-group"]),
    LedgerReports.groupSet(["purchase-expense-group", "direct-expense-group"]),
  ]);
  const classes = await accountClasses([...new Set(rows.map((r) => String(r._id.accountId)))]);
  const out = new Map(months.map((m) => [m, { revenue: 0, directCosts: 0, income: 0, expense: 0 }]));
  for (const r of rows) {
    const cls = classes.get(String(r._id.accountId)) || { groupId: null, category: "ASSET" };
    if (cls.category !== "INCOME" && cls.category !== "EXPENSE") continue;
    const bucket = out.get(r._id.month);
    const amount = round2(naturalBalance(cls.category, r.debit, r.credit));
    if (!bucket || Math.abs(amount) < 0.005) continue;
    if (cls.category === "INCOME") {
      bucket.income = round2(bucket.income + amount);
      if (directIncome.has(cls.groupId)) bucket.revenue = round2(bucket.revenue + amount);
    } else {
      bucket.expense = round2(bucket.expense + amount);
      if (directCost.has(cls.groupId)) bucket.directCosts = round2(bucket.directCosts + amount);
    }
  }
  return months.map((month) => {
    const b = out.get(month);
    const grossProfit = round2(b.revenue - b.directCosts);
    return { month, revenue: b.revenue, directCosts: b.directCosts, grossProfit, netProfit: round2(b.income - b.expense) };
  });
}

// One posting account's movement by month (the VAT on sales, say). `side` is the side it is read on.
// `excludeJournals`: the movement the documents made. The quarter's VAT is cleared against these accounts by a journal (paying the
// tax authority), which would otherwise show as a month of negative output VAT.
async function accountMonthly(configKey, months, lastDay, side, { excludeJournals = false } = {}) {
  let accountId;
  try {
    accountId = await AccountConfigService.resolveAccount(configKey);
  } catch (err) {
    if (err.code === "ACCOUNT_NOT_CONFIGURED") return { available: false, values: months.map(() => 0) };
    throw err;
  }
  const rows = await LedgerEntry.aggregate([
    { $match: { accountId, isReversed: { $ne: true }, date: range(`${months[0]}-01`, lastDay), ...(excludeJournals ? { voucherType: { $ne: "journal" } } : {}) } },
    { $group: { _id: monthKey("$date"), debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
  ]);
  const by = new Map(rows.map((r) => [r._id, side === "credit" ? r.credit - r.debit : r.debit - r.credit]));
  return { available: true, values: months.map((m) => round2(by.get(m) || 0)) };
}

// The Inventory account's balance at the end of each month (the last one at `lastDay`).
async function inventoryBalances(months, lastDay) {
  let accountId;
  try {
    accountId = await AccountConfigService.resolveAccount("inventory-asset");
  } catch (err) {
    if (err.code === "ACCOUNT_NOT_CONFIGURED") return { available: false, values: months.map(() => 0) };
    throw err;
  }
  const start = LedgerReports.dayStart(`${months[0]}-01`);
  const rows = await LedgerEntry.aggregate([
    { $match: { accountId, isReversed: { $ne: true }, date: { $lte: LedgerReports.dayEnd(lastDay) } } },
    { $group: { _id: { $cond: [{ $lt: ["$date", start] }, "before", monthKey("$date")] }, net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
  ]);
  const by = new Map(rows.map((r) => [r._id, r.net]));
  let running = by.get("before") || 0;
  const values = months.map((m) => {
    running += by.get(m) || 0;
    return round2(running);
  });
  return { available: true, values };
}

// Money in and out of the cash and bank accounts by month. A voucher counts by its net effect on
// cash and bank together, so a move between them is neither in nor out (as in the cash flow report).
async function cashFlowMonthly(months, lastDay) {
  const accounts = await LedgerReports.cashBankAccounts();
  const rows = accounts.length
    ? await LedgerEntry.aggregate([
        { $match: { accountId: { $in: accounts.map((a) => a._id) }, isReversed: { $ne: true }, date: range(`${months[0]}-01`, lastDay) } },
        { $group: { _id: "$voucherId", date: { $min: "$date" }, net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
        {
          $group: {
            _id: monthKey("$date"),
            inflow: { $sum: { $cond: [{ $gt: ["$net", 0] }, "$net", 0] } },
            outflow: { $sum: { $cond: [{ $lt: ["$net", 0] }, { $multiply: ["$net", -1] }, 0] } },
          },
        },
      ])
    : [];
  const by = new Map(rows.map((r) => [r._id, r]));
  return { accounts: accounts.length, months: months.map((month) => ({ month, inflow: round2(by.get(month)?.inflow || 0), outflow: round2(by.get(month)?.outflow || 0) })) };
}

// ---------------------------------------------------------------- trade documents

// Sales and purchases by month, VAT excluded, returns taken off (the stock reports' net value).
async function monthlyTrade(months, lastDay) {
  const rows = await Transaction.aggregate([
    { $match: { status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(`${months[0]}-01`, lastDay) } },
    { $unwind: "$items" },
    { $group: { _id: { month: monthKey("$date"), type: "$type" }, net: { $sum: LINE_NET } } },
  ]);
  const by = new Map(rows.map((r) => [`${r._id.month}|${r._id.type}`, r.net]));
  const net = (m, type) => by.get(`${m}|${type}`) || 0;
  return months.map((month) => ({
    month,
    sales: round2(net(month, "sales_order") - net(month, "sales_return")),
    purchases: round2(net(month, "purchase_order") - net(month, "purchase_return")),
  }));
}

// Net sales by item and month (a sales return counts against its item). `itemId` narrows to one item.
async function itemSalesByMonth(months, lastDay, itemId) {
  const rows = await Transaction.aggregate([
    { $match: { type: { $in: ["sales_order", "sales_return"] }, status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(`${months[0]}-01`, lastDay) } },
    { $unwind: "$items" },
    ...(itemId ? [{ $match: { "items.itemId": itemId } }] : []),
    { $group: { _id: { month: monthKey("$date"), item: "$items.itemId", type: "$type" }, net: { $sum: LINE_NET } } },
  ]);
  const sign = (type) => (type === "sales_return" ? -1 : 1);
  return rows.map((r) => ({ month: r._id.month, itemId: String(r._id.item), net: sign(r._id.type) * r.net }));
}

// Approved sales invoices of a period: how many, their value before VAT, and their total with VAT.
async function invoiceStats(from, to) {
  const [row] = await Transaction.aggregate([
    { $match: { type: "sales_order", status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(from, to) } },
    { $unwind: "$items" },
    { $group: { _id: "$_id", net: { $sum: LINE_NET }, total: { $first: "$totalAmount" } } },
    { $group: { _id: null, invoices: { $sum: 1 }, net: { $sum: "$net" }, total: { $sum: "$total" } } },
  ]);
  return { invoices: row?.invoices || 0, net: round2(row?.net || 0), total: round2(row?.total || 0) };
}

// Approved documents of one type in a period, with VAT: how many and what they come to (what is actually owed on them).
// Opening balances are left out, as in invoiceStats.
async function documentTotals(type, from, to) {
  const [row] = await Transaction.aggregate([
    { $match: { type, status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(from, to) } },
    { $group: { _id: null, documents: { $sum: 1 }, total: { $sum: "$totalAmount" } } },
  ]);
  return { documents: row?.documents || 0, total: round2(row?.total || 0) };
}

// The calendar day of the first approved sales invoice (null when there is none): a business that began selling a
// fortnight ago has two weeks of history, and the cash cycle must not pretend to have ninety days of it.
async function firstSaleDay() {
  const [row] = await Transaction.aggregate([
    { $match: { type: "sales_order", status: { $in: APPROVED }, isOpening: { $ne: true } } },
    { $group: { _id: null, first: { $min: "$date" } } },
    { $project: { _id: 0, day: dayKey("$first") } },
  ]);
  return row?.day || null;
}

// Sales and purchase orders of a period by status.
async function orderStatuses(from, to) {
  const rows = await Transaction.aggregate([
    { $match: { type: { $in: ["sales_order", "purchase_order"] }, isOpening: { $ne: true }, date: range(from, to) } },
    { $group: { _id: { type: "$type", status: "$status" }, n: { $sum: 1 } } },
  ]);
  const count = (type, pick) => rows.filter((r) => r._id.type === type && pick(r._id.status)).reduce((t, r) => t + r.n, 0);
  return {
    sales: { all: count("sales_order", () => true), approved: count("sales_order", (s) => APPROVED.includes(s)) },
    purchases: { all: count("purchase_order", () => true), drafts: count("purchase_order", (s) => s === "DRAFT") },
  };
}

// Orders waiting for approval, whenever they are dated.
async function drafts(type) {
  const [row] = await Transaction.aggregate([
    { $match: { type, status: "DRAFT", isOpening: { $ne: true } } },
    { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$totalAmount" } } },
  ]);
  return { count: row?.count || 0, value: round2(row?.value || 0) };
}

// Approved sales invoices and sales returns per day.
async function dailyOrders(from, to) {
  const rows = await Transaction.aggregate([
    { $match: { type: { $in: ["sales_order", "sales_return"] }, status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(from, to) } },
    { $group: { _id: { day: dayKey("$date"), type: "$type" }, n: { $sum: 1 } } },
  ]);
  const by = new Map(rows.map((r) => [`${r._id.day}|${r._id.type}`, r.n]));
  const days = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
  return days.map((date) => ({ date, orders: by.get(`${date}|sales_order`) || 0, returns: by.get(`${date}|sales_return`) || 0 }));
}

// Where a period's sales orders stand: created, approved, paid in part or in full, paid in full.
async function pipeline(from, to) {
  const [row] = await Transaction.aggregate([
    { $match: { type: "sales_order", isOpening: { $ne: true }, date: range(from, to) } },
    {
      $group: {
        _id: null,
        created: { $sum: 1 },
        approved: { $sum: { $cond: [{ $in: ["$status", APPROVED] }, 1, 0] } },
        paidInPart: { $sum: { $cond: [{ $and: [{ $in: ["$status", APPROVED] }, { $gt: ["$paidAmount", 0.005] }] }, 1, 0] } },
        paidInFull: { $sum: { $cond: [{ $and: [{ $in: ["$status", APPROVED] }, { $gt: ["$totalAmount", 0] }, { $lte: ["$outstandingAmount", 0.005] }] }, 1, 0] } },
      },
    },
  ]);
  return { created: row?.created || 0, approved: row?.approved || 0, paidInPart: row?.paidInPart || 0, paidInFull: row?.paidInFull || 0 };
}

// A period's sales invoices as paid, part-paid, unpaid and overdue, unpaid and not yet due (their
// count and their invoice totals). `open` is the ageing service's list of invoices still owing,
// which says how late each one is.
async function settlement(from, to, open) {
  const docs = await Transaction.find({ type: "sales_order", status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(from, to) })
    .select("totalAmount paidAmount outstandingAmount")
    .lean();
  const lateness = new Map(open.map((o) => [String(o.transactionId), o]));
  const parts = { paid: { count: 0, amount: 0 }, partPaid: { count: 0, amount: 0 }, overdue: { count: 0, amount: 0 }, notDue: { count: 0, amount: 0 } };
  for (const d of docs) {
    const owing = lateness.get(String(d._id));
    const key = !owing ? "paid" : d.paidAmount > 0.005 ? "partPaid" : owing.bucket !== "current" ? "overdue" : "notDue";
    parts[key].count += 1;
    parts[key].amount = round2(parts[key].amount + d.totalAmount);
  }
  return parts;
}

// Which customers bought each item in a period (to count the customers a category reached).
async function customersByItem(from, to) {
  const rows = await Transaction.aggregate([
    { $match: { type: "sales_order", status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(from, to) } },
    { $unwind: "$items" },
    { $group: { _id: { item: "$items.itemId", party: "$partyId" } } },
  ]);
  return rows.map((r) => ({ itemId: String(r._id.item), partyId: String(r._id.party) }));
}

// ---------------------------------------------------------------- vouchers

// What approved vouchers of a type came to in a period (receipts from customers, payments to vendors).
async function voucherTotal(type, from, to) {
  const [row] = await Voucher.aggregate([
    { $match: { voucherType: type, status: "approved", date: range(from, to) } },
    { $group: { _id: null, total: { $sum: "$totalAmount" } } },
  ]);
  return round2(row?.total || 0);
}

// Receipts and invoices by day, then filed under the Monday of their week. `weeks` is a list of week starts.
async function weeklyCollections(weeks, to) {
  const from = weeks[0];
  const [receipts, invoices] = await Promise.all([
    Voucher.aggregate([
      { $match: { voucherType: "receipt", status: "approved", date: range(from, to) } },
      { $group: { _id: dayKey("$date"), total: { $sum: "$totalAmount" } } },
    ]),
    Transaction.aggregate([
      { $match: { type: "sales_order", status: { $in: APPROVED }, isOpening: { $ne: true }, date: range(from, to) } },
      { $group: { _id: dayKey("$date"), total: { $sum: "$totalAmount" } } },
    ]),
  ]);
  const fileUnder = (rows) => {
    const sums = new Map(weeks.map((w) => [w, 0]));
    for (const r of rows) {
      const w = weekStart(r._id);
      if (sums.has(w)) sums.set(w, sums.get(w) + r.total);
    }
    return sums;
  };
  const received = fileUnder(receipts);
  const invoiced = fileUnder(invoices);
  return weeks.map((weekStartDay) => ({ weekStart: weekStartDay, receipts: round2(received.get(weekStartDay)), invoiced: round2(invoiced.get(weekStartDay)) }));
}

// ---------------------------------------------------------------- when people work

// Documents (trade documents and vouchers) created in each two-hour window of the day, by weekday,
// in Dubai time, for the four weeks ending `to`.
async function hourlyPulse(to) {
  const match = { createdAt: range(addDays(to, -27), to) };
  const group = {
    _id: { dow: { $isoDayOfWeek: { date: "$createdAt", timezone: tzName() } }, hour: { $hour: { date: "$createdAt", timezone: tzName() } } },
    n: { $sum: 1 },
  };
  const [a, b] = await Promise.all([Transaction.aggregate([{ $match: match }, { $group: group }]), Voucher.aggregate([{ $match: match }, { $group: group }])]);
  const KEYS = ["mon", "tue", "wed", "thu", "fri", "weekend", "weekend"]; // ISO weekdays 1..7
  const windows = new Map();
  for (const r of [...a, ...b]) {
    const hour = Math.floor(r._id.hour / 2) * 2;
    if (!windows.has(hour)) windows.set(hour, { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, weekend: 0 });
    windows.get(hour)[KEYS[r._id.dow - 1]] += r.n;
  }
  if (!windows.size) return [];
  const first = Math.min(...windows.keys());
  const last = Math.max(...windows.keys());
  const rows = [];
  for (let hour = first; hour <= last; hour += 2) rows.push({ hour, ...(windows.get(hour) || { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, weekend: 0 }) });
  return rows;
}

module.exports = {
  APPROVED, tzName,
  addDays, daysBetween, lastDayOf, shiftMonth, monthRange, weekStart, quarterStart,
  monthlyProfit, accountMonthly, inventoryBalances, cashFlowMonthly,
  monthlyTrade, itemSalesByMonth, invoiceStats, orderStatuses, drafts, dailyOrders, pipeline, settlement, customersByItem,
  voucherTotal, weeklyCollections, hourlyPulse, documentTotals, firstSaleDay,
};
