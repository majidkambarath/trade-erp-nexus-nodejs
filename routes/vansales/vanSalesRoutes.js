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
router.get("/customers", requirePermission("vansales.view"), c.customers);
router.get("/payment-choices", requirePermission(["vansales.view", "vansales.sell"]), c.paymentChoices);

// Reports: fixed paths before the :tripId ones, as every router here orders them.
router.get("/reports/summary", requirePermission("vansales.view"), c.summary);

// Selling lookups (a salesman holds sell, not necessarily anything else).
router.get("/customers/:customerId/position", requirePermission("vansales.sell"), c.customerPosition);
router.get("/invoices/:invoiceId/returnable", requirePermission("vansales.sell"), c.returnable);

// Trips.
router.get("/trips", requirePermission("vansales.view"), c.listTrips);
router.get("/trips/mine", requirePermission("vansales.view"), c.mine);
router.post("/trips", requirePermission("vansales.load"), c.openTrip);
router.get("/trips/:tripId", requirePermission("vansales.view"), c.getTrip);
router.get("/trips/:tripId/activity", requirePermission("vansales.view"), c.activity);
router.post("/trips/:tripId/load", requirePermission("vansales.load"), c.load);
router.post("/trips/:tripId/depart", requirePermission("vansales.load"), c.depart);
router.post("/trips/:tripId/cancel", requirePermission("vansales.load"), c.cancel);
router.post("/trips/:tripId/sell", requirePermission("vansales.sell"), c.sell);
router.get("/trips/:tripId/prices", requirePermission("vansales.sell"), c.prices);
router.get("/trips/:tripId/visits", requirePermission("vansales.view"), c.visits);
router.post("/trips/:tripId/visits", requirePermission("vansales.sell"), c.recordVisit);
router.post("/trips/:tripId/transfer", requirePermission("vansales.load"), c.transfer);
router.post("/trips/:tripId/invoices/:invoiceId/whatsapp", requirePermission("vansales.sell"), requireFeature("messaging"), sendLimit, c.whatsappInvoice);
router.post("/trips/:tripId/collect", requirePermission("vansales.sell"), c.collect);
router.post("/trips/:tripId/return", requirePermission("vansales.sell"), c.returnGoods);
router.post("/trips/:tripId/unload", requirePermission(["vansales.load", "vansales.sell"]), c.unload);
router.get("/trips/:tripId/settlement", requirePermission("vansales.settle"), c.settlementPreview);
router.post("/trips/:tripId/settle", requirePermission("vansales.settle"), c.settle);

module.exports = router;
