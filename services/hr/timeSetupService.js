// The three small organisation-wide masters attendance and leave read: Shift, HolidayCalendar, LeaveType.
// Kept in one file because each is a short CRUD list, the same reasoning garageSetupService.js groups bays
// and the service menu together rather than one file per master.
const Shift = require("../../models/modules/hr/shiftModel");
const HolidayCalendar = require("../../models/modules/hr/holidayCalendarModel");
const LeaveType = require("../../models/modules/hr/leaveTypeModel");
const AppError = require("../../utils/AppError");
const { isCalendarDay } = require("../../utils/documentExpiry");

class ShiftService {
  static list() {
    return Shift.find().sort({ name: 1 }).lean();
  }
  static async create(data, by) {
    if (!data?.name?.trim()) throw new AppError("Name the shift", 400, "VALIDATION_ERROR");
    if (!/^\d{2}:\d{2}$/.test(data?.startTime || "") || !/^\d{2}:\d{2}$/.test(data?.endTime || "")) {
      throw new AppError("Give the start and end time as HH:MM", 400, "VALIDATION_ERROR");
    }
    if (!(Number(data?.hours) > 0)) throw new AppError("The shift's own length, in hours", 400, "VALIDATION_ERROR");
    return Shift.create({
      name: data.name.trim(), startTime: data.startTime, endTime: data.endTime, hours: Number(data.hours),
      halfDayBelowHours: data.halfDayBelowHours === "" || data.halfDayBelowHours === undefined ? null : Number(data.halfDayBelowHours),
      createdBy: by,
    });
  }
  static async update(id, data, by) {
    const set = { updatedBy: by };
    for (const f of ["name", "startTime", "endTime", "hours", "halfDayBelowHours", "isActive"]) if (f in data) set[f] = data[f];
    const row = await Shift.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true });
    if (!row) throw new AppError("Shift not found", 404, "SHIFT_NOT_FOUND");
    return row;
  }
  static async remove(id) {
    const r = await Shift.deleteOne({ _id: id });
    if (!r.deletedCount) throw new AppError("Shift not found", 404, "SHIFT_NOT_FOUND");
    return { removed: true };
  }
}

class HolidayService {
  static list({ from, to } = {}) {
    const q = {};
    if (from || to) q.day = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    return HolidayCalendar.find(q).sort({ day: 1 }).lean();
  }
  static async isHoliday(day) {
    return Boolean(await HolidayCalendar.findOne({ day }).lean());
  }
  static async create(data, by) {
    if (!isCalendarDay(data?.day)) throw new AppError("Enter a real day", 400, "INVALID_DAY");
    if (!data?.name?.trim()) throw new AppError("Name the holiday", 400, "VALIDATION_ERROR");
    const clash = await HolidayCalendar.findOne({ day: data.day });
    if (clash) throw new AppError("That day is already a holiday", 409, "HOLIDAY_EXISTS");
    return HolidayCalendar.create({ day: data.day, name: data.name.trim(), createdBy: by });
  }
  static async remove(id) {
    const r = await HolidayCalendar.deleteOne({ _id: id });
    if (!r.deletedCount) throw new AppError("Holiday not found", 404, "HOLIDAY_NOT_FOUND");
    return { removed: true };
  }
}

class LeaveTypeService {
  static list() {
    return LeaveType.find().sort({ name: 1 }).lean();
  }
  static async create(data, by) {
    if (!data?.name?.trim()) throw new AppError("Name the leave type", 400, "VALIDATION_ERROR");
    if (!(Number(data?.accrualPerMonth) >= 0)) throw new AppError("Give the accrual rate, days a month", 400, "VALIDATION_ERROR");
    return LeaveType.create({
      name: data.name.trim(), accrualPerMonth: Number(data.accrualPerMonth),
      maxCarryForward: data.maxCarryForward === "" || data.maxCarryForward === undefined ? null : Number(data.maxCarryForward),
      isPaid: data.isPaid !== false, createdBy: by,
    });
  }
  static async update(id, data, by) {
    const set = { updatedBy: by };
    for (const f of ["name", "accrualPerMonth", "maxCarryForward", "isPaid", "isActive"]) if (f in data) set[f] = data[f];
    const row = await LeaveType.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true });
    if (!row) throw new AppError("Leave type not found", 404, "LEAVE_TYPE_NOT_FOUND");
    return row;
  }
  static async remove(id) {
    const r = await LeaveType.deleteOne({ _id: id });
    if (!r.deletedCount) throw new AppError("Leave type not found", 404, "LEAVE_TYPE_NOT_FOUND");
    return { removed: true };
  }
}

module.exports = { ShiftService, HolidayService, LeaveTypeService };
