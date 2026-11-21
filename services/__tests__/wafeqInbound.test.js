// Received supplier invoices, fix-and-resend and credit-in-full through Wafeq, against a throwaway database and a fake Wafeq.
// The received invoice is the REAL XML the Wafeq sandbox produced (fixtures/ubl/sandbox-invoice.xml), whose seller is TRN 171686550400003.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
process.env.WAFEQ_API_KEY_TEST = "pk_test_unit";
process.env.WAFEQ_WEBHOOK_SECRET_TEST = "whsec_" + Buffer.from("unit-test-webhook-signing-secret!").toString("base64");
const mongoose = require("mongoose");
const { sign } = require("../../utils/standardWebhooks");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_wfi_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const XML = fs.readFileSync(path.join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "ubl", "sandbox-invoice.xml"), "utf8");
const TAXPAYER = "txpay_unitInbound1";
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
    Hook: require("../einvoice/wafeq/webhookService"),
    Pull: require("../einvoice/wafeq/inboundPull"),
    Inbound: require("../einvoice/inboundService"),
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
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  svc.Client.useHttp(null);
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// the fake Wafeq
let sent, state;
const wafeq = (over = {}) => {
  sent = [];
  state = { inbound: [], creditNotes: [], xmlStatus: 200, postAnswer: null, nextDoc: 1, ...over };
  svc.Client.useHttp(async (url, o = {}) => {
    const u = new URL(url);
    const p = u.pathname.replace("/ae/v1", "");
    const body = o.body && String(o.body).startsWith("{") ? JSON.parse(o.body) : o.body;
    sent.push({ method: o.method || "GET", path: p, query: u.search, headers: o.headers, body });
    if (p === "/settings/profile") return { status: 200, body: { participant_id: "0235:1716865504", tin: "1716865504", profile: { legal_name: "Sandbox taxpayer 5504" } } };
    if (p === "/invoices" && (o.method || "GET") === "GET") return { status: 200, body: { items: state.inbound } };
    if (p === "/credit-notes" && (o.method || "GET") === "GET") return { status: 200, body: { items: state.creditNotes } };
    if (p.endsWith("/xml")) return state.xmlStatus === 200 ? { status: 200, text: XML, body: null } : { status: state.xmlStatus, body: { detail: { code: "wallet_insufficient_funds" } } };
    if (p.endsWith("/validate")) return { status: 200, body: { valid: true, route: "delivery", errors: [], warnings: [] } };
    if ((p === "/invoices" || p === "/credit-notes") && o.method === "POST") {
      if (state.postAnswer) return state.postAnswer;
      return { status: 202, body: { success: true, status: "queued", document_id: `inv_out${state.nextDoc++}`, delivery_job_id: "djob_x" } };
    }
    return { status: 404, body: { detail: "not found" } };
  });
};

let std, customer, vendor, items;
const line = (sku, qty, price) => ({ itemId: items[sku]._id, description: items[sku].itemName, qty, price, rate: price, taxCodeId: std._id });
const sellInvoice = async (lines = [line("OIL", 4, 38)]) => {
  const t = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: lines }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return svc.Transaction.findById(t._id).lean();
};
const hook = (event, id) => {
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  const secret = process.env.WAFEQ_WEBHOOK_SECRET_TEST;
  return svc.Hook.handle({ mode: "test", rawBody: raw, headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sign(secret, id, ts, raw)}` }, body: event });
};
const submissionOf = (tx) => svc.Models.EInvoiceSubmission.findOne({ sourceId: tx._id });

test("setup: items, a customer, the sandbox supplier as a vendor, Wafeq linked and e-invoicing on", { skip }, async () => {
  wafeq();
  items = {};
  const category = new mongoose.Types.ObjectId();
  for (const [sku, name] of [["RICE", "Basmati Rice 25 kg"], ["OIL", "Sunflower Oil 5 L"], ["SUGAR", "White Sugar 10 kg"]]) {
    items[sku] = await svc.Stock.create({ itemId: sku, sku, itemName: name, category });
  }
  std = await svc.TaxCode.findOne({ kind: "standard" });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Sandbox Supplier", contactPerson: "x", address: "y", trnNO: "171686550400003", participantId: "0235:1716865504" });
  const buyer = await svc.Vendor.create({ vendorId: "V2", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003" });
  customer = await svc.Customer.create({
    customerId: "C1", customerName: "Buyer LLC", contactPerson: "x", trnNumber: "100999888700003", billingAddress: "Deira", emirate: "Dubai", country: "AE",
    eInvoice: { participantId: "0235:1009998887", city: "Dubai", countryCode: "AE" },
  });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: buyer._id, partyType: "Vendor", partyTypeRef: "Vendor", items: ["RICE", "OIL", "SUGAR"].map((k) => ({ itemId: items[k]._id, description: k, qty: 500, price: 20, rate: 20, vatPercent: 5 })) }, "tester");
  await svc.Tx.processTransaction(buy._id, "approve", "tester");
  await svc.Config.updateSettings({ profile: { legalName: "Harbour Trading LLC", trn: "100123456700003", addressLine1: "Al Quoz", city: "Dubai", emirate: "Dubai" } });
  await svc.Connect.linkDirect("default", { mode: "sandbox", taxpayerId: TAXPAYER }, "test");
  await svc.EI.updateSettings({ enabled: true });
});

test("pull stores a received invoice once, from its real XML, matched to the vendor", { skip }, async () => {
  wafeq({ inbound: [{ id: "inv_in1", direction: "inbound", invoice_number: "WQS-2026-0001" }] });
  const r = await svc.Pull.pull("default", { force: true });
  assert.deepEqual({ found: r.found, added: r.added, errors: r.errors }, { found: 1, added: 1, errors: [] });
  assert.ok(sent.some((s) => s.path === "/invoices" && /direction=inbound/.test(s.query)));
  assert.ok(sent.some((s) => s.path === "/credit-notes" && /direction=inbound/.test(s.query)));
  assert.ok(sent.some((s) => s.path === "/invoices/inv_in1/xml" && s.headers.Accept === "application/xml"));
  const inv = await svc.Models.InboundInvoice.findOne({ providerId: "inv_in1" }).select("+xml").lean();
  assert.equal(inv.documentId, "WQS-2026-0001");
  assert.equal(inv.source, "wafeq");
  assert.equal(inv.kind, "invoice");
  assert.equal(inv.totals.payable, 1726.2);
  assert.equal(inv.lines.length, 3);
  assert.equal(String(inv.matchedVendorId), String(vendor._id));
  assert.ok(inv.xml.includes("<cbc:ID>WQS-2026-0001</cbc:ID>"), "the XML is kept as received");
  // asking again stores nothing new
  const again = await svc.Pull.pull("default", { force: true });
  assert.equal(again.added, 0);
  // and a poll within ten minutes of the last one is skipped unless forced
  const quiet = await svc.Pull.pull("default");
  assert.equal(quiet.skipped, true);
});

test("when Wafeq document credits run out the document is not stored and the reason is kept", { skip }, async () => {
  wafeq({ inbound: [{ id: "inv_in2", direction: "inbound", invoice_number: "X-2" }], xmlStatus: 402 });
  const r = await svc.Pull.pull("default", { force: true });
  assert.equal(r.added, 0);
  assert.match(r.errors[0], /credits have run out/);
  assert.equal(await svc.Models.InboundInvoice.countDocuments({ providerId: "inv_in2" }), 0);
  const s = await svc.Models.EInvoiceSettings.findOne({}).lean();
  assert.match(s.wafeq.lastError, /credits/);
});

test("the document.received webhook pulls just that document", { skip }, async () => {
  wafeq();
  const r = await hook({ id: "evt_r1", type: "document.received", environment: "sandbox", data: { document_id: "inv_in3", taxpayer_id: TAXPAYER, invoice_number: "WQS-2026-0001" } }, "msg_r1");
  assert.equal(r.result, "received:added");
  assert.equal(await svc.Models.InboundInvoice.countDocuments({ providerId: "inv_in3" }), 1);
});

const picks = () => ({ lines: [{ itemId: String(items.RICE._id) }, { itemId: String(items.OIL._id) }, { itemId: String(items.SUGAR._id) }] });

test("record as purchase invoice: refuses without items, then makes a DRAFT whose total equals the supplier's", { skip }, async () => {
  const inv = await svc.Models.InboundInvoice.findOne({ providerId: "inv_in1" });
  await assert.rejects(() => svc.Inbound.recordAsPurchase(inv._id, {}, {}), { code: "ITEM_REQUIRED" });
  await assert.rejects(() => svc.Inbound.recordAsPurchase(inv._id, { lines: [{ itemId: String(items.RICE._id) }] }, {}), { code: "ITEM_REQUIRED" });
  const r = await svc.Inbound.recordAsPurchase(inv._id, picks(), { admin: { id: "u1" } });
  assert.equal(r.receivedTotal, 1726.2);
  assert.equal(r.total, 1726.2);
  assert.equal(r.difference, 0);
  const t = await svc.Transaction.findById(r.transactionId).lean();
  assert.equal(t.type, "purchase_order");
  assert.equal(t.status, "DRAFT", "never approved here");
  assert.equal(t.vendorReference, "WQS-2026-0001");
  assert.equal(String(t.partyId), String(vendor._id));
  assert.equal(t.items.length, 3);
  assert.equal(t.items[0].vatPercent, 5);
  const after = await svc.Models.InboundInvoice.findById(inv._id).lean();
  assert.equal(after.status, "ACCEPTED");
  assert.equal(String(after.purchaseOrderId), String(t._id));
  await assert.rejects(() => svc.Inbound.recordAsPurchase(inv._id, picks(), {}), { code: "ALREADY_DECIDED" });
});

test("the same supplier number is never recorded twice", { skip }, async () => {
  const dup = await svc.Models.InboundInvoice.findOne({ providerId: "inv_in3" });
  await assert.rejects(() => svc.Inbound.recordAsPurchase(dup._id, picks(), {}), { code: "DUPLICATE_SUPPLIER_INVOICE" });
});

test("a received credit note is decided, never recorded as a purchase invoice; an unmatched vendor is refused", { skip }, async () => {
  const cn = await svc.Models.InboundInvoice.create({ companyId: "default", providerId: "inv_cn1", documentId: "CN-1", kind: "credit_note", sellerName: "X", totals: { net: 1, tax: 0, payable: 1 }, lines: [{ itemName: "a", quantity: 1, lineNetAmount: 1 }], matchedVendorId: vendor._id });
  await assert.rejects(() => svc.Inbound.recordAsPurchase(cn._id, picks(), {}), { code: "INBOUND_IS_CREDIT_NOTE" });
  const lost = await svc.Models.InboundInvoice.create({ companyId: "default", providerId: "inv_x9", documentId: "X-9", sellerName: "Nobody", totals: { net: 1, tax: 0, payable: 1 }, lines: [{ itemName: "a", quantity: 1, lineNetAmount: 1 }] });
  await assert.rejects(() => svc.Inbound.recordAsPurchase(lost._id, picks(), {}), { code: "VENDOR_NOT_MATCHED" });
});

test("a line whose tax has no matching code is refused with the rate named", { skip }, async () => {
  const odd = await svc.Models.InboundInvoice.create({ companyId: "default", providerId: "inv_odd", documentId: "ODD-1", sellerName: "S", matchedVendorId: vendor._id, totals: { net: 100, tax: 12, payable: 112 }, lines: [{ itemName: "a", quantity: 1, lineNetAmount: 100, taxCategory: "S", taxRatePercent: 12 }] });
  await assert.rejects(() => svc.Inbound.recordAsPurchase(odd._id, { lines: [{ itemId: String(items.RICE._id) }] }, {}), (e) => e.code === "TAX_CODE_NOT_FOUND" && /12%/.test(e.message));
});

const rejection = (docId, extra, id) => hook({ id: `evt_${id}`, type: "document.status", environment: "sandbox", data: { document_id: docId, taxpayer_id: TAXPAYER, ...extra } }, `msg_${id}`);

test("fix and resend: a buyer's BV rejection is corrected with the same number, pointing at the rejected document", { skip }, async () => {
  wafeq();
  const tx = await sellInvoice();
  const first = (await svc.EI.submit(tx._id, { admin: { id: "u" } })).submission;
  assert.equal(first.providerEntryId, "inv_out1");
  await rejection("inv_out1", { delivery_status: "rejected", response_code: "RE", reason_code: "BV", reason_text: "Buyer TRN does not match" }, "bv");
  const rej = await submissionOf(tx);
  assert.equal(rej.status, "REJECTED");
  assert.equal(rej.rejectedBy, "buyer");
  assert.equal(rej.deliveryReasonCode, "BV");
  assert.match(rej.lastError || "", /./);

  // the customer is fixed, then the correction is sent
  await svc.Customer.updateOne({ _id: customer._id }, { $set: { billingAddress: "Deira, Dubai (corrected)" } });
  wafeq({ nextDoc: 2 });
  const fixed = await svc.EI.correct(rej._id, { admin: { id: "u" } });
  assert.equal(fixed.status, "SUBMITTED");
  assert.equal(fixed.providerEntryId, "inv_out2");
  assert.deepEqual([...fixed.previousEntryIds], ["inv_out1"]);
  const post = sent.find((s) => s.method === "POST" && s.path === "/invoices");
  assert.equal(post.body.invoice_number, tx.transactionNo, "the number is kept");
  assert.equal(post.body.corrects_document_id, "inv_out1");
  assert.match(post.body.customer.address.street, /corrected/);
  assert.notEqual(post.headers["Idempotency-Key"], first.payloadHash && `${first._id}:${first.payloadHash.slice(0, 16)}`, "a corrected body gets a new key");
  assert.equal(fixed.deliveryReasonCode, "BV"); // history of why stays on the record via history/previousEntryIds
});

test("a rejection by the tax authority, an FD rejection and a non-rejected invoice cannot be corrected", { skip }, async () => {
  wafeq();
  const a = await sellInvoice([line("RICE", 1, 95)]);
  const sa = (await svc.EI.submit(a._id, { admin: { id: "u" } })).submission;
  await assert.rejects(() => svc.EI.correct(sa._id, {}), { code: "NOT_CORRECTABLE" }); // not rejected
  await rejection(sa.providerEntryId, { tax_authority_status: "NOT_COMPLIANT" }, "fta");
  await assert.rejects(() => svc.EI.correct(sa._id, {}), (e) => e.code === "NOT_CORRECTABLE" && /tax authority/.test(e.message));

  const b = await sellInvoice([line("SUGAR", 1, 29.75)]);
  const sb = (await svc.EI.submit(b._id, { admin: { id: "u" } })).submission;
  await rejection(sb.providerEntryId, { delivery_status: "rejected", reason_code: "FD" }, "fd");
  await assert.rejects(() => svc.EI.correct(sb._id, {}), (e) => e.code === "NOT_CORRECTABLE" && /credit note/.test(e.message));
});

test("Wafeq still withdrawing the rejected invoice is retried with the same key; sandbox refusals are plain", { skip }, async () => {
  wafeq();
  const tx = await sellInvoice([line("OIL", 2, 38)]);
  const s = (await svc.EI.submit(tx._id, { admin: { id: "u" } })).submission;
  await rejection(s.providerEntryId, { delivery_status: "rejected", reason_code: "SV" }, "sv");
  const rej = await submissionOf(tx);

  state.postAnswer = { status: 409, body: { detail: { code: "correction_not_ready" } } };
  const waiting = await svc.EI.correct(rej._id, {});
  assert.equal(waiting.status, "FAILED");
  assert.equal(waiting.retryable, true);
  assert.ok(waiting.nextRetryAt, "it will be sent again by itself");

  // the retry is rejected? no: a FAILED invoice is retried by the background pass, with the unchanged body and so the same key
  state.postAnswer = { status: 403, body: { detail: { code: "sandbox_reporting_disabled" } } };
  const again = await svc.EI.retry(waiting._id, {});
  assert.equal(again.status, "FAILED");
  assert.equal(again.retryable, false);
  assert.match(again.lastError, /only possible in live mode/);
});

test("credit in full drafts a return for what is not yet credited, at the original prices and tax code", { skip }, async () => {
  wafeq();
  const tx = await sellInvoice([line("RICE", 3, 95), line("OIL", 2, 38)]);
  await assert.rejects(() => svc.EI.creditInFull(tx._id, {}), { code: "NOT_E_INVOICED" }); // not sent yet
  await svc.EI.submit(tx._id, { admin: { id: "u" } });

  // one unit credited by hand first: only the rest is drafted
  const orig = await svc.Transaction.findById(tx._id).lean();
  const partial = await svc.Tx.createTransaction({
    type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", returnOf: { transactionId: tx._id, transactionNo: tx.transactionNo },
    items: [{ itemId: items.RICE._id, description: "Rice", qty: 1, price: 95, rate: 95, taxCodeId: std._id, returnOfLineId: orig.items[0]._id }],
  }, "tester");
  await svc.Tx.processTransaction(partial._id, "approve", "tester");

  const r = await svc.EI.creditInFull(tx._id, { admin: { id: "u" } });
  const draft = await svc.Transaction.findById(r._id).lean();
  assert.equal(draft.type, "sales_return");
  assert.equal(draft.status, "DRAFT");
  assert.equal(String(draft.returnOf.transactionId), String(tx._id));
  assert.deepEqual(draft.items.map((i) => i.qty).sort(), [2, 2]);
  assert.equal(String(draft.items.find((i) => i.qty === 2 && i.price === 95).taxCodeId), String(std._id));

  // approved and everything credited: nothing left to credit
  await svc.Tx.processTransaction(draft._id, "approve", "tester");
  await assert.rejects(() => svc.EI.creditInFull(tx._id, {}), { code: "NOTHING_LEFT" });

  // and the credit note goes to Wafeq referencing the original by its Wafeq id
  const pv = await svc.EI.preview(draft._id, {});
  assert.equal(pv.payload.wafeq.body.previous_invoice_source, "ap");
  assert.match(pv.payload.wafeq.body.previous_document_id, /^inv_out/);
});
