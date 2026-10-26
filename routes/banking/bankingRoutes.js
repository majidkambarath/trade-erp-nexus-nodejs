const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/banking/bankingController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);

// Every voucher form reads these to offer cash, bank and transfer, so they are open to every plan; what the banking
// feature adds (cheques, cards) is left out of the answer when it is off.
router.get("/payment-options", requirePermission(["lookups.view","finance.view","banking.view"]), c.paymentOptions);

router.use(requireFeature("banking"));

// Anyone signed in can read the masters (the voucher forms need them); changing them, and acting
// on a cheque, needs an admin or super admin.

// Bank statement import, matching and reconciliation, and card settlement: /api/v1/banking/reconciliation/*
router.use("/reconciliation", requireFeature("reconciliation"), require("./reconciliationRoutes"));

router.get("/banks", requirePermission(["banking.view","lookups.view"]), c.listBanks);
// The accounts at one bank carry their balances, so this one is not open to the lookups floor the
// list is: reading the chart is accounts.view, and banking.view is the banking screens' own key.
router.get("/banks/:id/accounts", requirePermission(["banking.view","accounts.view"]), c.listBankAccounts);
router.post("/banks", requirePermission("banking.manage"), c.createBank);
router.put("/banks/:id", requirePermission("banking.manage"), c.updateBank);

router.get("/card-types", requirePermission(["banking.view","lookups.view"]), c.listCardTypes);
router.post("/card-types", requirePermission("banking.manage"), c.createCardType);
router.put("/card-types/:id", requirePermission("banking.manage"), c.updateCardType);

router.get("/cards", requirePermission(["banking.view","lookups.view"]), c.listCards);
router.post("/cards", requirePermission("banking.manage"), c.createCard);
router.put("/cards/:id", requirePermission("banking.manage"), c.updateCard);

router.get("/cheques", requirePermission(["banking.view","finance.view"]), c.listCheques);
// Any fixed GET under /cheques (a report) must be registered ABOVE this line, or "/:id" captures it.
router.get("/cheques/:id", requirePermission(["banking.view","finance.view"]), c.getCheque);
router.post("/cheques/:id/clear", requirePermission("finance.approve"), c.clearCheque);
router.post("/cheques/:id/bounce", requirePermission("finance.approve"), c.bounceCheque);
router.post("/cheques/:id/cancel", requirePermission("finance.approve"), c.cancelCheque);

module.exports = router;
