const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { STATUSES } = require("../../utils/eInvoice");

const settingsSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    // Only the built-in sandbox exists today. The connection to an accredited service provider is
    // not built yet (see services/einvoice/providers.js).
    provider: { type: String, enum: ["sandbox", "wafeq"], default: "sandbox" },
    // for Wafeq: "sandbox" uses the installation's test key, "live" its live key
    environment: { type: String, enum: ["sandbox", "live"], default: "sandbox" },
    // The business as Wafeq knows it (the partner model: Zarvia holds the Wafeq account, each client only links its taxpayer).
    wafeq: {
      taxpayerId: { type: String, default: undefined }, // "txpay_..."
      grantId: { type: String, default: undefined }, // "tgr_..."
      tin: String,
      participantId: String, // "0235:<tin>"
      name: String,
      status: { type: String, enum: ["active", "revoked", "disconnected"], default: undefined },
      mode: { type: String, enum: ["sandbox", "live"], default: undefined },
      linkedVia: { type: String, enum: ["oauth", "console"], default: undefined },
      connectedAt: Date,
      connectedBy: String,
      lastError: String,
      lastWebhookAt: Date, // the last Wafeq delivery that named this business
      inboundPulledAt: Date, // the last time received documents were asked for (services/einvoice/wafeq/inboundPull.js)
    },
    // between "Connect with Wafeq" starting and finishing: the PKCE verifier, encrypted, never returned
    wafeqPending: { type: new mongoose.Schema({ verifierEnc: String, nonce: String, mode: String, at: Date, by: String }, { _id: false }), select: false, default: undefined },
    webhookSecretEnc: { type: String, select: false }, // signs inbound deliveries; encrypted, never returned
    participantId: { type: String, trim: true }, // the seller's Peppol id, "0235:..."
    startDate: { type: String, default: undefined }, // "YYYY-MM-DD": invoices dated on or after this day are expected to be e-invoiced
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
    issueDate: { type: Date, default: undefined }, // the invoice's own date (reports and the dashboard period read it)
    invoiceTypeCode: { type: String, enum: ["380", "381"], required: true },
    status: { type: String, enum: STATUSES, default: "QUEUED" },
    taxStatus: { type: String, default: null }, // the tax-authority leg, reported separately by the ASP
    payload: { type: mongoose.Schema.Types.Mixed }, // exactly what was sent: an issued invoice must be reproducible
    payloadHash: { type: String },
    providerEntryId: { type: String, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    deliveryStatus: { type: String, default: null }, // the provider's delivery leg (Wafeq delivery_status), beside taxStatus
    deliveryJobId: { type: String, default: null },
    deliveryReasonCode: { type: String, default: null }, // why the buyer rejected it: BV, SV or FD
    deliveryReasonText: { type: String, default: null },
    rejectedBy: { type: String, enum: ["buyer", "fta", null], default: null },
    previousEntryIds: [String], // the Wafeq ids a correction replaced, oldest first
    route: { type: String, default: null }, // delivery | reporting_only ...
    providerMode: { type: String, default: null }, // sandbox | live
    providerIssues: [{ code: String, message: String, _id: false }], // what the provider refused, in its words
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
submissionSchema.index({ companyId: 1, issueDate: 1 });

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
    source: { type: String, enum: ["webhook", "manual", "wafeq"], default: "manual" },
    // Received through Wafeq: what kind of document, its id there, its due day, and the XML exactly as received.
    kind: { type: String, enum: ["invoice", "credit_note"], default: "invoice" },
    wafeqDocumentId: { type: String, default: undefined },
    dueDate: { type: Date },
    xml: { type: String, select: false },
  },
  { timestamps: true }
);
inboundSchema.index({ companyId: 1, providerId: 1 }, { unique: true });
inboundSchema.index({ companyId: 1, status: 1, createdAt: -1 });

// Webhook deliveries from Wafeq, kept so a retry is recognised. Installation level (the delivery names a Wafeq taxpayer, not one of our
// organisations), so it carries no companyId; the organisation is found from the taxpayer id.
const wafeqEventSchema = new mongoose.Schema(
  { eventId: { type: String, required: true, unique: true }, type: String, taxpayerId: String, org: { type: String, default: null }, result: String, receivedAt: { type: Date, default: Date.now }, processedAt: Date },
  { timestamps: false }
);
wafeqEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }); // a month is longer than Wafeq retries

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
settingsSchema.plugin(tenantPlugin);
submissionSchema.plugin(tenantPlugin);
inboundSchema.plugin(tenantPlugin);

// every change a person makes is logged with its old and new values, and a deleted record is kept (utils/auditPlugin.js)
settingsSchema.plugin(require("../../utils/auditPlugin"), { entity: "EInvoiceSettings", ignore: ["inboundPulledAt", "wafeq.lastWebhookAt", "wafeq.lastError", "wafeqPending"] });

module.exports = {
  EInvoiceSettings: mongoose.model("EInvoiceSettings", settingsSchema),
  EInvoiceSubmission: mongoose.model("EInvoiceSubmission", submissionSchema),
  InboundInvoice: mongoose.model("InboundInvoice", inboundSchema),
  WafeqEvent: mongoose.model("WafeqEvent", wafeqEventSchema),
};
