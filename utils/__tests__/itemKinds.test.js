const test = require("node:test");
const assert = require("node:assert/strict");
const {
  SERVICE, GOODS, STOCKED_ONLY, itemTypeOf, isService, isStocked, parseItemType, stockFieldsOnService,
  servicePlan, needsDefaultExpense, routeServiceLegs,
} = require("../itemKinds");
const { figuresFor, buildEntries } = require("../postingTemplates");
const { planCloseShort, trimmedLines } = require("../closeShort");
const { buildFlow } = require("../documentFlow");
const { buildPayload } = require("../eInvoice");

// resolve: every reference becomes a readable string so assertions stay legible
const resolve = (a) => (a.party ? "PARTY" : a.key);
const side = (entries, account, s) =>
  entries.filter((e) => e.accountId === account).reduce((t, e) => t + e[s === "debit" ? "debitAmount" : "creditAmount"], 0);
const balanced = (entries) =>
  Math.abs(entries.reduce((t, e) => t + e.debitAmount, 0) - entries.reduce((t, e) => t + e.creditAmount, 0)) < 0.005;

// ---- the type itself ------------------------------------------------------------------------

test("a missing or unknown type reads as goods, so every item that existed before needs no migration", () => {
  assert.equal(itemTypeOf({}), GOODS);
  assert.equal(itemTypeOf(undefined), GOODS);
  assert.equal(itemTypeOf({ itemType: "weird" }), GOODS);
  assert.equal(itemTypeOf({ itemType: SERVICE }), SERVICE);
  assert.equal(isService({ itemType: "service" }), true);
  assert.equal(isService({}), false);
  assert.equal(isStocked({}), true);
  assert.equal(isStocked({ itemType: "service" }), false);
  assert.deepEqual(STOCKED_ONLY, { itemType: { $ne: "service" } }, "the filter that keeps services out of stock figures");
});

test("a requested type is goods or service, case aside; anything else is refused (null), nothing at all is undefined", () => {
  assert.equal(parseItemType("service"), "service");
  assert.equal(parseItemType(" Goods "), "goods");
  assert.equal(parseItemType(undefined), undefined);
  assert.equal(parseItemType(""), undefined);
  assert.equal(parseItemType(null), undefined);
  assert.equal(parseItemType("subscription"), null);
  assert.equal(parseItemType(5), null);
});

test("a service may be sent zero or blank stock fields (a form sends them) but not real ones", () => {
  assert.deepEqual(stockFieldsOnService({ currentStock: 0, reorderLevel: "", batchNumber: "", expiryDate: null, barcodeQrCode: undefined }), []);
  assert.deepEqual(stockFieldsOnService({ currentStock: "0", reorderLevel: "0" }), []);
  assert.deepEqual(stockFieldsOnService({ currentStock: 5 }), ["currentStock"]);
  assert.deepEqual(stockFieldsOnService({ reorderLevel: 2, batchNumber: "B1", expiryDate: "2026-12-31", barcodeQrCode: "123" }), ["reorderLevel", "batchNumber", "expiryDate", "barcodeQrCode"]);
});

// ---- posting: where a service's money goes ---------------------------------------------------

// a 100 AED service at 5% VAT (gross 100, no discount), and 10 x 20 of goods at 5%
const line = (over) => ({ itemId: "s1", grossAmount: 100, taxableAmount: 100, discountAmount: 0, vatAmount: 5, lineTotal: 105, ...over });
const kindMap = {
  consult: { service: true, incomeAccountId: null, expenseAccountId: null },
  design: { service: true, incomeAccountId: "INC-DESIGN", expenseAccountId: "EXP-DESIGN" },
  rice: { service: false },
};
const kindOf = (l) => kindMap[l.itemId] || { service: false };
const doc = (type, lines, extra = {}) => {
  const lineTotal = lines.reduce((t, l) => t + l.lineTotal, 0);
  const net = lines.reduce((t, l) => t + l.taxableAmount, 0);
  const gross = lines.reduce((t, l) => t + l.grossAmount, 0);
  const vat = lines.reduce((t, l) => t + l.vatAmount, 0);
  return { type, totalAmount: lineTotal, items: lines, pricing: { gross, lineDiscount: gross - net, net, lineVat: vat, chargesNet: 0, chargesVat: 0, headerDiscount: 0, roundOff: 0, grandTotal: lineTotal }, ...extra };
};
const post = (type, lines, cogs = 0, defaults = { defaultExpenseAccountId: "SERVICE-EXPENSE" }) => {
  const d = doc(type, lines);
  const entries = buildEntries(type, figuresFor(d, cogs), resolve);
  return routeServiceLegs(entries, type, servicePlan(d.items, kindOf), defaults);
};

test("a document with no service line is posted exactly as before (the same entries come back)", () => {
  const d = doc("sales_order", [line({ itemId: "rice" })]);
  const entries = buildEntries("sales_order", figuresFor(d, 60), resolve);
  assert.equal(servicePlan(d.items, kindOf).hasServices, false);
  assert.equal(routeServiceLegs(entries, "sales_order", servicePlan(d.items, kindOf)), entries, "same array: nothing was touched");
});

test("selling a service: revenue, VAT and the receivable, and no cost of goods or Inventory leg", () => {
  const e = post("sales_order", [line({ itemId: "consult" })], 0);
  assert.equal(side(e, "PARTY", "debit"), 105);
  assert.equal(side(e, "sales-revenue", "credit"), 100, "an item with no income account of its own earns into sales-revenue");
  assert.equal(side(e, "vat-sales", "credit"), 5);
  assert.equal(side(e, "cogs", "debit"), 0);
  assert.equal(side(e, "inventory-asset", "credit"), 0);
  assert.ok(balanced(e));
});

test("a service that names an income account earns into it, not into sales-revenue", () => {
  const e = post("sales_order", [line({ itemId: "design" })], 0);
  assert.equal(side(e, "INC-DESIGN", "credit"), 100);
  assert.equal(side(e, "sales-revenue", "credit"), 0, "the default account is not touched");
  assert.equal(side(e, "PARTY", "debit"), 105);
  assert.ok(balanced(e));
});

test("a mixed sale: goods earn into sales-revenue and carry their cost, the service lines earn where they should", () => {
  const e = post("sales_order", [line({ itemId: "rice", grossAmount: 200, taxableAmount: 200, vatAmount: 10, lineTotal: 210 }), line({ itemId: "design" }), line({ itemId: "consult", grossAmount: 50, taxableAmount: 50, vatAmount: 2.5, lineTotal: 52.5 })], 120);
  assert.equal(side(e, "sales-revenue", "credit"), 250, "the goods (200) and the service with no account of its own (50)");
  assert.equal(side(e, "INC-DESIGN", "credit"), 100);
  assert.equal(side(e, "vat-sales", "credit"), 17.5);
  assert.equal(side(e, "cogs", "debit"), 120, "cost of goods only for the goods");
  assert.equal(side(e, "inventory-asset", "credit"), 120);
  assert.equal(side(e, "PARTY", "debit"), 367.5);
  assert.ok(balanced(e));
});

test("a sales return of a service takes back the same revenue and VAT on the same side, with no stock leg", () => {
  const e = post("sales_return", [line({ itemId: "design" }), line({ itemId: "consult" })], 0);
  assert.equal(side(e, "INC-DESIGN", "debit"), 100);
  assert.equal(side(e, "sales-revenue", "debit"), 100);
  assert.equal(side(e, "vat-sales", "debit"), 10);
  assert.equal(side(e, "PARTY", "credit"), 210);
  assert.equal(side(e, "inventory-asset", "debit"), 0);
  assert.ok(balanced(e));
});

test("buying a service expenses it: the service-expense account, input VAT, the payable, and no Inventory", () => {
  const e = post("purchase_order", [line({ itemId: "consult" })]);
  assert.equal(side(e, "SERVICE-EXPENSE", "debit"), 100);
  assert.equal(side(e, "inventory-asset", "debit"), 0);
  assert.equal(side(e, "vat-purchase", "debit"), 5);
  assert.equal(side(e, "PARTY", "credit"), 105);
  assert.ok(balanced(e));
});

test("a bought service that names an expense account goes there; goods on the same invoice still go to Inventory", () => {
  const e = post("purchase_order", [line({ itemId: "rice", grossAmount: 300, taxableAmount: 300, vatAmount: 15, lineTotal: 315 }), line({ itemId: "design" }), line({ itemId: "consult", grossAmount: 40, taxableAmount: 40, vatAmount: 2, lineTotal: 42 })]);
  assert.equal(side(e, "inventory-asset", "debit"), 300);
  assert.equal(side(e, "EXP-DESIGN", "debit"), 100);
  assert.equal(side(e, "SERVICE-EXPENSE", "debit"), 40);
  assert.equal(side(e, "vat-purchase", "debit"), 22);
  assert.equal(side(e, "PARTY", "credit"), 462);
  assert.ok(balanced(e));
});

test("a purchase return of a service credits the expense instead of Inventory", () => {
  const e = post("purchase_return", [line({ itemId: "consult" })]);
  assert.equal(side(e, "SERVICE-EXPENSE", "credit"), 100);
  assert.equal(side(e, "inventory-asset", "credit"), 0);
  assert.equal(side(e, "PARTY", "debit"), 105);
  assert.ok(balanced(e));
});

test("a line discount comes off the expense of a bought service (the net), not off the revenue of a sold one (gross, with the discount shown apart)", () => {
  const discounted = line({ itemId: "consult", grossAmount: 100, taxableAmount: 90, vatAmount: 4.5, lineTotal: 94.5 });
  const buy = post("purchase_order", [discounted]);
  assert.equal(side(buy, "SERVICE-EXPENSE", "debit"), 90);
  const sell = post("sales_order", [discounted]);
  assert.equal(side(sell, "sales-revenue", "credit"), 100);
  assert.equal(side(sell, "discount-sales", "debit"), 10);
  assert.ok(balanced(buy) && balanced(sell));
});

test("a purchase of a service needs the default expense account only when some line names none", () => {
  assert.equal(needsDefaultExpense(servicePlan([line({ itemId: "design" })], kindOf)), false);
  assert.equal(needsDefaultExpense(servicePlan([line({ itemId: "design" }), line({ itemId: "consult" })], kindOf)), true);
  assert.equal(needsDefaultExpense(servicePlan([line({ itemId: "rice" })], kindOf)), false);
  assert.throws(
    () => post("purchase_order", [line({ itemId: "consult" })], 0, {}),
    { code: "ACCOUNT_NOT_CONFIGURED" },
    "never a silent fallback account"
  );
});

// ---- delivery: a service is rendered, not delivered ------------------------------------------

const RICE = "line-rice";
const JOB = "line-job";
const order = (over = {}) => ({
  _id: "o1", type: "sales_order", transactionNo: "SO-2026-0001", status: "DRAFT", totalAmount: 400, date: "2026-10-02",
  items: [
    { _id: RICE, itemId: "i1", description: "Rice", qty: 10, price: 10, lineTotal: 105 },
    { _id: JOB, itemId: "i2", itemType: "service", description: "Installation", qty: 1, price: 250, lineTotal: 262.5 },
  ],
  ...over,
});
const note = (no, status, lines) => ({ deliveryNoteNo: no, status, items: lines.map(([sourceLineId, qty, deliveredQty]) => ({ sourceLineId, qty, deliveredQty })) });

test("closing short never counts a service line as short, and it stays on the cut-down order", () => {
  const plan = planCloseShort(order(), [note("D1", "DELIVERED", [[RICE, 6, 6]])]);
  assert.equal(plan.blocked, undefined);
  assert.deepEqual(plan.lines.filter((r) => r.short > 0).map((r) => [r.description, r.short]), [["Rice", 4]]);
  assert.equal(plan.valueShort, 42, "only the rice that never left (4 of 10 of 105)");
  const kept = trimmedLines(order(), plan, (l, qty) => ({ id: l._id, qty }));
  assert.deepEqual(kept, [{ id: RICE, qty: 6 }, { id: JOB, qty: 1 }], "the service line is kept whole");
});

test("an order of services alone has nothing to close short", () => {
  const services = order({ items: [order().items[1]] });
  assert.equal(planCloseShort(services, []).blocked.code, "NOTHING_DELIVERED");
  assert.equal(planCloseShort(services, [note("D1", "DELIVERED", [[JOB, 1, 1]])]).blocked.code, "NOTHING_DELIVERED", "a note that lists the service does not make it goods");
});

test("the deal never asks for a service line to be delivered", () => {
  const chain = (items, notes = []) => buildFlow({ orders: [order({ items, status: "DRAFT" })], notes }).chains[0];
  const mixed = chain(order().items, [{ _id: "d1", deliveryNoteNo: "DLN-1", status: "DELIVERED", date: "2026-10-03", deliveredAt: "2026-10-04T08:00:00Z", invoiceStatus: "NONE", source: { kind: "sales_order", id: "o1" }, items: [{ sourceLineId: RICE, qty: 10, deliveredQty: 10 }] }]);
  assert.equal(mixed.delivery.complete, true, "the goods are all out; the installation is not a delivery");
  assert.deepEqual(mixed.delivery.remaining, []);
  const goodsOnly = chain(order().items.slice(0, 1), []);
  assert.equal(goodsOnly.delivery.complete, false, "still true of goods");
  const serviceOnly = chain(order().items.slice(1), []);
  assert.deepEqual(serviceOnly.delivery.remaining, []);
});

// ---- the e-invoice says goods or services -----------------------------------------------------

test("an e-invoice line says S for a service and G for goods", () => {
  const seller = { name: "Seller", trn: "100123456700003", address: "Dubai", country: "AE" };
  const customer = { customerName: "Buyer", trnNumber: "100987654300003", billingAddress: "Dubai", eInvoice: { participantId: "0235:100987654300003" } };
  const lines = [
    { itemId: "a", itemCode: "A", description: "Rice", qty: 10, price: 10, taxableAmount: 100, vatPercent: 5, vatAmount: 5, lineTotal: 105 },
    { itemId: "b", itemCode: "B", itemType: "service", description: "Installation", qty: 1, price: 250, taxableAmount: 250, vatPercent: 5, vatAmount: 12.5, lineTotal: 262.5 },
  ];
  const payload = buildPayload({ transaction: { type: "sales_order", transactionNo: "SO-1", date: new Date("2026-10-01"), items: lines, totalAmount: 367.5, pricing: { grandTotal: 367.5 } }, customer, seller, sellerParticipantId: "0235:100123456700003" });
  assert.deepEqual(payload.lines.map((l) => l.itemTypeGoodsServices), ["G", "S"]);
});
