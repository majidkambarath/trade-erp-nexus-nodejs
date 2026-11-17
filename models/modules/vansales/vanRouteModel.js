const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A route: the customers a van calls on, in the order it calls, and the weekdays it runs (0 = Sunday; none listed
// means any day). A master, organisation-wide. The customer's name is a snapshot for the list; the id is what counts.
const routeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    days: [{ type: Number, min: 0, max: 6, _id: false }],
    customers: [
      {
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
        name: { type: String, trim: true, maxlength: 150, default: "" },
        seq: { type: Number, default: 0 },
        _id: false,
      },
    ],
    // the price list every customer on the route is sold at, unless the customer has a list of their own
    priceListId: { type: mongoose.Schema.Types.ObjectId, ref: "PriceList", default: null },
    active: { type: Boolean, default: true },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
  },
  { timestamps: true }
);

routeSchema.index({ name: 1 }, { unique: true });

routeSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.VanRoute || mongoose.model("VanRoute", routeSchema);
