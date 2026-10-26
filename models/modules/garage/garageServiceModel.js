const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// The service menu: a saved "standard job" (an oil change, a brake job, a 40,000 km service) that fills a job
// card's estimate and tasks in one tap (GET /garage/services/plan?serviceId=&vehicleId= - the twin of
// processRouteService.plan, which returns a draft payload and creates nothing). Organisation-wide, like Customer
// or Vendor: the menu is the same whichever branch sells it.
//
// `serviceItemId` points at the real money: a service Stock item (itemType: "service") carrying the price, VAT
// and income account. This row is only a narrow master pointing at that item plus the hours and the parts/tasks
// it usually needs - the same "a menu entry pointing at the real thing" shape as a CRM Contact pointing at a
// Customer's own contacts array. Nothing here prices anything; jobCardService.#priceAndStampLines still does
// that from the real item master once the plan is accepted onto a card.
const defaultPartSchema = new mongoose.Schema(
  { stockId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true }, qty: { type: Number, min: 0, default: 1 } },
  { _id: false }
);
const defaultTaskSchema = new mongoose.Schema(
  { name: { type: String, trim: true, maxlength: 80, required: true }, mode: { type: String, enum: ["in_house", "sublet"], default: "in_house" }, standardHours: { type: Number, min: 0, default: 0 } },
  { _id: false }
);

const garageServiceSchema = new mongoose.Schema(
  {
    code: { type: String, trim: true, maxlength: 20, required: true },
    name: { type: String, trim: true, maxlength: 120, required: true },
    category: { type: String, trim: true, maxlength: 60, default: "" },
    serviceItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock", required: true },
    standardHours: { type: Number, min: 0, default: 0 },
    defaultParts: { type: [defaultPartSchema], default: [] },
    defaultTasks: { type: [defaultTaskSchema], default: [] },
    appliesTo: {
      makes: { type: [String], default: [] },
      models: { type: [String], default: [] },
    },
    active: { type: Boolean, default: true },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
  },
  { timestamps: true }
);

garageServiceSchema.index({ code: 1 }, { unique: true });
garageServiceSchema.index({ active: 1 });
garageServiceSchema.index({ name: 1 });

garageServiceSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.GarageService || mongoose.model("GarageService", garageServiceSchema);
