const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// One go-live submission that posts a single ledger voucher: either account balances (the trial
// balance) or opening stock. Customer and vendor opening invoices are not stored here - they are
// real Transaction documents flagged isOpening.
//
// The voucher's id is the voucherId of its ledger entries, so reversing it is one call to
// FinancialService.reverseLedgerEntries. A reversed voucher stays for the record; nothing about it
// counts any more, and its accounts / items can be entered again.
const lineSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount" },
    accountCode: { type: String, trim: true },
    accountName: { type: String, trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const stockRowSchema = new mongoose.Schema(
  {
    stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock" },
    itemCode: { type: String, trim: true }, // Stock.itemId, what the movements are keyed by
    sku: { type: String, trim: true },
    itemName: { type: String, trim: true },
    qty: { type: Number, min: 0 },
    unitCost: { type: Number, min: 0 }, // as entered
    value: { type: Number, min: 0 }, // qty x unit cost, to 2 dp: the cost that went into the pool
    batchNumber: { type: String, trim: true },
    expiryDate: { type: Date, default: null },
    location: { type: String, trim: true, default: "MAIN" },
  },
  { _id: false }
);

const openingBalanceSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    section: { type: String, enum: ["accounts", "stock"], required: true },
    voucherNo: { type: String, required: true, unique: true, trim: true },
    date: { type: Date, required: true },
    narration: { type: String, trim: true },
    // accounts
    lines: [lineSchema],
    totalDebit: { type: Number, default: 0, min: 0 },
    totalCredit: { type: Number, default: 0, min: 0 },
    // The balancing line to Opening Balance Equity: which side it was posted on, and how much.
    differenceAmount: { type: Number, default: 0, min: 0 },
    differenceSide: { type: String, enum: ["debit", "credit", null], default: null },
    // stock
    rows: [stockRowSchema],
    totalValue: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ["posted", "reversed"], default: "posted" },
    createdBy: { type: String, default: "system" },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: String, default: null },
  },
  { timestamps: true }
);

openingBalanceSchema.index({ companyId: 1, section: 1, status: 1, date: -1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
openingBalanceSchema.plugin(tenantPlugin);

module.exports = mongoose.model("OpeningBalanceVoucher", openingBalanceSchema);
