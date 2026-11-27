// Box 1 by the emirate of the establishment that made the supply, the totals by tax code and by emirate, and the whole
// period's documents for the export. Throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/vatEmirates.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_emr_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
const period = () => ({ from: orgDay(-1), to: orgDay(1) });

let svc;
let runWithTenant;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  ({ runWithTenant } = require("../../utils/tenantContext"));
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Config: require("../financial/accountConfigService"),
    Vat: require("../reports/vatReturnService"),
    Org: require("../core/organisationService"),
    Branches: require("../core/branchService"),
    Branch: require("../../models/core/branchModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.Org.ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  const customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e6 });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  const stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  const codes = Object.fromEntries((await svc.TaxCode.find({}).lean()).map((c) => [c.kind, c]));
  await svc.Branch.create({ code: "shj", name: "Sharjah", emirate: "Sharjah" });
  await svc.Branch.create({ code: "ajm", name: "Ajman store" }); // names no emirate: follows the company's

  const line = (qty, price, extra = {}) => ({ itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5, ...extra });
  const post = async (type, party, partyType, items) => {
    const t = await svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items }, "tester");
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };
  const inBranch = (branchId, fn) => runWithTenant({ companyId: "default", branchId, branchView: null }, fn);
  await post("purchase_order", vendor, "Vendor", [line(100, 10)]);
  await post("sales_order", customer, "Customer", [line(10, 20, { taxCodeId: codes.standard._id })]); // head office 200 / 10
  await inBranch("shj", () => post("sales_order", customer, "Customer", [line(5, 20)])); // Sharjah 100 / 5
  await inBranch("ajm", () => post("sales_order", customer, "Customer", [line(3, 20)])); // company's emirate 60 / 3
  await inBranch("shj", () => post("sales_order", customer, "Customer", [line(2, 50, { taxCodeId: codes.zero_rated._id })])); // 100 zero
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const box = (r, id) => r.boxes.find((b) => b.box === id);

test("box 1 puts a supply under its branch's emirate, else the company's, and says when that was assumed", { skip }, async () => {
  const r = await svc.Vat.compute(period());
  assert.deepEqual([box(r, "1c").amount, box(r, "1c").vat], [100, 5], "the Sharjah branch");
  assert.deepEqual([box(r, "1b").amount, box(r, "1b").vat], [260, 13], "head office and the branch with no emirate");
  assert.equal(r.emirateAssumed, true, "no company emirate is set, and some supplies fell back to Dubai");
  assert.deepEqual([box(r, "8").amount, box(r, "8").vat], [460, 18]);
  assert.ok(r.reconciliation.rows.every((x) => x.agrees));
});

test("a company emirate takes the unnamed branches with it and nothing is assumed", { skip }, async () => {
  await svc.Config.updateSettings({ profile: { emirate: "Abu Dhabi" } }, "tester").catch(async () => {
    await require("../../models/modules/financial/companySettingsModel").updateOne({}, { $set: { "profile.emirate": "Abu Dhabi" } });
  });
  const r = await svc.Vat.compute(period());
  assert.deepEqual([box(r, "1a").amount, box(r, "1c").amount, box(r, "1b").amount], [260, 100, 0]);
  assert.equal(r.emirateAssumed, false);
});

test("the report by tax code and by emirate adds up to the return's boxes", { skip }, async () => {
  const [a, r] = await Promise.all([svc.Vat.analysis(period()), svc.Vat.compute(period())]);
  const emirate = (name) => a.emirates.find((e) => e.emirate === name);
  assert.equal(a.emirates.length, 7);
  assert.deepEqual([emirate("Sharjah").standard, emirate("Sharjah").standardVat, emirate("Sharjah").zeroRated], [100, 5, 100]);
  assert.deepEqual([emirate("Abu Dhabi").standard, emirate("Abu Dhabi").standardVat], [260, 13]);
  assert.equal(a.emirates.reduce((t, e) => t + e.standardVat, 0), box(r, "8").vat);
  const output = a.taxCodes.filter((c) => c.direction === "output");
  assert.equal(output.reduce((t, c) => t + c.vat, 0), box(r, "8").vat);
  assert.equal(output.reduce((t, c) => t + c.taxable, 0), box(r, "8").amount);
  assert.ok(output.some((c) => c.kind === "zero_rated" && c.taxable === 100 && c.vat === 0));
  const input = a.taxCodes.filter((c) => c.direction === "input");
  assert.equal(input.reduce((t, c) => t + c.vat, 0), box(r, "11").vat);
});

test("the export asks for every document of the period, not one page of them", { skip }, async () => {
  const paged = await svc.Vat.detail({ ...period(), limit: 2 });
  assert.equal(paged.rows.length, 2);
  const whole = await svc.Vat.detail({ ...period(), limit: 2, all: true });
  assert.equal(whole.rows.length, whole.total);
  assert.equal(whole.total, 5);
});

test("a branch's emirate is one of the seven, or blank to follow the company", { skip }, async () => {
  await assert.rejects(svc.Branches.update("shj", { emirate: "Muscat" }), (e) => e.code === "INVALID_EMIRATE");
  assert.equal((await svc.Branches.update("ajm", { emirate: "ajman" })).emirate, "Ajman");
  assert.equal((await svc.Branches.update("ajm", { emirate: "" })).emirate, undefined);
  assert.equal((await svc.Branches.update("shj", { name: "Sharjah Industrial" })).emirate, "Sharjah", "an edit that names none keeps it");
});

test("a saved return keeps who it is of, and names who prepared and finalised it", { skip }, async () => {
  const Settings = require("../../models/modules/financial/companySettingsModel");
  await Settings.updateOne({}, { $set: { "profile.trn": "100123456700003", "profile.legalName": "Harbour Trading", "profile.addressLine1": "Plot 4", "profile.city": "Abu Dhabi" } });
  const Admin = require("../../models/core/adminModel");
  const person = await Admin.create({ name: "Mariam", email: `mariam.${Date.now()}@test.uae`, password: "12312312", type: "admin" });
  const draft = await svc.Vat.createDraft(period(), String(person._id));
  await svc.Vat.finalize(draft._id, String(person._id));
  await Settings.updateOne({}, { $set: { "profile.legalName": "Renamed since" } });
  const kept = await svc.Vat.get(draft._id);
  assert.deepEqual(kept.taxpayer, { trn: "100123456700003", nameEn: "Harbour Trading", nameAr: "", address: "Plot 4, Abu Dhabi" });
  assert.deepEqual([kept.createdByName, kept.finalizedByName, kept.filedByName], ["Mariam", "Mariam", ""]);
  assert.equal(kept.changedSince, null);
});
