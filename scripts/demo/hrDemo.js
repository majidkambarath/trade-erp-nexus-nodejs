// A small, believable HR department for a demo: a dozen people across three departments, what each of them
// costs an hour, a month of attendance, leave that is pending and leave that was approved, a posted payroll
// run, documents about to expire, assets in hands, a gratuity liability and one employee who can sign into
// the portal.
//
// It goes through the REAL services, not raw inserts. Every row is one the product itself would have
// written: an employee gets a generated code, a contract is a dated row with its money fields hidden from a
// reader who may not see pay, a leave request is decided through the same ApprovalPolicyService a trade
// document is, payroll posts one journal for the whole organisation, and the gratuity accrual is the
// incremental liability rather than a figure somebody typed. A demo built by hand would look right and
// behave wrong; this one cannot.
//
//   node scripts/demo/hrDemo.js --org=abc
//   node scripts/demo/hrDemo.js --org=abc --undo
//
// `--undo` removes the HR rows it made, newest-dependency-first. It deliberately does NOT reverse the
// payroll journal or the gratuity accrual: those are LEDGER postings, and unposting money belongs to a
// person pressing the button on the screen that explains what it does.
require("dotenv").config();
const mongoose = require("mongoose");
const { runWithTenant } = require("../../utils/tenantContext");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const ORG = arg("org");
const UNDO = process.argv.includes("--undo");
const MARK = "hr-demo"; // every row this script writes is stamped with it, so --undo is exact

// A fabrication and coating business, which is what the labour-costing half of this module is FOR: people
// whose hours end up in the cost of a product. Three departments, so "cost by department" says something.
const PEOPLE = [
  { name: "Rashid Al Blooshi", designation: "Works Manager", dept: "Fabrication", nationality: "AE", monthsAgo: 38, basic: 14000, allow: 3500, hours: 195 },
  { name: "Suresh Menon", designation: "Fabricator", dept: "Fabrication", nationality: "IN", monthsAgo: 29, basic: 4200, allow: 900, hours: 208 },
  { name: "Anil Kumar", designation: "Fabricator", dept: "Fabrication", nationality: "IN", monthsAgo: 22, basic: 4000, allow: 900, hours: 208 },
  { name: "Mohammed Farouk", designation: "Welder", dept: "Fabrication", nationality: "EG", monthsAgo: 17, basic: 3800, allow: 800, hours: 208 },
  { name: "Bikash Tamang", designation: "Helper", dept: "Fabrication", nationality: "NP", monthsAgo: 9, basic: 2200, allow: 600, hours: 208 },
  { name: "Ganesh Pillai", designation: "Coating Supervisor", dept: "Coating", nationality: "IN", monthsAgo: 26, basic: 6500, allow: 1500, hours: 195 },
  { name: "Ravi Shankar", designation: "Coating Operator", dept: "Coating", nationality: "IN", monthsAgo: 14, basic: 3600, allow: 800, hours: 208 },
  { name: "Arun Das", designation: "Coating Operator", dept: "Coating", nationality: "IN", monthsAgo: 6, basic: 3400, allow: 800, hours: 208 },
  { name: "Fatima Al Marzooqi", designation: "Accountant", dept: "Administration", nationality: "AE", monthsAgo: 31, basic: 9500, allow: 2500, hours: 180 },
  { name: "Priya Raghavan", designation: "HR & Admin Officer", dept: "Administration", nationality: "IN", monthsAgo: 19, basic: 6000, allow: 1800, hours: 180 },
  { name: "Joseph Mathew", designation: "Storekeeper", dept: "Administration", nationality: "IN", monthsAgo: 11, basic: 3200, allow: 900, hours: 195 },
  // A joiner this month and a leaver last month, so the headcount chart has a shape rather than a flat line.
  { name: "Sandeep Verma", designation: "Fabricator", dept: "Fabrication", nationality: "IN", monthsAgo: 0, basic: 3900, allow: 900, hours: 208 },
  { name: "Imran Qureshi", designation: "Helper", dept: "Coating", nationality: "PK", monthsAgo: 20, basic: 2100, allow: 600, hours: 208, leftMonthsAgo: 1 },
];

const DEPARTMENTS = ["Fabrication", "Coating", "Administration"];

// Documents that expire, which is the whole point of the expiry register: one already gone, two close, the
// rest comfortable. `inDays` is from today.
const DOCUMENTS = [
  { who: 1, name: "Labour card", number: "LC-884512", inDays: -6 },
  { who: 3, name: "Residence visa", number: "VS-229087", inDays: 11 },
  { who: 4, name: "Passport", number: "N4482910", inDays: 24 },
  { who: 6, name: "Labour card", number: "LC-771203", inDays: 58 },
  { who: 0, name: "Residence visa", number: "VS-100234", inDays: 190 },
  { who: 8, name: "Passport", number: "P9921045", inDays: 320 },
];

const ASSETS = [
  { who: 0, assetName: "Dell Latitude 5440", assetTag: "IT-0012", condition: "Good" },
  { who: 5, assetName: "Coating gun, Wagner", assetTag: "EQ-0031", condition: "New" },
  { who: 8, assetName: "HP ProBook 450", assetTag: "IT-0019", condition: "Good" },
  { who: 9, assetName: "iPhone SE", assetTag: "IT-0023", condition: "Fair" },
  { who: 10, assetName: "Stores scanner", assetTag: "EQ-0044", condition: "Good" },
  // Already back, so the register shows both states.
  { who: 2, assetName: "Angle grinder", assetTag: "EQ-0028", condition: "Fair", returnedDaysAgo: 4 },
];

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const shiftDays = (day, n) => dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000));
const monthsBack = (today, n) => {
  const [y, m, d] = today.split("-").map(Number);
  const t = y * 12 + (m - 1) - n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-${pad(Math.min(d, 28))}`;
};
const weekend = (day) => [5, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()); // Fri/Sat, the UAE week

async function seed(M, today) {
  const by = MARK;
  const month = today.slice(0, 7);

  // ---- the masters the rest leans on
  const departments = new Map();
  for (const name of DEPARTMENTS) {
    const existing = (await M.Dept.list()).find((d) => d.name === name);
    departments.set(name, existing || (await M.Dept.create({ name }, by)));
  }
  const shifts = await M.Shift.list();
  const shift = shifts.find((s) => s.name === "Day shift") || (await M.Shift.create({ name: "Day shift", startTime: "08:00", endTime: "17:00", hours: 9, halfDayBelowHours: 4 }, by));
  const types = await M.LeaveType.list();
  const annual = types.find((t) => t.name === "Annual") || (await M.LeaveType.create({ name: "Annual", accrualPerMonth: 2.5, maxCarryForward: 30, isPaid: true }, by));
  const sick = types.find((t) => t.name === "Sick") || (await M.LeaveType.create({ name: "Sick", accrualPerMonth: 1.25, isPaid: true }, by));
  // The statutory figures gratuity and Emiratisation read. Seeded as the product's own defaults, which the
  // Setup screen says loudly are to be confirmed with the client's accountant.
  await M.Rule.ensureDefaults((await M.Org.findOne({ code: ORG }).lean()).country);
  console.log(`  masters: ${DEPARTMENTS.length} departments, 1 shift, 2 leave types, statutory defaults`);

  // ---- the people, and what an hour of each costs
  const staff = [];
  for (const p of PEOPLE) {
    const joining = monthsBack(today, p.monthsAgo);
    const person = await M.Staff.createStaff(
      {
        name: p.name, designation: p.designation, nationality: p.nationality,
        departmentId: departments.get(p.dept)._id,
        contactNo: `05${Math.floor(10000000 + Math.random() * 89999999)}`,
        idNo: `784${joining.slice(2, 4)}${Math.floor(1000000 + Math.random() * 8999999)}`,
        joiningDate: joining,
        email: `${p.name.split(" ")[0].toLowerCase()}.${MARK}@example.test`,
      },
      {}, by
    );
    // A cost rate, so this person's hours can reach a product's cost and a payroll run can pay them.
    await M.Contract.create({ staffId: person._id, effectiveFrom: joining, basicPay: p.basic, allowances: p.allow, hoursPerMonth: p.hours }, by);
    // Somebody who has been here a while has had a rise - a NEW row, never an edit, so what past work
    // costed does not move.
    if (p.monthsAgo >= 24) {
      const raise = monthsBack(today, 11);
      await M.Contract.create({ staffId: person._id, effectiveFrom: raise, basicPay: Math.round(p.basic * 1.08), allowances: p.allow, hoursPerMonth: p.hours }, by);
    }
    if (p.leftMonthsAgo !== undefined) {
      await M.Staff.updateStaff(person._id, { exitDate: monthsBack(today, p.leftMonthsAgo), status: "Inactive" }, {}, by);
    }
    staff.push(person);
  }
  // A reporting line, so the Organisation half of the module has something to show.
  const manager = staff[0];
  for (const i of [1, 2, 3, 4, 11]) await M.Staff.updateStaff(staff[i]._id, { managerId: manager._id }, {}, by);
  for (const i of [6, 7]) await M.Staff.updateStaff(staff[i]._id, { managerId: staff[5]._id }, {}, by);
  console.log(`  people : ${staff.length} employees, every one with a cost rate (${staff.filter((_, i) => PEOPLE[i].monthsAgo >= 24).length} with a rise behind them)`);

  // ---- the month's muster, up to today
  const active = staff.filter((_, i) => PEOPLE[i].leftMonthsAgo === undefined);
  let marked = 0;
  for (let d = 1; d <= Number(today.slice(8, 10)); d++) {
    const day = `${month}-${pad(d)}`;
    for (const [i, person] of active.entries()) {
      // A joiner is not absent before they joined.
      if (day < monthsBack(today, PEOPLE[staff.indexOf(person)].monthsAgo)) continue;
      if (weekend(day)) { await M.Attend.markDay({ staffId: person._id, day, status: "weekly_off" }, by); marked += 1; continue; }
      // Believable, not random: mostly present, the odd absence, one half day.
      const n = (d * 7 + i * 13) % 29;
      const status = n === 0 ? "absent" : n === 1 ? "half_day" : "present";
      if (status === "present") await M.Attend.markDay({ staffId: person._id, day, checkIn: `${day}T08:0${i % 6}:00`, checkOut: `${day}T17:${pad((i * 7) % 40)}:00`, shiftId: shift._id }, by);
      else await M.Attend.markDay({ staffId: person._id, day, status }, by);
      marked += 1;
    }
  }
  console.log(`  muster : ${marked} days marked across ${month}`);

  // ---- leave: one out today, one still waiting, one refused
  const req = { admin: { id: by, name: "HR demo", role: {} } };
  const out = await M.Leave.submit({ staffId: staff[2]._id, leaveTypeId: annual._id, fromDay: shiftDays(today, -1), toDay: shiftDays(today, 2), reason: "Family function" }, by);
  await M.Leave.decide(out._id, { action: "approve" }, req);
  const waiting = await M.Leave.submit({ staffId: staff[6]._id, leaveTypeId: annual._id, fromDay: shiftDays(today, 9), toDay: shiftDays(today, 15), reason: "Annual leave to India" }, by);
  const alsoWaiting = await M.Leave.submit({ staffId: staff[4]._id, leaveTypeId: sick._id, fromDay: shiftDays(today, 3), toDay: shiftDays(today, 4), reason: "Fever" }, by);
  const refused = await M.Leave.submit({ staffId: staff[7]._id, leaveTypeId: annual._id, fromDay: shiftDays(today, 1), toDay: shiftDays(today, 20), reason: "Three weeks" }, by);
  await M.Leave.decide(refused._id, { action: "reject", reason: "Coating line cannot lose two people at once" }, req);
  console.log(`  leave  : 1 approved (out today), 2 waiting, 1 refused`);

  // ---- payroll: a deduction rule, then last month posted and this month left to run
  const components = await M.Component.list();
  if (!components.some((c) => c.name === "Staff loan recovery")) {
    await M.Component.create({ name: "Staff loan recovery", kind: "deduction", computation: "fixed", rate: 250 }, by);
  }
  const lastMonth = monthsBack(today, 1).slice(0, 7);
  let posted = null;
  // The posting keys payroll needs (salary-expense, salaries-payable, statutory-deductions-payable) are
  // created by the chart's own lazy top-up, which normally happens the first time somebody opens a report.
  // On a fresh organisation nothing has, so provision once here or the very first run refuses with
  // ACCOUNT_NOT_CONFIGURED - which is exactly what happened the first time this script was used.
  try { await require("../../services/financial/defaultChartService").provision(); } catch (_) { /* a chart that cannot be topped up is reported by the post below */ }
  try {
    const plan = await M.Payroll.plan(lastMonth);
    posted = await M.Payroll.post(lastMonth, { acknowledge: (plan.assessment?.warnings || []).map((w) => w.code) }, by);
    console.log(`  payroll: ${lastMonth} posted - ${plan.totals.employeeCount} people, gross ${plan.totals.gross}`);
  } catch (e) {
    console.log(`  payroll: ${lastMonth} not posted (${e.code || e.message}) - run it from the screen to see the four steps`);
  }

  // ---- gratuity: the liability the balance sheet should already be carrying
  try {
    const accrued = await M.Gratuity.accrue(lastMonth, by);
    console.log(`  gratuity: accrued to ${lastMonth}${accrued?.accrual ? ` - liability ${accrued.accrual.cumulativeLiability}` : ""}`);
  } catch (e) {
    console.log(`  gratuity: not accrued (${e.code || e.message})`);
  }

  // ---- documents that expire, assets in hands
  for (const d of DOCUMENTS) {
    await M.Doc.create({ staffId: staff[d.who]._id, name: d.name, number: d.number, expiryDate: shiftDays(today, d.inDays) }, by);
  }
  for (const a of ASSETS) {
    const issued = await M.Asset.issue({ staffId: staff[a.who]._id, assetName: a.assetName, assetTag: a.assetTag, issuedDate: monthsBack(today, 2), condition: a.condition }, by);
    if (a.returnedDaysAgo) await M.Asset.markReturned(issued._id, { returnedDate: shiftDays(today, -a.returnedDaysAgo), returnCondition: "Worn but working" }, by);
  }
  console.log(`  records: ${DOCUMENTS.length} documents (1 expired, 2 due within a month), ${ASSETS.length} assets issued`);

  // ---- the joiner's onboarding, the leaver's exit, and one review
  await M.Checklist.start({ staffId: staff[11]._id, listType: "onboarding", dueAt: shiftDays(today, 5) }, by);
  const items = await M.Checklist.forStaff(staff[11]._id);
  if (items[0]) await M.Checklist.markDone(items[0]._id, by);
  await M.Checklist.start({ staffId: staff[12]._id, listType: "exit" }, by);
  await M.Appraisal.create(
    { staffId: staff[1]._id, periodLabel: `${Number(today.slice(0, 4)) - 1} annual`, reviewDate: monthsBack(today, 4),
      rating: "Exceeds expectations", strengths: "Fastest clean weld on the floor; trains the helpers without being asked",
      improvements: "Paperwork on job cards is often late", goals: "Take the lead on the coater changeover" },
    by
  );
  console.log(`  talent : an onboarding checklist (1 done), an exit checklist, 1 appraisal`);

  // ---- one portal account, so the employee half can be opened too
  const portalFor = staff[1];
  const phone = "+971500000101";
  await M.Auth.setAccount({ staffId: portalFor._id, phone, password: "demo12345" }, by);
  console.log(`  portal : ${portalFor.name} can sign in at /portal — ${phone} / demo12345`);

  return { staff, posted };
}

/** Everything this script wrote, removed newest-dependency-first. The ledger postings are left alone. */
async function wipe(M) {
  const mine = await M.Staff_.find({ createdBy: MARK }).select("_id").lean();
  const ids = mine.map((s) => s._id);
  const gone = {};
  const drop = async (key, model, filter) => { gone[key] = (await model.deleteMany(filter)).deletedCount; };

  if (ids.length) {
    await drop("attendance", M.AttendDay, { staffId: { $in: ids } });
    await drop("leaveRequests", M.LeaveReq, { staffId: { $in: ids } });
    await drop("documents", M.DocModel, { staffId: { $in: ids } });
    await drop("assets", M.AssetModel, { staffId: { $in: ids } });
    await drop("checklistItems", M.ChecklistModel, { staffId: { $in: ids } });
    await drop("appraisals", M.AppraisalModel, { staffId: { $in: ids } });
    await drop("payslips", M.Payslip, { staffId: { $in: ids } });
    await drop("portalAccounts", M.EmpUser, { staffId: { $in: ids } });
    await drop("contracts", M.ContractModel, { staffId: { $in: ids } });
    await drop("employees", M.Staff_, { _id: { $in: ids } });
  }
  await drop("departments", M.DeptModel, { name: { $in: DEPARTMENTS } });
  return gone;
}

async function main() {
  if (!ORG) throw new Error("say which organisation: --org=<code>");
  await mongoose.connect(process.env.MONGO_URI);
  const M = {
    Org: require("../../models/core/organisationModel"),
    // services - everything is written through these, so the product's own rules apply
    Staff: require("../../services/staff/staffService"),
    Contract: require("../../services/hr/contractService"),
    Attend: require("../../services/hr/attendanceService"),
    Leave: require("../../services/hr/leaveRequestService"),
    Payroll: require("../../services/hr/payrollService"),
    Gratuity: require("../../services/hr/gratuityService"),
    Doc: require("../../services/hr/employeeDocumentService"),
    Asset: require("../../services/hr/assetAssignmentService"),
    Component: require("../../services/hr/salaryComponentService"),
    Rule: require("../../services/hr/statutoryRuleService"),
    Auth: require("../../services/hr/employeeAuthService"),
    Checklist: require("../../services/hr/talentService").ChecklistService,
    Appraisal: require("../../services/hr/talentService").AppraisalService,
    Dept: require("../../services/hr/timeSetupService").DepartmentService,
    Shift: require("../../services/hr/timeSetupService").ShiftService,
    LeaveType: require("../../services/hr/timeSetupService").LeaveTypeService,
    // models - only for --undo, which has to reach rows no service deletes
    Staff_: require("../../models/modules/staffModel"),
    ContractModel: require("../../models/modules/hr/employeeContractModel"),
    AttendDay: require("../../models/modules/hr/attendanceDayModel"),
    LeaveReq: require("../../models/modules/hr/leaveRequestModel"),
    DocModel: require("../../models/modules/hr/employeeDocumentModel"),
    AssetModel: require("../../models/modules/hr/assetAssignmentModel"),
    ChecklistModel: require("../../models/modules/hr/staffChecklistModel"),
    AppraisalModel: require("../../models/modules/hr/appraisalModel"),
    Payslip: require("../../models/modules/hr/payslipModel"),
    EmpUser: require("../../models/modules/hr/employeeUserModel"),
    DeptModel: require("../../models/modules/hr/departmentModel"),
  };
  const org = await M.Org.findOne({ code: ORG }).lean();
  if (!org) throw new Error(`no organisation with code "${ORG}"`);

  await runWithTenant({ companyId: ORG, branchId: "main" }, async () => {
    const today = require("../../utils/documentExpiry").todayInOrg();
    if (UNDO) {
      const gone = await wipe(M);
      console.log(`removed from ${org.legalName}:`, gone);
      console.log("the payroll journal and the gratuity accrual were LEFT ALONE - unposting money belongs to a person.");
      return;
    }
    console.log(`seeding HR into ${org.legalName} (${org.country}/${org.baseCurrency}), today ${today}`);
    await seed(M, today);
    console.log("done. Open HRMS > Overview.");
  });
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
