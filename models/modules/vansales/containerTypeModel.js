const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A kind of returnable container that goes out with the goods and comes back empty: a crate, a 19L bottle, a gas
// cylinder, a pallet. NOT a stock item - handed out as goods it would post cost of goods, sit in the valuation and need
// a credit note to come back. A master, organisation-wide like the price lists. `items` says which goods come in it and
// how many containers one unit takes (1 for a 19L water, 1/12 for a 1L milk in a crate of 12); the link lives here so the
// item master and its form are not touched. `deposit` (0 = none) is charged per container given and refunded per
// container collected, held as a liability (posting key container-deposits).
const containerTypeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    deposit: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true },
    items: [
      {
        stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
        itemName: String,
        perUnit: { type: Number, required: true, min: 0 },
        _id: false,
      },
    ],
    createdBy: String,
    updatedBy: String,

    companyId: { type: String, required: true },
  },
  { timestamps: true }
);

containerTypeSchema.index({ code: 1 }, { unique: true });

containerTypeSchema.plugin(tenantPlugin, { leadIndexes: true });

// every change a person makes is logged with its old and new values, and a deleted record is kept (utils/auditPlugin.js)
containerTypeSchema.plugin(require("../../../utils/auditPlugin"), { entity: "ContainerType" });
module.exports = mongoose.models.ContainerType || mongoose.model("ContainerType", containerTypeSchema);
