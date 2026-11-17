// Van sales demo for an existing organisation (default: the ABC TRADE books, code "abc").
//
//   node scripts/demo/vanSalesDemo.js [--code=abc] [--email=admin@abc.com]
//
// Switches the opt-in van sales module on for the organisation, then, through the module's own services (so every rule
// applies: free depot stock, pricing, credit control, the approval that moves stock and posts), makes one van with its
// cash account, one route of five customers, a trip loaded and out on the road, and FIVE sales on it: three paid in
// cash at the door, two on credit. The trip is left ON_ROUTE so My van, the Board and Settlement have something to show.
// Re-running it reuses the van and route and opens no second trip while one is still open.
require("dotenv").config();
const mongoose = require("mongoose");
const { runWithTenant } = require("../../utils/tenantContext");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const CODE = arg("code", "abc");
const EMAIL = arg("email", "admin@abc.com");
const BY = "van-sales-demo";

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const Organisation = require("../../models/core/organisationModel");
  const OrganisationService = require("../../services/core/organisationService");
  const orgLocale = require("../../utils/orgLocale");

  const org = await Organisation.findOne({ code: CODE }).lean();
  if (!org) throw new Error(`No organisation "${CODE}"`);
  await OrganisationService.update(CODE, { moduleOverrides: { vansales: true } });
  console.log(`Van sales switched on for ${CODE} (${org.legalName || org.tradeName || ""})`);
  orgLocale.warm({ ...org, code: CODE });

  await runWithTenant({ companyId: CODE, branchId: "main", branchView: null }, async () => {
    const Admin = require("../../models/core/adminModel");
    const Customer = require("../../models/modules/customerModel");
    const Stock = require("../../models/modules/stockModel");
    const Van = require("../../models/modules/vansales/vanModel");
    const VanRoute = require("../../models/modules/vansales/vanRouteModel");
    const VanTrip = require("../../models/modules/vansales/vanTripModel");
    const VanService = require("../../services/vansales/vanService");
    const TripService = require("../../services/vansales/vanTripService");
    const Sales = require("../../services/vansales/vanTripSales");

    const salesman = await Admin.findOne({ email: EMAIL }).lean();
    if (!salesman) throw new Error(`No account ${EMAIL} in ${CODE}`);
    const by = String(salesman._id);

    const customers = await Customer.find({ status: { $ne: "inactive" } }).sort({ createdAt: 1 }).limit(5).lean();
    if (customers.length < 5) throw new Error("Need five customers");
    const goods = (await Stock.find({ itemType: { $ne: "service" }, currentStock: { $gt: 60 }, salesPrice: { $gt: 0 } }).sort({ currentStock: -1 }).limit(5).lean());
    if (goods.length < 3) throw new Error("Need at least three stocked items with a sales price");

    let route = await VanRoute.findOne({ name: "Deira Morning Route" }).lean();
    if (!route) {
      route = await VanService.createRoute({ name: "Deira Morning Route", days: [0, 1, 2, 3, 4, 5, 6], customers: customers.map((c) => ({ customerId: String(c._id) })) }, BY);
      console.log(`Route made: ${route.name}`);
    }
    const routeId = String(route._id || route.id);

    let van = await Van.findOne({ code: "VAN-01" }).lean();
    if (!van) {
      van = await VanService.create({ code: "VAN-01", name: "Toyota Hiace - Deira", salesmanId: by, defaultRouteId: routeId, cashLimit: 20000 }, BY);
      console.log(`Van made: VAN-01 with its cash account`);
    }
    const vanId = String(van._id || van.id);

    let trip = await VanTrip.findOne({ vanId, status: { $in: ["LOADING", "ON_ROUTE"] } }).lean();
    if (trip && trip.status === "ON_ROUTE") {
      console.log(`Trip ${trip.tripNo} is already out on the road; nothing more made.`);
      return;
    }
    if (!trip) trip = await TripService.open({ vanId }, BY);
    const tripId = String(trip._id || trip.id);

    const loadQty = (s) => Math.min(40, Math.floor(Number(s.currentStock) / 3));
    await TripService.load(tripId, { lines: goods.map((s) => ({ stockId: String(s._id), qty: loadQty(s) })) }, BY);
    await TripService.depart(tripId, BY, { odometer: 48210 });
    const opened = await TripService.getById(tripId);
    console.log(`Trip ${opened.tripNo} loaded with ${goods.length} items and out on the road`);

    const plan = [
      { c: 0, lines: [[0, 6], [1, 4]], cash: true },
      { c: 1, lines: [[1, 5], [2, 3]], cash: false },
      { c: 2, lines: [[0, 3], [2, 4]], cash: true },
      { c: 3, lines: [[goods.length > 3 ? 3 : 0, 5]], cash: false },
      { c: 4, lines: [[goods.length > 4 ? 4 : 1, 4], [0, 2]], cash: true },
    ];
    for (const p of plan) {
      const items = p.lines.map(([g, qty]) => ({ itemId: String(goods[g]._id), qty }));
      try {
        const { invoice } = await Sales.sell(tripId, {
          customerId: String(customers[p.c]._id), items, acknowledged: true,
          ...(p.cash ? { payNow: { mode: "cash", full: true } } : {}),
        }, by);
        console.log(`  ${invoice.transactionNo}  ${customers[p.c].customerName}  ${invoice.totalAmount}  ${p.cash ? "paid in cash" : "on credit"}`);
      } catch (e) {
        console.log(`  REFUSED for ${customers[p.c].customerName}: ${e.code || ""} ${e.message}`);
      }
    }
    const t = (await TripService.getById(tripId)).totals || {};
    console.log(`Sold ${t.sales}, cash in hand ${t.cashInHand ?? t.cash}`);
  });
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
