const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// A production: materials taken out of stock and expenses already paid (travelling, coating powder,
// packing, ...) put into the cost of the item it made. DRAFT -> POSTED -> REVERSED. Posting moves the
// stock (materials out at their average cost, the finished item in at the whole cost) and, when ledger
// posting is on, books Dr Inventory / Cr Inventory (materials) / Cr "Production costs moved to stock".
// Service: services/stock/productionService.js; pure rules: utils/production.js.
const id = mongoose.Schema.Types.ObjectId;

const allocationSchema = new mongoose.Schema(
  { batchId: id, batchNumber: String, qty: Number, expiryDate: Date },
  { _id: false }
);

const materialSchema = new mongoose.Schema({
  stockId: { type: id, ref: "Stock", required: true },
  itemId: { type: String }, // Stock.itemId, the code the movements carry
  itemName: { type: String },
  qty: { type: Number, required: true, min: 0 },
  unitCost: { type: Number, default: null }, // set when posted: the average it left at
  cost: { type: Number, default: null },
  allocations: { type: [allocationSchema], default: undefined }, // the batches it came from (FEFO)
});

const costSchema = new mongoose.Schema({
  accountId: { type: id, ref: "LedgerAccount", required: true }, // the expense the cost was paid to
  accountCode: { type: String },
  accountName: { type: String },
  amount: { type: Number, required: true, min: 0 },
  narration: { type: String, trim: true, maxlength: 300 },
});

const productionOrderSchema = new mongoose.Schema(
  {
    productionNo: { type: String, required: true },
    date: { type: Date, required: true },
    status: { type: String, enum: ["DRAFT", "POSTED", "REVERSED"], default: "DRAFT" },
    finished: {
      stockId: { type: id, ref: "Stock", required: true },
      itemId: { type: String },
      itemName: { type: String },
      qty: { type: Number, required: true, min: 0 },
      batchNumber: { type: String, trim: true },
      expiryDate: { type: Date },
    },
    materials: { type: [materialSchema], default: [] },
    costs: { type: [costSchema], default: [] },
    totals: {
      materials: { type: Number, default: 0 },
      costs: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      unitCost: { type: Number, default: 0 },
    },
    notes: { type: String, trim: true, maxlength: 1000 },
    // made by a receipt on a job work (utils/jobWork.js): reversed only through that job, so the two never drift
    source: { kind: { type: String, enum: ["job_work"] }, id: { type: id }, no: String },
    ledgerPosted: { type: Boolean, default: false },
    acknowledged: { type: [String], default: undefined }, // warnings ticked when it was posted
    postedAt: Date,
    postedBy: String,
    reversedAt: Date,
    reversedBy: String,
    reverseReason: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: String },
    updatedBy: { type: String },
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the branch; head office is "main"
  },
  { timestamps: true }
);

productionOrderSchema.index({ productionNo: 1 }, { unique: true });
productionOrderSchema.index({ status: 1, date: -1 });
productionOrderSchema.index({ "finished.stockId": 1, date: -1 });
productionOrderSchema.index({ "materials.stockId": 1 });
productionOrderSchema.index({ createdAt: -1 });

productionOrderSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.ProductionOrder || mongoose.model("ProductionOrder", productionOrderSchema);
