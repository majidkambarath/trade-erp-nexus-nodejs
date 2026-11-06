const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * A shift: its hours, and the half-day cutoff utils/attendance.js dayStatus reads. Organisation-wide, like
 * tax codes and the chart - a shift is a PATTERN the organisation defines, not a document that belongs to
 * one branch (an employee working it is what is per-branch, on EmployeeDocument's sibling, AttendanceDay).
 */
const shiftSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Stored as "HH:MM" in the organisation's own clock - deliberately not a Date, which would need a day
    // attached to mean anything; a shift's start and end are a TIME OF DAY, every day it runs.
    startTime: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    endTime: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
    hours: { type: Number, required: true, min: 0, max: 24 }, // the shift's own length - utils/attendance.js overtimeHours' divisor
    halfDayBelowHours: { type: Number, min: 0, default: null }, // null: no half-day reading for this shift
    isActive: { type: Boolean, default: true },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

shiftSchema.index({ name: 1 }, { unique: true });

shiftSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Shift", shiftSchema);
