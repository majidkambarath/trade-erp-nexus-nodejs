// Which cost centre each ledger row of a trade document belongs to (utils/costCentres.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { splitLegsByCentre, lineFacts, centresOf } = require("../costCentres");

const sum = (rows, k) => Math.round(rows.reduce((t, r) => t + r[k], 0) * 100) / 100;
// a sale: 300 gross, 30 discount, 270 net, 13.50 VAT, cost of goods 150
const sale = () => [
  { accountId: "AR", debitAmount: 283.5, creditAmount: 0, figure: "total" },
  { accountId: "REV", debitAmount: 0, creditAmount: 300, figure: "gross" },
  { accountId: "DISC", debitAmount: 30, creditAmount: 0, figure: "discount" },
  { accountId: "VAT", debitAmount: 0, creditAmount: 13.5, figure: "vat" },
  { accountId: "COGS", debitAmount: 150, creditAmount: 0, figure: "cogs" },
  { accountId: "INV", debitAmount: 0, creditAmount: 150, figure: "cogs" },
];
const line = (centre, gross, discount, cogs, over = {}) => ({ centre, gross, discount, net: gross - discount, cogs, service: false, revenueAccount: null, expenseAccount: null, ...over });

test("a document whose lines name no centre of their own posts every leg on the header's, unchanged", () => {
  const out = splitLegsByCentre(sale(), [line(null, 100, 10, 50), line(null, 200, 20, 100)], "H");
  assert.equal(out.length, 6);
  assert.ok(out.every((e) => e.costCentreId === "H"));
  assert.deepEqual(out.map((e) => e.debitAmount + e.creditAmount), sale().map((e) => e.debitAmount + e.creditAmount));
  assert.ok(splitLegsByCentre(sale(), [], null).every((e) => e.costCentreId === null));
});

test("line centres share out revenue, discount and cost of goods by each line's own figure; the rest stays on the header", () => {
  const out = splitLegsByCentre(sale(), [line("A", 100, 10, 50), line("B", 200, 20, 100)], "H");
  const of = (acc, c) => out.filter((e) => e.accountId === acc && e.costCentreId === c);
  assert.equal(of("REV", "A")[0].creditAmount, 100);
  assert.equal(of("REV", "B")[0].creditAmount, 200);
  assert.equal(of("DISC", "A")[0].debitAmount, 10);
  assert.equal(of("COGS", "B")[0].debitAmount, 100);
  assert.equal(of("INV", "A")[0].creditAmount, 50);
  assert.equal(of("AR", "H")[0].debitAmount, 283.5);
  assert.equal(of("VAT", "H")[0].creditAmount, 13.5);
  assert.equal(sum(out, "debitAmount"), sum(out, "creditAmount"));
});

test("a line with no centre of its own falls to the header's, and an uneven split is fils-exact", () => {
  const entries = [
    { accountId: "AR", debitAmount: 100, creditAmount: 0, figure: "total" },
    { accountId: "REV", debitAmount: 0, creditAmount: 100, figure: "gross" },
  ];
  const out = splitLegsByCentre(entries, [line("A", 1, 0, 0), line(null, 1, 0, 0), line("A", 1, 0, 0)], "H");
  const rev = out.filter((e) => e.accountId === "REV");
  assert.deepEqual(rev.map((e) => [e.costCentreId, e.creditAmount]).sort(), [["A", 66.67], ["H", 33.33]]);
  assert.equal(sum(rev, "creditAmount"), 100);
});

test("a purchase splits the inventory leg over goods lines and each service's expense over its own lines", () => {
  const entries = [
    { accountId: "INV", debitAmount: 80, creditAmount: 0, figure: "netLines" },
    { accountId: "SVC", debitAmount: 20, creditAmount: 0, figure: "serviceExpense" },
    { accountId: "AP", debitAmount: 0, creditAmount: 100, figure: "total" },
  ];
  const lines = [
    line("A", 50, 0, 0),
    line("B", 30, 0, 0),
    line("C", 20, 0, 0, { service: true, expenseAccount: "SVC" }),
  ];
  const out = splitLegsByCentre(entries, lines, null);
  assert.deepEqual(out.filter((e) => e.accountId === "INV").map((e) => [e.costCentreId, e.debitAmount]), [["A", 50], ["B", 30]]);
  assert.deepEqual(out.filter((e) => e.accountId === "SVC").map((e) => [e.costCentreId, e.debitAmount]), [["C", 20]]);
  assert.equal(out.find((e) => e.accountId === "AP").costCentreId, null);
});

test("lineFacts pairs each goods line with its own stock movement cost, in order, and leaves services out of cost", () => {
  const items = [
    { itemId: "i1", taxableAmount: 90, discountAmount: 10, grossAmount: 100, costCentreId: "A" },
    { itemId: "s1", taxableAmount: 40, discountAmount: 0, grossAmount: 40 },
    { itemId: "i1", taxableAmount: 45, discountAmount: 5, grossAmount: 50, costCentreId: "B" },
  ];
  const kindOf = (l) => (l.itemId === "s1" ? { service: true, incomeAccountId: "INC2", expenseAccountId: null } : { service: false });
  const facts = lineFacts(items, [{ itemId: "i1", cost: 30 }, { itemId: "i1", cost: 15 }], kindOf, { defaultExpenseAccountId: "SE" });
  assert.deepEqual(facts.map((f) => f.cogs), [30, 0, 15]);
  assert.deepEqual(facts.map((f) => f.centre), ["A", null, "B"]);
  assert.equal(facts[1].revenueAccount, "INC2");
  assert.equal(facts[1].expenseAccount, "SE");
});

test("centresOf names the header and every line's centre, nothing blank", () => {
  assert.deepEqual(centresOf("H", [{ costCentreId: "A" }, {}, { costCentreId: "" }]), ["H", "A"]);
  assert.deepEqual(centresOf(null, []), []);
});
