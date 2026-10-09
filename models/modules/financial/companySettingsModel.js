const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// The posting map: which ledger account a business event posts to. Posting code asks for a
// configKey ("vat-sales") and never hard-codes an account. An unmapped key makes posting
// fail loudly - there is deliberately no fallback account.
const accountConfigurationSchema = new mongoose.Schema(
  {
    configKey: { type: String, required: true, lowercase: true, trim: true, match: /^[a-z0-9-]+$/, maxlength: 100 },
    displayName: { type: String, required: true, trim: true, maxlength: 150 },
    // What may be picked for this key. null = header-only, no picker.
    accountCategory: { type: String, enum: [...require("./accountGroupModel").CATEGORIES, null], default: null },
    // "group": the key maps to an AccountGroup. "account": it maps to one LedgerAccount.
    targetKind: { type: String, enum: ["group", "account", "none"], default: "account" },
    targetGroup: { type: mongoose.Schema.Types.ObjectId, ref: "AccountGroup", default: null },
    targetAccount: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
    parentConfigKey: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const companySettingsSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true },
    accountConfiguration: [accountConfigurationSchema],
    // When true, approving an order posts its accounting entries (receivable/payable, sales or
    // inventory, VAT, cost of goods sold). Off by default so approval keeps working for a company
    // that has not mapped its accounts yet; it can only be switched on once every key is mapped.
    ledgerPostingEnabled: { type: Boolean, default: false },
    // True once a person has switched posting on or off themselves. Until then, a company whose
    // accounts are all mapped is switched on automatically, so approved documents always have
    // their financial effect; after that the person's choice is respected.
    ledgerPostingTouched: { type: Boolean, default: false },
    // Credit control for sales (services/financial/creditControlService.js).
    creditControl: {
      mode: { type: String, enum: ["off", "warn", "block"], default: "off" },
      overdueBlockDays: { type: Number, default: 0, min: 0 }, // 0 = ignore overdue invoices
    },
    // Returns (services/orderPurchase/returnService.js).
    returnWindowDays: { type: Number, default: 0, min: 0 }, // 0 = no limit
    requireReturnLink: { type: Boolean, default: false },
    // Who may approve what (utils/approvalRules.js, services/core/approvalPolicyService.js). Both are off until the organisation sets them.
    approvals: {
      separateApprover: { type: Boolean, default: false }, // the person who prepared a document may not approve it
      secondApprovalAbove: { type: Number, min: 0, default: null }, // a document above this amount needs two different approvers; null = never
    },
    profile: {
      legalName: { type: String, trim: true },
      trn: { type: String, trim: true },
      vatRegistered: { type: Boolean, default: true },
      addressLine1: { type: String, trim: true },
      city: { type: String, trim: true },
      emirate: { type: String, trim: true },
      countryCode: { type: String, trim: true, default: "AE" },
      email: { type: String, trim: true },
      phone: { type: String, trim: true },
      // The rest of what a document's letterhead prints. This is the ORGANISATION's one copy: it used to be kept on each
      // person's own record (Admin.companyInfo), so every person had their own company name, logo and bank details.
      // services/core/companyProfileService.js owns it, and adopts the old per-person copy once.
      legalNameArabic: { type: String, trim: true },
      addressLine2: { type: String, trim: true },
      postalCode: { type: String, trim: true },
      website: { type: String, trim: true },
      country: { type: String, trim: true }, // the country as printed ("United Arab Emirates"); countryCode is the code
      logo: { url: { type: String, trim: true }, publicId: { type: String, trim: true } },
      bank: {
        bankName: { type: String, trim: true },
        accountName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        ibanNumber: { type: String, trim: true },
        swiftCode: { type: String, trim: true },
        currency: { type: String, trim: true, uppercase: true },
        branch: { type: String, trim: true },
      },
      // Set once the old per-person letterhead has been looked at (adopted if there was one), so it is never adopted twice.
      letterheadAdoptedAt: { type: Date, default: null },
    },
    // Go-live (conversion) date: every opening balance is dated this day. openingBalancesPostedAt is
    // when something was last posted (services/financial/openingBalanceService.js).
    openingBalanceDate: { type: Date, default: null },
    openingBalancesPostedAt: { type: Date, default: null },
    // First month of the fiscal year, 1-12. Default January.
    fiscalYearStartMonth: { type: Number, default: 1, min: 1, max: 12 },
    amountDecimal: { type: Number, default: 2, min: 0, max: 6 },
    quantityDecimal: { type: Number, default: 3, min: 0, max: 6 },
    rateDecimal: { type: Number, default: 5, min: 0, max: 8 },
    // The currency the ledger is kept in (the Currency master's isBase row), and how far, in percent,
    // a rate typed on a foreign-currency voucher may be from the master rate before a reason is
    // required (services/financial/currencyService.js).
    baseCurrency: { type: String, default: "AED", uppercase: true, trim: true },
    fxTolerancePercent: { type: Number, default: 5, min: 0, max: 100 },
  },
  { timestamps: true }
);

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
companySettingsSchema.plugin(tenantPlugin);

module.exports = mongoose.model("CompanySettings", companySettingsSchema);
