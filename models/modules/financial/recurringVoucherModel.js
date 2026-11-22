const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A recurring voucher: a TEMPLATE that makes a PENDING journal or expense voucher on a schedule (services/financial/recurringVoucherService.js,
// dates utils/recurring.js). The voucher it makes posts NOTHING until a person approves it, the same shape as a recurring invoice's draft.
// Branch scoped, like the vouchers it makes.
const lineSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    narration: { type: String, trim: true, maxlength: 300 },
    costCentreId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre" },
  },
  { _id: false }
);

const runSchema = new mongoose.Schema(
  {
    day: { type: String }, // the scheduled day, "YYYY-MM-DD"
    voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "Voucher" },
    voucherNo: { type: String },
    at: { type: Date },
  },
  { _id: false }
);

const recurringVoucherSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    kind: { type: String, enum: ["journal", "expense"], required: true },
    // The account the vouchers are made as. A job has no signed-in person, and a voucher's `createdBy` must be a real account.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },

    // journal
    lines: { type: [lineSchema], default: undefined },
    // expense: the net amount, before VAT, and how it is paid (cash or bank only: a transfer needs a reference and a cheque a number
    // that a schedule cannot know)
    expenseAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount" },
    description: { type: String, trim: true, maxlength: 300 },
    amount: { type: Number, min: 0 },
    taxCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "TaxCode" },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    partyName: { type: String, trim: true, maxlength: 150 },
    paymentMode: { type: String, enum: ["cash", "bank"] },
    paymentAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount" },
    paymentReference: { type: String, trim: true, maxlength: 100 },

    totalAmount: { type: Number, default: 0, min: 0 }, // the debit total of a journal, the net of an expense: a guide for the list
    narration: { type: String, trim: true, maxlength: 500 },
    costCentreId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre" },

    frequency: { type: String, enum: ["weekly", "monthly", "quarterly", "yearly"], required: true },
    interval: { type: Number, default: 1, min: 1, max: 12 },
    startDay: { type: String, required: true },
    endDay: { type: String },
    maxCount: { type: Number, min: 1 },
    cursor: { type: Number, default: 0, min: 0 }, // the next slot on the calendar (utils/recurring.js)
    made: { type: Number, default: 0, min: 0 }, // vouchers made so far
    nextRunDay: { type: String, default: null }, // null once ENDED
    status: { type: String, enum: ["ACTIVE", "PAUSED", "ENDED"], default: "ACTIVE" },

    runs: { type: [runSchema], default: [] }, // the latest 24
    lastError: { day: String, message: String, at: Date },
    retryAfter: { type: Date, default: null },

    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

recurringVoucherSchema.index({ companyId: 1, status: 1, nextRunDay: 1 });
recurringVoucherSchema.index({ companyId: 1, kind: 1 });

recurringVoucherSchema.plugin(tenantPlugin, { branchScoped: true });

module.exports = mongoose.models.RecurringVoucher || mongoose.model("RecurringVoucher", recurringVoucherSchema);
