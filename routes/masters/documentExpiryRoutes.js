const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/masters/documentExpiryController");

// Mounted at /api/v1/document-expiry: customer and vendor documents that have expired or expire soon.
const router = express.Router();
router.use(authenticateToken);

router.get("/", c.list);

module.exports = router;
