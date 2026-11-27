const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { baseLineFields, chargeSchema, pricingSchema } = require("./salesDocumentParts");

// A recurring invoice: a TEMPLATE that makes a DRAFT sales invoice on a schedule (services/orderPurchase/recurringInvoiceService.js,
// rules utils/recurring.js). It never approves, posts or sends anything: a person reviews and approves each draft.
// Branch scoped, like the invoices it makes: they belong to its branch.
const lineSchema = new mongoose.Schema(
  {
    ...baseLineFields,
    costCentreId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre" }, // the line's own, absent = the header's
  },
  { _id: false }
);

const runSchema = new mongoose.Schema(
  {
    day: { type: String }, // the scheduled day, "YYYY-MM-DD"
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
    transactionNo: { type: String },
    at: { type: Date },
  },
  { _id: false }
);

const recurringInvoiceSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    partyId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

    items: { type: [lineSchema], default: [] },
    charges: { type: [chargeSchema], default: [] },
    discount: { type: Number, default: 0, min: 0 },
    pricing: { type: pricingSchema, default: undefined }, // as priced when last saved: a guide; each invoice is priced on its own day
    totalAmount: { type: Number, default: 0, min: 0 },
    costCentreId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre" },
    notes: { type: String, trim: true, default: "", maxlength: 1000 },
    terms: { type: String, trim: true, default: "", maxlength: 2000 },

    frequency: { type: String, enum: ["weekly", "monthly", "quarterly", "yearly"], required: true },
    interval: { type: Number, default: 1, min: 1, max: 12 },
    startDay: { type: String, required: true },
    endDay: { type: String },
    maxCount: { type: Number, min: 1 },
    cursor: { type: Number, default: 0, min: 0 }, // the next slot on the calendar (utils/recurring.js)
    made: { type: Number, default: 0, min: 0 }, // invoices made so far
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

recurringInvoiceSchema.index({ companyId: 1, status: 1, nextRunDay: 1 });
recurringInvoiceSchema.index({ companyId: 1, partyId: 1 });

recurringInvoiceSchema.plugin(tenantPlugin, { branchScoped: true });
recurringInvoiceSchema.plugin(require("../../utils/auditPlugin"), { entity: "RecurringInvoice", ignore: ["cursor", "made", "nextRunDay", "runs", "lastError", "retryAfter"] });

module.exports = mongoose.models.RecurringInvoice || mongoose.model("RecurringInvoice", recurringInvoiceSchema);
