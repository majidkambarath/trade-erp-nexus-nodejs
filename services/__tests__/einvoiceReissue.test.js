// "Credit and re-issue": an approved invoice priced before 18 Nov 2026 took its whole-invoice discount off the total AFTER the tax, which an
// e-invoice cannot carry. EInvoiceService.reissue drafts a credit note for it and a new invoice that shares the discount over its lines.
// Against a throwaway database, with a fake Wafeq:
//   node --require ./utils/testSetup.js --test services/__tests__/einvoiceReissue.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
process.env.WAFEQ_API_KEY_TEST = "pk_test_unit";
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_rei_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const REQ = { admin: { id: "507f1f77bcf86cd799439011" } };
let svc;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    EI: require("../einvoice/einvoiceService"),
    Connect: require("../einvoice/wafeq/connectService"),
    Client: require("../einvoice/wafeq/client").WafeqClient,
    Models: require("../../models/modules/einvoiceModels"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Transaction: require("../../models/modules/transactionModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  svc.Client.useHttp(async (url, o = {}) => {
    const p = new URL(url).pathname.replace("/ae/v1", "");
    if (p === "/settings/profile") return { status: 200, body: { participant_id: "0235:1716865504", tin: "1716865504", profile: { legal_name: "Sandbox taxpayer" } } };
    if (p.endsWith("/validate")) return { status: 200, body: { valid: true, route: "delivery", errors: [], warnings: [] } };
    if (o.method === "POST") return { status: 202, body: { success: true, status: "queued", document_id: `inv_${Date.now()}`, delivery_job_id: "djob_x" } };
    return { status: 404, body: { detail: "not found" } };
  });
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  svc.Client.useHttp(null);
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let std, customer, items;
const round2 = (n) => Math.round(n * 100) / 100;
const vatOf = (t) => round2((t.pricing?.lineVat || 0) + (t.pricing?.chargesVat || 0));
const approved = async (lines) => {
  const t = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: lines }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return svc.Transaction.findById(t._id).lean();
};
const lines = () => [
  { itemId: items.RICE._id, description: "Basmati Rice", qty: 4, price: 100, rate: 100, taxCodeId: std._id },
  { itemId: items.OIL._id, description: "Sunflower Oil", qty: 1, price: 120, rate: 120, taxCodeId: std._id },
];
// An invoice as one approved before 18 Nov 2026 stored it: the lines and their tax untouched, 10 taken off the total after the tax.
const legacyInvoice = async () => {
  const t = await approved(lines());
  assert.equal(t.totalAmount, 546);
  await svc.Transaction.updateOne({ _id: t._id }, { $set: { discount: 10, "pricing.headerDiscount": 10, "pricing.grandTotal": 536, totalAmount: 536, outstandingAmount: 536 }, $unset: { "pricing.headerDiscountSpread": "" } });
  return svc.Transaction.findById(t._id).lean();
};
const refused = async (fn, code) => {
  await assert.rejects(fn, (e) => { assert.equal(e.code ?? e.errorCode, code, e.message); return true; });
};

test("setup: items, a registered customer, Wafeq linked and e-invoicing on", { skip }, async () => {
  items = {};
  const category = new mongoose.Types.ObjectId();
  for (const [sku, name] of [["RICE", "Basmati Rice"], ["OIL", "Sunflower Oil"]]) items[sku] = await svc.Stock.create({ itemId: sku, sku, itemName: name, category });
  std = await svc.TaxCode.findOne({ kind: "standard" });
  const supplier = await svc.Vendor.create({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003" });
  customer = await svc.Customer.create({
    customerId: "C1", customerName: "Buyer LLC", contactPerson: "x", trnNumber: "100999888700003", billingAddress: "Deira", emirate: "Dubai", country: "AE",
    eInvoice: { participantId: "0235:1009998887", city: "Dubai", countryCode: "AE" },
  });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: supplier._id, partyType: "Vendor", partyTypeRef: "Vendor", items: ["RICE", "OIL"].map((k) => ({ itemId: items[k]._id, description: k, qty: 500, price: 20, rate: 20, vatPercent: 5 })) }, "tester");
  await svc.Tx.processTransaction(buy._id, "approve", "tester");
  await svc.Config.updateSettings({ profile: { legalName: "Harbour Trading LLC", trn: "100123456700003", addressLine1: "Al Quoz", city: "Dubai", emirate: "Dubai" } });
  await svc.Connect.linkDirect("default", { mode: "sandbox", taxpayerId: "txpay_unitReissue" }, "test");
  await svc.EI.updateSettings({ enabled: true });
});

test("the Review dialog says what to do: the amount and the re-issue action", { skip }, async () => {
  const tx = await legacyInvoice();
  const p = await svc.EI.preview(tx._id, REQ);
  assert.equal(p.ready, false);
  const issue = p.issues.find((i) => i.field === "headerDiscount");
  assert.ok(issue, "the old discount is named");
  assert.equal(issue.amount, 10);
  assert.equal(issue.action, "reissue");
  assert.match(issue.message, /10\.00 off its total after VAT/);
  assert.match(issue.message, /Credit and re-issue/);
});

test("credit and re-issue drafts a credit note and a new invoice; the customer ends up owing the same total once", { skip }, async () => {
  const tx = await legacyInvoice();
  const r = await svc.EI.reissue(tx._id, REQ);
  assert.equal(r.original, tx.transactionNo);

  const credit = await svc.Transaction.findById(r.creditNote._id).lean();
  const invoice = await svc.Transaction.findById(r.invoice._id).lean();
  // drafts only: nothing approved, nothing posted
  assert.equal(credit.status, "DRAFT");
  assert.equal(invoice.status, "DRAFT");
  assert.equal(credit.type, "sales_return");
  assert.equal(String(credit.returnOf.transactionId), String(tx._id));
  // the same total, with the discount now shared over the lines: the tax falls (26 -> 25.52) and no header discount remains
  assert.equal(invoice.totalAmount, 536);
  assert.equal(credit.totalAmount, 536);
  assert.ok(vatOf(invoice) < 26, `the new invoice's VAT ${vatOf(invoice)} is below the old 26`);
  assert.equal(vatOf(invoice), 25.52);
  assert.equal(invoice.pricing.headerDiscount, 0);
  assert.equal(invoice.pricing.headerDiscountSpread, 10);
  assert.equal(invoice.items.length, 2);
  assert.match(invoice.notes, new RegExp(`in place of ${tx.transactionNo}`));
  // it may be pressed only once: the credit note waiting in Returns stands in the way of a second
  await refused(() => svc.EI.reissue(tx._id, REQ), "ALREADY_CREDITED");
  assert.equal(await svc.Transaction.countDocuments({ "returnOf.transactionId": tx._id }), 1);

  // the person approves the credit note, then the new invoice
  await svc.Tx.processTransaction(credit._id, "approve", "tester");
  await svc.Tx.processTransaction(invoice._id, "approve", "tester");
  const old = await svc.Transaction.findById(tx._id).lean();
  const fresh = await svc.Transaction.findById(invoice._id).lean();
  assert.equal(old.outstandingAmount, 0, "the old invoice is credited in full");
  assert.equal(fresh.outstandingAmount, 536, "the customer owes 536, once");

  // and the new invoice is sendable
  const p = await svc.EI.preview(invoice._id, REQ);
  assert.deepEqual(p.issues, []);
  assert.equal(p.ready, true);
  const sent = await svc.EI.submit(invoice._id, REQ);
  assert.ok(sent.submission);
});

test("only for this one problem: other invoices are refused, and Credit in full still refuses an unsent one", { skip }, async () => {
  const plain = await approved(lines());
  await refused(() => svc.EI.reissue(plain._id, REQ), "NOT_REISSUABLE");

  const draft = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: lines() }, "tester");
  await svc.Transaction.updateOne({ _id: draft._id }, { $set: { discount: 10, "pricing.headerDiscount": 10 } });
  await refused(() => svc.EI.reissue(draft._id, REQ), "NOT_REISSUABLE");

  const legacy = await legacyInvoice();
  await refused(() => svc.EI.creditInFull(legacy._id, REQ), "NOT_E_INVOICED");

  // one already on its way to Wafeq is credited the e-invoice way instead
  await svc.Models.EInvoiceSubmission.create({ companyId: "default", sourceType: "Transaction", sourceId: legacy._id, documentNo: legacy.transactionNo, invoiceTypeCode: "380", status: "SUBMITTED", payload: {}, payloadHash: "x" });
  await refused(() => svc.EI.reissue(legacy._id, REQ), "ALREADY_E_INVOICED");

  await refused(() => svc.EI.reissue("nope", REQ), undefined);
  assert.equal(await svc.Transaction.countDocuments({ type: "sales_return" }), 1, "no refusal drafted anything");
});
