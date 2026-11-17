const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A van trip: one van, one salesman, one day (utils/vanSales.js has the rules). A NON-POSTING record, like a job card:
// loading it moves no stock and posts nothing. The invoices a trip raises are ordinary sales invoices carrying
// `vanTripRef`; the receipts it takes are ordinary receipt vouchers carrying the same. What is on the van is worked
// out from those, never stored.
//
//   LOADING -> ON_ROUTE -> UNLOADED -> SETTLED, or CANCELLED while nothing has been sold.

const loadLine = new mongoose.Schema(
  {
    stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
    itemName: { type: String, trim: true, default: "" },
    qty: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const loadSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true }, // 1 = the first load, 2.. = top-ups
    at: { type: Date, default: Date.now },
    by: String,
    byName: String,
    lines: [loadLine],
  },
  { _id: false }
);

// A sales return taken on the road. Whether each line came back sellable or damaged is the TRIP's record, kept here and
// not on the document line, so the invoice and return schemas and pricing stay exactly as they are.
const returnRecord = new mongoose.Schema(
  {
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", required: true },
    no: String,
    at: { type: Date, default: Date.now },
    lines: [
      {
        stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
        qty: { type: Number, required: true, min: 0 },
        condition: { type: String, enum: ["good", "damaged"], default: "good" },
        _id: false,
      },
    ],
  },
  { _id: false }
);

const unloadSchema = new mongoose.Schema(
  {
    at: Date,
    by: String,
    byName: String,
    lines: [
      {
        stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock" },
        itemName: String,
        expectedGood: Number,
        countedGood: Number,
        expectedDamaged: Number,
        countedDamaged: Number,
        difference: Number,
        _id: false,
      },
    ],
  },
  { _id: false }
);

const settlementSchema = new mongoose.Schema(
  {
    at: Date,
    by: String,
    byName: String,
    cashExpected: Number,
    cashHanded: Number,
    cashVariance: Number,
    cheques: [{ chequeNo: String, amount: Number, handed: Boolean, _id: false }],
    stockVarianceValue: Number, // units short (negative) or over (positive), at average cost
    damagedValue: Number, // what the damaged goods were worth, written off
    acknowledged: [String],
    voucherIds: [{ type: mongoose.Schema.Types.ObjectId }],
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const vanTripSchema = new mongoose.Schema(
  {
    tripNo: { type: String, trim: true },
    vanId: { type: mongoose.Schema.Types.ObjectId, ref: "Van", required: true },
    vanCode: { type: String, trim: true },
    vanName: { type: String, trim: true },
    cashAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount" }, // the van's cash account when the trip opened
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: "VanRoute", default: null },
    routeName: { type: String, trim: true, default: "" },
    salesmanId: { type: String, required: true },
    salesmanName: { type: String, default: "" },
    date: { type: Date, required: true }, // a calendar DAY, stored at midnight like every document
    status: { type: String, enum: ["LOADING", "ON_ROUTE", "UNLOADED", "SETTLED", "CANCELLED"], default: "LOADING" },

    loads: [loadSchema],
    returns: [returnRecord],
    unload: { type: unloadSchema, default: undefined },
    settlement: { type: settlementSchema, default: undefined },
    notes: { type: String, trim: true, maxlength: 500, default: "" },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
  },
  { timestamps: true }
);

vanTripSchema.index({ tripNo: 1 }, { unique: true, sparse: true });
vanTripSchema.index({ vanId: 1, status: 1 });
vanTripSchema.index({ salesmanId: 1, status: 1 });
vanTripSchema.index({ status: 1, date: -1 });
vanTripSchema.index({ date: -1 });

// Branch scoped: a trip belongs to the branch it was opened in, like every other trade document.
vanTripSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.VanTrip || mongoose.model("VanTrip", vanTripSchema);
