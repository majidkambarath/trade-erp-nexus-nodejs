// Putting a deleted master back from DeletedRecord (utils/auditPlugin.js keeps each one whole when it is deleted).
//
// The record comes back with its own id, so whatever still names it (an old document line, an audit row) finds it
// again. The DeletedRecord row stays as it was: it is append-only, and the restore is logged as <ENTITY>_RESTORED.
// What may come back, and who may do it, is utils/restorable.js.
const path = require("path");
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const { assertPermission } = require("../../middleware/permissionGate");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { restorableOf, whyNot } = require("../../utils/restorable");

const ROOT = path.join(__dirname, "..", "..");
const modelOf = (rule) => {
  const m = require(path.join(ROOT, rule.model));
  return rule.exportName ? m[rule.exportName] : m;
};

// a party's id number back from the released list, and its ledger accounts switched on again
async function afterParty(entity, doc, session) {
  const Sequence = require("../../models/modules/sequenceModel");
  const LedgerAccount = require("../../models/modules/financial/financialModels").LedgerAccount;
  const PartyAccounts = require("../financial/partyAccounts");
  const isVendor = entity === "Vendor";
  const code = String(isVendor ? doc.vendorId : doc.customerId || "");
  const year = code.slice(4, 8);
  const n = parseInt(code.slice(8), 10);
  if (/^\d{4}$/.test(year) && Number.isInteger(n)) {
    await Sequence.updateOne(
      { year, type: isVendor ? "vendor" : "customer" },
      { $pull: { deletedNumbers: n }, $addToSet: { usedNumbers: n } },
      { session }
    );
  }
  const name = isVendor ? doc.vendorName : doc.customerName;
  if (!name) return;
  const kinds = isVendor ? ["vendor", "vendorAdvance"] : ["customer", "customerAdvance"];
  for (const kind of kinds) {
    const k = PartyAccounts.KINDS[kind];
    await LedgerAccount.updateOne({ accountName: `${k.prefix}${name}`, accountType: k.type, isActive: false }, { isActive: true }, { session });
  }
  await PartyAccounts.ensurePartyAccount(kinds[0], doc._id, name, { session });
}

const AFTER = { Customer: afterParty, Vendor: afterParty };

const fieldOf = (err) => Object.keys(err.keyPattern || err.keyValue || {}).filter((k) => k !== "companyId")[0] || null;

const restoreIn = withTransactionSession(async (req, id, session) => {
  const DeletedRecord = require("../../models/modules/deletedRecordModel");
  if (typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id)) throw new AppError("Deleted record not found", 404, "DELETED_RECORD_NOT_FOUND");
  const kept = await DeletedRecord.findById(id).session(session).lean();
  if (!kept) throw new AppError("Deleted record not found", 404, "DELETED_RECORD_NOT_FOUND");
  const rule = restorableOf(kept.entity);
  if (!rule) throw new AppError(whyNot(kept.entity), 409, "NOT_RESTORABLE");
  assertPermission(req, rule.permission, `Putting back a ${rule.label.toLowerCase()} needs the permission that adds one`);
  const Model = modelOf(rule);
  const data = kept.data || {};
  if (!data._id) throw new AppError("This deleted record has no id to restore", 409, "NOT_RESTORABLE");
  if (await Model.exists({ _id: data._id }).session(session)) {
    throw new AppError(`This ${rule.label.toLowerCase()} is already back`, 409, "ALREADY_RESTORED");
  }
  const doc = new Model(data);
  doc.$locals.auditAction = "RESTORED";
  try {
    await doc.save({ session });
  } catch (err) {
    if (err && err.code === 11000) {
      const field = fieldOf(err);
      throw new AppError(
        `Another ${rule.label.toLowerCase()} now has the same ${field || "name or code"}: rename or remove it first`,
        409, "RESTORE_CONFLICT", field ? { fields: [field] } : undefined
      );
    }
    throw err;
  }
  if (AFTER[kept.entity]) await AFTER[kept.entity](kept.entity, doc, session);
  return { entity: kept.entity, entityId: String(doc._id), label: kept.label || "", restored: true };
});

class RestoreService {
  static restore(req, id) {
    return restoreIn(req, id);
  }

  // which of these deleted rows can come back, and which are back already (one read per kind of record on the page)
  static async annotate(rows) {
    const ids = new Map();
    for (const r of rows) {
      if (!restorableOf(r.entity) || !r.data?._id) continue;
      if (!ids.has(r.entity)) ids.set(r.entity, []);
      ids.get(r.entity).push(r.data._id);
    }
    const back = new Set();
    for (const [entity, list] of ids) {
      const found = await modelOf(restorableOf(entity)).find({ _id: { $in: list } }).select("_id").lean();
      for (const f of found) back.add(`${entity}:${f._id}`);
    }
    return rows.map((r) => {
      const rule = restorableOf(r.entity);
      return {
        ...r,
        restorable: Boolean(rule),
        restorePermission: rule ? rule.permission : null,
        restored: Boolean(rule && r.data?._id && back.has(`${r.entity}:${r.data._id}`)),
        ...(rule ? {} : { notRestorable: whyNot(r.entity) }),
      };
    });
  }
}

module.exports = RestoreService;
