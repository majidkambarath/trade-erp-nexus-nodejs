const mongoose = require("mongoose");

// Pieces a quotation and a delivery note share with each other, and with the sales order they can
// turn into. The line carries the same pricing columns as Transaction.items so a line copies across
// unchanged and utils/pricing.js prices all three alike.

const pricingFields = {
  price: { type: Number, default: 0, min: 0 }, // unit price, VAT-exclusive
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  discountAmount: { type: Number, default: 0, min: 0 }, // what was actually taken off
  grossAmount: { type: Number, default: 0, min: 0 },
  taxableAmount: { type: Number, default: 0, min: 0 },
  taxCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "TaxCode", default: null },
  taxKind: { type: String, default: null },
  vatPercent: { type: Number, default: 0, min: 0 },
  vatAmount: { type: Number, default: 0, min: 0 },
  lineTotal: { type: Number, default: 0, min: 0 }, // VAT-inclusive
};

const baseLineFields = {
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
  itemCode: { type: String, default: "" },
  description: { type: String, required: true, trim: true },
  qty: { type: Number, required: true, min: 0 },
  ...pricingFields,
};

// Header charges (freight, handling...): each has its own tax.
const chargeSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true },
    description: { type: String, trim: true },
    amount: { type: Number, required: true, min: 0 },
    vatPercent: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// Server-computed totals (utils/pricing.js priceDocument).
const pricingSchema = new mongoose.Schema(
  {
    gross: Number, lineDiscount: Number, net: Number, lineVat: Number, chargesNet: Number,
    chargesVat: Number, headerDiscount: Number, roundOff: Number, grandTotal: Number,
  },
  { _id: false }
);

// A document's link to the document it became or came from. The target is a separate record that
// can be deleted, so a link is read together with that record's state, never trusted on its own.
const linkSchema = (kinds) =>
  new mongoose.Schema(
    {
      kind: { type: String, enum: kinds },
      id: { type: mongoose.Schema.Types.ObjectId },
      no: { type: String, trim: true },
    },
    { _id: false }
  );

module.exports = { pricingFields, baseLineFields, chargeSchema, pricingSchema, linkSchema };
