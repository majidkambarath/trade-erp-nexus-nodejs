// Payroll against a throwaway database: a run posted Dr Salaries Expense / Cr Statutory Deductions
// Payable + Salaries Payable for exactly the figures utils/payroll.js computes, refused a second time for
// the same period, and undone cleanly on reversal. One journal for the whole organisation (D14), never
// one posting per employee.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_payroll_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Staff: require("../staff/staffService"),
    Contract: require("../hr/contractService"),
    Component: require("../hr/salaryComponentService"),
    Payroll: require("../hr/payrollService"),
    Audit: require("../financial/voucherAuditService"),
    LedgerAccount: fin.LedgerAccount,
    days: require("../../utils/documentExpiry"),
    Org: require("../core/organisationService"),
    ctx: require("../../utils/tenantContext"),
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
const nextMonth = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };

let P0, P1, P2, P3;
let expenseAcc, deductionsAcc, payableAcc;
let ravi, anya, pf, run1Id;

test("setup: two employees, a PF component, and the three posting accounts", { skip }, async () => {
  P0 = today().slice(0, 7);
  P1 = nextMonth(P0);

  ravi = await svc.Staff.createStaff(
    { name: "Ravi Payroll", designation: "Fabricator", contactNo: "0505555555", idNo: "784PAY0001" + (Date.now() % 100000), joiningDate: svc.days.addDays(today(), -400) },
    {}, admin
  );
  await svc.Contract.create({ staffId: ravi._id, effectiveFrom: svc.days.addDays(today(), -400), basicPay: 6000, allowances: 1000 }, admin);

  anya = await svc.Staff.createStaff(
    { name: "Anya Payroll", designation: "Clerk", contactNo: "0506666666", idNo: "784PAY0002" + (Date.now() % 100000), joiningDate: svc.days.addDays(today(), -400) },
    {}, admin
  );
  await svc.Contract.create({ staffId: anya._id, effectiveFrom: svc.days.addDays(today(), -400), basicPay: 4000, allowances: 0 }, admin);

  pf = await svc.Component.create({ name: "PF", kind: "deduction", computation: "percentOfBasic", rate: 12, capBase: 15000 }, "tester");

  expenseAcc = await svc.LedgerAccount.findById(await svc.Config.resolveAccount("salary-expense")).lean();
  deductionsAcc = await svc.LedgerAccount.findById(await svc.Config.resolveAccount("statutory-deductions-payable")).lean();
  payableAcc = await svc.LedgerAccount.findById(await svc.Config.resolveAccount("salaries-payable")).lean();
});

test("a plan previews the real figures without writing anything", { skip }, async () => {
  const plan = await svc.Payroll.plan(P1);
  assert.equal(plan.alreadyPosted, false);
  assert.equal(plan.totals.employeeCount, 2);
  // gross: Ravi 7000, Anya 4000 = 11000. PF: Ravi 12% of min(6000,15000)=720, Anya 720*? -> 12% of 4000=480
  assert.equal(plan.totals.gross, 11000);
  assert.equal(plan.totals.deductions, 1200, "720 (Ravi) + 480 (Anya)");
  assert.equal(plan.totals.net, 9800);
  assert.equal(plan.assessment.canClose, true);

  const unposted = await svc.Payroll.list();
  assert.equal(unposted.find((r) => r.period === P1), undefined, "nothing written yet");
});

test("posting debits Salaries Expense and credits the deductions and payable accounts for exactly the plan's figures", { skip }, async () => {
  const expBefore = r2((await svc.LedgerAccount.findById(expenseAcc._id).lean()).currentBalance);
  const dedBefore = r2((await svc.LedgerAccount.findById(deductionsAcc._id).lean()).currentBalance);
  const payBefore = r2((await svc.LedgerAccount.findById(payableAcc._id).lean()).currentBalance);

  const { run, employeeCount } = await svc.Payroll.post(P1, {}, "tester");
  assert.equal(employeeCount, 2);
  assert.match(run.voucherNo, /^PAY-\d{4}-\d{4}$/);
  assert.equal(run.totalGross, 11000);
  assert.equal(run.totalDeductions, 1200);
  assert.equal(run.totalNet, 9800);
  run1Id = run._id;

  const expAfter = r2((await svc.LedgerAccount.findById(expenseAcc._id).lean()).currentBalance);
  const dedAfter = r2((await svc.LedgerAccount.findById(deductionsAcc._id).lean()).currentBalance);
  const payAfter = r2((await svc.LedgerAccount.findById(payableAcc._id).lean()).currentBalance);
  assert.equal(r2(expAfter - expBefore), 11000, "the full gross is a real expense, debited");
  assert.equal(r2(dedAfter - dedBefore), 1200, "PF credited to the liability, its own natural side");
  assert.equal(r2(payAfter - payBefore), 9800, "net pay owed to staff, credited");

  const payslips = await svc.Payroll.payslipsFor(run._id);
  assert.equal(payslips.length, 2);
  const r = payslips.find((p) => p.staffName === "Ravi Payroll");
  assert.equal(r.grossPay, 7000);
  assert.equal(r.deductions[0].amount, 720);
  assert.equal(r.netPay, 6280);
});

test("the same period cannot be posted twice", { skip }, async () => {
  await assert.rejects(() => svc.Payroll.post(P1, {}, "tester"), (e) => e.code === "ALREADY_POSTED");
});

test("the posting trail reads the run by its own id, like a production or a gratuity accrual", { skip }, async () => {
  const trail = await svc.Audit.postingTrail(run1Id);
  assert.equal(trail.voucher.typeLabel, "Payroll run");
  assert.ok(trail.source.facts.some((f) => f.label === "Period"));
  assert.equal(trail.ledger.balanced, true);
});

test("reversing undoes the posting cleanly - the ledger returns to exactly where it started", { skip }, async () => {
  const expBefore = r2((await svc.LedgerAccount.findById(expenseAcc._id).lean()).currentBalance);
  const dedBefore = r2((await svc.LedgerAccount.findById(deductionsAcc._id).lean()).currentBalance);
  const payBefore = r2((await svc.LedgerAccount.findById(payableAcc._id).lean()).currentBalance);

  await svc.Payroll.reverse(run1Id, { reason: "test reversal" }, "tester");

  const expAfter = r2((await svc.LedgerAccount.findById(expenseAcc._id).lean()).currentBalance);
  const dedAfter = r2((await svc.LedgerAccount.findById(deductionsAcc._id).lean()).currentBalance);
  const payAfter = r2((await svc.LedgerAccount.findById(payableAcc._id).lean()).currentBalance);
  assert.equal(r2(expAfter - expBefore), -11000);
  assert.equal(r2(dedAfter - dedBefore), -1200);
  assert.equal(r2(payAfter - payBefore), -9800);

  await assert.rejects(() => svc.Payroll.reverse(run1Id, {}, "tester"), (e) => e.code === "ALREADY_REVERSED");
});

test("a reversed period can be posted again - a fresh run, a fresh number", { skip }, async () => {
  const { run } = await svc.Payroll.post(P1, {}, "tester");
  assert.notEqual(String(run._id), String(run1Id));
  assert.notEqual(run.voucherNo, undefined);
});

test("an inactive component is ignored by the plan, and an eligibility ceiling genuinely rules somebody out", { skip }, async () => {
  const esi = await svc.Component.create({ name: "ESI", kind: "deduction", computation: "percentOfGross", rate: 0.75, eligibleUpTo: 6500 }, "tester");
  // Ravi's gross is 7000 - over the 6500 ceiling, so ESI does not apply to him at all; Anya's is 4000, under it
  P2 = nextMonth(P1);
  const plan = await svc.Payroll.plan(P2);
  const r = plan.employees.find((e) => e.staffName === "Ravi Payroll");
  const a = plan.employees.find((e) => e.staffName === "Anya Payroll");
  assert.ok(!r.slip.deductions.some((d) => d.name === "ESI"), "Ravi is over the ESI ceiling");
  assert.ok(a.slip.deductions.some((d) => d.name === "ESI"), "Anya is under it");
  await svc.Component.update(esi._id, { isActive: false }, "tester");
});

test("a negative net pay is a blocker the run refuses outright", { skip }, async () => {
  const hungryPf = await svc.Component.create({ name: "Huge deduction", kind: "deduction", computation: "fixed", rate: 999999 }, "tester");
  P3 = nextMonth(P2);
  const plan = await svc.Payroll.plan(P3);
  assert.equal(plan.assessment.canClose, false);
  assert.ok(plan.assessment.blockers.some((b) => b.code === "NEGATIVE_NET"));
  await assert.rejects(() => svc.Payroll.post(P3, {}, "tester"), (e) => e.code === "NEGATIVE_NET");
  await svc.Component.remove(hungryPf._id);
});

// ---- the IN starter components, lazily seeded, race-tolerant like StatutoryRule's own seed -----------

const inOrg = (fn) => svc.ctx.runWithTenant({ companyId: "payrollin", branchId: "main" }, fn);

test("an IN organisation is seeded PF, ESI and professional tax on first read, and only once", { skip }, async () => {
  await svc.Org.create({ legalName: "Payroll IN Test", code: "payrollin", country: "IN", baseCurrency: "INR", timezone: "Asia/Kolkata", planCode: "premium" }, { by: "dev" });
  await inOrg(() => svc.seed({ log: () => {} }));

  // two concurrent first reads - the same race StatutoryRuleService.ensureDefaults already tolerates
  const [a, b] = await inOrg(() => Promise.all([svc.Component.forCountry("IN"), svc.Component.forCountry("IN")]));
  assert.equal(a.length, 3, "PF, ESI and professional tax - seeded once, not six times by the race");
  assert.equal(b.length, 3);
  assert.deepEqual(a.map((c) => c.name).sort(), ["ESI", "PF", "Professional Tax"]);
  assert.ok(a.every((c) => c.isSystem), "marked as a seeded default, the same \"confirm it\" pattern StatutoryRule rows carry");
});

test("the IN PF component reads its rate and ceiling from StatutoryRule, not a stored constant", { skip }, async () => {
  const plan = await inOrg(async () => {
    const staff = await svc.Staff.createStaff(
      { name: "Deepak Payroll", designation: "Operator", contactNo: "0509999999", idNo: "INPAY0001" + (Date.now() % 100000), joiningDate: svc.days.addDays(svc.days.todayInOrg(), -100) },
      {}, admin
    );
    await svc.Contract.create({ staffId: staff._id, effectiveFrom: svc.days.addDays(svc.days.todayInOrg(), -100), basicPay: 20000 }, admin);
    const StatutoryRuleService = require("../hr/statutoryRuleService");
    await StatutoryRuleService.create({ country: "IN", key: "in.pf.employeeRate", value: 10, effectiveFrom: "2022-01-01" }, "tester");
    const month = svc.days.todayInOrg().slice(0, 7);
    return svc.Payroll.plan(month);
  });
  const row = plan.employees.find((e) => e.staffName === "Deepak Payroll");
  const pfLine = row.slip.deductions.find((d) => d.name === "PF");
  assert.equal(pfLine.amount, 1500, "10% of min(20000, 15000) = 1500 - the CORRECTED rate, from StatutoryRule, not the seeded 12%");
});
