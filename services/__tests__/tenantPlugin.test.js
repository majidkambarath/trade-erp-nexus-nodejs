// The tenant plugin against a real database: two organisations holding the SAME data, and every way a
// query can try to reach across. The rule being proved is that organisation A can never read, change,
// delete or join to organisation B's rows, and that a call with no organisation in scope fails instead of
// returning everything. Uses its own throwaway collections so it proves the plugin, not any one model.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
process.env.TENANT_LEGACY_DEFAULT = "0"; // fail closed: no scope is an error, as it will be in production
const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const widgetSchema = new mongoose.Schema({
  companyId: { type: String, required: true },
  branchId: { type: String, default: "main" },
  name: String,
  qty: { type: Number, default: 0 },
});
widgetSchema.index({ companyId: 1, name: 1 }, { unique: true });
widgetSchema.plugin(tenantPlugin);
const gadgetSchema = new mongoose.Schema({ companyId: { type: String, required: true }, widgetId: { type: mongoose.Schema.Types.ObjectId, ref: "TenantWidget" }, tag: String });
gadgetSchema.plugin(tenantPlugin);
const plainSchema = new mongoose.Schema({ label: String, widgetId: mongoose.Schema.Types.ObjectId }); // no companyId: not tenanted
const Widget = mongoose.model("TenantWidget", widgetSchema);
const Gadget = mongoose.model("TenantGadget", gadgetSchema);
const Plain = mongoose.model("TenantPlain", plainSchema);

const as = (companyId, fn, branchId) => runWithTenant({ companyId, branchId }, fn);
const raw = (fn) => runUnscoped("a test that inspects what is really stored, across organisations", fn);
const names = (rows) => rows.map((r) => r.name).sort();

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  await Widget.syncIndexes();
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("two organisations hold the same names without colliding, and each is stamped on save", { skip }, async () => {
  for (const org of ["A", "B"]) {
    await as(org, async () => {
      await Widget.create({ name: "rice", qty: 1 });
      await Widget.create({ name: "oil", qty: 2 });
      await new Widget({ name: `only-${org}` }).save();
    });
  }
  const all = await raw(() => Widget.find().lean());
  assert.equal(all.length, 6);
  assert.deepEqual([...new Set(all.filter((w) => w.name === "rice").map((w) => w.companyId))].sort(), ["A", "B"], "both hold 'rice'");
  assert.ok(all.every((w) => w.companyId === "A" || w.companyId === "B"), "every row is stamped");
});

test("reads only ever see the organisation in scope", { skip }, async () => {
  assert.deepEqual(names(await as("A", () => Widget.find().lean())), ["oil", "only-A", "rice"]);
  assert.deepEqual(names(await as("B", () => Widget.find().lean())), ["oil", "only-B", "rice"]);
  assert.equal(await as("A", () => Widget.countDocuments()), 3);
  assert.equal((await as("A", () => Widget.findOne({ name: "only-B" }))), null, "B's row is invisible to A");
  assert.deepEqual((await as("A", () => Widget.distinct("name"))).sort(), ["oil", "only-A", "rice"]);
  const bsRow = await raw(() => Widget.findOne({ name: "only-B" }).lean());
  assert.equal(await as("A", () => Widget.findById(bsRow._id)), null, "even by its exact id");
  assert.equal(await as("A", () => Widget.exists({ _id: bsRow._id })), null);
});

test("naming another organisation in a filter is an error, not an empty answer", { skip }, async () => {
  await as("A", async () => {
    await assert.rejects(() => Widget.find({ companyId: "B" }), { code: "CROSS_TENANT" });
    await assert.rejects(() => Widget.countDocuments({ companyId: "B" }), { code: "CROSS_TENANT" });
    await assert.rejects(() => Widget.updateOne({ companyId: "B" }, { qty: 9 }), { code: "CROSS_TENANT" });
    assert.equal((await Widget.find({ companyId: "A" })).length, 3, "naming your own is fine");
  });
});

test("with no organisation in scope a query fails instead of returning everything", { skip }, async () => {
  await assert.rejects(() => Widget.find(), { code: "NO_TENANT_SCOPE" });
  await assert.rejects(() => Widget.findOne({ name: "rice" }), { code: "NO_TENANT_SCOPE" });
  await assert.rejects(() => Widget.countDocuments(), { code: "NO_TENANT_SCOPE" });
  await assert.rejects(() => Widget.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]), { code: "NO_TENANT_SCOPE" });
  await assert.rejects(() => Widget.create({ companyId: "A", name: "stray" }), { code: "NO_TENANT_SCOPE" });
  await assert.rejects(() => Widget.deleteMany({}), { code: "NO_TENANT_SCOPE" });
  assert.equal(await raw(() => Widget.countDocuments({ name: "stray" })), 0, "nothing was written");
});

test("an unscoped block sees every organisation, which is exactly why it must stay rare", { skip }, async () => {
  assert.equal(await raw(() => Widget.countDocuments()), 6);
});

test("an update or delete in one organisation can never touch another's rows", { skip }, async () => {
  await as("A", async () => {
    assert.equal((await Widget.updateMany({}, { $set: { qty: 100 } })).modifiedCount, 3);
    assert.equal((await Widget.updateOne({ name: "only-B" }, { qty: 5 })).matchedCount, 0, "B's row does not match");
    assert.equal(await Widget.findOneAndUpdate({ name: "only-B" }, { qty: 5 }), null);
    assert.equal((await Widget.deleteOne({ name: "only-B" })).deletedCount, 0);
    assert.equal(await Widget.findOneAndDelete({ name: "only-B" }), null);
  });
  const b = await raw(() => Widget.find({ companyId: "B" }).lean());
  assert.equal(b.length, 3, "all of B's rows survive");
  assert.deepEqual([...new Set(b.map((w) => w.qty))].sort(), [0, 1, 2], "and none was changed");
  await as("A", () => Widget.updateMany({}, { $set: { qty: 0 } }));
});

test("a row cannot be moved to another organisation, by any route", { skip }, async () => {
  await as("A", async () => {
    await assert.rejects(() => Widget.updateOne({ name: "rice" }, { $set: { companyId: "B" } }), { code: "CROSS_TENANT" });
    await assert.rejects(() => Widget.updateOne({ name: "rice" }, { companyId: "B" }), { code: "CROSS_TENANT" });
    await assert.rejects(() => Widget.findOneAndUpdate({ name: "rice" }, { $unset: { companyId: "" } }), { code: "CROSS_TENANT" });
    await assert.rejects(() => Widget.updateOne({ name: "rice" }, { $rename: { companyId: "orgId" } }), { code: "CROSS_TENANT" });
    const doc = await Widget.findOne({ name: "rice" });
    doc.companyId = "B";
    await assert.rejects(() => doc.save(), { code: "CROSS_TENANT" });
    await assert.rejects(() => Widget.create({ companyId: "B", name: "smuggled" }), { code: "CROSS_TENANT" });
  });
  assert.equal(await raw(() => Widget.countDocuments({ name: "smuggled" })), 0);
  assert.equal(await raw(() => Widget.countDocuments({ companyId: "A" })), 3, "A still has its three");
});

test("a replacement document keeps its organisation, and a document loaded elsewhere cannot be deleted here", { skip }, async () => {
  await as("A", async () => {
    await Widget.replaceOne({ name: "oil" }, { name: "oil", qty: 77 });
    const replaced = await raw(() => Widget.findOne({ companyId: "A", name: "oil" }).lean());
    assert.equal(replaced.companyId, "A", "a replacement with no companyId did not drop it");
    assert.equal(replaced.qty, 77);
  });
  const foreign = await raw(() => Widget.findOne({ companyId: "B", name: "only-B" }));
  await as("A", () => assert.rejects(() => foreign.deleteOne(), { code: "CROSS_TENANT" }));
  assert.equal(await raw(() => Widget.countDocuments({ name: "only-B" })), 1, "still there");
});

test("an upsert creates its row in the organisation in scope", { skip }, async () => {
  await as("B", () => Widget.findOneAndUpdate({ name: "upserted" }, { $set: { qty: 3 } }, { upsert: true, new: true }));
  const row = await raw(() => Widget.findOne({ name: "upserted" }).lean());
  assert.equal(row.companyId, "B");
  await as("A", () => Widget.findOneAndUpdate({ name: "upserted" }, { $set: { qty: 4 } }, { upsert: true }));
  assert.deepEqual((await raw(() => Widget.find({ name: "upserted" }).lean())).map((w) => w.companyId).sort(), ["A", "B"], "A made its OWN row instead of editing B's");
});

test("the branch comes from the scope, over the schema default", { skip }, async () => {
  const w = await as("A", () => Widget.create({ name: "from-dubai" }), "dxb");
  assert.equal(w.branchId, "dxb");
  const d = await as("A", () => Widget.create({ name: "from-head-office" }));
  assert.equal(d.branchId, "main");
  const explicit = await as("A", () => Widget.create({ name: "explicit", branchId: "ajm" }), "dxb");
  assert.equal(explicit.branchId, "ajm", "a branch named on the document is respected");
});

test("insertMany stamps plain documents and refuses another organisation's", { skip }, async () => {
  const made = await as("A", () => Widget.insertMany([{ name: "bulk-1" }, { name: "bulk-2" }]));
  assert.deepEqual(made.map((d) => d.companyId), ["A", "A"]);
  await as("A", () => assert.rejects(() => Widget.insertMany([{ name: "bulk-3", companyId: "B" }]), { code: "CROSS_TENANT" }));
  assert.equal(await raw(() => Widget.countDocuments({ name: "bulk-3" })), 0);
});

test("bulkWrite is scoped: filters are narrowed, inserts stamped, foreign ones refused", { skip }, async () => {
  await as("A", () => Widget.bulkWrite([
    { insertOne: { document: { name: "bw-new" } } },
    { updateMany: { filter: { name: { $in: ["rice", "only-B", "upserted"] } }, update: { $set: { qty: 55 } } } },
  ]));
  assert.equal((await raw(() => Widget.findOne({ name: "bw-new" }).lean())).companyId, "A");
  const bRows = await raw(() => Widget.find({ companyId: "B", name: { $in: ["rice", "only-B", "upserted"] } }).lean());
  assert.ok(bRows.every((w) => w.qty !== 55), "B's rows were not touched by A's bulk update");
  await as("A", () => assert.rejects(() => Widget.bulkWrite([{ insertOne: { document: { name: "bw-bad", companyId: "B" } } }]), { code: "CROSS_TENANT" }));
  await as("A", () => assert.rejects(() => Widget.bulkWrite([{ deleteMany: { filter: { companyId: "B" } } }]), { code: "CROSS_TENANT" }));
  assert.equal(await raw(() => Widget.countDocuments({ companyId: "B" })), 4, "B's four rows are all still there");
});

test("estimatedDocumentCount cannot be scoped, so it is refused inside a scope", { skip }, async () => {
  await as("A", () => assert.rejects(() => Widget.estimatedDocumentCount(), { code: "UNSUPPORTED_OP" }));
});

test("aggregations are scoped, and a pipeline naming another organisation is refused", { skip }, async () => {
  const a = await as("A", () => Widget.aggregate([{ $group: { _id: "$companyId", n: { $sum: 1 } } }]));
  assert.deepEqual(a.map((g) => g._id), ["A"], "only A's rows were grouped");
  await as("A", () => assert.rejects(() => Widget.aggregate([{ $match: { companyId: "B" } }]), { code: "CROSS_TENANT" }));
  const sorted = await as("A", () => Widget.aggregate([{ $match: { name: "rice" } }, { $sort: { name: 1 } }]));
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].companyId, "A");
});

test("a $lookup into another tenanted collection is scoped too, so a crafted link cannot leak", { skip }, async () => {
  const wa = await as("A", () => Widget.findOne({ name: "rice" }));
  const wb = await as("B", () => Widget.findOne({ name: "rice" }));
  await as("A", () => Gadget.create({ widgetId: wa._id, tag: "a-gadget" }));
  // B plants a gadget that POINTS AT A's widget: a lookup from A must not pull it in
  await as("B", () => Gadget.create({ widgetId: wa._id, tag: "b-points-at-a" }));
  await as("B", () => Gadget.create({ widgetId: wb._id, tag: "b-gadget" }));

  const joined = await as("A", () => Widget.aggregate([
    { $match: { name: "rice" } },
    { $lookup: { from: "tenantgadgets", localField: "_id", foreignField: "widgetId", as: "gadgets" } },
  ]));
  assert.deepEqual(joined[0].gadgets.map((g) => g.tag), ["a-gadget"], "B's gadget is not joined into A's result");

  // the same join written with an explicit pipeline is scoped as well
  const piped = await as("A", () => Widget.aggregate([
    { $match: { name: "rice" } },
    { $lookup: { from: "tenantgadgets", localField: "_id", foreignField: "widgetId", as: "gadgets", pipeline: [{ $project: { tag: 1 } }] } },
  ]));
  assert.deepEqual(piped[0].gadgets.map((g) => g.tag), ["a-gadget"]);

  // and inside a $facet branch
  const faceted = await as("A", () => Widget.aggregate([
    { $facet: { rice: [{ $match: { name: "rice" } }, { $lookup: { from: "tenantgadgets", localField: "_id", foreignField: "widgetId", as: "g" } }] } },
  ]));
  assert.deepEqual(faceted[0].rice[0].g.map((g) => g.tag), ["a-gadget"]);
});

test("a $lookup into a collection that is not tenanted is left alone", { skip }, async () => {
  const wa = await as("A", () => Widget.findOne({ name: "rice" }));
  await Plain.create({ label: "shared", widgetId: wa._id });
  const joined = await as("A", () => Widget.aggregate([
    { $match: { name: "rice" } },
    { $lookup: { from: "tenantplains", localField: "_id", foreignField: "widgetId", as: "plain" } },
  ]));
  assert.equal(joined[0].plain.length, 1, "an untenanted collection still joins; stage 5 is what tenants those");
});

test("populate goes through the scope, so a reference into another organisation resolves to nothing", { skip }, async () => {
  const wa = await as("A", () => Widget.findOne({ name: "rice" }));
  const stray = await as("B", () => Gadget.create({ widgetId: wa._id, tag: "b-stray" }));
  const loaded = await as("B", () => Gadget.findById(stray._id).populate("widgetId"));
  assert.equal(loaded.widgetId, null, "B cannot read A's widget by following a stored id");
});

test("organisations stay separate under concurrent load", { skip }, async () => {
  const orgs = ["A", "B", "C"];
  await Promise.all(Array.from({ length: 30 }, (_, i) => as(orgs[i % 3], async () => {
    await new Promise((r) => setTimeout(r, (i * 7) % 11));
    await Widget.create({ name: `load-${i}` });
  })));
  for (const org of orgs) {
    const rows = await as(org, () => Widget.find({ name: /^load-/ }).lean());
    assert.equal(rows.length, 10, `${org} has its own ten`);
    assert.ok(rows.every((r) => r.companyId === org), `${org} has nobody else's`);
  }
});

test("queries inside a transaction are scoped as well", { skip }, async () => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await as("A", async () => {
        await Widget.create([{ name: "in-tx" }], { session });
        const seen = await Widget.find({ name: /^in-tx|^only-/ }).session(session).lean();
        assert.ok(seen.every((r) => r.companyId === "A"), "a transaction does not widen the scope");
      });
    });
  } finally {
    await session.endSession();
  }
  assert.equal((await raw(() => Widget.findOne({ name: "in-tx" }).lean())).companyId, "A");
});
