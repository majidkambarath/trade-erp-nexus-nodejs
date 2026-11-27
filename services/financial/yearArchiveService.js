// Archiving a closed fiscal year, and restoring it.
//
// Archive: every record of the year (documents, vouchers, ledger entries, stock movements, cheques, VAT returns...) is
// written to one sealed file the organisation keeps (utils/yearArchive.js). Nothing is removed from the books: the year
// stays readable online for as long as the organisation keeps records (CompanySettings.retention), and the file is the
// copy kept apart from the system.
//
// Restore: a file is checked first - its checksums, its seal, that it is this organisation's and this year's - and
// compared with the books. Records that are in the file and gone from the books are put back as they were, with their
// own ids, in one transaction. Nothing that IS in the books is changed: a record that differs, or one added since, is
// only reported. Only a CLOSED year is archived or restored (a closed year cannot be posted to, so the file is the whole
// year and a missing record is a loss, not an edit), and only in the all-branches view (a year covers every branch).
//
// Reads and writes go to the collections directly, with the organisation named in every filter and checked on every
// record: a record must come back byte for byte, including the fields a model hides from ordinary reads.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const orgLocale = require("../../utils/orgLocale");
const { getTenant } = require("../../utils/tenant");
const { ambientTenant } = require("../../utils/tenantContext");
const { sign, safeEqual } = require("../../utils/secretBox");
const rules = require("../../utils/yearArchive");
const AuditService = require("../core/auditService");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");

// what a year holds, and the field that says which year a record belongs to
const COLLECTIONS = [
  ["Transaction", () => require("../../models/modules/transactionModel"), "date"],
  ["Voucher", () => require("../../models/modules/financial/financialModels").Voucher, "date"],
  ["LedgerEntry", () => require("../../models/modules/financial/financialModels").LedgerEntry, "date"],
  ["InventoryMovement", () => require("../../models/modules/inventoryMovementModel"), "date"],
  ["Cheque", () => require("../../models/modules/banking/bankingModels").Cheque, "chequeDate"],
  ["Quotation", () => require("../../models/modules/quotationModel"), "date"],
  ["DeliveryNote", () => require("../../models/modules/deliveryNoteModel"), "date"],
  ["TradeOrder", () => require("../../models/modules/tradeOrderModel"), "date"],
  ["GoodsReceipt", () => require("../../models/modules/goodsReceiptModel"), "date"],
  ["ProductionOrder", () => require("../../models/modules/productionOrderModel"), "date"],
  ["JobWorkOrder", () => require("../../models/modules/jobWorkOrderModel"), "date"],
  ["OpeningBalanceVoucher", () => require("../../models/modules/financial/openingBalanceModel"), "date"],
  ["VATReturn", () => require("../../models/modules/financial/vatReturnModel"), "periodFrom", "day"],
];
const BY_NAME = new Map(COLLECTIONS.map((c) => [c[0], c]));
const MAX_BYTES = 100 * 1024 * 1024; // a compressed archive; a larger one is refused before it is read

const verify = (purpose, digest, signature) => typeof signature === "string" && safeEqual(sign(purpose, digest), signature);

function assertAllBranches(what) {
  if (ambientTenant()?.branchView) throw new AppError(`${what} covers every branch: switch to All branches first`, 409, "ALL_BRANCHES_REQUIRED");
}

async function closedYear(id) {
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) throw new AppError("Fiscal year not found", 404, "FISCAL_YEAR_NOT_FOUND");
  const fy = await FiscalYear.findById(id).lean();
  if (!fy) throw new AppError("Fiscal year not found", 404, "FISCAL_YEAR_NOT_FOUND");
  if (fy.status !== "closed") throw new AppError(`Fiscal year ${fy.code} is open: only a closed year is archived or restored`, 409, "ARCHIVE_YEAR_OPEN");
  return fy;
}

const yearOf = (fy) => ({ id: String(fy._id), code: fy.code, startDay: orgLocale.dayOf(fy.startDate), endDay: orgLocale.dayOf(fy.endDate), closedAt: fy.closedAt ? new Date(fy.closedAt).toISOString() : null });

// every record of the year in one collection, read straight from the collection with the organisation named
async function recordsOf([, model, field, kind], companyId, year) {
  const range = kind === "day"
    ? { $gte: year.startDay, $lte: year.endDay }
    : { $gte: orgLocale.dayStart(year.startDay), $lte: orgLocale.dayEnd(year.endDay) };
  return model().collection.find({ companyId, [field]: range }).sort({ _id: 1 }).toArray();
}

class YearArchiveService {
  static MAX_BYTES = MAX_BYTES;
  static COLLECTIONS = COLLECTIONS.map((c) => c[0]);

  /** -> { fileName, bytes, counts } for a closed year. */
  static async archive(req, id) {
    assertAllBranches("Archiving a year");
    const fy = await closedYear(id);
    const { companyId } = getTenant(req);
    const year = yearOf(fy);
    const collections = {};
    for (const c of COLLECTIONS) collections[c[0]] = { field: c[2], docs: await recordsOf(c, companyId, year) };
    const { archive, bytes } = rules.pack({
      organisation: companyId, fiscalYear: year, createdAt: new Date().toISOString(),
      createdBy: req?.admin?.email || null, version: require("../../package.json").version, collections,
    }, sign);
    const counts = Object.fromEntries(Object.entries(archive.collections).map(([k, c]) => [k, c.count]));
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    await AuditService.log({
      req, action: "FISCAL_YEAR_ARCHIVED", entity: "FiscalYear", entityId: fy._id,
      summary: `Fiscal year ${fy.code} archived: ${total} record(s), seal ${archive.seal.sha256.slice(0, 16)}`,
      after: { counts, seal: archive.seal.sha256 },
    });
    return { fileName: rules.fileName(companyId, fy.code), bytes, counts, seal: archive.seal.sha256 };
  }

  // read a file and check it belongs here; -> { archive, fy }
  static async open(req, buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AppError("Choose the archive file to check", 400, "ARCHIVE_FILE_REQUIRED");
    if (buffer.length > MAX_BYTES) throw new AppError("The file is too large", 413, "ARCHIVE_TOO_LARGE");
    const archive = rules.unpack(buffer, verify);
    const { companyId } = getTenant(req);
    if (archive.organisation !== companyId) throw new AppError("This archive belongs to another organisation", 409, "ARCHIVE_OTHER_ORGANISATION");
    const fy = await closedYear(String(archive.fiscalYear?.id || ""));
    if (fy.code !== archive.fiscalYear.code) throw new AppError("This archive's year does not match the year in the books", 409, "ARCHIVE_YEAR_MISMATCH");
    for (const name of Object.keys(archive.collections)) {
      if (!BY_NAME.has(name)) throw new AppError(`This archive holds records this system does not restore (${name})`, 409, "ARCHIVE_UNREADABLE");
    }
    return { archive, fy };
  }

  // per collection: the archived records against the books
  static async diff(req, archive, fy) {
    const { companyId } = getTenant(req);
    const year = yearOf(fy);
    const out = [];
    for (const [name, c] of Object.entries(archive.collections)) {
      const def = BY_NAME.get(name);
      for (const d of c.docs) {
        if (d.companyId !== companyId) throw new AppError("This archive holds another organisation's records", 409, "ARCHIVE_OTHER_ORGANISATION");
      }
      const live = await recordsOf(def, companyId, year);
      // a record whose date was moved out of the year is still in the books: look it up by id too
      const seen = new Set(live.map((d) => String(d._id)));
      const notInRange = c.docs.filter((d) => !seen.has(String(d._id))).map((d) => d._id);
      const moved = notInRange.length ? await def[1]().collection.find({ companyId, _id: { $in: notInRange } }).toArray() : [];
      out.push({ name, model: def[1], ...rules.compare(c.docs, [...live, ...moved]) });
    }
    return out;
  }

  static summary(archive, rows) {
    return {
      organisation: archive.organisation,
      fiscalYear: archive.fiscalYear,
      createdAt: archive.createdAt,
      createdBy: archive.createdBy,
      version: archive.version,
      seal: archive.seal.sha256,
      collections: rows.map((r) => ({ name: r.name, archived: r.archived, live: r.live, missing: r.missing.length, changed: r.changed, added: r.added })),
      missing: rows.reduce((s, r) => s + r.missing.length, 0),
      changed: rows.reduce((s, r) => s + r.changed, 0),
      added: rows.reduce((s, r) => s + r.added, 0),
    };
  }

  /** Check a file against the books; writes nothing. */
  static async check(req, buffer) {
    assertAllBranches("Checking a year archive");
    const { archive, fy } = await YearArchiveService.open(req, buffer);
    return YearArchiveService.summary(archive, await YearArchiveService.diff(req, archive, fy));
  }

  /** Put back the archived records that are gone from the books, in one transaction. */
  static async restore(req, buffer) {
    assertAllBranches("Restoring a year");
    const { archive, fy } = await YearArchiveService.open(req, buffer);
    const rows = await YearArchiveService.diff(req, archive, fy);
    const toRestore = rows.filter((r) => r.missing.length);
    if (!toRestore.length) throw new AppError("Nothing is missing: every record in this archive is in the books", 409, "NOTHING_TO_RESTORE");
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const r of toRestore) {
          try {
            await r.model().collection.insertMany(r.missing, { session, ordered: true });
          } catch (err) {
            if (err?.code === 11000) {
              throw new AppError(`A ${r.name} record in the books now has the same number or key as one being restored: nothing was restored`, 409, "RESTORE_CONFLICT", { collection: r.name });
            }
            throw err;
          }
        }
      });
    } finally {
      await session.endSession();
    }
    const restored = Object.fromEntries(toRestore.map((r) => [r.name, r.missing.length]));
    const total = Object.values(restored).reduce((s, n) => s + n, 0);
    await AuditService.log({
      req, action: "FISCAL_YEAR_RESTORED", entity: "FiscalYear", entityId: fy._id,
      summary: `Fiscal year ${fy.code}: ${total} missing record(s) restored from the archive sealed ${archive.seal.sha256.slice(0, 16)}`,
      after: { restored, seal: archive.seal.sha256 },
    });
    return { restored, total, ...YearArchiveService.summary(archive, await YearArchiveService.diff(req, archive, fy)) };
  }
}

module.exports = YearArchiveService;
