const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPayload, validatePayload, partyReadiness, payloadHash, canTransition, taxCategoryFor, dubaiDate,
} = require("../eInvoice");

const seller = { legalName: "Harbour Trading LLC", trn: "100123456700003", addressLine1: "Al Quoz", city: "Dubai", countryCode: "AE" };
const customer = {
  customerName: "Al Noor Mart", trnNumber: "100999888700003", billingAddress: "Deira",
  eInvoice: { participantId: "0235:100999888700003", city: "Dubai", countryCode: "AE" },
};
const item = (over = {}) => ({
  description: "Basmati rice 5kg", itemCode: "RICE5", qty: 10, price: 100, discountAmount: 100, taxableAmount: 900,
  vatPercent: 5, vatAmount: 45, taxKind: "standard", lineTotal: 945, ...over,
});
const tx = (over = {}) => ({
  transactionNo: "SO-2026-0001", type: "sales_order", date: new Date("2026-10-04T10:00:00Z"),
  items: [item()], charges: [], pricing: { roundOff: 0 }, ...over,
});
const build = (t = tx(), c = customer) => buildPayload({ transaction: t, customer: c, seller, sellerParticipantId: "0235:100123456700003" });

test("a complete sale validates clean and totals reconcile", () => {
  const p = build();
  assert.equal(p.lineExtensionTotal, 900);
  assert.equal(p.taxAmount, 45);
  assert.equal(p.totalIncludingTax, 945);
  assert.equal(p.payableAmount, 945);
  assert.equal(p.invoiceTypeCode, "380");
  assert.deepEqual(p.taxBreakdown, [{ taxCategory: "S", taxRatePercent: 5, taxableAmount: 900, taxAmount: 45 }]);
  assert.deepEqual(validatePayload(p), []);
});

test("the issue date is the Dubai calendar date, not the UTC one", () => {
  // 21:30 UTC on 3 Oct is 01:30 on 4 Oct in Dubai
  assert.equal(dubaiDate("2026-10-03T21:30:00Z"), "2026-10-04");
  assert.equal(build(tx({ date: new Date("2026-10-03T21:30:00Z") })).issueDate, "2026-10-04");
});

test("freight becomes a service line with its own VAT; the breakdown groups by category and rate", () => {
  const p = build(tx({ charges: [{ code: "FRT", description: "Freight", amount: 40, vatPercent: 5, vatAmount: 2 }] }));
  assert.equal(p.lines.length, 2);
  assert.equal(p.lines[1].itemTypeGoodsServices, "S");
  assert.equal(p.lineExtensionTotal, 940);
  assert.equal(p.taxAmount, 47);
  assert.equal(p.taxBreakdown.length, 1);
  assert.equal(p.taxBreakdown[0].taxableAmount, 940);
  assert.deepEqual(validatePayload(p), []);
});

test("an unresolved tax category blocks the invoice instead of being sent as S/0%", () => {
  assert.equal(taxCategoryFor({ vatPercent: 0 }), "");
  const p = build(tx({ items: [item({ taxKind: null, vatPercent: 0, vatAmount: 0, taxableAmount: 900, lineTotal: 900 })] }));
  const issues = validatePayload(p);
  assert.ok(issues.some((i) => i.message === "E-Invoice tax category could not be resolved from the ERP VAT treatment."));
});

test("zero-rated and exempt lines carry their own categories", () => {
  const z = build(tx({ items: [item({ taxKind: "zero_rated", vatPercent: 0, vatAmount: 0, lineTotal: 900 })] }));
  assert.equal(z.lines[0].taxCategory, "Z");
  assert.deepEqual(validatePayload(z), []);
  assert.equal(build(tx({ items: [item({ taxKind: "exempt", vatPercent: 0, vatAmount: 0 })] })).lines[0].taxCategory, "E");
});

test("a standard-rated line with no rate is refused", () => {
  const p = build(tx({ items: [item({ taxKind: "standard", vatPercent: 0, vatAmount: 0, lineTotal: 900 })] }));
  assert.ok(validatePayload(p).some((i) => i.message === "Standard-rated E-Invoice line must have a VAT rate greater than 0."));
});

test("fractional unit prices fall back to priceBaseQty so quantity x price still equals the net", () => {
  // 3 units netting 10.00 -> 3.33 each would give 9.99
  const p = build(tx({ items: [item({ qty: 3, taxableAmount: 10, vatAmount: 0.5, vatPercent: 5, lineTotal: 10.5 })] }));
  assert.equal(p.lines[0].unitPrice, 10);
  assert.equal(p.lines[0].priceBaseQty, 3);
  assert.deepEqual(validatePayload(p), []);
});

test("a registered buyer must have every detail; an unregistered one need not", () => {
  const bare = { customerName: "Walk-in", trnNumber: "100999888700003", billingAddress: "", eInvoice: {} };
  const r = partyReadiness(bare);
  assert.equal(r.required, true);
  assert.ok(r.missing.includes("Address Line 1") && r.missing.includes("City") && r.missing.includes("Participant ID"));
  assert.equal(r.missing.includes("Party Name"), false);
  assert.equal(r.ready, false);

  assert.equal(partyReadiness({ customerName: "Cash customer" }).required, false, "no TRN, not required");
  assert.equal(partyReadiness({ customerName: "Export", trnNumber: "123", eInvoice: { countryCode: "SA" } }).required, false, "foreign buyer");
  assert.equal(partyReadiness(customer).ready, true);
  assert.ok(partyReadiness({ ...customer, trnNumber: "12345" }).problems.includes("VAT Number must be 15 digits"));
  assert.ok(partyReadiness({ ...customer, eInvoice: { ...customer.eInvoice, participantId: "abc" } }).problems.length);
});

test("validation names exactly what is missing", () => {
  const p = build(tx(), { customerName: "X", trnNumber: "100999888700003", billingAddress: "", eInvoice: {} });
  const fields = validatePayload(p).map((i) => i.field);
  for (const f of ["buyerAddressLine1", "buyerCity", "customerParticipantId"]) assert.ok(fields.includes(f), f);
});

test("a credit note needs the invoice it credits, and a header discount cannot be sent", () => {
  const cn = build(tx({ type: "sales_return" }));
  assert.equal(cn.invoiceTypeCode, "381");
  assert.ok(validatePayload(cn).some((i) => i.field === "invoiceRef"));
  const ok = build(tx({ type: "sales_return", returnOf: { transactionNo: "SO-2026-0001" } }));
  assert.deepEqual(validatePayload(ok), []);
  assert.ok(validatePayload(build(), { headerDiscount: 15 }).some((i) => i.field === "headerDiscount"));
});

test("tampered totals are caught", () => {
  const p = build();
  p.taxAmount = 44;
  const msgs = validatePayload(p).map((i) => i.message);
  assert.ok(msgs.includes("Tax Amount must equal the sum of line tax amounts."));
  const q = build();
  q.lines[0].lineNetAmount = 901;
  assert.ok(validatePayload(q).some((i) => /Line net amount must equal quantity/.test(i.message)));
});

test("the payload hash is stable and changes with the content", () => {
  const a = build(), b = build();
  assert.equal(payloadHash(a), payloadHash(b));
  b.lines[0].itemName = "Other";
  assert.notEqual(payloadHash(a), payloadHash(b));
  // key order does not matter
  assert.equal(payloadHash({ a: 1, b: 2 }), payloadHash({ b: 2, a: 1 }));
});

test("status machine: a rejected or reported invoice is final; a failed one can only be retried", () => {
  assert.ok(canTransition("QUEUED", "SUBMITTED"));
  assert.ok(canTransition("SUBMITTED", "ACKNOWLEDGED"));
  assert.ok(canTransition("ACKNOWLEDGED", "REPORTED"));
  assert.ok(canTransition("FAILED", "QUEUED"));
  assert.ok(!canTransition("FAILED", "SUBMITTED"));
  assert.ok(!canTransition("REJECTED", "QUEUED"));
  assert.ok(!canTransition("REPORTED", "FAILED"));
});

// ================================= reverse charge (the supplier's invoice) =================================
// A sale on which the customer accounts for the VAT carries NO VAT: category AE, tax 0 at a 0 rate. The line's stored vatPercent (5) is the
// rate the customer assesses at, not an invoice rate. Priced since reverse charge was posted, the line has an `rcmVat`.
test("a reverse-charge sale line goes out as category AE with no tax at a 0 rate, and validates clean", () => {
  const rc = item({ taxKind: "reverse_charge", vatPercent: 5, vatAmount: 0, rcmVat: 45, discountAmount: 100, taxableAmount: 900, lineTotal: 900 });
  const p = build(tx({ items: [rc] }));
  const [line] = p.lines;
  assert.equal(line.taxCategory, "AE");
  assert.equal(line.taxRatePercent, 0, "the invoice charges no VAT, so there is no invoice rate");
  assert.equal(line.lineTaxAmount, 0);
  assert.equal(line.lineNetAmount, 900);
  assert.equal(line.inclVatamount, 900);
  assert.equal(p.taxAmount, 0);
  assert.equal(p.totalIncludingTax, 900);
  assert.equal(p.payableAmount, 900, "the customer pays the net");
  assert.deepEqual(p.taxBreakdown, [{ taxCategory: "AE", taxRatePercent: 0, taxableAmount: 900, taxAmount: 0 }]);
  assert.deepEqual(validatePayload(p), []);
});

test("a mixed invoice keeps a standard line standard and splits the breakdown by category", () => {
  const rc = item({ description: "Imported spice", taxKind: "reverse_charge", vatPercent: 5, vatAmount: 0, rcmVat: 10, discountAmount: 0, taxableAmount: 200, lineTotal: 200, price: 20 });
  const p = build(tx({ items: [item(), rc] }));
  assert.deepEqual(p.lines.map((l) => [l.taxCategory, l.taxRatePercent, l.lineTaxAmount]), [["S", 5, 45], ["AE", 0, 0]]);
  assert.equal(p.taxAmount, 45, "only the standard line carries VAT");
  assert.equal(p.totalIncludingTax, 1145, "900 + 45 + 200: the reverse-charge line adds no VAT");
  assert.deepEqual(p.taxBreakdown.map((g) => g.taxCategory).sort(), ["AE", "S"]);
  assert.deepEqual(validatePayload(p), []);
});

test("a reverse-charge line saved before it stopped charging VAT is sent as it always was", () => {
  const old = item({ taxKind: "reverse_charge", vatPercent: 5, vatAmount: 45, discountAmount: 100, taxableAmount: 900, lineTotal: 945 }); // no rcmVat
  const [line] = build(tx({ items: [old] })).lines;
  assert.equal(line.taxCategory, "AE");
  assert.equal(line.taxRatePercent, 5);
  assert.equal(line.lineTaxAmount, 45);
});
