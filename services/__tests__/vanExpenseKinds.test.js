// Van expense types and office-paid van costs, against a throwaway database: the organisation's own list (Mechanical
// added, Toll removed) is what a road expense chooses from, a type may post to its own account, an office expense voucher
// may name a van (a tag only, set or cleared even once posted), and a road expense keeps its trip's van.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vek_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Org: require("../core/organisationService"),
    Tx: require("../orderPurchase/transactionService"),
    StockService: require("../stock/stockService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Fleet: require("../vansales/vanFleetService"),
    Settings: require("../vansales/vanSettingsService"),
    Tag: require("../vansales/vanExpenseTagService"),
    Fin: require("../financial/financialService"),
    Chart: require("../financial/defaultChartService"),
    Accounts: require("../financial/chartOfAccountsService"),
    Config: require("../financial/accountConfigService"),
    migrations: require("../../utils/migrations"),
    Organisation: require("../../models/core/organisationModel"),
    Customer: require("../../models/modules/customerModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    fin: require("../../models/modules/financial/financialModels"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Chart.provision();
  await svc.Org.ensureDefault();
  await svc.Organisation.updateOne({ code: "default" }, { $set: { moduleOverrides: { vansales: true } } });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let person, van, other, trip, repairs, general, tollVoucher, roadVoucher;
const by = () => String(person._id);
const debitAccountsOf = async (voucherId) => (await svc.fin.LedgerEntry.find({ voucherId, debitAmount: { $gt: 0 } }).lean()).map((e) => String(e.accountId));
const stored = (id) => svc.fin.Voucher.findById(id).lean();
const office = (extra) => svc.Fin.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: general, description: "Garage bill", amount: 250, paymentMode: "cash", ...extra }, by());

test("setup: two vans, one out on a trip, a general expense account and one for repairs", { skip }, async () => {
  person = await svc.Admin.create({ name: "Rashid", email: `rashid-ek.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Food" });
  const rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 20, price: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by() }, "tester");
  other = await svc.Van.create({ code: "VAN-2", name: "Van Two" }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 5 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
  const postable = await svc.Accounts.listPostable();
  general = String(postable.find((a) => a.accountName === "Rent Expense" || a.category === "EXPENSE")._id);
  const group = postable.find((a) => a.accountName === "Van Running Expenses")?.groupId || postable.find((a) => a.category === "EXPENSE").groupId;
  await svc.Accounts.createAccount({ accountName: "Van Repairs", groupId: group }, undefined, by());
  repairs = String((await svc.fin.LedgerAccount.findOne({ accountName: "Van Repairs" }))._id);
});

test("a road expense chooses from the organisation's list, Mechanical included, and an unknown or removed type is refused", { skip }, async () => {
  tollVoucher = await svc.Fleet.expense(trip._id, { kind: "toll", amount: 8 }, by());
  roadVoucher = await svc.Fleet.expense(trip._id, { kind: "mechanical", amount: 120, note: "Fan belt" }, by());
  const running = await svc.Config.resolveAccount("van-expenses");
  assert.deepEqual(await debitAccountsOf(roadVoucher._id), [String(running)], "no account of its own yet");
  const r = await stored(roadVoucher._id);
  assert.deepEqual([r.vanExpenseKind, r.vanExpenseLabel, r.vanRef.vanCode, String(r.vanRef.vanId)], ["mechanical", "Mechanical / repairs", "VAN-1", String(van._id ?? van.id)]);
  for (const kind of ["lunch", "constructor", "", ["fuel"]]) await assert.rejects(() => svc.Fleet.expense(trip._id, { kind, amount: 1 }, by()), { code: "EXPENSE_KIND_REQUIRED" }, JSON.stringify(kind));

  // the organisation drops Toll and gives repairs their own account
  const cash = String(await svc.Config.resolveAccount("inventory-asset"));
  await assert.rejects(() => svc.Settings.save({ expenseKinds: [{ key: "mechanical", label: "Repairs", accountId: cash }] }), { code: "INVALID_EXPENSE_ACCOUNT" });
  await svc.Settings.save({ expenseKinds: [{ key: "fuel", label: "Fuel" }, { key: "mechanical", label: "Repairs", accountId: repairs }, { key: "other", label: "Other" }, { label: "Tyres" }] });
  await assert.rejects(() => svc.Fleet.expense(trip._id, { kind: "toll", amount: 1 }, by()), { code: "EXPENSE_KIND_REQUIRED" });
  const fixed = await svc.Fleet.expense(trip._id, { kind: "mechanical", amount: 40 }, by());
  assert.deepEqual(await debitAccountsOf(fixed._id), [repairs]);
  await svc.Fleet.expense(trip._id, { kind: "tyres", amount: 5 }, by());
  const list = await svc.Fleet.tripExpenses(trip._id);
  assert.deepEqual(list.map((e) => [e.kind, e.label]).sort(), [["mechanical", "Mechanical / repairs"], ["mechanical", "Repairs"], ["toll", "Toll"], ["tyres", "Tyres"]], "each keeps the name it had that day");
  assert.equal(tollVoucher.status, "approved");
});

test("an office expense names a van: a tag only, from the list, never from a made-up body", { skip }, async () => {
  const v = await office({ vanId: String(other.id), vanExpenseKind: "mechanical" });
  const s = await stored(v._id);
  assert.deepEqual([s.vanRef.vanCode, s.vanExpenseKind, s.vanExpenseLabel], ["VAN-2", "mechanical", "Repairs"]);
  assert.deepEqual(await debitAccountsOf(v._id), [general], "the tag posts nothing: the account chosen is the account posted");
  assert.equal((await stored((await office({ vanId: String(other.id) }))._id)).vanExpenseKind, "other", "no type said: other");
  await assert.rejects(() => office({ vanId: String(new mongoose.Types.ObjectId()) }), { code: "VAN_NOT_FOUND" });
  await assert.rejects(() => office({ vanId: String(other.id), vanExpenseKind: "toll" }), { code: "EXPENSE_KIND_UNKNOWN" });
  const forged = await office({ vanRef: { vanId: other.id, vanCode: "FAKE" }, vanExpenseKind: "mechanical", vanExpenseLabel: "Fake" });
  const f = await stored(forged._id);
  assert.deepEqual([f.vanRef, f.vanExpenseKind, f.vanExpenseLabel], [undefined, undefined, undefined]);
  await svc.Organisation.updateOne({ code: "default" }, { $set: { moduleOverrides: {} } });
  await assert.rejects(() => office({ vanId: String(other.id) }), { code: "VAN_SALES_OFF" });
  assert.deepEqual(await svc.Tag.choices(), { vans: [], expenseKinds: [] });
  await svc.Organisation.updateOne({ code: "default" }, { $set: { moduleOverrides: { vansales: true } } });
  const choices = await svc.Tag.choices();
  assert.deepEqual(choices.vans.map((x) => x.code), ["VAN-1", "VAN-2"]);
  assert.equal(choices.expenseKinds.find((k) => k.key === "mechanical").label, "Repairs");
});

test("a posted office expense can have its van set, changed and cleared with a reason; a road expense keeps its own", { skip }, async () => {
  const v = await office({});
  await assert.rejects(() => svc.Fin.updateVoucher(v._id, { vanId: String(van.id), vanExpenseKind: "fuel" }, by()), { code: "REASON_REQUIRED" });
  await svc.Fin.updateVoucher(v._id, { vanId: String(van.id), vanExpenseKind: "fuel", reason: "It was for Van One" }, by());
  assert.equal((await stored(v._id)).vanRef.vanCode, "VAN-1");
  await svc.Fin.updateVoucher(v._id, { narration: "Diesel", reason: "wording" }, by());
  assert.equal((await stored(v._id)).vanRef.vanCode, "VAN-1", "an edit that says nothing keeps it");
  await svc.Fin.updateVoucher(v._id, { vanId: "", reason: "not a van cost after all" }, by());
  assert.equal((await stored(v._id)).vanRef, undefined);
  await assert.rejects(() => svc.Fin.updateVoucher(roadVoucher._id, { vanId: String(other.id), reason: "move it" }, by()), { code: "VAN_EXPENSE_FROM_TRIP" });
  await svc.Fin.updateVoucher(roadVoucher._id, { narration: "Fan belt, Al Quoz", vanId: String(van.id), vanExpenseKind: "mechanical", reason: "wording" }, by());
  assert.equal((await stored(roadVoucher._id)).vanRef.vanCode, "VAN-1");
});

test("road expenses from before a van was recorded are given their trip's van, once", { skip }, async () => {
  await svc.fin.Voucher.collection.updateOne({ _id: tollVoucher._id }, { $unset: { vanRef: 1, vanExpenseLabel: 1 } });
  assert.equal(await svc.migrations.stampVanOnRoadExpenses(), 1);
  const s = await stored(tollVoucher._id);
  assert.deepEqual([s.vanRef.vanCode, s.vanExpenseKind, s.vanExpenseLabel], ["VAN-1", "toll", "Toll"]);
  assert.equal(await svc.migrations.stampVanOnRoadExpenses(), 0);
});
