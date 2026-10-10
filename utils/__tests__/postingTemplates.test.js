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
    total: 1050, roundUp: 0, roundDown: 0, cogs: 400, rcmVat: 0, // no reverse-charge line: nothing assessed
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

// ================================= reverse charge =================================
// A purchase on which the supplier charged no VAT and we assess it ourselves: the party is owed the NET, and a pair of legs
// (Dr Input VAT / Cr Reverse-charge VAT) books the assessed amount without touching the party. See utils/pricing.js.
const { itemKinds } = { itemKinds: require("../itemKinds") };

// 4 x 100 reverse-charge goods + 200 standard: the vendor is owed 400 + 200 + 10 = 610; we assess 20 on the first line
const rcmTx = (type = "purchase_order", over = {}) => ({
  type,
  totalAmount: 610,
  items: [
    { lineTotal: 400, vatAmount: 0, taxKind: "reverse_charge", rcmVat: 20 },
    { lineTotal: 210, vatAmount: 10 },
  ],
  pricing: { gross: 600, lineDiscount: 0, net: 600, lineVat: 10, rcmVat: 20, chargesNet: 0, chargesVat: 0, headerDiscount: 0, roundOff: 0, grandTotal: 610 },
  ...over,
});

test("figures: the assessed VAT is its own figure, outside vat and total, with and without a pricing block", () => {
  const priced = figuresFor(rcmTx());
  assert.equal(priced.rcmVat, 20);
  assert.equal(priced.vat, 10, "the VAT the supplier charged does not include it");
  assert.equal(priced.total, 610, "nor does what the party is owed");

  // a document with no pricing block (saved before server-side pricing): the lines carry it
  const { pricing, ...bare } = rcmTx();
  const fromLines = figuresFor(bare);
  assert.equal(fromLines.rcmVat, 20);
  assert.equal(fromLines.vat, 10);
  assert.equal(fromLines.netLines, 600, "net = line totals less the supplier's VAT (the assessed VAT is in neither)");

  // a priced document from before reverse charge was posted has no rcmVat in pricing: nothing assessed
  const { rcmVat, ...oldPricing } = rcmTx().pricing;
  assert.equal(figuresFor(rcmTx("purchase_order", { pricing: oldPricing })).rcmVat, 0);
});

test("a purchase books Dr Input VAT / Cr Reverse-charge VAT beside the ordinary legs, and balances", () => {
  const e = buildEntries("purchase_order", figuresFor(rcmTx()), resolve);
  assert.equal(side(e, "inventory-asset", "debit"), 600);
  assert.equal(side(e, "PARTY", "credit"), 610, "the vendor is owed the net plus the VAT it charged, not the assessed VAT");
  assert.equal(side(e, "vat-purchase", "debit"), 30, "10 charged + 20 assessed, both recoverable");
  assert.equal(side(e, "rcm-purchase", "credit"), 20);
  assert.equal(e.reduce((t, x) => t + x.debitAmount, 0), e.reduce((t, x) => t + x.creditAmount, 0));
});

test("a purchase return is the exact mirror, so the assessed VAT is reversed with it", () => {
  const buy = buildEntries("purchase_order", figuresFor(rcmTx()), resolve);
  const ret = buildEntries("purchase_return", figuresFor(rcmTx("purchase_return")), resolve);
  for (const acc of ["PARTY", "inventory-asset", "vat-purchase", "rcm-purchase"]) {
    assert.equal(side(ret, acc, "debit"), side(buy, acc, "credit"), acc);
    assert.equal(side(ret, acc, "credit"), side(buy, acc, "debit"), acc);
  }
});

test("a purchase with no reverse-charge line has no reverse-charge leg", () => {
  const e = buildEntries("purchase_order", figuresFor(tx("purchase_order")), resolve);
  assert.equal(e.some((x) => x.accountId === "rcm-purchase"), false);
  assert.equal(side(e, "vat-purchase", "debit"), 50);
});

test("a SALE posts no reverse-charge leg: the supplier charges no VAT and the customer assesses it", () => {
  // the sale's lines carry the same assessed figure (pricing is the same code), but no sales template has a leg for it
  const sale = rcmTx("sales_order", { totalAmount: 600, pricing: { ...rcmTx().pricing, lineVat: 0, grandTotal: 600 }, items: [{ lineTotal: 600, vatAmount: 0, taxKind: "reverse_charge", rcmVat: 30 }] });
  const e = buildEntries("sales_order", figuresFor(sale, 0), resolve);
  assert.equal(e.some((x) => x.accountId === "rcm-purchase"), false);
  assert.equal(e.some((x) => x.accountId === "vat-sales"), false, "no output VAT either");
  assert.equal(side(e, "PARTY", "debit"), 600);
  assert.equal(side(e, "sales-revenue", "credit"), 600);
  const back = buildEntries("sales_return", figuresFor({ ...sale, type: "sales_return" }, 0), resolve);
  assert.equal(back.some((x) => x.accountId === "rcm-purchase" || x.accountId === "vat-sales"), false);
});

test("a service bought under the reverse charge: expense for the net, assessed VAT as input and liability, no inventory leg", () => {
  // 500 of consulting, reverse charge 5%: the vendor is owed 500; we assess 25
  const service = {
    type: "purchase_order", totalAmount: 500,
    items: [{ itemId: "S1", lineTotal: 500, vatAmount: 0, taxKind: "reverse_charge", rcmVat: 25, taxableAmount: 500, grossAmount: 500 }],
    pricing: { gross: 500, lineDiscount: 0, net: 500, lineVat: 0, rcmVat: 25, chargesNet: 0, chargesVat: 0, headerDiscount: 0, roundOff: 0, grandTotal: 500 },
  };
  const plan = itemKinds.servicePlan(service.items, () => ({ service: true }));
  const e = itemKinds.routeServiceLegs(buildEntries("purchase_order", figuresFor(service), resolve), "purchase_order", plan, { defaultExpenseAccountId: "service-expense" });
  assert.equal(side(e, "service-expense", "debit"), 500);
  assert.equal(side(e, "inventory-asset", "debit"), 0, "a service is never stock");
  assert.equal(side(e, "PARTY", "credit"), 500);
  assert.equal(side(e, "vat-purchase", "debit"), 25);
  assert.equal(side(e, "rcm-purchase", "credit"), 25);
  assert.equal(e.reduce((t, x) => t + x.debitAmount, 0), e.reduce((t, x) => t + x.creditAmount, 0));
});
