// A new client's onboarding form: the private link a developer sends, and everything the client writes into it before
// their organisation is made.
//
// Kept on the PLATFORM side and deliberately NOT tenant scoped, like models/platform/supportRequestModel.js: the
// organisation does not exist yet, so there is nothing to scope by, and the console (which opens no organisation scope)
// must read every request. Naming the eventual organisation `organisationCode` rather than companyId keeps
// utils/__tests__/tenantGuard.test.js from asking for the tenant plugin, which is the opposite of what this model is for.
//
// The link is `publicId.secret` (utils/shareToken.js): the public reader finds the row by its selector and compares the
// secret's hash, so the token itself is never stored and a lost link is made again, never recovered.
const mongoose = require("mongoose");

const STATUSES = ["invited", "in_progress", "submitted", "created", "revoked"];

const fileSchema = new mongoose.Schema(
  {
    // the same _id as the OnboardingFile holding the bytes
    kind: { type: String, required: true },
    name: { type: String, required: true, maxlength: 200 },
    size: { type: Number, required: true },
    mimeType: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  { at: { type: Date, default: Date.now }, by: { type: String, default: "" }, action: { type: String, required: true }, note: { type: String, default: "" } },
  { _id: false }
);

const onboardingRequestSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true },
    secretHash: { type: String, required: true, select: false },

    // who the developer sent it to (the client's own answers are in `answers`)
    clientName: { type: String, required: true, maxlength: 120 },
    contactName: { type: String, default: "", maxlength: 80 },
    contactEmail: { type: String, default: "", maxlength: 254 },
    contactPhone: { type: String, default: "", maxlength: 25 },
    note: { type: String, default: "", maxlength: 1000 },
    planCode: { type: String, default: "standard" },

    status: { type: String, enum: STATUSES, default: "invited", index: true },
    expiresAt: { type: Date, required: true },

    // utils/clientOnboarding.js normaliseAnswers decides the shape; nothing reaches here any other way
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },
    files: [fileSchema],

    openedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    views: { type: Number, default: 0 },
    savedAt: { type: Date, default: null },
    submittedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },

    // set while an organisation is being made from it, so two developers cannot make two
    creatingAt: { type: Date, default: null },
    organisationCode: { type: String, default: null, index: true },
    organisationCreatedAt: { type: Date, default: null },
    // what was applied to the organisation when it was made, and the accounts made since (never their passwords)
    applied: { type: mongoose.Schema.Types.Mixed, default: null },
    usersCreated: [{ _id: false, email: String, name: String, role: String, at: Date }],

    createdBy: { type: String, default: "" }, // the developer's email
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true, versionKey: false, minimize: false }
);

// the public selector: the reader finds the row by it with no organisation known (tenantGuard GLOBAL_UNIQUE lists it)
onboardingRequestSchema.index({ publicId: 1 }, { unique: true });
onboardingRequestSchema.index({ status: 1, updatedAt: -1 });

module.exports = {
  STATUSES,
  OnboardingRequest: mongoose.models.OnboardingRequest || mongoose.model("OnboardingRequest", onboardingRequestSchema),
};
