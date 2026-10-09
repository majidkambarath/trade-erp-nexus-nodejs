// The company's letterhead: the name, address, contacts, logo and bank details every printed and emailed document carries.
//
// It is the ORGANISATION's, kept once on CompanySettings.profile. It used to live on each person's own record
// (Admin.companyInfo), so every person had their own company name, logo and bank details, a new organisation's Settings
// opened empty, and a document read the letterhead of whoever happened to print it. The first read of an organisation
// adopts the old copy, once (`letterheadAdoptedAt`): the earliest-created active person who had one, filling only what the
// organisation's profile has not already got (the company name is the exception: what documents have been printing wins).
//
// The tax registration number is not edited here: it is entered once under Settings -> Business rules -> Tax identity
// (`profile.trn`), and is only READ here as `vatNumber`, so it cannot differ between the letterhead and the VAT return.
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const Admin = require("../../models/core/adminModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const orgLocale = require("../../utils/orgLocale");
const { normalizeIban, isValidIban } = require("../../utils/iban");
const { deleteFromCloudinary } = require("../../middleware/upload");

const clean = (value) => String(value ?? "").trim();
const bad = (message, code) => new AppError(message, 400, code);

// What the letterhead may hold, and how long each part may be (the same limits the old per-person form had).
const LIMITS = { companyName: 100, companyNameArabic: 100, addressLine1: 100, addressLine2: 100, city: 50, state: 50, country: 50, postalCode: 20, website: 200 };
const BANK_LIMITS = { bankName: 100, accountName: 100, accountNumber: 50, currency: 10, branch: 100 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[0-9+()\-.\s]{5,25}$/;
const WEBSITE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;

// The profile on its way out, in the shape the screens already read (the old `companyInfo`, flat).
function toApi(profile = {}, baseCurrency = orgLocale.baseCurrency()) {
  const p = profile || {};
  const bank = p.bank || {};
  return {
    companyName: clean(p.legalName),
    companyNameArabic: clean(p.legalNameArabic),
    addressLine1: clean(p.addressLine1),
    addressLine2: clean(p.addressLine2),
    city: clean(p.city),
    state: clean(p.emirate),
    country: clean(p.country),
    postalCode: clean(p.postalCode),
    phoneNumber: clean(p.phone),
    emailAddress: clean(p.email),
    website: clean(p.website),
    vatNumber: clean(p.trn),
    companyLogo: p.logo?.url ? { url: p.logo.url } : null,
    bankDetails: {
      bankName: clean(bank.bankName), accountName: clean(bank.accountName), accountNumber: clean(bank.accountNumber),
      ibanNumber: clean(bank.ibanNumber), swiftCode: clean(bank.swiftCode), currency: clean(bank.currency) || baseCurrency,
    },
    branch: clean(bank.branch),
  };
}

const hasLetterhead = (ci) => Boolean(ci && (clean(ci.companyName) || clean(ci.addressLine1) || clean(ci.phoneNumber) || clean(ci.emailAddress) || ci.companyLogo?.url || clean(ci.bankDetails?.bankName)));

class CompanyProfileService {
  static async row() {
    const { companyId } = getTenant();
    return CompanySettings.findOneAndUpdate({ companyId }, { $setOnInsert: { companyId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  }

  /** Adopt the old per-person letterhead, once. Safe to call on every read: after the first it does nothing. */
  static async adopt(row) {
    const { companyId } = getTenant();
    if (row?.profile?.letterheadAdoptedAt) return row;
    const donors = await Admin.find({ isActive: true }).sort({ createdAt: 1 }).select("companyInfo").lean();
    const donor = donors.find((a) => hasLetterhead(a.companyInfo));
    const $set = { "profile.letterheadAdoptedAt": new Date() };
    if (donor) {
      const c = donor.companyInfo;
      const have = row?.profile || {};
      const fill = (path, value) => {
        const [head, tail] = path.split(".");
        const current = tail ? have[head]?.[tail] : have[head];
        if (clean(value) && !clean(current)) $set[`profile.${path}`] = clean(value);
      };
      if (clean(c.companyName)) $set["profile.legalName"] = clean(c.companyName); // what documents have been printing wins
      fill("legalNameArabic", c.companyNameArabic);
      fill("addressLine1", c.addressLine1); fill("addressLine2", c.addressLine2); fill("city", c.city); fill("emirate", c.state);
      fill("country", c.country); fill("postalCode", c.postalCode); fill("phone", c.phoneNumber); fill("email", c.emailAddress);
      fill("website", c.website); fill("trn", c.vatNumber);
      if (c.companyLogo?.url && !clean(have.logo?.url)) { $set["profile.logo.url"] = c.companyLogo.url; if (c.companyLogo.publicId) $set["profile.logo.publicId"] = c.companyLogo.publicId; }
      const b = c.bankDetails || {};
      for (const k of ["bankName", "accountName", "accountNumber", "ibanNumber", "swiftCode", "currency"]) fill(`bank.${k}`, b[k]);
      fill("bank.branch", c.branch);
    }
    // only the first adopter writes: a second request at the same moment finds it already set and changes nothing
    await CompanySettings.updateOne({ companyId, "profile.letterheadAdoptedAt": null }, { $set });
    return CompanySettings.findOne({ companyId }).lean();
  }

  static async get() {
    const row = await this.adopt(await this.row());
    return toApi(row.profile, row.baseCurrency || orgLocale.baseCurrency());
  }

  /**
   * Change the letterhead. `patch` is the old `companyInfo` shape; only what it names changes. `logo` is an uploaded file
   * ({ path, filename }) or null. -> the letterhead as it now stands.
   */
  static async update(patch = {}, { logo = null } = {}) {
    const { companyId } = getTenant();
    const row = await this.adopt(await this.row());
    const $set = {};
    const put = (key, path, max, label) => {
      if (patch[key] === undefined) return;
      const v = clean(patch[key]);
      if (v.length > max) throw bad(`${label} cannot exceed ${max} characters`, "FIELD_TOO_LONG");
      $set[`profile.${path}`] = v;
    };
    put("companyName", "legalName", LIMITS.companyName, "Company name");
    if ($set["profile.legalName"] === "") throw bad("The company needs a name", "COMPANY_NAME_REQUIRED");
    put("companyNameArabic", "legalNameArabic", LIMITS.companyNameArabic, "The Arabic company name");
    put("addressLine1", "addressLine1", LIMITS.addressLine1, "Address line 1");
    put("addressLine2", "addressLine2", LIMITS.addressLine2, "Address line 2");
    put("city", "city", LIMITS.city, "City");
    put("state", "emirate", LIMITS.state, "State / emirate");
    put("country", "country", LIMITS.country, "Country");
    put("postalCode", "postalCode", LIMITS.postalCode, "Postal code");
    if (patch.phoneNumber !== undefined) {
      const v = clean(patch.phoneNumber);
      if (v && !PHONE.test(v)) throw bad("Please provide a valid phone number", "INVALID_PHONE");
      $set["profile.phone"] = v;
    }
    if (patch.emailAddress !== undefined) {
      const v = clean(patch.emailAddress).toLowerCase();
      if (v && !EMAIL.test(v)) throw bad("Please provide a valid company email", "INVALID_EMAIL");
      $set["profile.email"] = v;
    }
    if (patch.website !== undefined) {
      const v = clean(patch.website);
      if (v && (v.length > LIMITS.website || !WEBSITE.test(v))) throw bad("Please provide a valid website address", "INVALID_WEBSITE");
      $set["profile.website"] = v;
    }

    const bank = patch.bankDetails || {};
    for (const [key, max] of Object.entries(BANK_LIMITS)) {
      if (key === "branch" || bank[key] === undefined) continue;
      const v = clean(bank[key]);
      if (v.length > max) throw bad(`The bank ${key} cannot exceed ${max} characters`, "FIELD_TOO_LONG");
      $set[`profile.bank.${key}`] = key === "currency" ? v.toUpperCase() : v;
    }
    if (patch.branch !== undefined) $set["profile.bank.branch"] = clean(patch.branch).slice(0, BANK_LIMITS.branch);
    if (bank.ibanNumber !== undefined) {
      const iban = normalizeIban(bank.ibanNumber);
      if (iban && !isValidIban(iban)) throw bad("That IBAN does not pass its check digits. Please check it.", "INVALID_IBAN");
      $set["profile.bank.ibanNumber"] = iban;
    }
    if (bank.swiftCode !== undefined) {
      const swift = clean(bank.swiftCode).toUpperCase();
      if (swift && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(swift)) throw bad("A SWIFT / BIC code is 8 or 11 letters and digits", "INVALID_SWIFT");
      $set["profile.bank.swiftCode"] = swift;
    }

    const oldLogo = row.profile?.logo?.publicId;
    if (logo) { $set["profile.logo.url"] = logo.path; $set["profile.logo.publicId"] = logo.filename; }
    if (Object.keys($set).length) await CompanySettings.updateOne({ companyId }, { $set });
    // the logo it replaced is removed only once the new one is stored; a failure to tidy up never fails the save
    if (logo && oldLogo && oldLogo !== logo.filename) deleteFromCloudinary(oldLogo).catch(() => {});
    return this.get();
  }
}

CompanyProfileService.toApi = toApi;
module.exports = CompanyProfileService;
