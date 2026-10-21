const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { signedIn } = require("../../middleware/permissionGate");
const c = require("../../controllers/core/notificationController");

// A person's own notification feed. No single permission gates it - a row's audience can name any
// permission key (inventory.view today, others as more checks are added), so the service filters what
// comes back rather than the route; `signedIn` states that as its reason, as the guard test requires.
const router = express.Router();
router.use(authenticateToken);
const reason = "a person's own notification feed - visibility is filtered per row inside the service";

router.get("/", signedIn(reason), c.list);
router.get("/unread-count", signedIn(reason), c.unreadCount);
router.post("/:id/read", signedIn(reason), c.markRead);
router.post("/read-all", signedIn(reason), c.markAllRead);

module.exports = router;
