// The developer console's API: /api/v1/platform. Everything here, except signing in, needs a PLATFORM token (its own
// audience and secret, see services/platform/platformAuthService.js): a customer's token is refused by its
// audience alone, so no ordering mistake in this file can open it to a customer's staff.
const express = require("express");
const { authenticatePlatform } = require("../../middleware/platformAuth");
const { rateLimit } = require("../../middleware/rateLimit");
const c = require("../../controllers/platform/platformController");

const router = express.Router();

// Ten tries per quarter hour per address: this account can create and suspend organisations.
router.post("/login", rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.PLATFORM_LOGIN_LIMIT) || 10, code: "PLATFORM_LOGIN_RATE", message: "Too many sign-in attempts. Try again in a little while." }), c.login);

// The second step of signing in, limited the same way: a wrong code is a failed sign-in.
router.post("/login/2fa", rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.PLATFORM_LOGIN_LIMIT) || 10, code: "PLATFORM_LOGIN_RATE", message: "Too many sign-in attempts. Try again in a little while." }), c.loginTwoFactor);

router.use(authenticatePlatform);
router.get("/me", c.me);
router.get("/me/2fa", c.twoFactorStatus);
router.post("/me/2fa/setup", c.beginTwoFactor);
router.post("/me/2fa/enable", c.enableTwoFactor);
router.post("/me/2fa/disable", c.disableTwoFactor);
router.post("/me/2fa/recovery-codes", c.regenerateRecoveryCodes);
router.get("/catalog", c.catalog);

router.get("/users", c.users);
router.post("/users", c.createUser);
router.patch("/users/:id", c.updateUser);
router.post("/users/:id/2fa/reset", c.resetUserTwoFactor);

router.get("/organisations", c.list);
router.post("/organisations", c.create);
router.get("/organisations/:code", c.detail);
router.patch("/organisations/:code", c.update);
router.post("/organisations/:code/extend", c.extend);
router.post("/organisations/:code/status", c.status);
router.post("/organisations/:code/provision", c.provision);
router.put("/organisations/:code/profile", c.profile);

router.get("/organisations/:code/users", c.orgUsers);
router.get("/organisations/:code/roles", c.orgRoles);
router.post("/organisations/:code/users", c.orgCreateUser);
router.patch("/organisations/:code/users/:id", c.orgUpdateUser);
router.get("/organisations/:code/branches", c.branches);
router.post("/organisations/:code/branches", c.createBranch);
router.patch("/organisations/:code/branches/:branch", c.updateBranch);

router.get("/audit", c.audit);

module.exports = router;
