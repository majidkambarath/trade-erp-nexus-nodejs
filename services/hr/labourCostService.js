const mongoose = require("mongoose");
const Staff = require("../../models/modules/staffModel");
const ProcessOrder = require("../../models/modules/processOrderModel");
const AppError = require("../../utils/AppError");
const hr = require("../../utils/hr");
const { orgDay, classify, STATUS } = require("../../utils/documentExpiry");
const AccountConfigService = require("../financial/accountConfigService");
const ContractService = require("./contractService");

/**
 * THE POINT OF THE WHOLE MODULE: joining what a person costs to the work they actually did.
 *
 * Both halves were already in the database and had never met. A process step records who worked it and when it
 * started and finished; a garage task records who worked it and how many hours it took. Neither knew what an
 * hour of that person costs, so a product's cost left its labour out (although IAS 2 requires conversion costs
 * in inventory) and a workshop could see what it CHARGED per hour and never what it PAID.
 *
 * What makes this cheap is that nothing downstream changes. A labour line is an ordinary entry in a process
 * order's `costs[]`, debited to the wages account, and at Finish the existing machinery moves it into the
 * product's cost and credits the "moved to stock" contra in the wages account's own group. No new posting
 * template, no new voucher type, no new report.
 *
 * THE ONE THING THIS DEPENDS ON, AND IT IS NOT OPTIONAL: the wage must actually be IN the books.
 *
 * Absorbing labour posts Dr Inventory / Cr "Production costs moved to stock" - and that credit only nets
 * against something if the wage was debited to the wages account in the first place (by an expense voucher
 * today, by payroll in a later wave). Absorb a wage nobody booked and the entry capitalises a cost that was
 * never incurred: inventory rises, the expense contra rises, and PROFIT RISES by the same amount, out of
 * nothing. That would be a fiction in the accounts, not a feature.
 *
 * The existing production engine already refuses it, which is why this needed no new guard of its own:
 * `COST_EXCEEDS_SPEND` compares each cost against that account's net debit for the year less what other
 * posted productions already moved out of it, and holds the finish until somebody acknowledges it by name.
 * So an organisation that books its salaries to the mapped wages account costs its labour correctly, and one
 * that does not is told, rather than quietly shown a better profit than it earned.
 *
 * What the entry does NOT do is erase the expense: the P&L shows wages in full with the amount moved to
 * stock on its own line beneath (the owner's own choice, recorded for productions). The labour in UNSOLD
 * stock stops being this period's expense and becomes part of the asset, which is what IAS 2 requires; it
 * reaches the P&L as cost of goods when the product is sold.
 */

// The wages account, with the lazy top-up for a company whose posting map predates the key. Read OUTSIDE any
// session, because the top-up commits on its own - the rule productionService.absorbedAccount follows.
async function wagesAccount() {
  try {
    return await AccountConfigService.resolveAccount("salary-expense");
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await require("../financial/defaultChartService").provision();
    return AccountConfigService.resolveAccount("salary-expense");
  }
}

class LabourCostService {
  static wagesAccount = wagesAccount;

  /**
   * The employee behind a piece of work, for a list of steps or tasks at once.
   *
   * Two ways in, because the shop floor and the office are different. `staffId` names the employee outright.
   * `assigneeId` is a sign-in ACCOUNT, which is how work was assigned before HR existed and still is for
   * anybody who logs in - `Staff.adminId` is the bridge. One query each, never one per row.
   */
  static async employeesFor(rows, { session } = {}) {
    const staffIds = [...new Set(rows.map((r) => r.staffId).filter(Boolean).map(String))];
    const adminIds = [...new Set(rows.filter((r) => !r.staffId && r.assigneeId).map((r) => String(r.assigneeId)))];
    const run = (q) => (session ? q.session(session) : q);
    const [byId, byAdmin] = await Promise.all([
      staffIds.length ? run(Staff.find({ _id: { $in: staffIds } }).select("name staffId adminId")).lean() : [],
      adminIds.length
        ? run(Staff.find({ adminId: { $in: adminIds.filter((a) => mongoose.isValidObjectId(a)) } }).select("name staffId adminId")).lean()
        : [],
    ]);
    const employees = new Map();
    for (const s of byId) employees.set(String(s._id), s);
    const viaAdmin = new Map(byAdmin.map((s) => [String(s.adminId), s]));
    return { employees, viaAdmin };
  }

  /** The employee a single row resolves to, or null when nobody can be identified. */
  static resolveOne(row, { employees, viaAdmin }) {
    if (row.staffId && employees.has(String(row.staffId))) return employees.get(String(row.staffId));
    if (!row.staffId && row.assigneeId && viaAdmin.has(String(row.assigneeId))) return viaAdmin.get(String(row.assigneeId));
    return null;
  }

  // ---- U1: the labour in a product ------------------------------------------------------------------------

  /**
   * What labour a process order's finished in-house steps have earned, as lines ready to be recorded.
   *
   * Nothing is written. The hours are an OFFER (utils/hr.js rule 3: an elapsed span is how long the step was
   * open, not how long it was worked), and every reason the figure might be wrong comes back with it so the
   * person confirming it can see what they are confirming.
   *
   * A JOB WORK step is skipped: that labour is the subcontractor's, and it arrives as their bill - counting it
   * here would put it in the product's cost twice.
   */
  static async previewForProcessOrder(orderId, { session, hoursPerDay } = {}) {
    const run = (q) => (session ? q.session(session) : q);
    const order = await run(ProcessOrder.findById(orderId)).lean();
    if (!order) throw new AppError("Process order not found", 404, "PROCESS_ORDER_NOT_FOUND");

    const done = (order.steps || []).filter((s) => s.mode === "in_house" && s.status === "DONE");
    // Already costed? The cost line keeps the step it came from, so pressing the button twice cannot cost the
    // same step twice. This is the whole of the idempotency, and it is why `labour.stepId` matters.
    const costedSteps = new Set((order.costs || []).filter((c) => c.labour).map((c) => String(c.stepId || "")));

    const { employees, viaAdmin } = await this.employeesFor(done, { session });
    const resolved = done.map((step) => ({ step, employee: this.resolveOne(step, { employees, viaAdmin }) }));
    // ONE query for the whole pay history of everyone involved. Each step wants the rate in force on the day
    // IT was finished, which differ, so the day is applied locally per step - asking the database per step
    // would be a query per step for no better answer.
    const contracts = await ContractService.contractsFor(resolved.map((r) => r.employee?._id).filter(Boolean), { session });

    const lines = [];
    const skipped = [];
    for (const { step, employee } of resolved) {
      const stepRef = { stepId: step._id, stepName: step.name };
      if (costedSteps.has(String(step._id))) { skipped.push({ ...stepRef, reason: "ALREADY_COSTED", message: `${step.name} has already been costed` }); continue; }
      if (!employee) { skipped.push({ ...stepRef, reason: "NO_EMPLOYEE", message: `Nobody is recorded as having worked ${step.name}` }); continue; }
      // The rate in force on the day the work was DONE, not today's: that is what the work cost.
      const day = orgDay(step.doneAt) || orgDay(order.date);
      const rate = hr.rateOn(contracts.get(String(employee._id)) || [], day);
      if (rate === null) {
        // Never 0 (utils/hr.js rule 1). Costing this at nothing would understate the product and overstate
        // its margin, and nobody would see it happen - so it is said out loud instead.
        skipped.push({ ...stepRef, reason: "NO_COST_RATE", message: `${employee.name} has no cost rate on ${day}`, staffId: employee._id, staffName: employee.name });
        continue;
      }
      const hours = hr.suggestedHours(step, { hoursPerDay });
      if (hours.hours === null) { skipped.push({ ...stepRef, reason: "NO_HOURS", message: `${step.name} has no start and finish time to work hours from` }); continue; }
      const line = hr.labourLine({
        staffId: employee._id, staffName: employee.name,
        hours: hours.hours, rate, source: hr.HOURS_SOURCE.ELAPSED,
        stepId: step._id, stepName: step.name, day,
      });
      lines.push({ ...line, elapsedHours: hours.elapsedHours, capped: hours.capped, spansDays: hours.spansDays, confident: hours.confident });
    }

    return { orderId: String(order._id), processNo: order.processNo, status: order.status, lines, skipped, total: hr.labourTotal(lines) };
  }

  /**
   * Record the labour as cost lines on the order, so it is visible, correctable, and moved into the product's
   * cost at Finish by machinery that already exists.
   *
   * `lines` lets the person correct the hours before they are kept (and the line then records that a human
   * chose them, not a clock). Anything they do not send is taken as offered.
   */
  static async record(orderId, { lines, by } = {}) {
    const account = await wagesAccount(); // outside the transaction: the top-up commits on its own
    const preview = await this.previewForProcessOrder(orderId);
    if (!preview.lines.length) throw new AppError("There is no labour to cost on this order", 400, "NO_LABOUR_TO_COST");
    if (preview.status !== "OPEN") throw new AppError("Only an open process order can have labour costed", 409, "PROCESS_ORDER_NOT_OPEN");

    const corrections = new Map((Array.isArray(lines) ? lines : []).map((l) => [String(l.stepId), l]));
    const toWrite = [];
    for (const offered of preview.lines) {
      const fix = corrections.get(String(offered.stepId));
      const hours = fix && fix.hours !== undefined && fix.hours !== null && fix.hours !== "" ? Number(fix.hours) : offered.hours;
      if (!Number.isFinite(hours) || hours < 0) throw new AppError(`The hours for ${offered.stepName} are not a number`, 400, "INVALID_HOURS");
      const confirmed = fix && Number(fix.hours) !== offered.hours;
      const line = hr.labourLine({
        ...offered,
        hours,
        // A figure a person typed is recorded as theirs. It matters: a report can then say how much of a
        // product's labour cost is confirmed and how much is still a guess from elapsed time.
        source: confirmed ? hr.HOURS_SOURCE.TYPED : offered.source,
      });
      if (!line) continue;
      toWrite.push({
        stepId: line.stepId, stepName: line.stepName,
        accountId: account._id, accountCode: account.accountCode, accountName: account.accountName,
        amount: line.amount,
        narration: `Labour: ${line.staffName} - ${line.hours}h`,
        labour: { staffId: line.staffId, staffName: line.staffName, hours: line.hours, rate: line.rate, source: line.source },
        addedBy: by, addedAt: new Date(),
      });
    }
    if (!toWrite.length) throw new AppError("There is no labour to cost on this order", 400, "NO_LABOUR_TO_COST");

    // One conditional push per order: the filter names the steps that must still be uncosted, so two people
    // pressing Cost labour at once cannot both write the same step's line.
    const res = await ProcessOrder.updateOne(
      { _id: orderId, status: "OPEN", "costs.stepId": { $nin: toWrite.map((c) => c.stepId) } },
      { $push: { costs: { $each: toWrite } } }
    );
    if (!res.modifiedCount) throw new AppError("That labour has already been costed", 409, "ALREADY_COSTED");
    return { costed: toWrite.length, amount: hr.labourTotal(toWrite.map((c) => ({ ...c.labour, amount: c.amount }))).amount };
  }

  // ---- U2: is the workshop making money on labour? --------------------------------------------------------

  /**
   * A job card's labour cost beside what its labour was sold for.
   *
   * `utils/garage.js` has always worked out the effective labour RATE - revenue divided by hours taken - and
   * had no way to know the cost, so the margin a workshop actually lives on could not be computed at all.
   * A task already carries `staffId` and `actualHours`, so nothing had to be stored to make this possible.
   *
   * `actualHours` is a figure a service advisor entered, so unlike a process step there is no elapsed-time
   * guesswork here: the workshop half is exact from the first day.
   */
  static async forJobCard(card, { session } = {}) {
    const tasks = (card?.tasks || []).filter((t) => t.mode === "in_house" && Number(t.actualHours) > 0);
    if (!tasks.length) return { lines: [], total: hr.labourTotal([]), uncosted: [] };
    const { employees, viaAdmin } = await this.employeesFor(tasks, { session });
    const fallbackDay = orgDay(card.closedAt || card.deliveredAt || card.createdAt) || orgDay(new Date());
    const resolved = tasks.map((t) => ({ task: t, employee: this.resolveOne(t, { employees, viaAdmin }) }));
    const contracts = await ContractService.contractsFor(resolved.map((r) => r.employee?._id).filter(Boolean), { session });

    const lines = [];
    const uncosted = [];
    for (const { task, employee } of resolved) {
      // The day the task was finished, falling back to the card's own day for a task closed without one.
      const day = orgDay(task.doneAt) || fallbackDay;
      const rate = employee ? hr.rateOn(contracts.get(String(employee._id)) || [], day) : null;
      if (rate === null || rate === undefined) {
        uncosted.push({ taskId: task._id, taskName: task.name, hours: Number(task.actualHours) || 0, staffName: employee?.name || task.staffName || null, reason: employee ? "NO_COST_RATE" : "NO_EMPLOYEE" });
        continue;
      }
      const line = hr.labourLine({
        staffId: employee._id, staffName: employee.name,
        hours: Number(task.actualHours), rate,
        // A typed figure, not a clock reading - which is why a workshop's labour cost is trustworthy at once.
        source: hr.HOURS_SOURCE.TYPED,
        stepId: task._id, stepName: task.name, day,
      });
      if (line) lines.push(line);
    }
    return { lines, total: hr.labourTotal(lines), uncosted };
  }

  // ---- compliance where the work is assigned --------------------------------------------------------------

  /**
   * Whether somebody may be given work at all. An expired labour card or visa is a reason the law says a
   * person must not be working, and a report nobody opens is where that fact usually sits - so it is checked
   * at the moment work is assigned instead.
   *
   * Returns the blocking documents, never throws: the caller decides whether this is a refusal or a warning
   * (wave 1 warns on the screen and refuses on release, which is where the money is).
   */
  static async expiredDocumentsFor(staffIds, { day } = {}) {
    const ids = [...new Set((staffIds || []).filter(Boolean).map(String))];
    if (!ids.length) return new Map();
    const EmployeeDocument = mongoose.models.EmployeeDocument;
    if (!EmployeeDocument) return new Map(); // the document register arrives with the rest of wave 1
    const rows = await EmployeeDocument.find({ staffId: { $in: ids } }).select("staffId name expiryDate").lean();
    const out = new Map();
    for (const row of rows) {
      const state = classify(row.expiryDate, { today: day });
      if (state.status !== STATUS.EXPIRED) continue;
      const key = String(row.staffId);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ name: row.name, expiredOn: state.expiryDay });
    }
    return out;
  }
}

module.exports = LabourCostService;
