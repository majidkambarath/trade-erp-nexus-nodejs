const mongoose = require("mongoose");

// Append-only record of who changed what. Configuration changes (account mapping, e-invoice
// settings, period close) are logged as well as documents, because those are what an auditor
// asks about. Rows are never updated or deleted by the application.
const activityLogSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    at: { type: Date, default: Date.now },
    userId: { type: String, default: null },
    username: { type: String, default: null },
    action: { type: String, required: true }, // e.g. ACCOUNT_CREATED, PERIOD_CLOSED, CREDIT_BLOCKED
    entity: { type: String, required: true }, // e.g. LedgerAccount, FiscalYear, Transaction
    entityId: { type: String, default: null },
    summary: { type: String, maxlength: 500 },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: null },
  },
  { versionKey: false }
);

activityLogSchema.index({ companyId: 1, at: -1 });
activityLogSchema.index({ companyId: 1, entity: 1, entityId: 1, at: -1 });
activityLogSchema.index({ companyId: 1, action: 1, at: -1 });

module.exports = mongoose.model("ActivityLog", activityLogSchema);
