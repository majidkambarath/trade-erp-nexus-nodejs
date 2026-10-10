const Transaction = require("../../models/modules/transactionModel");
const Stock = require("../../models/modules/stockModel");
const Category = require("../../models/modules/categoryModel");
const Customer = require("../../models/modules/customerModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const LedgerReports = require("./ledgerReportsService");
const VatReturn = require("./vatReturnService");
const StockReports = require("./stockReportsService");
const AgeingService = require("../financial/ageingService");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { orgDay } = require("../../utils/fx");
const { getTenant } = require("../../utils/tenant");
const orgLocale = require("../../utils/orgLocale");
const Q = require("./dashboardQueries");
const { STOCKED_ONLY } = require("../../utils/itemKinds");

// The home dashboard. Nothing is invented or sampled: every figure is read from the report that
// owns it (profit and loss, cash book / flow, party balances, ageing, stock valuation / expiry /
// reorder / sales analysis, the VAT return, the day book) or from a single grouped query in
// dashboardQueries.js that uses the same definitions, so a card can never disagree with the page
// it links to. All amounts are in the organisation's base currency, the ledger currency; days are its calendar days.
//
// One part per tab, so the page can show the first screen quickly and fetch the rest when asked:
//   summary()    header, ops status, collection rate, 8-month trend, top product, VAT, attention, recent
//   analytics()  the charts below them on the Dashboard tab
//   sales()      the Sales tab         inventory()  the Inventory tab       reports()  the Reports tab
//
// Every part takes the same period: ?period=week|month|quarter (default month), or ?month=YYYY-MM,
// or ?from=&to= (YYYY-MM-DD). A period always ends today (or on the month's last day for a past
// month) and is compared with the one before it: the same stretch of the previous week, month or
// quarter. Series that are months, weeks or days long (the 8-month charts, the 7-day pulse) end on
// the period's last day whatever its length. Stock on hand now (reorder, expiring batches) cannot
// be wound back, so it is always today's position.

const EXPIRY_DAYS = 30;
const MONTHS = 8;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const pad = (n) => String(n).padStart(2, "0");
const plural = (n, one, many) => (n === 1 ? one : many);
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const change = (now, before) => (before > 0 ? round2(((now - before) / before) * 100) : null);

// ---------------------------------------------------------------- the period

// What a chosen range is compared with. The screens send a year or a quarter as plain from/to days, so a range that is one says so:
//   a whole quarter (from its first day to its last or later) -> the quarter before, a quarter so far -> the same stretch of it;
//   from 1 January for more than a quarter (a year, or the year so far) -> the same days of the year before.
// Anything else keeps the contract: the same number of days just before. (Without this a year-to-date was compared with the 283 days
// before 1 January, and the headline "+46%" read as year on year when it was not.)
function previousOf(from, to, requestedTo = to) {
  const days = Q.daysBetween(from, to) + 1;
  const md = from.slice(5);
  const quarterStartDay = ["01-01", "04-01", "07-01", "10-01"].includes(md);
  if (quarterStartDay && requestedTo >= Q.lastDayOf(Q.shiftMonth(from.slice(0, 7), 2)) && days <= 92) {
    const previousEnd = Q.addDays(from, -1);
    const previousFrom = Q.quarterStart(previousEnd);
    const same = Q.addDays(previousFrom, days - 1);
    // a whole quarter is compared with the whole quarter before (they are not the same number of days); a part of one with the same stretch
    const wholeQuarter = to === Q.lastDayOf(Q.shiftMonth(from.slice(0, 7), 2));
    return { previousFrom, previousTo: wholeQuarter || same > previousEnd ? previousEnd : same };
  }
  if (md === "01-01" && days > 92) {
    const y = Number(from.slice(0, 4)) - 1;
    const tail = to.slice(5);
    return { previousFrom: `${y}-01-01`, previousTo: `${y}-${tail === "02-29" ? "02-28" : tail}` };
  }
  const previousTo = Q.addDays(from, -1);
  return { previousFrom: Q.addDays(previousTo, -Q.daysBetween(from, to)), previousTo };
}

function resolvePeriod({ period, month, from, to } = {}, today = orgDay()) {
  const current = today.slice(0, 7);
  const monthPeriod = (m, id) => {
    if (m > current) throw new AppError("That month has not started yet", 400, "FUTURE_MONTH");
    const last = m === current ? today : Q.lastDayOf(m);
    const previousMonth = Q.shiftMonth(m, -1);
    const previousDays = Number(Q.lastDayOf(previousMonth).slice(8));
    return {
      id, from: `${m}-01`, to: last,
      previousFrom: `${previousMonth}-01`,
      previousTo: m === current ? `${previousMonth}-${pad(Math.min(Number(last.slice(8)), previousDays))}` : Q.lastDayOf(previousMonth),
    };
  };

  let p;
  if (from || to) {
    if (!DAY.test(String(from)) || !DAY.test(String(to))) throw new AppError("from and to must both be written YYYY-MM-DD", 400, "INVALID_PERIOD");
    const real = (s) => { const [y, m, d] = s.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
    if (!real(from) || !real(to)) throw new AppError("from and to must be real calendar days", 400, "INVALID_PERIOD");
    if (from > to) throw new AppError("The period ends before it starts", 400, "INVALID_PERIOD");
    if (from > today) throw new AppError("That period has not started yet", 400, "FUTURE_PERIOD");
    const end = to > today ? today : to;
    p = { id: "custom", from, to: end, ...previousOf(from, end, to) };
  } else if (month) {
    if (!MONTH.test(String(month))) throw new AppError("month must be written YYYY-MM", 400, "INVALID_MONTH");
    p = monthPeriod(String(month), "month");
  } else {
    const id = period || "month";
    if (id === "month") p = monthPeriod(current, "month");
    else if (id === "week") {
      const start = Q.weekStart(today);
      p = { id, from: start, to: today, previousFrom: Q.addDays(start, -7), previousTo: Q.addDays(today, -7) };
    } else if (id === "quarter") {
      const start = Q.quarterStart(today);
      const previousFrom = Q.quarterStart(Q.addDays(start, -1));
      const same = Q.addDays(previousFrom, Q.daysBetween(start, today));
      const previousEnd = Q.addDays(start, -1);
      p = { id, from: start, to: today, previousFrom, previousTo: same > previousEnd ? previousEnd : same };
    } else throw new AppError("period must be week, month or quarter", 400, "INVALID_PERIOD");
  }
  return { ...p, month: p.to.slice(0, 7), months: Q.monthRange(p.to.slice(0, 7), MONTHS) };
}

// ---------------------------------------------------------------- pieces shared by several parts

const company = async () => {
  const s = await CompanySettings.findOne({ companyId: getTenant().companyId }).select("profile").lean();
  return { name: s?.profile?.legalName || null, emirate: s?.profile?.emirate || null };
};

const analysis = (p, groupBy, { direction = "sales", previous = false } = {}) =>
  StockReports.salesAnalysis({ from: previous ? p.previousFrom : p.from, to: previous ? p.previousTo : p.to, groupBy, direction });

// Sales-analysis rows (largest first) with the same row of the previous period beside them.
const withPrevious = (rows, previousRows, field) => {
  const before = new Map(previousRows.map((r) => [r.key, r[field]]));
  return rows.map((r) => ({ key: r.key, name: r.name, value: r[field], previous: before.get(r.key) || 0, changePct: change(r[field], before.get(r.key) || 0) }));
};

// Category of every item, for filing item totals under categories.
async function categoryOfItems() {
  const [stocks, categories] = await Promise.all([Stock.find({}).select("category").lean(), Category.find({}).select("name").lean()]);
  const names = new Map(categories.map((c) => [String(c._id), c.name]));
  return new Map(stocks.map((s) => [String(s._id), { id: s.category ? String(s.category) : null, name: names.get(String(s.category)) || "Uncategorised" }]));
}

const ageingBuckets = (receivable, payable) =>
  receivable.buckets.map((b) => ({ key: b.key, label: b.label, receivables: receivable.totals[b.key] || 0, payables: payable.totals[b.key] || 0 }));

// Where the operating expenses went: the five biggest expense groups of the profit and loss, everything smaller as
// "Other". Always shares of the SAME total the P&L reports, so the rows add up to it.
const EXPENSE_ROWS = 5;
function expenseBreakdown(profit) {
  const total = profit.operatingExpenses.total;
  const groups = profit.operatingExpenses.groups
    .filter((g) => g.total > 0)
    .map((g) => ({ key: String(g.groupId || "none"), name: g.name || "Other", amount: g.total }))
    .sort((a, b) => b.amount - a.amount);
  const rows = groups.slice(0, EXPENSE_ROWS);
  const rest = round2(groups.slice(EXPENSE_ROWS).reduce((t, g) => t + g.amount, 0));
  if (rest > 0) rows.push({ key: "others", name: "Other", amount: rest });
  return { total, rows: rows.map((r) => ({ ...r, sharePct: pct(r.amount, total) })) };
}

// The profit and loss as a flow: revenue, less the cost of what was sold, to gross profit; less operating expenses, plus
// other income, to net profit. Every step is a figure the P&L itself reports.
const profitFlow = (profit) => ({
  revenue: profit.revenue.total,
  directCosts: profit.directCosts.total,
  grossProfit: profit.grossProfit,
  operatingExpenses: profit.operatingExpenses.total,
  otherIncome: profit.otherIncome.total,
  netProfit: profit.netProfit,
});

// Stock value as a flow over the period: opening, what came in, what went out, closing (the stock movement report's own
// totals, in value). Out-buckets are positive magnitudes there; `adjustments` is signed.
const stockFlow = (movement) => {
  const v = (bucket) => movement.totals[bucket].value;
  return {
    from: movement.from, to: movement.to,
    opening: v("opening"), purchases: v("purchases"), salesReturns: v("salesReturns"), adjustments: v("adjustments"),
    purchaseReturns: v("purchaseReturns"), sales: v("sales"), writeOffs: v("writeOffs"), closing: v("closing"),
  };
};

// The business as one flow: bought -> in stock -> sold -> collected, with what is still owed each way, and the cash
// conversion cycle (how many days money is tied up between paying a vendor and collecting from a customer).
//   DSO = receivables / invoiced x days     DPO = payables / purchased x days     DIO = stock value / cost of goods x days
//   cycle = DIO + DSO - DPO
// Balances are as at the period's last day; the flows are the trailing 90 days, no further back than the first sale,
// and a window under two weeks gives no figure rather than a noisy one. A component with nothing to divide by is null,
// and so is the cycle then (a business with no stock has no DIO: the screen says so, it is not shown as zero).
const CYCLE_DAYS = 90;
const CYCLE_MIN_DAYS = 14;
const round1 = (n) => Math.round(n * 10) / 10;
function businessFlow({ profit, previous, purchases, stockValue, receipts, receivables, payables, window, invoiced, purchased, cogs }) {
  const per = (balance, flow) => (flow > 0 && window.days >= CYCLE_MIN_DAYS ? round1((balance / flow) * window.days) : null);
  const dso = per(receivables, invoiced);
  const dpo = per(payables, purchased);
  const dio = per(stockValue, cogs);
  return {
    statement: profitFlow(profit),
    previous: { revenue: previous.revenue.total, netProfit: previous.netProfit, revenueChangePct: change(profit.revenue.total, previous.revenue.total) },
    stages: { bought: purchases, stock: stockValue, sold: profit.revenue.total, collected: receipts, owedByCustomers: receivables, owedToVendors: payables },
    cycle: {
      from: window.from, to: window.to, days: window.days, minDays: CYCLE_MIN_DAYS, enough: window.days >= CYCLE_MIN_DAYS,
      dso, dpo, dio, cycleDays: dso !== null && dpo !== null && dio !== null ? round1(dio + dso - dpo) : null,
      receivables, payables, stockValue, invoiced, purchased, cogs,
    },
  };
}

// Gross margin by category, with the margin of all categories together as the line to compare each against.
function categoryMargin(rows) {
  const sold = rows.filter((r) => r.netRevenue > 0);
  const revenue = sold.reduce((t, r) => t + r.netRevenue, 0);
  const profit = sold.reduce((t, r) => t + (Number(r.grossProfit) || 0), 0);
  return {
    averagePct: pct(profit, revenue),
    rows: sold
      .filter((r) => r.marginPct !== null && r.marginPct !== undefined)
      .slice(0, 8)
      .map((r) => ({ key: r.key, name: r.name, revenue: r.netRevenue, marginPct: r.marginPct })),
  };
}

// What needs a person's attention, each with the page that fixes it. Only what is non-zero.
function attentionItems({ draftSales, draftPurchases, unclassifiedLines, stockAgrees, overLimit, expired, expiring }) {
  const out = [];
  const add = (key, count, text, to) => count > 0 && out.push({ key, count, text, to });
  add("draft-sales", draftSales, `${draftSales} ${plural(draftSales, "sales order is", "sales orders are")} waiting for approval.`, "/sales-order");
  add("draft-purchases", draftPurchases, `${draftPurchases} ${plural(draftPurchases, "purchase order is", "purchase orders are")} waiting for approval.`, "/purchase-order");
  add("unclassified-vat", unclassifiedLines, `${unclassifiedLines} ${plural(unclassifiedLines, "line", "lines")} in this quarter's VAT ${plural(unclassifiedLines, "has", "have")} no tax treatment.`, "/vat-reports");
  if (stockAgrees === false) out.push({ key: "stock-ledger", count: null, text: "Stock value does not agree with the Inventory account.", to: "/stock-reports?tab=valuation" });
  add("over-limit", overLimit, `${overLimit} ${plural(overLimit, "customer is", "customers are")} over their credit limit.`, "/party-balances?tab=customers");
  add("expired", expired, `${expired} ${plural(expired, "batch has", "batches have")} expired.`, "/stock-reports?tab=expiry");
  add("expiring", expiring, `${expiring} ${plural(expiring, "batch expires", "batches expire")} within ${EXPIRY_DAYS} days.`, "/stock-reports?tab=expiry");
  return out;
}

// How a posted document stands, for the recent-activity chip.
const statusOf = (doc) => {
  if (!doc || !["sales_order", "purchase_order"].includes(doc.type)) return "Posted";
  if (doc.outstandingAmount <= 0.005) return "Paid";
  return doc.paidAmount > 0.005 ? "Part-paid" : "Unpaid";
};

class DashboardService {
  static EXPIRY_DAYS = EXPIRY_DAYS;
  static resolvePeriod = resolvePeriod;
  // the shaping of the flow charts, exposed so the arithmetic is tested without a database
  static expenseBreakdown = expenseBreakdown;
  static profitFlow = profitFlow;
  static stockFlow = stockFlow;
  static categoryMargin = categoryMargin;
  static businessFlow = businessFlow;
  static CYCLE_DAYS = CYCLE_DAYS;
  static CYCLE_MIN_DAYS = CYCLE_MIN_DAYS;

  // ================================================================ the first screen
  static async summary(query = {}) {
    const p = resolvePeriod(query);
    const asOf = LedgerReports.dayEnd(p.to);
    const quarterFrom = Q.quarterStart(p.to);
    const vatMonths = Q.monthRange(p.month, 6);

    const [
      profit, previousProfit, invoices, receipts, orders, reorder, activeItems, newCustomers, customers,
      profits, trade, items, previousItems, vat, vatSpark, rcmSpark, valuation, expiry, balances, draftSales, draftPurchases, dayBook, profile,
    ] = await Promise.all([
      LedgerReports.profitAndLoss({ from: p.from, to: p.to }),
      LedgerReports.profitAndLoss({ from: p.previousFrom, to: p.previousTo }),
      Q.invoiceStats(p.from, p.to),
      Q.voucherTotal("receipt", p.from, p.to),
      Q.orderStatuses(p.from, p.to),
      StockReports.reorder(),
      Stock.countDocuments({ status: "Active", ...STOCKED_ONLY }), // a service is not an inventory line
      Customer.countDocuments({ createdAt: { $gte: LedgerReports.dayStart(p.from), $lte: asOf } }),
      Customer.countDocuments({}),
      Q.monthlyProfit(p.months, p.to),
      Q.monthlyTrade(p.months, p.to),
      analysis(p, "item"),
      analysis(p, "item", { previous: true }),
      VatReturn.compute({ from: quarterFrom, to: p.to }),
      Q.accountMonthly("vat-sales", vatMonths, p.to, "credit", { excludeJournals: true }),
      Q.accountMonthly("rcm-purchase", vatMonths, p.to, "credit", { excludeJournals: true }), // VAT assessed on reverse-charge purchases is output tax too (box 3)
      StockReports.valuation({ asOn: p.to }),
      StockReports.expiry({ withinDays: EXPIRY_DAYS }),
      LedgerReports.partyBalances({ type: "customer", asOn: p.to }),
      Q.drafts("sales_order"),
      Q.drafts("purchase_order"),
      LedgerReports.dayBook({ page: 1, limit: 8 }),
      company(),
    ]);

    // ---- the three header figures
    const headline = {
      revenue: profit.revenue.total,
      previousRevenue: previousProfit.revenue.total,
      changePct: change(profit.revenue.total, previousProfit.revenue.total),
      grossProfit: profit.grossProfit,
      grossMarginPct: profit.grossMargin,
      netProfit: profit.netProfit,
      invoices: invoices.invoices,
      averageInvoice: invoices.invoices ? round2(invoices.net / invoices.invoices) : null,
    };

    // ---- the 8 months
    const monthly = p.months.map((month, i) => ({
      month, revenue: profits[i].revenue, grossProfit: profits[i].grossProfit, netProfit: profits[i].netProfit, purchases: trade[i].purchases,
    }));
    const best = monthly.reduce((top, m) => (m.revenue > (top?.revenue ?? 0) ? m : top), null);

    // ---- top product of the period, with its last 7 months
    let topProduct = null;
    const leader = items.rows.find((r) => r.netRevenue > 0);
    const stock = leader && (await Stock.findOne({ itemId: leader.key }).select("itemName").lean());
    if (stock) {
      const sparkMonths = Q.monthRange(p.month, 7);
      const sold = await Q.itemSalesByMonth(sparkMonths, p.to, stock._id);
      const before = previousItems.rows.find((r) => r.key === leader.key)?.netRevenue || 0;
      topProduct = {
        itemId: leader.key, stockId: String(stock._id), name: stock.itemName,
        revenue: leader.netRevenue, previousRevenue: before, changePct: change(leader.netRevenue, before),
        spark: sparkMonths.map((month) => ({ month, revenue: round2(sold.filter((s) => s.month === month).reduce((t, s) => t + s.net, 0)) })),
      };
    }

    // ---- VAT, the calendar quarter so far
    const net = vat.totals.netPayable;
    const rec = valuation.reconciliation;
    const vatSummary = {
      from: quarterFrom, to: p.to, quarter: Math.floor((Number(p.to.slice(5, 7)) - 1) / 3) + 1, year: Number(p.to.slice(0, 4)),
      hasActivity: vat.boxes.some((b) => b.amount || b.vat) || vat.unclassified.count > 0 || vat.notReported.count > 0,
      outputVat: vat.totals.outputVat, recoverableVat: vat.totals.recoverableVat, net,
      position: net > 0 ? "payable" : net < 0 ? "refundable" : "nil",
      unclassifiedLines: vat.unclassified.count,
      spark: vatMonths.map((month, i) => ({ month, outputVat: round2(vatSpark.values[i] + rcmSpark.values[i]) })),
    };

    // ---- the latest vouchers, with where each invoice stands
    const docs = await Transaction.find({ _id: { $in: dayBook.rows.filter((r) => r.voucherType.endsWith("_order")).map((r) => r.voucherId) } })
      .select("type totalAmount paidAmount outstandingAmount")
      .lean();
    const docOf = new Map(docs.map((d) => [String(d._id), d]));
    const recent = dayBook.rows.map((r) => ({
      voucherId: r.voucherId, voucherNo: r.voucherNo, voucherType: r.voucherType, typeLabel: r.typeLabel,
      date: r.date, party: r.party, narration: r.narration, amount: r.amount, status: statusOf(docOf.get(String(r.voucherId))),
    }));

    return {
      currency: orgLocale.baseCurrency(),
      generatedAt: new Date().toISOString(),
      company: profile,
      period: { id: p.id, from: p.from, to: p.to, previousFrom: p.previousFrom, previousTo: p.previousTo },
      headline,
      collection: { receipts, invoiced: invoices.total, ratePct: pct(receipts, invoices.total) },
      ops: {
        activeOrders: { count: orders.sales.approved, total: orders.sales.all },
        pendingPurchaseOrders: { count: orders.purchases.drafts, total: orders.purchases.all },
        lowStock: { count: reorder.totals.items, total: activeItems },
        newCustomers: { count: newCustomers, total: customers },
      },
      monthly,
      peak: best && { month: best.month, revenue: best.revenue },
      topProduct,
      vat: vatSummary,
      attention: attentionItems({
        draftSales: draftSales.count, draftPurchases: draftPurchases.count, unclassifiedLines: vatSummary.unclassifiedLines,
        stockAgrees: rec.available ? rec.reconciles : null, overLimit: balances.totals.overLimit,
        expired: expiry.totals.expired.batches, expiring: expiry.totals.expiring.batches,
      }),
      recent,
    };
  }

  // ================================================================ the charts under the first screen
  static async analytics(query = {}) {
    const p = resolvePeriod(query);
    const asOf = LedgerReports.dayEnd(p.to);
    const months3 = Q.monthRange(p.month, 3);
    const weekFrom = Q.weekStart(p.to);
    const elapsed = Q.daysBetween(weekFrom, p.to);
    const lastWeekFrom = Q.addDays(weekFrom, -7);
    const lastWeekTo = Q.addDays(lastWeekFrom, elapsed);
    const weeks = Array.from({ length: 6 }, (_, i) => Q.addDays(weekFrom, (i - 5) * 7));

    const [
      daily, customers, vendors, previousVendors, items, categories, stockByCategory, profits, trade, itemMonths, cash, profit, receipts, invoices,
      activeItems, inStockItems, draftSales, draftPurchases, receiptsWeek, receiptsLastWeek, paymentsWeek, paymentsLastWeek,
      pipeline, open, ageingIn, ageingOut, collections, hourly, reached, categoryOf, previousProfit, firstSale,
    ] = await Promise.all([
      Q.dailyOrders(Q.addDays(p.to, -6), p.to),
      analysis(p, "customer"),
      analysis(p, "vendor", { direction: "purchases" }),
      analysis(p, "vendor", { direction: "purchases", previous: true }),
      analysis(p, "item"),
      analysis(p, "category"),
      StockReports.valuation({ asOn: p.to, groupBy: "category" }),
      Q.monthlyProfit(p.months, p.to),
      Q.monthlyTrade(p.months, p.to),
      Q.itemSalesByMonth(months3, p.to),
      Q.cashFlowMonthly(p.months, p.to),
      LedgerReports.profitAndLoss({ from: p.from, to: p.to }),
      Q.voucherTotal("receipt", p.from, p.to),
      Q.invoiceStats(p.from, p.to),
      Stock.countDocuments({ status: "Active", ...STOCKED_ONLY }),
      Stock.countDocuments({ status: "Active", currentStock: { $gt: 0 }, ...STOCKED_ONLY }),
      Q.drafts("sales_order"),
      Q.drafts("purchase_order"),
      Q.voucherTotal("receipt", weekFrom, p.to),
      Q.voucherTotal("receipt", lastWeekFrom, lastWeekTo),
      Q.voucherTotal("payment", weekFrom, p.to),
      Q.voucherTotal("payment", lastWeekFrom, lastWeekTo),
      Q.pipeline(p.from, p.to),
      AgeingService.openInvoices({ type: "receivable", asOf: LedgerReports.dayEnd(orgDay()) }), // where those invoices stand today
      AgeingService.report({ type: "receivable", asOf }),
      AgeingService.report({ type: "payable", asOf }),
      Q.weeklyCollections(weeks, p.to),
      Q.hourlyPulse(p.to),
      Q.customersByItem(p.from, p.to),
      categoryOfItems(),
      LedgerReports.profitAndLoss({ from: p.previousFrom, to: p.previousTo }),
      Q.firstSaleDay(),
    ]);

    // ---- the cash cycle's window: the 90 days to the period's last day, but not before the first sale
    const earliest = Q.addDays(p.to, -(CYCLE_DAYS - 1));
    // no sale yet (or the period ends before the first one): a one-day window, which is too short to measure anything
    const cycleFrom = !firstSale || firstSale > p.to ? p.to : firstSale > earliest ? firstSale : earliest;
    const window = { from: cycleFrom, to: p.to, days: Math.max(1, Q.daysBetween(cycleFrom, p.to) + 1) };
    const [invoicedWindow, purchasedWindow, profitWindow] = await Promise.all([
      Q.documentTotals("sales_order", window.from, window.to),
      Q.documentTotals("purchase_order", window.from, window.to),
      LedgerReports.profitAndLoss({ from: window.from, to: window.to }),
    ]);

    // ---- customer mix: the top four customers and everyone else
    const buyers = customers.rows.filter((r) => r.netRevenue > 0);
    const mixTotal = round2(buyers.reduce((t, r) => t + r.netRevenue, 0));
    const mixRows = buyers.slice(0, 4).map((r) => ({ key: r.key, name: r.name, value: r.netRevenue }));
    const others = round2(buyers.slice(4).reduce((t, r) => t + r.netRevenue, 0));
    if (buyers.length > 4) mixRows.push({ key: "others", name: "Others", value: others });

    // ---- categories: this month against last month, and the last three months
    const monthly = new Map(); // category name -> month -> net sales
    for (const s of itemMonths) {
      const name = (categoryOf.get(s.itemId) || { name: "Uncategorised" }).name;
      if (!monthly.has(name)) monthly.set(name, new Map());
      monthly.get(name).set(s.month, (monthly.get(name).get(s.month) || 0) + s.net);
    }
    const byMonth = (name, month) => round2(monthly.get(name)?.get(month) || 0);
    const names = [...monthly.keys()];
    const total3 = (n) => months3.reduce((t, m) => t + byMonth(n, m), 0);
    const categorySales = names
      .map((name) => ({ name, current: byMonth(name, months3[2]), previous: byMonth(name, months3[1]) }))
      .filter((c) => c.current || c.previous)
      .sort((a, b) => b.current + b.previous - (a.current + a.previous))
      .slice(0, 6);
    const categoryMonths = names
      .map((name) => ({ name, values: months3.map((m) => byMonth(name, m)) }))
      .filter((c) => c.values.some(Boolean))
      .sort((a, b) => total3(b.name) - total3(a.name))
      .slice(0, 5);

    // ---- the radar: how the four biggest categories compare, 100 being the best of the four
    const top4 = categories.rows.filter((r) => r.netRevenue > 0).slice(0, 4);
    const stockValueOf = new Map(stockByCategory.rows.map((r) => [r.categoryId || "none", r.value]));
    const reachedBy = new Map(); // category id -> customers
    for (const r of reached) {
      const cat = categoryOf.get(r.itemId)?.id || "none";
      if (!reachedBy.has(cat)) reachedBy.set(cat, new Set());
      reachedBy.get(cat).add(r.partyId);
    }
    const facts = top4.map((c) => ({
      name: c.name, volume: c.quantity, revenue: c.netRevenue, margin: c.marginPct ?? 0,
      stockValue: stockValueOf.get(c.key) || 0, customers: reachedBy.get(c.key)?.size || 0,
    }));
    const index = (field, c) => {
      const best = Math.max(...facts.map((f) => Math.max(f[field], 0)));
      return best > 0 ? Math.round((Math.max(c[field], 0) / best) * 1000) / 10 : 0;
    };
    const radar = {
      categories: facts.map((f, i) => ({ key: `c${i}`, name: f.name })),
      metrics: facts.length
        ? [["volume", "Volume"], ["revenue", "Revenue"], ["margin", "Margin"], ["stockValue", "Stock value"], ["customers", "Customers served"]].map(([field, label]) => ({
            metric: label, ...Object.fromEntries(facts.map((f, i) => [`c${i}`, index(field, f)])),
          }))
        : [],
      facts,
    };

    // ---- receivables and payables ageing; sales invoices by how far they are settled
    const settlement = await Q.settlement(p.from, p.to, open);

    return {
      currency: orgLocale.baseCurrency(),
      period: { id: p.id, from: p.from, to: p.to, previousFrom: p.previousFrom, previousTo: p.previousTo },
      weekly: daily,
      customerMix: { total: mixTotal, rows: mixRows.map((r) => ({ ...r, sharePct: pct(r.value, mixTotal) })) },
      performance: {
        collectionRatePct: pct(receipts, invoices.total),
        grossMarginPct: profit.grossMargin,
        stockAvailabilityPct: pct(inStockItems, activeItems),
        itemsInStock: inStockItems,
        activeItems,
      },
      monthly: p.months.map((month, i) => ({ month, sales: profits[i].revenue, purchases: trade[i].purchases, grossProfit: profits[i].grossProfit })),
      categorySales: { currentMonth: months3[2], previousMonth: months3[1], rows: categorySales },
      categoryMonths: { months: months3, rows: categoryMonths },
      cashFlow: { accounts: cash.accounts, months: cash.months },
      kpis: [
        { key: "open-sales", label: "Open sales orders", value: draftSales.value, count: draftSales.count, to: "/sales-order" },
        { key: "open-purchases", label: "Open purchase orders", value: draftPurchases.value, count: draftPurchases.count, to: "/purchase-order" },
        { key: "receipts-week", label: "Receipts this week", value: receiptsWeek, previous: receiptsLastWeek, changePct: change(receiptsWeek, receiptsLastWeek), to: "/receipt-voucher" },
        { key: "payments-week", label: "Payments this week", value: paymentsWeek, previous: paymentsLastWeek, changePct: change(paymentsWeek, paymentsLastWeek), to: "/payment-voucher" },
      ],
      radar,
      pipeline: [
        { key: "created", label: "Created", value: pipeline.created },
        { key: "approved", label: "Approved", value: pipeline.approved },
        { key: "paid-in-part", label: "Part-paid or paid", value: pipeline.paidInPart },
        { key: "paid", label: "Fully paid", value: pipeline.paidInFull },
      ],
      settlement: [
        { key: "paid", label: "Paid", ...settlement.paid },
        { key: "part-paid", label: "Part-paid", ...settlement.partPaid },
        { key: "overdue", label: "Unpaid, overdue", ...settlement.overdue },
        { key: "not-due", label: "Unpaid, not yet due", ...settlement.notDue },
      ],
      topCustomers: buyers.slice(0, 6).map((r) => ({ partyId: r.key, name: r.name, netRevenue: r.netRevenue })),
      ageing: ageingBuckets(ageingIn, ageingOut),
      topVendors: withPrevious(vendors.rows.filter((r) => r.netValue > 0), previousVendors.rows, "netValue").slice(0, 5).map((r) => ({ partyId: r.key, name: r.name, purchases: r.value, previous: r.previous, changePct: r.changePct })),
      collections,
      treemap: items.rows.filter((r) => r.netRevenue > 0).slice(0, 8).map((r) => ({ itemId: r.key, name: r.name, size: r.netRevenue })),
      categoryMargin: categoryMargin(categories.rows),
      businessFlow: businessFlow({
        profit, previous: previousProfit, window,
        purchases: round2(vendors.rows.reduce((t, r) => t + (r.netValue || 0), 0)),
        stockValue: stockByCategory.totals.value, receipts,
        receivables: ageingIn.totals.total, payables: ageingOut.totals.total,
        invoiced: invoicedWindow.total, purchased: purchasedWindow.total, cogs: profitWindow.directCosts.total,
      }),
      hourly,
    };
  }

  // ================================================================ Sales tab
  static async sales(query = {}) {
    const p = resolvePeriod(query);
    const [invoices, previousInvoices, orders, previousOrders, trade, profits, items, previousItems, customers, daily] = await Promise.all([
      Q.invoiceStats(p.from, p.to),
      Q.invoiceStats(p.previousFrom, p.previousTo),
      Q.orderStatuses(p.from, p.to),
      Q.orderStatuses(p.previousFrom, p.previousTo),
      Q.monthlyTrade(p.months, p.to),
      Q.monthlyProfit(p.months, p.to),
      analysis(p, "item"),
      analysis(p, "item", { previous: true }),
      analysis(p, "customer"),
      Q.dailyOrders(Q.addDays(p.to, -6), p.to),
    ]);
    const average = (s) => (s.invoices ? round2(s.net / s.invoices) : null);
    const ranked = withPrevious(items.rows.filter((r) => r.netRevenue > 0), previousItems.rows, "netRevenue").slice(0, 4);
    const top = ranked[0]?.value || 0;
    return {
      currency: orgLocale.baseCurrency(),
      period: { id: p.id, from: p.from, to: p.to, previousFrom: p.previousFrom, previousTo: p.previousTo },
      orders: { count: invoices.invoices, previous: previousInvoices.invoices, changePct: change(invoices.invoices, previousInvoices.invoices) },
      averageOrder: { value: average(invoices), previous: average(previousInvoices), changePct: average(invoices) && average(previousInvoices) ? change(average(invoices), average(previousInvoices)) : null },
      approvedShare: { pct: pct(orders.sales.approved, orders.sales.all), previousPct: pct(previousOrders.sales.approved, previousOrders.sales.all), approved: orders.sales.approved, created: orders.sales.all },
      monthly: p.months.map((month, i) => ({ month, sales: profits[i].revenue, purchases: trade[i].purchases })),
      bestSellers: ranked.map((r) => ({ itemId: r.key, name: r.name, revenue: r.value, changePct: r.changePct, fillPct: top > 0 ? Math.round((r.value / top) * 100) : 0 })),
      daily,
      topCustomers: customers.rows.filter((r) => r.netRevenue > 0).slice(0, 5).map((r) => ({ partyId: r.key, name: r.name, netRevenue: r.netRevenue })),
    };
  }

  // ================================================================ Inventory tab
  static async inventory(query = {}) {
    const p = resolvePeriod(query);
    const [valuation, reorder, expiry, trend, movement] = await Promise.all([
      StockReports.valuation({ asOn: p.to, groupBy: "category" }),
      StockReports.reorder(),
      StockReports.expiry({ withinDays: EXPIRY_DAYS }),
      Q.inventoryBalances(p.months, p.to),
      StockReports.movement({ from: p.from, to: p.to }),
    ]);
    const rows = valuation.rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
    const mix = rows.slice(0, 5).map((r) => ({ key: r.categoryId || "none", name: r.categoryName, value: r.value, sharePct: r.sharePct }));
    if (rows.length > 5) {
      const rest = round2(rows.slice(5).reduce((t, r) => t + r.value, 0));
      mix.push({ key: "others", name: "Others", value: rest, sharePct: valuation.totals.value > 0 ? round2((rest / valuation.totals.value) * 100) : null });
    }
    const rec = valuation.reconciliation;
    return {
      currency: orgLocale.baseCurrency(),
      period: { id: p.id, from: p.from, to: p.to },
      totals: { value: valuation.totals.value, items: valuation.totals.items, reorderItems: reorder.totals.items, expiring: expiry.totals.expiring.batches, expired: expiry.totals.expired.batches, agreesWithLedger: rec.available ? rec.reconciles : null },
      categories: rows.slice(0, 4).map((r) => ({ key: r.categoryId || "none", name: r.categoryName, items: r.items, value: r.value, sharePct: r.sharePct })),
      mix,
      lowStock: reorder.rows.slice(0, 6).map((r) => ({ stockId: r.stockId, itemName: r.itemName, qty: r.qty, unit: r.unit, reorderLevel: r.reorderLevel, status: r.status })),
      batches: expiry.rows.slice(0, 6).map((r) => ({ batchId: r.batchId, stockId: r.stockId, itemName: r.itemName, batchNumber: r.batchNumber, qtyOnHand: r.qtyOnHand, unit: r.unit, expiryDate: r.expiryDate, daysToExpiry: r.daysToExpiry, expired: r.expired })),
      stockValueTrend: { available: trend.available, months: p.months.map((month, i) => ({ month, value: trend.values[i] })) },
      stockFlow: stockFlow(movement),
    };
  }

  // ================================================================ Reports tab
  static async reports(query = {}) {
    const p = resolvePeriod(query);
    const quarterFrom = Q.quarterStart(p.to);
    const [profit, profits, dayBook, ageingIn, ageingOut, vat] = await Promise.all([
      LedgerReports.profitAndLoss({ from: p.from, to: p.to }),
      Q.monthlyProfit(p.months, p.to),
      LedgerReports.dayBook({ from: p.from, to: p.to, page: 1, limit: 1 }),
      AgeingService.report({ type: "receivable", asOf: LedgerReports.dayEnd(p.to) }),
      AgeingService.report({ type: "payable", asOf: LedgerReports.dayEnd(p.to) }),
      VatReturn.compute({ from: quarterFrom, to: p.to }),
    ]);
    const amountOf = (type) => dayBook.byType.find((t) => t.voucherType === type)?.amount || 0;
    const net = vat.totals.netPayable;
    return {
      currency: orgLocale.baseCurrency(),
      period: { id: p.id, from: p.from, to: p.to },
      grossProfit: profit.grossProfit,
      netProfit: profit.netProfit,
      vat: {
        from: quarterFrom, to: p.to, outputVat: vat.totals.outputVat, recoverableVat: vat.totals.recoverableVat, net,
        position: net > 0 ? "payable" : net < 0 ? "refundable" : "nil",
        hasActivity: vat.boxes.some((b) => b.amount || b.vat) || vat.unclassified.count > 0 || vat.notReported.count > 0,
      },
      valueGrowth: p.months.map((month, i) => ({ month, grossProfit: profits[i].grossProfit, netProfit: profits[i].netProfit, revenue: profits[i].revenue })),
      profitFlow: profitFlow(profit),
      expenses: expenseBreakdown(profit),
      vouchers: ["receipt", "payment", "journal", "contra", "expense"].map((type) => ({ voucherType: type, amount: amountOf(type) })),
      ageing: ageingBuckets(ageingIn, ageingOut),
    };
  }
}

module.exports = DashboardService;
