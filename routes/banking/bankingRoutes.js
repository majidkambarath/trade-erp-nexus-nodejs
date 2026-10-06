const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/banking/bankingController");

const router = express.Router();
router.use(authenticateToken);

// Anyone signed in can read the masters (the voucher forms need them); changing them, and acting
// on a cheque, needs an admin or super admin.
const canChange = requireRole(["super_admin", "admin"]);

// Bank statement import, matching and reconciliation, and card settlement: /api/v1/banking/reconciliation/*
router.use("/reconciliation", require("./reconciliationRoutes"));

router.get("/payment-options", c.paymentOptions);

router.get("/banks", c.listBanks);
router.post("/banks", canChange, c.createBank);
router.put("/banks/:id", canChange, c.updateBank);

router.get("/card-types", c.listCardTypes);
router.post("/card-types", canChange, c.createCardType);
router.put("/card-types/:id", canChange, c.updateCardType);

router.get("/cards", c.listCards);
router.post("/cards", canChange, c.createCard);
router.put("/cards/:id", canChange, c.updateCard);

router.get("/cheques", c.listCheques);
router.post("/cheques/:id/clear", canChange, c.clearCheque);
router.post("/cheques/:id/bounce", canChange, c.bounceCheque);
router.post("/cheques/:id/cancel", canChange, c.cancelCheque);

module.exports = router;
