// Onboarding/exit checklists and appraisals (W6) against a throwaway database.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_talent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Staff: require("../staff/staffService"),
    Contract: require("../hr/contractService"),
    talent: require("../hr/talentService"),
    days: require("../../utils/documentExpiry"),
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

const admin = new mongoose.Types.ObjectId();
const today = () => svc.days.todayInOrg();

let staff;

test("setup: an employee", { skip }, async () => {
  staff = await svc.Staff.createStaff(
    { name: "Nina Talent", designation: "Clerk", contactNo: "0505454545", idNo: "784TAL0001" + (Date.now() % 100000), joiningDate: today() },
    {}, admin
  );
});

test("starting an onboarding checklist creates every standard item, open, for that employee", { skip }, async () => {
  const rows = await svc.talent.ChecklistService.start({ staffId: staff._id, listType: "onboarding" }, "tester");
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.status === "OPEN"));
  assert.ok(rows.every((r) => String(r.staffId) === String(staff._id)));
  assert.ok(rows.some((r) => /ID and visa/.test(r.subject)));
});

test("a made-up list type is refused, not silently started as something else", { skip }, async () => {
  await assert.rejects(() => svc.talent.ChecklistService.start({ staffId: staff._id, listType: "nonsense" }, "tester"), (e) => e.code === "INVALID_LIST_TYPE");
});

test("the checklist can be read back, and a custom item added on top of the standard ones", { skip }, async () => {
  const added = await svc.talent.ChecklistService.addItem({ staffId: staff._id, listType: "onboarding", subject: "Book desk near the team" }, "tester");
  assert.equal(added.subject, "Book desk near the team");

  const list = await svc.talent.ChecklistService.forStaff(staff._id);
  assert.equal(list.length, 6, "5 standard + 1 custom");
});

test("marking an item done is one-way - it cannot be done twice", { skip }, async () => {
  const list = await svc.talent.ChecklistService.forStaff(staff._id);
  const open = list.find((r) => r.status === "OPEN");
  const done = await svc.talent.ChecklistService.markDone(open._id, "tester");
  assert.equal(done.status, "DONE");
  assert.ok(done.completedAt);
  await assert.rejects(() => svc.talent.ChecklistService.markDone(open._id, "tester"), (e) => e.code === "NOT_OPEN");
});

test("an exit checklist is its own separate list for the same employee", { skip }, async () => {
  const rows = await svc.talent.ChecklistService.start({ staffId: staff._id, listType: "exit" }, "tester");
  assert.equal(rows.length, 5);
  const all = await svc.talent.ChecklistService.forStaff(staff._id);
  assert.equal(all.length, 11, "6 onboarding (5 standard + 1 custom) + 5 exit");
  assert.equal(all.filter((r) => r.listType === "exit").length, 5);
});

test("an appraisal needs real content, and reads the pay in force at the review day for a confidential reader", { skip }, async () => {
  await svc.Contract.create({ staffId: staff._id, effectiveFrom: today(), basicPay: 5000, allowances: 500 }, admin);

  await assert.rejects(
    () => svc.talent.AppraisalService.create({ staffId: staff._id, periodLabel: "2026 annual", reviewDate: today() }, "tester"),
    (e) => e.code === "APPRAISAL_EMPTY"
  );

  const made = await svc.talent.AppraisalService.create(
    { staffId: staff._id, periodLabel: "2026 annual", reviewDate: today(), rating: "Meets expectations", strengths: "Reliable" },
    "tester"
  );
  assert.equal(made.periodLabel, "2026 annual");

  const withPay = await svc.talent.AppraisalService.withContext(staff._id, { confidential: true });
  assert.equal(withPay.length, 1);
  assert.equal(withPay[0].payAtReview.basicPay, 5000, "the pay in force on the review day, read for context - never edited from here");

  const withoutPay = await svc.talent.AppraisalService.withContext(staff._id, { confidential: false });
  assert.equal(withoutPay[0].payAtReview, undefined, "a reader without hr.confidential never sees the figure, the same gate a contract's own pay already uses");
});
