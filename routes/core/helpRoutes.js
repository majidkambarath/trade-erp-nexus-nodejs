const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { signedIn } = require("../../middleware/permissionGate");
const c = require("../../controllers/core/helpController");

// The user guide, readable by everyone signed in, whatever their role and whether or not the organisation has Zarvia AI:
// a guide a Viewer cannot open is not a guide.
const router = express.Router();
router.use(authenticateToken);
const reason = "the user guide: every signed-in person may read it, whatever their role";
router.get("/topics", signedIn(reason), c.list);
router.get("/topics/:id", signedIn(reason), c.topic);

module.exports = router;
