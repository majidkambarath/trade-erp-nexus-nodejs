const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * A leave type an organisation offers (Annual, Sick, Casual, ...) and its own accrual rate - organisation-wide,
 * like a tax code or a shift. The ACCRUAL RATE lives here, as a field the organisation sets, rather than in
 * StatutoryRule: unlike gratuity or Emiratisation, leave entitlement is something every organisation names
 * and configures for itself (a UAE employer must offer at least the statutory 30 days annual leave, but how
 * it is split into types, and anything beyond the statutory minimum, is the organisation's own policy).
 */
const leaveTypeSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    name: { type: String, required: true, trim: true, maxlength: 80 },
    accrualPerMonth: { type: Number, required: true, min: 0 }, // utils/leave.js leaveBalance's own rate
    maxCarryForward: { type: Number, min: 0, default: null }, // null: no cap stated
    isPaid: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

leaveTypeSchema.index({ name: 1 }, { unique: true });

leaveTypeSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("LeaveType", leaveTypeSchema);
