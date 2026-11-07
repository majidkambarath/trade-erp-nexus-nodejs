const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const Staff = require("../../models/modules/staffModel");
const EmployeeContract = require("../../models/modules/hr/employeeContractModel");
const employees = require("../../controllers/hr/employeeController");
const contracts = require("../../controllers/hr/contractController");
const employeeDocuments = require("../../controllers/hr/employeeDocumentController");

// The HR module, mounted at /api/v1/hr. Every route is gated on an hr.* permission - hr is sold per
// organisation (utils/plans.js: off in standard/trading, present in premium/trial/internal, or granted by
// override/the hrms plan), so the plan ceiling (middleware/permissionGate.js refusalFor) answers
// MODULE_NOT_IN_PLAN before any role is even considered. No requireFeature call: a module is capped on
// req.admin.grants itself, inside authenticateToken, exactly as the garage module's router is.
const router = express.Router();
router.use(authenticateToken);
// A head office working across branches acts in the document's OWN branch, not head office's - the same
// rule the garage module's job cards and claims follow, and for the same reason it needs TWO param names:
// `:id` means an employee on an /employees route and a CONTRACT on a /contracts route, and router.param is
// keyed by name, so one branchOfDocument(Staff) on `id` would wrongly try to load a contract's id as a
// Staff document the moment /contracts/:id ran.
router.param("id", branchOfDocument(Staff));
router.param("contractId", branchOfDocument(EmployeeContract));

// Employees. Read is hr.view (sees the directory; pay is a separate gate, below, on contracts); write is
// hr.manage.
router.get("/employees", requirePermission("hr.view"), employees.list);
router.get("/employees/stats", requirePermission("hr.view"), employees.stats);
router.get("/employees/:id", requirePermission("hr.view"), employees.get);
router.post("/employees", requirePermission("hr.manage"), employees.create);
router.put("/employees/:id", requirePermission("hr.manage"), employees.update);
router.delete("/employees/:id", requirePermission("hr.manage"), employees.remove);

// D15: the employee's own self-service portal account - set up or reset by HR, never read back once set
// (setPortalAccount answers only whether it worked, not the password).
router.get("/employees/:id/portal", requirePermission("hr.view"), employees.portalStatus);
router.post("/employees/:id/portal", requirePermission("hr.manage"), employees.setPortalAccount);
router.delete("/employees/:id/portal", requirePermission("hr.manage"), employees.disablePortalAccount);

// Contracts: pay. Reading the list needs only hr.view (the service strips every money figure unless the
// caller also holds hr.confidential); writing one is setting somebody's pay, so it needs hr.confidential
// outright - see controllers/hr/contractController.js for why that is NOT the same gate as hr.manage.
router.get("/employees/:id/contracts", requirePermission("hr.view"), (req, res, next) => {
  req.params.staffId = req.params.id;
  next();
}, contracts.list);
router.post("/employees/:id/contracts", requirePermission("hr.confidential"), (req, res, next) => {
  req.params.staffId = req.params.id;
  next();
}, contracts.create);
router.put("/contracts/:contractId", requirePermission("hr.confidential"), (req, res, next) => {
  req.params.id = req.params.contractId;
  next();
}, contracts.update);
router.delete("/contracts/:contractId", requirePermission("hr.confidential"), (req, res, next) => {
  req.params.id = req.params.contractId;
  next();
}, contracts.remove);

// Who, right now, cannot be costed - the one figure that tells HR and finance there is work to do before
// labour costing means anything for that person.
router.get("/coverage", requirePermission("hr.view"), contracts.coverage);

// W4: an employee's own KYC register - what expiry-blocks-assignment already reads (labourCostService.js
// expiredDocumentsFor, wave 1) and what the combined expiry report (customer/vendor/staff) now reads too.
router.get("/employees/:id/documents", requirePermission("hr.view"), (req, res, next) => { req.params.staffId = req.params.id; next(); }, employeeDocuments.forStaff);
router.post("/employee-documents", requirePermission("hr.manage"), employeeDocuments.create);
// :docId, not :id - the parent router keys "id" to branchOfDocument(Staff), and a document row is not one.
router.put("/employee-documents/:docId", requirePermission("hr.manage"), (req, res, next) => { req.params.id = req.params.docId; next(); }, employeeDocuments.update);
router.delete("/employee-documents/:docId", requirePermission("hr.manage"), (req, res, next) => { req.params.id = req.params.docId; next(); }, employeeDocuments.remove);
router.get("/employee-documents/expiring", requirePermission("hr.view"), employeeDocuments.expiring);

// W2: gratuity and Emiratisation, and the dated-rule engine both read (routes/hr/complianceRoutes.js).
// authenticateToken above already ran; this sub-router only adds its own permission gates.
router.use(require("./complianceRoutes"));

// W3: shifts, the holiday calendar, leave types, the muster, and leave requests through the approvals
// queue's own third kind (D13).
router.use(require("./timeRoutes"));
router.use(require("./leaveRoutes"));

// W4: salary components and a payroll run (D14), posted like a year's closing entry.
router.use(require("./payrollRoutes"));

// Assets: what was issued to whom, and when it came back - never a stock movement.
router.use(require("./assetRoutes"));

// W6: onboarding/exit checklists and a plain appraisal - the smallest wave, deliberately (D16).
router.use(require("./talentRoutes"));

module.exports = router;
