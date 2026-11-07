const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const p = require("../../controllers/hr/payrollController");

// Mounted under /api/v1/hr. Every param here is its own name (componentId, runId), never :id - the
// parent router keys router.param("id", branchOfDocument(Staff)), and neither a SalaryComponent nor a
// PayrollRun is one (the same collision already caught on contracts, statutory-rules, gratuity accruals
// and leave requests). The controller reads each param by its real name, so no copy-forward is needed.
const router = express.Router();

// Salary components: read hr.view (they are rules, not anyone's pay); write hr.payroll.
router.get("/salary-components", requirePermission("hr.view"), p.listComponents);
router.post("/salary-components", requirePermission("hr.payroll"), p.createComponent);
router.put("/salary-components/:componentId", requirePermission("hr.payroll"), p.updateComponent);
router.delete("/salary-components/:componentId", requirePermission("hr.payroll"), p.removeComponent);

// A run. Planning needs hr.payroll (the action); the controller strips every figure unless the caller
// also holds hr.confidential, the same split contracts.list already has. Posting and reversing assert
// finance.create / finance.deletePosted themselves (a ledger posting), hr.confidential is still the floor.
router.get("/payroll/plan", requirePermission("hr.payroll"), p.plan);
router.post("/payroll/post", requirePermission("hr.payroll"), p.post);
router.post("/payroll/runs/:runId/reverse", requirePermission("hr.payroll"), p.reverse);
router.get("/payroll/runs", requirePermission("hr.payroll"), p.list);
router.get("/payroll/runs/:runId/payslips", requirePermission("hr.payroll"), p.payslips);
router.get("/employees/:id/payslips", requirePermission("hr.payroll"), (req, res, next) => { req.params.staffId = req.params.id; next(); }, p.payslipsForStaff);

module.exports = router;
