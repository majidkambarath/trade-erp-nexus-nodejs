// Sending documents to customers. Everything here needs a login; the public link a customer opens is
// in shareRoutes.js, a separate file with no authentication in it at all.
//
// Anyone signed in may send, withdraw a link or retry (the same people who print and download today);
// every send records who. Changing the setup is for admins, because that is where the key lives.
const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const { rateLimit } = require("../../middleware/rateLimit");
const { pdfUpload } = require("../../middleware/pdfUpload");
const { getTenant } = require("../../utils/tenant");
const c = require("../../controllers/messaging/messagingController");

const router = express.Router();
router.use(authenticateToken);
const canChange = requireRole(["super_admin", "admin"]);

const perCompany = (req) => getTenant(req).companyId;
const sendLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, key: perCompany, code: "SEND_LIMIT_REACHED", message: "A lot of documents have been sent in the last hour. Try again in a little while." });
const testLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => req.admin?.id || "anon", code: "TEST_LIMIT_REACHED", message: "Five test emails an hour is the limit. Try again later." });

router.get("/settings", c.getSettings);
router.put("/settings", canChange, c.putSettings);
router.get("/readiness", c.readiness);
router.post("/test", canChange, testLimit, c.test);

router.post("/send", sendLimit, pdfUpload, c.send);
router.post("/handoff", sendLimit, c.handoff);
router.get("/sends", c.list);
router.get("/sends/:id", c.get);
router.post("/sends/:id/retry", c.retry);

router.get("/shares", c.shares);
router.post("/shares/:id/revoke", c.revoke);

module.exports = router;
