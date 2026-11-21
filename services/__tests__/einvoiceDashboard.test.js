// The e-invoicing dashboard, the server-side document filters, the Wafeq health / summary reads and the webhook clock.
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
const DB = `erp_test_wfd_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const XML = fs.readFileSync(path.join(__dirname, "..", "..", "utils", "__tests__", "fixtures", "ubl", "sandbox-invoice.xml"), "utf8");
const TAXPAYER = "txpay_unitDash1";
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

const dashOf = (q = {}) => svc.EI.dashboard(undefined, q);
const tile = (d, key) => d.todo.find((t) => t.key === key);

test("an approved invoice never sent is on the worklist, from the day e-invoicing was switched on", { skip }, async () => {
  const settings = await svc.EI.getSettings();
  assert.match(settings.startDate, /^\d{4}-\d{2}-\d{2}$/); // set when it was first enabled
  const tx = await sellInvoice();
  const d = await dashOf();
  assert.equal(tile(d, "notSent").count, 1);
  assert.ok(tile(d, "notSent").amount > 0);
  assert.equal(tile(d, "notSent").link, "/e-invoicing/outbound?status=NOT_SENT");
  assert.equal(d.sandbox, true);
  // a document dated before the start day is not expected to be e-invoiced
  await svc.Transaction.updateOne({ _id: tx._id }, { $set: { date: new Date("2020-01-01T00:00:00Z") } });
  assert.equal(tile(await dashOf(), "notSent").count, 0);
  await svc.Transaction.updateOne({ _id: tx._id }, { $set: { date: new Date() } });
});

test("a sent invoice and a failed one: two legs, totals by type, the worklist and attention", { skip }, async () => {
  wafeq();
  const a = await sellInvoice([line("RICE", 2, 50)]);
  const sa = (await svc.EI.submit(a._id, { admin: { id: "u" } })).submission;
  assert.ok(sa.issueDate, "the submission carries the invoice's own date");
  const b = await sellInvoice([line("SUGAR", 1, 30)]);
  const sb = (await svc.EI.submit(b._id, { admin: { id: "u" } })).submission;
  await svc.Models.EInvoiceSubmission.updateOne({ _id: sa._id }, { $set: { status: "ACKNOWLEDGED", deliveryStatus: "sent", taxStatus: "not_reported" } });
  await svc.Models.EInvoiceSubmission.updateOne({ _id: sb._id }, { $set: { status: "FAILED", lastError: "boom" } });
  const d = await dashOf();
  assert.equal(d.pipeline.delivery.delivered, 1);
  assert.equal(d.pipeline.fta.notReported, 1); // sandbox never reports: not a failure
  assert.equal(d.pipeline.fta.reported, 0);
  assert.equal(d.totals.invoices.count, 1);
  assert.equal(tile(d, "failed").count, 1);
  assert.equal(d.attention[0].action, "retry");
  assert.equal(d.attention[0].reason, "boom");
  assert.equal(d.recent.length >= 2, true);
  assert.equal(d.monthly.length, 6);
  assert.equal(d.monthly[5].sent, 1);
  assert.equal(d.topCustomers[0].name, "Buyer LLC");
});

test("a rejection by the buyer for BV is correctable, by the tax authority it is not", { skip }, async () => {
  const c = await sellInvoice([line("OIL", 1, 10)]);
  const sc = (await svc.EI.submit(c._id, { admin: { id: "u" } })).submission;
  await svc.Models.EInvoiceSubmission.updateOne({ _id: sc._id }, { $set: { status: "REJECTED", rejectedBy: "buyer", deliveryReasonCode: "BV" } });
  let d = await dashOf();
  assert.equal(tile(d, "rejectedByBuyer").count, 1);
  assert.equal(d.attention.find((x) => String(x._id) === String(sc._id)).action, "correct");
  await svc.Models.EInvoiceSubmission.updateOne({ _id: sc._id }, { $set: { rejectedBy: "fta" } });
  d = await dashOf();
  assert.equal(tile(d, "rejectedByFta").count, 1);
  assert.equal(d.attention.find((x) => String(x._id) === String(sc._id)).action, "credit_note");
});

test("the period is by the invoice's own date", { skip }, async () => {
  const d = await dashOf({ from: "2019-01-01", to: "2019-01-31" });
  assert.equal(d.totals.invoices.count, 0);
  assert.equal(d.pipeline.delivery.delivered, 0);
  await assert.rejects(() => dashOf({ from: "2026-02-01", to: "2026-01-01" }), /ends before/);
  await assert.rejects(() => dashOf({ from: "nope" }), /days/);
});

test("the status filter is decided by the database, not by the loaded page", { skip }, async () => {
  for (let i = 0; i < 4; i += 1) await sellInvoice([line("RICE", 1, 11 + i)]); // newer, unsent: they fill page one
  const failed = await svc.EI.documents(undefined, { status: "FAILED", limit: 2 });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, "FAILED");
  const unsent = await svc.EI.documents(undefined, { status: "NOT_SENT", limit: 100 });
  assert.ok(unsent.length >= 5 && unsent.every((r) => r.status === "NOT_SENT"));
  const credits = await svc.EI.documents(undefined, { kind: "381", limit: 100 });
  assert.ok(credits.every((r) => r.invoiceTypeCode === "381"));
});

test("an accepted supplier invoice not yet recorded as a purchase is listed by recorded=0", { skip }, async () => {
  wafeq({ inbound: [{ id: "inv_in9", direction: "inbound", invoice_number: "WQS-2026-0001" }] });
  await svc.Pull.pull("default", { force: true });
  const row = await svc.Models.InboundInvoice.findOne({});
  await svc.Models.InboundInvoice.updateOne({ _id: row._id }, { $set: { status: "ACCEPTED" } });
  assert.equal((await svc.Inbound.list(undefined, { status: "ACCEPTED", recorded: "0" })).total, 1);
  assert.equal(tile(await dashOf(), "inboundNotRecorded").count, 1);
  await svc.Models.InboundInvoice.updateOne({ _id: row._id }, { $set: { purchaseOrderId: new mongoose.Types.ObjectId() } });
  assert.equal((await svc.Inbound.list(undefined, { status: "ACCEPTED", recorded: "0" })).total, 0);
});

test("health compares Wafeq's profile with ours; summary puts Wafeq's count beside the ledger and survives Wafeq failing", { skip }, async () => {
  const Health = require("../einvoice/wafeq/healthService");
  Health.clearCache();
  wafeq();
  let h = await Health.health("default");
  assert.equal(h.connected, true);
  assert.equal(h.ok, false); // the fake's legal name is "Sandbox taxpayer 5504"; ours is Harbour Trading
  assert.ok(h.mismatches.some((m) => m.field === "Legal name"));
  const base = svc.Client._http;
  svc.Client.useHttp(async (url) => (url.includes("/reports/invoice-summary") ? { status: 200, body: { count: 9, totals_by_currency: [{ currency: "AED", count: 9, net: 1, tax: 0, gross: 1 }], by_status: [{ status: "delivered", count: 9 }], by_month: [] } } : { status: 404, body: {} }));
  Health.clearCache();
  const s = await Health.summary("default", {});
  assert.equal(s.outbound.count, 9);
  assert.equal(s.sandbox, true);
  svc.Client.useHttp(async () => ({ status: 500, body: {} }));
  Health.clearCache();
  const bad = await Health.summary("default", {});
  assert.equal(bad.outbound, null);
  assert.match(bad.note, /500/);
  svc.Client.useHttp(base || null);
});

test("a signed webhook records the last delivery time", { skip }, async () => {
  wafeq();
  await hook({ type: "taxpayer.updated", environment: "sandbox", data: { taxpayer_id: TAXPAYER } }, "evt_clock_1");
  const s = await svc.EI.getSettings();
  assert.ok(s.wafeq.lastWebhookAt);
});

test("the migration gives an earlier submission its issue date, once", { skip }, async () => {
  const { backfillEInvoiceIssueDates } = require("../../utils/migrations");
  const row = await svc.Models.EInvoiceSubmission.findOne({});
  await svc.Models.EInvoiceSubmission.collection.updateOne({ _id: row._id }, { $unset: { issueDate: "" }, $set: { "payload.issueDate": "2026-03-04" } });
  assert.equal(await backfillEInvoiceIssueDates(), 1);
  const after = await svc.Models.EInvoiceSubmission.findById(row._id).lean();
  assert.equal(after.issueDate.toISOString().slice(0, 10), "2026-03-04");
  assert.equal(await backfillEInvoiceIssueDates(), 0);
});
