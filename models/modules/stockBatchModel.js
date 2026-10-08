const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// A batch is a property of a RECEIPT, not of the product: the same item arrives in several lots
// with different expiry dates. Quantity and expiry live here; cost stays in the item's weighted
// average (batches are not separate cost layers).
const stockBatchSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
    itemCode: { type: String }, // Stock.itemId, for display and movement lookups
    batchNumber: { type: String, required: true, trim: true },
    expiryDate: { type: Date, default: null }, // null = does not expire / unknown
    receivedQty: { type: Number, required: true, min: 0 },
    qtyOnHand: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 }, // cost at receipt, for information
    sourceTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    sourceTransactionNo: { type: String, default: null },
    receivedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["active", "depleted", "written_off"], default: "active" },
  },
  { timestamps: true }
);

// First-expiry-first-out reads batches of one item ordered by expiry then receipt.
stockBatchSchema.index({ companyId: 1, stockId: 1, status: 1, expiryDate: 1, receivedAt: 1 });
stockBatchSchema.index({ companyId: 1, expiryDate: 1 });
stockBatchSchema.index({ sourceTransactionId: 1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
stockBatchSchema.plugin(tenantPlugin);

module.exports = mongoose.model("StockBatch", stockBatchSchema);
