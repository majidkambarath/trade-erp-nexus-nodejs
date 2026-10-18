const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

// Job work (subcontracting): our own parts sent to an outside party (a powder coater) and received back finished.
// DRAFT -> SENT -> PARTLY_RECEIVED -> RECEIVED, or CANCELLED. Sending moves NO stock and posts nothing: the parts
// are still ours (IAS 2; in India CGST Act s.143, sent on a job-work delivery challan under Rule 55). Each receipt
// creates and posts a Production (services/stock/productionService.js): the raw parts out at their cost, the
// finished item in at that cost plus the coating and transport moved into it.
// Service: services/stock/jobWorkService.js; pure rules: utils/jobWork.js.
const id = mongoose.Schema.Types.ObjectId;

const lineSchema = new mongoose.Schema({
  rawStockId: { type: id, ref: "Stock", required: true },
  rawItemId: String, // Stock.itemId, the code movements carry
  rawName: String,
  qtySent: { type: Number, required: true, min: 0 },
  unitValue: { type: Number, default: 0 }, // the average cost when sent: the value printed on the challan
  finishedStockId: { type: id, ref: "Stock", required: true },
  finishedItemId: String,
  finishedName: String,
  finishedPerRaw: { type: Number, default: 1, min: 0 }, // finished units expected from one raw unit
});

const receiptLineSchema = new mongoose.Schema(
  {
    lineId: { type: id, required: true },
    finishedQty: { type: Number, default: 0, min: 0 },
    rawConsumed: { type: Number, default: 0, min: 0 },
    rawReturned: { type: Number, default: 0, min: 0 }, // came back unprocessed: it never left our stock in the books
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  workerRef: { type: String, trim: true, maxlength: 60 }, // the job worker's own challan / invoice number
  // one production per item that came back; the costs entered on the receipt are spread over them by the value sent
  productions: { type: [new mongoose.Schema({ id: { type: id, ref: "ProductionOrder" }, no: String }, { _id: false })], default: [] },
  lines: { type: [receiptLineSchema], default: [] },
  createdBy: String,
  createdAt: { type: Date, default: Date.now },
  reversedAt: Date,
  reversedBy: String,
});

const jobWorkOrderSchema = new mongoose.Schema(
  {
    jobWorkNo: { type: String }, // given when sent (the challan number); a draft has none
    status: { type: String, enum: ["DRAFT", "SENT", "PARTLY_RECEIVED", "RECEIVED", "CANCELLED"], default: "DRAFT" },
    jobWorkerId: { type: id, ref: "Vendor", required: true },
    jobWorker: { name: String, code: String, address: String, taxId: String, phone: String }, // as it was when sent
    date: { type: Date, required: true }, // the day it is (to be) sent
    sentAt: Date,
    returnBy: Date, // India: one year after sending (s.143); elsewhere optional
    purpose: { type: String, trim: true, maxlength: 200 },
    vehicleNo: { type: String, trim: true, maxlength: 40 },
    notes: { type: String, trim: true, maxlength: 1000 },
    lines: { type: [lineSchema], default: [] },
    receipts: { type: [receiptSchema], default: [] },
    cancelledAt: Date,
    cancelledBy: String,
    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the branch; head office is "main"
  },
  { timestamps: true }
);

jobWorkOrderSchema.index({ jobWorkNo: 1 }, { unique: true, partialFilterExpression: { jobWorkNo: { $type: "string" } } });
jobWorkOrderSchema.index({ status: 1, date: -1 });
jobWorkOrderSchema.index({ "lines.rawStockId": 1, status: 1 });
jobWorkOrderSchema.index({ jobWorkerId: 1, date: -1 });
jobWorkOrderSchema.index({ createdAt: -1 });

jobWorkOrderSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.JobWorkOrder || mongoose.model("JobWorkOrder", jobWorkOrderSchema);
