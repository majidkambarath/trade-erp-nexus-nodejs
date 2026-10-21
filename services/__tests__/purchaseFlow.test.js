// Purchase order -> goods received -> purchase invoice. The order and the receipt are commitments and paper: they post
// nothing and move no stock. The invoice made from them does both when it is approved, and can bill no more than was
// received. Real documents through the real services; throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/purchaseFlow.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const Y = new Date(Date.now() + 4 * 3600e3).getUTCFullYear();
const D = (m, d) => `${Y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

let svc;
let mill, oils, rice, oil;
let order; // the purchase order used throughout
let receipt1, receipt2, invoice1, invoice2;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Orders: require("../orderPurchase/tradeOrderService"),
    Receipts: require("../orderPurchase/goodsReceiptService"),
    Tx: require("../orderPurchase/transactionService"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Receipt: require("../../models/modules/goodsReceiptModel"),
    Order: require("../../models/modules/tradeOrderModel"),
    ...require("../../models/modules/financial/financialModels"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  const category = new mongoose.Types.ObjectId();
  mill = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mill", contactPerson: "x", address: "Jebel Ali", paymentTerms: "Net 30" });
  oils = await svc.Vendor.create({ vendorId: "V2", vendorName: "Oil Co", contactPerson: "x", address: "Sharjah", paymentTerms: "Net 30" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice 5kg", category });
  oil = await svc.Stock.create({ itemId: "OIL", sku: "OIL", itemName: "Corn Oil", category });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// `rate` rides along as the order form sends it: a purchase invoice line records it
const line = (stock, qty, price) => ({ itemId: stock._id, description: stock.itemName, qty, price, rate: price, vatPercent: 5 });
const stockOf = async (s) => (await svc.Stock.findById(s._id)).currentStock;
const ledgerCount = () => svc.LedgerEntry.countDocuments({});

// ------------------------------------------------------------------------------------ the order

test("a purchase order is priced by the server, numbered in its own series, and is a draft", { skip }, async () => {
  order = await svc.Orders.create({ kind: "purchase", partyId: mill._id, date: D(3, 1), reference: "Quote 77", items: [line(rice, 100, 10), line(oil, 20, 50)] }, "tester");
  assert.match(order.orderNo, /^PORD-\d{4}-\d{4}$/);
  assert.equal(order.status, "DRAFT");
  assert.equal(order.totalAmount, 2100, "(100 x 10 + 20 x 50) + 5% VAT");
  assert.equal(order.kind, "purchase");
  const read = await svc.Orders.getById(order._id);
  assert.equal(read.progress.label, "Not received");
  assert.equal(read.actions.confirm, true);
  assert.equal(read.actions.receive, false, "a draft is not received against");
});

test("a draft can be edited and is repriced; nothing is posted", { skip }, async () => {
  const before = { ledger: await ledgerCount(), rice: await stockOf(rice) };
  const updated = await svc.Orders.update(order._id, { items: [line(rice, 100, 10), line(oil, 20, 50)], discount: 0, expectedDate: D(3, 10) }, "tester");
  assert.equal(updated.totalAmount, 2100);
  assert.equal(await ledgerCount(), before.ledger);
  assert.equal(await stockOf(rice), before.rice);
});

test("goods cannot be received against a draft order", { skip }, async () => {
  await assert.rejects(() => svc.Receipts.create({ sourceOrderId: String(order._id), items: [{ sourceLineId: order.items[0]._id, qty: 10 }] }, "tester"), { code: "ORDER_NOT_RECEIVABLE" });
});

test("confirming makes it receivable and no longer editable, and still posts nothing", { skip }, async () => {
  const before = { ledger: await ledgerCount(), rice: await stockOf(rice) };
  order = await svc.Orders.confirm(order._id, {}, "tester");
  assert.equal(order.status, "CONFIRMED");
  assert.ok(order.confirmedAt);
  await assert.rejects(() => svc.Orders.update(order._id, { notes: "x" }, "tester"), { code: "ORDER_NOT_EDITABLE" });
  await assert.rejects(() => svc.Orders.remove(order._id, "tester"), { code: "ORDER_NOT_DELETABLE" });
  assert.equal(await ledgerCount(), before.ledger);
  assert.equal(await stockOf(rice), before.rice);
  assert.equal((await svc.Orders.getById(order._id)).actions.receive, true);
});

// ------------------------------------------------------------------------------------ goods received

test("a receipt is prefilled with what is left on the order and is a draft that moves nothing", { skip }, async () => {
  const pre = await svc.Receipts.prefillFromOrder(order._id);
  assert.equal(pre.lines.length, 2);
  assert.equal(pre.lines[0].toReceive, 100);
  assert.equal(pre.party.vendorName, "Gulf Mill");

  const before = { ledger: await ledgerCount(), rice: await stockOf(rice) };
  receipt1 = await svc.Receipts.create(
    { sourceOrderId: String(order._id), date: D(3, 5), vendorDeliveryNo: "MILL-DN-9", items: [{ sourceLineId: order.items[0]._id, qty: 60 }] },
    "tester"
  );
  assert.match(receipt1.receiptNo, /^GRN-\d{4}-\d{4}$/);
  assert.equal(receipt1.status, "DRAFT");
  assert.equal(receipt1.totalAmount, 630, "60 x 10 + 5%: priced as the order priced it");
  assert.equal(receipt1.source.no, order.orderNo);
  assert.equal(await ledgerCount(), before.ledger);
  assert.equal(await stockOf(rice), before.rice);
});

test("a receipt cannot take in more than is left on the order", { skip }, async () => {
  await assert.rejects(
    () => svc.Receipts.create({ sourceOrderId: String(order._id), items: [{ sourceLineId: order.items[0]._id, qty: 41 }] }, "tester"),
    (e) => e.code === "OVER_RECEIPT" && e.statusCode === 409
  );
});

test("receiving needs the name of who took the goods in, and a reason for what came short", { skip }, async () => {
  await assert.rejects(() => svc.Receipts.receive(receipt1._id, {}, "tester"), { code: "RECEIVED_BY_REQUIRED" });
  await assert.rejects(
    () => svc.Receipts.receive(receipt1._id, { receivedBy: "Store keeper", lines: [{ lineId: String(receipt1.items[0]._id), receivedQty: 55 }] }, "tester"),
    { code: "INVALID_RECEIPT" }
  );
  await assert.rejects(
    () => svc.Receipts.receive(receipt1._id, { receivedBy: "Store keeper", lines: [{ lineId: String(receipt1.items[0]._id), receivedQty: 61 }] }, "tester"),
    { code: "INVALID_RECEIPT" }
  );
  await assert.rejects(
    () => svc.Receipts.receive(receipt1._id, { receivedBy: "Store keeper", receivedAt: "2099-01-01" }, "tester"),
    { code: "INVALID_DATE" }
  );
});

test("a confirmed receipt is repriced to what arrived, and still posts nothing and moves no stock", { skip }, async () => {
  const before = { ledger: await ledgerCount(), rice: await stockOf(rice) };
  receipt1 = await svc.Receipts.receive(
    receipt1._id,
    { receivedBy: "Store keeper", receivedAt: D(3, 6), lines: [{ lineId: String(receipt1.items[0]._id), receivedQty: 55, shortReason: "5 bags torn" }] },
    "tester"
  );
  assert.equal(receipt1.status, "RECEIVED");
  assert.equal(receipt1.receivedBy, "Store keeper");
  assert.equal(receipt1.items[0].receivedQty, 55);
  assert.equal(receipt1.totalAmount, 577.5, "55 x 10 + 5%");
  assert.equal(await ledgerCount(), before.ledger, "no ledger entry");
  assert.equal(await stockOf(rice), before.rice, "no stock");
  const progress = (await svc.Orders.getById(order._id)).progress;
  assert.equal(progress.totals.received, 55);
  assert.equal(progress.label, "Partly received");
  assert.equal(progress.lines[String(order.items[0]._id)].toReceive, 45, "the 5 that were torn are still to come");
});

// ------------------------------------------------------------------------------------ the invoice

test("the invoice is made from the receipt at the quantity received, as a draft that posts nothing", { skip }, async () => {
  const before = { ledger: await ledgerCount(), rice: await stockOf(rice) };
  const out = await svc.Receipts.createInvoice({ receiptIds: [String(receipt1._id)], vendorInvoiceNo: "MILL-INV-501", date: D(3, 8) }, "tester");
  invoice1 = out.purchaseInvoice;
  assert.equal(invoice1.type, "purchase_order");
  assert.equal(invoice1.status, "DRAFT");
  assert.equal(invoice1.vendorReference, "MILL-INV-501");
  assert.equal(invoice1.items.length, 1);
  assert.equal(invoice1.items[0].qty, 55);
  assert.equal(invoice1.totalAmount, 577.5);
  assert.equal(out.goodsReceipts[0].invoiceStatus, "DRAFT");
  assert.equal(await ledgerCount(), before.ledger);
  assert.equal(await stockOf(rice), before.rice);
  // a receipt can be on one invoice only
  await assert.rejects(() => svc.Receipts.createInvoice({ receiptIds: [String(receipt1._id)] }, "tester"), { code: "ALREADY_INVOICED" });
  // and cannot be withdrawn while an invoice is on its way
  await assert.rejects(() => svc.Receipts.cancel(receipt1._id, {}, "tester"), { code: "RECEIPT_INVOICED" });
});

test("3-way match: the invoice cannot be edited to bill more than was received", { skip }, async () => {
  await assert.rejects(
    () => svc.Tx.updateTransaction(invoice1._id, { items: [{ ...line(rice, 56, 10), _id: invoice1.items[0]._id }] }, "tester"),
    (e) => e.code === "BILLED_MORE_THAN_RECEIVED" && e.statusCode === 409
  );
  // less is fine
  const lower = await svc.Tx.updateTransaction(invoice1._id, { items: [{ ...line(rice, 50, 10), _id: invoice1.items[0]._id }] }, "tester");
  assert.equal(lower.items[0].qty, 50);
  const back = await svc.Tx.updateTransaction(invoice1._id, { items: [{ ...line(rice, 55, 10), _id: invoice1.items[0]._id }] }, "tester");
  assert.equal(back.items[0].qty, 55);
});

test("approving the invoice brings the stock in and posts a balanced entry; the receipt reads Invoiced", { skip }, async () => {
  const before = { ledger: await ledgerCount(), rice: await stockOf(rice) };
  await svc.Tx.processTransaction(invoice1._id, "approve", "tester");
  assert.equal(await stockOf(rice), before.rice + 55);
  assert.ok((await ledgerCount()) > before.ledger);
  const entries = await svc.LedgerEntry.find({ voucherId: invoice1._id }).lean();
  const debit = entries.reduce((t, e) => t + e.debitAmount, 0);
  const credit = entries.reduce((t, e) => t + e.creditAmount, 0);
  assert.equal(Math.round(debit * 100), Math.round(credit * 100));
  assert.equal(Math.round(credit * 100) / 100, 577.5);
  const stored = await svc.Receipt.findById(receipt1._id).lean();
  assert.equal(stored.invoiceStatus, "INVOICED");
  assert.equal((await svc.Orders.getById(order._id)).progress.totals.invoiced, 55);
});

test("the rest arrives on a second receipt and is invoiced on its own; vendors cannot be mixed", { skip }, async () => {
  receipt2 = await svc.Receipts.create({ sourceOrderId: String(order._id), date: D(3, 12), items: [{ sourceLineId: order.items[0]._id, qty: 45 }, { sourceLineId: order.items[1]._id, qty: 20 }] }, "tester");
  receipt2 = await svc.Receipts.receive(receipt2._id, { receivedBy: "Store keeper", receivedAt: D(3, 13) }, "tester");
  assert.equal(receipt2.totalAmount, 1522.5, "(45 x 10 + 20 x 50) + 5%");
  const p = (await svc.Orders.getById(order._id)).progress;
  assert.equal(p.receiving, "ALL");
  assert.equal(p.label, "Partly invoiced");

  // a receipt of another vendor
  const other = await svc.Receipts.create({ partyId: String(oils._id), date: D(3, 14), items: [{ itemId: oil._id, description: "Corn Oil", qty: 5, price: 50, vatPercent: 5 }] }, "tester");
  await svc.Receipts.receive(other._id, { receivedBy: "Store keeper", receivedAt: D(3, 14) }, "tester");
  await assert.rejects(() => svc.Receipts.createInvoice({ receiptIds: [String(receipt2._id), String(other._id)] }, "tester"), { code: "MIXED_VENDORS" });

  const out = await svc.Receipts.createInvoice({ receiptIds: [String(receipt2._id)], vendorInvoiceNo: "MILL-INV-502" }, "tester");
  invoice2 = out.purchaseInvoice;
  assert.equal(invoice2.totalAmount, 1522.5);
  await svc.Tx.processTransaction(invoice2._id, "approve", "tester");
  const done = (await svc.Orders.getById(order._id)).progress;
  assert.equal(done.label, "Invoiced");
  assert.equal(done.totals.invoiced, 120);
});

test("deleting an approved invoice reverses it and releases the receipts to be invoiced again", { skip }, async () => {
  const rice0 = await stockOf(rice);
  await svc.Tx.deleteTransaction(invoice2._id, "tester");
  assert.equal(await stockOf(rice), rice0 - 45, "the stock that came in with it goes out again");
  const r = await svc.Receipt.findById(receipt2._id).lean();
  assert.equal(r.invoiceStatus, "NONE");
  assert.equal(r.invoice, undefined);
  assert.equal((await svc.Orders.getById(order._id)).progress.label, "Partly invoiced");
  // and it can be invoiced afresh
  const again = await svc.Receipts.createInvoice({ receiptIds: [String(receipt2._id)] }, "tester");
  assert.equal(again.goodsReceipts[0].invoiceStatus, "DRAFT");
});

test("an order with goods received against it cannot be cancelled, only closed", { skip }, async () => {
  await assert.rejects(() => svc.Orders.cancel(order._id, {}, "tester"), { code: "ORDER_HAS_DOCUMENTS" });
  const closed = await svc.Orders.close(order._id, { reason: "Nothing more to come" }, "tester");
  assert.equal(closed.status, "CLOSED");
  await assert.rejects(() => svc.Receipts.create({ sourceOrderId: String(order._id), items: [{ sourceLineId: order.items[0]._id, qty: 1 }] }, "tester"), { code: "ORDER_NOT_RECEIVABLE" });
  const reopened = await svc.Orders.reopen(order._id, {}, "tester");
  assert.equal(reopened.status, "CONFIRMED");
});

test("a draft order with nothing against it can be cancelled or deleted", { skip }, async () => {
  const d = await svc.Orders.create({ kind: "purchase", partyId: mill._id, items: [line(rice, 1, 10)] }, "tester");
  const c = await svc.Orders.confirm(d._id, {}, "tester");
  const cancelled = await svc.Orders.cancel(c._id, { reason: "changed our mind" }, "tester");
  assert.equal(cancelled.status, "CANCELLED");
  const e = await svc.Orders.create({ kind: "purchase", partyId: mill._id, items: [line(rice, 1, 10)] }, "tester");
  const removed = await svc.Orders.remove(e._id, "tester");
  assert.match(removed.orderNo, /^PORD-/);
});

test("bad input is refused with a reason", { skip }, async () => {
  await assert.rejects(() => svc.Orders.create({ kind: "sideways", partyId: mill._id, items: [line(rice, 1, 1)] }, "tester"), { code: "INVALID_KIND" });
  await assert.rejects(() => svc.Orders.create({ kind: "purchase", items: [line(rice, 1, 1)] }, "tester"), { code: "PARTY_REQUIRED" });
  await assert.rejects(() => svc.Orders.create({ kind: "purchase", partyId: mill._id, items: [] }, "tester"), { code: "ITEMS_REQUIRED" });
  await assert.rejects(() => svc.Receipts.createInvoice({ receiptIds: [] }, "tester"), { code: "RECEIPTS_REQUIRED" });
});

test("a line's rate is its VALUE whatever the caller sent: the unit price lives in price", { skip }, async () => {
  // a script or import that sends the unit price in `rate` used to store it there, and every printed sheet then read the unit
  // price as the line's value and charged VAT on qty x value (a 585-unit line printed with 4,409.15 of VAT on 150.74)
  const tx = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: mill._id, partyType: "Vendor", partyTypeRef: "Vendor", date: D(4, 2),
    items: [{ itemId: rice._id, description: "Rice 5kg", qty: 585, price: 150.74, rate: 150.74, vatPercent: 5 }],
  }, "tester");
  const stored = await svc.Tx.getTransactionById(tx._id);
  const item = stored.items[0];
  assert.equal(item.price, 150.74);
  assert.equal(item.taxableAmount, 88182.9);
  assert.equal(item.rate, 88182.9, "rate is the VAT-exclusive value, after any discount");
  assert.equal(item.vatAmount, 4409.15);
  // a discount comes off the value, as the order form has always stored it
  const d = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: mill._id, partyType: "Vendor", partyTypeRef: "Vendor", date: D(4, 2),
    items: [{ itemId: rice._id, description: "Rice 5kg", qty: 10, price: 20, rate: 20, discountPercent: 10, vatPercent: 5 }],
  }, "tester");
  assert.equal((await svc.Tx.getTransactionById(d._id)).items[0].rate, 180);
});

test("the order lists the invoices made from what was received, with where each stands", { skip }, async () => {
  const read = await svc.Orders.getById(order._id);
  assert.ok(Array.isArray(read.invoices));
  assert.ok(read.invoices.length >= 1, "the invoices raised from this order's receipts are listed");
  for (const inv of read.invoices) {
    assert.ok(inv.no && ["DRAFT", "APPROVED"].includes(inv.status), `${inv.no} ${inv.status}`);
    assert.equal(typeof inv.totalAmount, "number");
    assert.equal(typeof inv.outstandingAmount, "number");
  }
  const fresh = await svc.Orders.create({ kind: "purchase", partyId: mill._id, items: [line(rice, 1, 10)] }, "tester");
  assert.deepEqual((await svc.Orders.getById(fresh._id)).invoices, [], "an order nothing was invoiced against lists none");
});

// These three reads had no projection, so a list row carried the party's bank account numbers and IBANs, its KYC
// document names, its credit limit and its running balance - to anyone who may read the list at all. None of it is
// read from a list row (the party account page loads the party from its own endpoint). The item's costValue goes with
// them; purchasePrice deliberately stays, because the order forms show it as a "Cost" column.
test("a list row carries no bank details, KYC files or party balances", { skip }, async () => {
  // getAllTransactions joins each item's unit with mongoose.model("UOM"), which only exists once something has
  // required that model. The server loads every model at start-up; a test suite has to say so.
  require("../../models/modules/uomModel");
  await svc.Vendor.updateOne({ _id: mill._id }, {
    $set: {
      bankAccounts: [{ bankName: "Leak Bank", accountNumber: "9999888877776666", iban: "AE070331234567890123456", accountHolder: "Gulf Mill" }],
      documents: [{ type: "Trade licence", number: "TL-LEAK-1", fileName: "licence.pdf" }],
      creditLimit: 250000,
      cashBalance: -4321,
    },
  });
  await svc.Stock.updateOne({ _id: rice._id }, { $set: { costValue: 87654, purchasePrice: 19.5 } });

  const { transactions } = await svc.Tx.getAllTransactions({ type: "purchase_order" });
  const row = transactions.find((t) => String(t.partyId) === String(mill._id) && (t.items || []).length);
  assert.ok(row, "a purchase invoice for this vendor with lines");

  // the party: enough to name and address them, and nothing that belongs to the finance screens
  for (const hidden of ["bankAccounts", "documents", "creditLimit", "cashBalance", "totalSpent"]) {
    assert.equal(row.party[hidden], undefined, `party.${hidden} must not ride along on a list row`);
  }
  assert.equal(row.party.vendorName, "Gulf Mill", "what the row is for is still there");
  assert.equal(row.party.paymentTerms, "Net 30", "the due date is worked out from this");
  assert.equal(row.partyName, "Gulf Mill");

  // nothing anywhere in the response, however nested: the whole payload is searched, not just the fields above
  const whole = JSON.stringify(transactions);
  for (const secret of ["9999888877776666", "AE070331234567890123456", "TL-LEAK-1", "licence.pdf", "87654"]) {
    assert.ok(!whole.includes(secret), `"${secret}" reached the list`);
  }

  // the line still carries what the screens read, and the deliberate exception
  const withRice = row.items.find((i) => String(i.itemId) === String(rice._id)) || row.items[0];
  assert.equal(withRice.stockDetails.costValue, undefined, "the total cost on hand is read nowhere");
  assert.equal(withRice.stockDetails.purchasePrice, 19.5, "the order forms show this as a Cost column: a product decision, not an accident");
  assert.equal(withRice.stockDetails.itemName, "Rice 5kg");
});
