const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// A product's saved route: what it is made from (for `batchQty` units) and the steps it goes through, each with who
// usually does it and how many days it usually takes. A master like an item: organisation-wide, one per product. A new
// process order is planned from it (utils/processOrders.js orderFromRoute); changing a route never touches an order.
const id = mongoose.Schema.Types.ObjectId;

const routeStepSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mode: { type: String, enum: ["in_house", "job_work"], required: true },
    assigneeId: String,
    assigneeName: { type: String, trim: true, maxlength: 120 },
    jobWorkerId: { type: id, ref: "Vendor" },
    jobWorkerName: String,
    days: { type: Number, default: 0, min: 0, max: 365 },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const processRouteSchema = new mongoose.Schema(
  {
    finished: { stockId: { type: id, ref: "Stock", required: true }, itemId: String, itemName: String },
    batchQty: { type: Number, required: true, min: 0 },
    materials: { type: [new mongoose.Schema({ stockId: { type: id, ref: "Stock", required: true }, itemId: String, itemName: String, qty: Number }, { _id: false })], default: [] },
    steps: { type: [routeStepSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 1000 },
    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  },
  { timestamps: true }
);

processRouteSchema.index({ "finished.stockId": 1 }, { unique: true });
processRouteSchema.index({ "materials.stockId": 1 });

processRouteSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.ProcessRoute || mongoose.model("ProcessRoute", processRouteSchema);
