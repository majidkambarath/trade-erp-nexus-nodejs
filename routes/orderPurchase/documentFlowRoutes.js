const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/orderPurchase/documentFlowController");

const router = express.Router();
router.use(authenticateToken);

router.get("/customer/:id", c.customer);

module.exports = router;
