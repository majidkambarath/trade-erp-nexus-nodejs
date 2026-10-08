const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// Voucher Line Item Schema
const voucherLineSchema = new mongoose.Schema({
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
    required: true,
  },
  accountName: { type: String, required: true, trim: true },
  accountCode: { type: String, trim: true },
  debitAmount: { type: Number, default: 0, min: 0 },
  creditAmount: { type: Number, default: 0, min: 0 },
  description: { type: String, trim: true },
  taxPercent: { type: Number, default: 0, min: 0, max: 100 },
  taxAmount: { type: Number, default: 0, min: 0 },
  // Foreign-currency receipts / payments: the money-side legs carry the currency, the rate and
  // their share of the foreign amount. The debit / credit amounts stay in the base currency.
  currency: { type: String, trim: true, uppercase: true },
  exchangeRate: { type: Number, min: 0 },
  amountForeign: { type: Number, min: 0 },
});

// Voucher Schema
const voucherSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  branchId: { type: String, default: "main" }, // the branch it belongs to; head office is "main"
  voucherNo: {
    type: String,
    required: true, // unique within an organisation: see the index below
    trim: true,
  },
  voucherType: {
    type: String,
    // enum: ["receipt", "payment", "journal", "contra", "expense"],
    required: true,
  },
  date: {
    type: Date,
    default: Date.now,
    required: true,
  },
  partyId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "partyType",
  },
  partyType: {
    type: String,
    enum: ["Customer", "Vendor", null],
    default: null,
  },
  partyName: { type: String, trim: true },
  linkedInvoices: [
    {
      invoiceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
      },
      allocatedAmount: { type: Number, min: 0 },
      previousBalance: { type: Number, min: 0 },
      newBalance: { type: Number, min: 0 },
    },
  ],
  onAccountAmount: { type: Number, default: 0, min: 0 },
  // cash | bank | transfer | cheque | card. "online" is the old name for transfer and is still
  // accepted on old vouchers. See services/banking/paymentModeService.js.
  paymentMode: {
    type: String,
    enum: ["cash", "bank", "transfer", "cheque", "card", "online", null],
    default: null,
  },
  paymentDetails: {
    // The ledger account the money moved through (cash account, bank account, settlement account...)
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount" },
    accountName: { type: String, trim: true },
    reference: { type: String, trim: true }, // bank slip / transfer reference
    referenceDate: { type: Date },
    drawnOnBankId: { type: mongoose.Schema.Types.ObjectId, ref: "BankMaster" },
    drawnOnBankName: { type: String, trim: true },
    chequeId: { type: mongoose.Schema.Types.ObjectId, ref: "Cheque" },
    isPDC: { type: Boolean },
    cardId: { type: mongoose.Schema.Types.ObjectId, ref: "CardMaster" },
    cardLabel: { type: String, trim: true },
    cardTypeName: { type: String, trim: true },
    cardLast4: { type: String, trim: true },
    approvalCode: { type: String, trim: true },
    cardFee: { type: Number, min: 0 },
    // older vouchers keep these
    bankDetails: {
      accountNumber: { type: String, trim: true },
      accountName: { type: String, trim: true },
    },
    chequeDetails: {
      chequeNumber: { type: String, trim: true },
      chequeDate: { type: Date },
    },
    onlineDetails: {
      transactionId: { type: String, trim: true },
      transactionDate: { type: Date },
    },
  },
  fromAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transactor",
  },
  toAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transactor",
  },

  transactorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Transactor",
    required: function () {
      return this.voucherType === "expense" && !this.ledgerBased;
    },
  },

  // True for vouchers posted straight to the chart of accounts (ledger accounts). Older journal,
  // contra and expense vouchers were posted to "transactor" accounts and keep working as they were.
  ledgerBased: { type: Boolean, default: false },
  description: { type: String, trim: true },
  // expense vouchers on the chart: which expense account, the VAT, who was paid
  expenseAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount" },
  expenseAccountName: { type: String, trim: true },
  taxCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "TaxCode" },
  subtotal: { type: Number, min: 0 },
  vatTotal: { type: Number, min: 0 },
  // debit / credit notes
  noteLines: [
    {
      accountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount" },
      accountName: { type: String, trim: true },
      accountCode: { type: String, trim: true },
      description: { type: String, trim: true },
      amount: { type: Number, min: 0 },
      taxCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "TaxCode" },
      vatPercent: { type: Number, min: 0, default: 0 },
      vatAmount: { type: Number, min: 0, default: 0 },
      _id: false,
    },
  ],
  referenceInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
  referenceInvoiceNo: { type: String, trim: true },

  expenseTypeName: { type: String, trim: true },
  transactorName: { type: String, trim: true },
  expenseCategoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ExpenseCategory",
  },
  expenseType: { type: String, trim: true },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
    default: null,
  },
  approvalStatus: {
    type: String,
    // enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
  },
  approvedAt: { type: Date },
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  narration: { type: String, trim: true },
  notes: { type: String, trim: true },
  entries: [voucherLineSchema],
  attachments: [
    {
      fileName: { type: String, trim: true },
      filePath: { type: String, trim: true },
      fileType: { type: String, trim: true },
      fileSize: { type: Number, min: 0 },
    },
  ],
  status: {
    type: String,
    // enum: ["draft", "pending", "approved", "rejected", "cancelled"],
    default: "draft",
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  referenceType: {
    type: String,
    enum: ["invoice", "order", "manual", null],
    default: "manual",
  },
  referenceId: { type: mongoose.Schema.Types.ObjectId },
  referenceNo: { type: String, trim: true },
  // Foreign currency (receipts and payments; services/financial/fxVoucherService.js). totalAmount and
  // everything posted stay in the base currency; these record how it was converted. An AED voucher has
  // currency "AED", exchangeRate 1 and no foreignAmount (older vouchers have none of these).
  currency: { type: String, trim: true, uppercase: true },
  exchangeRate: { type: Number, min: 0 },
  foreignAmount: { type: Number, min: 0 },
  rateDate: { type: Date }, // the day of the master rate it was taken from
  rateSource: { type: String, trim: true }, // manual | cbuae | import (as the master), or "voucher" when typed on it
  rateOverridden: { type: Boolean }, // typed rate further from the master than the allowed tolerance
  rateOverrideReason: { type: String, trim: true, maxlength: 250 },
  financialYear: { type: String, trim: true },
  month: { type: Number, min: 1, max: 12 },
  year: { type: Number },
});

// Pre-save middleware
voucherSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  const date = new Date(this.date);
  this.month = date.getMonth() + 1;
  this.year = date.getFullYear();
  // January to December, the year the document falls in (it was April to March, an Indian year)
  this.financialYear = String(date.getFullYear());
  if (this.voucherType === "journal") {
    const totalDebits = this.entries.reduce(
      (sum, entry) => sum + entry.debitAmount,
      0
    );
    const totalCredits = this.entries.reduce(
      (sum, entry) => sum + entry.creditAmount,
      0
    );
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      return next(
        new Error("Debits and credits must be equal for journal vouchers")
      );
    }
  }
  next();
});

// Pre-update middleware
voucherSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes (removed duplicate voucherNo index)
voucherSchema.index({ voucherType: 1, date: -1 }); // For FinancialService.getAllVouchers
voucherSchema.index({ partyId: 1, partyType: 1, status: 1 }); // For FinancialService.getPartyStatement
voucherSchema.index({ status: 1, approvalStatus: 1 }); // For FinancialService.getAllVouchers
voucherSchema.index({ financialYear: 1, month: 1 }); // For FinancialService.getFinancialReports
voucherSchema.index({ createdBy: 1, createdAt: -1 }); // For FinancialService.getDashboardStats
// the currency register and "is this currency used?"; only foreign-currency vouchers are indexed
voucherSchema.index({ currency: 1, voucherType: 1, date: -1 }, { partialFilterExpression: { foreignAmount: { $exists: true } } });

voucherSchema.index({ voucherNo: 1 }, { unique: true }); // unique within an organisation

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
// documents belong to a branch: a person working in one branch sees only that branch's (utils/tenantPlugin.js)
voucherSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

const Voucher = mongoose.model("Voucher", voucherSchema);

// Ledger Account Schema
const ledgerAccountSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  accountCode: {
    type: String,
    required: false,
    default: null,
    trim: true,
    sparse: true,
  },
  accountName: {
    type: String,
    required: true,
    trim: true,
  },
  accountType: {
    type: String,
    enum: ["asset", "liability", "equity", "income", "expense"],
    required: true,
  },
  subType: {
    type: String,
    enum: [
      "current_asset",
      "fixed_asset",
      "current_liability",
      "long_term_liability",
      "share_capital",
      "retained_earnings",
      "sales",
      "other_income",
      "operating_expense",
      "financial_expense",
    ],
    required: true,
  },
  parentAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
  },
  // Account group (carries the category that decides how the balance is read). Optional so
  // existing accounts keep working; accountType above stays as a denormalised copy of
  // group.category.
  groupId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "AccountGroup",
    default: null,
  },
  level: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  // For accounts in the Bank group: which bank, and the account's identifiers. The bank master
  // holds the institution; this holds the account.
  bank: {
    bankId: { type: mongoose.Schema.Types.ObjectId, ref: "BankMaster", default: null },
    branchCode: { type: String, trim: true, default: "" },
    accountNumber: { type: String, trim: true, default: "" },
    iban: { type: String, trim: true, uppercase: true, default: "" },
    accountHolder: { type: String, trim: true, default: "" },
  },
  // openingBalance is an unsigned amount; openingSide says whether it is a debit or a credit,
  // so a credit opening balance (e.g. a liability) is representable.
  openingBalance: { type: Number, default: 0, min: 0 },
  openingSide: { type: String, enum: ["debit", "credit"], default: null },
  currentBalance: { type: Number, default: 0 },
  description: { type: String, trim: true },
  allowDirectPosting: { type: Boolean, default: true },
  isSystemAccount: { type: Boolean, default: false },
  // Supporting documents (trade licence, bank letter, statements...). See attachmentService.
  documents: [
    {
      attachmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Attachment" },
      fileName: String,
      url: String,
      fileType: String,
      fileSize: Number,
      label: String,
      uploadedAt: { type: Date, default: Date.now },
      _id: false,
    },
  ],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save middleware
ledgerAccountSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Pre-update middleware
ledgerAccountSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes (removed duplicate accountCode index)
ledgerAccountSchema.index({ accountName: 1, isActive: 1 }); // For FinancialService.getCashBankAccount
ledgerAccountSchema.index({ accountType: 1, subType: 1 }); // For FinancialService.getOrCreateCustomerAccount
ledgerAccountSchema.index({ isActive: 1, allowDirectPosting: 1 }); // For FinancialService.processJournalVoucher
ledgerAccountSchema.index({ groupId: 1, accountCode: 1 });

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
ledgerAccountSchema.plugin(tenantPlugin, { leadIndexes: true });

const LedgerAccount = mongoose.model("LedgerAccount", ledgerAccountSchema);

// Ledger Entry Schema
const ledgerEntrySchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  branchId: { type: String, default: "main" }, // the branch it belongs to; head office is "main"
  voucherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Voucher",
    required: true,
  },
  voucherNo: {
    type: String,
    required: true,
    trim: true,
  },
  voucherType: {
    type: String,
    // enum: ["receipt", "payment", "journal", "contra", "expense"],
    required: true,
  },
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
    required: true,
  },
  accountName: {
    type: String,
    required: true,
    trim: true,
  },
  accountCode: {
    type: String,
    required: false,
    default: null,
    trim: true,
  },
  date: {
    type: Date,
    required: true,
  },
  debitAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  creditAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  narration: { type: String, trim: true },
  partyId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "partyType",
  },
  partyType: {
    type: String,
    enum: ["Customer", "Vendor", null],
    default: null,
  },
  referenceType: { type: String, trim: true },
  referenceId: { type: mongoose.Schema.Types.ObjectId },
  referenceNo: { type: String, trim: true },
  financialYear: { type: String, trim: true },
  month: { type: Number, min: 1, max: 12 },
  year: { type: Number },
  runningBalance: { type: Number, default: 0 },
  // Money-side legs of a foreign-currency voucher: the amounts above are base currency (AED);
  // these say what foreign amount at what rate they stand for. Absent on every other entry.
  currency: { type: String, trim: true, uppercase: true },
  exchangeRate: { type: Number, min: 0 },
  amountForeign: { type: Number, min: 0 },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  isReversed: { type: Boolean, default: false },
  reversedAt: { type: Date },
});

// Pre-save middleware
ledgerEntrySchema.pre("save", function (next) {
  const date = new Date(this.date);
  this.month = date.getMonth() + 1;
  this.year = date.getFullYear();
  this.financialYear = String(date.getFullYear()); // January to December
  next();
});

// Indexes
ledgerEntrySchema.index({ voucherId: 1, accountId: 1, date: 1 }); // For FinancialService.reverseLedgerEntries
ledgerEntrySchema.index({ accountId: 1, date: 1 }); // For FinancialService.getTrialBalance
ledgerEntrySchema.index({ partyId: 1, partyType: 1 }); // For FinancialService.getPartyStatement
ledgerEntrySchema.index({ financialYear: 1, month: 1 }); // For FinancialService.getFinancialReports

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
// documents belong to a branch: a person working in one branch sees only that branch's (utils/tenantPlugin.js)
ledgerEntrySchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);

module.exports = {
  Voucher,
  LedgerAccount,
  LedgerEntry,
};
