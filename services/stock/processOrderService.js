const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const ProcessOrder = require("../../models/modules/processOrderModel");
const JobWorkOrder = require("../../models/modules/jobWorkOrderModel");
const Stock = require("../../models/modules/stockModel");
const Vendor = require("../../models/modules/vendorModel");
const Admin = require("../../models/core/adminModel");
const rules = require("../../utils/processOrders");
const jobRules = require("../../utils/jobWork");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg, orgDay, toExpiryDay, addDays } = require("../../utils/documentExpiry");
const NumberSeriesService = require("../core/numberSeriesService");
const ItemKindService = require("./itemKindService");
const ProductionService = require("./productionService");
const JobWorkService = require("./jobWorkService");

// Process orders (utils/processOrders.js): a product made through steps, each in-house or at a job worker, each with a
// due date, and a board that shows what is pending, in progress, late, due today or tomorrow. Nothing moves in stock or
// the books while the steps run; a job-work step raises a job-work challan (JobWorkService.createForProcess), whose
// receipts move the step on (onJobWorkChanged); finishing the order posts ONE Production.

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const dayOf = (value) => {
  const day = toExpiryDay(value);
  return day ? new Date(`${day}T00:00:00.000Z`) : null;
};
const dayText = (d) => (d ? toExpiryDay(d) : null);

class ProcessOrderService {
  // ---- reading -------------------------------------------------------------------------------------------

  static present(doc) {
    const o = doc?.toObject ? doc.toObject() : doc;
    const step = rules.currentStep(o);
    const ready = rules.allDone(o);
    const today = todayInOrg();
    const tomorrow = addDays(today, 1);
    return {
      ...o,
      current: step ? { _id: step._id, name: step.name, status: step.status, seq: step.seq } : null,
      readyToFinish: o.status === "OPEN" && ready,
      finishedQty: rules.finishedQty(o),
      steps: (o.steps || []).map((s) => ({
        ...s,
        dueState: s.status === "DONE" ? "done" : rules.dueState(dayText(s.dueDate), today, tomorrow),
        actions: {
          start: o.status === "OPEN" && s.mode === "in_house" && s.status === "READY",
          complete: o.status === "OPEN" && s.mode === "in_house" && rules.OPEN_STEP.has(s.status),
          send: o.status === "OPEN" && s.mode === "job_work" && s.status === "READY",
        },
      })),
      actions: {
        edit: o.status === "DRAFT",
        delete: o.status === "DRAFT",
        release: o.status === "DRAFT",
        cancel: o.status === "OPEN" && !(o.steps || []).some((s) => s.mode === "job_work" && s.status === "IN_PROGRESS"),
        finish: o.status === "OPEN" && ready,
        reopen: o.status === "COMPLETED",
      },
    };
  }

  static async list(query = {}) {
    const q = {};
    if (["DRAFT", "OPEN", "COMPLETED", "CANCELLED"].includes(query.status)) q.status = query.status;
    const search = String(query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ processNo: rx }, { "finished.itemName": rx }, { "steps.name": rx }, { "steps.assigneeName": rx }, { "steps.jobWorkerName": rx }];
    }
    const rows = await ProcessOrder.find(q).sort({ createdAt: -1, _id: -1 }).limit(300).lean();
    return rows.map((r) => this.present(r));
  }

  static async getById(id) {
    if (!isId(id)) throw fail("Process order not found", 404, "NOT_FOUND");
    const o = await ProcessOrder.findById(id).lean();
    if (!o) throw fail("Process order not found", 404, "NOT_FOUND");
    return this.present(o);
  }

  // The owner's board: counts, where every open order is, what is late or due today / tomorrow, what is on the caller's
  // own list, and the material sitting with each job worker (with how long it has been out).
  static async board({ me = null } = {}) {
    const today = todayInOrg();
    const tomorrow = addDays(today, 1);
    const [orders, jobs] = await Promise.all([
      ProcessOrder.find({ status: "OPEN" }).lean(),
      JobWorkOrder.find({ status: { $in: [...jobRules.OPEN] } }).sort({ date: 1 }).lean(),
    ]);
    const out = rules.board(orders, { today, tomorrow, dayOf: dayText, me });
    out.today = today;
    out.withJobWorkers = jobs.map((j) => {
      const prog = jobRules.progress(j);
      const sent = dayText(j.date);
      return {
        jobWorkId: j._id, jobWorkNo: j.jobWorkNo, worker: j.jobWorker?.name || "", processNo: j.source?.no || null,
        items: j.lines.map((l) => ({ name: l.rawName, out: prog.lines.find((x) => x.lineId === String(l._id))?.atWorker ?? 0 })).filter((x) => x.out > 0),
        sent, daysOut: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${sent}T00:00:00Z`)) / 86400000)),
        returnBy: dayText(j.returnBy), overdue: jobRules.isOverdue(j.status, dayText(j.returnBy), today),
        value: j.lines.reduce((s, l) => s + (prog.lines.find((x) => x.lineId === String(l._id))?.atWorker || 0) * (Number(l.unitValue) || 0), 0),
      };
    }).filter((j) => j.items.length);
    return out;
  }

  // People a step can be given to (the organisation's active accounts, names only).
  static async assignees() {
    const rows = await Admin.find({ isActive: true, status: "active" }).select("name email").sort({ name: 1 }).lean();
    return rows.map((a) => ({ id: String(a._id), name: a.name || a.email }));
  }

  // The steps of the last order for a product, to start a new one from (names, who does each; no dates).
  static async lastSteps(stockId) {
    if (!isId(stockId)) return [];
    const last = await ProcessOrder.findOne({ "finished.stockId": stockId, status: { $ne: "DRAFT" } }).sort({ createdAt: -1 }).lean();
    return (last?.steps || []).map((s) => ({ name: s.name, mode: s.mode, assigneeId: s.assigneeId, assigneeName: s.assigneeName, jobWorkerId: s.jobWorkerId, jobWorkerName: s.jobWorkerName }));
  }

  // ---- drafts --------------------------------------------------------------------------------------------

  static async prepare(data, { session } = {}) {
    const errors = rules.validateOrder(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const stockIds = [data.finished.stockId, ...(data.materials || []).map((m) => m.stockId)].map(String);
    if (stockIds.some((x) => !isId(x))) throw fail("Item not found", 400, "ITEM_NOT_FOUND");
    const stocks = await Stock.find({ _id: { $in: stockIds } }).select("itemId itemName itemType").session(session || null).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    const item = (sid, what) => {
      const s = byId.get(String(sid));
      if (!s) throw fail("Item not found", 400, "ITEM_NOT_FOUND");
      ItemKindService.assertStocked(s, what);
      return s;
    };
    const fin = item(data.finished.stockId, "be made in a process order");

    const vendorIds = data.steps.filter((s) => s.mode === "job_work").map((s) => String(s.jobWorkerId));
    if (vendorIds.some((v) => !isId(v))) throw fail("Job worker not found", 400, "JOB_WORKER_NOT_FOUND");
    const vendors = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds } }).select("vendorName").session(session || null).lean() : [];
    const vendorById = new Map(vendors.map((v) => [String(v._id), v]));
    const peopleIds = data.steps.filter((s) => s.mode === "in_house" && s.assigneeId).map((s) => String(s.assigneeId)).filter(isId);
    const people = peopleIds.length ? await Admin.find({ _id: { $in: peopleIds } }).select("name email").session(session || null).lean() : [];
    const personById = new Map(people.map((p) => [String(p._id), p]));

    const date = data.date ? dayOf(data.date) : dayOf(todayInOrg());
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    return {
      date,
      dueDate: data.dueDate ? dayOf(data.dueDate) : undefined,
      finished: { stockId: fin._id, itemId: fin.itemId, itemName: fin.itemName, qty: round3(data.finished.qty) },
      materials: (data.materials || []).map((m) => {
        const s = item(m.stockId, "be used in a process order");
        return { stockId: s._id, itemId: s.itemId, itemName: s.itemName, qty: round3(m.qty) };
      }),
      steps: data.steps.map((s, i) => {
        const base = { seq: i + 1, name: String(s.name).trim().slice(0, 80), mode: s.mode, dueDate: s.dueDate ? dayOf(s.dueDate) : undefined, notes: s.notes ? String(s.notes).trim().slice(0, 500) : undefined, status: "WAITING" };
        if (s.mode === "job_work") {
          const v = vendorById.get(String(s.jobWorkerId));
          if (!v) throw fail(`Step ${i + 1}: job worker not found`, 400, "JOB_WORKER_NOT_FOUND");
          return { ...base, jobWorkerId: v._id, jobWorkerName: v.vendorName };
        }
        const p = s.assigneeId ? personById.get(String(s.assigneeId)) : null;
        return { ...base, assigneeId: p ? String(p._id) : undefined, assigneeName: p ? p.name || p.email : s.assigneeName ? String(s.assigneeName).trim().slice(0, 120) : undefined };
      }),
      notes: data.notes ? String(data.notes).trim().slice(0, 1000) : undefined,
    };
  }

  static create = withTransactionSession(async (data, by, session) => {
    const fields = await this.prepare(data, { session });
    const [o] = await ProcessOrder.create([{ ...fields, status: "DRAFT", createdBy: String(by || "system") }], { session });
    return o;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "DRAFT") throw fail(`${o.processNo} has been released; only a draft can be changed`, 409, "PROCESS_NOT_DRAFT");
    const cur = o.toObject();
    const fields = await this.prepare({
      date: data.date ?? dayText(cur.date), dueDate: data.dueDate ?? dayText(cur.dueDate), finished: data.finished ?? cur.finished,
      materials: data.materials ?? cur.materials, steps: data.steps ?? cur.steps.map((s) => ({ ...s, dueDate: dayText(s.dueDate) })), notes: data.notes ?? cur.notes,
    }, { session });
    Object.assign(o, fields, { updatedBy: String(by || "system") });
    await o.save({ session });
    return o;
  });

  static remove = withTransactionSession(async (id, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "DRAFT") throw fail(`${o.processNo} has been released; cancel it instead`, 409, "PROCESS_NOT_DRAFT");
    await ProcessOrder.deleteOne({ _id: o._id }, { session });
    return o;
  });

  static async load(id, session) {
    if (!isId(id)) throw fail("Process order not found", 404, "NOT_FOUND");
    const o = await ProcessOrder.findById(id).session(session);
    if (!o) throw fail("Process order not found", 404, "NOT_FOUND");
    return o;
  }

  static stepOf(o, stepId) {
    const s = o.steps.id(stepId);
    if (!s) throw fail("Step not found", 404, "NOT_FOUND");
    return s;
  }

  // ---- running it ----------------------------------------------------------------------------------------

  static release = withTransactionSession(async (id, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "DRAFT") throw fail("Only a draft can be released", 409, "PROCESS_NOT_DRAFT");
    o.processNo = await NumberSeriesService.allocate("PRO", o.date, { session });
    o.steps = rules.release(o.toObject().steps, o.finished.qty);
    o.status = "OPEN";
    o.releasedAt = new Date();
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return o;
  });

  static cancel = withTransactionSession(async (id, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "OPEN") throw fail("Only an open process order can be cancelled", 409, "PROCESS_NOT_OPEN");
    if (o.steps.some((s) => s.mode === "job_work" && s.status === "IN_PROGRESS")) {
      throw fail("Parts are out with a job worker on this order; bring them back (or cancel that challan) first", 409, "PROCESS_AT_JOB_WORKER");
    }
    o.status = "CANCELLED";
    o.cancelledAt = new Date();
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return o;
  });

  static startStep = withTransactionSession(async (id, stepId, by, session) => {
    const o = await this.openOrder(id, session);
    const s = this.stepOf(o, stepId);
    if (s.mode !== "in_house" || s.status !== "READY") throw fail(`${s.name} cannot be started now (${s.status.toLowerCase().replace("_", " ")})`, 409, "STEP_NOT_READY");
    s.status = "IN_PROGRESS";
    s.startedAt = new Date();
    s.startedBy = String(by || "system");
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return o;
  });

  static completeStep = withTransactionSession(async (id, stepId, input, by, session) => {
    const o = await this.openOrder(id, session);
    const s = this.stepOf(o, stepId);
    if (s.mode !== "in_house" || !rules.OPEN_STEP.has(s.status)) throw fail(`${s.name} cannot be finished now (${s.status.toLowerCase().replace("_", " ")})`, 409, "STEP_NOT_READY");
    const problem = rules.checkCompletion(s, input || {});
    if (problem) throw fail(problem.message, 400, problem.code);
    s.qtyDone = round3(input.qtyDone);
    s.qtyRejected = round3(Number(input.qtyRejected) || 0);
    if (input.notes) s.notes = String(input.notes).trim().slice(0, 500);
    s.status = "DONE";
    if (!s.startedAt) s.startedAt = new Date();
    s.doneAt = new Date();
    s.doneBy = String(by || "system");
    o.steps = rules.advance(o.toObject().steps, o.steps.findIndex((x) => String(x._id) === String(stepId)));
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return o;
  });

  // A job-work step: the parts go out on a challan (the order's main material, in proportion to the quantity this step
  // has to process), sent at once. The step is in progress until they come back (onJobWorkChanged).
  static sendStep = withTransactionSession(async (id, stepId, input, by, session) => {
    const o = await this.openOrder(id, session);
    const s = this.stepOf(o, stepId);
    if (s.mode !== "job_work" || s.status !== "READY") throw fail(`${s.name} cannot be sent now (${s.status.toLowerCase().replace("_", " ")})`, 409, "STEP_NOT_READY");
    const main = o.materials[0];
    const qty = round3((Number(main.qty) / Number(o.finished.qty)) * Number(s.plannedQty));
    const job = await JobWorkService.createForProcess(
      {
        jobWorkerId: s.jobWorkerId, date: input?.date || todayInOrg(), purpose: input?.purpose || s.name, vehicleNo: input?.vehicleNo,
        notes: `${o.processNo} step ${s.seq}: ${s.name}`,
        lines: [{ rawStockId: main.stockId, finishedStockId: main.stockId, qtySent: qty, finishedPerRaw: 1 }],
      },
      { kind: "process", id: o._id, no: o.processNo, stepId: s._id }, by, session
    );
    const sent = await JobWorkService.send(job._id, by, session);
    s.status = "IN_PROGRESS";
    s.startedAt = new Date();
    s.startedBy = String(by || "system");
    s.jobWorkId = sent._id;
    s.jobWorkNo = sent.jobWorkNo;
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return { order: o, jobWork: sent };
  });

  // Called by JobWorkService whenever a process step's challan changes: back in full -> the step is done and the next
  // one ready; partly back -> in progress with what is back so far; cancelled -> the step is ready again; a receipt
  // reversed after the next step has started is refused (the order has moved on).
  static async onJobWorkChanged(job, session, by) {
    const o = await ProcessOrder.findById(job.source.id).session(session);
    if (!o) return;
    const s = o.steps.id(job.source.stepId);
    if (!s) return;
    const index = o.steps.findIndex((x) => String(x._id) === String(s._id));
    const next = o.steps[index + 1];
    const prog = jobRules.progress(job.toObject ? job.toObject() : job);
    const back = round3(prog.lines.reduce((t, l) => t + l.finished, 0));
    const returned = round3(prog.lines.reduce((t, l) => t + l.returned, 0));
    const main = o.materials[0];
    const perUnit = Number(main.qty) / Number(o.finished.qty); // material units per unit of product
    const wasDone = s.status === "DONE";

    if (job.status === "CANCELLED") {
      s.status = "READY"; s.jobWorkId = undefined; s.jobWorkNo = undefined; s.startedAt = undefined; s.startedBy = undefined;
    } else if (job.status === "RECEIVED") {
      s.status = "DONE";
      s.qtyDone = round3(back / perUnit);
      s.qtyRejected = round3(returned / perUnit);
      s.doneAt = new Date();
      s.doneBy = String(by || "system");
    } else {
      if (wasDone && next && (next.status === "IN_PROGRESS" || next.status === "DONE")) {
        throw fail(`${o.processNo} has moved on to ${next.name}; that step must be undone first`, 409, "PROCESS_MOVED_ON");
      }
      s.status = "IN_PROGRESS";
      s.qtyDone = round3(back / perUnit);
      s.doneAt = undefined;
      if (next && next.status === "READY") next.status = "WAITING";
    }
    if (s.status === "DONE" && !wasDone) o.steps = rules.advance(o.toObject().steps, index);
    o.updatedBy = String(by || "system");
    await o.save({ session });
  }

  static async openOrder(id, session) {
    const o = await this.load(id, session);
    if (o.status !== "OPEN") throw fail(`${o.processNo || "This order"} is ${o.status.toLowerCase()}`, 409, "PROCESS_NOT_OPEN");
    return o;
  }

  // ---- finishing -----------------------------------------------------------------------------------------

  // Every step done: ONE Production posts - the materials out at their cost, the product in at that cost plus the costs
  // moved in (coating, transport, ...), for the good units that came out of the last step.
  static async finish(id, input = {}, by) {
    const costs = Array.isArray(input.costs) ? input.costs.filter((c) => c && (c.accountId || c.amount)) : [];
    const absorbedId = costs.length ? await ProductionService.absorbedAccount() : null; // may commit a chart top-up of its own
    return this.finishIn(id, { ...input, costs }, { absorbedId }, by);
  }

  static finishIn = withTransactionSession(async (id, input, { absorbedId }, by, session) => {
    const o = await this.openOrder(id, session);
    if (!rules.allDone(o.toObject())) throw fail("Every step must be done before the order is finished", 409, "STEPS_NOT_DONE");
    const qty = rules.finishedQty(o.toObject());
    if (!(qty > 0)) throw fail("Nothing good came out of the last step", 409, "NOTHING_MADE");
    const p = await ProductionService.create(
      {
        date: input.date || todayInOrg(),
        finished: { stockId: o.finished.stockId, qty },
        materials: o.materials.map((m) => ({ stockId: m.stockId, qty: m.qty })),
        costs: input.costs || [],
        notes: `Process order ${o.processNo}: ${o.steps.map((s) => s.name).join(" > ")}`,
      },
      by, session
    );
    p.source = { kind: "process", id: o._id, no: o.processNo };
    await p.save({ session });
    const posted = await ProductionService.postIn(p._id, { acknowledge: input.acknowledge || [], absorbedId }, by, session);
    o.status = "COMPLETED";
    o.completedAt = new Date();
    o.productionId = posted._id;
    o.productionNo = posted.productionNo;
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return { order: o, production: posted };
  });

  // Undoes the finishing (the Production reversed; refused once the product has been sold), so a step can be corrected.
  static reopen = withTransactionSession(async (id, { reason } = {}, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "COMPLETED") throw fail("Only a completed order can be reopened", 409, "PROCESS_NOT_COMPLETED");
    await ProductionService.reverse(o.productionId, { reason: reason || `Process order ${o.processNo} reopened`, fromJobWork: true }, by, session);
    o.status = "OPEN";
    o.completedAt = undefined;
    o.productionId = undefined;
    o.productionNo = undefined;
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return o;
  });
}

module.exports = ProcessOrderService;
