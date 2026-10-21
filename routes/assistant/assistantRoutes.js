const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { signedIn, requirePermission } = require("../../middleware/permissionGate");
const { requireFeature } = require("../../middleware/featureGate");
const c = require("../../controllers/assistant/assistantController");

// Zarvia AI. Asking it something is gated on being signed in and nothing else, on purpose: help
// that a Viewer cannot open is not help, and there is no permission key that every role holds. The
// assistant reads no business data in this version, so being signed in is the whole requirement.
// Its own settings hold an API key, so they follow the messaging precedent and need settings.manage.
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("assistant"));

const reason = "in-app help: every signed-in person may ask, whatever their role, which is the point of help";

router.post("/ask", signedIn(reason), c.ask);
router.get("/mine", signedIn(reason), c.mine);
router.get("/screen", signedIn(reason), c.screenTip);
router.post("/messages/:id/helpful", signedIn(reason), c.rate);
router.post("/escalate", signedIn(reason), c.escalate);

router.get("/usage", requirePermission(["settings.view", "settings.manage"]), c.usage);
router.get("/settings", requirePermission(["settings.view", "settings.manage"]), c.getSettings);
router.put("/settings", requirePermission("settings.manage"), c.putSettings);

module.exports = router;
