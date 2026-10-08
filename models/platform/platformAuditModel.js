// What the developers did to organisations: created, changed, extended, suspended. Kept apart from an
// organisation's own audit trail, which a customer can read, so an organisation never sees the product's
// internal notes about it - though the same events are also written to that organisation's own trail, in
// words fit for them, by the controller.
const mongoose = require("mongoose");

const platformAuditSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    by: { type: String, default: null }, // the platform user's email
    action: { type: String, required: true },
    organisation: { type: String, default: null, index: true }, // the organisation code, when there is one
    summary: { type: String, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { versionKey: false }
);

module.exports = mongoose.models.PlatformAudit || mongoose.model("PlatformAudit", platformAuditSchema);
