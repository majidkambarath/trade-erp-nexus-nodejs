const TaxCode = require("../../models/modules/financial/taxCodeModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

// The rate in force on `date`: the latest history entry dated on or before it, else the base rate.
function rateOn(taxCode, date) {
  const d = new Date(date || Date.now());
  const applicable = (taxCode.rateHistory || [])
    .filter((h) => new Date(h.date) <= d)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  return applicable ? applicable.ratePercent : taxCode.ratePercent;
}

const STARTER = [
  { name: "Standard 5%", kind: "standard", ratePercent: 5, isDefault: true },
  { name: "Zero-rated", kind: "zero_rated", ratePercent: 0 },
  { name: "Exempt", kind: "exempt", ratePercent: 0 },
  { name: "Out of scope", kind: "out_of_scope", ratePercent: 0 },
  // Bought under the reverse charge (services from abroad, some local supplies): the supplier charges no VAT and the buyer assesses
  // it at 5% and, if recoverable, claims it back in the same return (priced and posted by utils/pricing.js and postingTemplates.js).
  { name: "Reverse charge 5%", kind: "reverse_charge", ratePercent: 5 },
];

class TaxCodeService {
  static rateOn = rateOn;

  static async list(req) {
    const { companyId } = getTenant(req);
    return TaxCode.find({ companyId }).sort({ isDefault: -1, name: 1 }).lean();
  }

  static async create(data, req) {
    const { companyId } = getTenant(req);
    if (data.isDefault) await TaxCode.updateMany({ companyId }, { isDefault: false });
    // only what the form is for: a body that names an id, a creation date or anything else of the system's is not taken
    const fields = Object.fromEntries(["name", "kind", "ratePercent", "rateHistory", "isDefault", "isActive"].filter((k) => data?.[k] !== undefined).map((k) => [k, data[k]]));
    return TaxCode.create({ ...fields, companyId });
  }

  static async update(id, data, req) {
    const { companyId } = getTenant(req);
    const code = await TaxCode.findOne({ _id: id, companyId });
    if (!code) throw new AppError("Tax code not found", 404);
    if (data.isDefault) await TaxCode.updateMany({ companyId, _id: { $ne: id } }, { isDefault: false });
    for (const k of ["name", "kind", "ratePercent", "rateHistory", "isDefault", "isActive"]) {
      if (data[k] !== undefined) code[k] = data[k];
    }
    return code.save();
  }

  // A company with no tax codes gets the whole starter set. A company that already has codes keeps them exactly as they are and
  // is given only a starter KIND it has none of (the reverse-charge code arrived after the others, so an older company is
  // topped up with it once). Matched by kind, not name: a company that made its own reverse-charge code does not get a second;
  // and a name already in use is skipped (names are unique within a company). Returns how many were added.
  static async ensureStarter(companyId) {
    const existing = await TaxCode.find({ companyId }).select("name kind").lean();
    if (!existing.length) {
      await TaxCode.insertMany(STARTER.map((s) => ({ ...s, companyId })));
      return STARTER.length;
    }
    const kinds = new Set(existing.map((c) => c.kind));
    const names = new Set(existing.map((c) => c.name));
    const missing = STARTER.filter((s) => s.kind === "reverse_charge" && !kinds.has(s.kind) && !names.has(s.name));
    if (!missing.length) return 0;
    try {
      await TaxCode.insertMany(missing.map((s) => ({ ...s, companyId })));
    } catch (err) {
      if (err?.code === 11000) return 0; // another request added it first
      throw err;
    }
    return missing.length;
  }

  // Lines that name a tax code get their VAT % from it (as in force on the document date) and
  // keep a snapshot of the kind, so a later change to the code never restates a posted document.
  // Lines without one keep the vatPercent they sent.
  static async applyToItems(items, date, { session, companyId } = {}) {
    const company = companyId || getTenant().companyId;
    const ids = [...new Set(items.map((i) => i.taxCodeId).filter(Boolean).map(String))];
    if (!ids.length) return items;
    const q = TaxCode.find({ companyId: company, _id: { $in: ids } }).lean();
    const codes = new Map((await (session ? q.session(session) : q)).map((c) => [String(c._id), c]));
    return items.map((item) => {
      if (!item.taxCodeId) return item;
      const code = codes.get(String(item.taxCodeId));
      if (!code || !code.isActive) {
        throw new AppError(`Tax code not found or inactive for "${item.description || item.itemId}"`, 400, "INVALID_TAX_CODE");
      }
      return { ...item, vatPercent: rateOn(code, date), taxKind: code.kind };
    });
  }
}

module.exports = TaxCodeService;
