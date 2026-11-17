const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A price list: what given customers (or every customer on a route that names it) pay for given items, with quantity
// breaks and the days it is good for (utils/priceLists.js has the rule). A master, organisation-wide, like a customer.
// An item not on the list is sold at its own sales price.
const priceListSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    validFrom: { type: String, default: "" }, // "YYYY-MM-DD", empty = from the start
    validTo: { type: String, default: "" }, // "YYYY-MM-DD", empty = no end
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Customer" }],
    lines: [
      {
        stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
        itemName: { type: String, trim: true, default: "" },
        price: { type: Number, required: true, min: 0 },
        minQty: { type: Number, default: 1, min: 0 },
        _id: false,
      },
    ],
    active: { type: Boolean, default: true },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
  },
  { timestamps: true }
);

priceListSchema.index({ name: 1 }, { unique: true });
priceListSchema.index({ customerIds: 1, active: 1 });

priceListSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.PriceList || mongoose.model("PriceList", priceListSchema);
