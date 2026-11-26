// The slip a salesman prints at a shop's door: what it says, and what it never says.
const test = require("node:test");
const assert = require("node:assert/strict");
const { slipModel, paymentOf, containersOf, addressOf, vatByRate } = require("../vanSlip");

const INV = "64f1c0a1b2c3d4e5f6a7b8c9";
const invoice = (over = {}) => ({
  _id: INV, transactionNo: "SO-2026-0042", date: new Date("2026-11-23T00:00:00Z"), status: "APPROVED", lpono: "LPO-77",
  totalAmount: 932.4, outstandingAmount: 932.4,
  pricing: { gross: 888, lineDiscount: 0, headerDiscount: 0, net: 888, lineVat: 44.4, chargesVat: 0, chargesNet: 0, roundOff: 0, grandTotal: 932.4, cogs: "LEAK" },
  items: [
    { itemId: "a1", itemCode: "C4APPLE", description: "C4 Apple Zero 500ml", qty: 48, price: 14, discountAmount: 0, vatPercent: 5, vatAmount: 33.6, lineTotal: 705.6, unitCost: "LEAK-cost", allocations: [{ batchId: "LEAK" }] },
    { itemId: "b2", itemCode: "MSPB", description: "Muscle Sandwich Peanut Butter", qty: 12, price: 9, discountAmount: 0, vatPercent: 5, vatAmount: 5.4, lineTotal: 113.4 },
    { itemId: "c3", itemCode: "MSV", description: "Muscle Sandwich Vanilla", qty: 12, price: 9, discountAmount: 0, vatPercent: 5, vatAmount: 5.4, lineTotal: 113.4 },
  ],
  ...over,
});
const customer = { customerName: "Gymnation LLC", customerId: "CUS-9", phone: "04 111 2222", billingAddress: "Unit 203, Control Tower", city: "Dubai", emirate: "Dubai", vat: { trn: "100266546900003" }, creditLimit: "LEAK-credit", bankAccounts: [{ iban: "LEAK" }] };
const trip = { _id: "t1", tripNo: "VTR-2026-0009", vanCode: "VAN02", vanName: "Van Cash 02", salesmanName: "Sandeep", cashAccountId: "LEAK-acct" };
const items = new Map([["a1", { barcode: "5056569902274", unit: "NOS" }], ["b2", { barcode: "", unit: "NOS" }]]);

test("the slip carries what the reference receipt prints: code, unit, quantities, totals by rate, reference, van", () => {
  const s = slipModel({ invoice: invoice(), customer, trip, items });
  assert.equal(s.invoice.number, "SO-2026-0042");
  assert.equal(s.invoice.reference, "LPO-77");
  assert.deepEqual(s.trip, { tripNo: "VTR-2026-0009", vanCode: "VAN02", vanName: "Van Cash 02", salesmanName: "Sandeep" });
  assert.deepEqual(s.customer, { name: "Gymnation LLC", code: "CUS-9", address: "Unit 203, Control Tower, Dubai", phone: "04 111 2222", trn: "100266546900003" });
  assert.deepEqual(s.lines[0], { n: 1, code: "5056569902274", description: "C4 Apple Zero 500ml", qty: 48, unit: "NOS", price: 14, discount: 0, vatPercent: 5, vatAmount: 33.6, total: 705.6 });
  assert.equal(s.lines[1].code, "MSPB", "no barcode on the item: its own code");
  assert.equal(s.lines[2].unit, "", "an item with no unit prints none");
  assert.equal(s.totals.quantity, 72);
  assert.equal(s.totals.subTotal, 888);
  assert.equal(s.totals.discount, 0);
  assert.equal(s.totals.vat, 44.4);
  assert.deepEqual(s.totals.vatByRate, [{ rate: 5, amount: 44.4 }]);
  assert.equal(s.totals.total, 932.4);
});

test("nothing internal reaches the slip: no cost, batch, credit limit, bank or account id", () => {
  const out = JSON.stringify(slipModel({ invoice: invoice(), customer, trip, items }));
  assert.equal(out.includes("LEAK"), false, out.match(/LEAK[\w-]*/g));
  for (const w of ["unitCost", "allocations", "creditLimit", "bankAccounts", "cashAccountId", "cogs"]) assert.equal(out.includes(`"${w}"`), false, w);
});

test("payment: nothing taken is a credit sale; an approved receipt is money; a transfer waiting is shown apart", () => {
  assert.equal(slipModel({ invoice: invoice(), customer, trip }).payment.mode, "credit");
  assert.equal(slipModel({ invoice: invoice(), customer, trip }).payment.balanceDue, 932.4);
  const cash = { voucherNo: "RV-1", status: "approved", paymentMode: "cash", totalAmount: 500, linkedInvoices: [{ invoiceId: INV, amount: 500 }] };
  const wait = { voucherNo: "RV-2", status: "pending", paymentMode: "transfer", totalAmount: 432.4, linkedInvoices: [{ invoiceId: INV, amount: 432.4 }] };
  const s = slipModel({ invoice: invoice(), customer, trip, receipts: [cash, wait] });
  assert.equal(s.payment.mode, "mixed");
  assert.equal(s.payment.received, 500);
  assert.equal(s.payment.waiting, 432.4);
  assert.equal(s.payment.balanceDue, 432.4, "a transfer is not money until the office sees it");
});

test("a receipt for several invoices counts only what it set against this one; cancelled and rejected count nothing", () => {
  const many = { voucherNo: "RV-3", status: "approved", paymentMode: "cheque", totalAmount: 2000, linkedInvoices: [{ invoiceId: INV, amount: 300 }, { invoiceId: "other", amount: 1700 }] };
  const gone = { voucherNo: "RV-4", status: "cancelled", paymentMode: "cash", totalAmount: 100, linkedInvoices: [{ invoiceId: INV, amount: 100 }] };
  const refused = { voucherNo: "RV-5", status: "rejected", paymentMode: "cash", totalAmount: 100, linkedInvoices: [{ invoiceId: INV, amount: 100 }] };
  const elsewhere = { voucherNo: "RV-6", status: "approved", paymentMode: "cash", totalAmount: 50, linkedInvoices: [{ invoiceId: "other", amount: 50 }] };
  const p = paymentOf([many, gone, refused, elsewhere], INV);
  assert.equal(p.received, 300);
  assert.equal(p.mode, "cheque");
  assert.deepEqual(p.receipts.map((r) => r.number), ["RV-3"]);
});

test("a receipt for this invoice alone counts whole: the container deposit was paid with it", () => {
  const full = { voucherNo: "RV-7", status: "approved", paymentMode: "cash", totalAmount: 957.4, linkedInvoices: [{ invoiceId: INV, amount: 932.4 }] };
  const moves = [{ typeId: "t", given: 5, collected: 0, deposit: 5 }];
  const s = slipModel({ invoice: invoice(), customer, trip, receipts: [full], moves, typeNames: new Map([["t", "19L bottle"]]) });
  assert.equal(s.deposit, 25);
  assert.deepEqual(s.containers, [{ name: "19L bottle", given: 5, collected: 0 }]);
  assert.equal(s.payment.balanceDue, 0);
  // nothing paid yet: the customer owes the invoice AND the deposit
  const owing = slipModel({ invoice: invoice(), customer, trip, moves, typeNames: new Map([["t", "19L bottle"]]) });
  assert.equal(owing.payment.balanceDue, 957.4);
});

test("containers: given and collected by type, the deposit charged or refunded", () => {
  const c = containersOf([{ typeId: "t", given: 2, collected: 0, deposit: 5 }, { typeId: "t", given: 0, collected: 6, deposit: 5 }, { typeId: "u", given: 0, collected: 0, deposit: 9 }], new Map([["t", "Crate"]]));
  assert.deepEqual(c.containers, [{ name: "Crate", given: 2, collected: 6 }]);
  assert.equal(c.deposit, -20);
});

test("the address is printed once per place, and the VAT is listed by rate", () => {
  assert.equal(addressOf({ billingAddress: "Al Quoz 3", city: "Dubai", emirate: "dubai" }), "Al Quoz 3, Dubai");
  assert.equal(addressOf({}), "");
  assert.deepEqual(vatByRate([{ vatPercent: 5, vatAmount: 1 }, { vatPercent: 0, vatAmount: 0 }, { vatPercent: 5, vatAmount: 2.005 }]), [{ rate: 5, amount: 3.01 }]);
});

test("a sparse invoice gives a sparse slip, never a crash", () => {
  const s = slipModel({});
  assert.deepEqual(s.lines, []);
  assert.equal(s.payment.mode, "credit");
  assert.equal(s.totals.total, 0);
  assert.equal(s.invoice.vatRegistered, true);
  assert.equal(slipModel({ invoice: { vatRegistered: false } }).invoice.vatRegistered, false);
});
