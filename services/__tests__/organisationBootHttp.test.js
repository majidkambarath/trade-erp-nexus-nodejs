// Starting the real server on an empty database must leave the original organisation adopted, with its
// head office, and starting it AGAIN must change nothing. This is what makes the existing single-company
// system a real organisation without anyone running a command.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const ROOT = path.resolve(__dirname, "..", "..");
let logs = "";

async function boot() {
  const port = 3300 + Math.floor(Math.random() * 400);
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(port), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const deadline = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).ok) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`server did not start:\n${logs.slice(-1500)}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
  // the adoption runs just after the server starts listening
  const O = mongoose.connection.collection("organisations");
  for (let i = 0; i < 60 && !(await O.findOne({ code: "default" })); i += 1) await new Promise((r) => setTimeout(r, 500));
  return child;
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  await mongoose.connect(uri);
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("a fresh start adopts the original organisation with a head office, and a second start changes nothing", { skip }, async () => {
  const first = await boot();
  const orgs = mongoose.connection.collection("organisations");
  const branches = mongoose.connection.collection("branches");
  try {
    const org = await orgs.findOne({ code: "default" });
    assert.ok(org, `the original organisation was adopted\n${logs.slice(-800)}`);
    assert.equal(org.planCode, "internal", "it keeps every feature and has no limits");
    assert.equal(org.status, "active");
    assert.equal(org.subscription.endsAt, null, "and never expires");
    const heads = await branches.find({ companyId: "default", isHeadOffice: true }).toArray();
    assert.equal(heads.length, 1);
    assert.equal(heads[0].code, "main", "the head office is the branch every existing document already names");
  } finally {
    first.kill();
  }
  await new Promise((r) => setTimeout(r, 800));
  const second = await boot();
  try {
    assert.equal(await orgs.countDocuments({ code: "default" }), 1, "still one");
    assert.equal(await branches.countDocuments({ companyId: "default" }), 1, "still one head office");
  } finally {
    second.kill();
  }
});
