const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// Containers that changed hands with a customer: given out with a sale, collected back empty (with a sale or at a stop
// with none), or set by a supervisor (what a customer already held at go-live, a correction). A physical fact, kept apart
// from the invoice: deleting an invoice later does not undo crates that really went out. A customer's balance is the sum
// of given less collected over their moves. Branch scoped, like the trip; a balance is read across every branch.
const moveSchema = new mongoose.Schema(
  {
    typeId: { type: mongoose.Schema.Types.ObjectId, ref: "ContainerType", required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    given: { type: Number, default: 0, min: 0 },
    collected: { type: Number, default: 0, min: 0 },
    kind: { type: String, enum: ["sale", "empties", "adjustment"], required: true },
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "VanTrip" },
    tripNo: String,
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
    transactionNo: String,
    voucherId: { type: mongoose.Schema.Types.ObjectId }, // the deposit's debit or credit note, when there was one
    deposit: { type: Number, default: 0 }, // per container, as it was when this move was made
    note: { type: String, trim: true, maxlength: 300 },
    at: { type: Date, default: Date.now },
    by: String,
    byName: String,

    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
  },
  { timestamps: true }
);

moveSchema.index({ customerId: 1, typeId: 1 });
moveSchema.index({ tripId: 1 });

moveSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.VanContainerMove || mongoose.model("VanContainerMove", moveSchema);
