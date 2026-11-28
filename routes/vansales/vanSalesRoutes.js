const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const c = require("../../controllers/vansales/vanSalesController");
const { requireFeature } = require("../../middleware/featureGate");
const { rateLimit } = require("../../middleware/rateLimit");
const { getTenant } = require("../../utils/tenant");

// the same courtesy limit the messaging routes keep, in a bucket of its own
const sendLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, key: (req) => getTenant(req).companyId, code: "SEND_LIMIT_REACHED", message: "A lot of documents have been sent in the last hour. Try again in a little while." });

// The van sales module, mounted at /api/v1/van-sales. Every route is gated on a vansales.* permission: van sales is an
// opt-in MODULE (utils/plans.js OPT_IN_MODULES), sold per organisation like garage, so the plan ceiling answers
// MODULE_NOT_IN_PLAN before a role is even considered. The salesman's own actions (sell, collect, return, count the
// van back in) are further limited to the trip they are given, in the controller (assertMayWork).
const router = express.Router();
router.use(authenticateToken);
// only trips are branch documents; vans and routes are organisation-wide masters, so they use other param names
router.param("tripId", branchOfDocument(VanTrip));

// Masters and the module's own narrow pick lists.
// the vans and expense types an office expense voucher may name: whoever enters expenses reads them, with or without a van permission
router.get("/vans/choices", requirePermission(["vansales.view", "vansales.manage", "finance.view", "finance.create"]), c.vanChoices);
router.get("/vans", requirePermission("vansales.view"), c.listVans);
router.get("/vans/:vanId", requirePermission("vansales.view"), c.getVan);
router.post("/vans", requirePermission("vansales.manage"), c.createVan);
router.put("/vans/:vanId", requirePermission("vansales.manage"), c.updateVan);
router.get("/routes", requirePermission("vansales.view"), c.listRoutes);
router.get("/routes/:routeId", requirePermission("vansales.view"), c.getRoute);
router.post("/routes", requirePermission("vansales.manage"), c.createRoute);
router.put("/routes/:routeId", requirePermission("vansales.manage"), c.updateRoute);
router.get("/assignees", requirePermission("vansales.view"), c.assignees);
router.get("/price-lists", requirePermission("vansales.view"), c.listPriceLists);
router.get("/price-lists/:listId", requirePermission("vansales.view"), c.getPriceList);
router.post("/price-lists", requirePermission("vansales.manage"), c.createPriceList);
router.put("/price-lists/:listId", requirePermission("vansales.manage"), c.updatePriceList);
router.get("/promotions", requirePermission(["vansales.view", "vansales.sell"]), c.listPromotions);
router.get("/promotions/:promotionId", requirePermission("vansales.view"), c.getPromotion);
router.post("/promotions", requirePermission("vansales.manage"), c.createPromotion);
router.put("/promotions/:promotionId", requirePermission("vansales.manage"), c.updatePromotion);
router.get("/routes/:routeId/preorders", requirePermission("vansales.view"), c.routePreorders);
router.get("/customers", requirePermission("vansales.view"), c.customers);
router.get("/payment-choices", requirePermission(["vansales.view", "vansales.sell"]), c.paymentChoices);
// the machines a van can be given a card on: a manager sets one on the van, so it is a manager's read
router.get("/card-machines", requirePermission("vansales.manage"), c.cardMachines);

// The organisation's rules for its vans: everyone who works the vans reads them (the phone obeys them), a manager changes them.
router.get("/settings", requirePermission(["vansales.view", "vansales.sell", "vansales.manage"]), c.getSettings);
router.put("/settings", requirePermission("vansales.manage"), c.saveSettings);

// Reports: fixed paths before the :tripId ones, as every router here orders them.
router.get("/reports/summary", requirePermission("vansales.view"), c.summary);
router.get("/reports/route-profit", requirePermission("vansales.view"), c.routeProfit);
router.get("/analysis/choices", requirePermission("vansales.view"), c.analysisChoices);
for (const report of ["vans", "expenses", "returns", "trend", "items", "load", "collections", "coverage"]) {
  router.get(`/analysis/${report}`, requirePermission("vansales.view"), c.analysis(report));
}
// the supervisor's live board: who may settle or manage the vans
router.get("/board", requirePermission(["vansales.settle", "vansales.manage"]), c.board);

// Selling lookups (a salesman holds sell, not necessarily anything else).
router.get("/customers/:customerId/position", requirePermission("vansales.sell"), c.customerPosition);
// returnable containers: the types (read by whoever sells, changed by a manager), what a customer holds, a supervisor's correction
router.get("/container-types", requirePermission(["vansales.view", "vansales.sell"]), c.listContainerTypes);
router.post("/container-types", requirePermission("vansales.manage"), c.createContainerType);
router.put("/container-types/:typeId", requirePermission("vansales.manage"), c.updateContainerType);
router.get("/customers/:customerId/containers", requirePermission(["vansales.view", "vansales.sell"]), c.customerContainers);
router.post("/container-moves/adjust", requirePermission("vansales.manage"), c.adjustContainers);
router.get("/invoices/:invoiceId/returnable", requirePermission("vansales.sell"), c.returnable);

// Trips.
router.get("/load-requests", requirePermission("vansales.load"), c.listLoadRequests);
router.get("/load-requests/counts", requirePermission(["vansales.load", "vansales.sell"]), c.loadRequestCounts);
router.get("/trips", requirePermission("vansales.view"), c.listTrips);
router.get("/trips/mine", requirePermission("vansales.view"), c.mine);
// a salesman may open his own van's trip where loads go through a request (the controller checks which van and the rule)
router.post("/trips", requirePermission(["vansales.load", "vansales.sell"]), c.openTrip);
router.get("/trips/:tripId", requirePermission("vansales.view"), c.getTrip);
router.get("/trips/:tripId/activity", requirePermission("vansales.view"), c.activity);
router.post("/trips/:tripId/load", requirePermission("vansales.load"), c.load);
router.post("/trips/:tripId/depart", requirePermission("vansales.load"), c.depart);
router.get("/trips/:tripId/suggested-load", requirePermission(["vansales.load", "vansales.sell"]), c.suggestedLoad);
// load requests: the salesman asks and accepts (his own trip: the controller checks), the storekeeper loads or refuses
router.post("/trips/:tripId/load-requests", requirePermission("vansales.sell"), c.requestLoad);
router.post("/trips/:tripId/load-requests/:no/cancel", requirePermission("vansales.sell"), c.cancelLoadRequest);
router.post("/trips/:tripId/load-requests/:no/accept", requirePermission("vansales.sell"), c.acceptLoad);
router.post("/trips/:tripId/load-requests/:no/load", requirePermission("vansales.load"), c.loadFromRequest);
router.post("/trips/:tripId/load-requests/:no/reject", requirePermission("vansales.load"), c.rejectLoadRequest);
router.post("/trips/:tripId/load-check", requirePermission("vansales.load"), c.loadCheck);
router.get("/trips/:tripId/preorders", requirePermission("vansales.view"), c.tripPreorders);
router.post("/trips/:tripId/preorders", requirePermission("vansales.sell"), c.createPreorder);
router.post("/trips/:tripId/cancel", requirePermission("vansales.load"), c.cancel);
router.post("/trips/:tripId/sell", requirePermission("vansales.sell"), c.sell);
router.post("/trips/:tripId/containers", requirePermission("vansales.sell"), c.empties);
router.get("/trips/:tripId/prices", requirePermission("vansales.sell"), c.prices);
router.get("/trips/:tripId/customers/:customerId/insight", requirePermission("vansales.sell"), c.insight);
router.get("/trips/:tripId/visits", requirePermission("vansales.view"), c.visits);
router.post("/trips/:tripId/visits", requirePermission("vansales.sell"), c.recordVisit);
router.post("/trips/:tripId/transfer", requirePermission("vansales.load"), c.transfer);
// the shops to pick from on the trip: the van's own with no search, any matching customer with one
router.get("/trips/:tripId/shops", requirePermission("vansales.sell"), c.shops);
router.get("/trips/:tripId/offline", requirePermission("vansales.sell"), c.offlinePack);
router.post("/trips/:tripId/sync", requirePermission("vansales.sell"), c.sync);
// the trip's invoices and the slip of each, to print it again (the salesman's own trip: the controller checks)
router.get("/trips/:tripId/invoices", requirePermission("vansales.sell"), c.tripInvoices);
router.get("/trips/:tripId/invoices/:invoiceId/slip", requirePermission("vansales.sell"), c.invoiceSlip);
router.get("/trips/:tripId/returns/:returnId/slip", requirePermission("vansales.sell"), c.returnSlip);
// goods taken back item by item, the invoices found for the salesman
router.get("/trips/:tripId/customers/:customerId/returnable-items", requirePermission("vansales.sell"), c.returnableItems);
router.post("/trips/:tripId/return-plan", requirePermission("vansales.sell"), c.returnPlan);
router.post("/trips/:tripId/return-items", requirePermission("vansales.sell"), c.returnItems);
router.post("/trips/:tripId/invoices/:invoiceId/whatsapp", requirePermission("vansales.sell"), requireFeature("messaging"), sendLimit, c.whatsappInvoice);
router.post("/trips/:tripId/collect", requirePermission("vansales.sell"), c.collect);
router.get("/trips/:tripId/expenses", requirePermission("vansales.view"), c.tripExpenses);
router.post("/trips/:tripId/expenses", requirePermission("vansales.sell"), c.expense);
router.post("/trips/:tripId/customers/:customerId/location", requirePermission("vansales.sell"), c.pinCustomer);
router.post("/trips/:tripId/return", requirePermission("vansales.sell"), c.returnGoods);
router.post("/trips/:tripId/return-quote", requirePermission("vansales.sell"), c.returnQuote);
router.post("/trips/:tripId/unload", requirePermission(["vansales.load", "vansales.sell"]), c.unload);
// a second count before settling is the supervisor's, never the salesman's own
router.post("/trips/:tripId/recount", requirePermission(["vansales.settle", "vansales.manage"]), c.recount);
router.get("/trips/:tripId/settlement", requirePermission("vansales.settle"), c.settlementPreview);
router.post("/trips/:tripId/settle", requirePermission("vansales.settle"), c.settle);

module.exports = router;
