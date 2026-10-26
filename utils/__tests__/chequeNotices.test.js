const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../chequeRules");
const notices = require("../chequeNotices");

const TODAY = "2026-10-26";
const cheque = (over = {}) => ({ _id: "c1", direction: "receipt", status: "pending", chequeNo: "1001", partyName: "Al Noor", amount: 12500, voucherNo: "RV-1", chequeDay: "2026-10-29", ...over });
const one = (list) => { assert.equal(list.length, 1, JSON.stringify(list)); return list[0]; };

// ---- the date arithmetic ----
test("days between two calendar days, across a month end, a year end and a leap day", () => {
  assert.equal(rules.daysBetween("2026-10-26", "2026-10-29"), 3);
  assert.equal(rules.daysBetween("2026-10-29", "2026-10-26"), -3);
  assert.equal(rules.daysBetween("2026-02-28", "2026-03-01"), 1);
  assert.equal(rules.daysBetween("2028-02-28", "2028-03-01"), 2, "2028 is a leap year");
  assert.equal(rules.daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(rules.daysBetween(TODAY, TODAY), 0);
  assert.equal(rules.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(rules.addDays("2026-03-01", -1), "2026-02-28");
});

test("a cheque against its date: overdue, today, soon (7 days inclusive), later", () => {
  assert.deepEqual(rules.maturityOf("2026-10-25", TODAY), { state: "overdue", days: -1 });
  assert.deepEqual(rules.maturityOf(TODAY, TODAY), { state: "today", days: 0 });
  assert.equal(rules.maturityOf("2026-11-02", TODAY).state, "soon", "7 days away is still soon");
  assert.equal(rules.maturityOf("2026-11-03", TODAY).state, "later", "8 days away is not");
  assert.equal(rules.maturityOf("2026-11-03", TODAY, 10).state, "soon", "the window can be widened");
});

test("a cheque against its validity: ok, expiring inside 30 days, expired the day after the last good day", () => {
  assert.equal(rules.expiryOf("2026-10-01", TODAY, 183).state, "ok");
  const last = rules.expiryOf("2026-04-26", TODAY, 183);
  assert.deepEqual([last.state, last.lastDay, last.daysLeft], ["expiring", "2026-10-26", 0], "dated 183 days ago: today is the last good day");
  assert.equal(rules.expiryOf("2026-04-25", TODAY, 183).state, "expired", "dated 184 days ago: the register itself would refuse it");
  assert.equal(rules.expiryOf("2026-05-26", TODAY, 183).state, "expiring", "30 days left");
  assert.equal(rules.expiryOf("2026-05-27", TODAY, 183).state, "ok", "31 days left");
});

// ---- maturing ----
test("a customer's cheque: told 'matures in n days', then 'can be deposited today', then 'past its date and not deposited'", () => {
  const soon = one(notices.maturing([cheque()], TODAY, { currency: "AED" }));
  assert.equal(soon.title, "Cheque 1001 from Al Noor matures in 3 days");
  assert.equal(soon.severity, "info");
  assert.equal(soon.body, "AED 12,500.00, RV-1.");
  assert.match(one(notices.maturing([cheque({ chequeDay: TODAY })], TODAY)).title, /can be deposited today/);
  const late = one(notices.maturing([cheque({ chequeDay: "2026-10-20" })], TODAY));
  assert.equal(late.title, "Cheque 1001 from Al Noor is 6 days past its date and not deposited");
  assert.equal(late.severity, "warning");
  assert.equal(one(notices.maturing([cheque({ chequeDay: "2026-10-27" })], TODAY)).title, "Cheque 1001 from Al Noor matures in 1 day", "singular");
});

test("a cheque we issued reads differently: keep the account funded", () => {
  const ours = (day) => cheque({ direction: "payment", partyName: "Gulf Mills", chequeDay: day });
  assert.equal(one(notices.maturing([ours("2026-10-30")], TODAY)).title, "Our cheque 1001 to Gulf Mills falls due in 4 days");
  assert.match(one(notices.maturing([ours(TODAY)], TODAY)).title, /can be paid from today: keep the account funded/);
  const late = one(notices.maturing([ours("2026-10-24")], TODAY));
  assert.match(late.title, /has been payable for 2 days: keep the account funded/);
  assert.equal(late.severity, "warning");
});

test("ESCALATION CHANGES THE KEY, so a read notice is told again; within a stage the key is stable", () => {
  const key = (day, today) => one(notices.maturing([cheque({ chequeDay: day })], today)).dedupeKey;
  assert.equal(key("2026-10-29", "2026-10-26"), key("2026-10-29", "2026-10-27"), "the countdown changes quietly");
  assert.equal(key("2026-10-29", "2026-10-29"), key("2026-10-29", "2026-10-26"), "'today' is still the soon stage");
  assert.notEqual(key("2026-10-29", "2026-10-29"), key("2026-10-29", "2026-10-30"), "past its date is a new notice");
  assert.equal(key("2026-10-29", "2026-10-30"), "c1:overdue");
});

test("a held cheque is told, and says it is held; a cheque far in the future is not told at all", () => {
  const held = one(notices.maturing([cheque({ status: "hold", holdReason: "Wait for a transfer", chequeDay: TODAY })], TODAY));
  assert.match(held.title, /taken off hold and deposited today/);
  assert.match(held.body, /^On hold: Wait for a transfer\./);
  assert.match(one(notices.maturing([cheque({ status: "hold", chequeDay: "2026-10-20" })], TODAY)).title, /past its date and on hold/);
  assert.deepEqual(notices.maturing([cheque({ chequeDay: "2027-03-01" })], TODAY), []);
});

// ---- deposited, not cleared ----
test("a deposited cheque that has not cleared is told after 5 days, not before", () => {
  const dep = (day) => cheque({ status: "deposited", presentedDay: day, depositSlipNo: "S-9" });
  assert.deepEqual(notices.uncleared([dep("2026-10-22")], TODAY), [], "4 days: banks take a few");
  const n = one(notices.uncleared([dep("2026-10-21")], TODAY));
  assert.equal(n.title, "Cheque 1001 from Al Noor was deposited 5 days ago and has not cleared");
  assert.match(n.body, /slip S-9/);
  assert.equal(n.severity, "warning");
  assert.deepEqual(notices.uncleared([cheque({ status: "deposited" })], TODAY), [], "no deposit day recorded: nothing to count from");
  assert.deepEqual(notices.uncleared([dep("2026-10-21")], TODAY, { afterDays: 10 }), [], "the wait can be changed");
});

// ---- going stale ----
test("a cheque going stale: a warning inside 30 days, critical once it has", () => {
  const warn = one(notices.expiring([cheque({ chequeDay: "2026-05-10" })], TODAY, 183));
  assert.match(warn.title, /goes stale in 14 days/);
  assert.equal(warn.severity, "warning");
  assert.match(warn.body, /last good day 2026-11-09/);
  assert.match(one(notices.expiring([cheque({ chequeDay: "2026-04-26" })], TODAY, 183)).title, /goes stale after today/);
  const dead = one(notices.expiring([cheque({ chequeDay: "2026-03-01" })], TODAY, 183));
  assert.equal(dead.severity, "critical");
  assert.match(dead.title, /has gone stale/);
  assert.notEqual(warn.dedupeKey, dead.dedupeKey, "going stale is a new notice");
  assert.deepEqual(notices.expiring([cheque({ chequeDay: "2026-10-01" })], TODAY, 183), []);
});

test("a stale cheque we issued says what to do about it, and the validity is the caller's", () => {
  const dead = one(notices.expiring([cheque({ direction: "payment", partyName: "Gulf Mills", chequeDay: "2026-03-01" })], TODAY, 183));
  assert.match(dead.title, /to Gulf Mills/);
  assert.match(dead.body, /cancel it so the supplier is owed again/);
  assert.deepEqual(notices.expiring([cheque({ chequeDay: "2026-10-01" })], TODAY, 183), []);
  assert.equal(one(notices.expiring([cheque({ chequeDay: "2026-10-01" })], TODAY, 40)).severity, "warning", "a shorter window brings the warning forward");
});

test("nothing in any notice asserts a legal consequence", () => {
  const all = JSON.stringify([
    ...notices.maturing([cheque({ chequeDay: "2026-10-20" }), cheque({ _id: "c2", direction: "payment", chequeDay: TODAY })], TODAY),
    ...notices.uncleared([cheque({ status: "deposited", presentedDay: "2026-10-01" })], TODAY),
    ...notices.expiring([cheque({ chequeDay: "2026-03-01" }), cheque({ _id: "c3", chequeDay: "2026-05-10" })], TODAY, 183),
  ]);
  assert.doesNotMatch(all, /legal|prosecut|offence|criminal|section|s\.138|penalt|court/i);
});
