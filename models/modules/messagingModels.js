// Sending a document to the customer: the settings, the log of every send, and the secret links.
// Shaped like models/modules/einvoiceModels.js, with one deliberate difference: there is NO unique
// index on the source document. A tax invoice is reported to the authority once; it may be emailed
// to a customer five times (a new accounts contact, a chase, a typo in the address). The guard
// against a double click is on the REQUEST (idempotencyKey), not on the document.
const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const DOC_TYPES = ["tax_invoice", "quotation", "delivery_note", "statement"];
const SOURCE_TYPES = ["Transaction", "Quotation", "DeliveryNote", "Customer"];
// SENT means the provider accepted the message. It does NOT mean delivered: nothing in version one
// learns of a bounce. DELIVERED and BOUNCED are reserved for the provider webhook and nothing writes
// them yet. HANDED_OFF is WhatsApp: the message was given to the person's own WhatsApp, and the
// system makes no claim at all about what happened next.
const SEND_STATUSES = ["QUEUED", "SENT", "FAILED", "BOUNCED", "DELIVERED", "HANDED_OFF"];

const settingsSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    // "console" records the send and posts nothing, so the whole feature works with no account
    // (the same idea as the e-invoice sandbox) and is honest about it: connected is false.
    provider: { type: String, enum: ["console", "resend", "smtp"], default: "console" },
    apiKeyEnc: { type: String, select: false }, // encrypted at rest, write-only, never returned
    // Sending through a mailbox's own mail server. The password is kept apart from the Resend key so
    // switching provider and back loses neither. Write-only like the key.
    smtpHost: { type: String, trim: true, lowercase: true, maxlength: 253 },
    smtpPort: { type: Number, default: 587 },
    smtpUser: { type: String, trim: true, maxlength: 200 },
    smtpPassEnc: { type: String, select: false },
    fromName: { type: String, trim: true, maxlength: 100 },
    fromEmail: { type: String, trim: true, lowercase: true, maxlength: 160 },
    replyTo: { type: String, trim: true, lowercase: true, maxlength: 160 },
    // The domain verified at the provider by DNS records. A fromEmail outside it is refused here,
    // before the provider turns it into an opaque 403.
    verifiedDomain: { type: String, trim: true, lowercase: true, maxlength: 120 },
    bccSelf: { type: Boolean, default: false }, // a copy to the sender own mailbox: the cheapest sent items
    signature: { type: String, trim: true, maxlength: 500 },
    defaultNote: { type: String, trim: true, maxlength: 500 }, // the wording the dialog starts with
    attachPdf: { type: Boolean, default: true },
    shareEnabled: { type: Boolean, default: true },
    shareLinkDays: { type: Number, default: 30, min: 1, max: 365 },
    statementShareDays: { type: Number, default: 14, min: 1, max: 365 }, // the most sensitive of the four
    retryMax: { type: Number, default: 3, min: 0, max: 10 },
    dailyLimit: { type: Number, default: 200, min: 1, max: 5000 },
    lastAuthFailureAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const sendSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String },
    docType: { type: String, enum: DOC_TYPES, required: true },
    sourceType: { type: String, enum: SOURCE_TYPES, required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true }, // a statement's source is the customer
    documentNo: { type: String, required: true }, // display only
    period: { from: Date, to: Date }, // statements only
    partyId: { type: mongoose.Schema.Types.ObjectId },
    partyName: { type: String }, // denormalised so the history reads with no join
    channel: { type: String, enum: ["email", "whatsapp"], required: true },
    status: { type: String, enum: SEND_STATUSES, default: "QUEUED" },
    to: [String],
    cc: [String],
    bcc: [String],
    phone: { type: String }, // digits with the country code, whatsapp only
    subject: { type: String },
    bodyPreview: { type: String, maxlength: 400 }, // the text part, cut short. Never the HTML.
    note: { type: String, maxlength: 1000 }, // the person's own words, as sent
    attachment: { fileName: String, bytes: Number, sha256: String, mimeType: String },
    // What a retry needs to send the IDENTICAL message: held only while the send is unsettled, wiped
    // the moment it settles or gives up, and by the sweep after a day. The HTML carries the link, so
    // it is not kept a minute longer than the PDF.
    pending: { type: new mongoose.Schema({ html: String, text: String, bytes: Buffer }, { _id: false }), select: false },
    shareLinkId: { type: mongoose.Schema.Types.ObjectId, ref: "ShareLink" }, // the id, never the token
    openedAt: { type: Date, default: null }, // the customer opened the link and the page loaded
    provider: { type: String },
    providerMessageId: { type: String, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    attempts: { type: Number, default: 0 },
    retryable: { type: Boolean, default: false },
    nextRetryAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    lastErrorCode: { type: String, default: null },
    idempotencyKey: { type: String },
    sentBy: { type: String },
    sentByName: { type: String },
    queuedAt: { type: Date, default: Date.now },
    sentAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    history: [{ status: String, at: { type: Date, default: Date.now }, note: String, _id: false }],
  },
  { timestamps: true }
);
// The double-click guard. Partial, so rows with no key (old, or made by a script) never collide.
sendSchema.index({ companyId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
sendSchema.index({ companyId: 1, sourceType: 1, sourceId: 1, createdAt: -1 }); // one document's history
sendSchema.index({ companyId: 1, status: 1, nextRetryAt: 1 }); // the background pass
sendSchema.index({ companyId: 1, createdAt: -1 });
sendSchema.index({ companyId: 1, partyId: 1, createdAt: -1 });
sendSchema.index({ shareLinkId: 1 }, { sparse: true });
sendSchema.index({ companyId: 1, providerMessageId: 1 }, { sparse: true }); // the future webhook's lookup

const shareSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // tenancy is read from the row, never from the request
    publicId: { type: String, required: true, unique: true }, // the non-secret selector
    secretHash: { type: String, required: true }, // SHA-256 of the secret. The token itself is never stored.
    docType: { type: String, enum: DOC_TYPES, required: true },
    sourceType: { type: String, enum: SOURCE_TYPES, required: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
    documentNo: { type: String },
    partyId: { type: mongoose.Schema.Types.ObjectId },
    // The document as it was when it was sent: frozen, and built from a whitelist (utils/shareSnapshot).
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    // Checked in code. There is NO TTL index: deleting an expired row would delete the proof the
    // customer opened it, which is the reason the link exists.
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    revokeReason: { type: String, default: null },
    createdBy: { type: String },
    // Mail scanners and chat previews fetch a link before any person sees it, so a raw fetch proves
    // nothing. fetchCount counts every one; viewCount and firstViewedAt count only the signal the
    // page sends once it has really loaded, which a scanner does not run.
    fetchCount: { type: Number, default: 0 },
    lastFetchAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
    firstViewedAt: { type: Date, default: null },
    lastViewedAt: { type: Date, default: null },
    views: [{ at: Date, ip: String, ua: String, _id: false }], // capped at 20 by the writer
  },
  { timestamps: true }
);
shareSchema.index({ companyId: 1, sourceType: 1, sourceId: 1, createdAt: -1 });
shareSchema.index({ companyId: 1, expiresAt: 1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
settingsSchema.plugin(tenantPlugin);
sendSchema.plugin(tenantPlugin);
shareSchema.plugin(tenantPlugin);

module.exports = {
  MessagingSettings: mongoose.model("MessagingSettings", settingsSchema),
  DocumentSend: mongoose.model("DocumentSend", sendSchema),
  ShareLink: mongoose.model("ShareLink", shareSchema),
  DOC_TYPES, SOURCE_TYPES, SEND_STATUSES,
};
