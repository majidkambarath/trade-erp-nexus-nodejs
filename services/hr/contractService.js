const mongoose = require("mongoose");
const EmployeeContract = require("../../models/modules/hr/employeeContractModel");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const hr = require("../../utils/hr");
const { addDays, todayInOrg } = require("../../utils/documentExpiry");
const { withTransactionSession } = require("../../utils/withTransactionSession");

// The pay figures. They are `select: false` on the schema so no read hands them out by accident, which means
// every read that genuinely needs them has to ask here, in one place.
const PAY = "+basicPay +allowances +otherMonthlyCost +costPerHour +hoursPerMonth";
const PAY_FIELDS = ["basicPay", "allowances", "otherMonthlyCost", "costPerHour", "hoursPerMonth"];

/**
 * An employee's pay history, and the one place a cost per hour is looked up.
 *
 * A contract is never edited into a new rate: a rise is a NEW row, and the row it replaces is closed the day
 * before. That is what lets a posted order keep the cost it was really built at (utils/hr.js rule 2), and what
 * will let payroll check a salary against the contract lodged with the ministry.
 */
class ContractService {
  /** Whether the employee exists in this organisation (and this branch, when one is in view). */
  static async assertEmployee(staffId, session = null) {
    if (!mongoose.isValidObjectId(staffId)) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    const q = Staff.findById(staffId).select("_id name staffId");
    const found = await (session ? q.session(session) : q);
    if (!found) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
    return found;
  }

  /**
   * An employee's contracts, newest first.
   *
   * `confidential` is the whole point: without it the history is still returned - when somebody was on what
   * terms is an ordinary part of a personnel file - but with every money figure removed. A reader who may
   * keep the directory tidy is not thereby a reader who may price their colleagues.
   */
  static async list(staffId, { confidential = false } = {}) {
    await this.assertEmployee(staffId);
    const q = EmployeeContract.find({ staffId }).sort({ effectiveFrom: -1 });
    const rows = await (confidential ? q.select(PAY) : q).lean();
    if (confidential) return rows.map((r) => ({ ...r, hourlyCost: hr.hourlyCost(r), monthlyCost: hr.monthlyCost(r) }));
    // `hasPay` keeps the screen honest: it can say "a cost rate is on file" (so nobody wonders why the
    // labour costed) without saying what it is.
    return rows.map((r) => {
      const row = { ...r };
      for (const f of PAY_FIELDS) delete row[f];
      return row;
    });
  }

  /**
   * The cost per hour in force for an employee on a day, or null when there is none.
   *
   * null means "this person cannot be costed" and is NEVER 0 (utils/hr.js rule 1): the caller turns it into
   * something somebody sees, rather than costing the work at nothing.
   */
  static async rateOn(staffId, day, { session } = {}) {
    const q = EmployeeContract.find({ staffId }).select(PAY);
    const rows = await (session ? q.session(session) : q).lean();
    return hr.rateOn(rows, day);
  }

  /**
   * Every contract of several employees, in ONE query, as a Map of staffId -> contracts[].
   *
   * This is what callers that cost work should use, rather than asking for a rate per row: a process order's
   * steps were worked on DIFFERENT days, each wanting the rate in force on its own day, and asking per step
   * is a query per step. Load the history once and let utils/hr.js `rateOn` pick the day locally.
   */
  static async contractsFor(staffIds, { session } = {}) {
    const ids = [...new Set((staffIds || []).filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const q = EmployeeContract.find({ staffId: { $in: ids } }).select(PAY);
    const rows = await (session ? q.session(session) : q).lean();
    const byStaff = new Map(ids.map((id) => [id, []]));
    for (const r of rows) byStaff.get(String(r.staffId))?.push(r);
    return byStaff;
  }

  /** The rate for many employees on ONE day: a Map of staffId -> rate|null. */
  static async ratesOn(staffIds, day, { session } = {}) {
    const byStaff = await this.contractsFor(staffIds, { session });
    return new Map([...byStaff].map(([id, rows]) => [id, hr.rateOn(rows, day)]));
  }

  /**
   * Add a contract. The open contract it supersedes is CLOSED the day before this one starts - not edited to
   * the new figures - so the history reads as what was true when, and `contractOn` has exactly one answer for
   * every day.
   */
  static async create(data, by) {
    const errors = hr.validateContract(data);
    if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code, { errors, field: errors[0].field });

    return withTransactionSession(async (session) => {
      await this.assertEmployee(data.staffId, session);

      const clash = await EmployeeContract.findOne({ staffId: data.staffId, effectiveFrom: data.effectiveFrom }).session(session);
      if (clash) throw new AppError("This employee already has a contract starting that day", 409, "CONTRACT_EXISTS");

      // Close whatever was open and started earlier. A row starting LATER is left alone: somebody has entered
      // a future change, and closing it would be rewriting a decision already taken.
      const earlierOpen = await EmployeeContract.find({
        staffId: data.staffId,
        effectiveFrom: { $lt: data.effectiveFrom },
        $or: [{ effectiveTo: null }, { effectiveTo: { $gte: data.effectiveFrom } }],
      }).session(session);
      const dayBefore = addDays(data.effectiveFrom, -1);
      for (const row of earlierOpen) {
        await EmployeeContract.updateOne({ _id: row._id }, { $set: { effectiveTo: dayBefore, updatedBy: by } }).session(session);
      }

      const [created] = await EmployeeContract.create(
        [{
          staffId: data.staffId,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo || null,
          basicPay: num(data.basicPay),
          allowances: num(data.allowances),
          otherMonthlyCost: num(data.otherMonthlyCost),
          costPerHour: num(data.costPerHour),
          hoursPerMonth: num(data.hoursPerMonth),
          notes: typeof data.notes === "string" ? data.notes.trim() : undefined,
          createdBy: by,
        }],
        { session }
      );
      return created;
    })();
  }

  /**
   * Correct a contract. The money may be corrected (somebody mistyped the allowance) but NOT the day it
   * starts: that is what every stamped cost line was found by, so moving it would change which rate applied
   * to work already costed. Enter a new contract instead - which is the whole point of a history.
   */
  static async update(id, data, by) {
    const row = await EmployeeContract.findById(id);
    if (!row) throw new AppError("Contract not found", 404, "CONTRACT_NOT_FOUND");
    if ("effectiveFrom" in data && data.effectiveFrom !== row.effectiveFrom) {
      throw new AppError(
        "The day a contract starts cannot be changed - add a new contract from the new day instead",
        409,
        "CONTRACT_START_FIXED"
      );
    }
    const merged = { staffId: row.staffId, effectiveFrom: row.effectiveFrom, ...pick(data) };
    const errors = hr.validateContract(merged);
    if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code, { errors, field: errors[0].field });

    const set = { updatedBy: by };
    for (const f of [...PAY_FIELDS, "notes"]) if (f in data) set[f] = f === "notes" ? String(data[f] || "").trim() : num(data[f]);
    if ("effectiveTo" in data) set.effectiveTo = data.effectiveTo || null;
    await EmployeeContract.updateOne({ _id: id }, { $set: set });
    return EmployeeContract.findById(id).select(PAY);
  }

  static async remove(id) {
    const row = await EmployeeContract.findById(id);
    if (!row) throw new AppError("Contract not found", 404, "CONTRACT_NOT_FOUND");
    await EmployeeContract.deleteOne({ _id: id });
    // Deliberately does not reopen the contract this one closed: which day a rate ran to is a fact somebody
    // entered, and guessing it back would invent one. The screen shows the gap, and a contract is added to
    // fill it.
    return { removed: true };
  }

  /** What the organisation can cost today: how many active employees have a usable rate, and who does not. */
  static async coverage({ day } = {}) {
    const on = day || todayInOrg();
    const staff = await Staff.find({ status: "Active" }).select("_id name staffId designation").lean();
    const rates = await this.ratesOn(staff.map((s) => s._id), on);
    const without = staff.filter((s) => rates.get(String(s._id)) === null);
    return {
      day: on,
      employees: staff.length,
      costed: staff.length - without.length,
      // Named, because "7 of 12 employees have no cost rate" is useless and "Ravi, Anil and five others" is
      // something somebody can act on. No figures here - this is a list of who is MISSING one.
      missing: without.map((s) => ({ _id: s._id, name: s.name, staffId: s.staffId, designation: s.designation })),
    };
  }
}

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const pick = (data) => {
  const out = {};
  for (const f of [...PAY_FIELDS, "effectiveTo", "notes"]) if (f in data) out[f] = data[f];
  return out;
};

module.exports = ContractService;
