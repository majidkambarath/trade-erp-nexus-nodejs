const mongoose = require("mongoose");
const CostCentre = require("../../models/modules/financial/costCentreModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

// Cost centres: the master, and the one check every document path uses before it stores a centre.
// A document names a centre on its header and may override it per line (Transaction.items[].costCentreId,
// voucher lines); every ledger row carries the one that applies (LedgerEntry.costCentreId). Absent = none.

const FIELDS = ["code", "name", "parentId", "notes", "isActive"];

const idOf = (v) => (v && typeof v === "object" && v._id ? v._id : v);
const given = (v) => v !== undefined && v !== null && v !== "";

class CostCentreService {
  static async list(req, { active } = {}) {
    const { companyId } = getTenant(req);
    const filter = { companyId };
    if (active === true || active === "true") filter.isActive = true;
    return CostCentre.find(filter).sort({ code: 1 }).lean();
  }

  static validate(patch) {
    if (patch.code !== undefined) {
      patch.code = String(patch.code).trim().toUpperCase();
      if (!/^[A-Z0-9_-]{1,12}$/.test(patch.code)) throw new AppError("Code is 1 to 12 letters, digits, - or _", 400, "INVALID_CODE");
    }
    if (patch.name !== undefined) {
      patch.name = String(patch.name).trim();
      if (!patch.name) throw new AppError("Cost centre name is required", 400, "NAME_REQUIRED");
      if (patch.name.length > 100) throw new AppError("Name is at most 100 characters", 400, "NAME_TOO_LONG");
    }
    if (patch.parentId !== undefined) {
      if (!given(patch.parentId)) patch.parentId = null;
      else if (!mongoose.isValidObjectId(patch.parentId)) throw new AppError("That group does not exist", 400, "INVALID_PARENT");
    }
    if (patch.notes !== undefined) patch.notes = String(patch.notes ?? "").slice(0, 500);
    if (patch.isActive !== undefined) patch.isActive = patch.isActive === true || patch.isActive === "true";
    return patch;
  }

  static pick(data) {
    return this.validate(Object.fromEntries(FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])));
  }

  // A group is a centre with no parent of its own: one level only, and never itself.
  static async assertParent(parentId, selfId, companyId) {
    if (!parentId) return;
    if (selfId && String(parentId) === String(selfId)) throw new AppError("A cost centre cannot be its own group", 400, "INVALID_PARENT");
    const parent = await CostCentre.findOne({ _id: parentId, companyId }).lean();
    if (!parent) throw new AppError("That group does not exist", 400, "INVALID_PARENT");
    if (parent.parentId) throw new AppError("A group cannot itself be inside another group", 400, "INVALID_PARENT");
    if (selfId && (await CostCentre.countDocuments({ companyId, parentId: selfId }))) {
      throw new AppError("This cost centre is a group for others, so it cannot be put inside a group", 400, "INVALID_PARENT");
    }
  }

  static async create(data, req) {
    const { companyId, branchId } = getTenant(req);
    const patch = this.pick(data);
    if (!patch.code) throw new AppError("Code is required", 400, "INVALID_CODE");
    if (!patch.name) throw new AppError("Cost centre name is required", 400, "NAME_REQUIRED");
    await this.assertParent(patch.parentId, null, companyId);
    try {
      return (await CostCentre.create({ ...patch, companyId, branchId, createdBy: req?.admin?.id })).toObject();
    } catch (err) {
      if (err.code === 11000) throw new AppError("A cost centre with that code or name already exists", 409, "COST_CENTRE_EXISTS");
      throw err;
    }
  }

  static async update(id, data, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(id)) throw new AppError("Cost centre not found", 404, "COST_CENTRE_NOT_FOUND");
    const doc = await CostCentre.findOne({ _id: id, companyId });
    if (!doc) throw new AppError("Cost centre not found", 404, "COST_CENTRE_NOT_FOUND");
    const patch = this.pick(data);
    if (patch.parentId !== undefined) await this.assertParent(patch.parentId, doc._id, companyId);
    Object.assign(doc, patch);
    try {
      await doc.save();
    } catch (err) {
      if (err.code === 11000) throw new AppError("A cost centre with that code or name already exists", 409, "COST_CENTRE_EXISTS");
      throw err;
    }
    return doc.toObject();
  }

  static async usage(id) {
    const LedgerEntry = mongoose.model("LedgerEntry");
    const Transaction = mongoose.model("Transaction");
    const Voucher = mongoose.model("Voucher");
    const oid = new mongoose.Types.ObjectId(String(id));
    const [entries, documents, vouchers, children] = await Promise.all([
      LedgerEntry.countDocuments({ costCentreId: oid }),
      Transaction.countDocuments({ $or: [{ costCentreId: oid }, { "items.costCentreId": oid }] }),
      Voucher.countDocuments({ $or: [{ costCentreId: oid }, { "entries.costCentreId": oid }, { "noteLines.costCentreId": oid }] }),
      CostCentre.countDocuments({ parentId: oid }),
    ]);
    return { entries, documents, vouchers, children };
  }

  // A centre anything has been posted to or written on cannot be deleted: switch it off instead.
  static async remove(id, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(id)) throw new AppError("Cost centre not found", 404, "COST_CENTRE_NOT_FOUND");
    const doc = await CostCentre.findOne({ _id: id, companyId });
    if (!doc) throw new AppError("Cost centre not found", 404, "COST_CENTRE_NOT_FOUND");
    const used = await this.usage(doc._id);
    if (used.entries || used.documents || used.vouchers || used.children) {
      throw new AppError("This cost centre is in use, so it cannot be deleted. Switch it off instead.", 409, "COST_CENTRE_IN_USE", { usage: used });
    }
    await CostCentre.deleteOne({ _id: doc._id, companyId });
    return doc.toObject();
  }

  /**
   * The centres a document names (header and lines), checked to exist in this organisation and be switched on. A centre
   * the document ALREADY carried (an edit that keeps it) is accepted even if it has since been switched off.
   * Returns the ids as ObjectIds; throws 400 INVALID_COST_CENTRE otherwise.
   */
  static async assertUsable(ids, { keep = [] } = {}, session = null) {
    const wanted = [...new Set((ids || []).map(idOf).filter(given).map(String))];
    if (!wanted.length) return [];
    if (wanted.some((id) => !mongoose.isValidObjectId(id))) throw new AppError("That cost centre does not exist", 400, "INVALID_COST_CENTRE");
    const kept = new Set((keep || []).map(idOf).filter(given).map(String));
    const q = CostCentre.find({ _id: { $in: wanted } }).select("isActive name");
    if (session) q.session(session);
    const rows = await q.lean();
    const by = new Map(rows.map((r) => [String(r._id), r]));
    for (const id of wanted) {
      const c = by.get(id);
      if (!c) throw new AppError("That cost centre does not exist", 400, "INVALID_COST_CENTRE");
      if (c.isActive === false && !kept.has(id)) throw new AppError(`Cost centre ${c.name} is switched off`, 400, "INVALID_COST_CENTRE");
    }
    return wanted.map((id) => new mongoose.Types.ObjectId(id));
  }
}

module.exports = CostCentreService;
