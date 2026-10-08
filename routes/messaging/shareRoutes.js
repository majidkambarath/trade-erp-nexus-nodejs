// The public link a customer opens. NO AUTHENTICATION IS APPLIED IN THIS FILE, ON PURPOSE: it is the
// only door in the API that opens without a session, so it is its own router. Putting it in
// messagingRoutes.js behind a line order (the e-invoice webhook's way) would leave it one accidental
// reorder away from exposing everything.
//
// What it does: given a valid token, return the frozen copy of the document and nothing else. Unknown,
// malformed and wrong-secret links all answer the same 404, so nothing can be learned by guessing.
const express = require("express");
const catchAsync = require("../../utils/catchAsync");
const { rateLimit } = require("../../middleware/rateLimit");
const ShareService = require("../../services/messaging/shareService");

const { publicRoute } = require("../../middleware/permissionGate");
const router = express.Router();

// A bearer link must never be cached, indexed or passed on in a Referer header.
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer" });
  next();
});

const TOO_MANY = "Too many requests. Try again in a few minutes.";
const byAddress = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, code: "SHARE_RATE_LIMIT", message: TOO_MANY });
// One leaked link cannot be used as a bandwidth amplifier whatever addresses it comes from.
const byLink = rateLimit({ windowMs: 60 * 60 * 1000, max: 120, key: (req) => String(req.params.token || "").split(".")[0], code: "SHARE_RATE_LIMIT", message: TOO_MANY });

router.get("/:token", publicRoute("a customer opens the link they were sent; the secret in it is the credential"), byAddress, byLink, catchAsync(async (req, res) => {
  const link = await ShareService.resolve(req.params.token);
  await ShareService.recordFetch(link);
  res.status(200).json({ success: true, data: { ...link.snapshot, expiresAt: link.expiresAt } });
}));

// Sent by the page once it has really loaded, which a mail scanner does not do.
router.post("/:token/viewed", publicRoute("the customer's page reports that it was opened; the secret in the link is the credential"), byAddress, byLink, catchAsync(async (req, res) => {
  await ShareService.recordView(req.params.token, req);
  res.status(204).end();
}));

module.exports = router;
