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

module.exports = { assertTripAllows };
