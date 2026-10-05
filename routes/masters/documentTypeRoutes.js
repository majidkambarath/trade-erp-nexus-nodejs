const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/masters/documentTypeController");

// Mounted at /api/v1/document-types. Any signed-in admin can read the list (the customer and vendor
// forms need it); changing it needs an admin or super admin.
const router = express.Router();
router.use(authenticateToken);
const canChange = requireRole(["super_admin", "admin"]);

router.get("/", c.list);
router.post("/", canChange, c.create);
router.get("/:id", c.get);
router.put("/:id", canChange, c.update);
router.delete("/:id", canChange, c.remove);

module.exports = router;
