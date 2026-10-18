const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// A process order: one product made through steps in order (cutting -> bending -> painting -> packing), each in-house
// (a person) or job work (a vendor, on a job-work challan). DRAFT -> OPEN -> COMPLETED, or CANCELLED. Nothing moves in
// stock or the books while the steps run; finishing the order posts ONE Production (the materials out, the product in
// at their cost plus the costs moved in). Rules: utils/processOrders.js; service: services/stock/processOrderService.js.
const id = mongoose.Schema.Types.ObjectId;

const stepSchema = new mongoose.Schema({
  seq: Number,
  name: { type: String, required: true, trim: true, maxlength: 80 },
  mode: { type: String, enum: ["in_house", "job_work"], required: true },
  assigneeId: { type: String }, // the person doing an in-house step (an account id); optional
  assigneeName: { type: String, trim: true, maxlength: 120 },
  jobWorkerId: { type: id, ref: "Vendor" },
  jobWorkerName: String,
  dueDate: Date,
  plannedQty: { type: Number, default: 0 },
  status: { type: String, enum: ["WAITING", "READY", "IN_PROGRESS", "DONE"], default: "WAITING" },
  qtyDone: { type: Number, default: 0 },
  qtyRejected: { type: Number, default: 0 },
  startedAt: Date,
  startedBy: String,
  doneAt: Date,
  doneBy: String,
  jobWorkId: { type: id, ref: "JobWorkOrder" },
  jobWorkNo: String,
  notes: { type: String, trim: true, maxlength: 500 },
});

const processOrderSchema = new mongoose.Schema(
  {
    processNo: { type: String }, // given when released; a draft has none
    status: { type: String, enum: ["DRAFT", "OPEN", "COMPLETED", "CANCELLED"], default: "DRAFT" },
    date: { type: Date, required: true },
    dueDate: Date,
    finished: { stockId: { type: id, ref: "Stock", required: true }, itemId: String, itemName: String, qty: { type: Number, required: true, min: 0 } },
    materials: { type: [new mongoose.Schema({ stockId: { type: id, ref: "Stock", required: true }, itemId: String, itemName: String, qty: Number }, { _id: false })], default: [] },
    steps: { type: [stepSchema], default: [] },
    notes: { type: String, trim: true, maxlength: 1000 },
    releasedAt: Date,
    completedAt: Date,
    productionId: { type: id, ref: "ProductionOrder" },
    productionNo: String,
    cancelledAt: Date,
    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the branch; head office is "main"
  },
  { timestamps: true }
);

processOrderSchema.index({ processNo: 1 }, { unique: true, partialFilterExpression: { processNo: { $type: "string" } } });
processOrderSchema.index({ status: 1, dueDate: 1 });
processOrderSchema.index({ "steps.assigneeId": 1, status: 1 });
processOrderSchema.index({ "finished.stockId": 1, createdAt: -1 });
processOrderSchema.index({ createdAt: -1 });

processOrderSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.ProcessOrder || mongoose.model("ProcessOrder", processOrderSchema);
