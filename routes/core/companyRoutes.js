const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission, signedIn } = require("../../middleware/permissionGate");
const { uploadFields, handleUploadError } = require("../../middleware/upload");
const c = require("../../controllers/core/companyController");

// The organisation's letterhead. Reading is open to anyone signed in: it is printed on every document they can see, and a
// role that may print an invoice must be able to read the company's name on it. Changing it is a company setting.
const router = express.Router();
router.use(authenticateToken);

router.get("/profile", signedIn("the company's letterhead is printed on every document a person can see"), c.profile);
router.put("/profile", requirePermission("settings.manage"), uploadFields([{ name: "companyLogo", maxCount: 1 }]), handleUploadError, c.updateProfile);

module.exports = router;
