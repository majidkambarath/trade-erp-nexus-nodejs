const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { baseLineFields, chargeSchema, pricingSchema, linkSchema } = require("./salesDocumentParts");

// The paper that says what a vendor's goods turned out to be when they arrived, signed by whoever took them in. The
// vendor-side twin of a delivery note: it posts nothing and moves no stock. The PURCHASE INVOICE made from it does both,
// and can bill no more than was received. `invoiceStatus` is refreshed by services/orderPurchase/receiptLinks.js whenever
// that invoice is approved, rejected, cancelled or deleted.
const receiptLine = new mongoose.Schema({
  ...baseLineFields,
  // The line of the purchase order this receives part of, when the receipt is raised against one.
  sourceLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // What was actually taken in. null until the receipt is confirmed.
  receivedQty: { type: Number, default: null, min: 0 },
  shortReason: { type: String, trim: true, default: "" },
  batchNumber: { type: String, trim: true, default: "" },
  expiryDate: { type: Date, default: null },
});

const goodsReceiptSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    receiptNo: { type: String, required: true, trim: true },

    partyId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true },
    source: { type: linkSchema(["manual", "purchase_order"]), default: () => ({ kind: "manual" }) },
    // The purchase invoice (a purchase_order transaction) raised from this receipt.
    invoice: { type: linkSchema(["purchase_order"]), default: undefined },
    invoiceStatus: { type: String, required: true, default: "NONE" },

    date: { type: Date, required: true },
    status: { type: String, required: true, default: "DRAFT" },
    vendorDeliveryNo: { type: String, trim: true, default: "" }, // the vendor's own delivery note or invoice number
    reference: { type: String, trim: true, default: "" },
    vehicleNo: { type: String, trim: true, default: "" },
    driverName: { type: String, trim: true, default: "" },

    items: { type: [receiptLine], default: [] },
    charges: { type: [chargeSchema], default: [] },
    discount: { type: Number, default: 0, min: 0 },
    pricing: { type: pricingSchema, default: undefined },
    totalAmount: { type: Number, default: 0, min: 0 }, // the value of what was received

    notes: { type: String, trim: true, default: "" },

    receivedAt: { type: Date, default: null },
    receivedBy: { type: String, trim: true, default: "" }, // who took the goods in
    proofNote: { type: String, trim: true, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, default: "" },

    createdBy: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

goodsReceiptSchema.index({ companyId: 1, branchId: 1, receiptNo: 1 }, { unique: true });
goodsReceiptSchema.index({ companyId: 1, status: 1, invoiceStatus: 1 }); // received, not invoiced
goodsReceiptSchema.index({ companyId: 1, partyId: 1, date: -1 });
goodsReceiptSchema.index({ companyId: 1, "source.id": 1 }, { sparse: true });
goodsReceiptSchema.index({ companyId: 1, "invoice.id": 1 }, { sparse: true });
goodsReceiptSchema.index({ companyId: 1, createdAt: -1 });

goodsReceiptSchema.plugin(tenantPlugin, { branchScoped: true });

module.exports = mongoose.model("GoodsReceipt", goodsReceiptSchema);
