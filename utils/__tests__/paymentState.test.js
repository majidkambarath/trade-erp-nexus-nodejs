// The payment state of an invoice and the cards of a list (server twin of the frontend lib/paymentStatus.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { paymentStatus, isPastDue, dueDateOf, summarise } = require("../paymentState");

const inv = (o = {}) => ({ status: "APPROVED", totalAmount: 100, paidAmount: 0, outstandingAmount: 100, date: "2026-01-01", ...o });

test("unpaid, part paid, paid, from the amounts", () => {
  assert.equal(paymentStatus(inv()).key, "UNPAID");
  assert.equal(paymentStatus(inv({ paidAmount: 40, outstandingAmount: 60 })).key, "PARTIAL");
  assert.equal(paymentStatus(inv({ paidAmount: 100, outstandingAmount: 0 })).key, "PAID");
});

test("a return set against the invoice is not a payment but does reduce what is owed", () => {
  assert.equal(paymentStatus(inv({ creditedAmount: 30, outstandingAmount: 70 })).key, "PARTIAL");
  assert.equal(paymentStatus(inv({ creditedAmount: 100, outstandingAmount: 0 })).key, "PAID");
});

test("a draft, a nil document and missing amounts say nothing", () => {
  assert.equal(paymentStatus(inv({ status: "DRAFT" })), null);
  assert.equal(paymentStatus(inv({ totalAmount: 0 })), null);
  assert.equal(paymentStatus({ status: "APPROVED", totalAmount: 100 }), null);
  assert.equal(paymentStatus({ status: "PAID", totalAmount: 100 }).key, "PAID");
});

test("due date is the stored one, else the date plus the party's terms; past due only while owed", () => {
  const now = new Date("2026-02-20T12:00:00Z").getTime();
  assert.equal(dueDateOf(inv({ paymentTerms: "Net 30" })).toISOString().slice(0, 10), "2026-01-31");
  assert.equal(isPastDue(inv({ paymentTerms: "Net 30" }), now), true);
  assert.equal(isPastDue(inv({ paymentTerms: "Net 60" }), now), false);
  assert.equal(isPastDue(inv({ paymentTerms: "Net 30", paidAmount: 100, outstandingAmount: 0 }), now), false);
  assert.equal(isPastDue(inv({ dueDate: "2026-02-19" }), now), true);
});

test("summarise matches the cards the pages used to work out", () => {
  const now = new Date("2026-03-01T00:00:00Z").getTime();
  const s = summarise(
    [
      inv({ totalAmount: 100 }),
      inv({ totalAmount: 200, paidAmount: 50, outstandingAmount: 150 }),
      inv({ totalAmount: 300, paidAmount: 300, outstandingAmount: 0 }),
      inv({ status: "DRAFT", totalAmount: 10 }),
      inv({ isOpening: true, totalAmount: 40, outstandingAmount: 40 }),
    ],
    { now }
  );
  assert.equal(s.count, 5);
  assert.equal(s.draft, 1);
  assert.equal(s.confirmed, 4);
  assert.equal(s.invoiced, 3);
  assert.equal(s.invoicedValue, 600);
  assert.equal(s.totalValue, 650);
  assert.deepEqual([s.paid, s.partial, s.unpaid], [1, 1, 2]);
  assert.equal(s.open, 290);
  assert.equal(s.overdue, 3);
  assert.deepEqual(s.byStatus, { APPROVED: 4, DRAFT: 1 });
  assert.equal(s.valueByStatus.APPROVED, 640);
  assert.equal(summarise([]).count, 0);
});
