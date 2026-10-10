const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// One row per password-reset link that was emailed. The link's token is NEVER stored: `_id` is its SHA-256, so a copy of this
// collection opens nothing, and finding the row from a token is hashing it (utils/accountTokens.js). The id is the secret's
// hash, so it needs no unique index of its own and the lookup is by primary key.
//
// A link is good once (`usedAt`) and for thirty minutes; a newer request supersedes the older links of the same person
// (`supersededAt`) - they are kept, not deleted, so the number of requests in the last hour can still be counted. Rows go
// away by themselves a while after they expire (the TTL index), so a used or lapsed link answers "no longer valid" for a time
// and then simply does not exist.
const passwordResetSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // sha256 of the token in the emailed link
    companyId: { type: String, required: true }, // the organisation of the person it was made for
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    supersededAt: { type: Date, default: null }, // a newer request (or a successful reset) replaced it: the row stays, so the requests per hour can be counted
    requestedFrom: { type: String, default: null }, // a coarse address of whoever asked, as evidence (middleware/rateLimit.js coarseIp)
    // kept for a day past expiry so "this link has been used" can be told apart from "this link never existed" in an investigation
    purgeAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { versionKey: false }
);

passwordResetSchema.plugin(tenantPlugin);

module.exports = mongoose.model("PasswordReset", passwordResetSchema);
