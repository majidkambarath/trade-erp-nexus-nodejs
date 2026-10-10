const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// One row per signed-in browser. The refresh token (kept in an httpOnly cookie) names its session,
// so logging out ends exactly that session, and an admin's sessions can be listed or revoked.
// Rows are removed by the TTL index once the refresh token could no longer be used anyway.
const authSessionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // session id, carried as `sid` in the tokens
    companyId: { type: String, required: true }, // the organisation the session belongs to
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true, index: true },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date, default: null },
    // Rotation of the refresh cookie: every refresh replaces the token with a new one (a new `jti`). `refreshJti` is the one that is
    // current; `prevRefreshJti` the one before it, still honoured for a few seconds (`rotatedAt`) because two tabs may refresh together.
    // A refresh token that is neither is a copy somebody kept: presenting it ends the whole session. Empty on a session that began
    // before rotation existed: its first refresh adopts it.
    refreshJti: { type: String, default: null },
    prevRefreshJti: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
  },
  { versionKey: false }
);

authSessionSchema.plugin(tenantPlugin);

module.exports = mongoose.model("AuthSession", authSessionSchema);
