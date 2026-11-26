const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A promotion offered on van sales (utils/promotions.js has the rule): a quantity slab, buy X get Y free, or a
// basket discount. A master, organisation-wide, like a price list. Empty customer / route lists mean everyone.
const ids = (ref) => [{ type: mongoose.Schema.Types.ObjectId, ref }];
const promotionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    kind: { type: String, enum: ["slab", "bxgy", "basket"], required: true },
    validFrom: { type: String, default: "" },
    validTo: { type: String, default: "" },
    priority: { type: Number, default: 0, min: 0, max: 100 },
    stackable: { type: Boolean, default: false },
    stockIds: ids("Stock"),
    categoryIds: ids("Category"),
    customerIds: ids("Customer"),
    routeIds: ids("VanRoute"),
    // slab / basket
    percent: Number,
    minQty: Number,
    minValue: Number,
    // buy X get Y
    buyQty: Number,
    freeQty: Number,
    freeStockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", default: undefined },
    active: { type: Boolean, default: true },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
  },
  { timestamps: true }
);

promotionSchema.index({ name: 1 }, { unique: true });
promotionSchema.index({ active: 1, kind: 1 });

promotionSchema.plugin(tenantPlugin, { leadIndexes: true });

// every change a person makes is logged with its old and new values, and a deleted record is kept (utils/auditPlugin.js)
promotionSchema.plugin(require("../../../utils/auditPlugin"), { entity: "Promotion" });
module.exports = mongoose.models.Promotion || mongoose.model("Promotion", promotionSchema);
