const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { STATUSES } = require("../../utils/eInvoice");

const settingsSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    // Only the built-in sandbox exists today. The connection to an accredited service provider is
    // not built yet (see services/einvoice/providers.js).
    provider: { type: String, enum: ["sandbox"], default: "sandbox" },
    environment: { type: String, enum: ["sandbox"], default: "sandbox" },
    webhookSecretEnc: { type: String, select: false }, // signs inbound deliveries; encrypted, never returned
    participantId: { type: String, trim: true }, // the seller's Peppol id, "0235:..."
    dueDays: { type: Number, default: 0, min: 0 }, // days after the invoice date by which it should be sent
    retryMax: { type: Number, default: 5, min: 0, max: 20 },
  },
  { timestamps: true }
);

// One row per document sent. The unique index on the source document is the idempotency guard:
// the same invoice can never be submitted twice by two clicks, two tabs or two workers.
const submissionSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    sourceType: { type: String, default: "Transaction" },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    documentNo: { type: String, required: true },
    invoiceTypeCode: { type: String, enum: ["380", "381"], required: true },
    status: { type: String, enum: STATUSES, default: "QUEUED" },
    taxStatus: { type: String, default: null }, // the tax-authority leg, reported separately by the ASP
    payload: { type: mongoose.Schema.Types.Mixed }, // exactly what was sent: an issued invoice must be reproducible
    payloadHash: { type: String },
    providerEntryId: { type: String, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    attempts: { type: Number, default: 0 },
    pollCount: { type: Number, default: 0 },
    retryable: { type: Boolean, default: true },
    lastError: { type: String, default: null },
    nextRetryAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    reportedAt: { type: Date, default: null },
    totals: { net: Number, tax: Number, payable: Number },
    buyerName: { type: String },
    submittedBy: { type: String, default: null },
    history: [{ status: String, at: { type: Date, default: Date.now }, note: String, _id: false }],
  },
  { timestamps: true }
);
submissionSchema.index({ companyId: 1, sourceType: 1, sourceId: 1 }, { unique: true });
submissionSchema.index({ companyId: 1, status: 1, nextRetryAt: 1 });
submissionSchema.index({ companyId: 1, createdAt: -1 });

const inboundSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    providerId: { type: String, required: true },
    documentId: { type: String, required: true },
    issueDate: { type: Date },
    sellerName: String,
    sellerVatTrn: String,
    sellerParticipantId: String,
    invoiceRef: String,
    currency: { type: String, default: "AED" },
    totals: { net: Number, tax: Number, payable: Number },
    lines: [mongoose.Schema.Types.Mixed],
    status: { type: String, enum: ["RECEIVED", "ACCEPTED", "REJECTED"], default: "RECEIVED" },
    matchedVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    suggestedPurchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    matchNote: { type: String },
    decision: { by: String, at: Date, reason: String },
    source: { type: String, enum: ["webhook", "manual"], default: "manual" },
  },
  { timestamps: true }
);
inboundSchema.index({ companyId: 1, providerId: 1 }, { unique: true });
inboundSchema.index({ companyId: 1, status: 1, createdAt: -1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
settingsSchema.plugin(tenantPlugin);
submissionSchema.plugin(tenantPlugin);
inboundSchema.plugin(tenantPlugin);

module.exports = {
  EInvoiceSettings: mongoose.model("EInvoiceSettings", settingsSchema),
  EInvoiceSubmission: mongoose.model("EInvoiceSubmission", submissionSchema),
  InboundInvoice: mongoose.model("InboundInvoice", inboundSchema),
};
