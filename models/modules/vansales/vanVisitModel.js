const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A stop the salesman made on a trip that did NOT end in a sale or a payment: the shop was closed, the owner had no
// money, they still had stock, they refused. A sale or a receipt is its own record (an invoice, a voucher) and is not
// written here twice. Together they answer "who did the van call on, and why did some not buy" (the strike rate).
// Branch scoped, like the trip it belongs to.
const visitSchema = new mongoose.Schema(
  {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "VanTrip", required: true },
    tripNo: String,
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, trim: true, default: "" },
    outcome: { type: String, enum: ["no_sale", "skipped"], required: true },
    reason: { type: String, enum: ["closed", "no_money", "has_stock", "refused", "not_reached", "other"], required: true },
    note: { type: String, trim: true, maxlength: 300, default: "" },
    at: { type: Date, default: Date.now },
    // where the phone was, when the browser gave it (phase 5): a flag for the supervisor, never a refusal
    location: { lat: Number, lng: Number, accuracy: Number, _id: false },
    by: String,
    byName: String,

    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
  },
  { timestamps: true }
);

visitSchema.index({ tripId: 1, customerId: 1 });
visitSchema.index({ customerId: 1, at: -1 });

visitSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.VanVisit || mongoose.model("VanVisit", visitSchema);
