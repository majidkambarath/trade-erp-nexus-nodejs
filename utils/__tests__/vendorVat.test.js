const test = require("node:test");
const assert = require("node:assert/strict");
const { ACK_FIELD, vendorIsUnregistered, taxCharged, unregisteredVendorWarning } = require("../vendorVat");

const bill = (over = {}) => ({ type: "purchase_order", pricing: { lineVat: 50, chargesVat: 0 }, items: [], ...over });
const unreg = { vendorName: "Al Noor", vat: { status: "unregistered" } };
const reg = { vendorName: "Gulf Mills", vat: { status: "registered", trn: "100123456700003" } };

test("a supplier is unregistered by its status; with none stored, by having no tax number", () => {
  assert.equal(vendorIsUnregistered(unreg), true);
  assert.equal(vendorIsUnregistered(reg), false);
  assert.equal(vendorIsUnregistered({ vat: { status: "exempt" } }), false, "exempt is not unregistered");
  assert.equal(vendorIsUnregistered({ vat: { status: "designated_zone", trn: "1" } }), false);
  assert.equal(vendorIsUnregistered({}), true, "no status and no number");
  assert.equal(vendorIsUnregistered({ trnNO: "100123456700003" }), false, "the older field counts");
  assert.equal(vendorIsUnregistered({ vat: { trn: "100123456700003" } }), false);
  assert.equal(vendorIsUnregistered(null), true);
});

test("the tax a bill charges is its lines' and charges', not a reverse-charge line's self-assessed tax", () => {
  assert.equal(taxCharged(bill()), 50);
  assert.equal(taxCharged(bill({ pricing: { lineVat: 45, chargesVat: 1, rcmVat: 99 } })), 46);
  assert.equal(taxCharged({ items: [{ vatAmount: 5 }, { vatAmount: 2.5 }], charges: [{ vatAmount: 0.5 }] }), 8, "an older document without pricing");
  assert.equal(taxCharged({}), 0);
});

test("a bill with tax from an unregistered supplier warns, naming the supplier and the amount", () => {
  const w = unregisteredVendorWarning({ doc: bill(), vendor: unreg, taxName: "VAT", currency: "AED" });
  assert.equal(w.tax, 50);
  assert.match(w.message, /Al Noor is not registered for VAT/);
  assert.match(w.message, /VAT of AED 50\.00/);
  assert.match(w.message, /cannot be claimed back/);
  const gst = unregisteredVendorWarning({ doc: bill(), vendor: unreg, taxName: "GST", currency: "INR" });
  assert.match(gst.message, /not registered for GST/);
  assert.match(gst.message, /GST of INR 50\.00/);
});

test("nothing to say when the supplier is registered, the bill has no tax, or it is not a bill", () => {
  assert.equal(unregisteredVendorWarning({ doc: bill(), vendor: reg }), null);
  assert.equal(unregisteredVendorWarning({ doc: bill({ pricing: { lineVat: 0, chargesVat: 0 } }), vendor: unreg }), null);
  assert.equal(unregisteredVendorWarning({ doc: bill({ pricing: { lineVat: 0.004, chargesVat: 0 } }), vendor: unreg }), null);
  assert.equal(unregisteredVendorWarning({ doc: bill({ type: "purchase_return" }), vendor: unreg }), null);
  assert.equal(unregisteredVendorWarning({ doc: bill({ type: "sales_order" }), vendor: unreg }), null);
  assert.equal(unregisteredVendorWarning({ doc: bill({ isOpening: true }), vendor: unreg }), null);
  assert.equal(unregisteredVendorWarning({ doc: null, vendor: unreg }), null);
});

test("when the organisation will not claim the tax (the bill is stamped not registered) there is no claim to warn about", () => {
  assert.equal(unregisteredVendorWarning({ doc: bill({ vatRegistered: false }), vendor: unreg }), null);
  assert.ok(unregisteredVendorWarning({ doc: bill({ vatRegistered: true }), vendor: unreg }));
  assert.ok(unregisteredVendorWarning({ doc: bill(), vendor: unreg }), "a bill from before the rule has no stamp: it claims");
});

test("the acknowledgement field is its own, so it can never acknowledge a credit warning", () => {
  assert.equal(ACK_FIELD, "riskAck_unregistered_vendor_vat");
  assert.notEqual(ACK_FIELD, "riskAck_limit_party_credit");
});
