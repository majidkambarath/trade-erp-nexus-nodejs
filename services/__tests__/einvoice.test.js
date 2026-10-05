// The e-invoice pipeline against a throwaway database, using the built-in sandbox provider.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { hmac } = require("../../utils/secretBox");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let svc;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    EI: require("../einvoice/einvoiceService"),
    Inbound: require("../einvoice/inboundService"),
    Models: require("../../models/modules/einvoiceModels"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Audit: require("../core/auditService"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let stock, std, vendor;
const customerData = (name, over = {}) => ({
  customerId: name, customerName: name, contactPerson: "x", trnNumber: "100999888700003",
  billingAddress: "Deira, Dubai", eInvoice: { participantId: "0235:100999888700003", city: "Dubai", countryCode: "AE" }, ...over,
});
const sell = async (customer, qty = 10, extra = {}) => {
  const t = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
      items: [{ itemId: stock._id, description: "Rice", qty, price: 100, rate: 100, taxCodeId: std._id, ...extra }] }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return t;
};
const ready = {
  profile: { legalName: "Harbour Trading LLC", trn: "100123456700003", addressLine1: "Al Quoz", city: "Dubai", emirate: "Dubai" },
};

test("setup: stock, tax code, purchase", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003", participantId: "0235:100555444300003" });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  std = await svc.TaxCode.findOne({ kind: "standard" });
  const buy = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
      items: [{ itemId: stock._id, description: "Rice", qty: 500, price: 50, rate: 50, vatPercent: 5 }] }, "tester");
  await svc.Tx.processTransaction(buy._id, "approve", "tester");
});

test("it cannot be enabled until the company is ready", { skip }, async () => {
  const before = await svc.EI.readiness();
  assert.equal(before.ready, false);
  assert.ok(before.seller.some((c) => c.key === "trn" && !c.ok));
  await assert.rejects(() => svc.EI.updateSettings({ enabled: true }), { code: "EINVOICE_NOT_READY" });

  await svc.Config.updateSettings(ready);
  await assert.rejects(() => svc.Config.updateSettings({ profile: { trn: "123" } }), { code: "INVALID_TRN" });
  await assert.rejects(() => svc.EI.updateSettings({ participantId: "nope" }), { code: "INVALID_PARTICIPANT_ID" });
  await svc.EI.updateSettings({ participantId: "0235:100123456700003" });
  assert.equal((await svc.EI.readiness()).ready, true);

  const s = await svc.EI.updateSettings({ enabled: true, provider: "sandbox" });
  assert.equal(s.enabled, true);
  assert.equal(s.connected, false, "no access point is connected");
  // live use and other providers are not available yet
  await assert.rejects(() => svc.EI.updateSettings({ environment: "production" }), { code: "PROVIDER_NOT_AVAILABLE" });
  await assert.rejects(() => svc.EI.updateSettings({ provider: "http" }), { code: "PROVIDER_NOT_AVAILABLE" });
});

test("the webhook secret is stored encrypted and never returned", { skip }, async () => {
  const s = await svc.EI.updateSettings({ webhookSecret: "whsec-abc" });
  assert.equal(s.hasWebhookSecret, true);
  assert.equal(JSON.stringify(s).includes("whsec-abc"), false);
  const raw = await svc.Models.EInvoiceSettings.findOne().select("+webhookSecretEnc").lean();
  assert.match(raw.webhookSecretEnc, /^v1:/);
  assert.ok(!raw.webhookSecretEnc.includes("whsec-abc"));
  assert.equal(require("../../utils/secretBox").decrypt(raw.webhookSecretEnc), "whsec-abc");
  assert.equal(JSON.stringify(await svc.EI.getSettings()).includes("whsec-abc"), false);
  assert.ok(!("apiKeyEnc" in raw) && !("endpointUrl" in raw), "no third-party endpoint or key is stored");
});

test("a ready invoice is sent, stored as sent, and moves to reported on successive checks", { skip }, async () => {
  const c = await svc.Customer.create(customerData("Al Noor"));
  const t = await sell(c);
  const preview = await svc.EI.preview(t._id);
  assert.equal(preview.ready, true);
  assert.equal(preview.payload.payableAmount, 1050);

  const { submission, alreadySubmitted } = await svc.EI.submit(t._id);
  assert.equal(alreadySubmitted, false);
  assert.equal(submission.status, "SUBMITTED");
  assert.match(submission.providerEntryId, /^SBX-/);
  assert.equal(submission.payload.sellerVatTrn, "100123456700003", "the payload is kept as sent");
  assert.ok(submission.payloadHash);

  const a = await svc.EI.refresh(submission._id);
  assert.equal(a.status, "ACKNOWLEDGED");
  const r = await svc.EI.refresh(submission._id);
  assert.equal(r.status, "REPORTED");
  assert.equal(r.taxStatus, "REPORTING_CONFIRMED");
  assert.deepEqual(r.history.map((h) => h.status), ["QUEUED", "SUBMITTED", "ACKNOWLEDGED", "REPORTED"]);
  // a reported invoice does not move again
  assert.equal((await svc.EI.refresh(submission._id)).status, "REPORTED");
});

test("overlapping refreshes (the background poll and a user's click) record each step once", { skip }, async () => {
  const c = await svc.Customer.create(customerData("Overlap Co"));
  const t = await sell(c);
  const { submission } = await svc.EI.submit(t._id);
  await Promise.all([1, 2, 3, 4, 5].map(() => svc.EI.refresh(submission._id)));
  for (let i = 0; i < 3; i++) await svc.EI.refresh(submission._id); // settle if the overlap stopped short
  const done = await svc.EI.refresh(submission._id);
  assert.equal(done.status, "REPORTED");
  const seen = done.history.map((h) => h.status);
  assert.deepEqual(seen, ["QUEUED", "SUBMITTED", "ACKNOWLEDGED", "REPORTED"], "no step is written twice");
  assert.ok(done.acknowledgedAt && done.reportedAt);
});

test("sending the same invoice twice - even at once - creates one submission", { skip }, async () => {
  const c = await svc.Customer.create(customerData("Twice"));
  const t = await sell(c);
  const [a, b, d] = await Promise.all([svc.EI.submit(t._id), svc.EI.submit(t._id), svc.EI.submit(t._id)]);
  assert.equal(await svc.Models.EInvoiceSubmission.countDocuments({ sourceId: t._id }), 1);
  assert.equal([a, b, d].filter((x) => !x.alreadySubmitted).length, 1, "exactly one caller did the sending");
  assert.equal((await svc.EI.submit(t._id)).alreadySubmitted, true);
});

test("an invoice with missing customer details is refused with the exact problems, then sent once fixed", { skip }, async () => {
  const c = await svc.Customer.create(customerData("Incomplete", { billingAddress: "", eInvoice: { countryCode: "AE" } }));
  const t = await sell(c);
  await assert.rejects(() => svc.EI.submit(t._id), (e) => {
    assert.equal(e.code, "EINVOICE_VALIDATION");
    const fields = e.details.issues.map((i) => i.field);
    for (const f of ["buyerAddressLine1", "buyerCity", "customerParticipantId"]) assert.ok(fields.includes(f), f);
    return true;
  });
  assert.equal(await svc.Models.EInvoiceSubmission.countDocuments({ sourceId: t._id }), 0, "nothing was recorded or sent");

  const rd = await svc.EI.readiness();
  assert.ok(rd.parties.notReady.some((p) => p.customerName === "Incomplete" && p.missing.includes("City")));
  const fixed = await svc.EI.updateParty(c._id, { billingAddress: "Karama", city: "Dubai", participantId: "0235:100999888700003" });
  assert.equal(fixed.ready, true);
  assert.equal((await svc.EI.submit(t._id)).submission.status, "SUBMITTED");
});

test("a temporary failure is retried; a refused payload waits for a person", { skip }, async () => {
  const flaky = await svc.Customer.create(customerData("NETFAIL Traders"));
  const t = await sell(flaky);
  const { submission } = await svc.EI.submit(t._id);
  assert.equal(submission.status, "FAILED");
  assert.equal(submission.retryable, true);
  assert.ok(submission.nextRetryAt > new Date(), "a retry is scheduled");
  assert.equal(submission.attempts, 1);

  // the worker leaves it alone until its time, then retries it
  assert.equal((await svc.EI.processDue(new Date())).retried, 0);
  const later = new Date(Date.now() + 3600 * 1000);
  const pass = await svc.EI.processDue(later);
  assert.equal(pass.retried, 1);
  assert.equal((await svc.Models.EInvoiceSubmission.findById(submission._id)).attempts, 2);

  const bad = await svc.Customer.create(customerData("BADREQ Ltd"));
  const t2 = await sell(bad);
  const { submission: s2 } = await svc.EI.submit(t2._id);
  assert.equal(s2.status, "FAILED");
  assert.equal(s2.retryable, false);
  assert.equal(s2.nextRetryAt, null, "no automatic retry for a payload the provider refused");
  await svc.EI.processDue(later); // other failed invoices may be due; this one must not be
  assert.equal((await svc.Models.EInvoiceSubmission.findById(s2._id)).attempts, 1, "not retried automatically");
  // renaming the customer is a correction; a manual retry sends it
  await svc.Customer.updateOne({ _id: bad._id }, { customerName: "Good Ltd" });
  const retried = await svc.EI.retry(s2._id);
  assert.equal(retried.status, "SUBMITTED");
});

test("a downstream rejection is final and cannot be retried", { skip }, async () => {
  const c = await svc.Customer.create(customerData("REJECT Me"));
  const t = await sell(c);
  const { submission } = await svc.EI.submit(t._id);
  const r = await svc.EI.refresh(submission._id);
  assert.equal(r.status, "REJECTED");
  assert.ok(r.lastError);
  await assert.rejects(() => svc.EI.retry(submission._id), { code: "INVALID_TRANSITION" });
});

test("credit notes: need the original invoice; a linked return is sent as type 381", { skip }, async () => {
  const c = await svc.Customer.create(customerData("Credit Co"));
  const sale = await sell(c);
  const unlinked = await svc.Tx.createTransaction(
    { type: "sales_return", partyId: c._id, partyType: "Customer", partyTypeRef: "Customer",
      items: [{ itemId: stock._id, description: "Rice", qty: 1, price: 100, rate: 100, taxCodeId: std._id }] }, "tester");
  await svc.Tx.processTransaction(unlinked._id, "approve", "tester");
  await assert.rejects(() => svc.EI.submit(unlinked._id), (e) => e.details.issues.some((i) => i.field === "invoiceRef"));

  const linked = await svc.Tx.createTransaction(
    { type: "sales_return", partyId: c._id, partyType: "Customer", partyTypeRef: "Customer", returnOf: { transactionId: sale._id },
      items: [{ itemId: stock._id, description: "Rice", qty: 2, price: 100, rate: 100, taxCodeId: std._id, returnOfLineId: sale.items[0]._id }] }, "tester");
  await svc.Tx.processTransaction(linked._id, "approve", "tester");
  const { submission } = await svc.EI.submit(linked._id);
  assert.equal(submission.invoiceTypeCode, "381");
  assert.equal(submission.payload.invoiceRef, sale.transactionNo);
});

test("only approved sales documents are eligible", { skip }, async () => {
  const c = await svc.Customer.create(customerData("Draft Co"));
  const draft = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: c._id, partyType: "Customer", partyTypeRef: "Customer",
      items: [{ itemId: stock._id, description: "Rice", qty: 1, price: 100, rate: 100, taxCodeId: std._id }] }, "tester");
  await assert.rejects(() => svc.EI.submit(draft._id), { code: "NOT_APPROVED" });
  const buy = await svc.Transaction.findOne({ type: "purchase_order" });
  await assert.rejects(() => svc.EI.submit(buy._id), { code: "NOT_ELIGIBLE" });
});

test("the dashboard counts what happened", { skip }, async () => {
  const d = await svc.EI.dashboard();
  assert.ok(d.outbound.total >= 6);
  assert.ok(d.outbound.byStatus.REPORTED >= 1);
  assert.ok(d.outbound.needsAttention >= 2);
  assert.equal(typeof d.outbound.successRate, "number");
  assert.ok(d.recent.length > 0);
});

// ---- inbound ----
const inbound = (over = {}) => ({
  providerId: "IN-1", documentId: "SUP-9001", issueDate: "2026-10-01", sellerName: "Mill", sellerVatTrn: "100555444300003",
  sellerParticipantId: "0235:100555444300003", lineExtensionTotal: 1000, taxAmount: 50, payableAmount: 1050, lines: [{ lineNetAmount: 1000 }], ...over,
});

test("inbound: matched to the vendor and to the one purchase order with that amount", { skip }, async () => {
  const po = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
      items: [{ itemId: stock._id, description: "Rice", qty: 20, price: 50, rate: 50, vatPercent: 5 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester"); // 1050 incl. VAT

  const r = await svc.Inbound.ingest(inbound());
  assert.equal(r.duplicate, false);
  assert.equal(String(r.invoice.matchedVendorId), String(vendor._id));
  assert.equal(String(r.invoice.suggestedPurchaseOrderId), String(po._id));
  assert.match(r.invoice.matchNote, /by amount/);

  const again = await svc.Inbound.ingest(inbound());
  assert.equal(again.duplicate, true, "a repeated delivery is stored once");
  assert.equal(await svc.Models.InboundInvoice.countDocuments(), 1);

  const unknown = await svc.Inbound.ingest(inbound({ providerId: "IN-2", sellerVatTrn: "100000000000009", sellerParticipantId: undefined }));
  assert.equal(unknown.invoice.matchedVendorId, null);
  assert.match(unknown.invoice.matchNote, /No vendor matches/);

  const byRef = await svc.Inbound.ingest(inbound({ providerId: "IN-3", payableAmount: 777, invoiceRef: po.transactionNo }));
  assert.match(byRef.invoice.matchNote, /by reference/);
});

test("inbound: accept links the purchase order; reject needs a reason; a decision is final", { skip }, async () => {
  const inv = await svc.Models.InboundInvoice.findOne({ providerId: "IN-1" });
  await assert.rejects(() => svc.Inbound.decide(inv._id, "REJECTED", {}), { code: "REASON_REQUIRED" });
  const accepted = await svc.Inbound.decide(inv._id, "ACCEPTED", {});
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(String(accepted.purchaseOrderId), String(inv.suggestedPurchaseOrderId));
  await assert.rejects(() => svc.Inbound.decide(inv._id, "ACCEPTED", {}), { code: "ALREADY_DECIDED" });

  const other = await svc.Models.InboundInvoice.findOne({ providerId: "IN-2" });
  const rej = await svc.Inbound.decide(other._id, "REJECTED", { reason: "Unknown supplier" });
  assert.equal(rej.decision.reason, "Unknown supplier");
  const log = await svc.Audit.list(undefined, { entity: "InboundInvoice" });
  assert.ok(log.rows.some((x) => x.action === "INBOUND_EINVOICE_ACCEPTED"));
});

test("webhook: only a correctly signed body is accepted", { skip }, async () => {
  const { companyId } = require("../../utils/tenant").getTenant();
  const body = Buffer.from(JSON.stringify(inbound({ providerId: "IN-W" })));
  const good = hmac("whsec-abc", body);
  await svc.Inbound.verifyWebhook(body, good, companyId);
  await svc.Inbound.verifyWebhook(body, `sha256=${good}`, companyId);
  await assert.rejects(() => svc.Inbound.verifyWebhook(body, "0".repeat(64), companyId), { code: "INVALID_SIGNATURE" });
  await assert.rejects(() => svc.Inbound.verifyWebhook(body, undefined, companyId), { code: "INVALID_SIGNATURE" });
  await assert.rejects(() => svc.Inbound.verifyWebhook(Buffer.from("{}"), good, companyId), { code: "INVALID_SIGNATURE" }, "a tampered body");
});
