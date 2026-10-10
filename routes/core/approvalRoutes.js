const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const c = require("../../controllers/core/approvalController");

// The approvals list. Anyone who may approve something sees what is waiting for them; the service narrows it to the
// modules they may approve in, so holding one of these three is the whole entry test.
const router = express.Router();
router.use(authenticateToken);

router.get("/waiting", requirePermission(["sales.approve", "purchase.approve", "finance.approve"]), c.waiting);

module.exports = router;
