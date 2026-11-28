// A file a client uploaded with their onboarding form: their customer, supplier and item lists, opening balances, trade
// licence, tax certificate, logo. Kept apart from the request so reading a list of requests never reads megabytes of
// files, and the bytes are `select: false` so even a read of the file row does not carry them unless asked.
//
// Held in the database rather than in the attachment store because that store (services/core/attachmentService.js) is
// an organisation's, and these belong to no organisation yet. Each is at most 5 MB (utils/clientOnboarding.js LIMITS).
const mongoose = require("mongoose");

const onboardingFileSchema = new mongoose.Schema(
  {
    requestId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, required: true },
    name: { type: String, required: true, maxlength: 200 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true, select: false },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.models.OnboardingFile || mongoose.model("OnboardingFile", onboardingFileSchema);
