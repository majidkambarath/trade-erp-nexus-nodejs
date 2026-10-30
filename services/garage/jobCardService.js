const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const JobCard = require("../../models/modules/garage/jobCardModel");
const Vehicle = require("../../models/modules/garage/vehicleModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const Staff = require("../../models/modules/staffModel");
const Bay = require("../../models/modules/garage/bayModel");
const Admin = require("../../models/core/adminModel");
const Transaction = require("../../models/modules/transactionModel");
const Stock = require("../../models/modules/stockModel");
const rules = require("../../utils/garage");
const kinds = require("../../utils/itemKinds");
const ItemKindService = require("../stock/itemKindService");
const S = require("../orderPurchase/salesDocumentSupport");
const TransactionService = require("../orderPurchase/transactionService");
const TradeOrderService = require("../orderPurchase/tradeOrderService");
const NumberSeriesService = require("../core/numberSeriesService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const { addMonths } = require("../../utils/yearEnd");
const orgLocale = require("../../utils/orgLocale");
const tz = require("../../utils/tz");

// "Promised" is a day; an optional time narrows it to the hour actually told to the customer (D07: it was
// date-only, so "today" could read as a different day once stored). Combined in the organisation's own
// zone (utils/tz.js wallToInstant - the same construction the CRM's meetings use), so a promise typed as
// "2 pm" means 2 pm in Dubai, not wherever the server happens to run. A bare day with no time is left
// UNCHANGED: Mongoose casts "YYYY-MM-DD" to UTC midnight, the convention every other day-only field in
// this codebase already relies on - this only narrows it further when a time was actually given.
function promisedInstant(day, time) {
  if (!day) return undefined;
  const match = /^(\d{2}):(\d{2})$/.exec(String(time || "").trim());
  if (!match) return day;
  const [y, m, d] = String(day).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return day;
  return tz.wallToInstant(y, m, d, Number(match[1]), Number(match[2]), 0, 0, orgLocale.timezone());
}

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

  // What a screen may offer, computed from status alone (the request that actually acts is where the real
  // check is made - the button being shown is a convenience, never the guarantee). Same shape and purpose as
  // ProcessOrderService.present: the frontend reads `o.actions` / `task.actions` instead of re-deriving the
  // same status rules a second time.
  static present(doc) {
    const c = doc?.toObject ? doc.toObject() : doc;
    if (!c) return c;
    const status = c.status;
    return {
      ...c,
      totals: rules.jobTotals(c),
      // A line's real `lineTotal` (qty x price less discount, PLUS VAT) is the pricing engine's own figure,
      // stamped by #priceAndStampLines and now persisted (jobCardModel's lineSchema declares it - D01). The
      // fallback to rules.lineValue() - the PRE-VAT figure jobTotals/the board use - is for a line saved
      // before that fix and never re-priced since: it had no stored lineTotal at all (Mongoose silently
      // dropped it), so this used to compute one on every read, which is why the screen showed 0% VAT
      // everywhere lineTotal was displayed, not only on the printed estimate.
      lines: (c.lines || []).map((l) => ({ ...l, lineTotal: l.lineTotal || rules.lineValue(l) })),
      actions: {
        edit: status === "DRAFT",
        delete: status === "DRAFT",
        checkIn: status !== "CANCELLED",
        sendEstimate: status === "DRAFT",
        recordApproval: ["AWAITING_APPROVAL", "IN_PROGRESS"].includes(status),
        reviseEstimate: ["AWAITING_APPROVAL", "IN_PROGRESS"].includes(status),
        createInvoice: ["IN_PROGRESS", "READY", "DELIVERED"].includes(status) && rules.billableLines(c).length > 0,
        // A whitelist, like createInvoice above it, not "everything but DRAFT/CANCELLED": mayRelease (D05)
        // now refuses AWAITING_APPROVAL too (the customer has not decided yet), so the button agrees.
        release: ["IN_PROGRESS", "READY", "DELIVERED"].includes(status) && !c.delivery?.gatePassAt,
        cancel: !["DELIVERED", "CLOSED", "CANCELLED"].includes(status),
      },
      tasks: (c.tasks || []).map((t) => ({ ...t, actions: { start: t.status === "READY", complete: rules.OPEN_TASK.has(t.status) } })),
    };
  }

  static async getById(id) {
    const card = await this.#load(id);
    const presented = this.present(card);
    // delivery.releasedBy is a raw account id (D09): the gate pass used to print it as-is. One extra lookup
    // on the single-card read only, following the house pattern (InventoryMovementService.who): an account
    // removed since has no name to show, "system" reads as "System", nothing else is expected here.
    if (presented.delivery?.releasedBy) {
      presented.delivery = { ...presented.delivery, releasedByName: await this.#actorName(presented.delivery.releasedBy) };
    }
    return presented;
  }

  static async #actorName(raw) {
    const value = String(raw ?? "").trim();
    if (!value) return null;
    if (value.toLowerCase() === "system") return "System";
    if (!mongoose.isValidObjectId(value)) return value;
    const admin = await Admin.findById(value).select("name email").lean();
    return admin ? admin.name || admin.email || null : null;
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
      // D16: "Toyota" found nothing - the vehicle snapshot's own make was never searched, only its plate.
      filter.$or = [{ jobNo: rx }, { "vehicle.plateNumber": rx }, { "vehicle.make": rx }, { "customer.name": rx }];
    }
    return JobCard.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  }

  static async assignees() {
    // In-house technicians who may hold a login (the "optional login" decision): every active account, named,
    // same shape as the process-order board uses, so a single assignee picker can serve both modules.
    const rows = await Admin.find({ isActive: true, status: "active" }).select("name email").sort({ name: 1 }).lean();
    return rows.map((a) => ({ id: String(a._id), name: a.name || a.email }));
  }

  // A narrow read of the Staff directory, for naming who an in-house task goes to: name and designation only,
  // never the HR fields (idNo, contactNo, idProof, joiningDate) staff.view would otherwise hand over. Staff
  // records are deliberately their own module (Owner/Administrator only); a garage-only advisor still has to
  // put a name on a task, so this is the same narrow-read fix as customerChoices/vendorChoices above.
  static async staffChoices() {
    const rows = await Staff.find({ status: "Active" }).select("name designation").sort({ name: 1 }).lean();
    return rows.map((s) => ({ id: String(s._id), name: s.name, designation: s.designation || "" }));
  }

  // A narrow read of the parties, for a job card's own pickers - the CRM's own `customerChoices`
  // (services/crm/opportunityService.js) is the precedent: /customers/customers and /vendors/vendors need
  // sales.view/accounts.view or purchase.view/accounts.view, which a garage-only person does not hold. Id,
  // name, code and active, nothing else - no balance, no bank details, no credit limit.
  static async customerChoices(query = {}) {
    const q = {};
    const search = String(query.search || "").trim().slice(0, 80);
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ customerName: rx }, { customerId: rx }, { phone: rx }];
    }
    if (String(query.status || "") !== "all") q.status = { $ne: "Inactive" };
    const limit = Math.min(500, Math.max(1, Math.round(Number(query.limit)) || 200));
    const rows = await Customer.find(q).select("customerName customerId phone status isInsurer").sort({ customerName: 1, _id: 1 }).limit(limit).lean();
    return rows.map((r) => ({ id: String(r._id), name: r.customerName || "", code: r.customerId || "", phone: r.phone || "", active: r.status !== "Inactive", isInsurer: Boolean(r.isInsurer) }));
  }

  // The vehicle form's and the job card form's Owner/Customer pickers need to create a new customer on the
  // spot (a walk-in nobody has seen before) - the same quick-add gap the CRM closed for itself with its own
  // narrow customerChoices-style write, rather than sending a garage-only person to a Sales/Accounts screen
  // they may not even hold. One field only (a name): a one-person customer is the overwhelming case at a
  // garage counter, and the contact person is simply the same name until someone edits it on the real
  // Customers screen. garage.create is the permission, same door as opening a job card.
  static async createCustomer(name) {
    const trimmed = rules.text(name, 150);
    if (!trimmed) throw fail("Enter the customer's name", 400, "CUSTOMER_NAME_REQUIRED");
    const customerService = require("../customer/customerService");
    const c = await customerService.createCustomer({ customerName: trimmed, contactPerson: trimmed });
    return { id: String(c._id), name: c.customerName, code: c.customerId, phone: c.phone || "", active: true, isInsurer: false };
  }

  static async vendorChoices(query = {}) {
    const q = {};
    const search = String(query.search || "").trim().slice(0, 80);
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ vendorName: rx }, { vendorId: rx }];
    }
    if (String(query.status || "") !== "all") q.status = { $ne: "Inactive" };
    const limit = Math.min(500, Math.max(1, Math.round(Number(query.limit)) || 200));
    const rows = await Vendor.find(q).select("vendorName vendorId status").sort({ vendorName: 1, _id: 1 }).limit(limit).lean();
    return rows.map((r) => ({ id: String(r._id), name: r.vendorName || "", code: r.vendorId || "", active: r.status !== "Inactive" }));
  }

  // A returning vehicle's open comebacks: earlier jobs still within their warranty (by date or by odometer),
  // offered for the advisor to mark the new card against - never decided automatically (utils/garage.js
  // comebackCandidates: only the advisor knows whether today's noise is yesterday's fault).
  static async comebackCandidates({ vehicleId, odometer } = {}) {
    if (!isId(vehicleId)) return [];
    const today = todayInOrg();
    const jobs = await JobCard.find({ vehicleId, status: { $in: ["DELIVERED", "CLOSED"] } }).select("jobNo delivery.gatePassAt warranty tasks").limit(100).lean();
    return rules.comebackCandidates(jobs, { today, odometer, dayOf: (v) => toExpiryDay(v) });
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

  // What this card itself cannot have today: for each part/consumable it needs, on hand less what every
  // OTHER live, uninvoiced card has already committed (the same honest "free to sell" figure `committed()`
  // gives the stock list, just excluding this card's own lines so it is not counted against itself). Plan
  // part 1.2 step 8: "if a part is not in stock, a purchase order goes to a vendor" - this is what tells the
  // advisor there IS something to order, and `item.vendorId` (the item's own default supplier) is offered as
  // who to order it from. Nothing here moves stock or creates anything; raisePurchaseOrder below does that.
  static async shortages(id) {
    const card = await this.#load(id);
    // A cancelled job needs nothing bought for it (D21) - unlike every other write on the card, this had
    // no status check at all, so "Short of stock" and "Raise purchase order" kept offering on a dead card.
    if (card.status === "CANCELLED") return [];
    const needLines = (card.lines || []).filter((l) => rules.STOCKED_KINDS.has(l.kind) && rules.isApproved(l));
    if (!needLines.length) return [];
    const itemIds = [...new Set(needLines.map((l) => String(l.itemId)))];
    const objectIds = itemIds.map((i) => new mongoose.Types.ObjectId(i));

    const [stocks, committedRows] = await Promise.all([
      Stock.find({ _id: { $in: objectIds } }).select("itemId sku itemName currentStock vendorId purchasePrice").populate("vendorId", "vendorName").lean(),
      JobCard.aggregate([
        { $match: { status: { $in: [...rules.LIVE_STATUS] }, invoiceStatus: { $ne: "INVOICED" }, _id: { $ne: card._id } } },
        { $unwind: "$lines" },
        { $match: { "lines.itemId": { $in: objectIds }, "lines.kind": { $in: [...rules.STOCKED_KINDS] }, "lines.approved": { $ne: false } } },
        { $group: { _id: "$lines.itemId", qty: { $sum: "$lines.qty" } } },
      ]),
    ]);
    const stockById = new Map(stocks.map((s) => [String(s._id), s]));
    const committedById = new Map(committedRows.map((r) => [String(r._id), r.qty]));
    const neededById = new Map();
    for (const l of needLines) neededById.set(String(l.itemId), (neededById.get(String(l.itemId)) || 0) + (Number(l.qty) || 0));

    const out = [];
    for (const [itemId, needed] of neededById) {
      const stock = stockById.get(itemId);
      const onHand = Number(stock?.currentStock) || 0;
      const committedElsewhere = Number(committedById.get(itemId)) || 0;
      const short = rules.round3(Math.max(0, needed - (onHand - committedElsewhere)));
      if (short <= 0) continue;
      out.push({
        itemId, itemCode: stock?.itemId || "", itemName: stock?.itemName || "Unknown item", needed: rules.round3(needed),
        onHand: rules.round3(onHand), short, vendorId: stock?.vendorId?._id ? String(stock.vendorId._id) : null, vendorName: stock?.vendorId?.vendorName || "",
        purchasePrice: Number(stock?.purchasePrice) || 0,
      });
    }
    return out;
  }

  // Raises a draft purchase order for the chosen shortages, through the ordinary Purchase flow
  // (TradeOrderService.create, kind "purchase") - this is informational on the card from here: the
  // storekeeper confirms, receives and invoices it through the normal Purchase screens, not through the job
  // card, exactly as the plan says ("then the part reaches the job"). A record of it is kept so the advisor
  // can see one was raised and follow it up, the same shape `invoices[]` already keeps for the sales side.
  static raisePurchaseOrder = withTransactionSession(async ({ jobCardId, vendorId, items, date }, createdBy, session) => {
    const card = await this.#load(jobCardId, session);
    if (card.status === "CANCELLED") throw fail("This job was cancelled", 409, "JOB_CANCELLED");
    if (!Array.isArray(items) || !items.length) throw fail("Choose at least one item to order", 400, "NOTHING_TO_ORDER");
    if (!isId(vendorId)) throw fail("Choose who to order from", 400, "VENDOR_REQUIRED");
    // No vatPercent here (D01, same cause as the job-card lines): leaving the rate unset lets
    // TaxCodeService.applyToItems put the organisation's default on it, same as any other purchase, rather
    // than an explicit 0 it would never have overridden.
    const lines = items
      .filter((it) => isId(it?.itemId) && Number(it?.qty) > 0)
      .map((it) => ({ itemId: it.itemId, qty: Number(it.qty), price: Number(it.price) || 0, rate: Number(it.price) || 0 }));
    if (!lines.length) throw fail("Choose at least one item to order", 400, "NOTHING_TO_ORDER");

    const vendor = await Vendor.findById(vendorId).select("vendorName").session(session).lean();
    if (!vendor) throw fail("That vendor does not exist", 404, "VENDOR_REQUIRED");
    const order = await TradeOrderService.create({ kind: "purchase", partyId: vendorId, items: lines, date, notes: `Short parts for job card ${card.jobNo || "(draft)"}` }, createdBy, session);
    card.purchaseOrders.push({ tradeOrderId: order._id, no: order.orderNo, vendorId, vendorName: vendor.vendorName || "", amount: order.totalAmount, itemIds: lines.map((l) => l.itemId) });
    await card.save({ session });
    return { jobCard: card, order };
  });

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
    const bayIds = [...new Set(tasks.filter((t) => t.bayId).map((t) => idOf(t.bayId)))].filter(isId);
    const [staff, vendors, bays] = await Promise.all([
      staffIds.length ? Staff.find({ _id: { $in: staffIds } }).select("name").session(session || null).lean() : [],
      vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select("vendorName").session(session || null).lean() : [],
      bayIds.length ? Bay.find({ _id: { $in: bayIds } }).select("name").session(session || null).lean() : [],
    ]);
    const staffById = new Map(staff.map((s) => [String(s._id), s.name]));
    const vendorById = new Map(vendors.map((v) => [String(v._id), v.vendorName]));
    const bayById = new Map(bays.map((b) => [String(b._id), b.name]));
    return tasks.map((t, i) => ({
      seq: i + 1,
      stage: t.stage == null || t.stage === "" ? 1 : Number(t.stage),
      name: rules.text(t.name, 80),
      mode: t.mode,
      ...(t.mode === "in_house"
        ? { staffId: t.staffId || undefined, staffName: staffById.get(idOf(t.staffId)) || rules.text(t.staffName, 120), assigneeId: t.assigneeId || undefined }
        : { vendorId: t.vendorId, vendorName: vendorById.get(idOf(t.vendorId)) || "" }),
      ...(t.bayId && isId(t.bayId) ? { bayId: t.bayId, bayName: bayById.get(idOf(t.bayId)) || "" } : {}),
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

    // Offered, never decided (utils/garage.js comebackCandidates): only set when the body actually names one,
    // and only Object.assign's own rule applies on an edit - an omitted field leaves what is already stored.
    let comebackOf;
    if (data.comebackOf) {
      if (!isId(data.comebackOf)) throw fail("That is not an earlier job on this vehicle", 400, "COMEBACK_NOT_FOUND");
      const earlier = await JobCard.findOne({ _id: data.comebackOf, vehicleId: vehicle._id }).select("_id").session(session || null).lean();
      if (!earlier) throw fail("That earlier job is not on this vehicle", 404, "COMEBACK_NOT_FOUND");
      comebackOf = earlier._id;
    }

    return {
      jobType: data.jobType || "retail",
      vehicleId: vehicle._id,
      vehicle: { plateNumber: vehicle.plateNumber, make: vehicle.make, model: vehicle.model, year: vehicle.year, colour: vehicle.colour, chassisNo: vehicle.chassisNo },
      customerId: customer._id,
      customer: { name: customer.customerName, phone: customer.phone || "" },
      receivedAt: data.receivedAt || existing?.receivedAt || new Date(),
      promisedAt: promisedInstant(data.promisedAt, data.promisedTime),
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
      ...(comebackOf ? { comebackOf } : {}),
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

  // The walk-around: damage points, what the customer had with them, photos, the condition notes - the
  // garage's only defence when a customer later claims the car arrived undamaged. A NARROW write (only the
  // checkIn subdocument), never the whole-card #prepare `update` above, so recording it cannot touch the
  // vehicle, the customer, the estimate or the tasks. Refused only once the job is dead (CANCELLED): the
  // record of how the car arrived stays correctable for as long as the job itself is still real.
  static recordCheckIn = withTransactionSession(async (id, data, updatedBy, session) => {
    const existing = await this.#load(id, session);
    if (existing.status === "CANCELLED") throw fail("This job was cancelled", 409, "JOB_CANCELLED");
    const points = Array.isArray(data?.damagePoints) ? data.damagePoints : [];
    const bad = points.find((p) => p?.kind && !rules.DAMAGE_KINDS.includes(p.kind));
    if (bad) throw fail(`"${bad.kind}" is not a kind of damage this records`, 400, "INVALID_DAMAGE_KIND");
    existing.checkIn = {
      damagePoints: points.map((p) => ({ panel: rules.text(p?.panel, 60), kind: rules.DAMAGE_KINDS.includes(p?.kind) ? p.kind : undefined, notes: rules.text(p?.notes, 200) })),
      itemsPresent: Array.isArray(data?.itemsPresent) ? data.itemsPresent.map((s) => rules.text(s, 60)).filter(Boolean) : [],
      photos: Array.isArray(data?.photos) ? data.photos.filter((p) => isId(p)) : [],
      signatureAttachmentId: isId(data?.signatureAttachmentId) ? data.signatureAttachmentId : undefined,
      notes: rules.text(data?.notes, 500),
    };
    existing.updatedBy = updatedBy;
    await existing.save({ session });
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
    const approved = rules.approvedLines(card.toObject());
    if (!approved.length) throw fail("There is nothing approved to invoice", 409, "NOTHING_TO_INVOICE");
    // Approved is not the same as billable: a line already carried on an earlier invoice (this job's own, or -
    // for an insurance job - the insurer's share an InsuranceClaim already raised) must not be offered again,
    // or the same repair is billed twice, once to each party.
    const billable = rules.billableLines(card.toObject());
    if (!billable.length) throw fail("Every approved line on this job has already been invoiced", 409, "ALREADY_INVOICED");
    const wanted = lineIds ? new Set(lineIds.map(idOf)) : null;
    const lines = billable.filter((l) => (wanted ? wanted.has(idOf(l._id)) : true));
    if (!lines.length) throw fail("Nothing was chosen to invoice, or it has already been billed", 409, "NOTHING_TO_INVOICE");

    const resolvedPartyId = partyId || (billTo === "insurer" ? card.claimId : card.customerId);
    if (!isId(resolvedPartyId)) throw fail("Choose who this invoice bills", 400, billTo === "insurer" ? "INSURER_REQUIRED" : "CUSTOMER_REQUIRED");

    const items = lines.map((l) => S.toPricingInput(l, l.qty, l.qty));
    const invoice = await TransactionService.createTransaction(
      {
        type: "sales_order", partyId: resolvedPartyId, partyType: "Customer", partyTypeRef: "Customer",
        date: date || card.receivedAt || new Date(), items,
        notes: `Job card ${card.jobNo || "(draft)"}${billTo === "insurer" ? " - insurer's share" : ""}`, status: "DRAFT",
        // A structured link, not only the free-text note above: the printed tax invoice reads this to
        // show the job number and the plate, which a garage invoice needs and the note cannot answer for.
        jobCardRef: { jobCardId: card._id, jobNo: card.jobNo || undefined, plateNumber: card.vehicle?.plateNumber || undefined },
      },
      createdBy,
      session
    );

    for (const l of lines) {
      const sub = card.lines.id(l._id);
      if (sub) sub.invoiced = true;
    }
    card.invoices.push({ transactionId: invoice._id, no: invoice.transactionNo, billTo, amount: invoice.totalAmount, status: invoice.status, lineIds: lines.map((l) => l._id) });
    card.invoiceStatus = "DRAFT";
    await card.save({ session });
    return { jobCard: card, invoice };
  });

  // ---- handing the car back --------------------------------------------------------------------------------

  static releaseVehicle = withTransactionSession(async (id, input, releasedBy, session) => {
    const card = await this.#load(id, session);
    const txIds = (card.invoices || []).map((i) => i.transactionId).filter(Boolean);
    const open = txIds.length ? await Transaction.find({ _id: { $in: txIds } }).select("outstandingAmount").session(session).lean() : [];
    const invoicedOutstanding = open.reduce((t, x) => t + (Number(x.outstandingAmount) || 0), 0);
    // Approved lines never put on ANY invoice - draft or posted - are not in the sum above at all (D05):
    // without this a job whose work was approved but never invoiced reported 0 owed.
    const unbilled = rules.billableValue(card.toObject());
    const outstanding = rules.round2(invoicedOutstanding + unbilled);

    const check = rules.mayRelease(card.toObject(), { outstanding, mayOverride: Boolean(input?.override), onAccount: Boolean(input?.onAccount) });
    if (!check.ok) throw fail(check.message, 409, check.code, check.details);

    // odometerOut had no floor at all before (D11), unlike odometerIn - a typed "-5" would have been stored
    // as a real reading with no refusal.
    if (input?.odometerOut !== undefined && input?.odometerOut !== "" && !(Number(input.odometerOut) >= 0)) {
      throw fail("Enter the odometer reading in kilometres", 400, "INVALID_ODOMETER");
    }

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
