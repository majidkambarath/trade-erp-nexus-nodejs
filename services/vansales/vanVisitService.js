const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const VanVisit = require("../../models/modules/vansales/vanVisitModel");
const Customer = require("../../models/modules/customerModel");
const rules = require("../../utils/vanSales");
const { loadTrip } = require("./vanTripStock");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);

const REASONS = ["closed", "no_money", "has_stock", "refused", "not_reached", "other"];

/** A location from the browser, kept only when it is a real one: never refused, only dropped. */
function cleanLocation(loc) {
  if (!loc || typeof loc !== "object") return undefined;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return undefined;
  const accuracy = Number(loc.accuracy);
  return { lat, lng, ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}) };
}

// A stop that did not end in a sale or a payment, and why. Only while the van is out.
class VanVisitService {
  static REASONS = REASONS;

  static async record(tripId, input = {}, by, byName) {
    const trip = await loadTrip(tripId);
    if (!rules.SELLING.has(trip.status)) throw fail("Visits are recorded while the van is out", 409, "TRIP_NOT_SELLING");
    if (!isId(input.customerId)) throw fail("Choose the customer", 400, "CUSTOMER_REQUIRED");
    const c = await Customer.findById(input.customerId).select("customerName").lean();
    if (!c) throw fail("That customer does not exist", 404, "CUSTOMER_NOT_FOUND");
    const outcome = input.outcome === "skipped" ? "skipped" : "no_sale";
    const reason = REASONS.includes(input.reason) ? input.reason : null;
    if (!reason) throw fail("Say why there was no sale", 400, "VISIT_REASON_REQUIRED");
    const [visit] = await VanVisit.create([{
      tripId: trip._id, tripNo: trip.tripNo, customerId: c._id, customerName: c.customerName, outcome, reason,
      note: String(input.note || "").slice(0, 300), at: new Date(), location: cleanLocation(input.location), by: String(by), byName: byName || "",
    }]);
    return visit;
  }

  static async forTrip(tripId) {
    return VanVisit.find({ tripId }).sort({ at: 1 }).lean();
  }
}

module.exports = VanVisitService;
module.exports.cleanLocation = cleanLocation;
