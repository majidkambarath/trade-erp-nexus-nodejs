// A question Zarvia AI could not answer, waiting for one of us.
//
// Kept on the PLATFORM side and deliberately NOT tenant scoped: the whole value is reading one
// queue across every organisation, and a console route opens no organisation scope, so a scoped
// model would be invisible to it. The organisation is a plain `organisation` field holding its
// code, exactly as models/platform/platformAuditModel.js does - naming it companyId would make
// utils/__tests__/tenantGuard.test.js require the tenant plugin, which is the opposite of what
// this model is for.
const mongoose = require("mongoose");

const STATUSES = ["NEW", "OPEN", "ANSWERED", "CLOSED"];

const supportRequestSchema = new mongoose.Schema(
  {
    organisation: { type: String, required: true, index: true },
    organisationName: { type: String, default: "" },
    // Who asked. Enough to reply to them without opening their organisation.
    adminId: { type: String, default: "" },
    personName: { type: String, default: "" },
    personEmail: { type: String, default: "" },
    role: { type: String, default: "" },
    // Where they were and what had just been refused. This is the context that makes a support
    // request answerable without a conversation: the screen and the error code are usually enough.
    screen: { type: String, default: "" },
    errorCode: { type: String, default: "" },
    question: { type: String, required: true, maxlength: 2200 },
    // The assistant's own one-line triage, and what it had already tried.
    aiSummary: { type: String, default: "", maxlength: 500 },
    citations: [{ _id: false, title: String }],
    transcript: [{ _id: false, question: String, answer: String, at: Date }],
    messageId: { type: String, default: "" },
    status: { type: String, enum: STATUSES, default: "NEW", index: true },
    assignedTo: { type: String, default: "" },
    reply: { type: String, default: "" },
    repliedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

supportRequestSchema.index({ status: 1, createdAt: -1 });
supportRequestSchema.index({ organisation: 1, createdAt: -1 });

module.exports = {
  STATUSES,
  SupportRequest: mongoose.models.SupportRequest || mongoose.model("SupportRequest", supportRequestSchema),
};
