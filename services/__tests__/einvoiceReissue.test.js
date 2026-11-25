// "Credit and re-issue": an approved invoice priced before 18 Nov 2026 took its whole-invoice discount off the total AFTER the tax, which an
// e-invoice cannot carry. EInvoiceService.reissue drafts a credit note that MIRRORS it and a new invoice that shares the discount over its
// lines; services/orderPurchase/reissueLinks.js keeps the three together. Against a throwaway database, with a fake Wafeq:
//   node --require ./utils/testSetup.js --test services/__tests__/einvoiceReissue.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
process.env.WAFEQ_API_KEY_TEST = "pk_test_unit";
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_rei_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const ADMIN = "507f1f77bcf86cd799439011";
const REQ = { admin: { id: ADMIN } };
let svc;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    EI: require("../einvoice/einvoiceService"),
    Crm: require("../crm/crmHooks"),
    Connect: require("../einvoice/wafeq/connectService"),
    Client: require("../einvoice/wafeq/client").WafeqClient,
    Models: require("../../models/modules/einvoiceModels"),
    Stock: require("../../models/modules/stockModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Ledger: require("../../models/modules/financial/financialModels").LedgerEntry,
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
    if (o.method === "POST") return { status: 202, body: { success: true, status: "queued", document_id: `inv_${Date.now()}_${Math.random()}`, delivery_job_id: "djob_x" } };
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
const get = (id) => svc.Transaction.findById(id).lean();
const approve = (id) => svc.Tx.processTransaction(id, "approve", ADMIN);
const approved = async (lines) => {
  const t = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: lines }, ADMIN);
  await approve(t._id);
  return get(t._id);
};
const lines = () => [
  { itemId: items.RICE._id, description: "Basmati Rice", qty: 4, price: 100, rate: 100, taxCodeId: std._id },
  { itemId: items.OIL._id, description: "Sunflower Oil", qty: 1, price: 120, rate: 120, taxCodeId: std._id },
];
// An invoice as one approved before 18 Nov 2026 stored it: the lines and their tax untouched, 10 taken off the total after the tax.
const legacyInvoice = async (extra = {}) => {
  const t = await approved(lines());
  assert.equal(t.totalAmount, 546);
  await svc.Transaction.updateOne({ _id: t._id }, { $set: { discount: 10, "pricing.headerDiscount": 10, "pricing.grandTotal": 536, totalAmount: 536, outstandingAmount: 536, ...extra }, $unset: { "pricing.headerDiscountSpread": "" } });
  return get(t._id);
};
const refused = async (fn, code) => {
  await assert.rejects(fn, (e) => { assert.equal(e.code ?? e.errorCode, code, e.message); return true; });
};
const stockOf = async () => Object.fromEntries((await svc.Stock.find({}).select("itemId currentStock").lean()).map((s) => [s.itemId, s.currentStock]));
const rowOf = async (no) => (await svc.EI.documents(undefined, { limit: 100 })).find((d) => d.transactionNo === no);
const pay = (invoice, amount) => svc.Financial.createVoucher({
  voucherType: "receipt", customerId: customer._id, totalAmount: amount, date: new Date(), paymentMode: "cash",
  linkedInvoices: [{ invoiceId: invoice._id, amount, balance: round2(invoice.outstandingAmount - amount) }],
}, ADMIN);

test("setup: items, a registered customer, Wafeq linked and e-invoicing on", { skip }, async () => {
  items = {};
  const category = new mongoose.Types.ObjectId();
  for (const [sku, name] of [["RICE", "Basmati Rice"], ["OIL", "Sunflower Oil"]]) items[sku] = await svc.Stock.create({ itemId: sku, sku, itemName: name, category });
  std = await svc.TaxCode.findOne({ kind: "standard" });
  const supplier = await svc.Vendor.create({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003" });
  customer = await svc.Customer.create({
    customerId: "C1", customerName: "Buyer LLC", contactPerson: "x", trnNumber: "100999888700003", billingAddress: "Deira", emirate: "Dubai", country: "AE",
    paymentTerms: "Net 30", eInvoice: { participantId: "0235:1009998887", city: "Dubai", countryCode: "AE" },
  });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: supplier._id, partyType: "Vendor", partyTypeRef: "Vendor", items: ["RICE", "OIL"].map((k) => ({ itemId: items[k]._id, description: k, qty: 500, price: 20, rate: 20, vatPercent: 5 })) }, ADMIN);
  await approve(buy._id);
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

test("credit and re-issue end to end: a mirror credit note, a correct new invoice, paper only, hidden from e-invoicing", { skip }, async () => {
  const tx = await legacyInvoice({ serialNo: "GA-77", docno: "D-1" });
  const stockBefore = await stockOf();
  const waiting = async () => (await svc.EI.dashboard(undefined, {})).todo.find((t) => t.key === "notSent").count;
  const waitingBefore = await waiting(); // the old invoice is among them
  const r = await svc.EI.reissue(tx._id, REQ);
  assert.equal(r.original, tx.transactionNo);
  let credit = await get(r.creditNote._id);
  let invoice = await get(r.invoice._id);

  // drafts only: nothing approved, nothing posted
  assert.equal(credit.status, "DRAFT");
  assert.equal(invoice.status, "DRAFT");
  // the credit note reverses the old invoice to the fils: net 520, VAT 26.00, 10 off after the tax, 536
  assert.equal(credit.type, "sales_return");
  assert.equal(credit.pricing.net, 520);
  assert.equal(vatOf(credit), 26);
  assert.equal(credit.pricing.headerDiscount, 10);
  assert.equal(credit.totalAmount, 536);
  // the new invoice: the same total, the discount shared over the lines, so the VAT is right (25.52)
  assert.equal(invoice.totalAmount, 536);
  assert.equal(vatOf(invoice), 25.52);
  assert.equal(invoice.pricing.headerDiscount, 0);
  assert.equal(invoice.pricing.headerDiscountSpread, 10);
  // across the three documents the VAT is what it should have been
  assert.equal(round2(vatOf(tx) - vatOf(credit) + vatOf(invoice)), 25.52);
  // carried over: the due date (Net 30 from the OLD invoice's day), the serial and document numbers
  assert.equal(new Date(invoice.dueDate).toISOString().slice(0, 10), new Date(new Date(tx.date).getTime() + 30 * 86400000).toISOString().slice(0, 10));
  assert.equal(invoice.serialNo, "GA-77");
  assert.equal(invoice.docno, "D-1");
  // the three know each other
  const old = await get(tx._id);
  assert.equal(old.reissue.role, "original");
  assert.equal(String(old.reissue.invoiceId), String(invoice._id));
  assert.equal(String(credit.reissue.invoiceId), String(invoice._id));
  assert.equal(String(invoice.reissue.creditNoteId), String(credit._id));

  // hidden from e-invoicing: the old invoice and the credit note read Replaced, are not waiting to be sent, and cannot be sent
  assert.equal((await rowOf(tx.transactionNo)).status, "REPLACED");
  assert.equal((await rowOf(tx.transactionNo)).replacedBy.invoiceNo, invoice.transactionNo);
  assert.ok(!(await svc.EI.documents(undefined, { status: "NOT_SENT", limit: 100 })).some((d) => d.transactionNo === tx.transactionNo));
  assert.ok((await svc.EI.documents(undefined, { status: "REPLACED", limit: 100 })).some((d) => d.transactionNo === tx.transactionNo));
  await refused(() => svc.EI.preview(tx._id, REQ), "REPLACED");

  // once only: the credit note waiting in Returns stands in the way of a second press
  await refused(() => svc.EI.reissue(tx._id, REQ), "ALREADY_CREDITED");
  // the new invoice waits for its credit note
  await refused(() => approve(invoice._id), "REISSUE_CREDIT_FIRST");

  await approve(credit._id);
  assert.equal((await rowOf(credit.transactionNo)).status, "REPLACED");
  await refused(() => svc.EI.submit(credit._id, REQ), "REPLACED");
  assert.equal(await waiting(), waitingBefore - 1, "the old invoice and its approved credit note are not waiting to be sent");
  await approve(invoice._id);
  assert.equal(await waiting(), waitingBefore, "only the new invoice is waiting to be sent in their place");

  // the customer owes 536, once
  assert.equal((await get(tx._id)).outstandingAmount, 0, "the old invoice is cancelled");
  invoice = await get(invoice._id);
  assert.equal(invoice.outstandingAmount, 536);
  // paper only: nothing moved in stock, no movement and no cost of goods for either document
  assert.deepEqual(await stockOf(), stockBefore);
  assert.equal(await svc.Movement.countDocuments({ referenceId: { $in: [credit._id, invoice._id] } }), 0);
  const cogs = await svc.Config.resolveAccount("cogs");
  assert.equal(await svc.Ledger.countDocuments({ voucherId: { $in: [credit._id, invoice._id] }, accountId: cogs }), 0);
  // an approved credit note is not undone under the approved new invoice
  await refused(() => svc.Tx.deleteTransaction(credit._id, ADMIN), "REISSUE_INVOICE_APPROVED");

  // and the new invoice is the one that is sent
  const p = await svc.EI.preview(invoice._id, REQ);
  assert.deepEqual(p.issues, []);
  const sent = await svc.EI.submit(invoice._id, REQ);
  assert.ok(sent.submission);
});

test("a payment on the old invoice follows the new one: paid in full owes nothing, part paid owes the rest", { skip }, async () => {
  for (const [paid, owed] of [[536, 0], [200, 336]]) {
    const tx = await legacyInvoice();
    await pay(tx, paid);
    assert.equal((await get(tx._id)).outstandingAmount, round2(536 - paid));
    const r = await svc.EI.reissue(tx._id, REQ);
    await approve(r.creditNote._id);
    await approve(r.invoice._id);
    assert.equal((await get(tx._id)).outstandingAmount, 0);
    const fresh = await get(r.invoice._id);
    assert.equal(fresh.outstandingAmount, owed, `paid ${paid}: the new invoice owes ${owed}`);
    assert.equal(fresh.reissue.appliedCredit, paid);
  }
});

test("the drafts keep their lines; breaking the pair puts the documents back", { skip }, async () => {
  const tx = await legacyInvoice();
  const r = await svc.EI.reissue(tx._id, REQ);
  const credit = await get(r.creditNote._id);
  // a line cannot be changed...
  await refused(() => svc.Tx.updateTransaction(credit._id, { items: [{ ...credit.items[0], qty: 1 }, credit.items[1]] }, ADMIN), "REISSUE_DRAFT_LOCKED");
  // ...but the words can, and the form's unchanged lines sent back with them are fine
  await svc.Tx.updateTransaction(credit._id, { items: credit.items, discount: 10, notes: "Checked by accounts" }, ADMIN);
  assert.equal((await get(credit._id)).notes, "Checked by accounts");
  assert.equal(vatOf(await get(credit._id)), 26, "still the mirror");
  // a body cannot forge or drop the link
  await svc.Tx.updateTransaction(r.invoice._id, { reissue: null, notes: "x" }, ADMIN);
  assert.equal((await get(r.invoice._id)).reissue.role, "invoice");
  const plain = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: lines() }, ADMIN);
  await svc.Tx.updateTransaction(plain._id, { reissue: { role: "credit" }, notes: "y" }, ADMIN);
  assert.equal((await get(plain._id)).reissue, undefined);

  // deleting the draft credit note breaks the pair: all three read as ordinary documents again
  await svc.Tx.deleteTransaction(credit._id, ADMIN);
  for (const id of [tx._id, r.invoice._id]) assert.equal((await get(id)).reissue, undefined);
  assert.equal((await rowOf(tx.transactionNo)).status, "NOT_SENT");

  // an approved new invoice deleted: what it took from the credit note is the customer's credit again, the old invoice stays cancelled
  const tx2 = await legacyInvoice();
  await pay(tx2, 536);
  const r2 = await svc.EI.reissue(tx2._id, REQ);
  await approve(r2.creditNote._id);
  await approve(r2.invoice._id);
  await svc.Tx.deleteTransaction(r2.invoice._id, ADMIN);
  const old2 = await get(tx2._id);
  assert.equal(old2.reissue.role, "original");
  assert.equal(old2.reissue.invoiceId, undefined);
  assert.equal((await rowOf(tx2.transactionNo)).status, "REPLACED", "cancelled by its approved credit note, still not to be sent");
  await svc.Tx.deleteTransaction(r2.creditNote._id, ADMIN); // with the new invoice gone it may be undone
  assert.equal((await get(tx2._id)).reissue, undefined);
});

test("the new invoice moves no CRM deal; the old one's own deal still follows it", { skip }, async () => {
  assert.equal(await svc.Crm.onSalesDocumentProcessed({ _id: new mongoose.Types.ObjectId(), type: "sales_order", status: "APPROVED", partyId: customer._id, reissue: { role: "invoice" } }), null);
  assert.equal(await svc.Crm.onSalesDocumentReversed({ _id: new mongoose.Types.ObjectId(), type: "sales_order", reissue: { role: "invoice" } }), null);
});

test("only for this one problem: other invoices are refused, and Credit in full still refuses an unsent one", { skip }, async () => {
  const returnsBefore = await svc.Transaction.countDocuments({ type: "sales_return" });
  const plain = await approved(lines());
  await refused(() => svc.EI.reissue(plain._id, REQ), "NOT_REISSUABLE");

  const draft = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: lines() }, ADMIN);
  await svc.Transaction.updateOne({ _id: draft._id }, { $set: { discount: 10, "pricing.headerDiscount": 10 } });
  await refused(() => svc.EI.reissue(draft._id, REQ), "NOT_REISSUABLE");

  const legacy = await legacyInvoice();
  await refused(() => svc.EI.creditInFull(legacy._id, REQ), "NOT_E_INVOICED");

  // one already on its way to Wafeq is credited the e-invoice way instead
  await svc.Models.EInvoiceSubmission.create({ companyId: "default", sourceType: "Transaction", sourceId: legacy._id, documentNo: legacy.transactionNo, invoiceTypeCode: "380", status: "SUBMITTED", payload: {}, payloadHash: "x" });
  await refused(() => svc.EI.reissue(legacy._id, REQ), "ALREADY_E_INVOICED");

  await refused(() => svc.EI.reissue("nope", REQ), undefined);
  assert.equal(await svc.Transaction.countDocuments({ type: "sales_return" }), returnsBefore, "no refusal drafted anything");
});
