const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// One person's connection to their own Google account, for creating a Meet link and putting the meeting in their own
// Google Calendar.
//
// It is PER PERSON, not per organisation: the event belongs in the organiser's diary and the Meet link is minted by
// their account, so two salespeople connect separately and neither can act as the other.
//
// The tokens are stored encrypted (utils/secretBox.js, the same box as the messaging keys and the two-factor secrets)
// and are `select: false`, so a stray read or a lean() can never hand them to a screen. A refresh token is a standing
// key to somebody's calendar: it is written in one place and read in one place.
const googleAccountSchema = new mongoose.Schema(
  {
    adminId: { type: String, required: true }, // the person, as everything else in the CRM names them
    email: { type: String, trim: true, lowercase: true, default: "" }, // the Google account, so a screen can name it

    accessTokenEnc: { type: String, default: null, select: false },
    refreshTokenEnc: { type: String, default: null, select: false },
    expiresAt: { type: Date, default: null },
    scope: { type: String, default: "" },

    connectedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    // The last thing Google said that a person has to act on ("connect the account again"); cleared on success.
    lastError: { type: String, default: null },

    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  },
  { timestamps: true }
);

// One connection per person per organisation. Declared with schema.index so the tenant plugin can put companyId in
// front of it: a field-level `unique` would be global, and two organisations' people would collide.
googleAccountSchema.index({ adminId: 1 }, { unique: true });

googleAccountSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.GoogleAccount || mongoose.model("GoogleAccount", googleAccountSchema);
