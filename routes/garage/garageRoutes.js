const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const JobCard = require("../../models/modules/garage/jobCardModel");
const v = require("../../controllers/garage/vehicleController");
const j = require("../../controllers/garage/jobCardController");

// The garage module, mounted at /api/v1/garage: vehicles, job cards and their tasks. Every route is gated on a
// garage.* permission - garage is the first opt-in MODULE (utils/plans.js OPT_IN_MODULES), sold per organisation
// like the CRM, so the plan ceiling (middleware/permissionGate.js refusalFor) answers MODULE_NOT_IN_PLAN before
// a role is even considered. No requireFeature call is needed: a module is capped on req.admin.grants itself,
// inside authenticateToken, before any route runs.
const router = express.Router();
router.use(authenticateToken);
router.param("id", branchOfDocument(JobCard)); // a head office working across branches acts in the card's own branch

// Vehicles: an organisation-wide master, so no branchOfDocument on its own id.
router.get("/vehicles", requirePermission("garage.view"), v.list);
router.get("/vehicles/find", requirePermission("garage.view"), v.find);
router.post("/vehicles", requirePermission("garage.create"), v.create);
router.get("/vehicles/:vehicleId", requirePermission("garage.view"), v.get);
router.get("/vehicles/:vehicleId/activity", requirePermission("garage.view"), v.activity);
router.put("/vehicles/:vehicleId", requirePermission("garage.edit"), v.update);

// Job cards: fixed paths before /:id, as every router in this codebase orders them.
router.get("/job-cards/board", requirePermission("garage.view"), j.board);
router.get("/job-cards/assignees", requirePermission("garage.view"), j.assignees);
router.get("/job-cards/analysis", requirePermission("garage.view"), j.analysis);
router.get("/job-cards/committed", requirePermission("garage.view"), j.committed);

router.get("/job-cards", requirePermission("garage.view"), j.list);
router.post("/job-cards", requirePermission("garage.create"), j.create);
router.get("/job-cards/:id", requirePermission("garage.view"), j.get);
router.get("/job-cards/:id/activity", requirePermission("garage.view"), j.activity);
router.put("/job-cards/:id", requirePermission("garage.edit"), j.update);
router.delete("/job-cards/:id", requirePermission("garage.delete"), j.remove);
router.post("/job-cards/:id/send-estimate", requirePermission("garage.edit"), j.sendEstimate);
router.post("/job-cards/:id/approve", requirePermission("garage.approve"), j.recordApproval);
router.post("/job-cards/:id/revise-estimate", requirePermission("garage.edit"), j.reviseEstimate);
// Start/complete: garage.view opens the door, the controller's assertMayWorkTask decides the rest (a technician
// may always work the task they were given).
router.post("/job-cards/:id/tasks/:taskId/start", requirePermission("garage.view"), j.startTask);
router.post("/job-cards/:id/tasks/:taskId/complete", requirePermission("garage.view"), j.completeTask);
router.post("/job-cards/:id/invoice", requirePermission("garage.invoice"), j.createInvoice);
router.post("/job-cards/:id/release", requirePermission("garage.approve"), j.release);
router.post("/job-cards/:id/cancel", requirePermission("garage.edit"), j.cancel);

module.exports = router;
