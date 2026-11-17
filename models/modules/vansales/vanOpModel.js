const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// One operation a phone did while it had no signal (a sale, a payment, a return, a visit), applied when it synced.
// Written in the SAME transaction as the document it made, keyed on the phone's own id for the operation, so the same
// operation sent twice (a sync that timed out after the server had done it) makes exactly one invoice. A refused
// operation writes nothing here: the phone keeps it, the person fixes it, and it is sent again.
const opSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, trim: true, maxlength: 64 },
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "VanTrip", required: true },
    kind: { type: String, enum: ["sell", "collect", "return", "visit"], required: true },
    at: Date, // when the phone did it
    result: { type: mongoose.Schema.Types.Mixed }, // the numbers and ids it made, sent back on a repeat
    by: String,

    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
  },
  { timestamps: true }
);

opSchema.index({ clientId: 1 }, { unique: true });
opSchema.index({ tripId: 1, createdAt: 1 });

opSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.VanOp || mongoose.model("VanOp", opSchema);
