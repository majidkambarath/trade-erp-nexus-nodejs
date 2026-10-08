// The branch view, at the plugin: documents carry a branch and a person working in one branch sees only that
// branch's documents - through every route a query can take - while masters stay organisation-wide and a head
// office with no branch chosen sees everything. Uses its own throwaway collections, so it proves the rule and not
// any one model.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
process.env.TENANT_LEGACY_DEFAULT = "0";
const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { runWithTenant, allBranches, ambientTenant } = require("../../utils/tenantContext");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const docSchema = new mongoose.Schema({ companyId: { type: String, required: true }, branchId: { type: String, default: "main" }, no: String, amount: { type: Number, default: 0 } });
docSchema.index({ companyId: 1, no: 1 }, { unique: true });
docSchema.plugin(tenantPlugin, { branchScoped: true });
const lineSchema = new mongoose.Schema({ companyId: { type: String, required: true }, branchId: { type: String, default: "main" }, docNo: String });
lineSchema.plugin(tenantPlugin, { branchScoped: true });
const masterSchema = new mongoose.Schema({ companyId: { type: String, required: true }, branchId: { type: String, default: "main" }, name: String });
masterSchema.index({ companyId: 1, name: 1 }, { unique: true });
masterSchema.plugin(tenantPlugin); // a master: shared by every branch
const Doc = mongoose.model("BranchDoc", docSchema);
const Line = mongoose.model("BranchLine", lineSchema);
const Master = mongoose.model("BranchMaster", masterSchema);

const HO = (fn) => runWithTenant({ companyId: "A", branchId: "main" }, fn); // head office, every branch
const ONLY = (branch, fn, company = "A") => runWithTenant({ companyId: company, branchId: branch, branchView: branch }, fn);
const nos = (rows) => rows.map((r) => r.no).sort();

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  await Doc.syncIndexes();
  await Master.syncIndexes();
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("documents are stamped with the branch they are made in", { skip }, async () => {
  await ONLY("main", () => Doc.create({ no: "SO-1", amount: 10 }));
  await ONLY("shj", () => Doc.create({ no: "SHJ-SO-1", amount: 20 }));
  await ONLY("shj", () => Doc.create({ no: "SHJ-SO-2", amount: 30 }));
  await ONLY("dxb", () => Doc.create({ no: "DXB-SO-1", amount: 40 }));
  await ONLY("shj", () => Line.create({ docNo: "SHJ-SO-1" }), "A");
  await ONLY("main", () => Line.create({ docNo: "SO-1" }));
  // another organisation with a Sharjah branch of its own
  await ONLY("shj", () => Doc.create({ no: "SHJ-SO-1", amount: 99 }), "B");
  const stored = await mongoose.connection.collection("branchdocs").find({ companyId: "A" }).toArray();
  assert.deepEqual(Object.fromEntries(stored.map((d) => [d.no, d.branchId])), { "SO-1": "main", "SHJ-SO-1": "shj", "SHJ-SO-2": "shj", "DXB-SO-1": "dxb" });
});

test("a head office with no branch chosen sees every branch of its organisation, and no other organisation's", { skip }, async () => {
  assert.deepEqual(nos(await HO(() => Doc.find().lean())), ["DXB-SO-1", "SHJ-SO-1", "SHJ-SO-2", "SO-1"]);
  assert.equal(await HO(() => Doc.countDocuments()), 4);
});

test("a person working in one branch sees only that branch, by every route", { skip }, async () => {
  assert.deepEqual(nos(await ONLY("shj", () => Doc.find().lean())), ["SHJ-SO-1", "SHJ-SO-2"]);
  assert.equal(await ONLY("shj", () => Doc.countDocuments()), 2);
  assert.deepEqual((await ONLY("shj", () => Doc.distinct("no"))).sort(), ["SHJ-SO-1", "SHJ-SO-2"]);
  assert.equal(await ONLY("shj", () => Doc.findOne({ no: "SO-1" })), null, "another branch's document is invisible by its number");
  const headOfficeDoc = await HO(() => Doc.findOne({ no: "SO-1" }).lean());
  assert.equal(await ONLY("shj", () => Doc.findById(headOfficeDoc._id)), null, "and by its exact id");
  assert.equal(await ONLY("shj", () => Doc.exists({ _id: headOfficeDoc._id })), null);
  assert.equal(await ONLY("shj", () => Doc.countDocuments({ branchId: "main" })), 0, "asking for another branch by name returns nothing, not that branch");
  assert.equal(await ONLY("shj", () => Doc.countDocuments({ $or: [{ branchId: "main" }, { no: "SHJ-SO-1" }] })), 1, "an $or cannot widen the view");
});

test("aggregations and joins are limited to the branch too", { skip }, async () => {
  const total = (rows) => rows[0]?.total ?? 0;
  assert.equal(total(await ONLY("shj", () => Doc.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]))), 50);
  assert.equal(total(await HO(() => Doc.aggregate([{ $group: { _id: null, total: { $sum: "$amount" } } }]))), 100, "head office: every branch of A, none of B");
  const joined = await ONLY("shj", () => Line.aggregate([{ $lookup: { from: "branchdocs", localField: "docNo", foreignField: "no", as: "doc" } }]));
  assert.equal(joined.length, 1);
  assert.equal(joined[0].doc.length, 1);
  const crossJoin = await ONLY("main", () => Line.aggregate([{ $lookup: { from: "branchdocs", let: { n: "SHJ-SO-1" }, pipeline: [{ $match: { $expr: { $eq: ["$no", "$$n"] } } }], as: "doc" } }]));
  assert.deepEqual(crossJoin.map((l) => l.doc.length), [0], "a join cannot reach another branch's document either");
});

test("writes are limited to the branch's own documents", { skip }, async () => {
  const hit = await ONLY("shj", () => Doc.updateMany({}, { $set: { amount: 1 } }));
  assert.equal(hit.modifiedCount, 2, "only Sharjah's two");
  assert.equal(await HO(() => Doc.countDocuments({ amount: 1 })), 2);
  assert.equal((await ONLY("shj", () => Doc.deleteMany({ no: "SO-1" }))).deletedCount, 0, "another branch's document cannot be deleted");
  assert.equal(await HO(() => Doc.countDocuments({ no: "SO-1" })), 1);
  assert.equal((await ONLY("shj", () => Doc.findOneAndUpdate({ no: "DXB-SO-1" }, { $set: { amount: 0 } }))), null);
  await ONLY("shj", () => Doc.updateMany({}, { $set: { amount: 20 } })); // put back
});

test("a document cannot be made for another branch than the one being worked in", { skip }, async () => {
  await assert.rejects(() => ONLY("shj", () => Doc.create({ no: "SNEAK-1", branchId: "main" })), (e) => e.code === "CROSS_BRANCH");
  await assert.rejects(() => ONLY("shj", () => Doc.insertMany([{ no: "SNEAK-2", branchId: "dxb" }])), (e) => e.code === "CROSS_BRANCH");
  await assert.rejects(() => ONLY("shj", () => Doc.bulkWrite([{ insertOne: { document: { companyId: "A", no: "SNEAK-3", branchId: "main" } } }])), (e) => e.code === "CROSS_BRANCH");
  assert.equal(await HO(() => Doc.countDocuments({ no: /^SNEAK/ })), 0);
  // the head office, with no branch chosen, may name a branch it is entering a document for
  await HO(() => Doc.create({ no: "ENTERED-FOR-DXB", branchId: "dxb" }));
  assert.equal((await HO(() => Doc.findOne({ no: "ENTERED-FOR-DXB" }).lean())).branchId, "dxb");
  await HO(() => Doc.deleteOne({ no: "ENTERED-FOR-DXB" }));
});

test("masters are shared by every branch of the organisation", { skip }, async () => {
  await ONLY("shj", () => Master.create({ name: "rice" }));
  await ONLY("main", () => Master.create({ name: "oil" }));
  assert.deepEqual((await ONLY("dxb", () => Master.find().lean())).map((m) => m.name).sort(), ["oil", "rice"], "a branch sees the organisation's masters, whoever made them");
  assert.equal(await ONLY("main", () => Master.countDocuments({ name: "rice" })), 1);
});

test("allBranches lifts the view for what must see the whole organisation, and puts it back after", { skip }, async () => {
  await ONLY("shj", async () => {
    assert.equal(await Doc.countDocuments(), 2);
    const everywhere = await allBranches(() => Doc.countDocuments());
    assert.equal(everywhere, 4, "an organisation-wide figure, such as a customer's credit exposure");
    assert.equal(ambientTenant().branchView, "shj", "the view is back once it is done");
    assert.equal(await Doc.countDocuments(), 2);
    // still inside the organisation: another organisation's rows stay out of reach
    assert.equal(await allBranches(() => Doc.countDocuments({ no: "SHJ-SO-1" })), 1);
  });
});

test("outside any scope allBranches is not a way round the organisation", { skip }, async () => {
  await assert.rejects(async () => allBranches(() => Doc.countDocuments()), (e) => e.code === "NO_TENANT_SCOPE");
});
