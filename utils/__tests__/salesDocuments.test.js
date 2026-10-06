const test = require("node:test");
const assert = require("node:assert/strict");
const {
  quotationExpiry, defaultValidUntil, baseNumber, revisionNumber,
  fulfilment, settleDelivery, invoiceClock, lastDayOfMonth,
  QUOTATION_ACTIONS, DELIVERY_ACTIONS,
} = require("../salesDocuments");

// ---- quotation validity -------------------------------------------------------------------

test("a sent quotation lapses the day after validUntil, not on it", () => {
  const q = { status: "SENT", validUntil: new Date("2026-10-05") };
  assert.deepEqual(quotationExpiry(q, "2026-10-04"), { validDay: "2026-10-05", daysLeft: 1, expired: false });
  assert.equal(quotationExpiry(q, "2026-10-05").expired, false, "valid through the whole of validUntil");
  assert.equal(quotationExpiry(q, "2026-10-05").daysLeft, 0);
  const late = quotationExpiry(q, "2026-10-06");
  assert.equal(late.expired, true);
  assert.equal(late.daysLeft, -1);
});

test("only a SENT quotation can lapse", () => {
  const past = new Date("2026-01-01");
  for (const status of ["DRAFT", "ACCEPTED", "REJECTED", "CONVERTED", "SUPERSEDED"]) {
    assert.equal(quotationExpiry({ status, validUntil: past }, "2026-10-06").expired, false, status);
  }
});

test("validity is read on the Dubai calendar, not by the server clock", () => {
  // 21:00 UTC on 5 Oct is already 6 Oct in Dubai (UTC+4), so a quotation valid to 5 Oct has lapsed.
  const q = { status: "SENT", validUntil: new Date("2026-10-05") };
  assert.equal(quotationExpiry(q, new Date("2026-10-05T21:00:00Z")).expired, true);
  assert.equal(quotationExpiry(q, new Date("2026-10-05T19:59:00Z")).expired, false);
});

test("a quotation with no validity never lapses", () => {
  assert.deepEqual(quotationExpiry({ status: "SENT" }, "2026-10-06"), { validDay: null, daysLeft: null, expired: false });
});

test("default validity is 30 days from the quotation date", () => {
  assert.equal(defaultValidUntil("2026-10-06"), "2026-11-05");
  assert.equal(defaultValidUntil("2026-12-20", 15), "2027-01-04");
});

test("revision numbers extend the base number and never stack suffixes", () => {
  assert.equal(baseNumber("QT-2026-0007"), "QT-2026-0007");
  assert.equal(baseNumber("QT-2026-0007-R2"), "QT-2026-0007");
  assert.equal(revisionNumber("QT-2026-0007", 1), "QT-2026-0007-R1");
  assert.equal(revisionNumber("QT-2026-0007-R1", 2), "QT-2026-0007-R2");
});

test("quotation and delivery actions start only from the states that make sense", () => {
  assert.deepEqual(QUOTATION_ACTIONS.send.from, ["DRAFT"]);
  assert.ok(!QUOTATION_ACTIONS.accept.from.includes("DRAFT"), "an unsent quotation cannot be accepted");
  assert.ok(QUOTATION_ACTIONS.reject.from.includes("ACCEPTED"), "a customer can withdraw after accepting");
  assert.ok(!DELIVERY_ACTIONS.cancel.from.includes("DELIVERED"), "a signed delivery is reversed by a return, not cancelled");
  assert.ok(DELIVERY_ACTIONS.deliver.from.includes("DRAFT"), "a counter hand-over skips the dispatch step");
});

// ---- fulfilment ---------------------------------------------------------------------------

const order = [{ _id: "a", qty: 10 }, { _id: "b", qty: 4 }];

test("fulfilment: nothing delivered leaves everything remaining", () => {
  const f = fulfilment(order, []);
  assert.deepEqual(f.a, { ordered: 10, pending: 0, delivered: 0, remaining: 10, over: false });
  assert.equal(f.b.remaining, 4);
});

test("fulfilment: notes still in the warehouse hold their whole quantity, delivered ones count what was accepted", () => {
  const f = fulfilment(order, [
    { sourceLineId: "a", status: "DRAFT", qty: 3 },
    { sourceLineId: "a", status: "DISPATCHED", qty: 2 },
    { sourceLineId: "a", status: "DELIVERED", qty: 4, deliveredQty: 3.5 }, // 0.5 refused at the door
  ]);
  assert.equal(f.a.pending, 5);
  assert.equal(f.a.delivered, 3.5);
  assert.equal(f.a.remaining, 1.5);
  assert.equal(f.a.over, false);
});

test("fulfilment: a cancelled note frees its quantity", () => {
  const f = fulfilment(order, [{ sourceLineId: "b", status: "CANCELLED", qty: 4 }]);
  assert.equal(f.b.remaining, 4);
  assert.equal(f.b.pending, 0);
});

test("fulfilment: delivering more than ordered is flagged and never goes negative", () => {
  const f = fulfilment(order, [{ sourceLineId: "b", status: "DELIVERED", qty: 5, deliveredQty: 5 }]);
  assert.equal(f.b.remaining, 0);
  assert.equal(f.b.over, true);
});

test("fulfilment: fractional quantities do not accumulate float error", () => {
  const f = fulfilment([{ _id: "x", qty: 1 }], [
    { sourceLineId: "x", status: "DELIVERED", qty: 0.1, deliveredQty: 0.1 },
    { sourceLineId: "x", status: "DELIVERED", qty: 0.2, deliveredQty: 0.2 },
  ]);
  assert.equal(f.x.delivered, 0.3);
  assert.equal(f.x.remaining, 0.7);
});

test("fulfilment: a line that is not on the order is ignored", () => {
  const f = fulfilment(order, [{ sourceLineId: "zzz", status: "DELIVERED", qty: 9, deliveredQty: 9 }]);
  assert.equal(f.a.delivered, 0);
});

// ---- confirming a delivery ----------------------------------------------------------------

const lines = [{ _id: "l1", qty: 10 }, { _id: "l2", qty: 5 }];

test("settleDelivery: no input means everything was delivered in full", () => {
  const r = settleDelivery(lines, []);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lines.map((l) => l.deliveredQty), [10, 5]);
});

test("settleDelivery: a short line needs a reason", () => {
  const r = settleDelivery(lines, [{ lineId: "l1", deliveredQty: 8 }]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /say why 2 was not delivered/);
  const ok = settleDelivery(lines, [{ lineId: "l1", deliveredQty: 8, shortReason: "2 cartons damaged" }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.lines[0].shortReason, "2 cartons damaged");
  assert.equal(ok.lines[1].shortReason, "", "a full line keeps no reason");
});

test("settleDelivery: more than was sent, or a negative quantity, is refused", () => {
  assert.match(settleDelivery(lines, [{ lineId: "l1", deliveredQty: 11 }]).errors[0].message, /more than the 10 sent/);
  assert.match(settleDelivery(lines, [{ lineId: "l1", deliveredQty: -1, shortReason: "x" }]).errors[0].message, /zero or more/);
  assert.match(settleDelivery(lines, [{ lineId: "l1", deliveredQty: "abc" }]).errors[0].message, /zero or more/);
});

test("settleDelivery: delivering nothing at all is refused", () => {
  const r = settleDelivery(lines, [
    { lineId: "l1", deliveredQty: 0, shortReason: "closed" },
    { lineId: "l2", deliveredQty: 0, shortReason: "closed" },
  ]);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /Cancel the delivery note/);
});

test("settleDelivery: one refused line is allowed while another is delivered", () => {
  const r = settleDelivery(lines, [{ lineId: "l1", deliveredQty: 0, shortReason: "customer did not want it" }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lines.map((l) => l.deliveredQty), [0, 5]);
});

// ---- the 14-day invoice clock -------------------------------------------------------------

test("lastDayOfMonth handles 30/31-day months, February and a leap year", () => {
  assert.equal(lastDayOfMonth("2026-10-06"), "2026-10-31");
  assert.equal(lastDayOfMonth("2026-09-30"), "2026-09-30");
  assert.equal(lastDayOfMonth("2026-02-10"), "2026-02-28");
  assert.equal(lastDayOfMonth("2028-02-10"), "2028-02-29");
  assert.equal(lastDayOfMonth("2026-12-05"), "2026-12-31");
});

test("invoice clock: standard deadline is 14 days after delivery", () => {
  const c = invoiceClock("2026-10-01", "2026-10-06");
  assert.equal(c.deliveredDay, "2026-10-01");
  assert.equal(c.standardDue, "2026-10-15");
  assert.equal(c.daysSince, 5);
  assert.equal(c.daysToStandard, 9);
  assert.equal(c.clock, "within");
});

test("invoice clock: a summary invoice runs to 14 days after the end of the month", () => {
  const c = invoiceClock("2026-10-01", "2026-10-06");
  assert.equal(c.summaryDue, "2026-11-14");
});

test("invoice clock walks through its four states", () => {
  const at = (today) => invoiceClock("2026-10-01", today).clock;
  assert.equal(at("2026-10-11"), "within"); // 4 days left
  assert.equal(at("2026-10-12"), "dueSoon"); // 3 days left
  assert.equal(at("2026-10-15"), "dueSoon"); // the last day
  assert.equal(at("2026-10-16"), "pastStandard"); // 14 days gone, summary invoice still in time
  assert.equal(at("2026-11-14"), "pastStandard"); // the last day for a summary invoice
  assert.equal(at("2026-11-15"), "overdue");
});

test("invoice clock: the delivery day is the Dubai day, so a late-evening UTC time can be tomorrow", () => {
  // 21:00 UTC on 30 Sep is 01:00 on 1 Oct in Dubai.
  const c = invoiceClock(new Date("2026-09-30T21:00:00Z"), "2026-10-06");
  assert.equal(c.deliveredDay, "2026-10-01");
  assert.equal(c.standardDue, "2026-10-15");
});

test("invoice clock: a delivery late in the month still gets the next month's 14 days", () => {
  const c = invoiceClock("2026-12-30", "2027-01-05");
  assert.equal(c.standardDue, "2027-01-13");
  assert.equal(c.summaryDue, "2027-01-14");
});

test("invoice clock: an unreadable date gives nothing", () => {
  assert.equal(invoiceClock("not a date", "2026-10-06"), null);
  assert.equal(invoiceClock(undefined, "2026-10-06"), null);
});
