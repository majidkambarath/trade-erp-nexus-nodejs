// Gratuity accrual against a throwaway database (random name, dropped afterwards).
//
// Two employees, UAE rules: one with six years' service (the AE example utils/__tests__/compliance.test.js
// already pins at 27,000), one with none yet. The accrual must post Dr Gratuity Expense / Cr Employee
// Gratuity Provision for exactly the incremental liability, leave net profit untouched, refuse a second
// accrual of the same month, and undo cleanly on reversal.
//
// MONTHS, NAMED ONCE, USED ONCE EACH - an accruing liability is never genuinely "quiet" once an active
// employee is in their second gratuity band (Ravi's liability grows a little every month simply because
// time passes), so the one honest place to prove "nothing to accrue -> no number, no posting" is a month
// before anyone exists at all. M0 is consumed by that proof; M1 is the month the real accrual, the posting
// trail and the reversal are all proved against, so neither test's month can collide with the other's.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_gratuity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    Gratuity: require("../hr/gratuityService"),
    Audit: require("../financial/voucherAuditService"),
    LedgerAccount: fin.LedgerAccount,
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
const nextMonth = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };
const lastDayOf = (m) => { const [y, mo] = m.split("-").map(Number); const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, "0")}-01`; return svc.days.addDays(next, -1); };

// Computed lazily, inside the first test: `svc` (and the ambient tenant scope todayInOrg() needs) only
// exist once test.before() has run, not at module-load time when this file's top level is evaluated.
let M0, M1;
let expAcc, provAcc, ravi, anya, firstAccrualId;

test("before any employee exists, a month is genuinely quiet - nothing to accrue, nothing posted", { skip }, async () => {
  M0 = today().slice(0, 7); // the quiet month, before anyone exists
  M1 = nextMonth(M0); // the month everything else is proved against
  assert.equal(await svc.Config.isPostingEnabled(), true, "the seed switches ledger posting on");
  expAcc = await svc.LedgerAccount.findById(await svc.Config.resolveAccount("gratuity-expense")).lean();
  provAcc = await svc.LedgerAccount.findById(await svc.Config.resolveAccount("gratuity-provision")).lean();

  const p = await svc.Gratuity.preview(M0);
  assert.equal(p.cumulativeLiability, 0);
  assert.equal(p.amount, 0);

  const { accrual, posted } = await svc.Gratuity.accrue(M0, "tester");
  assert.equal(posted, false);
  assert.equal(accrual.voucherNo, undefined, "no number allocated for a month that moved nothing");
  await assert.rejects(() => svc.Gratuity.reverse(accrual._id, {}, "tester"), (e) => e.code === "NOTHING_POSTED");
});

test("setup: two employees, one with six years and one just joined", { skip }, async () => {
  // utils/hr.js serviceDays() counts INCLUSIVE of the joining day itself (+1), so landing on exactly
  // 2,190 days of service - the pure test's own fixture (utils/__tests__/compliance.test.js) - needs one
  // fewer day subtracted than a plain 6 x 365. Anchored on M1's own last day, since that is the day
  // GratuityService actually evaluates for M1's accrual - anchoring on "today" instead would be off by
  // however many days are left in the month, plus whatever a leap year adds.
  const sixYearsAgo = svc.days.addDays(lastDayOf(M1), -(6 * 365 - 1));
  ravi = await svc.Staff.createStaff(
    { name: "Ravi Gratuity", designation: "Fabricator", contactNo: "0502222222", idNo: "784GRAT0001" + Date.now() % 1000, joiningDate: sixYearsAgo },
    {}, admin
  );
  await svc.Contract.create({ staffId: ravi._id, effectiveFrom: sixYearsAgo, basicPay: 6000 }, admin);
  anya = await svc.Staff.createStaff(
    { name: "Anya New", designation: "Clerk", contactNo: "0503333333", idNo: "784GRAT0002" + Date.now() % 1000, joiningDate: today() },
    {}, admin
  );
  await svc.Contract.create({ staffId: anya._id, effectiveFrom: today(), basicPay: 4000 }, admin);
});

test("preview matches the pure calculation, naming who is and is not costed", { skip }, async () => {
  const p = await svc.Gratuity.preview(M1);
  assert.equal(p.cumulativeLiability, 27000, "six years at AED 6,000 basic = 27,000 (utils/__tests__/compliance.test.js pins this figure)");
  assert.equal(p.previousCumulative, 0, "M0's accrual moved nothing - it left no prior cumulative to carry");
  assert.equal(p.amount, 27000);
  const names = p.employees.map((e) => e.name).sort();
  assert.ok(names.includes("Ravi Gratuity"));
  assert.ok(names.includes("Anya New"), "Anya is COSTED at a known zero, not left out - she is just not yet entitled");
  assert.equal(p.employees.find((e) => e.name === "Anya New").owed, 0);
});

test("accruing posts Dr Gratuity Expense / Cr Employee Gratuity Provision for exactly the incremental liability", { skip }, async () => {
  const expBefore = r2((await svc.LedgerAccount.findById(expAcc._id).lean()).currentBalance);
  const provBefore = r2((await svc.LedgerAccount.findById(provAcc._id).lean()).currentBalance);

  console.log("DEBUG expAcc:", expAcc.accountName, expAcc._id, "provAcc:", provAcc.accountName, provAcc._id);
  const expFull = await svc.LedgerAccount.findById(expAcc._id).lean();
  const provFull = await svc.LedgerAccount.findById(provAcc._id).lean();
  console.log("DEBUG expAccountType:", expFull.accountType, "provAccountType:", provFull.accountType);
  const { accrual, posted } = await svc.Gratuity.accrue(M1, "tester");
  assert.equal(posted, true);
  assert.equal(accrual.amount, 27000);
  assert.match(accrual.voucherNo, /^GRJ-\d{4}-\d{4}$/);
  firstAccrualId = accrual._id;

  const expAfter = r2((await svc.LedgerAccount.findById(expAcc._id).lean()).currentBalance);
  const provAfter = r2((await svc.LedgerAccount.findById(provAcc._id).lean()).currentBalance);
  // currentBalance follows each account's OWN natural side (services/financial/ledgerBalances.js
  // applyBalances): debit-positive for an expense, CREDIT-positive for a liability - an ordinary accrual,
  // not the same-group contra wash the labour-absorption test proves, so the two sides do not net to zero.
  assert.equal(r2(expAfter - expBefore), 27000, "expense debited by the full accrual - a real cost recognised now");
  assert.equal(r2(provAfter - provBefore), 27000, "provision credited by the same amount, its own natural side - a genuine increase in the liability");
});

test("the same month cannot be accrued twice", { skip }, async () => {
  await assert.rejects(() => svc.Gratuity.accrue(M1, "tester"), (e) => e.code === "ALREADY_ACCRUED");
});

test("the posting trail reads the accrual by its own id, the way a production or a closing entry is read", { skip }, async () => {
  const trail = await svc.Audit.postingTrail(firstAccrualId);
  assert.equal(trail.voucher.typeLabel, "Gratuity accrual");
  assert.ok(trail.source.facts.some((f) => f.label === "Month"));
  assert.equal(trail.ledger.balanced, true);
});

test("reversing undoes the posting cleanly - the ledger returns to exactly where it started", { skip }, async () => {
  const expBefore = r2((await svc.LedgerAccount.findById(expAcc._id).lean()).currentBalance);
  const provBefore = r2((await svc.LedgerAccount.findById(provAcc._id).lean()).currentBalance);

  await svc.Gratuity.reverse(firstAccrualId, { reason: "test reversal" }, "tester");

  const expAfter = r2((await svc.LedgerAccount.findById(expAcc._id).lean()).currentBalance);
  const provAfter = r2((await svc.LedgerAccount.findById(provAcc._id).lean()).currentBalance);
  assert.equal(r2(expAfter - expBefore), -27000, "the expense is taken back out");
  assert.equal(r2(provAfter - provBefore), -27000, "and the provision is taken back off - its own credit side undone, so this is a decrease too");

  await assert.rejects(() => svc.Gratuity.reverse(firstAccrualId, {}, "tester"), (e) => e.code === "ALREADY_REVERSED");
});
