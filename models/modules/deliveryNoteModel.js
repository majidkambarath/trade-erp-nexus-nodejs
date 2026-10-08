const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { baseLineFields, chargeSchema, pricingSchema, linkSchema } = require("./salesDocumentParts");

// The paper that travels with the goods, signed by whoever receives them. It posts nothing and moves
// no stock: stock leaves when the sales order it belongs to is approved (utils/salesDocuments.js).
// `invoiceStatus` says whether that has happened yet, and is refreshed by
// services/orderPurchase/deliveryNoteLinks.js whenever a sales order is approved, cancelled or deleted.
const deliveryLine = new mongoose.Schema({
  ...baseLineFields,
  // The line of the sales order this delivers part of, when the note is raised against one.
  sourceLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // What the customer actually accepted. null until the delivery is confirmed.
  deliveredQty: { type: Number, default: null, min: 0 },
  shortReason: { type: String, trim: true, default: "" },
});

const deliveryNoteSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    deliveryNoteNo: { type: String, required: true, trim: true },

    partyId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    // Where the lines came from. A note against a sales order tracks how much of that order is out.
    source: { type: linkSchema(["manual", "sales_order", "quotation"]), default: () => ({ kind: "manual" }) },
    // The sales order that invoices these goods (the source order, or one raised from the note).
    invoice: { type: linkSchema(["sales_order"]), default: undefined },
    invoiceStatus: { type: String, required: true, default: "NONE" },

    date: { type: Date, required: true },
    status: { type: String, required: true, default: "DRAFT" },
    reference: { type: String, trim: true, default: "" }, // the customer's LPO

    deliveryAddress: { type: String, trim: true, default: "" },
    contactPerson: { type: String, trim: true, default: "" },
    contactPhone: { type: String, trim: true, default: "" },
    vehicleNo: { type: String, trim: true, default: "" },
    driverName: { type: String, trim: true, default: "" },
    driverPhone: { type: String, trim: true, default: "" },

    items: { type: [deliveryLine], default: [] },
    // Carried so an invoice raised from the note matches the offer or order it came from.
    charges: { type: [chargeSchema], default: [] },
    discount: { type: Number, default: 0, min: 0 },
    pricing: { type: pricingSchema, default: undefined },
    totalAmount: { type: Number, default: 0, min: 0 }, // the value of what was delivered

    notes: { type: String, trim: true, default: "" },

    dispatchedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    receivedBy: { type: String, trim: true, default: "" },
    proofNote: { type: String, trim: true, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, default: "" },

    createdBy: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

deliveryNoteSchema.index({ companyId: 1, branchId: 1, deliveryNoteNo: 1 }, { unique: true });
deliveryNoteSchema.index({ companyId: 1, status: 1, invoiceStatus: 1 }); // delivered, not invoiced
deliveryNoteSchema.index({ companyId: 1, partyId: 1, date: -1 });
deliveryNoteSchema.index({ companyId: 1, "source.id": 1 }, { sparse: true });
deliveryNoteSchema.index({ companyId: 1, "invoice.id": 1 }, { sparse: true });
deliveryNoteSchema.index({ companyId: 1, createdAt: -1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
// documents belong to a branch: a person working in one branch sees only that branch's (utils/tenantPlugin.js)
deliveryNoteSchema.plugin(tenantPlugin, { branchScoped: true });

module.exports = mongoose.model("DeliveryNote", deliveryNoteSchema);
