const mongoose = require("mongoose");
const Stock = require("../../models/modules/stockModel");
const rules = require("../../utils/vanSales");

const isId = (v) => mongoose.isValidObjectId(v);

// What the warehouse can really hand out. Stock is one quantity per item for the whole organisation; some of it is not
// on the shelf: out with a job worker (a coater), sitting in a van that is out, or in a van counted back in whose
// damaged, expired and missing units wait to be settled. Each is derived from its own documents and nothing is stored.
// Every check of "is this much free?" reads it here, so a van load, a job-work send, the suggested load and the
// storekeeper's list cannot disagree.
class ReservationService {
  /** Map(stockId -> qty) for each reason stock is off the shelf. Read in every branch: stock is organisation-wide. */
  static async held({ session } = {}) {
    const JobWorkService = require("./jobWorkService");
    const VanTripService = require("../vansales/vanTripService");
    // one after another: operations sharing a transaction's session must not run at once
    const jobWorker = await JobWorkService.withJobWorker({ session });
    const onVans = await VanTripService.withOnVans({ session });
    const countedIn = await VanTripService.countedIn({ session });
    return { jobWorker, onVans, countedIn };
  }

  /**
   * Per item: { itemName, itemType, onHand, jobWorker, onVans, countedIn, free }. `touch` marks the items as written in
   * the caller's transaction first, so two people taking the same item at once conflict, one retries on a fresh read and
   * sees what the other took (a load and a job-work send used to be able to both pass).
   */
  static async free(stockIds, { session, touch = false } = {}) {
    const ids = [...new Set((stockIds || []).map(String))].filter(isId);
    const out = new Map();
    if (!ids.length) return out;
    if (touch) await Stock.updateMany({ _id: { $in: ids } }, { $currentDate: { updatedAt: true } }, session ? { session } : undefined);
    const q = Stock.find({ _id: { $in: ids } }).select("itemName itemType currentStock").lean();
    const stocks = await (session ? q.session(session) : q);
    const { jobWorker, onVans, countedIn } = await this.held({ session });
    for (const s of stocks) {
      const id = String(s._id);
      const row = { itemName: s.itemName, itemType: s.itemType, onHand: Number(s.currentStock) || 0, jobWorker: jobWorker.get(id) || 0, onVans: onVans.get(id) || 0, countedIn: countedIn.get(id) || 0 };
      out.set(id, { ...row, free: rules.freeDepot({ currentStock: row.onHand, withJobWorker: row.jobWorker, onVans: row.onVans, countedIn: row.countedIn }) });
    }
    return out;
  }

  /** "12 on hand, 3 with job workers, 4 already on vans, 1 counted back in and waiting to be settled": why so little is free. */
  static why(row) {
    const parts = [`${row.onHand} on hand`];
    if (row.jobWorker) parts.push(`${row.jobWorker} with job workers`);
    if (row.onVans) parts.push(`${row.onVans} already on vans`);
    if (row.countedIn) parts.push(`${row.countedIn} counted back in damaged, expired or missing and waiting to be settled`);
    return parts.join(", ");
  }
}

module.exports = ReservationService;
