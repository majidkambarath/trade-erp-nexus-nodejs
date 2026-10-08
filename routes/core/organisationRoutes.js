const express = require("express");
const { authenticateTokenAllowingBlocked } = require("../../middleware/authMiddleware");
const c = require("../../controllers/core/organisationController");

const router = express.Router();

// The one route that also answers an organisation whose subscription has ended: it is how the app finds out
// what to tell the person, and whether anything is still readable.
router.get("/status", authenticateTokenAllowingBlocked, c.status);

module.exports = router;
