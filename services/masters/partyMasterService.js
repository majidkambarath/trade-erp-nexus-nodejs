const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { BankMaster } = require("../../models/modules/banking/bankingModels");
const AttachmentService = require("../core/attachmentService");
const DocumentTypeService = require("./documentTypeService");
const { resolveVat, resolveTerms, cleanWebsite, normalizeContacts, normalizeBankAccounts, normalizeDocuments } = require("../../utils/partyMaster");

// The customer / vendor master data: VAT configuration, credit terms, contacts, bank accounts and
// KYC documents. customerService and vendorService call `prepare` before they write and `finish`
// after, so both kinds share one set of rules (utils/partyMaster.js holds the pure part).
const KINDS = {
  customer: { model: "Customer", legacyTrn: "trnNumber", ownerType: "customer", nameField: "customerName", noun: "customer" },
  vendor: { model: "Vendor", legacyTrn: "trnNO", ownerType: "vendor", nameField: "vendorName", noun: "vendor" },
};
const kindOf = (kind) => {
  const k = KINDS[kind];
  if (!k) throw new AppError(`Unknown party kind ${kind}`, 500);
  return k;
};
const blank = (v) => !String(v ?? "").trim();

class PartyMasterService {
  static async assertUniqueTrn(kind, trn, excludeId) {
    const k = kindOf(kind);
    const Model = mongoose.model(k.model);
    const dup = await Model.findOne({ $or: [{ [k.legacyTrn]: trn }, { "vat.trn": trn }], ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
      .select("_id")
      .lean();
    if (dup) throw new AppError(`TRN already in use by another ${k.noun}`, 400, "DUPLICATE_TRN");
  }

  // Bank rows that name a bank from the bank master get the bank's name from it.
  static async resolveBanks(rows, req) {
    const { companyId } = getTenant(req);
    const ids = [...new Set(rows.map((r) => r.bankId).filter(Boolean).map(String))];
    if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new AppError("Choose a bank from the bank master", 400, "BANK_NOT_FOUND");
    const banks = ids.length ? await BankMaster.find({ companyId, _id: { $in: ids } }).select("bankName").lean() : [];
    const byId = new Map(banks.map((b) => [String(b._id), b]));
    return rows.map((r) => {
      if (!r.bankId) return r;
      const bank = byId.get(String(r.bankId));
      if (!bank) throw new AppError("Choose a bank from the bank master", 400, "BANK_NOT_FOUND");
      return { ...r, bankName: bank.bankName };
    });
  }

  // Everything the request changes in the master data, checked and cleaned, ready to merge into
  // the party being created (existing undefined) or updated (existing = its stored record, lean).
  // Returns a patch; the legacy fields (trnNumber / trnNO, paymentTerms, and contactPerson / email /
  // phone when blank) are kept in step with the new blocks.
  static async prepare(kind, data = {}, { existing, req } = {}) {
    const k = kindOf(kind);
    const patch = {};

    if (!existing || data.vat !== undefined || data[k.legacyTrn] !== undefined) {
      const stored = existing
        ? { status: existing.vat?.status, trn: existing.vat?.trn || existing[k.legacyTrn] || null, tradeLicenseNo: existing.vat?.tradeLicenseNo }
        : undefined;
      const vat = resolveVat({ input: data.vat, legacyTrn: data[k.legacyTrn], existing: stored });
      if (vat.trn && vat.trn !== (stored?.trn || null)) await this.assertUniqueTrn(kind, vat.trn, existing?._id);
      patch.vat = vat;
      patch[k.legacyTrn] = vat.trn;
    }

    if (!existing || data.paymentTerms !== undefined || data.credit !== undefined) {
      const terms = resolveTerms({ kind, paymentTerms: data.paymentTerms, creditDays: data.credit?.days, existing });
      patch.paymentTerms = terms.paymentTerms;
      patch.credit = { days: terms.days };
    }

    if (data.website !== undefined) patch.website = cleanWebsite(data.website);

    if (data.contacts !== undefined) {
      patch.contacts = normalizeContacts(data.contacts);
      const primary = patch.contacts.find((c) => c.isPrimary);
      if (primary) {
        // the flat contact fields of the party follow its primary contact when they were left blank
        const fill = (field, value) => {
          const sent = data[field] !== undefined ? data[field] : existing?.[field];
          if (blank(sent) && value) patch[field] = value;
        };
        fill("contactPerson", primary.name);
        fill("email", primary.email);
        fill("phone", primary.phone);
      }
    }

    if (data.bankAccounts !== undefined) {
      patch.bankAccounts = await this.resolveBanks(normalizeBankAccounts(data.bankAccounts), req);
    }

    if (data.documents !== undefined) {
      const rows = Array.isArray(data.documents) ? data.documents : [];
      const types = await DocumentTypeService.mapByIds(rows.map((d) => d?.documentTypeId), req);
      const had = new Set((existing?.documents || []).map((d) => String(d.documentTypeId)));
      for (const t of types.values()) {
        if (t.isActive === false && !had.has(String(t._id))) {
          throw new AppError(`${t.name} is switched off. Choose another document type.`, 400, "DOCUMENT_TYPE_INACTIVE");
        }
      }
      patch.documents = normalizeDocuments(data.documents, types);
      await AttachmentService.assertPartyFiles(k.ownerType, existing?._id || null, patch.documents, req);
    }
    return patch;
  }

  // After the party is saved: claim the files its document rows name, drop the ones no row names.
  static async finish(kind, party, patch, req) {
    if (!patch || patch.documents === undefined) return;
    await AttachmentService.syncPartyFiles(kindOf(kind).ownerType, party._id, patch.documents, req);
  }

  // Wipes the files of a party that is being deleted.
  static async discardFiles(kind, partyId, req) {
    await AttachmentService.syncPartyFiles(kindOf(kind).ownerType, partyId, [], req);
  }
}

module.exports = PartyMasterService;
