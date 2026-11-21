const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../einvoiceDashboard");

test("delivery leg reads Wafeq's own words, and the built-in sandbox's status", () => {
  const L = (deliveryStatus, extra = {}) => d.deliveryLeg({ status: "ACKNOWLEDGED", deliveryStatus, ...extra });
  for (const s of ["sent", "received_by_ap", "forwarded", "delivered_confirmed", "delivered"]) assert.equal(L(s), "delivered");
  for (const s of ["queued", "sending", "retrying"]) assert.equal(L(s), "inProgress");
  assert.equal(L("rejected", { status: "REJECTED" }), "rejected");
  assert.equal(L("failed"), "failed");
  assert.equal(L("attention_required"), "failed");
  assert.equal(L("not_applicable", { route: "reporting_only" }), "ftaOnly");
  assert.equal(d.deliveryLeg({ status: "ACKNOWLEDGED" }), "delivered");
  assert.equal(d.deliveryLeg({ status: "SUBMITTED" }), "inProgress");
  assert.equal(d.deliveryLeg({ status: "QUEUED" }), "pending");
});

test("FTA leg: sandbox never reports, and that is not a failure", () => {
  assert.equal(d.ftaLeg({ status: "ACKNOWLEDGED", taxStatus: "not_reported" }), "notReported");
  assert.equal(d.ftaLeg({ status: "REPORTED", taxStatus: "reported" }), "reported");
  assert.equal(d.ftaLeg({ status: "ACKNOWLEDGED", taxStatus: "reporting" }), "reporting");
  assert.equal(d.ftaLeg({ status: "REJECTED", taxStatus: "rejected", rejectedBy: "fta" }), "rejected");
  assert.equal(d.ftaLeg({ status: "REJECTED", taxStatus: "withdrawn", rejectedBy: "buyer" }), "withdrawn");
  assert.equal(d.ftaLeg({ status: "FAILED" }), "pending");
});

test("totals split invoices from credit notes and net them", () => {
  const t = d.totalsByType([
    { status: "REPORTED", invoiceTypeCode: "380", totals: { net: 100, tax: 5, payable: 105 } },
    { status: "ACKNOWLEDGED", invoiceTypeCode: "380", totals: { net: 50, tax: 2.5, payable: 52.5 } },
    { status: "ACKNOWLEDGED", invoiceTypeCode: "381", totals: { net: 20, tax: 1, payable: 21 } },
    { status: "FAILED", invoiceTypeCode: "380", totals: { net: 999, tax: 9, payable: 1008 } },
  ]);
  assert.equal(t.invoices.count, 2); assert.equal(t.invoices.payable, 157.5);
  assert.equal(t.creditNotes.count, 1);
  assert.deepEqual(t.net, { net: 130, tax: 6.5, payable: 136.5 });
});

test("months run oldest first across a year end, quiet months present", () => {
  assert.deepEqual(d.lastMonths("2026-02-10", 4), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  const m = d.monthly(["2026-01", "2026-02"], { "2026-02": { count: 2, amount: 10.456 } }, {});
  assert.deepEqual(m[0], { month: "2026-01", sent: 0, sentAmount: 0, received: 0, receivedAmount: 0 });
  assert.equal(m[1].sentAmount, 10.46);
});

test("attention names the right action", () => {
  assert.equal(d.attentionOf({ status: "FAILED", lastError: "x" }).action, "retry");
  assert.equal(d.attentionOf({ status: "REJECTED", rejectedBy: "buyer", deliveryReasonCode: "BV" }).action, "correct");
  assert.equal(d.attentionOf({ status: "REJECTED", rejectedBy: "buyer", deliveryReasonCode: "FD" }).action, "credit_note");
  assert.equal(d.attentionOf({ status: "REJECTED", rejectedBy: "fta", deliveryReasonCode: "BV" }).action, "credit_note");
  assert.equal(d.attentionOf({ status: "REPORTED" }), null);
});

test("stuck means sent and unanswered for more than a day", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  assert.equal(d.isStuck({ status: "SUBMITTED", submittedAt: "2026-11-20T10:00:00Z" }, now), true);
  assert.equal(d.isStuck({ status: "SUBMITTED", submittedAt: "2026-11-21T10:00:00Z" }, now), false);
  assert.equal(d.isStuck({ status: "ACKNOWLEDGED", submittedAt: "2026-11-01T10:00:00Z" }, now), false);
});

test("todo tiles link to a filtered list; profile mismatch compares TRN by digits and name loosely", () => {
  const t = d.todoItems({ failed: 2 });
  assert.equal(t.find((x) => x.key === "failed").link, "/e-invoicing/outbound?status=FAILED");
  assert.equal(t.length, 8);
  assert.deepEqual(d.profileMismatches({ vatNumber: "171686550400003", legalName: "Acme LLC" }, { trn: "1716 8655 0400 003", name: "ACME, LLC" }), []);
  assert.equal(d.profileMismatches({ vatNumber: "1", legalName: "A" }, { trn: "2", name: "B" }).length, 2);
});

test("the period compared with is the same days of the month before, or the same length just before", () => {
  assert.deepEqual(d.previousRange("2026-11-01", "2026-11-21"), { from: "2026-10-01", to: "2026-10-21" });
  assert.deepEqual(d.previousRange("2026-03-01", "2026-03-31"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(d.previousRange("2026-01-01", "2026-01-31"), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(d.previousRange("2026-04-10", "2026-04-19"), { from: "2026-03-31", to: "2026-04-09" });
  assert.equal(d.change(150, 100), 50);
  assert.equal(d.change(50, 100), -50);
  assert.equal(d.change(5, 0), null);
});
