const test = require("node:test");
const assert = require("node:assert/strict");
const ei = require("../eInvoice");
const { toWafeqDocument, wafeqTotals, emirateCode } = require("../wafeqPayload");

const seller = { legalName: "Seller LLC", trn: "100123456700003", addressLine1: "Office 1", city: "Dubai", countryCode: "AE" };
const customer = { customerName: "Buyer LLC", trnNumber: "199920000000003", billingAddress: "1 Sheikh Zayed Road", eInvoice: { city: "Dubai", countryCode: "AE", participantId: "0235:1999200000" } };
const item = (o = {}) => ({ description: "Consulting", qty: 1, price: 1000, taxableAmount: 1000, vatAmount: 50, vatPercent: 5, taxKind: "standard", itemType: "service", ...o });
const tx = (items, o = {}) => ({ transactionNo: "SO-2026-0001", type: "sales_order", date: new Date("2026-11-20T08:00:00Z"), items, charges: [], ...o });
const flat = (t, c = customer) => ei.buildPayload({ transaction: t, customer: c, seller, sellerParticipantId: "0235:1716865504" });
const ctx = { dueDate: "2026-12-20", sourceId: "abc", buyer: { emirate: "Dubai" } };

test("emirate names and codes map to codes", () => {
  assert.equal(emirateCode("Dubai"), "DXB");
  assert.equal(emirateCode("ras al  khaimah"), "RAK");
  assert.equal(emirateCode("UAQ"), "UAQ");
  assert.equal(emirateCode("Atlantis"), "");
});

test("a plain invoice maps to the body Wafeq accepted in the sandbox", () => {
  const r = toWafeqDocument(flat(tx([item()])), ctx);
  assert.equal(r.path, "/invoices");
  assert.deepEqual(r.issues, []);
  assert.equal(r.body.invoice_number, "SO-2026-0001");
  assert.equal(r.body.due_date, "2026-12-20");
  assert.deepEqual(r.body.customer, {
    name: "Buyer LLC", vat_number: "199920000000003", id: "0235:1999200000",
    address: { street: "1 Sheikh Zayed Road", city: "Dubai", country: "AE", country_subentity: "DXB" },
  });
  assert.deepEqual(r.body.line_items, [{ description: "Consulting", quantity: 1, unit_price: 1000, tax_category: "S", tax_percent: 5 }]);
  assert.equal("seller" in r.body, false);
});

test("a zero-rated line sends an explicit tax_percent of 0", () => {
  const r = toWafeqDocument(flat(tx([item({ taxKind: "zero_rated", vatPercent: 0, vatAmount: 0 })])), ctx);
  assert.equal(r.body.line_items[0].tax_category, "Z");
  assert.equal(r.body.line_items[0].tax_percent, 0);
});

test("an exempt line needs a reason code, and an exempt-only document becomes a commercial one", () => {
  const t = tx([item({ taxKind: "exempt", vatPercent: 0, vatAmount: 0 })]);
  assert.match(toWafeqDocument(flat(t), ctx).issues[0].message, /exemption reason/);
  const ok = toWafeqDocument(flat(t), { ...ctx, reasons: ["DL8.46.2"] });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.body.line_items[0].tax_exemption_reason_code, "DL8.46.2");
  assert.equal(ok.body.document_type_code, "480");
});

test("an out-of-scope line defaults to the documented reason code", () => {
  const r = toWafeqDocument(flat(tx([item({ taxKind: "out_of_scope", vatPercent: 0, vatAmount: 0 })])), ctx);
  assert.equal(r.body.line_items[0].tax_exemption_reason_code, "VATEX-AE-OOS");
});

test("a UAE buyer with no emirate is refused locally", () => {
  const r = toWafeqDocument(flat(tx([item()])), { ...ctx, buyer: {} });
  assert.ok(r.issues.some((i) => i.field === "buyerEmirate"));
});

test("a buyer with no TRN needs an identifier and then carries no Peppol id", () => {
  const walkIn = { customerName: "Walk-in", billingAddress: "Shop 1", eInvoice: { city: "Dubai", countryCode: "AE" } };
  assert.ok(toWafeqDocument(flat(tx([item()]), walkIn), ctx).issues.some((i) => i.field === "buyerIdentifier"));
  const r = toWafeqDocument(flat(tx([item()]), walkIn), { ...ctx, buyer: { emirate: "Dubai", identifier: "CN-2233445" } });
  assert.deepEqual(r.issues, []);
  assert.equal(r.body.customer.identifier, "CN-2233445");
  assert.equal("id" in r.body.customer, false);
  assert.equal("vat_number" in r.body.customer, false);
});

test("a credit note references an invoice Wafeq holds, or one from outside", () => {
  const credit = tx([item()], { type: "sales_return", returnOf: { transactionNo: "SO-2026-0001" }, transactionNo: "SR-2026-0001" });
  const ap = toWafeqDocument(flat(credit), { ...ctx, original: { wafeqDocumentId: "inv_abc" } });
  assert.equal(ap.path, "/credit-notes");
  assert.equal(ap.body.credit_note_number, "SR-2026-0001");
  assert.equal(ap.body.previous_document_id, "inv_abc");
  assert.equal(ap.body.previous_invoice_source, "ap");
  assert.equal("due_date" in ap.body, false);
  const ext = toWafeqDocument(flat(credit), { ...ctx, original: { number: "SO-2026-0001", issueDate: "2026-11-01" } });
  assert.equal(ext.body.previous_invoice_source, "external");
  assert.equal(ext.body.previous_invoice_number, "SO-2026-0001");
  assert.equal(ext.body.previous_invoice_issue_date, "2026-11-01");
});

test("Wafeq's totals are repeated: VAT once per category and rate", () => {
  const lines = [0.1, 0.1, 0.1].map((p) => ({ quantity: 1, unit_price: p, tax_category: "S", tax_percent: 5 }));
  assert.deepEqual(wafeqTotals(lines), { net: 0.3, tax: 0.02, total: 0.32 });
});

test("books that add VAT line by line are refused rather than sent with a different total", () => {
  const items = [0.1, 0.1, 0.1].map((p) => item({ price: p, taxableAmount: p, vatAmount: 0.01 }));
  const r = toWafeqDocument(flat(tx(items)), ctx);
  assert.ok(r.issues.some((i) => i.field === "totals"));
});

test("an odd quantity x price pair is sent as one unit at the net", () => {
  const r = toWafeqDocument(flat(tx([item({ qty: 3, price: 33.333333, taxableAmount: 100, vatAmount: 5 })])), ctx);
  assert.equal(r.body.line_items[0].quantity, 1);
  assert.equal(r.body.line_items[0].unit_price, 100);
  assert.match(r.body.line_items[0].description, /\(3 EA\)/);
  assert.deepEqual(r.issues, []);
});

test("a reverse-charge line needs its goods type and GTIN", () => {
  const p = flat(tx([item({ taxKind: "reverse_charge", rcmVat: 50 })]));
  const r = toWafeqDocument(p, ctx);
  assert.equal(r.issues.filter((i) => /reverse-charge/.test(i.message)).length, 2);
});

test("a foreign-currency or round-off document is refused locally", () => {
  const p = flat(tx([item()]));
  assert.ok(toWafeqDocument({ ...p, documentCurrencyCode: "USD" }, ctx).issues.some((i) => i.field === "documentCurrencyCode"));
  assert.ok(toWafeqDocument({ ...p, roundingAmount: 0.02, payableAmount: p.payableAmount + 0.02 }, ctx).issues.some((i) => i.field === "roundingAmount"));
});
