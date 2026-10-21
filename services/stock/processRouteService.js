const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const ProcessRoute = require("../../models/modules/processRouteModel");
const rules = require("../../utils/processOrders");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg, toExpiryDay, addDays } = require("../../utils/documentExpiry");
const ProcessOrderService = require("./processOrderService");

// Saved routes (models/modules/processRouteModel.js): a product's materials for `batchQty` units and its steps, each
// with who usually does it and how many days it takes. One per product. `plan` turns a route into a new order's
// materials, steps and due dates (utils/processOrders.js orderFromRoute); nothing else reads a route.

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;

class ProcessRouteService {
  static present(doc) {
    const r = doc?.toObject ? doc.toObject() : doc;
    return { ...r, totalDays: (r.steps || []).reduce((t, s) => t + (Number(s.days) || 0), 0) };
  }

  static async list({ search } = {}) {
    const q = {};
    const text = String(search || "").trim();
    if (text) {
      const rx = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ "finished.itemName": rx }, { "finished.itemId": rx }, { "steps.name": rx }];
    }
    const rows = await ProcessRoute.find(q).sort({ "finished.itemName": 1, _id: 1 }).limit(500).lean();
    return rows.map((r) => this.present(r));
  }

  static async getById(id) {
    if (!isId(id)) throw fail("Route not found", 404, "NOT_FOUND");
    const r = await ProcessRoute.findById(id).lean();
    if (!r) throw fail("Route not found", 404, "NOT_FOUND");
    return this.present(r);
  }

  // The items, job workers and people are checked as an order's are (ProcessOrderService.prepare), then the days added.
  static async prepare(data, { session } = {}) {
    const errors = rules.validateRoute(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const p = await ProcessOrderService.prepare({ finished: { stockId: data.finished.stockId, qty: data.batchQty }, materials: data.materials, steps: data.steps }, { session });
    return {
      finished: { stockId: p.finished.stockId, itemId: p.finished.itemId, itemName: p.finished.itemName },
      batchQty: p.finished.qty,
      materials: p.materials,
      steps: p.steps.map((s, i) => ({
        name: s.name, mode: s.mode, assigneeId: s.assigneeId, assigneeName: s.assigneeName, jobWorkerId: s.jobWorkerId, jobWorkerName: s.jobWorkerName,
        notes: s.notes, days: Number(data.steps[i].days) || 0,
      })),
      notes: data.notes ? String(data.notes).trim().slice(0, 1000) : undefined,
    };
  }

  static create = withTransactionSession(async (data, by, session) => {
    const fields = await this.prepare(data, { session });
    const existing = await ProcessRoute.findOne({ "finished.stockId": fields.finished.stockId }).select("_id").session(session).lean();
    if (existing) throw fail(`${fields.finished.itemName} already has a route; change that one`, 409, "ROUTE_EXISTS", { id: existing._id });
    const [r] = await ProcessRoute.create([{ ...fields, createdBy: String(by || "system") }], { session });
    return r;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    if (!isId(id)) throw fail("Route not found", 404, "NOT_FOUND");
    const r = await ProcessRoute.findById(id).session(session);
    if (!r) throw fail("Route not found", 404, "NOT_FOUND");
    const fields = await this.prepare(data, { session });
    if (String(fields.finished.stockId) !== String(r.finished.stockId)) {
      const clash = await ProcessRoute.findOne({ "finished.stockId": fields.finished.stockId, _id: { $ne: r._id } }).select("_id").session(session).lean();
      if (clash) throw fail(`${fields.finished.itemName} already has a route; change that one`, 409, "ROUTE_EXISTS", { id: clash._id });
    }
    Object.assign(r, fields, { updatedBy: String(by || "system") });
    await r.save({ session });
    return r;
  });

  static remove = withTransactionSession(async (id, by, session) => {
    if (!isId(id)) throw fail("Route not found", 404, "NOT_FOUND");
    const r = await ProcessRoute.findById(id).session(session);
    if (!r) throw fail("Route not found", 404, "NOT_FOUND");
    await ProcessRoute.deleteOne({ _id: r._id }, { session });
    return r;
  });

  // A new order for `qty` of the product, planned from its route from `date` (default today): `{ route, order }`, both
  // null when the product has no route.
  static async plan({ stockId, qty, date } = {}) {
    if (!isId(stockId)) return { route: null, order: null };
    const r = await ProcessRoute.findOne({ "finished.stockId": stockId }).lean();
    if (!r) return { route: null, order: null };
    const n = qty === undefined || qty === "" ? Number(r.batchQty) : Number(qty);
    if (!(n > 0)) throw fail("Enter how many to make", 400, "INVALID_QTY");
    const startDay = toExpiryDay(date) || todayInOrg();
    return { route: this.present(r), order: rules.orderFromRoute(r, { qty: n, startDay, addDays }) };
  }
}

module.exports = ProcessRouteService;
