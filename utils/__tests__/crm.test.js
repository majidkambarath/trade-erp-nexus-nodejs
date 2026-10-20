// The CRM's rules, with no database: what may be entered, who gets a lead, how warm it is, and - the part the whole
// module rests on - exactly when a document moves a deal and when it must not.
const test = require("node:test");
const assert = require("node:assert/strict");
const crm = require("../crm");

const STAGES = crm.normaliseStages(crm.STARTER_STAGES);
const stage = (key) => crm.stageByKey(STAGES, key);

// ---- hostile input ------------------------------------------------------------------------------------------------

test("a request body is coerced, never trusted: an object, an array or null reads as empty", () => {
  // The security sweep posts exactly these at every route and requires a clean 4xx, so nothing but a real string may
  // reach a query.
  assert.equal(crm.text({ $ne: "x" }), "");
  assert.equal(crm.text(["a"]), "");
  assert.equal(crm.text(null), "");
  assert.equal(crm.text(undefined), "");
  assert.equal(crm.text(5), "5");
  assert.equal(crm.text("  trimmed  "), "trimmed");
  assert.equal(crm.text("x".repeat(500), 10), "x".repeat(10));

  assert.equal(crm.num({ $gt: 1 }), 0);
  assert.equal(crm.num([]), 0);
  assert.equal(crm.num("12.5"), 12.5);
  assert.equal(crm.num(Number.NaN), 0);
  assert.equal(crm.num(Infinity), 0);

  assert.equal(crm.day("2026-10-20"), "2026-10-20");
  assert.equal(crm.day("2026-02-31"), null, "a day that does not exist is not a day");
  assert.equal(crm.day({ $ne: null }), null);
  assert.equal(crm.oneOf({ $ne: "x" }, crm.LEAD_SOURCES), null);
  assert.equal(crm.isId("64b64b64b64b64b64b64b64b"), true);
  assert.equal(crm.isId("nonsense"), false);
  assert.equal(crm.isId({ $ne: null }), false);

  // The one object that may speak for itself: an id out of our own database. JSON cannot carry `_bsontype`, so a
  // request body can never pretend to be one - and the services pass stored ids around without stringifying them.
  const objectId = { _bsontype: "ObjectId", toString: () => "64b64b64b64b64b64b64b64b" };
  assert.equal(crm.isId(objectId), true);
  assert.equal(crm.text(objectId), "64b64b64b64b64b64b64b64b");
  assert.equal(crm.isId(["64b64b64b64b64b64b64b64b"]), false, "an array that stringifies to an id is still not one");
});

// ---- what may be entered -----------------------------------------------------------------------------------------

test("a lead needs a name and a way to reach somebody", () => {
  const codes = (errors) => errors.map((e) => e.code);
  assert.deepEqual(codes(crm.validateLead({})), ["LEAD_NAME_REQUIRED", "LEAD_CONTACT_REQUIRED"]);
  assert.deepEqual(codes(crm.validateLead({ name: "Al Noor Foods", phone: "0501234567" })), []);
  assert.deepEqual(codes(crm.validateLead({ name: "Al Noor", email: "buyer@alnoor.ae" })), []);
  // An address that was typed counts as a way to reach somebody, so the only complaint is that it is not an address
  assert.deepEqual(codes(crm.validateLead({ name: "Al Noor", email: "not-an-email" })), ["LEAD_EMAIL_INVALID"]);
  assert.deepEqual(codes(crm.validateLead({ name: "x", phone: "1", source: "carrier-pigeon" })), ["LEAD_SOURCE_INVALID"]);
  assert.deepEqual(codes(crm.validateLead({ name: "x", phone: "1", expectedValue: -5 })), ["LEAD_VALUE_NEGATIVE"]);
  assert.deepEqual(codes(crm.validateLead({ name: "x", phone: "1", ownerId: "not-an-id" })), ["LEAD_OWNER_INVALID"]);
  // A partial update only judges what it was given
  assert.deepEqual(codes(crm.validateLead({ notes: "rang, no answer" }, { partial: true })), []);
  assert.deepEqual(codes(crm.validateLead({ name: "" }, { partial: true })), ["LEAD_NAME_REQUIRED"]);
});

test("a deal belongs to a customer, on a stage this organisation actually has", () => {
  const codes = (errors) => errors.map((e) => e.code);
  const id = "64b64b64b64b64b64b64b64b";
  assert.deepEqual(codes(crm.validateOpportunity({})), ["OPPORTUNITY_TITLE_REQUIRED", "OPPORTUNITY_CUSTOMER_REQUIRED"]);
  assert.deepEqual(codes(crm.validateOpportunity({ title: "Ramadan order", customerId: id }, { stages: STAGES })), []);
  assert.deepEqual(codes(crm.validateOpportunity({ title: "x", customerId: id, stageKey: "invented" }, { stages: STAGES })), ["STAGE_NOT_FOUND"]);
  assert.deepEqual(codes(crm.validateOpportunity({ title: "x", customerId: id, value: -1 }, { stages: STAGES })), ["OPPORTUNITY_VALUE_NEGATIVE"]);
  assert.deepEqual(codes(crm.validateOpportunity({ title: "x", customerId: id, expectedCloseDate: "soon" }, { stages: STAGES })), ["OPPORTUNITY_DATE_INVALID"]);
});

test("a follow-up is a kind of contact, about something that exists, due on a day", () => {
  const codes = (errors) => errors.map((e) => e.code);
  const regarding = { kind: "opportunity", id: "64b64b64b64b64b64b64b64b" };
  assert.deepEqual(codes(crm.validateActivity({ kind: "call", subject: "Ring back", regarding })), []);
  assert.deepEqual(codes(crm.validateActivity({ kind: "telepathy", subject: "x", regarding })), ["ACTIVITY_KIND_INVALID"]);
  assert.deepEqual(codes(crm.validateActivity({ kind: "call", subject: "", regarding })), ["ACTIVITY_SUBJECT_REQUIRED"]);
  assert.deepEqual(codes(crm.validateActivity({ kind: "call", subject: "x", regarding: { kind: "invoice", id: regarding.id } })), ["ACTIVITY_REGARDING_INVALID"]);
  assert.deepEqual(codes(crm.validateActivity({ kind: "call", subject: "x", regarding: { kind: "lead", id: "nope" } })), ["ACTIVITY_REGARDING_INVALID"]);
  assert.deepEqual(codes(crm.validateActivity({ kind: "call", subject: "x", regarding, dueAt: "tomorrow" })), ["ACTIVITY_DUE_INVALID"]);
});

test("a pipeline must stay a pipeline: one won stage, one lost stage, and no two stages answering one event", () => {
  const codes = (list) => crm.validateStages(list).map((e) => e.code);
  assert.deepEqual(codes(crm.STARTER_STAGES), []);
  assert.deepEqual(codes([]), ["STAGES_REQUIRED"]);
  assert.deepEqual(codes(null), ["STAGES_REQUIRED"]);

  const open = (key, over = {}) => ({ key, name: key, order: 1, probability: 10, type: "open", ...over });
  assert.ok(codes([open("a"), open("a"), open("w", { type: "won" }), open("l", { type: "lost" })]).includes("STAGE_KEY_DUPLICATE"));
  assert.ok(codes([open("a"), open("w", { type: "won" })]).includes("STAGE_LOST_REQUIRED"));
  assert.ok(codes([open("a"), open("l", { type: "lost" })]).includes("STAGE_WON_REQUIRED"));
  assert.ok(codes([open("a", { type: "won" }), open("b", { type: "won" }), open("l", { type: "lost" })]).includes("STAGE_WON_REQUIRED"));
  assert.ok(
    codes([
      open("a", { advanceOn: "quotation_sent" }),
      open("b", { advanceOn: "quotation_sent" }),
      open("w", { type: "won" }),
      open("l", { type: "lost" }),
    ]).includes("STAGE_EVENT_DUPLICATE"),
    "two stages cannot both claim the same event: the automation would not know where to send the deal"
  );
  assert.ok(codes([open("a", { advanceOn: "order_confirmed" }), open("w", { type: "won" }), open("l", { type: "lost" })]).includes("STAGE_EVENT_INVALID"),
    "an event nothing in the product fires is refused, so no stage promises a move that never comes");
  assert.ok(codes([open("a", { probability: 101 }), open("w", { type: "won" }), open("l", { type: "lost" })]).includes("STAGE_PROBABILITY_RANGE"));
  assert.ok(codes([open("a", { followUpDays: 400 }), open("w", { type: "won" }), open("l", { type: "lost" })]).includes("STAGE_FOLLOWUP_RANGE"));
});

test("stages are stored ordered from one, with keys cleaned and figures clamped", () => {
  const out = crm.normaliseStages([
    { key: "Needs Review!", name: "Needs review", order: 9, probability: 150.6, followUpDays: "3", staleDays: 1000, type: "nonsense" },
    { key: "", name: "Nameless", order: 2 },
  ]);
  assert.deepEqual(
    out.map((s) => [s.key, s.order, s.probability, s.followUpDays, s.staleDays, s.type]),
    [["stage-2", 1, 0, 0, 0, "open"], ["needsreview", 2, 100, 3, 365, "open"]]
  );
});

test("the automation settings fall back to the defaults, and a fixed owner must actually be named", () => {
  assert.deepEqual(crm.validateSettings({ assignmentMode: "telepathy" }).map((e) => e.code), ["ASSIGNMENT_MODE_INVALID"]);
  assert.deepEqual(crm.validateSettings({ assignmentMode: "fixed" }).map((e) => e.code), ["ASSIGNMENT_OWNER_REQUIRED"]);
  assert.deepEqual(crm.validateSettings({ assignmentMode: "fixed", fixedOwnerId: "64b64b64b64b64b64b64b64b" }), []);
  assert.deepEqual(crm.validateSettings({ staleDays: 0 }).map((e) => e.code), ["SETTING_RANGE"]);

  const out = crm.normaliseSettings({ autoAdvance: "yes", uncontactedHours: 9999, assignmentMode: "fixed", fixedOwnerId: "nope" });
  assert.equal(out.autoAdvance, true, "a value that is not a boolean keeps the default rather than reading as false");
  assert.equal(out.uncontactedHours, crm.DEFAULT_SETTINGS.uncontactedHours);
  assert.equal(out.fixedOwnerId, null);
});

// ---- who gets it -------------------------------------------------------------------------------------------------

test("round robin walks the people in order and carries on from whoever had the last one", () => {
  const a = "64b64b64b64b64b64b64b6a1";
  const b = "64b64b64b64b64b64b64b6b2";
  const c = "64b64b64b64b64b64b64b6c3";
  const candidates = [{ id: a }, { id: b }, { id: c }];
  const rr = { assignmentMode: "round_robin" };

  assert.equal(crm.assignOwner({ candidates, lastOwnerId: null, settings: rr }), a);
  assert.equal(crm.assignOwner({ candidates, lastOwnerId: a, settings: rr }), b);
  assert.equal(crm.assignOwner({ candidates, lastOwnerId: c, settings: rr }), a, "it comes round again");
  assert.equal(crm.assignOwner({ candidates, lastOwnerId: "someone-who-left", settings: rr }), a, "an unknown last owner starts at the beginning");
  assert.equal(crm.assignOwner({ candidates: [], settings: rr }), null, "nobody to give it to is not an error");

  assert.equal(crm.assignOwner({ candidates, settings: { assignmentMode: "creator" }, createdBy: c }), c);
  assert.equal(crm.assignOwner({ candidates, settings: { assignmentMode: "fixed", fixedOwnerId: b } }), b);
  assert.equal(crm.assignOwner({ candidates, settings: { assignmentMode: "fixed", fixedOwnerId: "64b64b64b64b64b64b64b6ff" } }), a,
    "a fixed owner who is no longer there falls back rather than leaving the lead unassigned");
});

test("a lead's score is explainable: where it came from, what it is worth, how much contact, how long since", () => {
  const today = "2026-10-20";
  const referral = crm.leadScore({ source: "referral", expectedValue: 150000, contactCount: 2, lastActivityDay: today }, today);
  assert.equal(referral.band, "hot");
  assert.ok(referral.score >= 70);

  const cold = crm.leadScore({ source: "other", expectedValue: 0, contactCount: 0 }, today);
  assert.equal(cold.band, "cold");

  // The same lead, gone quiet for a month, is colder than it was - the one thing a pipeline must notice.
  const fresh = crm.leadScore({ source: "website", expectedValue: 30000, contactCount: 1, lastActivityDay: today }, today);
  const stale = crm.leadScore({ source: "website", expectedValue: 30000, contactCount: 1, lastActivityDay: "2026-09-01" }, today);
  assert.ok(stale.score < fresh.score, `${stale.score} should be less than ${fresh.score}`);
  // The warmest a lead can read: a referral, worth a lot, often spoken to and already qualified - and still inside
  // the scale, because a score nobody can exceed is a score nobody can game.
  const hottest = crm.leadScore({ source: "referral", expectedValue: 1e12, contactCount: 99, status: "QUALIFIED", lastActivityDay: today }, today);
  assert.equal(hottest.score, 95);
  assert.equal(hottest.band, "hot");
  assert.ok(crm.leadScore({ source: "referral", expectedValue: 1e12, contactCount: 99 }, today).score <= 100, "never over 100");
  assert.ok(crm.leadScore({ source: "other", lastActivityDay: "2020-01-01" }, today).score >= 0, "and never below nothing");
});

// ---- the automation ----------------------------------------------------------------------------------------------

test("a document moves the deal: the event decides the stage, and the claim is one key per document", () => {
  const deal = { status: "OPEN", stageKey: "qualified", autoMoves: [] };
  const move = crm.planAdvance({ opportunity: deal, stages: STAGES, event: "quotation_sent", documentId: "quote1" });
  assert.equal(move.stageKey, "quoted");
  assert.equal(move.probability, 50);
  assert.equal(move.status, "OPEN");
  assert.equal(move.from, "qualified");
  assert.equal(move.key, "quotation_sent:quote1");
  assert.equal(move.reason, "A quotation was sent");

  const won = crm.planAdvance({ opportunity: { status: "OPEN", stageKey: "accepted", autoMoves: [] }, stages: STAGES, event: "invoice_approved", documentId: "inv1" });
  assert.equal(won.stageKey, "won");
  assert.equal(won.status, "WON");
});

test("and it never moves backwards, never twice, and never a deal that is already closed", () => {
  const already = { status: "OPEN", stageKey: "accepted", autoMoves: [] };
  assert.equal(
    crm.planAdvance({ opportunity: already, stages: STAGES, event: "quotation_sent", documentId: "quote1" }),
    null,
    "a quotation sent on a deal the customer has already accepted does not undo the acceptance"
  );

  const claimed = { status: "OPEN", stageKey: "qualified", autoMoves: [{ key: "quotation_sent:quote1", to: "quoted" }] };
  assert.equal(crm.planAdvance({ opportunity: claimed, stages: STAGES, event: "quotation_sent", documentId: "quote1" }), null,
    "the same document cannot move the same deal twice, however often the hook runs");
  assert.ok(crm.planAdvance({ opportunity: claimed, stages: STAGES, event: "quotation_sent", documentId: "quote2" }),
    "but a different quotation is a different event");

  assert.equal(crm.planAdvance({ opportunity: { status: "WON", stageKey: "won", autoMoves: [] }, stages: STAGES, event: "quotation_sent", documentId: "q" }), null);
  assert.equal(crm.planAdvance({ opportunity: { status: "OPEN", stageKey: "lost", autoMoves: [] }, stages: STAGES, event: "quotation_sent", documentId: "q" }), null);
  assert.equal(crm.planAdvance({ opportunity: { status: "OPEN", stageKey: "new", autoMoves: [] }, stages: STAGES, event: "nonsense", documentId: "q" }), null);
  assert.equal(
    crm.planAdvance({ opportunity: { status: "OPEN", stageKey: "new", autoMoves: [] }, stages: STAGES, event: "quotation_sent", documentId: "q", settings: { autoAdvance: false } }),
    null,
    "and nothing moves at all when the organisation has switched auto-advance off"
  );
});

test("a document undone takes its move back, to the stage the deal was on before", () => {
  const deal = {
    status: "WON",
    stageKey: "won",
    autoMoves: [{ key: "invoice_approved:inv1", event: "invoice_approved", from: "accepted", to: "won" }],
  };
  const undo = crm.planUndo({ opportunity: deal, stages: STAGES, event: "invoice_approved", documentId: "inv1" });
  assert.equal(undo.stageKey, "accepted", "back where it came from, not to the beginning");
  assert.equal(undo.status, "OPEN");
  assert.equal(undo.forget, false);

  // Something else has since moved the deal on: the later truth wins and the undo is only forgotten.
  const movedOn = { ...deal, stageKey: "quoted" };
  assert.deepEqual(crm.planUndo({ opportunity: movedOn, stages: STAGES, event: "invoice_approved", documentId: "inv1" }), {
    key: "invoice_approved:inv1", stageKey: null, forget: true,
  });

  assert.equal(crm.planUndo({ opportunity: deal, stages: STAGES, event: "invoice_approved", documentId: "other" }), null,
    "a document that never moved this deal has nothing to take back");

  // The stage it came from has since been deleted from the pipeline: it goes to the first open stage instead.
  const fallback = crm.planUndo({ opportunity: { ...deal, autoMoves: [{ key: "invoice_approved:inv1", from: "gone", to: "won" }] }, stages: STAGES, event: "invoice_approved", documentId: "inv1" });
  assert.equal(fallback.stageKey, "new");
});

test("entering a stage leaves exactly one next action behind, due by that stage's own clock", () => {
  const deal = { _id: "d1", title: "Ramadan order", ownerId: "64b64b64b64b64b64b64b6a1" };
  const plan = crm.planFollowUp({ opportunity: deal, stage: stage("quoted"), openActivities: [], today: "2026-10-20" });
  assert.equal(plan.dueAt, "2026-10-23", "three days for a quotation sent");
  assert.match(plan.subject, /Quotation sent - Ramadan order/);
  assert.equal(plan.ownerId, deal.ownerId);
  assert.equal(plan.auto, true);

  assert.equal(
    crm.planFollowUp({ opportunity: deal, stage: stage("quoted"), openActivities: [{ _id: "a1" }], today: "2026-10-20" }),
    null,
    "a deal that already has something owed does not get a second reminder piled on it"
  );
  assert.equal(crm.planFollowUp({ opportunity: deal, stage: stage("won"), openActivities: [], today: "2026-10-20" }), null, "a won deal owes nobody anything");
  assert.equal(crm.planFollowUp({ opportunity: deal, stage: stage("lost"), openActivities: [], today: "2026-10-20" }), null);
  assert.equal(crm.planFollowUp({ opportunity: deal, stage: stage("new"), openActivities: [], today: "2026-10-20", settings: { autoFollowUp: false } }), null);
  assert.equal(crm.planFollowUp({ opportunity: deal, stage: stage("new"), openActivities: [], today: null }), null, "with no day there is no due date to work out");
});

// ---- derived state ------------------------------------------------------------------------------------------------

test("a follow-up due today is due, not late", () => {
  const today = "2026-10-20";
  assert.equal(crm.dueState({ status: "OPEN", dueAt: "2026-10-19" }, today), "overdue");
  assert.equal(crm.dueState({ status: "OPEN", dueAt: today }, today), "today");
  assert.equal(crm.dueState({ status: "OPEN", dueAt: "2026-10-25" }, today), "soon");
  assert.equal(crm.dueState({ status: "OPEN", dueAt: "2026-12-25" }, today), "later");
  assert.equal(crm.dueState({ status: "DONE", dueAt: "2026-01-01" }, today), "done");
  assert.equal(crm.dueState({ status: "CANCELLED", dueAt: "2026-01-01" }, today), "cancelled");
  assert.equal(crm.dueState({ status: "OPEN" }, today), "later", "a follow-up with no date is not overdue");
});

test("a deal nobody has touched for longer than its stage allows is stale", () => {
  const stages = STAGES;
  const settings = { staleDays: 14 };
  const quoted = { status: "OPEN", stageKey: "quoted", lastActivityDay: "2026-10-01" };
  assert.deepEqual(crm.staleOf(quoted, settings, stages, "2026-10-20"), { days: 19, isStale: true, limit: 14 });
  assert.equal(crm.staleOf({ ...quoted, lastActivityDay: "2026-10-18" }, settings, stages, "2026-10-20").isStale, false);
  assert.equal(crm.staleOf({ ...quoted, status: "WON" }, settings, stages, "2026-10-20").isStale, false, "a closed deal is never stale");
  assert.equal(crm.staleOf({ status: "OPEN", stageKey: "quoted", stageSinceDay: "2026-10-01" }, settings, stages, "2026-10-20").isStale, true,
    "a deal nothing has ever happened to is measured from the day it arrived on the stage");
});

test("the pipeline is worth its total, and its total weighted by each stage's chance", () => {
  const deals = [
    { status: "OPEN", stageKey: "quoted", value: 10000 }, // 50%
    { status: "OPEN", stageKey: "accepted", value: 20000 }, // 90%
    { status: "WON", stageKey: "won", value: 50000 }, // closed: not in the pipeline
  ];
  assert.deepEqual(crm.weightedValue(deals, STAGES), { value: 30000, weighted: 23000 });

  const rows = crm.funnel(STAGES, deals.filter((d) => d.status === "OPEN"));
  assert.deepEqual(rows.map((r) => [r.key, r.count, r.value]), [
    ["new", 0, 0], ["qualified", 0, 0], ["quoted", 1, 10000], ["accepted", 1, 20000], ["won", 0, 0], ["lost", 0, 0],
  ]);
});

test("the report: a rate with nothing to measure is null, never nought", () => {
  const empty = crm.analysis({ stages: STAGES, today: "2026-10-20" });
  assert.equal(empty.leads.conversionRate, null);
  assert.equal(empty.deals.winRate, null);
  assert.equal(empty.deals.averageDaysToWin, null);

  const out = crm.analysis({
    stages: STAGES,
    today: "2026-10-20",
    leads: [
      { source: "referral", status: "CONVERTED", expectedValue: 5000, ownerId: "64b64b64b64b64b64b64b6a1", ownerName: "Asif" },
      { source: "referral", status: "LOST", expectedValue: 1000, ownerId: "64b64b64b64b64b64b64b6a1", ownerName: "Asif" },
      { source: "website", status: "NEW", expectedValue: 2000 },
    ],
    opportunities: [
      { status: "WON", stageKey: "won", value: 5000, ownerId: "64b64b64b64b64b64b64b6a1", ownerName: "Asif", openedDay: "2026-10-01", closedDay: "2026-10-11" },
      { status: "LOST", stageKey: "lost", value: 3000, lostReason: "price", ownerId: "64b64b64b64b64b64b64b6a1", ownerName: "Asif" },
      { status: "OPEN", stageKey: "quoted", value: 10000 },
    ],
    activities: [
      { status: "DONE", ownerId: "64b64b64b64b64b64b64b6a1", ownerName: "Asif" },
      { status: "OPEN", dueAt: "2026-10-10" },
    ],
  });
  assert.equal(out.leads.conversionRate, 33.3);
  assert.equal(out.deals.winRate, 50);
  assert.equal(out.deals.averageDaysToWin, 10);
  assert.equal(out.deals.weightedValue, 5000, "the one open deal at 50%");
  assert.equal(out.activity.overdue, 1);
  assert.deepEqual(out.bySource[0], { source: "referral", label: "Referral", leads: 2, converted: 1, lost: 1, value: 6000, conversionRate: 50 });
  assert.equal(out.byOwner[0].name, "Asif");
  assert.equal(out.byOwner[0].winRate, 50);
  assert.deepEqual(out.lostReasons, [{ reason: "price", label: "Price too high", deals: 1, value: 3000 }]);
  assert.equal(out.byOwner.find((o) => o.ownerId === null).name, "Unassigned");
});

test("a worklist's days: overdue has no beginning, today is one day, this week looks ahead", () => {
  assert.deepEqual(crm.followUpRange("overdue", "2026-10-20"), { from: null, to: "2026-10-19" });
  assert.deepEqual(crm.followUpRange("today", "2026-10-20"), { from: "2026-10-20", to: "2026-10-20" });
  assert.deepEqual(crm.followUpRange("week", "2026-10-20"), { from: null, to: "2026-10-27" });
  assert.deepEqual(crm.followUpRange("week", "nonsense"), { from: null, to: null });
});

test("the starter pipeline is a pipeline, and every event it names is one the product can fire", () => {
  assert.deepEqual(crm.validateStages(crm.STARTER_STAGES), []);
  const named = crm.STARTER_STAGES.map((s) => s.advanceOn).filter(Boolean);
  for (const event of named) assert.ok(crm.EVENTS.includes(event), event);
  assert.deepEqual(named, ["quotation_sent", "quotation_accepted", "invoice_approved"], "all three events a document can raise are used");
  for (const event of crm.EVENTS) assert.ok(crm.EVENT_LABEL[event], `${event} has words a person can read`);
});

test("aging measures from the day a deal entered its stage, not from when it was born", () => {
  const deals = [
    { _id: "a", opportunityNo: "OPP-1", title: "Old", status: "OPEN", openedDay: "2026-01-01", stageSinceDay: "2026-10-18", value: 20000 },
    { _id: "b", opportunityNo: "OPP-2", title: "Stuck", status: "OPEN", openedDay: "2026-09-01", stageSinceDay: "2026-08-04", value: 50000, expectedCloseDate: "2026-10-01" },
    { _id: "c", opportunityNo: "OPP-3", title: "Won", status: "WON", stageSinceDay: "2026-01-01", value: 90000 },
  ];
  const out = crm.aging({ opportunities: deals, stages: [], settings: {}, today: "2026-10-20" });

  // A deal that has existed since January but moved two days ago is NOT old: the question is how long it has
  // stood still, which is the whole point of the report.
  assert.equal(out.rows.find((r) => r.opportunityNo === "OPP-1").days, 2);
  assert.equal(out.rows.find((r) => r.opportunityNo === "OPP-2").days, 77);
  assert.equal(out.rows.length, 2, "a won deal is not aging; it is finished");
  assert.equal(out.oldest, 77);
  assert.equal(out.rows[0].opportunityNo, "OPP-2", "oldest first");
  // A close date already past on a deal still open is the loudest thing here.
  assert.equal(out.overdueClose, 1);
  assert.equal(out.bands.find((b) => b.key === "60+").deals, 1);
  assert.equal(out.bands.find((b) => b.key === "0-7").deals, 1);
  assert.equal(out.bands.reduce((t, b) => t + b.deals, 0), 2, "every open deal falls in exactly one band");
});

test("the communication report counts effort, and only what is OPEN can be late", () => {
  const rows = [
    { kind: "call", status: "DONE", ownerName: "Asif", completedDay: "2026-10-18" },
    { kind: "call", status: "DONE", ownerName: "Asif", completedDay: "2026-10-18" },
    { kind: "visit", status: "OPEN", ownerName: "Asif", dueAt: "2026-10-14" },
    { kind: "note", status: "DONE", ownerName: "Maya", completedDay: "2026-10-19" },
    { kind: "call", status: "OPEN", ownerName: "Maya", dueAt: "2026-10-25" },
    { kind: "call", status: "CANCELLED", ownerName: "Maya", dueAt: "2026-01-01" },
  ];
  const out = crm.activityReport({ activities: rows, today: "2026-10-20" });
  assert.equal(out.done, 3);
  assert.equal(out.open, 2);
  assert.equal(out.overdue, 1, "the one open follow-up whose day has passed");

  const asif = out.byPerson.find((p) => p.name === "Asif");
  assert.deepEqual([asif.done, asif.open, asif.overdue], [2, 1, 1]);
  assert.equal(out.byPerson[0].name, "Asif", "most done first");

  // A cancelled follow-up is neither done nor owed, so it cannot be late.
  const maya = out.byPerson.find((p) => p.name === "Maya");
  assert.equal(maya.overdue, 0);
  assert.equal(maya.total, 3, "it still happened, so it is still counted as hers");

  assert.deepEqual(out.byDay.map((d) => d.day), ["2026-10-18", "2026-10-19"], "oldest day first");
  assert.equal(out.byDay[0].count, 2);
  assert.equal(out.byKind.every((k) => k.done || k.open), true, "a kind nobody used is left out");
});

test("a finished follow-up is placed by its resolved day - a Date's own string form is not a day", () => {
  // What Mongo really hands back is a Date, and String(date) is "Tue Oct 20 2026 ...". An earlier version read that,
  // got no day, and drew an empty "busiest day" for a team that had done three calls. The caller resolves the day in
  // the organisation's calendar now; a row that arrives without one is simply not placed, never mis-placed.
  const real = { kind: "call", status: "DONE", ownerName: "Asif", completedAt: new Date("2026-10-18T06:00:00.000Z") };
  assert.equal(crm.activityReport({ activities: [real], today: "2026-10-20" }).byDay.length, 0, "no resolved day, so not placed");
  const placed = crm.activityReport({ activities: [{ ...real, completedDay: "2026-10-18" }], today: "2026-10-20" });
  assert.deepEqual(placed.byDay, [{ day: "2026-10-18", count: 1 }]);
});

test("the pulse is the last N days, every one of them, quiet days included", () => {
  const rows = [
    { status: "DONE", completedDay: "2026-10-20" },
    { status: "DONE", completedDay: "2026-10-20" },
    { status: "DONE", completedDay: "2026-10-18" },
    { status: "OPEN", completedDay: "2026-10-19" },
    { status: "DONE", completedDay: "2026-09-01" },
  ];
  const out = crm.pulse({ activities: rows, today: "2026-10-20", days: 5 });
  assert.deepEqual(out.map((d) => d.day), ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]);
  assert.deepEqual(out.map((d) => d.count), [0, 0, 1, 0, 2], "an open one is not done, and a day outside the window is not counted");
  assert.equal(out.length, 5, "a quiet day is a bar of nothing, not a gap");
});

test("the calendar places follow-ups, deals and enquiries on their own days", () => {
  const out = crm.calendarItems({
    from: "2026-10-01",
    to: "2026-10-31",
    today: "2026-10-20",
    activities: [
      { _id: "a1", kind: "call", status: "OPEN", subject: "Chase the contract", dueAt: "2026-10-14", ownerName: "Asif" },
      { _id: "a2", kind: "visit", status: "OPEN", subject: "Works visit", dueAt: "2026-10-25" },
      { _id: "a3", kind: "note", status: "DONE", subject: "Met at the fair", completedDay: "2026-10-10" },
      { _id: "a4", kind: "call", status: "CANCELLED", subject: "Dropped", dueAt: "2026-10-12" },
      { _id: "a5", kind: "call", status: "OPEN", subject: "Next month", dueAt: "2026-11-02" },
    ],
    opportunities: [
      { _id: "d1", title: "Rice contract", customerName: "Al Noor", value: 90000, status: "OPEN", expectedCloseDate: "2026-10-30" },
      { _id: "d2", title: "Already won", customerName: "X", value: 1, status: "WON", expectedCloseDate: "2026-10-12" },
    ],
    leads: [{ _id: "l1", name: "Priya", company: "Nair Metal", status: "NEW", createdDay: "2026-10-05" }],
  });
  assert.deepEqual(out.map((i) => i.id), ["l1", "a3", "a1", "a2", "d1"], "by day, oldest first");
  assert.equal(out.find((i) => i.id === "a1").overdue, true, "an open follow-up whose day has passed");
  assert.equal(out.find((i) => i.id === "a2").overdue, false);
  assert.equal(out.find((i) => i.id === "a3").movable, false, "a finished follow-up is history");
  assert.equal(out.find((i) => i.id === "a1").movable, true, "an open one can be rescheduled");
  assert.equal(out.find((i) => i.id === "d1").movable, false, "a close date is changed on the deal, where the reason is recorded");
  assert.ok(!out.some((i) => ["a4", "a5", "d2"].includes(i.id)), "cancelled, out of range and already-won are all left off");
  assert.deepEqual(crm.calendarItems({ from: "bad", to: "2026-10-31" }), [], "no range, no calendar");
});
