// Record keeping (5 or 15 years) is saved and read back; the user guide is served to the Help screen from the client-only
// help corpus. Throwaway database for the setting, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/retentionAndHelp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_rh_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  await require("../../utils/seedAccounting").seedAccounting({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("records are kept 5 years unless the organisation says 15, and nothing else is accepted", { skip }, async () => {
  const Config = require("../financial/accountConfigService");
  assert.equal((await Config.getSettings({})).retention.years, 5);
  await Config.updateSettings({ retention: { years: 15 } });
  assert.equal((await Config.getSettings({})).retention.years, 15);
  for (const bad of [7, "15x", null, { years: [15] }]) {
    await assert.rejects(Config.updateSettings({ retention: typeof bad === "object" && bad ? bad : { years: bad } }), (e) => e.code === "RETENTION_INVALID");
  }
  assert.equal((await Config.getSettings({})).retention.years, 15);
});

test("simplified tax invoices are off until chosen, on or off only, and reach the printed letterhead", { skip }, async () => {
  const Config = require("../financial/accountConfigService");
  const Profile = require("../core/companyProfileService");
  assert.equal((await Config.getSettings({})).simplifiedInvoices, false);
  assert.equal((await Profile.get()).simplifiedInvoices, false);
  await Config.updateSettings({ simplifiedInvoices: true });
  assert.equal((await Config.getSettings({})).simplifiedInvoices, true);
  assert.equal((await Profile.get()).simplifiedInvoices, true);
  for (const bad of ["true", 1, null, [true], { on: true }]) {
    await assert.rejects(Config.updateSettings({ simplifiedInvoices: bad }), (e) => e.code === "SIMPLIFIED_INVOICES_INVALID");
  }
  assert.equal((await Config.getSettings({})).simplifiedInvoices, true);
});

test("the Help screen lists the client topics, opens one, and refuses anything else", async () => {
  const c = require("../../controllers/core/helpController");
  const call = (fn, req) => new Promise((resolve, reject) => {
    const res = { json: (body) => resolve(body), status() { return this; } };
    fn(req, res, (err) => (err ? reject(err) : resolve(null)));
  });
  const list = await call(c.list, {});
  assert.ok(list.data.length > 100);
  const guide = list.data.find((t) => t.id === "extra-auditor-guide");
  assert.equal(guide.title, "A guide for auditors");
  assert.ok(!("body" in guide), "the list carries no topic text");
  const topic = await call(c.topic, { params: { id: "extra-auditor-guide" } });
  assert.match(topic.data.body, /audit log cannot be changed or deleted/i);
  await assert.rejects(call(c.topic, { params: { id: "../../CLAUDE" } }), (e) => e.code === "HELP_TOPIC_NOT_FOUND");
});
