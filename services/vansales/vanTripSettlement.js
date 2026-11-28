const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Stock = require("../../models/modules/stockModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const Transaction = require("../../models/modules/transactionModel");
const Van = require("../../models/modules/vansales/vanModel");
const { Voucher, LedgerAccount } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const FinancialService = require("../financial/financialService");
const AccountConfigService = require("../financial/accountConfigService");
const DefaultChartService = require("../financial/defaultChartService");
const StockAdjustmentService = require("../stock/stockAdjustmentService");
const { groupFamily } = require("../banking/cardService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg, orgDay } = require("../../utils/documentExpiry");
const { loadTrip, stockOf } = require("./vanTripStock");
const VanSettingsService = require("./vanSettingsService");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const round2 = rules.round2;

// Counting the van back in and settling the day. UNLOADED records what was found in the van; SETTLED is the one act
// that touches the books:
//   - cash: ONE journal. Dr main cash (what was handed in) + Dr Salesman Shortages (what was not) =
//           Cr the van's cash account (what it took) + Cr Cash over and short (what came in extra). Where more was spent
//           on the road than taken, the salesman is paid back from the main cash, on the same journal;
//   - stock: the expired and damaged goods are written off to their own loss accounts, and the units found against the
//            units that should be there put right, each at average cost (movement, ledger entry, period lock and all).
// Cheques are not moved: they sit in Cheques in Hand until deposited; settlement only checks they were handed over.

const WARNING_CODES = ["CASH_SHORT", "CASH_OVER", "STOCK_DIFFERENCE", "CHEQUES_MISSING", "CONTAINER_DIFFERENCE"];

/**
 * The containers a trip should bring back, and what was counted: [{ typeId, name, expected, counted, difference, value }].
 * Only where the organisation has container types. `counted` is Map(typeId -> n).
 */
async function containerRows(trip, stock, counted, { session } = {}) {
  const VanContainerService = require("./vanContainerService");
  const crates = require("../../utils/vanContainers");
  const types = await VanContainerService.types({ includeInactive: true, session });
  if (!types.length) return [];
  const moves = await VanContainerService.ofTrip(trip, { session });
  const expected = crates.expectedOnVan({ loaded: stock.loaded, moves }, types);
  if (!expected.size && !counted.size) return [];
  return crates.countRows(expected, counted, types);
}

/** What the person counted per container type: Map(typeId -> n). A type not sent is taken as found as expected. */
function countedContainers(raw) {
  const counted = new Map();
  for (const [i, c] of (Array.isArray(raw) ? raw : []).entries()) {
    const n = typeof c?.counted === "number" || (typeof c?.counted === "string" && c.counted.trim() !== "") ? Number(c.counted) : NaN;
    if (typeof c?.typeId !== "string" || !Number.isInteger(n) || n < 0) throw fail(`Containers line ${i + 1}: count them, a whole number of zero or more`, 400, "CONTAINERS_INVALID");
    counted.set(c.typeId, n);
  }
  return counted;
}

/** What was found on the van, as the trip keeps it: each item against what should be there, and the containers. */
async function countRecord(trip, stock, input, by, session) {
  const counts = Array.isArray(input?.counts) ? input.counts : [];
  let rows;
  try {
    rows = rules.unloadVariance(stock, counts);
  } catch (err) {
    if (err instanceof rules.VanError) throw fail(err.message, 400, err.code, err.details);
    throw err;
  }
  const names = new Map();
  for (const load of trip.loads) for (const l of load.lines) names.set(String(l.stockId), l.itemName);
  require("./vanFleetService").applyOdometer(trip, "in", input?.odometer);
  // every item the van should hold is counted, even when the answer is none: an item left out is not a count of nothing
  const missing = rules.uncounted(stock, counts);
  if (missing.length) {
    const unnamedMissing = missing.filter((id) => !names.get(id) && isId(id));
    if (unnamedMissing.length) for (const s of await Stock.find({ _id: { $in: unnamedMissing } }).select("itemName").session(session).lean()) names.set(String(s._id), s.itemName);
    const said = missing.slice(0, 5).map((id) => names.get(id) || "an item").join(", ");
    throw fail(`Count every item on the van, even when none is left: ${said}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""} not counted`, 400, "COUNT_INCOMPLETE", { stockIds: missing });
  }
  // goods taken back that this van never carried are named from the item master
  const unnamed = rows.map((r) => r.stockId).filter((id) => !names.get(id) && isId(id));
  if (unnamed.length) for (const s of await Stock.find({ _id: { $in: unnamed } }).select("itemName").session(session).lean()) names.set(String(s._id), s.itemName);
  const containers = await containerRows(trip, stock, countedContainers(input?.containers), { session });
  return {
    at: new Date(), by: String(by), byName: input?.byName || "",
    lines: rows.map((r) => ({ ...r, itemName: names.get(r.stockId) || "" })),
    ...(containers.length ? { containers: containers.map((c) => ({ typeId: c.typeId, name: c.name, expected: c.expected, counted: c.counted, difference: c.difference })) } : {}),
  };
}

/** What a second count changed, in words for the audit log. */
function countChanges(before, after) {
  const changed = [];
  const was = new Map((before.lines || []).map((l) => [String(l.stockId), l]));
  for (const l of after.lines) {
    const old = was.get(String(l.stockId));
    const good = Number(old?.countedGood || 0);
    const damaged = Number(old?.countedDamaged || 0);
    const expired = Number(old?.countedExpired || 0);
    const parts = [];
    if (good !== l.countedGood) parts.push(`sellable ${good} to ${l.countedGood}`);
    if (damaged !== l.countedDamaged) parts.push(`damaged ${damaged} to ${l.countedDamaged}`);
    if (expired !== Number(l.countedExpired || 0)) parts.push(`expired ${expired} to ${l.countedExpired || 0}`);
    if (parts.length) changed.push(`${l.itemName || old?.itemName || "item"}: ${parts.join(", ")}`);
  }
  const crates = new Map((before.containers || []).map((c) => [String(c.typeId), c.counted]));
  for (const c of after.containers || []) {
    const old = crates.get(String(c.typeId));
    if (old !== c.counted) changed.push(`${c.name}: ${old ?? 0} to ${c.counted}`);
  }
  return changed;
}

/** A cash figure somebody typed: a number, or text with something in it. Number(null) and Number([]) are 0, not an answer. */
const isTyped = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "");

/**
 * The batches this trip's returns put goods into, by item and by the condition they came back in: a return against an
 * invoice went back into the batches that invoice took, anything else into a batch of the credit note's own. A write-off
 * takes these first, so an expired batch is the one that leaves the books. Map(stockId -> { damaged: [], expired: [] }).
 */
async function returnedBatches(trip, { session }) {
  const out = new Map();
  const records = (trip.returns || []).filter((r) => (r.lines || []).some((l) => l.condition === "damaged" || l.condition === "expired"));
  if (!records.length) return out;
  const docs = new Map((await Transaction.find({ _id: { $in: records.map((r) => r.transactionId) }, status: "APPROVED" })
    .select("items._id items.itemId items.allocations").session(session).lean()).map((d) => [String(d._id), d]));
  const own = await StockBatch.find({ sourceTransactionId: { $in: [...docs.keys()] } }).select("stockId sourceTransactionId receivedQty").session(session).lean();
  for (const record of records) {
    const doc = docs.get(String(record.transactionId));
    if (!doc) continue;
    for (const line of record.lines) {
      if (line.condition !== "damaged" && line.condition !== "expired") continue;
      const mine = (doc.items || []).filter((l) => (line.docLineId ? String(l._id) === String(line.docLineId) : String(l.itemId) === String(line.stockId)));
      const named = [
        ...mine.flatMap((l) => (l.allocations || []).map((a) => ({ batchId: String(a.batchId), qty: Number(a.qty) || 0 }))),
        ...own.filter((b) => String(b.sourceTransactionId) === String(doc._id) && String(b.stockId) === String(line.stockId))
          .map((b) => ({ batchId: String(b._id), qty: Number(b.receivedQty) || 0 })),
      ];
      // a returned line names at most its own quantity of batches, in the order they were taken
      const prefer = [];
      let left = Number(line.qty) || 0;
      for (const p of named) {
        if (left <= 0) break;
        const take = rules.round3(Math.min(p.qty, left));
        if (take > 0) prefer.push({ batchId: p.batchId, qty: take });
        left = rules.round3(left - take);
      }
      const entry = out.get(String(line.stockId)) || { damaged: [], expired: [] };
      entry[line.condition].push(...prefer);
      out.set(String(line.stockId), entry);
    }
  }
  return out;
}

/**
 * The batches every van not yet settled holds its damaged and expired returns in, for one item: Map(batchId -> qty).
 * Those units are in the books until the van is settled and written off from these very batches, so no other sale may
 * be handed them in the meantime (BatchService.allocate takes them out of what it plans with). Read in every branch.
 */
async function heldReturnBatches(stockId, { session } = {}) {
  const VanTrip = require("../../models/modules/vansales/vanTripModel");
  const { allBranches } = require("../../utils/tenantContext");
  const out = new Map();
  if (!isId(stockId)) return out;
  const q = VanTrip.find({
    status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] },
    returns: { $elemMatch: { lines: { $elemMatch: { stockId, condition: { $in: ["damaged", "expired"] } } } } },
  }).select("returns");
  const trips = await allBranches(() => (session ? q.session(session) : q));
  for (const trip of trips) {
    const per = (await allBranches(() => returnedBatches(trip, { session }))).get(String(stockId));
    for (const p of [...(per?.damaged || []), ...(per?.expired || [])]) out.set(p.batchId, rules.round3((out.get(p.batchId) || 0) + p.qty));
  }
  return out;
}

/** The posting keys settlement uses, topped up for a company whose map predates them. Outside the transaction: the top-up commits on its own. */
async function ensureKeys(req) {
  for (const key of ["salesman-shortages", "cash-over-short", "damage-loss", "write-off-expiry"]) {
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
   * Count the van back in. `counts` is what was found, per item: [{ stockId, good, damaged, expired }]; an item not
   * listed was found nowhere. Moves nothing in the books: losses and differences are written when the trip is settled.
   */
  static unload = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const trip = await loadTrip(id, session);
    if (!rules.canMove(trip.status, "UNLOADED")) throw fail("Only a van that is out can be counted back in", 409, "TRIP_NOT_ON_ROUTE");
    require("./vanTripService").assertNoOpenRequest(trip, "be counted back in");
    const stock = await stockOf(trip, { session });
    trip.unload = await countRecord(trip, stock, input, by, session);
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
   * Count a counted-in van again, before it is settled: a mistake would otherwise go straight into the books, and a
   * settled trip is not reopened. Stock and money do not move at count-in, so the count is simply replaced; the earlier
   * ones are kept on the trip (the last five). The trip keeps its status and its retired numbers.
   */
  static recount = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const trip = await loadTrip(id, session);
    if (trip.status !== "UNLOADED" || !trip.unload) throw fail("Only a van that is counted in and not yet settled can be counted again", 409, "TRIP_NOT_UNLOADED");
    const stock = await stockOf(trip, { session, asOut: true });
    const { previous, ...earlier } = trip.unload.toObject();
    const record = await countRecord(trip, stock, input, by, session);
    trip.unload = { ...record, previous: [...(previous || []), earlier].slice(-5) };
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, changed: countChanges(earlier, record) };
  });

  /**
   * What settling would do, worked out from the trip as it stands and what was handed in. Used for the preview AND by
   * `settle`, so the screen can never promise something the posting does differently.
   */
  static async plan(trip, input = {}, { session, req } = {}) {
    if (trip.status !== "UNLOADED" || !trip.unload) throw fail("Count the van back in before settling it", 409, "TRIP_NOT_UNLOADED");
    const vouchers = await Voucher.find({ "vanTripRef.tripId": trip._id, voucherType: "receipt" })
      .select("voucherNo status paymentMode totalAmount paymentDetails.chequeDetails paymentDetails.reference paymentDetails.approvalCode paymentDetails.cardLabel partyName").session(session || null).lean();
    const live = vouchers.filter((v) => v.status === "approved");
    // a bank transfer taken on the road waits for the office to see it in the bank (financialService, holdFor "van_transfer"):
    // it is the bank's to confirm, never the van's, so it does not stop the trip being settled. Any other receipt still waiting does.
    const waitingTransfers = vouchers.filter((v) => v.status === "pending" && v.paymentMode === "transfer");
    const pending = vouchers.filter((v) => v.status === "pending" && v.paymentMode !== "transfer");
    // the van's cash: what it took, less what it paid out on the road (fuel, tolls) from the same account
    const spent = await Voucher.find({ "vanTripRef.tripId": trip._id, voucherType: "expense" }).select("voucherNo status totalAmount").session(session || null).lean();
    const expenses = round2(spent.filter((v) => v.status === "approved").reduce((t, v) => t + Number(v.totalAmount || 0), 0));
    const pendingExpenses = spent.filter((v) => v.status === "pending");
    const expected = round2(live.filter((v) => v.paymentMode === "cash").reduce((t, v) => t + Number(v.totalAmount || 0), 0) - expenses);
    // the cheques, with what a bank deposit slip needs (drawn on, from whom, dated): the register keeps those
    const { Cheque } = require("../../models/modules/banking/bankingModels");
    const chequeVouchers = live.filter((v) => v.paymentMode === "cheque");
    const register = new Map((await Cheque.find({ voucherId: { $in: chequeVouchers.map((v) => v._id) } }).select("voucherId chequeNo drawnOnBankName partyName chequeDate").session(session || null).lean()).map((c) => [String(c.voucherId), c]));
    const cheques = chequeVouchers.map((v) => {
      const c = register.get(String(v._id));
      return { chequeNo: c?.chequeNo || v.paymentDetails?.chequeDetails?.chequeNumber || v.voucherNo, amount: round2(v.totalAmount), bank: c?.drawnOnBankName || "", from: c?.partyName || "", date: c?.chequeDate || null, voucherNo: v.voucherNo };
    });

    // card and transfer takings never reached the van's cash, so they are not in the cash expected or the journal: they are
    // listed so the supervisor sees everything the trip took, and which transfers are still waiting for the bank
    const sumOf = (rows) => round2(rows.reduce((t, v) => t + Number(v.totalAmount || 0), 0));
    const cards = live.filter((v) => v.paymentMode === "card").map((v) => ({ voucherNo: v.voucherNo, amount: round2(v.totalAmount), from: v.partyName || "", approvalCode: v.paymentDetails?.approvalCode || "", card: v.paymentDetails?.cardLabel || "" }));
    const transfers = [...live.filter((v) => v.paymentMode === "transfer").map((v) => ({ v, waiting: false })), ...waitingTransfers.map((v) => ({ v, waiting: true }))]
      .map(({ v, waiting }) => ({ voucherNo: v.voucherNo, amount: round2(v.totalAmount), from: v.partyName || "", reference: v.paymentDetails?.reference || "", waiting }));
    const cardTotal = sumOf(live.filter((v) => v.paymentMode === "card"));
    const transferTotal = sumOf(live.filter((v) => v.paymentMode === "transfer"));
    const transfersWaiting = sumOf(waitingTransfers);

    // only the preview may leave the cash out: it then shows the day as it looks if all of it is handed in (or, where
    // more was spent than taken, if all of it is paid back)
    const handed = input.cashHanded === undefined || input.cashHanded === "" ? expected : isTyped(input.cashHanded) ? Number(input.cashHanded) : NaN;
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
    let expiredValue = 0;
    const rows = trip.unload.lines.map((l) => {
      const cost = Number(byId.get(String(l.stockId))?.purchasePrice) || 0;
      const row = {
        stockId: String(l.stockId), itemName: l.itemName || byId.get(String(l.stockId))?.itemName || "",
        expectedGood: l.expectedGood, countedGood: l.countedGood, expectedDamaged: l.expectedDamaged, countedDamaged: l.countedDamaged,
        ...(l.expectedExpired || l.countedExpired ? { expectedExpired: l.expectedExpired || 0, countedExpired: l.countedExpired || 0 } : {}),
        difference: l.difference, unitCost: cost,
        varianceValue: round2(l.difference * cost), damagedValue: round2(l.countedDamaged * cost), expiredValue: round2((l.countedExpired || 0) * cost),
      };
      varianceValue += row.varianceValue;
      damagedValue += row.damagedValue;
      expiredValue += row.expiredValue;
      return row;
    });

    // containers as counted in: missing ones of a deposit type are worth their deposit, charged to the salesman
    const VanContainerService = require("./vanContainerService");
    const depositOf = new Map((await VanContainerService.types({ includeInactive: true, session })).map((t) => [t.id, t.deposit]));
    const containers = (trip.unload.containers || []).map((c) => ({
      typeId: String(c.typeId), name: c.name, expected: c.expected, counted: c.counted, difference: c.difference,
      value: round2(Math.max(0, -Number(c.difference || 0)) * (depositOf.get(String(c.typeId)) || 0)),
    }));
    const containersMissing = containers.reduce((n, c) => n + Math.max(0, -Number(c.difference || 0)), 0);
    const containersMissingValue = round2(containers.reduce((t, c) => t + c.value, 0));

    const blockers = [];
    if (pendingExpenses.length) blockers.push({ code: "PENDING_EXPENSES", message: `${pendingExpenses.length} road expense${pendingExpenses.length === 1 ? " is" : "s are"} waiting for approval. Approve or reject ${pendingExpenses.length === 1 ? "it" : "them"} first.` });
    if (pending.length) blockers.push({ code: "PENDING_RECEIPTS", message: `${pending.length} receipt${pending.length === 1 ? " is" : "s are"} waiting for approval. Approve or reject ${pending.length === 1 ? "it" : "them"} first.` });
    const warnings = [];
    // a difference at or below the organisation's tolerance still posts to the shortage / over account; it just needs no tick
    const tolerance = (await VanSettingsService.forTrip(trip, { session })).cashTolerance;
    // more spent than taken: the figures are about what is paid back to the salesman, and say so
    const payingBack = cash.expected < 0 && cash.handed <= 0;
    if (cash.short > tolerance + 1e-9) warnings.push({ code: "CASH_SHORT", message: payingBack
      ? `${cash.short.toFixed(2)} more is paid to the salesman than is owed. It is charged to the salesman's shortage account.`
      : `${cash.short.toFixed(2)} less cash was handed in than the van took. It is charged to the salesman's shortage account.` });
    if (cash.over > tolerance + 1e-9) warnings.push({ code: "CASH_OVER", message: payingBack
      ? `${cash.over.toFixed(2)} less is paid to the salesman than is owed. It is booked to cash over and short, so nothing is owed afterwards.`
      : `${cash.over.toFixed(2)} more cash was handed in than the van took. It is booked to cash over and short.` });
    const off = rows.filter((r) => Math.abs(r.difference) > 0.0005);
    // goods missing at the count: a stock loss, or - the organisation's choice - the salesman's to make good, at cost
    const active = await VanSettingsService.forTrip(trip, { session });
    const missingCharged = active.chargeMissingStock ? round2(rows.filter((r) => r.difference < 0).reduce((t, r) => t - r.varianceValue, 0)) : 0;
    if (off.length) warnings.push({ code: "STOCK_DIFFERENCE", message: `${off.length} item${off.length === 1 ? "" : "s"} counted differently from what the van should hold (${round2(varianceValue).toFixed(2)} at cost). ${missingCharged > 0 ? `The missing goods, ${missingCharged.toFixed(2)} at cost, are charged to the salesman's shortage account; anything over is booked as a stock adjustment.` : "It is booked as a stock adjustment."}` });
    const containersOff = containers.filter((c) => c.difference !== 0);
    if (containersOff.length) {
      const said = containersOff.map((c) => (c.difference < 0 ? `${-c.difference} ${c.name} missing` : `${c.difference} ${c.name} more`)).join(", ");
      warnings.push({ code: "CONTAINER_DIFFERENCE", message: `${said} on the van.${containersMissingValue > 0 ? ` The deposit of the missing ones, ${containersMissingValue.toFixed(2)}, is charged to the salesman's shortage account.` : ""}` });
    }
    if (missing.length) warnings.push({ code: "CHEQUES_MISSING", message: `${missing.length} cheque${missing.length === 1 ? "" : "s"} taken on the road ${missing.length === 1 ? "was" : "were"} not handed in: ${missing.map((c) => c.chequeNo).join(", ")}.` });

    return {
      trip: { id: String(trip._id), tripNo: trip.tripNo, vanCode: trip.vanCode },
      cash, expenses, cheques, missingCheques: missing, cards, transfers, cardTotal, transferTotal, transfersWaiting, rows,
      stockVarianceValue: round2(varianceValue), damagedValue: round2(damagedValue), expiredValue: round2(expiredValue), missingCharged,
      containers, containersMissing, containersMissingValue,
      blockers, warnings,
    };
  }

  static async preview(id, input = {}, { req } = {}) {
    return this.plan(await loadTrip(id), input, { req });
  }

  /** Settle the trip: the cash journal, the write-offs and stock differences, the trip closed. Needs every warning acknowledged by code. */
  static async settle(id, input = {}, by, { req } = {}) {
    await ensureKeys(req); // before the transaction: the top-up commits on its own
    return this.#settleIn(id, input, by, { req });
  }

  static #settleIn = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(id, session);
    const plan = await this.plan(trip, input, { session, req: opts.req });
    // the cash is counted and typed: a day is never settled on the figure the system expected
    if (!isTyped(input.cashHanded)) throw fail("Enter the cash handed in", 400, "CASH_REQUIRED");
    if (plan.blockers.length) throw fail(plan.blockers[0].message, 409, "VAN_SETTLE_BLOCKED", { blockers: plan.blockers });
    const given = new Set((input.acknowledge || []).map(String));
    const open = plan.warnings.filter((w) => !given.has(w.code));
    if (open.length) throw fail("There are differences to acknowledge before this trip can be settled", 409, "VAN_SETTLE_WARNINGS", { warnings: open });

    const day = todayInOrg();
    const date = new Date(`${day}T00:00:00.000Z`);
    // What the count found happened the day the van was counted back in, not the day somebody settled it: the stock
    // moves carry the count day (and the period lock judges that day). The cash journal is the hand-in, so it keeps today.
    const countDate = trip.unload?.at ? new Date(`${orgDay(trip.unload.at)}T00:00:00.000Z`) : date;
    const voucherIds = [];

    // ---- cash: one journal -----------------------------------------------------------------------------------
    const { cash } = plan;
    const lostValue = plan.containersMissingValue || 0;
    if (cash.expected !== 0 || cash.handed !== 0 || lostValue > 0) {
      const main = await mainCash(opts.req, input.toAccountId, session);
      const shortAccount = await AccountConfigService.resolveAccount("salesman-shortages", { session });
      const overAccount = await AccountConfigService.resolveAccount("cash-over-short", { session });
      const note = `Van ${trip.vanCode} ${trip.tripNo} settlement`;
      const lines = [];
      if (cash.handed > 0) lines.push({ accountId: main._id, debit: cash.handed, narration: `${note}: cash handed in` });
      if (cash.handed < 0) lines.push({ accountId: main._id, credit: -cash.handed, narration: `${note}: paid back to ${trip.salesmanName}` });
      if (cash.short > 0) lines.push({ accountId: shortAccount, debit: cash.short, narration: `${note}: cash short, owed by ${trip.salesmanName}` });
      if (cash.expected > 0) lines.push({ accountId: trip.cashAccountId, credit: cash.expected, narration: `${note}: cash taken on the road` });
      if (cash.expected < 0) lines.push({ accountId: trip.cashAccountId, debit: -cash.expected, narration: `${note}: road spending beyond the cash taken` });
      if (cash.over > 0) lines.push({ accountId: overAccount, credit: cash.over, narration: `${note}: cash over` });
      // containers that did not come back: their deposit is the salesman's to make good (they have no book value of their own)
      if (lostValue > 0) {
        lines.push({ accountId: shortAccount, debit: lostValue, narration: `${note}: ${plan.containersMissing} containers missing, owed by ${trip.salesmanName}` });
        lines.push({ accountId: overAccount, credit: lostValue, narration: `${note}: containers missing, recovered from the salesman` });
      }
      const voucher = await FinancialService.createVoucher({ voucherType: "journal", date, lines, narration: note, ledgerBased: true }, by, session, { req: opts.req });
      await Voucher.updateOne({ _id: voucher._id }, { $set: { vanTripRef: { tripId: trip._id, tripNo: trip.tripNo } } }, { session });
      voucherIds.push(voucher._id);
    }

    // ---- stock: the expired and damaged goods are written off, then the units short or over are put right --------
    const back = await returnedBatches(trip, { session });
    const writeOff = (lossKey, prefer, includeExpired) => ({ lossKey, voucherType: "stock_writeoff", series: "WO", prefer, includeExpired });
    // goods short at the count go to the salesman's shortage account where the organisation chose so (never goods over)
    const charge = plan.missingCharged > 0;
    const stockDocs = [];
    for (const row of plan.rows) {
      const m = rules.stockMoves(row);
      const from = back.get(row.stockId) || {};
      for (const [qty, eventType, notes, how, kind] of [
        [m.expiry, "DAMAGED_STOCK", `Expired goods brought back on van trip ${trip.tripNo}`, writeOff("write-off-expiry", from.expired, true), "expired"],
        [m.damage, "DAMAGED_STOCK", `Damaged goods brought back on van trip ${trip.tripNo}`, writeOff("damage-loss", from.damaged, false), "damaged"],
        [m.variance, "STOCK_ADJUSTMENT", `Count difference on van trip ${trip.tripNo} (${trip.salesmanName})`, charge && m.variance < 0 ? { lossKey: "salesman-shortages" } : {}, "difference"],
      ]) {
        if (!qty) continue;
        const stock = await Stock.findById(row.stockId).session(session); // re-read: the move before changed it
        const target = rules.round3(Number(stock.currentStock) + qty);
        if (target < -1e-9) throw fail(`${stock.itemName} would go below zero; check the count`, 409, "STOCK_WOULD_GO_NEGATIVE", { stockId: row.stockId });
        const done = await StockAdjustmentService.apply({ stock, newQuantity: target, eventType, referenceNumber: trip.tripNo, notes, createdBy: by, date: countDate, ...how }, { session });
        if (done) stockDocs.push({ number: done.number, kind, stockId: row.stockId, itemName: row.itemName, qty, value: round2(qty < 0 ? -done.cost : done.cost) });
      }
    }
    // each counted line keeps what a unit cost on the day, for the loss reports
    const costOf = new Map(plan.rows.map((r) => [r.stockId, r.unitCost]));
    for (const line of trip.unload.lines) line.unitCost = costOf.get(String(line.stockId));

    trip.settlement = {
      at: new Date(), by: String(by), byName: input.byName || "",
      cashExpected: cash.expected, cashHanded: cash.handed, cashVariance: cash.variance, expenses: plan.expenses,
      cheques: plan.cheques.map((c) => ({ ...c, handed: !plan.missingCheques.some((m) => m.chequeNo === c.chequeNo) })),
      cardTotal: plan.cardTotal, transferTotal: plan.transferTotal, transfersWaiting: plan.transfersWaiting,
      stockVarianceValue: plan.stockVarianceValue, damagedValue: plan.damagedValue, expiredValue: plan.expiredValue,
      ...(plan.containers.length ? { containersMissing: plan.containersMissing, containersMissingValue: plan.containersMissingValue } : {}),
      ...(plan.missingCharged > 0 ? { missingCharged: plan.missingCharged } : {}),
      acknowledged: [...given].filter((c) => WARNING_CODES.includes(c)), voucherIds, stockDocs,
      notes: String(input.notes || "").slice(0, 500),
    };
    trip.status = "SETTLED";
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, plan };
  });
}

module.exports = VanTripSettlement;
module.exports.heldReturnBatches = heldReturnBatches;
