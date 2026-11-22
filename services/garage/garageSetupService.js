const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Bay = require("../../models/modules/garage/bayModel");
const GarageService = require("../../models/modules/garage/garageServiceModel");
const Stock = require("../../models/modules/stockModel");
const Category = require("../../models/modules/categoryModel");
const rules = require("../../utils/garage");
const { getTenant } = require("../../utils/tenant");

// Setup: bays (the physical plant, branch scoped) and the service menu (standard jobs, organisation-wide).
// Plain master CRUD - no transaction needed, nothing else is written alongside either row - plus `plan()`,
// the one piece of real logic: turning a chosen standard job into a draft job-card payload (see
// utils/garage.js planFromService for why this creates nothing, same as processRouteService.plan).

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const isId = (v) => mongoose.isValidObjectId(v);

class GarageSetupService {
  // ---- bays -----------------------------------------------------------------------------------------------
  static async listBays(query = {}) {
    const filter = String(query.status || "") === "all" ? {} : { active: true };
    return Bay.find(filter).sort({ name: 1 }).lean();
  }

  static async createBay(data, createdBy) {
    const errors = rules.validateBay(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const { companyId, branchId } = getTenant();
    return Bay.create({ name: rules.text(data.name, 60), code: rules.text(data.code, 20), kind: data.kind || "mechanical", notes: rules.text(data.notes, 300), companyId, branchId, createdBy, updatedBy: createdBy });
  }

  static async updateBay(id, data, updatedBy) {
    if (!isId(id)) throw fail("That bay does not exist", 404, "BAY_NOT_FOUND");
    const errors = rules.validateBay(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const bay = await Bay.findById(id);
    if (!bay) throw fail("That bay does not exist", 404, "BAY_NOT_FOUND");
    bay.name = rules.text(data.name, 60);
    bay.code = rules.text(data.code, 20);
    bay.kind = data.kind || "mechanical";
    bay.notes = rules.text(data.notes, 300);
    if (typeof data.active === "boolean") bay.active = data.active;
    bay.updatedBy = updatedBy;
    await bay.save();
    return bay;
  }

  // ---- the service menu -------------------------------------------------------------------------------------
  static async listServices(query = {}) {
    const filter = String(query.status || "") === "all" ? {} : { active: true };
    return GarageService.find(filter).sort({ name: 1 }).lean();
  }

  static async #checkItem(serviceItemId) {
    if (!isId(serviceItemId)) throw fail("Choose the service item this bills under", 400, "SERVICE_ITEM_REQUIRED");
    const item = await Stock.findById(serviceItemId).select("itemType itemName").lean();
    if (!item) throw fail("That item does not exist", 404, "SERVICE_ITEM_REQUIRED");
    if (item.itemType !== "service") throw fail(`"${item.itemName}" is a stocked item, not a service - choose a service item`, 400, "ITEM_NOT_A_SERVICE");
  }

  // The job-card form's quick add: no service item chosen, so make one of the job's own name. It takes the
  // category (and unit) of the newest service item, else the first category: a stock item must have one, and
  // guessing is better than stopping a person at the counter. Made through StockService.createStock, so it is
  // the same record the item form would make (SKU checked, service rules applied).
  static async #makeServiceItem(data, createdBy) {
    const StockService = require("../stock/stockService"); // lazily: stockService pulls in much of the app
    const like = await Stock.findOne({ itemType: "service" }).sort({ createdAt: -1 }).select("category unitOfMeasure").lean();
    const categoryId = like?.category || (await Category.findOne({}).sort({ createdAt: 1 }).select("_id").lean())?._id;
    if (!categoryId) throw fail("Add an item category in Inventory first: a new service item needs one", 400, "CATEGORY_REQUIRED");
    const base = `SVC-${rules.text(data.code, 20).toUpperCase().replace(/[^A-Z0-9-]/g, "")}` || "SVC";
    let sku = base;
    for (let n = 2; await Stock.exists({ sku }); n += 1) sku = `${base}-${n}`;
    return StockService.createStock({
      itemType: "service", itemName: rules.text(data.name, 120), sku, categoryId,
      unitOfMeasure: like?.unitOfMeasure || undefined, salesPrice: Number(data.price) || 0,
    }, createdBy);
  }

  static async createService(data, createdBy) {
    const makeItem = data.makeServiceItem === true && !isId(data.serviceItemId);
    const errors = rules.validateGarageService(data, { makeServiceItem: makeItem });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const code = rules.text(data.code, 20).toUpperCase();
    let madeItem = null;
    if (makeItem) {
      // the code is checked BEFORE the item is made, so a refused job never leaves a stray item behind
      if (await GarageService.exists({ code })) throw fail("A service with this code already exists", 409, "SERVICE_CODE_TAKEN");
      madeItem = await this.#makeServiceItem(data, createdBy);
      data = { ...data, serviceItemId: madeItem._id };
    } else {
      await this.#checkItem(data.serviceItemId);
    }
    const { companyId } = getTenant();
    try {
      const svc = await GarageService.create({
        code,
        name: rules.text(data.name, 120),
        category: rules.text(data.category, 60),
        serviceItemId: data.serviceItemId,
        standardHours: Number(data.standardHours) || 0,
        defaultParts: (data.defaultParts || []).filter((p) => isId(p?.stockId)).map((p) => ({ stockId: p.stockId, qty: Number(p.qty) || 1 })),
        defaultTasks: (data.defaultTasks || []).filter((t) => rules.text(t?.name, 80)).map((t) => ({ name: rules.text(t.name, 80), mode: t.mode === "sublet" ? "sublet" : "in_house", standardHours: Number(t.standardHours) || 0 })),
        appliesTo: { makes: Array.isArray(data.appliesTo?.makes) ? data.appliesTo.makes.map((s) => rules.text(s, 60)).filter(Boolean) : [], models: Array.isArray(data.appliesTo?.models) ? data.appliesTo.models.map((s) => rules.text(s, 60)).filter(Boolean) : [] },
        companyId, createdBy, updatedBy: createdBy,
      });
      if (madeItem) svc.$locals.madeServiceItem = { id: madeItem._id, name: madeItem.itemName };
      return svc;
    } catch (err) {
      if (madeItem) await Stock.deleteOne({ _id: madeItem._id }).catch(() => {}); // nothing else can use it yet
      if (err?.code === 11000) throw fail("A service with this code already exists", 409, "SERVICE_CODE_TAKEN");
      throw err;
    }
  }

  static async updateService(id, data, updatedBy) {
    if (!isId(id)) throw fail("That service does not exist", 404, "SERVICE_NOT_FOUND");
    const errors = rules.validateGarageService(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    await this.#checkItem(data.serviceItemId);
    const svc = await GarageService.findById(id);
    if (!svc) throw fail("That service does not exist", 404, "SERVICE_NOT_FOUND");
    svc.name = rules.text(data.name, 120);
    svc.category = rules.text(data.category, 60);
    svc.serviceItemId = data.serviceItemId;
    svc.standardHours = Number(data.standardHours) || 0;
    svc.defaultParts = (data.defaultParts || []).filter((p) => isId(p?.stockId)).map((p) => ({ stockId: p.stockId, qty: Number(p.qty) || 1 }));
    svc.defaultTasks = (data.defaultTasks || []).filter((t) => rules.text(t?.name, 80)).map((t) => ({ name: rules.text(t.name, 80), mode: t.mode === "sublet" ? "sublet" : "in_house", standardHours: Number(t.standardHours) || 0 }));
    svc.appliesTo = { makes: Array.isArray(data.appliesTo?.makes) ? data.appliesTo.makes.map((s) => rules.text(s, 60)).filter(Boolean) : [], models: Array.isArray(data.appliesTo?.models) ? data.appliesTo.models.map((s) => rules.text(s, 60)).filter(Boolean) : [] };
    if (typeof data.active === "boolean") svc.active = data.active;
    svc.updatedBy = updatedBy;
    await svc.save();
    return svc;
  }

  // A standard job, turned into a draft job-card payload (lines + tasks) for the new-job-card form to accept
  // onto its own state - nothing is created or saved here, same as processRouteService.plan. Real prices come
  // from the chosen service item and its default parts' own `salesPrice`, which the job card still re-prices
  // for real (TransactionService.buildPricing) the moment it is actually saved.
  static async plan({ serviceId } = {}) {
    if (!isId(serviceId)) throw fail("Choose a standard job", 400, "SERVICE_REQUIRED");
    const svc = await GarageService.findById(serviceId).lean();
    if (!svc) throw fail("That service does not exist", 404, "SERVICE_NOT_FOUND");
    const stockIds = [svc.serviceItemId, ...(svc.defaultParts || []).map((p) => p.stockId)].filter(isId);
    const items = await Stock.find({ _id: { $in: stockIds } }).select("itemName sku salesPrice").lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));
    const plan = rules.planFromService(svc, { partsById: byId });
    return {
      service: { id: String(svc._id), code: svc.code, name: svc.name },
      lines: plan.lines.map((l) => ({ ...l, description: byId.get(l.itemId)?.itemName || "", price: l.price != null ? l.price : byId.get(l.itemId)?.salesPrice || 0 })),
      tasks: plan.tasks,
      standardHours: plan.standardHours,
    };
  }
}

module.exports = GarageSetupService;
