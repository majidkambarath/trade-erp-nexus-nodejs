// The backup drill end to end on a throwaway database: an organisation with real postings is exported, restored into a
// second throwaway database, and the drill proves every collection and every account's debits and credits came back.
// A file changed after the export is refused by the restore before anything is written.
//
//   node --require ./utils/testSetup.js --test services/__tests__/backupDrill.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_bk_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const script = (s) => path.join(__dirname, "..", "..", "scripts", "backup", s);

// A child process run WITHOUT blocking this one. spawnSync froze this process for the minute an export takes; its database
// connection missed its heartbeats and then never closed, so the run never ended.
const node = (args) => new Promise((resolve) => {
  execFile(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
});

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  require("../../models/core/organisationModel");
  await mongoose.connection.syncIndexes();
  await mongoose.model("Organisation").collection.insertOne({ code: "default", legalName: "Drill Trading", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", status: "active" });
  await require("../../utils/seedAccounting").seedAccounting({ log: () => {} });
  await require("../financial/accountConfigService").setPostingEnabled(true);
  const Tx = require("../orderPurchase/transactionService");
  const customer = await require("../../models/modules/customerModel").create({ customerId: "C-1", customerName: "Al Noor", billingAddress: "Dubai" });
  const stock = await require("../../models/modules/stockModel").create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId(), currentStock: 50, purchasePrice: 5, costValue: 250 });
  const sale = await Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: new Date(), items: [{ itemId: stock._id, description: "Rice", qty: 4, price: 10, rate: 10, vatPercent: 5 }] }, "tester");
  await Tx.processTransaction(sale._id, "approve", "tester");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("a drill restores the organisation into a throwaway database and finds it identical", { skip }, async () => {
  // run as the operator runs it: its own process, its own connection
  const r = await node([script("drill.js"), "--org", "default", "--db", DB]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const result = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"), r.stdout.lastIndexOf("}") + 1));
  assert.deepEqual(result.differences, []);
  assert.equal(result.ok, true);
  assert.ok(result.rows > 0 && result.files > 0 && result.accounts > 0);
  assert.ok(result.debit > 0 && result.debit === result.credit, "the books came back balanced");
  assert.match(r.stdout, /\| default \| .* \| passed \|/);
});

test("a restore refuses a backup whose files changed after it was taken", { skip }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "zarvia-bk-"));
  try {
    const exp = await node([script("export.js"), "--org", "default", "--out", out, "--db", DB]);
    assert.equal(exp.status, 0, exp.stderr);
    const stamp = fs.readdirSync(out)[0];
    const dir = path.join(out, stamp, "default");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const file = Object.keys(manifest.sha256).find((f) => f.endsWith(".ndjson"));
    fs.appendFileSync(path.join(dir, file), "\n");
    const imp = await node([script("import.js"), "--from", dir, "--confirm", "--db", `${DB}_never`]);
    assert.equal(imp.status, 1);
    assert.match(imp.stderr, /is not the file the export wrote/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
