const test = require("node:test");
const assert = require("node:assert/strict");
const { figuresFor, buildEntries, TEMPLATES } = require("../postingTemplates");

// resolve: every reference becomes a readable string so assertions stay legible
const resolve = (a) => (a.party ? "PARTY" : a.key);

const tx = (type, over = {}) => ({
  type,
  totalAmount: 1050,
  items: [{ lineTotal: 1050, vatAmount: 50 }],
  ...over,
});

const side = (entries, account, s) =>
  entries.filter((e) => e.accountId === account).reduce((t, e) => t + e[s === "debit" ? "debitAmount" : "creditAmount"], 0);

test("figures: legacy documents (no pricing block) fall back to the lines", () => {
  assert.deepEqual(figuresFor(tx("sales_order"), 400), {
    gross: 1000, discount: 0, netLines: 1000, headerDiscount: 0, charges: 0, vat: 50,
    total: 1050, roundUp: 0, roundDown: 0, cogs: 400,
  });
});

test("priced documents post gross revenue, discounts, freight and VAT separately and balance", () => {
  // 10 x 100, 10% line discount, 5% VAT, 40 freight + 2 VAT, 15 header discount
  const priced = tx("sales_order", {
    totalAmount: 972,
    items: [{ lineTotal: 945, vatAmount: 45 }],
    pricing: { gross: 1000, lineDiscount: 100, net: 900, lineVat: 45, chargesNet: 40, chargesVat: 2,
               headerDiscount: 15, roundOff: 0, grandTotal: 972 },
  });
  const e = buildEntries("sales_order", figuresFor(priced, 0), resolve);
  assert.equal(side(e, "PARTY", "debit"), 972);
  assert.equal(side(e, "sales-revenue", "credit"), 1000);
  assert.equal(side(e, "discount-sales", "debit"), 115); // 100 line + 15 header
  assert.equal(side(e, "freight-sales", "credit"), 40);
  assert.equal(side(e, "vat-sales", "credit"), 47);

  const buy = buildEntries("purchase_order", figuresFor({ ...priced, type: "purchase_order" }), resolve);
  assert.equal(side(buy, "inventory-asset", "debit"), 900); // after line discount
  assert.equal(side(buy, "freight-purchase", "debit"), 40);
  assert.equal(side(buy, "vat-purchase", "debit"), 47);
  assert.equal(side(buy, "discount-purchase", "credit"), 15);
  assert.equal(side(buy, "PARTY", "credit"), 972);
});

test("sale: receivable, revenue, VAT and cost of goods all post and balance", () => {
  const e = buildEntries("sales_order", figuresFor(tx("sales_order"), 400), resolve);
  assert.equal(side(e, "PARTY", "debit"), 1050);
  assert.equal(side(e, "sales-revenue", "credit"), 1000);
  assert.equal(side(e, "vat-sales", "credit"), 50);
  assert.equal(side(e, "cogs", "debit"), 400);
  assert.equal(side(e, "inventory-asset", "credit"), 400);
});

test("purchase: stock at VAT-exclusive cost, input VAT recoverable, vendor credited the total", () => {
  const e = buildEntries("purchase_order", figuresFor(tx("purchase_order")), resolve);
  assert.equal(side(e, "inventory-asset", "debit"), 1000);
  assert.equal(side(e, "vat-purchase", "debit"), 50);
  assert.equal(side(e, "PARTY", "credit"), 1050);
});

test("returns mirror their originals exactly", () => {
  const sale = buildEntries("sales_order", figuresFor(tx("sales_order"), 400), resolve);
  const ret = buildEntries("sales_return", figuresFor(tx("sales_return"), 400), resolve);
  for (const acc of ["PARTY", "sales-revenue", "vat-sales", "cogs", "inventory-asset"]) {
    assert.equal(side(ret, acc, "debit"), side(sale, acc, "credit"), acc);
    assert.equal(side(ret, acc, "credit"), side(sale, acc, "debit"), acc);
  }
  const buy = buildEntries("purchase_order", figuresFor(tx("purchase_order")), resolve);
  const pret = buildEntries("purchase_return", figuresFor(tx("purchase_return")), resolve);
  for (const acc of ["PARTY", "inventory-asset", "vat-purchase"]) {
    assert.equal(side(pret, acc, "debit"), side(buy, acc, "credit"), acc);
    assert.equal(side(pret, acc, "credit"), side(buy, acc, "debit"), acc);
  }
});

test("a header total different from the lines posts the difference to round-off, still balanced", () => {
  // customer is charged 1049.50 against lines of 1050: 0.50 discount/round-down on a sale
  const e = buildEntries("sales_order", figuresFor(tx("sales_order", { totalAmount: 1049.5 })), resolve);
  assert.equal(side(e, "PARTY", "debit"), 1049.5);
  assert.equal(side(e, "round-off-sales", "debit"), 0.5);
  // and 0.30 more than the lines on a purchase
  const p = buildEntries("purchase_order", figuresFor(tx("purchase_order", { totalAmount: 1050.3 })), resolve);
  assert.equal(side(p, "PARTY", "credit"), 1050.3);
  assert.equal(side(p, "round-off-purchase", "debit"), 0.3);
});

test("zero-value legs are dropped (no cost of goods on a document that moved no stock)", () => {
  const e = buildEntries("sales_order", figuresFor(tx("sales_order"), 0), resolve);
  assert.ok(!e.some((x) => x.accountId === "cogs" || x.accountId === "inventory-asset"));
});

test("an unbalanced template is refused rather than written", () => {
  assert.throws(
    () => buildEntries("sales_order", { net: 1000, vat: 50, total: 900, roundUp: 0, roundDown: 0, cogs: 0 }, resolve),
    { code: "UNBALANCED_POSTING" }
  );
});

test("every document type has a template", () => {
  for (const t of ["sales_order", "sales_return", "purchase_order", "purchase_return"]) {
    assert.ok(TEMPLATES[t], t);
  }
});
