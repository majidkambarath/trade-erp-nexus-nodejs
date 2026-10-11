const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { baseLineFields, chargeSchema, pricingSchema } = require("./salesDocumentParts");

// A sales order (what a customer has asked for) or a purchase order (what we have asked a vendor for). It is a
// COMMITMENT, never a posting: no ledger entry, no stock, no party balance. Those happen when an invoice made from it is
// approved (utils/tradeOrders.js). What has been received or delivered and what has been invoiced is read from the
// goods receipts / delivery notes and invoices that point back at the order, so nothing here can drift.
const orderLine = new mongoose.Schema({
  ...baseLineFields,
  batchNumber: { type: String, trim: true, default: "" }, // what a purchase expects to receive, carried to the receipt
  expiryDate: { type: Date, default: null },
});

const tradeOrderSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    kind: { type: String, enum: ["sales", "purchase"], required: true },
    orderNo: { type: String, required: true, trim: true },

    partyId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "partyType" },
    partyType: { type: String, enum: ["Customer", "Vendor"], required: true },

    date: { type: Date, required: true },
    expectedDate: { type: Date, default: null }, // delivery date asked for / date the vendor promised
    reference: { type: String, trim: true, default: "" }, // the customer's LPO, or the vendor's quotation / reference
    status: { type: String, required: true, default: "DRAFT" },

    items: { type: [orderLine], default: [] },
    charges: { type: [chargeSchema], default: [] },
    discount: { type: Number, default: 0, min: 0 },
    pricing: { type: pricingSchema, default: undefined },
    totalAmount: { type: Number, default: 0, min: 0 },

    notes: { type: String, trim: true, default: "" },
    terms: { type: String, trim: true, default: "" },

    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: String, trim: true, default: "" },
    closedAt: { type: Date, default: null },
    closeReason: { type: String, trim: true, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, default: "" },

    createdBy: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

tradeOrderSchema.index({ companyId: 1, branchId: 1, kind: 1, orderNo: 1 }, { unique: true });
tradeOrderSchema.index({ companyId: 1, kind: 1, status: 1, date: -1 });
tradeOrderSchema.index({ companyId: 1, partyId: 1, date: -1 });
tradeOrderSchema.index({ companyId: 1, createdAt: -1 });

// Scope every query and write to the organisation in scope; an order belongs to a branch (utils/tenantPlugin.js).
tradeOrderSchema.plugin(tenantPlugin, { branchScoped: true });

module.exports = mongoose.model("TradeOrder", tradeOrderSchema);
