const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { signedIn, requirePermission } = require("../../middleware/permissionGate");
const { requireFeature } = require("../../middleware/featureGate");
const { rateLimit } = require("../../middleware/rateLimit");
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
const own = "the person's own earlier chats only: every read and delete is matched on their own id, and another person's is a plain 404";
router.get("/conversations", signedIn(own), c.conversations);
router.get("/conversations/:id", signedIn(own), c.conversation);
router.delete("/conversations/:id", signedIn(own), c.forgetConversation);
router.get("/screen", signedIn(reason), c.screenTip);
router.post("/messages/:id/helpful", signedIn(reason), c.rate);
router.post("/escalate", signedIn(reason), c.escalate);
// A person confirmed a document Zarvia AI prepared; it was saved by the normal route, with their own
// rights. This only remembers that, on their own message, so the card never offers it twice.
router.post("/messages/:id/proposals/:pid/saved", signedIn("remembers that the person confirmed their own prepared document: it changes nothing but their own message"), c.proposalSaved);

router.get("/usage", requirePermission(["settings.view", "settings.manage"]), c.usage);
router.get("/settings", requirePermission(["settings.view", "settings.manage"]), c.getSettings);
router.put("/settings", requirePermission("settings.manage"), c.putSettings);
// Makes the server call the address on the screen, so it needs the same right as saving it, and is
// limited per person: a free plan's daily allowance should not be spent on pressing Test.
const testLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  key: (req) => String(req.admin?._id || req.admin?.id || "anon"),
  code: "TEST_LIMIT_REACHED",
  message: "Twenty connection tests an hour is the limit. Try again later.",
});
router.post("/settings/test", requirePermission("settings.manage"), testLimit, c.testSettings);

module.exports = router;
