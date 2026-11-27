const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// A business record removed from its own collection, kept whole: who removed it, when, from where and why
// (utils/auditPlugin.js writes it in the same transaction as the delete). Nothing in the application changes or removes
// a row here; it is what "no hard deletes" means for the records that may still be deleted (a draft, an unused master).
const deletedRecordSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    label: { type: String, trim: true }, // the record's number or name, for a list
    data: { type: mongoose.Schema.Types.Mixed, required: true },
    deletedAt: { type: Date, default: Date.now },
    deletedBy: { type: String, default: null },
    deletedByName: { type: String, default: null },
    ip: { type: String, default: null },
    reason: { type: String, trim: true, maxlength: 300 },
  },
  { versionKey: false, minimize: false }
);

deletedRecordSchema.index({ companyId: 1, deletedAt: -1 });
deletedRecordSchema.index({ companyId: 1, entity: 1, entityId: 1 });

deletedRecordSchema.plugin(tenantPlugin);

// append-only, like the audit log
const REFUSE = ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete"];
deletedRecordSchema.pre(REFUSE, function refuse() {
  const err = new Error("A deleted record is kept as it was: it cannot be changed or removed");
  err.code = "DELETED_RECORD_IMMUTABLE";
  err.statusCode = 409;
  err.isOperational = true;
  throw err;
});
deletedRecordSchema.pre("save", function onlyNew() {
  if (!this.isNew) throw Object.assign(new Error("A deleted record cannot be changed"), { code: "DELETED_RECORD_IMMUTABLE", statusCode: 409, isOperational: true });
});

module.exports = mongoose.model("DeletedRecord", deletedRecordSchema);
