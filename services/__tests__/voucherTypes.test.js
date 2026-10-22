// The voucher type master and the numbering engine against a database: the seed reproduces today's
// numbers, a configured format takes effect, a continuous series counts across a year end, a branch gets
// its own series, a deleted number is handed back only where that is allowed, and a typed number floats
// the counter past itself. Throwaway database (random name, dropped after).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let S;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  S = {
    Types: require("../core/voucherTypeService"),
    Numbers: require("../core/numberSeriesService"),
    Register: require("../core/numberRegisterService"),
    VoucherType: require("../../models/modules/financial/voucherTypeModel"),
    NumberSeries: require("../../models/modules/financial/numberSeriesModel"),
    Issued: require("../../models/modules/financial/issuedNumberModel"),
    Fiscal: require("../../models/modules/financial/fiscalYearModel"),
    V: require("../../utils/voucherTypes"),
  };
  await mongoose.connection.syncIndexes();
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const Y = String(new Date().getUTCFullYear());
const reset = async (series) => {
  await S.NumberSeries.deleteMany({ series });
  await S.Issued.deleteMany({ series });
};
const set = async (key, patch) => {
  await S.Types.ensureDefaults();
  return S.Types.update(key, patch, {});
};

test("the seed is lazy, idempotent, and numbers exactly as the hardcoded table did", { skip }, async () => {
  // Nothing has been seeded, and numbering still works: that is what keeps seeding out of a posting
  // transaction and leaves an organisation that has never opened the screen untouched.
  assert.equal(await S.VoucherType.countDocuments({}), 0, "no master rows yet");
  assert.equal(await S.Numbers.allocate("SO"), `SO-${Y}-0001`);
  assert.equal(await S.Numbers.allocate("SO"), `SO-${Y}-0002`);

  const made = await S.Types.ensureDefaults();
  assert.equal(made, 29);
  assert.equal(await S.Types.ensureDefaults(), 0, "a second read seeds nothing");
  assert.equal(await S.VoucherType.countDocuments({}), 29);
  assert.equal(await S.Numbers.allocate("SO"), `SO-${Y}-0003`, "and the count carries on across the seeding");

  const rows = await S.Types.list({}, {});
  assert.equal(rows.find((r) => r.key === "SO").statutory, true);
  assert.equal(rows.find((r) => r.key === "JV").statutory, false);
  assert.ok(rows.every((r) => r.isSystem), "every seeded row is a built-in");
  await reset("SO");
});

test("every number given out is recorded, which is what makes a gap explainable", { skip }, async () => {
  await reset("JV");
  const a = await S.Numbers.allocate("JV", new Date(), { docType: "Voucher", docId: new mongoose.Types.ObjectId() });
  const row = await S.Issued.findOne({ number: a }).lean();
  assert.equal(row.series, "JV");
  assert.equal(row.seq, 1);
  assert.equal(row.label, Y, "the label is the counter it came from");
  assert.equal(row.status, "issued");
  assert.equal(row.docType, "Voucher");

  const bulk = await S.Numbers.allocateMany("OSI", 3, new Date(), { docType: "Transaction" });
  assert.deepEqual(bulk, [`OSI-${Y}-0001`, `OSI-${Y}-0002`, `OSI-${Y}-0003`]);
  assert.equal(await S.Issued.countDocuments({ series: "OSI" }), 3, "a run is recorded number by number");
  assert.deepEqual(await S.Numbers.allocateMany("OSI", 0), [], "nothing asked for, nothing recorded");
  await reset("OSI");
});

test("a number is never given to two documents, whatever a counter is wound back to", { skip }, async () => {
  await reset("EV");
  const first = await S.Numbers.allocate("EV");
  // The one way a duplicate could be minted is a counter wound backwards by hand. The register refuses
  // it rather than obeying it.
  await S.NumberSeries.updateOne({ series: "EV", fiscalYear: Y }, { $set: { next: 0 } });
  await assert.rejects(() => S.Numbers.allocate("EV"), { code: "NUMBER_ALREADY_USED" });
  assert.equal(await S.Issued.countDocuments({ series: "EV" }), 1, "and nothing was recorded for the refused one");
  assert.equal(first, `EV-${Y}-0001`);
  await reset("EV");
});

test("a configured format takes effect on the next number and never rewrites an issued one", { skip }, async () => {
  await reset("SO");
  const before = await S.Numbers.allocate("SO");
  assert.equal(before, `SO-${Y}-0001`);

  await set("SO", { prefix: "INV", separator: "/", numberLength: 5 });
  const after = await S.Numbers.allocate("SO");
  assert.equal(after, `INV/${Y}/00002`, "the count carries on; only the shape changed");
  assert.equal((await S.Issued.findOne({ number: before }).lean()).number, before, "what was issued stays as it was issued");

  const counter = await S.NumberSeries.findOne({ series: "SO", fiscalYear: Y }).lean();
  assert.equal(counter.prefix, "INV", "the counter row shows the format that minted its latest number");
  assert.equal(counter.numberLength, 5);

  await set("SO", { prefix: "SO", separator: "-", numberLength: 4 });
  await reset("SO");
});

test("yearly restarts the count; continuous carries it across a year end and prints no year", { skip }, async () => {
  await reset("JV");
  await S.Fiscal.deleteMany({});
  await S.Fiscal.create([
    { companyId: "default", code: "2031", startDate: new Date("2031-01-01T00:00:00Z"), endDate: new Date("2031-12-31T23:59:59.999Z") },
    { companyId: "default", code: "2032", startDate: new Date("2032-01-01T00:00:00Z"), endDate: new Date("2032-12-31T23:59:59.999Z") },
  ]);
  const inY = (y) => new Date(`${y}-06-15T08:00:00Z`);

  assert.equal(await S.Numbers.allocate("JV", inY(2031)), "JV-2031-0001");
  assert.equal(await S.Numbers.allocate("JV", inY(2031)), "JV-2031-0002");
  assert.equal(await S.Numbers.allocate("JV", inY(2032)), "JV-2032-0001", "a new year restarts the count");

  // Switching to continuous must CARRY the count over, or the client's next voucher is numbered 0001
  // again after years of trading.
  const saved = await set("JV", { resetPolicy: "never", includeYear: false });
  assert.ok(saved.reseeded, "the new counter was seeded from the old ones");
  assert.equal(await S.Numbers.allocate("JV", inY(2032)), "JV-0003", "two were issued in 2031, so the next is the third");
  assert.equal(await S.Numbers.allocate("JV", inY(2033)), "JV-0004", "and a later year does not restart it");

  const counters = await S.NumberSeries.find({ series: "JV" }).lean();
  assert.ok(counters.some((c) => c.fiscalYear === S.V.CONTINUOUS), "it counts under one label for good");
  await set("JV", { resetPolicy: "yearly", includeYear: true });
  await reset("JV");
  await S.Fiscal.deleteMany({});
});

test("a branch carries its code in front, and can be given a shorter one or none", { skip }, async () => {
  const { runWithTenant } = require("../../utils/tenantContext");
  await reset("PV");
  const inBranch = (branchId, fn) => runWithTenant({ companyId: "default", branchId }, fn);

  assert.equal(await inBranch("main", () => S.Numbers.allocate("PV")), `PV-${Y}-0001`);
  assert.equal(await inBranch("shj", () => S.Numbers.allocate("PV")), `SHJ-PV-${Y}-0001`,
    "a branch has its OWN counter, so both start at one and neither can reach the other's number");
  assert.equal(await inBranch("shj", () => S.Numbers.allocate("PV")), `SHJ-PV-${Y}-0002`);
  assert.equal(await inBranch("main", () => S.Numbers.allocate("PV")), `PV-${Y}-0002`);

  await set("PV", { branchPrefixes: [{ branchId: "shj", prefix: "SH" }] });
  assert.equal(await inBranch("shj", () => S.Numbers.allocate("PV")), `SH-PV-${Y}-0003`, "a branch can be given a shorter code");
  await set("PV", { branchPrefix: "none", branchPrefixes: [] });
  assert.equal(await inBranch("shj", () => S.Numbers.allocate("PV")), `PV-${Y}-0004`,
    "with the branch left out it shares head office's counter, which is why the screen warns about it");

  await set("PV", { branchPrefix: "auto" });
  await reset("PV");
});

// withTransactionSession is a decorator: it returns a function that opens the session and passes it as
// the LAST argument. So wrap, then call.
const inTx = (fn) => require("../../utils/withTransactionSession").withTransactionSession(fn)();

test("a deleted number is handed back only where the type allows it, and only inside a transaction", { skip }, async () => {
  await reset("JV");
  await set("JV", { allowReuse: true });
  const doc1 = new mongoose.Types.ObjectId();
  const doc2 = new mongoose.Types.ObjectId();
  const doc3 = new mongoose.Types.ObjectId();

  const a = await inTx((session) => S.Numbers.allocate("JV", new Date(), { session, docType: "Voucher", docId: doc1 }));
  const b = await inTx((session) => S.Numbers.allocate("JV", new Date(), { session, docType: "Voucher", docId: doc2 }));
  assert.deepEqual([a, b], [`JV-${Y}-0001`, `JV-${Y}-0002`]);

  const freed = await inTx((session) => S.Numbers.release({ docId: doc1, reason: "entered twice", session }));
  assert.equal(freed.status, "released");
  assert.equal(freed.number, a);

  const next = await inTx((session) => S.Numbers.allocate("JV", new Date(), { session, docType: "Voucher", docId: doc3 }));
  assert.equal(next, a, "the freed number comes before a new one");
  const after = await inTx((session) => S.Numbers.allocate("JV", new Date(), { session, docType: "Voucher", docId: new mongoose.Types.ObjectId() }));
  assert.equal(after, `JV-${Y}-0003`, "and once it is used the count carries on");

  const row = await S.Issued.findOne({ number: a }).lean();
  assert.equal(row.status, "issued");
  assert.equal(String(row.docId), String(doc3), "the record now names the document that has it");

  // Releasing twice must not put one number in the free list twice: that is how two documents would end
  // up sharing it.
  assert.equal(await inTx((session) => S.Numbers.release({ docId: doc1, session })), null, "the first delete already released it");
  await set("JV", { allowReuse: false });
  await reset("JV");
});

test("a tax document's number is retired, never handed back, and the gap keeps its reason", { skip }, async () => {
  await reset("SO");
  const doc = new mongoose.Types.ObjectId();
  const one = await inTx((session) => S.Numbers.allocate("SO", new Date(), { session, docType: "Transaction", docId: doc }));
  assert.equal(one, `SO-${Y}-0001`);

  // Even with re-use switched on at the database, a statutory type refuses: utils/voucherTypes.js mayReuse
  // is the rule, and the setting cannot override it.
  await S.VoucherType.updateOne({ key: "SO" }, { $set: { allowReuse: true } });
  S.Types.forget("default");
  const ended = await inTx((session) => S.Numbers.release({ docId: doc, reason: "wrong customer", session }));
  assert.equal(ended.status, "cancelled", "retired, not released");

  const next = await inTx((session) => S.Numbers.allocate("SO", new Date(), { session, docType: "Transaction", docId: new mongoose.Types.ObjectId() }));
  assert.equal(next, `SO-${Y}-0002`, "the gap stays open");

  const report = await S.Register.gaps({}, { series: "SO" });
  const scope = report.scopes.find((s) => s.label === Y);
  assert.equal(scope.continuous, false);
  assert.deepEqual(scope.gaps.map((g) => [g.seq, g.code, g.reason]), [[1, "CANCELLED", "wrong customer"]],
    "an auditor asking why there is no invoice 1 gets an answer");

  await S.VoucherType.updateOne({ key: "SO" }, { $set: { allowReuse: false } });
  S.Types.forget("default");
  await reset("SO");
});

test("a document that was sent to the customer keeps its number whatever the type says", { skip }, async () => {
  await reset("JV");
  await set("JV", { allowReuse: true });
  const doc = new mongoose.Types.ObjectId();
  await inTx((session) => S.Numbers.allocate("JV", new Date(), { session, docType: "Voucher", docId: doc }));
  // `retire` is how a caller reports that THIS document has spent its number - it was emailed, or
  // e-invoiced, so the number is already in somebody else's hands.
  const ended = await inTx((session) => S.Numbers.release({ docId: doc, reason: "deleted after it was sent", retire: true, session }));
  assert.equal(ended.status, "cancelled");
  const next = await inTx((session) => S.Numbers.allocate("JV", new Date(), { session, docId: new mongoose.Types.ObjectId() }));
  assert.equal(next, `JV-${Y}-0002`, "the number it was sent under is not handed to anybody else");
  await set("JV", { allowReuse: false });
  await reset("JV");
});

test("a typed number is refused unless the type allows it, and floats the counter past itself", { skip }, async () => {
  await reset("SO");
  await assert.rejects(() => S.Numbers.claimManual("SO", `SO-${Y}-0500`), { code: "NUMBER_NOT_TYPEABLE" });

  await set("SO", { method: "auto_override" });
  const typed = await S.Numbers.claimManual("SO", `SO-${Y}-0500`, new Date(), { docType: "Transaction", docId: new mongoose.Types.ObjectId() });
  assert.equal(typed, `SO-${Y}-0500`);

  // The point of floating: without it the automatic series would walk up to 0500 and fail on the unique
  // index months later, which is what the old client-supplied transactionNo path did.
  assert.equal(await S.Numbers.allocate("SO"), `SO-${Y}-0501`);

  // A number from the client's old paper book is recorded, but it is not this series' 77th document.
  const foreign = await S.Numbers.claimManual("SO", "INV/OLD/77", new Date(), { docId: new mongoose.Types.ObjectId() });
  assert.equal(foreign, "INV/OLD/77");
  const row = await S.Issued.findOne({ number: "INV/OLD/77" }).lean();
  assert.equal(row.seq, null, "it belongs to no sequence");
  assert.equal(row.manual, true);
  assert.equal(await S.Numbers.allocate("SO"), `SO-${Y}-0502`, "and it did not move the counter");

  await assert.rejects(() => S.Numbers.claimManual("SO", `SO-${Y}-0500`, new Date(), { docId: new mongoose.Types.ObjectId() }), { code: "NUMBER_ALREADY_USED" },
    "the same number cannot be typed twice");
  await assert.rejects(() => S.Numbers.claimManual("SO", "  "), { code: "NUMBER_REQUIRED" });

  await set("SO", { method: "auto" });
  await reset("SO");
});

test("a variant carries its own series and posts as its parent", { skip }, async () => {
  await S.Types.ensureDefaults();
  const made = await S.Types.create({ key: "PCV", name: "Petty cash payment", parentKey: "PV", prefix: "PCV" }, {});
  assert.equal(made.postsAs, "payment", "the engine still sees a payment, which is why nothing else had to change");
  assert.equal(made.kind, "voucher");
  assert.equal(made.isSystem, false);
  assert.equal(made.statutory, false);

  assert.equal(await S.Numbers.allocate("PCV"), `PCV-${Y}-0001`, "its own counter");
  assert.equal(await S.Numbers.allocate("PV"), `PV-${Y}-0001`, "and the parent's is untouched");
  assert.equal(await S.Numbers.seriesFor({ voucherType: "payment", voucherTypeKey: "PCV" }), "PCV");
  assert.equal(await S.Numbers.seriesFor({ voucherType: "payment" }), "PV", "no variant named, so the built-in");

  await assert.rejects(() => S.Types.create({ key: "X2", name: "No parent", prefix: "X2" }, {}), { code: "PARENT_REQUIRED" });
  await assert.rejects(() => S.Types.create({ key: "PCV2", name: "Deeper", parentKey: "PCV", prefix: "PC2" }, {}), { code: "VOUCHER_TYPE_INVALID" });
  await assert.rejects(() => S.Types.create({ key: "PCV", name: "Again", parentKey: "PV", prefix: "PC3" }, {}), { code: "VOUCHER_TYPE_INVALID" });
  await reset("PCV");
  await reset("PV");
});

test("the master refuses what would break a number, and a built-in is switched off, not deleted", { skip }, async () => {
  await S.Types.ensureDefaults();
  await assert.rejects(() => S.Types.update("SO", { numberLength: 2 }, {}), { code: "VOUCHER_TYPE_INVALID" });
  await assert.rejects(() => S.Types.update("SO", { prefix: "SO-X" }, {}), { code: "VOUCHER_TYPE_INVALID" });
  await assert.rejects(() => S.Types.update("SO", { allowReuse: true }, {}), { code: "VOUCHER_TYPE_INVALID" });
  await assert.rejects(() => S.Types.update("JV", { resetPolicy: "never" }, {}), { code: "VOUCHER_TYPE_INVALID" },
    "a continuous counter cannot keep the year segment");
  await assert.rejects(() => S.Types.update("YEC", { method: "auto_override" }, {}), { code: "VOUCHER_TYPE_INVALID" });
  await assert.rejects(() => S.Types.get("NOPE", {}), { code: "VOUCHER_TYPE_NOT_FOUND" });

  await assert.rejects(() => S.Types.remove("SO", {}), { code: "VOUCHER_TYPE_IS_DEFAULT" });
  const off = await S.Types.update("SO", { isActive: false }, {});
  assert.equal(off.isActive, false);
  await assert.rejects(() => S.Numbers.allocate("SO"), { code: "VOUCHER_TYPE_INACTIVE" }, "a switched-off type gives out no numbers");
  await S.Types.update("SO", { isActive: true }, {});

  // A variant with nothing built on it can go; once it has numbered something it can only be switched off.
  await S.Types.create({ key: "TMP", name: "Temporary", parentKey: "JV", prefix: "TMP" }, {});
  assert.deepEqual(await S.Types.usage("TMP", {}), { issued: 0, counters: 0, variants: 0 });
  assert.equal((await S.Types.remove("TMP", {})).key, "TMP");

  await S.Types.create({ key: "TMP2", name: "Temporary two", parentKey: "JV", prefix: "TMP2" }, {});
  await S.Numbers.allocate("TMP2");
  assert.equal((await S.Types.usage("TMP2", {})).issued, 1);
  await assert.rejects(() => S.Types.remove("TMP2", {}), { code: "VOUCHER_TYPE_IN_USE" });
  await reset("TMP2");
});

test("the register reads back what was issued, and tells the deleted ones apart", { skip }, async () => {
  await reset("CV");
  await set("CV", { allowReuse: true });
  const kept = new mongoose.Types.ObjectId();
  const gone = new mongoose.Types.ObjectId();
  await inTx((session) => S.Numbers.allocate("CV", new Date(), { session, docType: "Voucher", docId: kept }));
  await inTx((session) => S.Numbers.allocate("CV", new Date(), { session, docType: "Voucher", docId: gone }));
  await inTx((session) => S.Numbers.release({ docId: gone, reason: "keyed in error", session }));

  const all = await S.Register.list({}, { series: "CV" });
  assert.equal(all.total, 2);
  assert.ok(all.rows.every((r) => r.typeName === "Contra"), "a row is named, not just coded");

  const ended = await S.Register.list({}, { series: "CV", status: "ended" });
  assert.equal(ended.total, 1, "the deleted list is the register asked a different question");
  assert.equal(ended.rows[0].reason, "keyed in error");
  assert.equal(ended.rows[0].status, "released");

  assert.deepEqual(await S.Register.summary({}, { series: "CV" }), { issued: 1, released: 1, cancelled: 0 });

  const report = await S.Register.gaps({}, { series: "CV" });
  const scope = report.scopes.find((s) => s.label === Y);
  assert.equal(report.name, "Contra");
  assert.equal(scope.counter, 2);
  assert.deepEqual(scope.gaps.map((g) => g.code), ["RELEASED"], "the hole is the number waiting to be used again");
  await set("CV", { allowReuse: false });
  await reset("CV");
});

test("deleting a real voucher records the number, with its reason, and hands it back where allowed", { skip }, async () => {
  const Financial = require("../financial/financialService");
  const { LedgerAccount, CompanySettings } = { ...require("../../models/modules/financial/financialModels"), CompanySettings: require("../../models/modules/financial/companySettingsModel") };
  await require("../../utils/seedAccounting").seedAccounting({ log: () => {} });
  await CompanySettings.updateMany({}, { ledgerPostingEnabled: true, ledgerPostingTouched: true });
  await S.Fiscal.deleteMany({});
  const [rent, cash] = [
    await LedgerAccount.findOne({ accountName: /rent/i }),
    await LedgerAccount.findOne({ accountName: /^cash/i }),
  ];
  assert.ok(rent && cash, "the seeded chart has the accounts this needs");

  await reset("JV");
  await set("JV", { allowReuse: true });
  const admin = new mongoose.Types.ObjectId(); // createdBy is an ObjectId on a voucher
  const journal = (n) => Financial.createVoucher(
    { voucherType: "journal", date: new Date(), narration: "Register test " + n, lines: [{ accountId: rent._id, debit: 10 }, { accountId: cash._id, credit: 10 }] },
    String(admin)
  );

  const one = await journal(1);
  const two = await journal(2);
  assert.equal(one.voucherNo, `JV-${Y}-0001`);
  assert.equal(two.voucherNo, `JV-${Y}-0002`);
  assert.equal((await S.Issued.findOne({ number: one.voucherNo }).lean()).docType, "Voucher", "the register says what kind of thing has it");

  await Financial.deleteVoucher(one._id, String(admin), { reason: "entered twice" });

  const ended = await S.Register.list({}, { series: "JV", status: "ended" });
  assert.equal(ended.total, 1, "the deleted voucher is on the deleted list");
  assert.equal(ended.rows[0].number, one.voucherNo);
  assert.equal(ended.rows[0].reason, "entered twice", "with the reason the person gave");
  assert.equal(ended.rows[0].endedBy, String(admin), "and who did it");
  assert.equal(ended.rows[0].status, "released");

  const three = await journal(3);
  assert.equal(three.voucherNo, one.voucherNo, "and the number is handed to the next journal");

  const report = await S.Register.gaps({}, { series: "JV" });
  const scope = report.scopes.find((s) => s.label === Y);
  assert.equal(scope.continuous, true, "so the sequence has no hole left in it at all");

  // With re-use off, the same deletion leaves a hole that is explained instead of filled.
  await set("JV", { allowReuse: false });
  await Financial.deleteVoucher(two._id, String(admin), { reason: "wrong account" });
  const after = await S.Register.gaps({}, { series: "JV" });
  const scope2 = after.scopes.find((s) => s.label === Y);
  assert.deepEqual(scope2.gaps.map((g) => [g.seq, g.code, g.reason]), [[2, "CANCELLED", "wrong account"]]);
  const four = await journal(4);
  // 0001 was re-used, which does not move the counter, so the counter is still at 2: the next NEW number
  // is 0003, and the retired 0002 is not given out again.
  assert.equal(four.voucherNo, `JV-${Y}-0003`, "the retired number is not given out again");
  await reset("JV");
});

test("the migration takes every voucher written before the flag existed into the unique index", { skip }, async () => {
  const { Voucher } = require("../../models/modules/financial/financialModels");
  const { markVoucherNumbersHeld } = require("../../utils/migrations");

  // A voucher as older versions wrote it: no numberReleased at all, so it matches the partial index's
  // filter on nothing and would sit OUTSIDE the unique index - taking away the uniqueness the index is
  // there for.
  await Voucher.collection.insertMany([
    { companyId: "default", branchId: "main", voucherNo: "OLD-0001", voucherType: "journal", date: new Date(), totalAmount: 1, createdBy: new mongoose.Types.ObjectId(), status: "approved" },
    { companyId: "default", branchId: "main", voucherNo: "OLD-0002", voucherType: "journal", date: new Date(), totalAmount: 1, createdBy: new mongoose.Types.ObjectId(), status: "cancelled" },
  ]);
  assert.equal(await Voucher.countDocuments({ numberReleased: { $exists: false } }), 2);

  const moved = await markVoucherNumbersHeld();
  assert.equal(moved, 2);
  assert.equal(await Voucher.countDocuments({ numberReleased: { $exists: false } }), 0, "every old voucher now holds its number");
  assert.equal(await Voucher.countDocuments({ voucherNo: /^OLD-/, numberReleased: false }), 2,
    "both hold it - the migration never guesses that an old voucher had handed its number back, including the cancelled one");
  assert.equal(await markVoucherNumbersHeld(), 0, "running it again changes nothing");

  // And the rebuilt index really is the partial one, so two live vouchers still cannot share a number.
  const ix = (await Voucher.collection.indexes()).find((i) => i.key && i.key.voucherNo && i.unique);
  assert.deepEqual(ix.partialFilterExpression, { numberReleased: false }, "the old unconditional index was dropped");
  await assert.rejects(
    () => Voucher.collection.insertOne({ companyId: "default", branchId: "main", voucherNo: "OLD-0001", numberReleased: false, voucherType: "journal", date: new Date(), totalAmount: 1, createdBy: new mongoose.Types.ObjectId() }),
    { code: 11000 },
    "a second voucher holding a number in use is still refused"
  );
  await Voucher.deleteMany({ voucherNo: /^OLD-/ });
});
