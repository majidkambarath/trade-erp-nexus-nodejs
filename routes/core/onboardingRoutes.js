const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const c = require("../../controllers/core/onboardingController");

// The getting-started checklist: yes/no per first step. lookups.view is the key every person holds; the service itself narrows
// the steps to the modules the caller's own grants hold.
const router = express.Router();
router.use(authenticateToken);

router.get("/checklist", requirePermission("lookups.view"), c.checklist);

module.exports = router;
