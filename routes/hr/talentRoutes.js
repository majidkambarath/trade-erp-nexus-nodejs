const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const t = require("../../controllers/hr/talentController");

// Mounted under /api/v1/hr. No new permission key (D16) - checklists and appraisals read hr.view, write
// hr.manage, the same split employees/documents already use. :itemId, not :id - the parent router keys
// router.param("id", branchOfDocument(Staff)), and a StaffChecklistItem is not one.
const router = express.Router();

router.get("/employees/:id/checklists", requirePermission("hr.view"), (req, res, next) => { req.params.staffId = req.params.id; next(); }, t.checklistForStaff);
router.post("/checklists", requirePermission("hr.manage"), t.startChecklist);
router.post("/checklist-items", requirePermission("hr.manage"), t.addChecklistItem);
router.post("/checklist-items/:itemId/done", requirePermission("hr.manage"), t.markChecklistItemDone);
router.delete("/checklist-items/:itemId", requirePermission("hr.manage"), t.removeChecklistItem);

router.get("/employees/:id/appraisals", requirePermission("hr.view"), (req, res, next) => { req.params.staffId = req.params.id; next(); }, t.appraisalsForStaff);
router.post("/employees/:id/appraisals", requirePermission("hr.manage"), (req, res, next) => { req.params.staffId = req.params.id; next(); }, t.createAppraisal);

module.exports = router;
