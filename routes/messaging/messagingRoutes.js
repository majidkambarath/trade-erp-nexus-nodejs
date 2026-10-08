// Sending documents to customers. Everything here needs a login; the public link a customer opens is
// in shareRoutes.js, a separate file with no authentication in it at all.
//
// Anyone signed in may send, withdraw a link or retry (the same people who print and download today);
// every send records who. Changing the setup is for admins, because that is where the key lives.
const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { rateLimit } = require("../../middleware/rateLimit");
const { pdfUpload } = require("../../middleware/pdfUpload");
const { getTenant } = require("../../utils/tenant");
const c = require("../../controllers/messaging/messagingController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("messaging"));

const perCompany = (req) => getTenant(req).companyId;
const sendLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, key: perCompany, code: "SEND_LIMIT_REACHED", message: "A lot of documents have been sent in the last hour. Try again in a little while." });
const testLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => req.admin?.id || "anon", code: "TEST_LIMIT_REACHED", message: "Five test emails an hour is the limit. Try again later." });

router.get("/settings", requirePermission(["sales.send","settings.view"]), c.getSettings);
router.put("/settings", requirePermission("settings.manage"), c.putSettings);
router.get("/readiness", requirePermission(["sales.send","settings.view"]), c.readiness);
router.post("/test", requirePermission("settings.manage"), testLimit, c.test);

router.post("/send", requirePermission("sales.send"), sendLimit, pdfUpload, c.send);
router.post("/handoff", requirePermission("sales.send"), sendLimit, c.handoff);
router.get("/sends", requirePermission(["sales.send","sales.view"]), c.list);
router.get("/sends/:id", requirePermission(["sales.send","sales.view"]), c.get);
router.post("/sends/:id/retry", requirePermission("sales.send"), c.retry);

router.get("/shares", requirePermission(["sales.send","sales.view"]), c.shares);
router.post("/shares/:id/revoke", requirePermission("sales.send"), c.revoke);

module.exports = router;
