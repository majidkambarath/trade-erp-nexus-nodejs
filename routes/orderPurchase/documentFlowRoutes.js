const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/orderPurchase/documentFlowController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);

router.get("/customer/:id", requirePermission("sales.view"), c.customer);

module.exports = router;
