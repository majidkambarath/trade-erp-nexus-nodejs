const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const ContainerType = require("../../models/modules/vansales/containerTypeModel");
const VanContainerMove = require("../../models/modules/vansales/vanContainerMoveModel");
const Stock = require("../../models/modules/stockModel");
const Customer = require("../../models/modules/customerModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanContainers");
const kinds = require("../../utils/itemKinds");
const { allBranches } = require("../../utils/tenantContext");
const { getTenant } = require("../../utils/tenant");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg } = require("../../utils/documentExpiry");
const { loadTrip } = require("./vanTripStock");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const asAppError = (err) => (err instanceof rules.ContainerError ? fail(err.message, 400, err.code, err.details) : err);
const withSession = (q, session) => (session ? q.session(session) : q);

// Returnable containers on the vans (crates, bottles, cylinders): the types and the items that come in them, what changed
// hands with each customer, and what each customer holds. A container with a deposit charges it when given and refunds it
// when collected, through a debit or credit note to the customer against the `container-deposits` liability: its own
// document, so the invoice, its pricing, its posting and the VAT return are untouched. Pure arithmetic: utils/vanContainers.js.

const present = (t) => ({ id: String(t._id), code: t.code, name: t.name, deposit: Number(t.deposit) || 0, active: t.active !== false, items: (t.items || []).map((i) => ({ stockId: String(i.stockId), itemName: i.itemName || "", perUnit: i.perUnit })) });

class VanContainerService {
  // ---- the types -------------------------------------------------------------------------------------------------
  static async types({ includeInactive = false, session } = {}) {
    const rows = await withSession(ContainerType.find(includeInactive ? {} : { active: true }).sort({ name: 1 }).lean(), session);
    return rows.map(present);
  }

  static async #checked(input, exceptId) {
    let clean;
    try {
      clean = rules.validateType(input);
    } catch (err) {
      throw asAppError(err);
    }
    const ids = clean.items.map((i) => i.stockId);
    const stocks = ids.length ? await Stock.find({ _id: { $in: ids } }).select("itemName itemType").lean() : [];
    const names = new Map(stocks.map((s) => [String(s._id), s]));
    for (const it of clean.items) {
      const s = names.get(it.stockId);
      if (!s) throw fail("An item on the container does not exist", 404, "ITEM_NOT_FOUND");
      if (kinds.isService(s)) throw fail(`${s.itemName} is a service and comes in no container`, 400, "CONTAINER_ITEMS_INVALID");
      it.itemName = s.itemName;
    }
    // an item comes in one container: two would hand out both with every sale
    if (ids.length) {
      const other = await ContainerType.findOne({ active: true, "items.stockId": { $in: ids }, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select("name items").lean();
      if (other) {
        const clash = other.items.find((i) => ids.includes(String(i.stockId)));
        throw fail(`${names.get(String(clash.stockId))?.itemName || "An item"} already comes in ${other.name}`, 409, "ITEM_IN_OTHER_CONTAINER", { container: other.name });
      }
    }
    return clean;
  }

  static async create(input, by) {
    const clean = await this.#checked(input);
    if (await ContainerType.exists({ code: clean.code })) throw fail(`There is already a container ${clean.code}`, 409, "CONTAINER_CODE_TAKEN");
    const { companyId } = getTenant();
    const doc = await ContainerType.create({ ...clean, companyId, createdBy: String(by), updatedBy: String(by) });
    return present(doc.toObject());
  }

  static async update(id, input, by) {
    if (!isId(id)) throw fail("That container does not exist", 404, "CONTAINER_NOT_FOUND");
    const doc = await ContainerType.findById(id);
    if (!doc) throw fail("That container does not exist", 404, "CONTAINER_NOT_FOUND");
    const clean = await this.#checked({ ...present(doc.toObject()), ...input }, doc._id);
    if (clean.code !== doc.code && (await ContainerType.exists({ code: clean.code, _id: { $ne: doc._id } }))) throw fail(`There is already a container ${clean.code}`, 409, "CONTAINER_CODE_TAKEN");
    Object.assign(doc, clean, { updatedBy: String(by) });
    await doc.save();
    return present(doc.toObject());
  }

  // ---- what a customer holds ----------------------------------------------------------------------------------------

  /** What each customer holds, read across every branch (a customer is the organisation's): Map(customerId -> Map(typeId -> n)). */
  static async holdingsOf(customerIds, { session } = {}) {
    const ids = [...new Set((customerIds || []).map(String))].filter(isId).map((x) => new mongoose.Types.ObjectId(x));
    if (!ids.length) return new Map();
    const rows = await allBranches(() => withSession(VanContainerMove.aggregate([
      { $match: { customerId: { $in: ids } } },
      { $group: { _id: { c: "$customerId", t: "$typeId" }, given: { $sum: "$given" }, collected: { $sum: "$collected" } } },
    ]), session));
    const out = new Map();
    for (const r of rows) {
      const c = String(r._id.c);
      if (!out.has(c)) out.set(c, new Map());
      out.get(c).set(String(r._id.t), (Number(r.given) || 0) - (Number(r.collected) || 0));
    }
    return out;
  }

  /** One customer's containers: [{ typeId, code, name, holds, deposit, depositHeld }] for every type they hold or could. */
  static async balances(customerId, { session } = {}) {
    if (!isId(customerId)) throw fail("Choose a customer", 400, "CUSTOMER_REQUIRED");
    const [types, held] = await Promise.all([this.types({ includeInactive: true, session }), this.holdingsOf([customerId], { session })]);
    const mine = held.get(String(customerId)) || new Map();
    return types
      .filter((t) => t.active || (mine.get(t.id) || 0) !== 0)
      .map((t) => ({ typeId: t.id, code: t.code, name: t.name, holds: mine.get(t.id) || 0, deposit: t.deposit, depositHeld: rules.round2((mine.get(t.id) || 0) * t.deposit) }));
  }

  // ---- containers changing hands ------------------------------------------------------------------------------------

  /**
   * Write what changed hands with a customer, in the caller's transaction, and the deposit it is worth. `moves` is what
   * the person said ([{ typeId, given, collected }], already cleaned). A customer cannot hand back more than they hold
   * (with what they are given now) unless a supervisor says so: a refund on crates nobody gave them is money given away.
   * -> { moves, deposit, voucher }
   */
  static async record({ trip, customerId, moves, kind, transactionId, transactionNo, settleInvoiceId, by, byName, mayOverride = false, note, session }) {
    if (!moves.length) return { moves: [], deposit: 0, voucher: null };
    const types = await this.types({ includeInactive: true, session });
    const byType = new Map(types.map((t) => [t.id, t]));
    for (const m of moves) {
      const t = byType.get(m.typeId);
      if (!t || (!t.active && m.given > 0)) throw fail("That container is not in use", 404, "CONTAINER_NOT_FOUND");
    }
    const held = (await this.holdingsOf([customerId], { session })).get(String(customerId)) || new Map();
    if (!mayOverride) {
      for (const m of moves) {
        const can = (held.get(m.typeId) || 0) + m.given;
        if (m.collected > can) {
          throw fail(`The customer holds ${Math.max(0, held.get(m.typeId) || 0)} ${byType.get(m.typeId).name} on record, so ${m.collected} cannot come back. A supervisor can set what they hold.`, 409, "CONTAINERS_NOT_HELD", { typeId: m.typeId, holds: held.get(m.typeId) || 0 });
        }
      }
    }
    const depositByType = new Map(types.map((t) => [t.id, t.deposit]));
    const deposit = kind === "adjustment" ? 0 : rules.depositOf(moves, depositByType);
    let voucher = null;
    if (deposit !== 0) voucher = await this.#depositNote({ trip, customerId, moves, byType, deposit, transactionNo, settleInvoiceId, by, session });
    const { companyId, branchId } = getTenant();
    const rows = await VanContainerMove.insertMany(moves.map((m) => ({
      typeId: m.typeId, customerId, given: m.given, collected: m.collected, kind,
      ...(trip ? { tripId: trip._id, tripNo: trip.tripNo } : {}),
      ...(transactionId ? { transactionId, transactionNo } : {}),
      ...(voucher ? { voucherId: voucher._id } : {}),
      deposit: kind === "adjustment" ? 0 : byType.get(m.typeId).deposit,
      ...(note ? { note } : {}), at: new Date(), by: String(by), byName: byName || "", companyId, branchId: branchId || "main",
    })), { session });
    return { moves: rows, deposit, voucher };
  }

  /** The deposit as its own document: a debit note when the customer took more than they gave back, else a credit note. */
  static async #depositNote({ trip, customerId, moves, byType, deposit, transactionNo, settleInvoiceId, by, session }) {
    const AccountConfigService = require("../financial/accountConfigService");
    const FinancialService = require("../financial/financialService");
    const TaxCodeService = require("../financial/taxCodeService");
    const account = await AccountConfigService.resolveAccount("container-deposits", { session });
    // a refundable deposit is not a sale: it carries the organisation's out-of-scope code where there is one, so the VAT
    // return does not list it as a line nobody classified (verify the treatment with an adviser before quoting it)
    const noVat = await TaxCodeService.noVatCode(getTenant().companyId, { session });
    const words = moves.map((m) => [m.given ? `${m.given} given` : "", m.collected ? `${m.collected} back` : ""].filter(Boolean).join(", ") + ` ${byType.get(m.typeId).name}`).join("; ");
    const description = `Container deposit: ${words}${transactionNo ? ` (${transactionNo})` : ""}`.slice(0, 200);
    // a refund that fits on the invoice it came with is set against it, so the customer pays the invoice less the refund
    let referenceInvoiceId;
    if (deposit < 0 && settleInvoiceId) {
      const inv = await require("../../models/modules/transactionModel").findById(settleInvoiceId).select("outstandingAmount").session(session).lean();
      if (inv && Math.abs(deposit) <= Number(inv.outstandingAmount) + 0.005) referenceInvoiceId = settleInvoiceId;
    }
    const voucher = await FinancialService.createVoucher(
      {
        ...(referenceInvoiceId ? { referenceInvoiceId } : {}),
        voucherType: deposit > 0 ? "debit_note" : "credit_note", ledgerBased: true, partyId: customerId, partyType: "Customer", date: todayInOrg(),
        narration: description,
        lines: [{ accountId: account, amount: Math.abs(deposit), description, ...(noVat ? { taxCodeId: noVat._id } : {}) }],
      },
      by, session
    );
    if (trip) await Voucher.updateOne({ _id: voucher._id }, { $set: { vanTripRef: { tripId: trip._id, tripNo: trip.tripNo } } }, { session, strict: false });
    return voucher;
  }

  /** The posting key must exist before a transaction reads it: topped up lazily, outside it, like van-expenses. */
  static async ensureAccount(req) {
    if (!(await ContainerType.exists({ active: true, deposit: { $gt: 0 } }))) return;
    const AccountConfigService = require("../financial/accountConfigService");
    try {
      await AccountConfigService.resolveAccount("container-deposits");
    } catch (err) {
      if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
      await require("../financial/defaultChartService").provision(req);
    }
  }

  /** Empties collected (or containers handed over) at a stop with no sale, on the salesman's own trip. */
  static empties = withTransactionSession(async (tripId, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(tripId, session);
    if (trip.status !== "ON_ROUTE") throw fail("Containers are taken while the van is out", 409, "TRIP_NOT_ON_ROUTE");
    if (!isId(input?.customerId)) throw fail("Choose a customer", 400, "CUSTOMER_REQUIRED");
    const customer = await Customer.findById(input.customerId).select("_id status").session(session).lean();
    if (!customer || customer.status === "Inactive") throw fail("That customer is not available", 404, "CUSTOMER_NOT_FOUND");
    let moves;
    try {
      moves = rules.cleanMoves(input.containers);
    } catch (err) {
      throw asAppError(err);
    }
    if (!moves.length) throw fail("Enter how many containers changed hands", 400, "CONTAINERS_REQUIRED");
    return this.record({ trip, customerId: customer._id, moves, kind: "empties", by, byName: opts.byName, mayOverride: opts.mayOverride, session });
  });

  /**
   * A supervisor sets what a customer holds (what they already had at go-live, a count that turned out wrong): the
   * difference from what is on record, as an adjustment with a reason. No deposit moves: an adjustment is a record, not
   * a sale or a refund.
   */
  static adjust = withTransactionSession(async (input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    if (!isId(input?.customerId)) throw fail("Choose a customer", 400, "CUSTOMER_REQUIRED");
    if (!isId(input?.typeId)) throw fail("Choose the container", 400, "CONTAINER_REQUIRED");
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 300) : "";
    if (!reason) throw fail("Say why the holding is being set", 400, "REASON_REQUIRED");
    const holds = typeof input.holds === "number" || (typeof input.holds === "string" && input.holds.trim() !== "") ? Number(input.holds) : NaN;
    if (!Number.isInteger(holds) || holds < 0 || holds > 100000) throw fail("What the customer holds is a whole number of zero or more", 400, "CONTAINERS_INVALID");
    const customer = await Customer.findById(input.customerId).select("_id").session(session).lean();
    if (!customer) throw fail("That customer does not exist", 404, "CUSTOMER_NOT_FOUND");
    const now = (await this.holdingsOf([customer._id], { session })).get(String(customer._id))?.get(String(input.typeId)) || 0;
    const diff = holds - now;
    if (diff === 0) return { moves: [], deposit: 0, voucher: null, holds };
    const moves = [{ typeId: String(input.typeId), given: diff > 0 ? diff : 0, collected: diff < 0 ? -diff : 0 }];
    const r = await this.record({ customerId: customer._id, moves, kind: "adjustment", by, byName: opts.byName, mayOverride: true, note: reason, session });
    return { ...r, holds };
  });

  /**
   * The containers on a trip for the screens: the types in use (with the items that come in them, so the phone works out
   * what a sale hands out, also with no signal) and, per type, what was given, collected and should be on the van now.
   * Null where the organisation has no container types.
   */
  static async tripView(trip, stock, { session } = {}) {
    const types = await this.types({ session });
    if (!types.length) return null;
    const moves = await this.ofTrip(trip, { session });
    const expected = rules.expectedOnVan({ loaded: stock.loaded, moves }, types);
    const onVan = types.map((t) => {
      const mine = moves.filter((m) => String(m.typeId) === t.id);
      return { typeId: t.id, code: t.code, name: t.name, given: mine.reduce((n, m) => n + m.given, 0), collected: mine.reduce((n, m) => n + m.collected, 0), expected: expected.get(t.id) || 0 };
    });
    return { types, onVan };
  }

  /** What changed hands on a trip, per type: { given, collected } Map(typeId -> {...}), and the moves themselves. */
  static async ofTrip(trip, { session } = {}) {
    const moves = await withSession(VanContainerMove.find({ tripId: trip._id }).lean(), session);
    return moves;
  }
}

module.exports = VanContainerService;
