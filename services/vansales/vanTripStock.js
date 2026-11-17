const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/vanSales");

/** A trip by id, inside the caller's session if there is one. 404 when it is not this branch's or does not exist. */
async function loadTrip(id, session) {
  if (!mongoose.isValidObjectId(id)) throw new AppError("That van trip does not exist", 404, "TRIP_NOT_FOUND");
  const q = VanTrip.findById(id);
  const trip = await (session ? q.session(session) : q);
  if (!trip) throw new AppError("That van trip does not exist", 404, "TRIP_NOT_FOUND");
  return trip;
}

// What is on a trip's van, worked out from the documents (utils/vanSales.js has the arithmetic). Nothing is stored:
// the invoices and returns APPROVED on the trip are the single source, so deleting or cancelling one gives the goods
// back to the van with nothing to keep in step. Kept apart from vanTripService so the approval guard can read it
// without importing the service (which imports the transaction service which calls the guard).

/** The approved invoices and returns raised on a trip. */
async function documentsOf(trip, { session } = {}) {
  const base = { "vanTripRef.tripId": trip._id, status: "APPROVED" };
  const q = (type) => {
    const find = Transaction.find({ ...base, type }).select("transactionNo partyId items.itemId items.qty items.itemType totalAmount date").lean();
    return session ? find.session(session) : find;
  };
  const [invoices, returns] = await Promise.all([q("sales_order"), q("sales_return")]);
  return { invoices, returns };
}

/** The trip's stock figures: { loaded, sold, returned, sellable, physical, damaged, invoices, returns }. */
async function stockOf(trip, { session } = {}) {
  const { invoices, returns } = await documentsOf(trip, { session });
  const approved = new Set(returns.map((r) => String(r._id)));
  // whether a returned line came back sellable or damaged is the trip's own record of it
  const records = (trip.returns || []).filter((r) => approved.has(String(r.transactionId)));
  const returned = rules.returnedOf(
    records.map((r) => ({ items: (r.lines || []).map((l) => ({ itemId: l.stockId, qty: l.qty, returnCondition: l.condition })) }))
  );
  const loaded = rules.loadedOf(trip);
  const sold = rules.soldOf(invoices);
  const shelf = rules.onVan({ status: trip.status, loaded, sold, returned });
  return { loaded, sold, returned, ...shelf, invoices, returns };
}

module.exports = { loadTrip, documentsOf, stockOf };
