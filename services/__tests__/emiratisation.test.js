// EmiratisationService against a throwaway database: the UAE-only gate, and real headcount/nationality
// counting against Staff. No ledger involved - this service never posts (D12).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_emiratisation_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Staff: require("../staff/staffService"),
    Emiratisation: require("../hr/emiratisationService"),
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

test("is UAE-only: the seed's own organisation is AE, so the status is real and configured", { skip }, async () => {
  assert.equal(svc.Emiratisation.isUae(), true, "the seeded organisation is AE");
});

test("counts nationals against the whole active headcount, with the research's own default quota and fine", { skip }, async () => {
  const unique = Date.now() % 100000;
  const nationals = [
    { name: "Fatima Al Nat", nationality: "AE" },
  ];
  const others = Array.from({ length: 9 }, (_, i) => ({ name: `Worker ${i}`, nationality: "IN" }));
  for (const [i, p] of [...nationals, ...others].entries()) {
    await svc.Staff.createStaff(
      { name: p.name, designation: "Staff", contactNo: `05099${String(unique).padStart(5, "0")}${i}`, idNo: `784EMIR${unique}${i}`, joiningDate: today(), nationality: p.nationality },
      {}, admin
    );
  }
  const status = await svc.Emiratisation.status();
  assert.equal(status.configured, true);
  assert.equal(status.headcount, 10);
  assert.equal(status.nationals, 1);
  assert.equal(status.requiredPercent, 10, "the research's own seeded default");
  // ceil(10 * 10 / 100) = 1 required; already met with exactly one national
  assert.equal(status.required, 1);
  assert.equal(status.compliant, true);
  assert.equal(status.monthlyExposure, 0);
});

test("a shortfall carries a real monthly exposure, never a guess", { skip }, async () => {
  const unique = (Date.now() + 1) % 100000;
  // ten more non-nationals, with the one existing national now diluted below the quota
  for (let i = 0; i < 10; i++) {
    await svc.Staff.createStaff(
      { name: `Extra ${i}`, designation: "Staff", contactNo: `05088${String(unique).padStart(5, "0")}${i}`, idNo: `784EMIX${unique}${i}`, joiningDate: today(), nationality: "IN" },
      {}, admin
    );
  }
  const status = await svc.Emiratisation.status();
  assert.equal(status.headcount, 20);
  assert.equal(status.nationals, 1);
  assert.equal(status.required, 2, "ceil(20 * 10 / 100)");
  assert.equal(status.shortfall, 1);
  assert.equal(status.compliant, false);
  assert.equal(status.monthlyExposure, 9000, "the research's own seeded default fine per position");
});
