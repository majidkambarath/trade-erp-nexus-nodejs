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

// every change a person makes is logged with its old and new values, and a deleted record is kept (utils/auditPlugin.js)
departmentSchema.plugin(require("../../../utils/auditPlugin"), { entity: "Department" });
module.exports = mongoose.model("Department", departmentSchema);
