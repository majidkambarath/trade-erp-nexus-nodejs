const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// Organisation-wide, like LeaveType and Shift. Designations stay free text (Staff.designation) on
// purpose - they vary far more than departments do in practice, and a second master for them was not
// asked for; a department is the one structured grouping worth a headcount report.
const departmentSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

departmentSchema.index({ name: 1 }, { unique: true });
departmentSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Department", departmentSchema);
