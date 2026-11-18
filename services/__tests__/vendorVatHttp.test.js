// Approving a purchase bill that charges tax from a supplier who is not registered for it is asked about (409 RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED, the
// credit warning's answer with its own field) and goes through once acknowledged - never refused. Against a strict server with real sign-ins.
//
//   node --require ./utils/testSetup.js --test services/__tests__/vendorVatHttp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./support/httpHarness");

process.env.VENDOR_VAT_WARNING = "on"; // testSetup switches it off for the older suites; this one is about it (the spawned server inherits it)
const skip = H.skipReason?.() || (!process.env.MONGO_URI && "MONGO_URI not set");
const ORG = "vendvat";
const FIELD = "riskAck_unregistered_vendor_vat";

let stack, call, token, item, unregistered, registered, noVatCode;
const api = (method, url, body) => call(method, url, { token, body });

test.before(async () => {
  if (skip) return;
  stack = await H.startStack("vendvat");
  call = H.makeCaller(stack.base);
  const Admin = require("../../models/core/adminModel");
  await stack.Org.create({ legalName: "Vendor Vat Test", code: ORG, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  await stack.as(ORG, () => new Admin({ name: "owner", email: "owner@vv.test", password: H.PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  const r = await call("POST", "/login", { body: { email: "owner@vv.test", password: H.PASSWORD } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  token = r.body.tokens.accessToken;
  const Vendor = require("../../models/modules/vendorModel");
  const Category = require("../../models/modules/categoryModel");
  const Stock = require("../../models/modules/stockModel");
  const TaxCode = require("../../models/modules/financial/taxCodeModel");
  unregistered = await stack.as(ORG, () => Vendor.create({ vendorId: "V1", vendorName: "Al Noor Trading", address: "Dubai", paymentTerms: "Cash", vat: { status: "unregistered" } }));
  registered = await stack.as(ORG, () => Vendor.create({ vendorId: "V2", vendorName: "Gulf Mills", address: "Dubai", paymentTerms: "Cash", vat: { status: "registered", trn: "100123456700003" } }));
  const category = await stack.as(ORG, () => Category.create({ name: "General" }));
  item = await stack.as(ORG, () => Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: category._id }));
  noVatCode = await stack.as(ORG, () => TaxCode.findOne({ kind: "zero_rated" }).lean());
});

test.after(async () => {
  if (skip) return;
  await stack?.stop();
});

const bill = async (vendor, line = {}) => {
  const r = await api("POST", "/transactions/transactions", {
    type: "purchase_order", partyId: String(vendor._id), partyType: "Vendor", partyTypeRef: "Vendor",
    items: [{ itemId: String(item._id), description: "Rice", qty: 10, price: 100, rate: 100, vatPercent: 5, ...line }],
  });
  assert.equal(r.status, 201, r.text.slice(0, 300));
  return r.body;
};
const approve = (id, extra = {}) => api("PATCH", `/transactions/transactions/${id}/process`, { action: "approve", ...extra });

test("a bill with tax from an unregistered supplier asks first, then goes through once acknowledged", { skip }, async () => {
  const t = await bill(unregistered);
  const asked = await approve(t._id);
  assert.equal(asked.status, 409, asked.text.slice(0, 300));
  assert.equal(asked.code, "RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED");
  assert.equal(asked.data.details.risk.acknowledgementField, FIELD);
  assert.equal(asked.data.details.risk.title, "VAT warning");
  assert.match(asked.data.message, /Al Noor Trading is not registered for VAT/);
  assert.match(asked.data.message, /VAT of AED 50\.00/);
  const still = await api("GET", `/transactions/transactions/${t._id}`);
  assert.equal(still.body.transaction.status, "DRAFT", "nothing was approved or posted");

  const done = await approve(t._id, { [FIELD]: true });
  assert.equal(done.status, 200, done.text.slice(0, 300));
  const after = await api("GET", `/transactions/transactions/${t._id}`);
  assert.equal(after.body.transaction.status, "APPROVED");
  const audit = await api("GET", `/transactions/transactions/${t._id}/audit`);
  assert.match(JSON.stringify(audit.body), /VENDOR_VAT_WARNING_ACKNOWLEDGED/, "the acknowledgement is in the trail");
});

test("a registered supplier, or a bill with no tax, is approved without a question", { skip }, async () => {
  const fine = await bill(registered);
  assert.equal((await approve(fine._id)).status, 200);
  const noTax = await bill(unregistered, { taxCodeId: String(noVatCode._id), vatPercent: 0 });
  const r = await approve(noTax._id);
  assert.equal(r.status, 200, r.text.slice(0, 300));
});

test("the credit-limit acknowledgement does not acknowledge this warning, and this one does not acknowledge that", { skip }, async () => {
  const t = await bill(unregistered);
  const wrong = await approve(t._id, { riskAck_limit_party_credit: true }); // (the owner may use it; it is simply the wrong field for a bill)
  assert.equal(wrong.status, 409, "the credit acknowledgement acknowledges nothing here: " + wrong.text.slice(0, 200));
  assert.equal(wrong.data.details.risk.acknowledgementField, FIELD);
  const right = await approve(t._id, { [FIELD]: true });
  assert.equal(right.status, 200);
});
