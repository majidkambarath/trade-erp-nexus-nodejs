const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/currencyController");

const router = express.Router();
router.use(authenticateToken);

// Anyone signed in can read the currencies and rates (the voucher forms need them); changing them
// needs an admin or super admin, as with the other masters.
const canChange = requireRole(["super_admin", "admin"]);

router.get("/", c.list);
router.post("/", canChange, c.create);

// One-segment paths first, so they are never read as a currency code
router.get("/rate", c.rate);
router.get("/register", c.register);
router.get("/settings", c.getSettings);
router.put("/settings", canChange, c.updateSettings);

router.get("/:code/rates", c.rates);
router.post("/:code/rates", canChange, c.addRate);
router.put("/:code", canChange, c.update);
router.delete("/:code", canChange, c.remove);

module.exports = router;
