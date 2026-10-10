const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const c = require("../../controllers/core/accessController");

// The people of the signed-in organisation and what each may do: /api/v1/access/users and /api/v1/access/roles.
// Seeing them is users.view; adding, changing or switching off a person, and making roles, is users.manage, and then
// only for people and roles BELOW the person's own rank (decided in the service, which knows the target).
const router = express.Router();
router.use(authenticateToken);

router.get("/users", requirePermission("users.view"), c.users);
router.post("/users", requirePermission("users.manage"), c.createUser);
router.patch("/users/:id", requirePermission("users.manage"), c.updateUser);
router.post("/users/:id/2fa/reset", requirePermission("users.manage"), c.resetTwoFactor);

router.get("/roles", requirePermission("users.view"), c.roles);
router.post("/roles", requirePermission("users.manage"), c.createRole);
router.patch("/roles/:key", requirePermission("users.manage"), c.updateRole);
router.delete("/roles/:key", requirePermission("users.manage"), c.removeRole);

module.exports = router;
