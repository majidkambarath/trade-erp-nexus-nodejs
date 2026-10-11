// Trade reports: sales and purchases by party, by item, by party and item and by month, the line register, and the
// receivables / payables movement per party. Real documents through the real service; throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/tradeReports.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const Y = new Date(Date.now() + 4 * 3600e3).getUTCFullYear();
const D = (m, d) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let svc;
let c1, c2, v1, v2, rice, oil, saleReturn;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Reports: require("../reports/tradeReportsService"),
    Balances: require("../reports/ledgerReportsService"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });

  const category = new mongoose.Types.ObjectId();
  c1 = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", billingAddress: "Deira", paymentTerms: "Net 30" });
  c2 = await svc.Customer.create({ customerId: "C2", customerName: "Bright Star", contactPerson: "x", billingAddress: "Bur Dubai", paymentTerms: "Net 30" });
  v1 = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mill", contactPerson: "x", address: "Jebel Ali", paymentTerms: "Net 30" });
  v2 = await svc.Vendor.create({ vendorId: "V2", vendorName: "Oil Co", contactPerson: "x", address: "Sharjah", paymentTerms: "Net 30" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice 5kg", category });
  oil = await svc.Stock.create({ itemId: "OIL", sku: "OIL", itemName: "Corn Oil", category });

  const line = (stock, qty, price, extra = {}) => ({ itemId: stock._id, description: stock.itemName, qty, price, rate: price, vatPercent: 0, ...extra });
  const doc = async (type, party, partyType, items, date, approve = true) => {
    const t = await svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, date }, "tester");
    if (approve) await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };
  // purchases: V1 rice 100 @10 (Feb), V2 oil 50 @20 (Mar), V1 rice 50 @12 (Mar)
  await doc("purchase_order", v1, "Vendor", [line(rice, 100, 10)], D(2, 5));
  await doc("purchase_order", v2, "Vendor", [line(oil, 50, 20)], D(3, 3));
  await doc("purchase_order", v1, "Vendor", [line(rice, 50, 12)], D(3, 20));
  // sales: C1 rice 30 @15 (Feb), C2 rice 20 @16 + oil 10 @30 (Mar), C1 oil 5 @30 (Mar), and a draft that must not count
  const s1 = await doc("sales_order", c1, "Customer", [line(rice, 30, 15)], D(2, 10));
  await doc("sales_order", c2, "Customer", [line(rice, 20, 16), line(oil, 10, 30)], D(3, 12));
  await doc("sales_order", c1, "Customer", [line(oil, 5, 30)], D(3, 25));
  await doc("sales_order", c1, "Customer", [line(rice, 1, 15)], D(3, 26), false);
  // C1 sends 4 rice back, against the February sale
  saleReturn = await svc.Tx.createTransaction({
    type: "sales_return", partyId: c1._id, partyType: "Customer", partyTypeRef: "Customer", date: D(3, 28), returnOf: { transactionId: s1._id },
    items: [line(rice, 4, 15, { returnOfLineId: s1.items[0]._id })],
  }, "tester");
  await svc.Tx.processTransaction(saleReturn._id, "approve", "tester");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const year = { from: D(1, 1), to: D(12, 31) };
const byKey = (rows, name) => rows.find((r) => r.partyName === name || r.itemName === name || r.month === name);

test("sales by customer: what each bought, returns taken off, drafts left out", { skip }, async () => {
  const r = await svc.Reports.summary({ direction: "sales", groupBy: "party", ...year });
  const noor = byKey(r.rows, "Al Noor");
  const star = byKey(r.rows, "Bright Star");
  // Al Noor: rice 30 x 15 = 450, oil 5 x 30 = 150, less 4 rice x 15 = 60 returned; the draft is not counted
  assert.equal(noor.gross, 600);
  assert.equal(noor.returns, 60);
  assert.equal(noor.net, 540);
  assert.equal(noor.quantity, 31, "30 + 5 - 4");
  assert.equal(noor.documents, 3, "two sales and the return");
  assert.equal(noor.items, 2);
  // Bright Star: rice 20 x 16 = 320, oil 10 x 30 = 300
  assert.equal(star.net, 620);
  assert.equal(r.totals.net, 1160);
  assert.deepEqual(r.rows.map((x) => x.partyName), ["Bright Star", "Al Noor"], "biggest first");
  assert.equal(r.totals.parties, 2);
});

test("sales by item: quantity, value, average price and how many customers bought it", { skip }, async () => {
  const r = await svc.Reports.summary({ direction: "sales", groupBy: "item", ...year });
  const riceRow = byKey(r.rows, "Rice 5kg");
  assert.equal(riceRow.quantity, 46, "30 + 20 - 4");
  assert.equal(riceRow.net, 710, "450 + 320 - 60");
  assert.equal(riceRow.parties, 2);
  assert.ok(Math.abs(riceRow.avgPrice - 710 / 46) < 0.0001);
  const oilRow = byKey(r.rows, "Corn Oil");
  assert.equal(oilRow.quantity, 15);
  assert.equal(oilRow.net, 450);
  assert.equal(r.totals.net, 1160);
});

test("who bought which items: one row per customer and item", { skip }, async () => {
  const r = await svc.Reports.summary({ direction: "sales", groupBy: "party_item", ...year });
  assert.equal(r.rows.length, 4, "Al Noor and Bright Star, each with rice and oil");
  const noorRice = r.rows.find((x) => x.partyName === "Al Noor" && x.itemName === "Rice 5kg");
  assert.equal(noorRice.quantity, 26, "30 bought less 4 returned");
  assert.equal(noorRice.net, 390);
  assert.equal(noorRice.documents, 2, "the sale and the return");
  const starOil = r.rows.find((x) => x.partyName === "Bright Star" && x.itemName === "Corn Oil");
  assert.equal(starOil.quantity, 10);
  assert.equal(starOil.avgPrice, 30);
  assert.ok(r.rows.every((x) => x.partyName && x.itemName));
});

test("purchases by vendor and by item: which vendor supplied which item", { skip }, async () => {
  const vendors = await svc.Reports.summary({ direction: "purchases", groupBy: "party", ...year });
  assert.equal(byKey(vendors.rows, "Gulf Mill").net, 1600, "100 x 10 + 50 x 12");
  assert.equal(byKey(vendors.rows, "Oil Co").net, 1000);
  assert.equal(vendors.partyLabel, "Vendor");
  const pairs = await svc.Reports.summary({ direction: "purchases", groupBy: "party_item", ...year });
  assert.equal(pairs.rows.length, 2);
  const mill = pairs.rows.find((x) => x.partyName === "Gulf Mill");
  assert.equal(mill.itemName, "Rice 5kg");
  assert.equal(mill.quantity, 150);
  assert.ok(Math.abs(mill.avgPrice - 1600 / 150) < 0.0001, "weighted average price paid");
});

test("month by month: totals per month and a column per month on every row", { skip }, async () => {
  const r = await svc.Reports.summary({ direction: "sales", groupBy: "party", monthly: true, ...year });
  assert.deepEqual(r.months.slice(0, 3), [`${Y}-01`, `${Y}-02`, `${Y}-03`], "every month of the range, so a quiet month is a column too");
  assert.equal(r.months.length, 12);
  const noor = byKey(r.rows, "Al Noor");
  assert.equal(noor.monthly[`${Y}-02`].net, 450);
  assert.equal(noor.monthly[`${Y}-03`].net, 90, "oil 150 less the 60 returned in March");
  const months = await svc.Reports.summary({ direction: "sales", groupBy: "month", ...year });
  assert.equal(byKey(months.rows, `${Y}-02`).net, 450);
  assert.equal(byKey(months.rows, `${Y}-03`).net, 710);
  assert.equal(months.totals.net, 1160);
});

test("a period narrows what is counted", { skip }, async () => {
  const feb = await svc.Reports.summary({ direction: "sales", groupBy: "party", from: D(2, 1), to: D(2, 28) });
  assert.equal(feb.rows.length, 1);
  assert.equal(feb.rows[0].partyName, "Al Noor");
  assert.equal(feb.totals.net, 450);
});

test("filters: one customer, one item, a search by name", { skip }, async () => {
  const one = await svc.Reports.summary({ direction: "sales", groupBy: "item", partyId: String(c2._id), ...year });
  assert.equal(one.totals.net, 620);
  const item = await svc.Reports.summary({ direction: "sales", groupBy: "party", itemId: String(oil._id), ...year });
  assert.equal(item.totals.net, 450);
  assert.equal(item.rows.length, 2);
  const byParty = await svc.Reports.summary({ direction: "sales", groupBy: "party", search: "bright", ...year });
  assert.deepEqual(byParty.rows.map((r) => r.partyName), ["Bright Star"]);
  const byItem = await svc.Reports.summary({ direction: "sales", groupBy: "party", search: "corn", ...year });
  assert.equal(byItem.totals.net, 450);
});

test("the register lists every line and adds up to the summary", { skip }, async () => {
  const reg = await svc.Reports.register({ direction: "sales", ...year });
  assert.equal(reg.rows.length, 5, "4 sale lines (1 + 2 + 1) and the return line");
  assert.equal(reg.totals.net, 1160);
  const ret = reg.rows.find((r) => r.kind === "return");
  assert.equal(ret.quantity, -4);
  assert.equal(ret.net, -60);
  assert.equal(ret.partyName, "Al Noor");
  assert.ok(reg.rows.every((r) => r.documentNo && r.itemName && r.partyName));
  const days = reg.rows.map((r) => new Date(r.date).toISOString().slice(0, 10));
  assert.deepEqual(days, [...days].sort().reverse(), "newest first");
  assert.equal(days[0], D(3, 28));
  // the same filters as the summary
  const mine = await svc.Reports.register({ direction: "sales", partyId: String(c1._id), itemId: String(rice._id), ...year });
  assert.equal(mine.rows.length, 2);
  assert.equal(mine.totals.net, 390);
  // paging
  const paged = await svc.Reports.register({ direction: "sales", limit: 4, page: 2, ...year });
  assert.equal(paged.rows.length, 1);
  assert.equal(paged.pagination.total, 5);
  assert.equal(paged.pagination.pages, 2);
});

test("receivables movement: opening, invoiced, returns, received and closing agree with the party balances", { skip }, async () => {
  const m = await svc.Reports.partyMovement({ type: "customer", ...year });
  const noor = m.rows.find((r) => r.partyName === "Al Noor");
  assert.equal(noor.opening, 0);
  assert.equal(noor.invoiced, 600);
  assert.equal(noor.returns, 60);
  assert.equal(noor.settled, 0);
  assert.equal(noor.closing, 540);
  // a period that starts after the February sale brings it forward as opening
  const mar = await svc.Reports.partyMovement({ type: "customer", from: D(3, 1), to: D(3, 31) });
  const noorMar = mar.rows.find((r) => r.partyName === "Al Noor");
  assert.equal(noorMar.opening, 450);
  assert.equal(noorMar.invoiced, 150);
  assert.equal(noorMar.returns, 60);
  assert.equal(noorMar.closing, 540);
  // and closes at what the party balances say
  const balances = await svc.Balances.partyBalances({ type: "customer" });
  for (const r of m.rows) assert.equal(r.closing, balances.rows.find((b) => b.partyName === r.partyName).balance, r.partyName);
  assert.equal(m.totals.closing, r2(m.rows.reduce((t, r) => t + r.closing, 0)));
});

test("payables movement is the vendor's side of the same report", { skip }, async () => {
  const m = await svc.Reports.partyMovement({ type: "vendor", ...year });
  const mill = m.rows.find((r) => r.partyName === "Gulf Mill");
  assert.equal(mill.invoiced, 1600);
  assert.equal(mill.closing, 1600);
  const balances = await svc.Balances.partyBalances({ type: "vendor" });
  for (const r of m.rows) assert.equal(r.closing, balances.rows.find((b) => b.partyName === r.partyName).balance, r.partyName);
});

test("bad parameters are refused with a reason", { skip }, async () => {
  await assert.rejects(() => svc.Reports.summary({ direction: "sideways" }), { code: "INVALID_DIRECTION" });
  await assert.rejects(() => svc.Reports.summary({ direction: "sales", groupBy: "colour" }), { code: "INVALID_GROUP" });
  await assert.rejects(() => svc.Reports.summary({ direction: "sales", from: D(5, 1), to: D(4, 1) }), { code: "INVALID_RANGE" });
  await assert.rejects(() => svc.Reports.summary({ direction: "sales", partyId: "nope" }), { code: "INVALID_ID" });
  await assert.rejects(() => svc.Reports.partyMovement({ type: "supplier" }), { code: "INVALID_TYPE" });
});
