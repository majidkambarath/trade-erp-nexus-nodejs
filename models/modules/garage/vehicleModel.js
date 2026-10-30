const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A vehicle: organisation-wide (like Customer/Vendor), because its service history is the whole reason a garage
// buys software, and that history must survive a change of owner, not be scoped to the branch that first saw it.
// A vehicle can still be WORKED ON at any branch; what is per-branch is the job card, not the car.
//
// Looked up by plate or chassis, normalised (utils/garage.js plateKey/chassisKey) so "A 12345", "A-12345" and
// "a12345" all find one row - the field itself keeps whatever was typed. Rules: utils/garage.js. Service:
// services/garage/vehicleService.js.
const ownerHistorySchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    customerName: { type: String, trim: true, maxlength: 150 },
    from: Date,
    to: Date,
  },
  { _id: false }
);

const vehicleSchema = new mongoose.Schema(
  {
    plateNumber: { type: String, trim: true, maxlength: 20 },
    plateKey: { type: String, trim: true, maxlength: 20 }, // normalised form of plateNumber, for lookup only
    plateCode: { type: String, trim: true, maxlength: 10 }, // the UAE plate's own code/category (e.g. "A", "26")
    plateEmirate: { type: String, trim: true, maxlength: 20 },

    chassisNo: { type: String, trim: true, maxlength: 30 }, // VIN, as given
    chassisKey: { type: String, trim: true, maxlength: 30 }, // normalised form, for lookup

    engineNo: { type: String, trim: true, maxlength: 30, default: "" },
    make: { type: String, trim: true, maxlength: 60, required: true },
    model: { type: String, trim: true, maxlength: 60, required: true },
    variant: { type: String, trim: true, maxlength: 60, default: "" },
    year: { type: Number, min: 1900, max: 2100 },
    colour: { type: String, trim: true, maxlength: 40, default: "" },
    transmission: { type: String, enum: ["manual", "automatic", ""], default: "" },
    fuelType: { type: String, enum: ["petrol", "diesel", "hybrid", "electric", ""], default: "" },
    bodyType: { type: String, trim: true, maxlength: 40, default: "" },

    // Current owner, plus everyone who has owned it before. A vehicle can change hands; the history stays with
    // the vehicle, so a used car's buyer sees what was done to it and a workshop's demo is not a lie.
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    // A snapshot of the owner's name, taken when vehicleService#prepare loads the customer - declared here on
    // purpose (D15): the service always computed and tried to save it, but Mongoose strict mode silently
    // dropped it with nowhere to go, so the vehicle screen's "Owner" always read "-". Fixed where found by
    // the same miss as D01's job-card lines.
    customerName: { type: String, trim: true, maxlength: 150 },
    ownerHistory: { type: [ownerHistorySchema], default: [] },

    odometer: { type: Number, min: 0, default: 0 }, // the LATEST reading we have seen
    odometerAt: Date, // when that reading was taken

    registrationExpiry: Date,

    // Insurance, kept here because it is asked at every check-in, not inside a claim (a claim is one incident).
    insurerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" }, // the insurer, which is a Customer (isInsurer: true)
    policyNo: { type: String, trim: true, maxlength: 60, default: "" },
    policyExpiry: Date,

    // The owner's own schedule for this car, else the organisation's default (services/garage settings) applies.
    serviceInterval: {
      km: { type: Number, min: 0, default: 0 },
      months: { type: Number, min: 0, default: 0 },
    },
    lastServiceDay: { type: String, trim: true, maxlength: 10, default: "" }, // "YYYY-MM-DD", the org's calendar day
    lastServiceOdometer: { type: Number, min: 0, default: 0 },

    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
  },
  { timestamps: true }
);

// Unique only while the field is a real string: a vehicle may be entered with a chassis and no plate yet, or
// (an old car, pre-1981) a plate and no chassis - either partial index would otherwise collide on every blank.
// `$ne` is refused inside a partialFilterExpression (MongoDB allows only a small operator set there), so a
// blank value is never WRITTEN at all (vehicleService.js leaves the field undefined, not ""), and `$type`
// alone is then exactly the leadModel.js leadNo pattern: unset is the only way to be outside the index.
vehicleSchema.index({ plateKey: 1 }, { unique: true, partialFilterExpression: { plateKey: { $type: "string" } } });
vehicleSchema.index({ chassisKey: 1 }, { unique: true, partialFilterExpression: { chassisKey: { $type: "string" } } });
vehicleSchema.index({ customerId: 1 });
vehicleSchema.index({ make: 1, model: 1 });
vehicleSchema.index({ registrationExpiry: 1 });

// Organisation-wide: no branchScoped. Declared indexes only, so leadIndexes puts companyId in front of each.
vehicleSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.Vehicle || mongoose.model("Vehicle", vehicleSchema);
