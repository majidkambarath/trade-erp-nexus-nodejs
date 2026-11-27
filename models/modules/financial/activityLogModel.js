const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

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
    // the fields that changed, old and new (utils/auditDiff.js); absent on rows written before it existed
    changes: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    ip: { type: String, default: null },
  },
  { versionKey: false }
);

activityLogSchema.index({ companyId: 1, at: -1 });
activityLogSchema.index({ companyId: 1, entity: 1, entityId: 1, at: -1 });
activityLogSchema.index({ companyId: 1, action: 1, at: -1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
activityLogSchema.plugin(tenantPlugin);

// Append-only, enforced and not only promised: nothing may change or remove a row once written, so what the log says
// happened stays what it said. (A database administrator can still drop the collection; that is what backups are for.)
const REFUSE = ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"];
const immutable = () => Object.assign(new Error("The audit log cannot be changed or deleted"), { code: "AUDIT_LOG_IMMUTABLE", statusCode: 409, isOperational: true });
activityLogSchema.pre(REFUSE, { document: false, query: true }, function refuse() { throw immutable(); });
activityLogSchema.pre("deleteOne", { document: true, query: false }, function refuseDoc() { throw immutable(); });
activityLogSchema.pre("bulkWrite", function refuseBulk(next, ops) {
  if ((ops || []).some((op) => !op.insertOne)) throw immutable();
  next();
});
activityLogSchema.pre("save", function onlyNew() { if (!this.isNew) throw immutable(); });

module.exports = mongoose.model("ActivityLog", activityLogSchema);
