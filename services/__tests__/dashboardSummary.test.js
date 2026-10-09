// The home dashboard: every series is read from the report that owns it (or from one grouped query
// that uses the same definition) and is asserted against that report here, month by month, as well
// as against a hand-worked scenario. An empty database gives zeros and empty lists, never a crash.
// Throwaway database; see ledgerReports.test.js.
//
//   node --test services/__tests__/dashboardSummary.test.js
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();

let svc;
let Q;

// Dubai calendar days, the way the reports read dates
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
const today = () => orgDay();
const thisMonth = () => today().slice(0, 7);
const pad = (n) => String(n).padStart(2, "0");
const shift = (month, delta) => {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
const lastDay = (month) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};
const monthsEnding = (month, n) => Array.from({ length: n }, (_, i) => shift(month, i - (n - 1)));
const quarterFrom = (day) => `${day.slice(0, 4)}-${pad(Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1)}-01`;
const noon = (month, day) => new Date(`${month}-${day}T12:00:00+04:00`);
const inDays = (n) => new Date(Date.now() + n * 86400e3);
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.011, `${label}: ${actual} is not ${expected}`);
const keys = (rows, key = "month") => rows.map((r) => r[key]);

before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Chart: require("../financial/chartOfAccountsService"),
    Config: require("../financial/accountConfigService"),
    Ageing: require("../financial/ageingService"),
    Dashboard: require("../reports/dashboardService"),
    Ledger: require("../reports/ledgerReportsService"),
    Stock: require("../reports/stockReportsService"),
    Vat: require("../reports/vatReturnService"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
    Item: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Transaction: require("../../models/modules/transactionModel"),
    tenant: require("../../utils/tenant"),
  };
  Q = require("../reports/dashboardQueries");
  await mongoose.connection.syncIndexes();
});

after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ------------------------------------------------------------------------------------------------
// The period every part takes (pure)

describe("the period", () => {
  const { resolvePeriod } = require("../reports/dashboardService");
  const p = (query, day = "2026-10-08") => resolvePeriod(query, day);

  it("defaults to the month so far, compared with the same stretch of the month before", () => {
    const r = p({});
    assert.deepEqual([r.id, r.from, r.to, r.previousFrom, r.previousTo, r.month], ["month", "2026-10-01", "2026-10-08", "2026-09-01", "2026-09-08", "2026-10"]);
    assert.deepEqual(r.months, ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  });

  it("a week runs from Monday, a quarter from its first day, each against the same stretch before", () => {
    const week = p({ period: "week" }); // 8 October 2026 is a Thursday
    assert.deepEqual([week.from, week.to, week.previousFrom, week.previousTo], ["2026-10-05", "2026-10-08", "2026-09-28", "2026-10-01"]);
    const quarter = p({ period: "quarter" });
    assert.deepEqual([quarter.from, quarter.to, quarter.previousFrom, quarter.previousTo], ["2026-10-01", "2026-10-08", "2026-07-01", "2026-07-08"]);
    assert.equal(p({ period: "quarter" }, "2026-12-31").previousTo, "2026-09-30", "never past the end of the quarter before");
    assert.equal(p({ period: "quarter" }, "2027-01-15").previousFrom, "2026-10-01", "across a year end");
  });

  it("a month that is not finished is compared with the same day of the month before, capped at its length", () => {
    assert.equal(p({}, "2026-03-31").previousTo, "2026-02-28");
    assert.equal(p({}, "2026-01-10").previousFrom, "2025-12-01");
  });

  it("a named past month is the whole month against the whole month before", () => {
    const r = p({ month: "2026-09" });
    assert.deepEqual([r.id, r.from, r.to, r.previousFrom, r.previousTo], ["month", "2026-09-01", "2026-09-30", "2026-08-01", "2026-08-31"]);
    assert.equal(p({ month: "2026-10" }).to, "2026-10-08", "the current month ends today");
  });

  it("from and to are taken as given, against the days just before of the same length", () => {
    const r = p({ from: "2026-10-01", to: "2026-10-10" });
    assert.deepEqual([r.id, r.from, r.to, r.previousFrom, r.previousTo], ["custom", "2026-10-01", "2026-10-08", "2026-09-23", "2026-09-30"]);
    assert.equal(p({ from: "2026-09-01", to: "2026-09-10" }).previousFrom, "2026-08-22");
  });

  it("refuses what makes no sense", () => {
    for (const bad of [{ month: "2026-13" }, { month: "last month" }, { period: "year" }, { from: "2026-10-01" }, { from: "2026-10-09", to: "2026-10-01" }]) {
      assert.throws(() => p(bad), { statusCode: 400 }, JSON.stringify(bad));
    }
    assert.throws(() => p({ month: "2026-11" }), { code: "FUTURE_MONTH" });
    assert.throws(() => p({ from: "2026-10-20", to: "2026-10-25" }), { code: "FUTURE_PERIOD" });
  });
});

// ------------------------------------------------------------------------------------------------
// Nothing has happened yet: first a database with no chart at all, then a seeded one with no activity

function assertNothingYet(d, seeded) {
  const days = (n) => assert.equal(n, 7);
  // summary
  const s = d.summary;
  assert.equal(s.currency, "AED");
  assert.deepEqual(s.company, { name: null, emirate: null });
  assert.deepEqual(s.period, { id: "month", from: `${thisMonth()}-01`, to: today(), previousFrom: s.period.previousFrom, previousTo: s.period.previousTo });
  assert.deepEqual(s.headline, { revenue: 0, previousRevenue: 0, changePct: null, grossProfit: 0, grossMarginPct: null, netProfit: 0, invoices: 0, averageInvoice: null });
  assert.deepEqual(s.collection, { receipts: 0, invoiced: 0, ratePct: null });
  assert.deepEqual(s.ops, { activeOrders: { count: 0, total: 0 }, pendingPurchaseOrders: { count: 0, total: 0 }, lowStock: { count: 0, total: 0 }, newCustomers: { count: 0, total: 0 } });
  assert.equal(s.monthly.length, 8);
  assert.deepEqual(keys(s.monthly), monthsEnding(thisMonth(), 8));
  assert.ok(s.monthly.every((m) => m.revenue === 0 && m.purchases === 0 && m.grossProfit === 0 && m.netProfit === 0));
  assert.equal(s.peak, null);
  assert.equal(s.topProduct, null);
  assert.equal(s.vat.hasActivity, false);
  assert.deepEqual([s.vat.outputVat, s.vat.recoverableVat, s.vat.net, s.vat.unclassifiedLines], [0, 0, 0, 0]);
  assert.equal(s.vat.position, "nil");
  assert.equal(s.vat.spark.length, 6);
  assert.equal(s.vat.dueDate, undefined, "no due date is invented");
  assert.deepEqual(s.attention, []);
  assert.deepEqual(s.recent, []);
  // analytics
  const a = d.analytics;
  days(a.weekly.length);
  assert.ok(a.weekly.every((w) => w.orders === 0 && w.returns === 0));
  assert.equal(a.weekly.at(-1).date, today());
  assert.deepEqual(a.customerMix, { total: 0, rows: [] });
  assert.deepEqual(a.performance, { collectionRatePct: null, grossMarginPct: null, stockAvailabilityPct: null, itemsInStock: 0, activeItems: 0 });
  assert.equal(a.monthly.length, 8);
  assert.deepEqual(a.categorySales.rows, []);
  assert.deepEqual(a.categoryMonths.rows, []);
  assert.equal(a.categoryMonths.months.length, 3);
  assert.equal(a.cashFlow.months.length, 8);
  assert.ok(a.cashFlow.months.every((m) => m.inflow === 0 && m.outflow === 0));
  assert.deepEqual(a.kpis.map((k) => [k.key, k.value]), [["open-sales", 0], ["open-purchases", 0], ["receipts-week", 0], ["payments-week", 0]]);
  assert.deepEqual(a.radar.categories, []);
  assert.deepEqual(a.radar.metrics, []);
  assert.deepEqual(a.pipeline.map((x) => x.value), [0, 0, 0, 0]);
  assert.deepEqual(a.settlement.map((x) => [x.count, x.amount]), [[0, 0], [0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(a.topCustomers, []);
  assert.deepEqual(a.ageing.map((x) => x.key), ["current", "d1_30", "d31_60", "d61_90", "d90plus"]);
  assert.ok(a.ageing.every((x) => x.receivables === 0 && x.payables === 0));
  assert.deepEqual(a.topVendors, []);
  assert.equal(a.collections.length, 6);
  assert.ok(a.collections.every((w) => w.receipts === 0 && w.invoiced === 0));
  assert.deepEqual(a.treemap, []);
  assert.deepEqual(a.hourly, []);
  // sales
  const sl = d.sales;
  assert.deepEqual([sl.orders.count, sl.orders.changePct, sl.averageOrder.value, sl.approvedShare.pct], [0, null, null, null]);
  assert.equal(sl.monthly.length, 8);
  assert.deepEqual([sl.bestSellers, sl.topCustomers], [[], []]);
  days(sl.daily.length);
  // inventory
  const inv = d.inventory;
  assert.deepEqual(inv.totals, { value: 0, items: 0, reorderItems: 0, expiring: 0, expired: 0, agreesWithLedger: seeded ? true : null });
  assert.deepEqual([inv.categories, inv.mix, inv.lowStock, inv.batches], [[], [], [], []]);
  assert.equal(inv.stockValueTrend.available, seeded);
  assert.equal(inv.stockValueTrend.months.length, 8);
  assert.ok(inv.stockValueTrend.months.every((m) => m.value === 0));
  // reports
  const r = d.reports;
  assert.deepEqual([r.grossProfit, r.netProfit, r.vat.net, r.vat.hasActivity], [0, 0, 0, false]);
  assert.deepEqual(r.vouchers.map((v) => [v.voucherType, v.amount]), [["receipt", 0], ["payment", 0], ["journal", 0], ["contra", 0], ["expense", 0]]);
  assert.equal(r.valueGrowth.length, 8);
  assert.equal(r.ageing.length, 5);
}

async function everything(query = {}) {
  const D = svc.Dashboard;
  const [summary, analytics, sales, inventory, reports] = await Promise.all([D.summary(query), D.analytics(query), D.sales(query), D.inventory(query), D.reports(query)]);
  return { summary, analytics, sales, inventory, reports };
}

describe("an empty database", { skip }, () => {
  it("gives zeros and empty lists in every part with no chart of accounts at all", async () => {
    assertNothingYet(await everything(), false);
  });

  it("gives zeros and empty lists in every part on a freshly seeded chart", async () => {
    const year = Number(today().slice(0, 4));
    await svc.FiscalYear.create({
      companyId: svc.tenant.getTenant().companyId, code: "TEST", status: "open",
      startDate: new Date(Date.UTC(year - 1, 0, 1) - 4 * 3600e3), endDate: new Date(Date.UTC(year + 1, 0, 1) - 4 * 3600e3 - 1),
    });
    await svc.seed({ log: () => {} });
    await svc.Config.setPostingEnabled(true);
    assertNothingYet(await everything(), true);
  });
});

// ------------------------------------------------------------------------------------------------
// A small business. Rice is bought at 10 throughout, so every sale of it costs 10 a bag (a sale never
// moves the average); oil is bought for the batches that expire. Amounts exclude 5% VAT unless said.
//
//   m-3  buy 50 rice @10                                                             Gulf Mills
//        sell rice @12: 5 Al Noor, 4 Bin Zayed, 3 Cust Three, 2 Cust Four, 1 Cust Five     (revenue 180, cost 150)
//   m-2  buy 100 rice @10 (batch R1) and 50 oil @20 (batch O1, expires in 10 days)   Gulf Mills
//        sell 10 rice @15 and 10 oil @30                                             Bin Zayed   (revenue 450, cost 300)
//   m-1  sell 20 rice @15                                                            Al Noor     (revenue 300, cost 200)
//        buy 20 oil @22 (batch O-OLD, expired 3 days ago)                            Gulf Mills
//   now  sell 30 rice @18 to Al Noor, 5 @20 and 1 @30 with 0% VAT and no tax code to Bin Zayed
//        Al Noor returns 2 rice @15; buy 10 rice @10 from Delta Foods                (revenue 640, cost 340)
//        capital 5,000 to cash, 1,000 cash to ENBD, 100 received from Al Noor, 300 paid to Gulf Mills
//        two draft sales orders and one draft purchase order
//   Al Noor's credit limit is 100, so he is over it.
describe("a small business", { skip }, () => {
  let alNoor, binZayed, gulfMills, rice, oil, inventoryAccountId, equity;
  let R; // the five parts for the default period
  const M = () => thisMonth();

  before(async () => {
    const m = M();
    const [m1, m2, m3] = [shift(m, -1), shift(m, -2), shift(m, -3)];
    await svc.CompanySettings.updateOne({ companyId: svc.tenant.getTenant().companyId }, { $set: { "profile.legalName": "Test Foods LLC", "profile.emirate": "Sharjah" } });
    alNoor = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 100, paymentTerms: "Net 7" });
    binZayed = await svc.Customer.create({ customerId: "C2", customerName: "Bin Zayed", contactPerson: "x", creditLimit: 1000000 });
    const [three, four, five] = await svc.Customer.create(
      ["Cust Three", "Cust Four", "Cust Five"].map((customerName, i) => ({ customerId: `C${i + 3}`, customerName, contactPerson: "x", creditLimit: 1000000 }))
    );
    gulfMills = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
    const delta = await svc.Vendor.create({ vendorId: "V2", vendorName: "Delta Foods", contactPerson: "x", address: "y" });
    const [grains, oils] = await svc.Category.create([{ name: "Grains" }, { name: "Oils" }]);
    rice = await svc.Item.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: grains._id, reorderLevel: 500 });
    oil = await svc.Item.create({ itemId: "OIL", sku: "OIL", itemName: "Oil", category: oils._id, reorderLevel: 10 });

    const line = (item, qty, price, extra = {}) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5, ...extra });
    const make = (type, party, partyType, items, date, extra = {}) =>
      svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, date, ...extra }, "tester");
    const post = async (...args) => {
      const t = await make(...args);
      await svc.Tx.processTransaction(t._id, "approve", "tester");
      return t;
    };

    await post("purchase_order", gulfMills, "Vendor", [line(rice, 50, 10)], noon(m3, "15"));
    const oldest = [];
    for (const [party, qty] of [[alNoor, 5], [binZayed, 4], [three, 3], [four, 2], [five, 1]]) oldest.push(await post("sales_order", party, "Customer", [line(rice, qty, 12)], noon(m3, "15")));
    await post("purchase_order", gulfMills, "Vendor", [line(rice, 100, 10, { batchNumber: "R1", expiryDate: inDays(200) }), line(oil, 50, 20, { batchNumber: "O1", expiryDate: inDays(10) })], noon(m2, "15"));
    await post("sales_order", binZayed, "Customer", [line(rice, 10, 15), line(oil, 10, 30)], noon(m2, "15"));
    const s1 = await post("sales_order", alNoor, "Customer", [line(rice, 20, 15)], noon(m1, "15"));
    await post("purchase_order", gulfMills, "Vendor", [line(oil, 20, 22, { batchNumber: "O-OLD", expiryDate: inDays(-3) })], noon(m1, "20"));
    await post("sales_order", alNoor, "Customer", [line(rice, 30, 18)], new Date());
    await post("sales_order", binZayed, "Customer", [line(rice, 5, 20)], new Date());
    await post("sales_order", binZayed, "Customer", [line(rice, 1, 30, { vatPercent: 0 })], new Date());
    await post("sales_return", alNoor, "Customer", [line(rice, 2, 15, { returnOfLineId: s1.items[0]._id })], new Date(), { returnOf: { transactionId: s1._id } });
    await post("purchase_order", delta, "Vendor", [line(rice, 10, 10)], new Date());

    const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
    const cash = await acct("Cash in Hand");
    equity = await acct("Opening Balance Equity");
    const bankGroup = await svc.AccountGroup.findOne({ name: "Bank" });
    const enbd = await svc.Chart.createAccount({ accountName: "ENBD Current", groupId: bankGroup._id }, {}, admin);
    inventoryAccountId = await svc.Config.resolveAccount("inventory-asset");
    await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), narration: "Opening capital", lines: [{ accountId: cash._id, debit: 5000 }, { accountId: equity._id, credit: 5000 }] }, admin);
    await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: cash._id, toAccountId: enbd._id, totalAmount: 1000, date: new Date() }, admin);
    // the 100 from Al Noor settles his oldest invoice (63) and part of the next (37), as the receipt screen allocates it
    const open = await svc.Transaction.findById(s1._id).lean();
    await svc.Financial.createVoucher({
      voucherType: "receipt", customerId: alNoor._id, totalAmount: 100, date: new Date(), paymentMode: "cash",
      linkedInvoices: [{ invoiceId: oldest[0]._id, amount: 63, balance: 0 }, { invoiceId: s1._id, amount: 37, balance: Math.round((open.outstandingAmount - 37) * 100) / 100 }],
    }, admin);
    await svc.Financial.createVoucher({ voucherType: "payment", vendorId: gulfMills._id, totalAmount: 300, date: new Date(), paymentMode: "cash" }, admin);

    await make("sales_order", binZayed, "Customer", [line(rice, 1, 20)], new Date());
    await make("sales_order", alNoor, "Customer", [line(rice, 1, 20)], new Date());
    await make("purchase_order", gulfMills, "Vendor", [line(rice, 10, 10)], new Date());

    R = await everything();
  });

  // ---------------------------------------------------------------- the first screen

  it("header: the company, the three figures and the period they cover", async () => {
    const s = R.summary;
    assert.deepEqual(s.company, { name: "Test Foods LLC", emirate: "Sharjah" });
    assert.deepEqual([s.period.id, s.period.from, s.period.to], ["month", `${M()}-01`, today()]);
    const pl = await svc.Ledger.profitAndLoss({ from: s.period.from, to: s.period.to });
    const before = await svc.Ledger.profitAndLoss({ from: s.period.previousFrom, to: s.period.previousTo });

    assert.equal(s.headline.revenue, 640); // 540 + 100 + 30 less the 30 returned
    assert.equal(s.headline.grossProfit, 300);
    assert.equal(s.headline.revenue, pl.revenue.total);
    assert.equal(s.headline.grossProfit, pl.grossProfit);
    assert.equal(s.headline.grossMarginPct, pl.grossMargin);
    assert.equal(s.headline.netProfit, pl.netProfit);
    assert.equal(s.headline.previousRevenue, before.revenue.total);
    assert.equal(s.headline.changePct, before.revenue.total > 0 ? Math.round(((640 - before.revenue.total) / before.revenue.total) * 10000) / 100 : null);
    assert.equal(s.headline.invoices, 3, "returns are not invoices");
    assert.equal(s.headline.averageInvoice, 223.33); // 670 over 3 invoices
  });

  it("collection rate: receipts from customers against what was invoiced, and the ops counts", async () => {
    const s = R.summary;
    assert.deepEqual(s.collection, { receipts: 100, invoiced: 702, ratePct: 14.2 }); // 567 + 105 + 30
    assert.deepEqual(s.ops.activeOrders, { count: 3, total: 5 });
    assert.deepEqual(s.ops.pendingPurchaseOrders, { count: 1, total: 2 }, "the draft and Delta Foods' approved order");
    const reorder = await svc.Stock.reorder();
    assert.deepEqual(s.ops.lowStock, { count: reorder.totals.items, total: 2 });
    assert.equal(s.ops.lowStock.count, 1, "rice is under its level of 500");
    assert.deepEqual(s.ops.newCustomers, { count: 5, total: 5 });
  });

  it("eight months of sales, purchases, gross and net profit, month by month as the reports say", async () => {
    const m = M();
    const months = monthsEnding(m, 8);
    assert.deepEqual(keys(R.summary.monthly), months);
    for (const row of R.summary.monthly) {
      const to = row.month === m ? today() : lastDay(row.month);
      const pl = await svc.Ledger.profitAndLoss({ from: `${row.month}-01`, to });
      const bought = await svc.Stock.salesAnalysis({ from: `${row.month}-01`, to, direction: "purchases", groupBy: "item" });
      close(row.revenue, pl.revenue.total, `${row.month} revenue`);
      close(row.grossProfit, pl.grossProfit, `${row.month} gross profit`);
      close(row.netProfit, pl.netProfit, `${row.month} net profit`);
      close(row.purchases, bought.totals.netValue, `${row.month} purchases`);
    }
    const [r3, r2, r1, r0] = R.summary.monthly.slice(-4);
    assert.deepEqual([r3.revenue, r2.revenue, r1.revenue, r0.revenue], [180, 450, 300, 640]);
    assert.deepEqual([r3.grossProfit, r2.grossProfit, r1.grossProfit, r0.grossProfit], [30, 150, 100, 300]);
    assert.deepEqual([r3.purchases, r2.purchases, r1.purchases, r0.purchases], [500, 2000, 440, 100]);
    assert.ok(R.summary.monthly.slice(0, 4).every((x) => x.revenue === 0 && x.purchases === 0));
    assert.deepEqual(R.summary.peak, { month: m, revenue: 640 });
  });

  it("top product: the item that earned most this period, with its change and its last seven months", async () => {
    const t = R.summary.topProduct;
    const p = R.summary.period;
    const now = await svc.Stock.salesAnalysis({ from: p.from, to: p.to, groupBy: "item", direction: "sales" });
    const before = await svc.Stock.salesAnalysis({ from: p.previousFrom, to: p.previousTo, groupBy: "item", direction: "sales" });
    assert.equal(t.name, "Rice");
    assert.equal(t.revenue, 640);
    assert.equal(t.revenue, now.rows[0].netRevenue);
    const was = before.rows.find((r) => r.key === "RICE")?.netRevenue || 0;
    assert.equal(t.previousRevenue, was);
    assert.equal(t.changePct, was > 0 ? Math.round(((640 - was) / was) * 10000) / 100 : null);
    assert.deepEqual(keys(t.spark), monthsEnding(M(), 7));
    assert.deepEqual(t.spark.slice(-4).map((x) => x.revenue), [180, 150, 300, 640]);
    assert.equal(t.stockId, String(rice._id));
  });

  it("VAT: the quarter so far from the VAT return, with output VAT by month", async () => {
    const v = R.summary.vat;
    const from = quarterFrom(today());
    const ret = await svc.Vat.compute({ from, to: today() });
    assert.deepEqual([v.from, v.to], [from, today()]);
    assert.deepEqual([v.outputVat, v.recoverableVat, v.net], [ret.totals.outputVat, ret.totals.recoverableVat, ret.totals.netPayable]);
    assert.equal(v.unclassifiedLines, 1, "the 0% sale with no tax code");
    assert.equal(v.hasActivity, true);
    assert.equal(v.position, v.net > 0 ? "payable" : v.net < 0 ? "refundable" : "nil");
    assert.deepEqual(keys(v.spark), monthsEnding(M(), 6));
    // 5% of 180, of 150 + 300, of 300, then this month's 540 + 100 less the 30 returned (the 30 sold at 0% adds none)
    assert.deepEqual(v.spark.slice(-4).map((x) => x.outputVat), [9, 22.5, 15, 30.5]);
  });

  it("needs attention: drafts, unclassified VAT lines, customers over their limit and expired or expiring batches", async () => {
    assert.deepEqual(R.summary.attention.map((a) => [a.key, a.count, a.to]), [
      ["draft-sales", 2, "/sales-order"],
      ["draft-purchases", 1, "/purchase-order"],
      ["unclassified-vat", 1, "/vat-reports"],
      ["over-limit", 1, "/party-balances?tab=customers"],
      ["expired", 1, "/stock-reports?tab=expiry"],
      ["expiring", 1, "/stock-reports?tab=expiry"],
    ]);
    assert.deepEqual(R.summary.attention.map((a) => a.text), [
      "2 sales orders are waiting for approval.",
      "1 purchase order is waiting for approval.",
      "1 line in this quarter's VAT has no tax treatment.",
      "1 customer is over their credit limit.",
      "1 batch has expired.",
      "1 batch expires within 30 days.",
    ]);
  });

  it("recent activity: the eight latest vouchers, newest first, with where each invoice stands", async () => {
    const book = await svc.Ledger.dayBook({ page: 1, limit: 8 });
    const rows = R.summary.recent;
    assert.equal(rows.length, 8);
    assert.deepEqual(keys(rows, "voucherNo"), keys(book.rows, "voucherNo"));
    const dates = rows.map((r) => new Date(r.date).getTime());
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
    assert.ok(rows.every((r) => r.typeLabel && r.voucherType && r.amount > 0 && ["Paid", "Part-paid", "Unpaid", "Posted"].includes(r.status)));
    const journal = rows.find((r) => r.voucherType === "journal");
    assert.equal(journal.status, "Posted");
    const invoice = rows.find((r) => r.voucherType === "sales_order");
    const doc = await svc.Transaction.findById(invoice.voucherId).lean();
    assert.equal(invoice.status, doc.outstandingAmount <= 0.005 ? "Paid" : doc.paidAmount > 0.005 ? "Part-paid" : "Unpaid");
  });

  // ---------------------------------------------------------------- the charts under it

  it("weekly pulse: approved sales orders and sales returns for each of the last seven days", async () => {
    const w = R.analytics.weekly;
    assert.equal(w.length, 7);
    assert.deepEqual(keys(w, "date"), Array.from({ length: 7 }, (_, i) => orgDay(i - 6)));
    assert.deepEqual([w.at(-1).orders, w.at(-1).returns], [3, 1]);
    assert.ok(w.slice(0, 6).every((d) => d.orders === 0 && d.returns === 0));
  });

  it("customer mix: the top four customers and the rest as Others, shares adding up", async () => {
    const mix = await svc.Dashboard.analytics({ month: shift(M(), -3) });
    assert.deepEqual(mix.customerMix.rows.map((r) => [r.name, r.value]), [["Al Noor", 60], ["Bin Zayed", 48], ["Cust Three", 36], ["Cust Four", 24], ["Others", 12]]);
    assert.equal(mix.customerMix.total, 180);
    close(mix.customerMix.rows.reduce((t, r) => t + r.sharePct, 0), 100, "shares");
    assert.deepEqual(R.analytics.customerMix.rows.map((r) => [r.name, r.value]), [["Al Noor", 510], ["Bin Zayed", 130]], "no Others with two customers");
    const sa = await svc.Stock.salesAnalysis({ from: `${M()}-01`, to: today(), groupBy: "customer", direction: "sales" });
    assert.deepEqual(R.analytics.customerMix.rows.map((r) => r.value), sa.rows.map((r) => r.netRevenue));
  });

  it("performance: collection rate, gross margin and stock availability", async () => {
    const pf = R.analytics.performance;
    assert.equal(pf.collectionRatePct, 14.2);
    assert.equal(pf.grossMarginPct, R.summary.headline.grossMarginPct);
    assert.deepEqual([pf.itemsInStock, pf.activeItems, pf.stockAvailabilityPct], [2, 2, 100]);
  });

  it("sales, purchases and gross profit by month agree with the reports", async () => {
    assert.deepEqual(R.analytics.monthly.map((x) => [x.month, x.sales, x.purchases, x.grossProfit]), R.summary.monthly.map((x) => [x.month, x.revenue, x.purchases, x.grossProfit]));
  });

  it("categories: this month against last, and the last three months", async () => {
    const m = M();
    const cs = R.analytics.categorySales;
    assert.deepEqual([cs.currentMonth, cs.previousMonth], [m, shift(m, -1)]);
    assert.deepEqual(cs.rows, [{ name: "Grains", current: 640, previous: 300 }], "oils sold in neither month");
    const cm = R.analytics.categoryMonths;
    assert.deepEqual(cm.months, monthsEnding(m, 3));
    assert.deepEqual(cm.rows, [{ name: "Grains", values: [150, 300, 640] }, { name: "Oils", values: [300, 0, 0] }]);
  });

  it("cash in and out by month agree with the cash flow report", async () => {
    const cf = R.analytics.cashFlow;
    assert.equal(cf.months.length, 8);
    for (const row of cf.months) {
      const flow = await svc.Ledger.cashFlow({ from: `${row.month}-01`, to: row.month === M() ? today() : lastDay(row.month) });
      close(row.inflow, flow.totalIn, `${row.month} in`);
      close(row.outflow, flow.totalOut, `${row.month} out`);
    }
    assert.deepEqual([cf.months.at(-1).inflow, cf.months.at(-1).outflow], [5100, 300], "the move between cash and bank is neither");
  });

  it("four KPIs: open orders waiting for approval, and receipts and payments this week against last", async () => {
    const [openSales, openPurchases, receipts, payments] = R.analytics.kpis;
    const sales = await svc.Transaction.find({ type: "sales_order", status: "DRAFT" }).lean();
    assert.deepEqual([openSales.count, openSales.value], [2, sales.reduce((t, d) => t + d.totalAmount, 0)]);
    assert.equal(openSales.value, 42);
    assert.deepEqual([openPurchases.count, openPurchases.value], [1, 105]);
    assert.deepEqual([receipts.value, receipts.previous, receipts.changePct], [100, 0, null]);
    assert.deepEqual([payments.value, payments.previous, payments.changePct], [300, 0, null]);
  });

  it("radar: the biggest categories scaled to the best of them", async () => {
    const wide = await svc.Dashboard.analytics({ month: shift(M(), -2) });
    const { radar } = wide;
    assert.deepEqual(radar.categories.map((c) => c.name), ["Oils", "Grains"]);
    assert.deepEqual(radar.facts.map((f) => [f.name, f.volume, f.revenue, f.customers]), [["Oils", 10, 300, 1], ["Grains", 10, 150, 1]]);
    const row = (metric) => radar.metrics.find((x) => x.metric === metric);
    assert.deepEqual([row("Volume").c0, row("Volume").c1], [100, 100]);
    assert.deepEqual([row("Revenue").c0, row("Revenue").c1], [100, 50]);
    assert.ok(radar.metrics.every((x) => x.c0 >= 0 && x.c0 <= 100 && x.c1 >= 0 && x.c1 <= 100));
    assert.deepEqual(R.analytics.radar.categories.map((c) => c.name), ["Grains"]);
  });

  it("order pipeline and invoice settlement for the period's sales orders", async () => {
    assert.deepEqual(R.analytics.pipeline.map((x) => x.value), [5, 3, 0, 0]);
    const old = await svc.Dashboard.analytics({ month: shift(M(), -3) });
    assert.deepEqual(old.pipeline.map((x) => x.value), [5, 5, 1, 1], "Al Noor's oldest invoice took the receipt");
    const last = await svc.Dashboard.analytics({ month: shift(M(), -1) });
    assert.deepEqual(last.settlement.map((x) => x.count), [0, 1, 0, 0], "the next one is part-paid");
    assert.deepEqual(last.pipeline.map((x) => x.value), [1, 1, 1, 0]);
    // the same, worked out from the documents
    const docs = await svc.Transaction.find({ type: "sales_order", status: "APPROVED", date: { $gte: new Date(`${shift(M(), -3)}-01T00:00:00+04:00`), $lte: new Date(`${lastDay(shift(M(), -3))}T23:59:59.999+04:00`) } }).populate({ path: "partyId", model: "Customer", select: "paymentTerms" }).lean();
    const expected = { paid: 0, partPaid: 0, overdue: 0, notDue: 0 };
    for (const d of docs) {
      const due = new Date(d.date).getTime() + svc.Ageing.termDays(d.partyId.paymentTerms) * 86400000;
      const late = Math.floor((svc.Ledger.dayEnd(today()) - due) / 86400000) > 0;
      expected[d.outstandingAmount <= 0.005 ? "paid" : d.paidAmount > 0.005 ? "partPaid" : late ? "overdue" : "notDue"] += 1;
    }
    assert.deepEqual(old.settlement.map((x) => x.count), [expected.paid, expected.partPaid, expected.overdue, expected.notDue]);
    assert.deepEqual(old.settlement.map((x) => x.count), [1, 0, 4, 0], "overdue as they stand today, not as they stood at the end of that month");
    assert.deepEqual(R.analytics.settlement.map((x) => x.count), [0, 0, 0, 3], "this month's invoices are not yet due");
    assert.equal(R.analytics.settlement[3].amount, 702);
  });

  it("top customers, treemap and top vendors for the period", async () => {
    assert.deepEqual(R.analytics.topCustomers.map((c) => [c.name, c.netRevenue]), [["Al Noor", 510], ["Bin Zayed", 130]]);
    assert.deepEqual(R.analytics.treemap.map((t) => [t.name, t.size]), [["Rice", 640]]);
    const p = R.analytics.period;
    const now = await svc.Stock.salesAnalysis({ from: p.from, to: p.to, groupBy: "vendor", direction: "purchases" });
    assert.deepEqual(R.analytics.topVendors.map((v) => [v.name, v.purchases]), now.rows.map((r) => [r.name, r.netValue]));
    assert.deepEqual(R.analytics.topVendors.map((v) => [v.name, v.purchases]), [["Delta Foods", 100]]);
    const m2 = await svc.Dashboard.analytics({ month: shift(M(), -2) });
    assert.deepEqual(m2.topVendors.map((v) => [v.name, v.purchases, v.previous]), [["Gulf Mills", 2000, 500]]);
    assert.equal(m2.topVendors[0].changePct, 300);
  });

  it("receivables and payables ageing, bucket by bucket, from the ageing report", async () => {
    const end = svc.Ledger.dayEnd(today());
    const [inn, out] = [await svc.Ageing.report({ type: "receivable", asOf: end }), await svc.Ageing.report({ type: "payable", asOf: end })];
    assert.deepEqual(R.analytics.ageing.map((b) => [b.key, b.receivables, b.payables]), inn.buckets.map((b) => [b.key, inn.totals[b.key], out.totals[b.key]]));
    assert.ok(R.analytics.ageing.some((b) => b.key !== "current" && b.receivables > 0), "last months' invoices are past their terms");
    assert.equal(R.analytics.ageing.reduce((t, b) => t + b.receivables, 0), inn.totals.total);
  });

  it("weekly collections: receipts and invoices for the last six weeks, filed under their Monday", async () => {
    const c = R.analytics.collections;
    assert.equal(c.length, 6);
    const monday = (ymd) => {
      const d = new Date(`${ymd}T00:00:00Z`);
      return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    };
    assert.equal(c.at(-1).weekStart, monday(today()));
    for (let i = 1; i < 6; i++) assert.equal((new Date(c[i].weekStart) - new Date(c[i - 1].weekStart)) / 86400000, 7);
    // worked out from the documents
    const day = (d) => new Date(new Date(d).getTime() + 4 * 3600e3).toISOString().slice(0, 10);
    const first = c[0].weekStart;
    const invoices = (await svc.Transaction.find({ type: "sales_order", status: "APPROVED" }).lean()).filter((d) => day(d.date) >= first);
    const receipts = (await svc.Voucher.find({ voucherType: "receipt", status: "approved" }).lean()).filter((d) => day(d.date) >= first);
    for (const w of c) {
      close(w.invoiced, invoices.filter((d) => monday(day(d.date)) === w.weekStart).reduce((t, d) => t + d.totalAmount, 0), `${w.weekStart} invoiced`);
      close(w.receipts, receipts.filter((d) => monday(day(d.date)) === w.weekStart).reduce((t, d) => t + d.totalAmount, 0), `${w.weekStart} receipts`);
    }
    assert.deepEqual([c.at(-1).receipts, c.at(-1).invoiced], [100, 702]);
  });

  it("hourly pulse: documents created in each two-hour window of Dubai time, by weekday", async () => {
    const h = R.analytics.hourly;
    assert.ok(h.length >= 1);
    assert.ok(h.every((r) => r.hour % 2 === 0));
    const total = h.reduce((t, r) => t + r.mon + r.tue + r.wed + r.thu + r.fri + r.weekend, 0);
    assert.equal(total, (await svc.Transaction.countDocuments({})) + (await svc.Voucher.countDocuments({})));
    const dow = new Date(Date.now() + 4 * 3600e3).getUTCDay(); // 0 Sunday
    const key = ["weekend", "mon", "tue", "wed", "thu", "fri", "weekend"][dow];
    assert.equal(h.reduce((t, r) => t + r[key], 0), total, "everything was created today");
  });

  // ---------------------------------------------------------------- the Sales tab

  it("sales tab: orders, average order, best sellers, daily orders and sales by customer", async () => {
    const s = R.sales;
    assert.equal(s.orders.count, 3);
    assert.equal(s.averageOrder.value, 223.33);
    assert.deepEqual([s.approvedShare.approved, s.approvedShare.created, s.approvedShare.pct], [3, 5, 60]);
    assert.deepEqual(s.bestSellers.map((b) => [b.name, b.revenue, b.fillPct]), [["Rice", 640, 100]]);
    assert.deepEqual(s.monthly.map((x) => [x.month, x.sales, x.purchases]), R.analytics.monthly.map((x) => [x.month, x.sales, x.purchases]));
    assert.deepEqual(s.daily, R.analytics.weekly);
    assert.deepEqual(s.topCustomers.map((c) => [c.name, c.netRevenue]), [["Al Noor", 510], ["Bin Zayed", 130]]);
    // the change on the period before is that period's own figure
    const prev = await svc.Dashboard.sales({ from: s.period.previousFrom, to: s.period.previousTo });
    assert.equal(s.orders.previous, prev.orders.count);
  });

  it("best sellers carry their growth on the period before", async () => {
    const aug = await svc.Dashboard.sales({ month: shift(M(), -2) });
    assert.deepEqual(aug.bestSellers.map((b) => [b.name, b.revenue, b.changePct, b.fillPct]), [["Oil", 300, null, 100], ["Rice", 150, -16.67, 50]]);
  });

  // ---------------------------------------------------------------- the Inventory tab

  it("inventory tab: value by category, low stock and batch alerts, and the ledger's stock value by month", async () => {
    const i = R.inventory;
    const valuation = await svc.Stock.valuation({ asOn: today(), groupBy: "category" });
    assert.equal(i.totals.value, 2050); // 81 rice and 60 oil worth 1,240
    assert.equal(i.totals.value, valuation.totals.value);
    assert.deepEqual(i.categories.map((c) => [c.name, c.items, c.value]), [["Oils", 1, 1240], ["Grains", 1, 810]]);
    close(i.mix.reduce((t, x) => t + x.sharePct, 0), 100, "mix");
    assert.deepEqual(i.lowStock.map((r) => [r.itemName, r.qty, r.reorderLevel, r.status]), [["Rice", 81, 500, "below"]]);
    assert.deepEqual(i.batches.map((b) => [b.batchNumber, b.expired]), [["O-OLD", true], ["O1", false]], "the expired batch first");
    assert.deepEqual([i.totals.reorderItems, i.totals.expiring, i.totals.expired, i.totals.agreesWithLedger], [1, 1, 1, true]);

    const t = i.stockValueTrend;
    assert.equal(t.available, true);
    assert.deepEqual(keys(t.months), monthsEnding(M(), 8));
    assert.deepEqual(t.months.slice(-4).map((x) => x.value), [350, 2050, 2290, 2050]);
    for (const row of t.months.slice(-4)) {
      const rec = (await svc.Stock.valuation({ asOn: row.month === M() ? today() : lastDay(row.month) })).reconciliation;
      assert.equal(row.value, rec.ledgerBalance, `${row.month} against the valuation report`);
    }
  });

  // ---------------------------------------------------------------- the Reports tab

  it("reports tab: gross and net profit, VAT, voucher totals, value growth and ageing", async () => {
    const r = R.reports;
    const p = R.summary.period;
    const pl = await svc.Ledger.profitAndLoss({ from: p.from, to: p.to });
    const book = await svc.Ledger.dayBook({ from: p.from, to: p.to, limit: 1 });
    assert.deepEqual([r.grossProfit, r.netProfit], [pl.grossProfit, pl.netProfit]);
    assert.deepEqual([r.vat.outputVat, r.vat.recoverableVat, r.vat.net], [R.summary.vat.outputVat, R.summary.vat.recoverableVat, R.summary.vat.net]);
    for (const v of r.vouchers) assert.equal(v.amount, book.byType.find((t) => t.voucherType === v.voucherType)?.amount || 0, v.voucherType);
    assert.deepEqual(r.vouchers.map((v) => [v.voucherType, v.amount]), [["receipt", 100], ["payment", 300], ["journal", 5000], ["contra", 1000], ["expense", 0]]);
    assert.deepEqual(r.valueGrowth.map((x) => x.grossProfit), R.summary.monthly.map((x) => x.grossProfit));
    assert.deepEqual(r.ageing, R.analytics.ageing);
  });

  // ---------------------------------------------------------------- balances and a chosen period

  it("receivables and payables owed come out as the party balances say", async () => {
    const customers = await svc.Ledger.partyBalances({ type: "customer", asOn: today() });
    const vendors = await svc.Ledger.partyBalances({ type: "vendor", asOn: today() });
    assert.equal(customers.totals.overLimit, 1);
    assert.equal(vendors.totals.owed, 2892); // 525 + 2,100 + 462 + 105 less the 300 paid
  });

  it("a past month, a week and a custom range each give their own figures", async () => {
    const m1 = shift(M(), -1);
    const past = await svc.Dashboard.summary({ month: m1 });
    assert.deepEqual([past.period.from, past.period.to, past.period.previousFrom, past.period.previousTo], [`${m1}-01`, lastDay(m1), `${shift(M(), -2)}-01`, lastDay(shift(M(), -2))]);
    assert.deepEqual([past.headline.revenue, past.headline.previousRevenue, past.headline.changePct, past.headline.grossProfit], [300, 450, -33.33, 100]);
    assert.deepEqual(past.monthly.at(-1).month, m1);

    const week = await svc.Dashboard.summary({ period: "week" });
    const quarter = await svc.Dashboard.summary({ period: "quarter" });
    assert.equal(week.period.id, "week");
    assert.equal(quarter.period.id, "quarter");
    const wpl = await svc.Ledger.profitAndLoss({ from: week.period.from, to: week.period.to });
    assert.equal(week.headline.revenue, wpl.revenue.total);
    assert.equal(week.headline.revenue, 640, "everything this month happened today, and today is in this week");
    const qpl = await svc.Ledger.profitAndLoss({ from: quarter.period.from, to: quarter.period.to });
    assert.equal(quarter.headline.revenue, qpl.revenue.total);
    const custom = await svc.Dashboard.summary({ from: `${m1}-10`, to: `${m1}-20` });
    assert.equal(custom.period.id, "custom");
    assert.equal(custom.headline.revenue, 300);
  });

  it("stock that no longer agrees with the Inventory account is flagged", async () => {
    await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), narration: "Manual", lines: [{ accountId: inventoryAccountId, debit: 50 }, { accountId: equity._id, credit: 50 }] }, admin);
    const d = await svc.Dashboard.summary();
    assert.deepEqual(d.attention.map((a) => a.key), ["draft-sales", "draft-purchases", "unclassified-vat", "stock-ledger", "over-limit", "expired", "expiring"]);
    assert.equal(d.attention.find((a) => a.key === "stock-ledger").to, "/stock-reports?tab=valuation");
    const inv = await svc.Dashboard.inventory({});
    assert.equal(inv.totals.agreesWithLedger, false);
    assert.equal(inv.stockValueTrend.months.at(-1).value, 2100);
  });

  it("inventory tab: with more than five categories the rest are listed as Others", async () => {
    const vendor = await svc.Vendor.create({ vendorId: "V9", vendorName: "Small Lots", contactPerson: "x", address: "y" });
    for (const [n, price] of [4, 3, 2, 1].entries()) {
      const category = await svc.Category.create({ name: `Extra ${n}` });
      const item = await svc.Item.create({ itemId: `X${n}`, sku: `X${n}`, itemName: `Extra ${n}`, category: category._id });
      const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: item._id, description: "x", qty: 1, price: price + 0, rate: price, vatPercent: 5 }] }, "tester");
      await svc.Tx.processTransaction(t._id, "approve", "tester");
    }
    const inv = await svc.Dashboard.inventory({});
    assert.deepEqual(inv.mix.map((x) => x.name), ["Oils", "Grains", "Extra 0", "Extra 1", "Extra 2", "Others"]);
    assert.equal(inv.mix.at(-1).value, 1, "the smallest category");
    assert.equal(inv.mix.reduce((t, x) => t + x.value, 0), inv.totals.value);
    assert.equal(inv.categories.length, 4, "the cards show the four largest");
  });
});
