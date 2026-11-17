const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Stock = require("../../models/modules/stockModel");
const Van = require("../../models/modules/vansales/vanModel");
const { Voucher, LedgerAccount } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const FinancialService = require("../financial/financialService");
const AccountConfigService = require("../financial/accountConfigService");
const DefaultChartService = require("../financial/defaultChartService");
const StockAdjustmentService = require("../stock/stockAdjustmentService");
const { groupFamily } = require("../banking/cardService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg } = require("../../utils/documentExpiry");
const { loadTrip, stockOf } = require("./vanTripStock");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const round2 = rules.round2;

// Counting the van back in and settling the day. UNLOADED records what was found in the van; SETTLED is the one act
// that touches the books:
//   - cash: ONE journal. Dr main cash (what was handed in) + Dr Salesman Shortages (what was not) =
//           Cr the van's cash account (what it took) + Cr Cash over and short (what came in extra);
//   - stock: the units found against the units that should be there, and the damaged goods, each as a normal stock
//            adjustment at average cost (movement, ledger entry, period lock and all).
// Cheques are not moved: they sit in Cheques in Hand until deposited; settlement only checks they were handed over.

const WARNING_CODES = ["CASH_SHORT", "CASH_OVER", "STOCK_DIFFERENCE", "CHEQUES_MISSING"];

/** The two posting keys settlement uses, topped up for a company whose map predates them. Outside the transaction: the top-up commits on its own. */
async function ensureKeys(req) {
  for (const key of ["salesman-shortages", "cash-over-short"]) {
    try {
      await AccountConfigService.resolveAccount(key);
    } catch (err) {
      if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
      await DefaultChartService.provision(req);
      await AccountConfigService.resolveAccount(key);
    }
  }
}

/** The main cash account the day's money is handed into: the one chosen, else the first that is not a van's own. */
async function mainCash(req, chosenId, session) {
  const { ids } = await groupFamily("cash-account-group", req);
  const vans = await Van.find({}).select("cashAccountId").session(session).lean();
  const vanAccounts = new Set(vans.map((v) => String(v.cashAccountId)));
  const rows = await LedgerAccount.find({ groupId: { $in: ids }, isActive: true, allowDirectPosting: { $ne: false } }).sort({ accountCode: 1 }).session(session);
  const usable = rows.filter((a) => !vanAccounts.has(String(a._id)));
  if (chosenId) {
    const found = usable.find((a) => String(a._id) === String(chosenId));
    if (!found) throw fail("Choose a cash account that is not a van's own", 400, "NOT_A_CASH_ACCOUNT");
    return found;
  }
  if (!usable.length) throw fail("There is no main cash account to hand the cash into. Add one in the chart of accounts.", 422, "NO_ACCOUNT");
  return usable[0];
}

class VanTripSettlement {
  /**
   * Count the van back in. `counts` is what was found, per item: [{ stockId, good, damaged }]; an item not listed was
   * found nowhere. Moves nothing in the books: the shortage or surplus is written when the trip is settled.
   */
  static unload = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const trip = await loadTrip(id, session);
    if (!rules.canMove(trip.status, "UNLOADED")) throw fail("Only a van that is out can be counted back in", 409, "TRIP_NOT_ON_ROUTE");
    const stock = await stockOf(trip, { session });
    let rows;
    try {
      rows = rules.unloadVariance(stock, Array.isArray(input?.counts) ? input.counts : []);
    } catch (err) {
      if (err instanceof rules.VanError) throw fail(err.message, 400, err.code, err.details);
      throw err;
    }
    const names = new Map();
    for (const load of trip.loads) for (const l of load.lines) names.set(String(l.stockId), l.itemName);
    require("./vanFleetService").applyOdometer(trip, "in", input?.odometer);
    trip.unload = {
      at: new Date(), by: String(by), byName: input?.byName || "",
      lines: rows.map((r) => ({ ...r, itemName: names.get(r.stockId) || "" })),
    };
    trip.status = "UNLOADED";
    trip.updatedBy = String(by);
    if (trip.numberBlock?.length && !trip.numbersRetiredAt) {
      const Transaction = require("../../models/modules/transactionModel");
      const NumberSeriesService = require("../core/numberSeriesService");
      const used = new Set((await Transaction.find({ transactionNo: { $in: trip.numberBlock } }).select("transactionNo").session(session).lean()).map((t) => t.transactionNo));
      for (const number of trip.numberBlock.filter((n) => !used.has(n))) {
        await NumberSeriesService.release({ number, series: "SO", retire: true, reason: `Reserved for van trip ${trip.tripNo}, not used`, session, by });
      }
      trip.numbersRetiredAt = new Date();
    }
    await trip.save({ session });
    return trip;
  });

  /**
   * What settling would do, worked out from the trip as it stands and what was handed in. Used for the preview AND by
   * `settle`, so the screen can never promise something the posting does differently.
   */
  static async plan(trip, input = {}, { session, req } = {}) {
    if (trip.status !== "UNLOADED" || !trip.unload) throw fail("Count the van back in before settling it", 409, "TRIP_NOT_UNLOADED");
    const vouchers = await Voucher.find({ "vanTripRef.tripId": trip._id, voucherType: "receipt" })
      .select("voucherNo status paymentMode totalAmount paymentDetails.chequeDetails").session(session || null).lean();
    const live = vouchers.filter((v) => v.status === "approved");
    const pending = vouchers.filter((v) => v.status === "pending");
    // the van's cash: what it took, less what it paid out on the road (fuel, tolls) from the same account
    const spent = await Voucher.find({ "vanTripRef.tripId": trip._id, voucherType: "expense" }).select("voucherNo status totalAmount").session(session || null).lean();
    const expenses = round2(spent.filter((v) => v.status === "approved").reduce((t, v) => t + Number(v.totalAmount || 0), 0));
    const pendingExpenses = spent.filter((v) => v.status === "pending");
    const expected = round2(live.filter((v) => v.paymentMode === "cash").reduce((t, v) => t + Number(v.totalAmount || 0), 0) - expenses);
    const cheques = live
      .filter((v) => v.paymentMode === "cheque")
      .map((v) => ({ chequeNo: v.paymentDetails?.chequeDetails?.chequeNumber || v.voucherNo, amount: round2(v.totalAmount) }));

    const handed = input.cashHanded === undefined || input.cashHanded === "" ? expected : Number(input.cashHanded);
    if (!Number.isFinite(handed)) throw fail("Enter the cash handed in", 400, "CASH_REQUIRED");
    let cash;
    try {
      cash = rules.cashSettlement({ expected, handed });
    } catch (err) {
      if (err instanceof rules.VanError) throw fail(err.message, 400, err.code);
      throw err;
    }
    const handedNos = Array.isArray(input.chequesHanded) ? input.chequesHanded : cheques.map((c) => c.chequeNo);
    const missing = rules.missingCheques(cheques, handedNos);

    const ids = trip.unload.lines.map((l) => String(l.stockId));
    const stocks = await Stock.find({ _id: { $in: ids } }).select("itemName purchasePrice currentStock").session(session || null).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    let varianceValue = 0;
    let damagedValue = 0;
    const rows = trip.unload.lines.map((l) => {
      const cost = Number(byId.get(String(l.stockId))?.purchasePrice) || 0;
      const row = {
        stockId: String(l.stockId), itemName: l.itemName || byId.get(String(l.stockId))?.itemName || "",
        expectedGood: l.expectedGood, countedGood: l.countedGood, expectedDamaged: l.expectedDamaged, countedDamaged: l.countedDamaged,
        difference: l.difference, unitCost: cost,
        varianceValue: round2(l.difference * cost), damagedValue: round2(l.countedDamaged * cost),
      };
      varianceValue += row.varianceValue;
      damagedValue += row.damagedValue;
      return row;
    });

    const blockers = [];
    if (pendingExpenses.length) blockers.push({ code: "PENDING_EXPENSES", message: `${pendingExpenses.length} road expense${pendingExpenses.length === 1 ? " is" : "s are"} waiting for approval. Approve or reject ${pendingExpenses.length === 1 ? "it" : "them"} first.` });
    if (pending.length) blockers.push({ code: "PENDING_RECEIPTS", message: `${pending.length} receipt${pending.length === 1 ? " is" : "s are"} waiting for approval. Approve or reject ${pending.length === 1 ? "it" : "them"} first.` });
    const warnings = [];
    if (cash.short > 0) warnings.push({ code: "CASH_SHORT", message: `${cash.short.toFixed(2)} less cash was handed in than the van took. It is charged to the salesman's shortage account.` });
    if (cash.over > 0) warnings.push({ code: "CASH_OVER", message: `${cash.over.toFixed(2)} more cash was handed in than the van took. It is booked to cash over and short.` });
    const off = rows.filter((r) => Math.abs(r.difference) > 0.0005);
    if (off.length) warnings.push({ code: "STOCK_DIFFERENCE", message: `${off.length} item${off.length === 1 ? "" : "s"} counted differently from what the van should hold (${round2(varianceValue).toFixed(2)} at cost). It is booked as a stock adjustment.` });
    if (missing.length) warnings.push({ code: "CHEQUES_MISSING", message: `${missing.length} cheque${missing.length === 1 ? "" : "s"} taken on the road ${missing.length === 1 ? "was" : "were"} not handed in: ${missing.map((c) => c.chequeNo).join(", ")}.` });

    return {
      trip: { id: String(trip._id), tripNo: trip.tripNo, vanCode: trip.vanCode },
      cash, expenses, cheques, missingCheques: missing, rows,
      stockVarianceValue: round2(varianceValue), damagedValue: round2(damagedValue),
      blockers, warnings,
    };
  }

  static async preview(id, input = {}, { req } = {}) {
    return this.plan(await loadTrip(id), input, { req });
  }

  /** Settle the trip: the cash journal, the stock adjustments, the trip closed. Needs every warning acknowledged by code. */
  static async settle(id, input = {}, by, { req } = {}) {
    await ensureKeys(req); // before the transaction: the top-up commits on its own
    return this.#settleIn(id, input, by, { req });
  }

  static #settleIn = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(id, session);
    const plan = await this.plan(trip, input, { session, req: opts.req });
    if (plan.blockers.length) throw fail(plan.blockers[0].message, 409, "VAN_SETTLE_BLOCKED", { blockers: plan.blockers });
    const given = new Set((input.acknowledge || []).map(String));
    const open = plan.warnings.filter((w) => !given.has(w.code));
    if (open.length) throw fail("There are differences to acknowledge before this trip can be settled", 409, "VAN_SETTLE_WARNINGS", { warnings: open });

    const day = todayInOrg();
    const date = new Date(`${day}T00:00:00.000Z`);
    const voucherIds = [];

    // ---- cash: one journal -----------------------------------------------------------------------------------
    const { cash } = plan;
    if (cash.expected > 0 || cash.handed > 0) {
      const main = await mainCash(opts.req, input.toAccountId, session);
      const shortAccount = await AccountConfigService.resolveAccount("salesman-shortages", { session });
      const overAccount = await AccountConfigService.resolveAccount("cash-over-short", { session });
      const note = `Van ${trip.vanCode} ${trip.tripNo} settlement`;
      const lines = [];
      if (cash.handed > 0) lines.push({ accountId: main._id, debit: cash.handed, narration: `${note}: cash handed in` });
      if (cash.short > 0) lines.push({ accountId: shortAccount, debit: cash.short, narration: `${note}: cash short, owed by ${trip.salesmanName}` });
      if (cash.expected > 0) lines.push({ accountId: trip.cashAccountId, credit: cash.expected, narration: `${note}: cash taken on the road` });
      if (cash.over > 0) lines.push({ accountId: overAccount, credit: cash.over, narration: `${note}: cash over` });
      const voucher = await FinancialService.createVoucher({ voucherType: "journal", date, lines, narration: note, ledgerBased: true }, by, session, { req: opts.req });
      await Voucher.updateOne({ _id: voucher._id }, { $set: { vanTripRef: { tripId: trip._id, tripNo: trip.tripNo } } }, { session });
      voucherIds.push(voucher._id);
    }

    // ---- stock: the damaged goods leave, then the units short or over are put right ------------------------------
    for (const row of plan.rows) {
      const m = rules.stockMoves(row);
      for (const [qty, eventType, notes] of [
        [m.damage, "DAMAGED_STOCK", `Damaged goods brought back on van trip ${trip.tripNo}`],
        [m.variance, "STOCK_ADJUSTMENT", `Count difference on van trip ${trip.tripNo} (${trip.salesmanName})`],
      ]) {
        if (!qty) continue;
        const stock = await Stock.findById(row.stockId).session(session); // re-read: the first move changed it
        const target = rules.round3(Number(stock.currentStock) + qty);
        if (target < -1e-9) throw fail(`${stock.itemName} would go below zero; check the count`, 409, "STOCK_WOULD_GO_NEGATIVE", { stockId: row.stockId });
        await StockAdjustmentService.apply({ stock, newQuantity: target, eventType, referenceNumber: trip.tripNo, notes, createdBy: by, date }, { session });
      }
    }

    trip.settlement = {
      at: new Date(), by: String(by), byName: input.byName || "",
      cashExpected: cash.expected, cashHanded: cash.handed, cashVariance: cash.variance, expenses: plan.expenses,
      cheques: plan.cheques.map((c) => ({ ...c, handed: !plan.missingCheques.some((m) => m.chequeNo === c.chequeNo) })),
      stockVarianceValue: plan.stockVarianceValue, damagedValue: plan.damagedValue,
      acknowledged: [...given].filter((c) => WARNING_CODES.includes(c)), voucherIds,
      notes: String(input.notes || "").slice(0, 500),
    };
    trip.status = "SETTLED";
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, plan };
  });
}

module.exports = VanTripSettlement;
