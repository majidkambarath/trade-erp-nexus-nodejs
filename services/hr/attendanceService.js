const AttendanceDay = require("../../models/modules/hr/attendanceDayModel");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/attendance");
const { HolidayService } = require("./timeSetupService");
const Shift = require("../../models/modules/hr/shiftModel");
const { isCalendarDay, todayInOrg } = require("../../utils/documentExpiry");

// How many muster rows one read may return. The default serves a day or a short range; a caller that needs
// a whole month of every employee (the month matrix) asks for what it needs and is clamped to the ceiling,
// so neither a forgetful caller nor a hand-typed ?limit= can turn this into an unbounded read.
const DEFAULT_MUSTER_ROWS = 2000;
const MAX_MUSTER_ROWS = 20000;

/**
 * The muster: one row per employee per day, its status STAMPED at write time from utils/attendance.js
 * dayStatus - never recomputed on read, the same reason a labour cost line's rate is stamped, not looked up
 * fresh (utils/hr.js rule 2): a half-day cutoff changed next month must not silently rewrite last month's
 * attendance record.
 */
class AttendanceService {
  /** One employee's one day, present/half-day/absent/holiday/weekly-off/on-leave - from real punches, or a
   * plain manual mark (present/absent/on_leave with no punches at all, for a day nobody clocked in). */
  static async markDay(data, by) {
    const errors = rules.validateAttendanceRow(data);
    if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code, { errors, field: errors[0].field });
    if (!isCalendarDay(data.day)) throw new AppError("Enter a real day", 400, "INVALID_DAY");

    const staff = await Staff.findById(data.staffId).select("_id");
    if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");

    const isHoliday = await HolidayService.isHoliday(data.day);
    const shift = data.shiftId ? await Shift.findById(data.shiftId).lean() : null;
    const hours = data.checkIn && data.checkOut ? rules.hoursWorked(data.checkIn, data.checkOut) : null;
    // A manual status (present/absent/on_leave with no punches) is taken as given rather than derived -
    // there is nothing to derive it FROM. Real punches always decide for themselves, never overridden by a
    // status somebody also typed.
    const status = hours !== null
      ? rules.dayStatus({ isHoliday, isWeeklyOff: Boolean(data.isWeeklyOff), approvedLeave: Boolean(data.approvedLeave), checkIn: data.checkIn, checkOut: data.checkOut, halfDayBelowHours: shift?.halfDayBelowHours })
      : (data.status || (isHoliday ? "holiday" : "absent"));

    const set = {
      shiftId: data.shiftId || null, checkIn: data.checkIn || null, checkOut: data.checkOut || null,
      status, hoursWorked: hours, overtimeHours: hours !== null ? rules.overtimeHours(hours, shift?.hours) : null,
      // "self" (the employee's own punch, D15) must survive here too - a check against only "import" sent
      // every self-service punch back as "manual", which is indistinguishable from an HR clerk's own entry.
      source: ["import", "self"].includes(data.source) ? data.source : "manual",
      notes: data.notes, updatedBy: by,
    };
    return AttendanceDay.findOneAndUpdate(
      { staffId: data.staffId, day: data.day },
      { $set: set, $setOnInsert: { createdBy: by } },
      { new: true, upsert: true, runValidators: true }
    );
  }

  /** The muster for a range, newest first - the screen's own listing, and what U3 (idle labour) reads
   * paid hours from (labourCostService.idleFor).
   *
   * `limit` exists because the month matrix asks for a WHOLE month at once: at ~65 active employees x 31
   * days the old flat 2000 cap bit, and since the sort is newest day first the rows it dropped were the
   * EARLIEST days of the month being looked at - which rendered as "Not marked" for people who had been
   * marked. A silent wrong answer is the worst failure a muster can have, so a caller that knows how many
   * rows it needs may say so. It is clamped either way: a query value is never trusted, and no caller can
   * ask for an unbounded read. */
  static async muster({ from, to, staffId, limit } = {}) {
    const q = {};
    if (from || to) q.day = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    if (staffId) q.staffId = staffId;
    const asked = Number(limit);
    const cap = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), MAX_MUSTER_ROWS) : DEFAULT_MUSTER_ROWS;
    const rows = await AttendanceDay.find(q).sort({ day: -1, staffId: 1 }).limit(cap).select("-location").lean();
    const staff = await Staff.find({ _id: { $in: [...new Set(rows.map((r) => String(r.staffId)))] } }).select("name staffId").lean();
    const byId = new Map(staff.map((s) => [String(s._id), s]));
    return rows.map((r) => ({ ...r, staffName: byId.get(String(r.staffId))?.name, staffCode: byId.get(String(r.staffId))?.staffId }));
  }

  /** One day across every employee - the muster screen's own "pick a day" reading on a phone. */
  static async forDay(day) {
    if (!isCalendarDay(day)) throw new AppError("Enter a real day", 400, "INVALID_DAY");
    return this.muster({ from: day, to: day });
  }

  /** Paid hours an employee was marked present/half-day for, on one day - what idle labour (U3) is
   * measured against. Null when there is no row at all, never 0 (utils/hr.js rule 1's own reasoning):
   * a day nobody marked is unknown, not a day with zero hours worked. */
  static async paidHoursOn(staffId, day) {
    const row = await AttendanceDay.findOne({ staffId, day }).select("hoursWorked status").lean();
    if (!row) return null;
    return ["present", "half_day"].includes(row.status) ? (row.hoursWorked || 0) : 0;
  }

  /** The same figure for many (staffId, day) pairs at once - one query, not one per pair (U3 reads this
   * for every employee/day a process order's or a job card's labour touches). -> Map keyed "staffId|day". */
  static async paidHoursForMany(pairs) {
    const unique = [...new Map(pairs.filter((p) => p?.staffId && p?.day).map((p) => [`${p.staffId}|${p.day}`, p])).values()];
    if (!unique.length) return new Map();
    const rows = await AttendanceDay.find({
      $or: unique.map((p) => ({ staffId: p.staffId, day: p.day })),
    }).select("staffId day hoursWorked status").lean();
    const out = new Map();
    for (const r of rows) {
      out.set(`${r.staffId}|${r.day}`, ["present", "half_day"].includes(r.status) ? (r.hoursWorked || 0) : 0);
    }
    return out;
  }
}

// Exposed so a caller sizing its own read (and the test that pins the clamp) names the same numbers.
AttendanceService.DEFAULT_MUSTER_ROWS = DEFAULT_MUSTER_ROWS;
AttendanceService.MAX_MUSTER_ROWS = MAX_MUSTER_ROWS;

module.exports = AttendanceService;
