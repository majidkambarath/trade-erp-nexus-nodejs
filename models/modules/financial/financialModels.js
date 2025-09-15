// models/financial/voucherModel.js
const mongoose = require("mongoose");

// Base voucher line item schema
const voucherLineSchema = new mongoose.Schema({
  accountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
    required: true,
  },
  accountName: { type: String, required: true },
  debitAmount: { type: Number, default: 0, min: 0 },
  creditAmount: { type: Number, default: 0, min: 0 },
  description: { type: String },
  taxPercent: { type: Number, default: 0, min: 0, max: 100 },
  taxAmount: { type: Number, default: 0, min: 0 },
});

// Main unified voucher schema
const voucherSchema = new mongoose.Schema({
  voucherNo: {
    type: String,
    unique: true,
    required: true,
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

  // Party information (for receipt/payment vouchers)
  partyId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "partyType",
  },
  partyType: {
    type: String,
    enum: ["Customer", "Vendor", null],
    default: null,
  },
  partyName: { type: String },

  // Linked invoices (for receipt/payment)
  linkedInvoices: [
    {
      invoiceId: { type: mongoose.Schema.Types.ObjectId },
      invoiceNo: { type: String },
      amount: { type: Number, min: 0 },
      balanceAmount: { type: Number, min: 0 },
    },
  ],

  // Payment/Transfer details
  paymentMode: {
    type: String,
    enum: ["cash", "bank", "cheque", "online", "transfer", null],
    default: null,
  },
  chequeNo: { type: String },
  chequeDate: { type: Date },
  bankName: { type: String },

  // For contra vouchers
  fromAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
  },
  toAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
  },

  // For expense vouchers
  expenseCategoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ExpenseCategory",
  },
  expenseType: { type: String },
  submittedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  approvalStatus: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  approvedAt: { type: Date },

  // Common fields
  totalAmount: {
    type: Number,
    required: true,
    min: 0,
  },
  narration: { type: String },
  notes: { type: String },

  // Voucher entries (double entry system)
  entries: [voucherLineSchema],

  // File attachments
  attachments: [
    {
      fileName: { type: String },
      filePath: { type: String },
      fileType: { type: String },
      fileSize: { type: Number },
    },
  ],

  // Status and workflow
  status: {
    type: String,
    enum: ["draft", "pending", "approved", "rejected", "cancelled"],
    default: "draft",
  },

  // Audit fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },

  // References for integration
  referenceType: {
    type: String,
    enum: ["invoice", "order", "manual", null],
    default: "manual",
  },
  referenceId: { type: mongoose.Schema.Types.ObjectId },
  referenceNo: { type: String },

  // Financial period
  financialYear: { type: String },
  month: { type: Number, min: 1, max: 12 },
  year: { type: Number },
});

// Pre-save middleware
voucherSchema.pre("save", function (next) {
  this.updatedAt = Date.now();

  // Set financial period
  const date = new Date(this.date);
  this.month = date.getMonth() + 1;
  this.year = date.getFullYear();

  // Calculate financial year (April to March)
  const fyStart =
    date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  this.financialYear = `${fyStart}-${fyStart + 1}`;

  // Validate double entry for journal vouchers
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

// Indexes for performance
voucherSchema.index({ voucherType: 1, date: -1 });
voucherSchema.index({ partyId: 1, voucherType: 1 });
voucherSchema.index({ status: 1, createdAt: -1 });
voucherSchema.index({ financialYear: 1, month: 1 });
voucherSchema.index({ createdBy: 1, date: -1 });

module.exports = mongoose.model("Voucher", voucherSchema);

// models/financial/ledgerAccountModel.js
const ledgerAccountSchema = new mongoose.Schema({
  accountCode: {
    type: String,
    unique: true,
    required: true,
  },
  accountName: {
    type: String,
    required: true,
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
  level: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  openingBalance: { type: Number, default: 0 },
  currentBalance: { type: Number, default: 0 },
  description: { type: String },

  // Account behavior
  allowDirectPosting: { type: Boolean, default: true },
  isSystemAccount: { type: Boolean, default: false },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ledgerAccountSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

ledgerAccountSchema.index({ accountType: 1, subType: 1 });
ledgerAccountSchema.index({ isActive: 1, allowDirectPosting: 1 });

const LedgerAccount = mongoose.model("LedgerAccount", ledgerAccountSchema);

// models/financial/expenseCategoryModel.js
const expenseCategorySchema = new mongoose.Schema({
  categoryName: {
    type: String,
    required: true,
    unique: true,
  },
  categoryCode: {
    type: String,
    required: true,
    unique: true,
  },
  description: { type: String },
  parentCategoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ExpenseCategory",
  },
  level: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },

  // Budget controls
  monthlyBudget: { type: Number, default: 0 },
  yearlyBudget: { type: Number, default: 0 },
  currentSpent: { type: Number, default: 0 },

  // Approval requirements
  requiresApproval: { type: Boolean, default: true },
  approvalLimit: { type: Number, default: 0 },

  // Default ledger account for this category
  defaultAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "LedgerAccount",
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

expenseCategorySchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

expenseCategorySchema.index({ isActive: 1, level: 1 });
expenseCategorySchema.index({ parentCategoryId: 1 });

const ExpenseCategory = mongoose.model(
  "ExpenseCategory",
  expenseCategorySchema
);

// models/financial/ledgerEntryModel.js
const ledgerEntrySchema = new mongoose.Schema({
  voucherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Voucher",
    required: true,
  },
  voucherNo: {
    type: String,
    required: true,
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
  },
  accountCode: {
    type: String,
    required: true,
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

  narration: { type: String },

  // Party information for receivables/payables tracking
  partyId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: "partyType",
  },
  partyType: {
    type: String,
    enum: ["Customer", "Vendor", null],
    default: null,
  },

  // Reference information
  referenceType: { type: String },
  referenceId: { type: mongoose.Schema.Types.ObjectId },
  referenceNo: { type: String },

  // Financial period
  financialYear: { type: String },
  month: { type: Number, min: 1, max: 12 },
  year: { type: Number },

  // Running balance for the account
  runningBalance: { type: Number, default: 0 },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Pre-save middleware to set financial period
ledgerEntrySchema.pre("save", function (next) {
  const date = new Date(this.date);
  this.month = date.getMonth() + 1;
  this.year = date.getFullYear();

  // Calculate financial year (April to March)
  const fyStart =
    date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  this.financialYear = `${fyStart}-${fyStart + 1}`;

  next();
});

// Indexes for optimal query performance
ledgerEntrySchema.index({ accountId: 1, date: -1 });
ledgerEntrySchema.index({ voucherId: 1 });
ledgerEntrySchema.index({ voucherType: 1, date: -1 });
ledgerEntrySchema.index({ partyId: 1, partyType: 1, date: -1 });
ledgerEntrySchema.index({ financialYear: 1, month: 1 });
ledgerEntrySchema.index({ date: -1, createdAt: -1 });

const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);

// Export all models
module.exports = {
  Voucher: mongoose.model("Voucher", voucherSchema),
  LedgerAccount,
  ExpenseCategory,
  LedgerEntry,
};
