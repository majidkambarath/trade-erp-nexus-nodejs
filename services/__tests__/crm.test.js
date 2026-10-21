// The CRM against a throwaway database (random name, dropped afterwards).
//
// The story: an enquiry arrives from a referral, the automation gives it an owner and a first follow-up the same day,
// somebody rings and records what happened, the lead is qualified - which creates a REAL customer with its ledger
// account and a deal on the first stage - and the deal is then chased, moved, won and lost by hand. Stage B's
// automation (a quotation and an invoice moving the deal by themselves) is tested in crmAutomation.test.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Lead: require("../crm/leadService"),
    Opp: require("../crm/opportunityService"),
    Act: require("../crm/activityService"),
    Setup: require("../crm/crmSetupService"),
    Report: require("../crm/crmReportService"),
    LeadModel: require("../../models/modules/crm/leadModel"),
    OppModel: require("../../models/modules/crm/opportunityModel"),
    ActModel: require("../../models/modules/crm/crmActivityModel"),
    StageModel: require("../../models/modules/crm/crmStageModel"),
    Customer: require("../../models/modules/customerModel"),
    Admin: require("../../models/core/adminModel"),
    LedgerAccount: require("../../models/modules/financial/financialModels").LedgerAccount,
    days: require("../../utils/documentExpiry"),
    rules: require("../../utils/crm"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const today = () => svc.days.todayInOrg();
const fails = async (fn, code) => {
  try {
    await fn();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.errorCode || error.code, code, error.message);
    return error;
  }
};

let asif, maya, lead, deal;

test("setup: two people who may work the CRM", { skip }, async () => {
  // A person on any role but the five original account types is stored as a viewer with `roleKey` naming the role
  // (utils/permissions.js `roleKeyOf`), which is how the sales executive role reaches them.
  const person = (name, roleKey) =>
    new svc.Admin({ name, email: `${name.toLowerCase()}${Date.now()}@crm.test`, password: "12345678", status: "active", isActive: true, type: "viewer", roleKey }).save();
  asif = (await person("Asif", "sales")).toObject();
  maya = (await person("Maya", "sales")).toObject();
  const owners = await svc.Setup.owners();
  const names = owners.map((o) => o.name);
  assert.ok(names.includes("Asif") && names.includes("Maya"), names.join(", "));
  // The seeded super admins may work it too; a storekeeper would not appear, having no crm.view.
  const keeper = await person("Store", "storekeeper");
  assert.equal((await svc.Setup.owners()).some((o) => o.id === String(keeper._id)), false, "a storekeeper holds no crm.view, so nothing is given to them");
});

test("the pipeline is seeded on the first read, once, and reads the same twice", { skip }, async () => {
  const first = await svc.Setup.stages();
  assert.deepEqual(first.map((s) => s.key), ["new", "qualified", "quoted", "accepted", "won", "lost"]);
  const second = await svc.Setup.stages();
  assert.equal(await svc.StageModel.countDocuments({}), 6, "a second read does not seed it again");
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.filter((s) => s.advanceOn).map((s) => [s.key, s.advanceOn]),
    [["quoted", "quotation_sent"], ["accepted", "quotation_accepted"], ["won", "invoice_approved"]]
  );
});

test("an enquiry arrives: it is numbered, given an owner and left with a follow-up due today", { skip }, async () => {
  lead = await svc.Lead.create(
    { name: "Hassan Al Noor", company: "Al Noor Foods", phone: "0501234567", email: "buyer@alnoor.ae", source: "referral", sourceNote: "sent by Gulf Trading", interest: "Monthly rice and oil", expectedValue: 45000 },
    asif._id
  );
  assert.match(lead.leadNo, /^LD-\d{4}-0001$/);
  assert.equal(lead.status, "NEW");
  assert.ok(lead.ownerId, "the automation gave it to somebody without being asked");
  // Warm, not hot: a referral worth 45,000 is promising, but nobody has spoken to them yet - engagement is what makes
  // a lead hot, which is the whole reason the score falls again when it goes quiet.
  assert.equal(lead.band, "warm", `${lead.band} (${lead.score})`);

  const open = await svc.Act.openFor(lead._id);
  assert.equal(open.length, 1, "exactly one first action");
  assert.equal(open[0].dueAt, today(), "due today: nobody sits on a new enquiry");
  assert.equal(open[0].auto, true);
  assert.equal(open[0].ownerId, lead.ownerId, "and it is owed by whoever owns the lead");
  assert.equal((await svc.LeadModel.findById(lead._id).lean()).nextActionAt, today());
});

test("round robin: the next enquiry goes to somebody else", { skip }, async () => {
  const second = await svc.Lead.create({ name: "Second caller", phone: "0509999999", source: "phone" }, asif._id);
  assert.notEqual(second.ownerId, lead.ownerId, "two enquiries in a row do not land on one person");
  const third = await svc.Lead.create({ name: "Third caller", phone: "0508888888", source: "walk_in" }, asif._id);
  assert.notEqual(third.ownerId, second.ownerId);
  await svc.Lead.remove(second._id, asif._id);
  await svc.Lead.remove(third._id, asif._id);
});

test("somebody we may already know is reported, never refused", { skip }, async () => {
  const found = await svc.Lead.possibleDuplicates({ phone: "0501234567" });
  assert.equal(found.leads.length, 1);
  assert.equal(found.leads[0].leadNo, lead.leadNo);
  const again = await svc.Lead.create({ name: "Hassan again", phone: "0501234567", source: "phone" }, asif._id);
  assert.ok(again._id, "the second enquiry from the same number is still accepted");
  await svc.Lead.remove(again._id, asif._id);
});

test("the call is made: the outcome is recorded, the next one is entered in the same breath", { skip }, async () => {
  const [first] = await svc.Act.openFor(lead._id);
  const { activity, next } = await svc.Act.done(first._id, { outcome: "interested", notes: "Wants a price for 200 bags", nextDueAt: svc.days.addDays(today(), 2), nextSubject: "Send the price" }, asif._id);
  assert.equal(activity.status, "DONE");
  assert.equal(activity.outcome, "interested");
  assert.ok(next, "and the deal is not left with nothing owed");
  assert.equal(next.dueAt, svc.days.addDays(today(), 2));

  const fresh = await svc.LeadModel.findById(lead._id).lean();
  assert.equal(fresh.contactCount, 1, "the contact is counted");
  assert.equal(fresh.lastActivityDay, today());
  assert.equal(fresh.nextActionAt, next.dueAt, "and the lead knows when the next thing is due");
  assert.ok(fresh.score >= lead.score, "talking to somebody does not make them colder");
});

test("a note is recorded as done at once: it is a thing that happened, not a thing to do", { skip }, async () => {
  const note = await svc.Act.create({ kind: "note", subject: "Met at Gulfood", regarding: { kind: "lead", id: String(lead._id) } }, asif._id);
  assert.equal(note.status, "DONE", "a note never sits in somebody's worklist asking to be ticked off");
  assert.equal((await svc.Act.openFor(lead._id)).length, 1, "and it is not a second open action");
});

test("qualifying makes a real customer with its ledger account, and a deal on the first stage", { skip }, async () => {
  const out = await svc.Lead.qualify(lead._id, { creditLimit: 50000 }, asif._id);
  deal = out.opportunity;

  const customer = await svc.Customer.findById(out.customerId).lean();
  assert.equal(customer.customerName, "Al Noor Foods");
  assert.match(customer.customerId, /^CUST\d{4}\d{3}$/);
  assert.equal(customer.creditLimit, 50000);
  assert.equal(customer.contactPerson, "Hassan Al Noor");
  const account = await svc.LedgerAccount.findOne({ accountName: "Customer - Al Noor Foods" }).lean();
  assert.ok(account, "the customer is in the chart of accounts, exactly as one entered by hand would be");

  assert.match(deal.opportunityNo, /^OPP-\d{4}-0001$/);
  assert.equal(deal.stageKey, "new");
  assert.equal(deal.probability, 10);
  assert.equal(deal.value, 45000, "the enquiry's expected value carries over");
  assert.equal(String(deal.customerId), String(customer._id));
  assert.equal(deal.ownerId, lead.ownerId, "and it stays with the person who was chasing it");

  const fresh = await svc.LeadModel.findById(lead._id).lean();
  assert.equal(fresh.status, "CONVERTED");
  assert.equal(String(fresh.opportunityId), String(deal._id));

  const moved = await svc.Act.openFor(deal._id);
  assert.equal(moved.length, 1, "the chasing carried on against the deal");
  assert.equal(moved[0].subject, "Send the price", "the very follow-up that was owed, not a new one");
  assert.equal((await svc.Act.openFor(lead._id)).length, 0, "and nothing is left owed against the lead");
});

test("qualifying twice does not make a second customer", { skip }, async () => {
  await fails(() => svc.Lead.qualify(lead._id, {}, asif._id), "LEAD_CLOSED");
  assert.equal(await svc.Customer.countDocuments({ customerName: "Al Noor Foods" }), 1);
});

test("a converted lead cannot be deleted: it is how the customer came to be", { skip }, async () => {
  await fails(() => svc.Lead.remove(lead._id, asif._id), "LEAD_CONVERTED");
});

test("a deal is moved by hand, and the stage it lands on decides what is owed next", { skip }, async () => {
  const moved = await svc.Opp.moveStage(deal._id, { stageKey: "qualified" }, asif._id);
  assert.equal(moved.stageName, "Qualified");
  assert.equal(moved.probability, 25);
  assert.equal(moved.stageSinceDay, today());

  // There was already something owed, so no second reminder is piled on
  assert.equal((await svc.Act.openFor(deal._id)).length, 1);

  // Clear it, move again, and the new stage leaves its own follow-up behind
  const [owed] = await svc.Act.openFor(deal._id);
  await svc.Act.done(owed._id, { outcome: "quoted" }, asif._id);
  const quoted = await svc.Opp.moveStage(deal._id, { stageKey: "quoted" }, asif._id);
  const owedNow = await svc.Act.openFor(quoted._id);
  assert.equal(owedNow.length, 1);
  assert.equal(owedNow[0].dueAt, svc.days.addDays(today(), 3), "three days, which is what the Quotation sent stage says");
  assert.equal(owedNow[0].auto, true);
});

test("the board: every stage, what sits on it, and what the pipeline is worth", { skip }, async () => {
  const board = await svc.Opp.pipeline();
  assert.deepEqual(board.stages.map((s) => s.key), ["new", "qualified", "quoted", "accepted", "won", "lost"]);
  const quoted = board.stages.find((s) => s.key === "quoted");
  assert.equal(quoted.count, 1);
  assert.equal(quoted.value, 45000);
  assert.equal(board.totals.count, 1);
  assert.equal(board.totals.value, 45000);
  assert.equal(board.totals.weighted, 22500, "45,000 at the Quotation sent stage's 50%");
});

test("losing a deal needs a reason, and takes the chasing off somebody's list", { skip }, async () => {
  const second = await svc.Opp.create({ title: "Trial order", customerId: String(deal.customerId), value: 8000 }, asif._id);
  await fails(() => svc.Opp.lose(second._id, {}, asif._id), "LOST_REASON_REQUIRED");

  const lost = await svc.Opp.lose(second._id, { reason: "price", note: "Found cheaper rice" }, asif._id);
  assert.equal(lost.status, "LOST");
  assert.equal(lost.stageKey, "lost");
  assert.equal(lost.probability, 0);
  assert.equal(lost.closedDay, today());
  assert.equal((await svc.Act.openFor(second._id)).length, 0, "a closed deal owes nobody anything");
  assert.equal(await svc.ActModel.countDocuments({ "regarding.id": second._id, status: "CANCELLED" }), 1);

  const reopened = await svc.Opp.reopen(second._id, asif._id);
  assert.equal(reopened.status, "OPEN");
  assert.equal(reopened.stageKey, "accepted", "it goes back to the last open stage, not to the beginning");
  assert.equal(reopened.lostReason, null);
  await svc.Opp.remove(second._id, asif._id);
});

test("a won deal stays on record: it cannot be deleted", { skip }, async () => {
  const third = await svc.Opp.create({ title: "Won and done", customerId: String(deal.customerId), value: 1000 }, asif._id);
  await svc.Opp.win(third._id, {}, asif._id);
  const won = await svc.OppModel.findById(third._id).lean();
  assert.equal(won.status, "WON");
  assert.equal(won.probability, 100);
  await fails(() => svc.Opp.remove(third._id, asif._id), "OPPORTUNITY_WON");
});

test("handing a deal over hands over its follow-ups too", { skip }, async () => {
  const given = await svc.Opp.assign(deal._id, String(maya._id), asif._id);
  assert.equal(given.ownerName, "Maya");
  const owed = await svc.Act.openFor(deal._id);
  assert.equal(owed[0].ownerId, String(maya._id), "a deal handed over with somebody else's reminders on it is a deal nobody chases");
  assert.equal(owed[0].ownerName, "Maya");

  const mine = await svc.Act.list({ scope: "mine" }, { adminId: String(maya._id) });
  assert.equal(mine.length, 1);
  const notMine = await svc.Act.list({ scope: "mine" }, { adminId: String(asif._id) });
  assert.equal(notMine.length, 0, "and it is off the other person's list");
});

test("the worklist and the badge count only what is actually owed, by day", { skip }, async () => {
  const [owed] = await svc.Act.openFor(deal._id);
  await svc.ActModel.updateOne({ _id: owed._id }, { $set: { dueAt: svc.days.addDays(today(), -2) } });

  const overdue = await svc.Act.list({ scope: "mine", due: "overdue" }, { adminId: String(maya._id) });
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].dueState, "overdue");
  assert.equal((await svc.Act.list({ scope: "mine", due: "today" }, { adminId: String(maya._id) })).length, 0);
  assert.deepEqual(await svc.Act.dueCount({ adminId: String(maya._id) }), { count: 1 }, "overdue counts as due: it is owed now");
  assert.deepEqual(await svc.Act.dueCount({ adminId: String(asif._id) }), { count: 0 });
  assert.deepEqual(await svc.Act.dueCount({ adminId: null }), { count: 0 }, "and nobody signed in owes nothing");
});

test("the stages can be changed, and every open deal follows the new wording", { skip }, async () => {
  const stages = await svc.Setup.stages();
  const renamed = stages.map((s) => (s.key === "quoted" ? { ...s, name: "Offer out", probability: 55 } : s));
  await svc.Setup.replaceStages(renamed, "tester");
  const fresh = await svc.OppModel.findById(deal._id).lean();
  assert.equal(fresh.stageName, "Offer out", "the copy a list reads is refreshed, or a renamed stage still reads by its old name");
  assert.equal(fresh.probability, 55);

  // A stage with open deals on it cannot simply vanish
  const without = renamed.filter((s) => s.key !== "quoted");
  const error = await fails(() => svc.Setup.replaceStages(without, "tester"), "STAGE_IN_USE");
  assert.match(error.message, /Offer out/);
  assert.equal(error.details.deals, 1);

  await svc.Setup.replaceStages(stages, "tester"); // put it back
});

test("the settings decide the automation: with auto-follow-up off, nothing is left owed", { skip }, async () => {
  await svc.Setup.saveSettings({ autoFollowUp: false }, "tester");
  const quiet = await svc.Opp.create({ title: "No chasing wanted", customerId: String(deal.customerId), value: 100 }, asif._id);
  assert.equal((await svc.Act.openFor(quiet._id)).length, 0);

  await svc.Setup.saveSettings({ autoFollowUp: true }, "tester");
  const chased = await svc.Opp.create({ title: "Chasing wanted", customerId: String(deal.customerId), value: 100 }, asif._id);
  assert.equal((await svc.Act.openFor(chased._id)).length, 1);
  await svc.Opp.remove(quiet._id, asif._id);
  await svc.Opp.remove(chased._id, asif._id);
});

test("the report counts what came in, what became of it, and how well", { skip }, async () => {
  const out = await svc.Report.analysis({});
  assert.equal(out.leads.total >= 1, true);
  assert.equal(out.leads.converted, 1);
  assert.equal(out.leads.conversionRate !== null, true);
  assert.equal(out.deals.won, 1);
  assert.equal(out.deals.lost, 0, "the lost one was deleted again, so the period holds none");
  assert.equal(out.deals.winRate, 100);
  assert.ok(out.bySource.some((r) => r.source === "referral"));
  assert.ok(out.funnel.length === 6);

  await fails(() => svc.Report.analysis({ from: "2026-10-20", to: "2026-10-01" }), "INVALID_RANGE");

  const summary = await svc.Report.summary();
  assert.equal(summary.openDeals >= 1, true);
  assert.equal(summary.pipelineValue >= 45000, true);
  assert.equal(summary.overdue >= 1, true, "the one we back-dated");
});

test("refusals: a deal needs a customer that exists, a follow-up something that exists", { skip }, async () => {
  const missing = new mongoose.Types.ObjectId();
  await fails(() => svc.Opp.create({ title: "Nobody", customerId: String(missing) }, asif._id), "CUSTOMER_NOT_FOUND");
  await fails(() => svc.Opp.create({ title: "", customerId: String(deal.customerId) }, asif._id), "OPPORTUNITY_TITLE_REQUIRED");
  await fails(() => svc.Opp.getById("not-an-id"), "OPPORTUNITY_NOT_FOUND");
  await fails(() => svc.Opp.getById(String(missing)), "OPPORTUNITY_NOT_FOUND");
  await fails(() => svc.Act.create({ kind: "call", subject: "x", regarding: { kind: "lead", id: String(missing) } }, asif._id), "LEAD_NOT_FOUND");
  await fails(() => svc.Act.create({ kind: "call", subject: "x", regarding: { kind: "opportunity", id: String(missing) } }, asif._id), "OPPORTUNITY_NOT_FOUND");
  await fails(() => svc.Lead.create({ name: "No way to reach them" }, asif._id), "LEAD_CONTACT_REQUIRED");
  // A hostile body is refused, not crashed on
  await fails(() => svc.Lead.create({ name: { $ne: "x" }, phone: ["0501234567"] }, asif._id), "LEAD_NAME_REQUIRED");
});

test("a follow-up that is done is a record of what happened: it cannot be changed or deleted", { skip }, async () => {
  const note = await svc.Act.create({ kind: "call", subject: "Rang", regarding: { kind: "opportunity", id: String(deal._id) }, dueAt: today() }, asif._id);
  await svc.Act.done(note._id, { outcome: "spoke" }, asif._id);
  await fails(() => svc.Act.update(note._id, { subject: "Changed my mind" }, asif._id), "ACTIVITY_DONE");
  await fails(() => svc.Act.remove(note._id, asif._id), "ACTIVITY_DONE");
  await fails(() => svc.Act.done(note._id, { outcome: "spoke" }, asif._id), "ACTIVITY_DONE");
});

test("the deal's own screen carries its customer, its timeline and the pipeline it sits in", { skip }, async () => {
  const view = await svc.Opp.getById(deal._id);
  assert.equal(view.customer.customerName, "Al Noor Foods");
  assert.ok(view.timeline.length >= 2);
  assert.equal(view.pipeline.length, 6);
  assert.equal(view.stage.key, view.stageKey);
  assert.equal(view.weighted, Math.round(view.value * view.stage.probability) / 100);
});
