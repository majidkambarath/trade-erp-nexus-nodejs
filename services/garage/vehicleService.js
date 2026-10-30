const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Vehicle = require("../../models/modules/garage/vehicleModel");
const Customer = require("../../models/modules/customerModel");
const rules = require("../../utils/garage");

// The vehicle master (utils/garage.js has the pure validation and the plate/chassis lookup keys). Organisation
// wide, like Customer/Vendor: a vehicle's service history is the whole reason a workshop buys this, and that
// history must survive a change of owner. Service: this file. Model: models/modules/garage/vehicleModel.js.

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.isValidObjectId(v);

class VehicleService {
  // ---- finding one ----------------------------------------------------------------------------------------

  static async findByPlateOrChassis({ plateNumber, chassisNo } = {}) {
    const plateKey = rules.plateKey(plateNumber);
    const chassisKey = rules.chassisKey(chassisNo);
    if (!plateKey && !chassisKey) return null;
    const or = [];
    if (plateKey) or.push({ plateKey });
    if (chassisKey) or.push({ chassisKey });
    return Vehicle.findOne({ $or: or }).lean();
  }

  static async getById(id) {
    if (!isId(id)) throw fail("That vehicle does not exist", 404, "VEHICLE_NOT_FOUND");
    const v = await Vehicle.findById(id).lean();
    if (!v) throw fail("That vehicle does not exist", 404, "VEHICLE_NOT_FOUND");
    return v;
  }

  // ---- preparing a write ------------------------------------------------------------------------------------

  static async #prepare(data, { existing } = {}) {
    const errors = rules.validateVehicle(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const plateKey = rules.plateKey(data.plateNumber);
    const chassisKey = rules.chassisKey(data.chassisNo);

    // A duplicate plate or chassis is caught here with a message naming the vehicle it already belongs to -
    // the database's own unique index is the backstop, not the first thing a person sees.
    if (plateKey) {
      const dupe = await Vehicle.findOne({ plateKey, ...(existing ? { _id: { $ne: existing._id } } : {}) }).select("plateNumber").lean();
      if (dupe) throw fail(`${dupe.plateNumber} is already registered`, 409, "PLATE_ALREADY_USED");
    }
    if (chassisKey) {
      const dupe = await Vehicle.findOne({ chassisKey, ...(existing ? { _id: { $ne: existing._id } } : {}) }).select("chassisNo").lean();
      if (dupe) throw fail(`That chassis number is already registered (${dupe.chassisNo})`, 409, "CHASSIS_ALREADY_USED");
    }

    let customerName;
    if (data.customerId) {
      if (!isId(data.customerId)) throw fail("Choose the owner", 400, "CUSTOMER_NOT_FOUND");
      const customer = await Customer.findById(data.customerId).select("customerName").lean();
      if (!customer) throw fail("That customer does not exist", 404, "CUSTOMER_NOT_FOUND");
      customerName = customer.customerName;
    }

    return {
      plateNumber: String(data.plateNumber ?? existing?.plateNumber ?? "").trim(),
      // Never written as "": the partial unique index only excludes a field that is UNSET, not merely blank
      // (MongoDB refuses $ne inside a partialFilterExpression, so $type: "string" alone is what works).
      plateKey: plateKey || undefined,
      plateCode: rules.text(data.plateCode, 10),
      plateEmirate: rules.text(data.plateEmirate, 20),
      chassisNo: String(data.chassisNo ?? existing?.chassisNo ?? "").trim(),
      chassisKey: chassisKey || undefined,
      engineNo: rules.text(data.engineNo, 30),
      make: rules.text(data.make, 60),
      model: rules.text(data.model, 60),
      variant: rules.text(data.variant, 60),
      year: data.year === "" || data.year == null ? undefined : Number(data.year),
      colour: rules.text(data.colour, 40),
      transmission: data.transmission || "",
      fuelType: data.fuelType || "",
      bodyType: rules.text(data.bodyType, 40),
      customerId: data.customerId || undefined,
      ...(customerName ? { customerName } : {}),
      odometer: data.odometer === "" || data.odometer == null ? undefined : Number(data.odometer),
      registrationExpiry: data.registrationExpiry || undefined,
      insurerId: data.insurerId || undefined,
      policyNo: rules.text(data.policyNo, 60),
      policyExpiry: data.policyExpiry || undefined,
      notes: rules.text(data.notes, 1000),
    };
  }

  // ---- writing ----------------------------------------------------------------------------------------------

  static async create(data, createdBy) {
    const prepared = await this.#prepare(data);
    const now = new Date();
    const v = await Vehicle.create({
      ...prepared,
      odometerAt: prepared.odometer != null ? now : undefined,
      ownerHistory: prepared.customerId ? [{ customerId: prepared.customerId, customerName: prepared.customerName, from: now }] : [],
      createdBy,
      updatedBy: createdBy,
    });
    return v.toObject();
  }

  static async update(id, data, updatedBy) {
    const existing = await Vehicle.findById(id);
    if (!existing) throw fail("That vehicle does not exist", 404, "VEHICLE_NOT_FOUND");
    const prepared = await this.#prepare(data, { existing });

    // A change of owner closes the old entry and opens a new one - the history that sells the next job.
    const changingOwner = prepared.customerId && String(prepared.customerId) !== String(existing.customerId || "");
    if (changingOwner) {
      const now = new Date();
      const history = (existing.ownerHistory || []).map((h) => (h.to ? h : { ...h.toObject?.() ?? h, to: now }));
      history.push({ customerId: prepared.customerId, customerName: prepared.customerName, from: now });
      prepared.ownerHistory = history;
    }

    if (prepared.odometer != null && prepared.odometer !== existing.odometer) prepared.odometerAt = new Date();

    Object.assign(existing, prepared, { updatedBy });
    await existing.save();
    return existing.toObject();
  }

  // ---- listing ----------------------------------------------------------------------------------------------

  static async list(query = {}) {
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.customerId && isId(query.customerId)) filter.customerId = query.customerId;
    const search = String(query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      // customerName was not searchable before D15 declared it on the schema (it existed nowhere to search).
      filter.$or = [{ plateNumber: rx }, { chassisNo: rx }, { make: rx }, { model: rx }, { customerName: rx }];
    }
    return Vehicle.find(filter).sort({ updatedAt: -1 }).limit(300).lean();
  }

  // Every make and model this organisation has already entered, for the vehicle form's own suggestions (free
  // text stays free text - plan 1.4 "Not built yet"; this only stops "Toyota" and "toyota" drifting apart on
  // the same workshop's books). Capped small; a form's datalist, not a full catalogue.
  static async catalogue() {
    const makes = await Vehicle.distinct("make");
    const rows = await Vehicle.aggregate([{ $group: { _id: { make: "$make", model: "$model" } } }]);
    const modelsByMake = {};
    for (const r of rows) {
      if (!r._id.make || !r._id.model) continue;
      (modelsByMake[r._id.make] ||= []).push(r._id.model);
    }
    return { makes: makes.filter(Boolean).sort(), modelsByMake };
  }

  // What the vehicle's own screen shows above its history: who owns it now, when it is next due, and any open
  // comeback candidate. `JobCardService` supplies the job history itself (it owns that collection).
  static async withSchedule(id, { lastServiceDay, lastServiceOdometer, addMonths } = {}) {
    const v = await this.getById(id);
    const due = rules.serviceDue(v, {
      intervalKm: v.serviceInterval?.km,
      intervalMonths: v.serviceInterval?.months,
      lastServiceDay: lastServiceDay ?? v.lastServiceDay,
      lastServiceOdometer: lastServiceOdometer ?? v.lastServiceOdometer,
      addMonths,
    });
    return { ...v, serviceDue: due };
  }
}

module.exports = VehicleService;
