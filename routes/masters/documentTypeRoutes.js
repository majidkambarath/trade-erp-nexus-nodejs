const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/masters/documentTypeController");

// Mounted at /api/v1/document-types. Any signed-in admin can read the list (the customer and vendor
// forms need it); changing it needs an admin or super admin.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);

router.get("/", requirePermission(["accounts.view","lookups.view","sales.view","purchase.view"]), c.list);
router.post("/", requirePermission("accounts.manage"), c.create);
router.get("/:id", requirePermission(["accounts.view","lookups.view","sales.view","purchase.view"]), c.get);
router.put("/:id", requirePermission("accounts.manage"), c.update);
router.delete("/:id", requirePermission("accounts.manage"), c.remove);

module.exports = router;
