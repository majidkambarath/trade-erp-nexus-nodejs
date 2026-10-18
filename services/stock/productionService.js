const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const ProductionOrder = require("../../models/modules/productionOrderModel");
const Stock = require("../../models/modules/stockModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const costing = require("../../utils/inventoryCosting");
const rules = require("../../utils/production");
const orgLocale = require("../../utils/orgLocale");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg, orgDay, toExpiryDay } = require("../../utils/documentExpiry");
const NumberSeriesService = require("../core/numberSeriesService");
const FiscalYearService = require("../core/fiscalYearService");
const AccountConfigService = require("../financial/accountConfigService");
const { writeEntries } = require("../financial/ledgerBalances");
const BatchService = require("./batchService");
const ItemKindService = require("./itemKindService");

// A production (see models/modules/productionOrderModel.js): materials out of stock at their average
// cost, expenses already paid moved into the cost of the item made, the finished item in at the sum.
//
// Ledger (posting on):  Dr Inventory  materials + costs
//                       Cr Inventory  materials
//                       Cr Production costs moved to stock (key "production-absorbed")  each cost
// The expense accounts keep what was spent on them; the P&L shows the amount moved as its own line, and
// the finished item's sale books the whole cost as cost of goods sold.
//
// Not built (v1): back-dating behind later stock movements, partial completion / work in progress, saved
// recipes, scrap, linking a cost line to the expense voucher that paid it.

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.Types.ObjectId.isValid(v) && String(v).length === 24;
const LIVE = { isReversed: { $ne: true }, referenceNumber: { $not: /^REV-/ } };
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdminId = (v) => (isId(v) ? new mongoose.Types.ObjectId(String(v)) : SYSTEM_USER);
const poolOf = (stock) => ({
  quantity: Number(stock.currentStock) || 0,
  costValue: stock.costValue ?? costing.roundValue((Number(stock.currentStock) || 0) * (stock.purchasePrice || 0)),
  avgRate: costing.roundRate(stock.purchasePrice || 0),
});

function dayOf(value) {
  const day = toExpiryDay(value);
  return day ? new Date(`${day}T00:00:00.000Z`) : null;
}

// A production's stock moves on its DAY, stored at midnight like every document's date (an invoice dated today is
// midnight too), so the cost replay (RecostService.recostItem, ordered by date then createdAt) puts two things of the same
// day in the order they were entered. Stamping the clock time instead put a same-day invoice entered AFTER the production
// before it, and the replay counted the production twice in the item's stored value (found on the live books). Nothing of a
// LATER day may have moved its items (LATER_MOVEMENTS_EXIST): this is that day's last moment.
function lastMomentOf(date) {
  return orgLocale.endOfDay(orgDay(date));
}

// "Production costs moved to stock". A company whose posting map predates the key gets the defaults added
// once and tries again; read outside any session, because the top-up commits on its own.
async function absorbedAccount() {
  try {
    return await AccountConfigService.resolveAccount("production-absorbed");
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await require("../financial/defaultChartService").provision();
    return AccountConfigService.resolveAccount("production-absorbed");
  }
}

// Where each cost's credit goes: a "Production Costs Moved to Stock" account in the SAME group as the expense, so the
// P&L shows the expense and the amount moved out of it side by side (an expense filed under Cost of Goods Sold is
// offset inside cost of sales, and gross profit stays right). The posting key's own account serves its own group
// (and an expense with no group); another group gets one made on first use, the way a party account is.
const CONTRA_NAME = "Production Costs Moved to Stock";
async function contraAccounts(costs, absorbedId, session) {
  const out = new Map();
  if (!costs.length) return out;
  const AccountGroupService = require("../financial/accountGroupService");
  const ids = [...new Set(costs.map((c) => String(c.accountId)))];
  const [keyed, expenses] = await Promise.all([
    LedgerAccount.findById(absorbedId).select("groupId").session(session).lean(),
    LedgerAccount.find({ _id: { $in: ids } }).select("groupId subType").session(session).lean(),
  ]);
  const byGroup = new Map();
  for (const e of expenses) {
    const group = e.groupId ? String(e.groupId) : null;
    if (!group || !keyed?.groupId || group === String(keyed.groupId)) { out.set(String(e._id), String(absorbedId)); continue; }
    if (!byGroup.has(group)) {
      let contra = await LedgerAccount.findOne({ groupId: e.groupId, accountType: "expense", accountName: CONTRA_NAME }).select("_id").session(session).lean();
      if (!contra) {
        const accountCode = await AccountGroupService.generateNextAccountCode(e.groupId, { session });
        [contra] = await LedgerAccount.create(
          [{
            accountCode, accountName: CONTRA_NAME, accountType: "expense", subType: e.subType || "operating_expense", groupId: e.groupId,
            allowDirectPosting: true, isSystemAccount: true, createdBy: SYSTEM_USER,
            description: "Expenses of this group moved into the cost of items made in productions (each expense keeps what was spent on it).",
          }],
          { session }
        );
      }
      byGroup.set(group, String(contra._id));
    }
    out.set(String(e._id), byGroup.get(group));
  }
  return out;
}

class ProductionService {
  static absorbedAccount = absorbedAccount; // for a caller that posts inside its own transaction (job work)
  static CONTRA_NAME = CONTRA_NAME;

  // ---- reading -------------------------------------------------------------------------------------------

  static present(doc) {
    const p = doc?.toObject ? doc.toObject() : doc;
    return {
      ...p,
      actions: {
        edit: p.status === "DRAFT",
        delete: p.status === "DRAFT",
        post: p.status === "DRAFT",
        reverse: p.status === "POSTED" && !p.source?.kind, // made by a job-work receipt or a process order: undone there
      },
    };
  }

  static async list(query = {}) {
    const q = {};
    if (["DRAFT", "POSTED", "REVERSED"].includes(query.status)) q.status = query.status;
    const from = dayOf(query.from || query.dateFrom);
    const to = dayOf(query.to || query.dateTo);
    if (from || to) q.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    if (isId(query.itemId)) q.$or = [{ "finished.stockId": query.itemId }, { "materials.stockId": query.itemId }];
    const search = String(query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const or = [{ productionNo: rx }, { "finished.itemName": rx }, { "finished.itemId": rx }, { notes: rx }];
      q.$and = [...(q.$or ? [{ $or: q.$or }] : []), { $or: or }];
      delete q.$or;
    }
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    const rows = await ProductionOrder.find(q).sort({ date: -1, _id: -1 }).limit(limit).lean();
    return rows.map((r) => this.present(r));
  }

  static async getById(id) {
    if (!isId(id)) throw fail("Production not found", 404, "NOT_FOUND");
    const p = await ProductionOrder.findById(id).lean();
    if (!p) throw fail("Production not found", 404, "NOT_FOUND");
    const out = this.present(p);
    if (p.status === "DRAFT") out.preview = await this.preview(p);
    return out;
  }

  // What posting a draft would do today: each material at its current average, and what is on hand.
  static async preview(p, { session } = {}) {
    const ids = [p.finished.stockId, ...p.materials.map((m) => m.stockId)];
    const stocks = await Stock.find({ _id: { $in: ids } }).select("itemName currentStock purchasePrice costValue").session(session || null).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    const materials = p.materials.map((m) => {
      const s = byId.get(String(m.stockId));
      const pool = s ? poolOf(s) : { quantity: 0, avgRate: 0, costValue: 0 };
      const cost = costing.roundValue(Number(m.qty) * pool.avgRate);
      return { stockId: m.stockId, onHand: pool.quantity, unitCost: pool.avgRate, cost, short: Math.max(0, Number(m.qty) - pool.quantity) };
    });
    return { materials, totals: rules.totals({ materialCosts: materials.map((m) => m.cost), costs: p.costs, qty: p.finished.qty }) };
  }

  static async costReport(query = {}) {
    const q = { status: "POSTED" };
    const from = dayOf(query.from || query.dateFrom);
    const to = dayOf(query.to || query.dateTo);
    if (from || to) q.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
    if (isId(query.itemId)) q["finished.stockId"] = query.itemId;
    const rows = await ProductionOrder.find(q).sort({ date: 1, _id: 1 }).lean();
    return rules.costReport(rows);
  }

  // ---- drafts --------------------------------------------------------------------------------------------

  // Checks the input against the item master and the chart, and returns what is stored.
  static async prepare(data, { session } = {}) {
    const errors = rules.validate(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const materials = rules.mergeMaterials(data.materials || []);
    for (const m of [data.finished, ...materials]) {
      if (!isId(m.stockId)) throw fail("Item not found", 400, "ITEM_NOT_FOUND");
    }
    const ids = [data.finished.stockId, ...materials.map((m) => m.stockId)];
    const stocks = await Stock.find({ _id: { $in: ids } }).select("itemId itemName itemType status").session(session || null).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    const itemOf = (stockId, what) => {
      const s = byId.get(String(stockId));
      if (!s) throw fail("Item not found", 400, "ITEM_NOT_FOUND");
      ItemKindService.assertStocked(s, what);
      return s;
    };
    const finishedItem = itemOf(data.finished.stockId, "be made in a production");

    const costs = data.costs || [];
    const accountIds = costs.map((c) => String(c.accountId));
    if (accountIds.some((a) => !isId(a))) throw fail("Expense account not found", 400, "INVALID_COST_ACCOUNT");
    const accounts = accountIds.length
      ? await LedgerAccount.find({ _id: { $in: accountIds } }).select("accountName accountCode accountType isActive allowDirectPosting").session(session || null).lean()
      : [];
    const accById = new Map(accounts.map((a) => [String(a._id), a]));
    // the accounts the posting itself uses cannot also be a cost (it would move a figure into itself)
    const reserved = new Set();
    for (const key of ["inventory-asset", "cogs", "production-absorbed"]) {
      try { reserved.add(String(await AccountConfigService.resolveAccount(key, { session }))); } catch { /* not mapped: nothing to keep apart */ }
    }
    const storedCosts = costs.map((c, i) => {
      const a = accById.get(String(c.accountId));
      if (!a) throw fail(`Cost ${i + 1}: expense account not found`, 400, "INVALID_COST_ACCOUNT");
      if (a.accountType !== "expense") throw fail(`Cost ${i + 1}: ${a.accountName} is not an expense account`, 400, "INVALID_COST_ACCOUNT");
      if (a.isActive === false || a.allowDirectPosting === false) throw fail(`Cost ${i + 1}: ${a.accountName} cannot take postings`, 400, "INVALID_COST_ACCOUNT");
      if (reserved.has(String(a._id)) || a.accountName === CONTRA_NAME) throw fail(`Cost ${i + 1}: ${a.accountName} cannot be moved into a product's cost`, 400, "INVALID_COST_ACCOUNT");
      return { accountId: a._id, accountCode: a.accountCode, accountName: a.accountName, amount: costing.roundValue(Number(c.amount)), narration: c.narration ? String(c.narration).trim().slice(0, 300) : undefined };
    });

    const date = data.date ? dayOf(data.date) : dayOf(todayInOrg());
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    if (orgDay(date) > todayInOrg()) throw fail("A production cannot be dated in the future", 400, "INVALID_DATE");

    return {
      date,
      finished: {
        stockId: finishedItem._id, itemId: finishedItem.itemId, itemName: finishedItem.itemName,
        qty: Math.round(Number(data.finished.qty) * 1000) / 1000,
        batchNumber: data.finished.batchNumber ? String(data.finished.batchNumber).trim().slice(0, 60) : undefined,
        expiryDate: data.finished.expiryDate ? dayOf(data.finished.expiryDate) : undefined,
      },
      materials: materials.map((m) => {
        const s = itemOf(m.stockId, "be used in a production");
        return { stockId: s._id, itemId: s.itemId, itemName: s.itemName, qty: m.qty };
      }),
      costs: storedCosts,
      notes: data.notes ? String(data.notes).trim().slice(0, 1000) : undefined,
    };
  }

  static create = withTransactionSession(async (data, by, session) => {
    const fields = await this.prepare(data, { session });
    const productionNo = await NumberSeriesService.allocate("PRD", fields.date, { session });
    const totals = rules.totals({ materialCosts: [], costs: fields.costs, qty: fields.finished.qty });
    const [p] = await ProductionOrder.create([{ ...fields, productionNo, status: "DRAFT", totals, createdBy: String(by || "system") }], { session });
    return p;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const p = await this.loadDraft(id, session);
    const cur = p.toObject(); // plain values: the rules spread lines, and a subdocument spreads its internals
    const fields = await this.prepare(
      {
        date: data.date ?? toExpiryDay(cur.date),
        finished: data.finished ?? cur.finished,
        materials: data.materials ?? cur.materials,
        costs: data.costs ?? cur.costs,
        notes: data.notes ?? cur.notes,
      },
      { session }
    );
    Object.assign(p, fields, { totals: rules.totals({ materialCosts: [], costs: fields.costs, qty: fields.finished.qty }), updatedBy: String(by || "system") });
    await p.save({ session });
    return p;
  });

  static remove = withTransactionSession(async (id, by, session) => {
    const p = await this.loadDraft(id, session);
    await ProductionOrder.deleteOne({ _id: p._id }, { session });
    return p;
  });

  static async loadDraft(id, session) {
    if (!isId(id)) throw fail("Production not found", 404, "NOT_FOUND");
    const p = await ProductionOrder.findById(id).session(session);
    if (!p) throw fail("Production not found", 404, "NOT_FOUND");
    if (p.status !== "DRAFT") throw fail(`${p.productionNo} is ${p.status.toLowerCase()}; only a draft can be changed`, 409, "PRODUCTION_NOT_DRAFT");
    return p;
  }

  // ---- posting -------------------------------------------------------------------------------------------

  // A cost moved in is meant to be money already spent on that expense. Warns (the person ticks it) when an
  // account has had less spent on it, this fiscal year up to the production's day, than is being moved out of
  // it here and by the other posted productions of the same period.
  static async spendWarnings(p, { session } = {}) {
    if (!p.costs.length) return [];
    const day = orgDay(p.date);
    const fy = await FiscalYear.findOne({ startDate: { $lte: orgLocale.endOfDay(day) }, endDate: { $gte: orgLocale.dayStart(day) } }).session(session).lean();
    const start = fy?.startDate || orgLocale.dayStart(`${day.slice(0, 4)}-01-01`);
    const end = orgLocale.endOfDay(day);
    const wanted = new Map();
    for (const c of p.costs) wanted.set(String(c.accountId), costing.roundValue((wanted.get(String(c.accountId)) || 0) + c.amount));
    const ids = [...wanted.keys()].map((x) => new mongoose.Types.ObjectId(x));
    const [spent, moved] = await Promise.all([
      LedgerEntry.aggregate([
        { $match: { accountId: { $in: ids }, isReversed: { $ne: true }, date: { $gte: start, $lte: end } } },
        { $group: { _id: "$accountId", net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
      ]).session(session),
      ProductionOrder.aggregate([
        { $match: { status: "POSTED", _id: { $ne: p._id }, date: { $gte: start, $lte: end } } },
        { $unwind: "$costs" },
        { $match: { "costs.accountId": { $in: ids } } },
        { $group: { _id: "$costs.accountId", amount: { $sum: "$costs.amount" } } },
      ]).session(session),
    ]);
    const spentBy = new Map(spent.map((r) => [String(r._id), costing.roundValue(r.net)]));
    const movedBy = new Map(moved.map((r) => [String(r._id), costing.roundValue(r.amount)]));
    const warnings = [];
    for (const [accountId, amount] of wanted) {
      const left = costing.roundValue((spentBy.get(accountId) || 0) - (movedBy.get(accountId) || 0));
      if (amount > left + 0.005) {
        const name = p.costs.find((c) => String(c.accountId) === accountId)?.accountName || "This account";
        warnings.push({
          code: "COST_EXCEEDS_SPEND", accountId, accountName: name, amount, available: Math.max(0, left),
          message: `${name}: ${amount.toFixed(2)} is being moved into stock, but only ${Math.max(0, left).toFixed(2)} has been spent on it this year and not yet moved. Record the expense first, or tick to go ahead.`,
        });
      }
    }
    return warnings;
  }

  static async post(id, { acknowledge = [] } = {}, by) {
    // looked up before the transaction: a company that never had the key gets it added in a commit of its own
    const draft = isId(id) ? await ProductionOrder.findById(id).select("costs").lean() : null;
    const absorbedId = draft?.costs?.length ? await absorbedAccount() : null;
    return this.postIn(id, { acknowledge, absorbedId }, by);
  }

  static postIn = withTransactionSession(async (id, { acknowledge, absorbedId }, by, session) => {
    const p = await this.loadDraft(id, session);
    const date = p.date;
    await FiscalYearService.assertPostingAllowed(date, { session });
    const postingOn = await AccountConfigService.isPostingEnabled({ session });
    if (p.costs.length && !postingOn) {
      throw fail("Ledger posting is off, so costs cannot be moved into stock. Switch ledger posting on, or post the production with materials only.", 409, "LEDGER_POSTING_OFF");
    }

    const at = lastMomentOf(date);
    const involved = [p.finished, ...p.materials];
    const later = await InventoryMovement.findOne({ stockId: { $in: involved.map((m) => m.itemId) }, date: { $gt: at }, ...LIVE })
      .select("stockId referenceNumber date").session(session).lean();
    if (later) {
      throw fail(
        `${later.referenceNumber} moved ${later.stockId} after ${orgDay(date)}. A production cannot be dated before a later stock movement of its items; date it today.`,
        409, "LATER_MOVEMENTS_EXIST", { referenceNumber: later.referenceNumber }
      );
    }

    const ticked = new Set((Array.isArray(acknowledge) ? acknowledge : [acknowledge]).map(String));
    const warnings = (await this.spendWarnings(p, { session })).filter((w) => !ticked.has(w.code));
    if (warnings.length) throw fail(warnings[0].message, 409, "PRODUCTION_WARNINGS", { warnings });

    const createdBy = String(by || "system");
    const productionNo = p.productionNo;

    // materials out, at the average each has now
    let materialsCost = 0;
    for (const m of p.materials) {
      const stock = await Stock.findById(m.stockId).session(session);
      if (!stock) throw fail(`${m.itemName} no longer exists`, 409, "ITEM_NOT_FOUND");
      ItemKindService.assertStocked(stock, "be used in a production");
      const pool = poolOf(stock);
      if (pool.quantity + 1e-9 < m.qty) {
        throw fail(`Only ${pool.quantity} of ${stock.itemName} on hand; this production uses ${m.qty}`, 409, "INSUFFICIENT_STOCK", { itemId: stock.itemId, onHand: pool.quantity, needed: m.qty });
      }
      const r = costing.applyMovement(pool, "sale", { qty: m.qty });
      await Stock.updateOne({ _id: stock._id }, { currentStock: r.pool.quantity, costValue: r.pool.costValue, purchasePrice: r.pool.avgRate }, { session });
      const taken = await BatchService.allocate({ stockId: stock._id, qty: m.qty, orderDate: date }, { session });
      await InventoryMovement.create(
        [{
          stockId: stock.itemId, quantity: -m.qty, previousStock: pool.quantity, newStock: r.pool.quantity,
          eventType: "PRODUCTION_ISSUE", referenceType: "Production", referenceId: p._id, referenceNumber: productionNo,
          unitCost: r.rate, totalValue: r.cost, costBasis: "production",
          rateBefore: pool.avgRate, rateAfter: r.pool.avgRate, costPoolAfter: r.pool.costValue, poolQtyAfter: r.pool.quantity,
          notes: `Used in production ${productionNo}: ${p.finished.itemName}`, createdBy, date,
        }],
        { session }
      );
      m.unitCost = r.rate;
      m.cost = r.cost;
      m.allocations = taken.allocations;
      materialsCost = costing.roundValue(materialsCost + r.cost);
    }

    const totals = rules.totals({ materialCosts: p.materials.map((m) => m.cost), costs: p.costs, qty: p.finished.qty });

    // the finished item in, at materials + costs (blending with any of it already on hand)
    const finished = await Stock.findById(p.finished.stockId).session(session);
    if (!finished) throw fail(`${p.finished.itemName} no longer exists`, 409, "ITEM_NOT_FOUND");
    ItemKindService.assertStocked(finished, "be made in a production");
    const pool = poolOf(finished);
    const r = costing.applyMovement(pool, "purchase", { qty: p.finished.qty, cost: totals.total });
    await Stock.updateOne({ _id: finished._id }, { currentStock: r.pool.quantity, costValue: r.pool.costValue, purchasePrice: r.pool.avgRate }, { session });
    await BatchService.receive(
      { _id: p._id, transactionNo: productionNo, date },
      { itemId: finished._id, itemCode: finished.itemId, batchNumber: p.finished.batchNumber, expiryDate: p.finished.expiryDate },
      p.finished.qty, totals.unitCost, { session }
    );
    await InventoryMovement.create(
      [{
        stockId: finished.itemId, quantity: p.finished.qty, previousStock: pool.quantity, newStock: r.pool.quantity,
        eventType: "PRODUCTION_RECEIPT", referenceType: "Production", referenceId: p._id, referenceNumber: productionNo,
        unitCost: totals.unitCost, totalValue: totals.total, costBasis: "production",
        rateBefore: pool.avgRate, rateAfter: r.pool.avgRate, costPoolAfter: r.pool.costValue, poolQtyAfter: r.pool.quantity,
        notes: `Made in production ${productionNo}`, createdBy, batchNumber: p.finished.batchNumber, expiryDate: p.finished.expiryDate, date,
      }],
      { session }
    );

    // the ledger
    let ledgerPosted = false;
    if (postingOn && totals.total > 0) {
      const inventoryId = await AccountConfigService.resolveAccount("inventory-asset", { session });
      const contra = await contraAccounts(p.costs, absorbedId, session);
      const lines = rules.ledgerLines({
        inventoryAccountId: String(inventoryId), absorbedAccountId: absorbedId && String(absorbedId),
        materialsCost, costs: p.costs.map((c) => ({ ...c.toObject(), contraAccountId: contra.get(String(c.accountId)) })),
        productionNo, itemName: p.finished.itemName, qty: p.finished.qty,
      });
      const accounts = await LedgerAccount.find({ _id: { $in: [...new Set(lines.map((l) => l.accountId))] } }).select("accountName accountCode").session(session).lean();
      const accById = new Map(accounts.map((a) => [String(a._id), a]));
      const d = new Date(date);
      const docs = lines.map((l) => {
        const a = accById.get(String(l.accountId));
        if (!a) throw fail("A posting account of this production is missing from the chart", 409, "ACCOUNT_NOT_CONFIGURED");
        return {
          voucherId: p._id, voucherNo: productionNo, voucherType: "production", date,
          accountId: new mongoose.Types.ObjectId(String(l.accountId)), accountName: a.accountName, accountCode: a.accountCode,
          debitAmount: l.debit, creditAmount: l.credit, narration: l.narration,
          referenceType: "production", referenceId: p._id, referenceNo: productionNo,
          month: d.getMonth() + 1, year: d.getFullYear(), financialYear: String(d.getFullYear()),
          createdBy: asAdminId(by),
        };
      });
      await writeEntries(docs, session);
      ledgerPosted = true;
    }

    p.status = "POSTED";
    p.totals = totals;
    p.ledgerPosted = ledgerPosted;
    p.postedAt = new Date();
    p.postedBy = createdBy;
    if (ticked.size) p.acknowledged = [...ticked];
    p.markModified("materials");
    await p.save({ session });
    return p;
  });

  // Undoes a posted production: the finished item back out at the cost it came in at, the materials back in
  // at theirs, the batches put back and the ledger reversed. Refused once any of the finished goods have gone.
  static reverse = withTransactionSession(async (id, { reason, fromJobWork = false } = {}, by, session) => {
    if (!isId(id)) throw fail("Production not found", 404, "NOT_FOUND");
    const p = await ProductionOrder.findById(id).session(session);
    if (!p) throw fail("Production not found", 404, "NOT_FOUND");
    if (p.status !== "POSTED") throw fail(`${p.productionNo} is ${p.status.toLowerCase()}; only a posted production can be reversed`, 409, "PRODUCTION_NOT_POSTED");
    if (p.source?.kind === "job_work" && !fromJobWork) {
      throw fail(`${p.productionNo} was made by a receipt on job work ${p.source.no}; reverse that receipt on the job work instead`, 409, "PRODUCTION_FROM_JOB_WORK");
    }
    if (p.source?.kind === "process" && !fromJobWork) {
      throw fail(`${p.productionNo} finished process order ${p.source.no}; reopen that order instead`, 409, "PRODUCTION_FROM_PROCESS");
    }
    await FiscalYearService.assertPostingAllowed(p.date, { session });

    const finished = await Stock.findById(p.finished.stockId).session(session).lean();
    if (!finished || Number(finished.currentStock) + 1e-9 < p.finished.qty) {
      throw fail(
        `Only ${finished?.currentStock ?? 0} of ${p.finished.itemName} is on hand; ${p.finished.qty} were made. Goods already sold or used cannot be un-made.`,
        409, "FINISHED_STOCK_USED"
      );
    }
    await BatchService.removeReceipt(p._id, { session }); // BATCH_PARTLY_USED when some of its batch went
    for (const m of p.materials) await BatchService.restore(m.allocations, { session });

    const createdBy = String(by || "system");
    const movements = await InventoryMovement.find({ referenceType: "Production", referenceId: p._id, isReversed: false, referenceNumber: { $not: /^REV-/ } }).session(session);
    // the finished item first, so its pool is taken back before the materials return
    movements.sort((a, b) => b.quantity - a.quantity);
    for (const mv of movements) {
      const stock = await Stock.findOne({ itemId: mv.stockId }).session(session);
      if (!stock) throw fail(`Stock item ${mv.stockId} not found`, 404, "ITEM_NOT_FOUND");
      const qty = -mv.quantity;
      const newStock = costing.roundValue((Number(stock.currentStock) || 0) + qty);
      const costDelta = mv.quantity > 0 ? -(mv.totalValue || 0) : (mv.totalValue || 0);
      const prior = poolOf(stock);
      const newCostValue = costing.roundValue(prior.costValue + costDelta);
      const newAvg = costing.recalcAvg(newStock, newCostValue, prior.avgRate);
      await Stock.updateOne({ _id: stock._id }, { currentStock: newStock, costValue: newCostValue, purchasePrice: newAvg }, { session });
      const [rev] = await InventoryMovement.create(
        [{
          stockId: stock.itemId, quantity: qty, previousStock: stock.currentStock, newStock,
          eventType: mv.eventType, referenceType: "Production", referenceId: p._id, referenceNumber: `REV-${p.productionNo}`,
          unitCost: mv.unitCost, totalValue: mv.totalValue, costBasis: "production",
          rateBefore: prior.avgRate, rateAfter: newAvg, costPoolAfter: newCostValue, poolQtyAfter: newStock,
          notes: `Reversal of ${mv.notes}`, createdBy, batchNumber: mv.batchNumber, expiryDate: mv.expiryDate, date: new Date(),
        }],
        { session }
      );
      await InventoryMovement.updateOne({ _id: mv._id }, { isReversed: true, reversalReference: rev._id }, { session });
    }

    if (p.ledgerPosted) {
      const FinancialService = require("../financial/financialService"); // avoids a require cycle
      await FinancialService.reverseLedgerEntries(p._id, session);
    }
    p.status = "REVERSED";
    p.reversedAt = new Date();
    p.reversedBy = createdBy;
    if (reason) p.reverseReason = String(reason).trim().slice(0, 500);
    await p.save({ session });
    return p;
  });
}

module.exports = ProductionService;
