const mongoose = require("mongoose");

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
});

// Voucher Schema
const voucherSchema = new mongoose.Schema({
  voucherNo: {
    type: String,
    unique: true,
    required: true,
    trim: true,
  },
  voucherType: {
    type: String,
    enum: ["receipt", "payment", "journal", "contra", "expense"],
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
  paymentMode: {
    type: String,
    enum: ["cash", "bank", "cheque", "online", null],
    default: null,
  },
  paymentDetails: {
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
  expenseCategoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ExpenseCategory",
  },
  expenseType: { type: String, trim: true },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
  },
  approvalStatus: {
    type: String,
    enum: ["pending", "approved", "rejected"],
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
    enum: ["draft", "pending", "approved", "rejected", "cancelled"],
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
  const fyStart = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  this.financialYear = `${fyStart}-${fyStart + 1}`;
  if (this.voucherType === "journal") {
    const totalDebits = this.entries.reduce((sum, entry) => sum + entry.debitAmount, 0);
    const totalCredits = this.entries.reduce((sum, entry) => sum + entry.creditAmount, 0);
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
      return next(new Error("Debits and credits must be equal for journal vouchers"));
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

const Voucher = mongoose.model("Voucher", voucherSchema);

// Ledger Account Schema
const ledgerAccountSchema = new mongoose.Schema({
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
  level: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  openingBalance: { type: Number, default: 0, min: 0 },
  currentBalance: { type: Number, default: 0 },
  description: { type: String, trim: true },
  allowDirectPosting: { type: Boolean, default: true },
  isSystemAccount: { type: Boolean, default: false },
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

const LedgerAccount = mongoose.model("LedgerAccount", ledgerAccountSchema);

// Expense Category Schema
const expenseCategorySchema = new mongoose.Schema({
  categoryName: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  categoryCode: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  description: { type: String, trim: true },
  parentCategoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ExpenseCategory",
  },
  level: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: true },
  monthlyBudget: { type: Number, default: 0, min: 0 },
  yearlyBudget: { type: Number, default: 0, min: 0 },
  currentSpent: { type: Number, default: 0, min: 0 },
  requiresApproval: { type: Boolean, default: true },
  approvalLimit: { type: Number, default: 0, min: 0 },
  defaultAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save middleware
expenseCategorySchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Pre-update middleware
expenseCategorySchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes (removed duplicate categoryName and categoryCode indexes)
expenseCategorySchema.index({ isActive: 1 }); // For FinancialService.processExpenseVoucher
expenseCategorySchema.index({ parentCategoryId: 1 }); // For hierarchical queries

const ExpenseCategory = mongoose.model("ExpenseCategory", expenseCategorySchema);

// Ledger Entry Schema
const ledgerEntrySchema = new mongoose.Schema({
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
    enum: ["receipt", "payment", "journal", "contra", "expense"],
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
  const fyStart = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  this.financialYear = `${fyStart}-${fyStart + 1}`;
  next();
});

// Indexes
ledgerEntrySchema.index({ voucherId: 1, accountId: 1, date: 1 }); // For FinancialService.reverseLedgerEntries
ledgerEntrySchema.index({ accountId: 1, date: 1 }); // For FinancialService.getTrialBalance
ledgerEntrySchema.index({ partyId: 1, partyType: 1 }); // For FinancialService.getPartyStatement
ledgerEntrySchema.index({ financialYear: 1, month: 1 }); // For FinancialService.getFinancialReports

const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);

module.exports = {
  Voucher,
  LedgerAccount,
  ExpenseCategory,
  LedgerEntry,
};