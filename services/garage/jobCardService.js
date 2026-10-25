const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const JobCard = require("../../models/modules/garage/jobCardModel");
const Vehicle = require("../../models/modules/garage/vehicleModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const Staff = require("../../models/modules/staffModel");
const Admin = require("../../models/core/adminModel");
const Transaction = require("../../models/modules/transactionModel");
const rules = require("../../utils/garage");
const kinds = require("../../utils/itemKinds");
const ItemKindService = require("../stock/itemKindService");
const S = require("../orderPurchase/salesDocumentSupport");
const TransactionService = require("../orderPurchase/transactionService");
const NumberSeriesService = require("../core/numberSeriesService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const { addMonths } = require("../../utils/yearEnd");

// The job card (utils/garage.js has the pure rules: validation, the estimate, tasks in parallel stages, the
// board, analysis). A NON-POSTING document, like a delivery note or a goods receipt: nothing here moves stock
// or touches the ledger. Only approving the sales invoice it raises does both - createInvoice below calls
// TransactionService.createTransaction exactly as deliveryNoteService.createInvoice does, and jobCardLinks.js
// (called from the bottom of processTransaction, after the two-approval early return) keeps invoiceStatus and
// status in step with what that invoice does afterwards.

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.isValidObjectId(v);
const idOf = (v) => (v && typeof v === "object" ? String(v._id || v) : v == null ? "" : String(v));

class JobCardService {
  // ---- reading ----------------------------------------------------------------------------------------------

  static async #load(id, session) {
    if (!isId(id)) throw fail("That job card does not exist", 404, "JOB_NOT_FOUND");
    const q = JobCard.findById(id);
    const card = await (session ? q.session(session) : q);
    if (!card) throw fail("That job card does not exist", 404, "JOB_NOT_FOUND");
    return card;
  }

  static async getById(id) {
    const card = await this.#load(id);
    return card.toObject();
  }

  static async list(query = {}) {
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.jobType) filter.jobType = query.jobType;
    if (query.vehicleId && isId(query.vehicleId)) filter.vehicleId = query.vehicleId;
    if (query.customerId && isId(query.customerId)) filter.customerId = query.customerId;
    const search = String(query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ jobNo: rx }, { "vehicle.plateNumber": rx }, { "customer.name": rx }];
    }
    return JobCard.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  }

  static async assignees() {
    // In-house technicians who may hold a login (the "optional login" decision): every active account, named,
    // same shape as the process-order board uses, so a single assignee picker can serve both modules.
    const rows = await Admin.find({ isActive: true, status: "active" }).select("name email").sort({ name: 1 }).lean();
    return rows.map((a) => ({ id: String(a._id), name: a.name || a.email }));
  }

  // What is in the workshop right now (utils/garage.js board): counts, columns, overdue/due lists, "my work".
  static async board({ me } = {}) {
    const today = todayInOrg();
    const tomorrow = toExpiryDay(new Date(Date.parse(`${today}T00:00:00Z`) + 86400000));
    const cards = await JobCard.find({ status: { $in: [...rules.LIVE_STATUS] } }).lean();
    return rules.board(cards, { today, tomorrow, dayOf: (v) => toExpiryDay(v), me: me || null });
  }

  static async analysis({ from, to } = {}) {
    const fromDay = from ? toExpiryDay(from) : null;
    const toDay = to ? toExpiryDay(to) : null;
    if (from && !fromDay) throw fail("The start date is not a date", 400, "INVALID_DATE");
    if (to && !toDay) throw fail("The end date is not a date", 400, "INVALID_DATE");
    // Widen the database read by a day either side; the pure rule judges the organisation's own day exactly.
    const match = {};
    if (fromDay) match.$gte = new Date(`${fromDay}T00:00:00.000Z`);
    if (toDay) match.$lte = new Date(Date.parse(`${toDay}T00:00:00.000Z`) + 86400000);
    const filter = Object.keys(match).length ? { "delivery.gatePassAt": match } : {};
    const cards = await JobCard.find(filter).lean();
    return rules.analysis(cards, { from: fromDay, to: toDay, dayOf: (v) => toExpiryDay(v) });
  }

  // How much of an item is promised to a live, not-yet-invoiced job card: the stock list's own honest
  // "free to sell" figure (the DeliveryNoteService.availability pattern), never a movement - nothing here
  // changes a quantity on hand. Once a job card's invoice is approved, the item's own currentStock already
  // reflects it, so an INVOICED card is left out or this would double count.
  static async committed(itemIds = []) {
    const ids = (Array.isArray(itemIds) ? itemIds : String(itemIds).split(",")).map((s) => String(s).trim()).filter(isId);
    if (!ids.length) return [];
    const rows = await JobCard.aggregate([
      { $match: { status: { $in: [...rules.LIVE_STATUS] }, invoiceStatus: { $ne: "INVOICED" } } },
      { $unwind: "$lines" },
      { $match: { "lines.itemId": { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, "lines.kind": { $in: [...rules.STOCKED_KINDS] }, "lines.approved": { $ne: false } } },
      { $group: { _id: "$lines.itemId", qty: { $sum: "$lines.qty" } } },
    ]);
    const byId = new Map(rows.map((r) => [String(r._id), r.qty]));
    return ids.map((itemId) => ({ itemId, committed: rules.round3(byId.get(itemId) || 0) }));
  }

  // ---- preparing lines and tasks (shared by create, update and reviseEstimate) -------------------------------

  // Prices the lines exactly as an invoice is priced (TransactionService.buildPricing, via the same
  // priceDocument every quotation and delivery note uses), then checks each line's own `kind` against what the
  // item master really is: a part/consumable must be a STOCKED item, labour/sublet must be a SERVICE item. This
  // is what keeps `committed()` and the printed estimate's stream totals honest - the posting itself is safe
  // either way, because approving the invoice reads the item's real itemType, never this line's `kind`.
  static async #priceAndStampLines(items, { session, date } = {}) {
    if (!Array.isArray(items) || !items.length) return [];
    const pricingInput = items.map((l) => ({
      itemId: l.itemId, description: l.description, qty: l.qty, price: l.price,
      discountPercent: l.discountPercent, discountAmount: l.discountAmount, taxCodeId: l.taxCodeId,
    }));
    const priced = await S.priceDocument({ items: pricingInput, charges: [], discount: 0, date }, { session });

    const kindMap = await ItemKindService.load(priced.lines, { session });
    const vendorIds = [...new Set(items.filter((l) => l.kind === "sublet" && l.vendorId).map((l) => idOf(l.vendorId)))].filter(isId);
    const vendors = vendorIds.length
      ? new Map((await Vendor.find({ _id: { $in: vendorIds } }).select("vendorName").session(session || null).lean()).map((v) => [String(v._id), v.vendorName]))
      : new Map();

    return priced.lines.map((p, i) => {
      const src = items[i];
      const n = i + 1;
      const stock = kindMap.get(String(p.itemId));
      const isServiceItem = kinds.isService(stock);
      const mustBeStocked = rules.STOCKED_KINDS.has(src.kind);
      if (mustBeStocked && isServiceItem) {
        throw fail(`Line ${n}: "${p.description}" is a service item and cannot be billed as ${src.kind}`, 400, "LINE_KIND_MISMATCH", { line: n });
      }
      if (!mustBeStocked && !isServiceItem) {
        throw fail(`Line ${n}: "${p.description}" is a stocked item and cannot be billed as ${src.kind}`, 400, "LINE_KIND_MISMATCH", { line: n });
      }
      if (src.kind === "sublet" && !idOf(src.vendorId)) throw fail(`Line ${n}: choose who the work goes out to`, 400, "SUBLET_VENDOR_REQUIRED", { line: n });
      return {
        ...p,
        ...(src._id ? { _id: src._id } : {}),
        kind: src.kind,
        ...(src.kind === "sublet" ? { vendorId: src.vendorId, vendorName: vendors.get(idOf(src.vendorId)) || "" } : {}),
        ...(src.complaintId ? { complaintId: src.complaintId } : {}),
        approved: src.approved,
        addedInVersion: src.addedInVersion || 1,
        issuedQty: Number(src.issuedQty) || 0,
      };
    });
  }

  // Tasks need no money pricing, only names resolved: a Staff member (and whether they hold a login), or a
  // sublet vendor's name for the card to print and the board to show.
  static async #stampTasks(tasks, { session } = {}) {
    if (!Array.isArray(tasks) || !tasks.length) return [];
    const staffIds = [...new Set(tasks.filter((t) => t.mode === "in_house" && t.staffId).map((t) => idOf(t.staffId)))].filter(isId);
    const vendorIds = [...new Set(tasks.filter((t) => t.mode === "sublet" && t.vendorId).map((t) => idOf(t.vendorId)))].filter(isId);
    const [staff, vendors] = await Promise.all([
      staffIds.length ? Staff.find({ _id: { $in: staffIds } }).select("name").session(session || null).lean() : [],
      vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select("vendorName").session(session || null).lean() : [],
    ]);
    const staffById = new Map(staff.map((s) => [String(s._id), s.name]));
    const vendorById = new Map(vendors.map((v) => [String(v._id), v.vendorName]));
    return tasks.map((t, i) => ({
      seq: i + 1,
      stage: t.stage == null || t.stage === "" ? 1 : Number(t.stage),
      name: rules.text(t.name, 80),
      mode: t.mode,
      ...(t.mode === "in_house"
        ? { staffId: t.staffId || undefined, staffName: staffById.get(idOf(t.staffId)) || rules.text(t.staffName, 120), assigneeId: t.assigneeId || undefined }
        : { vendorId: t.vendorId, vendorName: vendorById.get(idOf(t.vendorId)) || "" }),
      ...(t.bayId ? { bayId: t.bayId, bayName: t.bayName || "" } : {}),
      ...(t.complaintId ? { complaintId: t.complaintId } : {}),
      standardHours: Number(t.standardHours) || 0,
      status: "WAITING",
    }));
  }

  // ---- preparing the card itself ------------------------------------------------------------------------------

  static async #prepare(data, { existing, session } = {}) {
    const errors = rules.validateJobCard(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    if (!isId(data.vehicleId)) throw fail("Choose the vehicle", 400, "VEHICLE_NOT_FOUND");
    const vehicle = await Vehicle.findById(data.vehicleId).session(session || null).lean();
    if (!vehicle) throw fail("That vehicle does not exist", 404, "VEHICLE_NOT_FOUND");

    if (!isId(data.customerId)) throw fail("Choose the customer", 400, "CUSTOMER_NOT_FOUND");
    const customer = await Customer.findById(data.customerId).select("customerName phone").session(session || null).lean();
    if (!customer) throw fail("That customer does not exist", 404, "CUSTOMER_NOT_FOUND");

    const date = existing?.receivedAt || data.receivedAt ? new Date(data.receivedAt || existing.receivedAt) : new Date();
    const lines = await this.#priceAndStampLines(data.lines || [], { session, date });
    const tasks = await this.#stampTasks(data.tasks || [], { session });

    return {
      jobType: data.jobType || "retail",
      vehicleId: vehicle._id,
      vehicle: { plateNumber: vehicle.plateNumber, make: vehicle.make, model: vehicle.model, year: vehicle.year, colour: vehicle.colour, chassisNo: vehicle.chassisNo },
      customerId: customer._id,
      customer: { name: customer.customerName, phone: customer.phone || "" },
      receivedAt: data.receivedAt || existing?.receivedAt || new Date(),
      promisedAt: data.promisedAt || undefined,
      odometerIn: data.odometerIn === "" || data.odometerIn == null ? undefined : Number(data.odometerIn),
      fuelLevelIn: data.fuelLevelIn || "",
      checkIn: {
        damagePoints: Array.isArray(data.checkIn?.damagePoints) ? data.checkIn.damagePoints : [],
        itemsPresent: Array.isArray(data.checkIn?.itemsPresent) ? data.checkIn.itemsPresent : [],
        photos: Array.isArray(data.checkIn?.photos) ? data.checkIn.photos : [],
        signatureAttachmentId: data.checkIn?.signatureAttachmentId || undefined,
        notes: rules.text(data.checkIn?.notes, 500),
      },
      complaints: (data.complaints || []).map((c, i) => ({ seq: i + 1, concern: rules.text(c.concern, 400), cause: rules.text(c.cause, 400), correction: rules.text(c.correction, 400), status: c.status || "OPEN", ...(c._id ? { _id: c._id } : {}) })),
      tasks,
      lines,
      notes: rules.text(data.notes, 1000),
    };
  }

  // ---- writing: the draft ----------------------------------------------------------------------------------

  static create = withTransactionSession(async (data, createdBy, session) => {
    const { companyId, branchId } = getTenant();
    const prepared = await this.#prepare(data, { session });
    const jobNo = await NumberSeriesService.numberFor("JC", { typed: data.manualNumber, date: prepared.receivedAt, session, docType: "JobCard" });
    const [doc] = await JobCard.create([{ ...prepared, jobNo, companyId, branchId, createdBy, updatedBy: createdBy }], { session });
    return doc;
  });

  static update = withTransactionSession(async (id, data, updatedBy, session) => {
    const existing = await this.#load(id, session);
    if (existing.status !== "DRAFT") throw fail("Only a draft job card can be edited directly; use the estimate to add work once it has been sent", 409, "JOB_NOT_DRAFT");
    const prepared = await this.#prepare(data, { existing, session });
    Object.assign(existing, prepared, { updatedBy });
    await existing.save({ session });
    return existing;
  });

  static remove = withTransactionSession(async (id, removedBy, session) => {
    const existing = await this.#load(id, session);
    if (existing.status !== "DRAFT") throw fail("Only a draft job card can be deleted; cancel it instead", 409, "JOB_NOT_DRAFT");
    await existing.deleteOne({ session });
    return existing;
  });

  // ---- the estimate and its approval ---------------------------------------------------------------------

  static sendEstimate = withTransactionSession(async (id, sentBy, session) => {
    const card = await this.#load(id, session);
    if (card.status !== "DRAFT") throw fail(`This job is ${String(card.status).toLowerCase()}, not a draft`, 409, "JOB_NOT_DRAFT");
    if (!card.lines.length) throw fail("Add at least one line before sending the estimate", 400, "NOTHING_TO_ESTIMATE");
    const plan = rules.planEstimate(card.toObject(), { now: new Date(), by: sentBy });
    card.lines = plan.lines;
    card.estimate = { ...plan.estimate, sentAt: new Date(), sentBy };
    card.status = "AWAITING_APPROVAL";
    await card.save({ session });
    return card;
  });

  // The customer's (or the insurer's) decision: whole or in part, and how it was given. The first decision
  // releases the first stage of tasks and moves the card to IN_PROGRESS; a LATER decision (after teardown found
  // more and reviseEstimate added lines) only settles the lines actually named, leaving everything already
  // decided untouched - see utils/garage.js checkApproval and the comment below.
  static recordApproval = withTransactionSession(async (id, input, decidedBy, session) => {
    const card = await this.#load(id, session);
    if (!["AWAITING_APPROVAL", "IN_PROGRESS"].includes(card.status)) {
      throw fail(`This job is ${String(card.status).toLowerCase()}, not waiting for a decision`, 409, "JOB_NOT_AWAITING_APPROVAL");
    }
    const err = rules.checkApproval(input, card.toObject());
    if (err) throw fail(err.message, 409, err.code, err.details);

    const lineIds = Array.isArray(input.lineIds) ? input.lineIds.map(idOf) : null;
    const firstDecision = card.status === "AWAITING_APPROVAL";
    if (firstDecision) {
      if (lineIds) card.lines.forEach((l) => { l.approved = lineIds.includes(idOf(l._id)); });
      else card.lines.forEach((l) => { l.approved = true; });
    } else {
      // A later decision never re-opens what an earlier one already settled: it touches only the lines named,
      // or (nothing named) every line still pending from a revision.
      const target = lineIds || card.lines.filter((l) => l.approved === false).map((l) => idOf(l._id));
      card.lines.forEach((l) => { if (target.includes(idOf(l._id))) l.approved = true; });
    }

    card.estimate.decidedAt = new Date();
    card.estimate.decidedBy = decidedBy;
    card.estimate.method = input.method;
    card.estimate.reference = rules.text(input.reference, 60);
    card.estimate.note = rules.text(input.note, 300);

    if (firstDecision) {
      card.status = "IN_PROGRESS";
      card.tasks = rules.release(card.toObject().tasks, new Date());
    }
    await card.save({ session });
    return card;
  });

  // Teardown found more: a new version of the SAME card (never a second document), its new lines pending
  // until named in a later recordApproval. Work already released keeps running.
  static reviseEstimate = withTransactionSession(async (id, input, by, session) => {
    const card = await this.#load(id, session);
    if (!["AWAITING_APPROVAL", "IN_PROGRESS"].includes(card.status)) {
      throw fail(`Cannot revise the estimate while the job is ${String(card.status).toLowerCase()}`, 409, "JOB_NOT_REVISABLE");
    }
    const newLines = await this.#priceAndStampLines((input.lines || []).map((l) => ({ ...l, approved: false })), { session, date: card.receivedAt });
    if (!newLines.length) throw fail("Add at least one new line", 400, "NOTHING_TO_ADD");
    const plan = rules.planEstimate({ estimate: card.estimate.toObject(), lines: [...card.toObject().lines, ...newLines] }, { now: new Date(), by });
    card.lines = plan.lines;
    card.estimateHistory.push(card.estimate.toObject());
    card.estimate = { ...card.estimate.toObject(), version: plan.version, total: plan.estimate.total };
    await card.save({ session });
    return card;
  });

  // ---- tasks ------------------------------------------------------------------------------------------------

  static startTask = withTransactionSession(async (id, taskId, startedBy, session) => {
    const card = await this.#load(id, session);
    const task = card.tasks.find((t) => idOf(t._id) === idOf(taskId));
    if (!task) throw fail("That task is not on this job card", 404, "TASK_NOT_FOUND");
    if (task.status !== "READY") throw fail(`This task is ${String(task.status || "").toLowerCase()}`, 409, "TASK_NOT_READY");
    task.status = "IN_PROGRESS";
    task.startedAt = new Date();
    task.startedBy = startedBy;
    await card.save({ session });
    return card;
  });

  static completeTask = withTransactionSession(async (id, taskId, input, doneBy, session) => {
    const card = await this.#load(id, session);
    const index = card.tasks.findIndex((t) => idOf(t._id) === idOf(taskId));
    const task = index === -1 ? null : card.tasks[index];
    if (input?.skip) {
      if (!task) throw fail("That task is not on this job card", 404, "TASK_NOT_FOUND");
      if (!rules.OPEN_TASK.has(task.status)) throw fail(`This task is ${String(task.status || "").toLowerCase()}`, 409, "TASK_NOT_OPEN");
      task.status = "SKIPPED";
      task.holdReason = rules.text(input.holdReason, 80);
    } else {
      const err = rules.checkCompletion(task, input || {});
      if (err) throw fail(err.message, 409, err.code);
      task.status = "DONE";
      task.actualHours = input.actualHours == null || input.actualHours === "" ? task.standardHours : Number(input.actualHours);
      task.doneAt = new Date();
      task.doneBy = doneBy;
    }
    card.tasks = rules.advance(card.toObject().tasks, new Date());
    if (rules.allTasksSettled(card.toObject()) && card.status === "IN_PROGRESS") card.status = "READY";
    await card.save({ session });
    return card;
  });

  // ---- invoicing --------------------------------------------------------------------------------------------

  // One draft invoice from the approved lines, to one bill-to. A split job (insurer pays the repair, the
  // customer pays the excess and the depreciation) calls this twice with a different lineIds/billTo/partyId -
  // see services/garage/insuranceClaimService.js splitBill, which decides which lines go where.
  static createInvoice = withTransactionSession(async ({ jobCardId, billTo = "customer", partyId, lineIds, date }, createdBy, session) => {
    const card = await this.#load(jobCardId, session);
    if (!["IN_PROGRESS", "READY", "DELIVERED"].includes(card.status)) {
      throw fail("The estimate has not been approved yet, so there is nothing to invoice", 409, "JOB_NOT_READY_TO_INVOICE");
    }
    const wanted = lineIds ? new Set(lineIds.map(idOf)) : null;
    const lines = rules.approvedLines(card.toObject()).filter((l) => (wanted ? wanted.has(idOf(l._id)) : true));
    if (!lines.length) throw fail("There is nothing approved to invoice", 409, "NOTHING_TO_INVOICE");

    const resolvedPartyId = partyId || (billTo === "insurer" ? card.claimId : card.customerId);
    if (!isId(resolvedPartyId)) throw fail("Choose who this invoice bills", 400, billTo === "insurer" ? "INSURER_REQUIRED" : "CUSTOMER_REQUIRED");

    const items = lines.map((l) => S.toPricingInput(l, l.qty, l.qty));
    const invoice = await TransactionService.createTransaction(
      {
        type: "sales_order", partyId: resolvedPartyId, partyType: "Customer", partyTypeRef: "Customer",
        date: date || card.receivedAt || new Date(), items,
        notes: `Job card ${card.jobNo || "(draft)"}${billTo === "insurer" ? " - insurer's share" : ""}`, status: "DRAFT",
      },
      createdBy,
      session
    );

    card.invoices.push({ transactionId: invoice._id, no: invoice.transactionNo, billTo, amount: invoice.totalAmount, status: invoice.status });
    card.invoiceStatus = "DRAFT";
    await card.save({ session });
    return { jobCard: card, invoice };
  });

  // ---- handing the car back --------------------------------------------------------------------------------

  static releaseVehicle = withTransactionSession(async (id, input, releasedBy, session) => {
    const card = await this.#load(id, session);
    const txIds = (card.invoices || []).map((i) => i.transactionId).filter(Boolean);
    const open = txIds.length ? await Transaction.find({ _id: { $in: txIds } }).select("outstandingAmount").session(session).lean() : [];
    const outstanding = open.reduce((t, x) => t + (Number(x.outstandingAmount) || 0), 0);

    const check = rules.mayRelease(card.toObject(), { outstanding, mayOverride: Boolean(input?.override), onAccount: Boolean(input?.onAccount) });
    if (!check.ok) throw fail(check.message, 409, check.code, check.details);

    const deliveredDay = todayInOrg();
    const warranty = rules.warrantyUntil(
      { deliveredDay, odometerOut: input?.odometerOut, months: input?.warrantyMonths || 0, kilometres: input?.warrantyKm || 0 },
      { addMonths }
    );
    card.delivery = {
      gatePassAt: new Date(), releasedBy,
      odometerOut: input?.odometerOut == null || input?.odometerOut === "" ? undefined : Number(input.odometerOut),
      handedTo: rules.text(input?.handedTo, 150),
      signatureAttachmentId: input?.signatureAttachmentId || undefined,
    };
    card.warranty = { months: Number(input?.warrantyMonths) || 0, kilometres: Number(input?.warrantyKm) || 0, until: warranty.until, untilOdometer: warranty.untilOdometer };
    card.status = card.invoiceStatus === "INVOICED" ? "CLOSED" : "DELIVERED";
    await card.save({ session });

    if (card.delivery.odometerOut) {
      await Vehicle.updateOne({ _id: card.vehicleId }, { $set: { odometer: card.delivery.odometerOut, odometerAt: new Date() } }, { session });
    }
    return card;
  });

  static cancel = withTransactionSession(async (id, { reason } = {}, cancelledBy, session) => {
    const card = await this.#load(id, session);
    if (["DELIVERED", "CLOSED", "CANCELLED"].includes(card.status)) throw fail(`This job is already ${String(card.status).toLowerCase()}`, 409, "JOB_NOT_CANCELLABLE");
    if (!String(reason || "").trim()) throw fail("Say why the job is being cancelled", 400, "REASON_REQUIRED");
    card.status = "CANCELLED";
    card.cancelledAt = new Date();
    card.cancelledBy = cancelledBy;
    card.cancelReason = rules.text(reason, 300);
    await card.save({ session });
    return card;
  });
}

module.exports = JobCardService;
