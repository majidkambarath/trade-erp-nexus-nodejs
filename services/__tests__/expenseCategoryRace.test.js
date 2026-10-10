// Two people creating or renaming expense categories to the SAME name at the same moment. Each call runs in its own MongoDB
// transaction, and the unique index on (name, parent) makes the second writer a genuine write conflict. That conflict used to
// reach the person as a raw database error (a 500 in the data-bleed sweep when other suites were loading the cluster). It is
// retried now, so the loser sees what a person who arrived a moment later would: "already exists".
// Runs against a throwaway database (see accountingFoundation.test.js).
//
//   npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let Svc;
let Category;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  Svc = require("../financial/expenseTypeService");
  Category = require("../../models/modules/financial/expenseTypeModel");
  require("../../models/modules/financial/financialModels"); // delete asks the vouchers whether the category is in use
  await Category.init();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// what the person is told: made, or refused in words (an AppError carries a status). Anything else is a fault.
const outcome = (r) => {
  if (r.status === "fulfilled") return "made";
  const e = r.reason;
  return e && e.isOperational && e.statusCode === 400 ? "refused" : `FAULT ${e?.name}: ${String(e?.message).slice(0, 120)} (code ${e?.code}, labels ${JSON.stringify(e?.errorLabels || [])})`;
};

test("creating and renaming to one name at once: one wins, the others are told it exists, nobody sees a database error", { skip, timeout: 240000 }, async () => {
  const faults = [];
  let made = 0;
  for (let round = 0; round < 10; round++) {
    const name = `Race ${round}`;
    const bases = [];
    for (let k = 0; k < 4; k++) bases.push(String((await Svc.create({ name: `Base ${round}-${k}` }, "tester"))._id));
    const results = await Promise.allSettled([
      Svc.create({ name }, "tester"),
      Svc.create({ name }, "tester"),
      ...bases.map((id) => Svc.update(id, { name }, "tester")),
    ]);
    for (const r of results) {
      const o = outcome(r);
      if (o === "made") made += 1;
      else if (o !== "refused") faults.push(`round ${round}: ${o}`);
    }
    // exactly one category carries the name, whoever got there first
    assert.equal(await Category.countDocuments({ name }), 1, `round ${round}: more than one category named ${name}`);
  }
  assert.deepEqual(faults, []);
  assert.ok(made >= 10, "one writer per round must have won");
});

test("deleting a category while another request renames it is a clean answer, not a database error", { skip, timeout: 120000 }, async () => {
  const faults = [];
  for (let round = 0; round < 6; round++) {
    const id = String((await Svc.create({ name: `Del ${round}` }, "tester"))._id);
    const results = await Promise.allSettled([
      Svc.delete(id),
      Svc.update(id, { name: `Del renamed ${round}` }, "tester"),
      Svc.delete(id),
    ]);
    for (const r of results) {
      if (r.status === "fulfilled") continue;
      const e = r.reason;
      // gone before the second request got to it is the honest answer
      if (!(e && e.isOperational && (e.statusCode === 404 || e.statusCode === 400))) faults.push(`round ${round}: ${e?.name}: ${String(e?.message).slice(0, 120)} (labels ${JSON.stringify(e?.errorLabels || [])})`);
    }
    if (await Category.countDocuments({ _id: id })) faults.push(`round ${round}: the category was not deleted`);
  }
  assert.deepEqual(faults, []);
});
