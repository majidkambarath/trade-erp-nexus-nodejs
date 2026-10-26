const express = require("express");
const multer = require("multer");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const AppError = require("../../utils/AppError");
const AttachmentService = require("../../services/core/attachmentService");
const JobCard = require("../../models/modules/garage/jobCardModel");
const InsuranceClaim = require("../../models/modules/garage/insuranceClaimModel");
const v = require("../../controllers/garage/vehicleController");
const j = require("../../controllers/garage/jobCardController");
const ic = require("../../controllers/garage/insuranceClaimController");
const files = require("../../controllers/garage/garageAttachmentController");
const setup = require("../../controllers/garage/garageSetupController");

// A file arrives in memory and is validated (extension AND contents) by AttachmentService before anything is
// stored, exactly as routes/crm/crmRoutes.js does it.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AttachmentService.MAX_BYTES, files: 1 } });
const uploadOne = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    next(err.code === "LIMIT_FILE_SIZE" ? new AppError("File too large (10 MB maximum)", 413, "FILE_TOO_LARGE") : new AppError("Upload failed", 400));
  });

// The garage module, mounted at /api/v1/garage: vehicles, job cards and their tasks. Every route is gated on a
// garage.* permission - garage is the first opt-in MODULE (utils/plans.js OPT_IN_MODULES), sold per organisation
// like the CRM, so the plan ceiling (middleware/permissionGate.js refusalFor) answers MODULE_NOT_IN_PLAN before
// a role is even considered. No requireFeature call is needed: a module is capped on req.admin.grants itself,
// inside authenticateToken, before any route runs.
const router = express.Router();
router.use(authenticateToken);
router.param("id", branchOfDocument(JobCard)); // a head office working across branches acts in the card's own branch
router.param("claimId", branchOfDocument(InsuranceClaim));

// Vehicles: an organisation-wide master, so no branchOfDocument on its own id.
router.get("/vehicles", requirePermission("garage.view"), v.list);
router.get("/vehicles/find", requirePermission("garage.view"), v.find);
router.get("/vehicles/catalogue", requirePermission("garage.view"), v.catalogue);
router.post("/vehicles", requirePermission("garage.create"), v.create);
router.get("/vehicles/:vehicleId", requirePermission("garage.view"), v.get);
router.get("/vehicles/:vehicleId/activity", requirePermission("garage.view"), v.activity);
router.get("/vehicles/:vehicleId/jobs", requirePermission("garage.view"), v.jobs);
router.put("/vehicles/:vehicleId", requirePermission("garage.edit"), v.update);
router.get("/vehicles/:vehicleId/attachments", requirePermission("garage.view"), files.vehicleFiles.list);
router.post("/vehicles/:vehicleId/attachments", requirePermission("garage.edit"), uploadOne, files.vehicleFiles.add);

// Job cards: fixed paths before /:id, as every router in this codebase orders them.
router.get("/job-cards/board", requirePermission("garage.view"), j.board);
router.get("/job-cards/assignees", requirePermission("garage.view"), j.assignees);
router.get("/job-cards/staff", requirePermission("garage.view"), j.staff);
router.get("/job-cards/analysis", requirePermission("garage.view"), j.analysis);
router.get("/job-cards/comeback-candidates", requirePermission("garage.view"), j.comebackCandidates);
router.get("/job-cards/committed", requirePermission("garage.view"), j.committed);
// Narrow party pickers (jobCardService.customerChoices/vendorChoices): a garage-only person has neither
// sales.view/accounts.view nor purchase.view/accounts.view, so /customers/customers and /vendors/vendors
// would refuse them. Same precedent as GET /crm/customers.
router.get("/customers", requirePermission("garage.view"), j.customers);
router.post("/customers", requirePermission("garage.create"), j.createCustomer);
router.get("/vendors", requirePermission("garage.view"), j.vendors);

router.get("/job-cards", requirePermission("garage.view"), j.list);
router.post("/job-cards", requirePermission("garage.create"), j.create);
router.get("/job-cards/:id", requirePermission("garage.view"), j.get);
router.get("/job-cards/:id/activity", requirePermission("garage.view"), j.activity);
router.get("/job-cards/:id/shortages", requirePermission("garage.view"), j.shortages);
router.post("/job-cards/:id/purchase-orders", requirePermission("garage.edit"), j.raisePurchaseOrder);
router.put("/job-cards/:id", requirePermission("garage.edit"), j.update);
router.delete("/job-cards/:id", requirePermission("garage.delete"), j.remove);
router.put("/job-cards/:id/check-in", requirePermission("garage.edit"), j.recordCheckIn);
router.get("/job-cards/:id/attachments", requirePermission("garage.view"), files.jobCardFiles.list);
router.post("/job-cards/:id/attachments", requirePermission("garage.edit"), uploadOne, files.jobCardFiles.add);
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

// Insurance claims: fixed paths before /:claimId, same ordering discipline.
router.get("/claims/ageing", requirePermission("garage.view"), ic.ageing);
router.get("/claims", requirePermission("garage.view"), ic.list);
router.post("/claims", requirePermission("garage.create"), ic.create);
router.get("/claims/:claimId", requirePermission("garage.view"), ic.get);
router.get("/claims/:claimId/activity", requirePermission("garage.view"), ic.activity);
router.put("/claims/:claimId", requirePermission("garage.edit"), ic.update);
router.delete("/claims/:claimId", requirePermission("garage.delete"), ic.remove);
router.get("/claims/:claimId/attachments", requirePermission("garage.view"), files.claimFiles.list);
router.post("/claims/:claimId/attachments", requirePermission("garage.edit"), uploadOne, files.claimFiles.add);
router.post("/claims/:claimId/submit", requirePermission("garage.edit"), ic.submit);
router.post("/claims/:claimId/survey", requirePermission("garage.edit"), ic.recordSurvey);
router.post("/claims/:claimId/decide", requirePermission("garage.approve"), ic.recordApproval);
router.post("/claims/:claimId/raise-invoices", requirePermission("garage.invoice"), ic.raiseInvoices);

// One door for all three owners' files - the attachment id alone decides which record it belongs to
// (GarageAttachmentService.find), exactly as /crm/attachments/:attachmentId does.
router.get("/attachments/:attachmentId", requirePermission("garage.view"), files.downloadFile);
router.delete("/attachments/:attachmentId", requirePermission("garage.edit"), files.removeFile);

// Setup: bays (the branch's own plant) and the service menu (standard jobs, organisation-wide). Reading is
// garage.view (every job-card form needs the picker), changing is garage.manage - the Setup screen's own door.
router.get("/bays", requirePermission("garage.view"), setup.listBays);
router.post("/bays", requirePermission("garage.manage"), setup.createBay);
router.put("/bays/:bayId", requirePermission("garage.manage"), setup.updateBay);
router.get("/services", requirePermission("garage.view"), setup.listServices);
router.post("/services", requirePermission("garage.manage"), setup.createService);
router.put("/services/:serviceId", requirePermission("garage.manage"), setup.updateService);
router.get("/services/plan", requirePermission("garage.view"), setup.plan);

module.exports = router;
