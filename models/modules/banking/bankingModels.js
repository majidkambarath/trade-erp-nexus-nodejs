const mongoose = require("mongoose");

// ---------------------------------------------------------------------------------------------
// Bank master: the banks the company deals with (its own and its customers'/vendors').
// A bank ACCOUNT is not stored here: it is a ledger account under the Bank group that points at
// one of these (LedgerAccount.bank), so balances and postings stay in the one chart of accounts.
// ---------------------------------------------------------------------------------------------
const bankSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    bankName: { type: String, required: true, trim: true, maxlength: 150 },
    bankCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    swiftCode: { type: String, trim: true, uppercase: true, default: "", match: [/^([A-Z0-9]{8}|[A-Z0-9]{11})?$/, "SWIFT/BIC must be 8 or 11 letters and digits"] },
    country: { type: String, trim: true, uppercase: true, default: "AE", maxlength: 2 },
    city: { type: String, trim: true, default: "", maxlength: 100 },
    branches: [
      {
        name: { type: String, trim: true, maxlength: 150 },
        code: { type: String, trim: true, uppercase: true, maxlength: 20 },
        address: { type: String, trim: true, maxlength: 250 },
        _id: false,
      },
    ],
    notes: { type: String, trim: true, maxlength: 500 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
bankSchema.index({ companyId: 1, bankCode: 1 }, { unique: true });
bankSchema.index({ companyId: 1, isActive: 1, bankName: 1 });

// ---------------------------------------------------------------------------------------------
// Card type master: Visa, Mastercard, American Express, Mada... with the fee the card processor
// charges when a customer pays by that card (merchant discount rate).
// ---------------------------------------------------------------------------------------------
const cardTypeSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 250, default: "" },
    feePercent: { type: Number, default: 0, min: 0, max: 100 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
cardTypeSchema.index({ companyId: 1, name: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Card master: a card the company transacts through.
//   terminal : a merchant terminal / POS account. Customers pay us by card; the processor settles
//              into `accountId` (a bank account) less its fee.
//   credit   : the company's own credit card. Paying a vendor by it creates a liability on
//              `accountId` (created automatically), capped by `creditLimit`.
//   debit    : the company's debit card; `accountId` is the bank account it draws on.
//   prepaid  : a prepaid card; `accountId` is its own asset account (created automatically).
// Only the last four digits are kept. The full number and the CVV are never stored.
// ---------------------------------------------------------------------------------------------
const CARD_KINDS = ["terminal", "credit", "debit", "prepaid"];
const cardSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    label: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: CARD_KINDS, required: true },
    cardTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "CardType", required: true },
    bankId: { type: mongoose.Schema.Types.ObjectId, ref: "BankMaster", default: null },
    holderName: { type: String, trim: true, maxlength: 150, default: "" },
    terminalId: { type: String, trim: true, maxlength: 40, default: "" },
    last4: { type: String, trim: true, default: "", match: [/^(\d{4})?$/, "Enter only the last four digits"] },
    expiryMonth: { type: Number, min: 1, max: 12, default: null },
    expiryYear: { type: Number, min: 2000, max: 2100, default: null },
    creditLimit: { type: Number, default: 0, min: 0 },
    feePercent: { type: Number, default: null, min: 0, max: 100 }, // overrides the card type's fee when set
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
cardSchema.index({ companyId: 1, label: 1 }, { unique: true });
cardSchema.index({ companyId: 1, kind: 1, isActive: 1 });

// ---------------------------------------------------------------------------------------------
// Cheque register: one row per cheque received (receipt voucher) or issued (payment voucher).
// pending -> cleared | bounced | cancelled. Until it clears, a cheque sits in a post-dated
// cheques account rather than in the bank account.
// ---------------------------------------------------------------------------------------------
const CHEQUE_STATUSES = ["pending", "cleared", "bounced", "cancelled"];
const chequeSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    direction: { type: String, enum: ["receipt", "payment"], required: true },
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "Voucher", required: true },
    voucherNo: { type: String, required: true },
    voucherDate: { type: Date, required: true },
    partyType: { type: String, enum: ["Customer", "Vendor"] },
    partyId: { type: mongoose.Schema.Types.ObjectId, refPath: "partyType" },
    partyName: { type: String, trim: true },
    chequeNo: { type: String, required: true, trim: true, maxlength: 40 },
    chequeDate: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 }, // base currency (AED) value
    // set when the cheque is in a foreign currency: what it is written for, and the rate it was taken at
    currency: { type: String, trim: true, uppercase: true },
    foreignAmount: { type: Number, min: 0 },
    exchangeRate: { type: Number, min: 0 },
    drawnOnBankId: { type: mongoose.Schema.Types.ObjectId, ref: "BankMaster", default: null },
    drawnOnBankName: { type: String, trim: true, default: "" },
    bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    isPDC: { type: Boolean, default: false },
    status: { type: String, enum: CHEQUE_STATUSES, default: "pending" },
    clearedOn: { type: Date, default: null },
    bouncedOn: { type: Date, default: null },
    reason: { type: String, trim: true, maxlength: 250, default: "" },
    history: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        by: { type: String, default: null },
        note: { type: String, default: "" },
        _id: false,
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
  },
  { timestamps: true }
);
chequeSchema.index({ companyId: 1, status: 1, chequeDate: 1 });
chequeSchema.index({ companyId: 1, voucherId: 1 });
chequeSchema.index({ companyId: 1, direction: 1, chequeNo: 1 });

const BankMaster = mongoose.models.BankMaster || mongoose.model("BankMaster", bankSchema);
const CardType = mongoose.models.CardType || mongoose.model("CardType", cardTypeSchema);
const CardMaster = mongoose.models.CardMaster || mongoose.model("CardMaster", cardSchema);
const Cheque = mongoose.models.Cheque || mongoose.model("Cheque", chequeSchema);

module.exports = { BankMaster, CardType, CardMaster, Cheque, CARD_KINDS, CHEQUE_STATUSES };
