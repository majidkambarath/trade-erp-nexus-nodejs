// A deal with a customer: what it is worth, how likely it is, when it should close, and which stage of the pipeline it
// sits on. It always belongs to a real Customer (a lead becomes one when it is qualified), so every amount here can be
// compared with the ledger and the ageing without a second kind of party.
//
// `autoMoves` is the point of the whole module. Each entry is one automatic stage move, claimed under a key of
// "<event>:<documentId>" so a retried transaction or a second call cannot apply it twice, and recording where the deal
// came FROM so that a document later rejected, cancelled or deleted puts the deal back where it was rather than
// leaving it won for ever. utils/crm.js `planAdvance` / `planUndo` are the two halves of that rule; the claim itself is
// a conditional updateOne in services/crm/crmHooks.js, the same compare-and-set as utils/migrations.js uses.
const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");
const crm = require("../../../utils/crm");

const autoMoveSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // "invoice_approved:<documentId>" - the claim
    event: { type: String, enum: crm.EVENTS, required: true },
    from: { type: String, default: null }, // the stage key it was on before
    to: { type: String, required: true },
    at: { type: Date, default: Date.now },
    by: { type: String, default: "automation" }, // never a person: this is what the documents did
    docId: { type: String, default: null },
    docNo: { type: String, default: "" },
    undoneAt: { type: Date, default: null }, // the move was taken back; the row stays, as a record
  },
  { _id: false }
);

const opportunitySchema = new mongoose.Schema(
  {
    opportunityNo: { type: String, trim: true },

    title: { type: String, required: true, trim: true, maxlength: 150 },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, trim: true, default: "" },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    stageKey: { type: String, required: true },
    stageName: { type: String, trim: true, default: "" },
    probability: { type: Number, default: 0, min: 0, max: 100 },
    stageSinceDay: { type: String, default: null }, // "YYYY-MM-DD": how long it has stood where it stands

    value: { type: Number, default: 0, min: 0 }, // in the organisation's base currency, like every other figure
    expectedCloseDate: { type: String, default: null }, // a day, not an instant (utils/crm.js reads days)

    status: { type: String, enum: crm.OPPORTUNITY_STATUS, default: "OPEN" },
    source: { type: String, enum: crm.LEAD_SOURCES, default: "other" },
    openedDay: { type: String, default: null },
    closedDay: { type: String, default: null },
    lostReason: { type: String, enum: [...crm.LOST_REASONS, null], default: null },
    lostNote: { type: String, trim: true, maxlength: 300, default: "" },

    ownerId: { type: String, default: null },
    ownerName: { type: String, trim: true, default: "" },

    // The documents this deal became. Numbers are kept beside the ids on purpose: a person holding CRM but not Sales
    // may read the deal, and the screen must be able to name the quotation without being able to open it.
    links: {
      quotationId: { type: String, default: null },
      quotationNo: { type: String, default: "" },
      orderId: { type: String, default: null },
      orderNo: { type: String, default: "" },
      deliveryNoteId: { type: String, default: null },
      deliveryNoteNo: { type: String, default: "" },
    },
    autoMoves: { type: [autoMoveSchema], default: [] },

    lastActivityAt: { type: Date, default: null },
    lastActivityDay: { type: String, default: null },
    nextActionAt: { type: String, default: null },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },

    createdBy: { type: String, default: "system" },
    updatedBy: { type: String, default: null },

    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the branch; head office is "main"
  },
  { timestamps: true }
);

opportunitySchema.index({ opportunityNo: 1 }, { unique: true, partialFilterExpression: { opportunityNo: { $type: "string" } } });
opportunitySchema.index({ status: 1, stageKey: 1 });
opportunitySchema.index({ ownerId: 1, status: 1 });
opportunitySchema.index({ customerId: 1, status: 1 });
// How the hook finds the deal behind a document, once per quotation or invoice event. Indexed because it is read on
// the sales approval path, which is the hottest write in the product.
opportunitySchema.index({ "links.quotationId": 1 });
opportunitySchema.index({ "links.orderId": 1 });
// An invoice raised from a quotation names it by NUMBER (`Transaction.quoteRef`), which is how the hook finds the deal
// when the invoice itself was never linked - so that read is indexed too rather than scanning on the approval path.
opportunitySchema.index({ "links.quotationNo": 1 });
opportunitySchema.index({ createdAt: -1 });

opportunitySchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.Opportunity || mongoose.model("Opportunity", opportunitySchema);
