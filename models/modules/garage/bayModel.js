const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A bay: a physical work slot (a ramp, a lift, a paint booth). Branch scoped, like a document - the plant at one
// branch has nothing to do with another's. A task on a job card may name one (jobCardModel.js taskSchema.bayId),
// which is how bay utilisation is worked out (utils/garage.js analysis reads jobs, not this; the bay list itself
// is a plain master read by the picker, GET /garage/bays).
const baySchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 60, required: true },
    code: { type: String, trim: true, maxlength: 20, default: "" },
    kind: { type: String, enum: ["mechanical", "body", "paint", "wash", "other"], default: "mechanical" },
    active: { type: Boolean, default: true },
    notes: { type: String, trim: true, maxlength: 300, default: "" },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
  },
  { timestamps: true }
);

baySchema.index({ name: 1 });
baySchema.index({ active: 1 });

baySchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.Bay || mongoose.model("Bay", baySchema);
