const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../chequeReports");

const TODAY = "2026-10-26";
let n = 0;
const row = (o = {}) => ({ _id: `r${++n}`, direction: "receipt", status: "pending", chequeNo: `${n}`, chequeDay: "2026-10-29", partyId: "p1", partyName: "Al Noor", bankAccountId: "b1", bankName: "ENBD", amount: 100, voucherNo: "RV-1", ...o });

test("the buckets, at every edge", () => {
  const at = (d) => R.bucketOf(d);
  assert.deepEqual([-1, 0, 1, 7, 8, 30, 31, 90, 91].map(at), ["overdue", "today", "week", "week", "month", "month", "quarter", "quarter", "later"]);
  assert.deepEqual(R.BUCKETS.map((b) => b.key), ["overdue", "today", "week", "month", "quarter", "later"]);
});

test("the maturity report groups by bucket in the order a person plans, with the three kinds of money kept apart", () => {
  const rows = [
    row({ chequeDay: "2026-10-20", amount: 50 }), row({ chequeDay: "2026-10-26", status: "hold", amount: 70 }), row({ chequeDay: "2026-10-29" }),
    row({ direction: "payment", chequeDay: "2026-11-20", amount: 30 }), row({ chequeDay: "2027-03-01", amount: 5 }),
  ];
  const m = R.maturity(rows, TODAY);
  assert.deepEqual(m.groups.map((g) => g.key), ["overdue", "today", "week", "month", "later"]);
  const g = Object.fromEntries(m.groups.map((x) => [x.key, x]));
  assert.deepEqual([g.overdue.receivable.amount, g.overdue.payable.amount, g.overdue.onHold.amount], [50, 0, 0]);
  assert.deepEqual([g.today.receivable.amount, g.today.onHold.amount], [0, 70], "a cheque on hold is NOT expected money");
  assert.equal(g.month.payable.amount, 30);
  assert.equal(m.totals.receivable.amount, 155);
  assert.equal(m.totals.net, 125, "coming in less going out; hold is not in it");
  assert.equal(m.totals.onHold.amount, 70);
});

test("every cheque lands in exactly one group, whatever the grouping: nothing lost, nothing counted twice", () => {
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(row({
      direction: i % 3 ? "receipt" : "payment", status: ["pending", "hold", "deposited"][i % 3], amount: 10 + i,
      chequeDay: `2026-${String(10 + (i % 4)).padStart(2, "0")}-${String(1 + (i % 27)).padStart(2, "0")}`,
      partyId: `p${i % 5}`, partyName: `Party ${i % 5}`, bankAccountId: `b${i % 2}`, bankName: `Bank ${i % 2}`,
    }));
  }
  for (const by of R.GROUPINGS) {
    const m = R.maturity(rows, TODAY, { groupBy: by });
    const count = (k) => m.groups.reduce((t, g) => t + g[k].count, 0);
    assert.equal(count("receivable") + count("payable") + count("onHold"), rows.length, `${by}: every cheque once`);
    assert.equal(m.rows.length, rows.length);
    const total = m.groups.reduce((t, g) => t + g.receivable.amount + g.payable.amount + g.onHold.amount, 0);
    assert.ok(Math.abs(total - rows.reduce((t, r) => t + r.amount, 0)) < 0.005, `${by}: the amounts add up`);
    assert.equal(m.totals.receivable.count + m.totals.payable.count + m.totals.onHold.count, rows.length);
  }
});

test("by party, bank and month; an unknown grouping falls back to bucket; the detail is nearest first", () => {
  const rows = [row({ partyId: "a", partyName: "Small", amount: 10 }), row({ partyId: "b", partyName: "Big", amount: 900 }), row({ partyId: "a", partyName: "Small", amount: 5, chequeDay: "2026-11-05" })];
  assert.deepEqual(R.maturity(rows, TODAY, { groupBy: "party" }).groups.map((g) => g.label), ["Big", "Small"], "biggest first");
  assert.deepEqual(R.maturity(rows, TODAY, { groupBy: "month" }).groups.map((g) => g.key), ["2026-10", "2026-11"]);
  assert.equal(R.maturity(rows, TODAY, { groupBy: "bank" }).groups[0].label, "ENBD");
  assert.equal(R.maturity(rows, TODAY, { groupBy: "nonsense" }).groupBy, "bucket");
  assert.deepEqual(R.maturity(rows, TODAY).rows.map((r) => r.days), [3, 3, 10]);
});

test("cheques at the bank are counted apart, and an empty register is empty, not an error", () => {
  const m = R.maturity([row({ status: "deposited", amount: 40 }), row()], TODAY);
  assert.deepEqual(m.atBank, { count: 1, amount: 40 });
  const none = R.maturity([], TODAY);
  assert.deepEqual([none.groups, none.rows, none.totals.net], [[], [], 0]);
});

test("forward periods: rolling weeks, calendar months with a part first month, and the year turning over", () => {
  const w = R.forwardPeriods(TODAY, "week", 3);
  assert.deepEqual(w.map((p) => [p.from, p.to]), [["2026-10-26", "2026-11-01"], ["2026-11-02", "2026-11-08"], ["2026-11-09", "2026-11-15"]]);
  assert.equal(w[0].label, "26 Oct - 1 Nov");
  const m = R.forwardPeriods("2026-11-20", "month", 3);
  assert.deepEqual(m.map((p) => [p.from, p.to]), [["2026-11-20", "2026-11-30"], ["2026-12-01", "2026-12-31"], ["2027-01-01", "2027-01-31"]]);
  assert.equal(R.forwardPeriods("2028-02-10", "month", 1)[0].to, "2028-02-29", "a leap February");
  assert.equal(R.forwardPeriods(TODAY, "week", 0).length, 12, "no count: the default");
  assert.equal(R.forwardPeriods(TODAY, "week", 999).length, 52, "capped at a year");
});

test("forward: cheques already due come off the opening balance first, then each period adds its net", () => {
  const rows = [
    row({ chequeDay: "2026-10-20", amount: 200 }),                       // a customer's, already due: assumed to clear at once
    row({ direction: "payment", chequeDay: "2026-10-22", amount: 50 }),   // ours, already due: the bank may pay it any day
    row({ chequeDay: "2026-10-28", amount: 1000 }),                       // week 1
    row({ direction: "payment", chequeDay: "2026-10-30", amount: 400 }),  // week 1
    row({ chequeDay: "2026-11-05", amount: 300 }),                        // week 2
  ];
  const f = R.forward(rows, TODAY, { unit: "week", count: 3, opening: 5000 });
  assert.equal(f.due.net, 150);
  assert.equal(f.afterDue, 5150);
  assert.deepEqual(f.periods.map((p) => [p.receipts.amount, p.payments.amount, p.net, p.closing]), [[1000, 400, 600, 5750], [300, 0, 300, 6050], [0, 0, 0, 6050]]);
  assert.equal(f.totals.closing, 6050);
});

test("forward: a held cheque is shown beside the plan, never in it", () => {
  const f = R.forward([row({ chequeDay: "2026-10-28", amount: 1000 }), row({ chequeDay: "2026-10-28", status: "hold", amount: 777 })], TODAY, { count: 1, opening: 0 });
  assert.equal(f.periods[0].receipts.amount, 1000);
  assert.equal(f.periods[0].onHold.amount, 777);
  assert.equal(f.periods[0].closing, 1000, "the held 777 is not counted on");
  assert.equal(f.totals.onHold, 777);
});

test("forward: a cheque at the bank still counts on its date; one beyond the last period is 'later'", () => {
  const f = R.forward([row({ status: "deposited", chequeDay: "2026-10-27", amount: 90 }), row({ chequeDay: "2027-06-01", amount: 25 })], TODAY, { count: 2, opening: 10 });
  assert.equal(f.periods[0].receipts.amount, 90);
  assert.equal(f.later.receipts.amount, 25);
  assert.equal(f.totals.closing, 125, "opening 10 + 90 + the 25 beyond the window");
  assert.equal(f.periods.at(-1).closing, 100, "but the last period's own balance stops short of it");
});

test("forward: nothing is lost between the periods, the days already due and the days beyond - whatever the window", () => {
  const rows = [];
  for (let i = 0; i < 80; i += 1) rows.push(row({ direction: i % 2 ? "receipt" : "payment", status: i % 7 ? "pending" : "hold", amount: 5 + i, chequeDay: R.forwardPeriods("2026-09-01", "week", 40)[i % 40].from }));
  for (const [unit, count] of [["week", 4], ["week", 12], ["month", 3], ["month", 12]]) {
    const f = R.forward(rows, TODAY, { unit, count, opening: 1000 });
    const count_ = (k) => f.due[k].count + f.later[k].count + f.periods.reduce((t, p) => t + p[k].count, 0);
    assert.equal(count_("receipts") + count_("payments") + count_("onHold"), rows.length, `${unit} x ${count}`);
    const expected = rows.filter((r) => r.status !== "hold").reduce((t, r) => t + (r.direction === "receipt" ? r.amount : -r.amount), 0);
    assert.ok(Math.abs(f.totals.closing - (1000 + expected)) < 0.005, `${unit} x ${count}: closing = opening + every non-held cheque`);
  }
});

test("forward: floating-point money does not drift", () => {
  const rows = Array.from({ length: 10 }, () => row({ chequeDay: "2026-10-28", amount: 0.1 }));
  assert.equal(R.forward(rows, TODAY, { count: 1 }).periods[0].receipts.amount, 1, "ten times 0.10 is 1.00, not 0.9999999999999999");
});
