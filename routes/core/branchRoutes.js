const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const c = require("../../controllers/core/branchController");

// The organisation's own branches. Reading them is open to anyone who looks at the company's setup or its people (a person is
// placed in a branch there); adding or changing one is part of changing the company's settings. The plan's multiBranch
// feature and branch limit are answered by BranchService on a create, so a plan without them still SEES its head office.
const router = express.Router();
router.use(authenticateToken);

router.get("/", requirePermission(["settings.view", "users.view"]), c.list);
router.post("/", requirePermission("settings.manage"), c.create);
router.patch("/:code", requirePermission("settings.manage"), c.update);

module.exports = router;
