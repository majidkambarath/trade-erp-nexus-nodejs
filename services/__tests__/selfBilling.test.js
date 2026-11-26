// Self-billed tax invoices (VAT Executive Regulation Art. 59(9), 60(4)): who may raise one, its number, and what
// follows it. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/selfBilling.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_sb_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);

let svc;
let vendor;
let stock;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Config: require("../financial/accountConfigService"),
    VendorService: require("../vendor/vendorService"),
    Vat: require("../reports/vatReturnService"),
    Faf: require("../reports/ftaAuditFileService"),
    Transaction: require("../../models/modules/transactionModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Issued: require("../../models/modules/financial/issuedNumberModel"),
    Stock: require("../../models/modules/stockModel"),
    UOM: require("../../models/modules/uomModel"),
  };
  require("../../models/core/organisationModel");
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  vendor = await svc.VendorService.createVendor({ vendorName: "Desert Farm", contactPerson: "x", address: "Al Ain", trnNO: "100555444300003" });
  stock = await svc.Stock.create({ itemId: "DATE", sku: "DATE", itemName: "Dates", category: new mongoose.Types.ObjectId() });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const bill = (extra = {}) => svc.Tx.createTransaction(
  { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: stock._id, description: "Dates", qty: 10, price: 20, rate: 20, vatPercent: 5 }], ...extra },
  "tester"
);
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");

test("it is refused without our tax number, without an agreement, and before the agreement starts", { skip }, async () => {
  await assert.rejects(bill({ selfBilled: true }), (e) => e.code === "SELF_BILLING_RECIPIENT_NOT_REGISTERED");
  await svc.Settings.updateOne({}, { $set: { "profile.trn": "100123456700003", "profile.legalName": "Harbour Trading" } });
  await assert.rejects(bill({ selfBilled: true }), (e) => e.code === "SELF_BILLING_NOT_AGREED" && /Desert Farm/.test(e.message));
  await assert.rejects(svc.VendorService.updateVendor(vendor._id, { selfBilling: { agreed: true, from: orgDay() } }), (e) => e.code === "INVALID_SELF_BILLING");
  await svc.VendorService.updateVendor(vendor._id, { selfBilling: { agreed: true, agreementRef: "SBA-2026-7", from: orgDay(30) } });
  await assert.rejects(bill({ selfBilled: true }), (e) => e.code === "SELF_BILLING_BEFORE_AGREEMENT");
  await svc.VendorService.updateVendor(vendor._id, { selfBilling: { agreed: true, agreementRef: "SBA-2026-7", from: orgDay(-30) } });
  assert.equal((await svc.VendorService.updateVendor(vendor._id, { contactPerson: "y" })).selfBilling.agreed, true, "an edit that names none keeps it");
  // only a purchase can be raised by the buyer
  const buyer = await mongoose.model("Customer").create({ customerId: "CUST-SB", customerName: "Buyer" });
  await assert.rejects(
    bill({ type: "sales_order", partyId: buyer._id, partyType: "Customer", partyTypeRef: "Customer", selfBilled: true }),
    (e) => e.code === "SELF_BILLING_PURCHASES_ONLY",
  );
});

test("its own number is taken on approval, never from a request, and an ordinary bill has none", { skip }, async () => {
  const plain = await approve(await bill());
  assert.equal(plain.selfBilledNo, undefined);
  const draft = await bill({ selfBilled: true, selfBilledNo: "SBI-9999" });
  assert.equal(draft.selfBilled, true);
  assert.equal(draft.selfBilledNo, undefined, "a draft has no number yet");
  const first = await approve(draft);
  assert.match(first.selfBilledNo, /^SBI-\d{4}-0001$/);
  assert.equal(first.selfBillingRef, "SBA-2026-7", "the agreement is kept on the document");
  const second = await approve(await bill({ selfBilled: true }));
  assert.match(second.selfBilledNo, /0002$/);
  // a draft may be switched on and off before it counts
  const toggled = await bill();
  await svc.Tx.updateTransaction(toggled._id, { selfBilled: true }, "tester");
  assert.equal((await svc.Transaction.findById(toggled._id)).selfBilled, true);
  await svc.Tx.updateTransaction(toggled._id, { selfBilled: false, selfBilledNo: "SBI-1" }, "tester");
  const off = await approve(await svc.Transaction.findById(toggled._id));
  assert.equal(off.selfBilledNo, undefined);
});

test("a return of a self-billed invoice is our credit note; the audit file carries our number; a deleted one stays used", { skip }, async () => {
  const invoice = await approve(await bill({ selfBilled: true }));
  const returned = await svc.Tx.createTransaction({
    type: "purchase_return", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", returnOf: { transactionId: invoice._id, transactionNo: invoice.transactionNo },
    items: [{ itemId: stock._id, description: "Dates", qty: 2, price: 20, rate: 20, vatPercent: 5 }],
  }, "tester");
  assert.equal(returned.selfBilled, true);
  const note = await approve(returned);
  assert.match(note.selfBilledNo, /^SBC-\d{4}-0001$/);
  assert.equal(note.selfBilledAgainst, invoice.selfBilledNo);
  const listed = await svc.Tx.getAllTransactions({ type: "purchase_return" });
  const rows = listed.transactions || listed.data || listed;
  assert.ok(rows.some((r) => r.selfBilledAgainst === invoice.selfBilledNo && r.selfBillingRef === "SBA-2026-7"), "the list carries what the paper prints");

  await svc.Settings.updateOne({}, { $set: { "profile.trn": "100123456700003" } });
  const file = await svc.Faf.generate({ from: orgDay(-1), to: orgDay(1) });
  assert.ok(file.text.includes(`,${invoice.selfBilledNo},`), "our tax invoice number in the purchase listing");
  assert.ok(file.text.includes(`,${note.selfBilledNo},`));

  // an approved note is cancelled, not deleted: it keeps its number, which is never given again
  await svc.Tx.deleteTransaction(note._id, "tester");
  const kept = await svc.Transaction.findById(note._id).lean();
  assert.equal(kept.status, "CANCELLED");
  assert.equal(kept.selfBilledNo, note.selfBilledNo);
  const again = await approve(await svc.Tx.createTransaction({
    type: "purchase_return", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", returnOf: { transactionId: invoice._id, transactionNo: invoice.transactionNo },
    items: [{ itemId: stock._id, description: "Dates", qty: 1, price: 20, rate: 20, vatPercent: 5 }],
  }, "tester"));
  assert.match(again.selfBilledNo, /0002$/, "never the deleted number again");
});

test("an agreement withdrawn stops a draft invoice, while a return is booked as an ordinary one", { skip }, async () => {
  const bought = await approve(await bill({ selfBilled: true }));
  const back = (qty) => svc.Tx.createTransaction({
    type: "purchase_return", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", returnOf: { transactionId: bought._id, transactionNo: bought.transactionNo },
    items: [{ itemId: stock._id, description: "Dates", qty, price: 20, rate: 20, vatPercent: 5 }],
  }, "tester");
  const draftReturn = await back(1);
  assert.equal(draftReturn.selfBilled, true);
  const draft = await bill({ selfBilled: true });
  await svc.VendorService.updateVendor(vendor._id, { selfBilling: { agreed: false } });
  await assert.rejects(approve(draft), (e) => e.code === "SELF_BILLING_NOT_AGREED");
  assert.equal((await svc.Transaction.findById(draft._id)).status, "DRAFT");

  await approve(draftReturn);
  const booked = await svc.Transaction.findById(draftReturn._id).lean();
  assert.equal(booked.status, "APPROVED");
  assert.ok(!booked.selfBilled);
  assert.equal(booked.selfBilledNo, undefined);
  assert.ok(!(await back(1)).selfBilled, "a new return after it ended is the supplier's to credit");
});
