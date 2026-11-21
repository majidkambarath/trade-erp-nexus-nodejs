// The ERP end of the Wafeq integration against a throwaway database: linking a business, the sandbox pricing rule, submitting a real invoice,
// status by polling and by signed webhook, and the one-taxpayer-one-organisation rule. The network function is replaced; nothing leaves the machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
process.env.WAFEQ_API_KEY_TEST = "pk_test_unit";
process.env.WAFEQ_CLIENT_ID_TEST = "client-unit";
process.env.WAFEQ_CLIENT_SECRET_TEST = "secret-unit";
process.env.WAFEQ_WEBHOOK_SECRET_TEST = "whsec_" + Buffer.from("unit-test-webhook-signing-secret!").toString("base64");
process.env.PUBLIC_APP_URL = "https://app.example.test";
const mongoose = require("mongoose");
const { sign } = require("../../utils/standardWebhooks");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_wfq_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
let svc;
const TAXPAYER = "txpay_unitTaxpayer1";
const PROFILE = { participant_id: "0235:1716865504", tin: "1716865504", profile: { legal_name: "Sandbox taxpayer 5504", vat_number: "171686550400003" } };

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
    Client: require("../einvoice/wafeq/client").WafeqClient,
    Models: require("../../models/modules/einvoiceModels"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Tenant: require("../../utils/tenantContext"),
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

// the fake Wafeq: answers by address, records what it was sent
let sent;
let docs; // document_id -> the fields a GET returns
const wafeq = () => {
  sent = [];
  docs = {};
  svc.Client.useHttp(async (url, o = {}) => {
    const u = new URL(url);
    sent.push({ method: o.method || "GET", path: u.pathname.replace("/ae/v1", ""), headers: o.headers, body: o.body && String(o.body).startsWith("{") ? JSON.parse(o.body) : o.body });
    const p = u.pathname.replace("/ae/v1", "");
    if (p === "/settings/profile") return o.headers?.["x-ae-taxpayer-id"] === "txpay_missing" ? { status: 404, body: { detail: "Unknown taxpayer" } } : { status: 200, body: PROFILE };
    if (p.endsWith("/oauth/token")) return { status: 200, body: { taxpayer_id: TAXPAYER, grant_id: "tgr_unit1", tin: "1716865504", taxpayer_name: "Sandbox taxpayer 5504", access_token: "wat_x", refresh_token: "wrt_x" } };
    if (p.endsWith("/taxpayer-registration")) return { status: 200, body: { taxpayer_registered: true } };
    if (p.endsWith("/validate")) return { status: 200, body: { valid: true, route: "delivery", effective_recipient_id: "0235:100999888700003", errors: [], warnings: [] } };
    if (p === "/invoices" && o.method === "POST") { docs.inv_unit1 = { status: "delivered", delivery_status: "sent", tdd_status: "not_reported" }; return { status: 202, body: { success: true, status: "queued", document_id: "inv_unit1", delivery_job_id: "djob_1" } }; }
    if (p === "/credit-notes" && o.method === "POST") return { status: 202, body: { success: true, status: "queued", document_id: "inv_cn1", delivery_job_id: "djob_2" } };
    const m = /^\/invoices\/(.+)$/.exec(p);
    if (m && docs[m[1]]) return { status: 200, body: docs[m[1]] };
    return { status: 404, body: { detail: "not found" } };
  });
};

let stock, std, customer;
const ready = { profile: { legalName: "Harbour Trading LLC", trn: "100123456700003", addressLine1: "Al Quoz", city: "Dubai", emirate: "Dubai" } };
const sell = async (items, extra = {}) => {
  const t = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
      items: items.map((price) => ({ itemId: stock._id, description: "Rice", qty: 1, price, rate: price, taxCodeId: std._id })), ...extra }, "tester");
  return t;
};

test("setup: stock, tax code, customer, a purchase to sell from", { skip }, async () => {
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003" });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  std = await svc.TaxCode.findOne({ kind: "standard" });
  customer = await svc.Customer.create({
    customerId: "C1", customerName: "Buyer LLC", contactPerson: "x", trnNumber: "100999888700003", billingAddress: "Deira, Dubai",
    emirate: "Dubai", country: "AE", eInvoice: { participantId: "0235:100999888700003", city: "Dubai", countryCode: "AE" },
  });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: stock._id, description: "Rice", qty: 500, price: 50, rate: 50, vatPercent: 5 }] }, "tester");
  await svc.Tx.processTransaction(buy._id, "approve", "tester");
  await svc.Config.updateSettings(ready);
});

test("before Wafeq, VAT is added line by line as always", { skip }, async () => {
  const t = await sell([0.1, 0.1, 0.1]);
  assert.equal(t.pricing.lineVat, 0.03);
});

test("the console link checks the taxpayer with Wafeq and takes the Peppol id from it", { skip }, async () => {
  wafeq();
  const r = await svc.Connect.linkDirect("default", { mode: "sandbox", taxpayerId: TAXPAYER, grantId: "tgr_unit1" }, "dev@platform");
  assert.equal(r.participantId, "0235:1716865504");
  assert.equal(sent[0].path, "/settings/profile");
  assert.equal(sent[0].headers["x-ae-taxpayer-id"], TAXPAYER);
  const s = await svc.EI.updateSettings({ enabled: true });
  assert.equal(s.connected, true);
  assert.equal(s.provider, "wafeq");
  assert.equal(s.participantId, "0235:1716865504");
});

test("a bad taxpayer id and a taxpayer Wafeq does not know are refused", { skip }, async () => {
  wafeq();
  await assert.rejects(() => svc.Connect.linkDirect("default", { mode: "sandbox", taxpayerId: "nope" }, "d"), { code: "INVALID_TAXPAYER_ID" });
  await assert.rejects(() => svc.Connect.linkDirect("default", { mode: "sandbox", taxpayerId: "txpay_missing" }, "d"), { code: "WAFEQ_TAXPAYER_UNKNOWN" });
  await assert.rejects(() => svc.Connect.linkDirect("default", { mode: "live", taxpayerId: TAXPAYER }, "d"), { code: "WAFEQ_NOT_CONFIGURED" });
});

test("one Wafeq taxpayer belongs to one organisation", { skip }, async () => {
  wafeq();
  await assert.rejects(() => svc.Connect.linkDirect("another-org", { mode: "sandbox", taxpayerId: TAXPAYER }, "d"), { code: "WAFEQ_TAXPAYER_IN_USE" });
});

test("with Wafeq connected, VAT is rounded once per rate and no round-off is kept", { skip }, async () => {
  const t = await sell([0.1, 0.1, 0.1], { totalAmount: 0.33 });
  assert.equal(t.pricing.lineVat, 0.02);
  assert.equal(t.pricing.roundOff, 0);
  assert.equal(t.totalAmount, 0.32);
});

test("an approved invoice is previewed with Wafeq's own validation, then sent, and Wafeq's id is kept", { skip }, async () => {
  wafeq();
  const t = await sell([100, 50]);
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  const pv = await svc.EI.preview(t._id, {});
  assert.deepEqual(pv.issues, []);
  assert.equal(pv.wafeq.checked, true);
  assert.equal(pv.wafeq.route, "delivery");
  assert.equal(pv.payload.wafeq.body.customer.address.country_subentity, "DXB");

  const { submission, alreadySubmitted } = await svc.EI.submit(t._id, { admin: { id: "u1" } });
  assert.equal(alreadySubmitted, false);
  assert.equal(submission.status, "SUBMITTED");
  assert.equal(submission.providerEntryId, "inv_unit1");
  assert.equal(submission.deliveryJobId, "djob_1");
  assert.equal(submission.providerMode, "sandbox");
  const post = sent.find((s) => s.method === "POST" && s.path === "/invoices");
  assert.equal(post.headers["Idempotency-Key"].startsWith(String(submission._id)), true);
  assert.equal(post.body.line_items.length, 2);
  assert.equal("seller" in post.body, false);

  // pressing it again sends nothing
  const again = await svc.EI.submit(t._id, { admin: { id: "u1" } });
  assert.equal(again.alreadySubmitted, true);
  assert.equal(sent.filter((s) => s.method === "POST" && s.path === "/invoices").length, 1);

  // polling: delivered in the sandbox is ACKNOWLEDGED and says the FTA was not told
  const polled = await svc.EI.refresh(submission._id, {});
  assert.equal(polled.status, "ACKNOWLEDGED");
  assert.equal(polled.deliveryStatus, "sent");
  assert.equal(polled.taxStatus, "not_reported");
});

const post = (event, { id = "msg_1", secret = process.env.WAFEQ_WEBHOOK_SECRET_TEST, tamper = false } = {}) => {
  const raw = JSON.stringify(event);
  const ts = String(Math.floor(Date.now() / 1000));
  return svc.Hook.handle({
    mode: "test", rawBody: tamper ? raw.replace("inv_unit1", "inv_other") : raw,
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sign(secret, id, ts, raw)}` }, body: JSON.parse(raw),
  });
};
const reported = { id: "evt_1", type: "document.reported", environment: "sandbox", data: { document_id: "inv_unit1", taxpayer_id: TAXPAYER, delivery_status: "delivered_confirmed", tax_authority_status: "REPORTED" } };

test("a signed webhook moves the invoice to REPORTED once; a retry does nothing", { skip }, async () => {
  const before = await svc.Models.EInvoiceSubmission.findOne({ providerEntryId: "inv_unit1" });
  assert.equal(before.status, "ACKNOWLEDGED");
  const r = await post(reported, { id: "msg_a" });
  assert.equal(r.result, "applied:REPORTED");
  const after = await svc.Models.EInvoiceSubmission.findOne({ providerEntryId: "inv_unit1" });
  assert.equal(after.status, "REPORTED");
  assert.equal(after.history.filter((h) => h.status === "REPORTED").length, 1);
  const dup = await post(reported, { id: "msg_a" });
  assert.equal(dup.duplicate, true);
  assert.equal((await svc.Models.EInvoiceSubmission.findOne({ providerEntryId: "inv_unit1" })).history.filter((h) => h.status === "REPORTED").length, 1);
});

test("a webhook with a wrong or missing signature is refused and recorded nowhere", { skip }, async () => {
  await assert.rejects(() => post({ ...reported, id: "evt_2" }, { id: "msg_b", secret: "whsec_" + Buffer.from("other").toString("base64") }), { code: "INVALID_SIGNATURE" });
  await assert.rejects(() => post({ ...reported, id: "evt_3" }, { id: "msg_c", tamper: true }), { code: "INVALID_SIGNATURE" });
  assert.equal(await svc.Models.WafeqEvent.countDocuments({ eventId: { $in: ["msg_b", "msg_c"] } }), 0);
});

test("a webhook for a taxpayer nobody linked is acknowledged and touches nothing", { skip }, async () => {
  const r = await post({ ...reported, data: { ...reported.data, taxpayer_id: "txpay_stranger" } }, { id: "msg_d" });
  assert.equal(r.result, "unknown_taxpayer");
});

test("an event from the other mode is ignored", { skip }, async () => {
  const r = await post({ ...reported, environment: "live" }, { id: "msg_e" });
  assert.equal(r.result, "wrong_environment");
});

test("a credit note references the Wafeq id of the invoice it credits", { skip }, async () => {
  wafeq();
  const inv = await svc.Models.EInvoiceSubmission.findOne({ providerEntryId: "inv_unit1" });
  const original = await svc.Tx.getTransactionById?.(inv.sourceId).catch(() => null);
  void original;
  const T = require("../../models/modules/transactionModel");
  const o = await T.findById(inv.sourceId).lean();
  const ret = await svc.Tx.createTransaction({
    type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
    returnOf: { transactionId: o._id, transactionNo: o.transactionNo },
    items: [{ itemId: stock._id, description: "Rice", qty: 1, price: 100, rate: 100, taxCodeId: std._id, returnOfLineId: o.items[0]._id }],
  }, "tester");
  await svc.Tx.processTransaction(ret._id, "approve", "tester");
  const pv = await svc.EI.preview(ret._id, {});
  assert.equal(pv.payload.wafeq.path, "/credit-notes");
  assert.equal(pv.payload.wafeq.body.previous_document_id, "inv_unit1");
  assert.equal(pv.payload.wafeq.body.previous_invoice_source, "ap");
});

test("Connect with Wafeq: start signs a state, finish trades the code and links the taxpayer", { skip }, async () => {
  wafeq();
  await svc.Connect.unlinkDirect("default");
  await svc.Models.EInvoiceSettings.updateOne({}, { $unset: { "wafeq.taxpayerId": "" } });
  await svc.Tenant.runWithTenant({ companyId: "default" }, async () => {
    const req = { admin: { id: "a1" } };
    const { url } = await svc.Connect.start({ mode: "sandbox" }, req);
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://einvoicing.wafeq.com/sandbox/oauth/authorize");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("redirect_uri"), "https://app.example.test/settings/einvoicing/wafeq/callback");
    assert.equal(u.searchParams.get("external_id"), "default");
    const state = u.searchParams.get("state");

    // forged, another person's, and a state that was never issued
    await assert.rejects(() => svc.Connect.finish({ code: "c", state: state + "x" }, req), { code: "WAFEQ_STATE_INVALID" });
    await assert.rejects(() => svc.Connect.finish({ code: "c", state }, { admin: { id: "someone-else" } }), { code: "WAFEQ_STATE_INVALID" });

    const done = await svc.Connect.finish({ code: "the-code", state }, req);
    assert.equal(done.connected, true);
    const tok = sent.find((s) => s.path.endsWith("/oauth/token"));
    assert.match(String(tok.body), /code_verifier=/);
    assert.match(String(tok.body), /code=the-code/);
    assert.match(tok.headers.Authorization, /^Basic /);
    // the same approval cannot be used twice
    await assert.rejects(() => svc.Connect.finish({ code: "the-code", state }, req), { code: "WAFEQ_STATE_INVALID" });

    const stored = await svc.Models.EInvoiceSettings.findOne({}).select("+wafeqPending").lean();
    assert.equal(stored.wafeq.linkedVia, "oauth");
    assert.equal(stored.wafeq.grantId, "tgr_unit1");
    assert.equal(stored.wafeqPending, undefined);
    assert.equal(JSON.stringify(stored).includes("wat_x"), false, "no token is stored");
  });
});

test("disconnecting returns the business to the built-in sandbox", { skip }, async () => {
  wafeq();
  await svc.Tenant.runWithTenant({ companyId: "default" }, async () => {
    const r = await svc.Connect.disconnect({ admin: { id: "a1" } });
    assert.equal(r.connected, false);
    const s = await svc.EI.getSettings({});
    assert.equal(s.provider, "sandbox");
    assert.equal(s.connected, false);
  });
});

test("secrets never appear in the settings answer", { skip }, async () => {
  const s = await svc.EI.getSettings({});
  const text = JSON.stringify(s);
  for (const secret of ["pk_test_unit", "secret-unit", "whsec_", "wat_x"]) assert.equal(text.includes(secret), false);
});
