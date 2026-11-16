// What Zarvia AI prepares: finding the right party, the amount, the bills a payment settles, the bodies.
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../assistantProposals");

const vendors = [
  { _id: "v1", vendorName: "Al Noor Steel" },
  { _id: "v2", vendorName: "Al Noor Trading" },
  { _id: "v3", vendorName: "Gulf Packaging" },
  { _id: "v4", vendorName: "Noor" },
];
const find = (q) => p.rankByName(vendors, q, (v) => v.vendorName);

test("a name is matched exactly first, then by its start, then by a part of it", () => {
  assert.equal(find("noor").match._id, "v4", "an exact name beats longer names that contain it");
  assert.equal(find("gulf").match._id, "v3");
  assert.equal(find("PACKAGING").match._id, "v3", "case and spaces do not matter");
  assert.equal(find("  al   noor steel ").match._id, "v1");
});

test("two equally good matches are choices for the person, never a guess", () => {
  const r = find("al noor");
  assert.equal(r.match, undefined);
  assert.deepEqual(r.choices.map((c) => c.id), ["v1", "v2"]);
  assert.equal(r.choices[0].name, "Al Noor Steel");
});

test("choices are capped, and nothing found says so", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ _id: `x${i}`, vendorName: `Shop ${i}` }));
  const r = p.rankByName(many, "shop", (v) => v.vendorName);
  assert.equal(r.choices.length, 5);
  assert.equal(r.more, 4);
  assert.deepEqual(find("zzz"), { none: true });
  assert.deepEqual(find(""), { none: true });
  assert.deepEqual(p.rankByName([{ _id: "a" }], "x", (x) => x.name), { none: true }, "a record with no name is skipped, not crashed on");
});

test("an amount is positive money with at most two decimals", () => {
  assert.deepEqual(p.checkAmount(5000), { ok: true, amount: 5000 });
  assert.deepEqual(p.checkAmount("5,000.50"), { ok: true, amount: 5000.5 });
  assert.deepEqual(p.checkAmount("1 200"), { ok: true, amount: 1200 });
  for (const bad of [0, -5, "abc", "", null, undefined, NaN, Infinity, 12.345, 1e12]) {
    assert.equal(p.checkAmount(bad).ok, false, String(bad));
  }
  assert.match(p.checkAmount(undefined).reason, /how much/i);
});

test("a date is a real calendar day, and nothing given means today", () => {
  assert.deepEqual(p.checkDate(undefined, "2026-11-16"), { ok: true, date: "2026-11-16" });
  assert.deepEqual(p.checkDate("", "2026-11-16"), { ok: true, date: "2026-11-16" });
  assert.deepEqual(p.checkDate("2026-02-28", "x"), { ok: true, date: "2026-02-28" });
  for (const bad of ["2026-02-30", "16/11/2026", "tomorrow", "2026-13-01", "2026-1-5"]) {
    assert.equal(p.checkDate(bad, "2026-11-16").ok, false, bad);
  }
});

const bills = [
  { id: "b3", number: "PO-3", outstanding: 700, date: "2026-10-30" },
  { id: "b1", number: "PO-1", outstanding: 300.5, date: "2026-09-01" },
  { id: "b2", number: "PO-2", outstanding: 1000, date: "2026-10-05" },
  { id: "paid", number: "PO-0", outstanding: 0, date: "2026-01-01" },
];

test("the oldest bill is settled first, and what each will still owe is worked out", () => {
  const r = p.allocateOldestFirst(bills, 500);
  assert.deepEqual(r.allocations, [
    { invoiceId: "b1", number: "PO-1", amount: 300.5, balance: 0 },
    { invoiceId: "b2", number: "PO-2", amount: 199.5, balance: 800.5 },
  ]);
  assert.equal(r.onAccount, 0);
});

test("bills dated as Date objects are settled in time order, not in the alphabetical order of their text", () => {
  // "Tue Oct 07 2025" sorts before "Wed Jan 01 2025" as text, which is the wrong way round.
  const r = p.allocateOldestFirst(
    [
      { id: "newer", number: "B", outstanding: 100, date: new Date("2025-10-07") },
      { id: "older", number: "A", outstanding: 100, date: new Date("2025-01-01") },
    ],
    100
  );
  assert.deepEqual(r.allocations.map((a) => a.invoiceId), ["older"]);
  const mixed = p.allocateOldestFirst([{ id: "x", number: "X", outstanding: 5, date: "2026-03-01" }, { id: "y", number: "Y", outstanding: 5, date: new Date("2026-02-01") }], 5);
  assert.deepEqual(mixed.allocations.map((a) => a.invoiceId), ["y"], "an ISO string and a Date compare with each other");
});

test("more than every bill owes leaves the rest on account; a paid bill is never touched", () => {
  const r = p.allocateOldestFirst(bills, 3000);
  assert.deepEqual(r.allocations.map((a) => a.invoiceId), ["b1", "b2", "b3"]);
  assert.equal(r.onAccount, 999.5);
  assert.deepEqual(p.allocateOldestFirst([], 100), { allocations: [], onAccount: 100 });
});

test("cents survive: 0.1 + 0.2 style sums do not leave a speck behind", () => {
  const r = p.allocateOldestFirst([{ id: "a", number: "A", outstanding: 0.1, date: "2026-01-01" }, { id: "b", number: "B", outstanding: 0.2, date: "2026-01-02" }], 0.3);
  assert.deepEqual(r.allocations.map((a) => [a.amount, a.balance]), [[0.1, 0], [0.2, 0]]);
  assert.equal(r.onAccount, 0);
});

test("the words a person uses become the product's payment modes", () => {
  assert.deepEqual(p.normaliseMode(""), { ok: true, mode: "cash", assumed: true });
  assert.equal(p.normaliseMode("Bank Transfer").mode, "transfer");
  assert.equal(p.normaliseMode("NEFT").mode, "transfer");
  assert.equal(p.normaliseMode("deposit").mode, "bank");
  for (const hard of ["cheque", "card", "credit card"]) {
    const r = p.normaliseMode(hard);
    assert.equal(r.ok, false);
    assert.match(r.reason, /payment screen/);
  }
  assert.equal(p.normaliseMode("barter").ok, false);
});

test("a bank or transfer payment needs a reference; cash does not", () => {
  assert.deepEqual(p.modeFields({ mode: "cash" }).missing, []);
  assert.deepEqual(p.modeFields({ mode: "transfer" }).missing, ["reference"]);
  assert.deepEqual(p.modeFields({ mode: "bank", reference: "  " }).missing, ["reference"]);
  assert.deepEqual(p.modeFields({ mode: "bank", accountId: "a1", reference: " TT-77 " }), { paymentMode: "bank", paymentDetails: { accountId: "a1", reference: "TT-77" }, missing: [] });
});

test("a payment body is exactly what the payment screen sends", () => {
  const { allocations } = p.allocateOldestFirst(bills, 500);
  const { body, missing } = p.paymentBody({ vendorId: "v1", vendorName: "Al Noor Steel", date: "2026-11-16", amount: 500, allocations, mode: "transfer", accountId: "bk1", reference: "TT-9" });
  assert.deepEqual(body, {
    voucherType: "payment",
    vendorId: "v1",
    date: "2026-11-16",
    totalAmount: 500,
    narration: "Payment to Al Noor Steel",
    linkedInvoices: [{ invoiceId: "b1", amount: 300.5, balance: 0 }, { invoiceId: "b2", amount: 199.5, balance: 800.5 }],
    paymentMode: "transfer",
    paymentDetails: { accountId: "bk1", reference: "TT-9" },
  });
  assert.deepEqual(missing, []);
});

test("a receipt names the customer, not a vendor, and an expense is ledger based", () => {
  const r = p.receiptBody({ customerId: "c1", customerName: "Gulf Fresh", date: "2026-11-16", amount: 200, mode: "cash" });
  assert.equal(r.body.voucherType, "receipt");
  assert.equal(r.body.customerId, "c1");
  assert.equal(r.body.vendorId, undefined);
  assert.equal(r.body.narration, "Receipt from Gulf Fresh");
  const e = p.expenseBody({ accountId: "ex1", date: "2026-11-16", amount: 150, description: "Fuel", mode: "cash", taxCodeId: "t1" });
  assert.deepEqual(e.body, { voucherType: "expense", ledgerBased: true, date: "2026-11-16", expenseAccountId: "ex1", description: "Fuel", amount: 150, paymentMode: "cash", paymentDetails: {}, taxCodeId: "t1" });
  assert.equal(p.expenseBody({ accountId: "ex1", date: "d", amount: 1, description: "x", mode: "cash" }).body.taxCodeId, undefined, "no tax code is sent unless one was asked for");
});

test("an invoice body is a sales order with no status, no total and no tax figures: the server prices it", () => {
  const { body } = p.invoiceBody({ customerId: "c1", date: "2026-11-16", note: "", lines: [{ itemId: "i1", name: "Milk 1L", qty: 10, price: 4.5 }] });
  assert.deepEqual(body, { type: "sales_order", partyId: "c1", partyType: "Customer", date: "2026-11-16", items: [{ itemId: "i1", description: "Milk 1L", qty: 10, price: 4.5 }], notes: "" });
  for (const key of ["status", "total", "pricing", "transactionNo", "vatAmount"]) assert.equal(key in body, false, key);
});

test("the card's lines read in the order a person checks them", () => {
  const rows = p.proposalLines("payment", { partyName: "Al Noor Steel", amount: 5000, methodLabel: "Bank transfer", accountName: "ENBD Current", reference: "TT-9", date: "2026-11-16", allocations: [{ number: "PO-1", amount: 300.5 }], onAccount: 4699.5 }, "AED");
  assert.deepEqual(rows.map((r) => r[0]), ["Pay", "Amount", "How", "Account", "Reference", "Date", "Settles", "On account"]);
  assert.equal(rows[1][1], "AED 5,000.00");
  assert.equal(rows[6][1], "PO-1 (300.50)");
  const inv = p.proposalLines("invoice", { partyName: "Gulf Fresh", lines: [{ name: "Milk 1L", qty: 10, price: 4.5 }], date: "2026-11-16" }, "AED");
  assert.deepEqual(inv.at(-1), ["Saved as", "a draft: nothing is posted until it is approved"]);
});

test("a request to DO something is told apart from a question about how something works", () => {
  for (const doIt of ["pay Gulf Packaging 500 in cash", "I paid al noor 100", "Harbour Cafe paid us 200", "invoice Harbour Cafe 10 milk", "record a fuel expense of 150", "transfer 1000 to Gulf Packaging"]) {
    assert.equal(p.looksLikeAction(doIt), true, doIt);
  }
  for (const askIt of ["how do I pay a vendor?", "What is an invoice", "Why did my receipt not post", "Can I record an expense in euros", "where do I see my bills", "", "   ", null, undefined]) {
    assert.equal(p.looksLikeAction(askIt), false, String(askIt));
  }
});
