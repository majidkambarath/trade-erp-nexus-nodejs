const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const a = require("../../controllers/hr/assetController");

// Mounted under /api/v1/hr. :assetId, not :id - the parent router keys router.param("id",
// branchOfDocument(Staff)), and an AssetAssignment is not one.
const router = express.Router();

router.get("/assets", requirePermission("hr.view"), a.list);
router.get("/employees/:id/assets", requirePermission("hr.view"), (req, res, next) => { req.params.staffId = req.params.id; next(); }, a.forStaff);
router.post("/assets", requirePermission("hr.manage"), a.issue);
router.post("/assets/:assetId/return", requirePermission("hr.manage"), a.markReturned);
router.delete("/assets/:assetId", requirePermission("hr.manage"), a.remove);

module.exports = router;
