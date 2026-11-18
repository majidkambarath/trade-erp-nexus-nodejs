// A discount on the whole invoice reduces the taxable amount and the tax, not just the total: shared out over the lines as extra line discount
// (utils/headerDiscount.js). The total is what it always was. Against a throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/headerDiscountSpread.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_hd_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc, vendor, customer, rice;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Category: require("../../models/modules/categoryModel"),
    Stock: require("../../models/modules/stockModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    LedgerEntry: fin.LedgerEntry,
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", address: "y", paymentTerms: "Cash" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", paymentTerms: "Cash" });
  const category = await svc.Category.create({ name: "General" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: category._id });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const L = (qty, price, extra = {}) => ({ itemId: rice._id, description: "Rice", qty, price, rate: price, vatPercent: 5, ...extra });
const sell = (items, extra) => svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items, ...extra }, "tester");
const buy = (items, extra) => svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items, ...extra }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
async function posted(t) {
  const rows = await svc.LedgerEntry.find({ voucherId: t._id, isReversed: { $ne: true } }).lean();
  const out = {};
  for (const e of rows) out[e.accountName] = r2((out[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return { byAccount: out, balanced: r2(rows.reduce((s, e) => s + e.debitAmount - e.creditAmount, 0)) === 0 };
}

test("a sales invoice with a header discount: the tax falls with it, the total is what it was", { skip }, async () => {
  const t = await sell([L(10, 100)], { discount: 105 });
  assert.equal(r2(t.totalAmount), 945, "1,050 less the 105 typed, exactly as before");
  assert.equal(r2(t.pricing.lineVat), 45, "VAT on 900, not on 1,000");
  assert.equal(t.pricing.headerDiscount, 0, "no header discount remains");
  assert.equal(t.pricing.headerDiscountSpread, 105);
  assert.equal(r2(t.pricing.lineDiscount), 100);
  assert.equal(r2(t.items[0].taxableAmount), 900);
  assert.equal(r2(t.items[0].vatAmount), 45);
  assert.equal(r2(t.items[0].discountAmount), 100);
  assert.equal(r2(t.discount), 105, "the amount typed is kept for reference");
  await approve(t);
  const p = await posted(t);
  assert.equal(p.byAccount["Output VAT"], -45);
  assert.equal(p.byAccount["Sales Discounts Given"], 100, "the discount is an ordinary sales discount");
  assert.ok(p.balanced);
});

test("a purchase with a header discount: the stock costs what was paid for it, net of the discount", { skip }, async () => {
  const t = await buy([L(10, 100)], { discount: 52.5 });
  assert.equal(r2(t.totalAmount), 997.5);
  assert.equal(r2(t.pricing.lineVat), 47.5);
  await approve(t);
  const p = await posted(t);
  assert.equal(p.byAccount["Input VAT"], 47.5);
  assert.equal(p.byAccount["Inventory Stock"], 950, "the goods cost 950, not 1,000 with the discount as income");
  assert.ok(!p.byAccount["Purchase Discounts Received"]);
  assert.ok(p.balanced);
  const movement = await svc.Movement.findOne({ referenceId: t._id, eventType: "PURCHASE_RECEIVE" }).lean();
  assert.equal(r2(movement.totalValue), 950);
});

test("without a discount nothing changes at all", { skip }, async () => {
  const t = await sell([L(10, 100)]);
  assert.equal(r2(t.totalAmount), 1050);
  assert.equal(r2(t.pricing.lineVat), 50);
  assert.equal(t.pricing.headerDiscountSpread, undefined);
});

test("a discount larger than the lines is held to what they cost", { skip }, async () => {
  const t = await sell([L(1, 100)], { discount: 9999 });
  assert.equal(r2(t.totalAmount), 0);
  assert.equal(r2(t.pricing.lineVat), 0);
});

test("editing with the lines prices the discount from what was entered, not on top of the stored lines", { skip }, async () => {
  const t = await sell([L(10, 100)], { discount: 105 });
  const edited = await svc.Tx.updateTransaction(t._id, { items: [L(10, 100)], discount: 210 }, "tester");
  assert.equal(r2(edited.totalAmount), 840);
  assert.equal(r2(edited.pricing.lineVat), 40);
  assert.equal(edited.pricing.headerDiscountSpread, 210);
  const again = await svc.Tx.updateTransaction(t._id, { items: [L(10, 100)], discount: 210 }, "tester");
  assert.equal(r2(again.totalAmount), 840, "saving it again changes nothing");
});

test("an edit that sends no lines re-prices the stored lines from their own prices: the discount is neither lost nor taken twice", { skip }, async () => {
  const t = await sell([L(10, 100)], { discount: 105 });
  assert.equal(r2(t.items[0].headerDiscountNet), 100, "the line records how much of its discount is the shared-out one");
  const charged = await svc.Tx.updateTransaction(t._id, { charges: [{ description: "Courier", amount: 20, vatPercent: 5 }] }, "tester");
  assert.equal(r2(charged.pricing.lineVat), 45, "the lines still carry their 45");
  assert.equal(r2(charged.pricing.chargesVat), 1, "and the courier its own VAT");
  assert.equal(r2(charged.totalAmount), 966, "945 plus the courier and its VAT");
  assert.equal(charged.pricing.headerDiscountSpread, 105);
  assert.equal(r2(charged.items[0].discountAmount), 100);
  // the discount can be changed on its own too
  const lower = await svc.Tx.updateTransaction(t._id, { discount: 52.5 }, "tester");
  assert.equal(r2(lower.totalAmount), 1050 - 52.5 + 21);
  assert.equal(r2(lower.pricing.lineVat), 47.5);
  const again = await svc.Tx.updateTransaction(t._id, { discount: 52.5, notes: "x" }, "tester");
  assert.equal(r2(again.totalAmount), r2(lower.totalAmount), "saving again changes nothing");
});

test("an invoice made before this is re-priced the new way the next time it is saved, with the same total", { skip }, async () => {
  const t = await sell([L(10, 100)], { discount: 105 });
  const Transaction = require("../../models/modules/transactionModel");
  // as one saved by the release before: header discount kept, lines at full value, no record of a shared-out discount
  const lines = t.items.map((i) => ({ ...i.toObject(), taxableAmount: 1000, vatAmount: 50, discountAmount: 0, lineTotal: 1050, grandTotal: 1050, rate: 1000, headerDiscountNet: undefined }));
  await Transaction.updateOne({ _id: t._id }, { $set: { items: lines, "pricing.headerDiscount": 105, "pricing.lineVat": 50 }, $unset: { "pricing.headerDiscountSpread": "" } });
  const old = await Transaction.findById(t._id).lean();
  assert.equal(r2(old.pricing.headerDiscount), 105, "as stored it is still a header discount");
  const untouched = await svc.Tx.updateTransaction(t._id, { notes: "only a note" }, "tester");
  assert.equal(r2(untouched.pricing.lineVat), 50, "an edit that does not price again leaves it as it was issued");
  const edited = await svc.Tx.updateTransaction(t._id, { discount: 105 }, "tester");
  assert.equal(r2(edited.totalAmount), 945, "the same total");
  assert.equal(r2(edited.pricing.lineVat), 45, "and now the tax follows the discount");
  assert.equal(edited.pricing.headerDiscount, 0);
});

test("a quotation prices a discount the way the invoice it becomes will, and converting does not take it twice", { skip }, async () => {
  const quote = await svc.Tx.buildPricing({ items: [L(10, 100)], discount: 105, date: new Date(), side: "sales" });
  assert.equal(quote.pricing.headerDiscount, 0);
  assert.equal(r2(quote.pricing.lineVat), 45);
  assert.equal(r2(quote.totalAmount), 945);
  // the stored line handed back as a pricing input (what converting does) carries only its OWN discount, so the typed discount is shared out once
  const S = require("../orderPurchase/salesDocumentSupport");
  const stored = { ...quote.processedItems[0], qty: 10 };
  assert.equal(r2(stored.discountAmount), 100);
  const back = S.toPricingInput(stored);
  assert.equal(back.discountAmount, 0, "none of the shared-out discount comes back as the line's own");
  const invoice = await sell([{ ...L(10, 100), discountAmount: back.discountAmount }], { discount: 105 });
  assert.equal(r2(invoice.totalAmount), 945);
  assert.equal(r2(invoice.pricing.lineVat), 45);
  // a line with a discount of its own keeps it when it comes back
  const own = await svc.Tx.buildPricing({ items: [L(10, 100, { discountAmount: 50 })], discount: 105, date: new Date(), side: "sales" });
  const ownBack = S.toPricingInput(own.processedItems[0]);
  assert.equal(ownBack.discountAmount, 50, "its own 50 only");
});
