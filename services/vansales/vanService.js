const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Van = require("../../models/modules/vansales/vanModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const Customer = require("../../models/modules/customerModel");
const Admin = require("../../models/core/adminModel");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const vanSettings = require("../../utils/vanSettings");
const { groupFamily, CardService } = require("../banking/cardService");
const UsageService = require("../core/usageService");
const ChartOfAccountsService = require("../financial/chartOfAccountsService");
const { addressOf } = require("../../utils/vanSlip");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const wrap = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof rules.VanError) throw fail(err.message, 400, err.code, err.details);
    throw err;
  }
};

// Vans and routes: the two masters of the van sales module (the trip itself is vanTripService). Both are
// organisation-wide, like a customer or a vehicle.
class VanService {
  // ---- vans ---------------------------------------------------------------------------------------------------

  static async list({ includeInactive = false, onlySalesman = null } = {}) {
    const q = includeInactive ? {} : { active: true };
    if (onlySalesman) q.salesmanId = String(onlySalesman); // a salesman's list holds the van he drives
    const vans = await Van.find(q).sort({ code: 1 }).lean();
    // who is out right now: a van with a trip that is still holding stock
    const open = await VanTrip.find({ vanId: { $in: vans.map((v) => v._id) }, status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] } })
      .select("vanId tripNo status date").lean();
    const byVan = new Map(open.map((t) => [String(t.vanId), t]));
    return vans.map((v) => ({ ...v, id: String(v._id), openTrip: byVan.get(String(v._id)) || null }));
  }

  static async get(id) {
    if (!isId(id)) throw fail("That van does not exist", 404, "VAN_NOT_FOUND");
    const van = await Van.findById(id).lean();
    if (!van) throw fail("That van does not exist", 404, "VAN_NOT_FOUND");
    return { ...van, id: String(van._id) };
  }

  static async #salesman(salesmanId) {
    if (!salesmanId) return { salesmanId: "", salesmanName: "" };
    if (!isId(salesmanId)) throw fail("Choose a salesman from the list", 400, "SALESMAN_INVALID");
    const a = await Admin.findOne({ _id: salesmanId, isActive: true, status: "active" }).select("name email").lean();
    if (!a) throw fail("That person is not an active user", 400, "SALESMAN_INVALID");
    return { salesmanId: String(a._id), salesmanName: a.name || a.email };
  }

  static async #route(routeId) {
    if (!routeId) return null;
    if (!isId(routeId) || !(await VanRoute.exists({ _id: routeId }))) throw fail("That route does not exist", 400, "ROUTE_NOT_FOUND");
    return routeId;
  }

  /** The van's own rule overrides, checked: an object of only the keys it sets, or null when it follows the organisation. */
  static #ownRules(input) {
    const { errors, rules: own } = vanSettings.cleanVanRules(input);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    return Object.keys(own).length ? own : null;
  }

  /** The van's card machine: an active merchant terminal, and only where the plan has banking. null clears it. */
  static async #card(cardId, req) {
    if (cardId === null || cardId === "" || cardId === undefined) return null;
    if (!isId(cardId)) throw fail("Choose a card machine from the list", 400, "CARD_REQUIRED");
    await UsageService.assertFeature("banking");
    const card = await CardService.forUse(cardId, "receipt", { req }); // a terminal, and active: it refuses anything else
    return card._id;
  }

  static async create(input, createdBy, req) {
    const base = wrap(() => rules.validateVan(input));
    if (await Van.exists({ code: base.code })) throw fail(`A van with the code ${base.code} already exists`, 409, "VAN_CODE_TAKEN");
    const sales = await this.#salesman(input.salesmanId);
    const defaultRouteId = await this.#route(input.defaultRouteId);
    const own = this.#ownRules(input.rules);
    const cardId = await this.#card(input.cardId, req);
    // The van's own cash account, under the Cash group. What the van took is this account's balance, so settling
    // is a plain transfer of it. A chart account made through the ordinary service: it appears in the chart.
    const { rootId } = await groupFamily("cash-account-group", req);
    const account = await ChartOfAccountsService.createAccount({ accountName: `Van Cash - ${base.code}`, groupId: rootId }, req, createdBy);
    const van = await Van.create({ ...base, ...sales, defaultRouteId, cashAccountId: account._id, createdBy, cardId, ...(own ? { rules: own } : {}) });
    return this.get(van._id);
  }

  static async update(id, input, updatedBy) {
    const van = await Van.findById(id);
    if (!van) throw fail("That van does not exist", 404, "VAN_NOT_FOUND");
    // the code names the van's cash account and every trip; it does not change after the van exists
    const base = wrap(() => rules.validateVan({ ...input, code: van.code }));
    const sales = input.salesmanId !== undefined ? await this.#salesman(input.salesmanId) : {};
    const defaultRouteId = input.defaultRouteId !== undefined ? await this.#route(input.defaultRouteId) : van.defaultRouteId;
    van.set({ name: base.name, plate: base.plate, ...sales, defaultRouteId, updatedBy, ...(input.cashLimit !== undefined ? { cashLimit: base.cashLimit } : {}), ...(input.offlineBlock !== undefined ? { offlineBlock: base.offlineBlock } : {}), ...("dailySalesTarget" in base ? { dailySalesTarget: base.dailySalesTarget } : {}), ...("dailyCallsTarget" in base ? { dailyCallsTarget: base.dailyCallsTarget } : {}) });
    // the van's own rules are sent whole: a key left out (or "org") goes back to following the organisation
    if (input.rules !== undefined) van.rules = this.#ownRules(input.rules) || undefined;
    if (input.cardId !== undefined) van.cardId = await this.#card(input.cardId);
    if (typeof input.active === "boolean" && input.active !== van.active) {
      if (!input.active && (await VanTrip.exists({ vanId: van._id, status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] } }))) {
        throw fail("This van has a trip that is not settled yet", 409, "VAN_HAS_OPEN_TRIP");
      }
      van.active = input.active;
    }
    await van.save();
    return this.get(van._id);
  }

  // ---- routes -------------------------------------------------------------------------------------------------

  static async listRoutes({ includeInactive = false } = {}) {
    const rows = await VanRoute.find(includeInactive ? {} : { active: true }).sort({ name: 1 }).lean();
    return rows.map((r) => ({ ...r, id: String(r._id) }));
  }

  static async getRoute(id) {
    if (!isId(id)) throw fail("That route does not exist", 404, "ROUTE_NOT_FOUND");
    const r = await VanRoute.findById(id).lean();
    if (!r) throw fail("That route does not exist", 404, "ROUTE_NOT_FOUND");
    return { ...r, id: String(r._id) };
  }

  static async #checkedRoute(input) {
    const base = wrap(() => rules.validateRoute(input));
    const ids = base.customers.map((c) => c.customerId);
    if (ids.some((i) => !isId(i))) throw fail("A customer on the route is not valid", 400, "CUSTOMER_INVALID");
    const found = await Customer.find({ _id: { $in: ids } }).select("customerName").lean();
    const names = new Map(found.map((c) => [String(c._id), c.customerName]));
    if (base.priceListId) {
      const PriceList = require("../../models/modules/vansales/priceListModel");
      if (!isId(base.priceListId) || !(await PriceList.exists({ _id: base.priceListId }))) throw fail("That price list does not exist", 400, "PRICE_LIST_NOT_FOUND");
    }
    for (const c of base.customers) {
      if (!names.has(c.customerId)) throw fail("A customer on the route does not exist", 400, "CUSTOMER_NOT_FOUND");
      c.name = names.get(c.customerId); // the name as it is now, not as the form had it
    }
    return base;
  }

  static async createRoute(input, createdBy) {
    const base = await this.#checkedRoute(input);
    if (await VanRoute.exists({ name: base.name })) throw fail(`A route called ${base.name} already exists`, 409, "ROUTE_NAME_TAKEN");
    const r = await VanRoute.create({ ...base, createdBy });
    return this.getRoute(r._id);
  }

  static async updateRoute(id, input, updatedBy) {
    const r = await VanRoute.findById(id);
    if (!r) throw fail("That route does not exist", 404, "ROUTE_NOT_FOUND");
    const base = await this.#checkedRoute(input);
    if (await VanRoute.exists({ name: base.name, _id: { $ne: r._id } })) throw fail(`A route called ${base.name} already exists`, 409, "ROUTE_NAME_TAKEN");
    r.set({ ...base, updatedBy });
    if (typeof input.active === "boolean") r.active = input.active;
    await r.save();
    return this.getRoute(r._id);
  }

  // ---- narrow reads for the screens ---------------------------------------------------------------------------
  // A salesman may hold no sales or accounts permission at all, so these give the module its own small pick lists
  // (the same fix the CRM and the garage made): names and ids, nothing about balances or contacts.

  static async assignees() {
    const rows = await Admin.find({ isActive: true, status: "active" }).select("name email").sort({ name: 1 }).lean();
    return rows.map((a) => ({ id: String(a._id), name: a.name || a.email }));
  }

  static async customerChoices(query = {}) {
    const q = {};
    const search = String(query.search || "").trim().slice(0, 80);
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$or = [{ customerName: rx }, { customerId: rx }, { phone: rx }];
    }
    if (String(query.status || "") !== "all") q.status = { $ne: "Inactive" };
    const limit = Math.min(500, Math.max(1, Math.round(Number(query.limit)) || 200));
    const FIELDS = "customerName customerId phone status paymentTerms vanPaymentMode trnNumber trnNO vat.trn billingAddress city emirate";
    const rows = await Customer.find(q).select(FIELDS).sort({ customerName: 1, _id: 1 }).limit(limit).lean();
    // `ids` names customers who must be in the answer whatever the page holds: the shop being sold to is past the limit
    // in a long list, and without it the screen would not know their terms or usual way of paying
    const wanted = String(query.ids || "").split(",").map((x) => x.trim()).filter((x) => /^[a-f0-9]{24}$/i.test(x)).slice(0, 50);
    const missing = wanted.filter((id) => !rows.some((r) => String(r._id) === id));
    if (missing.length) rows.push(...(await Customer.find({ _id: { $in: missing }, ...(q.status ? { status: q.status } : {}) }).select(FIELDS).lean()));
    return rows.map((r) => ({
      id: String(r._id), name: r.customerName || "", code: r.customerId || "", phone: r.phone || "",
      terms: r.paymentTerms || "", active: r.status !== "Inactive", trn: r.vat?.trn || r.trnNumber || r.trnNO || "",
      address: addressOf(r), // printed on the slip: the street and the place, nothing else of the record
      payMode: r.vanPaymentMode || "", // how they usually pay: only pre-selects the van's sale screen
    }));
  }

  /**
   * The card machines a van can be given: the organisation's active merchant terminals, by name and fee only. The van
   * module's own narrow read (a van manager need not hold banking.view), and empty without the banking feature.
   */
  static async cardMachines(req) {
    const banking = !req?.organisation || require("../../utils/plans").hasFeature(req.organisation, "banking");
    if (!banking) return [];
    const cards = await CardService.list(req, { kind: "terminal", active: true });
    return cards.map((c) => ({ id: String(c._id), label: c.label, feePercent: c.effectiveFeePercent ?? 0 }));
  }

  /**
   * What a salesman may take money into on the road: cash always (the van's own account), and a cheque only where the
   * organisation has banking, with the bank accounts it can be deposited to. Names and ids only: no balances.
   */
  static async paymentChoices(req) {
    const banking = !req?.organisation || require("../../utils/plans").hasFeature(req.organisation, "banking");
    // a bank transfer needs no part of the plan (the office receipt path does not ask either), so the bank accounts are
    // always offered; a cheque and a card are the banking feature's, and the banks a cheque is drawn on come with them
    const { ids } = await groupFamily("bank-account-group", req);
    const rows = await LedgerAccount.find({ groupId: { $in: ids }, isActive: true, allowDirectPosting: { $ne: false } }).select("accountName accountCode").sort({ accountCode: 1 }).lean();
    const bankAccounts = rows.map((a) => ({ id: String(a._id), name: a.accountName }));
    if (!banking) return { cheque: false, card: false, bankAccounts, banks: [] };
    const { BankMaster } = require("../../models/modules/banking/bankingModels");
    const banks = await BankMaster.find({ isActive: true }).select("bankName").sort({ bankName: 1 }).lean();
    return { cheque: true, card: true, bankAccounts, banks: banks.map((b) => ({ id: String(b._id), name: b.bankName })) };
  }

  /** The van's cash account, for a caller that needs its current balance (the settlement preview). */
  static async cashBalance(van) {
    if (!van?.cashAccountId) return 0;
    const a = await LedgerAccount.findById(van.cashAccountId).select("currentBalance").lean();
    return Number(a?.currentBalance || 0);
  }
}

module.exports = VanService;
