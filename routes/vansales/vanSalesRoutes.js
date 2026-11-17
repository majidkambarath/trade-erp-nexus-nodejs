const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const c = require("../../controllers/vansales/vanSalesController");

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
router.post("/trips/:tripId/collect", requirePermission("vansales.sell"), c.collect);
router.post("/trips/:tripId/return", requirePermission("vansales.sell"), c.returnGoods);
router.post("/trips/:tripId/unload", requirePermission(["vansales.load", "vansales.sell"]), c.unload);
router.get("/trips/:tripId/settlement", requirePermission("vansales.settle"), c.settlementPreview);
router.post("/trips/:tripId/settle", requirePermission("vansales.settle"), c.settle);

module.exports = router;
