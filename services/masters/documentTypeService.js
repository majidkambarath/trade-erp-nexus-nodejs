const mongoose = require("mongoose");
const DocumentType = require("../../models/modules/documentTypeModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// What every company starts with. Created the first time the list is read; never overwritten, so a
// company can change a limit or switch one off and it stays that way.
const DEFAULTS = [
  { name: "Trade licence", code: "TL", requiresExpiry: true, minLength: 3, maxLength: 30 },
  { name: "VAT certificate", code: "VAT", requiresExpiry: false, minLength: 15, maxLength: 15 },
  { name: "Emirates ID", code: "EID", requiresExpiry: true, minLength: 15, maxLength: 18 },
  { name: "Passport", code: "PASS", requiresExpiry: true, minLength: 6, maxLength: 15 },
  { name: "Bank letter", code: "BANK", requiresExpiry: false, minLength: null, maxLength: null },
  { name: "Other", code: "OTHER", requiresExpiry: false, minLength: null, maxLength: null },
];

const FIELDS = ["name", "code", "requiresExpiry", "minLength", "maxLength", "isActive"];

function cleanLimit(v, label) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 60) throw new AppError(`${label} must be a whole number from 0 to 60`, 400, "INVALID_LENGTH");
  return n || null; // 0 means no limit
}

// Turns a name into a code when none is given: letters and digits, upper case, at most 12.
const codeFromName = (name) => String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 12) || "DOC";

class DocumentTypeService {
  static async ensureDefaults(req) {
    const { companyId, branchId } = getTenant(req);
    if ((await DocumentType.countDocuments({ companyId, isSystem: true })) >= DEFAULTS.length) return 0;
    let made = 0;
    for (const d of DEFAULTS) {
      const r = await DocumentType.updateOne(
        { companyId, code: d.code },
        { $setOnInsert: { ...d, companyId, branchId, isActive: true, isSystem: true } },
        { upsert: true }
      ).catch((err) => { if (err.code !== 11000) throw err; return { upsertedCount: 0 }; }); // a parallel first call got there first
      made += r.upsertedCount || 0;
    }
    return made;
  }

  static async list(req, { active, q } = {}) {
    const { companyId } = getTenant(req);
    await this.ensureDefaults(req);
    const filter = { companyId };
    if (active === true || active === "true") filter.isActive = true;
    if (q) filter.name = new RegExp(escapeRe(q), "i");
    return DocumentType.find(filter).sort({ name: 1 }).lean();
  }

  static async get(id, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(id)) throw new AppError("Invalid document type id", 400);
    const doc = await DocumentType.findOne({ _id: id, companyId }).lean();
    if (!doc) throw new AppError("Document type not found", 404, "DOCUMENT_TYPE_NOT_FOUND");
    return doc;
  }

  // Map(String id -> type) for the ids named by a party's document rows.
  static async mapByIds(ids, req) {
    const { companyId } = getTenant(req);
    const wanted = [...new Set(ids.filter(Boolean).map(String))];
    const bad = wanted.find((id) => !mongoose.isValidObjectId(id));
    if (bad) throw new AppError("That document type does not exist", 404, "DOCUMENT_TYPE_NOT_FOUND");
    const rows = wanted.length ? await DocumentType.find({ companyId, _id: { $in: wanted } }).lean() : [];
    return new Map(rows.map((r) => [String(r._id), r]));
  }

  static validate(patch) {
    if (patch.name !== undefined) {
      patch.name = String(patch.name).trim();
      if (!patch.name) throw new AppError("Document type name is required", 400, "NAME_REQUIRED");
    }
    if (patch.code !== undefined) {
      patch.code = String(patch.code).trim().toUpperCase();
      if (!/^[A-Z0-9_]{1,12}$/.test(patch.code)) throw new AppError("Code is 1 to 12 letters, digits or underscores", 400, "INVALID_CODE");
    }
    if (patch.minLength !== undefined) patch.minLength = cleanLimit(patch.minLength, "Minimum length");
    if (patch.maxLength !== undefined) patch.maxLength = cleanLimit(patch.maxLength, "Maximum length");
    return patch;
  }

  static assertLimits({ minLength, maxLength }) {
    if (minLength && maxLength && minLength > maxLength) {
      throw new AppError("Minimum length cannot be more than the maximum length", 400, "INVALID_LENGTH");
    }
  }

  static async create(data, req) {
    const { companyId, branchId } = getTenant(req);
    await this.ensureDefaults(req);
    const patch = this.validate(Object.fromEntries(FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])));
    if (!patch.name) throw new AppError("Document type name is required", 400, "NAME_REQUIRED");
    patch.code = patch.code || codeFromName(patch.name);
    this.assertLimits(patch);
    try {
      return (await DocumentType.create({ ...patch, companyId, branchId, isSystem: false })).toObject();
    } catch (err) {
      if (err.code === 11000) throw new AppError("A document type with that name or code already exists", 409, "DUPLICATE_DOCUMENT_TYPE");
      throw err;
    }
  }

  static async update(id, data, req) {
    const { companyId } = getTenant(req);
    const doc = await DocumentType.findOne({ _id: id, companyId });
    if (!doc) throw new AppError("Document type not found", 404, "DOCUMENT_TYPE_NOT_FOUND");
    const patch = this.validate(Object.fromEntries(FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]])));
    if (doc.isSystem && patch.code !== undefined && patch.code !== doc.code) {
      throw new AppError("The code of a default document type cannot change", 409, "CODE_LOCKED");
    }
    this.assertLimits({ minLength: patch.minLength !== undefined ? patch.minLength : doc.minLength, maxLength: patch.maxLength !== undefined ? patch.maxLength : doc.maxLength });
    Object.assign(doc, patch);
    try {
      await doc.save();
    } catch (err) {
      if (err.code === 11000) throw new AppError("A document type with that name or code already exists", 409, "DUPLICATE_DOCUMENT_TYPE");
      throw err;
    }
    return doc.toObject();
  }

  static async usage(id) {
    const Customer = mongoose.model("Customer");
    const Vendor = mongoose.model("Vendor");
    const [c, v] = await Promise.all([Customer.countDocuments({ "documents.documentTypeId": id }), Vendor.countDocuments({ "documents.documentTypeId": id })]);
    return { customers: c, vendors: v };
  }

  // A type in use by any party's document cannot be deleted (switch it off instead); neither can a default.
  static async remove(id, req) {
    const { companyId } = getTenant(req);
    const doc = await DocumentType.findOne({ _id: id, companyId });
    if (!doc) throw new AppError("Document type not found", 404, "DOCUMENT_TYPE_NOT_FOUND");
    if (doc.isSystem) throw new AppError("A default document type cannot be deleted. Switch it off instead.", 409, "DOCUMENT_TYPE_IS_DEFAULT");
    const used = await this.usage(doc._id);
    if (used.customers || used.vendors) {
      throw new AppError(
        `This type is used by ${used.customers} customer(s) and ${used.vendors} vendor(s). Switch it off instead of deleting it.`,
        409,
        "DOCUMENT_TYPE_IN_USE"
      );
    }
    await doc.deleteOne();
  }
}

module.exports = DocumentTypeService;
module.exports.DEFAULTS = DEFAULTS;
