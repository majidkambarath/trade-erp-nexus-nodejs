const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * One public or company holiday, by day - organisation-wide (a holiday calendar is set once, not per
 * branch, the same reasoning a fiscal year is organisation-wide even though documents post per branch).
 * utils/attendance.js dayStatus reads whether a given day is one of these before anything else.
 */
const holidaySchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // the organisation's own calendar day
    name: { type: String, required: true, trim: true, maxlength: 120 },
    createdBy: { type: String },
  },
  { timestamps: true }
);

holidaySchema.index({ day: 1 }, { unique: true }); // one holiday per day, per organisation

holidaySchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("HolidayCalendar", holidaySchema);
