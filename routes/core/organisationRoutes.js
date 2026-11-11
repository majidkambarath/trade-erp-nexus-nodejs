const express = require("express");
const { authenticateTokenAllowingBlocked } = require("../../middleware/authMiddleware");
const c = require("../../controllers/core/organisationController");

const { requirePermission, signedIn } = require("../../middleware/permissionGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const router = express.Router();

// The one route that also answers an organisation whose subscription has ended: it is how the app finds out
// what to tell the person, and whether anything is still readable.
router.get("/status", authenticateTokenAllowingBlocked, signedIn("it is how a person finds out what they may do, so it cannot itself depend on a permission"), c.status);

// Changing it is a settings change like any other; reading it rides on /status, which every signed-in
// person already reads, because every screen that shows a date needs it.
router.put("/date-format", authenticateToken, requirePermission("settings.manage"), c.setDateFormat);

module.exports = router;
