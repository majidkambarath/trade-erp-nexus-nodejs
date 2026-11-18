// The customer's copy of an invoice made in a foreign currency is the document they were invoiced: in that currency, at its rate.
const test = require("node:test");
const assert = require("node:assert/strict");
const { invoiceSnapshot } = require("../shareSnapshot");

const usdInvoice = () => ({
  transactionNo: "SO-2026-0001",
  date: "2026-11-18",
  totalAmount: 3856.13,
  items: [{ description: "Rice", qty: 10, rate: 3672.5, price: 367.25, vatPercent: 5, vatAmount: 183.63, lineTotal: 3856.13, fx: { price: 100, taxableAmount: 1000, vatAmount: 50, lineTotal: 1050 } }],
  charges: [],
  pricing: { lineVat: 183.63, chargesVat: 0, grandTotal: 3856.13 },
  fx: { currency: "USD", rate: 3.6725, totalAmount: 1050, pricing: { grandTotal: 1050, lineVat: 50, chargesVat: 0 } },
});

test("a foreign invoice is shown in its own currency with the rate and the tax in the base currency", () => {
  const s = invoiceSnapshot({ transaction: usdInvoice(), customer: { customerName: "Cust" }, company: {} });
  assert.equal(s.document.currency, "USD");
  assert.equal(s.document.exchangeRate, 3.6725);
  assert.equal(s.document.baseVat, 183.63);
  assert.equal(s.document.totalAmount, 1050);
  assert.equal(s.document.items[0].lineTotal, 1050);
  assert.equal(s.document.items[0].vatAmount, 50);
});

test("the base-currency invoice carries none of the foreign keys", () => {
  const tx = usdInvoice();
  delete tx.fx;
  const s = invoiceSnapshot({ transaction: tx, customer: { customerName: "Cust" }, company: {} });
  for (const k of ["currency", "exchangeRate", "baseVat"]) assert.equal(k in s.document, false, k);
  assert.equal(s.document.totalAmount, 3856.13);
});
