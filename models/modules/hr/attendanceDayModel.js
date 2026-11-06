const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * One employee's one day: the punches, the status utils/attendance.js dayStatus worked out from them, and
 * the hours. branchScoped like Staff itself - an employee's attendance belongs to the branch they work in.
 *
 * `source` is how the row arrived: `manual` (typed on the muster), `import` (the spreadsheet importer,
 * utils/crmImport.js's own shape reused rather than rebuilt), or `self` (wave 5's employee portal punch,
 * with a geofence - the field exists from this wave on so it is not added late).
 */
const attendanceDaySchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the employee's branch; head office is "main"
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: "Shift", default: null },
    checkIn: { type: Date, default: null },
    checkOut: { type: Date, default: null },
    // Stamped at write time by the service, from utils/attendance.js dayStatus - never recomputed on read,
    // the same "a past fact is not re-derived from today's rules" instinct utils/hr.js stamping rule holds
    // for a labour line's cost rate: a half-day cutoff changed next month must not rewrite last month's
    // musters.
    status: { type: String, enum: ["present", "half_day", "absent", "on_leave", "holiday", "weekly_off"], required: true },
    hoursWorked: { type: Number, default: null },
    overtimeHours: { type: Number, default: null },
    source: { type: String, enum: ["manual", "import", "self"], default: "manual" },
    // where a self-service punch was made, for the geofence check wave 5 adds - carried from day one so it
    // is not a field bolted on late
    location: { lat: { type: Number }, lng: { type: Number } },
    notes: { type: String, trim: true, maxlength: 300 },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

attendanceDaySchema.index({ staffId: 1, day: 1 }, { unique: true }); // one row per employee per day
attendanceDaySchema.index({ day: 1, status: 1 }); // the muster's own listing

attendanceDaySchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("AttendanceDay", attendanceDaySchema);
