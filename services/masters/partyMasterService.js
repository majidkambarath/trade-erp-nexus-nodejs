const orgLocale = require("../../utils/orgLocale");
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const logger = require("../../utils/logger");
const { getTenant } = require("../../utils/tenant");
const { BankMaster } = require("../../models/modules/banking/bankingModels");
const AttachmentService = require("../core/attachmentService");
const DocumentTypeService = require("./documentTypeService");
const { resolveVat, resolveTerms, cleanWebsite, normalizeContacts, normalizeBankAccounts, normalizeDocuments } = require("../../utils/partyMaster");
const { orgTaxTerms } = require("../../utils/countryRules");
const { resolveAddress } = require("../../utils/partyAddress");
const { stateCodeOfGstin } = require("../../utils/gstStates");

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
    if (dup) throw new AppError(`${orgTaxTerms().taxId} already in use by another ${k.noun}`, 400, "DUPLICATE_TRN");
  }

  // A customer's (vendor's) ledger accounts are found by NAME ("Customer - <name>", partyAccounts.js) in the
  // statement, credit control, ageing, the party balances and the IFRS notes, so two customers with one name would
  // post to, and be read from, ONE account. The name is therefore unique within a kind: compared without regard to
  // case or surrounding spaces, since "Al Noor" and "AL NOOR " are the same company to whoever reads the books.
  static async assertUniqueName(kind, name, excludeId) {
    const k = kindOf(kind);
    const text = String(name ?? "").trim();
    if (!text) return;
    const Model = mongoose.model(k.model);
    const exact = new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    const dup = await Model.findOne({ [k.nameField]: exact, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
      .select("_id")
      .lean();
    if (dup) {
      throw new AppError(
        `There is already a ${k.noun} called "${text}". Use a name that tells them apart (for example add the branch or the city).`,
        409,
        "DUPLICATE_PARTY_NAME"
      );
    }
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

    // only when the request names one: a contacts-only update (crm/contactService) says nothing about the name
    if (data[k.nameField] !== undefined) {
      const name = String(data[k.nameField] ?? "").trim();
      if (!existing || name.toLowerCase() !== String(existing[k.nameField] ?? "").trim().toLowerCase()) {
        await this.assertUniqueName(kind, name, existing?._id);
      }
    }

    if (!existing || data.vat !== undefined || data[k.legacyTrn] !== undefined) {
      const stored = existing
        ? { status: existing.vat?.status, trn: existing.vat?.trn || existing[k.legacyTrn] || null, tradeLicenseNo: existing.vat?.tradeLicenseNo }
        : undefined;
      const vat = resolveVat({ input: data.vat, legacyTrn: data[k.legacyTrn], existing: stored, country: orgLocale.country() }); // TRN, GSTIN, ... by the organisation's country
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

    // the address's country and emirate: only when the request names one, so a record that never had them is not given any
    const address = resolveAddress({ country: data.country, emirate: data.emirate, stateCode: data.stateCode }, existing);
    if (address) Object.assign(patch, address);
    // an Indian party with no state typed takes the one in its GSTIN (the first two digits), so place of supply works without a second entry
    if ((patch.country || existing?.country) === "IN" && !(patch.stateCode ?? existing?.stateCode)) {
      const derived = stateCodeOfGstin(patch.vat?.trn || patch[k.legacyTrn] || existing?.vat?.trn || existing?.[k.legacyTrn]);
      if (derived) patch.stateCode = derived;
    }

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

  // After the party is saved: keep the CRM's own Contact records in step with the party's contact list, then claim
  // the files its document rows name and drop the ones no row names.
  //
  // This is the one place every party write passes through (create and update, customer and vendor), which is why the
  // contact mirror hangs here rather than in four services. services/crm/contactService.js owns the rule; it is
  // required lazily because it requires this file back.
  static async finish(kind, party, patch, req) {
    if (patch?.contacts !== undefined && party?._id) {
      try {
        await require("../crm/contactService").syncFromParty(party, kind);
      } catch (error) {
        // The party is already saved and this is outside its transaction, so a failed mirror must never report an
        // error for a save that worked. The next read of that party's people heals it (ContactService.forParty).
        logger.debug(`[crm] contact mirror for ${kind} ${party._id} did not run: ${error.message}`);
      }
    }
    if (!patch || patch.documents === undefined) return;
    await AttachmentService.syncPartyFiles(kindOf(kind).ownerType, party._id, patch.documents, req);
  }

  // Wipes the files of a party that is being deleted.
  static async discardFiles(kind, partyId, req) {
    await AttachmentService.syncPartyFiles(kindOf(kind).ownerType, partyId, [], req);
  }
}

module.exports = PartyMasterService;
