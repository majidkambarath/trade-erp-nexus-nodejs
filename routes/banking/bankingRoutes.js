const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/banking/bankingController");

const router = express.Router();
router.use(authenticateToken);

// Every voucher form reads these to offer cash, bank and transfer, so they are open to every plan; what the banking
// feature adds (cheques, cards) is left out of the answer when it is off.
router.get("/payment-options", c.paymentOptions);

router.use(requireFeature("banking"));

// Anyone signed in can read the masters (the voucher forms need them); changing them, and acting
// on a cheque, needs an admin or super admin.
const canChange = requireRole(["super_admin", "admin"]);

// Bank statement import, matching and reconciliation, and card settlement: /api/v1/banking/reconciliation/*
router.use("/reconciliation", requireFeature("reconciliation"), require("./reconciliationRoutes"));

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
