// The new-client onboarding form, as the CLIENT reaches it: /api/v1/client-onboarding/:token. NO AUTHENTICATION IS APPLIED
// IN THIS FILE, ON PURPOSE: the client has no account yet - the form is how one gets made - so the secret in the link is
// the credential, exactly as for a customer's document link (routes/messaging/shareRoutes.js). It is its own router so no
// reordering of another file can ever open something else.
//
// Everything a link can do is in services/platform/clientOnboardingService.js: read its own form, save it, add and remove
// its own files, and send it. It can never read a file back, nor anything about any other form, and every write is
// refused once the form is sent, withdrawn, out of date, or made into an organisation.
//
// (/api/v1/onboarding is a different thing: the getting-started checklist of a signed-in organisation.)
const express = require("express");
const multer = require("multer");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const { rateLimit } = require("../../middleware/rateLimit");
const { publicRoute } = require("../../middleware/permissionGate");
const { LIMITS } = require("../../utils/clientOnboarding");
const Onboarding = require("../../services/platform/clientOnboardingService");

const router = express.Router();

// A bearer link must never be cached, indexed or passed on in a Referer header.
router.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer" });
  next();
});

const TOO_MANY = "Too many requests. Wait a few minutes and try again: what you wrote is kept.";
const selector = (req) => String(req.params.token || "").split(".")[0];
// The page saves as the client types (a second or two after they stop), so these are roomy for a person and tight for a script.
const byAddress = rateLimit({ windowMs: 5 * 60 * 1000, max: 300, code: "ONBOARDING_RATE_LIMIT", message: TOO_MANY });
const byLink = rateLimit({ windowMs: 60 * 60 * 1000, max: 1500, key: selector, code: "ONBOARDING_RATE_LIMIT", message: TOO_MANY });
const uploadsByLink = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, key: selector, code: "ONBOARDING_RATE_LIMIT", message: "Too many uploads. Wait a little and try again." });
const submitsByLink = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: selector, code: "ONBOARDING_RATE_LIMIT", message: TOO_MANY });

// One file, into memory (never the server's disk, which is not durable), at most the form's own limit.
const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: LIMITS.fileBytes, files: 1, fields: 4, fieldSize: 200 } });
const oneFile = (req, res, next) =>
  memory.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return next(new AppError(`A file may be at most ${LIMITS.fileBytes / 1024 / 1024} MB`, 413, "FILE_TOO_LARGE"));
    if (err instanceof multer.MulterError) return next(new AppError("The upload could not be read. Choose the file again.", 400, "UPLOAD_INVALID"));
    return next(err);
  });

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

router.get("/:token", publicRoute("a new client opens the onboarding form they were sent; the secret in the link is the credential"), byAddress, byLink, catchAsync(async (req, res) => {
  ok(res, await Onboarding.open(req.params.token));
}));

router.put("/:token", publicRoute("the client saves the onboarding form they are filling in; the secret in the link is the credential"), byAddress, byLink, catchAsync(async (req, res) => {
  ok(res, await Onboarding.save(req.params.token, req.body || {}));
}));

router.post("/:token/files", publicRoute("the client adds a file (their customer list, trade licence...) to their own onboarding form; the secret in the link is the credential"), byAddress, uploadsByLink, oneFile, catchAsync(async (req, res) => {
  ok(res, await Onboarding.upload(req.params.token, { kind: req.body?.kind, file: req.file }), 201);
}));

router.delete("/:token/files/:fileId", publicRoute("the client removes a file from their own onboarding form; the secret in the link is the credential"), byAddress, byLink, catchAsync(async (req, res) => {
  ok(res, await Onboarding.removeFile(req.params.token, req.params.fileId));
}));

router.post("/:token/submit", publicRoute("the client sends their filled-in onboarding form; the secret in the link is the credential"), byAddress, submitsByLink, catchAsync(async (req, res) => {
  ok(res, await Onboarding.submit(req.params.token, req.body || {}));
}));

module.exports = router;
