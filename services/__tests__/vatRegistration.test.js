// VAT registration decides what an organisation may charge and claim (UAE organisations), against a throwaway database (random name,
// dropped afterwards).
//
//   not registered   selling: every line and charge is out of scope at 0%, whatever the form sent.
//                    buying:  the supplier's VAT stays on the document, but it cannot be claimed back, so it is part of the cost: it goes
//                             into Inventory (and the stock's cost), and no Input VAT is posted.
//   registered       exactly as before.
//   the date         registration starts on a day; a document dated before it is not a registered one.
//   the return       the VAT return exists only for a registered organisation.
//
//   node --require ./utils/testSetup.js --test services/__tests__/vatRegistration.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dayPlus = (n) => new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

let svc;
test.before(async () => {
  if (skip) return;
  process.env.VAT_REGISTRATION_RULES = "on"; // testSetup switches the rule off for the older suites; this one is about it
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Reg: require("../financial/vatRegistrationService"),
    Voucher: require("../financial/ledgerVoucherService"),
    PaymentMode: require("../banking/paymentModeService"),
    Gate: require("../../middleware/featureGate"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
});

test.after(async () => {
  delete process.env.VAT_REGISTRATION_RULES;
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let vendor, customer, rice, std, outOfScope;
const INVENTORY = "Inventory Stock";
const profile = (set) => svc.Settings.updateOne({}, { $unset: { "profile.trn": "", "profile.vatRegisteredFrom": "" }, $set: { "profile.vatRegistered": true } }).then(() => (set ? svc.Settings.updateOne({}, { $set: set }) : null));
const REGISTERED = { "profile.trn": "100123456700003" };
const L = (qty, price, extra = {}) => ({ itemId: rice._id, description: "Rice", qty, price, rate: price, ...extra });
const sell = (items, extra) => svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items, ...extra }, "tester");
const buy = (items, extra) => svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items, ...extra }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const live = (t) => svc.LedgerEntry.find({ voucherId: t._id, isReversed: { $ne: true } }).lean();
async function byAccount(t) {
  const out = {};
  for (const e of await live(t)) out[e.accountName] = r2((out[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
}

test("setup", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", paymentTerms: "Net 30" });
  const category = await svc.Category.create({ name: "General" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: category._id });
  std = await svc.TaxCode.findOne({ kind: "standard" }).lean();
  outOfScope = await svc.TaxCode.findOne({ kind: "out_of_scope" }).lean();
  assert.ok(std && outOfScope);
});

test("the answer, from the settings and the day", { skip }, async () => {
  await profile();
  assert.deepEqual(await svc.Reg.stateOn(new Date()), { governs: true, registered: false, from: null }, "no tax number on file");
  await profile(REGISTERED);
  assert.equal((await svc.Reg.stateOn(new Date())).registered, true);
  await profile({ ...REGISTERED, "profile.vatRegistered": false });
  assert.equal((await svc.Reg.stateOn(new Date())).registered, false, "deregistered, with the number still on file");
  await profile({ ...REGISTERED, "profile.vatRegisteredFrom": dayPlus(10) });
  assert.equal((await svc.Reg.stateOn(new Date())).registered, false, "before the registration date");
  assert.equal((await svc.Reg.stateOn(new Date(Date.now() + 11 * 86400e3))).registered, true, "from the registration date on");
});

test("not registered: a sale carries no VAT whatever the form sent, and says so on the document", { skip }, async () => {
  await profile();
  const t = await sell([L(10, 100, { taxCodeId: std._id, vatPercent: 5 })], { charges: [{ description: "Courier", amount: 40, vatPercent: 5 }] });
  assert.equal(t.pricing.lineVat, 0);
  assert.equal(t.pricing.chargesVat, 0);
  assert.equal(r2(t.totalAmount), 1040, "1,000 of goods and 40 of courier, nothing more");
  assert.equal(t.items[0].taxKind, "out_of_scope");
  assert.equal(String(t.items[0].taxCodeId), String(outOfScope._id));
  assert.equal(t.vatRegistered, false);
  // and it posts no Output VAT
  const approved = await approve(t);
  assert.equal(approved.status, "APPROVED");
  const posted = await byAccount(t);
  assert.ok(!posted["Output VAT"], JSON.stringify(posted));
});

test("registered: the sale is priced and posted as it always was", { skip }, async () => {
  await profile(REGISTERED);
  const t = await sell([L(10, 100, { taxCodeId: std._id })]);
  assert.equal(r2(t.pricing.lineVat), 50);
  assert.equal(t.vatRegistered, true);
  await approve(t);
  assert.equal((await byAccount(t))["Output VAT"], -50);
});

test("a document dated before the registration date is not a registered one; one dated on it is", { skip }, async () => {
  await profile({ ...REGISTERED, "profile.vatRegisteredFrom": dayPlus(5) });
  const before = await sell([L(1, 100, { taxCodeId: std._id })], { date: new Date() });
  assert.equal(before.pricing.lineVat, 0);
  assert.equal(before.vatRegistered, false);
  const after = await sell([L(1, 100, { taxCodeId: std._id })], { date: new Date(Date.now() + 6 * 86400e3) });
  assert.equal(r2(after.pricing.lineVat), 5);
  assert.equal(after.vatRegistered, true);
});

test("not registered: a purchase keeps the supplier's VAT, but it is part of the cost and no Input VAT is posted", { skip }, async () => {
  await profile();
  const t = await buy([L(10, 100, { taxCodeId: std._id })]);
  assert.equal(r2(t.pricing.lineVat), 50, "the supplier did charge it, and the vendor is owed it");
  assert.equal(r2(t.totalAmount), 1050);
  assert.equal(t.vatRegistered, false);
  await approve(t);
  const posted = await byAccount(t);
  assert.ok(!posted["Input VAT"], "nothing to claim back: " + JSON.stringify(posted));
  assert.equal(posted[INVENTORY], 1050, "the goods cost what was paid, VAT included: " + JSON.stringify(posted));
  assert.equal(Object.values(posted).reduce((s, v) => r2(s + v), 0), 0, "and the entry balances");
  // earlier tests sold rice that was never bought, so the item's running average is not this purchase alone: read the purchase's own movement
  const movement = await svc.Movement.findOne({ referenceId: t._id, eventType: "PURCHASE_RECEIVE" }).lean();
  assert.equal(r2(movement.totalValue), 1050, "the stock came in at what it cost, VAT included");
  assert.equal(r2(movement.totalValue / movement.quantity), 105);
});

test("registered: a purchase claims its VAT back as it always did", { skip }, async () => {
  await profile(REGISTERED);
  const t = await buy([L(10, 100, { taxCodeId: std._id })]);
  assert.equal(t.vatRegistered, true);
  await approve(t);
  const posted = await byAccount(t);
  assert.equal(posted["Input VAT"], 50);
  assert.equal(posted[INVENTORY], 1000, JSON.stringify(posted));
});

test("a document saved before the rule (no stamp) posts exactly as it did, even if the company is not registered now", { skip }, async () => {
  await profile(REGISTERED);
  const t = await buy([L(2, 100, { taxCodeId: std._id })]);
  await svc.Transaction.updateOne({ _id: t._id }, { $unset: { vatRegistered: "" } }); // as a document from before this release
  await profile(); // and the organisation is not registered today
  await approve(t);
  assert.equal((await byAccount(t))["Input VAT"], 10);
});

test("a body cannot choose the stamp", { skip }, async () => {
  await profile();
  const t = await buy([L(1, 100, { taxCodeId: std._id })]);
  assert.equal(t.vatRegistered, false);
  const updated = await svc.Tx.updateTransaction(t._id, { vatRegistered: true, notes: "x" }, "tester");
  assert.equal(updated.vatRegistered, false);
});

test("an expense and a supplier's debit note: the VAT is cost when not registered, Input VAT when registered", { skip }, async () => {
  const fuel = await svc.LedgerAccount.findOne({ accountType: "expense" }).lean();
  const cash = { PaymentModeService: svc.PaymentMode };
  await profile();
  const plain = await svc.Voucher.processExpense({ expenseAccountId: fuel._id, amount: 100, taxCodeId: std._id, description: "Fuel", paymentMode: "cash" }, null, cash);
  assert.equal(plain.totalAmount, 105);
  assert.equal(plain.entries.length, 2, "the expense and the cash, no Input VAT");
  assert.equal(plain.entries[0].debitAmount, 105);
  await profile(REGISTERED);
  const claimed = await svc.Voucher.processExpense({ expenseAccountId: fuel._id, amount: 100, taxCodeId: std._id, description: "Fuel", paymentMode: "cash" }, null, cash);
  assert.equal(claimed.entries.length, 3);
  assert.equal(claimed.entries[0].debitAmount, 100);

  const note = (extra) => svc.Voucher.processNote({ partyId: vendor._id, partyType: "Vendor", lines: [{ accountId: fuel._id, amount: 100, taxCodeId: std._id }], ...extra }, null, { voucherType: "debit_note" });
  assert.equal((await note()).entries.length, 3, "registered: the party, the line and the VAT");
  await profile();
  const folded = await note();
  assert.equal(folded.entries.length, 2);
  assert.equal(folded.entries[1].creditAmount, 105, "the supplier's VAT goes back with the line");
  const toCustomer = await svc.Voucher.processNote({ partyId: customer._id, partyType: "Customer", lines: [{ accountId: fuel._id, amount: 100, taxCodeId: std._id }] }, null, { voucherType: "credit_note" });
  assert.equal(toCustomer.vatTotal, 0, "a credit note to a customer carries no VAT");
});

test("the VAT return exists only for a registered organisation", { skip }, async () => {
  const run = async () => {
    let result = "passed";
    await svc.Gate.requireFeature("vatReturn")({ organisation: { planCode: "internal", country: "AE" } }, {}, (err) => { if (err) result = err.code; });
    return result;
  };
  await profile();
  assert.equal(await run(), "VAT_NOT_REGISTERED");
  await profile(REGISTERED);
  assert.equal(await run(), "passed");
});

test("another country is not governed: nothing forced, nothing stamped", { skip }, async () => {
  const rule = require("../../utils/vatRegistration");
  assert.deepEqual(rule.stateOn({}, "IN", "2026-11-01"), { governs: false, registered: true });
  assert.deepEqual(rule.stateOn({}, "AE", "2026-11-01"), { governs: true, registered: false });
});
