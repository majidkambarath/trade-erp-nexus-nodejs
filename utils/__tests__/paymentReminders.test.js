const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../paymentReminders");

const STEPS = [-3, 0, 7, 14, 30];
const plan = (offset, over = {}) => r.planStep({ offset, steps: STEPS, catchUpDays: 7, used: new Set(), ...over });

test("a step is named by its day: before3, due, late7", () => {
  assert.equal(r.stepKey(-3), "before3");
  assert.equal(r.stepKey(0), "due");
  assert.equal(r.stepKey(14), "late14");
  assert.equal(r.claimKey("abc", 7), "reminder:abc:late7");
});

test("nothing is owed before the first step is reached", () => {
  assert.equal(plan(-10), null);
  assert.equal(plan(-4), null);
});

test("the first step is reached three days before the due date", () => {
  const p = plan(-3);
  assert.equal(p.key, "before3");
  assert.equal(p.stage, "before");
});

test("between two steps today's step is the latest one reached, never an earlier one that was missed", () => {
  assert.equal(plan(-1).key, "before3"); // 1 day before: the 3-days-before reminder (age 2)
  assert.equal(plan(0).key, "due");
  assert.equal(plan(5).key, "due"); // within catch-up (age 5)
  assert.equal(plan(7).key, "late7");
  assert.equal(plan(20).key, "late14"); // 20 days late gets the 14-day one, not the 7-day one as well
});

test("a step older than the catch-up window is stale and is not sent", () => {
  assert.equal(plan(8).key, "late7"); // one day past the 7-day step: still fresh
  // a long gap after the LAST step (the server slept, or reminders were only just switched on):
  assert.equal(r.planStep({ offset: 40, steps: [0, 7], catchUpDays: 7, used: new Set() }), null); // step 7, age 33
  assert.equal(r.planStep({ offset: 14, steps: [0, 7], catchUpDays: 7, used: new Set() }).key, "late7"); // age 7: the edge, still sent
  assert.equal(r.planStep({ offset: 15, steps: [0, 7], catchUpDays: 7, used: new Set() }), null); // age 8: stale
});

test("catch-up of 0 sends only on the step's own day", () => {
  assert.equal(r.planStep({ offset: 7, steps: STEPS, catchUpDays: 0, used: new Set() }).key, "late7");
  assert.equal(r.planStep({ offset: 8, steps: STEPS, catchUpDays: 0, used: new Set() }), null);
});

test("a step already sent is never sent again, and an earlier unsent step is not made up instead", () => {
  assert.equal(plan(7, { used: new Set(["late7"]) }), null);
  assert.equal(plan(9, { used: new Set(["late7"]) }), null); // still the 7-day step's window: nothing more today
  assert.equal(plan(14, { used: new Set(["late7"]) }).key, "late14"); // the next step arrives on its day
  assert.equal(plan(8, { used: new Set(["due"]) }).key, "late7"); // an earlier step used does not block today's
});

test("nothing on the day an invoice was made (a cash sale is 'due' that day)", () => {
  assert.equal(plan(0, { daysSinceIssue: 0 }), null);
  assert.equal(plan(0, { daysSinceIssue: 1 }).key, "due");
  assert.equal(plan(-2, { daysSinceIssue: 0 }), null); // short terms: the day it is issued, nothing
});

test("an invoice with no due day or a junk offset is owed nothing", () => {
  assert.equal(plan(NaN), null);
  assert.equal(plan(undefined), null);
  assert.equal(r.offsetOf("2026-11-10", null), null);
});

test("days since due are counted on calendar days", () => {
  assert.equal(r.offsetOf("2026-11-10", "2026-11-03"), 7);
  assert.equal(r.offsetOf("2026-11-10", "2026-11-10"), 0);
  assert.equal(r.offsetOf("2026-11-10", "2026-11-13"), -3);
  assert.equal(r.offsetOf("2027-01-02", "2026-12-31"), 2); // across a year end
});

test("a step list is validated: whole days, 1 to 8, no repeats, sorted", () => {
  assert.deepEqual(r.validateSettings({ steps: [14, -3, 7, 0, 7] }).steps, [-3, 0, 7, 14]);
  assert.deepEqual(r.validateSettings({ steps: ["3", 5] }).steps, [3, 5]);
  for (const bad of [[], [1.5], ["x"], [-31], [121], [null], "7", Array.from({ length: 9 }, (_, i) => i)]) {
    assert.throws(() => r.validateSettings({ steps: bad }), (e) => e.code === "INVALID_REMINDER_SETTINGS" && e.field === "steps", JSON.stringify(bad));
  }
});

test("mode, hour and catch-up are validated, and a missing field keeps what is held", () => {
  assert.deepEqual(r.validateSettings({}), {});
  assert.equal(r.validateSettings({ mode: "automatic" }).mode, "automatic");
  assert.throws(() => r.validateSettings({ mode: "always" }), (e) => e.field === "mode");
  assert.equal(r.validateSettings({ sendHour: 0 }).sendHour, 0);
  assert.throws(() => r.validateSettings({ sendHour: 24 }), (e) => e.field === "sendHour");
  assert.throws(() => r.validateSettings({ sendHour: 9.5 }), (e) => e.field === "sendHour");
  assert.throws(() => r.validateSettings({ catchUpDays: 31 }), (e) => e.field === "catchUpDays");
  assert.throws(() => r.validateSettings({ catchUpDays: -1 }), (e) => e.field === "catchUpDays");
  // Number([]) is 0, Number(null) is 0, Number(true) is 1: none of them is a number somebody typed
  for (const junk of [[], null, true, "", " ", {}, [5]]) {
    assert.throws(() => r.validateSettings({ sendHour: junk }), (e) => e.field === "sendHour", `sendHour ${JSON.stringify(junk)}`);
    assert.throws(() => r.validateSettings({ catchUpDays: junk }), (e) => e.field === "catchUpDays", `catchUpDays ${JSON.stringify(junk)}`);
  }
  assert.equal(r.validateSettings({ sendHour: "7" }).sendHour, 7);
});

test("settings as held, with gaps, read as the defaults", () => {
  assert.deepEqual(r.settingsOf(undefined), { mode: "off", steps: [-3, 0, 7, 14, 30], sendHour: 9, catchUpDays: 7, lastAutoRunDay: null });
  assert.equal(r.settingsOf({ mode: "nonsense" }).mode, "off");
  assert.deepEqual(r.settingsOf({ mode: "review", steps: [7, 0] }).steps, [0, 7]);
  assert.equal(r.settingsOf({ sendHour: 0 }).sendHour, 0);
});

test("automatic runs only in automatic mode, from the hour, once a day", () => {
  const s = (over) => ({ mode: "automatic", sendHour: 9, lastAutoRunDay: "2026-11-09", ...over });
  assert.equal(r.automaticDue({ settings: s(), today: "2026-11-10", hour: 9 }), true);
  assert.equal(r.automaticDue({ settings: s(), today: "2026-11-10", hour: 8 }), false);
  assert.equal(r.automaticDue({ settings: s({ lastAutoRunDay: "2026-11-10" }), today: "2026-11-10", hour: 15 }), false);
  assert.equal(r.automaticDue({ settings: s({ mode: "review" }), today: "2026-11-10", hour: 15 }), false);
  assert.equal(r.automaticDue({ settings: s({ mode: "off" }), today: "2026-11-10", hour: 15 }), false);
});

test("the hour is read in the organisation's zone", () => {
  const at = new Date("2026-11-10T05:30:00Z");
  assert.equal(r.hourIn("Asia/Dubai", at), 9);
  assert.equal(r.hourIn("UTC", at), 5);
  assert.equal(r.hourIn("Asia/Calcutta", at), 11);
  assert.equal(r.hourIn("UTC", new Date("2026-11-10T00:10:00Z")), 0); // midnight reads 0, never 24
});

test("reminders never take the last fifth of the daily allowance", () => {
  assert.equal(r.room({ dailyLimit: 200, used: 0 }), 160);
  assert.equal(r.room({ dailyLimit: 200, used: 150 }), 10);
  assert.equal(r.room({ dailyLimit: 200, used: 160 }), 0);
  assert.equal(r.room({ dailyLimit: 200, used: 500 }), 0);
  assert.equal(r.room({ dailyLimit: 200, used: 0, cap: 25 }), 25);
});

test("a refusal that would fail every send is told from one that is about a single invoice", () => {
  for (const code of ["PROVIDER_AUTH", "SECRET_UNREADABLE", "FROM_NOT_VERIFIED", "PROVIDER_QUOTA"]) assert.equal(r.isOrgWide(code), true, code);
  for (const code of ["INVALID_ADDRESS", "PROVIDER_TIMEOUT", "SEND_FAILED", undefined]) assert.equal(r.isOrgWide(code), false, String(code));
});
