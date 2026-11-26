// The FTA Audit File from real books: its listings tie to the VAT return, its ledger ties to the books. Throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/ftaAuditFile.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_faf_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const admin = new mongoose.Types.ObjectId();
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
const dmy = (ymd) => ymd.split("-").reverse().join("-");
const money = (n) => Math.round(Number(n) * 100) / 100;

let svc;
let invoice;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Config: require("../financial/accountConfigService"),
    Vat: require("../reports/vatReturnService"),
    Faf: require("../reports/ftaAuditFileService"),
    ...require("../../models/modules/financial/financialModels"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
  };
  require("../../models/core/organisationModel");
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  const customer = await svc.Customer.create({ customerId: "C1", customerName: 'Al Noor, "Wholesale" LLC', contactPerson: "x", creditLimit: 1e6, trnNumber: "100999888700003" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y", trnNO: "100555444300003" });
  const stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Basmati Rice", category: new mongoose.Types.ObjectId() });
  const codes = Object.fromEntries((await svc.TaxCode.find({}).lean()).map((c) => [c.kind, c]));
  const line = (qty, price, extra = {}) => ({ itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5, ...extra });
  const post = async (type, party, partyType, items, extra = {}) => {
    const t = await svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, ...extra }, "tester");
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };
  await post("purchase_order", vendor, "Vendor", [line(100, 10)], { vendorReference: "GM-7781" }); // input 1000 / 50
  await post("purchase_order", vendor, "Vendor", [line(1, 400, { taxCodeId: codes.reverse_charge._id })]); // reverse charge 400 / 20 assessed
  invoice = await post("sales_order", customer, "Customer", [line(10, 20), line(5, 20, { taxCodeId: codes.zero_rated._id })]);
  await post("sales_return", customer, "Customer", [line(2, 20)]); // -40 / -2
  await mongoose.model("Transaction").updateOne({ _id: invoice._id }, { $set: { "items.1.description": "" } }); // an older line with none
  const rent = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" });
  const cash = await svc.LedgerAccount.findOne({ accountName: "Cash in Hand" });
  const equity = await svc.LedgerAccount.findOne({ accountName: "Opening Balance Equity" });
  await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), lines: [{ accountId: cash._id, debit: 5000 }, { accountId: equity._id, credit: 5000 }] }, admin);
  await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 200, taxCodeId: codes.standard._id, description: "Rent", paymentMode: "cash", date: new Date() }, admin);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// the rows of one table: the lines between its start marker and its end marker, and the end marker's own fields
const table = (text, name) => {
  const lines = text.split("\r\n");
  const a = lines.indexOf(`${name}Start`);
  const b = lines.findIndex((l, i) => i > a && l.startsWith(`${name}End`));
  assert.ok(a >= 0 && b > a, `${name} table is there`);
  return { rows: lines.slice(a + 1, b).map((l) => l.split(",")), end: lines[b].split(",") };
};
const period = () => ({ from: orgDay(-1), to: orgDay(1) });

test("a file is refused until the company has a tax number, and for a nonsense period", { skip }, async () => {
  await assert.rejects(svc.Faf.generate(period()), (e) => e.code === "TRN_REQUIRED");
  await svc.Settings.updateOne({}, { $set: { "profile.trn": "100123456700003", "profile.legalName": "Harbour Trading, LLC" } });
  await assert.rejects(svc.Faf.generate({ from: "2026-13", to: orgDay() }), (e) => e.code === "PERIOD_REQUIRED");
  await assert.rejects(svc.Faf.generate({ from: orgDay(1), to: orgDay(-1) }), (e) => e.code === "INVALID_PERIOD");
});

test("the four tables carry the books, and their totals agree with the VAT return and with each other", { skip }, async () => {
  const file = await svc.Faf.generate(period());
  assert.equal(file.fileName, `FAF_100123456700003_${orgDay(-1)}_${orgDay(1)}.csv`);
  const markers = file.text.split("\r\n").filter((l) => /^(CompInfo|PurcData|SuppData|GLData)(Start|End)/.test(l)).map((l) => l.split(",")[0]);
  assert.deepEqual(markers, ["CompInfoStart", "CompInfoEnd", "PurcDataStart", "PurcDataEnd", "SuppDataStart", "SuppDataEnd", "GLDataStart", "GLDataEnd"]);

  const company = table(file.text, "CompInfo").rows[0];
  assert.deepEqual([company[0], company[2], company[7], company[8], company[11]], ["Harbour Trading; LLC", "100123456700003", dmy(orgDay(-1)), dmy(orgDay(1)), "FAFv1.0.0"]);

  const vat = await svc.Vat.compute(period());
  const box = (id) => vat.boxes.find((b) => b.box === id);

  const supplies = table(file.text, "SuppData");
  assert.equal(supplies.rows.length, 3, "two invoice lines and the return's line");
  for (const r of supplies.rows) assert.equal(r.length, 13, "13 fields a supply row");
  assert.equal(supplies.rows[0][0], "Al Noor; 'Wholesale' LLC", "no comma or quote inside a field");
  assert.equal(supplies.rows[0][1], "100999888700003");
  assert.ok(supplies.rows.some((r) => r[5] === "Basmati Rice" && r[8] === "ZR"), "a line with no description is named by its item");
  // output VAT of our own supplies: box 8 less the reverse-charge supplies we received (box 3)
  assert.equal(Number(supplies.end[2]), money(box("8").vat - box("3").vat));
  assert.equal(Number(supplies.end[1]), money(200 + 100 - 40));
  assert.equal(supplies.end[3], "3");
  assert.equal(file.totals.supplies.vat, Number(supplies.end[2]));

  const purchases = table(file.text, "PurcData");
  assert.equal(purchases.rows.length, 3);
  for (const r of purchases.rows) assert.equal(r.length, 13, "13 fields a purchase row");
  assert.ok(purchases.rows.some((r) => r[3] === "GM-7781"), "the supplier's own invoice number");
  const rc = purchases.rows.find((r) => r[9] === "RC");
  assert.deepEqual([rc[7], rc[8]], ["400.00", "20.00"], "the tax assessed on a reverse-charge purchase");
  assert.equal(Number(purchases.end[2]), box("11").vat, "recoverable input tax");
  assert.equal(Number(purchases.end[1]), box("11").amount);

  const ledger = table(file.text, "GLData");
  const entries = await svc.LedgerEntry.countDocuments({ isReversed: { $ne: true } });
  assert.equal(ledger.rows.length, entries);
  for (const r of ledger.rows) assert.equal(r.length, 11, "11 fields a ledger row");
  assert.equal(ledger.end[1], ledger.end[2], "debits equal credits");
  assert.equal(ledger.end[3], String(entries));
  assert.equal(ledger.end[4], "AED");
  // each account's last running balance is its balance in the books
  const last = new Map(ledger.rows.map((r) => [r[2], Number(r[10])]));
  for (const name of ["Cash in Hand", "Rent Expense"]) {
    const sum = await svc.LedgerEntry.aggregate([{ $match: { accountName: name, isReversed: { $ne: true } } }, { $group: { _id: null, net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } }]);
    assert.equal(last.get(name), money(sum[0].net), name);
  }
  assert.ok(ledger.rows.some((r) => r[5] === invoice.transactionNo && r[7] === "Sales invoice"));
});

test("a later period starts from the balance brought forward", { skip }, async () => {
  const file = await svc.Faf.generate({ from: orgDay(2), to: orgDay(3) });
  assert.equal(table(file.text, "GLData").rows.length, 0);
  assert.deepEqual(table(file.text, "SuppData").end, ["SuppDataEnd", "0.00", "0.00", "0"]);
});

test("a single branch's view cannot make the file: it is the taxpayer's", { skip }, async () => {
  const { runWithTenant } = require("../../utils/tenantContext");
  await assert.rejects(runWithTenant({ companyId: "default", branchId: "shj", branchView: "shj" }, () => svc.Faf.generate(period())), (e) => e.code === "ALL_BRANCHES_REQUIRED");
});
