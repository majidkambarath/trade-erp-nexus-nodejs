// The customer's copy of a quotation, a delivery note and a statement: the output holds to an explicit list of fields, so a field added to a
// record later is invisible until someone adds it on purpose (the contract utils/shareSnapshot.js opens with).
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../shareSnapshot");

const keysOk = (obj, allowed, where) => { for (const k of Object.keys(obj)) assert.ok(allowed.includes(k), `${where}: unexpected key "${k}"`); };
const company = { companyName: "Harbour", vatNumber: "1", internalMargin: 9 };
const customer = { customerName: "Al Noor", customerId: "C1", billingAddress: "Quoz", creditLimit: 5000, cashBalance: 77, bankAccounts: [{ accountNumber: "SECRET" }], documents: [{ name: "KYC" }], vat: { status: "registered", trn: "100", internal: 1 }, eInvoice: { city: "Dubai", countryCode: "AE", participantId: "PEPPOL" } };
const line = { itemId: "ID1", itemCode: "R1", description: "Rice", qty: 2, price: 20, taxableAmount: 40, vatPercent: 5, vatAmount: 2, lineTotal: 42, costValue: 7, batches: [1], headerDiscountNet: 1, rcmVat: 3 };

test("a quotation snapshot is held to its list and leaks nothing internal", () => {
  const s = S.quotationSnapshot({ quotation: { quotationNo: "QT-1", date: "2026-11-18", validUntil: "2026-12-18", status: "SENT", terms: "t", notes: "INTERNAL", createdBy: "x", partyId: "P", items: [line], charges: [{ description: "Freight", amount: 5, vatAmount: 0.25, secret: 1 }], pricing: { net: 40, grandTotal: 42, rcmVat: 3, headerDiscountSpread: 2 }, totalAmount: 42, convertedTo: { id: "A" } }, customer, company });
  const A = S.QUOTATION_ALLOWED;
  keysOk(s, A.top, "top"); keysOk(s.document, A.document, "document"); keysOk(s.document.items[0], A.line, "line");
  keysOk(s.document.charges[0], A.charge, "charge"); keysOk(s.document.pricing, A.pricing, "pricing");
  keysOk(s.party, A.party, "party"); keysOk(s.party.eInvoice, A.eInvoice, "eInvoice"); keysOk(s.company, A.company, "company");
  const text = JSON.stringify(s);
  for (const x of ["INTERNAL", "SECRET", "5000", "PEPPOL", "ID1", "costValue", "rcmVat", "createdBy", "convertedTo"]) assert.equal(text.includes(x), false, x);
});

test("a delivery note snapshot carries quantities and the delivery particulars and no price at all", () => {
  const s = S.deliveryNoteSnapshot({
    note: { deliveryNoteNo: "DLN-1", date: "2026-11-18", status: "DELIVERED", vehicleNo: "V1", driverName: "Raju", receivedBy: "Store", deliveredAt: "2026-11-19", source: { kind: "sales_order", no: "SO-1", id: "X" }, items: [{ ...line, deliveredQty: 2, shortReason: "" }], totalAmount: 42, pricing: { grandTotal: 42 }, createdBy: "x", invoice: { id: "Y" } },
    customer: { ...customer, shippingAddress: "Warehouse" }, company,
  });
  const A = S.DELIVERY_NOTE_ALLOWED;
  keysOk(s, A.top, "top"); keysOk(s.document, A.document, "document"); keysOk(s.document.items[0], A.line, "line"); keysOk(s.document.source, A.source, "source");
  keysOk(s.party, A.party, "party");
  assert.equal(s.party.shippingAddress, "Warehouse");
  const text = JSON.stringify(s);
  for (const x of ["price", "lineTotal", "pricing", "totalAmount", "vatAmount", "SECRET", "ID1", "createdBy", '"id"']) assert.equal(text.includes(x), false, x);
});

test("a statement snapshot holds rows without their ledger ids, and says when it was cut short", () => {
  const rows = Array.from({ length: 1002 }, (_, i) => ({ _id: `r${i}`, voucherId: "V", accountId: "A", date: "2026-11-01", voucherNo: `SO-${i}`, voucherType: "sales_order", narration: "n", debit: 1, credit: 0, balance: i, net: i }));
  const s = S.statementSnapshot({ statement: { from: "2026-01-01", to: "2026-11-18", opening: 0, closing: 1001, totals: { debit: 1002, credit: 0, extra: 1 }, rows, party: { _id: "P" } }, customer, company });
  const A = S.STATEMENT_ALLOWED;
  keysOk(s, A.top, "top"); keysOk(s.statement, A.statement, "statement"); keysOk(s.statement.rows[0], A.row, "row"); keysOk(s.statement.totals, A.totals, "totals"); keysOk(s.party, A.party, "party");
  assert.equal(s.statement.rows.length, 1000);
  assert.equal(s.statement.truncated, true);
  const text = JSON.stringify(s);
  for (const x of ["voucherId", "accountId", '"_id"', "SECRET", "5000"]) assert.equal(text.includes(x), false, x);
});
