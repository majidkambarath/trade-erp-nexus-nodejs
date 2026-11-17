const AppError = require("../../utils/AppError");
const rules = require("../../utils/vanSales");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const { stockOf } = require("./vanTripStock");

// Called from TransactionService.processTransaction, on the approve path, just before stock moves. A document carrying
// `vanTripRef` was raised on a trip; approving it is only allowed while that trip is out, and an invoice only while
// the goods it sells are still on the van. It lives here, on the approval itself, so that no other screen or route
// can sell from a closed or empty van: the trip service's own checks are the friendly message, this is the lock.
async function assertTripAllows(transaction, { session } = {}) {
  const ref = transaction?.vanTripRef;
  if (!ref?.tripId) return;
  const trip = await (session ? VanTrip.findById(ref.tripId).session(session) : VanTrip.findById(ref.tripId));
  if (!trip) throw new AppError("The van trip this document was raised on no longer exists", 409, "VAN_TRIP_NOT_FOUND");
  if (!rules.SELLING.has(trip.status)) {
    throw new AppError(`Van trip ${trip.tripNo || ""} is ${String(trip.status).toLowerCase().replace("_", " ")}, so nothing more can be approved on it`.replace("  ", " "), 409, "VAN_TRIP_CLOSED", { tripNo: trip.tripNo, status: trip.status });
  }
  if (transaction.type !== "sales_order") return;
  const stock = await stockOf(trip, { session });
  const goods = (transaction.items || []).filter((l) => l.itemType !== "service");
  const short = rules.shortages(goods.map((l) => ({ itemId: l.itemId, qty: l.qty })), stock.sellable);
  if (short.length) {
    throw new AppError("There is not enough of that on the van to sell", 409, "VAN_STOCK_SHORT", { short });
  }
}

/**
 * Taking back something done on a van trip (deleting or cancelling an approved invoice or return, deleting a receipt)
 * is refused once the van has been counted back in. The count and the settlement were made against those documents:
 * an invoice taken back now would return goods to the books that no van holds, and a receipt taken back would empty a
 * van cash account that has already been handed in. While the van is still out it is allowed, and the goods simply
 * count as on the van again. The correction after counting in is a new document (a sales return, a new receipt).
 */
async function assertNotCountedIn(doc, { session } = {}) {
  const ref = doc?.vanTripRef;
  if (!ref?.tripId) return;
  const q = VanTrip.findById(ref.tripId).select("tripNo status");
  const trip = await (session ? q.session(session) : q);
  if (trip && ["UNLOADED", "SETTLED"].includes(trip.status)) {
    throw new AppError(
      `This was done on van trip ${trip.tripNo}, which has been counted back in. Correct it with a new document (a return or a receipt) instead.`,
      409, "VAN_TRIP_SETTLED", { tripNo: trip.tripNo, status: trip.status }
    );
  }
}

module.exports = { assertTripAllows, assertNotCountedIn };
