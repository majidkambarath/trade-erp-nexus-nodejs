const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../periodClose");
const Y = require("../yearEnd");

// ----------------------------------------------------------------------------- the months of a year

test("a calendar year has twelve months, each with its own first and last day", () => {
  const months = P.monthsOf("2026-01-01", "2026-12-31");
  assert.equal(months.length, 12);
  assert.deepEqual(months[0], { key: "2026-01", label: "January 2026", startDay: "2026-01-01", endDay: "2026-01-31" });
  assert.deepEqual(months[1], { key: "2026-02", label: "February 2026", startDay: "2026-02-01", endDay: "2026-02-28" });
  assert.equal(months[11].endDay, "2026-12-31");
  assert.equal(P.monthsOf("2028-01-01", "2028-12-31")[1].endDay, "2028-02-29", "a leap year");
});

test("a year that runs April to March, or starts or ends mid-month, is cut into the months it touches", () => {
  const fy = P.monthsOf("2025-04-01", "2026-03-31");
  assert.deepEqual([fy[0].key, fy[8].key, fy[11].key], ["2025-04", "2025-12", "2026-03"]);
  assert.equal(fy.length, 12);
  const odd = P.monthsOf("2026-01-15", "2026-03-10");
  assert.deepEqual(odd.map((m) => [m.key, m.startDay, m.endDay]), [
    ["2026-01", "2026-01-15", "2026-01-31"], ["2026-02", "2026-02-01", "2026-02-28"], ["2026-03", "2026-03-01", "2026-03-10"],
  ]);
  assert.equal(P.monthsOf("2026-05-05", "2026-05-20").length, 1, "inside one month");
  assert.deepEqual(P.monthsOf("2026-12-31", "2026-01-01"), [], "an upside-down year has no months");
  assert.deepEqual(P.monthsOf("", "2026-12-31"), []);
  assert.equal(P.monthsOf("2026-01-01", "2126-01-01").length, 120, "a nonsense range stops at a cap");
});

test("a month is found by its key", () => {
  const year = { startDay: "2026-01-01", endDay: "2026-12-31" };
  assert.equal(P.findMonth(year, "2026-08").label, "August 2026");
  assert.equal(P.findMonth(year, "2027-01"), null);
  assert.equal(P.findMonth(year, "nonsense"), null);
});

// ----------------------------------------------------------------------------- locks and states

const YEAR = { code: "2026", status: "open", startDay: "2026-01-01", endDay: "2026-12-31", lockedThroughDay: null, monthCloses: [] };
const lockedTo = (day, over = {}) => ({ ...YEAR, lockedThroughDay: day, ...over });

test("a day is behind the month lock when it is on or before the locked-through day", () => {
  assert.equal(P.monthLocked(YEAR, "2026-01-01"), false, "no lock at all");
  assert.equal(P.monthLocked(lockedTo("2026-08-31"), "2026-08-31"), true, "the last day itself is locked");
  assert.equal(P.monthLocked(lockedTo("2026-08-31"), "2026-09-01"), false);
  assert.equal(P.monthLocked(lockedTo("2026-08-31"), "2026-01-01"), true);
  assert.equal(P.lockedMessage("2026-08-31"), "Posting is closed up to 31 Aug 2026");
});

test("a year is locked by whichever lock reaches further, and the month lock survives the year being closed", () => {
  assert.equal(P.lockedDayOf(YEAR), null);
  assert.equal(P.lockedDayOf(lockedTo("2026-03-31")), "2026-03-31");
  assert.equal(P.lockedDayOf(lockedTo("2026-03-31", { status: "closed" })), "2026-12-31", "a closed year is locked as a whole");
  assert.equal(P.fullyLocked(lockedTo("2026-12-31")), true, "every month closed");
  assert.equal(P.fullyLocked(lockedTo("2026-11-30")), false);
  assert.equal(P.fullyLocked({ ...YEAR, status: "closed" }), true);
  assert.equal(P.anyLocked(YEAR), false);
  assert.equal(P.anyLocked(lockedTo("2026-01-31")), true);
  assert.equal(P.anyLocked({ ...YEAR, status: "closed" }), true);
});

test("months say where they stand, which one may be closed next and which one reopened", () => {
  const none = P.monthStates(YEAR);
  assert.equal(none.every((m) => m.status === "open"), true);
  assert.deepEqual(none.filter((m) => m.canClose).map((m) => m.key), ["2026-01"], "only the first");
  assert.equal(none.some((m) => m.canReopen), false);

  const some = P.monthStates(lockedTo("2026-03-31", { monthCloses: [{ month: "2026-03", closedAt: "2026-04-02T08:00:00Z", closedByName: "Mariam" }] }));
  assert.deepEqual(some.map((m) => m.status).slice(0, 5), ["closed", "closed", "closed", "open", "open"]);
  assert.deepEqual(some.filter((m) => m.canClose).map((m) => m.key), ["2026-04"], "the next one in order");
  assert.deepEqual(some.filter((m) => m.canReopen).map((m) => m.key), ["2026-03"], "the latest closed one");
  assert.equal(some[2].closedBy, "Mariam");
  assert.equal(some[2].closedAt, "2026-04-02T08:00:00Z");
  assert.equal(some[0].closedBy, null, "no record is kept for a month closed some other way");

  const all = P.monthStates(lockedTo("2026-12-31"));
  assert.equal(all.every((m) => m.status === "closed"), true);
  assert.equal(all.some((m) => m.canClose), false, "nothing left to close");
});

test("in a closed year the months are locked with it, offer no buttons, and keep the months that were closed before", () => {
  const states = P.monthStates(lockedTo("2026-02-28", { status: "closed" }));
  assert.deepEqual(states.slice(0, 4).map((m) => m.status), ["closed", "closed", "yearClosed", "yearClosed"]);
  assert.equal(states.some((m) => m.canClose || m.canReopen), false);
});

// ----------------------------------------------------------------------------- closing a month

const MARCH = P.findMonth(YEAR, "2026-03");
const JAN = P.findMonth(YEAR, "2026-01");
const facts = (over = {}) => ({
  year: { ...YEAR }, month: JAN, today: "2026-12-31", allBranches: true, earlierYears: [], laterYears: [],
  unfinished: { documents: 0, vouchers: 0 }, outOfBalance: [], postingEnabled: true, banks: [], currency: "AED", ...over,
});
const codes = (a) => a.checks.map((c) => c.code);

test("a month with nothing against it may be closed, and every check says so", () => {
  const a = P.assessMonthClose(facts());
  assert.equal(a.canClose, true);
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(codes(a), ["ALL_BRANCHES", "EARLIER_MONTHS_CLOSED", "DOCUMENTS_FINISHED", "LEDGER_BALANCED"]);
  assert.match(a.checks[3].title, /up to 31 Jan 2026/);
});

test("months are closed in order: an earlier month still open stops this one, and the first one is named", () => {
  const a = P.assessMonthClose(facts({ month: MARCH }));
  assert.equal(a.canClose, false);
  assert.deepEqual(a.blockers.map((b) => b.code), ["EARLIER_MONTH_OPEN"]);
  assert.equal(a.blockers[0].title, "Close January 2026 first");
  const next = P.assessMonthClose(facts({ month: MARCH, year: lockedTo("2026-02-28") }));
  assert.equal(next.canClose, true, "once January and February are closed, March is next");
});

test("an earlier year that is not locked to its end stops the first month of the next", () => {
  const a = P.assessMonthClose(facts({ earlierYears: ["2025"] }));
  assert.deepEqual(a.blockers.map((b) => b.code), ["EARLIER_YEAR_OPEN"]);
  assert.match(a.blockers[0].title, /Finish closing 2025 first/);
  assert.equal(P.assessMonthClose(facts({ earlierYears: ["2024", "2025"] })).blockers[0].title, "Finish closing 2024, 2025 first");
});

test("drafts and pending vouchers dated in the month stop it, and are counted", () => {
  const a = P.assessMonthClose(facts({ unfinished: { documents: 2, vouchers: 1 } }));
  assert.deepEqual(a.blockers.map((b) => b.code), ["UNFINISHED_DOCUMENTS"]);
  assert.equal(a.blockers[0].title, "2 documents and 1 voucher dated in January 2026 are not approved");
  assert.equal(a.blockers[0].documents, 2);
  assert.match(P.assessMonthClose(facts({ unfinished: { documents: 1, vouchers: 0 } })).blockers[0].title, /^1 document dated in January 2026 is not approved$/);
});

test("a ledger that does not balance up to the month end stops it, branch by branch", () => {
  const a = P.assessMonthClose(facts({ outOfBalance: [{ branchId: "main", difference: -5 }, { branchId: "shj", difference: 12.5 }] }));
  assert.deepEqual(a.blockers.map((b) => b.code), ["LEDGER_OUT_OF_BALANCE"]);
  assert.match(a.blockers[0].detail, /Head office: debits and credits differ by AED 5\.00 up to 31 Jan 2026; shj: .* AED 12\.50/);
});

test("closing from one branch's view is refused: the lock covers every branch", () => {
  const a = P.assessMonthClose(facts({ allBranches: false }));
  assert.deepEqual(a.blockers.map((b) => b.code), ["ALL_BRANCHES_REQUIRED"]);
});

test("a month that has not ended, posting switched off and unreconciled banks are warnings the person ticks by name", () => {
  const a = P.assessMonthClose(facts({
    today: "2026-01-31", postingEnabled: false,
    banks: [{ accountName: "ENBD", reconciledTo: "2025-12-31" }, { accountName: "Mashreq", reconciledTo: null }, { accountName: "RAK", reconciledTo: "2026-01-31" }],
  }));
  assert.equal(a.canClose, true, "none of these blocks");
  assert.deepEqual(a.warnings.map((w) => w.code), ["POSTING_OFF", "MONTH_NOT_ENDED", "BANK_NOT_RECONCILED"]);
  assert.equal(a.warnings[1].title, "January 2026 has not ended", "today is its last day, so it is still running");
  assert.match(a.warnings[2].title, /2 bank accounts are not reconciled to 31 Jan 2026/);
  assert.match(a.warnings[2].detail, /ENBD \(to 31 Dec 2025\); Mashreq \(never reconciled\)/);
  assert.deepEqual(a.warnings[2].accounts, ["ENBD", "Mashreq"]);
  assert.deepEqual(Y.unacknowledged(a, ["POSTING_OFF"]).map((w) => w.code), ["MONTH_NOT_ENDED", "BANK_NOT_RECONCILED"]);
  assert.deepEqual(Y.unacknowledged(a, ["POSTING_OFF", "MONTH_NOT_ENDED", "BANK_NOT_RECONCILED"]), []);
  assert.equal(P.assessMonthClose(facts({ today: "2026-02-01" })).warnings.length, 0, "the day after, it has ended");
});

test("a month that is already closed, or in a closed year, or not in the year, has one answer", () => {
  assert.deepEqual(codes(P.assessMonthClose(facts({ year: lockedTo("2026-01-31") }))), ["ALREADY_CLOSED"]);
  assert.deepEqual(codes(P.assessMonthClose(facts({ year: { ...YEAR, status: "closed" } }))), ["YEAR_CLOSED"]);
  assert.deepEqual(codes(P.assessMonthClose(facts({ month: null }))), ["MONTH_NOT_FOUND"]);
  assert.equal(P.assessMonthClose(facts({ year: { ...YEAR, status: "closed" } })).canClose, false);
});

// ----------------------------------------------------------------------------- stock against the ledger

const stock = (over = {}) => ({
  available: true, reconciles: false, stockValue: 1000, ledgerBalance: 900, difference: 100, accountName: "Inventory", basis: "today",
  sources: [{ label: "Purchases", stock: 800, ledger: 700, difference: 100 }, { label: "Cost of goods sold", stock: -50, ledger: -50, difference: 0 }], ...over,
});

test("stock that disagrees with the Inventory ledger is a warning with the difference and the biggest source", () => {
  const a = P.assessMonthClose(facts({ stock: stock() }));
  assert.equal(a.canClose, true);
  const w = a.warnings.find((x) => x.code === "STOCK_NOT_RECONCILED");
  assert.ok(w);
  assert.equal(w.title, "Stock differs from the Inventory ledger by AED 100.00");
  assert.match(w.detail, /At 31 Jan 2026 the stock is worth AED 1,000\.00 and Inventory shows AED 900\.00\. Largest: Purchases \(stock 800\.00, ledger 700\.00\)/);
  assert.equal(w.difference, 100);
  assert.doesNotMatch(w.detail, /as the books stand now/, "today's figure is exact: no caveat");
});

test("for a past day the check says it is as far as the movements show", () => {
  const w = P.assessMonthClose(facts({ stock: stock({ basis: "history" }) })).warnings.find((x) => x.code === "STOCK_NOT_RECONCILED");
  assert.match(w.detail, /worked out from the stock movements dated up to that day, as the books stand now/);
  assert.equal(w.basis, "history");
});

test("stock that agrees is a passed check; nothing to compare, or posting off, leaves no line at all", () => {
  const ok = P.assessMonthClose(facts({ stock: stock({ reconciles: true, difference: 0, ledgerBalance: 1000 }) }));
  const line = ok.checks.find((c) => c.code === "STOCK_AGREES");
  assert.equal(line.level, "ok");
  assert.equal(line.title, "Stock agrees with the Inventory ledger (AED 1,000.00)");
  assert.equal(ok.warnings.length, 0);

  const none = P.assessMonthClose(facts({ stock: stock({ reconciles: true, difference: 0, stockValue: 0, ledgerBalance: 0 }) }));
  assert.equal(none.checks.some((c) => c.code.startsWith("STOCK")), false, "a company with no stock has nothing to compare");
  const off = P.assessMonthClose(facts({ postingEnabled: false, stock: stock() }));
  assert.equal(off.checks.some((c) => c.code.startsWith("STOCK")), false, "posting off already says the ledger is not receiving");
  assert.equal(P.assessMonthClose(facts()).checks.some((c) => c.code.startsWith("STOCK")), false, "no stock facts, no check");
});

test("stock that could not be compared is a warning when there is stock, silent when there is none, and always when it failed", () => {
  const unmapped = P.assessMonthClose(facts({ stock: { available: false, reason: "The Inventory account is not mapped.", stockValue: 500 } }));
  assert.deepEqual(unmapped.warnings.map((w) => w.code), ["STOCK_NOT_RECONCILED"]);
  assert.equal(unmapped.warnings[0].detail, "The Inventory account is not mapped.");
  assert.equal(P.assessMonthClose(facts({ stock: { available: false, reason: "x", stockValue: 0 } })).warnings.length, 0);
  const failed = P.assessMonthClose(facts({ stock: { available: false, error: true, reason: "Stock could not be checked: boom", stockValue: 0 } }));
  assert.equal(failed.warnings[0].detail, "Stock could not be checked: boom");
});

test("the year close asks the same stock question, at the year end", () => {
  const f = {
    year: { code: "2026", status: "open", startDay: "2026-01-01", endDay: "2026-12-31" }, today: "2027-01-05", allBranches: true,
    retained: { mapped: true, accountName: "Retained Earnings" }, postingEnabled: true, currency: "AED", stock: stock(),
  };
  const a = Y.assessClose(f);
  assert.equal(a.canClose, true);
  const w = a.warnings.find((x) => x.code === "STOCK_NOT_RECONCILED");
  assert.match(w.detail, /At 31 Dec 2026/);
  assert.equal(Y.assessClose({ ...f, stock: undefined }).checks.some((c) => c.code.startsWith("STOCK")), false, "callers that do not read stock are unchanged");
});

// ----------------------------------------------------------------------------- reopening a month

const reopenFacts = (over = {}) => ({ year: lockedTo("2026-03-31"), month: P.findMonth(YEAR, "2026-03"), allBranches: true, laterYears: [], ...over });

test("only the latest closed month may be reopened", () => {
  assert.equal(P.assessMonthReopen(reopenFacts()).canClose, true);
  assert.equal(P.assessMonthReopen(reopenFacts()).checks.at(-1).code, "CAN_REOPEN");
  const a = P.assessMonthReopen(reopenFacts({ month: JAN }));
  assert.deepEqual(a.blockers.map((b) => b.code), ["LATER_MONTH_CLOSED"]);
  assert.equal(a.blockers[0].title, "Reopen March 2026 first");
});

test("a month that is open, a month of a closed year, or a year with a later lock cannot be reopened", () => {
  assert.deepEqual(codes(P.assessMonthReopen(reopenFacts({ month: P.findMonth(YEAR, "2026-04") }))), ["NOT_CLOSED"]);
  assert.deepEqual(codes(P.assessMonthReopen(reopenFacts({ year: lockedTo("2026-03-31", { status: "closed" }) }))), ["YEAR_CLOSED"]);
  const later = P.assessMonthReopen(reopenFacts({ laterYears: ["2027"] }));
  assert.deepEqual(later.blockers.map((b) => b.code), ["LATER_YEAR_LOCKED"]);
  assert.equal(later.blockers[0].title, "Reopen the months of 2027 first");
  assert.deepEqual(P.assessMonthReopen(reopenFacts({ allBranches: false })).blockers.map((b) => b.code), ["ALL_BRANCHES_REQUIRED"]);
  assert.deepEqual(codes(P.assessMonthReopen(reopenFacts({ month: null }))), ["MONTH_NOT_FOUND"]);
});

test("a year with months closed in a later year cannot be reopened until those are", () => {
  const year = { code: "2025", status: "closed" };
  assert.equal(Y.assessReopen({ year, laterClosed: [], laterMonthLocked: [] }).canClose, true);
  const a = Y.assessReopen({ year, laterClosed: [], laterMonthLocked: ["2026"] });
  assert.deepEqual(a.blockers.map((b) => b.code), ["LATER_MONTHS_CLOSED"]);
  assert.equal(a.blockers[0].title, "Reopen the months of 2026 first");
  assert.equal(Y.assessReopen({ year, laterClosed: ["2026"], laterMonthLocked: ["2027"] }).blockers[0].code, "LATER_YEAR_CLOSED", "a later closed year is still the first reason");
});
