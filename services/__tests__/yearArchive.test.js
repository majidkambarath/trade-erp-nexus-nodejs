// Archiving a closed fiscal year to one sealed file, checking a file against the books, and putting back the records
// that are gone. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/yearArchive.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const zlib = require("zlib");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const rules = require("../../utils/yearArchive");
const { sign } = require("../../utils/secretBox");
const { runWithTenant } = require("../../utils/tenantContext");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_ya_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const req = { admin: { id: String(new mongoose.Types.ObjectId()), email: "auditor@example.ae" }, ip: "10.0.0.9" };
const refused = (code) => (err) => { assert.equal(err.code, code, err.message); return true; };

test("the file format: what is packed comes back exactly, and any change breaks the seal", () => {
  const id = new mongoose.Types.ObjectId();
  const docs = [{ _id: id, companyId: "x", date: new Date("2025-02-03T00:00:00Z"), amount: 10.5, n: 3, list: [1, "a"] }];
  const { bytes } = rules.pack({ organisation: "x", fiscalYear: { id: "y", code: "2025" }, createdAt: "t", createdBy: "me", version: "1", collections: { Transaction: { field: "date", docs } } }, sign);
  const verify = (p, d, s) => sign(p, d) === s;
  const back = rules.unpack(bytes, verify);
  assert.equal(String(back.collections.Transaction.docs[0]._id), String(id));
  assert.ok(back.collections.Transaction.docs[0].date instanceof Date);
  assert.equal(rules.recordHash(back.collections.Transaction.docs[0]), rules.recordHash(docs[0]));

  const raw = JSON.parse(zlib.gunzipSync(bytes).toString());
  raw.collections.Transaction.docs[0].amount = { $numberDouble: "99" };
  assert.throws(() => rules.unpack(zlib.gzipSync(JSON.stringify(raw)), verify), refused("ARCHIVE_TAMPERED"));
  // the checksum recomputed as well: the seal still catches it
  raw.collections.Transaction.sha256 = rules.sha256(JSON.stringify(raw.collections.Transaction.docs));
  assert.throws(() => rules.unpack(zlib.gzipSync(JSON.stringify(raw)), verify), refused("ARCHIVE_TAMPERED"));
  assert.throws(() => rules.unpack(Buffer.from("not a file"), verify), refused("ARCHIVE_UNREADABLE"));
  assert.throws(() => rules.unpack(zlib.gzipSync(JSON.stringify({ format: "other" })), verify), refused("ARCHIVE_UNREADABLE"));
  assert.equal(rules.fileName("abc", "2025/../x"), "abc-2025x-archive.json.gz");
});

let svc;
let fy;
const day = (s) => new Date(`${s}T00:00:00Z`);
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Archive: require("../financial/yearArchiveService"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    Transaction: require("../../models/modules/transactionModel"),
    LedgerEntry: require("../../models/modules/financial/financialModels").LedgerEntry,
    VATReturn: require("../../models/modules/financial/vatReturnModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
  };
  require("../../models/core/organisationModel");
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  fy = await svc.FiscalYear.create({ code: "2025", startDate: day("2025-01-01"), endDate: day("2025-12-31"), status: "closed", closedAt: day("2026-01-10") });
  const T = svc.Transaction.collection;
  await T.insertMany([
    { companyId: "default", branchId: "main", transactionNo: "SO-2025-0001", type: "sales_order", status: "APPROVED", date: day("2025-03-01"), totalAmount: 105, items: [{ description: "Rice", qty: 2 }] },
    { companyId: "default", branchId: "shj", transactionNo: "SHJ-SO-2025-0001", type: "sales_order", status: "APPROVED", date: day("2025-12-31"), totalAmount: 50 },
    { companyId: "default", branchId: "main", transactionNo: "SO-2026-0001", type: "sales_order", status: "DRAFT", date: day("2026-01-02"), totalAmount: 7 },
    { companyId: "other", branchId: "main", transactionNo: "SO-2025-0001", type: "sales_order", status: "APPROVED", date: day("2025-05-01"), totalAmount: 999 },
  ]);
  await svc.LedgerEntry.collection.insertMany([
    { companyId: "default", branchId: "main", accountId: new mongoose.Types.ObjectId(), date: day("2025-03-01"), debit: 105, credit: 0, voucherNo: "SO-2025-0001" },
    { companyId: "default", branchId: "main", accountId: new mongoose.Types.ObjectId(), date: day("2025-03-01"), debit: 0, credit: 105, voucherNo: "SO-2025-0001" },
  ]);
  await svc.VATReturn.collection.insertOne({ companyId: "default", returnNo: "VR-2025-Q1", periodFrom: "2025-01-01", periodTo: "2025-03-31", status: "FILED" });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("only a closed year, only in the all-branches view", { skip }, async () => {
  const open = await svc.FiscalYear.findOne({ status: "open" }).lean();
  await assert.rejects(svc.Archive.archive(req, String(open._id)), refused("ARCHIVE_YEAR_OPEN"));
  await assert.rejects(svc.Archive.archive(req, "nope"), refused("FISCAL_YEAR_NOT_FOUND"));
  await assert.rejects(
    runWithTenant({ companyId: "default", branchId: "main", branchView: "main" }, () => svc.Archive.archive(req, String(fy._id))),
    refused("ALL_BRANCHES_REQUIRED")
  );
});

let file;
test("a closed year is archived whole: every branch, nothing from another year or organisation", { skip }, async () => {
  file = await svc.Archive.archive(req, String(fy._id));
  assert.equal(file.fileName, "default-2025-archive.json.gz");
  assert.equal(file.counts.Transaction, 2);
  assert.equal(file.counts.LedgerEntry, 2);
  assert.equal(file.counts.VATReturn, 1);
  const [logged] = await svc.ActivityLog.find({ action: "FISCAL_YEAR_ARCHIVED" }).lean();
  assert.equal(logged.username, "auditor@example.ae");
  assert.match(logged.summary, /2025 archived: 5 record/);

  const checked = await svc.Archive.check(req, file.bytes);
  assert.equal(checked.missing, 0);
  assert.equal(checked.changed, 0);
  assert.equal(checked.fiscalYear.code, "2025");
});

test("records gone from the books are found and put back exactly, and nothing else is touched", { skip }, async () => {
  const lost = await svc.Transaction.collection.findOne({ transactionNo: "SO-2025-0001", companyId: "default" });
  const entry = await svc.LedgerEntry.collection.findOne({ companyId: "default", credit: 105 });
  await svc.Transaction.collection.deleteOne({ _id: lost._id });
  await svc.LedgerEntry.collection.deleteOne({ _id: entry._id });
  await svc.Transaction.collection.updateOne({ transactionNo: "SHJ-SO-2025-0001" }, { $set: { notes: "changed since" } });

  const checked = await svc.Archive.check(req, file.bytes);
  assert.equal(checked.missing, 2);
  assert.equal(checked.changed, 1);
  assert.deepEqual(checked.collections.find((c) => c.name === "Transaction"), { name: "Transaction", archived: 2, live: 1, missing: 1, changed: 1, added: 0 });

  const out = await svc.Archive.restore(req, file.bytes);
  assert.deepEqual(out.restored, { Transaction: 1, LedgerEntry: 1 });
  assert.equal(out.missing, 0);
  const back = await svc.Transaction.collection.findOne({ _id: lost._id });
  assert.equal(rules.recordHash(back), rules.recordHash(lost), "the record comes back byte for byte");
  assert.ok(await svc.LedgerEntry.collection.findOne({ _id: entry._id }));
  assert.equal((await svc.Transaction.collection.findOne({ transactionNo: "SHJ-SO-2025-0001" })).notes, "changed since", "a record that differs is only reported");
  const [logged] = await svc.ActivityLog.find({ action: "FISCAL_YEAR_RESTORED" }).lean();
  assert.match(logged.summary, /2 missing record\(s\) restored/);

  await assert.rejects(svc.Archive.restore(req, file.bytes), refused("NOTHING_TO_RESTORE"));
});

test("a number taken since stops the whole restore; another organisation's file is refused", { skip }, async () => {
  const lost = await svc.Transaction.collection.findOne({ transactionNo: "SO-2025-0001", companyId: "default" });
  const entry = await svc.LedgerEntry.collection.findOne({ companyId: "default", debit: 105 });
  const vat = await svc.VATReturn.collection.findOne({ companyId: "default", returnNo: "VR-2025-Q1" });
  await svc.Transaction.collection.deleteOne({ _id: lost._id });
  await svc.LedgerEntry.collection.deleteOne({ _id: entry._id });
  await svc.VATReturn.collection.deleteOne({ _id: vat._id });
  // the VAT return's number given to another return since (outside the year): the LAST collection restored clashes
  await svc.VATReturn.collection.insertOne({ companyId: "default", returnNo: "VR-2025-Q1", periodFrom: "2026-01-01", periodTo: "2026-03-31", status: "DRAFT" });
  await assert.rejects(svc.Archive.restore(req, file.bytes), refused("RESTORE_CONFLICT"));
  assert.equal(await svc.Transaction.collection.findOne({ _id: lost._id }), null, "all or nothing: the invoice restored before the clash is rolled back");
  assert.equal(await svc.LedgerEntry.collection.findOne({ _id: entry._id }), null, "nothing was restored");

  const { bytes } = rules.pack({ organisation: "other", fiscalYear: { id: String(fy._id), code: "2025" }, createdAt: "t", createdBy: "x", version: "1", collections: {} }, sign);
  await assert.rejects(svc.Archive.check(req, bytes), refused("ARCHIVE_OTHER_ORGANISATION"));
  // a file built by someone else - every checksum right, the seal's hash right - but not signed by this installation
  const forged = rules.pack({ organisation: "default", fiscalYear: { id: String(fy._id), code: "2025" }, createdAt: "t", createdBy: "x", version: "1", collections: { Transaction: { field: "date", docs: [] } } }, () => "f".repeat(64));
  await assert.rejects(svc.Archive.check(req, forged.bytes), refused("ARCHIVE_TAMPERED"));
  await assert.rejects(svc.Archive.restore(req, forged.bytes), refused("ARCHIVE_TAMPERED"));
  await assert.rejects(svc.Archive.check(req, Buffer.alloc(0)), refused("ARCHIVE_FILE_REQUIRED"));

  await svc.FiscalYear.updateOne({ _id: fy._id }, { status: "open" });
  await assert.rejects(svc.Archive.check(req, file.bytes), refused("ARCHIVE_YEAR_OPEN"));
  await svc.FiscalYear.updateOne({ _id: fy._id }, { status: "closed" });
});
