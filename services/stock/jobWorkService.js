const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const JobWorkOrder = require("../../models/modules/jobWorkOrderModel");
const Stock = require("../../models/modules/stockModel");
const Vendor = require("../../models/modules/vendorModel");
const rules = require("../../utils/jobWork");
const orgLocale = require("../../utils/orgLocale");
const { allBranches } = require("../../utils/tenantContext");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const NumberSeriesService = require("../core/numberSeriesService");
const ItemKindService = require("./itemKindService");
const ProductionService = require("./productionService");

// Job work (subcontracting): our parts go out to an outside job worker (a powder coater) on a challan and come back
// finished. Sending moves NO stock and posts nothing - the parts are still ours (IAS 2; India CGST Act s.143, the
// challan under Rule 55). A receipt creates and posts one Production per item that came back, in the same transaction:
// the raw parts out at their average cost, the finished item in at that cost plus the costs entered on the receipt
// (coating, transport), moved in from the expense accounts the bills were paid to. See utils/jobWork.js for the rules.

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const dayOf = (value) => {
  const day = toExpiryDay(value);
  return day ? new Date(`${day}T00:00:00.000Z`) : null;
};

class JobWorkService {
  // ---- reading -------------------------------------------------------------------------------------------

  static present(doc) {
    const o = doc?.toObject ? doc.toObject() : doc;
    const prog = rules.progress(o);
    const returnByDay = o.returnBy ? toExpiryDay(o.returnBy) : null;
    const open = rules.OPEN.has(o.status);
    return {
      ...o,
      progress: prog,
      atWorker: prog.atWorker,
      overdue: rules.isOverdue(o.status, returnByDay, todayInOrg()),
      actions: {
        edit: o.status === "DRAFT" && !o.source?.kind,
        delete: o.status === "DRAFT" && !o.source?.kind,
        send: o.status === "DRAFT" && !o.source?.kind,
        receive: open && prog.atWorker > 0,
        cancel: o.status === "SENT" && !(o.receipts || []).some((r) => !r.reversedAt),
        challan: o.status !== "DRAFT" && o.status !== "CANCELLED",
      },
    };
  }

  static async list(query = {}) {
    const q = {};
    if (["DRAFT", "SENT", "PARTLY_RECEIVED", "RECEIVED", "CANCELLED"].includes(query.status)) q.status = query.status;
    if (query.status === "OPEN" || query.status === "OVERDUE") q.status = { $in: [...rules.OPEN] };
    const from = dayOf(query.from), to = dayOf(query.to);
    if (from || to) q.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    if (isId(query.jobWorkerId)) q.jobWorkerId = query.jobWorkerId;
    const search = String(query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ jobWorkNo: rx }, { "jobWorker.name": rx }, { "lines.rawName": rx }, { "lines.finishedName": rx }, { purpose: rx }];
    }
    const rows = (await JobWorkOrder.find(q).sort({ date: -1, _id: -1 }).limit(300).lean()).map((r) => this.present(r));
    return query.status === "OVERDUE" ? rows.filter((r) => r.overdue) : rows;
  }

  static async getById(id) {
    if (!isId(id)) throw fail("Job work not found", 404, "NOT_FOUND");
    const o = await JobWorkOrder.findById(id).lean();
    if (!o) throw fail("Job work not found", 404, "NOT_FOUND");
    return this.present(o);
  }

  // What every raw item has with job workers now, in every branch (stock is held by the organisation, not a branch).
  static async withJobWorker({ session } = {}) {
    const open = await allBranches(() => JobWorkOrder.find({ status: { $in: [...rules.OPEN] } }).session(session || null).lean());
    return rules.withJobWorker(open);
  }

  // ---- drafts --------------------------------------------------------------------------------------------

  static async prepare(data, { session, sameItem = false } = {}) {
    const errors = rules.validateOrder(data, { sameItem });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    if (!isId(data.jobWorkerId)) throw fail("Job worker not found", 400, "JOB_WORKER_NOT_FOUND");
    const vendor = await Vendor.findById(data.jobWorkerId).session(session || null).lean();
    if (!vendor) throw fail("Job worker not found", 400, "JOB_WORKER_NOT_FOUND");

    const ids = data.lines.flatMap((l) => [l.rawStockId, l.finishedStockId]).map(String);
    if (ids.some((x) => !isId(x))) throw fail("Item not found", 400, "ITEM_NOT_FOUND");
    const stocks = await Stock.find({ _id: { $in: ids } }).select("itemId itemName itemType").session(session || null).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    const item = (sid, what) => {
      const s = byId.get(String(sid));
      if (!s) throw fail("Item not found", 400, "ITEM_NOT_FOUND");
      ItemKindService.assertStocked(s, what);
      return s;
    };
    const date = data.date ? dayOf(data.date) : dayOf(todayInOrg());
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    if (toExpiryDay(date) > todayInOrg()) throw fail("Job work cannot be dated in the future", 400, "INVALID_DATE");
    return {
      jobWorkerId: vendor._id,
      jobWorker: this.workerSnapshot(vendor),
      date,
      purpose: data.purpose ? String(data.purpose).trim().slice(0, 200) : undefined,
      vehicleNo: data.vehicleNo ? String(data.vehicleNo).trim().slice(0, 40) : undefined,
      notes: data.notes ? String(data.notes).trim().slice(0, 1000) : undefined,
      lines: data.lines.map((l) => {
        const raw = item(l.rawStockId, "be sent for job work");
        const fin = item(l.finishedStockId, "come back from job work");
        return {
          rawStockId: raw._id, rawItemId: raw.itemId, rawName: raw.itemName, qtySent: round3(l.qtySent),
          finishedStockId: fin._id, finishedItemId: fin.itemId, finishedName: fin.itemName,
          finishedPerRaw: Number(l.finishedPerRaw) > 0 ? round3(l.finishedPerRaw) : 1,
        };
      }),
    };
  }

  static workerSnapshot(v) {
    return { name: v.vendorName, code: v.vendorId, address: v.address, taxId: v.vat?.trn || v.trnNO || undefined, phone: v.phone || undefined };
  }

  // A process order's job-work step (services/stock/processOrderService.js): the part goes out and comes back as the same
  // part, so the same item on both sides is allowed here (and only here: a request body cannot set `source`).
  static createForProcess = withTransactionSession(async (data, source, by, session) => {
    const fields = await this.prepare(data, { session, sameItem: true });
    const [o] = await JobWorkOrder.create([{ ...fields, source, status: "DRAFT", createdBy: String(by || "system") }], { session });
    return o;
  });

  static create = withTransactionSession(async (data, by, session) => {
    const fields = await this.prepare(data, { session });
    const [o] = await JobWorkOrder.create([{ ...fields, status: "DRAFT", createdBy: String(by || "system") }], { session });
    return o;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "DRAFT") throw fail(`${o.jobWorkNo} has been sent; only a draft can be changed`, 409, "JOB_WORK_NOT_DRAFT");
    const cur = o.toObject();
    const fields = await this.prepare({
      jobWorkerId: data.jobWorkerId ?? cur.jobWorkerId, date: data.date ?? toExpiryDay(cur.date), lines: data.lines ?? cur.lines,
      purpose: data.purpose ?? cur.purpose, vehicleNo: data.vehicleNo ?? cur.vehicleNo, notes: data.notes ?? cur.notes,
    }, { session });
    Object.assign(o, fields, { updatedBy: String(by || "system") });
    await o.save({ session });
    return o;
  });

  static remove = withTransactionSession(async (id, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "DRAFT") throw fail(`${o.jobWorkNo} has been sent; cancel it instead`, 409, "JOB_WORK_NOT_DRAFT");
    await JobWorkOrder.deleteOne({ _id: o._id }, { session });
    return o;
  });

  static async load(id, session) {
    if (!isId(id)) throw fail("Job work not found", 404, "NOT_FOUND");
    const o = await JobWorkOrder.findById(id).session(session);
    if (!o) throw fail("Job work not found", 404, "NOT_FOUND");
    return o;
  }

  // ---- send, cancel ------------------------------------------------------------------------------------

  // The challan is issued: a number, the value of what goes out (its average cost), the return-by day (India: one
  // year). Refused when the item does not have that much free: on hand less what is already with job workers.
  static send = withTransactionSession(async (id, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "DRAFT") throw fail(`${o.jobWorkNo || "This job work"} has already been sent`, 409, "JOB_WORK_NOT_DRAFT");
    const away = await this.withJobWorker({ session });
    const wanted = new Map();
    for (const l of o.lines) wanted.set(String(l.rawStockId), round3((wanted.get(String(l.rawStockId)) || 0) + l.qtySent));
    const stocks = await Stock.find({ _id: { $in: [...wanted.keys()] } }).select("itemName currentStock purchasePrice").session(session).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    for (const [sid, qty] of wanted) {
      const s = byId.get(sid);
      const free = round3((Number(s?.currentStock) || 0) - (away.get(sid) || 0));
      if (!s || free + 1e-9 < qty) {
        throw fail(
          `Only ${Math.max(0, free)} of ${s?.itemName || "this item"} is free to send (${s?.currentStock ?? 0} on hand, ${away.get(sid) || 0} already with job workers); this job sends ${qty}`,
          409, "INSUFFICIENT_STOCK", { stockId: sid, free, needed: qty }
        );
      }
    }
    for (const l of o.lines) l.unitValue = Number(byId.get(String(l.rawStockId))?.purchasePrice) || 0;
    const vendor = await Vendor.findById(o.jobWorkerId).session(session).lean();
    if (vendor) o.jobWorker = this.workerSnapshot(vendor);
    o.jobWorkNo = await NumberSeriesService.allocate("JWC", o.date, { session });
    o.status = "SENT";
    o.sentAt = new Date();
    const returnBy = rules.returnByFor(orgLocale.country(), toExpiryDay(o.date));
    o.returnBy = returnBy ? dayOf(returnBy) : undefined;
    o.updatedBy = String(by || "system");
    await o.save({ session });
    return o;
  });

  // Nothing came back and nothing will: the parts never left our books, so there is nothing to undo.
  static cancel = withTransactionSession(async (id, by, session) => {
    const o = await this.load(id, session);
    if (o.status !== "SENT" || o.receipts.some((r) => !r.reversedAt)) {
      throw fail("Only a job work with nothing received yet can be cancelled", 409, "JOB_WORK_NOT_CANCELLABLE");
    }
    o.status = "CANCELLED";
    o.cancelledAt = new Date();
    o.cancelledBy = String(by || "system");
    await o.save({ session });
    await this.syncProcess(o, session);
    return o;
  });

  // ---- receive, reverse --------------------------------------------------------------------------------

  // What came back: per line the finished quantity, the raw units it used (pre-filled from the ratio) and any raw
  // returned unprocessed; plus the costs moved in (coating, transport). One Production per line with finished goods,
  // created and posted in this transaction; the costs are spread over them by the value of the raw parts used.
  static async receive(id, input = {}, by) {
    const costs = Array.isArray(input.costs) ? input.costs.filter((c) => c && (c.accountId || c.amount)) : [];
    const absorbedId = costs.length ? await ProductionService.absorbedAccount() : null; // may commit a chart top-up of its own
    return this.receiveIn(id, { ...input, costs }, { absorbedId }, by);
  }

  static receiveIn = withTransactionSession(async (id, input, { absorbedId }, by, session) => {
    const o = await this.load(id, session);
    if (o.source?.kind === "process" && (input.costs || []).length) {
      throw fail(`${o.jobWorkNo} is a step of process order ${o.source.no}: its costs are added when that order is finished`, 400, "PROCESS_COSTS_AT_FINISH");
    }
    if (!rules.OPEN.has(o.status)) throw fail(`${o.jobWorkNo || "This job work"} is ${o.status.toLowerCase()}; nothing can be received on it`, 409, "JOB_WORK_NOT_OPEN");
    const { errors, lines } = rules.validateReceipt(o.toObject(), input);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const date = input.date ? dayOf(input.date) : dayOf(todayInOrg());
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    if (date < o.date) throw fail("Goods cannot come back before the day they were sent", 400, "INVALID_DATE");

    // a step of a process order makes nothing here: that order’s own Production does, when it is finished
    const made = o.source?.kind === "process" ? [] : lines.filter((l) => l.finishedQty > 0);
    const lineOf = (lineId) => o.lines.find((x) => String(x._id) === String(lineId));
    const weights = made.map((l) => l.rawConsumed * (Number(lineOf(l.lineId).unitValue) || 0));
    const shares = rules.splitCosts(input.costs || [], weights);
    const workerRef = input.workerRef ? String(input.workerRef).trim().slice(0, 60) : undefined;

    const productions = [];
    for (let i = 0; i < made.length; i += 1) {
      const l = made[i];
      const line = lineOf(l.lineId);
      const p = await ProductionService.create(
        {
          date: toExpiryDay(date),
          finished: { stockId: line.finishedStockId, qty: l.finishedQty },
          materials: [{ stockId: line.rawStockId, qty: l.rawConsumed }],
          costs: shares[i],
          notes: `Job work ${o.jobWorkNo}: back from ${o.jobWorker?.name || "the job worker"}${workerRef ? ` (their ref ${workerRef})` : ""}`,
        },
        by, session
      );
      p.source = { kind: "job_work", id: o._id, no: o.jobWorkNo };
      await p.save({ session });
      const posted = await ProductionService.postIn(p._id, { acknowledge: input.acknowledge || [], absorbedId }, by, session);
      productions.push({ id: posted._id, no: posted.productionNo });
    }

    o.receipts.push({ date, workerRef, productions, lines, createdBy: String(by || "system") });
    o.status = rules.progress(o.toObject()).status;
    o.updatedBy = String(by || "system");
    await o.save({ session });
    await this.syncProcess(o, session, by);
    return { order: o, productions };
  });

  // Takes a receipt back: its productions are reversed (stock and ledger), and what it brought back counts as still
  // with the job worker again. Refused, as a production is, once the finished goods have been sold.
  static reverseReceipt = withTransactionSession(async (id, receiptId, { reason } = {}, by, session) => {
    const o = await this.load(id, session);
    const r = o.receipts.id(receiptId);
    if (!r) throw fail("Receipt not found", 404, "NOT_FOUND");
    if (r.reversedAt) throw fail("That receipt has already been reversed", 409, "RECEIPT_REVERSED");
    for (const p of r.productions) await ProductionService.reverse(p.id, { reason: reason || `Receipt on ${o.jobWorkNo} reversed`, fromJobWork: true }, by, session);
    r.reversedAt = new Date();
    r.reversedBy = String(by || "system");
    o.status = rules.progress(o.toObject()).status;
    o.updatedBy = String(by || "system");
    await o.save({ session });
    await this.syncProcess(o, session, by);
    return o;
  });

  // A job raised by a process order's step tells that step where it stands (sent, partly back, back, cancelled).
  static async syncProcess(o, session, by) {
    if (o.source?.kind !== "process") return;
    await require("./processOrderService").onJobWorkChanged(o, session, by); // required here: the two call each other
  }
}

module.exports = JobWorkService;
