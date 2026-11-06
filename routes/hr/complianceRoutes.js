const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const c = require("../../controllers/hr/complianceController");

// Mounted under /api/v1/hr (routes/hr/hrRoutes.js already runs authenticateToken and holds the hr.* module
// ceiling), so this file names only the ROLE gate on top of that - the same split every HR route takes.
const router = express.Router();

// Gratuity. Reading the aggregate needs hr.view; the per-employee breakdown is stripped unless the caller
// also holds hr.confidential (controllers/hr/complianceController.js forReader) - never gated at the route,
// because the SAME request answers differently depending on what the caller may see, exactly like
// contracts.list already does.
router.get("/compliance/gratuity/preview", requirePermission("hr.view"), c.previewGratuity);
router.get("/compliance/gratuity/accruals", requirePermission("hr.view"), c.listGratuityAccruals);
// accrue/reverse assert finance.create / finance.deletePosted themselves (a ledger posting, not just an HR
// action) - hr.confidential is still the floor, asserted first.
router.post("/compliance/gratuity/accrue", requirePermission("hr.confidential"), c.accrueGratuity);
// :accrualId, not :id - the same param-name collision the statutory-rules route above avoids: the parent
// router keys "id" to branchOfDocument(Staff), and a GratuityAccrual is not a Staff document (it is not
// branchScoped at all - D11, one accrual for the whole organisation).
router.post("/compliance/gratuity/:accrualId/reverse", requirePermission("hr.confidential"), (req, res, next) => {
  req.params.id = req.params.accrualId;
  next();
}, c.reverseGratuity);

// Emiratisation: headcount and nationality, never a wage - hr.view is the floor, no confidential gate.
router.get("/compliance/emiratisation", requirePermission("hr.view"), c.emiratisation);

// The dated-rule engine every compliance figure (and later wave's payroll deductions) reads. Setup, so
// hr.manage to write; hr.view to read the table (the figures are statutory, not anyone's pay).
router.get("/statutory-rules", requirePermission("hr.view"), c.listStatutoryRules);
router.post("/statutory-rules", requirePermission("hr.manage"), c.createStatutoryRule);
// :ruleId, not :id - the parent router (routes/hr/hrRoutes.js) already keys `router.param("id", ...)` to
// branchOfDocument(Staff). Reusing :id here would make it try to load a StatutoryRule's id as a Staff
// document the moment this route ran - the exact mistake already caught once on /contracts/:id; a
// StatutoryRule is organisation-wide anyway (not branchScoped), so it needs no branchOfDocument at all.
router.delete("/statutory-rules/:ruleId", requirePermission("hr.manage"), (req, res, next) => {
  req.params.id = req.params.ruleId;
  next();
}, c.removeStatutoryRule);

module.exports = router;
