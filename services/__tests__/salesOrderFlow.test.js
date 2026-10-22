// Sales order document -> delivery notes -> sales invoice. The order and the notes post nothing and move no stock; the
// invoice made from what was delivered does both when it is approved, and can bill no more than was delivered. The
// order's freight rides on its first invoice only. Real documents through the real services; throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/salesOrderFlow.test.js
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
let noor, mill, rice;
let order, note1, note2, invoice1, invoice2;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Orders: require("../orderPurchase/tradeOrderService"),
    Notes: require("../orderPurchase/deliveryNoteService"),
    Tx: require("../orderPurchase/transactionService"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Note: require("../../models/modules/deliveryNoteModel"),
    UOM: require("../../models/modules/uomModel"), // the list read resolves each item's unit
    ...require("../../models/modules/financial/financialModels"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  const category = new mongoose.Types.ObjectId();
  noor = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", billingAddress: "Deira", paymentTerms: "Net 30" });
  mill = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mill", contactPerson: "x", address: "Jebel Ali", paymentTerms: "Net 30" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice 5kg", category });
  // stock to sell: a direct purchase, approved
  const buy = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: mill._id, partyType: "Vendor", partyTypeRef: "Vendor", date: D(1, 5),
    items: [{ itemId: rice._id, description: "Rice 5kg", qty: 200, price: 10, rate: 10, vatPercent: 5 }],
  }, "tester");
  await svc.Tx.processTransaction(buy._id, "approve", "tester");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const stockOf = async () => (await svc.Stock.findById(rice._id)).currentStock;
const ledgerCount = () => svc.LedgerEntry.countDocuments({});
const line = (qty, price) => ({ itemId: rice._id, description: "Rice 5kg", qty, price, rate: price, vatPercent: 5 });

test("a sales order is priced by the server, numbered in its own series and posts nothing", { skip }, async () => {
  const before = { ledger: await ledgerCount(), stock: await stockOf() };
  order = await svc.Orders.create({
    kind: "sales", partyId: noor._id, date: D(2, 1), reference: "LPO-77",
    items: [line(100, 15)], charges: [{ code: "FRT", description: "Freight", amount: 20, vatPercent: 5 }],
  }, "tester");
  assert.match(order.orderNo, /^SORD-\d{4}-\d{4}$/);
  assert.equal(order.totalAmount, 1596, "(100 x 15 + 20 freight) + 5%");
  order = await svc.Orders.confirm(order._id, {}, "tester");
  assert.equal(order.status, "CONFIRMED");
  assert.equal(await ledgerCount(), before.ledger);
  assert.equal(await stockOf(), before.stock);
});

test("delivery notes are raised against the order, part by part, and cannot go past what is left", { skip }, async () => {
  const pre = await svc.Notes.prefillFromTradeOrder(order._id);
  assert.equal(pre.lines[0].remaining, 100);
  assert.equal(pre.party.customerName, "Al Noor");

  const before = { ledger: await ledgerCount(), stock: await stockOf() };
  note1 = await svc.Notes.create({ sourceTradeOrderId: String(order._id), date: D(2, 3), items: [{ sourceLineId: order.items[0]._id, qty: 30 }] }, "tester");
  assert.equal(note1.source.kind, "trade_order");
  assert.equal(note1.source.no, order.orderNo);
  assert.equal(note1.totalAmount, 472.5, "30 x 15 + 5%, with no freight on a part delivery");
  assert.equal(note1.charges.length, 0);
  await assert.rejects(() => svc.Notes.create({ sourceTradeOrderId: String(order._id), items: [{ sourceLineId: order.items[0]._id, qty: 71 }] }, "tester"), { code: "OVER_DELIVERY" });

  note1 = await svc.Notes.deliver(note1._id, { receivedBy: "Khalid", deliveredAt: D(2, 4) }, "tester");
  assert.equal(note1.status, "DELIVERED");
  assert.equal(await ledgerCount(), before.ledger, "delivery posts nothing");
  assert.equal(await stockOf(), before.stock, "and moves no stock");
  const p = (await svc.Orders.getById(order._id)).progress;
  assert.equal(p.totals.received, 30);
  assert.equal(p.label, "Partly delivered");
});

test("nothing can be invoiced from an order until something is delivered; then it is invoiced at the delivered quantity", { skip }, async () => {
  // a fresh order with nothing delivered
  const idle = await svc.Orders.confirm((await svc.Orders.create({ kind: "sales", partyId: noor._id, items: [line(5, 15)] }, "tester"))._id, {}, "tester");
  await assert.rejects(() => svc.Orders.createInvoice(idle._id, {}, "tester"), { code: "NOTHING_TO_INVOICE" });

  const before = { ledger: await ledgerCount(), stock: await stockOf() };
  const out = await svc.Orders.createInvoice(order._id, { date: D(2, 6) }, "tester");
  invoice1 = out.invoice;
  assert.equal(out.kind, "sales");
  assert.equal(invoice1.type, "sales_order");
  assert.equal(invoice1.status, "DRAFT");
  assert.equal(invoice1.items[0].qty, 30);
  assert.equal(invoice1.charges.length, 1, "the order's freight goes on its first invoice");
  assert.equal(invoice1.totalAmount, 493.5, "30 x 15 + 20 freight, + 5%");
  assert.equal(await ledgerCount(), before.ledger, "a draft invoice posts nothing");
  assert.equal(await stockOf(), before.stock);
  const stored = await svc.Note.findById(note1._id).lean();
  assert.equal(stored.invoiceStatus, "DRAFT");
});

test("the invoice cannot be edited to bill more than was delivered", { skip }, async () => {
  await assert.rejects(
    () => svc.Tx.updateTransaction(invoice1._id, { items: [{ ...line(31, 15), _id: invoice1.items[0]._id }] }, "tester"),
    (e) => e.code === "BILLED_MORE_THAN_DELIVERED" && e.statusCode === 409
  );
});

test("approving the invoice takes the stock out and posts a balanced entry; the note reads Invoiced", { skip }, async () => {
  const before = { ledger: await ledgerCount(), stock: await stockOf() };
  await svc.Tx.processTransaction(invoice1._id, "approve", "tester");
  assert.equal(await stockOf(), before.stock - 30);
  const entries = await svc.LedgerEntry.find({ voucherId: invoice1._id }).lean();
  assert.ok(entries.length > 0);
  const debit = entries.reduce((t, e) => t + e.debitAmount, 0);
  const credit = entries.reduce((t, e) => t + e.creditAmount, 0);
  assert.equal(Math.round(debit * 100), Math.round(credit * 100));
  assert.equal((await svc.Note.findById(note1._id).lean()).invoiceStatus, "INVOICED");
  assert.equal((await svc.Orders.getById(order._id)).progress.totals.invoiced, 30);
});

test("the rest is delivered and invoiced; the second invoice carries no freight; the order reads Invoiced", { skip }, async () => {
  note2 = await svc.Notes.create({ sourceTradeOrderId: String(order._id), date: D(2, 10), items: [{ sourceLineId: order.items[0]._id, qty: 70 }] }, "tester");
  note2 = await svc.Notes.deliver(note2._id, { receivedBy: "Khalid", deliveredAt: D(2, 11) }, "tester");
  assert.equal((await svc.Orders.getById(order._id)).progress.receiving, "ALL");

  const out = await svc.Orders.createInvoice(order._id, { date: D(2, 12) }, "tester");
  invoice2 = out.invoice;
  assert.equal(invoice2.items[0].qty, 70);
  assert.equal(invoice2.charges.length, 0, "freight was on the first invoice");
  assert.equal(invoice2.totalAmount, 1102.5, "70 x 15 + 5%");
  await svc.Tx.processTransaction(invoice2._id, "approve", "tester");
  assert.equal((await svc.Orders.getById(order._id)).progress.label, "Invoiced");
  assert.equal(await stockOf(), 100, "200 bought, 100 sold");
});

test("rejecting or deleting the invoice releases the notes to be invoiced again", { skip }, async () => {
  await svc.Tx.deleteTransaction(invoice2._id, "tester");
  const stored = await svc.Note.findById(note2._id).lean();
  assert.equal(stored.invoiceStatus, "NONE");
  assert.equal(stored.invoice, undefined);
  assert.equal(await stockOf(), 170);
  const again = await svc.Orders.createInvoice(order._id, {}, "tester");
  assert.equal(again.invoice.items[0].qty, 70);
  assert.equal(again.invoice.charges.length, 0, "still the first invoice that had the freight");
});

test("a delivered note can also be invoiced on its own from the notes list, as before", { skip }, async () => {
  const n = await svc.Notes.create({ partyId: String(noor._id), date: D(3, 1), items: [{ itemId: rice._id, description: "Rice 5kg", qty: 2, price: 15, vatPercent: 5 }] }, "tester");
  await svc.Notes.deliver(n._id, { receivedBy: "Khalid", deliveredAt: D(3, 2) }, "tester");
  const out = await svc.Notes.createInvoice({ deliveryNoteIds: [String(n._id)] }, "tester");
  assert.equal(out.salesOrder.items[0].qty, 2);
  assert.equal(out.salesOrder.totalAmount, 31.5);
});

// The lists PRINT: Download, the Send attachment and the invoice screen opened from a row all build the printed
// sheet out of the list row (frontend utils/documentTotals.js). A row without `pricing` falls back to summing the
// lines, so the header charges, the header discount and the round-off vanish from the paper while the Amount column
// beside it still reads the real total - an invoice of 200 less 10 discount plus 60 courier printed 190 beside a row
// reading 250.
test("a list row carries the figures the printed invoice needs", { skip }, async () => {
  const { transactions } = await svc.Tx.getAllTransactions({ type: "sales_order", search: invoice1.transactionNo });
  const row = transactions.find((t) => String(t._id) === String(invoice1._id));
  assert.ok(row, "the invoice is on its own list");
  assert.equal(row.charges.length, 1, "the freight is on the row");
  assert.equal(row.charges[0].description, "Freight");
  assert.equal(row.pricing.chargesNet, 20);
  assert.equal(row.pricing.grandTotal, row.totalAmount, "the row prints what the Amount column shows");
  const lines = (row.items || []).reduce((t, i) => t + (i.taxableAmount || 0) + (i.vatAmount || 0), 0);
  assert.notEqual(Math.round(lines * 100), Math.round(row.totalAmount * 100), "summing the lines is NOT the total: that is why pricing is on the row");
});
