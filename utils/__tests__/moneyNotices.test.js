// What the notification feed says about money owed, bills falling due and paper running out (utils/moneyNotices.js). Pure.
//   node --test utils/__tests__/moneyNotices.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const n = require("../moneyNotices");

const TODAY = "2026-11-21"; // a Saturday

test("a weekly notice is keyed on the Monday of its week", () => {
  assert.equal(n.weekKey("2026-11-16"), "2026-11-16", "a Monday is its own week");
  assert.equal(n.weekKey("2026-11-21"), "2026-11-16", "a Saturday");
  assert.equal(n.weekKey("2026-11-22"), "2026-11-16", "a Sunday belongs to the week that is ending, not the one starting");
  assert.equal(n.weekKey("2026-11-23"), "2026-11-23");
  assert.equal(n.weekKey("2027-01-01"), "2026-12-28", "across a year end");
  assert.equal(n.weekKey("2026-03-01"), "2026-02-23", "across a month end");
  assert.equal(n.weekKey("soon"), null);
  assert.equal(n.weekKey(undefined), null);
});

// ---- customer invoices ----------------------------------------------------------------------------------------------------------
const inv = (partyId, outstanding, dueDay) => ({ partyId, partyName: `Customer ${partyId}`, outstanding, dueDay });

test("overdue invoices are counted, summed and aged, in one notice", () => {
  const notice = n.overdueReceivables([inv("a", 100, "2026-11-16"), inv("a", 250.5, "2026-11-11"), inv("b", 49.5, "2026-11-19")], TODAY, { currency: "AED" });
  assert.equal(notice.severity, "warning");
  assert.equal(notice.title, "3 invoices overdue: AED 400.00 owed by 2 customers");
  assert.match(notice.body, /The oldest is 10 days past its due date/);
});

test("an invoice due today, or later, or with no due day, is not overdue yet", () => {
  assert.equal(n.overdueReceivables([inv("a", 100, TODAY), inv("a", 100, "2026-11-30"), inv("b", 100, null), inv("c", 100, undefined)], TODAY), null);
  assert.equal(n.overdueReceivables([], TODAY), null);
  assert.equal(n.overdueReceivables(undefined, TODAY), null);
  const one = n.overdueReceivables([inv("a", 100, "2026-11-20")], TODAY, { currency: "AED" });
  assert.equal(one.title, "1 invoice overdue: AED 100.00 owed by 1 customer");
  assert.match(one.body, /oldest is 1 day past/);
});

test("it turns critical once the oldest is more than 60 days late, and not before", () => {
  assert.equal(n.overdueReceivables([inv("a", 1, "2026-09-22")], TODAY).severity, "warning", "60 days late");
  assert.equal(n.overdueReceivables([inv("a", 1, "2026-09-21")], TODAY).severity, "critical", "61 days late");
  assert.equal(n.overdueReceivables([inv("a", 1, "2026-09-21")], TODAY, { seriousDays: 90 }).severity, "warning");
});

test("a money notice names nobody: the audience may see sales, not every customer's balance", () => {
  const notice = n.overdueReceivables([inv("a", 100, "2026-11-01")], TODAY, { currency: "AED" });
  assert.ok(!`${notice.title} ${notice.body}`.includes("Customer a"));
});

// ---- supplier bills -------------------------------------------------------------------------------------------------------------
const bill = (outstanding, dueDay) => ({ partyId: "v", outstanding, dueDay });

test("supplier bills: the overdue and those falling due this week, each with its sum", () => {
  const notice = n.payablesDue([bill(500, "2026-11-10"), bill(120, TODAY), bill(80, "2026-11-28"), bill(999, "2026-11-29")], TODAY, { currency: "AED" });
  assert.equal(notice.severity, "warning");
  assert.equal(notice.title, "Supplier bills: 1 overdue (AED 500.00), 2 due within 7 days (AED 200.00)");
  assert.match(notice.body, /Pay the overdue ones first/);
});

test("bills only falling due are information, and a bill more than a week away is not told", () => {
  const notice = n.payablesDue([bill(80, "2026-11-25")], TODAY, { currency: "AED" });
  assert.equal(notice.severity, "info");
  assert.equal(notice.title, "Supplier bills: 1 due within 7 days (AED 80.00)");
  assert.equal(n.payablesDue([bill(80, "2026-11-29")], TODAY), null, "8 days away");
  assert.equal(n.payablesDue([bill(80, "2026-11-28")], TODAY).severity, "info", "7 days away is told");
  assert.equal(n.payablesDue([], TODAY), null);
});

// ---- documents ------------------------------------------------------------------------------------------------------------------
const doc = (partyName, documentType, daysLeft, expiryDate) => ({ partyName, documentType, daysLeft, expiryDate });

test("a customer's or supplier's documents are named, three at most, soonest first", () => {
  const result = { rows: [doc("Al Noor Trading", "Trade licence", -3, "2026-11-18"), doc("Gulf Foods", "Tax certificate", 4, "2026-11-25"), doc("Delta Oils", "Visa", 10, "2026-12-01"), doc("Mina Foods", "Licence", 20, "2026-12-11")] };
  const notice = n.documentsExpiring(result, "customer");
  assert.equal(notice.severity, "warning", "one has already expired");
  assert.equal(notice.title, "Customer documents: 1 expired, 3 expiring within 30 days");
  assert.equal(notice.body, "Trade licence of Al Noor Trading (expired 3 days ago); Tax certificate of Gulf Foods (4 days left); Visa of Delta Oils (10 days left); and 1 more.");
  assert.equal(n.documentsExpiring(result, "vendor").title.startsWith("Supplier documents:"), true);
});

test("an employee's documents are counted and dated, never named", () => {
  const result = { rows: [doc("Ali Driver", "Passport", -2, "2026-11-19"), doc("Sami Cook", "Visa", 9, "2026-11-30")] };
  const notice = n.documentsExpiring(result, "staff");
  assert.equal(notice.title, "Staff documents: 1 expired, 1 expiring within 30 days");
  assert.equal(notice.body, "The oldest ran out on 2026-11-19.");
  assert.ok(!JSON.stringify(notice).includes("Ali") && !JSON.stringify(notice).includes("Passport"));
  const soonOnly = n.documentsExpiring({ rows: [doc("Sami Cook", "Visa", 9, "2026-11-30")] }, "staff");
  assert.equal(soonOnly.severity, "info");
  assert.equal(soonOnly.body, "The next runs out on 2026-11-30.");
});

test("no documents, no notice", () => {
  assert.equal(n.documentsExpiring({ rows: [] }, "customer"), null);
  assert.equal(n.documentsExpiring(undefined, "staff"), null);
});

// ---- batches --------------------------------------------------------------------------------------------------------------------
const batch = (itemName, qtyOnHand, daysToExpiry, expired = false) => ({ itemName, qtyOnHand, daysToExpiry, expired, expiryDate: "2026-12-01" });

test("batches: expired and expiring, named three at a time", () => {
  const notice = n.batchesExpiring([batch("Yoghurt", 40, -2, true), batch("Milk", 120, 3), batch("Cheese", 15, 0), batch("Butter", 8, 20)]);
  assert.equal(notice.severity, "warning");
  assert.equal(notice.title, "Batches: 1 expired, 3 expiring within 30 days");
  assert.equal(notice.body, "Yoghurt, 40 left (expired); Milk, 120 left (3 days left); Cheese, 15 left (expires today); and 1 more.");
  assert.equal(n.batchesExpiring([batch("Milk", 5, 3)]).severity, "info");
  assert.equal(n.batchesExpiring([]), null);
});

test("a full page of batches says so rather than quoting a count that stops at the page size", () => {
  const many = Array.from({ length: 500 }, (_, i) => batch(`Item ${i}`, 1, 5));
  assert.equal(n.batchesExpiring(many, { cap: 500 }).title, "Batches: 500 or more expired or expiring within 30 days");
});

// ---- e-invoices -----------------------------------------------------------------------------------------------------------------
test("e-invoices that need a person: rejected, or failed with no retry left; a failure that retries by itself is not told", () => {
  const retrying = { status: "FAILED", nextRetryAt: new Date() };
  assert.equal(n.einvoiceAttention([retrying]), null, "it will be tried again without anybody");
  assert.equal(n.einvoiceAttention([]), null);
  const given = n.einvoiceAttention([{ status: "FAILED", nextRetryAt: null }, retrying]);
  assert.equal(given.severity, "warning");
  assert.equal(given.title, "1 e-invoice needs attention");
  assert.match(given.body, /1 failed and will not be tried again on their own/);

  const both = n.einvoiceAttention([{ status: "REJECTED", rejectedBy: "fta" }, { status: "REJECTED", rejectedBy: "buyer" }, { status: "REJECTED", rejectedBy: null }, { status: "FAILED", nextRetryAt: null }]);
  assert.equal(both.severity, "critical", "rejected by the tax authority is the serious one");
  assert.equal(both.title, "4 e-invoices need attention");
  assert.match(both.body, /1 rejected by the tax authority, 2 rejected by the buyer, 1 failed/);
});

test("needsAttention is the one rule the service and the notice share", () => {
  assert.equal(n.needsAttention({ status: "REJECTED" }), true);
  assert.equal(n.needsAttention({ status: "FAILED", nextRetryAt: null }), true);
  assert.equal(n.needsAttention({ status: "FAILED", nextRetryAt: new Date() }), false);
  assert.equal(n.needsAttention({ status: "SUBMITTED" }), false);
  assert.equal(n.needsAttention(undefined), false);
});
