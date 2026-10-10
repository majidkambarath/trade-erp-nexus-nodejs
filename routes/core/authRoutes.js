const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { sharedLoginThrottle } = require("../../middleware/loginThrottle");
const { rateLimit } = require("../../middleware/rateLimit");
const { requirePermission, signedIn, publicRoute } = require("../../middleware/permissionGate");
const adminController = require("../../controllers/core/adminController");
const c = require("../../controllers/core/authController");

// A person's own sign-in security, mounted at /api/v1/auth (before adminRouter, like every new top-level route):
//   forgetting a password            POST /forgot-password, POST /reset-password            (no login: the person cannot sign in)
//   the second step of signing in    POST /login/2fa                                       (no login: the challenge is the credential)
//   setting up and managing two-factor  /2fa/*                                              (the person's own account, signed in)
//   the organisation's rule about it    PUT /security-policy                                (settings.manage)
const router = express.Router();

const quarterHour = 15 * 60 * 1000;
// Per address, counted for every request whatever the address typed, so the answer never depends on whether an account exists.
// In memory and per process (middleware/rateLimit.js): it stops an impatient script. The per-ACCOUNT cap on reset mails is in
// the service and lives in the database.
const forgotLimit = rateLimit({ windowMs: quarterHour, max: Number(process.env.FORGOT_PASSWORD_IP_LIMIT) || 10, code: "TOO_MANY_REQUESTS", message: "Too many requests from this address. Try again in a little while." });
const resetLimit = rateLimit({ windowMs: quarterHour, max: Number(process.env.RESET_PASSWORD_IP_LIMIT) || 20, code: "TOO_MANY_REQUESTS", message: "Too many attempts from this address. Try again in a little while." });

// =================== PUBLIC ROUTES ===================
router.post("/forgot-password", publicRoute("the person cannot sign in, so there is no one to check; it answers the same for every address"), forgotLimit, c.forgotPassword);
router.post("/reset-password", publicRoute("the emailed single-use link is the credential"), resetLimit, c.resetPassword);
// shares the sign-in's failure throttle: a wrong code is a failed sign-in
router.post("/login/2fa", publicRoute("step two of signing in: the challenge from the correct password is the credential"), sharedLoginThrottle(), adminController.loginTwoFactor);

// =================== THE PERSON'S OWN TWO-FACTOR ===================
const own = signedIn("a person's own sign-in security: the account is the signed-in one, and the password is asked for again");
router.get("/2fa", authenticateToken, own, c.twoFactorStatus);
router.post("/2fa/setup", authenticateToken, own, c.beginTwoFactor);
router.post("/2fa/enable", authenticateToken, own, c.enableTwoFactor);
router.post("/2fa/disable", authenticateToken, own, c.disableTwoFactor);
router.post("/2fa/recovery-codes", authenticateToken, own, c.regenerateRecoveryCodes);

// =================== THE ORGANISATION'S RULE ===================
router.put("/security-policy", authenticateToken, requirePermission("settings.manage"), c.updatePolicy);

module.exports = router;
