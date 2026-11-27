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
    qty: { type: Number, required: true }, // negative only on a transfer out to another van
  },
  { _id: false }
);

const loadSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true }, // 1 = the first load, 2.. = top-ups
    kind: { type: String, enum: ["load", "transfer_in", "transfer_out"], default: "load" },
    peerTripNo: String, // the other van's trip, on a transfer
    requestNo: Number, // the load request this load was accepted from (absent on a direct load)
    at: { type: Date, default: Date.now },
    by: String,
    byName: String,
    lines: [loadLine],
  },
  { _id: false }
);

// A load the salesman ASKED for (CompanySettings.vanSales.loadRequests). It is not a load: nothing here is on the van
// until the salesman accepts it, which pushes an ordinary loads[] entry at the quantities he accepted. While it is
// LOADED (on the van, not yet accepted) its `loaded` quantities reserve depot stock but cannot be sold.
const loadRequestSchema = new mongoose.Schema(
  {
    no: { type: Number, required: true },
    status: { type: String, enum: ["REQUESTED", "LOADED", "ACCEPTED", "REJECTED", "CANCELLED"], default: "REQUESTED" },
    note: String,
    requestedAt: { type: Date, default: Date.now },
    requestedBy: String,
    requestedByName: String,
    loadedAt: Date,
    loadedBy: String,
    loadedByName: String,
    acceptedAt: Date,
    acceptedBy: String,
    acceptedByName: String,
    closedAt: Date, // rejected or cancelled
    closedByName: String,
    reason: String, // why it was refused, or why less arrived than was loaded
    loadNo: Number, // the loads[] entry its acceptance made
    lines: [
      {
        stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
        itemName: String,
        requested: { type: Number, default: 0, min: 0 },
        loaded: Number,
        accepted: Number,
        _id: false,
      },
    ],
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
    // why it came back, in the organisation's wording at the time; whether an invoice stood behind it; what it credited.
    // No defaults: a return recorded before these existed reads exactly as it did.
    reason: String,
    note: String,
    withoutInvoice: Boolean,
    amount: Number,
  },
  { _id: false }
);

// One count of the van at count-in: who, when, each item against what should have been there, and the containers.
const countFields = {
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
    // returnable containers counted on the van (crates, bottles): what should be there and what was (no default)
    containers: [{ typeId: { type: mongoose.Schema.Types.ObjectId, ref: "ContainerType" }, name: String, expected: Number, counted: Number, difference: Number, _id: false }],
};

const unloadSchema = new mongoose.Schema(
  {
    ...countFields,
    // earlier counts, when the van was counted again before settling (the last five; absent where it was counted once)
    previous: { type: [new mongoose.Schema(countFields, { _id: false })], default: undefined },
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
    expenses: Number, // paid from the van's cash on the road (fuel, tolls), taken off the cash expected
    cheques: [{ chequeNo: String, amount: Number, handed: Boolean, _id: false }],
    // taken by card (to the machine's bank account) and by bank transfer: not cash, so not in the journal; a transfer may still
    // be waiting for the office to see it in the bank when the trip is settled (no default: absent on earlier trips)
    cardTotal: Number,
    transferTotal: Number,
    transfersWaiting: Number,
    stockVarianceValue: Number, // units short (negative) or over (positive), at average cost
    damagedValue: Number, // what the damaged goods were worth, written off
    // containers missing from the van at count-in, and the deposit they were worth (charged to the salesman's shortage)
    containersMissing: Number,
    containersMissingValue: Number,
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
    loadRequests: [loadRequestSchema],
    // invoice numbers reserved when the van went out, for sales made with no signal (phase 3). Which are used is
    // derived from the invoices; the rest are retired with a reason when the van is counted in.
    numberBlock: [{ type: String, trim: true }],
    numbersRetiredAt: Date,
    departedAt: Date,
    // km on the clock going out and coming back (phase 5); route profitability reads the difference
    odometer: { type: new mongoose.Schema({ out: Number, in: Number }, { _id: false }), default: undefined },
    // the van's daily targets as they stood when the trip was opened (absent on trips from before targets, and on a
    // van with none: the trip view then reads the van's current ones)
    target: { type: new mongoose.Schema({ sales: Number, calls: Number }, { _id: false }), default: undefined },
    // where the phone was at each sale / payment / visit it reported a location for, against the customer's pinned
    // place. A flag for the supervisor's board, never a refusal: a phone's location can be poor.
    pings: [
      {
        at: { type: Date, default: Date.now },
        kind: { type: String, enum: ["sale", "collect", "visit", "preorder"] },
        customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
        ref: String,
        lat: Number,
        lng: Number,
        accuracy: Number,
        distanceM: Number,
        far: Boolean,
        _id: false,
      },
    ],
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
vanTripSchema.plugin(require("../../../utils/auditPlugin"), { entity: "VanTrip", ignore: ["pings", "numbersRetiredAt"] });

module.exports = mongoose.models.VanTrip || mongoose.model("VanTrip", vanTripSchema);
