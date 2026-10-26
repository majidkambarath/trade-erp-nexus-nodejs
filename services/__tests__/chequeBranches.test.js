// A cheque is a document of the branch its voucher was taken in. The register used to have no branchId at all, so a
// branch user listed other branches' cheques (whose audit trail then 404ed). This proves, on a throwaway database:
//   - an old cheque row (no branchId) is given its VOUCHER's branch by the migration, not a flat "main",
//   - the migration is safe to repeat, and leaves a cheque that already has a branch alone,
//   - once branch scoped, a branch view lists and reads only its own branch's cheques,
//   - the whole-organisation view (no branchView) still sees every branch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let Cheque, Voucher, mig, tenant, ChequeService;
const ids = {};
const oid = () => new mongoose.Types.ObjectId();

(function load(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) load(p);
    else if (p.endsWith(".js")) require(path.resolve(p));
  }
})(path.resolve(__dirname, "..", "..", "models"));

const legacy = (n, voucherId, extra = {}) => ({
  companyId: "default", direction: "receipt", voucherId, voucherNo: `RV-${n}`, voucherDate: new Date("2026-10-01"),
  chequeNo: `CHQ${n}`, chequeDate: new Date("2026-11-01"), amount: 100, bankAccountId: oid(), status: "pending", history: [], ...extra,
});
const ONLY = (branch, fn) => tenant.runWithTenant({ companyId: "default", branchId: branch, branchView: branch }, fn);
const ALL = (fn) => tenant.runWithTenant({ companyId: "default", branchId: "main" }, fn);

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  ({ Cheque } = require("../../models/modules/banking/bankingModels"));
  ({ Voucher } = require("../../models/modules/financial/financialModels"));
  mig = require("../../utils/migrations");
  tenant = require("../../utils/tenantContext");
  ChequeService = require("../../services/banking/chequeService");
  await Cheque.init();
  // vouchers in three branches, written raw (a voucher needs far more than this test cares about)
  ids.vMain = oid(); ids.vShj = oid(); ids.vAuh = oid(); ids.vGone = oid();
  await Voucher.collection.insertMany([
    { _id: ids.vMain, companyId: "default", branchId: "main", voucherNo: "RV-1" },
    { _id: ids.vShj, companyId: "default", branchId: "shj", voucherNo: "RV-2" },
    { _id: ids.vAuh, companyId: "default", branchId: "auh", voucherNo: "RV-3" },
  ]);
  // an older version's cheques: NO branchId field at all (raw insert, so no schema default is applied)
  await Cheque.collection.insertMany([
    legacy(1, ids.vMain), legacy(2, ids.vShj), legacy(3, ids.vShj, { chequeNo: "CHQ3b" }), legacy(4, ids.vAuh),
    legacy(5, ids.vGone), // its voucher no longer exists
    legacy(6, ids.vMain, { branchId: "shj" }), // already has a branch, even though its voucher says main: must be left alone
  ]);
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const branchOf = async (no) => (await Cheque.collection.findOne({ chequeNo: no })).branchId;

test("before: the old rows name no branch at all", { skip }, async () => {
  assert.equal(await Cheque.collection.countDocuments({ branchId: { $exists: false } }), 5);
});

test("the migration gives each cheque its VOUCHER's branch, not a flat main", { skip }, async () => {
  const done = await mig.backfillChequeBranches();
  assert.equal(done, 5, "five rows had no branch; the sixth already had one");
  assert.equal(await branchOf("CHQ1"), "main");
  assert.equal(await branchOf("CHQ2"), "shj", "a Sharjah voucher's cheque is Sharjah's, not head office's");
  assert.equal(await branchOf("CHQ3b"), "shj");
  assert.equal(await branchOf("CHQ4"), "auh");
  assert.equal(await branchOf("CHQ5"), "main", "a cheque whose voucher is gone falls back to head office");
  assert.equal(await branchOf("CHQ6"), "shj", "a row that already had a branch is not overwritten from its voucher");
});

test("the migration is safe to repeat: a second run finds nothing", { skip }, async () => {
  assert.equal(await mig.backfillChequeBranches(), 0);
  assert.equal(await branchOf("CHQ2"), "shj");
});

test("a branch view lists only its own branch's cheques", { skip }, async () => {
  const shj = await ONLY("shj", () => ChequeService.list({}, {}));
  assert.deepEqual(shj.rows.map((r) => r.chequeNo).sort(), ["CHQ2", "CHQ3b", "CHQ6"]);
  assert.equal(shj.total, 3);
  const auh = await ONLY("auh", () => ChequeService.list({}, {}));
  assert.deepEqual(auh.rows.map((r) => r.chequeNo), ["CHQ4"]);
});

test("the summary is the branch's own, not the organisation's", { skip }, async () => {
  const shj = await ONLY("shj", () => ChequeService.list({}, {}));
  assert.equal(shj.summary.receivable.count, 3);
  assert.equal(shj.summary.receivable.amount, 300);
  const all = await ALL(() => ChequeService.list({}, {}));
  assert.equal(all.summary.receivable.count, 6, "the whole-organisation view still adds every branch");
});

test("another branch's cheque cannot be read by id: it is a 404, not a leak", { skip }, async () => {
  const auh = await Cheque.collection.findOne({ chequeNo: "CHQ4" });
  await assert.rejects(() => ONLY("shj", () => ChequeService.get(auh._id, {})), (e) => e.statusCode === 404 || /not found/i.test(e.message));
  const own = await ONLY("auh", () => ChequeService.get(auh._id, {}));
  assert.equal(own.chequeNo, "CHQ4");
  const viaAll = await ALL(() => ChequeService.get(auh._id, {}));
  assert.equal(viaAll.chequeNo, "CHQ4", "head office in the all-branches view reads any branch's cheque");
});

test("a new cheque is stamped with the branch it is taken in", { skip }, async () => {
  const [c] = await ONLY("shj", () => Cheque.create([legacy(7, ids.vShj, { chequeNo: "CHQ7" })]));
  assert.equal(c.branchId, "shj");
  await assert.rejects(
    () => ONLY("shj", () => Cheque.create([legacy(8, ids.vAuh, { chequeNo: "CHQ8", branchId: "auh" })])),
    "a Sharjah view cannot write an Abu Dhabi cheque"
  );
});
